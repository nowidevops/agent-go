// navigate-probe.test.mjs — the navigate 404-self-heal probes must be BOUNDED.
//
// Live hang (2026-09-01, a-live-run, excluded-host): navigate to a bare classic
// sys_email.do form never returned. The self-heal's snPageNotFound probe read
// document.body.innerText (a forced synchronous style+layout pass in every
// frame — the raw-HTML email body pinned the renderer) through an un-deadlined
// executeScript({allFrames:true}), and background.js has no per-tool time-box,
// so the whole run parked until the user hit Stop. waitForSnClassicFrame had
// the same hole: its deadline check sat AFTER the await, so one hung injection
// defeated the 6s budget.
//
// These tests pin the invariant: with chrome.scripting.executeScript hanging
// FOREVER, navigate still resolves — bare .do within ~5s (one 4s-raced probe),
// wrapped classic within ~13s (raced frame-wait loop + raced probe) — and a
// probe timeout fails SAFE (ok:true, no page_not_found rewrite).
// Run: node navigate-probe.test.mjs   Author: iDevOpsLLC

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };

const ORIGIN = "https://excluded-host.example.com";

// The mock must exist BEFORE tools.js is evaluated (dynamic import below).
function installChrome({ executeScriptImpl }) {
  const tab = { id: 1, url: ORIGIN + "/x_g_dh6_usbp_pat_policy.do?sys_id=abc", active: true };
  const calls = { injections: 0, updates: [] };
  globalThis.chrome = {
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      update: async (_id, { url }) => { tab.url = url; calls.updates.push(url); return tab; },
      onUpdated: {
        // Fire "complete" almost immediately so waitForLoad never eats its 15s.
        addListener: (fn) => setTimeout(() => fn(1, { status: "complete" }), 10),
        removeListener: () => {}
      }
    },
    scripting: {
      executeScript: (...a) => { calls.injections++; return executeScriptImpl(...a); }
    }
  };
  return calls;
}

const hangForever = () => new Promise(() => {});

console.log("\n1. BARE CLASSIC .do + HUNG INJECTION: navigate resolves ok within ~5s (was: forever)");
{
  const calls = installChrome({ executeScriptImpl: hangForever });
  const { executeTool } = await import("./tools.js");
  const t0 = Date.now();
  const r = await executeTool("navigate", { url: ORIGIN + "/sys_email.do?sys_id=6ddf16bd97cf83109003bffce053af5e&sysparm_view=inbox" }, {});
  const ms = Date.now() - t0;
  ok("resolved at all (the live bug: it never did)", !!r);
  ok("resolved within 6s, not parked (took " + ms + "ms)", ms < 6000, String(ms));
  ok("probe timeout fails SAFE: ok:true, no page_not_found", r && r.ok === true && !r.page_not_found, JSON.stringify(r));
  ok("injection was attempted (probe ran, then was abandoned)", calls.injections >= 1);
  ok("no self-heal rewrite navigation happened", calls.updates.length === 1, JSON.stringify(calls.updates));
}

console.log("\n2. WRAPPED CLASSIC URL + HUNG INJECTION: frame-wait deadline HOLDS (each injection raced)");
{
  installChrome({ executeScriptImpl: hangForever });
  const { executeTool } = await import("./tools.js?v=2");
  const t0 = Date.now();
  const r = await executeTool("navigate", { url: ORIGIN + "/now/nav/ui/classic/params/target/sys_email.do%3Fsys_id%3D6ddf16bd97cf83109003bffce053af5e" }, {});
  const ms = Date.now() - t0;
  ok("resolved at all", !!r);
  ok("resolved within 14s (6s frame-wait + 4s probe + slack), not parked (took " + ms + "ms)", ms < 14000, String(ms));
  ok("fails SAFE: ok:true, no page_not_found", r && r.ok === true && !r.page_not_found, JSON.stringify(r));
}

console.log("\n3. CONTROL — RESPONSIVE PAGE, REAL 404: self-heal still detects and retries via wrapper");
{
  const calls = installChrome({
    executeScriptImpl: async ({ func, args }) => {
      // The frame-wait probe takes args (the .do base); the 404 probe takes none.
      if (args && args.length) return [{ result: true }];
      globalThis.document = { body: { textContent: "The page you are looking for could not be found" } };
      try { return [{ result: func() }]; } finally { delete globalThis.document; }
    }
  });
  const { executeTool } = await import("./tools.js?v=3");
  const r = await executeTool("navigate", { url: ORIGIN + "/sys_email_list.do" }, {});
  ok("404 detected through textContent probe (page_not_found or wrapper retry ran)",
    (r && r.page_not_found === true) || calls.updates.length === 2, JSON.stringify(r));
  ok("wrapper retry navigation was attempted", calls.updates.length === 2, JSON.stringify(calls.updates));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
