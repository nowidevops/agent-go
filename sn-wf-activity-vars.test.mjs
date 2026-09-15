// sn-wf-activity-vars.test.mjs — the classic-workflow activity INPUT reader and the
// self-correction hints around it (2026-09-02, STRY0000001 research runs).
//
// Two live runs (~70 tool calls) never managed to read a Catalog Task activity's
// advanced_script: the model queried wf_activity for advanced_script/input/vars
// (always empty), wf_activity_variable.value (the input MODEL — no values),
// wf_activity_variable_value (HTTP 400, twice), http_request on the REST URL (401),
// and finally tried clicking canvas nodes. The values live in sys_variable_value
// (document=wf_activity, document_key=<activity>, variable→element). These tests
// pin: the new tool joins the two tables into {activity → {element: value}}; REST
// 401 falls back to the session query; sn_fetch_script_by_sysid on wf_activity
// returns the inputs instead of script:""; wf_activity queries carry the hint;
// invalid-table 400s name the real table; sn_query_schema walks super_class; and
// the record-prefix map knows STRY.
// Run: node sn-wf-activity-vars.test.mjs   Author: iDevOpsLLC
import { snWorkflowActivityVars, snFetchScriptBySysId, snQueryTable, snQuerySchema, snQueryRecord } from "./sn-tools.js";
import { wfActivityQueryHint, invalidTableHint, SN_TABLE_ALIAS_HINTS } from "./sn-hints.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };

const ORIGIN = "https://customer-dev.example.com";
const TARGET = { origin: ORIGIN, headers: { Authorization: "Basic xyz" }, credentials: "omit" };
const V = "022e5c921bcbcb10773186eae54bcbaa";
const AD = "ce2edcd21bcbcb10773186eae54bcbd0";  // Active Directory
const DM = "422edcd21bcbcb10773186eae54bcbe7";  // Desk Move
const DEF = "38891b6f0a0a0b1e00efdfdd77602027"; // Catalog Task definition

const ACTS = [
  { sys_id: AD, name: "Active Directory", activity_definition: DEF, "activity_definition.name": "Catalog Task", "stage.name": "Fulfillment", workflow_version: V, "workflow_version.name": "User Move R7", "workflow_version.published": "true" },
  { sys_id: DM, name: "Desk Move", activity_definition: DEF, "activity_definition.name": "Catalog Task", "stage.name": "Fulfillment", workflow_version: V, "workflow_version.name": "User Move R7", "workflow_version.published": "true" }
];
const AD_SCRIPT = "var user = current.variables.name.getDisplayValue();\ntask.short_description = 'Move - verify any additional share drive access (' + current.due_date + ') ' + user;";
const VALS = [
  { document_key: AD, variable: "v1", "variable.element": "advanced", "variable.label": "Advanced", value: "true" },
  { document_key: AD, variable: "v2", "variable.element": "advanced_script", "variable.label": "Advanced script", value: AD_SCRIPT },
  { document_key: AD, variable: "v3", "variable.element": "values", "variable.label": "Values", value: "description=Verify if any additional share drive access needs to be configured" },
  { document_key: DM, variable: "v2", "variable.element": "advanced_script", "variable.label": "Advanced script", value: "task.short_description = 'Move - Desk move/update eBusiness desk location (' + current.due_date + ') ' + user;" },
  { document_key: DM, variable: "v4", "variable.element": "assignment_group", "variable.label": "Assignment group", value: "aaaa0000aaaa0000aaaa0000aaaa0000" }
];

// ---- fetch stub: routes by table, records every URL, can force a status ----
const calls = [];
let forceStatus = null; // e.g. { table: "sys_variable_value", status: 401 }
globalThis.fetch = async (url) => {
  calls.push(String(url));
  const u = new URL(url);
  const table = u.pathname.split("/api/now/table/")[1] || "";
  const q = u.searchParams.get("sysparm_query") || "";
  const fields = u.searchParams.get("sysparm_fields") || "";
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (forceStatus && table === forceStatus.table) return json(forceStatus.status, { error: { message: "User Not Authenticated" } });
  if (table === "wf_activity") {
    if (/^workflow_version=/.test(q)) return json(200, { result: ACTS });
    const m = /sys_idIN([^^]+)/.exec(q);
    if (m) { const ids = m[1].split(","); return json(200, { result: ACTS.filter((a) => ids.includes(a.sys_id)) }); }
    return json(200, { result: [] });
  }
  if (table === "sys_variable_value") {
    const m = /document_keyIN([^^]+)/.exec(q);
    const ids = m ? m[1].split(",") : [];
    let rows = VALS.filter((r) => ids.includes(r.document_key));
    const e = /variable\.elementIN([^^]+)/.exec(q);
    if (e) { const els = e[1].split(","); rows = rows.filter((r) => els.includes(r["variable.element"])); }
    return json(200, { result: rows });
  }
  if (table === "sys_db_object") {
    const m = /^name=([a-z_]+)/.exec(q);
    const parents = { wf_activity_variable: "var_dictionary", incident: "task", task: "" };
    const t = m ? m[1] : "";
    return json(200, { result: t in parents ? [{ name: t, "super_class.name": parents[t] }] : [] });
  }
  if (table === "sys_dictionary") {
    const m = /^nameIN([^^]+)/.exec(q);
    const names = m ? m[1].split(",") : [];
    const rows = [];
    if (names.includes("wf_activity_variable")) rows.push({ name: { value: "wf_activity_variable" }, element: { value: "model" }, internal_type: { value: "reference" } }, { name: { value: "wf_activity_variable" }, element: { value: "activity" }, internal_type: { value: "reference" } });
    if (names.includes("var_dictionary")) rows.push({ name: { value: "var_dictionary" }, element: { value: "element" }, internal_type: { value: "string" } }, { name: { value: "var_dictionary" }, element: { value: "label" }, internal_type: { value: "string" } }, { name: { value: "var_dictionary" }, element: { value: "order" }, internal_type: { value: "integer" } });
    return json(200, { result: rows });
  }
  if (table === "rm_story" || table === "task") return json(200, { result: [] });
  if (table.startsWith("wf_activity_variable_value")) return json(400, { error: { message: "Invalid table wf_activity_variable_value", detail: null }, status: "failure" });
  return json(404, { error: { message: "no such route" } });
};

// ---- 1. by workflow_version: every activity, element→value, legend, labels ----
{
  calls.length = 0;
  const r = await snWorkflowActivityVars(TARGET, { workflow_version: V }, null, null);
  ok("version: no error", !r.error, JSON.stringify(r).slice(0, 200));
  ok("version: two activities back", r.count === 2 && r.activities.length === 2);
  const ad = r.activities.find((a) => a.sys_id === AD);
  ok("version: advanced_script is the full script text", ad && ad.vars.advanced_script === AD_SCRIPT);
  ok("version: values (Set Values) present", ad && /^description=/.test(ad.vars.values));
  ok("version: element order puts advanced/advanced_script first", ad && Object.keys(ad.vars).slice(0, 2).join(",") === "advanced,advanced_script");
  ok("version: definition + stage labelled", ad && ad.definition === "Catalog Task" && ad.stage === "Fulfillment");
  ok("version: published flag + version name", r.published === "true" && r.workflow_version_name === "User Move R7");
  ok("version: legend explains advanced_script + values", r.legend && r.legend.advanced_script && r.legend.values);
  ok("version: labels map element→label", r.labels && r.labels.advanced_script === "Advanced script");
  ok("version: exactly two REST calls (activities + values)", calls.length === 2, String(calls.length));
  ok("version: values query filters empties", /valueISNOTEMPTY/.test(decodeURIComponent(calls[1])));
  ok("version: values query dot-walks element", /variable\.element/.test(decodeURIComponent(calls[1])));
  ok("version: write path documented", /sys_variable_value/.test(r.write_path));
}

// ---- 2. by activity_sys_id list, element filter, caller order, truncation ----
{
  calls.length = 0;
  const r = await snWorkflowActivityVars(TARGET, { activity_sys_id: `${DM}, ${AD.toUpperCase()}`, element: "advanced_script", max_chars: 40 }, null, null);
  ok("ids: no error", !r.error, JSON.stringify(r).slice(0, 200));
  ok("ids: caller's order kept (Desk Move first)", r.activities[0].sys_id === DM && r.activities[1].sys_id === AD);
  ok("ids: element filter — only advanced_script returned", Object.keys(r.activities[0].vars).join() === "advanced_script");
  ok("ids: element filter reaches the query", /variable\.elementINadvanced_script/.test(decodeURIComponent(calls[1])));
  ok("ids: long value truncated with a re-call marker", /truncated at 40 chars/.test(r.activities[1].vars.advanced_script) && r.truncated_values === 2);
}

// ---- 3. argument validation ----
{
  const a = await snWorkflowActivityVars(TARGET, {}, null, null);
  ok("args: neither id nor version → actionable error", /activity_sys_id/.test(a.error) && /workflow_version/.test(a.error));
  const b = await snWorkflowActivityVars(TARGET, { activity_sys_id: "Active Directory" }, null, null);
  ok("args: a NAME is rejected with the query to get sys_ids", /not a 32-hex sys_id/.test(b.error) && /wf_activity/.test(b.error));
  const c = await snWorkflowActivityVars(TARGET, { workflow_version: "70ae75" }, null, null);
  ok("args: short version id rejected, explains sysparm_sys_id", /sysparm_sys_id/.test(c.error));
  const d = await snWorkflowActivityVars(TARGET, { activity_sys_id: "0".repeat(32) }, null, null);
  ok("args: unknown activity → 'not activity sys_ids' error", /No wf_activity found/.test(d.error));
}

// ---- 4. REST 401 → session fallback (same two queries through the tab) ----
{
  calls.length = 0;
  forceStatus = { table: "wf_activity", status: 401 };
  const sessionCalls = [];
  const sessionQuery = async (table, query, fields, limit) => {
    sessionCalls.push({ table, query, fields, limit });
    if (table === "wf_activity") return { ok: true, records: ACTS };
    const m = /document_keyIN([^^]+)/.exec(query);
    const ids = m ? m[1].split(",") : [];
    return { ok: true, records: VALS.filter((r) => ids.includes(r.document_key)) };
  };
  const r = await snWorkflowActivityVars(TARGET, { workflow_version: V }, null, sessionQuery);
  forceStatus = null;
  ok("401: falls back to the session path without erroring", !r.error && r.count === 2, JSON.stringify(r).slice(0, 200));
  ok("401: source says so", /tab session/.test(r.source));
  ok("401: session limit never exceeds the 50-row cap", sessionCalls.every((c) => c.limit <= 50));
  ok("401: values fetched in small batches on the session path", sessionCalls.filter((c) => c.table === "sys_variable_value").length === 1 && sessionCalls[0].table === "wf_activity");
  ok("401: REST not retried after the first 401", calls.length === 1, String(calls.length));
  ok("401: values still joined correctly", r.activities.find((a) => a.sys_id === AD).vars.advanced_script === AD_SCRIPT);
}
{
  // No tab to fall back to → the REST error surfaces (with the existing recovery text)
  forceStatus = { table: "wf_activity", status: 401 };
  const r = await snWorkflowActivityVars(TARGET, { workflow_version: V }, null, null);
  forceStatus = null;
  ok("401 without a tab: error names the recovery", /Could not read wf_activity/.test(r.error) && /sn_query_session/.test(r.error));
}

// ---- 5. sn_fetch_script_by_sysid on wf_activity returns the inputs, not script:"" ----
{
  const r = await snFetchScriptBySysId(TARGET, { table: "wf_activity", sysId: AD }, null, null);
  ok("fetch_by_sysid wf_activity: redirected to the inputs", !r.error && r.activities && r.activities[0].vars.advanced_script === AD_SCRIPT);
  ok("fetch_by_sysid wf_activity: note explains the redirect", /no script column/.test(r.note));
}

// ---- 6. hints on wf_activity / wf_activity_variable queries ----
{
  const r = await snQueryTable(TARGET, { table: "wf_activity", query: `sys_id=${AD}`, fields: "name,sys_id,advanced_script" }, null);
  ok("sn_query_table wf_activity + advanced_script field → hint", /sn_wf_activity_vars/.test(r.hint || ""));
  const r2 = await snQueryTable(TARGET, { table: "wf_activity", query: `sys_id=${AD}` }, null);
  ok("sn_query_table wf_activity with ALL fields → hint", /sn_wf_activity_vars/.test(r2.hint || ""));
  const r3 = await snQueryTable(TARGET, { table: "wf_activity", query: `workflow_version=${V}`, fields: "sys_id,name,activity_definition" }, null);
  ok("sn_query_table wf_activity listing nodes → no hint (not hunting inputs)", !r3.hint);
  ok("hint fn: wf_activity_variable with value field", /INPUT MODEL/.test(wfActivityQueryHint("wf_activity_variable", "name,value", "") || ""));
  ok("hint fn: wf_activity_variable filtered by activity", /INPUT MODEL/.test(wfActivityQueryHint("wf_activity_variable", "", `activity=${AD}`) || ""));
  ok("hint fn: unrelated table → null", wfActivityQueryHint("incident", "number,short_description", "active=true") === null);
}

// ---- 7. invalid table 400 names the real table ----
{
  let err = "";
  try { await snQueryTable(TARGET, { table: "wf_activity_variable_value", query: `activity=${AD}` }, null); } catch (e) { err = e.message; }
  ok("400 Invalid table wf_activity_variable_value → sys_variable_value + tool named", /sys_variable_value/.test(err) && /sn_wf_activity_vars/.test(err), err.slice(0, 160));
  ok("400 unknown table → sys_db_object lookup suggested", /sys_db_object/.test(invalidTableHint('{"error":{"message":"Invalid table foo_bar"}}') || ""));
  ok("alias table covers wf_activity_vars / wf_activity_inputs", ["wf_activity_vars", "wf_activity_inputs", "wf_activity_values"].every((t) => SN_TABLE_ALIAS_HINTS.some((h) => h.re.test(t))));
}

// ---- 8. sn_query_schema walks super_class ----
{
  const r = await snQuerySchema(TARGET, { table: "wf_activity_variable" }, null);
  ok("schema: inherited fields included", r.fields.some((f) => f.name === "element") && r.fields.some((f) => f.name === "order"));
  ok("schema: extends chain reported", Array.isArray(r.extends) && r.extends[0] === "var_dictionary");
  ok("schema: inherited_from marks parent fields", r.fields.find((f) => f.name === "element").inherited_from === "var_dictionary" && !r.fields.find((f) => f.name === "model").inherited_from);
  ok("schema: own fields listed before inherited", r.fields[0].name === "activity" && r.fields[1].name === "model");
}

// ---- 9. record prefixes: STRY → rm_story, and a not-found names the instance ----
{
  calls.length = 0;
  const r = await snQueryRecord(TARGET, { recordNumber: "STRY0000001" }, null);
  ok("STRY looks in rm_story first", /\/rm_story\?/.test(calls[0]));
  ok("not found: says which instance + suggests working from the task text", /customer-dev/.test(r.error) && /DIFFERENT instance/.test(r.error));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
