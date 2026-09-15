// sn-write-fallback.test.mjs — write routing for sn_update_record / sn_create_record
// (2026-09-02, STRY0000001 implementation runs a-live-run / a-live-run).
//
// Eleven sn_update_record calls on customer-dev all came back HTTP 403 — through the
// stored connection, and with `instance:` forced. The tool threw the response body
// away and printed a fixed "needs a CSRF token — connect with username/password"
// line, so the owner reconnected and the model retried the identical call, three
// turns running. These tests pin: the instance's own reason is surfaced with the
// auth path used; a refused Basic write falls back to the signed-in tab session
// (cookie + g_ck); once an origin refused Basic auth the session goes first; a
// denial on every route names the UI form route and tells the model not to retry;
// a second refused record says STOP; non-auth errors never trigger a second route.
// Run: node sn-write-fallback.test.mjs   Author: iDevOpsLLC
import { snWriteRecord, snErrorDetail, snWriteDenyHint, snAuthPath, forgetAclDenials } from "./sn-tools.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };

const ORIGIN = "https://customer-dev.example.com";
const OTHER = "https://dev000000.service-now.com";
const BASIC = () => ({ origin: ORIGIN, headers: { Authorization: "Basic xyz" }, credentials: "omit" });
const ROW = "328fd49a1bcbcb10773186eae54bcbc8";
const ARGS = { table: "sys_variable_value", sysId: ROW, fields: { value: "task.short_description = 'Move - Update AD info';" } };
const ACL = { error: { message: "Operation Failed", detail: "ACL Exception Update Failed due to security constraints" }, status: "failure" };
const NOAUTH = { error: { message: "User Not Authenticated", detail: "Required to provide Auth information" }, status: "failure" };
const OKROW = { result: { sys_id: ROW, value: ARGS.fields.value } };

// ---- fetch stub: answer by auth header; record every request ---------------
let calls = [];
let plan = {}; // { basic: {status, body}, session: {...}, "session-no-token": {...} }
globalThis.fetch = async (url, init) => {
  const h = (init && init.headers) || {};
  const path = h.Authorization ? "basic" : (h["X-UserToken"] ? "session" : "session-no-token");
  calls.push({ url: String(url), method: init.method, path, credentials: init.credentials });
  const p = plan[path] || { status: 200, body: OKROW };
  return { ok: p.status < 400, status: p.status, json: async () => p.body, text: async () => JSON.stringify(p.body) };
};
const session = (tok = "g_ck_123") => ({ origin: ORIGIN, getToken: async () => tok });
const reset = (p) => { calls = []; plan = p; forgetAclDenials(); /* 2026-09-04 ACL-table memo is process-wide */ };

// ---- helpers ----------------------------------------------------------------
ok("snErrorDetail joins message + detail", snErrorDetail(JSON.stringify(ACL)) === "Operation Failed: ACL Exception Update Failed due to security constraints");
ok("snErrorDetail dedupes identical message/detail", snErrorDetail(JSON.stringify({ error: { message: "x", detail: "x" } })) === "x");
ok("snErrorDetail strips HTML bodies", snErrorDetail("<html><body><h1>403 Forbidden</h1></body></html>") === "403 Forbidden");
ok("snErrorDetail empty on empty body", snErrorDetail("") === "");
ok("snAuthPath basic", snAuthPath(BASIC()) === "basic");
ok("snAuthPath session", snAuthPath({ headers: { "X-UserToken": "t" } }) === "session");
ok("snAuthPath session-no-token", snAuthPath({ headers: {} }) === "session-no-token");
ok("deny hint: ACL names the table and says repeating fails", /ACL: .*sys_variable_value.*fails the same way/.test(snWriteDenyHint("ACL Exception Update Failed due to security constraints", "basic", "sys_variable_value")));
ok("deny hint: missing g_ck tells the model to open a classic page", /no g_ck.*classic page/i.test(snWriteDenyHint("", "session-no-token", "sys_variable_value")));
ok("deny hint: basic not-authenticated points at the session route", /signed-in tab session/.test(snWriteDenyHint("User Not Authenticated", "basic", "x")));
ok("deny hint: session token rejected says reload", /reload/.test(snWriteDenyHint("User Not Authenticated", "session", "x")));

// ---- 1. Basic refused (403 ACL) → session succeeds ----------------------------
reset({ basic: { status: 403, body: ACL } });
let out = await snWriteRecord("sn_update_record", BASIC(), ARGS, null, session());
ok("fallback: two requests, basic then session", calls.length === 2 && calls[0].path === "basic" && calls[1].path === "session", JSON.stringify(calls.map((c) => c.path)));
ok("fallback: session request carries cookies + g_ck", calls[1].credentials === "include" && calls[1].url.includes(`/api/now/table/sys_variable_value/${ROW}`));
ok("fallback: result is the updated record", out && !out.error && out.sys_id === ROW && out.updatedFields.join() === "value");
ok("fallback: result names the route that worked", out.auth_path === "signed-in tab session");
ok("fallback: note carries the instance's reason for the first refusal", /ACL Exception Update Failed/.test(out.note || "") && /Basic auth \/ stored connection/.test(out.note));

// ---- 2. memo: same origin now tries the session FIRST -------------------------
reset({});
out = await snWriteRecord("sn_update_record", BASIC(), ARGS, null, session());
ok("memo: after a Basic refusal the session route goes first (one request)", calls.length === 1 && calls[0].path === "session", JSON.stringify(calls.map((c) => c.path)));
ok("memo: result still reports the route", out.auth_path === "signed-in tab session" && !out.note);

// ---- 3. memo is per origin -----------------------------------------------------
reset({});
out = await snWriteRecord("sn_update_record", { origin: OTHER, headers: { Authorization: "Basic abc" }, credentials: "omit" }, ARGS, null, { origin: OTHER, getToken: async () => "tok" });
ok("memo: another instance still goes Basic first", calls.length === 1 && calls[0].path === "basic" && out.auth_path === "basic (stored connection)");

// ---- 4. session refused too (ACL on both) → no retry + UI route ------------------
reset({ basic: { status: 403, body: ACL }, session: { status: 403, body: ACL } });
out = await snWriteRecord("sn_update_record", BASIC(), ARGS, null, session());
ok("both refused: both routes were tried", calls.length === 2 && new Set(calls.map((c) => c.path)).size === 2);
ok("both refused: error, not a record", out && out.error && !out.sys_id);
ok("both refused: says do NOT retry", /Do NOT retry this write/.test(out.error));
ok("both refused: surfaces the instance's reason with the path", /HTTP 403 via Basic auth \/ stored connection.*instance says: "Operation Failed: ACL Exception/.test(out.error));
// 2026-09-03: an ACL refusal on EVERY route means the activity form is read-only under the same ACL — the hand-off is the Fix Script, not sn_wf_activity_set (dev000000). 2026-09-04: publish goes through sn_wf_publish.
ok("both refused (ACL): hands off to sn_wf_fix_script, never the form / sn_wf_activity_set", /sn_wf_fix_script \{workflow_version/.test(out.error) && /do NOT try sn_wf_activity_set/.test(out.error) && /sn_wf_publish/.test(out.error));
ok("both refused: structured denied_on for both paths", Array.isArray(out.denied_on) && out.denied_on.length === 2 && out.denied_on.every((d) => d.status === 403 && /ACL/.test(d.instance_says)));
ok("both refused: first record does not say STOP yet", !/STOP:/.test(out.error));

// ---- 5. second refused record on the same origin → STOP ------------------------
reset({ basic: { status: 403, body: ACL }, session: { status: 403, body: ACL } });
out = await snWriteRecord("sn_update_record", BASIC(), { ...ARGS, sysId: "7e8fd49a1bcbcb10773186eae54bcbe8" }, null, session());
ok("streak: second refused record says STOP and report to owner", /STOP: 2 records refused on every route/.test(out.error) && /report the blocker/.test(out.error));

// ---- 6. a success clears the streak --------------------------------------------
reset({ basic: { status: 403, body: ACL } });
out = await snWriteRecord("sn_update_record", BASIC(), ARGS, null, session());
ok("streak: success resets (record returned)", out.sys_id === ROW);
reset({ basic: { status: 403, body: ACL }, session: { status: 403, body: ACL } });
out = await snWriteRecord("sn_update_record", BASIC(), ARGS, null, session());
ok("streak: next refusal counts from 1 again", !/STOP:/.test(out.error));

// ---- 7. no signed-in tab: single route, tells the owner what to open -------------
reset({ basic: { status: 403, body: NOAUTH } });
out = await snWriteRecord("sn_update_record", BASIC(), ARGS, null, null);
ok("no tab: only the Basic request is made", calls.length === 1 && calls[0].path === "basic");
ok("no tab: asks for a logged-in tab on THIS instance, retry once", /No signed-in tab on https:\/\/customer-dev\.example\.com/.test(out.error) && /retry ONCE/.test(out.error));
ok("no tab: Basic not-authenticated hint points at the session route", /signed-in tab session is the other route/.test(out.error));

// ---- 8. tab on a different instance is not a fallback for this origin -------------
reset({ basic: { status: 403, body: ACL } });
out = await snWriteRecord("sn_update_record", BASIC(), ARGS, null, { origin: OTHER, getToken: async () => "tok" });
ok("other-origin tab: not used (one request)", calls.length === 1 && /No signed-in tab on/.test(out.error));

// ---- 9. session without g_ck: header absent, hint says open a classic page -------
reset({ basic: { status: 403, body: ACL }, "session-no-token": { status: 401, body: NOAUTH } });
out = await snWriteRecord("sn_update_record", BASIC(), ARGS, null, session(""));
ok("no g_ck: session attempt made without X-UserToken (memo: session first, then Basic)", calls.length === 2 && calls[0].path === "session-no-token" && calls[1].path === "basic", JSON.stringify(calls.map((c) => c.path)));
ok("no g_ck: error explains the missing token + the fix", /WITHOUT a CSRF token/.test(out.error) && /navigate the ACTIVE tab to any classic page/.test(out.error));

// ---- 10. bare session target (no stored connection) + tab: token injected ---------
reset({});
out = await snWriteRecord("sn_update_record", { origin: ORIGIN, headers: {}, credentials: "include" }, ARGS, null, session());
ok("bare session target: one request with g_ck", calls.length === 1 && calls[0].path === "session" && out.auth_path === "signed-in tab session");

// ---- 11. non-auth errors never trigger the second route ----------------------------
reset({ basic: { status: 400, body: { error: { message: "Invalid table sys_variable_valu" } } } });
out = await snWriteRecord("sn_update_record", { origin: OTHER, headers: { Authorization: "Basic abc" }, credentials: "omit" }, ARGS, null, { origin: OTHER, getToken: async () => "tok" });
ok("400: one request, error passed through", calls.length === 1 && /HTTP 400/.test(out.error) && !/UI route/.test(out.error));
reset({});
out = await snWriteRecord("sn_update_record", BASIC(), { table: "sys_variable_value", sysId: "nope", fields: { value: "x" } }, null, session());
ok("validation error: no request at all", calls.length === 0 && /valid sys_id/.test(out.error));

// ---- 12. create goes through the same routing (fresh origin: Basic first) ---------------
reset({ basic: { status: 403, body: ACL } });
plan.session = { status: 200, body: { result: { sys_id: "aaaa0000aaaa0000aaaa0000aaaa0001", name: "Draft" } } };
const THIRD = "https://dev000000.service-now.com";
out = await snWriteRecord("sn_create_record", { origin: THIRD, headers: { Authorization: "Basic q" }, credentials: "omit" }, { table: "wf_workflow_version", fields: { name: "Draft" } }, null, { origin: THIRD, getToken: async () => "tok" });
ok("create: POST falls back to the session and returns the new sys_id", calls.length === 2 && calls[1].method === "POST" && out.sys_id === "aaaa0000aaaa0000aaaa0000aaaa0001" && out.auth_path === "signed-in tab session", JSON.stringify({ calls: calls.map((c) => c.path), out }));
ok("create: refused CREATE is worded as create", /denied the CREATE/.test(out.note || ""));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
