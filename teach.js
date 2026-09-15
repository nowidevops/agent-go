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
    const list = await getWorkflows(); // returns a name-deduped list
    workflow.name = uniqueName(workflow.name, list); // no two workflows share a name
    list.push(workflow);
    await chrome.storage.local.set({ teachWorkflows: list.slice(-50) });
  }
  return { ok: true, workflow, eventCount: events.length };
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
function dedupeEvents(events) {
  const out = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    const key = (x) => x?.target?.recId || x?.target?.id || x?.target?.name || x?.target?.label || x?.target?.text;
    if (prev && (e.action === "input" || e.action === "select") && prev.action === e.action && key(prev) === key(e)) {
      out[out.length - 1] = e; // keep latest value for the same field
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

export async function getWorkflows() {
  const { teachWorkflows } = await chrome.storage.local.get("teachWorkflows");
  const list = teachWorkflows || [];
  // Heal any pre-existing duplicate names once; no-op (no write) afterward.
  if (dedupeNames(list)) await chrome.storage.local.set({ teachWorkflows: list });
  return list;
}
export async function deleteWorkflow(id) {
  const list = await getWorkflows();
  await chrome.storage.local.set({ teachWorkflows: list.filter((w) => w.id !== id) });
}
export async function clearWorkflows() {
  await chrome.storage.local.set({ teachWorkflows: [] });
}
