// sn-session-queries.test.mjs — the session-authenticated ServiceNow query tools
// (sn_query_session, sn_check_duplicate): the "why does this always take forever?"
// fix (2026-09-01, live customer rm_story run).
//
// Both tools ran their Table API fetches under executeScript({allFrames:true}), so
// EVERY frame holding a g_ck fired the SAME request(s) and the result-picker threw
// all but one away; executeScript resolves only once every frame settles, so a
// single lookup cost N duplicate queries and waited on the slowest. sn_query_session
// also hardcoded sysparm_display_value=all (a record read + ACL pass per reference),
// and sn_check_duplicate awaited its two lookups in SERIES. Neither had a timeout on
// the fetch or the injection, so a slow instance parked the run until the user hit Stop.
//
// Fixing the timeouts exposed a second, worse bug in sn_check_duplicate: a lookup
// that FAILED returned no rows, which fed straight into the duplicate verdict — so
// a 401 or a timeout reported "No existing record matched — safe to create". On the
// write path that is how you get the fifth copy of a Business Rule. It now fails
// closed: absence is only claimed when the lookup actually succeeded.
//
// These tests pin the invariants that make all of that impossible: one frame is
// picked and queried ONCE, lookups run concurrently, the request shape defaults to
// the cheap mode, every wait is bounded and degrades the way frame discovery does,
// and no failed check ever reads as "safe to create".
// Run: node sn-session-queries.test.mjs   Author: iDevOpsLLC
import { snQuerySession, snCheckDuplicate } from "./editors.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };

const ORIGIN = "https://customer.example.com";

function install({ frames, fetchImpl, probeHangs = false }) {
  const calls = { probes: 0, queries: 0, urls: [], queryFrameIds: [] };
  globalThis.chrome = {
    scripting: {
      executeScript: async ({ target, func, args }) => {
        if (func.name === "pageSnHasGck") {
          calls.probes++;
          if (probeHangs) return new Promise(() => {});
          return frames.map((f) => ({ frameId: f.frameId, result: { hasGck: !!f.gck, origin: ORIGIN } }));
        }
        calls.queries++;
        calls.queryFrameIds.push(target.frameIds ? target.frameIds[0] : "ALL_FRAMES");
        const frame = frames.find((f) => f.frameId === target.frameIds[0]);
        globalThis.window = { g_ck: frame && frame.gck ? "tok" : null, location: { origin: ORIGIN } };
        globalThis.fetch = (url, init) => { calls.urls.push(url); return fetchImpl(url, init); };
        return [{ frameId: target.frameIds[0], result: await func(...args) }];
      }
    }
  };
  return calls;
}

const jsonOk = (rows) => async () => ({ ok: true, status: 200, json: async () => ({ result: rows }) });
const timeoutFetch = async () => { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; };

console.log("\n1. FAN-OUT: 4 frames hold g_ck -> exactly ONE Table API request, from the top frame");
{
  const frames = [{ frameId: 0, gck: 1 }, { frameId: 3, gck: 1 }, { frameId: 7, gck: 1 }, { frameId: 9, gck: 1 }];
  const calls = install({ frames, fetchImpl: jsonOk([{ number: "STRY0000001", short_description: "x" }]) });
  const r = await snQuerySession(1, { table: "rm_story", query: "number=STRY0000001", fields: "number,short_description" });
  ok("one query issued (was 4 before the fix)", calls.queries === 1, "got " + calls.queries);
  ok("issued from the TOP document (frameId 0)", calls.queryFrameIds[0] === 0, "got " + calls.queryFrameIds[0]);
  ok("probe ran once, no network", calls.probes === 1, "got " + calls.probes);
  ok("record returned", r.ok === true && r.count === 1 && r.records[0].number === "STRY0000001", JSON.stringify(r));
  ok("query_ms surfaced", typeof r.query_ms === "number", JSON.stringify(r.query_ms));
}

console.log("\n2. FRAME PICK: only gsft_main (frameId 7) is logged in -> query goes there");
{
  const frames = [{ frameId: 0, gck: 0 }, { frameId: 7, gck: 1 }, { frameId: 11, gck: 0 }];
  const calls = install({ frames, fetchImpl: jsonOk([{ sys_id: "abc" }]) });
  const r = await snQuerySession(1, { table: "sys_script" });
  ok("picked frame 7", calls.queryFrameIds[0] === 7, "got " + calls.queryFrameIds[0]);
  ok("succeeded", r.ok === true, JSON.stringify(r));
}

console.log("\n3. NO SESSION: no frame has g_ck -> actionable error, zero queries");
{
  const frames = [{ frameId: 0, gck: 0 }, { frameId: 2, gck: 0 }];
  const calls = install({ frames, fetchImpl: jsonOk([]) });
  const r = await snQuerySession(1, { table: "rm_story" });
  ok("no Table API request attempted", calls.queries === 0, "got " + calls.queries);
  ok("kept the original guidance message", /No ServiceNow UI session \(g_ck\)/.test(r.error || ""), r.error);
}

console.log("\n4. REQUEST SHAPE: display_value default + override + bogus fallback");
{
  const frames = [{ frameId: 0, gck: 1 }];
  let calls = install({ frames, fetchImpl: jsonOk([{ number: "N" }]) });
  const r = await snQuerySession(1, { table: "rm_story" });
  ok("defaults to display_value=true (was hardcoded 'all')", /sysparm_display_value=true/.test(calls.urls[0]), calls.urls[0]);
  ok("never emits display_value=all by default", !/display_value=all/.test(calls.urls[0]));
  ok("echoes the mode used", r.display_value === "true", r.display_value);

  calls = install({ frames, fetchImpl: jsonOk([{ number: "N" }]) });
  await snQuerySession(1, { table: "rm_story", display_value: "false" });
  ok("honours display_value=false (raw sys_ids, fastest)", /sysparm_display_value=false/.test(calls.urls[0]), calls.urls[0]);

  calls = install({ frames, fetchImpl: jsonOk([{ number: "N" }]) });
  await snQuerySession(1, { table: "rm_story", display_value: "; drop" });
  ok("bogus mode falls back to true (nothing smuggled into the query string)", /sysparm_display_value=true/.test(calls.urls[0]), calls.urls[0]);
}

console.log("\n5. FLATTEN PARITY: display_value=all shape still flattens to display strings");
{
  const frames = [{ frameId: 0, gck: 1 }];
  install({ frames, fetchImpl: jsonOk([{ assignment_group: { value: "sysid123", display_value: "ESSET Team" }, number: "STRY1" }]) });
  const r = await snQuerySession(1, { table: "rm_story", display_value: "all" });
  ok("reference flattened to its label", r.records[0].assignment_group === "ESSET Team", JSON.stringify(r.records[0]));
}

console.log("\n6. TIMEOUT: a slow instance fails fast with instance-is-slow guidance (no hang)");
{
  const frames = [{ frameId: 0, gck: 1 }];
  install({ frames, fetchImpl: timeoutFetch });
  const t0 = Date.now();
  const r = await snQuerySession(1, { table: "rm_story" });
  ok("returned an error rather than hanging", !!r.error, JSON.stringify(r));
  ok("labelled a TIMEOUT", /TIMEOUT after 25s/.test(r.error || ""), r.error);
  ok("tells the model NOT to rewrite its arguments", /do NOT rewrite the arguments/i.test(r.error || ""), r.error);
  ok("suggests the faster display_value", /display_value/.test(r.error || ""), r.error);
  ok("returned promptly", Date.now() - t0 < 2000, (Date.now() - t0) + "ms");
}

console.log("\n7. HTTP error hints preserved (regression guard on the 400/403 self-correction text)");
{
  const frames = [{ frameId: 0, gck: 1 }];
  install({ frames, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Invalid table sc_cat_item_variable" } }) }) });
  const r = await snQuerySession(1, { table: "sc_cat_item_variable" });
  ok("surfaces SN's own message", /Invalid table/.test(r.error || ""), r.error);
  ok("keeps the alias hint", /item_option_new/.test(r.error || ""), r.error);
}
{
  const frames = [{ frameId: 0, gck: 1 }];
  install({ frames, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "Field(s) present in the query do not have permission to be read" } }) }) });
  const r = await snQuerySession(1, { table: "item_option_new", query: "questionLIKEStart Date" });
  ok("403 explained as a bad FIELD NAME, not ACLs", /DOES NOT EXIST/.test(r.error || ""), r.error);
  ok("gives the question_text hint", /question_text/.test(r.error || ""), r.error);
}

console.log("\n8. STALLED PROBE: degrades to the top frame instead of hanging (house pattern)");
{
  // The top frame DOES hold the session, so the degrade should still deliver the record.
  const frames = [{ frameId: 0, gck: 1 }];
  const calls = install({ frames, fetchImpl: jsonOk([{ number: "STRY0000001" }]), probeHangs: true });
  const t0 = Date.now();
  const r = await snQuerySession(1, { table: "rm_story" });
  const ms = Date.now() - t0;
  ok("bounded near the 10s probe deadline (not forever)", ms >= 9500 && ms < 13000, ms + "ms");
  ok("degraded to frame 0 and still queried", calls.queries === 1 && calls.queryFrameIds[0] === 0, JSON.stringify(calls.queryFrameIds));
  ok("returned the record", r.ok === true && r.records[0].number === "STRY0000001", JSON.stringify(r));
}

console.log("\n9. STALLED PROBE on a NON-ServiceNow tab -> no-session message, not a misleading one");
{
  const frames = [{ frameId: 0, gck: 0 }];
  install({ frames, fetchImpl: jsonOk([]), probeHangs: true });
  const r = await snQuerySession(1, { table: "rm_story" });
  ok("says there is no UI session", /No ServiceNow UI session \(g_ck\)/.test(r.error || ""), r.error);
  ok("does NOT claim the session 'disappeared'", !/disappeared/.test(r.error || ""), r.error);
}

console.log("\n10. sn_check_duplicate FAN-OUT: 4 frames -> ONE injection, both lookups concurrent");
{
  const frames = [{ frameId: 0, gck: 1 }, { frameId: 3, gck: 1 }, { frameId: 7, gck: 1 }, { frameId: 9, gck: 1 }];
  let inflight = 0, maxInflight = 0;
  const calls = install({
    frames,
    fetchImpl: async () => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((res) => setTimeout(res, 40));
      inflight--;
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
  });
  const r = await snCheckDuplicate(1, { table: "sys_script", name: "My Rule", sysId: "abc123" });
  ok("one injection, not four", calls.queries === 1, "got " + calls.queries);
  ok("two Table API requests (name + sys_id), not eight", calls.urls.length === 2, "got " + calls.urls.length);
  ok("they ran CONCURRENTLY, not in series", maxInflight === 2, "max in flight " + maxInflight);
  ok("clean check reports safe to create", r.ok === true && r.duplicate === false && /safe to create/.test(r.summary), JSON.stringify(r));
}

console.log("\n11. sn_check_duplicate FAILS CLOSED: a timed-out lookup must NOT read as 'safe to create'");
{
  const frames = [{ frameId: 0, gck: 1 }];
  install({ frames, fetchImpl: timeoutFetch });
  const r = await snCheckDuplicate(1, { table: "sys_script", name: "My Rule" });
  ok("not ok", r.ok === false, JSON.stringify(r));
  ok("duplicate is UNKNOWN (null), never false", r.duplicate === null, JSON.stringify(r.duplicate));
  ok("never says 'safe to create'", !/safe to create/.test(JSON.stringify(r)), JSON.stringify(r));
  ok("says INCONCLUSIVE", /INCONCLUSIVE/.test(r.error || ""), r.error);
  ok("forbids creating the record", /do NOT create/i.test(r.error || ""), r.error);
  ok("names the timeout as the cause", /TIMEOUT/.test(r.error || ""), r.error);
}

console.log("\n12. sn_check_duplicate FAILS CLOSED on an HTTP error too (pre-existing hole)");
{
  const frames = [{ frameId: 0, gck: 1 }];
  install({ frames, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  const r = await snCheckDuplicate(1, { table: "sys_script", name: "My Rule" });
  ok("401 on the name lookup is inconclusive, not 'safe'", r.ok === false && r.inconclusive === true, JSON.stringify(r));
  ok("surfaces the HTTP status", /HTTP 401/.test(r.error || ""), r.error);
}

console.log("\n13. sn_check_duplicate: a FOUND duplicate stays conclusive even if the other lookup failed");
{
  const frames = [{ frameId: 0, gck: 1 }];
  install({
    frames,
    fetchImpl: async (url) => /sysparm_query=name/.test(url)
      ? { ok: true, status: 200, json: async () => ({ result: [{ sys_id: "dupe1", name: "My Rule" }] }) }
      : { ok: false, status: 500, json: async () => ({}) }
  });
  const r = await snCheckDuplicate(1, { table: "sys_script", name: "My Rule", sysId: "abc123" });
  ok("reports the duplicate", r.ok === true && r.duplicate === true, JSON.stringify(r));
  ok("tells the agent not to create", /Do NOT create a new record/.test(r.summary || ""), r.summary);
  ok("still discloses the failed lookup", /by sys_id/.test(r.summary || ""), r.summary);
}

console.log("\n14. sn_check_duplicate: no session -> fail closed, zero requests");
{
  const frames = [{ frameId: 0, gck: 0 }, { frameId: 4, gck: 0 }];
  const calls = install({ frames, fetchImpl: jsonOk([]) });
  const r = await snCheckDuplicate(1, { table: "sys_script", name: "My Rule" });
  ok("no request attempted", calls.urls.length === 0, "got " + calls.urls.length);
  ok("not ok", r.ok === false, JSON.stringify(r));
  ok("warns against creating before the check runs", /Do NOT create/i.test(r.error || ""), r.error);
}

console.log("\n===== " + pass + " passed, " + fail + " failed =====");
process.exit(fail ? 1 : 0);
