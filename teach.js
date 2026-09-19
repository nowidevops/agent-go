// teach.js — "Teach a workflow": record demonstrated actions + spoken narration,
// then have the local model synthesize a reusable, parameterized procedure.
// Author: iDevOpsLLC

import { chat } from "./ollama.js";
import { withModelLock } from "./model-lock.js";

// Ping the page's content-script message listener. Returns true ONLY if a LIVE
// listener answers — a stale script orphaned by an extension reload leaves
// window.__localClaudeContentReady set but its runtime is dead and cannot reply.
async function pingContent(tabId) {
  try { const r = await chrome.tabs.sendMessage(tabId, { type: "PING" }); return !!(r && r.ok); }
  catch { return false; }
}

// Ensure a live recorder is attached to the tab. Pings first; if dead/absent,
// injects a fresh content.js and re-pings. If a STALE copy still holds the
// top-level consts, re-injection throws "already declared" and the listener
// stays dead — only a page reload fixes that, so we report needsReload.
async function ensureRecorder(tabId) {
  if (await pingContent(tabId)) return { ok: true };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {
    if (await pingContent(tabId)) return { ok: true };
    return { ok: false, needsReload: true, error: e?.message || "injection failed" };
  }
  if (await pingContent(tabId)) return { ok: true };
  return { ok: false, needsReload: true, error: "content script did not respond after injection" };
}

// --- Recording session state (kept in storage so it survives navigations) ---
export async function teachStart() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) return { ok: false, error: "No active tab to record. Click into a website tab, then start." };
  // Content scripts can't run on browser/system pages or the Web Store.
  if (/^(chrome|edge|brave|about|chrome-extension|moz-extension|devtools|view-source):/i.test(tab.url || "") ||
      /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(tab.url || "")) {
    return { ok: false, error: "Can't record on this page (a browser/system page). Open a normal website tab and try again." };
  }
  const ensured = await ensureRecorder(tab.id);
  if (!ensured.ok) {
    return {
      ok: false,
      error: ensured.needsReload
        ? "Couldn't attach the recorder — the page is running an old copy from before the extension was reloaded. Reload the tab (press F5 / Ctrl+R), then click 🎬 again."
        : `Couldn't attach the recorder to the page. ${ensured.error || ""}`.trim()
    };
  }
  // Only now (recorder confirmed live) start a clean session, then turn it on.
  await chrome.storage.local.set({ teachRecording: true, teachEvents: [], teachStart: Date.now() });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "RECORD_START" });
  } catch (e) {
    await chrome.storage.local.set({ teachRecording: false });
    return { ok: false, error: "Recorder attached but didn't start. Reload the tab and retry. (" + e.message + ")" };
  }
  return { ok: true };
}

// Stable identity for a captured element, mirroring dedupeEvents/live view.
function evKey(x) {
  const t = (x && x.target) || {};
  return t.recId || t.id || t.name || t.label || t.text || "";
}
// Two frame runtimes can capture the SAME action: the top frame reaching into a
// same-origin iframe (lcAllDocs) AND that iframe's own content script. They
// arrive back-to-back. Collapse an exact duplicate of the last stored event
// within a short window so the click/type isn't double-counted (dedupeEvents
// only collapses input/select/navigate, never clicks).
function isDupOfLast(last, ev) {
  if (!last || last.action !== ev.action) return false;
  if (Math.abs((ev.ts || 0) - (last.ts || 0)) > 1200) return false;
  if (evKey(last) !== evKey(ev)) return false;
  if (ev.action === "input" || ev.action === "select") return true; // same field; latest wins anyway
  if (ev.action === "click" || ev.action === "navigate") return (last.url || "") === (ev.url || "");
  return false;
}

// Serialize appends: recordEvent is async read-modify-write on storage, and
// dual-frame capture fires two calls near-simultaneously. Without a mutex both
// read the same array before either writes (lost update), which also defeats
// the dedup above. Chain every call so they run strictly in order.
let _recChain = Promise.resolve();

// Append a captured user action (sent from the content script). Resolves to
// TRUE when the event was actually persisted (so the caller mirrors only kept
// events to the live panel), FALSE when it was dropped as a duplicate or the
// session isn't recording.
export function recordEvent(ev) {
  const p = _recChain.then(() => _recordEventInner(ev)).catch(() => false);
  _recChain = p.catch(() => {});
  return p;
}
async function _recordEventInner(ev) {
  const { teachRecording, teachEvents } = await chrome.storage.local.get(["teachRecording", "teachEvents"]);
  if (!teachRecording) return false;
  const events = teachEvents || [];
  if (isDupOfLast(events[events.length - 1], ev)) return false;
  events.push(ev);
  await chrome.storage.local.set({ teachEvents: events.slice(-600) });
  return true;
}

export async function teachStop(narration, settings) {
  await chrome.storage.local.set({ teachRecording: false });
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) { try { await chrome.tabs.sendMessage(tab.id, { type: "RECORD_STOP" }); } catch {} }

  const { teachEvents } = await chrome.storage.local.get("teachEvents");
  const events = dedupeEvents(teachEvents || []);

  // Require at least one REAL action (a click / typing / dropdown choice). A demo with only
  // navigations — or nothing — has no workflow to teach, and saving it just produced junk
  // "Empty Procedure Template — 0 steps" entries. Bail cleanly and tell the user why.
  const realActions = events.filter((e) => e.action === "click" || e.action === "input" || e.action === "select");
  if (!realActions.length) {
    return {
      ok: false, saved: false, reason: "no_actions", eventCount: events.length,
      error: "No clicks or typing were captured, so there's nothing to save. Start recording, then actually CLICK and TYPE on the page as you narrate — if the form is inside a frame (e.g. a ServiceNow record), give it a moment to load first — then click the recorder again to finish."
    };
  }

  const recordedSteps = eventsToStepLines(events); // literal click-by-click

  let workflow = await synthesize(events, narration, settings);
  // Synthesis can fail (model error / empty demo). As long as we captured actions,
  // still save the recording so the literal click-by-click text is never lost —
  // the user can export it as Markdown even without the generalized procedure.
  if (!workflow && recordedSteps.length) {
    workflow = {
      name: deriveName(events),
      description: "Recorded workflow — literal steps (model synthesis unavailable).",
      parameters: [],
      steps: recordedSteps.slice()
    };
  }

  if (workflow) {
    workflow.id = crypto.randomUUID();
    workflow.created = Date.now();
    workflow.eventCount = events.length;
    workflow.recordedSteps = recordedSteps;            // raw, ungeneralized capture
    workflow.narration = (narration || "").slice(0, 1000);
    // At the cap, refuse the save instead of silently dropping the oldest saved row (an internal review B2).
    const saved = await withWorkflowsLock(async () => {
      const list = await readWorkflowList(); // returns a name-deduped list
      if (list.length >= WORKFLOW_CAP) return false;
      workflow.name = uniqueName(workflow.name, list); // no two workflows share a name
      list.push(workflow);
      await chrome.storage.local.set({ teachWorkflows: list });
      return true;
    });
    if (!saved) {
      return { ok: false, saved: false, workflow, eventCount: events.length,
        error: `Not saved: you already have ${WORKFLOW_CAP} saved workflows. Delete one in Settings, then record again.` };
    }
  }
  return { ok: true, saved: !!workflow, workflow, eventCount: events.length };
}

// First sensible title from a raw demo: the first click/field label, else the
// host navigated to. Used only when the model can't name the workflow itself.
function deriveName(events) {
  for (const e of events) {
    const t = e.target || {};
    const label = t.label || t.text;
    if (label) return `Workflow: ${String(label).slice(0, 40)}`;
  }
  const nav = events.find((e) => e.action === "navigate" && e.url);
  if (nav) { try { return `Workflow on ${new URL(nav.url).hostname}`; } catch {} }
  return "Recorded workflow";
}

// Collapse noisy repeats: successive inputs on the same field keep only the last.
const TOGGLE_ACTIONS = new Set(["check", "uncheck"]);
export function dedupeEvents(events) {
  const out = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    const key = (x) => x?.target?.recId || x?.target?.id || x?.target?.name || x?.target?.label || x?.target?.text;
    const shown = (x) => x?.target?.label || x?.target?.text;
    // Same shown text only ties a click to a field when the click was NOT on a button or link: a
    // "Search" button that opens a box labelled "Search" is a separate step replay needs.
    const sameShown = (p, x) => !/^(a|button)$/i.test(p?.target?.tag || "") && shown(p) && shown(p) === shown(x);
    if (prev && (e.action === "input" || e.action === "select") && prev.action === e.action && key(prev) === key(e)) {
      out[out.length - 1] = e; // keep latest value for the same field
    } else if (prev && prev.action === "click" && (e.action === "input" || e.action === "select") &&
        (key(prev) === key(e) || sameShown(prev, e))) {
      // Clicking into a field and then typing into it (or picking an option) is one step: keep the value.
      out[out.length - 1] = e;
    } else if (prev && TOGGLE_ACTIONS.has(e.action) &&
        (TOGGLE_ACTIONS.has(prev.action) || prev.action === "click") &&
        (key(prev) === key(e) || (prev.action === "click" && sameShown(prev, e)))) {
      // The click that ticked a box (on the box or its label) and any repeat change/input events
      // for it are ONE gesture: keep the final checked state.
      out[out.length - 1] = e;
    } else if (prev && e.action === "navigate" && prev.action === "navigate" && prev.url === e.url) {
      // skip duplicate navigate
    } else {
      out.push(e);
    }
  }
  return out;
}

// One human-readable line for a single captured action. Exported so the live
// side-panel recorder formats steps identically to the saved Markdown.
export function eventToStepLine(e) {
  const t = (e && e.target) || {};
  const label = t.label || t.text || t.id || t.name || t.tag || "element";
  if (e.action === "navigate") return `Navigate to ${e.url}`;
  if (e.action === "input") return `Type "${e.value}" into "${label}"`;
  if (e.action === "select") return `Choose "${e.value}" in dropdown "${label}"`;
  // Idempotent wording: a replay on a page that remembers filters must not untick a box.
  if (e.action === "check") return `Check the "${label}" box (click it only if it is not already checked)`;
  if (e.action === "uncheck") return `Uncheck the "${label}" box (click it only if it is currently checked)`;
  return `Click "${label}"${t.tag ? ` <${t.tag}>` : ""}`;
}

// One human-readable line per captured action (no numbering — callers number it).
function eventsToStepLines(events) {
  return events.map(eventToStepLine);
}

function eventsToLog(events) {
  return eventsToStepLines(events).map((s, i) => `${i + 1}. ${s}`).join("\n");
}

// Render a saved workflow as a self-contained Markdown runbook: generalized
// procedure (with parameters), the literal click-by-click capture, and any
// spoken narration. Shared by the side-panel "Export .md / Copy" actions so the
// exported text always matches what's stored. Author: iDevOpsLLC
export function workflowToMarkdown(w) {
  if (!w) return "";
  const L = [`# ${w.name || "Recorded workflow"}`, ""];
  if (w.description) L.push(`_${w.description}_`, "");
  const meta = [];
  if (w.created) { try { meta.push(`Recorded ${new Date(w.created).toLocaleString()}`); } catch {} }
  const count = w.eventCount != null ? w.eventCount : (w.recordedSteps ? w.recordedSteps.length : 0);
  if (count) meta.push(`${count} action${count === 1 ? "" : "s"}`);
  if (meta.length) L.push(meta.join(" · "), "");

  if (Array.isArray(w.parameters) && w.parameters.length) {
    L.push("## Parameters", "");
    for (const p of w.parameters) L.push(`- **{${p.name}}**${p.example ? ` — e.g. ${p.example}` : ""}`);
    L.push("");
  }
  const steps = Array.isArray(w.steps) ? w.steps : [];
  if (steps.length) {
    L.push("## Steps", "");
    steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
    L.push("");
  }
  const raw = Array.isArray(w.recordedSteps) ? w.recordedSteps : [];
  // Show the literal capture only when it adds something beyond the generalized steps.
  if (raw.length && JSON.stringify(raw) !== JSON.stringify(steps)) {
    L.push("## Recorded click-by-click", "");
    raw.forEach((s, i) => L.push(`${i + 1}. ${s}`));
    L.push("");
  }
  if (w.narration) L.push("## Narration", "", w.narration, "");
  return L.join("\n").trim() + "\n";
}

// Ensure no two saved workflows share a name (case-insensitive). Appends
// " (2)", " (3)", ... to collisions.
function uniqueName(name, list) {
  const base = String(name || "Untitled workflow").trim() || "Untitled workflow";
  const taken = new Set((list || []).map((w) => String(w.name || "").toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`.toLowerCase())) n++;
  return `${base} (${n})`;
}

// Rename duplicate names IN PLACE across an existing list. Returns true if any
// name changed (so the caller knows whether to persist). Idempotent.
function dedupeNames(list) {
  const seen = new Set();
  let changed = false;
  for (const w of list) {
    const want = String(w.name || "Untitled workflow").trim() || "Untitled workflow";
    let name = want;
    if (seen.has(name.toLowerCase())) {
      let n = 2;
      while (seen.has(`${want} (${n})`.toLowerCase())) n++;
      name = `${want} (${n})`;
    }
    if (name !== w.name) {
      w.name = name;
      changed = true;
    }
    seen.add(name.toLowerCase());
  }
  return changed;
}

function extractJson(s) {
  const m = String(s || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Ask the local model to turn the demo into a reusable procedure.
async function synthesize(events, narration, settings) {
  const log = eventsToLog(events) || "(no actions recorded)";
  const prompt = `A user demonstrated a browser workflow while narrating out loud. Turn it into a clear, REUSABLE, PARAMETERIZED procedure another agent can replay with browser tools (navigate, click_element, fill_input, select_option, set_reference_field, read_page).

WHAT THEY SAID (narration):
${narration || "(no narration captured)"}

WHAT THEY DID (recorded actions):
${log}

Rules:
- Generalize specifics into PARAMETERS (e.g. a person's name, an incident number, a search term become {caller}, {number}). Constant navigation/UI steps stay literal.
- Checking or unchecking a box, picking a filter, and clicking a button or link are CONSTANT steps. Keep them literal ("Check the \\"CSM\\" box"). Only text the user TYPED can become a parameter; never turn a checkbox label into one.
- Each step is one imperative instruction referencing parameters with {curly_braces}.
- Use the narration to clarify intent and naming.

Output ONLY a JSON object:
{"name":"short title","description":"one sentence","parameters":[{"name":"caller","example":"David Loo"}],"steps":["Navigate to ...","Click ...","Set the Caller field to {caller}", "..."]}`;
  try {
    const msg = await withModelLock(() => chat({
      base: settings.ollamaBase,
      model: settings.model,
      messages: [{ role: "user", content: prompt }],
      options: { temperature: 0.3 }
    }));
    const wf = extractJson(msg.content);
    if (!wf || !Array.isArray(wf.steps)) return null;
    wf.parameters = Array.isArray(wf.parameters) ? wf.parameters : [];
    wf.name = String(wf.name || "Untitled workflow").slice(0, 80);
    return wf;
  } catch {
    return null;
  }
}

// Every writer of teachWorkflows (recording save, delete, clear all, demo seeding) runs under one Web Lock, so the
// options page, the side panel and the service worker can't overwrite each other's read-modify-write
// (an internal review #4). Runs directly where navigator.locks is missing (tests).
const WORKFLOWS_LOCK = "agent-go-teach-workflows";
function withWorkflowsLock(fn) {
  const locks = globalThis.navigator && globalThis.navigator.locks;
  return locks && typeof locks.request === "function" ? locks.request(WORKFLOWS_LOCK, fn) : fn();
}
async function readWorkflowList() {
  const { teachWorkflows } = await chrome.storage.local.get("teachWorkflows");
  const list = Array.isArray(teachWorkflows) ? teachWorkflows : [];
  // Heal any pre-existing duplicate names once; no-op (no write) afterward.
  if (dedupeNames(list)) await chrome.storage.local.set({ teachWorkflows: list });
  return list;
}
// readWorkflowList's dedupe heal is a write, so outside readers take the lock too (an internal review B1).
// Never call getWorkflows from inside withWorkflowsLock: Web Locks are not reentrant.
export async function getWorkflows() {
  return withWorkflowsLock(() => readWorkflowList());
}
export async function deleteWorkflow(id) {
  return withWorkflowsLock(async () => {
    const list = await readWorkflowList();
    await chrome.storage.local.set({ teachWorkflows: list.filter((w) => w.id !== id) });
  });
}
export async function clearWorkflows() {
  return withWorkflowsLock(() => chrome.storage.local.set({ teachWorkflows: [] }));
}

// Demo workflows (2026-09-14, hardened after an internal review). demo-workflows.json holds the two workflows from
// the Saved workflows video (caregiver search, home care claim). They open the public, fictional demo pages at
// https://ai.nowidevops.com/demo/, so anyone can run them. Seeded rows carry demo: true and show a Demo badge.
// - Release build (manifest has the stamped key): added once per DEMO_SEED_VERSION. A demo the user deletes stays
//   deleted. DEMO_SEED_VERSION is unchanged from 1.0.12 / 0.2.18 so those users keep their deletions.
// - Owner's dev copy (unpacked, no key): permanent for demo use; every load puts back a missing demo.
// Both: add all missing demos or none, and never past the 50-workflow cap (a user's own workflows are never pushed out);
// rewrite old http://localhost:8899/ steps, but only on rows that are our demos; set the flag only once every demo
// is present, in the same write as the list.
const DEMO_SEED_VERSION = "saved-workflows-video-2026-09-14-public";
const DEMO_OLD_BASE = "http://localhost:8899/";
const WORKFLOW_CAP = 50;
// A saved row is one of our demos when it carries the marker, or (rows added by 1.0.12 / 0.2.18, before the marker)
// when its name, description and step count are exactly the shipped demo's.
function demoFor(w, byName, byId) {
  if (!w) return null;
  // A marked row matches by its shipped id first, so a demo stored as "Name (2)" is still ours.
  if (w.demo === true && w.demoId && byId && byId.has(w.demoId)) return byId.get(w.demoId);
  const fresh = byName.get(String(w.name || "").toLowerCase());
  if (!fresh) return null;
  if (w.demo === true) return fresh;
  const legacyCopy = w.description === fresh.description && Array.isArray(w.steps) && w.steps.length === fresh.steps.length;
  return legacyCopy ? fresh : null;
}
export async function seedDemoWorkflows() {
  try {
    const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
    const releaseBuild = !!(manifest && manifest.key);
    const res = await fetch(chrome.runtime.getURL("demo-workflows.json"));
    if (!res.ok) return { added: 0 };
    const incoming = await res.json();
    const valid = (Array.isArray(incoming) ? incoming : []).filter((w) => w && w.name && Array.isArray(w.steps) && w.steps.length);
    if (!valid.length) return { added: 0, error: "demo-workflows.json holds no usable workflow" };
    const byName = new Map(valid.map((w) => [String(w.name).toLowerCase(), w]));
    const byId = new Map(valid.filter((w) => w.id).map((w) => [w.id, w]));
    return await withWorkflowsLock(async () => {
      const list = await readWorkflowList();
      const { demoWorkflowsSeeded } = await chrome.storage.local.get("demoWorkflowsSeeded");
      let added = 0, repointed = 0, marked = 0;
      // Canonical names of the demos already in the list. A user's own row that only shares a demo's name does not
      // count, so it can't hide the demo or latch the flag (an internal review B3).
      const ours = new Set();
      for (const w of list) {
        const fresh = demoFor(w, byName, byId);
        if (!fresh) continue;
        ours.add(String(fresh.name).toLowerCase());
        if (w.demo !== true) { w.demo = true; w.demoId = fresh.id; marked++; }
        if (JSON.stringify([w.steps || [], w.recordedSteps || []]).includes(DEMO_OLD_BASE)) {
          w.steps = fresh.steps.slice();
          if (Array.isArray(fresh.recordedSteps)) w.recordedSteps = fresh.recordedSteps.slice();
          repointed++;
        }
      }
      const missing = [...byName].filter(([key]) => !ours.has(key));
      const mayAdd = !releaseBuild || demoWorkflowsSeeded !== DEMO_SEED_VERSION;
      const fits = list.length + missing.length <= WORKFLOW_CAP;
      if (mayAdd && missing.length && fits) {
        for (const [key, w] of missing) {
          list.push({ ...w, name: uniqueName(w.name, list), id: crypto.randomUUID(), created: Date.now(), demo: true, demoId: w.id });
          ours.add(key);
          added++;
        }
      }
      const allPresent = [...byName.keys()].every((key) => ours.has(key));
      const latch = allPresent && demoWorkflowsSeeded !== DEMO_SEED_VERSION;
      const changed = added + repointed + marked > 0;
      if (changed || latch) {
        const patch = {};
        if (changed) patch.teachWorkflows = list;
        if (latch) patch.demoWorkflowsSeeded = DEMO_SEED_VERSION;
        await chrome.storage.local.set(patch);
      }
      return { added, repointed, marked, mode: releaseBuild ? "release-once" : "dev-always", skippedFull: mayAdd && missing.length > 0 && !fits };
    });
  } catch (e) {
    return { added: 0, error: String((e && e.message) || e) };
  }
}
