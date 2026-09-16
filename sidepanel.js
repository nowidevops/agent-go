// sidepanel.js — chat UI: streaming render, markdown, persistence, stop/clear, status.
// Author: iDevOpsLLC

import { getSettings, getCloudCreds, getByok } from "./settings.js";
import { activeProvider, providerLabel } from "./provider.js";
import { CLOUD_MODELS, CLOUD_DEFAULT_MODEL } from "./cloud.js";
import { listModels, chat } from "./ollama.js";
import { getShortcuts, saveShortcut, computeNextFire, BUILTINS, seedDefaultShortcuts } from "./shortcuts.js";
import { describeShortcutArgs } from "./shortcut-tool.js";
import { riskTier, RISK_META } from "./ui-risk.js"; // display-only approval risk bands (2026-09-14 redesign)
import { copyText, downloadMarkdown, downloadDocx, downloadPdf, exportBaseName, buildDocxBytes, buildPdfBytes, extractCodeArtifacts, downloadArtifact, buildPhaseRunReport } from "./export.js";
import { getRootHandle, saveRootHandle, clearRootHandle, getRootHandles, addRootHandle, removeRootHandleByName, clearAllRoots, pickRoot, MAX_ROOTS, ensurePermission, ensureReadWritePermission, hasReadPermission, hasWritePermission, listDir, readFileText, readFileBytesB64, writeFileText, writeFileBytes, createFolder, movePath, copyPath, deletePath, editFile, searchFiles } from "./fsaccess.js";
import { getSnConnections, saveSnConnections, clearSnConnections, snBasicTarget, snQueryTable, snOrigin } from "./sn-tools.js";
import { workflowToMarkdown, eventToStepLine } from "./teach.js";
import { initListen, getListenContext, maybeSpeak } from "./listen.js";
import { initConvLog, convLogSave } from "./conv-log.js";
import { getAuthToken, getAuth } from "./auth.js";
import { DEFAULTS } from "./settings.js";
import { updateState, checkForUpdate, dismissUpdate, downloadPageFor } from "./update-check.js";

const logEl = document.getElementById("log");

// Copy button on each code card (event delegation — covers every card, now and
// future). Copies the raw code (textContent strips the color spans) and flashes ✓.
logEl.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".code-copy");
  if (!btn) return;
  const codeEl = btn.closest(".code-card") && btn.closest(".code-card").querySelector("pre code");
  if (!codeEl) return;
  Promise.resolve(copyText(codeEl.textContent)).then(() => {
    const prev = btn.textContent;
    btn.textContent = "Copied ✓";
    setTimeout(() => { btn.textContent = prev; }, 1200);
  }).catch(() => {});
});

// Copy button on each rendered table (event delegation on document so it also
// works for tables inside the admin phase-report viewer, not just #log).
// Writes BOTH text/plain (tab-separated — pastes into a text editor or a
// spreadsheet as cells) and text/html (the real <table> — pastes into
// Docs/Word/Sheets with the grid intact); falls back to TSV-only where the
// rich clipboard API is blocked.
document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".table-copy");
  if (!btn) return;
  const wrap = btn.closest(".md-table-wrap");
  const table = wrap && wrap.querySelector("table");
  if (!table) return;
  // [\t\r\n]+ → space: a cell can contain real newlines (a fenced code block in a
  // GFM cell survives as a <pre> via the [[LCCODEBLOCK]] sentinel) — un-normalized
  // they'd shear the TSV row alignment on plain-text paste (MM review L1).
  const tsv = Array.from(table.querySelectorAll("tr"))
    .map((tr) => Array.from(tr.querySelectorAll("th,td")).map((c) => c.textContent.trim().replace(/[\t\r\n]+/g, " ")).join("\t"))
    .join("\n");
  const flash = () => {
    const prev = btn.textContent;
    btn.textContent = "Copied ✓";
    setTimeout(() => { btn.textContent = prev; }, 1200);
  };
  const rich = () => navigator.clipboard.write([
    new ClipboardItem({
      "text/plain": new Blob([tsv], { type: "text/plain" }),
      "text/html": new Blob([table.outerHTML], { type: "text/html" }),
    }),
  ]);
  // Promise.resolve().then(rich) routes even a synchronous throw into .catch;
  // the TSV fallback only flashes success when copyText really succeeded.
  (typeof ClipboardItem !== "undefined" && navigator.clipboard && navigator.clipboard.write ? Promise.resolve().then(rich) : Promise.reject())
    .then(flash)
    .catch(() => Promise.resolve(copyText(tsv)).then((ok) => { if (ok) flash(); }).catch(() => {}));
});

// ---- admin-only tool visibility (Agent Go) ----------------------------------------
// Non-admin users don't see raw tool-call/result bubbles — just a processing spinner.
// Admin status is the server-authoritative tier from /me (not the login-stored tier).
let isAdmin = false;
(async function loadTier() {
  try {
    const s = await getSettings();
    const token = await getAuthToken();
    const res = await fetch(`${String(s.backendUrl || "").replace(/\/$/, "")}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) { const me = await res.json(); isAdmin = me && me.tier === "admin"; }
    seedDefaultShortcuts().catch(() => {}); // one-time UAT starter /commands, gated to maintainer@example.com
  } catch (_e) { isAdmin = false; } // fail closed (now only gates the admin-only menu items, e.g. Conversation log)
  applyAdminGating();
})();

// Hide admin/training-only UI from non-admins (fail-closed: hidden until /me
// confirms admin). Conversation log auto-saves full transcripts for LLM training —
// an internal feature, not for usage-tier users.
function applyAdminGating() {
  const convLog = document.getElementById("menuConvLog");
  if (convLog) convLog.hidden = !isAdmin; // hidden until /me confirms admin; shown for admins
}
applyAdminGating(); // hide immediately on load (before /me resolves) — fail-closed


// PROACTIVE maintenance notice: poll the backend's public /status so the panel shows an
// "under maintenance" banner AND disables the composer BEFORE a user sends — instead of only
// after a failed turn. /status is unauthenticated, outside the kill guards, and reflects the
// MASTER kill (a deliberate outage), so it's the right proactive signal (a per-tier kill isn't
// visible unauthenticated and still surfaces reactively as the inline 503 on send).
function setMaintenance(on) {
  const banner = document.getElementById("maintBanner");
  const row = document.querySelector(".input-row");
  if (banner) banner.hidden = !on;
  if (row) row.classList.toggle("maint-disabled", on);
}
async function checkAgentGoStatus() {
  try {
    const s = await getSettings();
    const base = String(s.backendUrl || "").replace(/\/$/, "");
    if (!base) return;
    const res = await fetch(`${base}/status`, { cache: "no-store" });
    if (!res.ok) return;                       // a transient error is NOT a confirmed outage
    const j = await res.json();
    setMaintenance(!!j && j.available === false); // ONLY an explicit available:false shows it
  } catch (_e) { /* network hiccup → leave the banner as-is (no flapping) */ }
}
checkAgentGoStatus();
setInterval(checkAgentGoStatus, 60000); // 60s poll (unref not needed — panel lifetime)

// "A newer pack is available" banner (2026-09-03): render the stored answer, then refresh it if
// it is older than six hours. Never blocks the composer; dismiss hides it for that version only.
function renderUpdateBanner(st) {
  const banner = document.getElementById("updateBanner");
  if (!banner) return;
  banner.hidden = !st.available;
  if (st.available) document.getElementById("updateBannerText").textContent = "Agent Go " + st.latest + " is available (you have " + st.current + ").";
}
(async () => {
  try {
    // Buttons first, so a banner rendered from the stored answer is never left without handlers.
    document.getElementById("updateBannerGo").addEventListener("click", async () => {
      let base = "";
      try { base = (await getSettings()).backendUrl; } catch (_e) { /* fall back to production */ }
      chrome.tabs.create({ url: downloadPageFor(base) + "/agent-go.html" });
    });
    document.getElementById("updateBannerDismiss").addEventListener("click", async () => renderUpdateBanner(await dismissUpdate()));
    renderUpdateBanner(await updateState());
    const s = await getSettings();
    renderUpdateBanner(await checkForUpdate({ backendUrl: s.backendUrl }));
  } catch (_e) { /* banner is decoration */ }
})();
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkAgentGoStatus(); });

// Processing spinner shown to non-admins while tools run (in place of the tool bubbles).
let spinnerEl = null;
let spinnerT0 = 0;      // when the CURRENT run's spinner first appeared (elapsed is run-total, not per-step)
let spinnerTimer = null;
// The spinner now lives in the PINNED #procBar (between the log and the composer), NOT appended
// to the scrolling log — so a long/multi-agent run stays visible at the bottom without scrolling
// (user: as usage tier "Analyzing… 287s" is my only 'still running' signal and it scrolled away).
function showSpinner(status) {
  // All tiers get the pinned bar (always-visible current step) PLUS the detailed tool log.
  const bar = spinnerEl || (spinnerEl = document.getElementById("procBar"));
  if (!bar) return;
  const label = status || "Working…";
  const t = bar.querySelector(".proc-status");
  if (bar.hidden) { // first show of this run → reveal the bar and start the run-total clock
    spinnerT0 = Date.now();
    bar.hidden = false;
    const tick = () => {
      if (bar.hidden) return;
      const el = bar.querySelector(".proc-elapsed");
      const secs = Math.round((Date.now() - spinnerT0) / 1000);
      if (el) el.textContent = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : `0:${String(secs).padStart(2, "0")}`;
    };
    tick();
    spinnerTimer = setInterval(tick, 1000); // cleared in hideSpinner so it never leaks between runs
  }
  if (t) t.textContent = label; // textContent → labels/URLs can't inject HTML
}
function hideSpinner() {
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  const bar = spinnerEl || document.getElementById("procBar");
  if (bar) { bar.hidden = true; const e = bar.querySelector(".proc-elapsed"); if (e) e.textContent = ""; const s = bar.querySelector(".proc-status"); if (s) s.textContent = ""; }
}
// A STATIC "Working…" for a whole multi-step run reads as slow / black-box. Map each tool
// to a short human-readable status so the pinned bar shows LIVE progress (feedback + trust).
function friendlyToolLabel(name, args) {
  let host = "";
  try { host = new URL(args && args.url).hostname.replace(/^www\./, ""); } catch (_e) { /* no url */ }
  switch (name) {
    case "web_search": {
      const q = args && args.query ? String(args.query).slice(0, 48) : "";
      return q ? `Searching “${q}”…` : "Searching the web…";
    }
    case "navigate": return host ? `Opening ${host}…` : "Opening a page…";
    case "read_page": return host ? `Reading ${host}…` : "Reading the page…";
    case "fetch_page": return host ? `Fetching ${host}…` : "Fetching a page…";
    case "capture_screenshot":
    case "desktop_screenshot": return "Looking at the screen…";
    case "spawn_subagent": return "Researching…";
    case "query_elements": return "Finding elements…";
    case "click_element": return "Clicking…";
    case "fill_input":
    case "set_editor_value":
    case "select_option": return "Filling in…";
    case "send_chat_message": return "Sending…";
    case "send_email": return "Composing email…";
    case "run_command": return "Running a command…";
    case "create_document": return "Creating a document…";
    default:
      // Phase-engine steps — especially the FINAL review/verify/summarize spin —
      // MUST tell the user what's happening, or a long silent "Working…" reads as
      // the model looping/hallucinating and they stop it mid-finalize.
      if (name && name.startsWith("phase:")) {
        const PHASE = {
          PLAN: "Planning the approach…",
          EXECUTE: "Doing the work…",
          INVARIANTS: "Checking the result…",
          REVIEW: "Reviewing the answer for accuracy…",
          REVERIFY: "Double-checking the answer…",
          REPAIR: "Refining the answer…",
          SYNTHESIZE: "Combining the results…",
          CLARIFY: "Preparing a question for you…",
          persist: "Saving progress…",
          RESUME: "Resuming…"
        };
        return PHASE[name.slice(6)] || "Finalizing and reviewing the answer…";
      }
      if (name === "self_feedback") return "Wrapping up…";
      if (name && name.startsWith("sn_")) return "Querying ServiceNow…";
      if (name && name.startsWith("desktop_")) return "Controlling the desktop…";
      return "Working…";
  }
}
// Screen-reader announcements for moments that need attention (not every streamed token). 2026-09-14 redesign.
function announce(text) {
  const el = document.getElementById("srAnnounce");
  if (!el) return;
  el.textContent = "";
  setTimeout(() => { el.textContent = text; }, 60);
}
const RISK_ICON = {
  read: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"></path><circle cx="8" cy="8" r="2"></circle></svg>',
  plan: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M5 4h8M5 8h8M5 12h8"></path><circle cx="2.5" cy="4" r="0.6"></circle><circle cx="2.5" cy="8" r="0.6"></circle><circle cx="2.5" cy="12" r="0.6"></circle></svg>',
  warn: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2l6.5 11.5h-13z"></path><path d="M8 6.5v3.2M8 11.8v.1"></path></svg>'
};
function riskBandHtml(tier, text) {
  const icon = tier === "read" ? RISK_ICON.read : tier === "plan" ? RISK_ICON.plan : RISK_ICON.warn;
  return `<div class="risk-band risk-${tier}">${icon}<span>${escapeHtml(text)}</span></div>`;
}
const STEP_ICON = {
  run: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4"></circle></svg>',
  ok: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-4.9"></path></svg>',
  fail: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3L3 9"></path></svg>'
};
function stepRowHtml(icon, label, name) {
  return `<span class="name"><span class="step-ico">${STEP_ICON[icon]}</span>${escapeHtml(label)}<span class="tool-tech">${escapeHtml(name)}</span></span>`;
}
function rawDetails(text) {
  const det = document.createElement("details");
  det.className = "tool-raw";
  const sum = document.createElement("summary");
  sum.textContent = "Details";
  const pre = document.createElement("pre");
  pre.textContent = text;
  det.append(sum, pre);
  return det;
}
const inputEl = document.getElementById("input");
const DEFAULT_PLACEHOLDER = inputEl.placeholder; // restored when idle (busy shows a steer hint)
const sendBtn = document.getElementById("send");
const clearBtn = document.getElementById("clearBtn");
const settingsBtn = document.getElementById("settingsBtn");
const statusEl = document.getElementById("status");
const statusDot = document.getElementById("statusDot");
const providerBadge = document.getElementById("providerBadge");

let history = [];          // persisted user/assistant turns
let busy = false;
let port = null;
let liveBubble = null;     // current streaming assistant bubble
let liveText = "";         // raw streamed text for the live bubble
let thinkTimer = null;     // client-side 1s "thinking… Ns" heartbeat (all providers)
let thinkT0 = 0;           // ms when the current turn started thinking
let thinkLabel = "";       // provider suffix for the heartbeat (subscription CLIs)
// Tick the live bubble once per second while the model is thinking and NOTHING
// has streamed yet — so a slow first turn (model load, or a subscription CLI
// that returns the whole reply at once) shows a moving counter instead of a
// frozen "thinking…". Cleared the instant a token streams or the turn ends.
function startThinkTimer() {
  stopThinkTimer();
  thinkT0 = Date.now();
  const tick = () => {
    if (!liveBubble || liveText) { stopThinkTimer(); return; }
    const s = Math.round((Date.now() - thinkT0) / 1000);
    liveBubble.textContent = thinkLabel
      ? `thinking… ${s}s — ${thinkLabel} returns the whole reply at once (no streaming); a big first turn can take 1–3 min`
      : (s < 8 ? `thinking… ${s}s` : `thinking… ${s}s (first reply can take 20–40s while the model loads)`);
  };
  tick();
  thinkTimer = setInterval(tick, 1000);
}
function stopThinkTimer() { if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; } }
let lastAssistantBubble = null; // last finished assistant bubble (for cleanup)
let lastAssistantActRow = null; // that bubble's Copy/.md/.docx/.pdf action row (for cleanup/rebuild)
let activeRunId = null;         // the current run's id — so a run that ENDS in error/abort (no clean
                                // "final") still gets a 👍/👎 row (the failure signal is prime RL data)
let runGotFeedbackRow = false;  // guard: don't double-add the run-level feedback row
let lastToolForFeedback = null;  // {name, args} of the in-flight tool, for per-step feedback (C.5)
let childPanels = {};            // childId -> { panel, body, liveBubble, liveText } for C.6 sub-agents
let transcript = [];             // ordered run activity (turns + tool steps + sub-agents) for rich export

// ---------- minimal, safe markdown ----------
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// Internal evidence-citation tokens like [E2.O16] / [E14.O2] are provenance the
// phase-engine gates require on every claim — verification machinery, not something
// end users should see. Strip them (with any leading space) from user-facing text
// and exports; the admin phase-report keeps them for the audit trail.
function stripCites(s) {
  return String(s == null ? "" : s).replace(/[ \t]*\[E\d+\.O\d+\]/g, "");
}
// Lightweight syntax highlighter for fenced code blocks. Tokenizes the RAW code
// (comments, strings, template literals, numbers, keywords) then escapes each
// token individually and wraps it in a color span — so highlighting never breaks
// HTML escaping. Tuned for JS / ServiceNow ES5 (the common case); other-language
// blocks still render, just escaped without colors. Colors use the design tokens.
const HL_KEYWORDS = new Set(("var let const function return if else for while do switch case break continue " +
  "new this typeof instanceof in of try catch finally throw delete void null true false undefined " +
  "class extends super default").split(" "));
// Friendly language label for the code-card header (e.g. "js" → "JavaScript").
function codeLangLabel(lang) {
  const map = { js: "JavaScript", javascript: "JavaScript", glide: "JavaScript", es5: "JavaScript", node: "JavaScript",
    ts: "TypeScript", typescript: "TypeScript", json: "JSON", jsonc: "JSON", java: "Java", py: "Python", python: "Python",
    html: "HTML", xml: "XML", css: "CSS", sh: "Shell", bash: "Shell", sql: "SQL", yaml: "YAML", yml: "YAML" };
  const k = String(lang || "").toLowerCase();
  // Own keys only: an inherited name like "constructor" must not come back as a function.
  return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : (lang ? String(lang).toUpperCase() : "Code");
}
function highlightCode(code, lang) {
  const l = String(lang || "").toLowerCase();
  const jsish = !l || /^(js|javascript|json|jsonc|ts|typescript|java|c|cpp|cs|glide|es5|node)$/.test(l);
  if (!jsish) return escapeHtml(code);
  // 2026-09-14 redesign: tokens get hl-* classes (colored per light/dark theme in theme.css)
  // instead of fixed dark-theme colors: keywords, comments, strings, numbers, Capitalized type names.
  const span = (cls, txt) => `<span class="hl-${cls}">${escapeHtml(txt)}</span>`;
  const tok = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|[A-Za-z_$][A-Za-z0-9_$]*|[^]/g;
  let out = "", m;
  while ((m = tok.exec(code))) {
    const t = m[0];
    if (t.startsWith("//") || t.startsWith("/*")) out += span("cmt", t);
    else if (/^['"`]/.test(t)) out += span("str", t);
    else if (/^\d/.test(t)) out += span("num", t);
    else if (HL_KEYWORDS.has(t)) out += span("kw", t);
    else if (/^[A-Z][A-Za-z0-9_$]*$/.test(t)) out += span("type", t); // Capitalized → class/type
    else out += escapeHtml(t);
  }
  return out;
}
// Minimal GFM table support: a header row of |cells|, a |---|---| separator row,
// then body rows → a real <table>. Runs on the already-escaped, inline-formatted
// string BEFORE the list/paragraph passes (which would otherwise mangle the
// pipes). Cells keep any inline <strong>/<code> already applied and any
// [[LCCODEBLOCK]] placeholder (restored later). This is what makes phase-report
// and SN deliverable tables (Test/Verify, Artifacts Summary) readable inline.
function mdTables(s) {
  const lines = s.split("\n");
  const isSep = (l) => l != null && l.includes("-") && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("|") && isSep(lines[i + 1])) {
      const head = cells(lines[i]);
      const body = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") { body.push(cells(lines[j])); j++; }
      // Framed table like .code-card (frame, header bar and cell lines styled per theme in theme.css,
      // 2026-09-14 redesign). The head bar carries a Copy button (delegated handler near the top of
      // this file) so every table is one-click copyable, like code cards.
      let t = '<div class="md-table-wrap"><div class="md-table-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px">'
        + '<span>Table</span><button class="table-copy" type="button" title="Copy table (pastes into spreadsheets and docs)">Copy</button></div>'
        + '<div style="overflow-x:auto"><table class="md-table" style="border-collapse:collapse;width:100%"><thead><tr>';
      t += head.map((c) => `<th style="text-align:left;border-bottom:1px solid var(--line);font-weight:600">${c}</th>`).join("") + "</tr></thead><tbody>";
      for (const r of body) t += "<tr>" + head.map((_, ci) => `<td style="border-bottom:1px solid var(--line);vertical-align:top">${r[ci] != null ? r[ci] : ""}</td>`).join("") + "</tr>";
      t += "</tbody></table></div></div>";
      out.push("", t, ""); // blank-line padding so it's its own paragraph chunk (never wrapped in <p>)
      i = j - 1;
    } else {
      out.push(lines[i]);
    }
  }
  return out.join("\n");
}
function renderMarkdown(src, opts) {
  // Strip internal evidence-citation tokens ([E2.O16]) from user-facing text —
  // the admin phase-report renders with { keepCites: true } to preserve them.
  let src0 = String(src == null ? "" : src);
  if (!(opts && opts.keepCites)) src0 = stripCites(src0);
  // fenced code blocks first. Stash each behind a collision-proof sentinel
  // (a plain-ASCII [[LCCODEBLOCK:n]] token, round-trip safe) — NOT a bare " <index> ", which would also match any plain
  // number in the prose (e.g. "3 days ago") and restore it to blocks[3] =
  // undefined → the literal word "undefined" in the rendered reply.
  const blocks = [];
  // Per-render placeholder tag, so reply text that happens to contain a marker is never replaced or deleted.
  let cbTag; // redraw until the delimiter is absent from this reply, so no reply text can collide
  do { cbTag = "LCCB" + Math.random().toString(36).slice(2, 10); } while (String(src0).includes("[[" + cbTag + ":"));
  let s = src0.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const body = highlightCode(code.replace(/\n$/, ""), lang);
    blocks.push(`<div class="code-card"><div class="code-card-head"><span class="code-lang">${escapeHtml(codeLangLabel(lang))}</span><button class="code-copy" type="button" title="Copy code">Copy</button></div><pre><code class="hl">${body}</code></pre></div>`);
    return `[[${cbTag}:${blocks.length - 1}]]`;
  });
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>");
  s = mdTables(s); // GFM tables → <table> (before lists/paragraphs would mangle the pipes)
  // unordered lists
  s = s.replace(/(?:^|\n)((?:[-*] .*(?:\n|$))+)/g, (m, list) => {
    const items = list.trim().split("\n").map((l) => `<li>${l.replace(/^[-*]\s+/, "")}</li>`).join("");
    return `\n<ul>${items}</ul>`;
  });
  // paragraphs (leave block-level elements we already produced, incl. tables, unwrapped)
  s = s.split(/\n{2,}/).map((p) => (/^\s*<(ul|ol|pre|h\d|table|div)/.test(p) || p.trimStart().startsWith("[[" + cbTag + ":") ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`)).join("");
  s = s.split("[[" + cbTag + ":").map((part, n) => {
    if (!n) return part;
    const m = part.match(/^(\d+)\]\]/);
    return m && blocks[+m[1]] != null ? blocks[+m[1]] + part.slice(m[0].length) : "[[" + cbTag + ":" + part; // unknown index: leave the text
  }).join("");
  return s;
}

// ---------- DOM helpers ----------
// The sign-in guide (owner, 2026-09-04): a run that reaches the backend without a session
// used to die with a bare "Not signed in to Agent Go." AFTER the packs and the thinking
// spinner had run. Now the panel checks the session BEFORE starting a run and, whenever
// that 401 surfaces anywhere, shows the exact clicks plus a button that opens Settings.
function signUpBase() {
  try {
    const u = new URL(String(DEFAULTS.backendUrl || ""));
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return "http://localhost:3000";
  } catch {}
  return "https://ai.nowidevops.com";
}
function signInGuide(reason) {
  const d = bubble("msg error signin");
  d.innerHTML =
    '<div class="signin-title">⚠ ' + escapeHtml(reason || "Not signed in to Agent Go") + ' — sign in first, then send your message again.</div>' +
    '<ol class="signin-steps">' +
      '<li>Click <b>⚙ Settings</b> at the top right of this panel (or the button below).</li>' +
      '<li>In the <b>Account</b> card, type the <b>email</b> and <b>password</b> of your Agent Go account.</li>' +
      '<li>Click <b>Sign in</b>. The card switches to your email and plan badge when it worked.</li>' +
      '<li>Come back to this panel and send your message again.</li>' +
    '</ol>' +
    '<div class="signin-actions">' +
      '<button type="button" class="signin-open">Open Settings</button>' +
      '<button type="button" class="signin-create secondary">No account? Create one</button>' +
    '</div>' +
    '<div class="signin-hint">Forgot the password? Use "Forgot password" on the sign-in page. It is the same account you use on the Agentic Copilot site (ai.nowidevops.com).</div>';
  d.querySelector(".signin-open").addEventListener("click", () => chrome.runtime.openOptionsPage());
  d.querySelector(".signin-create").addEventListener("click", () => chrome.tabs.create({ url: signUpBase() + "/signup" }));
  logEl.scrollTop = logEl.scrollHeight;
  return d;
}
// Storage-only presence check (review 2026-09-04, F2): no network hop before the run, so a
// hung /auth/refresh cannot wedge `submitting` and the user-gesture window for the folder
// re-grant below stays intact. A stale token is the backend's call (it 401s; see the error case).
async function signedIn() {
  try { const a = await getAuth(); return !!(a && a.idToken); } catch { return true; }
}

function bubble(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
  return d;
}
function toolStart(name, args) {
  showSpinner(friendlyToolLabel(name, args)); // pinned current-step for BOTH tiers
  // Full parity with local-claude-extension (2026-07-30): tool bubbles show for ALL tiers.
  const d = document.createElement("div");
  d.className = "tool";
  d.innerHTML = stepRowHtml("run", friendlyToolLabel(name, args), name); // plain-language label; raw args under Details
  if (args && Object.keys(args).length) {
    d.appendChild(rawDetails(JSON.stringify(args)));
  }
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}
function toolResult(name, result, meta = {}) {
  showSpinner("Thinking…"); // pinned current-step for BOTH tiers
  // Full parity (2026-07-30): tool results show for ALL tiers.
  const ok = !(result && result.error);
  const d = document.createElement("div");
  d.className = "tool " + (ok ? "ok" : "fail");
  const label = friendlyToolLabel(name, meta.args).replace(/…$/, "");
  d.innerHTML = stepRowHtml(ok ? "ok" : "fail", ok ? `${label}: done` : `${label}: failed`, name);
  d.appendChild(rawDetails(JSON.stringify(result, null, 1).slice(0, 1400)));
  // Per-step 👍/👎 REMOVED (user 2026-07-18: "too many thumbs"). The ONLY feedback control is now the
  // single run-level 👍/👎 shown ONCE on the final response (responseActions / appendRunFeedback).
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

// Compact 👍/👎 under a tool result. 👎 immediately distills a focused lesson
// from THAT step (no need to wait for the run to finish); both labels are merged
// into the run's trajectory for training export.
function stepFeedbackBar({ runId, stepIndex, step }) {
  const row = document.createElement("div");
  row.className = "fb-row";
  const up = document.createElement("button");
  up.textContent = "👍";
  up.title = "This step was good";
  const down = document.createElement("button");
  down.textContent = "👎";
  down.title = "This step was wrong — learn a lesson from it";
  const note = document.createElement("span");
  note.className = "fb-note";
  const send = async (value) => {
    up.disabled = down.disabled = true;
    (value > 0 ? up : down).classList.add("chosen");
    note.textContent = value > 0 ? "noted" : "learning…";
    try {
      const res = await chrome.runtime.sendMessage({ type: "step_feedback", runId, stepIndex, value, step });
      if (value < 0) note.textContent = res?.lesson ? `learned: "${res.lesson}"` : "noted";
      else note.textContent = "thanks!";
      transcript.push({ t: "feedback", scope: "step", stepIndex, value, name: step?.name, lesson: res?.lesson });
    } catch { note.textContent = "saved"; }
    convLogSave(); // feedback is the reinforcement signal — persist it too
  };
  up.addEventListener("click", () => send(1));
  down.addEventListener("click", () => send(-1));
  row.append(up, down, note);
  return row;
}

// ---------- C.6: sub-agent panels ----------
// Each child agent gets its own collapsible-ish panel; its events (streamed via a
// `childId`) render INSIDE that panel, indented, instead of the main log.
function getChildPanel(childId) {
  if (childPanels[childId]) return childPanels[childId];
  const panel = document.createElement("div");
  panel.className = "tool";
  panel.style.borderLeft = "2px solid var(--accent-purple, #C586C0)";
  const head = document.createElement("div");
  head.className = "name";
  head.textContent = `▸ Sub-agent ${childId}`;
  const body = document.createElement("div");
  body.style.marginLeft = "10px";
  panel.append(head, body);
  logEl.appendChild(panel);
  const rec = { panel, body, head, liveBubble: null, liveText: "", lastArgs: null };
  childPanels[childId] = rec;
  return rec;
}

function handleChildEvent(m) {
  const cp = getChildPanel(m.childId);
  switch (m.type) {
    case "assistant_start":
      cp.liveBubble = document.createElement("div");
      cp.liveBubble.className = "msg assistant caret";
      cp.liveText = "";
      cp.body.appendChild(cp.liveBubble);
      break;
    case "token":
      if (!cp.liveBubble) { cp.liveBubble = document.createElement("div"); cp.liveBubble.className = "msg assistant caret"; cp.body.appendChild(cp.liveBubble); }
      cp.liveText += m.delta;
      cp.liveBubble.textContent = cp.liveText;
      break;
    case "assistant_end":
      if (cp.liveBubble) {
        cp.liveBubble.classList.remove("caret");
        if (cp.liveText.trim()) cp.liveBubble.innerHTML = renderMarkdown(cp.liveText);
        else cp.liveBubble.remove();
      }
      cp.liveBubble = null;
      break;
    case "tool": {
      cp.lastArgs = m.args;
      transcript.push({ t: "child_tool", childId: m.childId, name: m.name, args: m.args });
      showSpinner(friendlyToolLabel(m.name, m.args)); // pinned current-step for BOTH tiers
      // Full parity (2026-07-30): child tool calls show for ALL tiers.
      const row = document.createElement("div");
      row.className = "tool";
      row.innerHTML = `<span class="name">⚙ ${escapeHtml(m.name)}</span>`;
      cp.body.appendChild(row);
      break;
    }
    case "tool_result": {
      transcript.push({ t: "child_tool_result", childId: m.childId, name: m.name, result: m.result });
      showSpinner("Analyzing…"); // pinned current-step for BOTH tiers
      // Full parity (2026-07-30): child tool results show for ALL tiers.
      const ok = !(m.result && m.result.error);
      const row = document.createElement("div");
      row.className = "tool " + (ok ? "ok" : "fail");
      row.innerHTML = `<span class="name">${ok ? "✓" : "✗"} ${escapeHtml(m.name)}</span>`;
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(m.result, null, 1).slice(0, 900);
      row.appendChild(pre);
      if (m.runId != null && Number.isInteger(m.stepIndex)) {
        row.appendChild(stepFeedbackBar({ runId: m.runId, stepIndex: m.stepIndex, step: { name: m.name, args: cp.lastArgs, result: m.result } }));
      }
      cp.body.appendChild(row);
      break;
    }
    case "approval_request":
      // Reuse the approval card, rendered inside the child's panel and labeled.
      approvalCard(m.id, m.name, m.args, cp.body, `Sub-agent ${m.childId}: `);
      break;
    case "final": {
      // The child's result was already streamed into its bubble (assistant_end),
      // so DON'T re-render m.text here — just mark the sub-agent done.
      transcript.push({ t: "child_final", childId: m.childId, text: m.text || "" });
      const done = document.createElement("div");
      done.className = "fb-note";
      done.textContent = `✓ Sub-agent ${m.childId} done`;
      cp.body.appendChild(done);
      break;
    }
    case "error": {
      const e = document.createElement("div");
      e.className = "msg error";
      e.textContent = "⚠ " + (m.text || "sub-agent error");
      cp.body.appendChild(e);
      break;
    }
    // assistant_retry / rewrite_assistant / aborted: nothing useful to show per-child
  }
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- persistence ----------
async function saveHistory() {
  try { await chrome.storage.local.set({ history }); } catch {}
}
// Empty state (2026-09-14 redesign): heading plus the original welcome message.
// The "Try a task" example list was removed at the owner's request (2026-09-14).
function renderEmptyState() {
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  const h = document.createElement("h2");
  h.className = "empty-title";
  h.textContent = "What should we get done?";
  const welcome = document.createElement("div");
  welcome.className = "msg assistant empty-welcome";
  welcome.innerHTML = renderMarkdown(
    "Hi! I'm **Agent Go**, a cloud browser agent. Ask about this page, or tell me to find / click / fill things. I can also **screenshot** the page and read it with a vision model. Inference runs in the Agent Go cloud."
  );
  wrap.append(h, welcome); // note removed at the owner's request (2026-09-14)
  logEl.appendChild(wrap);
}

// After the first message the examples and promise go away; the original welcome bubble stays, as before the redesign.
function collapseEmptyState() {
  const wrap = logEl.querySelector(".empty-state");
  if (!wrap) return;
  const welcome = wrap.querySelector(".empty-welcome");
  if (welcome) wrap.replaceWith(welcome); else wrap.remove();
}

async function loadHistory() {
  try {
    const { history: h } = await chrome.storage.local.get("history");
    history = Array.isArray(h) ? h : [];
  } catch { history = []; }
  // Seed the export transcript from restored turns (plain); live runs append rich activity.
  transcript = history.map((m) => ({ t: m.role === "user" ? "user" : "assistant", text: m.content }));
  logEl.innerHTML = "";
  if (!history.length) {
    renderEmptyState();
    return;
  }
  let askBefore = ""; // the request each restored reply answered (names its export files)
  for (const m of history) {
    if (m.role === "user") { askBefore = m.content; bubble("msg user", m.content); }
    else {
      bubble("msg assistant").innerHTML = renderMarkdown(m.content);
      responseActions(m.content, null, undefined, askBefore); // export controls (no feedback on restored turns)
    }
  }
}

// ---------- status ----------
// Header badge: which brain is actually answering — local Ollama (private) vs a
// cloud provider (data leaves the machine), or a cloud provider selected without
// a key (which silently falls back to Ollama).
const PROVIDER_NAME = { openai: "OpenAI", gemini: "Gemini", anthropic: "Claude", xai: "Grok", "claude-sub": "Claude Max", "codex-sub": "ChatGPT", custom: "Custom API" };
const PROVIDER_VENDOR = { openai: "OpenAI", gemini: "Google", anthropic: "Anthropic", xai: "xAI", "claude-sub": "Anthropic", "codex-sub": "OpenAI", custom: "the custom endpoint host you configured" };

const BYOK_BADGE_NAME = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", xai: "xAI", custom: "Custom endpoint" };
function updateProviderBadge(s, prov, byok) {
  if (!providerBadge) return;
  // Header badge (owner request 2026-09-03, parity with Local LLM's "☁ Ollama Cloud"): which brain
  // answers. Agent Go models run on the Agent Go service; under BYOK the user's own provider and
  // model do, and the badge says so (with the host for a custom endpoint).
  if (byok && byok.provider) {
    let host = "";
    if (byok.provider === "custom" && byok.baseUrl) { try { host = new URL(byok.baseUrl).hostname; } catch (_e) { host = ""; } }
    providerBadge.hidden = false;
    providerBadge.className = "provider-badge cloud byok";
    providerBadge.textContent = "Your key · " + (BYOK_BADGE_NAME[byok.provider] || byok.provider) + (byok.model ? " · " + byok.model : "");
    providerBadge.title = "Bring your own key: turns run on " + (host || BYOK_BADGE_NAME[byok.provider] || byok.provider) + " with your key and model " + (byok.model || "") + ". Model/token usage is billed to your provider account; Agent Go charges a flat trigger fee per turn.";
  } else {
    providerBadge.hidden = false;
    providerBadge.className = "provider-badge cloud";
    providerBadge.textContent = "Agent Go cloud · " + (s && s.model ? s.model : "auto model");
    providerBadge.title = "Agent Go cloud — inference runs on the Agent Go service" + (s && s.model ? " (" + s.model + ")" : " (auto model)") + ". Page content the agent reads is sent there.";
  }
  // Agent Go footer parity (2026-07-19): mirror the active model id into the
  // mode-row's bottom-right indicator. Null-guarded — purely cosmetic, and a
  // missing span (old HTML) or field can never break the badge update above.
  try {
    const am = document.getElementById("activeModel");
    if (am) {
      const cloudSel = s.provider === "openai" || s.provider === "gemini" || s.provider === "anthropic" ||
        s.provider === "xai" || s.provider === "claude-sub" || s.provider === "codex-sub" || s.provider === "custom";
      am.textContent = (cloudSel && prov !== "ollama") ? (s.cloudModel || PROVIDER_NAME[s.provider] || "") : (s.model || "");
    }
  } catch { /* cosmetic only */ }
}

// LOCAL-FILES RECONNECT STRIP (Agent Go footer parity, 2026-07-19f): the folder
// HANDLE persists in IndexedDB, but Chrome resets the read/write PERMISSION on a
// browser restart (File System Access security rule — a page can't silently
// regain disk access without a user gesture; there is no API to bypass this).
// Instead of the agent failing mid-task, surface ONE minimalist strip at the
// VERY bottom of the footer — amber dot + "Local file access to "X" lapsed" +
// a Reconnect link whose click IS the required gesture. Shown only when a
// handle exists AND its grant lapsed; hidden otherwise. Ported verbatim from
// Agent Go (llm-go extension) — same helper names in this codebase.
let lfBanner = null;
function ensureLfBanner() {
  if (lfBanner) return lfBanner;
  const b = document.createElement("div");
  b.id = "lfReconnectBanner";
  b.hidden = true;
  b.style.cssText = "display:flex;align-items:center;gap:7px;margin:8px -12px -14px;padding:5px 11px;"
    + "background:var(--bg-secondary);border-top:1px solid var(--border-color);"
    + "font-size:11px;color:var(--text-secondary);";
  const dot = document.createElement("span");
  dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:var(--accent-orange);flex:none;";
  const txt = document.createElement("span");
  txt.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  const btn = document.createElement("button");
  btn.textContent = "Reconnect";
  btn.style.cssText = "flex:none;background:transparent;border:none;color:var(--accent-orange);"
    + "font-size:11px;font-weight:600;cursor:pointer;padding:0;font-family:inherit;";
  b.append(dot, txt, btn);
  b._txt = txt; b._btn = btn;
  const footer = document.querySelector("footer");
  if (footer) footer.appendChild(b); // the VERY bottom of the panel (below the composer + mode row)
  else logEl.parentNode.insertBefore(b, logEl.nextSibling);
  lfBanner = b;
  return b;
}
// Connected folders whose read/write grant is NOT live right now (queryPermission
// only — no gesture, safe anywhere). Every root, not just the first: with 5
// folders connected the banner used to watch "_RESUME" alone while the run's
// target folder "STRY0000001_RESEARCH" sat lapsed (2026-09-02 a-live-run).
async function lapsedRoots() {
  const roots = await getRootHandles().catch(() => []);
  const out = [];
  for (const h of roots) if (!(await hasWritePermission(h).catch(() => false))) out.push(h);
  return out;
}

// Re-grant lapsed folders INSIDE a user gesture (requestPermission needs one).
// `preferNames` go first — the folder the task names is the one that matters, and
// Chrome's transient activation (~5s) may not outlast several prompts in a row.
// Returns { granted:[names], still:[names] }.
async function regrantLapsed(lapsed, preferNames = []) {
  const prefer = preferNames.map((n) => String(n).toLowerCase());
  const ordered = [...lapsed].sort((a, b) => {
    const ia = prefer.indexOf(a.name.toLowerCase()), ib = prefer.indexOf(b.name.toLowerCase());
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const granted = [], still = [];
  for (const h of ordered) {
    let ok = false;
    try { ok = await ensureReadWritePermission(h); } catch { ok = false; } // SecurityError once activation expires
    (ok ? granted : still).push(h.name);
  }
  return { granted, still };
}

// Folder names the task text refers to — a path like
// C:\redacted\path
// its last segment, and a bare folder name counts too.
function rootNamesMentioned(text, roots) {
  const t = String(text || "").toLowerCase();
  return roots.filter((h) => h.name && t.includes(h.name.toLowerCase())).map((h) => h.name);
}

let lfChecking = false; // re-entrancy guard so the poll + events can't overlap
async function checkLocalFilesGrant() {
  if (lfChecking) return;
  lfChecking = true;
  try {
    const roots = await getRootHandles().catch(() => []);
    if (!roots.length) { if (lfBanner) lfBanner.hidden = true; return; }     // nothing connected
    const lapsed = await lapsedRoots();
    if (!lapsed.length) { if (lfBanner) lfBanner.hidden = true; return; }    // every grant live
    const banner = ensureLfBanner();
    const names = lapsed.map((h) => `"${h.name}"`).join(", ");
    banner._txt.textContent = lapsed.length === 1
      ? `Local file access to ${names} lapsed`
      : `Local file access lapsed for ${lapsed.length} of ${roots.length} folders: ${names}`;
    banner._btn.title = "Chrome resets folder access after a restart — click to re-grant read/write (one prompt per folder).";
    banner._btn.onclick = async () => {
      const r = await regrantLapsed(lapsed);
      if (r.granted.length) bubble("msg note", `✓ Local files access re-granted for ${r.granted.map((n) => `"${n}"`).join(", ")} (read/write). The agent can read, organize, and write there again.`);
      if (r.still.length) bubble("msg error", `⚠ Still not re-granted: ${r.still.map((n) => `"${n}"`).join(", ")}. Click Reconnect again (Chrome allows a limited number of prompts per click), or open 📁 Local files (MCP) to disconnect a folder.`);
      checkLocalFilesGrant();
    };
    banner.hidden = false;
  } finally {
    lfChecking = false;
  }
}
// DYNAMIC refresh (2026-07-19, user: "it should not be static but dynamic"):
// the strip reflects the LIVE grant state, not just the load/tab-switch snapshot.
// (1) on panel open; (2) on visibility/focus regain; (3) a light poll WHILE the
// panel is visible so a grant that lapses OR is restored mid-session (e.g. the
// folder reconnected via the 📁 menu, or a run that just re-granted) updates the
// strip within a couple seconds without a tab switch. queryPermission is a cheap
// async check (no gesture, no disk IO); the poll pauses while the panel is hidden.
checkLocalFilesGrant(); // on panel open (incl. the fresh load after a browser restart)
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkLocalFilesGrant(); });
window.addEventListener("focus", () => checkLocalFilesGrant());
setInterval(() => { if (!document.hidden) checkLocalFilesGrant(); }, 3000);

async function checkStatus() {
  const s = await getSettings();
  Object.assign(s, await getCloudCreds()); // keys (storage.local) decide the effective provider
  const prov = activeProvider(s);
  // BYOK-aware: under BYOK the turn runs on the user's own model (byok.model), not s.model.
  const _byok = await getByok().catch(() => null);
  updateProviderBadge(s, prov, _byok);
  _activeModelId = (_byok && _byok.model) ? _byok.model : (s.model || "Auto"); renderActiveModel(busy); // bottom-right model indicator

  const search = s.autoWebSearch !== false ? "🔎 search auto" : "🔎 search manual";

  // Cloud provider active: don't ping Ollama (it may not even be running).
  if (prov !== "ollama") {
    statusDot.className = "dot ok";
    // Info line removed at user request — the header dot shows connection; the
    // model / vision / search / egress details live in ⚙ Settings. Hide the strip.
    statusEl.hidden = true;
    statusEl.textContent = "";
    return;
  }

  statusEl.hidden = false; // Ollama mode keeps its model / status / error line
  try {
    const models = await listModels(s.ollamaBase);
    const hasModel = models.includes(s.model);
    const hasVision = models.includes(s.visionModel);
    statusDot.className = "dot " + (hasModel ? "ok" : "bad");
    // ollama-cloud still goes through the local daemon (so we ping it + check the
    // model is registered), but the model runs on Ollama's servers — note egress.
    const egress = s.provider === "ollama-cloud" ? " · ⚠ Ollama cloud — page data leaves this machine" : "";
    statusEl.textContent = `${s.model}${hasModel ? "" : " ⚠ not installed"} · vision: ${s.visionModel}${hasVision ? "" : " ⚠ missing"} · ${search}${egress}`;
  } catch (e) {
    statusDot.className = "dot bad";
    statusEl.textContent = `Cannot reach Ollama at ${s.ollamaBase}. Is it running? Did you set OLLAMA_ORIGINS? (see README)`;
  }
}

// Refresh the badge + status line live when settings or cloud keys change in the
// Options page (chrome.storage fires across extension pages).
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" && changes.settings) || (area === "local" && changes.cloudCreds)) {
    checkStatus();
  }
  if (area === "sync" && changes.uiTheme) renderAppearance(changes.uiTheme.newValue);
});

// ---------- agent run ----------
// Heartbeat: a live elapsed counter that ticks every second while the agent is
// busy, so the user can see it's alive even when the model is silently loading
// or generating with no streamed tokens.
const workingEl = document.getElementById("working");
const workSecsEl = document.getElementById("workSecs");
let workStart = 0;
let workTimer = null;
function tickWork() {
  const s = Math.floor((Date.now() - workStart) / 1000);
  workSecsEl.textContent = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
// Bottom-right active-model indicator: shows the model that runs your requests (green + dot while
// a turn is active). `_activeModelId` is refreshed by checkStatus() from the selected model.
let _activeModelId = "";
function shortModel(m) { return String(m || "").replace(/^llmgo:/, ""); }
function renderActiveModel(running) {
  const el = document.getElementById("activeModel");
  if (!el) return;
  el.className = "active-model" + (running ? " running" : "");
  el.innerHTML = _activeModelId ? ((running ? '<span class="am-dot"></span>' : "") + escapeHtml(shortModel(_activeModelId))) : "";
  el.title = "Active model — " + (_activeModelId || "unknown") + (running ? " (running your request)" : "");
}
function setBusy(state) {
  busy = state;
  renderActiveModel(state); // reflect run start/stop on the model indicator
  // Keep the input ENABLED during a run so the user can steer ("/btw") mid-task.
  inputEl.disabled = false;
  inputEl.placeholder = state ? "Type to steer the agent — it'll adjust on its next step (Enter)…" : DEFAULT_PLACEHOLDER;
  // Circular pill end-cap (Agent Go footer parity 2026-07-19): glyphs, not words
  // — "Send"/"Stop" don't fit a 36px circle. Accessible name kept in title/aria.
  sendBtn.textContent = state ? "■" : "↑";
  sendBtn.title = state ? "Stop" : "Send";
  sendBtn.setAttribute("aria-label", state ? "Stop" : "Send");
  sendBtn.classList.toggle("stop", state);
  if (state) {
    workStart = Date.now();
    tickWork();
    workingEl.classList.add("on");
    showSpinner("Thinking…");
    if (!workTimer) workTimer = setInterval(tickWork, 1000);
  } else {
    workingEl.classList.remove("on");
    hideSpinner();
    if (workTimer) { clearInterval(workTimer); workTimer = null; }
  }
}

// Plan-first: track the live approval card + the run's model override, so a new
// message/plan supersedes a stale card and approval reuses the same model.
let activePlanCard = null;
let pendingModelOverride = null;
function invalidatePlanCard() {
  if (!activePlanCard) return;
  activePlanCard.querySelectorAll("button").forEach((b) => (b.disabled = true));
  activePlanCard.classList.add("superseded");
  const n = document.createElement("div");
  n.className = "approval-done";
  n.textContent = "⚠ Superseded — a newer message/plan replaced this one";
  activePlanCard.appendChild(n);
  activePlanCard = null;
}

// Draft approval: one-click "APPROVED — SEND IT" card shown after a run that
// left a draft_chat_message in the compose box. Clicking it submits the EXACT
// approval phrase as a normal user message, so the send still flows through the
// injected pack's approval gate (and the phrase stays in the transcript as the
// audit record). Offered when the Teams pack OR the Slack pack (approval gate
// added 2026-07-24 for parity) injected the run — both use the same phrase.
const TEAMS_APPROVAL_PHRASE = "APPROVED — SEND IT";
let pendingDraftApproval = null;  // { draft } captured from the draft tool result
let teamsPackActiveRun = false;   // did teams_auto_reply_pack inject THIS run?
let slackPackActiveRun = false;   // did slack_auto_reply_pack inject THIS run?
let activeDraftCard = null;
function invalidateDraftCard() {
  if (!activeDraftCard) return;
  activeDraftCard.querySelectorAll("button").forEach((b) => (b.disabled = true));
  activeDraftCard.classList.add("superseded");
  const n = document.createElement("div");
  n.className = "approval-done";
  n.textContent = "⚠ Superseded — a newer message replaced this draft approval";
  activeDraftCard.appendChild(n);
  activeDraftCard = null;
}

function draftApprovalCard(info) {
  invalidateDraftCard(); // only one live draft card at a time
  const d = document.createElement("div");
  d.className = "tool approval";
  d.innerHTML = riskBandHtml("send", "Sends a message as you") + `<span class="name">Draft is in the compose box. Send it?</span>`;
  if (info.draft) {
    const pre = document.createElement("pre");
    pre.textContent = info.draft;
    d.appendChild(pre);
  }
  const row = document.createElement("div");
  row.className = "approval-actions";
  const go = document.createElement("button");
  go.className = "allow";
  go.textContent = "APPROVED — SEND IT";
  const keep = document.createElement("button");
  keep.className = "deny";
  keep.textContent = "Don't send";
  const finish = (msg) => {
    go.disabled = keep.disabled = true;
    activeDraftCard = null; // acted on — no longer "live"
    const n = document.createElement("div");
    n.className = "approval-done";
    n.textContent = msg;
    d.appendChild(n);
  };
  go.addEventListener("click", () => {
    if (busy) { bubble("msg note", "The previous run is still closing — click again in a moment."); return; }
    finish("✓ Approved — sending");
    run(TEAMS_APPROVAL_PHRASE);
  });
  keep.addEventListener("click", () => finish("✗ Not sent — the draft stays in the compose box; edit or send it there yourself"));
  row.append(go, keep);
  d.appendChild(row);
  activeDraftCard = d;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function run(text, modelOverride) {
  collapseEmptyState();                         // examples must not linger or overwrite a later draft
  invalidatePlanCard();                          // a new message supersedes any pending plan
  invalidateDraftCard();                         // no-op for the approve click (finish() already closed it)
  teamsPackActiveRun = slackPackActiveRun = false; // re-set by this run's pack injection events
  if (resumeBarEl) { resumeBarEl.remove(); resumeBarEl = null; } // ...and any resume offer
  pendingModelOverride = modelOverride || null;  // reused by the execute run after approval
  // While the meeting listener is on, ground the prompt in the live transcript
  // (the bubble shows what was typed; the model gets the transcript tail too).
  const listenCtx = getListenContext();
  history.push({ role: "user", content: listenCtx ? text + listenCtx : text });
  transcript.push({ t: "user", text });          // export record
  const userBubble = bubble("msg user", text);

  // Show + send any attached images (screenshots or picked files).
  const atts = attachments;
  if (atts.length) {
    for (const a of atts) {
      const img = document.createElement("img");
      img.className = "sent-img";
      img.src = a.dataUrl;
      userBubble.appendChild(img);
    }
    attachments = [];
    renderChips();
  }

  saveHistory();
  startAgentRun({
    type: "run",
    history,
    attachments: atts.length ? atts.map((a) => ({ base64: a.base64, name: a.name })) : undefined,
    modelOverride: modelOverride || undefined,
    planFirst: actMode === "plan" // Plan-first mode: model drafts a plan and waits for approval
  });
}

// Approve a presented plan: re-run with the plan in history and tools enabled,
// without pushing a new user message/bubble.
// Returns true only if execution actually started (so the card stays clickable
// to retry if we bail on the busy/stale guards).
function executeApprovedPlan() {
  if (busy) { bubble("msg note", "The previous run is still closing — click Approve again in a moment."); return false; }
  const last = history[history.length - 1];
  if (!last || last.role !== "assistant" || !String(last.content || "").trim()) {
    bubble("msg error", "⚠ This plan is out of date (a newer message was sent). Send your request again to get a fresh plan.");
    return false;
  }
  startAgentRun({ type: "run", history, executePlan: true, modelOverride: pendingModelOverride || undefined });
  return true;
}

// Open the agent port, send the payload, and wire all streaming/result events.
function startAgentRun(payload) {
  collapseEmptyState(); // also covers Resume, which does not go through run()
  setBusy(true);
  schedHalted = false; // a new run re-arms the queue: its "done" drains it
  updateSchedBanner(); // ...and repaint now, so the "paused" text doesn't linger through the whole run
  liveBubble = null;
  liveText = "";
  childPanels = {}; // C.6: fresh run → fresh sub-agent panels

  const runPort = chrome.runtime.connect({ name: "agent" });
  port = runPort;
  runPort.postMessage(payload);

  runPort.onMessage.addListener((m) => {
    if (port !== runPort) return; // ignore events from a superseded run (race guard)
    if (m.childId) { handleChildEvent(m); return; } // C.6: route sub-agent events into their panel
    if (m.runId != null) { if (m.runId !== activeRunId) runGotFeedbackRow = false; activeRunId = m.runId; } // track run id; reset the feedback guard on a NEW run
    switch (m.type) {
      case "assistant_start":
        liveBubble = bubble("msg assistant caret");
        liveText = "";
        thinkLabel = "";
        startThinkTimer(); // ticking "thinking… Ns" until the first token / turn end
        break;
      case "assistant_retry":
        // A transient tool-call/template error; the turn is being re-rolled.
        if (!liveBubble) liveBubble = bubble("msg assistant caret");
        liveText = "";
        thinkLabel = "";
        liveBubble.textContent = `tool-call hiccup — retrying (${m.attempt}/2)…`;
        startThinkTimer(); // resume the heartbeat for the re-rolled turn
        break;
      case "token":
        hideSpinner(); // answer is streaming — drop the processing spinner
        if (!liveBubble) liveBubble = bubble("msg assistant caret");
        stopThinkTimer(); // real text is streaming now — the counter's job is done
        liveText += m.delta;
        liveBubble.textContent = liveText;
        logEl.scrollTop = logEl.scrollHeight;
        break;
      case "assistant_working":
        // Subscription CLIs (Claude/Codex) DON'T stream — they return the whole
        // turn at once. This event just tells us WHICH provider so the 1s
        // client-side heartbeat can name it; the tick itself owns the seconds.
        if (!liveBubble) { liveBubble = bubble("msg assistant caret"); liveText = ""; }
        thinkLabel = m.provider || "subscription";
        if (!thinkTimer && !liveText) startThinkTimer();
        break;
      case "assistant_end":
        stopThinkTimer();
        if (liveBubble) {
          liveBubble.classList.remove("caret");
          if (liveText.trim()) liveBubble.innerHTML = renderMarkdown(liveText);
          else liveBubble.remove(); // model went straight to a tool with no preface
          lastAssistantBubble = liveText.trim() ? liveBubble : null;
          // Export lives ONLY on the FINAL answer (added in the `final` case below).
          // Intermediate reasoning bubbles no longer each get an export row — that
          // stacked up many buttons + big blank gaps down a multi-step run.
          lastAssistantActRow = null;
        }
        liveBubble = null;
        break;
      case "rewrite_assistant":
        // The model wrote a tool call as text; replace the shown markup with
        // the cleaned preface (or remove the bubble if nothing's left).
        if (lastAssistantBubble) {
          if (lastAssistantActRow) { lastAssistantActRow.remove(); lastAssistantActRow = null; }
          if (m.text && m.text.trim()) {
            lastAssistantBubble.innerHTML = renderMarkdown(m.text);
            lastAssistantActRow = null; // export only on the final answer, not intermediate replies
          } else {
            lastAssistantBubble.remove();
          }
          lastAssistantBubble = null;
        }
        break;
      case "approval_request":
        approvalCard(m.id, m.name, m.args);
        announce(`Approval needed: ${RISK_META[riskTier(m.name, m.args) === "read" ? "review" : riskTier(m.name, m.args)].label}`);
        break;
      case "tool":
        lastToolForFeedback = { name: m.name, args: m.args }; // pair with the next tool_result for per-step feedback
        transcript.push({ t: "tool", name: m.name, args: m.args });
        toolStart(m.name, m.args);
        break;
      case "tool_result":
        transcript.push({ t: "tool_result", name: m.name, result: m.result });
        toolResult(m.name, m.result, { stepIndex: m.stepIndex, runId: m.runId, args: lastToolForFeedback?.args });
        // Draft-approval plumbing (Teams + Slack — both packs share the phrase gate).
        if (m.name === "teams_auto_reply_pack" && m.result?.ok) teamsPackActiveRun = true;
        if (m.name === "slack_auto_reply_pack" && m.result?.ok) slackPackActiveRun = true;
        if (m.name === "draft_chat_message" && m.result?.drafted && !m.result?.sent) {
          pendingDraftApproval = { draft: String(m.result.draft || "") };
        }
        if (m.name === "send_chat_message" && m.result?.sent) pendingDraftApproval = null; // already sent — nothing to approve
        break;
      case "final":
        hideSpinner();
        if (m.text && m.text.trim()) {
          history.push({ role: "assistant", content: m.text });
          transcript.push({ t: "assistant", text: m.text });
          saveHistory();
          // The ONLY export/feedback row for the run goes here, on the final answer
          // (runId-bound: 👍/👎 + Export ▾ + deliverables). Clear any stale ref first.
          if (lastAssistantActRow) { lastAssistantActRow.remove(); lastAssistantActRow = null; }
          responseActions(m.text, m.runId, m.phaseMeta); // phaseMeta → phase-report export (P1-3)
          maybePhaseReportInline(m.phaseMeta); // admin tier: full audit readable inline (no download needed)
          maybeSpeak(m.text); // meeting listener: voice the reply when "speak" is on
        } else {
          // Empty turn: the model produced no text (often after running tools, or
          // a degenerate generation). Don't persist a blank bubble — explain it.
          bubble("msg note", "↳ The model ended the turn without a text reply. If it performed actions, check the tab; otherwise try rephrasing or give it a starting URL (e.g. \"Go to signup.live.com and …\").");
        }
        break;
      case "plan":
        // Plan-first mode: the model drafted a plan (already rendered via the
        // streamed bubble). Persist it and wait for the user's approval.
        if (m.text && m.text.trim()) {
          history.push({ role: "assistant", content: m.text });
          transcript.push({ t: "plan", text: m.text });
          saveHistory();
          planCard();
        } else {
          bubble("msg note", "↳ The model returned an empty plan. Try rephrasing your request, or switch to Ask/Auto mode.");
        }
        break;
      case "resumed":
        bubble("msg note", `↻ Resumed the previous run at step ${m.step}. Earlier steps already ran — continuing from where it left off.`);
        break;
      case "steer_applied":
        bubble("msg note", "↪ Got it — factoring that in now.");
        break;
      case "continued":
        // TRUNCATION CONTINUATION (2026-09-03): the final answer hit the output limit; the next bubble continues it.
        bubble("msg note", `↳ The answer was cut off (${m.why}) — continuing where it stopped (${m.n}/2)…`);
        break;
      case "aborted":
        hideSpinner();
        stopThinkTimer();
        bubble("msg note", "⏹ Stopped.");
        appendRunFeedback(activeRunId, "Rate this run (helps training): ");
        break;
      case "error":
        hideSpinner();
        stopThinkTimer();
        announce("Error: " + m.text);
        // Both 401 texts get the guide (review 2026-09-04, F1): the pre-flight's "Not signed in"
        // and the backend's "Session expired" (stale token after a failed refresh). No run rating
        // on either: nothing ran.
        if (/Not signed in to Agent Go|Session expired/i.test(String(m.text || ""))) { signInGuide(/Session expired/i.test(String(m.text || "")) ? "Your session expired" : "Not signed in to Agent Go"); break; }
        bubble("msg error", "⚠ " + m.text);
        // If the failure was the service being unavailable (503), re-check /status now so the
        // maintenance banner appears immediately (master kill) instead of waiting for the poll.
        if (/\b503\b|temporarily unavailable/i.test(String(m.text || ""))) checkAgentGoStatus();
        appendRunFeedback(activeRunId, "Rate this run (helps training): ");
        break;
      case "done":
        hideSpinner();
        // Universal catch-all: EVERY finished run must be rateable for RL, no matter how it ended.
        // No-op if a final/error/abort already added the row (runGotFeedbackRow) or there's no runId.
        appendRunFeedback(activeRunId, "Rate this run (helps training): ");
        stopThinkTimer();
        setBusy(false);
        announce("Run finished");
        try { runPort.disconnect(); } catch {}
        if (port === runPort) port = null;
        // Run left a Teams/Slack draft in the compose box → offer one-click approval.
        if (pendingDraftApproval && (teamsPackActiveRun || slackPackActiveRun)) draftApprovalCard(pendingDraftApproval);
        pendingDraftApproval = null;
        convLogSave(); // persist the full conversation to the training folder (if connected)
        checkStatus(); // refresh the dot in case Ollama state changed
        maybeRunNextScheduled(); // chain any queued scheduled tasks once free
        break;
    }
  });

  // A CLEAN finish disconnects the port itself in the "done" case above and nulls
  // `port` first — so reaching here with `port` still pointing at this run means the
  // run died UNCLEANLY: the MV3 background worker was evicted or crashed mid-step.
  // This used to silently drop the spinner, leaving the transcript ending on a tool
  // call with no result, no error, and no hint that anything was wrong (the user
  // just saw it "get stuck"). Say so, and offer the resume bar immediately instead
  // of waiting for the panel to be reopened (checkResumable only ran at load).
  runPort.onDisconnect.addListener(async () => {
    if (port !== runPort) return;
    stopThinkTimer();
    setBusy(false);
    port = null;
    // A dead run must not leak its half-finished Teams/Slack draft into the NEXT
    // run's completion (the "done" path clears this; we never reach it here).
    pendingDraftApproval = null;
    // Every step here is individually guarded: this handler IS the last line of
    // defense against a silent hang, so nothing inside it may throw its way past
    // the message below. (convLogSave is async — an unguarded rejection would.)
    try { await convLogSave(); } catch { /* log folder not connected / grant lapsed */ }
    // Scheduled-task chaining is deliberately NOT continued after a crash — but
    // say so, rather than leaving the banner claiming they're running now.
    schedHalted = true;
    updateSchedBanner();
    let info = null;
    try { info = await peekResumable(); } catch { /* background not answering */ }
    bubble("msg error", "⚠ The run stopped unexpectedly — the extension's background worker was evicted or crashed mid-step, so the last action never returned a result. Nothing after the last step above ran. "
      + (info ? "Use Resume below to continue from the last completed step." : "Send the request again to retry."));
    if (info) showResumeBar(info);
  });
}

// ---------- resumable run ----------
// If a previous run was interrupted (panel closed, worker evicted, browser
// restart) the background keeps a durable snapshot. Offer to continue it.
let resumeBarEl = null;
// Ask the background whether a checkpoint exists, WITHOUT rendering anything —
// the unclean-death handler needs the answer before it writes its message, so it
// can point at the Resume button only when there will actually be one.
async function peekResumable() {
  if (busy) return null;
  try {
    const res = await chrome.runtime.sendMessage({ type: "peek_resume" });
    return (res && res.resumable) || null;
  } catch { return null; } // background asleep / not ready — nothing to resume
}
async function checkResumable() {
  const info = await peekResumable();
  if (!info) return false;
  showResumeBar(info);
  return true;
}

function showResumeBar(info) {
  if (resumeBarEl) resumeBarEl.remove();
  const task = (info.task || "").trim();
  const d = document.createElement("div");
  d.className = "tool approval";
  d.innerHTML = `<span class="name">↻ Previous run was interrupted${task ? ` — “${escapeHtml(task.slice(0, 80))}”` : ""} (reached step ${info.step}). Resume it?</span>`;
  const row = document.createElement("div");
  row.className = "approval-actions";
  const go = document.createElement("button");
  go.className = "allow";
  go.textContent = "Resume";
  const dismiss = document.createElement("button");
  dismiss.className = "deny";
  dismiss.textContent = "Dismiss";
  const close = () => { if (resumeBarEl) { resumeBarEl.remove(); resumeBarEl = null; } };
  go.addEventListener("click", () => {
    if (busy) return;
    close();
    startAgentRun({ type: "resume" });
  });
  dismiss.addEventListener("click", async () => {
    close();
    try { await chrome.runtime.sendMessage({ type: "discard_resume" }); } catch {}
  });
  row.append(go, dismiss);
  d.appendChild(row);
  resumeBarEl = d;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

// Plan-first approval: shown under a drafted plan. Approve runs it; Reject lets
// the user refine the request.
function planCard() {
  invalidatePlanCard(); // only one live plan card at a time
  const d = document.createElement("div");
  d.className = "tool approval";
  d.innerHTML = riskBandHtml("plan", "Plan · waiting for your OK") + `<span class="name">Plan ready. Approve to run it.</span>`;
  const row = document.createElement("div");
  row.className = "approval-actions";
  const go = document.createElement("button");
  go.className = "allow";
  go.textContent = "Approve & run";
  const reject = document.createElement("button");
  reject.className = "deny";
  reject.textContent = "Reject / edit";
  const finish = (msg) => {
    go.disabled = reject.disabled = true;
    activePlanCard = null; // acted on — no longer "live"
    const n = document.createElement("div");
    n.className = "approval-done";
    n.textContent = msg;
    d.appendChild(n);
  };
  go.addEventListener("click", () => { if (executeApprovedPlan()) finish("✓ Approved — running the plan"); });
  reject.addEventListener("click", () => finish("✗ Rejected — refine your request and send again"));
  row.append(go, reject);
  d.appendChild(row);
  activePlanCard = d;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

let submitting = false; // Send is async now (folder re-grant may prompt) — no double-submit on a second Enter
async function submit() {
  if (busy) { // the Send button acts as Stop while a run is in progress
    try { port?.postMessage({ type: "stop" }); } catch {}
    return;
  }
  if (submitting) return;
  const text = inputEl.value.trim();
  if (!text) return;
  submitting = true;
  // PRE-FLIGHT: no session ⇒ show the sign-in steps now, keep the typed message, start nothing.
  if (!(await signedIn())) { signInGuide(); submitting = false; return; }
  try {
    // RE-GRANT LAPSED FOLDERS NOW, while this click/Enter is still a user gesture.
    // Chrome drops File System Access grants on restart; the only self-heal the
    // run had was fs_op's navigator.userActivation check, which is long expired
    // by the time the model calls list_files. Both 2026-09-02 STRY0000001 runs
    // died on exactly that ("Local folder access needs to be re-granted" /
    // "connected folder is read-only") after the research was done. The folder
    // the task names goes first, so the one prompt that matters is the first one.
    const lapsed = await lapsedRoots();
    if (lapsed.length) {
      const roots = await getRootHandles().catch(() => []);
      const r = await regrantLapsed(lapsed, rootNamesMentioned(text, roots));
      if (r.granted.length) bubble("msg note", `📁 Re-granted local folder access for ${r.granted.map((n) => `"${n}"`).join(", ")} before starting.`);
      if (r.still.length) bubble("msg note", `⚠ Local folder access is still lapsed for ${r.still.map((n) => `"${n}"`).join(", ")} — the agent cannot read or save there until you click Reconnect on the strip below (or 📁 Local files (MCP)). Starting anyway.`);
      checkLocalFilesGrant();
    }
  } catch { /* never block a send on the permission check */ }
  finally { submitting = false; }
  recordPrompt(text);
  inputEl.value = "";
  resetInputHeight();
  run(text);
}

// Mid-run steering ("/btw" in Claude Code): inject a side message into the running
// agent WITHOUT stopping it. It's applied at the agent's next step. Used by Enter
// while a run is in progress (the red Stop button still stops).
function steer() {
  const text = inputEl.value.trim();
  const atts = attachments;
  if (!text && !atts.length) return; // nothing to steer with
  if (!busy || !port) { submit(); return; } // not actually running → treat as a normal send
  try {
    port.postMessage({
      type: "steer",
      text,
      attachments: atts.length ? atts.map((a) => ({ base64: a.base64, name: a.name })) : undefined
    });
  } catch {}
  if (text) recordPrompt(text);
  inputEl.value = "";
  resetInputHeight();
  // Show it in the transcript as a queued side message. Image-only steers get a
  // placeholder line so the history entry isn't empty.
  const shown = text || "(attached image)";
  history.push({ role: "user", content: shown });
  transcript.push({ t: "user", text: shown });
  saveHistory();
  const b = bubble("msg user", text);
  if (atts.length) {
    for (const a of atts) {
      const img = document.createElement("img");
      img.className = "sent-img";
      img.src = a.dataUrl;
      b.appendChild(img);
    }
    attachments = [];
    renderChips();
  }
  const tag = document.createElement("div");
  tag.className = "fb-note";
  tag.textContent = "↪ steering — the agent will pick this up on its next step";
  b.appendChild(tag);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- prompt history: ↑/↓ recall previously sent prompts ----------
// Shell-style. Persisted in chrome.storage.local so it survives panel close.
let promptHistory = [];
let histIndex = 0;       // promptHistory.length === "current draft, not in history"
let histDraft = "";      // the in-progress text saved when you start navigating

async function loadPromptHistory() {
  try {
    const { promptHistory: h } = await chrome.storage.local.get("promptHistory");
    promptHistory = Array.isArray(h) ? h : [];
  } catch {
    promptHistory = [];
  }
  histIndex = promptHistory.length;
}

function recordPrompt(text) {
  if (text && promptHistory[promptHistory.length - 1] !== text) {
    promptHistory.push(text);
    if (promptHistory.length > 100) promptHistory = promptHistory.slice(-100);
    try { chrome.storage.local.set({ promptHistory }); } catch {}
  }
  histIndex = promptHistory.length; // reset navigation to the (empty) draft slot
  histDraft = "";
}

function caretAtFirstLine() {
  return inputEl.selectionStart === inputEl.selectionEnd && !inputEl.value.slice(0, inputEl.selectionStart).includes("\n");
}
function caretAtLastLine() {
  return inputEl.selectionStart === inputEl.selectionEnd && !inputEl.value.slice(inputEl.selectionEnd).includes("\n");
}
function setInputValue(v) {
  inputEl.value = v;
  const n = inputEl.value.length;
  inputEl.selectionStart = inputEl.selectionEnd = n; // caret to end
  autoGrow();
  updateClearBtn();
}

// Returns true if it consumed the key (so the caller stops further handling).
function historyNav(e) {
  if (e.key === "ArrowUp" && caretAtFirstLine() && promptHistory.length) {
    e.preventDefault();
    if (histIndex === promptHistory.length) histDraft = inputEl.value; // save draft on entry
    if (histIndex > 0) histIndex--;
    setInputValue(promptHistory[histIndex]);
    return true;
  }
  if (e.key === "ArrowDown" && caretAtLastLine() && histIndex < promptHistory.length) {
    e.preventDefault();
    histIndex++;
    setInputValue(histIndex === promptHistory.length ? histDraft : promptHistory[histIndex]);
    return true;
  }
  return false;
}

// ---------- auto-grow + manual resize ----------
// The textarea grows to fit its content (up to ~50% of the panel), then scrolls.
// If the user drags the resize handle, we respect their size and stop auto-growing
// until the box is cleared (after sending).
let manualResize = false;
let lastAutoHeight = 0;

function autoGrow() {
  updateClearBtn(); // every change path (typing, dictation, send, clear) lands here
  if (manualResize) return;
  inputEl.style.height = "auto";
  const borders = inputEl.offsetHeight - inputEl.clientHeight; // top+bottom border
  const max = Math.floor(window.innerHeight * 0.3); // cap sooner (live dictation can get long) — scrollbar takes over past this
  const needed = inputEl.scrollHeight + borders;
  inputEl.style.height = Math.min(needed, max) + "px";
  inputEl.style.overflowY = needed > max ? "auto" : "hidden";
  lastAutoHeight = inputEl.offsetHeight;
}

function resetInputHeight() {
  manualResize = false;
  autoGrow();
}

// ---------- clear prompt (✕ button + Esc) ----------
const clearInputBtn = document.getElementById("clearInput");

function updateClearBtn() {
  clearInputBtn.classList.toggle("show", inputEl.value.length > 0);
}

function clearPrompt() {
  inputEl.value = "";
  histIndex = promptHistory.length; // reset ↑/↓ navigation
  histDraft = "";
  resetInputHeight();
  updateClearBtn();
  inputEl.focus();
}

clearInputBtn.addEventListener("click", clearPrompt);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (slashOpen()) { e.preventDefault(); closeSlash(); return; }
    if (inputEl.value) { e.preventDefault(); clearPrompt(); }
  }
});

inputEl.addEventListener("input", () => { autoGrow(); updateClearBtn(); refreshSlash(); histIndex = promptHistory.length; histDraft = ""; });
// A drag of the resize handle ends with a mouseup and a height change.
inputEl.addEventListener("mouseup", () => {
  if (Math.abs(inputEl.offsetHeight - lastAutoHeight) > 2) {
    manualResize = true;
    inputEl.style.overflowY = "auto"; // allow scrolling within the user's chosen size
  }
});
window.addEventListener("resize", autoGrow);

// ---------- attachments: screenshot / image ----------
const attachBtn = document.getElementById("attach");
const attachMenu = document.getElementById("attachMenu");
const chipRow = document.getElementById("chipRow");
const filePick = document.getElementById("filePick");
let attachments = []; // [{ dataUrl, base64, name }]
const MAX_ATTACHMENTS = 6;

function renderChips() {
  chipRow.innerHTML = "";
  if (!attachments.length) { chipRow.classList.remove("show"); return; }
  attachments.forEach((a, idx) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    const img = document.createElement("img");
    img.src = a.dataUrl;
    const label = document.createElement("span");
    label.textContent = a.name;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.title = "Remove";
    x.addEventListener("click", () => { attachments.splice(idx, 1); renderChips(); });
    chip.append(img, label, x);
    chipRow.appendChild(chip);
  });
  chipRow.classList.add("show");
}

function addAttachment(dataUrl, name) {
  const base64 = (dataUrl || "").split(",")[1] || "";
  if (!base64) { bubble("msg error", "⚠ Could not read the image."); return; }
  if (attachments.length >= MAX_ATTACHMENTS) {
    bubble("msg error", `⚠ Up to ${MAX_ATTACHMENTS} images per message. Remove one first.`);
    return;
  }
  attachments.push({ dataUrl, base64, name });
  renderChips();
  inputEl.focus();
}

attachBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  attachMenu.classList.toggle("open");
});
document.addEventListener("click", () => attachMenu.classList.remove("open"));

document.getElementById("menuShot").addEventListener("click", async () => {
  attachMenu.classList.remove("open");
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    addAttachment(dataUrl, "screenshot.png");
  } catch (e) {
    bubble("msg error", "⚠ Screenshot failed: " + e.message + " (restricted pages like chrome:// can't be captured)");
  }
});

document.getElementById("menuImage").addEventListener("click", () => {
  attachMenu.classList.remove("open");
  filePick.click();
});

filePick.addEventListener("change", () => {
  const files = Array.from(filePick.files || []);
  for (const f of files) {
    if (f.size > 8 * 1024 * 1024) { bubble("msg error", `⚠ "${f.name}" is too large (max 8 MB).`); continue; }
    const reader = new FileReader();
    reader.onload = () => addAttachment(reader.result, f.name);
    reader.readAsDataURL(f);
  }
  filePick.value = "";
});

// ---------- paste an image (Snipping Tool / Win+Shift+S → Ctrl+V) ----------
// A snip lands on the clipboard as image/png; pasting anywhere in the panel
// routes it through the same addAttachment pipeline as 📷 / 🖼. A mixed
// clipboard still pastes its text into the input AND attaches the image;
// an image-only clipboard suppresses the default paste so no stray filename
// text lands in the box. Same 8 MB cap as file-pick.
document.addEventListener("paste", (e) => {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const imgs = items.filter((it) => it.kind === "file" && /^image\//.test(it.type));
  if (!imgs.length) return; // plain text paste — default behavior
  let n = 0;
  for (const it of imgs) {
    const f = it.getAsFile();
    if (!f) continue;
    if (f.size > 8 * 1024 * 1024) { bubble("msg error", "⚠ Pasted image is too large (max 8 MB)."); continue; }
    const ext = ((f.type.split("/")[1] || "png").replace("jpeg", "jpg"));
    // Clipboard files are all named "image.png" — stamp them so multiple
    // pastes stay distinguishable in the chips and the conversation log.
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
    const name = `pasted-${stamp}${n ? "-" + n : ""}.${ext}`;
    const reader = new FileReader();
    reader.onload = () => addAttachment(reader.result, name);
    reader.readAsDataURL(f);
    n++;
  }
  if (!e.clipboardData.getData("text/plain")) e.preventDefault();
});

// ---------- per-response action bar: feedback (learning) + export ----------
// 👍 reinforces / 👎 distills a lesson (only when there's a runId — i.e. a live
// run). Copy / .md / .docx / .pdf export the response text and appear on every
// assistant message, including ones restored from history.
// A standalone 👍/👎 row for when a run ENDS without a clean deliverable (error / abort / stall).
// Bound to the run's id so a FAILED run still yields a reinforcement signal — the 👎 on a bad run
// is the highest-value RL data. Reuses the same {type:"feedback"} backend as responseActions.
function appendRunFeedback(runId, label) {
  if (runId == null || runGotFeedbackRow) return;
  runGotFeedbackRow = true;
  const d = document.createElement("div");
  d.className = "fb-row act-row";
  if (label) { const s = document.createElement("span"); s.className = "fb-note"; s.textContent = label; d.appendChild(s); }
  const up = document.createElement("button"); up.textContent = "👍"; up.title = "Good run — reinforce the lessons it used";
  const down = document.createElement("button"); down.textContent = "👎"; down.title = "Bad run — distill a lesson so it improves";
  const note = document.createElement("span"); note.className = "fb-note";
  const send = async (value) => {
    up.disabled = down.disabled = true;
    (value > 0 ? up : down).classList.add("chosen");
    note.textContent = value > 0 ? "saving…" : "learning from this…";
    try {
      const res = await chrome.runtime.sendMessage({ type: "feedback", runId, value });
      if (value > 0) note.textContent = res?.reinforced ? `reinforced ${res.reinforced} lesson(s)` : "thanks!";
      else note.textContent = res?.lesson ? `learned: "${res.lesson}"` : (res?.error || "noted");
      transcript.push({ t: "feedback", scope: "run", runId, value, lesson: res?.lesson, reinforced: res?.reinforced });
    } catch { note.textContent = "saved"; }
    convLogSave();
  };
  up.addEventListener("click", () => send(1));
  down.addEventListener("click", () => send(-1));
  d.append(up, down, note);
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

// The newest user request in the conversation (export file names start with its slug).
function lastUserAsk() {
  for (let i = history.length - 1; i >= 0; i--) if (history[i] && history[i].role === "user") return String(history[i].content || "");
  return "";
}
function firstUserAsk() {
  const m = history.find((x) => x && x.role === "user");
  return m ? String(m.content || "") : "";
}

function responseActions(text, runId, phaseMeta, task) {
  const exportTask = task != null ? task : lastUserAsk();
  const d = document.createElement("div");
  d.className = "fb-row act-row";

  if (runId != null) {
    runGotFeedbackRow = true; // this run's response already carries thumbs — don't add a second row on end
    const up = document.createElement("button");
    up.textContent = "👍";
    up.title = "Good run — reinforce the lessons it used";
    const down = document.createElement("button");
    down.textContent = "👎";
    down.title = "Bad run — distill a lesson so it improves";
    const note = document.createElement("span");
    note.className = "fb-note";

    const send = async (value) => {
      up.disabled = down.disabled = true;
      (value > 0 ? up : down).classList.add("chosen");
      note.textContent = value > 0 ? "saving…" : "learning from this…";
      try {
        const res = await chrome.runtime.sendMessage({ type: "feedback", runId, value });
        if (value > 0) note.textContent = res?.reinforced ? `reinforced ${res.reinforced} lesson(s)` : "thanks!";
        else note.textContent = res?.lesson ? `learned: "${res.lesson}"` : (res?.error || "noted");
        transcript.push({ t: "feedback", scope: "run", runId, value, lesson: res?.lesson, reinforced: res?.reinforced });
      } catch {
        note.textContent = "saved";
      }
      convLogSave(); // feedback is the reinforcement signal — persist it too
    };
    up.addEventListener("click", () => send(1));
    down.addEventListener("click", () => send(-1));
    d.append(up, down, note);
  }

  const sep = document.createElement("span");
  sep.className = "sep";
  d.appendChild(sep);

  // Single minimalist "Export ▾" dropdown (replaces the 4 always-visible buttons).
  // Copy / .md / .docx / .pdf (+ any code artifacts / phase report) live inside it.
  // Exports use the citation-stripped text so downloaded deliverables are clean;
  // the phase-report (admin) is built separately and keeps its [E#.O#] provenance.
  const cleanText = stripCites(text);
  const base = () => exportBaseName(cleanText, exportTask);
  const wrap = document.createElement("div");
  wrap.className = "exp-wrap";
  const toggle = document.createElement("button");
  toggle.className = "exp exp-toggle";
  toggle.textContent = "⬇ Export ▾";
  toggle.title = "Copy or download this response";
  const menu = document.createElement("div");
  menu.className = "attach-menu exp-menu";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".exp-menu.open").forEach((m) => { if (m !== menu) m.classList.remove("open"); });
    menu.classList.toggle("open");
  });
  // A menu item: runs its action, closes the menu, and flashes ✓/✗ on the toggle.
  const item = (label, title, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.classList.remove("open");
      const prev = toggle.textContent;
      try { const ok = await fn(); toggle.textContent = ok === false ? "✗ failed" : "✓ done"; }
      catch { toggle.textContent = "✗ failed"; }
      setTimeout(() => { toggle.textContent = prev; }, 1200);
    });
    return b;
  };
  menu.append(
    item("📋 Copy", "Copy this response to the clipboard", () => copyText(cleanText)),
    item("⬇ Markdown (.md)", "Download this response as Markdown", () => downloadMarkdown(cleanText, base())),
    item("⬇ Word (.docx)", "Download this response as a Word document", () => downloadDocx(cleanText, base())),
    item("⬇ PDF (.pdf)", "Download this response as a PDF", () => downloadPdf(cleanText, base()))
  );
  // Code artifacts (a fenced code block → its own downloadable file) become menu items too.
  const deliverables = []; // named, downloadable outputs — surfaced as a chip below
  try {
    for (const a of extractCodeArtifacts(cleanText)) {
      deliverables.push(a.filename);
      menu.appendChild(item(`⬇ ${a.filename}`, `Download the ${a.lang || "code"} artifact "${a.filename}"`, () => downloadArtifact(a.code, a.filename)));
    }
  } catch { /* best-effort — never break the export bar */ }
  // Phase runs also offer a full audit report when the engine attached metadata.
  // Full parity (2026-07-30): available to ALL tiers, matching local-claude-extension.
  if (phaseMeta && (phaseMeta.ledger?.length || phaseMeta.gates?.length)) {
    deliverables.push("phase-report.md");
    menu.appendChild(item("⬇ phase-report.md", "Download the full phase-run audit report", () => downloadMarkdown(buildPhaseRunReport(phaseMeta), base() + "-phase-report")));
  }
  // Deliverables were being produced but hidden behind a plain "Export ▾" label —
  // users didn't know they existed. Rather than a SECOND, redundant chip next to
  // the button (same content, two controls), label the Export button ITSELF with
  // the deliverable so ONE control both signals it and opens the menu that names
  // and downloads it. The item() flash saves/restores this text, so it persists.
  if (deliverables.length) {
    const n = deliverables.length;
    toggle.textContent = n === 1 ? `📦 ${deliverables[0]} ▾` : `📦 ${n} deliverables ▾`;
    toggle.title = `Deliverables: ${deliverables.join(", ")} — plus Copy / .md / .docx / .pdf. Click to open.`;
    toggle.style.maxWidth = "100%";
    toggle.style.overflow = "hidden";
    toggle.style.textOverflow = "ellipsis";
    toggle.style.whiteSpace = "nowrap";
    toggle.style.borderColor = "var(--accent-green,#4EC9B0)";
    toggle.style.color = "var(--accent-green,#4EC9B0)";
  }
  wrap.append(toggle, menu);
  d.appendChild(wrap);

  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
  return d;
}
// Close any open per-response export menu on an outside click.
document.addEventListener("click", () => document.querySelectorAll(".exp-menu.open").forEach((m) => m.classList.remove("open")));

// The full phase-run audit (evidence ledger, gate verdicts, the remediated
// artifact, and the Click-by-Click Build Guide) rendered INLINE as a collapsible
// block — readable in the panel without downloading the .md.
function maybePhaseReportInline(phaseMeta) {
  // Full parity (2026-07-30): inline phase-run audit renders for ALL tiers.
  if (!phaseMeta || !((phaseMeta.ledger && phaseMeta.ledger.length) || (phaseMeta.gates && phaseMeta.gates.length))) return;
  let md = "";
  try { md = buildPhaseRunReport(phaseMeta); } catch { return; }
  if (!md.trim()) return;
  const det = document.createElement("details");
  det.className = "phase-report-inline";
  det.style.cssText = "margin:6px 0 2px;border:1px solid var(--border-color,#404040);border-radius:8px;background:var(--bg-secondary,#252526);padding:6px 10px;";
  const sum = document.createElement("summary");
  sum.style.cssText = "cursor:pointer;color:var(--accent-yellow,#DCDCAA);font-size:11px;font-weight:600;";
  sum.textContent = "📋 Phase run report (admin) — evidence, gate verdicts, remediated artifact & Click-by-Click. Click to read inline.";
  const body = document.createElement("div");
  body.className = "phase-report-body";
  body.style.cssText = "margin-top:8px;font-size:12px;line-height:1.5;overflow-x:auto;";
  body.innerHTML = renderMarkdown(md, { keepCites: true }); // admin audit keeps [E#.O#] provenance
  det.append(sum, body);
  logEl.appendChild(det);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- "/" slash commands: built-ins + user shortcuts ----------
const slashMenu = document.getElementById("slashMenu");
let slashItems = [];
let slashSel = 0;

function slashOpen() { return slashMenu.classList.contains("open"); }
function closeSlash() { slashMenu.classList.remove("open"); slashItems = []; }

async function refreshSlash() {
  const v = inputEl.value;
  // Trigger only while typing a single "/token" (no spaces/newlines yet).
  if (!/^\/[^\s]*$/.test(v)) { closeSlash(); return; }
  const q = v.slice(1).toLowerCase();
  const builtins = BUILTINS.filter((b) => b.name.includes(q)).map((b) => ({ type: "builtin", name: b.name, desc: b.description }));
  const scs = (await getShortcuts())
    .filter((s) => s.name.toLowerCase().includes(q))
    .map((s) => ({ type: "shortcut", name: s.name, desc: s.prompt.slice(0, 60), sc: s }));
  slashItems = [...builtins, ...scs, { type: "manage", name: "Shortcuts", desc: "Create / edit in Settings ›" }];
  slashSel = 0;
  renderSlash();
}

function renderSlash() {
  if (!slashItems.length) { closeSlash(); return; }
  slashMenu.innerHTML = "";
  slashItems.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "slash-item" + (i === slashSel ? " sel" : "");
    const cls = it.type === "shortcut" ? "sc-name" : "cmd";
    const prefix = it.type === "manage" ? "⚙" : "/";
    d.innerHTML = `<span class="${cls}">${prefix} ${escapeHtml(it.name)}</span><span class="desc">${escapeHtml(it.desc)}</span>`;
    d.addEventListener("mousedown", (e) => { e.preventDefault(); slashSel = i; chooseSlash(); });
    slashMenu.appendChild(d);
  });
  slashMenu.classList.add("open");
}

function moveSlashSel(delta) {
  if (!slashItems.length) return;
  slashSel = (slashSel + delta + slashItems.length) % slashItems.length;
  renderSlash();
}

function chooseSlash() {
  const it = slashItems[slashSel];
  closeSlash();
  if (!it) return;
  inputEl.value = "";
  resetInputHeight();
  if (it.type === "manage") { chrome.runtime.openOptionsPage(); return; }
  if (it.type === "builtin") {
    if (it.name === "compact") doCompact();
    else if (it.name === "clear") { history = []; saveHistory(); loadHistory(); }
    return;
  }
  if (it.type === "shortcut") runShortcut(it.sc);
}

function runShortcut(sc) {
  let task = sc.prompt || "";
  if (sc.startFrom) task = `Begin by navigating to ${sc.startFrom}\n\n${task}`;
  if (!task.trim()) { bubble("msg error", `⚠ Shortcut "/${sc.name}" has no prompt.`); return; }
  run(task, sc.model || null);
}

// /compact — summarize the conversation, then keep only the summary as context.
async function doCompact() {
  if (!history.length) { bubble("msg note", "Nothing to compact yet."); return; }
  const note = bubble("msg note", "Compacting conversation…");
  try {
    const s = await getSettings();
    const convo = history.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 12000);
    const msg = await chat({
      base: s.ollamaBase,
      model: s.model,
      messages: [{ role: "user", content: `Summarize this conversation concisely, preserving key facts, decisions, names, and any context needed to continue:\n\n${convo}` }],
      options: { temperature: 0.3 }
    });
    const summary = (msg.content || "").trim();
    history = [{ role: "assistant", content: "[Summary of earlier conversation]\n" + summary }];
    await saveHistory();
    await loadHistory();
    bubble("msg note", "✓ Conversation compacted — summary kept as context.");
  } catch (e) {
    note.textContent = "Compact failed: " + e.message;
  }
}

// ---------- Teach a workflow: record actions + narration, model synthesizes ----------
const teachBtn = document.getElementById("teach");
let teaching = false;
let teachRecorder = null;
let teachChunks = [];

// ----- Live step list: grows in real time as the content script captures actions -----
let teachLiveListEl = null;  // <ol> the steps append to
let teachLiveCountEl = null; // header counter
let teachLiveDotEl = null;   // blinking REC dot
let teachLiveCount = 0;      // real actions only (click/input/select) — what actually SAVES
let teachLivePrev = null;    // { action, key, url, li } for collapsing repeats

// A savable step is a click / typing / dropdown choice. Navigations are shown
// as muted context but never counted, because the saved workflow discards a
// navigate-only recording (teach.js realActions gate). Counting them was the
// "4 live steps but 0 saved" mismatch — the 4 were all navigations.
function teachIsRealAction(action) { return action === "click" || action === "input" || action === "select"; }

// Stable identity for a field, mirroring teach.js dedupeEvents so the live view
// collapses the same repeats the saved workflow will.
function teachStepKey(t) { return (t && (t.recId || t.id || t.name || t.label || t.text)) || ""; }

function startLiveSteps() {
  teachLiveCount = 0;
  teachLivePrev = null;
  const card = document.createElement("div");
  card.className = "tool teach-live";
  const head = document.createElement("div");
  head.className = "name";
  head.innerHTML = `<span class="rec-dot"></span> Live steps · <span class="teach-live-n">0</span>`;
  const ol = document.createElement("ol");
  ol.className = "teach-live-list";
  card.append(head, ol);
  logEl.appendChild(card);
  teachLiveListEl = ol;
  teachLiveCountEl = head.querySelector(".teach-live-n");
  teachLiveDotEl = head.querySelector(".rec-dot");
  logEl.scrollTop = logEl.scrollHeight;
}

function addLiveStep(ev) {
  if (!teachLiveListEl) return;
  const line = eventToStepLine(ev);
  const k = teachStepKey(ev.target);
  const real = teachIsRealAction(ev.action);
  // Collapse successive typing/select on the same field; drop duplicate navigations.
  if (teachLivePrev) {
    if ((ev.action === "input" || ev.action === "select") && teachLivePrev.action === ev.action && teachLivePrev.key === k) {
      teachLivePrev.li.textContent = line; // keep only the latest value
      return;
    }
    // A click on a field followed by its tick, typing or choice is ONE step, the same collapse the saved
    // workflow gets (teach.js dedupeEvents). Without it the live list showed 'Click "CPR certified" <input>'
    // and then 'Check the "CPR certified" box' for every tick (Saved workflows video probe 2026-09-13).
    if (teachLivePrev.action === "click" && ["check", "uncheck", "input", "select"].includes(ev.action)
        && (teachLivePrev.key === k || (!/^(a|button)$/i.test(teachLivePrev.tag || "") && teachLivePrev.shown && teachLivePrev.shown === ((ev.target && (ev.target.label || ev.target.text)) || "")))) {
      teachLivePrev.li.textContent = line;
      teachLivePrev.action = ev.action;
      teachLivePrev.key = k;
      return;
    }
    if ((ev.action === "check" || ev.action === "uncheck") && (teachLivePrev.action === "check" || teachLivePrev.action === "uncheck") && teachLivePrev.key === k) {
      teachLivePrev.li.textContent = line;
      teachLivePrev.action = ev.action;
      return;
    }
    if (ev.action === "navigate" && teachLivePrev.action === "navigate" && teachLivePrev.url === ev.url) return;
  }
  const li = document.createElement("li");
  li.textContent = line;
  if (real) {
    teachLiveCount++;
    if (teachLiveCountEl) teachLiveCountEl.textContent = String(teachLiveCount);
  } else {
    // Navigation: context only, not a savable step. Style it muted and don't
    // count it (a value="" li keeps the ordered-list numbering on real steps).
    li.style.color = "var(--text-muted)";
    li.value = teachLiveCount; // don't advance the visible step number
  }
  teachLiveListEl.appendChild(li);
  teachLivePrev = { action: ev.action, key: k, url: ev.url, li, shown: (ev.target && (ev.target.label || ev.target.text)) || "", tag: (ev.target && ev.target.tag) || "" };
  logEl.scrollTop = logEl.scrollHeight;
}

function finishLiveSteps() {
  if (teachLiveDotEl) teachLiveDotEl.remove(); // stop the blinking REC indicator
  if (teachLiveListEl && teachLiveCount === 0) {
    // No savable action captured — say so plainly (this is exactly the case the
    // save path rejects), and point at the usual cause: clicks/typing inside a
    // frame (e.g. a ServiceNow record) that needs a moment, or a direct click in.
    const li = document.createElement("li");
    li.textContent = "(no clicks or typing captured — nothing will be saved. If your form is inside a frame, click directly inside it and re-record.)";
    li.style.color = "var(--accent-orange)";
    li.value = 0;
    teachLiveListEl.appendChild(li);
  }
  teachLiveListEl = teachLiveCountEl = teachLiveDotEl = null;
  teachLivePrev = null;
}

// Receive each captured action while recording and render it live.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "teach_event" && teaching) addLiveStep(msg.event);
});

async function startTeaching() {
  // Attach the recorder FIRST; only enter "recording" state if it actually
  // started. Otherwise a dead content script (e.g. the page wasn't reloaded after
  // an extension reload) would leave the button blinking while nothing records.
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "teach_start" }); }
  catch (e) { res = { ok: false, error: e.message }; }
  if (!res || res.ok === false) {
    bubble("msg note", "⚠️ Couldn't start recording. " + ((res && res.error) || "Reload the page (F5) and try again."));
    return;
  }
  teaching = true;
  teachBtn.classList.add("recording");
  teachBtn.title = "Recording — click to finish and learn the workflow";
  bubble("msg note", "🎬 Recording your workflow on the active tab — CLICK and TYPE the steps (a form inside a frame, e.g. a ServiceNow record, can take a second to hook in). Narrate out loud as you go: your voice is recorded now and transcribed only when you FINISH (needs the local Whisper server running). Click 🎬 again to finish.");
  startLiveSteps();

  // Narration (best-effort; actions are still recorded without it).
  try {
    if (await whisperAvailable()) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      teachChunks = [];
      teachRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      teachRecorder._stream = stream;
      teachRecorder.ondataavailable = (e) => { if (e.data.size) teachChunks.push(e.data); };
      teachRecorder.start();
    }
  } catch {
    /* no mic — actions-only demo is still useful */
  }
}

async function stopTeaching() {
  teaching = false;
  teachBtn.classList.remove("recording");
  teachBtn.title = "Teach a workflow";
  finishLiveSteps();

  let narration = "";
  if (teachRecorder) {
    narration = await new Promise((resolve) => {
      teachRecorder.onstop = async () => {
        teachRecorder._stream.getTracks().forEach((t) => t.stop());
        try {
          const s = await getSettings();
          const fd = new FormData();
          fd.append("audio", new Blob(teachChunks, { type: "audio/webm" }), "narration.webm");
          const res = await fetch(`${s.whisperUrl}/transcribe`, { method: "POST", body: fd });
          const data = await res.json();
          resolve(data.text || "");
        } catch {
          // Whisper unreachable → narration can't be transcribed. Say so (silent "" was
          // the "not capturing my voice" symptom); the workflow is still captured from actions.
          bubble("msg note", "🎙 Narration wasn't transcribed — the local Whisper server isn't reachable. The workflow was still captured from your actions. Start whisper-server\\start-whisper.bat to include spoken narration.");
          resolve("");
        }
      };
      teachRecorder.stop();
    });
    teachRecorder = null;
  }

  const note = bubble("msg note", "🎬 Learning your workflow…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "teach_stop", narration });
    if (res?.workflow && res.ok !== false) {
      note.innerHTML = renderMarkdown(
        `📚 Learned **"${res.workflow.name}"** — ${res.workflow.steps?.length || 0} steps from ${res.eventCount} recorded actions. Saved. Run it anytime from **+ → Run a saved workflow**.`
      );
    } else {
      note.textContent = res?.error || `Recorded ${res?.eventCount || 0} actions, but couldn't synthesize a workflow (model error or empty demo). Try again with clear actions + narration.`;
    }
  } catch (e) {
    note.textContent = "Teach failed: " + e.message;
  }
}

teachBtn.addEventListener("click", () => (teaching ? stopTeaching() : startTeaching()));

// Saved-workflow chooser (opened from the + menu).
async function showWorkflows() {
  let list = [];
  try { list = await chrome.runtime.sendMessage({ type: "get_workflows" }); } catch {}
  if (!list || !list.length) {
    bubble("msg note", "No saved workflows yet. Click 🎬 to record and teach one.");
    return;
  }
  const d = document.createElement("div");
  d.className = "tool";
  d.innerHTML = `<span class="name">▶ Saved workflows — click Run</span>`;
  for (const w of list) {
    const row = document.createElement("div");
    row.className = "wf-row";
    const run = document.createElement("button");
    run.className = "run";
    run.textContent = "Run";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${w.demo ? "Demo · " : ""}${w.name} (${w.steps?.length || 0} steps)`;
    name.title = (w.steps || []).join("\n");
    run.addEventListener("click", () => runWorkflow(w));
    // Export the recorded workflow as click-by-click text.
    const copy = document.createElement("button");
    copy.className = "run";
    copy.textContent = "Copy";
    copy.title = "Copy this workflow as click-by-click Markdown";
    copy.addEventListener("click", async () => {
      await copyText(workflowToMarkdown(w));
      copy.textContent = "Copied ✓";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    });
    const md = document.createElement("button");
    md.className = "run";
    md.textContent = ".md";
    md.title = "Download this workflow as a Markdown file";
    md.addEventListener("click", () => downloadMarkdown(workflowToMarkdown(w), exportBaseName("workflow", w.name || "")));
    row.append(run, copy, md, name);
    d.appendChild(row);
  }
  const hint = document.createElement("div");
  hint.style.cssText = "color:var(--text-secondary);font-size:10.5px;margin-top:8px";
  hint.textContent = "Copy / .md export the steps as text. Manage or delete workflows in ⚙ Settings.";
  d.appendChild(hint);
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

// Parameter values are collected HERE, before the model sees the task. The old prompt told the
// model to ask for them, so every parameterized replay ended on a question with no tool call and
// the grounding retry argued with it (SIR0014155 export 2026-09-13 20:53).
function runWorkflow(w) {
  const params = (w.parameters || []).filter((p) => p && p.name);
  if (!params.length) return sendWorkflow(w, {});

  const card = document.createElement("div");
  card.className = "tool wf-params";
  const head = document.createElement("span");
  head.className = "name";
  head.textContent = `▶ ${w.name} — values for this run`;
  const form = document.createElement("form");
  const stamp = Date.now();
  const fields = params.map((p, i) => {
    const input = document.createElement("input");
    input.type = "text";
    input.id = `wfp-${stamp}-${i}`;
    input.value = p.example != null ? String(p.example) : "";
    input.autocomplete = "off";
    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.textContent = p.name;
    form.append(label, input);
    return { p, input };
  });
  const row = document.createElement("div");
  row.className = "wf-row";
  const go = document.createElement("button");
  go.type = "submit";
  go.className = "run";
  go.textContent = "Run";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "run secondary";
  cancel.textContent = "Cancel";
  row.append(go, cancel);
  form.appendChild(row);

  const close = (note) => {
    form.querySelectorAll("input, button").forEach((el) => (el.disabled = true));
    head.textContent = `▶ ${w.name} — ${note}`;
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = {};
    for (const { p, input } of fields) {
      const v = input.value.trim();
      if (!v) { input.setAttribute("aria-invalid", "true"); input.focus(); return; }
      input.removeAttribute("aria-invalid");
      values[p.name] = v;
    }
    close("running");
    sendWorkflow(w, values);
  });
  cancel.addEventListener("click", () => close("cancelled"));
  form.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close("cancelled"); } });

  card.append(head, form);
  logEl.appendChild(card);
  logEl.scrollTop = logEl.scrollHeight;
  fields[0].input.focus();
  fields[0].input.select();
}

function sendWorkflow(w, values) {
  const has = (k) => Object.prototype.hasOwnProperty.call(values, k);
  const fill = (s) => String(s).replace(/\{(\w+)\}/g, (m, k) => (has(k) ? values[k] : m));
  const steps = (w.steps || []).map((s, i) => `${i + 1}. ${fill(s)}`).join("\n");
  let task = `Replay this learned workflow named "${w.name}".\n\nSteps:\n${steps}`;
  const names = Object.keys(values);
  if (names.length) {
    task += `\n\nValues for this run: ${names.map((k) => `${k} = "${values[k]}"`).join(", ")}. They are already filled into the steps above, so do not ask me for them.\n\nPerform these steps now using your browser tools.`;
  } else {
    task += `\n\nPerform these steps using your browser tools.`;
  }
  run(task);
}

document.getElementById("menuWorkflows").addEventListener("click", () => {
  attachMenu.classList.remove("open");
  showWorkflows();
});

// ---------- 📁 Local files: grant/disconnect a read-only folder (File System Access API) ----------
// ---------- 🔌 ServiceNow (MCP): connect an instance (URL + user + password) ----------
const snOverlay = document.getElementById("snOverlay");

// Show/Hide toggle for the ServiceNow password (verify what you typed before Connect).
const snPassToggle = document.getElementById("snPassToggle");
if (snPassToggle) snPassToggle.addEventListener("click", () => {
  const p = document.getElementById("snPass");
  const reveal = p.type === "password";
  p.type = reveal ? "text" : "password";
  snPassToggle.textContent = reveal ? "Hide" : "Show";
  snPassToggle.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
});

// Parse the CSV textarea into connections. One row per line: url,username,password.
// Blank lines and lines starting with # are ignored.
function parseSnCsv(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(",").map((s) => s.trim());
    const url = snOrigin(parts[0] || "");
    if (!url) continue;
    out.push({ url, username: parts[1] || "", password: parts[2] || "" });
  }
  return out;
}

// Gather connections from BOTH the single-instance fields and the CSV box, deduped
// by origin (CSV wins on conflict since it's the bulk source of truth).
function gatherSnConnections() {
  const byOrigin = new Map();
  const u = snOrigin(document.getElementById("snUrl").value);
  if (u) byOrigin.set(u, { url: u, username: document.getElementById("snUser").value.trim(), password: document.getElementById("snPass").value });
  for (const c of parseSnCsv(document.getElementById("snCsv").value)) byOrigin.set(c.url, c);
  return [...byOrigin.values()];
}

async function refreshSnStatus() {
  const conns = await getSnConnections().catch(() => []);
  const status = document.getElementById("snStatus");
  if (conns.length) {
    const hosts = conns.map((c) => { try { return new URL(c.url).hostname; } catch { return c.url; } });
    status.textContent = conns.length === 1 ? `● Connected to ${conns[0].url}` : `● Connected to ${conns.length} instances: ${hosts.join(", ")}`;
    status.style.color = "var(--accent-green)";
    // Show the stored connections in the CSV box (editable); keep single fields blank.
    document.getElementById("snCsv").value = conns.map((c) => `${c.url},${c.username},${c.password}`).join("\n");
    document.getElementById("snUrl").value = "";
    document.getElementById("snUser").value = "";
    document.getElementById("snPass").value = "";
  } else {
    status.textContent = "Not connected.";
    status.style.color = "var(--text-secondary)";
  }
}
document.getElementById("menuServiceNow").addEventListener("click", async () => {
  attachMenu.classList.remove("open");
  document.getElementById("snMsg").textContent = "";
  await refreshSnStatus();
  snOverlay.classList.add("open");
});
document.getElementById("snClose").addEventListener("click", () => snOverlay.classList.remove("open"));
snOverlay.addEventListener("click", (e) => { if (e.target === snOverlay) snOverlay.classList.remove("open"); });

document.getElementById("snConnect").addEventListener("click", async () => {
  const msg = document.getElementById("snMsg");
  const list = gatherSnConnections();
  if (!list.length) { msg.textContent = "⚠ Enter a URL, or paste CSV rows (url,username,password)."; msg.style.color = "var(--accent-red)"; return; }
  msg.textContent = `Testing ${list.length} connection${list.length > 1 ? "s" : ""}…`; msg.style.color = "var(--text-secondary)";
  await saveSnConnections(list);
  // Verify EACH connection with a tiny live query so bad URLs/credentials fail fast.
  const results = [];
  for (const c of list) {
    try {
      const res = await snQueryTable(snBasicTarget(c), { table: "sys_user", fields: "user_name", limit: 1 });
      results.push({ url: c.url, ok: !(res && res.error), error: res && res.error });
    } catch (e) {
      results.push({ url: c.url, ok: false, error: e.message });
    }
  }
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) {
    msg.textContent = `✓ Connected & verified (${ok.length}).`; msg.style.color = "var(--accent-green)";
  } else {
    msg.textContent = `✓ ${ok.length} verified · ⚠ ${bad.length} failed (kept — check creds/URL).`; msg.style.color = "var(--accent-orange)";
  }
  const lines = results.map((r) => `${r.ok ? "✓" : "⚠"} ${r.url}${r.ok ? "" : " — " + (r.error || "failed")}`).join("\n");
  bubble("msg note", `🔌 ServiceNow connections (${ok.length}/${results.length} verified):\n${lines}\nEach sub-agent uses the row matching its instance for sn_query_* / sn_update_record.`);
  await refreshSnStatus();
  if (!bad.length) setTimeout(() => snOverlay.classList.remove("open"), 800);
});
document.getElementById("snDisconnect").addEventListener("click", async () => {
  await clearSnConnections();
  document.getElementById("snUrl").value = "";
  document.getElementById("snUser").value = "";
  document.getElementById("snPass").value = "";
  document.getElementById("snCsv").value = "";
  document.getElementById("snMsg").textContent = "Disconnected (all instances).";
  document.getElementById("snMsg").style.color = "var(--text-secondary)";
  await refreshSnStatus();
  bubble("msg note", "🔌 ServiceNow disconnected (all instances).");
});

document.getElementById("menuLocalFiles").addEventListener("click", async () => {
  attachMenu.classList.remove("open");
  if (!window.showDirectoryPicker) {
    bubble("msg error", "⚠ This browser doesn't support the File System Access API (need Chrome/Edge).");
    return;
  }
  const roots = await getRootHandles().catch(() => []);
  if (!roots.length) { await pickAndAddFolder(); return; }
  // One or more folders connected — show the manager (add up to 3, per-folder
  // reconnect/disconnect). Multi-root (2026-07-22): the agent can hold up to 3
  // folders at once (e.g. SN_REF + Project Files); paths route by folder-name prefix.
  await showFoldersManager(roots);
});

// Open the OS picker, grant, and ADD the folder to the connected set (cap MAX_ROOTS).
async function pickAndAddFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    if (!(await ensureReadWritePermission(handle))) {
      bubble("msg error", "⚠ Folder access was not granted, so the folder isn't connected.");
      return;
    }
    const s = await getSettings();
    const r = await addRootHandle(handle, s.maxRoots);
    if (!r.ok) {
      bubble("msg error", `⚠ ${r.reason}. Connected: ${r.roots.map((h) => `"${h.name}"`).join(", ")}. Open 📁 Local files (MCP) to disconnect one, or raise "max connected folders" in Settings.`);
      return;
    }
    checkLocalFilesGrant();
    const names = r.roots.map((h) => `"${h.name}"`).join(", ");
    bubble("msg note", `✓ Connected "${handle.name}" (read/write). ${r.roots.length}/${r.max} folder(s) connected: ${names}.` +
      (r.roots.length > 1
        ? ` With multiple folders, target files by PREFIXING the folder name — e.g. read_file "${handle.name}/README.md", list_files "${r.roots[0].name}".`
        : ` The agent can read (PDF/Office/images too), organize, and write to it (approval-gated).`) +
      ` (Access resets when Chrome restarts — reconnect here if needed.)`);
  } catch (e) {
    if (e && e.name !== "AbortError") bubble("msg error", "⚠ Couldn't connect folder: " + e.message);
  }
}

// Manager card: lists every connected folder with per-folder Reconnect (if lapsed)
// / Disconnect, plus Add folder (while < MAX_ROOTS) and Disconnect all.
async function showFoldersManager(roots) {
  const s = await getSettings();
  const max = s.maxRoots || MAX_ROOTS;
  const card = bubble("msg note");
  const head = document.createElement("div");
  head.innerHTML = `<b>📁 Local files (MCP)</b> — ${roots.length}/${max} folder(s) connected` +
    (roots.length > 1 ? ` · address files with a folder-name prefix (e.g. <code>read_file "${roots[0].name}/file"</code>)` : ``);
  card.appendChild(head);
  for (const h of roots) {
    const lapsed = !(await hasReadPermission(h).catch(() => false));
    const line = document.createElement("div");
    line.className = "approval-actions";
    const label = document.createElement("span");
    label.style.cssText = "flex:1;align-self:center";
    label.textContent = `${h.name}${lapsed ? " ⚠ access lapsed" : " ✓"}`;
    line.appendChild(label);
    const mk = (t, cls, fn) => { const b = document.createElement("button"); b.className = cls; b.textContent = t; b.addEventListener("click", async () => { line.remove(); await fn(); }); line.appendChild(b); };
    if (lapsed) mk("Reconnect", "allow", async () => {
      if (await ensureReadWritePermission(h)) { checkLocalFilesGrant(); bubble("msg note", `✓ Re-granted "${h.name}".`); }
      else bubble("msg error", `⚠ "${h.name}" wasn't re-granted — try again.`);
    });
    mk("Disconnect", "deny", async () => {
      const left = await removeRootHandleByName(h.name);
      checkLocalFilesGrant();
      bubble("msg note", `📁 Disconnected "${h.name}". ${left.length ? `${left.length} folder(s) still connected: ${left.map((x) => `"${x.name}"`).join(", ")}.` : "No folders connected."}`);
    });
    card.appendChild(line);
  }
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const mkA = (t, cls, fn) => { const b = document.createElement("button"); b.className = cls; b.textContent = t; b.addEventListener("click", async () => { await fn(); }); actions.appendChild(b); };
  if (roots.length < max) mkA(`➕ Add folder`, "allow", () => pickAndAddFolder());
  mkA("Disconnect all", "deny", async () => { await clearAllRoots(); checkLocalFilesGrant(); bubble("msg note", "📁 All local folders disconnected."); });
  mkA("Cancel", "deny", async () => {});
  card.appendChild(actions);
}

// ---------- Schedule task / Create-shortcut modal ----------
const schedOverlay = document.getElementById("schedOverlay");
const schedToggle = document.getElementById("schedToggle");
const schedFields = document.getElementById("schedFields");
const schedRecurrence = document.getElementById("schedRecurrence");
const schedDate = document.getElementById("schedDate");
const schedWeekday = document.getElementById("schedWeekday");
const schedInterval = document.getElementById("schedInterval");
const schedTime = document.getElementById("schedTime");
const schedWindow = document.getElementById("schedWindow");
const schedWindowStart = document.getElementById("schedWindowStart");
const schedWindowEnd = document.getElementById("schedWindowEnd");
const schedDaysWrap = document.getElementById("schedDaysWrap");
const schedDays = document.getElementById("schedDays");
const schedNextNote = document.getElementById("schedNextNote");
const schedModel = document.getElementById("schedModel");
const schedMsg = document.getElementById("schedMsg");

// Build the schedule object from the form (matches normalizeSchedule's shape).
function readSchedule() {
  if (!schedToggle.checked) return { enabled: false };
  return {
    enabled: true,
    recurrence: schedRecurrence.value,
    date: schedDate.value,                       // "YYYY-MM-DD" from <input type=date>
    time: schedTime.value || "09:00",            // "HH:MM" from <input type=time>
    weekday: parseInt(schedWeekday.value, 10),
    intervalMinutes: parseInt(schedInterval.value, 10),  // "every N" preset
    windowStart: schedWindowStart.value,                 // "HH:MM" active-hours window (interval)
    windowEnd: schedWindowEnd.value,
    days: schedDays ? schedDays.value : "all"            // all | weekdays | market (interval + daily)
  };
}

// Show only the inputs the chosen recurrence needs: once→date, weekly→weekday,
// interval→the "every N" picker (no time-of-day), daily→just the time. Then
// refresh the "next run" preview.
function syncSchedFields() {
  schedFields.hidden = !schedToggle.checked;
  const r = schedRecurrence.value;
  schedDate.hidden = r !== "once";
  schedWeekday.hidden = r !== "weekly";
  schedInterval.hidden = r !== "interval";
  schedTime.hidden = r === "interval";           // interval has no time-of-day
  schedWindow.hidden = r !== "interval";         // active-hours window: interval only
  if (schedDaysWrap) schedDaysWrap.hidden = !(r === "interval" || r === "daily"); // day filter
  updateNextNote();
}

function updateNextNote() {
  if (!schedToggle.checked) { schedNextNote.textContent = ""; return; }
  // Flag a backwards window before computeNextFire silently drops it.
  if (schedRecurrence.value === "interval" && schedWindowStart.value && schedWindowEnd.value
      && schedWindowStart.value >= schedWindowEnd.value) {
    schedNextNote.textContent = "⚠ End time must be after start time.";
    schedNextNote.style.color = "var(--accent-orange)";
    return;
  }
  const next = computeNextFire(readSchedule());
  schedNextNote.textContent = next
    ? "Next run: " + new Date(next).toLocaleString()
    : (schedRecurrence.value === "once" ? "⚠ Pick a future date and time." : "⚠ Incomplete schedule.");
  schedNextNote.style.color = next ? "var(--accent-green)" : "var(--accent-orange)";
}

// Cloud picks are stored as "provider:modelId" (e.g. "anthropic:claude-haiku-4-5")
// so a single dropdown value carries both which provider to use and which model.
// A bare value (no prefix) is a local Ollama model id; "" = Default (from Settings).
const SCHED_CLOUD_PROVIDERS = [
  { id: "openai",    label: "☁ OpenAI",            keyName: "openaiKey" },
  { id: "gemini",    label: "☁ Gemini",            keyName: "geminiKey" },
  { id: "anthropic", label: "☁ Claude (Anthropic)", keyName: "anthropicKey" }
];

async function populateSchedModels() {
  schedModel.innerHTML = '<option value="">Default (from Settings)</option>';

  // Local Ollama models (if the daemon is reachable).
  try {
    const s = await getSettings();
    const models = await listModels(s.ollamaBase);
    // ":cloud"-tagged ids run on Ollama's servers (data egresses) -- never list
    // them under "Local". They get their own group so the egress is explicit.
    const groups = [
      ["🖥 Local (Ollama)", models.filter((m) => !m.endsWith(":cloud"))],
      ["☁ Ollama Cloud (data leaves this machine)", models.filter((m) => m.endsWith(":cloud"))]
    ];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      const og = document.createElement("optgroup");
      og.label = label;
      for (const m of list) {
        const o = document.createElement("option");
        o.value = m; o.textContent = m;
        og.appendChild(o);
      }
      schedModel.appendChild(og);
    }
  } catch { /* Ollama unreachable — Default + cloud options are still usable */ }

  // Cloud models, grouped by provider. Egress is opt-in: a provider with no key
  // in Settings is shown but its options are disabled (with a hint) so the user
  // knows to add a key before scheduling against it. ⚠ cloud runs send page/SN
  // content off the machine.
  try {
    const creds = await getCloudCreds();
    for (const p of SCHED_CLOUD_PROVIDERS) {
      const list = CLOUD_MODELS[p.id] || [];
      if (!list.length) continue;
      const hasKey = !!String(creds[p.keyName] || "").trim();
      const og = document.createElement("optgroup");
      og.label = hasKey ? p.label : `${p.label} — add a key in Settings`;
      for (const m of list) {
        const o = document.createElement("option");
        o.value = `${p.id}:${m.id}`;
        o.textContent = m.label;
        o.disabled = !hasKey;
        og.appendChild(o);
      }
      schedModel.appendChild(og);
    }
  } catch { /* creds unreachable — local options still available */ }
}

function openSchedModal() {
  // reset
  document.getElementById("schedName").value = "";
  document.getElementById("schedPrompt").value = "";
  document.getElementById("schedStart").value = "";
  schedToggle.checked = true;          // opened from "Schedule a task" → default scheduling ON
  schedRecurrence.value = "once";
  schedDate.value = "";
  schedWeekday.value = "1";
  schedInterval.value = "60";
  schedTime.value = "09:00";
  schedWindowStart.value = "";
  schedWindowEnd.value = "";
  if (schedDays) schedDays.value = "all";
  schedMsg.textContent = "";
  syncSchedFields();
  populateSchedModels();
  schedOverlay.classList.add("open");
  document.getElementById("schedPrompt").focus();
}

function closeSchedModal() { schedOverlay.classList.remove("open"); }

document.getElementById("menuSchedule").addEventListener("click", () => {
  attachMenu.classList.remove("open");
  openSchedModal();
});
document.getElementById("schedClose").addEventListener("click", closeSchedModal);
document.getElementById("schedCancel").addEventListener("click", closeSchedModal);
schedOverlay.addEventListener("click", (e) => { if (e.target === schedOverlay) closeSchedModal(); });
// Esc closes the Schedule / ServiceNow windows like Prompt Builder does (2026-09-14 redesign, a11y).
// Typed values are kept (same as the ✕ button); focus returns to the + button that opened them.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  let closed = false;
  if (schedOverlay.classList.contains("open")) { closeSchedModal(); closed = true; }
  else if (snOverlay.classList.contains("open")) { snOverlay.classList.remove("open"); closed = true; }
  if (closed) {
    e.stopPropagation();
    document.getElementById("attach")?.focus();
  }
});
schedToggle.addEventListener("change", syncSchedFields);
schedRecurrence.addEventListener("change", syncSchedFields);
schedDate.addEventListener("input", updateNextNote);
schedTime.addEventListener("input", updateNextNote);
schedWeekday.addEventListener("change", updateNextNote);
schedInterval.addEventListener("change", updateNextNote);
schedWindowStart.addEventListener("input", updateNextNote);
schedWindowEnd.addEventListener("input", updateNextNote);
if (schedDays) schedDays.addEventListener("change", updateNextNote);

document.getElementById("schedSave").addEventListener("click", async () => {
  const name = document.getElementById("schedName").value.trim();
  const prompt = document.getElementById("schedPrompt").value.trim();
  const startFrom = document.getElementById("schedStart").value.trim();
  const model = schedModel.value;
  if (!prompt) { schedMsg.textContent = "⚠ Prompt is required."; schedMsg.style.color = "var(--accent-red)"; return; }
  const schedule = readSchedule();
  if (schedule.enabled && computeNextFire(schedule) == null) {
    schedMsg.textContent = "⚠ That schedule can't run — pick a future date/time.";
    schedMsg.style.color = "var(--accent-red)";
    return;
  }
  try {
    await saveShortcut({ name: name || "task", prompt, startFrom, model, schedule });
    // Tell the background to (re)build alarms from the updated shortcuts.
    try { await chrome.runtime.sendMessage({ type: "shortcuts_changed" }); } catch {}
    closeSchedModal();
    if (schedule.enabled) {
      const next = computeNextFire(schedule);
      bubble("msg note", `✓ Scheduled "/${name || "task"}" — next run ${new Date(next).toLocaleString()}. (Runs here while Chrome is open.)`);
    } else {
      bubble("msg note", `✓ Saved shortcut "/${name || "task"}". Type /${name || "task"} to run it.`);
    }
  } catch (e) {
    schedMsg.textContent = "Save failed: " + e.message;
    schedMsg.style.color = "var(--accent-red)";
  }
});

// ---------- scheduled-run delivery ----------
// A fired alarm queues a run in background storage and (if we're open) pings us.
// We pull the queue and run each task VISIBLY here, one at a time (the agent is
// single-threaded), chaining the next from the run's "done" event.
let scheduledQueue = [];
let schedBannerEl = null;
// An unclean run death deliberately does NOT auto-chain the queue, so the banner
// must not keep promising "running now" — nothing will pick these up until the
// next run finishes. Cleared when a run starts (its "done" drains the queue).
let schedHalted = false;

function updateSchedBanner() {
  if (!scheduledQueue.length) { if (schedBannerEl) { schedBannerEl.remove(); schedBannerEl = null; } return; }
  if (!schedBannerEl) { schedBannerEl = bubble("sched-banner", ""); }
  const n = scheduledQueue.length, s = n > 1 ? "s" : "";
  schedBannerEl.textContent = schedHalted
    ? `⏰ ${n} scheduled task${s} queued — paused because the run stopped unexpectedly. Send any message to start them again.`
    : `⏰ ${n} scheduled task${s} queued — running ${busy ? "after the current one" : "now"}.`;
}

async function drainAndQueueScheduled() {
  let pending = [];
  try {
    const res = await chrome.runtime.sendMessage({ type: "drain_scheduled" });
    pending = (res && res.pending) || [];
  } catch { /* background unreachable */ }
  if (pending.length) {
    scheduledQueue.push(...pending);
    updateSchedBanner();
    maybeRunNextScheduled();
  }
}

async function maybeRunNextScheduled() {
  if (busy || !scheduledQueue.length) { updateSchedBanner(); return; }
  const entry = scheduledQueue.shift();
  updateSchedBanner();
  const list = await getShortcuts();
  const sc = list.find((s) => s.id === entry.scId);
  if (!sc) { bubble("msg note", `↳ Scheduled task "/${entry.name}" no longer exists — skipped.`); maybeRunNextScheduled(); return; }
  // Each scheduled cycle starts from a CLEAN context. The agent loop re-sends the
  // FULL conversation every step, so letting scheduled cycles accumulate would
  // balloon token cost across the day AND leak stale data (old prices/positions)
  // from one cycle into the next. Reset history so every scheduled run is bounded
  // and independent — equivalent to an automatic /clear before each run. (Manual
  // runs are untouched; clear those yourself with /clear.)
  if (history.length) {
    history = [];
    await saveHistory();
    await loadHistory();
  }
  bubble("msg note", `⏰ Running scheduled task "/${sc.name}" (fresh context)…`);
  runShortcut(sc);
}

// The background pings us when an alarm fires while we're open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "scheduled_pending") drainAndQueueScheduled();
});

// Filesystem MCP: the agent loop (service worker) delegates file ops to US because
// the File System Access permission was granted in THIS panel context. We hold the
// permitted directory handle and run the actual read/list/write here.
const _numOr = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "fs_op") return;
  (async () => {
    try {
      const roots = await getRootHandles();
      if (!roots.length) return sendResponse({ error: "No local folder is connected. Click '📁 Local files (MCP)' in the side panel and choose a folder." });
      const a = msg.args || {};
      // MULTI-ROOT: list_files at the TOP (empty path) with >1 folder connected →
      // return the connected folders so the model can drill into one by prefix.
      const emptyPath = !String(a.path || "").split(/[\/\\]+/).filter((s) => s && s !== ".").length;
      if (msg.op === "list_files" && roots.length > 1 && emptyPath) {
        const listing = roots.map((r) => `  [DIR] ${r.name}/`).join("\n");
        return sendResponse({ root: "(multiple)", roots: roots.map((r) => r.name), path: "", recursive: false,
          content: `Directory: .  (${roots.length} connected folders — prefix a path with a folder name to browse it, e.g. list_files "${roots[0].name}")\nDirectories: ${roots.length} | Files: 0\n\n${listing}\n`,
          count: roots.length, truncated: false });
      }
      // Route this op to ONE folder by its (prefixed) path.
      let root;
      try { root = pickRoot(roots, (msg.op === "move_file" || msg.op === "copy_file") ? a.from : (a.path != null ? a.path : a.pattern)); }
      catch (e) { return sendResponse({ error: e.message }); }
      if (msg.op === "move_file" || msg.op === "copy_file") {
        let toRoot; try { toRoot = pickRoot(roots, a.to); } catch (e) { return sendResponse({ error: e.message }); }
        if (toRoot.name !== root.name) return sendResponse({ error: `Cross-folder ${msg.op} isn't supported: "from" is in "${root.name}" but "to" resolves to "${toRoot.name}". Move/copy within a single connected folder.` });
      }
      const READ_OPS = new Set(["list_files", "read_file", "read_file_bytes", "search_files"]);
      const needWrite = !READ_OPS.has(msg.op); // every organize/write op mutates the folder
      let ok = needWrite ? await hasWritePermission(root) : await hasReadPermission(root);
      if (!ok && navigator.userActivation?.isActive) {
        // The grant lapsed but the user JUST interacted with the panel (e.g. hit
        // Enter to send the message that started this run) — that transient
        // activation lets requestPermission re-prompt right here, so the op can
        // self-heal instead of erroring into a re-connect loop (2026-07-11).
        try { ok = await ensurePermission(root, needWrite ? "readwrite" : "read"); } catch {}
      }
      if (!ok) {
        checkLocalFilesGrant(); // surface the Reconnect strip immediately, naming this folder
        return sendResponse({ error: (needWrite
          ? `Chrome reset the write grant on the connected folder "${root.name}" (it lapses after a browser restart). `
          : `Chrome reset the read grant on the connected folder "${root.name}" (it lapses after a browser restart). `) +
          `The user must click "Reconnect" on the orange strip at the bottom of the side panel (or 📁 Local files (MCP) → Reconnect) — nothing you call can re-grant it. Do NOT retry this or other file tools on "${root.name}" until then: finish the rest of the task, put the full deliverable in your reply, and end with one line asking the user to click Reconnect so you can save it.` });
      }
      if (msg.op === "list_files") {
        const out = await listDir(root, a.path || "", a.recursive === true);
        return sendResponse({ root: root.name, path: a.path || "", recursive: a.recursive === true, ...out });
      }
      if (msg.op === "read_file") {
        let out;
        try {
          out = await readFileText(root, a.path, { startLine: _numOr(a.start_line), endLine: _numOr(a.end_line), maxChars: _numOr(a.max_chars) });
        } catch (e) {
          // NO text layer (scanned / undecodable font): hand the BYTES back so the
          // worker can send them to the desktop-server for PyMuPDF + Tesseract OCR
          // (2026-09-07c). The old path threw here and told the model to call
          // read_pdf with an absolute path it had no way of knowing.
          if (e && e.code === "NO_TEXT_LAYER") {
            const bytes = await readFileBytesB64(root, a.path);
            return sendResponse({ root: root.name, path: a.path, name: bytes.name, size: bytes.size, no_text_layer: true, pdf_base64: bytes.base64, extractor_error: e.message });
          }
          throw e;
        }
        return sendResponse({ root: root.name, path: a.path, ...out });
      }
      // Internal (not a model tool): read_pdf on a connected-folder path asks for
      // the file's bytes and ships them to the desktop-server (2026-09-07c).
      if (msg.op === "read_file_bytes") {
        const bytes = await readFileBytesB64(root, a.path);
        return sendResponse({ root: root.name, path: a.path, ...bytes });
      }
      // Organize ops (fsaccess.js): move/copy transfer raw bytes, so they work on
      // every file type — including the binaries read_file blocks.
      if (msg.op === "create_folder") {
        const out = await createFolder(root, a.path);
        return sendResponse({ ok: true, root: root.name, ...out });
      }
      if (msg.op === "move_file" || msg.op === "copy_file") {
        const fn = msg.op === "move_file" ? movePath : copyPath;
        const out = await fn(root, a.from, a.to, { overwrite: a.overwrite === true });
        return sendResponse({ ok: true, root: root.name, op: msg.op === "move_file" ? "moved" : "copied", ...out });
      }
      if (msg.op === "delete_file") {
        const out = await deletePath(root, a.path, { recursive: a.recursive === true });
        return sendResponse({ ok: true, root: root.name, ...out });
      }
      if (msg.op === "edit_file") {
        const out = await editFile(root, a.path, a.old_text, a.new_text, { replaceAll: a.replace_all === true });
        return sendResponse({ ok: true, root: root.name, path: a.path, ...out });
      }
      if (msg.op === "search_files") {
        const out = await searchFiles(root, a.pattern, { path: a.path, glob: a.glob, caseSensitive: a.case_sensitive === true });
        return sendResponse({ root: root.name, ...out });
      }
      if (msg.op === "create_document") {
        // Generate a formatted document from Markdown and SAVE it to the folder.
        // .md is plain text; .docx/.pdf are binary (built by export.js, which uses
        // the DOM/canvas only available here in the panel).
        const fmt = String(a.format || "md").toLowerCase();
        const content = String(a.content ?? "");
        let res;
        if (fmt === "md" || fmt === "markdown" || fmt === "txt") {
          res = await writeFileText(root, a.path, content);
        } else if (fmt === "docx") {
          res = await writeFileBytes(root, a.path, buildDocxBytes(content));
        } else if (fmt === "pdf") {
          res = await writeFileBytes(root, a.path, buildPdfBytes(content));
        } else {
          return sendResponse({ error: `Unsupported document format "${fmt}". Use md, docx, or pdf.` });
        }
        return sendResponse({ ok: true, root: root.name, path: a.path, format: fmt, ...res });
      }
      const res = await writeFileText(root, a.path, a.content); // write_file
      return sendResponse({ ok: true, root: root.name, path: a.path, ...res });
    } catch (e) {
      sendResponse({ error: "Filesystem error: " + (e && e.message ? e.message : String(e)) });
    }
  })();
  return true; // async response
});

// Filesystem MCP status probe: the service worker asks US (the panel that holds
// the directory handle) whether a folder is connected and readable, so it can
// inject a "connected local folder" ground-truth block into the system prompt at
// the START of a run — that's what makes the model actually consult the folder
// for context instead of ignoring the read tools. Cheap, gesture-free
// (queryPermission only), and returns { connected, root, canWrite }.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "fs_status") return;
  (async () => {
    try {
      const roots = await getRootHandles();
      if (!roots.length) return sendResponse({ connected: false });
      const info = [];
      for (const h of roots) {
        const canRead = await hasReadPermission(h).catch(() => false);
        const canWrite = canRead ? await hasWritePermission(h).catch(() => false) : false;
        info.push({ name: h.name, canWrite: !!canWrite, needsReconnect: !canRead });
      }
      const readable = info.filter((r) => !r.needsReconnect);
      if (!readable.length) return sendResponse({ connected: false, roots: info, root: info[0] && info[0].name, needsReconnect: true });
      // Legacy fields (root/canWrite = the FIRST readable folder) kept for older
      // callers; `roots` carries the full set for the multi-root prompt note.
      sendResponse({ connected: true, roots: info, root: readable[0].name, canWrite: readable.every((r) => r.canWrite) });
    } catch (e) {
      sendResponse({ connected: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // async response
});

// On panel load, pick up anything that fired while we were closed.
drainAndQueueScheduled();

// ---------- act mode: plan first / ask before acting / act without asking ----------
const modeBtn = document.getElementById("modeBtn");
const modeMenu = document.getElementById("modeMenu");
const checkPlan = document.getElementById("checkPlan");
const checkAsk = document.getElementById("checkAsk");
const checkAuto = document.getElementById("checkAuto");
const checkReadonly = document.getElementById("checkReadonly");
let actMode = "plan"; // default: draft a plan and wait for approval before acting

function renderMode() {
  modeBtn.textContent = actMode === "auto" ? "Act without asking"
    : actMode === "plan" ? "Plan first"
    : actMode === "readonly" ? "Read-only"
    : "Ask before acting";
  modeBtn.dataset.mode = actMode; // 2026-09-14 redesign: CSS draws the mode's color dot and the menu chevron
  checkPlan.style.display = actMode === "plan" ? "" : "none";
  checkAsk.style.display = actMode === "ask" ? "" : "none";
  checkAuto.style.display = actMode === "auto" ? "" : "none";
  checkReadonly.style.display = actMode === "readonly" ? "" : "none";
}
async function loadMode() {
  try {
    const { actMode: m } = await chrome.storage.local.get("actMode");
    actMode = (m === "auto" || m === "ask" || m === "plan" || m === "readonly") ? m : "plan";
  } catch { actMode = "plan"; }
  renderMode();
}
async function setMode(m) {
  actMode = m;
  try { await chrome.storage.local.set({ actMode: m }); } catch {}
  renderMode();
  modeMenu.classList.remove("open");
}
modeBtn.addEventListener("click", (e) => { e.stopPropagation(); modeMenu.classList.toggle("open"); });
document.addEventListener("click", () => modeMenu.classList.remove("open"));
document.getElementById("modePlan").addEventListener("click", () => setMode("plan"));
document.getElementById("modeAsk").addEventListener("click", () => setMode("ask"));
document.getElementById("modeAuto").addEventListener("click", () => setMode("auto"));
document.getElementById("modeReadonly").addEventListener("click", () => setMode("readonly"));
loadMode();
// Settings > Behavior and limits writes the same actMode; an open panel follows it.
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.actMode) loadMode(); });

// Build a readable, action-specific preview for the approval card. Returns a
// string (rendered in a <pre>) or "" to fall back to the JSON dump.
function approvalPreview(name, args) {
  if (!args) return "";
  if (name === "run_command") {
    return `$ ${args.command}${args.cwd ? `\n  (in ${args.cwd})` : ""}`;
  }
  if (name === "edit_file") {
    const old = String(args.old_text ?? "").split("\n").map((l) => "- " + l);
    const neu = String(args.new_text ?? "").split("\n").map((l) => "+ " + l);
    const lines = [...old, ...neu];
    const shown = lines.slice(0, 30).join("\n");
    return `${args.path}${args.replace_all ? "  (all occurrences)" : ""}\n${shown}${lines.length > 30 ? `\n… (+${lines.length - 30} more)` : ""}`;
  }
  if (name === "create_shortcut") {
    const body = String(args.prompt ?? "");
    return `/${String(args.name || "").trim().toLowerCase()}${args.replace_existing ? "  (replaces the existing shortcut)" : ""}\n${describeShortcutArgs(args)}\n${body.slice(0, 600)}${body.length > 600 ? "\n… (" + body.length + " chars total)" : ""}`;
  }
  if (name === "write_file" || name === "create_document") {
    const body = String(args.content ?? "");
    return `${args.path}${args.format ? `  (${args.format})` : ""}\n${body.slice(0, 600)}${body.length > 600 ? "\n… (" + body.length + " chars total)" : ""}`;
  }
  if (name === "http_request") {
    return `${String(args.method || "GET").toUpperCase()} ${args.url}${args.body ? `\n${String(args.body).slice(0, 400)}` : ""}`;
  }
  if (name === "delete_file") return `Delete: ${args.path}${args.recursive ? "  (recursive — folder + contents)" : ""}`;
  if (name === "send_email") return `To: ${args.to}\nSubject: ${args.subject || "(none)"}`;
  // Show the EXACT outgoing chat message so the user approves the wording, not JSON.
  if (name === "send_chat_message") return `To: ${args.recipient}\n${String(args.message ?? "").slice(0, 600)}`;
  return "";
}

// Render an inline approval request with Allow / Deny buttons. `container` and
// `labelPrefix` let a sub-agent's request render inside its own panel (C.6/MF-6).
function approvalCard(id, name, args, container = logEl, labelPrefix = "") {
  const d = document.createElement("div");
  d.className = "tool approval";
  // An approval request is never a pure read; an unclassified tool gets the neutral "check the details" band.
  const tier = riskTier(name, args) === "read" ? "review" : riskTier(name, args);
  d.innerHTML = riskBandHtml(tier, labelPrefix + RISK_META[tier].label)
    + `<span class="name">Allow this step? ${escapeHtml(friendlyToolLabel(name, args).replace(/…$/, ""))}<span class="tool-tech">${escapeHtml(labelPrefix + name)}</span></span>`;
  // Human-reviewable preview for the high-stakes tools: a command line, a file
  // diff, or the target URL — so the user approves WHAT will happen, not raw JSON.
  const preview = approvalPreview(name, args);
  if (preview) {
    const pv = document.createElement("pre");
    pv.className = "approval-preview";
    pv.textContent = preview.slice(0, 2000);
    d.appendChild(pv);
  } else if (args && Object.keys(args).length) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(args, null, 1).slice(0, 800);
    d.appendChild(pre);
  }
  const row = document.createElement("div");
  row.className = "approval-actions";
  const allow = document.createElement("button");
  allow.className = "allow";
  allow.textContent = "Allow";
  const deny = document.createElement("button");
  deny.className = "deny";
  deny.textContent = "Deny";
  const decide = (approved) => {
    try { port?.postMessage({ type: "approve", id, approved }); } catch {}
    allow.disabled = true;
    deny.disabled = true;
    const note = document.createElement("div");
    note.className = "approval-done";
    note.textContent = approved ? "✓ Allowed" : "✗ Denied";
    d.appendChild(note);
  };
  allow.addEventListener("click", () => decide(true));
  deny.addEventListener("click", () => decide(false));
  row.append(allow, deny);
  d.appendChild(row);
  container.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- local Whisper availability (used by the 🎬 Teach-a-workflow narration) ----------
let whisperOkUntil = 0;      // health-check cache expiry (ms epoch)
let whisperOk = false;

// Is the local Whisper server up? (cached for 30s)
async function whisperAvailable() {
  const now = Date.now();
  if (now < whisperOkUntil) return whisperOk;
  const s = await getSettings();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 800);
    const res = await fetch(`${s.whisperUrl}/health`, { signal: ctl.signal });
    clearTimeout(t);
    whisperOk = res.ok;
  } catch {
    whisperOk = false;
  }
  whisperOkUntil = now + 30000;
  return whisperOk;
}

// ---------- export the whole conversation ----------
// Serialize history into one markdown doc with role headings; the export.js
// helpers turn that into .md / .docx / .pdf (or copy it).
// Compact one-line summaries of a tool's args / result for the export trace.
function exportArgs(name, args) {
  if (name === "send_sms" || name === "send_email") return " _(recipient/body hidden)_";
  if (!args || !Object.keys(args).length) return "";
  const s = JSON.stringify(args);
  return " `" + (s.length > 140 ? s.slice(0, 140) + "…" : s) + "`";
}
function exportResult(r) {
  if (r == null) return "ok";
  if (r.error) return "✗ " + String(r.error).slice(0, 200);
  const s = JSON.stringify(r);
  return "✓ " + (s.length > 240 ? s.slice(0, 240) + "…" : s);
}

// Strip developer-facing internals from an assistant/plan turn so a USAGE-tier export
// reads as a plain conversation (user complaint: the exported .md "can't be followed").
// Removes [E#.O#] citation tokens, the trailing "Evidence ledger" provenance block, and the
// internal "🛑/✅ GATED:" gate banner — while KEEPING any "### ❓ To proceed" follow-up
// questions. Admin exports are untouched (they keep the full audit detail).
function cleanTurnForUsage(text) {
  let s = stripCites(String(text || ""));
  s = s.replace(/\n*(?:---\s*\n)?\**Evidence ledger\**[^\n]*\n[\s\S]*?(?=\n---\n|\n#{2,3} |$)/g, "");
  s = s.replace(/\n*(?:---\s*\n)?(?:🛑|✅) GATED:[^\n]*\n?/g, "\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function conversationMarkdown() {
  const head = `# Agent Go — Conversation\n\n_Exported ${new Date().toLocaleString()}_`;
  // Prefer the rich live transcript (turns + tool steps + sub-agents); fall back
  // to plain restored turns when there's no live activity (e.g. after a reload).
  const src = transcript.length
    ? transcript
    : history.map((m) => ({ t: m.role === "user" ? "user" : "assistant", text: m.content }));
  // Full parity (2026-07-30): every tier exports the full trace (tool calls, sub-agents),
  // matching the local-claude-extension behavior. The clean/usage filter is retired.
  const clean = false;
  const lines = [head];
  for (const e of src) {
    switch (e.t) {
      case "user": lines.push(`\n## You\n\n${e.text}`); break;
      case "assistant": lines.push(`\n## Agent Go\n\n${clean ? cleanTurnForUsage(e.text) : e.text}`); break;
      case "plan": lines.push(`\n## Agent Go — plan\n\n${clean ? cleanTurnForUsage(e.text) : e.text}`); break;
      case "tool": if (!clean) lines.push(`- 🔧 \`${e.name}\`${exportArgs(e.name, e.args)}`); break;
      case "tool_result": if (!clean) lines.push(`  - ↳ ${exportResult(e.result)}`); break;
      case "child_tool": if (!clean) lines.push(`  - ▸ **sub-agent ${e.childId}** 🔧 \`${e.name}\`${exportArgs(e.name, e.args)}`); break;
      case "child_tool_result": if (!clean) lines.push(`    - ↳ ${exportResult(e.result)}`); break;
      case "child_final": if (!clean) lines.push(`  - ▸ **sub-agent ${e.childId} →** ${String(e.text || "").slice(0, 600)}`); break;
    }
  }
  return lines.join("\n");
}

const exportBtn = document.getElementById("exportBtn");
const exportMenu = document.getElementById("exportMenu");

function exportConversation(kind) {
  exportMenu.classList.remove("open");
  if (!history.length) { bubble("msg note", "Nothing to export yet."); return; }
  const md = conversationMarkdown();
  const base = exportBaseName("conversation", firstUserAsk());
  if (kind === "copy") copyText(md);
  else if (kind === "md") downloadMarkdown(md, base);
  else if (kind === "docx") downloadDocx(md, base);
  else if (kind === "pdf") downloadPdf(md, base);
}

exportBtn.addEventListener("click", (e) => { e.stopPropagation(); exportMenu.classList.toggle("open"); });
document.addEventListener("click", () => exportMenu.classList.remove("open"));
document.getElementById("expCopy").addEventListener("click", () => exportConversation("copy"));
document.getElementById("expMd").addEventListener("click", () => exportConversation("md"));
document.getElementById("expDocx").addEventListener("click", () => exportConversation("docx"));
document.getElementById("expPdf").addEventListener("click", () => exportConversation("pdf"));

// ---------- zoom (readability) ----------
// Scales the conversation area only, so the header controls and input stay put.
// Persisted in chrome.storage.local. Buttons + Ctrl +/-/0 + Ctrl+wheel.
const ZOOM_MIN = 0.7, ZOOM_MAX = 2.5, ZOOM_STEP = 0.1;
let zoom = 1;

function applyZoom() { logEl.style.zoom = zoom; }
async function loadZoom() {
  try {
    const { panelZoom } = await chrome.storage.local.get("panelZoom");
    if (typeof panelZoom === "number" && panelZoom >= ZOOM_MIN && panelZoom <= ZOOM_MAX) zoom = panelZoom;
  } catch {}
  applyZoom();
}
function setZoom(z) {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));
  applyZoom();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight; // keep the latest in view
  try { chrome.storage.local.set({ panelZoom: zoom }); } catch {}
}
document.getElementById("zoomIn").addEventListener("click", () => setZoom(zoom + ZOOM_STEP));
document.getElementById("zoomOut").addEventListener("click", () => setZoom(zoom - ZOOM_STEP));
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === "=" || e.key === "+") { e.preventDefault(); setZoom(zoom + ZOOM_STEP); }
  else if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom(zoom - ZOOM_STEP); }
  else if (e.key === "0") { e.preventDefault(); setZoom(1); }
});
logEl.addEventListener("wheel", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
}, { passive: false });

// ---------- wiring ----------
sendBtn.addEventListener("click", submit);
inputEl.addEventListener("keydown", (e) => {
  if (slashOpen()) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSlashSel(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveSlashSel(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseSlash(); return; }
  }
  // ↑/↓ recall previous prompts (only when the slash menu is closed and the
  // caret is on the first/last line, so multiline editing still works).
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && historyNav(e)) return;
  // Enter sends when idle; while a run is in progress it STEERS (injects a side
  // message the agent picks up next step — "/btw"), without stopping. The red Stop
  // button is the way to cancel.
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (busy) steer(); else submit(); }
});
clearBtn.addEventListener("click", async () => {
  if (busy) return;
  history = [];
  await saveHistory();
  await loadHistory();
});
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

// Appearance menu (System / Light / Dark) — 2026-09-14 redesign. Visual only: applies
// the theme via theme-boot.js and stores it in its own sync key (uiTheme), never inside the settings object.
function renderAppearance(v) {
  const val = v === "light" || v === "dark" ? v : "system";
  const name = { system: "System", light: "Light", dark: "Dark" }[val];
  const btn = document.getElementById("appearanceBtn");
  const menu = document.getElementById("appearanceMenu");
  if (btn) { btn.title = `Appearance: ${name}`; btn.setAttribute("aria-label", `Appearance: ${name}`); }
  if (menu) menu.querySelectorAll("[data-theme-choice]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeChoice === val)));
}
{
  const appearanceBtn = document.getElementById("appearanceBtn");
  const appearanceMenu = document.getElementById("appearanceMenu");
  if (appearanceBtn && appearanceMenu) {
    appearanceBtn.addEventListener("click", (e) => {
      e.stopPropagation(); exportMenu.classList.remove("open"); appearanceMenu.classList.toggle("open");
      if (appearanceMenu.classList.contains("open")) (appearanceMenu.querySelector('[aria-checked="true"]') || appearanceMenu.querySelector("[data-theme-choice]")).focus();
    });
    document.addEventListener("click", () => appearanceMenu.classList.remove("open"));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && appearanceMenu.classList.contains("open")) { appearanceMenu.classList.remove("open"); appearanceBtn.focus(); } });
    appearanceMenu.querySelectorAll("[data-theme-choice]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = b.dataset.themeChoice;
      appearanceMenu.classList.remove("open");
      // Own sync key (uiTheme): never reads or rewrites the settings object, so it cannot undo a Settings save.
      if (window.__agSaveTheme) window.__agSaveTheme(v); else if (window.__agSetTheme) window.__agSetTheme(v);
      renderAppearance(v);
      appearanceBtn.focus();
    }));
    // Keyboard: arrows, Home and End move between the three choices; Enter or Space picks (native buttons).
    appearanceMenu.addEventListener("keydown", (e) => {
      const items = [...appearanceMenu.querySelectorAll("[data-theme-choice]")];
      const i = items.indexOf(document.activeElement);
      let next = -1;
      if (e.key === "ArrowDown") next = (i + 1) % items.length;
      else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      if (next >= 0) { e.preventDefault(); items[next].focus(); }
    });
    renderAppearance(window.__agGetTheme ? window.__agGetTheme() : "system");
    window.addEventListener("ag-theme-applied", (e) => renderAppearance(e.detail)); // late sync correction on open
    appearanceMenu.addEventListener("focusout", (e) => { if (!appearanceMenu.contains(e.relatedTarget) && e.relatedTarget !== appearanceBtn) appearanceMenu.classList.remove("open"); });
  }
}

// Stop in the pinned progress bar: same message as the send button's Stop (submit()).
document.getElementById("procStop")?.addEventListener("click", () => {
  if (!busy) return;
  try { port?.postMessage({ type: "stop" }); } catch {}
});

loadHistory().then(checkResumable); // offer to resume an interrupted run (after history renders)
// First-run setup (welcome.html) hands a starter prompt to the message box. It only fills
// the box; the user reviews it and presses send.
function takeWelcomePrompt(text) {
  if (typeof text !== "string" || !text.trim()) return;
  // Never replace a draft or interrupt a run: the prompt stays stored and fills the box the next time
  // the panel opens with an empty composer.
  if (busy || inputEl.value.trim()) return;
  chrome.storage.local.remove(["agWelcomePrompt", "agWelcomePromptAt"]).catch(() => {});
  inputEl.value = text;
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  inputEl.focus();
}
// A starter prompt older than 10 minutes is stale (the panel was not opened after first run): drop it.
chrome.storage.local.get(["agWelcomePrompt", "agWelcomePromptAt"]).then((r) => {
  if (r.agWelcomePrompt && r.agWelcomePromptAt && Date.now() - r.agWelcomePromptAt > 10 * 60 * 1000) {
    chrome.storage.local.remove(["agWelcomePrompt", "agWelcomePromptAt"]).catch(() => {});
    return;
  }
  takeWelcomePrompt(r.agWelcomePrompt);
}).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.agWelcomePrompt) takeWelcomePrompt(changes.agWelcomePrompt.newValue);
});
initListen({ run, bubble, isBusy: () => busy, inputEl }); // 🎤 dictation + 🎧 meeting listener
initConvLog({ bubble, getMarkdown: conversationMarkdown, getEvents: () => transcript, getHistory: () => history }); // 💾 auto-save conversations for training
loadPromptHistory();
loadZoom();
checkStatus();
autoGrow();
inputEl.focus();

// Self-heal the status indicator: re-check when the panel regains focus and
// on a slow idle interval, so a recovered/restarted Ollama clears the warning.
window.addEventListener("focus", () => checkStatus());
setInterval(() => { if (!busy) checkStatus(); }, 20000);


// A11y (UI/UX standards compliance, 2026-07-19): keep aria-expanded truthful on
// the menu trigger buttons. Observer-only -- no existing handler is touched.
for (const [btnId, menuId] of [["attach", "attachMenu"], ["listenBtn", "listenMenu"], ["modeBtn", "modeMenu"], ["exportBtn", "exportMenu"], ["appearanceBtn", "appearanceMenu"]]) {
  const btn = document.getElementById(btnId);
  const menu = document.getElementById(menuId);
  if (!btn || !menu) continue;
  const syncExpanded = () => btn.setAttribute("aria-expanded", menu.classList.contains("open") ? "true" : "false");
  new MutationObserver(syncExpanded).observe(menu, { attributes: true, attributeFilter: ["class"] });
  syncExpanded();
}
