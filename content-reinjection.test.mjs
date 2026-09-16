// content-reinjection.test.mjs — content.js must survive being injected TWICE
// into the same isolated world.
//
// Owner's chrome://extensions Errors page (2026-09-07, dev000000 classic form
// inside the polaris wrapper): eight copies of
//   Uncaught SyntaxError: Identifier 'NON_CONTENT_TAGS' has already been declared
//   content.js:1
// Two injectors race at document_idle — the manifest content_scripts entry and
// the worker's executeScript({files:["content.js"]}) that runs when a frame
// probe answered "not ready yet". A second copy of a script whose top level
// declares `const NON_CONTENT_TAGS` fails at PARSE time, before the
// `if (!window.__localClaudeContentReady)` guard at the bottom can run.
// Wrapping the whole file in an IIFE makes every declaration function-scoped,
// so the second copy parses, runs, sees the ready flag and registers nothing.
//
// The test evaluates the real content.js twice in one vm context with stub
// window/document/chrome globals and asserts: no throw, ONE onMessage listener,
// ready flag set. Run: node content-reinjection.test.mjs   Author: iDevOpsLLC
import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };

const src = readFileSync(new URL("./content.js", import.meta.url), "utf8");

function makeContext() {
  const listeners = [];
  const noop = () => {};
  const el = { addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null, getAttribute: () => null, children: [], childNodes: [], style: {}, textContent: "", innerText: "" };
  const document = {
    ...el,
    title: "stub", body: { ...el }, documentElement: { ...el }, readyState: "complete",
    createElement: () => ({ ...el }), createRange: () => ({ selectNode: noop }), getElementById: () => null, activeElement: null
  };
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Math, Date, JSON, Map, Set, WeakMap, WeakSet, Promise, RegExp, Array, Object, String, Number, Boolean, Error, Symbol,
    document,
    location: { href: "https://example.test/x", hostname: "example.test", origin: "https://example.test", pathname: "/x", search: "" },
    navigator: { userAgent: "stub", clipboard: {} },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (f) => setTimeout(f, 0),
    chrome: {
      runtime: {
        id: "stub-ext", getURL: (p) => "chrome-extension://stub/" + p,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: () => Promise.resolve()
      },
      storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener: noop } }
    }
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx; ctx.top = ctx; ctx.parent = ctx;
  vm.createContext(ctx);
  return { ctx, listeners };
}

console.log("\n1. content.js evaluated TWICE in one isolated world");
{
  const { ctx, listeners } = makeContext();
  let err1 = null, err2 = null;
  try { vm.runInContext(src, ctx, { filename: "content.js" }); } catch (e) { err1 = e; }
  ok("first copy runs (no throw)", !err1, err1 && err1.message);
  ok("first copy set the ready flag", ctx.__localClaudeContentReady === true);
  ok("first copy registered exactly one onMessage listener", listeners.length === 1, String(listeners.length));
  try { vm.runInContext(src, ctx, { filename: "content.js" }); } catch (e) { err2 = e; }
  ok("second copy does NOT throw 'has already been declared' (the live bug)", !err2, err2 && err2.message);
  ok("second copy registered NO extra listener (guard held)", listeners.length === 1, String(listeners.length));
  ok("no top-level const leaked into the world", !("NON_CONTENT_TAGS" in ctx));
}

console.log("\n2. the wrap is present and closed");
{
  ok("file starts with the re-injection-safe IIFE marker", /^\/\* __LLMGO_IIFE_WRAP__ v1 re-injection-safe \*\/\s*;\(function\(\)\{/.test(src));
  ok("file ends by closing the IIFE", /\}\)\(\);\s*$/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
