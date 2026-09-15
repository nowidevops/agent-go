// console-tap.js — MAIN-world, document_start, all frames: buffer the page's
// UNCAUGHT exceptions + unhandled promise rejections into a ring buffer so the
// agent's read_console tool (diagnostics.js) can pull REAL page errors as
// root-cause evidence. It does NOT wrap console.error/warn (that re-emitted the
// page's own console noise from this extension → Chrome flagged it all as
// extension "Errors"; see note below). Captures from page load onward — a tab
// loaded before the extension (re)loaded has no tap until it reloads.
// MAIN world is required: page errors don't cross into the isolated world.
// Author: iDevOpsLLC
(() => {
  if (window.__llmConsoleTap) return; // idempotent (SPA soft-navigations, re-injection)
  const MAX = 200;
  const buf = [];
  const fmt = (a) => {
    try {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message || String(a);
      return JSON.stringify(a);
    } catch { try { return String(a); } catch { return "[unprintable]"; } }
  };
  const push = (level, parts) => {
    try {
      buf.push({ t: Date.now(), level, text: parts.map(fmt).join(" ").slice(0, 2000) });
      if (buf.length > MAX) buf.shift();
    } catch {}
  };
  // Forward to the original console method through an ANONYMOUS trampoline
  // (new Function → no source URL) so Chrome attributes the message to the
  // PAGE, not this extension. Without it, the call site of the real
  // console.error is this extension-origin file, and chrome://extensions
  // collects every page's console noise (e.g. Firestore's benign clock-skew
  // warning on agentic-workflow.html) under the extension's red Errors badge.
  // If the page's CSP bans eval in the main world (no trampoline), we skip
  // wrapping entirely on that page — uncaught exceptions and rejections are
  // still captured by the window listeners below, and the extension never
  // gets blamed for the page's own console output.
  // TRUSTED TYPES (Outlook/Teams web, 2026-07-23): on a page enforcing
  // require-trusted-types-for 'script', `new Function(<string>)` is BLOCKED and
  // Chrome logs a "requires 'TrustedScript' assignment" violation to the
  // extension's Errors panel on EVERY page load — even inside try/catch. When
  // the TT API exists, mint the source through a policy and indirect-eval the
  // TrustedScript instead (legal under TT, and eval unwraps it fine on pages
  // without enforcement). If the site's CSP restricts policy names or bans
  // eval, the catch leaves forward null and we degrade to events-only as before.
  let forward = null;
  try {
    const SRC = "(function(orig, self, args){ return orig.apply(self, args); })";
    let code = SRC;
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      code = window.trustedTypes.createPolicy("lc-console-tap", { createScript: (s) => s }).createScript(SRC);
    }
    forward = (0, eval)(code); // indirect eval → no source URL, page-attributed
  } catch {}
  if (forward) {
    for (const level of ["error", "warn"]) {
      const orig = console[level];
      try {
        console[level] = function (...args) {
          push(level, args);
          try { return forward(orig, this, args); } catch { return orig.apply(this, args); }
        };
      } catch {}
    }
  }
  window.addEventListener("error", (e) => {
    push("error", [String(e.message || "Script error") + (e.filename ? ` (${e.filename}:${e.lineno || 0})` : "")]);
  }, true);
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    push("error", ["Unhandled promise rejection: " + ((r && (r.stack || r.message)) || fmt(r))]);
  }, true);
  window.__llmConsoleTap = { read: () => buf.slice() };
})();
