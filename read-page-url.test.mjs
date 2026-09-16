// read-page-url.test.mjs — read_page must read the page it was ASKED for, and must
// never hand back a different page's text as if it were that page.
//
// Live incident: competitive-intel export 2026-09-09 15:51. The model called
//   read_page {"url": ".../northwind-pricing.html", "max_chars": 12000}
//   read_page {"url": ".../northwind-releases.html", ...}
//   read_page {"url": ".../northwind-careers.html", ...}
//   read_page {"url": ".../petrichor-pricing.html", ...}
// read_page had NO url parameter. The arg was accepted and silently dropped, so all
// four read whatever the active tab already showed (northwind-pricing). Call 2 came
// back "unchanged: true, url: northwind-pricing" for a page never opened; calls 3+
// were refused as "ALREADY called with these exact arguments" because the dedupe
// signature ignored read_page's args entirely. The model then INVENTED the three
// pages it could not read — the Petrichor table it produced (Basic 24 / Standard 52 /
// Professional 84) shares not one number with the real page (Free 0 / Growth 19 /
// Scale 45), and its careers list had 10 Austin roles where the page has 8 in
// Boston/Manila, four of them Applied AI.
//
// Contract pinned here:
//   1. read_page accepts `url` and navigates to it before reading.
//   2. a url already on screen is read without a redundant navigation.
//   3. a bad url is rejected, not silently ignored.
//   4. a failed navigation returns read:false and NO page text.
//   5. landing somewhere else discards the text and says so (the fabrication seam).
//   6. no url still reads the active tab, unchanged.
// Run: node read-page-url.test.mjs   Author: iDevOpsLLC

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };

const PRICING = "http://localhost:8898/northwind-pricing.html";
const RELEASES = "http://localhost:8898/northwind-releases.html";

const tab = { id: 7, url: PRICING, status: "complete", active: true, windowId: 1 };
// What each url "serves" when a frame read reaches it.
const PAGES = {
  [PRICING]: { title: "Pricing - Northwind Cloud Ops (demo)", text: "Starter 32 Team 66 Growth 99" },
  [RELEASES]: { title: "Releases - Northwind Cloud Ops (demo)", text: "2026-09-01 Growth tier replaces Business" }
};

// `stickyTab: true` reproduces the original bug shape — the tab never actually moves,
// so a read after a "successful" navigation still returns the OLD page.
function installChrome({ stickyTab = false, navFails = false } = {}) {
  const calls = { updates: [], reads: [] };
  globalThis.chrome = {
    tabs: {
      query: async () => [tab],
      get: async () => ({ ...tab }),
      update: async (_id, { url }) => {
        calls.updates.push(url);
        if (navFails) throw new Error("Cannot navigate to invalid URL");
        if (!stickyTab) tab.url = url;
        tab.status = "complete";
        return { ...tab };
      },
      sendMessage: async (_id, msg) => {
        if (msg && msg.type === "TOOL" && msg.name === "read_page") {
          calls.reads.push(tab.url);
          const p = PAGES[tab.url] || { title: "unknown", text: "" };
          return { title: p.title, url: tab.url, text: p.text };
        }
        return {};
      },
      onUpdated: { addListener: () => {}, removeListener: () => {} }
    },
    // read_page merges frames via executeScript-discovered frame ids; returning just
    // the top frame keeps the mock honest and exercises the same code path.
    scripting: { executeScript: async () => [{ frameId: 0, result: true }] },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, url: tab.url }] },
    runtime: { lastError: null }
  };
  return calls;
}

installChrome();
const { executeTool, sameHttpUrl, LOAD_BUDGETS } = await import("./tools.js");
LOAD_BUDGETS.default = 800;
LOAD_BUDGETS.readGrace = 200;

console.log("\n0. sameHttpUrl: what counts as the same page");
{
  ok("identical urls match", sameHttpUrl(PRICING, PRICING));
  ok("trailing slash ignored", sameHttpUrl("http://h/a/", "http://h/a"));
  ok("fragment ignored", sameHttpUrl("http://h/a#top", "http://h/a"));
  ok("host case ignored", sameHttpUrl("http://HOST/a", "http://host/a"));
  ok("different path does NOT match", !sameHttpUrl(PRICING, RELEASES));
  ok("different query does NOT match", !sameHttpUrl("http://h/a?x=1", "http://h/a?x=2"));
  ok("garbage does not match", !sameHttpUrl("not a url", PRICING));
}

console.log("\n1. read_page {url} navigates there first, then reads THAT page");
{
  tab.url = PRICING;
  const calls = installChrome();
  const r = await executeTool("read_page", { url: RELEASES }, {});
  ok("navigation was issued to the requested url",
    calls.updates.length === 1 && calls.updates[0] === RELEASES, JSON.stringify(calls.updates));
  ok("the read happened on the requested page",
    calls.reads.length === 1 && calls.reads[0] === RELEASES, JSON.stringify(calls.reads));
  ok("text is the requested page's text", /Growth tier replaces Business/.test((r && r.text) || ""), JSON.stringify(r));
  ok("result echoes what was requested", r && r.requested_url === RELEASES, JSON.stringify(r));
  ok("no error", r && !r.error, r && r.error);
}

console.log("\n2. a url already on screen is read without a redundant navigation");
{
  tab.url = PRICING;
  const calls = installChrome();
  const r = await executeTool("read_page", { url: PRICING }, {});
  ok("no tabs.update", calls.updates.length === 0, JSON.stringify(calls.updates));
  ok("still read the page", /Starter 32/.test((r && r.text) || ""), JSON.stringify(r));
}

console.log("\n3. a malformed url is REJECTED, never silently ignored (the original bug)");
{
  tab.url = PRICING;
  const calls = installChrome();
  const r = await executeTool("read_page", { url: "northwind-releases.html" }, {});
  ok("returns an error", r && !!r.error, JSON.stringify(r));
  ok("error explains the http:// requirement", /must start with http/i.test(r.error || ""), r && r.error);
  ok("nothing was read", calls.reads.length === 0, JSON.stringify(calls.reads));
}

console.log("\n4. a navigation that fails returns read:false and NO page text");
{
  tab.url = PRICING;
  installChrome({ navFails: true });
  const r = await executeTool("read_page", { url: "http://localhost:9/gone.html" }, {});
  ok("read is false", r && r.read === false, JSON.stringify(r));
  ok("no text is returned", r && r.text === undefined, JSON.stringify(r));
  ok("names the requested url", r && r.requested_url === "http://localhost:9/gone.html");
  ok("tells the model not to describe the page", /NOTHING was read/i.test((r && r.note) || ""), r && r.note);
}

console.log("\n5. landing on a DIFFERENT page discards the text (the fabrication seam)");
{
  tab.url = PRICING;
  const calls = installChrome({ stickyTab: true }); // navigation "succeeds", tab never moves
  const r = await executeTool("read_page", { url: RELEASES }, {});
  ok("returns an error rather than the wrong page's text", r && !!r.error, JSON.stringify(r));
  ok("the wrong page's text is NOT present", !/Starter 32/.test(JSON.stringify(r)), JSON.stringify(r));
  ok("names both the requested and the actual url",
    (r.error || "").includes(RELEASES) && (r.error || "").includes(PRICING), r && r.error);
  ok("read is false", r && r.read === false);
  ok("explains the one-tab collision and says to read one page per call",
    /one page per call|ONE tab|one at a time/i.test((r && r.note) || ""), r && r.note);
  ok("no read result leaked through", !/Growth tier/.test(JSON.stringify(r)));
  void calls;
}

console.log("\n6. no url => reads the active tab, exactly as before");
{
  tab.url = PRICING;
  const calls = installChrome();
  const r = await executeTool("read_page", { max_chars: 5000 }, {});
  ok("no navigation", calls.updates.length === 0, JSON.stringify(calls.updates));
  ok("read the active tab", /Starter 32/.test((r && r.text) || ""), JSON.stringify(r));
  ok("no requested_url is invented", r && r.requested_url === undefined, JSON.stringify(r));
}

console.log("\n7. M1 real-money: read_page's new navigation cannot route around the allowlist");
{
  // read_page can navigate now, so it must not become a way to reach a blocked M1 route
  // that `navigate` itself would refuse. The nested call goes through navigate's own
  // fail-closed origin check, so the refusal must survive.
  tab.url = "https://dashboard.m1.com/d/invest/portfolio";
  const calls = installChrome();
  const r = await executeTool("read_page", { url: "https://dashboard.m1.com/d/invest/trade" }, {});
  ok("blocked M1 route is refused", r && !!r.error, JSON.stringify(r));
  ok("refusal names the M1 read-only rule", /M1 read-only/i.test(r.error || ""), r && r.error);
  ok("no navigation was issued", calls.updates.length === 0, JSON.stringify(calls.updates));
  ok("nothing was read", calls.reads.length === 0 && r.read === false, JSON.stringify(calls.reads));
}
{
  // ...while an allowlisted read-only M1 route still works.
  tab.url = "https://dashboard.m1.com/d/invest/portfolio";
  PAGES["https://dashboard.m1.com/d/invest/portfolio"] = { title: "Portfolio", text: "holdings" };
  const calls = installChrome();
  const r = await executeTool("read_page", { url: "https://dashboard.m1.com/d/invest/portfolio" }, {});
  ok("an allowlisted M1 page is still readable", r && !r.error && /holdings/.test(r.text || ""), JSON.stringify(r));
  void calls;
}

// ---- 2026-09-09c: master-mind review findings (consensus 18:01, NO-GO on 09b) -------
console.log("\n8. F3 — the read-only pin holds at the executor: read_page{url} cannot move the tab");
{
  tab.url = PRICING;
  const calls = installChrome();
  const r = await executeTool("read_page", { url: RELEASES }, { readOnly: true });
  ok("refused with read:false", r && r.read === false && !!r.error, JSON.stringify(r));
  ok("names READ-ONLY mode", /READ-ONLY/.test(r.error || ""), r && r.error);
  ok("no navigation was issued", calls.updates.length === 0, JSON.stringify(calls.updates));
  ok("no text leaked", r.text === undefined);
  const same = await executeTool("read_page", { url: PRICING }, { readOnly: true });
  ok("the page already on screen is still readable in read-only mode", same && !same.error && /Starter 32/.test(same.text || ""), JSON.stringify(same));
}

console.log("\n9. F3 — the M1 pin holds even when the tab has DRIFTED off M1");
{
  tab.url = PRICING; // not on dashboard.m1.com — the 09b navigate-case check would be skipped
  const calls = installChrome();
  const r = await executeTool("read_page", { url: "https://dashboard.m1.com/d/invest/trade" }, { m1ReadOnly: true });
  ok("transactional M1 route refused on the PIN, not the live host", r && r.read === false && /M1 read-only/i.test(r.error || ""), JSON.stringify(r));
  ok("no navigation was issued", calls.updates.length === 0, JSON.stringify(calls.updates));
}

console.log("\n10. F7 — a same-site redirect is read and LABELLED; a cross-host redirect is refused");
{
  const LANDED = "http://localhost:8898/northwind-pricing-2026.html";
  PAGES[LANDED] = { title: "Pricing 2026", text: "Starter 32 (2026 page)" };
  tab.url = RELEASES;
  const calls = installChrome();
  const realUpdate = globalThis.chrome.tabs.update;
  globalThis.chrome.tabs.update = async (id, o) => { const t = await realUpdate(id, o); tab.url = LANDED; return t; }; // server redirect
  const r = await executeTool("read_page", { url: PRICING }, {});
  ok("the redirected page's text is returned", r && !r.error && /2026 page/.test(r.text || ""), JSON.stringify(r));
  ok("redirected_to names where it landed", r && r.redirected_to === LANDED, JSON.stringify(r));
  ok("the note says plainly whose text this is", /REDIRECTED/.test(r.note || "") && (r.note || "").includes(LANDED), r && r.note);
  ok("requested_url still echoes the request", r && r.requested_url === PRICING);
  void calls;
}
{
  const SSO = "https://login.example-sso.com/auth?next=pricing";
  PAGES[SSO] = { title: "Sign in", text: "Username Password" };
  tab.url = RELEASES;
  installChrome();
  const realUpdate = globalThis.chrome.tabs.update;
  globalThis.chrome.tabs.update = async (id, o) => { const t = await realUpdate(id, o); tab.url = SSO; return t; };
  const r = await executeTool("read_page", { url: PRICING }, {});
  ok("cross-host redirect => refused, read:false", r && r.read === false && !!r.error, JSON.stringify(r));
  ok("error names the bounce and the host it landed on", /redirect|sign-in page|authentication-like/i.test(r.error || "") && (r.error || "").includes(SSO), r && r.error);
  ok("the login page text is NOT passed off as the request", !/Username Password/.test(JSON.stringify(r)));
}

console.log("\n11. B — a page that reports no url cannot be proven: fail closed");
{
  tab.url = PRICING;
  installChrome();
  const realSend = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async (id, msg) => { const v = await realSend(id, msg); if (v && v.url) delete v.url; return v; };
  const r = await executeTool("read_page", { url: RELEASES }, {});
  ok("read:false with an error", r && r.read === false && !!r.error, JSON.stringify(r));
  ok("explains the page did not report its URL", /did not report its own URL/i.test(r.error || ""), r && r.error);
  ok("text discarded", r.text === undefined);
}

console.log("\n12. F8 — a differing #route on a hash-routed SPA is navigated and proven");
{
  const APP_A = "http://localhost:8898/app#/careers", APP_B = "http://localhost:8898/app#/pricing";
  PAGES[APP_A] = { title: "Careers", text: "8 open roles" };
  PAGES[APP_B] = { title: "Pricing", text: "Starter 32" };
  tab.url = APP_A;
  const calls = installChrome();
  const r = await executeTool("read_page", { url: APP_B }, {});
  ok("navigation was issued for the new #route", calls.updates.length === 1 && calls.updates[0] === APP_B, JSON.stringify(calls.updates));
  ok("the #/pricing view's text came back", r && !r.error && /Starter 32/.test(r.text || ""), JSON.stringify(r));
  tab.url = APP_B;
  const calls2 = installChrome();
  const r2 = await executeTool("read_page", { url: APP_B }, {});
  ok("same #route => no navigation", calls2.updates.length === 0 && r2 && !r2.error, JSON.stringify(calls2.updates));
  // A stuck hash router (tab never moves) must not pass the careers view off as pricing.
  tab.url = APP_A;
  installChrome({ stickyTab: true });
  const r3 = await executeTool("read_page", { url: APP_B }, {});
  ok("stuck #route => refused, careers text not returned", r3 && r3.read === false && !/8 open roles/.test(JSON.stringify(r3)), JSON.stringify(r3));
}

console.log("\n13. P3 — a user Stop during the nested navigation propagates as AbortError");
{
  tab.url = PRICING;
  installChrome();
  globalThis.chrome.tabs.update = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  let thrown = null;
  try { await executeTool("read_page", { url: RELEASES }, {}); } catch (e) { thrown = e; }
  ok("AbortError is re-thrown, not swallowed into {error}", thrown && thrown.name === "AbortError", String(thrown));
}

console.log("\n14. P3 — an absurd url length is rejected");
{
  tab.url = PRICING;
  const calls = installChrome();
  const r = await executeTool("read_page", { url: "http://localhost:8898/" + "x".repeat(4100) }, {});
  ok("too-long url => error, nothing read", r && /too long/i.test(r.error || "") && calls.reads.length === 0, JSON.stringify(r).slice(0, 120));
}

// ---- 2026-09-09d: master-mind pass-2 findings (session 6aa1de30, B-1 / B-2) ----------
console.log("\n15. B-1 — a SAME-HOST bounce to login.do is refused, never read-and-labelled");
{
  const RECORD = "https://dev000001.service-now.com/now/nav/ui/home?sys_id=abc"; // polaris route (no classic .do probe in the mock)
  const LOGIN = "https://dev000001.service-now.com/login.do";
  PAGES[LOGIN] = { title: "Log in", text: "User name Password Log in" };
  tab.url = PRICING;
  installChrome();
  const realUpdate = globalThis.chrome.tabs.update;
  globalThis.chrome.tabs.update = async (id, o) => { const t = await realUpdate(id, o); tab.url = LOGIN; return t; }; // session expired
  const r = await executeTool("read_page", { url: RECORD }, {});
  ok("refused with login_required", r && r.read === false && r.login_required === true, JSON.stringify(r));
  ok("error names the authentication page", /authentication-like|sign-in page/i.test(r.error || "") && (r.error || "").includes(LOGIN), r && r.error);
  ok("login form text never returned", !/User name Password/.test(JSON.stringify(r)));
  ok("note forbids typing credentials", /do NOT type credentials/i.test(r.note || ""), r && r.note);
}
console.log("\n16. B-1 — a catch-all redirect to the site root is refused");
{
  const ROOT = "http://localhost:8898/";
  PAGES[ROOT] = { title: "Home", text: "Welcome home" };
  tab.url = RELEASES;
  installChrome();
  const realUpdate = globalThis.chrome.tabs.update;
  globalThis.chrome.tabs.update = async (id, o) => { const t = await realUpdate(id, o); tab.url = ROOT; return t; };
  const r = await executeTool("read_page", { url: "http://localhost:8898/does-not-exist.html" }, {});
  ok("refused with redirected_home", r && r.read === false && r.redirected_home === true, JSON.stringify(r));
  ok("home text never returned", !/Welcome home/.test(JSON.stringify(r)));
  // ...but asking for the root itself is fine.
  tab.url = RELEASES;
  installChrome();
  const r2 = await executeTool("read_page", { url: ROOT }, {});
  ok("requesting the root itself reads it", r2 && !r2.error && /Welcome home/.test(r2.text || ""), JSON.stringify(r2));
}
console.log("\n17. B-2 — navigate's instance-host rewrite is refused for a read");
{
  // Tab is signed in to instance 1; the model asks for instance 2. navigate rewrites the host
  // to instance 1 (placeholder-host self-heal). For a READ that is the wrong instance.
  const ON_DEV1 = "https://dev000001.service-now.com/now/nav/ui/home";
  const WANT_DEV2 = "https://dev000002.service-now.com/api/now/table/incident?sysparm_limit=1";
  PAGES[ON_DEV1] = { title: "dev1", text: "dev1 home" };
  tab.url = ON_DEV1;
  const calls = installChrome();
  const r = await executeTool("read_page", { url: WANT_DEV2 }, {});
  ok("refused, read:false", r && r.read === false && !!r.error, JSON.stringify(r));
  ok("error names both the requested and the rewritten url", (r.error || "").includes("dev000002") && (r.error || "").includes("dev000001"), r && r.error);
  ok("no instance-1 text leaked", !/dev1 home/.test(JSON.stringify(r)));
  void calls;
}

// ---- 2026-09-09e: master-mind pass-3 N-8 / N-9 / N-14 -----------------------------------
console.log("\n18. N-8 — looksLikeLoginUrl precision");
{
  const { looksLikeLoginUrl } = await import("./tools.js");
  ok("login.do / logout.do / welcome.do", ["https://h/login.do", "https://h/logout.do", "https://h/welcome.do?x=1"].every(looksLikeLoginUrl));
  ok("a *_login table list is NOT a login page", !looksLikeLoginUrl("https://h/x_snc_login_list.do"));
  ok("nav_to uri=login.do is; uri=login_history_list.do is not",
    looksLikeLoginUrl("https://h/nav_to.do?uri=login.do") && looksLikeLoginUrl("https://h/nav_to.do?uri=%2Flogin.do") && !looksLikeLoginUrl("https://h/nav_to.do?uri=login_history_list.do"));
  ok("a /login segment in the QUERY only is not a login page", !looksLikeLoginUrl("https://h/article?next=/login"));
  ok("/docs/auth/overview IS auth-like (refused on a redirect landing, readable when requested)", looksLikeLoginUrl("https://h/docs/auth/overview"));
  ok("/authors/ is not", !looksLikeLoginUrl("https://h/authors/jane"));
}
console.log("\n19. N-8 — a login-like REQUEST that lands on itself is read");
{
  const DEVICE = "https://github.example/login/device";
  PAGES[DEVICE] = { title: "Device activation", text: "Enter the code shown on your device" };
  tab.url = PRICING;
  installChrome();
  const r = await executeTool("read_page", { url: DEVICE }, {});
  ok("the requested login page is read", r && !r.error && /Enter the code/.test(r.text || ""), JSON.stringify(r));
  // …and a login-like request that gets normalised to itself + query is still on target
  tab.url = PRICING;
  installChrome();
  const realUpdate = globalThis.chrome.tabs.update;
  globalThis.chrome.tabs.update = async (id, o) => { const t = await realUpdate(id, o); tab.url = DEVICE + "?return_to=%2F"; return t; };
  PAGES[DEVICE + "?return_to=%2F"] = PAGES[DEVICE];
  const r2 = await executeTool("read_page", { url: DEVICE }, {});
  ok("a login-like request landing on login?return_to is NOT refused as a bounce", !(r2 && r2.login_required), JSON.stringify(r2));
}
console.log("\n20. N-8 — a docs redirect to an auth-like landing is refused with a recovery hint");
{
  const OLD = "http://localhost:8898/old-doc.html", NEW = "http://localhost:8898/docs/auth/overview";
  PAGES[NEW] = { title: "Auth overview", text: "How auth works" };
  tab.url = PRICING;
  installChrome();
  const realUpdate = globalThis.chrome.tabs.update;
  globalThis.chrome.tabs.update = async (id, o) => { const t = await realUpdate(id, o); tab.url = NEW; return t; };
  const r = await executeTool("read_page", { url: OLD }, {});
  ok("refused, read:false, login_required", r && r.read === false && r.login_required === true, JSON.stringify(r));
  ok("the note does not assert the session expired as fact and names the recovery", /Most often/.test(r.note || "") && /call read_page with the landing url/.test(r.note || ""), r && r.note);
  // second call on the landing url itself reads
  const r2 = await executeTool("read_page", { url: NEW }, {});
  ok("reading the landing url directly works", r2 && !r2.error && /How auth works/.test(r2.text || ""), JSON.stringify(r2));
}
console.log("\n21. N-9 / N-14 — wording");
{
  const ROOT = "http://localhost:8898/";
  PAGES[ROOT] = { title: "Home", text: "Welcome home" };
  tab.url = RELEASES;
  installChrome();
  const realUpdate = globalThis.chrome.tabs.update;
  globalThis.chrome.tabs.update = async (id, o) => { const t = await realUpdate(id, o); tab.url = ROOT; return t; };
  const r = await executeTool("read_page", { url: "http://localhost:8898/missing.html" }, {});
  ok("root refusal says NOT verified, not 'does not exist'", /NOT verified/.test(r.error || "") && !/does not exist there or is not reachable\./.test(r.error || ""), r && r.error);
  const ON_DEV1 = "https://dev000001.service-now.com/now/nav/ui/home";
  PAGES[ON_DEV1] = { title: "dev1", text: "dev1 home" };
  tab.url = ON_DEV1;
  installChrome();
  const r2 = await executeTool("read_page", { url: "https://dev000002.service-now.com/api/now/table/incident?sysparm_limit=1" }, {});
  ok("host-rewrite note names the landed host and landed_url", /dev000001\.service-now\.com/.test(r2.note || "") && /landed_url/.test(r2.note || ""), r2 && r2.note);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
