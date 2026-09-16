// conv-log.js — continuous conversation logging to a user-picked local folder
// (e.g. C:\redacted\path), so every conversation becomes
// training material for reinforcing the extension's learning. Author: iDevOpsLLC
//
// A Chrome extension cannot write to an arbitrary OS path, so (exactly like the
// Local-files MCP root) the user grants the folder ONCE via the native picker;
// the FileSystemDirectoryHandle persists in IndexedDB under its own key.
// After every completed run — and after every 👍/👎 — the CURRENT session's
// files are rewritten in full (idempotent):
//   <folder>/YYYY-MM-DD/conv-HHMMSS.md      human-readable conversation
//   <folder>/YYYY-MM-DD/conv-HHMMSS.jsonl   machine-readable events (turns,
//                                           tools, results, feedback) for
//                                           training / lesson distillation
// A new panel session (reload/reopen) starts a new file pair.
//
// Permission survives the browser session only: after a Chrome restart the
// grant returns to "prompt", and re-granting needs a user gesture — clicking
// the 💾 menu item re-grants. Auto-saves are skipped (with one reminder note)
// until then.

import { getConvLogHandle, saveConvLogHandle, clearConvLogHandle, ensureReadWritePermission, hasWritePermission, writeFileText } from "./fsaccess.js";
import { getSettings } from "./settings.js";

let cb = null;            // { bubble, getMarkdown, getEvents, getHistory }
let warnedNoGrant = false; // one reminder per session, not one per run
let saving = false;        // collapse overlapping saves (done + feedback bursts)
let pendingSave = false;

const startedAt = new Date();
function pad(n) { return String(n).padStart(2, "0"); }
const DAY_DIR = startedAt.getFullYear() + "-" + pad(startedAt.getMonth() + 1) + "-" + pad(startedAt.getDate());
const CONV_NAME = "conv-" + pad(startedAt.getHours()) + pad(startedAt.getMinutes()) + pad(startedAt.getSeconds());

// Per-model performance tracking: sessions whose agent model matches one of
// these patterns are grouped into "YYYY-MM-DD-<model>" folders (":tag"
// stripped) instead of the plain day folder, so a new model's corpus can be
// scored in isolation with training/analyze-conversations.mjs — e.g.
// C:\redacted\path
// Add a pattern here when evaluating a new model; remove it once settled.
const TRACKED_MODELS = [/^ornith-1\.5/];
// Locked at the FIRST save of the session (from the model selected then), so a
// mid-session model switch can't fork the rewritten .md/.jsonl pair across
// two folders and leave a stale copy behind.
let _sessionBase = null;
function sessionBaseFor(model) {
  if (_sessionBase) return _sessionBase;
  const tracked = TRACKED_MODELS.some((re) => re.test(model || ""));
  const slug = (model || "").split(":")[0].replace(/[^\w.-]+/g, "-");
  _sessionBase = (tracked && slug ? DAY_DIR + "-" + slug : DAY_DIR) + "/" + CONV_NAME;
  return _sessionBase;
}

const FOLDER_README =
  "# Agent Go conversation log\n\n" +
  "Author: iDevOpsLLC\n\n" +
  "Auto-written by the Agent Go Chrome extension (conv-log.js). One `.md` +\n" +
  "`.jsonl` pair per side-panel session, grouped in YYYY-MM-DD folders (models\n" +
  "under per-model tracking — TRACKED_MODELS in conv-log.js — get their own\n" +
  "`YYYY-MM-DD-<model>` folder so the corpus can be scored in isolation), rewritten\n" +
  "after every completed run and every 👍/👎 so the pair is always complete.\n\n" +
  "- `conv-*.md` — the conversation as readable markdown.\n" +
  "- `conv-*.jsonl` — one JSON event per line: `meta`, `user`, `assistant`,\n" +
  "  `plan`, `tool`, `tool_result`, `child_*` (sub-agents), and `feedback`\n" +
  "  (👍/👎 with scope `run` or `step`) — the reinforcement signal for training\n" +
  "  and lesson distillation.\n";

export function isConvLogConnected() { return !!_handle; }
let _handle = null; // cached across calls; revalidated on use

async function handleReady({ gesture } = {}) {
  if (!_handle) _handle = await getConvLogHandle();
  if (!_handle) return false;
  if (await hasWritePermission(_handle)) return true;
  if (gesture) return ensureReadWritePermission(_handle);
  return false;
}

// Rewrite this session's .md + .jsonl. Safe to call often; overlapping calls
// collapse into one trailing save so feedback bursts don't race the writer.
export async function convLogSave() {
  if (saving) { pendingSave = true; return; }
  saving = true;
  try {
    if (!(await handleReady())) {
      if (_handle && !warnedNoGrant) {
        warnedNoGrant = true;
        cb.bubble("msg note", "💾 Conversation log: the folder grant expired with the browser restart — click + → “Conversation log” once to re-grant. Saving is paused until then.");
      }
      return;
    }
    const events = cb.getEvents();
    const history = cb.getHistory();
    if (!events.length && !history.length) return;

    let model = "";
    try { model = (await getSettings()).model || ""; } catch {}
    const base = sessionBaseFor(model);
    const meta = { t: "meta", session: base, model, savedAt: new Date().toISOString(), turns: history.length, events: events.length };
    const jsonl = [JSON.stringify(meta)]
      .concat(events.map((e) => JSON.stringify(e)))
      .join("\n") + "\n";

    await writeFileText(_handle, base + ".md", cb.getMarkdown());
    await writeFileText(_handle, base + ".jsonl", jsonl);
  } catch (e) {
    if (!warnedNoGrant) {
      warnedNoGrant = true;
      cb.bubble("msg note", "💾 Conversation log: save failed (" + (e.message || e) + "). Click + → “Conversation log” to reconnect.");
    }
  } finally {
    saving = false;
    if (pendingSave) { pendingSave = false; convLogSave(); }
  }
}

async function connect() {
  const dir = await window.showDirectoryPicker({ mode: "readwrite" });
  await saveConvLogHandle(dir);
  _handle = dir;
  warnedNoGrant = false;
  try { await writeFileText(dir, "README.md", FOLDER_README); } catch {}
  cb.bubble("msg note", "💾 Conversation log connected: “" + dir.name + "”. Every run now auto-saves the full conversation there (md + jsonl) — including 👍/👎 feedback for training.");
  await convLogSave(); // capture whatever this session already has
}

async function onMenuClick() {
  try {
    if (!_handle) _handle = await getConvLogHandle();
    if (!_handle) { await connect(); return; }
    // Connected: a click is the re-grant gesture; then offer disconnect.
    const granted = await handleReady({ gesture: true });
    if (granted) {
      warnedNoGrant = false;
      if (confirm("Conversation log is saving to “" + _handle.name + "”.\n\nOK = keep logging (re-granted)\nCancel = disconnect and stop logging")) {
        cb.bubble("msg note", "💾 Conversation log active: “" + _handle.name + "” — re-granted for this session.");
        await convLogSave();
      } else {
        await clearConvLogHandle();
        _handle = null;
        cb.bubble("msg note", "💾 Conversation log disconnected — nothing more will be saved. (Files already written stay on disk.)");
      }
    } else {
      await connect(); // grant refused/unavailable → pick again
    }
  } catch (e) {
    if (e && e.name === "AbortError") return; // user closed the picker
    cb.bubble("msg error", "⚠ Conversation log: " + (e.message || e));
  }
}

export async function initConvLog(callbacks) {
  cb = callbacks;
  document.getElementById("menuConvLog").addEventListener("click", onMenuClick);
  // If connected from a previous session but the grant lapsed with the restart,
  // stay SILENT (no bubble — user found it noisy): just set the flag so the
  // save-time warning is suppressed too. Auto-save quietly pauses; the user can
  // re-grant anytime via + → Conversation log.
  _handle = await getConvLogHandle();
  if (_handle && !(await hasWritePermission(_handle))) {
    warnedNoGrant = true;
  }
}
