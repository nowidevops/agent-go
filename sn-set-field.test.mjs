// sn-set-field.test.mjs — sn_set_field must never hang the run (2026-10-07: setting the
// Dictionary Entry 'Type' froze the agent on "Querying ServiceNow…"). setValue is queued, the
// read-back is bounded, and a reload / blocked page comes back as a clear result.
// Run: node sn-set-field.test.mjs   Author: iDevOpsLLC
import { setServiceNowField } from "./editors.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

// Fake page: one g_form living in frame 3 (gsft_main), none in the top frame.
function makeForm(fields, opts = {}) {
  const store = { ...fields };
  return {
    hasField: (n) => n in store,
    getValue: (n) => store[n],
    getDisplayValue: (n) => store[n],
    setValue: (n, v, d) => { store[n] = opts.storeAs ? opts.storeAs(v) : v; opts.calls && opts.calls.push([n, v, d]); },
    store
  };
}

function installChrome(form, mode = {}) {
  const log = [];
  globalThis.chrome = {
    scripting: {
      executeScript: async ({ target, func, args }) => {
        log.push({ target, fn: func.name });
        const call = log.filter((x) => x.fn === func.name).length;
        if (mode.hangOn === func.name) return new Promise(() => {});
        if (mode.rejectOn === func.name) throw new Error("Frame with ID 3 was removed.");
        const run = (win) => { globalThis.window = win; try { return func(...(args || [])); } finally { delete globalThis.window; } };
        if (target.allFrames) return [{ frameId: 0, result: run({}) }, { frameId: 3, result: run({ g_form: form }) }];
        return [{ frameId: target.frameIds[0], result: run({ g_form: form }) }];
      }
    }
  };
  return log;
}

console.log("— sn_set_field —");

{
  const calls = [];
  const form = makeForm({ active: "false" }, { calls });
  const log = installChrome(form);
  const r = await setServiceNowField(1, { field: "active", value: "true" });
  t("checkbox set + verified", r.ok === true && r.value === "true", JSON.stringify(r));
  t("only the probe fans out; set + read target the g_form frame",
    log[0].target.allFrames === true && log.slice(1).every((x) => x.target.frameIds && x.target.frameIds[0] === 3), JSON.stringify(log));
}

{
  const calls = [];
  const form = makeForm({ internal_type: "" }, { calls });
  installChrome(form);
  const r = await setServiceNowField(1, { field: "internal_type", value: "boolean", display: "True/False" });
  t("display_value is passed as setValue's 3rd arg", calls.length === 1 && calls[0][2] === "True/False", JSON.stringify(calls));
  t("reference keyed by name verifies", r.ok === true && r.value === "boolean", JSON.stringify(r));
}

{
  const form = makeForm({ internal_type: "" });
  installChrome(form, { rejectOn: "pageSnSetFieldRead" });
  const r = await setServiceNowField(1, { field: "internal_type", value: "boolean" });
  t("form reload after set -> ok + reloaded, tells the agent handles are stale", r.ok === true && r.reloaded === true && /stale/.test(r.note), JSON.stringify(r));
}

{
  const form = makeForm({ internal_type: "" });
  installChrome(form, { hangOn: "pageSnSetFieldRead" });
  const t0 = Date.now();
  const r = await setServiceNowField(1, { field: "internal_type", value: "boolean" });
  const ms = Date.now() - t0;
  t("blocked page (dialog) -> returns blocked instead of hanging", r.ok === false && r.blocked === true && /dialog/.test(r.error), JSON.stringify(r));
  t("bounded by the deadline (< 15s)", ms < 15000, `${ms}ms`);
}

{
  const form = makeForm({ caller_id: "" }, { storeAs: () => "" });
  installChrome(form);
  const r = await setServiceNowField(1, { field: "caller_id", value: "not-a-sys-id" });
  t("value that did not stick -> ok:false with guidance", r.ok === false && /STORED value/.test(r.error), JSON.stringify(r));
}

{
  installChrome(makeForm({ active: "true" }));
  const r = await setServiceNowField(1, { field: "ni.sys_script.nope", value: "x" });
  t("unknown field -> clear error", r.ok === false && /field 'nope' is not on this form/.test(r.error), JSON.stringify(r));
}

{
  globalThis.chrome = { scripting: { executeScript: async () => [{ frameId: 0, result: { hasGform: false } }] } };
  const r = await setServiceNowField(1, { field: "active", value: "true" });
  t("no g_form -> classic-form error", r.ok === false && /CLASSIC form/.test(r.error), JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
