// sn-ledger.js — instance write ledger + test-record guard for the run loop.
// Pure module (no chrome.*), imported by background.js so it is unit-testable
// (master-mind 2026-09-04: both must-fix defects of the 0.2.5 review sat in this
// code while it lived un-exported inside the service worker). Author: iDevOpsLLC

// ---------------------------------------------------------------------------
// INSTANCE WRITE LEDGER + TEST-RECORD GUARD (dev000000 legacy-workflow run,
// 2026-09-04 08:04 export): the build was right, but the model created EIGHT
// test incidents (INC0010001-08, + child INC0010009) and five helper Fix
// Scripts while hunting a publish that never reached the engine — each test
// record after the first one proved nothing new (same graph, same stale cache),
// and the final answer listed none of them. Code now (a) remembers every record
// a run creates on the instance, (b) refuses the third test record after two
// that started no workflow context unless a cache flush / publish happened in
// between, and (c) makes the answer list what it left behind and ask about
// cleanup instead of deleting anything itself.
// ---------------------------------------------------------------------------
export const SN_TEST_RECORD_RE = /\b(test|uat|smoke|dummy|sample|probe)\b/i;
export const SN_AUTHORING_TABLE_RE = /^(wf_|sys_|var_|sc_cat_item|item_option|question|catalog_)/; // u_* custom tables are workflow TARGETS, so their test records count
// Only PERSISTENT evidence counts (master-mind 2026-09-04 B2): wf_executing rows vanish
// when the activity completes and wf_log fills only for activities that log, so a
// healthy fast workflow probes as count 0 there and would be marked dead.
export const WF_PROBE_TABLES = new Set(["wf_context", "wf_history"]);

// A create on a data table whose text says "test" — the record a run makes to
// see whether the thing it built fires. Authoring/system tables never count.
export function snTestRecordOf(args) {
  const table = String((args && args.table) || "").trim().toLowerCase();
  if (!table || SN_AUTHORING_TABLE_RE.test(table)) return null;
  const f = (args && args.fields && typeof args.fields === "object") ? args.fields : {};
  const text = ["short_description", "name", "description", "title", "subject"].map((k) => f[k]).filter((v) => typeof v === "string").join(" ");
  return SN_TEST_RECORD_RE.test(text) ? { table } : null;
}

// Refuse (or annotate) a test-record create that cannot tell the run anything new.
export function snTestRecordGate(ctx, args) {
  const tests = ctx._snTestRecords || [];
  const dead = tests.filter((t) => t.noStart);
  const list = (arr) => arr.map((t) => t.display || t.sys_id).join(", ");
  if (dead.length >= 3) {
    return { refuse: `TEST-RECORD GUARD: ${tests.length} test records this run (${list(tests)}) and the workflow started for NONE of the last ${dead.length} (wf_context / wf_history count 0) even after a cache flush. A fourth proves nothing. The version's trigger does not match the record: read wf_workflow_version {sys_id:<version>} fields table, condition, condition_type, published, checked_out_by and compare them with the record you insert (table, and the encoded query in condition — JavaScript there never matches); check wf_workflow.active and that exactly ONE version is published. Fix THAT, then sn_wf_publish, then one test record. If nothing is wrong there, STOP and report the blocker with these facts — do not create more test records.` };
  }
  if (dead.length >= 2 && !ctx._wfFlushedSinceTest) {
    return { refuse: `TEST-RECORD GUARD: the workflow did not start for the last ${dead.length} test records (${list(dead)}) and nothing that could change that has happened since. Another test record proves nothing. Do this instead: sn_wf_publish {workflow_version:"<the version>"} — it pre-flights the graph, sets condition_type, publishes, reads back, and FLUSHES the workflow caches (the step a Table-API publish skips; 2026-09-04: six dead test incidents, then cache.do, then the very next one ran). After that, ONE test record.` };
  }
  if (dead.length >= 1 && !ctx._wfFlushedSinceTest) {
    return { note: `TEST-RECORD NOTE: the previous test record (${list(dead)}) started no workflow context and nothing changed since (no sn_wf_publish / cache flush / Fix Script run). If this one starts nothing either, do NOT create a third — call sn_wf_publish {workflow_version} (publish + cache flush), then test once.` };
  }
  return null;
}

// Post-result bookkeeping: created records, test-record outcomes, flush events.
export function snNoteWrite(ctx, name, args, result) {
  if (!result || result.error) return;
  const created = (rec) => { (ctx._snCreated = ctx._snCreated || []).push(rec); };
  if (name === "sn_create_record" && result.sys_id) {
    const rec = { table: String((args && args.table) || ""), sys_id: String(result.sys_id), display: result.display ? String(result.display) : "" };
    created(rec);
    if (snTestRecordOf(args)) { (ctx._snTestRecords = ctx._snTestRecords || []).push({ ...rec, noStart: false }); ctx._wfFlushedSinceTest = false; }
    return;
  }
  if (name === "sn_wf_fix_script" && result.created && result.sys_id) {
    created({ table: "sys_script_fix", sys_id: String(result.sys_id), display: String(result.name || ""), helper: true });
    if (result.publishes) ctx._wfFlushedSinceTest = true; // the script flushes when it runs
    return;
  }
  if (name === "sn_wf_publish") {
    if (result.fix_script && result.fix_script.sys_id) created({ table: "sys_script_fix", sys_id: String(result.fix_script.sys_id), display: String(result.fix_script.name || ""), helper: true });
    if (result.cache_flushed || result.route === "fix-script") ctx._wfFlushedSinceTest = true;
    return;
  }
  if (name === "navigate" && /\/cache\.do(\?|$)/i.test(String((args && args.url) || ""))) { ctx._wfFlushedSinceTest = true; return; }
  if (/^sn_query_(table|session)$/.test(name) && args && WF_PROBE_TABLES.has(String(args.table || "").toLowerCase())) {
    const tests = ctx._snTestRecords || [];
    if (!tests.length) return;
    const q = String(args.query || "");
    // Attribute the probe to the test record it NAMES; with several test records and no
    // sys_id in the query, blame nobody (the newest-record fallback marked the wrong one).
    const named = tests.find((t) => t.sys_id && q.includes(t.sys_id));
    // A query naming some OTHER record (id= / sys_id= / context.id= / document_key=) says nothing
    // about our single test record; a scope such as workflow_version=<id> still does.
    const namesForeignId = !named && /(^|\^)(id|sys_id|context\.id|context|document_key)=[0-9a-f]{32}\b/i.test(q);
    const hit = named || (tests.length === 1 && !namesForeignId ? tests[0] : null);
    if (!hit) return;
    const n = Number(result.count);
    if (n > 0) { hit.noStart = false; hit.started = true; }          // any persistent-table positive proves it ran
    else if (n === 0 && !hit.started) hit.noStart = true;             // a later count-0 (e.g. wf_history filter) never undoes proof of a start
  }
}

// Which created records the final answer fails to mention (by number/name or sys_id).
// Authoring rows (wf_activity, wf_transition, sys_variable_value, …) are the build
// itself and are named by the workflow, not per sys_id — they stay in the audit line
// but never trigger the nudge. Test records and helper Fix Scripts must be named.
export function snUnmentionedCreates(ctx, text) {
  const txt = String(text || "");
  return (ctx._snCreated || []).filter((r) => (r.helper || !SN_AUTHORING_TABLE_RE.test(String(r.table || "").toLowerCase())) && !(r.display && txt.includes(r.display)) && !txt.includes(r.sys_id));
}

export function emitSnWriteAudit(ctx, post) {
  const all = ctx._snCreated || [];
  if (!all.length) return;
  const byTable = {};
  for (const r of all) (byTable[r.table] = byTable[r.table] || []).push(r.display ? `${r.display} (${r.sys_id})` : r.sys_id);
  const tests = (ctx._snTestRecords || []).map((t) => `${t.display || t.sys_id}${t.noStart ? " — no workflow context" : ""}`);
  const helpers = all.filter((r) => r.helper).map((r) => `${r.display || "Fix Script"} (${r.sys_id})`);
  post({ type: "tool", name: "servicenow_write_audit", args: { records_created: all.length } });
  post({ type: "tool_result", name: "servicenow_write_audit", result: {
    ok: true,
    records_created: byTable,
    test_records: tests.length ? tests : undefined,
    helper_fix_scripts: helpers.length ? helpers : undefined,
    note: "Ground truth: records this run created on the instance. Test records and helper Fix Scripts stay there until the owner closes/deletes them."
  }});
}
