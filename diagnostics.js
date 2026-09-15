// diagnostics.js — RCA evidence tools: read the page's console-error tap and the
// extension's failed-network-request log. These give the agent the two evidence
// sources a real root-cause analysis needs and that read_page can't see: the
// JavaScript exception that actually fired, and the HTTP request that actually
// failed. Both are passive/read-only.
// Author: iDevOpsLLC

// Race a promise against a timeout so a stalled call becomes a clean, recoverable
// error instead of an open-ended spinner. executeScript across allFrames is far more
// robust than a content-script sendMessage, but a very busy / many-framed page can
// still delay it — this bounds it the same way read_page's frame reads are bounded.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const e = new Error(`${label} timed out after ${ms / 1000}s`);
      e.__lcTimeout = true;
      reject(e);
    }, ms);
    Promise.resolve(promise).then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); }
    );
  });
}

// ---- read_console: pull the ring buffer installed by console-tap.js ---------
// The tap runs in the MAIN world of every frame at document_start; we read it via
// chrome.scripting in the same world across all frames (a ServiceNow classic form
// lives in iframe#gsft_main — its errors matter as much as the top frame's).
export async function readConsoleTap(tabId, opts = {}) {
  let results;
  try {
    results = await withTimeout(chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => (window.__llmConsoleTap ? window.__llmConsoleTap.read() : null)
    }), 8000, "read_console");
  } catch (e) {
    if (e && e.__lcTimeout) {
      return { error: "read_console timed out reading the page's frames (the tab is very busy or has many iframes). The console tap keeps capturing in the background — retry once, or reload the tab and reproduce the problem, then read again." };
    }
    return { error: `read_console failed: ${e.message}. Restricted pages (chrome://, Web Store, PDFs) cannot be inspected.` };
  }
  const frames = (results || []).filter((r) => Array.isArray(r && r.result));
  if (!frames.length) {
    return { error: "Console tap is not installed on this page — it loads with the page, so a tab opened BEFORE the extension loaded has no tap. navigate to the page's URL (a reload) and reproduce the problem, then call read_console again." };
  }
  let entries = frames.flatMap((r) => r.result);
  entries.sort((a, b) => a.t - b.t);
  const level = String(opts.level || "all").toLowerCase();
  if (level === "error" || level === "warn") entries = entries.filter((e) => e.level === level);
  if (opts.pattern) {
    try { const rx = new RegExp(String(opts.pattern), "i"); entries = entries.filter((e) => rx.test(e.text)); } catch {}
  }
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
  const total = entries.length;
  entries = entries.slice(-limit); // most recent
  return {
    total,
    returned: entries.length,
    entries: entries.map((e) => ({ time: new Date(e.t).toISOString(), level: e.level, text: e.text })),
    note: total
      ? "Captured from page load onward (top frame + iframes). Timestamps are capture time — correlate with read_network and sn_recent_changes."
      : "No console errors/warnings captured since page load. If the problem predates the last reload, reload the page, REPRODUCE the failure, then read again."
  };
}

// ---- read_network: failed-request log (webRequest) ---------------------------
// background.js calls initNetLog() at service-worker startup; listeners record
// ONLY failures (HTTP ≥ 400 or a network error) into a ring buffer mirrored to
// chrome.storage.session so it survives service-worker suspends (cleared when
// the browser exits). Successes are deliberately not recorded — RCA needs the
// request that broke, and recording everything would be a privacy/noise problem.

const NET_MAX = 400;
const NET_KEY = "netFailLog";
let netBuf = [];
let hydrated = false;
let flushTimer = null;

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const o = await chrome.storage.session.get(NET_KEY);
    if (Array.isArray(o[NET_KEY])) netBuf = o[NET_KEY].concat(netBuf);
  } catch {}
}
function flushSoon() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try { chrome.storage.session.set({ [NET_KEY]: netBuf }); } catch {}
  }, 2000);
}
function pushNet(entry) {
  netBuf.push(entry);
  if (netBuf.length > NET_MAX) netBuf.splice(0, netBuf.length - NET_MAX);
  flushSoon();
}
const isOwnTraffic = (url) => /^https?:\/\/(localhost|127\.0\.0\.1):11434\//.test(url);

export function initNetLog() {
  if (!chrome.webRequest) return; // permission missing — tool will report empty
  hydrate();
  const filter = { urls: ["http://*/*", "https://*/*"] };
  chrome.webRequest.onCompleted.addListener((d) => {
    if (d.tabId < 0 || d.statusCode < 400 || isOwnTraffic(d.url)) return;
    pushNet({ t: d.timeStamp, tabId: d.tabId, method: d.method, url: String(d.url).slice(0, 300), status: d.statusCode, type: d.type });
  }, filter);
  chrome.webRequest.onErrorOccurred.addListener((d) => {
    if (d.tabId < 0 || isOwnTraffic(d.url)) return;
    const err = String(d.error || "");
    if (err === "net::ERR_ABORTED") return; // cancelled navigations/fetches — noise, not failures
    pushNet({ t: d.timeStamp, tabId: d.tabId, method: d.method, url: String(d.url).slice(0, 300), error: err, type: d.type });
  }, filter);
}

export async function readNetLog(tabId, opts = {}) {
  await hydrate();
  let entries = netBuf.filter((e) => e.tabId === tabId);
  if (opts.pattern) {
    try { const rx = new RegExp(String(opts.pattern), "i"); entries = entries.filter((e) => rx.test(e.url) || rx.test(String(e.error || "")) || rx.test(String(e.status || ""))); } catch {}
  }
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
  const total = entries.length;
  entries = entries.slice(-limit);
  return {
    total,
    returned: entries.length,
    entries: entries.map((e) => ({
      time: new Date(e.t).toISOString(),
      method: e.method,
      url: e.url,
      ...(e.status != null ? { status: e.status } : {}),
      ...(e.error ? { error: e.error } : {}),
      resource_type: e.type
    })),
    note: total
      ? "Only FAILED requests are recorded (HTTP ≥ 400 or a network error). A 401/403 = auth/permission; 404 = wrong URL/missing resource; 5xx = server-side — check server logs (ServiceNow: syslog via sn_query_table)."
      : "No failed requests recorded for this tab since the extension loaded. REPRODUCE the problem (reload / trigger the failing action), then call read_network again."
  };
}
