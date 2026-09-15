// sn-ledger.test.mjs — instance write ledger + test-record guard (sn-ledger.js).
//
// Master-mind review of Agent Go 0.2.5 (2026-09-04, session 6a9abd05…): both
// must-fix defects lived in this code while it was un-exported inside
// background.js — wf_executing/wf_log probes (transient tables) marked a WORKING
// workflow's test record dead, and a probe naming no sys_id blamed the newest
// record. These tests pin: what counts as a test record (any data table, u_*
// included; authoring tables never), probe attribution (named record only, or
// the single one), persistent-evidence tables only, positive evidence clearing a
// mark, the gate thresholds (note → refuse → refuse outright), flush events
// re-arming the gate, the ledger + nudge inputs, and the audit payload.
// Run: node sn-ledger.test.mjs   Author: iDevOpsLLC
import { snTestRecordOf, snTestRecordGate, snNoteWrite, snUnmentionedCreates, emitSnWriteAudit, WF_PROBE_TABLES } from "./sn-ledger.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };
const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", C = "cccccccccccccccccccccccccccccccc";
const create = (ctx, table, sysId, display, sd = "WF test - caller email") => snNoteWrite(ctx, "sn_create_record", { table, fields: { short_description: sd } }, { sys_id: sysId, display });
const probe = (ctx, table, query, count) => snNoteWrite(ctx, "sn_query_table", { table, query }, { count, records: [] });

// ---- what is a test record ------------------------------------------------------
ok("test record: incident whose short_description says test", !!snTestRecordOf({ table: "incident", fields: { short_description: "WF test 3 - caller email" } }));
ok("test record: u_* custom table counts (workflow targets are any table)", !!snTestRecordOf({ table: "u_equipment_request", fields: { name: "UAT probe 1" } }));
ok("test record: sc_request with 'smoke' in description", !!snTestRecordOf({ table: "sc_request", fields: { description: "smoke run" } }));
ok("not a test record: real incident text", !snTestRecordOf({ table: "incident", fields: { short_description: "Printer on floor 3 jams" } }));
ok("not a test record: authoring tables never count", !snTestRecordOf({ table: "wf_activity", fields: { name: "Test node" } }) && !snTestRecordOf({ table: "sys_script_fix", fields: { name: "WF test publish" } }) && !snTestRecordOf({ table: "sys_variable_value", fields: { value: "test" } }));

// ---- probe tables: persistent evidence only (B2) --------------------------------
ok("probe tables: wf_context + wf_history only — wf_executing/wf_log are transient", WF_PROBE_TABLES.has("wf_context") && WF_PROBE_TABLES.has("wf_history") && !WF_PROBE_TABLES.has("wf_executing") && !WF_PROBE_TABLES.has("wf_log"));

// ---- B2 scenario: a WORKING workflow must not be marked dead ----------------------
let ctx = {};
create(ctx, "incident", A, "INC0010001");
probe(ctx, "wf_context", `id=${A}`, 1);
probe(ctx, "wf_executing", `context.id=${A}`, 0); // already completed — transient table empty
probe(ctx, "wf_log", `context.id=${A}`, 0);
ok("B2: wf_executing/wf_log count 0 after a started context does not mark the record", ctx._snTestRecords[0].noStart === false);
ok("B2: no gate note/refusal for the second test record", snTestRecordGate(ctx, {}) === null);

// ---- B2 scenario: a probe naming no sys_id blames nobody when ≥2 records exist -----
ctx = {};
create(ctx, "incident", A, "INC1"); create(ctx, "incident", B, "INC2");
probe(ctx, "wf_context", "workflow_version=f386d93a9303031021aaf1d8dd03d6d6", 0);
ok("B2: unscoped count-0 probe with two test records marks neither", !ctx._snTestRecords[0].noStart && !ctx._snTestRecords[1].noStart);
ctx = {};
create(ctx, "incident", A, "INC1");
probe(ctx, "wf_context", "workflow_version=f386d93a9303031021aaf1d8dd03d6d6", 0);
ok("B2: unscoped count-0 probe with ONE test record marks that one", ctx._snTestRecords[0].noStart === true);
probe(ctx, "wf_context", `id=${A}`, 1);
ok("B2: positive wf_context evidence naming the record clears the mark", ctx._snTestRecords[0].noStart === false);
probe(ctx, "wf_history", `context.id=${A}^activity.name=Send Email`, 0);
ok("pass-2 C6: a later count-0 wf_history filter never undoes proof of a start (sticky started)", ctx._snTestRecords[0].noStart === false && ctx._snTestRecords[0].started === true);
ctx = {}; create(ctx, "incident", A, "INC1");
probe(ctx, "wf_history", `context.id=${A}`, 2);
ok("pass-2 C6: a wf_history positive also proves the start", ctx._snTestRecords[0].started === true && !ctx._snTestRecords[0].noStart);
ctx = {}; create(ctx, "incident", A, "INC1");
probe(ctx, "wf_context", `id=${C}`, 0);
ok("pass-2: a probe naming a FOREIGN sys_id does not blame the single test record", !ctx._snTestRecords[0].noStart);

// ---- gate thresholds -------------------------------------------------------------
ctx = {};
create(ctx, "incident", A, "INC1"); probe(ctx, "wf_context", `id=${A}`, 0);
let g = snTestRecordGate(ctx, {});
ok("gate: one dead record ⇒ note (not a refusal) naming sn_wf_publish", g && g.note && !g.refuse && /sn_wf_publish/.test(g.note) && /INC1/.test(g.note));
create(ctx, "incident", B, "INC2"); probe(ctx, "wf_history", `context.id=${B}`, 0);
g = snTestRecordGate(ctx, {});
ok("gate: two dead + nothing changed ⇒ REFUSED with the sn_wf_publish exit", g && g.refuse && /sn_wf_publish/.test(g.refuse) && /INC1, INC2/.test(g.refuse));
snNoteWrite(ctx, "sn_wf_publish", { workflow_version: "x" }, { ok: true, published: true, cache_flushed: "cache.do" });
ok("gate: a flushed publish re-arms the gate (third record allowed)", ctx._wfFlushedSinceTest === true && snTestRecordGate(ctx, {}) === null);
create(ctx, "incident", C, "INC3");
ok("gate: creating the third record clears the flush flag again", ctx._wfFlushedSinceTest === false);
probe(ctx, "wf_context", `id=${C}`, 0);
g = snTestRecordGate(ctx, {});
ok("gate: three dead ⇒ refused outright, told to compare version table/condition and STOP", g && g.refuse && /table, condition, condition_type/.test(g.refuse) && /STOP/.test(g.refuse));
snNoteWrite(ctx, "navigate", { url: "https://dev000000.service-now.com/cache.do" }, { ok: true });
g = snTestRecordGate(ctx, {});
ok("gate: three dead stays refused even after a flush (mismatch, not cache)", g && g.refuse);
ctx = {};
ok("gate: never fires on a run without test records", snTestRecordGate(ctx, {}) === null);

// ---- flush events ---------------------------------------------------------------
ctx = {}; create(ctx, "incident", A, "INC1");
snNoteWrite(ctx, "navigate", { url: "https://x.service-now.com/cache.do?x=1" }, { ok: true });
ok("flush: navigate to cache.do counts", ctx._wfFlushedSinceTest === true);
ctx = {}; create(ctx, "incident", A, "INC1");
snNoteWrite(ctx, "sn_wf_publish", {}, { ok: true, published: true, cache_flushed: false });
ok("flush: sn_wf_publish WITHOUT a flush does not count", !ctx._wfFlushedSinceTest);
snNoteWrite(ctx, "sn_wf_publish", {}, { ok: true, published: "pending-fix-script", route: "fix-script", fix_script: { sys_id: "ffffffffffffffffffffffffffffffff", name: "WF x - publish + cache flush" } });
ok("flush: the Fix-Script route counts (hardening B3 acknowledged) and the helper is ledgered", ctx._wfFlushedSinceTest === true && ctx._snCreated.some((r) => r.helper && r.table === "sys_script_fix"));

// ---- ledger + nudge inputs --------------------------------------------------------
ctx = {};
snNoteWrite(ctx, "sn_create_record", { table: "wf_workflow_version", fields: { name: "N" } }, { sys_id: "11111111111111111111111111111111", display: "N" });
snNoteWrite(ctx, "sn_create_record", { table: "wf_transition", fields: { from: "a", to: "b" } }, { sys_id: "22222222222222222222222222222222" });
create(ctx, "incident", A, "INC0010007");
snNoteWrite(ctx, "sn_wf_fix_script", { workflow_version: "x" }, { ok: true, created: true, sys_id: "33333333333333333333333333333333", name: "WF N - set activity inputs", publishes: false });
snNoteWrite(ctx, "sn_create_record", { table: "incident", fields: { short_description: "x" } }, { error: "refused" });
ok("ledger: successes only, helpers flagged", ctx._snCreated.length === 4 && ctx._snCreated.filter((r) => r.helper).length === 1);
let missing = snUnmentionedCreates(ctx, "Built workflow N. Test record INC0010007 started a context.");
ok("nudge: helper Fix Script unnamed ⇒ listed; authoring rows never trigger it", missing.length === 1 && missing[0].table === "sys_script_fix");
missing = snUnmentionedCreates(ctx, "INC0010007 … Fix Script 33333333333333333333333333333333");
ok("nudge: sys_id mention counts", missing.length === 0);
missing = snUnmentionedCreates(ctx, "Done.");
ok("nudge: test record unnamed ⇒ listed", missing.some((r) => r.display === "INC0010007"));

// ---- audit payload --------------------------------------------------------------
const posts = [];
emitSnWriteAudit(ctx, (m) => posts.push(m));
const audit = posts.find((p) => p.type === "tool_result" && p.name === "servicenow_write_audit");
ok("audit: one tool + one tool_result post with records by table, test records, helpers", posts.length === 2 && audit && audit.result.records_created.incident && audit.result.test_records.length === 1 && audit.result.helper_fix_scripts.length === 1);
emitSnWriteAudit({}, (m) => posts.push(m));
ok("audit: silent when nothing was created", posts.length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
