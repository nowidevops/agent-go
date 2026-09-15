// run-state.js — durable snapshot of an in-flight agent run, so a run can be
// RESUMED after the MV3 service worker is evicted, the side panel is closed, or
// the browser restarts mid-task. Without this, any interruption discards all
// progress and the trajectory is only ever saved on clean completion.
//
// Resume contract (IMPORTANT — read before changing the checkpoint placement):
//   * A snapshot is only ever written at a CLEAN conversation boundary — after a
//     model turn AND all of that turn's tool results have been appended. We never
//     persist a dangling assistant message that requested tools but has no results
//     yet (that would be a malformed conversation the model template can choke on).
//   * Resume re-feeds the saved `messages` to the model and asks for the NEXT
//     step. It does NOT replay already-executed tools — their results are already
//     in `messages` — so a normal resume causes no duplicate side effects.
//   * The one at-least-once window: if the worker dies AFTER a tool's side effect
//     completed but BEFORE the end-of-step checkpoint, that whole step is redone
//     on resume. Action tools are approval-gated (in "ask" mode), so the user sees
//     and can cancel a re-run; document this rather than silently double-acting.
// Author: iDevOpsLLC

const KEY = "activeRun";
const STATE_VERSION = 1;                 // bump to invalidate incompatible snapshots
const MAX_AGE_MS = 60 * 60 * 1000;       // 1h — a day-old snapshot is stale, not resumable
const MAX_BYTES = 800 * 1024;            // don't risk the 10MB local quota on a giant page read

// Persist (overwrite) the current run snapshot. Returns false if it couldn't be
// stored (too large / storage error) — the run continues either way; it just
// won't be resumable from that point.
export async function saveRunState(state) {
  try {
    const payload = { v: STATE_VERSION, ...state, savedAt: Date.now() };
    const json = JSON.stringify(payload);
    if (json.length > MAX_BYTES) return false; // oversized — skip rather than blow the quota
    await chrome.storage.local.set({ [KEY]: payload });
    return true;
  } catch {
    return false;
  }
}

// Load a resumable snapshot, or null if none / stale / wrong version / malformed.
// Stale snapshots are cleared as a side effect so they don't linger.
export async function loadRunState() {
  try {
    const o = await chrome.storage.local.get(KEY);
    const s = o[KEY];
    if (!s || s.v !== STATE_VERSION) return null;
    if (Date.now() - (s.savedAt || 0) > MAX_AGE_MS) { await clearRunState(); return null; }
    if (!Array.isArray(s.messages) || s.messages.length < 2) return null; // need at least system + a turn
    return s;
  } catch {
    return null;
  }
}

export async function clearRunState() {
  try { await chrome.storage.local.remove(KEY); } catch {}
}

// Lightweight check for the UI: returns { task, step, savedAt, phase? } when a
// run is resumable, else null. Does not return the heavy messages array.
// A resumable PHASE run (interrupted after EXECUTE, draft persisted) takes
// precedence — it's the more valuable resume (skips minutes of evidence work).
export async function peekResumable() {
  const ps = await loadPhaseState();
  if (ps && ps.data && ps.data.draft) {
    return { task: String(ps.envelope?.taskText || "").slice(0, 160), step: 0, savedAt: ps.envelope?.savedAt, phase: ps.envelope?.phase || "review" };
  }
  const s = await loadRunState();
  if (!s) return null;
  return { task: String(s.taskText || "").slice(0, 160), step: s.step || 0, savedAt: s.savedAt };
}

// ---------------------------------------------------------------------------
// Phase-engine envelope (IMPROVEMENTS_PHASE_ENGINE.md §3.3 / MM BL-3).
// SEPARATE keys from "activeRun" so the standalone resume path is untouched:
//   phaseRun  — small gate-state envelope (phase, verdicts, avoid identities,
//               resolved-config hash) — must ALWAYS fit and persist.
//   phaseData — heavy payloads (draft, evidence ledger) under the ~10MB
//               storage.local budget, saved best-effort with VISIBLE failure.
// Byte accounting uses TextEncoder (UTF-8 bytes, not UTF-16 code units — MM
// finding on the activeRun check above; that legacy check is left as-is to
// avoid changing standalone behavior).
// ---------------------------------------------------------------------------

const PHASE_KEY = "phaseRun";
const PHASE_DATA_KEY = "phaseData";
const PHASE_VERSION = 1;
const PHASE_ENVELOPE_MAX = 64 * 1024;        // envelope is small by design
const PHASE_DATA_MAX = 4 * 1024 * 1024;      // heavy payloads, still well under quota

function utf8Bytes(s) {
  try { return new TextEncoder().encode(s).length; } catch { return s.length * 2; }
}

// Persist the gate-state envelope. Returns {ok} or {ok:false, reason} — callers
// MUST surface a failure (never silent; MM BL-3).
export async function savePhaseState(envelope) {
  try {
    const payload = { v: PHASE_VERSION, ...envelope, savedAt: Date.now() };
    const json = JSON.stringify(payload);
    if (utf8Bytes(json) > PHASE_ENVELOPE_MAX) return { ok: false, reason: "envelope too large" };
    await chrome.storage.local.set({ [PHASE_KEY]: payload });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

export async function savePhaseData(data) {
  try {
    const payload = { v: PHASE_VERSION, ...data, savedAt: Date.now() };
    const json = JSON.stringify(payload);
    if (utf8Bytes(json) > PHASE_DATA_MAX) {
      // MM 16z-audit P0-3: a failed data save must NOT leave a STALE payload —
      // otherwise a later run's envelope pairs with this run's draft/ledger and
      // gates the wrong evidence. Clear it so loadPhaseState finds no data.
      try { await chrome.storage.local.remove(PHASE_DATA_KEY); } catch { /* best-effort */ }
      return { ok: false, reason: "phase data too large" };
    }
    await chrome.storage.local.set({ [PHASE_DATA_KEY]: payload });
    return { ok: true };
  } catch (e) {
    try { await chrome.storage.local.remove(PHASE_DATA_KEY); } catch { /* best-effort */ }
    return { ok: false, reason: String(e?.message || e) };
  }
}

export async function loadPhaseState() {
  try {
    const o = await chrome.storage.local.get([PHASE_KEY, PHASE_DATA_KEY]);
    const env = o[PHASE_KEY];
    if (!env || env.v !== PHASE_VERSION) return null;
    if (Date.now() - (env.savedAt || 0) > MAX_AGE_MS) { await clearPhaseState(); return null; }
    let data = o[PHASE_DATA_KEY] && o[PHASE_DATA_KEY].v === PHASE_VERSION ? o[PHASE_DATA_KEY] : null;
    // MM 16z-audit P0-3: BIND envelope↔data by runId — a torn pair (envelope of
    // run B + data of run A) must never be treated as resumable. Fail closed:
    // drop mismatched data so the run is not resumed on the wrong evidence.
    if (data && env.runId && data.runId && env.runId !== data.runId) data = null;
    return { envelope: env, data };
  } catch {
    return null;
  }
}

export async function clearPhaseState() {
  try { await chrome.storage.local.remove([PHASE_KEY, PHASE_DATA_KEY]); } catch {}
}
