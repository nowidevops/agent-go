// demo-workflows.test.mjs — pins seedDemoWorkflows() (teach.js) and the shipped demo-workflows.json.
// Hardened rules after an internal review: all-or-nothing within the 50 cap, demo marker, repoint only our rows,
// flag only when every demo is present, one combined write, one Web Lock for every list writer.
// Run: node demo-workflows.test.mjs   (stubs chrome.storage / chrome.runtime / fetch / navigator.locks)   Author: iDevOpsLLC
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };

const DEMO_NAMES = ["Request Caregiver Availability", "Submit Tollbrook Care Claim"];
const store = {};
let writes = 0;
let manifest = {};
const tick = () => new Promise((r) => setTimeout(r, 0));
globalThis.chrome = {
  storage: { local: {
    get: async (k) => { await tick(); const keys = Array.isArray(k) ? k : [k]; const o = {}; for (const x of keys) if (x in store) o[x] = JSON.parse(JSON.stringify(store[x])); return o; },
    set: async (o) => { await tick(); writes++; for (const [k, v] of Object.entries(o)) store[k] = JSON.parse(JSON.stringify(v)); },
  } },
  runtime: { getURL: (p) => "chrome-extension://test/" + p, getManifest: () => manifest },
};
// A minimal exclusive Web Lock: one holder at a time per name, FIFO.
let lockDepth = 0, maxDepth = 0, lockCalls = 0;
const chains = new Map();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: (name, fn) => {
  lockCalls++;
  const prev = chains.get(name) || Promise.resolve();
  const run = prev.then(async () => { lockDepth++; maxDepth = Math.max(maxDepth, lockDepth); try { return await fn(); } finally { lockDepth--; } });
  chains.set(name, run.catch(() => {}));
  return run;
} } } });
const demoRaw = fs.readFileSync(new URL("./demo-workflows.json", import.meta.url), "utf8");
let fetchMode = "ok", fetchBody = null;
globalThis.fetch = async (url) => {
  if (fetchMode === "throw") throw new Error("net down");
  return { ok: fetchMode !== "404" && /demo-workflows\.json$/.test(url), json: async () => (fetchBody !== null ? fetchBody : JSON.parse(demoRaw)) };
};
const reset = () => { for (const k of Object.keys(store)) delete store[k]; writes = 0; fetchMode = "ok"; fetchBody = null; };
const demos = (l) => l.filter((w) => w.demo === true);
const users = (n) => Array.from({ length: n }, (_, i) => ({ id: "u" + i, name: "User " + i, steps: ["x"], parameters: [] }));

const { seedDemoWorkflows, getWorkflows, deleteWorkflow, clearWorkflows } = await import("./teach.js");

// 1. The shipped file.
let data = null;
try { data = JSON.parse(demoRaw); } catch {}
ok("demo-workflows.json parses to an array of 2", Array.isArray(data) && data.length === 2);
const byName = Object.fromEntries((data || []).map((w) => [w.name, w]));
ok("Caregiver workflow: 9 steps / 5 params", byName[DEMO_NAMES[0]]?.steps?.length === 9 && byName[DEMO_NAMES[0]]?.parameters?.length === 5);
ok("Tollbrook workflow: 12 steps / 7 params", byName[DEMO_NAMES[1]]?.steps?.length === 12 && byName[DEMO_NAMES[1]]?.parameters?.length === 7);
ok("both carry demo: true", (data || []).every((w) => w.demo === true));
const urls = (data || []).flatMap((w) => JSON.stringify([w.steps, w.recordedSteps || []]).match(/https?:\/\/[^\s"'\\)]+/g) || []);
ok("every step URL is https://ai.nowidevops.com/demo/...", urls.length > 0 && urls.every((u) => u.startsWith("https://ai.nowidevops.com/demo/")), urls.join(" "));
ok("no localhost and no 'Tolbroop' typo left", !/localhost/i.test(demoRaw) && !/Tolbroop/i.test(demoRaw));

// 2. Dev copy (no key): always restores missing demos; marked rows.
reset(); manifest = {};
store.teachWorkflows = [{ id: "own", name: "My own workflow", steps: ["Open settings"], parameters: [] }];
let r = await seedDemoWorkflows();
let list = await getWorkflows();
ok("dev: first run adds both, marked demo, flag set in the SAME write", r.added === 2 && r.mode === "dev-always" && demos(list).length === 2 && writes === 1 && store.demoWorkflowsSeeded, JSON.stringify({ r, writes }));
ok("dev: seeded rows keep the shipped id as demoId and get a fresh id", demos(list).every((w) => w.demoId && w.id !== w.demoId));
writes = 0;
r = await seedDemoWorkflows();
ok("dev: second run writes nothing", r.added === 0 && writes === 0, JSON.stringify({ r, writes }));
await deleteWorkflow(demos(await getWorkflows())[0].id);
r = await seedDemoWorkflows();
ok("dev: a deleted demo comes back", r.added === 1 && demos(await getWorkflows()).length === 2, JSON.stringify(r));

// 3. Release build: once per version; deletions and Clear all stick.
reset(); manifest = { key: "MIIBIjANBgkq-test" };
store.teachWorkflows = [{ id: "own", name: "My own workflow", steps: ["x"], parameters: [] }];
r = await seedDemoWorkflows();
ok("release: first run adds both and sets the flag", r.added === 2 && r.mode === "release-once" && store.demoWorkflowsSeeded, JSON.stringify(r));
await deleteWorkflow(demos(await getWorkflows())[0].id);
writes = 0;
r = await seedDemoWorkflows();
ok("release: deleted demo stays deleted, no writes", r.added === 0 && demos(await getWorkflows()).length === 1 && writes === 0, JSON.stringify({ r, writes }));
await clearWorkflows();
r = await seedDemoWorkflows();
ok("release: after Clear all nothing comes back", r.added === 0 && (await getWorkflows()).length === 0);

// 4. Cap: all-or-nothing, user rows never evicted, flag NOT burned when they did not fit.
reset(); manifest = { key: "k" };
store.teachWorkflows = users(49);
r = await seedDemoWorkflows();
list = await getWorkflows();
ok("cap 49: neither demo added (both would not fit), all user rows kept", r.added === 0 && r.skippedFull === true && list.length === 49 && list[0].id === "u0", JSON.stringify(r));
ok("cap 49: release flag not set, so they arrive once there is room", !("demoWorkflowsSeeded" in store));
store.teachWorkflows = users(40);
r = await seedDemoWorkflows();
ok("room again: both added, flag set", r.added === 2 && store.demoWorkflowsSeeded && (await getWorkflows()).length === 42, JSON.stringify(r));
reset(); manifest = {};
store.teachWorkflows = users(50);
writes = 0;
r = await seedDemoWorkflows();
ok("cap 50 (dev): full list untouched, no write", r.added === 0 && writes === 0 && store.teachWorkflows.length === 50);
reset(); manifest = {};
store.teachWorkflows = users(60);
store.teachWorkflows.push({ ...byName[DEMO_NAMES[0]], id: "old", demo: true, steps: ["Navigate to http://localhost:8899/quillmoor/"] });
r = await seedDemoWorkflows();
ok("over-cap legacy list: repoint never truncates user rows", r.repointed === 1 && store.teachWorkflows.length === 61 && store.teachWorkflows[0].id === "u0", JSON.stringify(r));

// 5. Marker, legacy rows and repoint identity.
reset(); manifest = { key: "k" };
const legacy = { ...byName[DEMO_NAMES[0]], id: "legacy-1012" };
delete legacy.demo;
legacy.steps = legacy.steps.map((s) => s.replace("https://ai.nowidevops.com/demo/", "http://localhost:8899/"));
const mine = { id: "mine", name: DEMO_NAMES[1], description: "my own claim run", steps: ["Navigate to http://localhost:8899/tollbrook/", "Click Submit"], parameters: [] };
store.teachWorkflows = [legacy, mine];
store.demoWorkflowsSeeded = "saved-workflows-video-2026-09-14-public";
r = await seedDemoWorkflows();
list = await getWorkflows();
const lg = list.find((w) => w.id === "legacy-1012");
const mn = list.find((w) => w.id === "mine");
ok("legacy 1.0.12 row is recognised: marked demo and repointed, id kept", lg && lg.demo === true && !JSON.stringify(lg.steps).includes("localhost") && r.marked === 1 && r.repointed === 1, JSON.stringify(r));
ok("user's own same-named workflow is NOT touched (steps, no marker)", mn && mn.demo !== true && mn.steps.length === 2 && mn.steps[0].includes("localhost:8899"), JSON.stringify(mn));
ok("release: nothing re-added over the user's same-named row", !list.some((w) => /\(\d+\)$/.test(w.name)) && list.length === 2);

// 6. Bad payloads and fetch failures: no write, flag never burned.
for (const [label, mode, body] of [["404", "404", null], ["throws", "throw", null], ["empty array", "ok", []], ["object", "ok", {}], ["entries without steps", "ok", [{ name: "x" }]]]) {
  reset(); manifest = { key: "k" };
  store.teachWorkflows = [{ id: "own", name: "Mine", steps: ["x"], parameters: [] }];
  fetchMode = mode; fetchBody = body;
  r = await seedDemoWorkflows();
  ok(`bad input (${label}): nothing written, flag not set, user list intact`, r.added === 0 && writes === 0 && !("demoWorkflowsSeeded" in store) && store.teachWorkflows.length === 1, JSON.stringify(r));
}

// 7. Concurrency: every list writer goes through one lock; no double add, no lost user write.
reset(); manifest = {};
store.teachWorkflows = [{ id: "own", name: "Mine", steps: ["x"], parameters: [] }];
lockCalls = 0; maxDepth = 0;
await Promise.all([seedDemoWorkflows(), seedDemoWorkflows(), deleteWorkflow("own")]);
const writerLockCalls = lockCalls;
list = await getWorkflows();
ok("seed + seed + delete at once: exactly 2 demos, the delete is not lost", demos(list).length === 2 && !list.some((w) => w.id === "own") && !list.some((w) => /\(\d+\)$/.test(w.name)), JSON.stringify(list.map((w) => w.name)));
ok("writers took the lock one at a time", writerLockCalls === 3 && maxDepth === 1, JSON.stringify({ writerLockCalls, maxDepth }));
const src = fs.readFileSync(new URL("./teach.js", import.meta.url), "utf8");
ok("recording save runs under the same lock", /await withWorkflowsLock\(async \(\) => \{\s*const list = await readWorkflowList\(\); \/\/ returns a name-deduped list/.test(src));

// 8. Both renderers label demo rows.
const opt = fs.readFileSync(new URL("./options.js", import.meta.url), "utf8");
const sp = fs.readFileSync(new URL("./sidepanel.js", import.meta.url), "latin1");
ok("Settings list shows a DEMO badge for demo rows", /w\.demo \? '<span title="Sample workflow[^']*>DEMO<\/span>'/.test(opt));
ok("side panel run list prefixes demo rows", /\$\{w\.demo \? "Demo · " : ""\}\$\{w\.name\}/.test(sp) || sp.includes('${w.demo ? "Demo'));
const bg = fs.readFileSync(new URL("./background.js", import.meta.url), "latin1");
ok("service worker seeds on install and on browser start", (bg.match(/seedDemoWorkflows\(\)/g) || []).length >= 2 && /onStartup[\s\S]{0,200}seedDemoWorkflows/.test(bg));

// 9. an internal review follow-up (1.0.14 / 0.2.20).
reset(); manifest = {};
store.teachWorkflows = [{ id: "a", name: "Dup", steps: ["x"], parameters: [] }, { id: "b", name: "Dup", steps: ["y"], parameters: [] }];
lockCalls = 0; maxDepth = 0;
await Promise.all([getWorkflows(), seedDemoWorkflows(), getWorkflows()]);
list = store.teachWorkflows;
ok("B1: getWorkflows takes the lock, so its heal write never overlaps a writer", lockCalls === 3 && maxDepth === 1, JSON.stringify({ lockCalls, maxDepth }));
ok("B1: heal + seed together keep both demos and unique names", demos(list).length === 2 && new Set(list.map((w) => w.name.toLowerCase())).size === list.length, JSON.stringify(list.map((w) => w.name)));

reset(); manifest = { key: "k" };
store.teachWorkflows = [{ id: "mine", name: DEMO_NAMES[0], description: "my own", steps: ["a", "b"], parameters: [] }];
r = await seedDemoWorkflows();
list = await getWorkflows();
ok("B3: a user's same-named row does not hide the demo; the demo gets a unique name", r.added === 2 && demos(list).some((w) => w.name === DEMO_NAMES[0] + " (2)") && list.find((w) => w.id === "mine").demo !== true, JSON.stringify(list.map((w) => w.name)));
ok("B3: flag set only once the demos are really there", store.demoWorkflowsSeeded === "saved-workflows-video-2026-09-14-public" && demos(list).length === 2);
reset(); manifest = {};
store.teachWorkflows = [{ id: "mine", name: DEMO_NAMES[1], description: "my own", steps: ["a"], parameters: [] }];
await seedDemoWorkflows();
writes = 0;
r = await seedDemoWorkflows();
ok("B3: dev reload recognises the renamed demo by demoId and adds nothing", r.added === 0 && writes === 0 && store.teachWorkflows.length === 3, JSON.stringify({ r, writes }));

reset(); manifest = {};
store.teachWorkflows = users(3);
const everything = Promise.all([getWorkflows(), deleteWorkflow("u0"), seedDemoWorkflows(), getWorkflows(), clearWorkflows()]);
const finished = await Promise.race([everything.then(() => true), new Promise((res) => setTimeout(() => res(false), 2000))]);
ok("no deadlock: readers and every writer finish under the lock", finished);

const src2 = fs.readFileSync(new URL("./teach.js", import.meta.url), "utf8");
ok("B2: recording save refuses at the cap instead of slice(-50)", !/slice\(-50\)/.test(src2) && /if \(list\.length >= WORKFLOW_CAP\) return false;/.test(src2));
ok("B2: side panel shows the refusal instead of 'Saved.'", /res\?\.workflow && res\.ok !== false/.test(sp) && /res\?\.error \|\|/.test(sp));
ok("B5: teach_stop and get_workflows always answer the panel", /teachStop\(msg\.narration, s\)\)\.then\(sendResponse, \(e\) =>/.test(bg) && /getWorkflows\(\)\.then\(sendResponse, \(\) => sendResponse\(\[\]\)\)/.test(bg));
ok("B6: Settings says when the demos were skipped at the cap", /r && r\.skippedFull/.test(opt));
ok("B7: service worker cold start seeds demo workflows", /\nseedDemoWorkflows\(\)\.catch\(\(\) => \{\}\);/.test(bg));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
