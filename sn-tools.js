// sn-tools.js — ServiceNow MCP for the local agent. Mirrors master-mind's
// SN tool executor + "ServiceNow Record Context" connect panel: the user connects an
// instance with URL + username + password, and the read tools (sn_query_table /
// sn_query_record / sn_query_schema) query it over the Table API with Basic auth.
// (If no connection is configured but the active tab is a logged-in ServiceNow tab,
// the tools fall back to that tab's session.)
//
// Two WRITE tools exist: sn_update_record (PATCH one record by sys_id) and
// sn_create_record (POST one record — added for legacy-workflow authoring). Both are
// ACTION tools — gated by act mode (approval in "ask" mode) and stripped entirely in
// READ-ONLY mode (see ACTION_TOOLS in background.js). All other SN tools are read-only.
// Author: iDevOpsLLC

import { invalidTableHint, wfActivityQueryHint, WF_ACTIVITY_VARS_HINT_TEXT } from "./sn-hints.js";

const SN_CONN_KEY = "snConnection";   // legacy single connection: { url, username, password }
const SN_CONNS_KEY = "snConnections"; // multi: [ { url, username, password }, ... ] keyed by origin

// Instances the SN MCP must NEVER query — client/work instances whose REST
// credentials will not be provided (policy, 2026-07-09: a customer). Without this the
// tools fall back to the tab session and burn attempts on guaranteed 401s
// (scorecard 2026-07-09: sn_query_table 5/5 failures). Enforced in snFetch /
// snWrite — the single chokepoint every sn_* call passes through — so the
// agent gets an immediate, actionable error instead.
// 2026-08-21: customer-dev.example.com REMOVED from this list — REST
// credentials ARE provided for it now, so the REST sn_* tools (sn_query_table,
// sn_fetch_script_by_name, sn_recent_changes, sn_compare_record, …) work there
// and the old "use sn_query_session instead" error no longer applies. The
// separate read-only standing grant on that host (SN_RESEARCH_INSTANCES in
// background.js) is unrelated and still stands.
const SN_EXCLUDED_HOSTS = []; // instance hosts the sn_* tools must never touch (policy exclusions) — add your own

// True when a tab URL belongs to a policy-excluded instance. Exported so the agent
// loop can say so UP FRONT in the system prompt — the call-time error alone doesn't
// persist across turns, and the model re-tried sn_* tools at the start of every new
// turn (observed 2026-07-09: 5 wasted excluded calls across one 4-review session).
export function isSnExcludedUrl(url) {
  let host = ""; try { host = new URL(String(url || "")).hostname.toLowerCase(); } catch { return false; }
  return SN_EXCLUDED_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

function snExcludedError(origin) {
  let host = ""; try { host = new URL(origin).hostname.toLowerCase(); } catch {}
  if (!SN_EXCLUDED_HOSTS.some((h) => host === h || host.endsWith("." + h))) return null;
  return new Error(
    `${host} is EXCLUDED from ServiceNow MCP by policy — no API credentials will be provided for this instance. ` +
    `Do NOT retry REST sn_* tools against it. For record lookups use sn_query_session instead (it queries through the ` +
    `logged-in tab session, needs no credentials, and returns structured rows + sys_ids in ONE call); for forms use the ` +
    `page tools: read_page / query_elements / click_element / fill_input.`
  );
}

// Normalize a user-entered instance URL to an origin (adds https:// if missing).
export function snOrigin(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).origin; }
  catch { return ""; }
}

// Normalize a raw {url,username,password} into a clean connection (origin-normalized url).
function cleanConn(c) {
  return { url: snOrigin(c && c.url), username: (c && c.username) || "", password: (c && c.password) || "" };
}

// All stored connections (array). Migrates the legacy single `snConnection` into the
// list when the list is empty, so older installs keep working.
export async function getSnConnections() {
  try {
    const got = await chrome.storage.local.get([SN_CONNS_KEY, SN_CONN_KEY]);
    let list = Array.isArray(got[SN_CONNS_KEY]) ? got[SN_CONNS_KEY] : [];
    if (!list.length && got[SN_CONN_KEY] && got[SN_CONN_KEY].url) list = [got[SN_CONN_KEY]];
    return list.map(cleanConn).filter((c) => c.url);
  } catch { return []; }
}

// Replace the whole connection list (deduped by origin, last wins). Also clears the
// legacy single key so it can't shadow the list later.
export async function saveSnConnections(list) {
  const byOrigin = new Map();
  for (const c of (Array.isArray(list) ? list : []).map(cleanConn)) if (c.url) byOrigin.set(c.url, c);
  await chrome.storage.local.set({ [SN_CONNS_KEY]: [...byOrigin.values()] });
  try { await chrome.storage.local.remove(SN_CONN_KEY); } catch {}
}

export async function clearSnConnections() {
  try { await chrome.storage.local.remove([SN_CONNS_KEY, SN_CONN_KEY]); } catch {}
}

// Resolve a fetch target from a STORED connection by instance hint (origin/host
// substring) — NO open tab required. Lets an agent (or a sub-agent given
// scope_instance) target any connected instance by name. Returns the Basic-auth
// target, or null if no stored connection matches.
export async function resolveSnTargetByInstance(instanceHint) {
  const s = String(instanceHint || "").toLowerCase().trim();
  if (!s) return null;
  const conns = await getSnConnections();
  const m = conns.find((c) => {
    const o = c.url.toLowerCase();
    let host = ""; try { host = new URL(c.url).hostname.toLowerCase(); } catch {}
    return o.includes(s) || (host && (host.includes(s) || s.includes(host)));
  });
  return m ? snBasicTarget(m) : null;
}

// Comma-list of connected instance origins — for clear "no match" errors.
export async function listSnInstances() {
  return (await getSnConnections()).map((c) => c.url);
}

// Build a Basic-auth fetch target from a connection.
export function snBasicTarget(conn) {
  const origin = snOrigin(conn.url);
  const headers = {};
  if (conn.username) headers.Authorization = "Basic " + btoa(`${conn.username}:${conn.password || ""}`);
  return { origin, headers, credentials: "omit" };
}

// --- back-compat single-connection wrappers (first stored connection) ---
export async function getSnConnection() { return (await getSnConnections())[0] || null; }
export async function saveSnConnection(conn) {
  const list = await getSnConnections();
  const c = cleanConn(conn);
  const i = list.findIndex((x) => x.url === c.url);
  if (i >= 0) list[i] = c; else list.push(c);
  await saveSnConnections(list);
}
export async function clearSnConnection() { await clearSnConnections(); }

// Build the fetch target ({ origin, headers, credentials }) for the SN tools.
// `tabOrigin` is the resolved SN tab origin (or "").
//
// PRECEDENCE — normally a stored Basic-auth connection wins, then the (active) tab
// session. BUT a child bound to a SPECIFIC ServiceNow tab (opts.preferBoundTab —
// e.g. a per-instance sub-agent in a multi-instance fan-out) MUST query THAT tab's
// instance: its explicit per-tab binding beats the single globally-stored instance.
// Without this, 5 sub-agents told to hit 5 instances ALL hit the stored instance
// (UAT 2026-06-21: every child returned dev000000's INC0012345 — only the first was
// actually correct).
export async function resolveSnTarget(tabOrigin, opts = {}) {
  const conns = await getSnConnections();
  const match = (origin) => conns.find((c) => c.url === origin);

  if (opts.preferBoundTab) {
    if (!tabOrigin) return null; // bound child whose tab is not a ServiceNow page — don't silently hit a stored instance
    const m = match(tabOrigin);
    if (m) return snBasicTarget(m);                                  // Basic auth for THIS instance
    // Shared-credential fallback: no exact connection for this instance, but if ANY
    // connection is stored, reuse its Basic auth against this origin (common when all
    // instances share one admin/password). Wrong creds just 401 — same as a dead
    // session — so this is safe. Only fall back to the tab session if nothing stored.
    if (conns.length) return { ...snBasicTarget(conns[0]), origin: tabOrigin };
    return { origin: tabOrigin, headers: {}, credentials: "include" };
  }
  // Top-level: a stored connection matching the active tab wins; else (on a SN tab)
  // use that tab's own session — NEVER another instance's stored creds; else fall
  // back to the first stored connection as the configured default.
  if (tabOrigin) {
    const m = match(tabOrigin);
    if (m) return snBasicTarget(m);
    return { origin: tabOrigin, headers: {}, credentials: "include" };
  }
  if (conns.length) return snBasicTarget(conns[0]);
  return null;
}

// Common record-number prefixes → table. Unknown prefixes fall back to a `task`
// query (covers most task-derived records); kb/interaction handled explicitly.
const PREFIX_TABLE = {
  INC: "incident", CHG: "change_request", CTASK: "change_task", CHGTASK: "change_task",
  PRB: "problem", PRBTASK: "problem_task", RITM: "sc_req_item", REQ: "sc_request",
  SCTASK: "sc_task", TASK: "task", KB: "kb_knowledge", INT: "interaction", CALL: "new_call",
  // Agile / SPM records (2026-09-02: STRY0000001 fell through to the `task` fallback
  // and reported "no record" for a story number).
  STRY: "rm_story", DFCT: "rm_defect", ENHC: "rm_enhancement", EPIC: "rm_epic",
  PRJ: "pm_project", PRJTASK: "pm_project_task", DMND: "dmn_demand", RLSE: "rm_release"
};

function tableForNumber(num) {
  const m = String(num || "").match(/^([A-Za-z]+)\d+$/);
  return m ? PREFIX_TABLE[m[1].toUpperCase()] || null : null;
}

// Artifact type → table / name field / table-scope field / script field(s).
// Mirrors master-mind's ARTIFACT_TABLE_MAP so sn_fetch_script_by_name and
// sn_search_script_body target the right table + columns for each script type.
const ARTIFACT_TABLE_MAP = {
  script_include:        { table: "sys_script_include",     nameField: "name",              tableField: null,           scriptFields: ["script"] },
  business_rule:         { table: "sys_script",             nameField: "name",              tableField: "collection",   scriptFields: ["script"] },
  client_script:         { table: "sys_script_client",      nameField: "name",              tableField: "table",        scriptFields: ["script"] },
  fix_script:            { table: "sys_script_fix",         nameField: "name",              tableField: null,           scriptFields: ["script"] },
  ui_script:             { table: "sys_ui_script",          nameField: "name",              tableField: null,           scriptFields: ["script"] },
  scheduled_job:         { table: "sysauto_script",         nameField: "name",              tableField: null,           scriptFields: ["script"] },
  ui_policy:             { table: "sys_ui_policy",          nameField: "short_description", tableField: "table",        scriptFields: ["script_true", "script_false"] },
  ui_action:             { table: "sys_ui_action",          nameField: "name",              tableField: "table",        scriptFields: ["script"] },
  ui_page:               { table: "sys_ui_page",            nameField: "name",              tableField: null,           scriptFields: ["processing_script"] },
  ui_macro:              { table: "sys_ui_macro",           nameField: "name",              tableField: null,           scriptFields: ["xml"] },
  catalog_client_script: { table: "catalog_script_client",  nameField: "name",              tableField: "cat_item",     scriptFields: ["script"] },
  catalog_ui_policy:     { table: "catalog_ui_policy",      nameField: "short_description", tableField: "catalog_item", scriptFields: ["script_true", "script_false"] },
  acl:                   { table: "sys_security_acl",       nameField: "name",              tableField: null,           scriptFields: ["script"] },
  data_policy:           { table: "sys_data_policy2",       nameField: "short_description", tableField: "model_table",  scriptFields: ["script"] },
  script_action:         { table: "sysevent_script_action", nameField: "name",              tableField: null,           scriptFields: ["script"] }
};
export const ARTIFACT_TYPES = Object.keys(ARTIFACT_TABLE_MAP);

// Strip ServiceNow encoded-query operators from a user value so a keyword/name
// can't break (or inject into) the query.
function sanitizeQ(s) {
  return String(s || "").replace(/[\^\r\n]/g, " ").trim().slice(0, 200);
}

const clampLimit = (n, def, max) => {
  const v = parseInt(n, 10);
  return Number.isInteger(v) ? Math.min(Math.max(v, 1), max) : def;
};

// display_value=all returns each field as { value, display_value }. Keep plain
// values as-is; for fields whose display differs (references/choices), return
// { value, display } so the agent gets BOTH the sys_id/stored value and the label.
function flattenRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (v && typeof v === "object") {
      const val = v.value ?? "", dv = v.display_value ?? "";
      out[k] = dv && dv !== val ? { value: val, display: dv } : val;
    } else out[k] = v;
  }
  return out;
}
const dispOf = (v) => (v && typeof v === "object" ? (v.display_value ?? v.value ?? "") : v);

async function snFetch(target, pathAndQuery, signal) {
  const origin = target.origin;
  const excluded = snExcludedError(origin);
  if (excluded) throw excluded;
  let res;
  try {
    res = await fetch(origin + pathAndQuery, {
      method: "GET",
      credentials: target.credentials || "omit",
      headers: { Accept: "application/json", ...(target.headers || {}) },
      signal
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new Error(`Could not reach ServiceNow at ${origin}. Check the instance URL and that it's reachable.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`ServiceNow denied the request (HTTP ${res.status}) at ${origin} — no/wrong MCP credentials for THIS instance. DO NOT STOP AND DO NOT ASK THE USER TO FIX CREDENTIALS. Recover NOW, in this order: (1) retry the SAME query with sn_query_session — it authenticates through the logged-in browser tab and works whenever the tab is signed in; (2) if the record's form is open, read it with DOM tools (query_elements, get_editor_value, open_form_section); (3) do mutations through the UI instead of REST. CONTINUE THE TASK with these fallbacks — a 401 here never blocks the task itself.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // "Invalid table X" = the model invented a table name (2026-09-02:
    // wf_activity_variable_value, twice). Name the real table instead of offering
    // the DOM fallback — the form it would scrape does not exist either.
    const badTable = res.status === 400 ? invalidTableHint(body) : null;
    if (badTable) throw new Error(`ServiceNow HTTP 400: ${body.slice(0, 120)} — ${badTable} Do NOT retry the same table name.`);
    throw new Error(`ServiceNow HTTP ${res.status}: ${body.slice(0, 200)} — FALLBACK: if the record's form is open in the browser tab, read it with the DOM tools (query_elements / get_editor_value / open_form_section) instead of retrying REST.`);
  }
  return res.json();
}

// Query any table by encoded query. The workhorse for grounding solutions in real
// records + sys_ids. origin = the instance origin (https://devNNN.service-now.com).
export async function snQueryTable(target, args, signal) {
  const table = String(args.table || "").trim();
  if (!table) return { error: "sn_query_table requires a table name." };
  const params = new URLSearchParams();
  if (args.query) params.set("sysparm_query", String(args.query));
  if (args.fields) params.set("sysparm_fields", String(args.fields));
  params.set("sysparm_limit", String(clampLimit(args.limit, 10, 50)));
  params.set("sysparm_display_value", "all");
  params.set("sysparm_exclude_reference_link", "true");
  const data = await snFetch(target, `/api/now/table/${encodeURIComponent(table)}?${params.toString()}`, signal);
  const records = (data.result || []).map(flattenRow);
  const out = { instance: target.origin, table, query: args.query || "", count: records.length, records };
  // Reading a workflow activity for its script? The columns it asked for do not
  // exist on wf_activity — point at sn_wf_activity_vars before it re-queries.
  const wfHint = wfActivityQueryHint(table, args.fields, args.query);
  if (wfHint) out.hint = wfHint;
  return out;
}

// Fetch one record by its number (INC0012345 …). Resolves the table from the prefix,
// with a `task` fallback for task-derived records.
export async function snQueryRecord(target, args, signal) {
  const recordNumber = String(args.recordNumber || "").trim();
  if (!recordNumber) return { error: "sn_query_record requires a recordNumber (e.g. INC0012345)." };
  const table = tableForNumber(recordNumber) || "task";
  let out = await snQueryTable(target, { table, query: `number=${recordNumber}`, limit: 1 }, signal);
  if ((!out.records || !out.records.length) && table === "task") {
    return { error: `No record found for ${recordNumber}. This tool looks up by record NUMBER (INC/CHG/RITM...); it cannot take a sys_id or a name. For a sys_id use sn_query_table (query: sys_id=<32-hex>) with the correct table; if REST fails or you don't know the table, read the OPEN FORM directly with the DOM tools (query_elements for field state incl. checked/value, get_editor_value for scripts).` };
  }
  if (!out.records || !out.records.length) {
    // prefix mapped to a specific table but nothing found — try task as a fallback
    out = await snQueryTable(target, { table: "task", query: `number=${recordNumber}`, limit: 1 }, signal);
  }
  return out.records && out.records.length
    ? { instance: target.origin, table: out.table, record: out.records[0] }
    : { error: `No record found with number ${recordNumber} on ${target.origin} (looked in ${table}${table !== "task" ? " and task" : ""}). It may live on a DIFFERENT instance (stories/defects are often tracked elsewhere) — if the task text already contains the requirement, work from that and say the record was not on this instance; do not keep re-querying other tables for the same number. If its form is open in a tab, read it with the DOM tools (query_elements / read_page).` };
}

// Field definitions for a table from sys_dictionary (name, label, type, length,
// reference target, mandatory, default).
export async function snQuerySchema(target, args, signal) {
  const table = String(args.table || "").trim();
  if (!table) return { error: "sn_query_schema requires a table name." };
  // INHERITED FIELDS (2026-09-02): sys_dictionary rows are keyed by the table that
  // DECLARES the column, so `name=<table>` alone misses everything an extended
  // table inherits (incident → task; wf_activity_variable → var_dictionary). The
  // model read "wf_activity_variable has 2 fields" and went looking elsewhere.
  // Walk sys_db_object.super_class first and query the whole chain.
  const chain = [table];
  try {
    let cur = table;
    for (let depth = 0; depth < 8 && cur; depth++) {
      const p = new URLSearchParams();
      p.set("sysparm_query", `name=${cur}`);
      p.set("sysparm_fields", "name,super_class.name");
      p.set("sysparm_limit", "1");
      p.set("sysparm_display_value", "false");
      p.set("sysparm_exclude_reference_link", "true");
      const d = await snFetch(target, `/api/now/table/sys_db_object?${p.toString()}`, signal);
      const row = (d.result || [])[0];
      const parent = row ? String(row["super_class.name"] || "") : "";
      if (!parent || chain.includes(parent)) break;
      chain.push(parent);
      cur = parent;
    }
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    // sys_db_object unreadable for this user — fall back to the declaring table only.
  }
  const params = new URLSearchParams();
  params.set("sysparm_query", `nameIN${chain.join(",")}^elementISNOTEMPTY^ORDERBYelement`);
  params.set("sysparm_fields", "name,element,column_label,internal_type,max_length,reference,mandatory,default_value");
  params.set("sysparm_limit", "1000");
  params.set("sysparm_display_value", "all");
  const data = await snFetch(target, `/api/now/table/sys_dictionary?${params.toString()}`, signal);
  const seen = new Set();
  const fields = [];
  for (const r of (data.result || [])) {
    const name = dispOf(r.element);
    if (!name || seen.has(name)) continue; // a child override shadows the parent's row
    seen.add(name);
    const declaredOn = String((r.name && typeof r.name === "object") ? (r.name.value ?? r.name.display_value ?? "") : (r.name ?? ""));
    const f = {
      name,
      label: dispOf(r.column_label),
      type: dispOf(r.internal_type),
      max_length: dispOf(r.max_length),
      reference: dispOf(r.reference),
      mandatory: dispOf(r.mandatory),
      default: dispOf(r.default_value)
    };
    if (declaredOn && declaredOn !== table) f.inherited_from = declaredOn;
    fields.push(f);
  }
  // Child fields first, then each ancestor's — the ORDERBYelement above sorts
  // across the whole chain, which buries the table's own columns.
  fields.sort((a, b) => (chain.indexOf(a.inherited_from || table) - chain.indexOf(b.inherited_from || table)) || a.name.localeCompare(b.name));
  const out = { instance: target.origin, table, extends: chain.length > 1 ? chain.slice(1) : undefined, fieldCount: fields.length, fields };
  // The glide_var column is a container, not data: say where the values are.
  if (/^wf_activity$/i.test(table)) out.hint = "the `vars` column (glide_var) is only a container — " + WF_ACTIVITY_VARS_HINT_TEXT();
  return out;
}

const MAX_SCRIPT_CHARS = 60000;
function capScript(s) {
  const t = String(s == null ? "" : s);
  return t.length > MAX_SCRIPT_CHARS ? t.slice(0, MAX_SCRIPT_CHARS) + "\n…[script truncated]" : t;
}

// Fetch the COMPLETE script body of an artifact by name + type. Resolves the right
// table + script column(s) from ARTIFACT_TABLE_MAP. targetTable narrows precision
// for table-scoped types (business rule, client script, …).
export async function snFetchScriptByName(target, args, signal) {
  const artifactType = String(args.artifactType || "").trim();
  const config = ARTIFACT_TABLE_MAP[artifactType];
  if (!config) return { error: `Unknown artifactType '${artifactType}'. Valid: ${ARTIFACT_TYPES.join(", ")}` };
  const name = sanitizeQ(args.name);
  if (!name) return { error: "sn_fetch_script_by_name requires a name." };

  let query = `${config.nameField}=${name}`;
  if (args.targetTable && config.tableField) query += `^${config.tableField}=${sanitizeQ(args.targetTable)}`;
  const wantFields = [config.nameField, "sys_id", "active", "description", "short_description", ...config.scriptFields];
  if (config.tableField) wantFields.push(config.tableField);
  const params = new URLSearchParams();
  params.set("sysparm_query", query);
  params.set("sysparm_limit", "1");
  params.set("sysparm_fields", [...new Set(wantFields)].join(","));
  params.set("sysparm_display_value", "false"); // raw script source + sys_ids
  const data = await snFetch(target, `/api/now/table/${config.table}?${params.toString()}`, signal);
  const rec = (data.result || [])[0];
  if (!rec) return { error: `${artifactType} "${name}" not found${args.targetTable ? " on " + args.targetTable : ""}.` };

  let script;
  if (config.scriptFields.length === 1) script = capScript(rec[config.scriptFields[0]]);
  else { script = {}; for (const sf of config.scriptFields) if (rec[sf]) script[sf] = capScript(rec[sf]); }
  return {
    instance: target.origin, artifactType, table: config.table,
    name: rec[config.nameField], sys_id: rec.sys_id, active: rec.active,
    table_scope: config.tableField ? rec[config.tableField] : undefined,
    description: rec.description || rec.short_description || undefined,
    script
  };
}

// Fetch the COMPLETE script/record by sys_id from a specific table. Use when you
// already have a sys_id from a prior query/search.
export async function snFetchScriptBySysId(target, args, signal, sessionQuery) {
  const sysId = String(args.sysId || "").trim();
  const table = String(args.table || "").trim();
  if (!/^[0-9a-f]{32}$/i.test(sysId)) return { error: "Invalid sys_id (must be 32 hex chars)." };
  if (!table) return { error: "sn_fetch_script_by_sysid requires a table." };
  // A workflow activity's "script" is not a column — it is one of its inputs in
  // sys_variable_value. Returning script:"" here (as this did on 2026-09-02, five
  // times in one run) reads as "the activity has no script"; hand back the inputs.
  if (/^wf_activity$/i.test(table)) {
    const out = await snWorkflowActivityVars(target, { activity_sys_id: sysId }, signal, sessionQuery);
    if (out && !out.error) out.note = "wf_activity has no script column; these are the activity's INPUT values from sys_variable_value (advanced_script is the script you were after). Same data as sn_wf_activity_vars.";
    return out;
  }
  const params = new URLSearchParams();
  params.set("sysparm_display_value", "false");
  const data = await snFetch(target, `/api/now/table/${encodeURIComponent(table)}/${sysId}?${params.toString()}`, signal);
  const rec = data.result;
  if (!rec) return { error: `Record ${sysId} not found in ${table}. If the record's form is open in the browser tab, read it with the DOM tools instead (query_elements for field state incl. checked/value, get_editor_value for the Script editor, open_form_section for hidden tabs).` };
  // Identify the script field(s) for this table (if it's a known artifact table).
  const cfg = Object.values(ARTIFACT_TABLE_MAP).find((c) => c.table === table);
  const scriptFields = cfg ? cfg.scriptFields : ["script", "script_true", "processing_script", "xml"];
  const out = { instance: target.origin, table, sys_id: rec.sys_id, name: rec.name || rec.short_description, active: rec.active, description: rec.description || rec.short_description || undefined };
  const scripts = {};
  for (const sf of scriptFields) if (rec[sf]) scripts[sf] = capScript(rec[sf]);
  const keys = Object.keys(scripts);
  out.script = keys.length === 1 ? scripts[keys[0]] : (keys.length ? scripts : "");
  return out;
}

// ---------------------------------------------------------------------------
// sn_wf_activity_vars — a classic-workflow activity's INPUT VALUES, keyed by
// input name (element). Born of the 2026-09-02 STRY0000001 research runs: the
// story asked for the Catalog Task activities' advanced_script and the model
// spent two whole runs (≈70 tool calls, two "wait you are lost" interrupts)
// failing to read it, because nothing in the toolset said where it lives:
//
//   wf_activity            — the canvas node only (name, definition, x/y, stage)
//   wf_activity_variable   — the input MODEL per activity DEFINITION (element=
//                            "advanced_script", model=<definition>) — no values
//   sys_variable_value     — THE VALUES: document='wf_activity',
//                            document_key=<activity sys_id>, variable=<model row>,
//                            value=<text>   ← one row per filled-in input
//
// The dictionary shows this as the glide_var column wf_activity.vars
// (wf_activity.vars.var__m_<definition sys_id>.advanced_script), which the Table
// API returns as an empty container. Two queries here, one call for the model:
// the activities (by sys_id list or by workflow version) then their values with
// variable.element dot-walked, folded into {activity → {element: value}}.
//
// `sessionQuery(table, query, fields, limit)` is an optional fallback the
// dispatcher supplies when a logged-in ServiceNow tab exists: on a REST 401/403
// (Basic-Auth Restriction) the same two queries run through the tab's UI session
// instead of surfacing "retry with sn_query_session" for the model to translate.
// ---------------------------------------------------------------------------
const WF_VARS_LEGEND = {
  advanced_script: "server script run when the task is created; `task` = the new sc_task/task record, `current` = the workflow's record (e.g. sc_req_item). task.short_description / task.description set here WIN over the plain fields.",
  advanced: "\"true\" = the Advanced script is enabled and runs.",
  task_set_values: "Set Values (Catalog Task / Create Task) — an encoded field=value^field=value^EQ string applied to the created task (e.g. assignment_group=<sys_id>^description=<text>^EQ). THIS is the 'Values' field of the activity dialog; keep the pairs you are not changing.",
  task_short_description: "literal task short description (Catalog Task / Create Task) — used when the advanced script does not set task.short_description.",
  task_value_type: "which of Fields / Template / Values the dialog applies (values = Set Values).",
  values: "Set Values — one field=value per line applied to the created task (e.g. description=...).",
  short_description: "literal task short description (used when the script does not set task.short_description).",
  description: "literal task description (used when the script does not set task.description).",
  script: "Run Script activity body (ES5; `current`, `workflow`, `activity`).",
  assignment_group: "sys_user_group sys_id the task is assigned to."
};
const WF_VARS_ELEMENT_ORDER = ["advanced", "advanced_script", "task_short_description", "short_description", "description", "task_set_values", "values", "task_value_type", "script", "assignment_group"];
const SYS_ID_RE = /^[0-9a-f]{32}$/i;

// Raw (display_value=false) row → flat strings; a reference that still arrives as
// {value} (no exclude_reference_link on the session path) collapses to its sys_id.
function rawRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[k] = v && typeof v === "object" ? String(v.value ?? "") : (v == null ? "" : String(v));
  return out;
}

export async function snWorkflowActivityVars(target, args, signal, sessionQuery) {
  const ids = String(args.activity_sys_id || args.activity_sys_ids || "").split(/[\s,]+/).filter(Boolean).map((s) => s.toLowerCase());
  const version = String(args.workflow_version || "").trim().toLowerCase();
  if (!ids.length && !version) {
    return { error: "sn_wf_activity_vars needs activity_sys_id (one or a comma-separated list of wf_activity sys_ids) OR workflow_version (a wf_workflow_version sys_id — the sysparm_sys_id in the workflow editor URL — to read every activity of that version)." };
  }
  const badId = ids.find((id) => !SYS_ID_RE.test(id));
  if (badId) return { error: `"${badId}" is not a 32-hex sys_id. Pass wf_activity sys_ids (from sn_query_table {table:"wf_activity", query:"workflow_version=<v>", fields:"sys_id,name,activity_definition"}), not names.` };
  if (version && !SYS_ID_RE.test(version)) return { error: `workflow_version "${version}" is not a 32-hex sys_id. It is the wf_workflow_version sys_id — the sysparm_sys_id parameter of the workflow_ide.do URL, or wf_workflow_version.sys_id from a query.` };
  if (ids.length > 60) return { error: "Max 60 activity sys_ids per call — or pass workflow_version to read a whole version at once." };
  const elementFilter = String(args.element || "").split(/[\s,]+/).filter(Boolean).map((s) => s.toLowerCase());
  const maxChars = clampLimit(args.max_chars, 6000, MAX_SCRIPT_CHARS);

  const reader = makeRawReader(target, signal, sessionQuery);
  const runQuery = reader.run;

  // 1. The activities (node name + definition + stage + version), so the values
  //    come back labelled and the model never has to join them itself.
  const actFields = "sys_id,name,activity_definition,activity_definition.name,stage.name,workflow_version,workflow_version.name,workflow_version.published";
  let acts;
  try {
    acts = version
      ? await runQuery("wf_activity", `workflow_version=${version}^ORDERBYname`, actFields, 200)
      : await runQuery("wf_activity", `sys_idIN${ids.join(",")}`, actFields, ids.length);
  } catch (e) {
    return { error: `Could not read wf_activity: ${e.message}` };
  }
  if (!acts.length) {
    return { error: version
      ? `No wf_activity rows belong to workflow_version ${version}. Check the version sys_id (sn_query_table {table:"wf_workflow_version", query:"workflow.name=<workflow name>", fields:"sys_id,name,published,checked_out_by"}).`
      : `No wf_activity found for sys_id(s) ${ids.join(", ")}. Those are not activity sys_ids on this instance — re-read them from wf_activity (query workflow_version=<v>).` };
  }
  if (ids.length) acts.sort((a, b) => ids.indexOf(a.sys_id.toLowerCase()) - ids.indexOf(b.sys_id.toLowerCase())); // caller's order, not SN's

  // 2. Their filled-in inputs. valueISNOTEMPTY drops the ~20 blank inputs every
  //    Catalog Task carries; small batches keep the session path under its 50-row cap.
  const actIds = acts.map((a) => a.sys_id);
  const batch = reader.usedSession() ? 2 : 25;
  const values = [];
  let capped = false;
  try {
    for (let i = 0; i < actIds.length; i += batch) {
      const chunk = actIds.slice(i, i + batch);
      let q = `document=wf_activity^document_keyIN${chunk.join(",")}^valueISNOTEMPTY`;
      if (elementFilter.length) q += `^variable.elementIN${elementFilter.join(",")}`;
      q += "^ORDERBYdocument_key";
      const limit = reader.usedSession() ? 50 : 1000;
      const rows = await runQuery("sys_variable_value", q, "document_key,variable,variable.element,variable.label,value", limit);
      if (rows.length >= limit) capped = true;
      values.push(...rows);
    }
  } catch (e) {
    return { error: `Read ${acts.length} activit${acts.length === 1 ? "y" : "ies"} but could not read their inputs from sys_variable_value: ${e.message}` };
  }

  const byAct = new Map(actIds.map((id) => [id, {}]));
  const labels = {};
  let truncatedCount = 0;
  for (const r of values) {
    const el = (r["variable.element"] || r.variable || "").replace(/^\./, "") || "(unnamed)";
    const bucket = byAct.get(r.document_key);
    if (!bucket) continue;
    let v = r.value == null ? "" : String(r.value);
    if (v.length > maxChars) { v = v.slice(0, maxChars) + `\n…[truncated at ${maxChars} chars — re-call with element:"${el}" and max_chars up to ${MAX_SCRIPT_CHARS} for the rest]`; truncatedCount++; }
    bucket[el] = v;
    if (r["variable.label"] && !labels[el]) labels[el] = r["variable.label"];
  }

  const orderKeys = (vars) => {
    const ks = Object.keys(vars);
    ks.sort((a, b) => {
      const ia = WF_VARS_ELEMENT_ORDER.indexOf(a), ib = WF_VARS_ELEMENT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    const o = {}; for (const k of ks) o[k] = vars[k]; return o;
  };
  const activities = acts.map((a) => {
    const vars = orderKeys(byAct.get(a.sys_id) || {});
    const out = {
      sys_id: a.sys_id, name: a.name,
      definition: a["activity_definition.name"] || undefined, definition_sys_id: a.activity_definition || undefined,
      stage: a["stage.name"] || undefined,
      workflow_version: a.workflow_version || undefined,
      vars
    };
    if (!Object.keys(vars).length) out.note = elementFilter.length ? "none of the requested elements has a value on this activity" : "no non-empty inputs (Begin/End and some Set Values nodes are like this)";
    return out;
  });
  const usedElements = [...new Set(values.map((r) => (r["variable.element"] || "").replace(/^\./, "")).filter(Boolean))];
  const legend = {};
  for (const el of usedElements) if (WF_VARS_LEGEND[el]) legend[el] = WF_VARS_LEGEND[el];
  const v0 = acts[0];
  const res = {
    instance: target.origin,
    source: reader.usedSession() ? "sys_variable_value via logged-in tab session (REST 401/403)" : "sys_variable_value via REST",
    workflow_version: version || undefined,
    workflow_version_name: v0 && v0["workflow_version.name"] || undefined,
    published: v0 && v0["workflow_version.published"] !== "" ? v0["workflow_version.published"] : undefined,
    count: activities.length,
    activities,
    legend: Object.keys(legend).length ? legend : undefined,
    labels: Object.keys(labels).length ? labels : undefined
  };
  if (truncatedCount) res.truncated_values = truncatedCount;
  if (capped) res.warning = "the inputs query hit its row cap — some activities may be missing inputs; re-call with fewer activity_sys_ids or an element filter.";
  res.write_path = "to CHANGE an input: sn_wf_activity_set {activity_sys_id:\"<activity>\", inputs:{advanced_script:\"...\", values:\"...\"}} on a CHECKED-OUT (published=false) version — it writes over the API where the instance allows it, otherwise through the activity's own form in the signed-in tab, and verifies by reading the rows back. Do NOT sn_update_record sys_variable_value rows one by one (customer instances ACL that table). To REMOVE an activity: sn_wf_delete_activity.";
  return res;
}

// Raw-row reader shared by the workflow tools: REST first (display_value=false,
// no reference links), and once the instance answers 401/403 every later query
// goes through the signed-in tab's session (sn_query_session semantics: ≤50 rows).
function makeRawReader(target, signal, sessionQuery) {
  let usedSession = false;
  const run = async (table, query, fields, limit) => {
    if (!usedSession) {
      const params = new URLSearchParams();
      params.set("sysparm_query", query);
      params.set("sysparm_fields", fields);
      params.set("sysparm_limit", String(limit));
      params.set("sysparm_display_value", "false");
      params.set("sysparm_exclude_reference_link", "true");
      try {
        const data = await snFetch(target, `/api/now/table/${encodeURIComponent(table)}?${params.toString()}`, signal);
        return (data.result || []).map(rawRow);
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        if (!sessionQuery || !/HTTP 40[13]/.test(String(e && e.message))) throw e;
        usedSession = true; // REST is closed on this instance for this user — stay on the session path
      }
    }
    // Session path: sn_query_session caps rows at 50, so callers keep batches small.
    const r = await sessionQuery(table, query, fields, Math.min(limit, 50));
    if (!r || r.error) throw new Error((r && r.error) || "session query returned nothing");
    return (r.records || []).map(rawRow);
  };
  return { run, usedSession: () => usedSession };
}

// ---------------------------------------------------------------------------
// sn_wf_activity_set — CHANGE a classic-workflow activity's inputs and prove it.
//
// Why a dedicated tool (2026-09-02, STRY0000001 implementation runs 15:39 /
// 15:46 / 16:01): the story needed four sys_variable_value rows changed and the
// model had every value ready, but every sn_update_record came back 403 (eleven
// times over Basic auth) and the classic sys_variable_value form rendered Value
// read-only (sys_readonly.sys_variable_value.value) — customer instances ACL that
// table against direct writes. What DOES work is the activity's own form: the
// Workflow Editor's double-click dialog IS wf_activity.do, and its variable
// editor renders each input as wf_activity.vars.var__m_<definition>.<element>
// (live-verified 2026-07-30, legacy-workflow pack). The model then burned ~40
// DOM-hunting calls at a 60K-token baseline without finding "Set Values".
//
// So this does the whole edit in ONE call: read the activity (draft guard) →
// try the API (stored connection, then the tab session — snWriteRecord) → if
// the instance refuses, open wf_activity.do in the signed-in tab, set the fields
// by their known names (editor-aware), save with g_form → re-read the rows and
// report per input: verified / unchanged / refused / not persisted.
//
// `deps` (from the dispatcher): { sessionQuery, session, form } where
//   form = { open(url), run(pageFunc, args), saveAndSettle(), url() } drives the
//   signed-in tab, or null when no such tab exists.
// ---------------------------------------------------------------------------
const WF_ELEMENT_RE = /^[a-z0-9_]{1,60}$/i;
const norm = (s) => String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();

// Runs IN THE PAGE (MAIN world) on an open wf_activity form. Self-contained.
// plan = [{ element, value }]; def = the activity_definition sys_id. Sets each
// input through its rendered field — the CodeMirror/Monaco editor when one is
// attached (script inputs), the raw input/textarea/hidden field otherwise — and
// through g_form so onChange logic runs. Never saves. Reports what it found so a
// missing or read-only field is diagnosed in the result, not hunted for.
export function pageWfActivitySetFields(def, plan) {
  try {
    var gf = window.g_form;
    if (!gf || typeof gf.setValue !== "function") return { hasGform: false };
    var tbl = ""; try { tbl = gf.getTableName ? gf.getTableName() : ""; } catch (e) {}
    if (tbl && tbl !== "wf_activity") return { hasGform: true, wrongForm: tbl };
    var recId = ""; try { recId = gf.getUniqueValue ? gf.getUniqueValue() : ""; } catch (e) {}
    var prefix = "wf_activity.vars.var__m_" + def + ".";
    var gfPrefix = "vars.var__m_" + def + ".";
    var seen = [];
    var all = document.querySelectorAll('[id*="vars.var__m_"], [name*="vars.var__m_"]');
    for (var i = 0; i < all.length && seen.length < 60; i++) {
      var idn = all[i].id || all[i].name;
      if (idn && seen.indexOf(idn) < 0) seen.push(idn);
    }
    function cmFor(el) {
      var cms = document.querySelectorAll(".CodeMirror");
      for (var c = 0; c < cms.length; c++) {
        var cm = cms[c].CodeMirror;
        if (cm && cm.getTextArea && cm.getTextArea() === el) return cm;
      }
      return null;
    }
    function monacoFor(el) {
      try {
        var eds = (window.monaco && window.monaco.editor && window.monaco.editor.getEditors) ? window.monaco.editor.getEditors() : [];
        if (!eds.length) return null;
        var box = el;
        for (var up = 0; up < 6 && box && !(box.querySelector && box.querySelector(".monaco-editor")); up++) box = box.parentElement;
        if (!box) return null;
        for (var k = 0; k < eds.length; k++) {
          var n = eds[k].getDomNode && eds[k].getDomNode();
          if (n && box.contains(n)) return eds[k];
        }
      } catch (e) {}
      return null;
    }
    var results = [];
    for (var p = 0; p < plan.length; p++) {
      var el = String(plan[p].element), val = String(plan[p].value == null ? "" : plan[p].value);
      var id = prefix + el;
      var node = document.getElementById(id);
      if (!node) { try { node = document.querySelector('[name="' + id.replace(/"/g, '\\"') + '"]'); } catch (e) {} }
      var ro = false;
      if (!node) {
        var roNode = document.getElementById("sys_readonly." + id) || document.getElementById("sys_display." + id) || document.getElementById("ni." + id);
        if (roNode) { node = roNode; ro = /^sys_readonly\./.test(roNode.id); }
      }
      if (!node) { results.push({ element: el, found: false }); continue; }
      if (node.readOnly || node.disabled || /^sys_readonly\./.test(node.id || "")) ro = true;
      if (ro) { results.push({ element: el, found: true, readonly: true, id: node.id || node.name }); continue; }
      var via = "dom";
      var cm = cmFor(node);
      var mo = cm ? null : monacoFor(node);
      try {
        if (cm) { cm.setValue(val); if (cm.save) cm.save(); via = "codemirror"; }
        else if (mo) { mo.setValue(val); via = "monaco"; }
      } catch (e) {}
      try {
        node.value = val;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (e) {}
      try { gf.setValue(gfPrefix + el, val); via += "+g_form"; }
      catch (e) { try { gf.setValue(id, val); via += "+g_form"; } catch (e2) {} }
      var now = null;
      try { now = node.value; } catch (e) {}
      if (now == null || now === "") { try { now = gf.getValue(gfPrefix + el); } catch (e) {} }
      var same = String(now == null ? "" : now).replace(/\r\n?/g, "\n") === val.replace(/\r\n?/g, "\n");
      results.push({ element: el, found: true, readonly: false, id: node.id || node.name, via: via, applied: same });
    }
    return { hasGform: true, record: recId, results: results, vars_fields_on_form: seen };
  } catch (e) { return { hasGform: true, error: String((e && e.message) || e) }; }
}

async function readWfActivity(reader, id) {
  const rows = await reader.run("wf_activity",
    `sys_id=${id}`,
    "sys_id,name,activity_definition,activity_definition.name,workflow_version,workflow_version.name,workflow_version.published,workflow_version.checked_out_by,workflow_version.workflow",
    1);
  return rows[0] || null;
}

function publishedVersionError(act, tool) {
  return `${tool}: activity "${act.name}" (${act.sys_id}) belongs to the PUBLISHED version of "${act["workflow_version.name"]}" (${act.workflow_version}). Published versions are not edited in place — the Workflow Editor edits a checked-out DRAFT (published=false) and Publish swaps it in. Find the draft: sn_query_table {table:"wf_workflow_version", query:"workflow=${act["workflow_version.workflow"] || "<wf_workflow sys_id>"}^published=false^ORDERBYDESCsys_updated_on", fields:"sys_id,name,checked_out_by,sys_updated_on"} (if none, check the workflow out in the editor first), then sn_wf_activity_vars {workflow_version:"<draft>"} to get the draft's activity sys_ids (same names) and re-run against those.`;
}

export async function snWorkflowActivitySet(target, args, signal, deps = {}) {
  const id = String(args.activity_sys_id || "").trim().toLowerCase();
  if (!SYS_ID_RE.test(id)) return { error: "sn_wf_activity_set needs activity_sys_id — a wf_activity sys_id (32 hex). Get it from sn_wf_activity_vars {workflow_version:\"<draft version sys_id>\"}." };
  const inputs = args.inputs;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs) || !Object.keys(inputs).length) {
    return { error: "sn_wf_activity_set needs inputs — an object of element→value, e.g. {advanced_script:\"task.short_description = 'Move - Update AD info';\", values:\"description=...^EQ\"}. Element names come from sn_wf_activity_vars." };
  }
  const badEl = Object.keys(inputs).find((k) => !WF_ELEMENT_RE.test(k));
  if (badEl) return { error: `"${badEl}" is not an input element name (letters, digits, underscore). Use the element names sn_wf_activity_vars returns (advanced_script, values, short_description, description, …).` };
  const wanted = {};
  for (const [k, v] of Object.entries(inputs)) wanted[k] = v == null ? "" : String(v);
  const reader = makeRawReader(target, signal, deps.sessionQuery);

  // 1. The activity + its version (draft guard: published versions are never edited in place).
  let act;
  try { act = await readWfActivity(reader, id); }
  catch (e) { return { error: `Could not read wf_activity ${id}: ${e.message}` }; }
  if (!act) return { error: `No wf_activity with sys_id ${id} on ${target.origin}. Activity sys_ids come from sn_wf_activity_vars {workflow_version:"<version>"} — not from the story text, which may list the PUBLISHED version's activities.` };
  if (act["workflow_version.published"] === "true" && args.allow_published !== true) return { error: publishedVersionError(act, "sn_wf_activity_set") };
  const def = act.activity_definition;
  if (!SYS_ID_RE.test(def || "")) return { error: `wf_activity ${id} has no activity_definition — cannot resolve its input fields.` };

  // 2. Current rows for the requested inputs (empty rows included — the row may exist with no value).
  const els = Object.keys(wanted);
  let rows;
  try {
    rows = await reader.run("sys_variable_value",
      `document=wf_activity^document_key=${id}^variable.elementIN${els.join(",")}`,
      "sys_id,variable,variable.element,value", 50);
  } catch (e) { return { error: `Read the activity but could not read its inputs from sys_variable_value: ${e.message}` }; }
  const rowByEl = {};
  for (const r of rows) {
    const el = (r["variable.element"] || "").replace(/^\./, "");
    if (el && !rowByEl[el]) rowByEl[el] = r;
  }
  const outcome = {};   // element → { status, ... }
  const pending = [];   // elements that still need a write
  for (const el of els) {
    const row = rowByEl[el];
    if (row && norm(row.value) === norm(wanted[el])) outcome[el] = { status: "unchanged", note: "already holds this value" };
    else pending.push(el);
  }
  const base = {
    instance: target.origin,
    activity: { sys_id: act.sys_id, name: act.name, definition: act["activity_definition.name"] || undefined },
    workflow_version: { sys_id: act.workflow_version, name: act["workflow_version.name"] || undefined, published: act["workflow_version.published"] === "true", checked_out_by: act["workflow_version.checked_out_by"] || undefined }
  };
  if (!pending.length) return { ...base, ok: true, route: "none", inputs: outcome, note: "Every requested input already holds the requested value — nothing to write." };

  // 3. Route A — the API (stored connection, then the tab session). One refusal
  //    on every path closes the route for the rest of this call.
  let route = "api";
  const apiRefusals = [];
  let varRows = null; // wf_activity_variable rows, fetched lazily for inputs with no row yet
  for (const el of pending.slice()) {
    const row = rowByEl[el];
    let res;
    if (row) {
      res = await snWriteRecord("sn_update_record", target, { table: "sys_variable_value", sysId: row.sys_id, fields: { value: wanted[el] } }, signal, deps.session || null);
    } else {
      if (!varRows) {
        try { varRows = await reader.run("wf_activity_variable", `model=${def}^elementIN${pending.join(",")}`, "sys_id,element", 50); }
        catch (e) { varRows = []; }
      }
      const vr = varRows.find((v) => v.element === el);
      if (!vr) { outcome[el] = { status: "unknown_input", error: `"${el}" is not an input of the "${act["activity_definition.name"] || def}" activity definition (no wf_activity_variable row). Check the element name with sn_wf_activity_vars.` }; pending.splice(pending.indexOf(el), 1); continue; }
      res = await snWriteRecord("sn_create_record", target, { table: "sys_variable_value", fields: { document: "wf_activity", document_key: id, variable: vr.sys_id, value: wanted[el] } }, signal, deps.session || null);
    }
    if (res && !res.error) { outcome[el] = { status: "written", via: res.auth_path || "api" }; pending.splice(pending.indexOf(el), 1); continue; }
    const denied = res && Array.isArray(res.denied_on) && res.denied_on.length;
    if (!denied) return { ...base, ok: false, route, inputs: outcome, error: `Writing "${el}" failed: ${(res && res.error) || "no response"}` };
    apiRefusals.push({ element: el, denied_on: res.denied_on });
    break; // API is closed for this table on this instance — switch route
  }

  // 4. Route B — the activity's own form in the signed-in tab.
  let formReport = null;
  if (pending.length) {
    route = apiRefusals.length ? "form" : route;
    const form = deps.form;
    if (!form) {
      return { ...base, ok: false, route: "api", inputs: outcome, api_refused: apiRefusals,
        error: `The instance refused the API write on sys_variable_value on every auth path (${summarizeDenials(apiRefusals)}) and there is no signed-in tab on ${target.origin} to drive the activity form with. Open (or switch the active tab to) any classic page on that instance while signed in, then re-run this exact call — it will edit ${target.origin}/wf_activity.do?sys_id=${id} through your session. ` + fixScriptHint(act.workflow_version, [{ activity: act.name, inputs: wanted }], []) };
    }
    const url = `${target.origin}/wf_activity.do?sys_id=${id}&sysparm_stack=no`;
    try { await form.open(url); } catch (e) { return { ...base, ok: false, route, inputs: outcome, error: `Could not open the activity form ${url}: ${e.message}` }; }
    const plan = pending.map((el) => ({ element: el, value: wanted[el] }));
    let r;
    try { r = await form.run(pageWfActivitySetFields, [def, plan]); } catch (e) { r = { error: e.message }; }
    if (!r || !r.hasGform) return { ...base, ok: false, route, inputs: outcome, error: `${url} did not render a ServiceNow form (no g_form)${r && r.error ? ": " + r.error : ""}. Is the tab signed in to ${target.origin}? Sign in (sn_login) and re-run.` };
    if (r.wrongForm) return { ...base, ok: false, route, inputs: outcome, error: `The tab rendered a ${r.wrongForm} form instead of wf_activity — the navigation was redirected (session expired or no read access to wf_activity ${id}). Sign in and re-run.` };
    if (r.error) return { ...base, ok: false, route, inputs: outcome, error: `The activity form threw while setting fields: ${r.error}` };
    formReport = r;
    const readonly = (r.results || []).filter((x) => x.readonly).map((x) => x.element);
    const missing = (r.results || []).filter((x) => !x.found).map((x) => x.element);
    if (readonly.length || missing.length) {
      for (const x of r.results || []) {
        if (x.readonly) outcome[x.element] = { status: "refused", error: `the activity form renders this input READ-ONLY (${x.id}) for this user` };
        else if (!x.found) outcome[x.element] = { status: "not_on_form", error: `no field named wf_activity.vars.var__m_${def}.${x.element} on the activity form` };
      }
      const why = [];
      if (readonly.length) why.push(`read-only on the form: ${readonly.join(", ")} — this user cannot change it through the API OR the UI (write ACL on the activity inputs, or the version is not checked out by this user${base.workflow_version.checked_out_by ? ` — it is checked out by ${base.workflow_version.checked_out_by}` : ""}). Nothing in this extension can get past that: STOP and report it to the owner (they need the role/ACL, or to check the workflow out themselves).`);
      if (missing.length) why.push(`not on the form: ${missing.join(", ")} — the definition "${act["activity_definition.name"] || def}" renders these input fields: ${(r.vars_fields_on_form || []).map((f) => f.replace(/^.*var__m_[0-9a-f]{32}\./, "")).filter((v, i, a) => a.indexOf(v) === i).slice(0, 40).join(", ") || "(none found — the variable editor may not have rendered)"}. Use one of those element names.`);
      return { ...base, ok: false, route, inputs: outcome, api_refused: apiRefusals.length ? apiRefusals : undefined, error: `Nothing was saved. ${why.join(" ")}`, alternative: readonly.length ? fixScriptHint(act.workflow_version, [{ activity: act.name, inputs: wanted }], []) : undefined };
    }
    let saved;
    try { saved = await form.saveAndSettle(); } catch (e) { saved = { error: e.message }; }
    if (saved && saved.blocked) return { ...base, ok: false, route, inputs: outcome, error: `The activity form refused to save — mandatory field(s) empty: ${(saved.missing || []).join(", ") || "(unnamed)"}. Nothing was persisted.` };
    if (saved && saved.error) return { ...base, ok: false, route, inputs: outcome, error: `g_form.save() failed on the activity form: ${saved.error}. Nothing was persisted.` };
  }

  // 5. Verify — the rows are the ground truth, whichever route was used.
  const toVerify = els.filter((el) => outcome[el] && (outcome[el].status === "written")).concat(pending);
  let after = {};
  for (let attempt = 0; attempt < 3 && toVerify.length; attempt++) {
    try {
      const vrows = await reader.run("sys_variable_value",
        `document=wf_activity^document_key=${id}^variable.elementIN${toVerify.join(",")}`,
        "sys_id,variable.element,value", 50);
      after = {};
      for (const r of vrows) { const el = (r["variable.element"] || "").replace(/^\./, ""); if (el) after[el] = r; }
      if (toVerify.every((el) => after[el] && norm(after[el].value) === norm(wanted[el]))) break;
    } catch (e) {
      return { ...base, ok: false, route, inputs: outcome, error: `The write(s) ran but the verification read failed: ${e.message}. Re-read with sn_wf_activity_vars {activity_sys_id:"${id}"} before claiming anything.` };
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 700));
  }
  let allOk = true;
  for (const el of toVerify) {
    const row = after[el];
    if (row && norm(row.value) === norm(wanted[el])) {
      outcome[el] = { status: "verified", row: row.sys_id, via: (outcome[el] && outcome[el].via) || route };
    } else {
      allOk = false;
      const got = row ? String(row.value || "") : "";
      outcome[el] = {
        status: "not_persisted",
        row: row ? row.sys_id : undefined,
        stored_now: got.length > 160 ? got.slice(0, 160) + "…" : got,
        error: row
          ? (route === "form"
              ? `the form saved but sys_variable_value still holds the OLD value — the "${el}" widget re-serialised its own rows on submit and dropped the value set on the hidden field`
              : "the API reported success but the stored value did not change")
          : "no sys_variable_value row exists for this input after the write"
      };
      if (route === "form" && (el === "values" || el === "task_set_values")) {
        outcome[el].fallback = "Set Values could not be written through the form widget. " + fixScriptHint(act.workflow_version, [{ activity: act.name, inputs: { [el]: wanted[el] } }], []) + " (Last resort only: set task.description in the advanced script instead — it runs after Set Values and wins — and say the Values field still shows the old text.)";
      }
    }
  }
  const out = { ...base, ok: allOk, route, inputs: outcome };
  if (apiRefusals.length) out.api_refused = apiRefusals;
  if (formReport) out.form = { record: formReport.record, fields: (formReport.results || []).map((x) => ({ element: x.element, via: x.via })) };
  out.next = allOk
    ? `Verified against sys_variable_value. Then publish with sn_wf_publish {workflow_version:"${act.workflow_version}"} (graph pre-flight + publish + read-back + cache flush) — never the editor's Publish menu; its result carries the read-back.`
    : "Do NOT report these inputs as updated. Fix the failed ones as described per input (the Fix Script route in `alternative`/`fallback` works when every direct write is refused), or report the exact blocker.";
  if (!allOk && !out.alternative) out.alternative = fixScriptHint(act.workflow_version, [{ activity: act.name, inputs: wanted }], []);
  return out;
}

function summarizeDenials(list) {
  return list.map((d) => `${d.element}: ${(d.denied_on || []).map((x) => `${x.path} ${x.status}${x.instance_says ? ` "${x.instance_says}"` : ""}`).join("; ")}`).join(" | ");
}

// ---------------------------------------------------------------------------
// FIX SCRIPT route — the owner's own answer to "ServiceNow (MCP) refuses the
// write" (STRY0000001, 2026-09-02 20:09 UTC: sys_script_fix
// 00000000000000000000000000000000 "STRY0000001 Update task text",
// C:\redacted\path). A Fix Script runs server-side GlideRecord under NO table ACLs,
// so it changes sys_variable_value / wf_transition / wf_activity rows the Table
// API (403) and the forms (read-only Value) refuse for the same user. The record
// itself is creatable through the API or its own form; running it is one
// related-link click ("Run Fix Script") that the model or the owner performs.
//
// buildWfFixScript() renders the owner's script shape from structured input —
// activities keyed by NAME inside one draft version, complete new input values,
// delete + bridge — idempotent (a second run changes nothing) and ES5. The model
// never hand-writes the GlideRecord code, so a local model cannot get the
// escaping, the element names, or the delete order wrong.
// ---------------------------------------------------------------------------
const jsStr = (s) => JSON.stringify(String(s == null ? "" : s));

// Tables the classic engine reads through the server cache. A version published
// over the Table API read back published=true yet started NO context for six
// inserts in a row (dev000000, 2026-09-04) until /cache.do was loaded — so a
// scripted publish flushes these itself (GlideCacheManager.flushTable is the
// documented platform call; the model never types this list).
export const WF_CACHE_TABLES = ["wf_workflow_version", "wf_workflow", "wf_activity", "wf_condition", "wf_transition", "sys_variable_value"];

// The publish + flush block shared by sn_wf_publish's Fix-Script fallback and
// sn_wf_fix_script {publish:true}. `publish` = { conditionType?, condition? }.
function wfPublishScriptLines(versionId, publish, indent = "  ") {
  const p = publish && typeof publish === "object" ? publish : {};
  const L = (s) => indent + s;
  const out = [];
  out.push(L("var ver = new GlideRecord('wf_workflow_version');"));
  out.push(L(`if (!ver.get(${jsStr(versionId)})) { gs.error(TAG + ' version not found: ' + ${jsStr(versionId)}); failed++; }`));
  out.push(L("else {"));
  out.push(L("  var publishedOk = false;"));
  if (p.conditionType) out.push(L(`  ver.setValue('condition_type', ${jsStr(p.conditionType)});`));
  if (p.condition !== undefined && p.condition !== null) out.push(L(`  ver.setValue('condition', ${jsStr(p.condition)});`));
  out.push(L("  ver.setValue('validated', true);"));
  out.push(L("  ver.setValue('published', true);   /* fires 'Unpublish other workflow versions' + 'Unload Workflow Version' */"));
  out.push(L("  ver.setValue('checked_out', false);"));
  out.push(L("  ver.setValue('checked_out_by', '');"));
  out.push(L("  if (!ver.update()) { gs.error(TAG + ' update() returned nothing for ' + ver.getUniqueValue() + ' - NOT published, cache NOT flushed'); failed++; }"));
  out.push(L("  else {"));
  out.push(L("    changed++; publishedOk = true;"));
  out.push(L("    gs.info(TAG + ' published ' + ver.getValue('name') + ' (' + ver.getUniqueValue() + ') condition_type=' + ver.getValue('condition_type') + ' condition=' + (ver.getValue('condition') || '(none)'));"));
  out.push(L("  }"));
  out.push(L("  /* The engine reads workflow versions through the server cache: a published version"));
  out.push(L("     it has not been told about never starts (2026-09-04). Flush the tables it caches. */"));
  out.push(L("  if (publishedOk) {"));
  out.push(L(`    var flushTables = ${JSON.stringify(WF_CACHE_TABLES)};`));
  out.push(L("    for (var fi = 0; fi < flushTables.length; fi++) {"));
  out.push(L("      try { GlideCacheManager.flushTable(flushTables[fi]); } catch (fe) { gs.warn(TAG + ' flushTable ' + flushTables[fi] + ' failed: ' + fe); }"));
  out.push(L("    }"));
  out.push(L("    gs.info(TAG + ' cache flushed for ' + flushTables.join(', '));"));
  out.push(L("  }"));
  out.push(L("}"));
  return out;
}

export function buildWfFixScript({ versionId, title, tag, set = [], remove = [], publish = null }) {
  const T = tag || (String(title || "").match(/\b(STRY|DFCT|ENHC|PRB|CHG)\d+\b/i) || ["FIX"])[0];
  const lines = [];
  lines.push("/**");
  lines.push(` * Fix Script - ${String(title || "workflow activity update").replace(/\*\//g, "* /")}`);
  lines.push(" * Edits the CHECKED-OUT draft version " + versionId + " of a classic workflow.");
  lines.push(" * Generated by the local-claude-extension (sn_wf_fix_script). Idempotent: a");
  lines.push(publish ? " * second run changes nothing but re-publishes + re-flushes the cache." : " * second run changes nothing. Publish the draft from the Workflow Editor afterwards.");
  lines.push(" */");
  lines.push("(function() {");
  lines.push(`  var TAG = ${jsStr("[" + T + "]")};`);
  lines.push(`  var versionId = ${jsStr(versionId)};`);
  lines.push("  var changed = 0, skipped = 0, failed = 0;");
  lines.push("");
  lines.push("  function findActivity(ref) {");
  lines.push("    var a = new GlideRecord('wf_activity');");
  lines.push("    a.addQuery('workflow_version', versionId);");
  lines.push("    if (/^[0-9a-f]{32}$/i.test(ref)) { a.addQuery('sys_id', ref); } else { a.addQuery('name', ref); }");
  lines.push("    a.setLimit(1);");
  lines.push("    a.query();");
  lines.push("    if (a.next()) { return a.getUniqueValue(); }");
  lines.push("    gs.error(TAG + ' activity not found in version ' + versionId + ': ' + ref);");
  lines.push("    failed++;");
  lines.push("    return null;");
  lines.push("  }");
  lines.push("");
  lines.push("  function setInput(activityId, element, newVal) {");
  lines.push("    if (!activityId) { return; }");
  lines.push("    var v = new GlideRecord('sys_variable_value');");
  lines.push("    v.addQuery('document', 'wf_activity');");
  lines.push("    v.addQuery('document_key', activityId);");
  lines.push("    v.addQuery('variable.element', element);");
  lines.push("    v.setLimit(1);");
  lines.push("    v.query();");
  lines.push("    if (!v.next()) {");
  lines.push("      /* no row yet: create it from the definition's input model */");
  lines.push("      var act = new GlideRecord('wf_activity');");
  lines.push("      if (!act.get(activityId)) { failed++; return; }");
  lines.push("      var model = new GlideRecord('wf_activity_variable');");
  lines.push("      model.addQuery('model', act.getValue('activity_definition'));");
  lines.push("      model.addQuery('element', element);");
  lines.push("      model.setLimit(1);");
  lines.push("      model.query();");
  lines.push("      if (!model.next()) { gs.error(TAG + ' unknown input ' + element + ' on activity ' + activityId); failed++; return; }");
  lines.push("      v.initialize();");
  lines.push("      v.setValue('document', 'wf_activity');");
  lines.push("      v.setValue('document_key', activityId);");
  lines.push("      v.setValue('variable', model.getUniqueValue());");
  lines.push("      v.setValue('value', newVal);");
  lines.push("      v.insert();");
  lines.push("      changed++;");
  lines.push("      gs.info(TAG + ' created ' + element + ' on ' + activityId);");
  lines.push("      return;");
  lines.push("    }");
  lines.push("    var oldVal = v.getValue('value') || '';");
  lines.push("    if (oldVal.replace(/\\r\\n/g, '\\n') === newVal.replace(/\\r\\n/g, '\\n')) { skipped++; gs.info(TAG + ' ' + element + ' on ' + activityId + ' already correct'); return; }");
  lines.push("    v.setValue('value', newVal);");
  lines.push("    v.update();");
  lines.push("    changed++;");
  lines.push("    gs.info(TAG + ' updated ' + element + ' on ' + activityId);");
  lines.push("  }");
  lines.push("");
  lines.push("  function removeActivity(ref, bridgeRef) {");
  lines.push("    var id = findActivity(ref);");
  lines.push("    if (!id) { gs.info(TAG + ' ' + ref + ' already absent'); return; }");
  lines.push("    var bridgeId = bridgeRef ? findActivity(bridgeRef) : null;");
  lines.push("    if (bridgeRef && !bridgeId) { return; }");
  lines.push("    var tIn = new GlideRecord('wf_transition');");
  lines.push("    tIn.addQuery('to', id);");
  lines.push("    tIn.query();");
  lines.push("    while (tIn.next()) {");
  lines.push("      if (bridgeId) { tIn.setValue('to', bridgeId); tIn.update(); gs.info(TAG + ' re-pointed transition ' + tIn.getUniqueValue() + ' to ' + bridgeRef); }");
  lines.push("      else { tIn.deleteRecord(); gs.info(TAG + ' deleted incoming transition ' + tIn.getUniqueValue()); }");
  lines.push("    }");
  lines.push("    var cond = new GlideRecord('wf_condition');");
  lines.push("    cond.addQuery('activity', id);");
  lines.push("    cond.query();");
  lines.push("    while (cond.next()) {");
  lines.push("      var tOut = new GlideRecord('wf_transition');");
  lines.push("      tOut.addQuery('from', cond.getUniqueValue());");
  lines.push("      tOut.query();");
  lines.push("      while (tOut.next()) { tOut.deleteRecord(); }");
  lines.push("      cond.deleteRecord();");
  lines.push("    }");
  lines.push("    var vals = new GlideRecord('sys_variable_value');");
  lines.push("    vals.addQuery('document', 'wf_activity');");
  lines.push("    vals.addQuery('document_key', id);");
  lines.push("    vals.query();");
  lines.push("    while (vals.next()) { vals.deleteRecord(); }");
  lines.push("    var act = new GlideRecord('wf_activity');");
  lines.push("    if (act.get(id)) { act.deleteRecord(); changed++; gs.info(TAG + ' deleted activity ' + ref + ' (' + id + ')'); }");
  lines.push("  }");
  lines.push("");
  set.forEach((s, i) => {
    const v = "act" + (i + 1);
    lines.push(`  /* ${String(s.activity).replace(/\*\//g, "* /")} */`);
    lines.push(`  var ${v} = findActivity(${jsStr(s.activity)});`);
    for (const [el, val] of Object.entries(s.inputs || {})) lines.push(`  setInput(${v}, ${jsStr(el)}, ${jsStr(val)});`);
    lines.push("");
  });
  remove.forEach((d) => {
    lines.push(`  removeActivity(${jsStr(d.activity)}, ${d.rewire_to ? jsStr(d.rewire_to) : "null"});`);
  });
  if (remove.length) lines.push("");
  if (publish) {
    lines.push("  /* PUBLISH + CACHE FLUSH — only when every edit above landed */");
    lines.push("  if (failed === 0) {");
    lines.push(...wfPublishScriptLines(versionId, publish, "    "));
    lines.push("  } else {");
    lines.push("    gs.error(TAG + ' NOT published: ' + failed + ' edit(s) failed above');");
    lines.push("  }");
    lines.push("");
  }
  lines.push("  gs.info(TAG + ' done: ' + changed + ' changed, ' + skipped + ' already correct, ' + failed + ' failed');");
  lines.push("})();");
  return lines.join("\n");
}

// A stand-alone publish Fix Script (no activity edits) — the fallback when the
// Table API refuses or silently ignores published=true.
export function buildWfPublishFixScript({ versionId, title, conditionType, condition }) {
  const lines = [];
  lines.push("/**");
  lines.push(` * Fix Script - ${String(title || "publish workflow version").replace(/\*\//g, "* /")}`);
  lines.push(" * Publishes wf_workflow_version " + versionId + " and flushes the workflow caches.");
  lines.push(" * Generated by the local-claude-extension (sn_wf_publish). Safe to re-run.");
  lines.push(" */");
  lines.push("(function() {");
  lines.push("  var TAG = '[WF PUBLISH]';");
  lines.push("  var changed = 0, failed = 0;");
  lines.push(...wfPublishScriptLines(versionId, { conditionType, condition }, "  "));
  lines.push("  gs.info(TAG + ' done: ' + changed + ' changed, ' + failed + ' failed');");
  lines.push("})();");
  return lines.join("\n");
}

// The version's `condition` is a CONDITIONS field (encoded query), not a script.
// The 2026-09-04 build stored `current.operation() == 'insert'` there, which the
// engine can never match. JavaScript belongs in an If activity's Advanced script.
// Master-mind 2026-09-04 (B1): `!=` is a legitimate encoded-query operator
// (state!=6, sys_id!=<id>) and a clause VALUE may itself start with `javascript:`
// (sys_created_on>=javascript:gs.beginningOfToday()), so the test runs per
// ^-clause and looks only at what is left after the operator. `==` never occurs
// in an encoded query, and `current.` / `gs.` outside a javascript: value never do.
export function wfConditionLooksLikeScript(cond) {
  const c = String(cond == null ? "" : cond).trim();
  if (!c) return false;
  // `return` / `answer =` only where a JS statement can start — `u_type=return` is a value.
  // `answer = true` / `answer = 'yes'` / `answer = (…)` is script; `answer=yes` is a field named answer.
  if (/==|&&|\|\||;\s*$|^\s*\(?\s*function\b|(^|[;{}])\s*return\b|(^|[;{}])\s*answer\s*=\s*(true|false|['"(!]|current\b|gs\b|new\b)/.test(c)) return true;
  return c.split(/\^(?:OR|NQ)?/).some((clause) => {
    // Everything from the first `javascript:` on is a dynamic VALUE — after =, >=, ON,
    // BETWEEN, IN, DYNAMIC, LIKE, or an `@` separator (master-mind 2026-09-04 pass 2:
    // a greedy field class swallowed word operators and refused every date filter).
    const head = clause.trim().split(/javascript:/i)[0].trim();
    if (!head) return false;
    const m = /^([a-zA-Z0-9_.]+?)(!=|>=|<=|=|>|<|NOT LIKE|NOTLIKE|LIKE|STARTSWITH|ENDSWITH|NOT IN|IN|ISNOTEMPTY|ISEMPTY|EMPTYSTRING|BETWEEN|ON|DYNAMIC|NSAMEAS|SAMEAS|ANYTHING|GT_OR_EQUALS_FIELD|LT_OR_EQUALS_FIELD|GT_FIELD|LT_FIELD|RELATIVE[A-Z]*|DATEPART|MATCH_PAT|MATCH_RGX|ORDERBY[A-Z]*|GROUPBY)(.*)$/.exec(head);
    const field = m ? m[1] : head, value = m ? m[3] : head;
    if (/^(current|gs)\s*(\.|\[)/i.test(field)) return true;   // current.priority>3, current['x']
    return /\b(current|gs)\s*(\.|\[)/i.test(value);            // priority=gs.getProperty('x')
  });
}
// wf_workflow_version.condition_type choices that matter here (sys_choice, live 2026-09-04).
export const WF_CONDITION_TYPE_RE = /^(run_match|run_if_no_other)$/;
export const WF_CONDITION_FIX = "wf_workflow_version.condition is an ENCODED QUERY (a conditions field), not a script: use an encoded query on the version's TABLE such as sys_mod_count=0 (insert-only proxy — the record has never been updated), priority=1, or leave it EMPTY and gate inside the graph with an If activity whose Advanced script is `answer = (current.operation() == 'insert') ? 'yes' : 'no';` (works on any table). Never put current.* / == / gs.* in the condition field.";

const FIX_SCRIPT_RUN_STEPS = (origin, sysId, publishes = false) =>
  `RUN IT: navigate the signed-in tab to ${origin}/sys_script_fix.do?sys_id=${sysId}&sysparm_stack=no, then query_elements {selector:"a, button", text:"Run Fix Script"} → click_element (a confirmation dialog appears — click its Proceed button; a progress dialog then reports the gs.info lines). If the "Run Fix Script" link is not on the form, this user lacks the role to run it: hand the owner the record URL and STOP. AFTER the run: verify with sn_wf_activity_vars {workflow_version:"<version>"} (and wf_activity/wf_transition queries for a deletion) — the gs.info summary is not evidence` +
  (publishes
    ? `; the script also PUBLISHED the version and flushed the workflow caches — read back sn_query_table {table:"wf_workflow_version", query:"sys_id=${"<version>"}", fields:"published,checked_out_by,condition_type,condition"} and then create ONE test record.`
    : ` — then publish with sn_wf_publish {workflow_version:"<version>"} (pre-flight + publish + cache flush), not the editor's menu.`);

// sn_wf_fix_script — build the Fix Script and create its sys_script_fix record.
//   args: { workflow_version, name, set:[{activity, inputs}], remove:[{activity, rewire_to}],
//           publish (false | true | {condition_type, condition}), create (default true) }
export async function snWorkflowFixScript(target, args, signal, deps = {}) {
  const versionId = String(args.workflow_version || "").trim().toLowerCase();
  if (!SYS_ID_RE.test(versionId)) return { error: "sn_wf_fix_script needs workflow_version — the checked-out DRAFT's wf_workflow_version sys_id (published=false)." };
  const set = Array.isArray(args.set) ? args.set : [];
  const remove = Array.isArray(args.remove) ? args.remove : [];
  let publish = null;
  if (args.publish === true) publish = {};
  else if (args.publish && typeof args.publish === "object") publish = { conditionType: args.publish.condition_type || undefined, condition: args.publish.condition };
  if (publish && publish.conditionType && !WF_CONDITION_TYPE_RE.test(String(publish.conditionType))) return { error: `publish.condition_type ${JSON.stringify(String(publish.conditionType))} is not a wf_workflow_version choice (run_match | run_if_no_other).` };
  if (publish) {
    if (publish.condition !== undefined && wfConditionLooksLikeScript(publish.condition)) return { error: `publish.condition ${JSON.stringify(String(publish.condition)).slice(0, 120)} is JavaScript. ${WF_CONDITION_FIX}` };
    if (!publish.conditionType) publish.conditionType = "run_match";
  }
  if (!set.length && !remove.length && !publish) return { error: "sn_wf_fix_script needs at least one change: set:[{activity:\"<name or sys_id>\", inputs:{<element>:\"<complete new value>\"}}] and/or remove:[{activity:\"<name>\", rewire_to:\"<name of the node its incoming transitions should lead to>\"}] — or publish:true to publish the version + flush the workflow caches." };
  for (const s of set) {
    if (!s || !String(s.activity || "").trim()) return { error: "every set[] entry needs activity (name within the version, or wf_activity sys_id)." };
    if (!s.inputs || typeof s.inputs !== "object" || Array.isArray(s.inputs) || !Object.keys(s.inputs).length) return { error: `set[] entry "${s.activity}" needs inputs {<element>: <complete new value>} (element names as sn_wf_activity_vars returns them, e.g. advanced_script, task_set_values).` };
    const bad = Object.keys(s.inputs).find((k) => !WF_ELEMENT_RE.test(k));
    if (bad) return { error: `"${bad}" is not an input element name.` };
  }
  for (const d of remove) if (!d || !String(d.activity || "").trim()) return { error: "every remove[] entry needs activity (name or sys_id)." };
  const reader = makeRawReader(target, signal, deps.sessionQuery);

  // Draft guard + a name check so the script never runs against a typo.
  let ver;
  try { ver = (await reader.run("wf_workflow_version", `sys_id=${versionId}`, "sys_id,name,published,checked_out_by,workflow", 1))[0]; }
  catch (e) { return { error: `Could not read wf_workflow_version ${versionId}: ${e.message}` }; }
  if (!ver) return { error: `No wf_workflow_version ${versionId} on ${target.origin}.` };
  // A published version may be RE-published (flush after a post-publish edit) but never edited in place.
  if (ver.published === "true" && (set.length || remove.length)) return { error: `${versionId} is the PUBLISHED version of "${ver.name}". A Fix Script must edit the checked-out draft (published=false): sn_query_table {table:"wf_workflow_version", query:"workflow=${ver.workflow}^published=false^ORDERBYDESCsys_updated_on", fields:"sys_id,name,checked_out_by"}.` };
  let acts = [];
  try { acts = await reader.run("wf_activity", `workflow_version=${versionId}`, "sys_id,name", 200); } catch {}
  const known = (ref) => acts.some((a) => a.sys_id === String(ref).toLowerCase() || a.name === String(ref));
  const missing = [...set.map((s) => s.activity), ...remove.map((d) => d.activity), ...remove.map((d) => d.rewire_to).filter(Boolean)].filter((r) => acts.length && !known(r));
  if (missing.length) return { error: `Not activities of version ${versionId} ("${ver.name}"): ${missing.map((m) => `"${m}"`).join(", ")}. Activities there: ${acts.map((a) => a.name).join(" | ")}. Use the exact names.` };

  const name = String(args.name || `${(set[0] && set[0].activity) || ver.name || "workflow"} — ${set.length || remove.length ? "activity update" : "publish"}`).trim().slice(0, 100);
  const script = buildWfFixScript({ versionId, title: name, set, remove, publish });
  const what = [
    set.length ? `sets ${set.map((s) => `${s.activity} [${Object.keys(s.inputs).join(", ")}]`).join("; ")}` : "",
    remove.length ? `removes ${remove.map((d) => d.activity).join(", ")}` : "",
    publish ? `publishes it (condition_type=${publish.conditionType}${publish.condition !== undefined ? `, condition=${JSON.stringify(String(publish.condition))}` : ""}) and flushes the workflow caches` : ""
  ].filter(Boolean).join("; ");
  const description = String(args.description || `${ver.published === "true" ? "Re-publishes" : "Edits the checked-out"} "${ver.name}" (${versionId}): ${what}. Generated by the local-claude-extension.`).slice(0, 1000);
  const base = { instance: target.origin, workflow_version: { sys_id: versionId, name: ver.name, checked_out_by: ver.checked_out_by || undefined }, name, publishes: !!publish, script_chars: script.length };
  if (args.create === false) {
    return { ...base, ok: true, created: false, script, next: `Create it: sn_create_record {table:"sys_script_fix", fields:{name:${JSON.stringify(name)}, description:"…", record_for_rollback:"true", script:"<this script>"}} — or, if the API refuses, the form ${target.origin}/sys_script_fix.do?sys_id=-1 (sn_set_field name; list_editors + set_editor_value for the script; save_record). ` + FIX_SCRIPT_RUN_STEPS(target.origin, "<sys_id>", !!publish) };
  }
  const res = await snWriteRecord("sn_create_record", target, { table: "sys_script_fix", fields: { name, description, script, record_for_rollback: "true" } }, signal, deps.session || null);
  if (!res || res.error) {
    return { ...base, ok: false, created: false, script, error: `The sys_script_fix record could not be created over the API: ${(res && res.error) || "no response"}`, next: `Create it through its form instead: navigate ${target.origin}/sys_script_fix.do?sys_id=-1&sysparm_stack=no → sn_set_field {field:"name", value:${JSON.stringify(name)}} → list_editors + set_editor_value {index:<the Script editor>, value:<the script above>} → save_record. Or write the script to the task folder with write_file for the owner. ` + FIX_SCRIPT_RUN_STEPS(target.origin, "<new sys_id>", !!publish) };
  }
  return { ...base, ok: true, created: true, sys_id: res.sys_id, auth_path: res.auth_path, url: `${target.origin}/sys_script_fix.do?sys_id=${res.sys_id}`, script_preview: script.slice(0, 600) + (script.length > 600 ? "…" : ""), next: FIX_SCRIPT_RUN_STEPS(target.origin, res.sys_id, !!publish) };
}

// ---------------------------------------------------------------------------
// sn_wf_publish — PUBLISH a classic workflow version so it actually RUNS.
//
// Why (dev000000, 2026-09-04, "Incident Caller Email and Child Incident"): the
// build was right, sn_update_record published=true read back true, and the
// workflow still started no context for SIX test incidents over 25 minutes.
// Three things were wrong at once and nothing in the toolset named any of them:
//   1. condition_type was EMPTY at first publish (the engine skips such versions);
//   2. condition held `current.operation() == 'insert'` — JavaScript in a
//      conditions (encoded-query) field, which can never match;
//   3. the engine caches the published versions per table; a Table-API publish
//      never reached it. Loading /cache.do was the change right before the first
//      context appeared (INC0010007), after eight test incidents and five Fix Scripts.
// This tool does the publish the way it has to be done, in one call: graph
// pre-flight (dangling / unreachable / dead-end nodes) → condition sanity →
// condition_type default → PATCH published (Fix-Script fallback when refused or
// silently ignored) → read-back → CACHE FLUSH through the signed-in tab
// (cache.do) or, without a tab, through the Fix Script's GlideCacheManager lines.
//
// deps: { sessionQuery, session, cache: { flush(): Promise<{ok, via, error?}> } | null }
// ---------------------------------------------------------------------------
export function wfGraphPreflight(acts, conds, trans) {
  const byId = new Map(acts.map((a) => [String(a.sys_id).toLowerCase(), a]));
  const isBegin = (a) => String(a["activity_definition.begin"] || "") === "true" || /^begin$/i.test(String(a.name || ""));
  const isEnd = (a) => String(a["activity_definition.end"] || "") === "true" || /^end$/i.test(String(a.name || ""));
  const begin = acts.find(isBegin);
  const ends = acts.filter(isEnd);
  const condOwner = new Map(conds.map((c) => [String(c.sys_id).toLowerCase(), String(c.activity || "").toLowerCase()]));
  const blockers = [], warnings = [];
  const dangling = trans.filter((t) => !String(t.to || "").trim());
  if (dangling.length) blockers.push(`${dangling.length} transition(s) with an EMPTY "to" (invisible on the canvas, hangs the run): ${dangling.map((t) => t.sys_id).join(", ")} — delete them or point them at a node.`);
  if (!begin) blockers.push("no Begin activity in this version.");
  if (!ends.length) blockers.push("no End activity in this version.");
  const incoming = new Map(), outgoing = new Map();
  for (const t of trans) {
    const to = String(t.to || "").toLowerCase();
    const from = String(t.from || "").toLowerCase() || condOwner.get(String(t.condition || "").toLowerCase()) || "";
    if (to) incoming.set(to, (incoming.get(to) || 0) + 1);
    if (from) outgoing.set(from, (outgoing.get(from) || 0) + 1);
  }
  for (const a of acts) {
    const id = String(a.sys_id).toLowerCase();
    if (!isBegin(a) && !incoming.get(id)) blockers.push(`"${a.name}" (${id}) is UNREACHABLE — no transition leads to it.`);
    if (!isEnd(a) && !outgoing.get(id)) blockers.push(`"${a.name}" (${id}) is a DEAD END — no transition leaves it, so the context would stay executing forever.`);
  }
  // Exit ports without a transition are only a warning: an If's unused "No" is common, but an unused port on a Timer/Run Script is usually a mistake.
  const wired = new Set(trans.map((t) => String(t.condition || "").toLowerCase()));
  const unwired = conds.filter((c) => !wired.has(String(c.sys_id).toLowerCase()) && byId.has(String(c.activity || "").toLowerCase()) && !isEnd(byId.get(String(c.activity || "").toLowerCase())));
  if (unwired.length) warnings.push(`exit condition(s) with no transition: ${unwired.map((c) => `${(byId.get(String(c.activity || "").toLowerCase()) || {}).name}.${c.name}`).join(", ")} — fine only if that outcome should end the branch.`);
  return { blockers, warnings, begin: begin ? begin.sys_id : null, ends: ends.map((e) => e.sys_id), activities: acts.length, transitions: trans.length };
}

export async function snWorkflowPublish(target, args, signal, deps = {}) {
  const versionId = String(args.workflow_version || "").trim().toLowerCase();
  if (!SYS_ID_RE.test(versionId)) return { error: "sn_wf_publish needs workflow_version — the wf_workflow_version sys_id to publish (the draft you built, or a published version to re-publish + flush after an edit)." };
  const reader = makeRawReader(target, signal, deps.sessionQuery);
  const VER_FIELDS = "sys_id,name,workflow,table,published,validated,checked_out,checked_out_by,condition,condition_type,active";
  let ver;
  try { ver = (await reader.run("wf_workflow_version", `sys_id=${versionId}`, VER_FIELDS, 1))[0]; }
  catch (e) { return { error: `Could not read wf_workflow_version ${versionId}: ${e.message}` }; }
  if (!ver) return { error: `No wf_workflow_version ${versionId} on ${target.origin}.` };

  // --- condition sanity (encoded query, never JavaScript) ---
  const condGiven = args.condition !== undefined && args.condition !== null;
  const condition = condGiven ? String(args.condition) : String(ver.condition || "");
  if (wfConditionLooksLikeScript(condition)) {
    return { error: `${condGiven ? "condition" : `The version's stored condition ${JSON.stringify(condition).slice(0, 120)}`} is JavaScript — the engine can never match it, and the 2026-09-04 build lost six test records to exactly this. ${condGiven ? "" : `If you believe the stored condition IS a valid encoded query, publish WITHOUT touching it: sn_wf_fix_script {workflow_version:"${versionId}", publish:true} (the Fix Script does not re-check it). `}${WF_CONDITION_FIX} To REPLACE a wrong condition, re-call sn_wf_publish with condition:"<encoded query>" (or "" = run on every insert/update and gate inside the graph) — that overwrites the stored one, so only when it is wrong.` };
  }
  const conditionType = String(args.condition_type || ver.condition_type || "run_match");
  if (!WF_CONDITION_TYPE_RE.test(conditionType)) return { error: `condition_type ${JSON.stringify(conditionType)} is not a wf_workflow_version choice — use run_match (run whenever the condition matches) or run_if_no_other.${args.condition_type ? "" : ' (That is the STORED value; pass condition_type:"run_match" to replace it.)'}` };
  const notes = [];
  if (!args.condition_type && !ver.condition_type) notes.push("condition_type was EMPTY (the engine skips such versions) — set to run_match (\"Run the workflow always\" when the condition matches).");
  if (!String(ver.table || "").trim()) return { error: `Version ${versionId} ("${ver.name}") has no table — nothing can trigger it. Set wf_workflow_version.table (and wf_workflow.table) first.` };

  // --- graph pre-flight ---
  let acts = [], conds = [], trans = [];
  try {
    acts = await reader.run("wf_activity", `workflow_version=${versionId}`, "sys_id,name,activity_definition,activity_definition.begin,activity_definition.end", 300);
    conds = await reader.run("wf_condition", `activity.workflow_version=${versionId}`, "sys_id,activity,name,order", 600);
    trans = await reader.run("wf_transition", `from.workflow_version=${versionId}`, "sys_id,from,to,condition", 600);
  } catch (e) { return { error: `Could not read the graph of ${versionId}: ${e.message}` }; }
  const pre = wfGraphPreflight(acts, conds, trans);
  const base = { instance: target.origin, workflow_version: { sys_id: versionId, name: ver.name, workflow: ver.workflow, table: ver.table }, preflight: pre };
  if (pre.blockers.length && args.force !== true) {
    return { ...base, ok: false, published: false, error: `NOT published — ${pre.blockers.length} blocker(s) in the graph: ${pre.blockers.join(" ")} Fix them (sn_wf_fix_script / sn_update_record on wf_transition / sn_wf_delete_activity), then call sn_wf_publish again.` };
  }

  // --- publish over the API ---
  const fields = { published: "true", validated: "true", checked_out: "", checked_out_by: "", condition_type: conditionType };
  if (condGiven) fields.condition = condition;
  const publishScript = () => buildWfPublishFixScript({ versionId, title: `WF ${ver.name} - publish`, conditionType, condition: condGiven ? condition : undefined });
  const viaFixScript = async (reason) => {
    const name = `WF ${String(ver.name).slice(0, 60)} - publish + cache flush`;
    const script = publishScript();
    const res = await snWriteRecord("sn_create_record", target, { table: "sys_script_fix", fields: { name, description: `Publishes wf_workflow_version ${versionId} ("${ver.name}") with condition_type=${conditionType} and flushes the workflow caches. ${reason} Generated by the local-claude-extension (sn_wf_publish).`.slice(0, 1000), script, record_for_rollback: "true" } }, signal, deps.session || null);
    if (!res || res.error) {
      return { ...base, ok: false, published: false, route: "fix-script", reason, script, error: `${reason} The publish Fix Script could not be created either: ${(res && res.error) || "no response"}. Create it through its form (${target.origin}/sys_script_fix.do?sys_id=-1&sysparm_stack=no: sn_set_field name, list_editors + set_editor_value for the script, save_record) and run it, or hand the script to the owner.` };
    }
    return { ...base, ok: true, published: "pending-fix-script", route: "fix-script", reason, fix_script: { sys_id: res.sys_id, name, url: `${target.origin}/sys_script_fix.do?sys_id=${res.sys_id}` }, notes: notes.length ? notes : undefined, next: `${reason} ` + FIX_SCRIPT_RUN_STEPS(target.origin, res.sys_id, true) + " After that read-back, create ONE test record." };
  };
  const w = await snWriteRecord("sn_update_record", target, { table: "wf_workflow_version", sysId: versionId, fields }, signal, deps.session || null);
  if (!w || w.error) return viaFixScript(`The Table API refused the publish (${String((w && w.error) || "no response").slice(0, 200)}).`);

  // --- read back (the 2026-07-30 form route silently ignored published=true) ---
  let back;
  try { back = (await reader.run("wf_workflow_version", `sys_id=${versionId}`, VER_FIELDS, 1))[0]; } catch {}
  if (!back || String(back.published) !== "true") return viaFixScript("sn_update_record published=true was accepted but read back false (silently ignored).");
  let siblings = [];
  try { siblings = await reader.run("wf_workflow_version", `workflow=${ver.workflow}^published=true^sys_id!=${versionId}`, "sys_id,name,checked_out_by", 20); } catch {}
  if (String(back.condition_type || "") !== conditionType) notes.push(`condition_type read back as ${JSON.stringify(String(back.condition_type || ""))}, not the ${JSON.stringify(conditionType)} that was sent — the engine skips a version whose condition_type is empty; re-publish through sn_wf_fix_script {workflow_version:"${versionId}", publish:true} (GlideRecord setValue) and read it back again.`);
  if (siblings.length) notes.push(`${siblings.length} OTHER published version(s) of this workflow still read published=true (${siblings.map((s) => s.sys_id).join(", ")}) — the unpublish-siblings BR did not run; the engine may pick either. Re-publish through sn_wf_fix_script {workflow_version:"${versionId}", publish:true} so the GlideRecord update fires it.`);

  // --- cache flush: the step the API publish skips ---
  let cache = { ok: false, via: "none" };
  if (deps.cache && typeof deps.cache.flush === "function") {
    try { cache = await deps.cache.flush(); } catch (e) { cache = { ok: false, via: "cache.do", error: e.message }; }
  }
  if (!cache.ok) {
    notes.push(`CACHE NOT FLUSHED (${cache.error || "no signed-in tab on this instance"}): the engine may keep running the OLD published set and start nothing for the new version. Flush before the first test record: navigate the signed-in tab to ${target.origin}/cache.do (loading the page flushes the server cache), or run sn_wf_fix_script {workflow_version:"${versionId}", publish:true}.`);
  }
  const verify = `sn_query_table {table:"wf_context", query:"id=<test record sys_id>", fields:"sys_id,state,started,workflow_version"}`;
  return {
    ...base,
    ok: true,
    published: true,
    route: w.auth_path || "api",
    condition_type: String(back.condition_type || ""),   // STORED value, verbatim (MM 09-04 B6)
    condition: String(back.condition || ""),
    checked_out_by: String(back.checked_out_by || ""),
    cache_flushed: cache.ok ? cache.via : false,
    preflight_warnings: pre.warnings.length ? pre.warnings : undefined,
    notes: notes.length ? notes : undefined,
    next: `Create ONE test record on ${ver.table} now and read back ${verify} plus wf_history / wf_executing / sys_email for it. wf_context count 0 AFTER this publish${cache.ok ? " (cache flushed)" : ""} means the version's condition (${JSON.stringify(String(back.condition || ""))}, type ${String(back.condition_type || "(empty)")}) or table does not match the record — fix that; a second identical test record proves nothing. A Timer/Wait activity is proven by its wf_executing row (state executing), not by sys_trigger.`
  };
}

// One-line hand-off used by the other workflow tools when every direct route is refused.
function fixScriptHint(versionId, setEntries, removeEntries) {
  const parts = [];
  if (setEntries && setEntries.length) parts.push(`set:${JSON.stringify(setEntries.map((s) => ({ activity: s.activity, inputs: Object.fromEntries(Object.keys(s.inputs).map((k) => [k, "<complete new value>"])) })))}`);
  if (removeEntries && removeEntries.length) parts.push(`remove:${JSON.stringify(removeEntries)}`);
  return `ALTERNATIVE THAT WORKS WHEN EVERY WRITE IS REFUSED (owner-approved 2026-09-02): a Fix Script. Call sn_wf_fix_script {workflow_version:"${versionId}", name:"<story number> <short title>", ${parts.join(", ")}} — it generates the idempotent GlideRecord script (server-side, no table ACLs), creates the sys_script_fix record, and tells you how to run it (one "Run Fix Script" click) and verify.`;
}

// ---------------------------------------------------------------------------
// sn_wf_delete_activity — REMOVE one activity node from a checked-out draft and
// keep the graph connected: incoming transitions are re-pointed at `rewire_to`
// (or deleted), the activity is deleted (ServiceNow cascades its conditions /
// transitions / input rows; anything left behind is swept), and the result is
// verified by reading the graph back. Deletes are ALWAYS approval-gated
// (ALWAYS_CONFIRM_TOOLS) and refused on a published version or on Begin/End.
// The Workflow Editor canvas offers no DOM for "delete node" (GWT-rendered
// menus, 2026-07-30), so without this the story's "remove the Update R7 UG Group
// Lists task" step had no path at all.
// ---------------------------------------------------------------------------
async function snDeleteRow(target, table, sysId, signal, session) {
  // snWrite with DELETE — same route fallback as the other writes.
  const origin = target.origin;
  const isBasic = !!(target.headers && target.headers.Authorization);
  const haveSession = !!(session && session.origin === origin);
  const routes = [];
  if (isBasic) routes.push("basic");
  if (haveSession || !isBasic) routes.push("session");
  if (routes.length > 1 && basicWriteDenied.has(origin)) routes.reverse();
  const denied = [];
  for (const route of routes) {
    let t = target;
    if (route === "session" && haveSession) {
      let tok = ""; try { tok = await session.getToken(); } catch {}
      t = { origin, credentials: "include", headers: tok ? { "X-UserToken": tok } : {} };
    }
    try {
      await snWrite(t, `/api/now/table/${encodeURIComponent(table)}/${sysId}`, null, signal, "DELETE");
      if (route === "basic") basicWriteDenied.delete(origin);
      return { ok: true, auth_path: route === "basic" ? "basic (stored connection)" : "signed-in tab session" };
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      if (!e || !e.snDenied) return { error: (e && e.message) || String(e) };
      denied.push(e);
      if (route === "basic") basicWriteDenied.add(origin);
    }
  }
  return { error: denied.map((e) => e.message).join(" "), denied_on: denied.map((e) => ({ path: e.authPath, status: e.status, instance_says: e.snDetail || "" })) };
}

export async function snWorkflowDeleteActivity(target, args, signal, deps = {}) {
  const id = String(args.activity_sys_id || "").trim().toLowerCase();
  if (!SYS_ID_RE.test(id)) return { error: "sn_wf_delete_activity needs activity_sys_id — the wf_activity sys_id (32 hex) of the node to remove, from sn_wf_activity_vars {workflow_version:\"<draft>\"}." };
  const rewireTo = String(args.rewire_to || "").trim().toLowerCase();
  if (rewireTo && !SYS_ID_RE.test(rewireTo)) return { error: "rewire_to must be a wf_activity sys_id (the node the deleted activity's INCOMING transitions should point at instead — usually the node the deleted one led to)." };
  if (rewireTo === id) return { error: "rewire_to cannot be the activity being deleted." };
  const reader = makeRawReader(target, signal, deps.sessionQuery);
  const session = deps.session || null;

  let act;
  try { act = await readWfActivity(reader, id); }
  catch (e) { return { error: `Could not read wf_activity ${id}: ${e.message}` }; }
  if (!act) return { error: `No wf_activity with sys_id ${id} on ${target.origin}.` };
  if (act["workflow_version.published"] === "true") return { error: publishedVersionError(act, "sn_wf_delete_activity") };
  if (/^(begin|end)$/i.test(String(act["activity_definition.name"] || "")) || /^(begin|end)$/i.test(String(act.name || ""))) {
    return { error: `Refusing to delete "${act.name}" — Begin/End nodes are the workflow's entry and exit.` };
  }
  const base = {
    instance: target.origin,
    activity: { sys_id: act.sys_id, name: act.name, definition: act["activity_definition.name"] || undefined },
    workflow_version: { sys_id: act.workflow_version, name: act["workflow_version.name"] || undefined, published: false, checked_out_by: act["workflow_version.checked_out_by"] || undefined }
  };

  // The graph around the node, before touching anything.
  let conds, tIn, tOut, target2 = null;
  try {
    conds = await reader.run("wf_condition", `activity=${id}`, "sys_id,name", 50);
    tIn = await reader.run("wf_transition", `to=${id}`, "sys_id,from,from.activity,from.activity.name,from.name", 50);
    tOut = conds.length ? await reader.run("wf_transition", `fromIN${conds.map((c) => c.sys_id).join(",")}`, "sys_id,to,to.name", 50) : [];
    if (rewireTo) {
      const t = await reader.run("wf_activity", `sys_id=${rewireTo}^workflow_version=${act.workflow_version}`, "sys_id,name", 1);
      target2 = t[0] || null;
      if (!target2) return { ...base, error: `rewire_to ${rewireTo} is not an activity of the same version (${act.workflow_version}). Pick the node the deleted activity currently leads to: ${tOut.map((t) => `${t["to.name"] || "?"} (${t.to})`).join(", ") || "(it has no outgoing transition)"}.` };
    }
  } catch (e) { return { ...base, error: `Could not read the activity's transitions/conditions: ${e.message}` }; }
  if (tIn.length && !rewireTo && args.orphan_ok !== true) {
    return { ...base, error: `"${act.name}" has ${tIn.length} incoming transition(s) (from ${tIn.map((t) => `"${t["from.activity.name"] || "?"}" via condition "${t["from.name"] || "?"}"`).join(", ")}). Pass rewire_to:"<activity sys_id>" so they are re-pointed (usually at the node this activity leads to: ${tOut.map((t) => `${t["to.name"] || "?"} = ${t.to}`).join(", ") || "none"}), or orphan_ok:true to delete them and leave those branches dangling.`, incoming: tIn, outgoing: tOut };
  }

  const done = { rewired: [], deleted: { activity: false, conditions: 0, transitions: 0, inputs: 0 } };
  // 1. Re-point (reversible) BEFORE the delete — the cascade would remove these rows otherwise.
  for (const t of tIn) {
    if (rewireTo) {
      const r = await snWriteRecord("sn_update_record", target, { table: "wf_transition", sysId: t.sys_id, fields: { to: rewireTo } }, signal, session);
      if (!r || r.error) return { ...base, ok: false, progress: done, error: `Stopped before deleting anything: could not re-point transition ${t.sys_id} (from "${t["from.activity.name"] || "?"}") to ${rewireTo}: ${(r && r.error) || "no response"}`, alternative: fixScriptHint(act.workflow_version, [], [{ activity: act.name, rewire_to: target2 ? target2.name : undefined }]) };
      done.rewired.push({ transition: t.sys_id, from_activity: t["from.activity.name"] || t["from.activity"], to: target2 ? target2.name : rewireTo });
    } else {
      const r = await snDeleteRow(target, "wf_transition", t.sys_id, signal, session);
      if (!r.ok) return { ...base, ok: false, progress: done, error: `Stopped: could not delete incoming transition ${t.sys_id}: ${r.error}`, alternative: fixScriptHint(act.workflow_version, [], [{ activity: act.name }]) };
      done.deleted.transitions++;
    }
  }
  // 2. The node itself. A refusal here leaves the graph as re-pointed above (harmless: the node is now unreachable).
  const del = await snDeleteRow(target, "wf_activity", id, signal, session);
  if (!del.ok) {
    return { ...base, ok: false, progress: done, denied_on: del.denied_on, error: `Could not delete wf_activity ${id}: ${del.error}${done.rewired.length ? ` The ${done.rewired.length} incoming transition(s) WERE re-pointed, so "${act.name}" is now unreachable (it will never create its task) but still sits on the canvas — remove it in the Workflow Editor (click the node → Delete) before publishing.` : ""}`, alternative: fixScriptHint(act.workflow_version, [], [{ activity: act.name, rewire_to: target2 ? target2.name : undefined }]) };
  }
  done.deleted.activity = true;
  // 3. Sweep whatever the cascade left behind.
  try {
    const leftT = await reader.run("wf_transition", `to=${id}${conds.length ? `^ORfromIN${conds.map((c) => c.sys_id).join(",")}` : ""}`, "sys_id", 50);
    for (const t of leftT) { const r = await snDeleteRow(target, "wf_transition", t.sys_id, signal, session); if (r.ok) done.deleted.transitions++; }
    const leftC = await reader.run("wf_condition", `activity=${id}`, "sys_id", 50);
    for (const c of leftC) { const r = await snDeleteRow(target, "wf_condition", c.sys_id, signal, session); if (r.ok) done.deleted.conditions++; }
    const leftV = await reader.run("sys_variable_value", `document=wf_activity^document_key=${id}`, "sys_id", 50);
    for (const v of leftV) { const r = await snDeleteRow(target, "sys_variable_value", v.sys_id, signal, session); if (r.ok) done.deleted.inputs++; }
  } catch {}
  // 4. Verify.
  let verified = false, leftovers = {};
  try {
    const a = await reader.run("wf_activity", `sys_id=${id}`, "sys_id", 1);
    const t = await reader.run("wf_transition", `to=${id}${conds.length ? `^ORfromIN${conds.map((c) => c.sys_id).join(",")}` : ""}`, "sys_id", 50);
    const c = await reader.run("wf_condition", `activity=${id}`, "sys_id", 50);
    leftovers = { activity: a.length, transitions: t.length, conditions: c.length };
    verified = !a.length && !t.length && !c.length;
  } catch (e) { leftovers = { error: e.message }; }
  return {
    ...base, ok: verified, deleted: done.deleted, rewired: done.rewired, auth_path: del.auth_path,
    leftovers: verified ? undefined : leftovers,
    next: verified
      ? `Verified: the node and its transitions are gone${done.rewired.length ? ` and ${done.rewired.length} incoming transition(s) now lead to "${target2 ? target2.name : rewireTo}"` : ""}. Then publish with sn_wf_publish {workflow_version:"${act.workflow_version}"} (its pre-flight is the validation; it reads the publish back and flushes the cache) — never the editor's Publish menu.`
      : "Rows are still present (see leftovers) — do NOT report the activity as removed; list what remains."
  };
}

// Search INSIDE script bodies for a keyword across one or more artifact types —
// finds artifacts by what they DO. Returns name, type, sys_id, and a snippet
// around the matching line. Mirrors master-mind's sn_search_script_body.
export async function snSearchScriptBody(target, args, signal) {
  const keyword = sanitizeQ(args.keyword);
  if (keyword.length < 2) return { error: "keyword must be at least 2 characters." };
  let types = [];
  if (Array.isArray(args.artifactTypes) && args.artifactTypes.length) types = args.artifactTypes.slice(0, 5);
  else if (args.artifactType) types = [String(args.artifactType)];
  else types = ["script_include", "business_rule", "client_script"];
  const bad = types.find((t) => !ARTIFACT_TABLE_MAP[t]);
  if (bad) return { error: `Unknown artifactType '${bad}'. Valid: ${ARTIFACT_TYPES.join(", ")}` };

  const lowerKw = keyword.toLowerCase();
  const results = [];
  const errors = [];
  for (const t of types) {
    const config = ARTIFACT_TABLE_MAP[t];
    const clauses = config.scriptFields.map((f) => `${f}LIKE${keyword}`);
    let query = clauses.length > 1 ? clauses.join("^OR") : clauses[0];
    if (args.targetTable && config.tableField) query += `^${config.tableField}=${sanitizeQ(args.targetTable)}`;
    if (!args.includeInactive) query += "^active=true";
    const wantFields = [config.nameField, "sys_id", "active", "sys_updated_on", ...config.scriptFields];
    if (config.tableField) wantFields.push(config.tableField);
    const params = new URLSearchParams();
    params.set("sysparm_query", query);
    params.set("sysparm_limit", "5");
    params.set("sysparm_fields", [...new Set(wantFields)].join(","));
    params.set("sysparm_display_value", "false");
    let data;
    try { data = await snFetch(target, `/api/now/table/${config.table}?${params.toString()}`, signal); }
    catch (e) { if (e && e.name === "AbortError") throw e; errors.push({ type: t, error: e.message }); continue; }
    for (const item of (data.result || [])) {
      let snippet = "", matchedField = null;
      for (const sf of config.scriptFields) {
        const lines = String(item[sf] || "").split("\n");
        const i = lines.findIndex((l) => l.toLowerCase().includes(lowerKw));
        if (i >= 0) { snippet = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join("\n"); matchedField = sf; break; }
      }
      if (!snippet) { const fb = String(item[config.scriptFields[0]] || ""); snippet = fb.slice(0, 200) + (fb.length > 200 ? "…" : ""); }
      results.push({
        name: item[config.nameField], type: t, sys_id: item.sys_id, active: item.active,
        targetTable: config.tableField ? item[config.tableField] : null,
        updatedOn: item.sys_updated_on, matchedField,
        matchSnippet: snippet.length > 500 ? snippet.slice(0, 500) + "…" : snippet
      });
    }
  }
  if (!results.length) {
    return { error: `No artifacts found with "${keyword}" in script body. Searched: ${types.join(", ")}.${errors.length ? ` (${errors.length} type(s) errored)` : ""}` };
  }
  return { instance: target.origin, keyword, searched: types, count: results.length, results, errors: errors.length ? errors : undefined };
}

// --- WRITE path ------------------------------------------------------------

// System/read-only columns that must never be written via the API.
const NON_WRITABLE_FIELDS = new Set([
  "sys_id", "sys_created_on", "sys_created_by", "sys_updated_on",
  "sys_updated_by", "sys_mod_count", "sys_tags"
]);

// Write-route memos shared by snWriteRecord and snDeleteRow (see the WRITE routing
// section below): origins that refused a Basic-auth write, and the per-origin count
// of records refused on every path in a row.
const basicWriteDenied = new Set();
const deniedRecordStreak = new Map(); // origin → records refused on EVERY path in a row
// origin|table pairs a table ACL refused on EVERY route (worker lifetime): the next
// write to that table is refused locally with the working alternative instead of
// costing another 403 round trip per row (dev000000 2026-09-04: sys_variable_value).
const aclDeniedTables = new Map(); // origin|table → expiry (ms)
const ACL_MEMO_TTL_MS = 20 * 60 * 1000; // an owner who grants the ACL mid-session is not locked out for the worker's life
function aclDenialRemembered(key) {
  const until = aclDeniedTables.get(key);
  if (!until) return false;
  if (Date.now() > until) { aclDeniedTables.delete(key); return false; }
  return true;
}
export function forgetAclDenials() { aclDeniedTables.clear(); }

// Which credentials a write target carries. "basic" = stored connection (no CSRF
// needed); "session" = signed-in tab cookie + X-UserToken (g_ck); "session-no-token"
// = cookie only — ServiceNow rejects every state-changing request on that path.
export function snAuthPath(target) {
  const h = (target && target.headers) || {};
  if (h.Authorization) return "basic";
  if (h["X-UserToken"]) return "session";
  return "session-no-token";
}
const AUTH_PATH_LABEL = {
  basic: "Basic auth / stored connection",
  session: "signed-in tab session (cookie + X-UserToken)",
  "session-no-token": "signed-in tab session WITHOUT a CSRF token (no g_ck on the active tab)"
};

// The instance's own reason for a 4xx: Table API errors are JSON
// {error:{message,detail}}; some gateways answer with HTML. 2026-09-02: eleven
// sn_update_record 403s in one STRY0000001 run all surfaced as a canned "needs a
// CSRF token" line while the body was never read — the model reconnected, retried
// and re-retried the same write instead of switching route.
export function snErrorDetail(body) {
  const txt = String(body || "").trim();
  if (!txt) return "";
  try {
    const j = JSON.parse(txt);
    const e = j && j.error;
    if (e && typeof e === "object") {
      const parts = [e.message, e.detail].map((s) => String(s || "").trim()).filter(Boolean);
      return [...new Set(parts)].join(": ").slice(0, 300);
    }
    if (typeof e === "string") return e.slice(0, 300);
  } catch {}
  return txt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

// What to do about a denied write, from the instance's reason + the path used.
export function snWriteDenyHint(detail, authPath, table, op = "write") {
  const d = String(detail || "");
  if (/acl|security constraint|insufficient|not authorized|unauthorized|role/i.test(d)) {
    return `ACL: the account has no ${op} access to ${table || "this table"} through the API on this path — repeating this call fails the same way.`;
  }
  if (authPath === "session-no-token") {
    return "The active tab exposed no g_ck — navigate the ACTIVE tab to any classic page on this instance (e.g. /wf_activity_list.do), then retry once.";
  }
  if (/not authenticated|csrf|user token|session/i.test(d)) {
    return authPath === "basic"
      ? "The stored username/password was rejected for writes (Basic auth can be restricted to read-only on customer instances) — the signed-in tab session is the other route."
      : "The tab's CSRF token was rejected — reload the ServiceNow tab (it re-issues g_ck) and retry once.";
  }
  return authPath === "basic"
    ? "Basic auth was refused for this write; the signed-in tab session is the other route."
    : "The signed-in session was refused for this write.";
}

// PATCH/POST a record. Like snFetch but for state-changing requests. For session-cookie
// auth (logged-in tab) ServiceNow requires an X-UserToken (CSRF) header — the caller
// injects it into target.headers before calling. Basic-auth connections need no token.
// A 401/403 throws an Error tagged snDenied=true with the instance's own reason
// (status, authPath, snDetail, table) so snWriteRecord can switch route.
async function snWrite(target, pathAndQuery, body, signal, method = "PATCH") {
  const origin = target.origin;
  const excluded = snExcludedError(origin);
  if (excluded) throw excluded;
  let res;
  try {
    const init = {
      method,
      credentials: target.credentials || "omit",
      headers: { Accept: "application/json", ...(target.headers || {}) },
      signal
    };
    if (method !== "DELETE") { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    res = await fetch(origin + pathAndQuery, init);
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new Error(`Could not reach ServiceNow at ${origin}. Check the instance URL and that it's reachable.`);
  }
  if (res.status === 401 || res.status === 403) {
    const detail = snErrorDetail(await res.text().catch(() => ""));
    const authPath = snAuthPath(target);
    const table = (/\/api\/now\/table\/([^/?]+)/.exec(pathAndQuery) || [])[1] || "";
    const op = method === "POST" ? "create" : (method === "DELETE" ? "delete" : "write");
    const e = new Error(
      `ServiceNow denied the ${op.toUpperCase()} (HTTP ${res.status} via ${AUTH_PATH_LABEL[authPath]}) at ${origin}` +
      `${detail ? ` — instance says: "${detail}"` : " — no reason given in the response body"}. ` +
      snWriteDenyHint(detail, authPath, table, op)
    );
    e.snDenied = true; e.status = res.status; e.authPath = authPath; e.snDetail = detail; e.table = table;
    throw e;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ServiceNow HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  if (method === "DELETE" || res.status === 204) return {}; // DELETE answers 204 No Content
  return res.json();
}

// Update ONE record by sys_id on a specific table. The only mutating SN MCP tool.
// Requires an explicit sys_id (never updates by query — avoids mass/wrong writes)
// and a non-empty `fields` object { fieldName: value, ... }. System/read-only
// columns are dropped. Returns the updated record (stored + display values).
export async function snUpdateRecord(target, args, signal) {
  const table = String(args.table || "").trim();
  const sysId = String(args.sysId || "").trim();
  if (!table) return { error: "sn_update_record requires a table." };
  if (!/^[0-9a-f]{32}$/i.test(sysId)) {
    return { error: "sn_update_record requires a valid sys_id (32 hex chars). Find it first with sn_query_table / sn_query_record." };
  }
  const fields = args.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) {
    return { error: "sn_update_record requires a non-empty 'fields' object, e.g. { description: 'new text' }." };
  }

  const body = {};
  const skipped = [];
  for (const [k, v] of Object.entries(fields)) {
    if (NON_WRITABLE_FIELDS.has(k)) { skipped.push(k); continue; }
    body[k] = v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : v);
  }
  if (!Object.keys(body).length) {
    return { error: `No writable fields provided. Skipped system/read-only fields: ${skipped.join(", ") || "(none)"}.` };
  }

  const params = new URLSearchParams();
  params.set("sysparm_display_value", "all");
  params.set("sysparm_exclude_reference_link", "true");
  // Default: inputs are STORED values (sys_ids for references, stored values for
  // choices) — exactly what sn_query_* returns, so the agent can round-trip safely.
  // Opt in to inputDisplayValue when passing human labels ("In Progress") instead.
  if (args.inputDisplayValue === true) params.set("sysparm_input_display_value", "true");

  const data = await snWrite(target, `/api/now/table/${encodeURIComponent(table)}/${sysId}?${params.toString()}`, body, signal);
  const rec = data && data.result ? flattenRow(data.result) : null;
  if (!rec) return { error: `Update to ${table}/${sysId} returned no record (it may not exist).` };
  return {
    instance: target.origin,
    table,
    sys_id: sysId,
    number: rec.number ? dispOf(rec.number) : undefined,
    updatedFields: Object.keys(body),
    skippedFields: skipped.length ? skipped : undefined,
    record: rec
  };
}

// Create ONE record on a specific table (POST Table API). The second mutating SN
// MCP tool (approval-gated like sn_update_record; stripped in read-only mode).
// Built for AUTHORING-table workflows — e.g. the legacy-workflow ordered insert plan
// (wf_workflow_version → wf_activity → sys_variable_value → wf_transition) — but any
// table the credentials can insert into is accepted; ACLs remain the real gate.
// Requires a non-empty `fields` object; system/read-only columns are dropped.
// Returns the new record's sys_id + display value so the caller can verify + chain.
export async function snCreateRecord(target, args, signal) {
  const table = String(args.table || "").trim();
  if (!table) return { error: "sn_create_record requires a table." };
  const fields = args.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) {
    return { error: "sn_create_record requires a non-empty 'fields' object, e.g. { name: 'My workflow', table: 'incident' }." };
  }

  const body = {};
  const skipped = [];
  for (const [k, v] of Object.entries(fields)) {
    if (NON_WRITABLE_FIELDS.has(k)) { skipped.push(k); continue; }
    body[k] = v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : v);
  }
  if (!Object.keys(body).length) {
    return { error: `No writable fields provided. Skipped system/read-only fields: ${skipped.join(", ") || "(none)"}.` };
  }

  const params = new URLSearchParams();
  params.set("sysparm_display_value", "all");
  params.set("sysparm_exclude_reference_link", "true");
  if (args.inputDisplayValue === true) params.set("sysparm_input_display_value", "true");

  const data = await snWrite(target, `/api/now/table/${encodeURIComponent(table)}?${params.toString()}`, body, signal, "POST");
  const rec = data && data.result ? flattenRow(data.result) : null;
  if (!rec) return { error: `Insert into ${table} returned no record — verify with sn_query_table before assuming it was created.` };
  const sysId = storedOfValue(rec.sys_id);
  return {
    instance: target.origin,
    table,
    sys_id: sysId,
    display: dispOf(rec.name) || dispOf(rec.number) || dispOf(rec.short_description) || undefined,
    setFields: Object.keys(body),
    skippedFields: skipped.length ? skipped : undefined,
    record: rec,
    note: "Server-side business rules may have auto-created related records (e.g. a blank-workflow wf_workflow_version insert scaffolds wf_workflow + Begin/End + conditions) — query them back rather than inserting them yourself."
  };
}

// --- WRITE routing: stored connection, then the signed-in tab ---------------
//
// A customer instance can refuse Basic-auth writes that its UI allows (a customer
// customer-dev, 2026-09-02: every PATCH on sys_variable_value came back 403 through
// the stored connection — with `instance:` forced, too). The owner IS signed in
// on a tab of that instance, and that session (cookie + g_ck) is the route the
// UI itself uses. So a write tries the resolved target first and, on a 401/403,
// the tab session (or the reverse once the instance has refused Basic auth).
// Origins that refused a Basic write are remembered for this worker's lifetime
// so later writes don't pay a failed request per record.
// (basicWriteDenied / deniedRecordStreak are declared next to NON_WRITABLE_FIELDS so
// snDeleteRow, defined earlier in the file, never reads them in the temporal dead zone.)

// One route that works for any signed-in user, named so the model stops
// re-issuing the API call. sys_variable_value rows are workflow-activity inputs:
// the direct form renders Value read-only on customer instances (customer-dev
// 2026-09-02), so the ONLY working path is the activity's own form — which
// sn_wf_activity_set drives end to end. Point there, not at DOM tools.
function snWriteUiRoute(origin, table, args, aclDenied) {
  const sysId = String((args && args.sysId) || "").trim();
  if (table === "sys_variable_value" && aclDenied) {
    // A table ACL refuses the row on every auth path; the activity's own form is under the same
    // ACL (its Value renders read-only), so do not send the model there (2026-09-03 dev000000:
    // two 403s, a dead form route, then the Fix Script — the Fix Script should be step 2).
    return "NEXT (do NOT retry this write and do NOT try sn_wf_activity_set — the same ACL makes the form read-only): call sn_wf_fix_script {workflow_version:\"<the draft's wf_workflow_version sys_id>\", set:[{activity:\"<activity name or sys_id>\", inputs:{<element>:\"<value>\"}}, …]} with EVERY activity input of this version in ONE script, then run it (one 'Run Fix Script' click) and read the values back with sn_wf_activity_vars. Publish afterwards with sn_wf_publish {workflow_version} (pre-flight + publish + cache flush; it falls back to a publish Fix Script by itself) — never hunt for the editor's Publish menu (it is canvas-rendered, not DOM).";
  }
  if (table === "sys_variable_value") {
    return "NEXT: call sn_wf_activity_set {activity_sys_id:\"<this row's document_key>\", inputs:{<element>:\"<value>\"}} — it edits the input through the activity's own form (wf_activity.do, the form the Workflow Editor dialog opens) in your signed-in tab and verifies the stored value. Do not open sys_variable_value.do (its Value field renders read-only). To remove an activity: sn_wf_delete_activity. If those are refused too: sn_wf_fix_script (a Fix Script edits these rows server-side without table ACLs; one 'Run Fix Script' click).";
  }
  if (table === "wf_activity" || table === "wf_transition" || table === "wf_condition") {
    return `UI route: the Workflow Editor at ${origin}/workflow_ide.do?sysparm_sys_id=<workflow_version>&sysparm_use_polaris=false (checked-out draft only). To remove a node with its transitions re-pointed, use sn_wf_delete_activity instead of hand-driving the canvas; if that is refused too, sn_wf_fix_script generates a Fix Script that does it server-side.`;
  }
  return `UI route: navigate the tab to ${origin}/${table}.do?sys_id=${sysId || "<sys_id>"}&sysparm_stack=no, edit the field(s) with the page tools and click Update — the form's own save runs under the UI's ACLs.`;
}

// Run sn_update_record / sn_create_record with route fallback.
//   name    — "sn_update_record" | "sn_create_record"
//   target  — the dispatcher's resolved target (Basic or bare session)
//   session — { origin, getToken: async () => g_ck } for a signed-in tab on the
//             SAME origin, or null when there is no such tab
export async function snWriteRecord(name, target, args, signal, session) {
  const origin = target.origin;
  // wf_workflow_version guard (2026-09-04): the version's `condition` is an encoded
  // query — JavaScript there can never match, so it is refused BEFORE the request;
  // a shell created without condition_type is skipped by the engine, so it gets
  // run_match; and a raw published=true is told what it does not do (cache flush).
  const wfNotes = [];
  if (String((args && args.table) || "").trim() === "wf_workflow_version" && args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)) {
    const f = args.fields;
    if (f.condition !== undefined && wfConditionLooksLikeScript(f.condition)) {
      return { error: `Refused before sending: wf_workflow_version.condition ${JSON.stringify(String(f.condition)).slice(0, 120)} is JavaScript. ${WF_CONDITION_FIX}` };
    }
    if (name === "sn_create_record" && !String(f.condition_type || "").trim()) {
      f.condition_type = "run_match";
      wfNotes.push("condition_type was missing — set to run_match (the engine skips versions with an empty condition_type; the 2026-09-04 build published with it empty and never started).");
    }
    if (String(f.published) === "true") {
      wfNotes.push("A Table-API publish does NOT reach the running engine until the workflow caches are flushed (2026-09-04: six test inserts started nothing until /cache.do was loaded). Use sn_wf_publish {workflow_version} instead — it pre-flights the graph, publishes, reads back and flushes — or at least navigate the signed-in tab to " + origin + "/cache.do BEFORE the first test record.");
    }
  }
  const run = async (t) => {
    const out = name === "sn_create_record" ? await snCreateRecord(t, args, signal) : await snUpdateRecord(t, args, signal);
    if (out && !out.error && wfNotes.length) out.note = (out.note ? out.note + " " : "") + wfNotes.join(" ");
    return out;
  };
  const isBasic = !!(target.headers && target.headers.Authorization);
  const haveSession = !!(session && session.origin === origin);
  const sessionTarget = async () => {
    if (!haveSession) return target; // bare-session target from the dispatcher (no tab id) — as-is
    let tok = ""; try { tok = await session.getToken(); } catch {}
    return { origin, credentials: "include", headers: tok ? { "X-UserToken": tok } : {} };
  };
  const memoTable = String((args && args.table) || "").trim();
  if (memoTable && aclDenialRemembered(origin + "|" + memoTable)) {
    return { error: `Not sent: ${origin} already refused ${memoTable} writes on every auth path this session with an ACL reason — this row would fail the same way. ` + snWriteUiRoute(origin, memoTable, args, true), denied_on: [{ path: "remembered", status: 403, instance_says: "ACL (earlier refusal this session)" }] };
  }

  const routes = [];
  if (isBasic) routes.push("basic");
  if (haveSession || !isBasic) routes.push("session");
  if (routes.length > 1 && basicWriteDenied.has(origin)) routes.reverse();

  const denied = [];
  for (const route of routes) {
    const t = route === "basic" ? target : await sessionTarget();
    try {
      const out = await run(t);
      if (out && !out.error) {
        out.auth_path = route === "basic" ? "basic (stored connection)" : "signed-in tab session";
        if (denied.length) out.note = `First attempt was refused (${denied[0].message}) — succeeded via the ${out.auth_path}; later writes to this instance try that route first.`;
        deniedRecordStreak.delete(origin);
        if (route === "basic") basicWriteDenied.delete(origin);
      }
      return out;
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      if (!e || !e.snDenied) return { error: e && e.message || String(e) };
      denied.push(e);
      if (route === "basic") basicWriteDenied.add(origin);
    }
  }

  const streak = (deniedRecordStreak.get(origin) || 0) + 1;
  deniedRecordStreak.set(origin, streak);
  const table = String((args && args.table) || denied[0].table || "").trim();
  const parts = denied.map((e) => e.message);
  if (!haveSession && isBasic) {
    parts.push(`No signed-in tab on ${origin} to fall back to — open (or switch the active tab to) a logged-in page on that instance and retry ONCE; the write then goes through your session.`);
  } else {
    parts.push("Both routes were tried. Do NOT retry this write — it fails the same way.");
  }
  if (streak >= 2) parts.push(`STOP: ${streak} records refused on every route this run — stop issuing writes and report the blocker (the instance's reason above) to the owner.`);
  const aclDenied = denied.every((e) => /acl|security constraint|insufficient|not authorized|unauthorized/i.test(String(e.snDetail || "")));
  // Only when BOTH routes were actually tried: a Basic-only refusal with no tab to
  // fall back to must stay retryable once a signed-in tab exists.
  if (aclDenied && table && (haveSession || !isBasic)) aclDeniedTables.set(origin + "|" + table, Date.now() + ACL_MEMO_TTL_MS);
  parts.push(snWriteUiRoute(origin, table, args, aclDenied));
  return { error: parts.join(" "), denied_on: denied.map((e) => ({ path: e.authPath, status: e.status, instance_says: e.snDetail || "" })) };
}

// Stored value of a possibly-{value,display} flattened cell.
function storedOfValue(v) { return v && typeof v === "object" ? (v.value ?? "") : (v ?? ""); }

// ---- RCA: what changed before it broke ---------------------------------------
// sys_update_xml = every tracked customization change (business rules, client
// scripts, forms, ACLs, properties, …) with who/when — the highest-yield RCA
// query. Optional record_sys_id adds sys_audit rows (field-level data changes on
// ONE record). Read-only.
export async function snRecentChanges(target, args, signal) {
  const hours = clampLimit(args.hours, 24, 24 * 30);
  const limit = clampLimit(args.limit, 20, 50);
  const clauses = [];
  if (args.since) clauses.push(`sys_updated_on>=${sanitizeQ(args.since)}`);
  else clauses.push(`sys_updated_onRELATIVEGE@hour@ago@${hours}`);
  if (args.user) clauses.push(`sys_updated_by=${sanitizeQ(args.user)}`);
  if (args.name_contains) clauses.push(`nameLIKE${sanitizeQ(args.name_contains)}`);
  const q = clauses.join("^") + "^ORDERBYDESCsys_updated_on";
  const out = await snQueryTable(target, {
    table: "sys_update_xml",
    query: q,
    fields: "name,type,target_name,action,sys_updated_by,sys_updated_on,update_set",
    limit
  }, signal);
  const changes = out.records || [];

  let fieldAudit;
  if (/^[0-9a-f]{32}$/i.test(String(args.record_sys_id || ""))) {
    const a = await snQueryTable(target, {
      table: "sys_audit",
      query: `documentkey=${String(args.record_sys_id).toLowerCase()}^ORDERBYDESCsys_created_on`,
      fields: "tablename,fieldname,oldvalue,newvalue,user,sys_created_on",
      limit
    }, signal);
    fieldAudit = a.records || [];
  }

  return {
    instance: target.origin,
    window: args.since ? `since ${args.since}` : `last ${hours}h`,
    count: changes.length,
    customization_changes: changes,
    field_audit: fieldAudit,
    note: "customization_changes = sys_update_xml (code/config changes: scripts, rules, forms). Correlate sys_updated_on with when the problem started — a change just before the first failure is the prime suspect. field_audit (only when record_sys_id given) = sys_audit field-level value changes on that record. For server errors also query table syslog (levelIN0,1^sys_created_onRELATIVEGE@hour@ago@" + hours + ")."
  };
}

// ---- Cross-instance diff: "works in dev, broken in test" ----------------------
// Fetch the same record from TWO connected instances (by sys_id, or by exact
// name) and return only the fields whose STORED values differ. Volatile system
// fields are reported separately so real config drift isn't buried. Read-only.
const VOLATILE_FIELDS = new Set(["sys_updated_on", "sys_updated_by", "sys_mod_count", "sys_created_on", "sys_created_by", "sys_id"]);
const storedOf = (v) => (v && typeof v === "object" ? (v.value ?? "") : (v ?? ""));

export async function snCompareRecord(targetA, targetB, args, signal) {
  const table = String(args.table || "").trim();
  if (!table) return { error: "sn_compare_record requires a table (e.g. sys_script, sys_properties)." };
  let query;
  if (/^[0-9a-f]{32}$/i.test(String(args.sysId || ""))) query = `sys_id=${String(args.sysId).toLowerCase()}`;
  else if (String(args.name || "").trim()) query = `name=${sanitizeQ(args.name)}`;
  else return { error: "sn_compare_record needs a sysId (32-hex) or an exact name to identify the record." };

  const fetchOne = async (target) => {
    const out = await snQueryTable(target, { table, query, fields: args.fields, limit: 1 }, signal);
    return (out.records && out.records[0]) || null;
  };
  const [recA, recB] = [await fetchOne(targetA), await fetchOne(targetB)];
  if (!recA && !recB) return { error: `No record matched ${query} on either instance (${targetA.origin}, ${targetB.origin}). Check the table and identifier.` };
  if (!recA || !recB) {
    return {
      table, query,
      instance_a: targetA.origin, instance_b: targetB.origin,
      missing_on: !recA ? targetA.origin : targetB.origin,
      found_record: (recA || recB),
      note: "The record exists on only ONE instance — that itself may be the root cause (never migrated, or deleted)."
    };
  }

  const keys = [...new Set([...Object.keys(recA), ...Object.keys(recB)])].sort();
  const differences = [], volatile = [];
  let identical = 0;
  for (const k of keys) {
    const a = storedOf(recA[k]), b = storedOf(recB[k]);
    if (String(a) === String(b)) { identical++; continue; }
    const d = { field: k, a: String(a).slice(0, 2000), b: String(b).slice(0, 2000) };
    (VOLATILE_FIELDS.has(k) ? volatile : differences).push(d);
  }
  return {
    table, query,
    instance_a: targetA.origin, instance_b: targetB.origin,
    sys_id_a: storedOf(recA.sys_id), sys_id_b: storedOf(recB.sys_id),
    identical_fields: identical,
    differences,
    volatile_differences: volatile.length ? volatile : undefined,
    note: differences.length
      ? "differences = fields whose STORED values drift between the instances (a=first instance, b=second). volatile_differences (timestamps/audit fields) are expected to differ."
      : "No functional drift — all non-volatile stored values match between the two instances."
  };
}
