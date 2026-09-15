// frame-discovery.test.mjs — the query_elements/read_page hang fix (2026-07-27).
//
// Live a-live-run: query_elements on a large ServiceNow incident form never
// returned. The per-frame message timeout in sendToAllFrames (the 2026-07-22
// read_page fix) protects the step AFTER frame discovery; discovery itself
// awaited chrome.scripting.executeScript({allFrames:true}) with NO deadline, so a
// single never-settling frame left the promise pending forever — which in the MV3
// service worker means eviction at the 30s idle mark, taking the pending promise
// and every rescue setTimeout with it. No tool_result, no error, dead run.
//
// These tests pin the two invariants that make that impossible: discovery is
// always bounded, and a hang degrades to "top frame only" instead of hanging.
// Run: node frame-discovery.test.mjs   Author: iDevOpsLLC

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

// Minimal chrome stub — tools.js only touches these at import time.
globalThis.chrome = {
  runtime: { getURL: (p) => p, onMessage: { addListener() {} } },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  tabs: { onUpdated: { addListener() {}, removeListener() {} } },
  scripting: { executeScript: async () => [] }
};

const { withDeadline, frameIdsWithContent } = await import("./tools.js");

const NEVER = new Promise(() => {});           // the hung-frame case
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("— withDeadline —");
t("resolves the real value when it beats the deadline",
  (await withDeadline(Promise.resolve("real"), 1000, "fb")) === "real");
t("resolves the fallback when the promise NEVER settles (the hang)",
  (await withDeadline(NEVER, 50, "fb")) === "fb");
// A rejection must NOT become the fallback: executeScript rejects instantly on a
// restricted page (chrome://, PDF, Web Store) and that deserves its own message,
// distinct from a page that is merely hung. Callers that want a rejection to
// degrade opt in with .catch() at the call site.
let rejected = false;
try { await withDeadline(Promise.reject(new Error("boom")), 1000, "fb"); }
catch (e) { rejected = e.message === "boom"; }
t("propagates a rejection rather than masking it as the fallback", rejected);
t("a slow-but-finishing promise still yields the fallback past the deadline",
  (await withDeadline(sleep(200).then(() => "late"), 50, "fb")) === "fb");
t("a rejection AFTER the deadline is swallowed, not left unhandled",
  (await withDeadline(sleep(100).then(() => { throw new Error("late boom"); }), 30, "fb")) === "fb");
// The whole point: bounded. Without the deadline this line never returns.
const started = Date.now();
await withDeadline(NEVER, 60, null);
t("returns within its budget rather than pending forever", Date.now() - started < 2000,
  `took ${Date.now() - started}ms`);

console.log("— frameIdsWithContent —");

// Normal page: three frames, all with content.js live.
chrome.scripting.executeScript = async () => ([
  { frameId: 0, result: true }, { frameId: 7, result: true }, { frameId: 9, result: true }
]);
t("returns every ready frame on a healthy page",
  JSON.stringify(await frameIdsWithContent(1)) === JSON.stringify([0, 7, 9]));

// A frame that is injectable but not yet ready gets content.js forced in, then counts.
let call = 0;
chrome.scripting.executeScript = async () => {
  call++;
  return call === 1 ? [{ frameId: 0, result: true }, { frameId: 4, result: false }] : [{ frameId: 4 }];
};
t("force-injects not-yet-ready frames and includes them",
  JSON.stringify(await frameIdsWithContent(1)) === JSON.stringify([0, 4]));

// THE REGRESSION: the all-frames probe hangs (a busy ServiceNow iframe).
chrome.scripting.executeScript = () => NEVER;
const t0 = Date.now();
const hung = await frameIdsWithContent(1);
t("a hung all-frames probe degrades to the top frame",
  JSON.stringify(hung) === JSON.stringify([0]), JSON.stringify(hung));
t("...and does so in bounded time (was: never returned)", Date.now() - t0 < 15000,
  `took ${Date.now() - t0}ms`);

// The probe answers but the FORCED INJECTION hangs — the frames that did answer
// must still serve the read rather than the whole call stalling.
let call2 = 0;
chrome.scripting.executeScript = (...a) => {
  call2++;
  if (call2 === 1) return Promise.resolve([{ frameId: 0, result: true }, { frameId: 5, result: false }]);
  return NEVER;
};
const t1 = Date.now();
const partial = await frameIdsWithContent(1);
t("a hung force-injection still returns the frames that answered",
  JSON.stringify(partial) === JSON.stringify([0]), JSON.stringify(partial));
t("...also in bounded time", Date.now() - t1 < 15000, `took ${Date.now() - t1}ms`);

// A throwing probe (restricted page) must not take the run down — frame discovery
// opts into degrading via .catch(), even though withDeadline itself propagates.
chrome.scripting.executeScript = async () => { throw new Error("Cannot access contents"); };
t("a throwing probe falls back to the top frame",
  JSON.stringify(await frameIdsWithContent(1)) === JSON.stringify([0]));

// A rejecting force-injection likewise degrades to the frames that did answer.
let call3 = 0;
chrome.scripting.executeScript = async () => {
  call3++;
  if (call3 === 1) return [{ frameId: 0, result: true }, { frameId: 6, result: false }];
  throw new Error("frame went away mid-inject");
};
t("a rejecting force-injection keeps the frames that answered",
  JSON.stringify(await frameIdsWithContent(1)) === JSON.stringify([0]));

// No unhandled rejection may escape (an abandoned late-rejecting promise is the
// classic way a "fixed" timeout still crashes the worker).
let unhandled = 0;
process.on("unhandledRejection", () => { unhandled++; });
chrome.scripting.executeScript = () => sleep(80).then(() => { throw new Error("late"); });
await frameIdsWithContent(1);
await sleep(250);
t("no unhandled rejection escapes a late-failing probe", unhandled === 0, `saw ${unhandled}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
