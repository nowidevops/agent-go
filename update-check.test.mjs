// update-check.test.mjs — "a newer pack is available": version compare, freshness window,
// dismissal per version, network failure keeps the last answer. Run: node update-check.test.mjs
// Author: iDevOpsLLC
let store = {};
let manifestVersion = "0.2.1";
let fetchImpl = async () => ({ ok: true, json: async () => ({ version: "0.2.2", built: "2026-09-10" }) });
let fetches = 0;
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: manifestVersion }) },
  storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => { Object.assign(store, o); } } },
  alarms: { get: async () => null, create: () => {} }
};
globalThis.fetch = async (...a) => { fetches++; return fetchImpl(...a); };

const { compareVersions, checkForUpdate, dismissUpdate, updateState, metaUrlFor, downloadPageFor } = await import("./update-check.js");

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

t("compare: equal", compareVersions("0.2.1", "0.2.1") === 0);
t("compare: patch newer", compareVersions("0.2.1", "0.2.2") < 0);
t("compare: minor beats patch", compareVersions("0.2.9", "0.3.0") < 0);
t("compare: numeric not lexical", compareVersions("0.2.10", "0.2.9") > 0);
t("compare: missing part is 0", compareVersions("1.0", "1.0.0") === 0);
t("compare: garbage is 0", compareVersions("x", "0.0.1") < 0);
t("meta url: prod", metaUrlFor("https://ai.nowidevops.com/api/llm-go") === "https://ai.nowidevops.com/downloads/agent-go-extension.json");
t("meta url: localhost dev server", downloadPageFor("http://localhost:5001/api/llm-go") === "http://localhost:3000");
t("meta url: garbage → prod", downloadPageFor("") === "https://ai.nowidevops.com");

// First check: fetches, stores, reports available.
let st = await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go" });
t("first check fetched once", fetches === 1);
t("newer version reported available", st.available === true && st.latest === "0.2.2" && st.current === "0.2.1" && st.built === "2026-09-10");
// Second check inside the freshness window: no fetch.
st = await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go" });
t("fresh answer is reused without a fetch", fetches === 1 && st.available === true);
// Forced: fetches again.
await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go", force: true });
t("force fetches", fetches === 2);
// Dismiss: hidden for this version only.
st = await dismissUpdate();
t("dismissed hides the notice", st.available === false && st.newer === true && st.dismissed === true);
fetchImpl = async () => ({ ok: true, json: async () => ({ version: "0.2.3", built: "2026-09-12" }) });
st = await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go", force: true });
t("next version shows again after a dismissal", st.available === true && st.latest === "0.2.3");
// Network failure: last good answer kept, error noted.
fetchImpl = async () => { throw new Error("offline"); };
st = await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go", force: true });
t("failure keeps the last answer", st.available === true && st.latest === "0.2.3" && st.error === "offline");
// Bad metadata (no version): same.
fetchImpl = async () => ({ ok: true, json: async () => ({ nope: 1 }) });
st = await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go", force: true });
t("metadata without a version is ignored", st.latest === "0.2.3" && /no version/.test(st.error));
// HTTP error: same.
fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
st = await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go", force: true });
t("HTTP error is reported, answer kept", st.latest === "0.2.3" && st.error === "HTTP 503");
// Installed copy is ahead of (or equal to) the published one: nothing to show.
store = {}; manifestVersion = "0.3.0";
fetchImpl = async () => ({ ok: true, json: async () => ({ version: "0.2.3" }) });
st = await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go", force: true });
t("newer local build shows nothing", st.available === false && st.newer === false);
{ const before = fetches; const st2 = await updateState(); t("updateState reads without fetching", st2.latest === "0.2.3" && fetches === before); }
// Odd version strings from the server are rejected; Chrome's 4-part versions are accepted.
store = {}; manifestVersion = "0.2.1";
fetchImpl = async () => ({ ok: true, json: async () => ({ version: "<script>" }) });
st = await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go", force: true });
t("non-numeric server version rejected", st.latest === null && st.available === false);
t("failed attempt is marked stale-free when nothing was known", st.stale === false);
fetchImpl = async () => ({ ok: true, json: async () => ({ version: "0.2.10.1" }) });
st = await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go", force: true });
t("four-part version accepted and newer", st.latest === "0.2.10.1" && st.available === true);
// After a failure the unforced path backs off for 15 minutes instead of retrying on every page open.
fetchImpl = async () => { throw new Error("offline"); };
st = await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go", force: true });
t("failure with a known answer is reported as stale", st.stale === true && st.latest === "0.2.10.1");
{ const before = fetches; await checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go" }); t("unforced check backs off after an error", fetches === before); }
// A dismissal clicked while a forced check is in flight survives it.
let release; fetchImpl = () => new Promise((r) => { release = () => r({ ok: true, json: async () => ({ version: "0.2.10.1" }) }); });
const pending = checkForUpdate({ backendUrl: "https://ai.nowidevops.com/api/llm-go", force: true });
await new Promise((r) => setTimeout(r, 5));
await dismissUpdate("0.2.10.1");
release(); st = await pending;
t("dismissal during an in-flight check is kept", st.dismissed === true && st.available === false);
// Concurrent unforced callers share one fetch.
store = {}; fetchImpl = async () => ({ ok: true, json: async () => ({ version: "0.2.11" }) });
{ const before = fetches; await Promise.all([checkForUpdate({}), checkForUpdate({}), checkForUpdate({})]); t("concurrent checks share one fetch", fetches === before + 1); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
