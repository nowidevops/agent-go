// sn-wf-activity-set.test.mjs — sn_wf_activity_set / sn_wf_delete_activity
// (2026-09-02, STRY0000001 implementation runs 15:39 / 15:46 / 16:01).
//
// The story needed four workflow-activity inputs changed and one activity
// removed. Every sn_update_record on sys_variable_value came back 403, the
// sys_variable_value form rendered Value read-only, and the model spent ~40
// DOM calls in the Workflow Editor without finding "Set Values". These tests
// pin the one-call replacement: draft guard, unchanged short-circuit, API route
// with the session fallback, the switch to the activity's own form after an
// API refusal (field naming wf_activity.vars.var__m_<def>.<element>), read-only
// and missing-field diagnosis BEFORE any save, verification against the rows
// (not the tool's own success), the Set-Values script fallback hint, and the
// delete tool's re-point → delete → sweep → verify order with a safe stop on
// the first refusal.
// Run: node sn-wf-activity-set.test.mjs   Author: iDevOpsLLC
import { snWorkflowActivitySet, snWorkflowDeleteActivity, snWorkflowFixScript, buildWfFixScript, pageWfActivitySetFields, forgetAclDenials } from "./sn-tools.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };

const ORIGIN = "https://customer-dev.example.com";
const BASIC = () => ({ origin: ORIGIN, headers: { Authorization: "Basic xyz" }, credentials: "omit" });
const ACT = "728fd49a1bcbcb10773186eae54bcbc3";     // Active Directory (draft)
const DEF = "c1d5ea1b0a0a0b3f00a1b2c3d4e5f607";     // Catalog Task definition
const VER = "6a8f509a1bcbcb10773186eae54bcb50";     // checked-out draft
const ROW_SCRIPT = "328fd49a1bcbcb10773186eae54bcbc8";
const ROW_VALUES = "328fd49a1bcbcb10773186eae54bcbc6";
const OLD_SCRIPT = "var user = 'x';\ntask.short_description = 'Move - verify any additional share drive access (' + current.due_date + ') ' + user;";
const NEW_SCRIPT = "var user = 'x';\ntask.short_description = 'Move - Update AD info';";
const OLD_VALUES = "assignment_group=16c8e04fdb85f7804f387d0e0f961953^description=Verify if any additional share drive access needs to be configured^EQ";
const NEW_VALUES = "assignment_group=16c8e04fdb85f7804f387d0e0f961953^description=Update Active Directory (as applicable)\n- \"Description\" field\n- OU container^EQ";
const ACL = { error: { message: "Operation Failed", detail: "ACL Exception Update Failed due to security constraints" }, status: "failure" };

// ---- an in-memory instance ---------------------------------------------------
let db, calls, plan;
function resetDb(over = {}) {
  db = {
    wf_activity: {
      [ACT]: { sys_id: ACT, name: "Active Directory", activity_definition: DEF, "activity_definition.name": "Catalog Task", workflow_version: VER, "workflow_version.name": "User Move R7", "workflow_version.published": "false", "workflow_version.checked_out_by": "Alex Rivera", "workflow_version.workflow": "w1" },
      ...(over.wf_activity || {})
    },
    sys_variable_value: {
      [ROW_SCRIPT]: { sys_id: ROW_SCRIPT, document: "wf_activity", document_key: ACT, variable: "v1", "variable.element": "advanced_script", value: OLD_SCRIPT },
      [ROW_VALUES]: { sys_id: ROW_VALUES, document: "wf_activity", document_key: ACT, variable: "v2", "variable.element": "values", value: OLD_VALUES },
      ...(over.sys_variable_value || {})
    },
    wf_activity_variable: { v1: { sys_id: "v1", model: DEF, element: "advanced_script" }, v2: { sys_id: "v2", model: DEF, element: "values" }, v3: { sys_id: "v3", model: DEF, element: "short_description" } },
    wf_condition: over.wf_condition || {},
    wf_transition: over.wf_transition || {}
  };
  calls = [];
  forgetAclDenials(); // the 2026-09-04 ACL-table memo is process-wide; each case starts clean
  plan = { write: {} }; // write: { basic: {status, body}, session: {status, body} } — default: succeed
}
function q(table, query) {
  // Minimal encoded-query evaluator for the shapes the tools issue.
  const rows = Object.values(db[table] || {});
  return rows.filter((r) => query.split("^").every((clause) => {
    if (!clause || /^ORDERBY/.test(clause)) return true;
    let m;
    if ((m = /^(.+?)IN(.+)$/.exec(clause)) && !/[=]/.test(m[1])) { const list = m[2].split(","); return list.includes(String(r[m[1]] || "")); }
    if ((m = /^(.+?)=(.*)$/.exec(clause))) return String(r[m[1]] || "") === m[2];
    if (/ISNOTEMPTY$/.test(clause)) return !!r[clause.replace(/ISNOTEMPTY$/, "")];
    return true;
  }));
}
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const h = (init && init.headers) || {};
  const path = h.Authorization ? "basic" : (h["X-UserToken"] ? "session" : "session-no-token");
  const m = /\/api\/now\/table\/([^/?]+)(?:\/([0-9a-f]{32}))?/.exec(u.pathname);
  const table = m[1], sysId = m[2];
  const method = (init && init.method) || "GET";
  calls.push({ method, table, sysId, path, body: init && init.body ? JSON.parse(init.body) : null });
  if (method === "GET") {
    const rows = q(table, u.searchParams.get("sysparm_query") || "");
    const fields = (u.searchParams.get("sysparm_fields") || "").split(",").filter(Boolean);
    const out = rows.map((r) => { const o = {}; for (const f of fields) o[f] = r[f] == null ? "" : r[f]; return o; });
    return { ok: true, status: 200, json: async () => ({ result: out }), text: async () => "" };
  }
  const p = plan.write[path];
  if (p) return { ok: p.status < 400, status: p.status, json: async () => p.body, text: async () => JSON.stringify(p.body) };
  if (method === "PATCH") { Object.assign(db[table][sysId], init.body ? JSON.parse(init.body) : {}); return { ok: true, status: 200, json: async () => ({ result: db[table][sysId] }), text: async () => "" }; }
  if (method === "POST") { const b = JSON.parse(init.body); const id = "new" + Object.keys(db[table]).length; db[table][id] = { sys_id: id, ...b, "variable.element": db.wf_activity_variable[b.variable] && db.wf_activity_variable[b.variable].element }; return { ok: true, status: 201, json: async () => ({ result: db[table][id] }), text: async () => "" }; }
  if (method === "DELETE") {
    if (table === "wf_activity" && db.wf_activity[sysId]) {
      // ServiceNow cascades the node's conditions + transitions + input rows.
      for (const [k, c] of Object.entries(db.wf_condition)) if (c.activity === sysId) { delete db.wf_condition[k]; for (const [tk, t] of Object.entries(db.wf_transition)) if (t.from === k) delete db.wf_transition[tk]; }
      for (const [tk, t] of Object.entries(db.wf_transition)) if (t.to === sysId) delete db.wf_transition[tk];
      for (const [vk, v] of Object.entries(db.sys_variable_value)) if (v.document_key === sysId) delete db.sys_variable_value[vk];
    }
    delete db[table][sysId];
    return { ok: true, status: 204, json: async () => { throw new Error("no body"); }, text: async () => "" };
  }
  return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
};
const session = () => ({ origin: ORIGIN, getToken: async () => "g_ck_1" });

// A fake form driver: records what it was asked to do, "renders" fields per `formFields`.
function fakeForm(opts = {}) {
  const log = [];
  return {
    log,
    async open(url) { log.push({ open: url }); if (opts.openError) throw new Error(opts.openError); },
    async run(func, args) {
      log.push({ run: func.name, args });
      if (opts.noGform) return { hasGform: false };
      if (opts.wrongForm) return { hasGform: true, wrongForm: opts.wrongForm };
      const [def, plan] = args;
      const results = plan.map((p) => {
        const f = (opts.formFields || {})[p.element];
        if (!f) return { element: p.element, found: false };
        if (f.readonly) return { element: p.element, found: true, readonly: true, id: "sys_readonly.wf_activity.vars.var__m_" + def + "." + p.element };
        // "persist" through the form unless the field is flagged as dropping its value
        if (!f.drops) { const row = Object.values(db.sys_variable_value).find((r) => r["variable.element"] === p.element); if (row) opts.pendingSave = [...(opts.pendingSave || []), [row, p.value]]; }
        return { element: p.element, found: true, readonly: false, id: "wf_activity.vars.var__m_" + def + "." + p.element, via: f.via || "dom+g_form", applied: true };
      });
      return { hasGform: true, record: ACT, results, vars_fields_on_form: Object.keys(opts.formFields || {}).map((e) => "wf_activity.vars.var__m_" + def + "." + e) };
    },
    async url() { return ORIGIN + "/wf_activity.do?sys_id=" + ACT; },
    async saveAndSettle() {
      log.push({ save: true });
      if (opts.blocked) return { hasGform: true, blocked: true, missing: ["Stage"] };
      for (const [row, v] of (opts.pendingSave || [])) row.value = v;
      opts.pendingSave = [];
      return { saving: true };
    }
  };
}
const deps = (form, extra = {}) => ({ session: session(), form, ...extra });

// =============================================================================
// sn_wf_activity_set
// =============================================================================

// ---- 1. argument validation --------------------------------------------------
resetDb();
let out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: "nope", inputs: { advanced_script: "x" } }, null, deps(null));
ok("set: bad sys_id rejected without a request", /activity_sys_id/.test(out.error) && calls.length === 0);
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: {} }, null, deps(null));
ok("set: empty inputs rejected", /inputs/.test(out.error) && calls.length === 0);
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { "Set Values": "x" } }, null, deps(null));
ok("set: non-element key rejected with the real names", /not an input element name/.test(out.error) && /advanced_script/.test(out.error));

// ---- 2. draft guard ------------------------------------------------------------
resetDb({ wf_activity: { [ACT]: { sys_id: ACT, name: "Active Directory", activity_definition: DEF, "activity_definition.name": "Catalog Task", workflow_version: "022e5c921bcbcb10773186eae54bcbaa", "workflow_version.name": "User Move R7", "workflow_version.published": "true", "workflow_version.workflow": "w1" } } });
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT } }, null, deps(fakeForm()));
ok("set: PUBLISHED version refused, names the draft query", /PUBLISHED version/.test(out.error) && /published=false/.test(out.error) && /workflow=w1/.test(out.error));
ok("set: published refusal wrote nothing", !calls.some((c) => c.method !== "GET"));
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: "0000000000000000000000000000dead", inputs: { advanced_script: "x" } }, null, deps(null));
ok("set: unknown activity says where sys_ids come from", /No wf_activity with sys_id/.test(out.error) && /sn_wf_activity_vars/.test(out.error));

// ---- 3. unchanged short-circuit ------------------------------------------------
resetDb();
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: OLD_SCRIPT.replace(/\n/g, "\r\n") } }, null, deps(fakeForm()));
ok("set: value already stored (CRLF-insensitive) → no write, route none", out.ok && out.route === "none" && out.inputs.advanced_script.status === "unchanged" && !calls.some((c) => c.method !== "GET"));

// ---- 4. API route succeeds (Basic) + verified ---------------------------------
resetDb();
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT, values: NEW_VALUES } }, null, deps(fakeForm()));
ok("set: API route — both rows PATCHed", calls.filter((c) => c.method === "PATCH").length === 2 && out.route === "api");
ok("set: API route — verified against the re-read rows", out.ok && out.inputs.advanced_script.status === "verified" && out.inputs.values.status === "verified" && out.inputs.values.row === ROW_VALUES);
ok("set: API route — result carries activity + version + next (Publish) step", out.activity.name === "Active Directory" && out.workflow_version.sys_id === VER && /Publish/.test(out.next));
ok("set: API route — form never touched", !calls.some((c) => c.path === "session") );

// ---- 5. API refused on Basic → session succeeds ------------------------------------
resetDb(); plan.write.basic = { status: 403, body: ACL };
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT } }, null, deps(fakeForm()));
// NB: the basic-denied memo from a previous test may already route session-first; either way the row must land.
ok("set: Basic refused → session PATCH lands, verified", out.ok && out.inputs.advanced_script.status === "verified" && db.sys_variable_value[ROW_SCRIPT].value === NEW_SCRIPT);

// ---- 6. API refused on EVERY path → the activity's own form -----------------------
resetDb(); plan.write.basic = { status: 403, body: ACL }; plan.write.session = { status: 403, body: ACL };
let form = fakeForm({ formFields: { advanced_script: { via: "monaco+g_form" }, values: {} } });
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT, values: NEW_VALUES } }, null, deps(form));
ok("set: form route — opened wf_activity.do for the ACTIVITY (not the row)", form.log[0] && form.log[0].open === `${ORIGIN}/wf_activity.do?sys_id=${ACT}&sysparm_stack=no`);
ok("set: form route — page function got the definition + the pending plan", form.log[1] && form.log[1].run === "pageWfActivitySetFields" && form.log[1].args[0] === DEF && form.log[1].args[1].length === 2);
ok("set: form route — saved once, then verified from the rows", form.log.some((l) => l.save) && out.ok && out.route === "form" && out.inputs.advanced_script.status === "verified" && out.inputs.values.status === "verified");
ok("set: form route — only ONE API refusal before switching (no per-row retry)", calls.filter((c) => c.method === "PATCH").length === 2 /* basic + session for the first row */);
ok("set: form route — reports the API refusal with the instance's reason", Array.isArray(out.api_refused) && out.api_refused.length === 1 && /ACL/.test(out.api_refused[0].denied_on[0].instance_says));
ok("set: form route — form report lists the fields + how they were set", out.form && out.form.fields.some((f) => f.element === "advanced_script" && /monaco/.test(f.via)));

// ---- 7. no signed-in tab → actionable error, nothing saved --------------------------
resetDb(); plan.write.basic = { status: 403, body: ACL }; plan.write.session = { status: 403, body: ACL };
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT } }, null, deps(null));
ok("set: no tab — says to open a signed-in tab on THIS instance and re-run", !out.ok && /no signed-in tab on https:\/\/customer-dev/.test(out.error) && /re-run this exact call/.test(out.error));
ok("set: no tab — row untouched", db.sys_variable_value[ROW_SCRIPT].value === OLD_SCRIPT);

// ---- 8. read-only field on the form → STOP before saving, diagnosis ------------------
resetDb(); plan.write.basic = { status: 403, body: ACL }; plan.write.session = { status: 403, body: ACL };
form = fakeForm({ formFields: { advanced_script: { readonly: true }, values: {} } });
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT, values: NEW_VALUES } }, null, deps(form));
ok("set: read-only — nothing saved", !form.log.some((l) => l.save) && /Nothing was saved/.test(out.error));
ok("set: read-only — names the input, the checkout owner, and says STOP", out.inputs.advanced_script.status === "refused" && /read-only on the form: advanced_script/.test(out.error) && /checked out by Alex Rivera/.test(out.error) && /STOP and report/.test(out.error));
ok("set: read-only — the other input is left pending, not claimed", !out.inputs.values || out.inputs.values.status !== "verified");

// ---- 9. unknown element on the form → lists the real field names ---------------------
resetDb(); plan.write.basic = { status: 403, body: ACL }; plan.write.session = { status: 403, body: ACL };
form = fakeForm({ formFields: { advanced_script: {}, values: {}, short_description: {} } });
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { set_values: "x" } }, null, deps(form));
ok("set: element not an input → wf_activity_variable miss reported before any form work", out.inputs.set_values && out.inputs.set_values.status === "unknown_input" && /not an input of the "Catalog Task"/.test(out.inputs.set_values.error));
ok("set: unknown element → ok true? no — nothing pending, reported as no-op with the diagnosis", out.route === "api" || out.route === "none");

// ---- 10. form saved but a widget dropped the value → not_persisted + script fallback ----
resetDb(); plan.write.basic = { status: 403, body: ACL }; plan.write.session = { status: 403, body: ACL };
form = fakeForm({ formFields: { advanced_script: {}, values: { drops: true } } });
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT, values: NEW_VALUES } }, null, deps(form));
ok("set: partial persist — ok false, script verified, values not_persisted", !out.ok && out.inputs.advanced_script.status === "verified" && out.inputs.values.status === "not_persisted");
ok("set: partial persist — shows what IS stored and why", /still holds the OLD value/.test(out.inputs.values.error) && /Verify if any additional/.test(out.inputs.values.stored_now));
ok("set: partial persist — Set Values fallback = Fix Script first, task.description last resort", /sn_wf_fix_script/.test(out.inputs.values.fallback) && /task\.description/.test(out.inputs.values.fallback) && /Values field still shows the old text/.test(out.inputs.values.fallback));
ok("set: partial persist — next says do NOT report as updated", /Do NOT report/.test(out.next));

// ---- 11. form blocked by a mandatory field ------------------------------------------------
resetDb(); plan.write.basic = { status: 403, body: ACL }; plan.write.session = { status: 403, body: ACL };
form = fakeForm({ formFields: { advanced_script: {} }, blocked: true });
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT } }, null, deps(form));
ok("set: mandatory-field block reported, nothing persisted", !out.ok && /mandatory field\(s\) empty: Stage/.test(out.error) && db.sys_variable_value[ROW_SCRIPT].value === OLD_SCRIPT);

// ---- 12. no g_form / wrong form -------------------------------------------------------------
resetDb(); plan.write.basic = { status: 403, body: ACL }; plan.write.session = { status: 403, body: ACL };
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT } }, null, deps(fakeForm({ noGform: true })));
ok("set: no g_form → sign-in hint", /did not render a ServiceNow form/.test(out.error) && /sn_login/.test(out.error));
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT } }, null, deps(fakeForm({ wrongForm: "sys_user" })));
ok("set: redirected to another form → says so", /rendered a sys_user form instead of wf_activity/.test(out.error));

// ---- 13. an input with NO row yet → created via POST (API route) ---------------------------
resetDb();
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { short_description: "Move - Update AD info" } }, null, deps(fakeForm()));
const post = calls.find((c) => c.method === "POST");
ok("set: missing row → POST sys_variable_value with document/document_key/variable", post && post.body.document === "wf_activity" && post.body.document_key === ACT && post.body.variable === "v3");
ok("set: missing row → verified from the new row", out.ok && out.inputs.short_description.status === "verified");

// ---- 14. the in-page function (DOM stub) ----------------------------------------------------
{
  const fields = {};
  const mk = (id, extra = {}) => ({ id, name: id, value: "", readOnly: false, disabled: false, dispatchEvent() {}, querySelector() { return null; }, parentElement: null, ...extra });
  fields["wf_activity.vars.var__m_" + DEF + ".advanced_script"] = mk("wf_activity.vars.var__m_" + DEF + ".advanced_script");
  fields["sys_readonly.wf_activity.vars.var__m_" + DEF + ".values"] = mk("sys_readonly.wf_activity.vars.var__m_" + DEF + ".values", { readOnly: true });
  const gfCalls = [];
  globalThis.window = { g_form: { setValue: (f, v) => gfCalls.push([f, v]), getValue: () => "", getTableName: () => "wf_activity", getUniqueValue: () => ACT }, monaco: null };
  globalThis.document = {
    getElementById: (id) => fields[id] || null,
    querySelector: () => null,
    querySelectorAll: (sel) => sel === ".CodeMirror" ? [] : Object.values(fields)
  };
  globalThis.Event = class { constructor(t) { this.type = t; } };
  const r = pageWfActivitySetFields(DEF, [{ element: "advanced_script", value: NEW_SCRIPT }, { element: "values", value: NEW_VALUES }, { element: "nope", value: "x" }]);
  ok("page fn: sets the writable field via DOM + g_form (vars.var__m_<def>.<element>)", r.hasGform && r.results[0].applied && r.results[0].via === "dom+g_form" && gfCalls[0][0] === "vars.var__m_" + DEF + ".advanced_script" && fields["wf_activity.vars.var__m_" + DEF + ".advanced_script"].value === NEW_SCRIPT);
  ok("page fn: sys_readonly.* field reported read-only, not written", r.results[1].readonly === true && /sys_readonly/.test(r.results[1].id));
  ok("page fn: missing field reported not found", r.results[2].found === false);
  ok("page fn: inventories the vars fields on the form", r.vars_fields_on_form.length === 2);
  globalThis.window.g_form.getTableName = () => "sys_variable_value";
  ok("page fn: wrong table reported", pageWfActivitySetFields(DEF, []).wrongForm === "sys_variable_value");
  delete globalThis.window; delete globalThis.document; delete globalThis.Event;
}

// =============================================================================
// sn_wf_delete_activity
// =============================================================================
const UG = "1a2e10161bcbcb10773186eae54bcb14";  // Update R7 UG Group Lists
const ADD = "022edcd21bcbcb10773186eae54bcbb3"; // Move - ADD to Division/Branch lists
const WAIT = "022edcd21bcbcb10773186eae54bcbf0"; // Wait for all catalog tasks
const tIn = "aa000000000000000000000000000001";
const tOut = "aa000000000000000000000000000002";
const cADD = "cc000000000000000000000000000001";
const cUG = "cc000000000000000000000000000002";
const vUG = "ee000000000000000000000000000001";
const graph = () => ({
  wf_activity: {
    [UG]: { sys_id: UG, name: "Update R7 UG Group Lists", activity_definition: DEF, "activity_definition.name": "Catalog Task", workflow_version: VER, "workflow_version.name": "User Move R7", "workflow_version.published": "false", "workflow_version.workflow": "w1" },
    [ADD]: { sys_id: ADD, name: "Move - ADD to Division/Branch email/group lists", activity_definition: DEF, workflow_version: VER, "workflow_version.published": "false" },
    [WAIT]: { sys_id: WAIT, name: "Wait for all catalog tasks to be closed.", activity_definition: "d", workflow_version: VER, "workflow_version.published": "false" },
    "b0000000000000000000000000000001": { sys_id: "b0000000000000000000000000000001", name: "Begin", activity_definition: "b", "activity_definition.name": "Begin", workflow_version: VER, "workflow_version.published": "false" }
  },
  wf_condition: { [cADD]: { sys_id: cADD, name: "Always", activity: ADD }, [cUG]: { sys_id: cUG, name: "Always", activity: UG } },
  wf_transition: { [tIn]: { sys_id: tIn, from: cADD, "from.activity": ADD, "from.activity.name": "Move - ADD to Division/Branch email/group lists", "from.name": "Always", to: UG }, [tOut]: { sys_id: tOut, from: cUG, to: WAIT, "to.name": "Wait for all catalog tasks to be closed." } },
  sys_variable_value: { [vUG]: { sys_id: vUG, document: "wf_activity", document_key: UG, "variable.element": "advanced_script", value: "x" } }
});

// ---- 15. guards -----------------------------------------------------------------------------
resetDb(graph());
out = await snWorkflowDeleteActivity(BASIC(), { activity_sys_id: "b0000000000000000000000000000001" }, null, deps(null));
ok("delete: Begin refused", /Begin\/End/.test(out.error));
out = await snWorkflowDeleteActivity(BASIC(), { activity_sys_id: UG }, null, deps(null));
ok("delete: incoming transitions without rewire_to → refused, names the node it leads to", /incoming transition/.test(out.error) && new RegExp(WAIT).test(out.error) && db.wf_activity[UG]);
out = await snWorkflowDeleteActivity(BASIC(), { activity_sys_id: UG, rewire_to: "ffffffffffffffffffffffffffffffff" }, null, deps(null));
ok("delete: rewire_to outside the version refused", /not an activity of the same version/.test(out.error));

// ---- 16. happy path: re-point → delete → verified -----------------------------------------------
resetDb(graph());
out = await snWorkflowDeleteActivity(BASIC(), { activity_sys_id: UG, rewire_to: WAIT }, null, deps(null));
ok("delete: incoming transition re-pointed BEFORE the delete", calls.findIndex((c) => c.method === "PATCH" && c.table === "wf_transition") < calls.findIndex((c) => c.method === "DELETE" && c.table === "wf_activity") && db.wf_transition[tIn].to === WAIT);
ok("delete: node + cascade gone, verified", out.ok && !db.wf_activity[UG] && !db.wf_transition[tOut] && !db.wf_condition[cUG] && out.deleted.activity === true);
ok("delete: result names the rewire and the remaining Publish step", out.rewired[0].to === "Wait for all catalog tasks to be closed." && /Publish/.test(out.next) && new RegExp(VER).test(out.next));

// ---- 17. refusal on the re-point → nothing touched -------------------------------------------------
resetDb(graph()); plan.write.basic = { status: 403, body: ACL }; plan.write.session = { status: 403, body: ACL };
out = await snWorkflowDeleteActivity(BASIC(), { activity_sys_id: UG, rewire_to: WAIT }, null, deps(null));
ok("delete: re-point refused → stopped before deleting, graph intact", !out.ok && /Stopped before deleting anything/.test(out.error) && db.wf_activity[UG] && db.wf_transition[tIn].to === UG);

// ---- 18. refusal on the DELETE after the re-point → honest partial report ------------------------------
resetDb(graph());
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init && init.method === "DELETE") return { ok: false, status: 403, json: async () => ACL, text: async () => JSON.stringify(ACL) };
    return realFetch(url, init);
  };
  out = await snWorkflowDeleteActivity(BASIC(), { activity_sys_id: UG, rewire_to: WAIT }, null, deps(null));
  globalThis.fetch = realFetch;
}
ok("delete: DELETE refused → says the node is now unreachable but still on the canvas", !out.ok && /Could not delete wf_activity/.test(out.error) && /now unreachable/.test(out.error) && /Workflow Editor/.test(out.error) && db.wf_transition[tIn].to === WAIT);

// ---- 19. orphan_ok deletes the incoming transition instead ---------------------------------------------
resetDb(graph());
out = await snWorkflowDeleteActivity(BASIC(), { activity_sys_id: UG, orphan_ok: true }, null, deps(null));
ok("delete: orphan_ok → incoming transition deleted, node gone", out.ok && !db.wf_transition[tIn] && !db.wf_activity[UG] && out.deleted.transitions >= 1);

// ---- 20. refusals hand off to the Fix Script route ---------------------------------------------------
resetDb(); plan.write.basic = { status: 403, body: ACL }; plan.write.session = { status: 403, body: ACL };
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT } }, null, deps(null));
ok("set: no-tab refusal names sn_wf_fix_script with the draft version + activity name", /sn_wf_fix_script \{workflow_version:"6a8f509a/.test(out.error) && /"activity":"Active Directory"/.test(out.error) && /advanced_script/.test(out.error));
form = fakeForm({ formFields: { advanced_script: { readonly: true } } });
out = await snWorkflowActivitySet(BASIC(), { activity_sys_id: ACT, inputs: { advanced_script: NEW_SCRIPT } }, null, deps(form));
ok("set: read-only refusal carries `alternative` = Fix Script", /sn_wf_fix_script/.test(out.alternative || ""));
resetDb(graph()); plan.write.basic = { status: 403, body: ACL }; plan.write.session = { status: 403, body: ACL };
out = await snWorkflowDeleteActivity(BASIC(), { activity_sys_id: UG, rewire_to: WAIT }, null, deps(null));
ok("delete: refusal carries `alternative` with remove + rewire_to by NAME", /sn_wf_fix_script/.test(out.alternative || "") && /"rewire_to":"Wait for all catalog tasks to be closed."/.test(out.alternative));

// =============================================================================
// sn_wf_fix_script / buildWfFixScript
// =============================================================================
const STORY_SET = [
  { activity: "Active Directory", inputs: { advanced_script: NEW_SCRIPT, task_set_values: NEW_VALUES } },
  { activity: "Desk Move", inputs: { advanced_script: "task.short_description = 'Move - eBusiness desk location';" } }
];
const STORY_REMOVE = [{ activity: "Update R7 UG Group Lists", rewire_to: "Wait for all catalog tasks to be closed." }];

// ---- 21. the generated script ----------------------------------------------------------------------
{
  const js = buildWfFixScript({ versionId: VER, title: "STRY0000001 Update SCTASK text - R7 User", set: STORY_SET, remove: STORY_REMOVE });
  ok("fix: ES5 IIFE with the story tag and the draft version pinned", /^\/\*\*/.test(js) && /\(function\(\) \{/.test(js) && /var TAG = "\[STRY0000001\]";/.test(js) && new RegExp(`var versionId = "${VER}";`).test(js) && /\}\)\(\);\s*$/.test(js));
  ok("fix: activities looked up by NAME within the version", /a\.addQuery\('workflow_version', versionId\)/.test(js) && /findActivity\("Active Directory"\)/.test(js) && /findActivity\("Desk Move"\)/.test(js));
  ok("fix: complete values written as safe JS string literals (newlines + quotes escaped)", js.includes('setInput(act1, "task_set_values", "assignment_group=16c8e04fdb85f7804f387d0e0f961953^description=Update Active Directory (as applicable)\\n- \\"Description\\" field\\n- OU container^EQ");'));
  ok("fix: idempotent — skips when the stored value already matches (CRLF-insensitive)", /already correct/.test(js) && /replace\(\/\\r\\n\/g, '\\n'\)/.test(js));
  ok("fix: creates the row from wf_activity_variable when the input has none", /new GlideRecord\('wf_activity_variable'\)/.test(js) && /model\.addQuery\('model', act\.getValue\('activity_definition'\)\)/.test(js) && /v\.insert\(\)/.test(js));
  ok("fix: remove = re-point incoming, delete conditions' outgoing transitions, values, then the node", /removeActivity\("Update R7 UG Group Lists", "Wait for all catalog tasks to be closed."\)/.test(js) && js.indexOf("tIn.setValue('to', bridgeId)") < js.indexOf("cond.deleteRecord()") && js.indexOf("cond.deleteRecord()") < js.indexOf("act.deleteRecord()"));
  ok("fix: no eval / no let-const / logs a summary", !/\beval\(/.test(js) && !/\b(let|const)\s/.test(js) && /gs\.info\(TAG \+ ' done: '/.test(js));
  const noRemove = buildWfFixScript({ versionId: VER, title: "x", set: STORY_SET.slice(0, 1) });
  ok("fix: no remove[] → no removeActivity call, tag falls back to [FIX]", !/removeActivity\("/.test(noRemove) && /var TAG = "\[FIX\]";/.test(noRemove));
  new Function(js); new Function(noRemove); // parses as JS
  ok("fix: generated script parses", true);
}

// ---- 22. the tool: guards ------------------------------------------------------------------------------
resetDb(graph());
db.wf_workflow_version = { [VER]: { sys_id: VER, name: "User Move R7", published: "false", checked_out_by: "Alex Rivera", workflow: "w1" }, pub1: { sys_id: "022e5c921bcbcb10773186eae54bcbaa", name: "User Move R7", published: "true", workflow: "w1" } };
db.wf_workflow_version["022e5c921bcbcb10773186eae54bcbaa"] = db.wf_workflow_version.pub1; delete db.wf_workflow_version.pub1;
db.wf_activity[ACT] = { sys_id: ACT, name: "Active Directory", workflow_version: VER };
db.wf_activity["d0000000000000000000000000000001"] = { sys_id: "d0000000000000000000000000000001", name: "Desk Move", workflow_version: VER };
out = await snWorkflowFixScript(BASIC(), { workflow_version: "022e5c921bcbcb10773186eae54bcbaa", name: "STRY0000001 x", set: STORY_SET }, null, deps(null));
ok("fix tool: published version refused with the draft query", /PUBLISHED version/.test(out.error) && /published=false/.test(out.error));
out = await snWorkflowFixScript(BASIC(), { workflow_version: VER, name: "STRY0000001 x", set: [{ activity: "Active Directoryy", inputs: { advanced_script: "x" } }] }, null, deps(null));
ok("fix tool: activity name not in the draft → refused, lists the real names", /Not activities of version/.test(out.error) && /Active Directory \|/.test(out.error) && /Desk Move/.test(out.error));
out = await snWorkflowFixScript(BASIC(), { workflow_version: VER, name: "STRY0000001 x" }, null, deps(null));
ok("fix tool: no changes → refused", /at least one change/.test(out.error));

// ---- 23. the tool: create=false returns the script; create → POST sys_script_fix ---------------------------
out = await snWorkflowFixScript(BASIC(), { workflow_version: VER, name: "STRY0000001 Update SCTASK text - R7 User", set: STORY_SET, remove: STORY_REMOVE, create: false }, null, deps(null));
ok("fix tool: create=false → script text + how to create/run", out.ok && out.created === false && /findActivity\("Active Directory"\)/.test(out.script) && /sn_create_record \{table:"sys_script_fix"/.test(out.next) && /Run Fix Script/.test(out.next));
db.sys_script_fix = {};
out = await snWorkflowFixScript(BASIC(), { workflow_version: VER, name: "STRY0000001 Update SCTASK text - R7 User", set: STORY_SET, remove: STORY_REMOVE }, null, deps(null));
const created = calls.find((c) => c.method === "POST" && c.table === "sys_script_fix");
ok("fix tool: creates sys_script_fix with name/description/script/record_for_rollback", created && created.body.name === "STRY0000001 Update SCTASK text - R7 User" && created.body.record_for_rollback === "true" && /var TAG = "\[STRY0000001\]"/.test(created.body.script) && /Active Directory \[advanced_script, task_set_values\]/.test(created.body.description));
ok("fix tool: result = record url + Run Fix Script + verify steps, never claims the edit ran", out.ok && out.created && /sys_script_fix\.do\?sys_id=/.test(out.url) && /Run Fix Script/.test(out.next) && /sn_wf_activity_vars/.test(out.next) && /sn_wf_publish/.test(out.next)); // 2026-09-04: publish = sn_wf_publish, not the editor menu

// ---- 24. the tool: record creation refused → script returned + form route -------------------------------------
plan.write.basic = { status: 403, body: ACL }; plan.write.session = { status: 403, body: ACL };
out = await snWorkflowFixScript(BASIC(), { workflow_version: VER, name: "STRY0000001 x", set: STORY_SET }, null, deps(null));
ok("fix tool: API refused → ok false, full script in the result, form route named", !out.ok && out.created === false && /findActivity\("Desk Move"\)/.test(out.script) && /sys_script_fix\.do\?sys_id=-1/.test(out.next) && /set_editor_value/.test(out.next));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
