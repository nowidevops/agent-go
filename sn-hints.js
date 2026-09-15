// sn-hints.js — shared self-correction hints for the ServiceNow tools.
// Pure data + tiny helpers, no chrome.* — imported by BOTH the REST tools
// (sn-tools.js) and the session tools (editors.js), which are both leaf modules
// and cannot import each other. Before 2026-09-02 the alias tables lived only in
// editors.js, so a wrong table name got a hint on sn_query_session but a bare
// "HTTP 400" on sn_query_table.
// Author: iDevOpsLLC

// Common WRONG table names local models invent, mapped to the real table + key
// field. Kept short and specific; extend when a run shows a new one.
export const SN_TABLE_ALIAS_HINTS = [
  { re: /^(sc_)?cat(alog)?_item_var(iable)?s?$|^cat_item_var$|^sc_item_option_new$/i, hint: "catalog VARIABLES live in item_option_new (filter: cat_item=<sc_cat_item sys_id>, fields: name,question_text,type,order,active,cat_item,variable_set). Same-row layout is done with a 'Container Start' variable (type=19) whose layout is '2 columns' + 'Container Split' (type=20) between the two variables + 'Container End' (type=21) after -- NOT via order alone." },
  { re: /^(sc_)?variable_set(s)?$|^sc_item_variable_set$/i, hint: "variable SETS live in item_option_new_set; the item<->set link is io_set_item (fields: sc_cat_item, variable_set)." },
  { re: /^sc_catalog_item$|^catalog_item$/i, hint: "catalog items live in sc_cat_item." },
  { re: /^business_rule(s)?$|^sys_business_rule$/i, hint: "Business Rules live in sys_script." },
  { re: /^client_script(s)?$|^sys_client_script$/i, hint: "Client Scripts live in sys_script_client; Catalog Client Scripts in catalog_script_client." },
  { re: /^script_include(s)?$/i, hint: "Script Includes live in sys_script_include." },
  { re: /^ui_polic(y|ies)$|^sys_ui_policies$|^sc_cat_item_ui_polic(y|ies)$|^sc_ui_polic(y|ies)$|^cat(alog)?_item_ui_polic(y|ies)$/i, hint: "UI Policies live in sys_ui_policy (actions: sys_ui_policy_action); Catalog UI Policies in catalog_ui_policy (filter: catalog_item=<sc_cat_item sys_id> OR variable_set=<set sys_id>; actions: catalog_ui_policy_action)." },
  { re: /^ui_action(s)?$/i, hint: "UI Actions live in sys_ui_action." },
  { re: /^workflow(s)?$/i, hint: "classic Workflows live in wf_workflow (versions: wf_workflow_version, activities: wf_activity); Flow Designer flows in sys_hub_flow." },
  { re: /^sp_widget(s)?_instance$|^widget_instance$/i, hint: "portal widget instances live in sp_instance (widget=sp_widget sys_id, column=sp_column)." },
  // 2026-09-02 STRY0000001 research run: the model invented wf_activity_variable_value
  // (HTTP 400 twice) while hunting for a Catalog Task activity's advanced_script.
  { re: /^wf_activity_(variable_)?values?$|^wf_activity_vars?$|^wf_activity_inputs?$|^wf_activity_script(s)?$|^wf_variable_values?$/i, hint: WF_ACTIVITY_VARS_HINT_TEXT() },
];

// Common WRONG field names local models put in sysparm_query (→ strict-query 403),
// keyed by table. `re` runs against the QUERY string. Extend when a run shows a new one.
export const SN_FIELD_ALIAS_HINTS = [
  { table: /^item_option_new$/i, re: /(^|\^|\bOR)question(LIKE|=|STARTSWITH|!=)/i,
    hint: "on item_option_new the label field is question_text (NOT question). Retry: query=question_textLIKEStart Date  fields=question_text,name,cat_item,variable_set,order,type,active. cat_item = the item that owns it; variable_set = the variable set that owns it (a variable set is shared by EVERY item that includes it -- edit with care)." },
  { table: /^item_option_new$/i, re: /(^|\^|\bOR)(label|display_name|title)(LIKE|=|STARTSWITH)/i,
    hint: "on item_option_new the label field is question_text and the internal name is name." },
  { table: /^item_option_new_set$/i, re: /(^|\^|\bOR)(cat_item|sc_cat_item|catalog_item|item)(=|LIKE|IN)/i,
    hint: "item_option_new_set has NO cat_item field. To find the variable sets attached to an item query io_set_item (query: sc_cat_item=<item sys_id>  fields: variable_set,sc_cat_item,order); to list ALL items sharing a set query io_set_item with variable_set=<set sys_id>." },
  { table: /^sc_cat_item$/i, re: /(^|\^|\bOR)variable_set(=|LIKE|IN)/i,
    hint: "sc_cat_item has NO variable_set field -- the item<->set link is the io_set_item table (fields: sc_cat_item, variable_set)." },
  { table: /^catalog_ui_policy$/i, re: /(^|\^|\bOR)(sc_cat_item|cat_item)(=|LIKE|IN)/i,
    hint: "on catalog_ui_policy the item field is catalog_item (variable-set-scoped policies use variable_set instead)." },
  { table: /^sys_script$/i, re: /(^|\^|\bOR)table(=|LIKE|IN)/i,
    hint: "on sys_script the table field is collection (NOT table)." },
  { table: /^sys_script_client$/i, re: /(^|\^|\bOR)(cat_item|catalog_item)(=|LIKE|IN)/i,
    hint: "sys_script_client has no cat_item -- catalog client scripts live in catalog_script_client (fields: cat_item, variable_set, ui_type, type)." },
  { table: /^wf_activity$/i, re: /(^|\^|\bOR)(advanced_script|script|values|set_values|short_description|description|vars|input)(=|LIKE|IN|STARTSWITH|ISNOTEMPTY)/i,
    hint: WF_ACTIVITY_VARS_HINT_TEXT() },
];

// ---------------------------------------------------------------------------
// Classic Workflow activity INPUTS (the 2026-09-02 STRY0000001 lesson).
// A wf_activity row carries only the node (name, definition, x/y, stage). What
// the activity DOES — Catalog Task's advanced_script / short_description /
// description / values, Run Script's script, Approval's groups… — is stored as
// one sys_variable_value row per input: document='wf_activity',
// document_key=<activity sys_id>, variable=<wf_activity_variable sys_id> whose
// .element is the input name. The dictionary shows it as the glide_var column
// wf_activity.vars (wf_activity.vars.var__m_<definition>.advanced_script), which
// the Table API returns EMPTY — so every "read the activity's script" path the
// model tried (wf_activity.input/vars, wf_activity_variable.value,
// sn_fetch_script_by_sysid wf_activity, http_request) came back blank or 401.
// ---------------------------------------------------------------------------
export function WF_ACTIVITY_VARS_HINT_TEXT() {
  return "a classic-workflow activity's INPUTS (Catalog Task / Create Task: advanced_script, short_description, description, values, assignment_group…; Run Script: script; Approval: groups/users…) are NOT columns on wf_activity and NOT in wf_activity_variable (that is the input MODEL per activity definition — its rows carry no per-activity value). They are rows in sys_variable_value (document=wf_activity^document_key=<activity sys_id>; variable→wf_activity_variable.element names the input). Call sn_wf_activity_vars {activity_sys_id:\"<sys_id>\"} — or {workflow_version:\"<wf_workflow_version sys_id>\"} for EVERY activity of a version in one call — and read the element→value map it returns. Do not query wf_activity.input / wf_activity.vars, do not read the workflow canvas, and do not paste the activity URL into http_request.";
}

// Fired on a wf_activity / wf_activity_variable query whose requested FIELDS or
// QUERY show the model is hunting for input values. Returns the hint or null.
export function wfActivityQueryHint(table, fields, query) {
  const t = String(table || "").toLowerCase();
  const f = String(fields || "");
  const q = String(query || "");
  const wantsInputs = /\b(advanced_script|script|values|set_values|short_description|description|vars|input|assignment_group|template)\b/i;
  if (t === "wf_activity") {
    // No field list = "give me everything" — the model is almost always after the
    // script when it reads ONE activity with all columns (both 2026-09-02 runs).
    if (!f.trim() || wantsInputs.test(f) || wantsInputs.test(q)) return WF_ACTIVITY_VARS_HINT_TEXT();
    return null;
  }
  if (t === "wf_activity_variable") {
    if (/\bvalue\b/i.test(f) || /(^|\^)activity(=|IN)/i.test(q) || /advanced_script|\.value/i.test(q)) {
      return "wf_activity_variable is the INPUT MODEL (one row per input of an activity DEFINITION: model=<wf_activity_definition sys_id>, element=<input name>) — it has no per-activity value. " + WF_ACTIVITY_VARS_HINT_TEXT();
    }
    return null;
  }
  return null;
}

// Parse ServiceNow's "Invalid table <name>" 400 body and map the bad name to a
// real-table hint (null when the body isn't that error or nothing matches).
export function invalidTableHint(body) {
  const m = /Invalid table ([A-Za-z0-9_]+)/i.exec(String(body || ""));
  if (!m) return null;
  const bad = m[1];
  const alias = SN_TABLE_ALIAS_HINTS.find((h) => h.re.test(bad));
  return alias
    ? `'${bad}' is not a ServiceNow table -- ${alias.hint}`
    : `'${bad}' is not a ServiceNow table. Do NOT retry the same name; find the real one via sn_query_table {table:"sys_db_object", query:"nameLIKE${bad.slice(0, 24)}^ORlabelLIKE${bad.replace(/_/g, " ").slice(0, 24)}", fields:"name,label,super_class"}.`;
}
