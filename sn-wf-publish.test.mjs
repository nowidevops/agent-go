// sn-wf-publish.test.mjs — sn_wf_publish + the 2026-09-04 write guards.
//
// dev000000, "Incident Caller Email and Child Incident" (export 08:04): the graph
// was right, sn_update_record published=true read back true, and the engine
// started NO context for six test incidents until /cache.do was loaded. Along the
// way the version carried condition_type="" and a JavaScript string in the
// conditions field, sys_variable_value was re-tried after an ACL 403, and eight
// test incidents + five Fix Scripts were left behind unlisted. These tests pin
// the one-call publish (pre-flight → condition sanity → PATCH → read-back →
// cache flush, Fix-Script fallback), the wf_workflow_version write guard, the
// ACL-table memo, and the publish block of sn_wf_fix_script.
// Run: node sn-wf-publish.test.mjs   Author: iDevOpsLLC
import {
  snWorkflowPublish, snWorkflowFixScript, snWriteRecord, buildWfFixScript, buildWfPublishFixScript,
  wfConditionLooksLikeScript, wfGraphPreflight, forgetAclDenials, WF_CACHE_TABLES
} from "./sn-tools.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };

const ORIGIN = "https://dev000000.service-now.com";
const BASIC = () => ({ origin: ORIGIN, headers: { Authorization: "Basic xyz" }, credentials: "omit" });
const VER = "f386d93a9303031021aaf1d8dd03d6d6";
const WF = "7f86d93a9303031021aaf1d8dd03d6d9";
const BEGIN = "3786d93a9303031021aaf1d8dd03d6dc", END = "ff86d93a9303031021aaf1d8dd03d6df";
const IF = "02a6dd3a9303031021aaf1d8dd03d656", MAIL = "8aa6dd3a9303031021aaf1d8dd03d661", WAIT = "42a6dd3a9303031021aaf1d8dd03d66a", CHILD = "0aa6dd3a9303031021aaf1d8dd03d672";
const ACL = { error: { message: "Operation Failed", detail: "ACL Exception Update Failed due to security constraints" }, status: "failure" };

// ---- an in-memory instance ---------------------------------------------------
let db, calls, plan;
function resetDb(over = {}) {
  db = {
    wf_workflow_version: {
      [VER]: { sys_id: VER, name: "Incident Caller Email and Child Incident", workflow: WF, table: "incident", published: "false", validated: "false", checked_out: "true", checked_out_by: "6816f79cc0a8016401c5a33be04be441", condition: "", condition_type: "", active: "true" },
      ...(over.wf_workflow_version || {})
    },
    wf_activity: over.wf_activity || {
      [BEGIN]: { sys_id: BEGIN, name: "Begin", activity_definition: "dBegin", "activity_definition.begin": "true", "activity_definition.end": "false", workflow_version: VER },
      [END]: { sys_id: END, name: "End", activity_definition: "dEnd", "activity_definition.begin": "false", "activity_definition.end": "true", workflow_version: VER },
      [IF]: { sys_id: IF, name: "Is New Incident?", activity_definition: "dIf", workflow_version: VER },
      [MAIL]: { sys_id: MAIL, name: "Send Email to Caller", activity_definition: "dNotif", workflow_version: VER },
      [WAIT]: { sys_id: WAIT, name: "Wait 30 Minutes", activity_definition: "dTimer", workflow_version: VER },
      [CHILD]: { sys_id: CHILD, name: "Create Child Incident", activity_definition: "dRun", workflow_version: VER }
    },
    wf_condition: over.wf_condition || {
      cBegin: { sys_id: "cBegin", activity: BEGIN, name: "Always", "activity.workflow_version": VER },
      cIfYes: { sys_id: "cIfYes", activity: IF, name: "Yes", "activity.workflow_version": VER },
      cIfNo: { sys_id: "cIfNo", activity: IF, name: "No", "activity.workflow_version": VER },
      cMail: { sys_id: "cMail", activity: MAIL, name: "Always", "activity.workflow_version": VER },
      cWait: { sys_id: "cWait", activity: WAIT, name: "Complete", "activity.workflow_version": VER },
      cChild: { sys_id: "cChild", activity: CHILD, name: "Always", "activity.workflow_version": VER }
    },
    wf_transition: over.wf_transition || {
      t1: { sys_id: "t1", from: BEGIN, to: IF, condition: "cBegin", "from.workflow_version": VER },
      t2: { sys_id: "t2", from: IF, to: MAIL, condition: "cIfYes", "from.workflow_version": VER },
      t3: { sys_id: "t3", from: IF, to: END, condition: "cIfNo", "from.workflow_version": VER },
      t4: { sys_id: "t4", from: MAIL, to: WAIT, condition: "cMail", "from.workflow_version": VER },
      t5: { sys_id: "t5", from: WAIT, to: CHILD, condition: "cWait", "from.workflow_version": VER },
      t6: { sys_id: "t6", from: CHILD, to: END, condition: "cChild", "from.workflow_version": VER }
    },
    sys_script_fix: {},
    sys_variable_value: {},
    wf_activity_variable: {}
  };
  calls = [];
  plan = { write: {}, readBackPublished: null };
  forgetAclDenials();
}
function q(table, query) {
  const rows = Object.values(db[table] || {});
  return rows.filter((r) => query.split("^").every((clause) => {
    if (!clause || /^ORDERBY/.test(clause)) return true;
    let m;
    if ((m = /^(.+?)!=(.*)$/.exec(clause))) return String(r[m[1]] || "") !== m[2];
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
  const p = plan.write[table + ":" + path] || plan.write[path];
  if (p) return { ok: p.status < 400, status: p.status, json: async () => p.body, text: async () => JSON.stringify(p.body) };
  if (method === "PATCH") {
    const body = init.body ? JSON.parse(init.body) : {};
    Object.assign(db[table][sysId], body);
    if (plan.readBackPublished != null && table === "wf_workflow_version") db[table][sysId].published = plan.readBackPublished; // silently ignored publish
    return { ok: true, status: 200, json: async () => ({ result: db[table][sysId] }), text: async () => "" };
  }
  if (method === "POST") { const b = JSON.parse(init.body); const id = "new" + Object.keys(db[table]).length; db[table][id] = { sys_id: id, ...b }; return { ok: true, status: 201, json: async () => ({ result: db[table][id] }), text: async () => "" }; }
  return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
};
const session = () => ({ origin: ORIGIN, getToken: async () => "g_ck_1" });
const cacheOk = () => { const log = []; return { log, async flush() { log.push("flush"); return { ok: true, via: "cache.do", page: "Clear Cache Servlet Memory" }; } }; };

// =============================================================================
// 1. pure helpers
// =============================================================================
ok("condition: encoded queries are not scripts", !wfConditionLooksLikeScript("sys_mod_count=0") && !wfConditionLooksLikeScript("priority=1^category=network") && !wfConditionLooksLikeScript("") && !wfConditionLooksLikeScript("javascript:gs.getUserID()"));
ok("condition: the 2026-09-04 string is flagged", wfConditionLooksLikeScript("current.operation() == 'insert'"));
ok("condition: answer=/return/gs. flagged", wfConditionLooksLikeScript("answer = true;") && wfConditionLooksLikeScript("return current.priority == 1") && wfConditionLooksLikeScript("gs.nil(current.caller_id)"));
// Master-mind 2026-09-04 B1: `!=` is an encoded-query operator and a clause VALUE may start with javascript:
ok("condition B1: != is an encoded-query operator, not JavaScript", !wfConditionLooksLikeScript("state!=6") && !wfConditionLooksLikeScript("active=true^priority!=5") && !wfConditionLooksLikeScript("workflow=abc^published=true^sys_id!=f386d93a9303031021aaf1d8dd03d6d6"));
ok("condition B1: a mid-query javascript: clause value is allowed", !wfConditionLooksLikeScript("active=true^sys_created_on>=javascript:gs.beginningOfToday()") && !wfConditionLooksLikeScript("caller_id=javascript:gs.getUserID()^ORopened_by=javascript:gs.getUserID()"));
ok("condition B1: current./gs. outside a javascript: value is still script", wfConditionLooksLikeScript("current.priority>3") && wfConditionLooksLikeScript("priority=gs.getProperty('x')") && wfConditionLooksLikeScript("current.operation() == 'insert'"));
// Master-mind 2026-09-04 pass 2 (C1/C2/C7): word operators + multi-value javascript:, `return` as a value, bracket notation
ok("condition B1b: word-operator / multi-value javascript: are encoded queries",
  !wfConditionLooksLikeScript("sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()") &&
  !wfConditionLooksLikeScript("opened_atBETWEENjavascript:gs.dateGenerate('2026-01-01','00:00:00')@javascript:gs.dateGenerate('2026-01-31','23:59:59')") &&
  !wfConditionLooksLikeScript("assignment_groupDYNAMICjavascript:gs.getUser().getMyGroups()") &&
  !wfConditionLooksLikeScript("sys_idINjavascript:new global.ArrayUtil().convertArray(current.variables.requested_for.getMyGroups())") &&
  !wfConditionLooksLikeScript("opened_atONLast 7 days@javascript:gs.beginningOfLastNDaysAgo(7)@javascript:gs.endOfYesterday()"));
ok("condition B1b: `return` / `answer` as VALUES are not script",
  !wfConditionLooksLikeScript("u_request_type=return") && !wfConditionLooksLikeScript("state=return^active=true") && !wfConditionLooksLikeScript("short_descriptionLIKElaptop return request") && !wfConditionLooksLikeScript("answer=yes"));
ok("condition B1b: script still caught",
  wfConditionLooksLikeScript("current.x=javascript:gs.getUserID()") && wfConditionLooksLikeScript("current['priority']>3") && wfConditionLooksLikeScript("caller_id=gs['getUserID']()") &&
  wfConditionLooksLikeScript("return true") && wfConditionLooksLikeScript("(function(){ var gr = new GlideRecord('incident'); gr.query(); })()") && wfConditionLooksLikeScript("answer = true;") &&
  wfConditionLooksLikeScript("current.operation() == 'insert'") && wfConditionLooksLikeScript("priority=gs.getProperty('x')"));

let scr = buildWfPublishFixScript({ versionId: VER, title: "WF X - publish", conditionType: "run_match", condition: "" });
ok("publish script: sets condition_type + published + clears checkout", /setValue\('condition_type', "run_match"\)/.test(scr) && /setValue\('published', true\)/.test(scr) && /setValue\('checked_out_by', ''\)/.test(scr));
ok("publish script: flushes every engine-cached table via GlideCacheManager.flushTable", WF_CACHE_TABLES.every((t) => scr.includes(t)) && /GlideCacheManager\.flushTable\(flushTables\[fi\]\)/.test(scr));
ok("publish script: ES5 IIFE (no const/let)", /^\(function\(\) \{/m.test(scr) && !/\b(const|let)\b/.test(scr));
ok("publish script: condition '' is written explicitly", /setValue\('condition', ""\)/.test(scr));
ok("publish script: update() result is checked before claiming published", /if \(!ver\.update\(\)\)/.test(scr) && /NOT published/.test(scr));
ok("publish script: the cache flush runs ONLY in the published branch", scr.indexOf("if (publishedOk) {") > 0 && scr.indexOf("flushTable") > scr.indexOf("if (publishedOk) {") && /cache NOT flushed/.test(scr));
scr = buildWfPublishFixScript({ versionId: VER, conditionType: "run_match" });
ok("publish script: omitted condition leaves the stored one alone", !/setValue\('condition',/.test(scr));

scr = buildWfFixScript({ versionId: VER, title: "STRY1 inputs + publish", set: [{ activity: "Wait 30 Minutes", inputs: { timer_type: "user_specified", duration: "1970-01-01 00:30:00" } }], publish: { conditionType: "run_match" } });
const iSet = scr.indexOf("setInput(act1"), iPub = scr.indexOf("setValue('published', true)");
ok("fix script publish:true — publish block AFTER the input edits, gated on failed === 0", iSet > 0 && iPub > iSet && /if \(failed === 0\) \{/.test(scr) && /NOT published/.test(scr));
scr = buildWfFixScript({ versionId: VER, title: "x", set: [{ activity: "A", inputs: { script: "var a = 1;" } }] });
ok("fix script without publish — no publish block, editor note kept", !/setValue\('published'/.test(scr) && /Publish the draft from the Workflow Editor/.test(scr));

// graph pre-flight
resetDb();
let pre = wfGraphPreflight(Object.values(db.wf_activity), Object.values(db.wf_condition), Object.values(db.wf_transition));
ok("preflight: the live graph is clean", pre.blockers.length === 0 && pre.begin === BEGIN && pre.ends.includes(END), JSON.stringify(pre.blockers));
pre = wfGraphPreflight(Object.values(db.wf_activity), Object.values(db.wf_condition), Object.values(db.wf_transition).map((t) => t.sys_id === "t5" ? { ...t, to: "" } : t));
ok("preflight: empty-to transition + the orphaned node are blockers", pre.blockers.some((b) => /EMPTY "to"/.test(b) && /t5/.test(b)) && pre.blockers.some((b) => /Create Child Incident.*UNREACHABLE/.test(b)));
pre = wfGraphPreflight(Object.values(db.wf_activity), Object.values(db.wf_condition), Object.values(db.wf_transition).filter((t) => t.sys_id !== "t6"));
ok("preflight: a node with no outgoing transition is a DEAD END blocker", pre.blockers.some((b) => /Create Child Incident.*DEAD END/.test(b)) && pre.warnings.some((w) => /Create Child Incident\.Always/.test(w)));
pre = wfGraphPreflight(Object.values(db.wf_activity), Object.values(db.wf_condition), Object.values(db.wf_transition).filter((t) => t.sys_id !== "t3"));
ok("preflight: an unwired If.No is a warning, not a blocker", pre.blockers.length === 0 && pre.warnings.some((w) => /Is New Incident\?\.No/.test(w)));

// =============================================================================
// 2. sn_wf_publish end to end
// =============================================================================
resetDb();
let cache = cacheOk();
let out = await snWorkflowPublish(BASIC(), { workflow_version: "nope" }, null, { session: session(), cache });
ok("publish: bad sys_id rejected without a request", /workflow_version/.test(out.error) && calls.length === 0);

resetDb(); cache = cacheOk();
out = await snWorkflowPublish(BASIC(), { workflow_version: VER }, null, { session: session(), cache });
const patch = calls.find((c) => c.method === "PATCH" && c.table === "wf_workflow_version");
ok("publish: happy path — PATCH published/validated/checkout + condition_type default", out.ok === true && out.published === true && patch && patch.body.published === "true" && patch.body.validated === "true" && patch.body.checked_out_by === "" && patch.body.condition_type === "run_match", JSON.stringify(out).slice(0, 300));
ok("publish: read back from the instance, not from the PATCH echo", out.condition_type === "run_match" && out.checked_out_by === "" && db.wf_workflow_version[VER].published === "true");
resetDb(); plan.write["wf_workflow_version:basic"] = null;
{ // B6: the instance keeps condition_type empty (a BR reset it) — the result must say so, not echo the intent
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => { const r = await realFetch(u, i); if (i && i.method === "PATCH") db.wf_workflow_version[VER].condition_type = ""; return r; };
  out = await snWorkflowPublish(BASIC(), { workflow_version: VER }, null, { session: session(), cache: cacheOk() });
  globalThis.fetch = realFetch;
  ok("publish B6: a stored condition_type that reads back EMPTY is reported verbatim with a re-publish note", out.condition_type === "" && (out.notes || []).some((n) => /read back as ""/.test(n) && /publish:true/.test(n)));
}
ok("publish: the cache was flushed through the tab AFTER the read-back", out.cache_flushed === "cache.do" && cache.log.length === 1);
ok("publish: the empty condition_type is called out in notes", (out.notes || []).some((n) => /condition_type was EMPTY/.test(n)));
ok("publish: next step = ONE test record, count 0 ⇒ condition/table mismatch, timer proof = wf_executing", /ONE test record/.test(out.next) && /second identical test record proves nothing/.test(out.next) && /wf_executing/.test(out.next) && /not by sys_trigger/.test(out.next));
ok("publish: no Fix Script was created on the happy path", !Object.keys(db.sys_script_fix).length);

// JavaScript in the conditions field — the 2026-09-04 trap
resetDb({ wf_workflow_version: { [VER]: { sys_id: VER, name: "N", workflow: WF, table: "incident", published: "false", checked_out_by: "u", condition: "current.operation() == 'insert'", condition_type: "run_match" } } });
cache = cacheOk();
out = await snWorkflowPublish(BASIC(), { workflow_version: VER }, null, { session: session(), cache });
ok("publish: a stored JavaScript condition is refused before any write", /is JavaScript/.test(out.error) && /ENCODED QUERY/.test(out.error) && /If activity/.test(out.error) && !calls.some((c) => c.method === "PATCH") && cache.log.length === 0);
ok("publish: the refusal leads with the NON-destructive exit (Fix Script publish) before any replace advice", out.error.indexOf("publish:true") > 0 && out.error.indexOf("publish:true") < out.error.indexOf("To REPLACE") && /does not re-check/.test(out.error) && /only when it is wrong/.test(out.error));
resetDb({ wf_workflow_version: { [VER]: { sys_id: VER, name: "N", workflow: WF, table: "incident", published: "false", checked_out_by: "u", condition: "sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()", condition_type: "run_match" } } });
out = await snWorkflowPublish(BASIC(), { workflow_version: VER }, null, { session: session(), cache: cacheOk() });
ok("publish: a condition-builder date filter with javascript: values PUBLISHES with the condition untouched (pass-2 C1)", out.ok === true && out.condition === "sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()");
resetDb({ wf_workflow_version: { [VER]: { sys_id: VER, name: "N", workflow: WF, table: "incident", published: "false", checked_out_by: "u", condition: "", condition_type: "banana" } } });
out = await snWorkflowPublish(BASIC(), { workflow_version: VER }, null, { session: session(), cache: cacheOk() });
ok("publish: a stored garbage condition_type is refused with the replace hint (no PATCH)", /not a wf_workflow_version choice/.test(out.error) && /STORED value/.test(out.error) && !calls.some((c) => c.method === "PATCH"));
out = await snWorkflowPublish(BASIC(), { workflow_version: VER, condition_type: "run_match" }, null, { session: session(), cache: cacheOk() });
ok("publish: passing condition_type:run_match replaces it", out.ok === true && out.condition_type === "run_match");
out = await snWorkflowPublish(BASIC(), { workflow_version: VER, condition: "sys_mod_count=0" }, null, { session: session(), cache });
ok("publish: passing an encoded query replaces it and publishes", out.ok === true && out.condition === "sys_mod_count=0" && db.wf_workflow_version[VER].condition === "sys_mod_count=0");
out = await snWorkflowPublish(BASIC(), { workflow_version: VER, condition: "answer = current.priority == 1;" }, null, { session: session(), cache });
ok("publish: a JavaScript `condition` argument is refused too", /is JavaScript/.test(out.error));

// graph blockers stop the publish
resetDb(); cache = cacheOk();
db.wf_transition.t5.to = "";
out = await snWorkflowPublish(BASIC(), { workflow_version: VER }, null, { session: session(), cache });
ok("publish: blockers ⇒ NOT published, no PATCH, no flush, blockers named", out.ok === false && out.published === false && /EMPTY "to"/.test(out.error) && /UNREACHABLE/.test(out.error) && !calls.some((c) => c.method === "PATCH") && cache.log.length === 0);
out = await snWorkflowPublish(BASIC(), { workflow_version: VER, force: true }, null, { session: session(), cache });
ok("publish: force:true publishes despite blockers (still reported)", out.ok === true && out.preflight.blockers.length === 2);

// refused PATCH ⇒ publish Fix Script with the flush lines
resetDb(); cache = cacheOk();
plan.write["wf_workflow_version:basic"] = { status: 403, body: ACL };
plan.write["wf_workflow_version:session"] = { status: 403, body: ACL };
out = await snWorkflowPublish(BASIC(), { workflow_version: VER }, null, { session: session(), cache });
const fx = Object.values(db.sys_script_fix)[0];
ok("publish: refused on both routes ⇒ publish Fix Script created, run steps returned", out.ok === true && out.published === "pending-fix-script" && out.route === "fix-script" && fx && /GlideCacheManager\.flushTable/.test(fx.script) && /setValue\('published', true\)/.test(fx.script) && /Run Fix Script/.test(out.next) && /ONE test record/.test(out.next), JSON.stringify(out).slice(0, 300));
ok("publish: no tab flush on the Fix-Script route (the script flushes when run)", cache.log.length === 0 && /publish \+ cache flush/.test(fx.name));

// accepted PATCH that reads back false (the 2026-07-30 silent no-op)
resetDb(); cache = cacheOk();
plan.readBackPublished = "false";
out = await snWorkflowPublish(BASIC(), { workflow_version: VER }, null, { session: session(), cache });
ok("publish: PATCH accepted but read back false ⇒ Fix-Script route, reason stated", out.route === "fix-script" && /read back false/.test(out.reason) && Object.keys(db.sys_script_fix).length === 1 && cache.log.length === 0);

// no signed-in tab ⇒ published but the flush is owed, said loudly
resetDb();
out = await snWorkflowPublish(BASIC(), { workflow_version: VER }, null, { session: null, cache: null });
ok("publish: without a tab the result says CACHE NOT FLUSHED and names both ways to do it", out.ok === true && out.cache_flushed === false && (out.notes || []).some((n) => /CACHE NOT FLUSHED/.test(n) && /cache\.do/.test(n) && /publish:true/.test(n)));

// flush that landed on a login page is not a flush
resetDb();
out = await snWorkflowPublish(BASIC(), { workflow_version: VER }, null, { session: session(), cache: { async flush() { return { ok: false, via: "cache.do", error: "cache.do did not render the flush page (login redirect)" }; } } });
ok("publish: a failed cache.do load is reported as not flushed", out.cache_flushed === false && (out.notes || []).some((n) => /login redirect/.test(n)));

// a second published sibling is reported
resetDb({ wf_workflow_version: {
  [VER]: { sys_id: VER, name: "N", workflow: WF, table: "incident", published: "false", checked_out_by: "u", condition: "", condition_type: "run_match" },
  old1: { sys_id: "old1", name: "N", workflow: WF, table: "incident", published: "true", checked_out_by: "", condition: "", condition_type: "run_match" }
} });
out = await snWorkflowPublish(BASIC(), { workflow_version: VER }, null, { session: session(), cache: cacheOk() });
ok("publish: a sibling still published=true is named with the re-publish route", out.ok === true && (out.notes || []).some((n) => /OTHER published version/.test(n) && /old1/.test(n) && /publish:true/.test(n)));

// =============================================================================
// 3. sn_wf_fix_script {publish:true}
// =============================================================================
resetDb();
out = await snWorkflowFixScript(BASIC(), { workflow_version: VER, publish: true, name: "WF N - republish" }, null, { session: session() });
ok("fix script: publish:true alone is a valid change (re-publish + flush)", out.ok === true && out.created === true && out.publishes === true && /flushTable/.test(Object.values(db.sys_script_fix)[0].script));
ok("fix script: publish run steps ask for the read-back then ONE test record", /read back sn_query_table/.test(out.next) && /ONE test record/.test(out.next));
resetDb({ wf_workflow_version: { [VER]: { sys_id: VER, name: "N", workflow: WF, table: "incident", published: "true", checked_out_by: "", condition: "", condition_type: "run_match" } } });
out = await snWorkflowFixScript(BASIC(), { workflow_version: VER, publish: true }, null, { session: session() });
ok("fix script: a PUBLISHED version may be re-published + flushed (no edits)", out.ok === true && out.publishes === true);
out = await snWorkflowFixScript(BASIC(), { workflow_version: VER, publish: true, set: [{ activity: "Begin", inputs: { x: "1" } }] }, null, { session: session() });
ok("fix script: but never EDITED in place", /PUBLISHED version/.test(out.error));
resetDb();
out = await snWorkflowFixScript(BASIC(), { workflow_version: VER, publish: { condition: "current.operation() == 'insert'" } }, null, { session: session() });
ok("fix script: publish.condition JavaScript refused", /is JavaScript/.test(out.error));
out = await snWorkflowFixScript(BASIC(), { workflow_version: VER, publish: { condition_type: "NOT A REAL CHOICE!!!" } }, null, { session: session() });
ok("fix script: nested publish.condition_type is validated (pass-2 C5)", /not a wf_workflow_version choice/.test(out.error));
out = await snWorkflowFixScript(BASIC(), { workflow_version: VER, set: [{ activity: "Wait 30 Minutes", inputs: { duration: "1970-01-01 00:30:00" } }] }, null, { session: session() });
ok("fix script: without publish, next step routes to sn_wf_publish (not the editor menu)", out.ok === true && /sn_wf_publish/.test(out.next) && !/Workflow Actions → Publish/.test(out.next));

// =============================================================================
// 4. snWriteRecord guard on wf_workflow_version + ACL memo
// =============================================================================
resetDb();
out = await snWriteRecord("sn_create_record", BASIC(), { table: "wf_workflow_version", fields: { name: "N", table: "incident", published: "false" } }, null, session());
let post = calls.find((c) => c.method === "POST");
ok("guard: shell create without condition_type gets run_match + a note", post.body.condition_type === "run_match" && /condition_type was missing/.test(out.note));
resetDb();
out = await snWriteRecord("sn_create_record", BASIC(), { table: "wf_workflow_version", fields: { name: "N", table: "incident", condition: "current.operation() == 'insert'" } }, null, session());
ok("guard: JavaScript condition refused BEFORE the request", /is JavaScript/.test(out.error) && calls.length === 0);
resetDb();
out = await snWriteRecord("sn_update_record", BASIC(), { table: "wf_workflow_version", sysId: VER, fields: { published: "true", validated: "true" } }, null, session());
ok("guard: a raw published=true PATCH succeeds but is told about the cache + sn_wf_publish", !out.error && /sn_wf_publish/.test(out.note) && /cache\.do/.test(out.note));
resetDb();
out = await snWriteRecord("sn_update_record", BASIC(), { table: "wf_activity", sysId: IF, fields: { name: "Is New Incident?" } }, null, session());
ok("guard: other tables untouched (no note)", !out.error && !out.note, JSON.stringify(out).slice(0, 200));

// ACL memo: the second sys_variable_value row is refused locally
resetDb();
plan.write["sys_variable_value:basic"] = { status: 403, body: ACL };
plan.write["sys_variable_value:session"] = { status: 403, body: ACL };
out = await snWriteRecord("sn_create_record", BASIC(), { table: "sys_variable_value", fields: { document: "wf_activity", document_key: IF, variable: "v1", value: "x" } }, null, session());
const n1 = calls.filter((c) => c.method === "POST").length;
ok("memo: first row tries both routes, names the Fix Script route", /Do NOT retry/.test(out.error) && /sn_wf_fix_script/.test(out.error) && n1 === 2);
out = await snWriteRecord("sn_create_record", BASIC(), { table: "sys_variable_value", fields: { document: "wf_activity", document_key: MAIL, variable: "v2", value: "y" } }, null, session());
ok("memo: second row is refused WITHOUT a request and still routes to sn_wf_fix_script", /Not sent/.test(out.error) && /sn_wf_fix_script/.test(out.error) && calls.filter((c) => c.method === "POST").length === n1 && out.denied_on[0].path === "remembered");
out = await snWriteRecord("sn_create_record", BASIC(), { table: "wf_transition", fields: { from: IF, to: MAIL, condition: "cIfYes" } }, null, session());
ok("memo: other tables on the same instance still write", !out.error && out.sys_id);
resetDb();
plan.write["sys_variable_value:basic"] = { status: 403, body: ACL };
out = await snWriteRecord("sn_create_record", BASIC(), { table: "sys_variable_value", fields: { document: "wf_activity", document_key: IF, variable: "v1", value: "x" } }, null, null);
out = await snWriteRecord("sn_create_record", BASIC(), { table: "sys_variable_value", fields: { document: "wf_activity", document_key: IF, variable: "v1", value: "x" } }, null, null);
ok("memo: a Basic-only refusal with NO tab is not memoised (a tab may unblock it)", calls.filter((c) => c.method === "POST").length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
