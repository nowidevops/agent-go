// web-search-fallbacks.test.mjs — web_search must not give up after one backend.
//
// Live incident: every take of the v2 recording (2026-09-09 23:20 to 03:48 UTC) hit
// DuckDuckGo's rate limit and Google's bot-check page back to back. The tool returned
// 0 results with a note telling the model to switch tools; the model guessed a URL and
// navigated. 09i chains DuckDuckGo html -> DuckDuckGo lite -> Bing RSS inside one call.
//
// Markup fixtures are trimmed copies of what the three endpoints returned from this
// machine on 2026-09-10 00:05 local for the query "what is Ollama".
// Author: iDevOpsLLC
import assert from "node:assert/strict";

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  ok   " + name); } else { failed++; console.log("  FAIL " + name); } }

globalThis.chrome = {
  tabs: { query: async () => [], get: async () => ({}), update: async () => ({}), sendMessage: async () => ({}), onUpdated: { addListener() {}, removeListener() {} } },
  scripting: { executeScript: async () => [] },
  webNavigation: { getAllFrames: async () => [] },
  runtime: { lastError: null },
};
const { __webSearchInternals: W } = await import("./tools.js");

const DDG_HTML = `<div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Follama.com%2F&amp;rut=abc">Ollama</a></h2><a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Follama.com%2F">Get up and running with large language models.</a></div>
<div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Follama%2Follama&amp;rut=def">GitHub - ollama/ollama</a></h2><a class="result__snippet" href="#">Get up and running with &amp; more.</a></div>`;
const DDG_HTML_EMPTY = `<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></body></html>`;
const DDG_LITE = `<table><tr><td valign="top">1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Follama.com%2F&amp;rut=5b8" class='result-link'>Official site</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>
  Ollama
</td></tr><tr><td>&nbsp;</td><td><span class='link-text'>ollama.com</span></td></tr>
<tr><td valign="top">2.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fitsfoss.com%2Follama%2F&amp;rut=9c1" class='result-link'>What is Ollama? Everything Important You Should Know</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>Ollama is a free and open-source tool that lets anyone run open LLMs locally.</td></tr></table>`;
const BING_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>Bing: what is Ollama</title><item><title>Ollama</title><link>https://ollama.com/</link><description>Local models are always free. Ollama is the easiest way to automate your work using open models, while keeping your data safe.</description><pubDate>Wed, 09 Sep 2026 14:03:00 GMT</pubDate></item><item><title>What is Ollama - GeeksforGeeks</title><link>https://www.geeksforgeeks.org/artificial-intelligence/what-is-ollama/</link><description>Ollama enables developers to run pre-trained, open-weight language &amp; multimodal models locally.</description></item></channel></rss>`;

console.log("A. parsers");
{
  const r = W.parseDdgHtml(DDG_HTML);
  ok("ddg html: two results, real urls unwrapped", r.length === 2 && r[0].url === "https://ollama.com/" && r[1].url === "https://github.com/ollama/ollama");
  ok("ddg html: snippet decoded", r[0].snippet === "Get up and running with large language models.");
  ok("ddg html: bot page parses to nothing", W.parseDdgHtml(DDG_HTML_EMPTY).length === 0);
  const l = W.parseDdgLite(DDG_LITE);
  ok("ddg lite: two results, real urls unwrapped", l.length === 2 && l[0].url === "https://ollama.com/" && l[1].url === "https://itsfoss.com/ollama/");
  ok("ddg lite: whitespace-padded snippet trimmed", l[0].snippet === "Ollama" && /free and open-source/.test(l[1].snippet));
  const b = W.parseBingRss(BING_RSS);
  ok("bing rss: two items with link + description", b.length === 2 && b[0].url === "https://ollama.com/" && /keeping your data safe/.test(b[0].snippet));
  ok("bing rss: entities decoded in descriptions", b[1].snippet.includes("language & multimodal"));
  ok("bing rss: the channel title is not an item", !b.some((x) => x.title.startsWith("Bing:")));
}

console.log("\nB. fallback order (stubbed fetch)");
const calls = [];
function stubFetch(map) {
  globalThis.fetch = async (url) => {
    calls.push(url);
    for (const [k, v] of Object.entries(map)) {
      if (url.includes(k)) {
        if (v instanceof Error) throw v;
        return { ok: v.status === undefined || v.status === 200, status: v.status || 200, text: async () => v.body || "" };
      }
    }
    throw new Error("unexpected url " + url);
  };
}
{
  calls.length = 0;
  stubFetch({ "html.duckduckgo.com": { body: DDG_HTML } });
  const r = await W.webSearch("what is Ollama", 5);
  ok("first backend serves: one fetch, backend named", calls.length === 1 && r.backend === "duckduckgo" && r.count === 2 && r.backends_tried === undefined);
}
{
  calls.length = 0;
  stubFetch({ "html.duckduckgo.com": { body: DDG_HTML_EMPTY }, "lite.duckduckgo.com": { body: DDG_LITE } });
  const r = await W.webSearch("what is Ollama");
  ok("ddg rate-limit page -> lite serves", calls.length === 2 && r.backend === "duckduckgo-lite" && r.count === 2);
  ok("the bounced backend is reported", Array.isArray(r.backends_tried) && /duckduckgo: 0 results/.test(r.backends_tried[0]));
}
{
  calls.length = 0;
  stubFetch({ "html.duckduckgo.com": { status: 429, body: "" }, "lite.duckduckgo.com": new Error("Failed to fetch"), "bing.com": { body: BING_RSS } });
  const r = await W.webSearch("what is Ollama");
  ok("HTTP 429 then network error -> bing rss serves", calls.length === 3 && r.backend === "bing-rss" && r.count === 2);
  ok("both failures reported in order", r.backends_tried.length === 2 && /HTTP 429/.test(r.backends_tried[0]) && /Failed to fetch/.test(r.backends_tried[1]));
  ok("result note still forbids invention", /Do NOT add statistics/.test(r.note));
}
{
  calls.length = 0;
  stubFetch({ "html.duckduckgo.com": { body: DDG_HTML_EMPTY }, "lite.duckduckgo.com": { body: "<html>nothing</html>" }, "bing.com": { status: 503, body: "" } });
  const r = await W.webSearch("what is Ollama");
  ok("all three fail -> 0 results, every backend named, no error thrown", r.count === 0 && r.backends_tried.length === 3 && /No results from any search backend/.test(r.note));
  ok("failure note points at google_search or a direct read, never at inventing", /google_search once/.test(r.note) && /does NOT license inventing/.test(r.note));
  ok("empty query short-circuits without fetching", (calls.length = 0, (await W.webSearch("  ")).error !== undefined && calls.length === 0));
}
{
  ok("limit clamps to 1..10", (await (async () => { stubFetch({ "html.duckduckgo.com": { body: DDG_HTML } }); const r = await W.webSearch("x", 99); return r.count <= 10; })()));
  ok("backend order is ddg html, ddg lite, bing rss", W.WEB_SEARCH_BACKENDS.map((b) => b.name).join(",") === "duckduckgo,duckduckgo-lite,bing-rss");
}

console.log("\nC. 09l hardening (an internal review follow-ups)");
{
  const bare = `<table><tr><td><form><input name="q"></form></td></tr></table><table><tr><td>1.</td><td><a rel="nofollow" href=//duckduckgo.com/l/?uddg=https%3A%2F%2Follama.com%2F class='result-link'>Ollama</a></td></tr>
<tr><td></td><td class='result-snippet'>Run models locally.</td></tr></table><div class='result-snippet'>FOOTER AD</div>`;
  const l = W.parseDdgLite(bare);
  ok("lite: a bare (unquoted) href still yields the real url, past the search-form table", l.length === 1 && l[0].url === "https://ollama.com/");
  ok("lite: a snippet after </table> never attaches to the last result", l[0].snippet === "Run models locally.");
  const nourl = `<table><tr><td><a class='result-link'>No link here</a></td></tr></table>`;
  ok("lite: an item without a url is skipped (so the backend hands over instead of serving uncitable rows)", W.parseDdgLite(nourl).length === 0);
  const cdata = `<rss><channel><item><title><![CDATA[Ollama <b>home</b>]]></title><link>https://ollama.com/</link><description><![CDATA[Run <i>open</i> models & more]]></description></item><item><title>bad link</title><link>javascript:alert(1)</link></item></channel></rss>`;
  const c = W.parseBingRss(cdata);
  ok("bing: CDATA title survives the tag strip and inner tags are removed", c.length === 1 && c[0].title === "Ollama home");
  ok("bing: CDATA description decoded", c[0].snippet === "Run open models & more");
  ok("bing: a non-http link is dropped", !c.some((x) => /javascript:/.test(x.url)));
}
{
  const saved = W.WEB_SEARCH_OPTS.timeoutMs;
  W.WEB_SEARCH_OPTS.timeoutMs = 60;
  calls.length = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push(url);
    if (url.includes("html.duckduckgo.com")) return new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
    if (url.includes("lite.duckduckgo.com")) return { ok: true, status: 200, text: () => new Promise(() => {}) }; // body never arrives
    return { ok: true, status: 200, text: async () => BING_RSS };
  };
  const keepAlive = setTimeout(() => {}, 5000); // Node unrefs AbortSignal.timeout's timer; Chrome does not
  const t0 = Date.now();
  const r = await W.webSearch("what is Ollama");
  const took = Date.now() - t0;
  clearTimeout(keepAlive);
  ok("a stalled fetch AND a stalled body both time out and hand over", r.backend === "bing-rss" && calls.length === 3);
  ok("timeouts are recorded as such", r.backends_tried.length === 2 && r.backends_tried.every((s) => /timeout after 60 ms/.test(s)));
  ok("the chain is bounded by ~3x the per-backend deadline, not forever", took < 2000);
  W.WEB_SEARCH_OPTS.timeoutMs = saved;
  ok("default per-backend deadline is 10 s", saved === 10000);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
