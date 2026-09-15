// update-check.js — "a newer Agent Go pack is available" (owner request 2026-09-03).
// Author: iDevOpsLLC
//
// The pack is installed by "Load unpacked", so Chrome never updates it. This module compares the
// installed manifest version with the version published beside the download zip
// (https://ai.nowidevops.com/downloads/agent-go-extension.json, written by
// .ci/build_agent_go_dist.py, served no-cache) and remembers the answer in chrome.storage.local
// under UPDATE_KEY. The background worker checks on install/startup and once a day (alarm);
// Options and the side panel read the stored answer and offer "Check now".
//
// A dismissed version stays dismissed; the next version shows again. Network failures are
// silent — the stored answer is kept, never replaced with a false "up to date".

export const UPDATE_KEY = "agentGoUpdate";
export const UPDATE_ALARM = "agentgo-update-check";
export const CHECK_INTERVAL_MIN = 24 * 60;
const FRESH_MS = 6 * 60 * 60 * 1000; // a stored answer younger than this is not re-fetched unless forced
const FETCH_TIMEOUT_MS = 8000;
const RETRY_AFTER_ERROR_MS = 15 * 60 * 1000; // after a failed attempt, wait this long before trying again unforced
let inFlight = null; // one fetch at a time; concurrent callers share it

/** Where the pack and its metadata live for this backend (localhost dev server keeps working). */
export function downloadPageFor(backendUrl) {
  try {
    const u = new URL(String(backendUrl || ""));
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return "http://localhost:3000";
  } catch (_e) { /* fall through to production */ }
  return "https://ai.nowidevops.com";
}
export function metaUrlFor(backendUrl) { return downloadPageFor(backendUrl) + "/downloads/agent-go-extension.json"; }

/** Dotted numeric versions: -1 when a < b, 0 when equal, 1 when a > b. Non-numeric parts count as 0. */
export function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function installedVersion() {
  try { return chrome.runtime.getManifest().version || "0.0.0"; } catch (_e) { return "0.0.0"; }
}

async function readStored() {
  try { const o = await chrome.storage.local.get(UPDATE_KEY); return (o && o[UPDATE_KEY]) || {}; } catch (_e) { return {}; }
}
async function writeStored(state) {
  try { await chrome.storage.local.set({ [UPDATE_KEY]: state }); } catch (_e) { /* storage unavailable */ }
}

/** Shape both pages render from. `available` already honours the dismissal. */
export function describe(stored) {
  const current = installedVersion();
  const latest = stored && stored.latest ? String(stored.latest) : null;
  const newer = !!latest && compareVersions(current, latest) < 0;
  return {
    current,
    latest,
    built: (stored && stored.built) || null,
    checkedAt: (stored && stored.checkedAt) || null,
    newer,
    dismissed: !!latest && stored.dismissed === latest,
    available: newer && stored.dismissed !== latest,
    error: (stored && stored.error) || null,
    errorAt: (stored && stored.errorAt) || null,
    // The last attempt failed but an older answer is still on screen.
    stale: !!(stored && stored.error && stored.latest)
  };
}

export async function updateState() { return describe(await readStored()); }

/**
 * Fetch the published metadata and store the result. Returns describe(state).
 * @param {object} [o] { backendUrl, force } — force ignores the freshness window ("Check now").
 */
export async function checkForUpdate(o = {}) {
  const stored = await readStored();
  if (!o.force) {
    if (stored.checkedAt && Date.now() - stored.checkedAt < FRESH_MS) return describe(stored);
    if (stored.errorAt && Date.now() - stored.errorAt < RETRY_AFTER_ERROR_MS) return describe(stored);
  }
  if (inFlight) return inFlight; // a check is already running (panel + options opened together)
  inFlight = (async () => {
    const url = metaUrlFor(o.backendUrl);
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      // Chrome allows 1-4 dot-separated integers, each 0-65535.
      const latest = j && /^[0-9]{1,5}(\.[0-9]{1,5}){1,3}$/.test(String(j.version || "")) ? String(j.version) : null;
      if (!latest) throw new Error("no version in metadata");
      // Re-read: a "Not now" clicked while this fetch was running must not be lost.
      const fresh = await readStored();
      const next = { checkedAt: Date.now(), latest, built: j.built || null, dismissed: fresh.dismissed || null, error: null, errorAt: null };
      await writeStored(next);
      return describe(next);
    } catch (e) {
      // Keep the last good answer; only note that this attempt failed.
      const fresh = await readStored();
      const next = Object.assign({}, fresh, { checkedAt: fresh.checkedAt || null, error: String((e && e.message) || e).slice(0, 120), errorAt: Date.now() });
      await writeStored(next);
      return describe(next);
    } finally {
      if (timer) clearTimeout(timer);
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Hide the notice for THIS version only; the next release shows again. */
export async function dismissUpdate(version) {
  const stored = await readStored();
  const v = version || stored.latest;
  if (!v) return describe(stored);
  const next = Object.assign({}, stored, { dismissed: String(v) });
  await writeStored(next);
  return describe(next);
}

/** Background worker: create the daily alarm (idempotent) and run one check now. */
export async function scheduleUpdateChecks(backendUrl) {
  try {
    const existing = await chrome.alarms.get(UPDATE_ALARM);
    if (!existing) chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 5, periodInMinutes: CHECK_INTERVAL_MIN });
  } catch (_e) { /* alarms unavailable — the pages still check when opened */ }
  return checkForUpdate({ backendUrl });
}

/** Plain-English instructions, shared by both pages (kept in step with INSTALL.md "Updating"). */
export function updateSteps() {
  return "Download the new zip, empty the folder you installed from, unzip the new files into that same folder, then reload Agent Go on chrome://extensions. Your sign-in, settings and shortcuts are kept. If the Agent Go card on chrome://extensions shows an ID other than igpadcnljdbbhklmgemlflnodnoihheb, follow the one-time exception in INSTALL.md instead (Remove, then Load unpacked).";
}
