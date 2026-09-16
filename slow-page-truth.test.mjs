// slow-page-truth.test.mjs — a page the server has not finished SENDING must be
// reported as "still loading", never as "loaded" or "hung".
//
// Live run (2026-09-07 11:30 export, six-instance ServiceNow login fan-out): the
// sub-agent's navpage.do tab was still title-less (no document at all) when
// navigate's 15 s wait ran out, yet navigate answered ok:true. The child then
// re-navigated to the same URL (cancelling the in-flight request and starting the
// slow server over), every read timed out with "hung — reload the tab (F5)", and
// the screenshot never returned.
//
// These tests pin the corrected contract:
//   1. navigate returns {ok:false, still_loading:true} when the budget ends with
//      the tab still "loading" — within the budget, never parked.
//   2. navigate RESUMES a load already in flight for the same URL (no tabs.update).
//   3. a read on a still-loading tab whose injections hang says STILL LOADING and
//      does not tell the model to reload.
//   4. waitForLoad answers true/false: true for a tab already complete (poll path,
//      no onUpdated event ever fires), false at the budget on a loading tab.
//   5. a *.service-now.com instance gets the longer budget.
// Run: node slow-page-truth.test.mjs   Author: iDevOpsLLC

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };
const hangForever = () => new Promise(() => {});

// The mock must exist BEFORE tools.js is evaluated (dynamic import below).
function installChrome({ tab, executeScriptImpl = hangForever, fireComplete = false }) {
  const calls = { updates: [], sends: 0, injections: 0 };
  globalThis.chrome = {
    tabs: {
      query: async () => [tab],
      get: async () => ({ ...tab }),
      update: async (_id, { url }) => { tab.url = url; tab.status = "loading"; calls.updates.push(url); return { ...tab }; },
      sendMessage: async () => { calls.sends++; throw new Error("Could not establish connection. Receiving end does not exist."); },
      onUpdated: {
        addListener: (fn) => { if (fireComplete) setTimeout(() => { tab.status = "complete"; fn(tab.id, { status: "complete" }); }, 200); },
        removeListener: () => {}
      }
    },
    scripting: {
      executeScript: (...a) => { calls.injections++; return executeScriptImpl(...a); }
    }
  };
  return calls;
}

const SN = "https://dev000000.service-now.com";
const tab = { id: 7, url: "about:blank", status: "complete", active: true, windowId: 1 };
installChrome({ tab });
const { executeTool, waitForLoad, loadBudgetMsFor, LOAD_BUDGETS } = await import("./tools.js");
// Shrink the budgets so the suite runs in seconds; the contract is the same.
LOAD_BUDGETS.default = 1200;
LOAD_BUDGETS.servicenow = 2000;
LOAD_BUDGETS.readGrace = 300;

console.log("\n5. BUDGET: a *.service-now.com instance gets the longer wait");
{
  ok("servicenow instance → servicenow budget", loadBudgetMsFor(SN + "/navpage.do") === LOAD_BUDGETS.servicenow);
  ok("other site → default budget", loadBudgetMsFor("https://example.com/") === LOAD_BUDGETS.default);
  ok("garbage → default budget (no throw)", loadBudgetMsFor("not a url") === LOAD_BUDGETS.default);
}

console.log("\n1. NAVIGATE to a server that never answers: {ok:false, still_loading:true}, within the budget (was: ok:true)");
{
  tab.url = "about:blank"; tab.status = "complete";
  const calls = installChrome({ tab });
  const t0 = Date.now();
  const r = await executeTool("navigate", { url: SN + "/navpage.do" }, {});
  const ms = Date.now() - t0;
  ok("navigation was issued once", calls.updates.length === 1, JSON.stringify(calls.updates));
  ok("ok is false", r && r.ok === false, JSON.stringify(r));
  ok("still_loading flag set", r && r.still_loading === true);
  ok("error names the slow server, not a hang", /STILL LOADING/.test(r.error || "") && /not a hung page/.test(r.error || "") && !/F5/.test(r.error || ""), r && r.error);
  ok("error forbids reload and points at re-navigate", /do NOT reload/i.test(r.error || "") && /navigate AGAIN/.test(r.error || ""));
  ok("resolved near the budget, not parked (took " + ms + "ms)", ms >= LOAD_BUDGETS.servicenow - 50 && ms < LOAD_BUDGETS.servicenow + 2500, String(ms)); // +2.5s headroom: Agent Go races a beforeunload neutraliser before the update
}

console.log("\n2. NAVIGATE while the SAME url is already in flight: resumes, no tabs.update, ok once it completes");
{
  tab.url = SN + "/navpage.do"; tab.status = "loading";
  const calls = installChrome({ tab, fireComplete: true });
  const r = await executeTool("navigate", { url: SN + "/navpage.do" }, {});
  ok("no restart of the in-flight request", calls.updates.length === 0, JSON.stringify(calls.updates));
  ok("ok:true once the load completed", r && r.ok === true, JSON.stringify(r));
}

console.log("\n2b. NAVIGATE to a DIFFERENT url while loading still restarts (a real navigation)");
{
  tab.url = SN + "/navpage.do"; tab.status = "loading";
  const calls = installChrome({ tab, fireComplete: true });
  const r = await executeTool("navigate", { url: SN + "/incident_list.do" }, {});
  ok("tabs.update issued for the new url", calls.updates.length === 1 && /incident_list/.test(calls.updates[0]), JSON.stringify(calls.updates));
  ok("ok:true", r && r.ok === true, JSON.stringify(r));
}

console.log("\n3. READ on a still-loading tab with hung injections: STILL LOADING, never 'reload (F5)'");
{
  tab.url = SN + "/navpage.do"; tab.status = "loading";
  installChrome({ tab });
  const t0 = Date.now();
  let msg = "";
  try {
    const r = await executeTool("query_elements", { selector: "button", text: "Log in" }, {});
    msg = (r && r.error) || JSON.stringify(r);
  } catch (e) { msg = e.message; }
  const ms = Date.now() - t0;
  ok("says STILL LOADING", /STILL LOADING/.test(msg), msg);
  ok("does not say hung / reload F5", /not a hung page/.test(msg) && !/F5/.test(msg) && !/did not respond/.test(msg), msg);
  ok("bounded (took " + ms + "ms, two 5s probes + grace)", ms < 16000, String(ms));
}

console.log("\n3b. READ on a COMPLETE tab with hung injections keeps the hung wording (unchanged behavior)");
{
  tab.url = SN + "/navpage.do"; tab.status = "complete";
  installChrome({ tab });
  let msg = "";
  try {
    const r = await executeTool("query_elements", { selector: "button" }, {});
    msg = (r && r.error) || JSON.stringify(r);
  } catch (e) { msg = e.message; }
  ok("hung wording kept for a page that is not loading", /did not respond within/.test(msg) && /F5/.test(msg), msg);
}

console.log("\n4. waitForLoad answers TRUE/FALSE");
{
  tab.status = "complete";
  installChrome({ tab }); // onUpdated never fires — only the poll can answer
  const t0 = Date.now();
  const loaded = await waitForLoad(tab.id, 5000);
  const ms = Date.now() - t0;
  ok("already-complete tab → true via the poll (was: ate the whole budget)", loaded === true);
  ok("answered in ~1.5-2.5s, not at the budget (took " + ms + "ms)", ms >= 1400 && ms < 3000, String(ms));

  tab.status = "loading";
  installChrome({ tab });
  const t1 = Date.now();
  const loaded2 = await waitForLoad(tab.id, 800);
  const ms2 = Date.now() - t1;
  ok("loading tab at the budget → false", loaded2 === false);
  ok("returned at the budget (took " + ms2 + "ms)", ms2 >= 750 && ms2 < 1500, String(ms2));

  tab.status = "loading";
  installChrome({ tab, fireComplete: true });
  const loaded3 = await waitForLoad(tab.id, 5000);
  ok("onUpdated complete → true", loaded3 === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
