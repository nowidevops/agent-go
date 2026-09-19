/* __LLMGO_IIFE_WRAP__ v1 re-injection-safe */
;(function(){
// content.js — injected into pages; reads DOM and performs actions.
// Pierces open Shadow DOM and same-origin iframes (e.g. ServiceNow gsft_main,
// Now Experience web components). Author: iDevOpsLLC

// Surface an otherwise-silent failure to the page's dev console. Many catch
// blocks here intentionally degrade (e.g. an invalid selector → empty result),
// but a fully silent swallow makes an incomplete read or a no-op click
// impossible to diagnose. This leaves a greppable breadcrumb without changing
// the non-fatal fallback behaviour. Cross-origin iframe access is EXPECTED to
// fail, so frameDoc() deliberately does not call this.
function lcWarn(context, e) {
  const msg = e && e.message ? e.message : String(e);
  try { console.warn(`[local-claude] ${context}:`, msg); } catch {}
}

// ---------------------------------------------------------------------------
// Deep traversal: regular DOM + open shadowRoots + same-origin iframe docs.
// ---------------------------------------------------------------------------

// Get the same-origin document of an iframe, or null if cross-origin/unloaded.
function frameDoc(iframe) {
  try {
    return iframe.contentDocument || iframe.contentWindow?.document || null;
  } catch {
    return null; // cross-origin — inaccessible by design
  }
}

// Run a selector against one root, supporting Playwright-style ":has-text(...)"
// (NOT valid CSS) — models reach for it constantly. "button:has-text('Log in')"
// → query the base ("button"), then keep elements whose text contains "Log in".
function lcQuerySelectorAll(root, selector) {
  const m = String(selector).match(/^\s*(.*?):has-text\(\s*(['"]?)(.*?)\2\s*\)\s*$/i);
  if (m) {
    const base = (m[1] || "").trim() || "*";
    const want = (m[3] || "").trim().toLowerCase();
    let els = [];
    try { els = [...root.querySelectorAll(base)]; } catch (e) { lcWarn(`lcQuerySelectorAll base "${base}"`, e); return []; }
    return els.filter((el) => ((el.innerText || el.textContent || "").toLowerCase().includes(want)));
  }
  return [...root.querySelectorAll(selector)];
}

// Collect all elements matching `selector`, descending into shadow roots and
// same-origin iframes. `root` is a Document or ShadowRoot.
function deepQueryAll(selector, root = document, depth = 0, out = new Set()) {
  if (depth > 12) return out;
  let matches = [];
  // An invalid CSS selector throws here (caller usually surfaces it); a valid one
  // that throws is unexpected and worth a breadcrumb. ":has-text()" is handled.
  try { matches = lcQuerySelectorAll(root, selector); } catch (e) { lcWarn(`deepQueryAll selector "${selector}"`, e); matches = []; }
  for (const el of matches) out.add(el);

  let all = [];
  try { all = root.querySelectorAll("*"); } catch (e) { lcWarn("deepQueryAll walk '*'", e); all = []; }
  for (const el of all) {
    if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, depth + 1, out);
    if (el.tagName === "IFRAME") {
      const doc = frameDoc(el);
      if (doc) deepQueryAll(selector, doc, depth + 1, out);
    }
  }
  return out;
}

// Non-content elements whose text is CSS/JS noise, not page content. Reading
// .innerText on a <style> child of a shadow root leaks the whole stylesheet
// (e.g. LinkedIn's ":host{--black:#000;...}") and floods read_page.
const NON_CONTENT_TAGS = /^(STYLE|SCRIPT|NOSCRIPT|TEMPLATE|LINK|META)$/;

// Visible-text of a Document or ShadowRoot (innerText isn't on ShadowRoot).
function nodeText(node) {
  if (node.body) return node.body.innerText || "";                 // Document
  return Array.from(node.children || [])                            // ShadowRoot
    .filter((c) => !NON_CONTENT_TAGS.test(c.tagName))
    .map((c) => c.innerText || "")
    .join("\n");
}

// read_page cost guards. A ServiceNow catalog form with variable-heavy sections
// (e.g. a catalog item's Variables in the Notes section) has an enormous DOM, and
// nodeText()'s .innerText forces a synchronous layout reflow on every node it
// touches — walking every element AND every shadow root that way stalls for many
// seconds ("stuck reading form sections with too many variables"). We only ever
// KEEP maxChars of text, so once we have plenty there is no reason to keep
// reflowing. Bound the walk by wall-clock, node count, and collected chars; return
// best-effort partial text (flagged) instead of hanging. The 8s per-frame timeout
// and instant Stop are the outer nets; this stops the walk from being slow at all.
const READ_PAGE_BUDGET_MS = 2500;   // hard wall-clock cap for the whole walk
const READ_PAGE_MAX_NODES = 25000;  // elements scanned before we bail
const READ_PAGE_MAX_CHARS = 120000; // collected chars before we bail (>> any slice)

// Aggregate visible text across the top doc, shadow roots, and iframe docs.
// `budget` (created in readPage) bounds the traversal; when any limit trips we set
// budget.hit and unwind so the caller returns what it already has.
function collectText(root, acc, depth, budget) {
  if (depth > 12) return;
  if (budget.hit || performance.now() > budget.deadline) { budget.hit = true; return; }
  const t = nodeText(root);
  acc.push(t);
  budget.chars += t.length;
  if (budget.chars >= READ_PAGE_MAX_CHARS) { budget.hit = true; return; }
  const host = root.body || root;
  let all = [];
  try { all = host.querySelectorAll("*"); } catch (e) { lcWarn("collectText walk '*'", e); all = []; }
  for (const el of all) {
    // Cheap per-node budget check (performance.now() is sub-microsecond) so a form
    // with tens of thousands of variable widgets can't run the walk unbounded.
    if (++budget.nodes > READ_PAGE_MAX_NODES || performance.now() > budget.deadline) { budget.hit = true; return; }
    if (el.shadowRoot) { collectText(el.shadowRoot, acc, depth + 1, budget); if (budget.hit) return; }
    if (el.tagName === "IFRAME") {
      const doc = frameDoc(el);
      if (doc) { budget.frames++; collectText(doc, acc, depth + 1, budget); if (budget.hit) return; }
    }
  }
}

function isVisible(el) {
  try {
    const win = el.ownerDocument.defaultView || window;
    const rect = el.getBoundingClientRect();
    const style = win.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Element handles: stable ids that survive shadow/iframe boundaries.
// ---------------------------------------------------------------------------
const registry = new Map();
let counter = 0;
// Per-frame token so handles are GLOBALLY unique across frames. content.js now
// runs in EVERY frame (all_frames), so two frames minting "lc-1" would collide —
// a broadcast click for one frame's "lc-1" would wrongly resolve the OTHER frame's
// "lc-1". The token guarantees "lc-<token>-N" resolves in exactly one frame.
const FRAME_TOKEN = Math.random().toString(36).slice(2, 8);

function tag(el) {
  let id = el.getAttribute("data-lc-id");
  if (!id) {
    id = "lc-" + FRAME_TOKEN + "-" + ++counter;
    try { el.setAttribute("data-lc-id", id); } catch {}
  }
  registry.set(id, el);
  return id;
}

function resolveHandle(handle) {
  if (registry.has(handle)) {
    const el = registry.get(handle);
    if (el && el.isConnected) return el;
    registry.delete(handle);
  }
  // re-find by the data attribute across frames/shadow roots
  const esc = window.CSS && CSS.escape ? CSS.escape(handle) : handle;
  const byId = [...deepQueryAll(`[data-lc-id="${esc}"]`)][0];
  if (byId) return byId;
  // last resort: treat the handle as a plain CSS selector
  try {
    const byCss = [...deepQueryAll(handle)][0];
    if (byCss) return byCss;
  } catch (e) {
    lcWarn(`resolveHandle CSS fallback "${handle}"`, e);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------
function readPage(maxChars = 6000) {
  const acc = [];
  // budget.frames is counted DURING the walk, replacing a second full deepQueryAll
  // tree traversal that used to run just to count iframes (a second reflow storm).
  const budget = { chars: 0, nodes: 0, frames: 0, hit: false, deadline: performance.now() + READ_PAGE_BUDGET_MS };
  collectText(document, acc, 0, budget);
  const text = acc.join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  return {
    title: document.title,
    url: location.href,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    // partial === true means the cost guard stopped the walk early (huge form) — the
    // text is best-effort, not the whole page. The model should act on what it has
    // (or target a specific field with query_elements) rather than re-read.
    partial: budget.hit || undefined,
    pierced_frames: budget.frames
  };
}

// Identify a form field: its id/name and the human label tied to it.
// Critical for telling apart e.g. ServiceNow's "Short description" input
// (incident.short_description) from the "Description" textarea.
// A <label> that WRAPS its control also wraps the control's own text: every <option> of a <select>, a
// textarea's contents. Read the label without its controls, or a dropdown's label came back as
// "Care type Personal care Companionship Dementia care …" (Saved workflows video probe 2026-09-13).
function labelText(lab) {
  try {
    if (!lab.querySelector("select, textarea, input, option")) return (lab.innerText || "").trim();
    const c = lab.cloneNode(true);
    c.querySelectorAll("select, textarea, input, option").forEach((n) => n.remove());
    return (c.textContent || "").replace(/\s+/g, " ").trim();
  } catch {
    return (lab.innerText || "").trim();
  }
}
function fieldInfo(el) {
  const doc = el.ownerDocument || document;
  let label = el.getAttribute?.("aria-label") || "";
  if (!label && el.id) {
    try {
      const lab = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) label = labelText(lab);
    } catch {}
  }
  if (!label) {
    const lab = el.closest?.("label");
    if (lab) label = labelText(lab);
  }
  if (!label) label = el.getAttribute?.("placeholder") || "";
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    name: el.getAttribute?.("name") || undefined,
    label: label ? label.slice(0, 80) : undefined
  };
}

// Derive a SEMANTIC hint for an ICON-ONLY control (chevron/arrow buttons, pager
// prev/next, accordion toggles) that carries no visible text — otherwise the
// agent sees a blank button and can't tell "next" from "expand". Reads aria-label,
// title, tooltip, class names, child SVG/<use>/icon classes, and Unicode arrow
// glyphs, then maps to tags: next|prev|up|down|expand|collapse|close|menu|play|pause.
function iconHint(el) {
  const bits = [];
  const push = (v) => { if (v) bits.push(String(v).toLowerCase()); };
  push(el.getAttribute?.("aria-label"));
  push(el.getAttribute?.("title"));
  push(el.getAttribute?.("data-tooltip"));
  push(el.getAttribute?.("data-icon"));
  push(el.getAttribute?.("data-action"));
  try { push(typeof el.className === "string" ? el.className : el.getAttribute?.("class")); } catch {}
  try {
    // Child icon carriers: <svg>/<i>/<use>/<img>/<path> classes, alt, href, <title>.
    el.querySelectorAll?.("svg, i, span[class], use, img, [data-icon]").forEach((c) => {
      push(c.getAttribute?.("class"));
      push(c.getAttribute?.("alt"));
      push(c.getAttribute?.("aria-label"));
      push(c.getAttribute?.("data-icon"));
      push(c.getAttribute?.("xlink:href") || c.getAttribute?.("href"));
    });
    const st = el.querySelector?.("svg title, svg desc");
    if (st) push(st.textContent);
  } catch {}
  push(el.textContent && el.textContent.trim().length <= 4 ? el.textContent : ""); // short glyphs only (‹ › » ▶)

  const hay = " " + bits.join("  ") + " ";
  const tags = new Set();
  const t = (re, name) => { if (re.test(hay)) tags.add(name); };
  t(/next|forward|chevron[-_ ]?right|arrow[-_ ]?right|caret[-_ ]?right|angle[-_ ]?right|icon[-_ ]?right|\bright\b|›|»|▶|►|→|❯|⟩|>/, "next");
  t(/prev(ious)?|\bback\b|chevron[-_ ]?left|arrow[-_ ]?left|caret[-_ ]?left|angle[-_ ]?left|icon[-_ ]?left|\bleft\b|‹|«|◀|◄|←|❮|⟨/, "prev");
  t(/chevron[-_ ]?up|caret[-_ ]?up|angle[-_ ]?up|arrow[-_ ]?up|\bup\b|▲|↑|collapse/, "up");
  t(/chevron[-_ ]?down|caret[-_ ]?down|angle[-_ ]?down|arrow[-_ ]?down|\bdown\b|▼|↓|expand/, "down");
  t(/expand|\bopen\b|\bshow\b|plus|\+|accordion/, "expand");
  t(/collaps|\bhide\b|minus/, "collapse");
  t(/\bclose\b|dismiss|×|✕|✖/, "close");
  t(/\bmenu\b|hamburger|\bbars\b|kebab|ellipsis|more|⋮|⋯|\.\.\./, "menu");
  t(/\bplay\b|▶/, "play");
  t(/\bpause\b|❚❚|⏸/, "pause");
  return [...tags].join(" ");
}

// Expand a user's search word into the icon-hint tags it should also match, so
// query_elements text:"next"/"back"/"expand" finds the right icon-only control.
const NEEDLE_SYNONYMS = {
  next: "next", forward: "next", continue: "next", ">": "next",
  prev: "prev", previous: "prev", back: "prev", "<": "prev",
  expand: "expand", open: "expand", show: "expand",
  collapse: "collapse", close: "close", hide: "collapse",
  up: "up", down: "down", menu: "menu", more: "menu", play: "play", pause: "pause"
};

function queryElements(selector, text, limit = 20) {
  let nodes;
  try {
    nodes = [...deepQueryAll(selector)];
  } catch (e) {
    return { error: `Invalid selector: ${e.message}` };
  }
  const needle = (text || "").toLowerCase();
  const out = [];
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    // Never let a password field's plaintext leak through the innerText→value
    // fallback (mirrors the el.type !== "password" guard on the value field below).
    const label = ((el.type === "password" ? "" : (el.innerText || el.value)) || el.getAttribute?.("aria-label") || el.getAttribute?.("placeholder") || el.getAttribute?.("title") || "").trim();
    // Hide third-party helper-extension UI (SN Utils etc.) from the agent: these links are
    // injected for HUMANS, and the agent clicking "[SN Utils] Versions" opened a popup it
    // then mistook for platform data (observed 2026-07-09). The platform's own UI never
    // carries these bracket-prefixed labels.
    if (/^\[(SN Utils|SNU|Snowbelt)\]/i.test(label)) continue;
    // Icon hint (for text-less chevron/arrow/toggle buttons) + accordion state.
    const hint = iconHint(el);
    const ariaExpandedAttr = el.getAttribute?.("aria-expanded");
    if (needle) {
      const syn = NEEDLE_SYNONYMS[needle];
      const labelHit = label.toLowerCase().includes(needle);
      const hintHit = hint && (hint.includes(needle) || (syn && hint.includes(syn)));
      // "expand"/"collapse" also match a disclosure widget by its aria-expanded state.
      const stateHit = (needle === "expand" && ariaExpandedAttr === "false") ||
                       (needle === "collapse" && ariaExpandedAttr === "true");
      if (!labelHit && !hintHit && !stateHit) continue;
    }
    // Field STATE (type/checked/value/disabled/readonly): without these a
    // checkbox's setting is INVISIBLE to the agent, which then guesses —
    // observed 2026-07-15: a Business Rule review fabricated "Insert/Update/
    // Delete/Query all true" because checked was never reported. aria-checked
    // covers custom role="checkbox"/"switch" widgets (Next Experience UI).
    const ariaChecked = el.getAttribute?.("aria-checked");
    const isCheckable = el.type === "checkbox" || el.type === "radio";
    out.push({
      tag: el.tagName.toLowerCase(),
      text: label.slice(0, 120),
      selector: tag(el), // opaque handle — pass back to click/fill
      icon_hint: (!label && hint) ? hint : undefined,   // e.g. "next"/"prev"/"expand" for a text-less arrow button
      aria_expanded: ariaExpandedAttr != null ? (ariaExpandedAttr === "true") : undefined, // accordion/disclosure: false=collapsed→click to expand
      id: el.id || undefined,
      name: el.getAttribute?.("name") || undefined,
      field_label: /^(input|textarea|select)$/i.test(el.tagName) ? fieldInfo(el).label : undefined,
      type: el.tagName === "INPUT" ? (el.type || "text") : undefined,
      checked: isCheckable ? !!el.checked : ariaChecked ? ariaChecked === "true" : undefined,
      value: /^(input|textarea|select)$/i.test(el.tagName) && el.type !== "password" && el.type !== "checkbox"
        ? (String(el.value ?? "").slice(0, 120) || undefined)
        : undefined,
      disabled: el.disabled || undefined,
      readonly: el.readOnly || undefined,
      options: el.tagName === "SELECT"
        ? Array.from(el.options).slice(0, 20).map((o) => o.text.trim())
        : undefined,
      href: el.getAttribute?.("href") || undefined,
      in_frame: el.ownerDocument !== document || undefined
    });
    if (out.length >= limit) break;
  }
  return { count: out.length, elements: out };
}

// Phase 4 submission guard — autonomous day-trading order submit requires BOTH
// the local kill-switch (paperOrderSubmissionEnabled) AND the trading pack
// (tradingPackEnabled, which carries the SUBMIT-mode discipline). Read live so it
// responds instantly to a toggle. Since 2026-09-04 (owner directive) both default
// ON: an UNSET kill-switch counts as allowed; only an explicit false blocks. The
// server brakes (paper-only, sizing, lockout) are untouched. Used by EVERY DOM path that could submit an
// order (button click, fill+submit, Enter) — not just the Submit button.
// 2026-09-18: records WHICH check refused, so the block message names the real cause. Before
// this, a storage read that threw (a page whose content script outlived an extension reload)
// produced the same "unticked in Options" text as a real toggle, and a live cycle
// could not tell a settings problem from a stale page.
let dayTradingSubmitDenyCause = "";
async function dayTradingSubmitAllowed() {
  dayTradingSubmitDenyCause = "";
  try {
    const { paperOrderSubmissionEnabled } = await chrome.storage.local.get("paperOrderSubmissionEnabled");
    if (paperOrderSubmissionEnabled === false) { dayTradingSubmitDenyCause = "submit-toggle"; return false; }
    const { settings } = await chrome.storage.sync.get("settings");
    if (settings && settings.tradingPackEnabled === false) { dayTradingSubmitDenyCause = "pack-toggle"; return false; }
    return true;
  } catch (e) { dayTradingSubmitDenyCause = "storage-error: " + ((e && e.message) || String(e)); return false; }
}
const SUBMIT_BLOCKED_TAIL = " The agent cannot place an order; a human must click Submit Order. (Validate / dry-run is still allowed.)";
function submitBlocked() {
  const c = dayTradingSubmitDenyCause;
  let reason;
  if (c === "submit-toggle") reason = "Autonomous order submission is OFF — the 'AUTONOMOUS submit (PAPER)' toggle is unticked in Options (on by default). Tick it in Options — the gate re-reads it live, no reload needed.";
  else if (c === "pack-toggle") reason = "Autonomous order submission is OFF — the 'Day-trading agent pack' toggle is unticked in Options (on by default), so unless you unticked it mid-run the trading pack was not injected into this run either. Tick it in Options and reload the page (Ctrl+F5) so the pack loads.";
  else if (c.indexOf("storage-error") === 0) reason = "Reload the Day Trading page (Ctrl+F5) and retry: autonomous order submission could not be verified because the extension's settings are unreadable from this page (" + c.slice(15) + "), usually because the extension was reloaded or updated while the page stayed open. This is usually not a settings problem.";
  else reason = "Autonomous order submission is OFF — the day-trading agent pack or the 'AUTONOMOUS submit (PAPER)' toggle was unticked in Options (both are on by default).";
  return { ok: false, blocked: true, cause: c || "unknown", reason: reason + SUBMIT_BLOCKED_TAIL };
}
function isOrderField(el) { try { return !!(el && el.id && /^order/i.test(el.id)); } catch { return false; } }

// ── REAL-MONEY (live-trading.html) submission guard (2026-09-11) ──────────────────────
// Mirror of the paper guard with the OPPOSITE default: BOTH the live pack toggle (sync) AND the
// live kill-switch (storage.local) must be EXPLICITLY true. Unset = blocked. Own storage keys so a
// paper lockout never masks (or is masked by) a live one. Used by every DOM submit vector.
async function liveTradingSubmitAllowed() {
  try {
    const { liveOrderSubmissionEnabled } = await chrome.storage.local.get("liveOrderSubmissionEnabled");
    if (liveOrderSubmissionEnabled !== true) return false;
    const { settings } = await chrome.storage.sync.get("settings");
    return !!(settings && settings.liveTradingPackEnabled === true && settings.liveTradingPrefillEnabled === true); // MM pass 2 S1: same three-toggle contract as liveTradingMode()
  } catch { return false; }
}
const LIVE_SUBMIT_BLOCKED = { ok: false, blocked: true, reason: "REAL-MONEY order submission is OFF — the live-trading agent pack, its PREFILL toggle and the 'AUTONOMOUS submit (LIVE — REAL MONEY)' toggle must ALL THREE be explicitly enabled in Options (all off by default). The agent cannot place a live order; a human must click Submit Order." };
const LIVE_LOCKOUT_RE = /DAILY_TIER_\w+|RISK_HALT|BOT_HALTED|NON_LIVE|AGENT_ENTRY_LIVE_ONLY|DAILY_LOSS_LOCKOUT|Daily loss limit reached|No new orders until tomorrow|max daily loss/i;
function armLiveLockoutWatcher() {
  let tries = 0;
  const iv = setInterval(() => {
    tries++;
    try {
      const scoped = [
        document.getElementById("toastContainer") ? document.getElementById("toastContainer").innerText : "",
        document.getElementById("lockoutBanner") ? document.getElementById("lockoutBanner").innerText : ""
      ].join("\n");
      const cleaned = scoped.replace(/[^\n]*(MANUAL_NO_SCANNER_SIGNAL|SIGNAL_ALREADY_EXECUTED)[^\n]*/gi, "");
      if (LIVE_LOCKOUT_RE.test(cleaned)) {
        chrome.storage.local.set({ liveTradingSubmitBlockedUntil: Date.now() + SUBMIT_LOCKOUT_MS });
        clearInterval(iv);
        return;
      }
    } catch {}
    if (tries >= 24) clearInterval(iv);
  }, 500);
}
async function guardLiveTradingSubmit() {
  if (!(await liveTradingSubmitAllowed())) return LIVE_SUBMIT_BLOCKED;
  const now = Date.now();
  try {
    const { liveTradingSubmitBlockedUntil } = await chrome.storage.local.get("liveTradingSubmitBlockedUntil");
    if (liveTradingSubmitBlockedUntil && now < liveTradingSubmitBlockedUntil) {
      return { ok: false, blocked: true, reason: "LIVE (real-money) submit is LOCKED OUT for the rest of the session — a prior order hit a day-ending server response. No further live orders today (clears automatically at the session boundary)." };
    }
  } catch { return { ok: false, blocked: true, reason: "Cannot verify or persist REAL-MONEY submit safety state — no order attempted. Reload (Ctrl+F5), reconcile, retry." }; } // MM pass 4 M4: fail closed
  try {
    const { liveTradingLastSubmit } = await chrome.storage.local.get("liveTradingLastSubmit");
    const sig = orderFormSig();
    if (liveTradingLastSubmit) {
      if (now - liveTradingLastSubmit.ts < SUBMIT_MIN_INTERVAL_MS) {
        return { ok: false, blocked: true, reason: "Submitting too fast on the REAL-MONEY page (" + Math.round((now - liveTradingLastSubmit.ts) / 1000) + "s since the last submit). Min " + (SUBMIT_MIN_INTERVAL_MS / 1000) + "s between orders — looks like a loop; stop and reassess." };
      }
      if (liveTradingLastSubmit.sig === sig && now - liveTradingLastSubmit.ts < SUBMIT_DUP_WINDOW_MS) {
        return { ok: false, blocked: true, reason: "Duplicate REAL-MONEY order — this exact order was just submitted. Not re-submitting." };
      }
    }
    await chrome.storage.local.set({ liveTradingLastSubmit: { ts: now, sig } });
  } catch { return { ok: false, blocked: true, reason: "Cannot verify or persist REAL-MONEY submit safety state — no order attempted. Reload (Ctrl+F5), reconcile, retry." }; } // MM pass 4 M4: fail closed
  armLiveLockoutWatcher();
  return null; // allowed
}

// ── Phase 4.1: client-side submit hardening (anti-spam latch + local lockout) ──
// Enforced in content.js so it holds regardless of LLM behavior; the server gate
// remains authoritative. State lives in chrome.storage.local.
const SUBMIT_MIN_INTERVAL_MS = 15000;  // no two agent submits closer than 15s (anti-loop)
const SUBMIT_DUP_WINDOW_MS = 90000;    // identical order blocked for 90s (anti-double-submit)
const SUBMIT_LOCKOUT_MS = 6 * 3600 * 1000; // a server lockout stops submits for ~rest of session

function orderFormSig() {
  const g = (id) => { const e = document.getElementById(id); return e ? String(e.value || "") : ""; };
  return [g("orderSymbol"), g("orderSide"), g("orderQty"), g("orderType"), g("orderLimitPrice"), g("orderStopLoss"), g("orderTakeProfit"), g("orderStrategyTag"), g("orderThesis")].join("|").toUpperCase();
}

// Watch briefly for the server's lockout/blocked toast after a submit; if seen,
// latch a local lockout so the agent can't keep retrying. Uses the SPECIFIC 403
// response wording (not generic "daily loss" which appears on settings labels).
function armLockoutWatcher() {
  let tries = 0;
  // Specific 403 wording ONLY (no bare "lockout" token), and SCOPED to the dynamic
  // feedback containers — NOT document.body, which contains the static dry-run hint
  // "...checks paper-mode, R:R, sizing, lockout & market hours..." that would
  // otherwise phantom-latch a lockout on the first submit.
  // 2026-09-10b (an internal review M3): "ORDER BLOCKED" REMOVED from the latch. POST /orders
  // prefixes EVERY validator rejection with 'ORDER BLOCKED — ' (RR_TOO_LOW, VWAP_EXTENSION,
  // RISK_TOO_HIGH ...), so one per-order geometry reject was latching a 6-hour client lockout
  // and silently ending the buyer's day. Only the daily-loss / lockout wording latches now.
  // 2026-09-10c (an internal review MF-1): the server's REAL day-ending codes are DAILY_TIER_BLOCK /
  // DAILY_TIER_FLATTEN / DAILY_TIER_SESSION_GOAL / DAILY_TIER_LOSS_COUNT, RISK_HALT and BOT_HALTED
  // (order-validator.js); DAILY_LOSS_LOCKOUT is never emitted. Latch on those, never on the
  // generic 'ORDER BLOCKED' prefix every per-order rejection carries.
  const re = /DAILY_TIER_\w+|RISK_HALT|BOT_HALTED|NON_PAPER|DAILY_LOSS_LOCKOUT|Daily loss limit reached|No new orders until tomorrow|max daily loss/i; // an internal review F6: prefix-match the tier codes, NON_PAPER is day-ending
  const iv = setInterval(() => {
    tries++;
    try {
      const scoped = [
        document.getElementById("toastContainer") ? document.getElementById("toastContainer").innerText : "",
        document.getElementById("lockoutBanner") ? document.getElementById("lockoutBanner").innerText : ""
      ].join("\n");
      // NN_MOM_CORE4 cohort (V2/1R since 2026-07-24; server rev 01523-z6h 2026-08-16; same gate since CORE3): MANUAL_NO_SCANNER_SIGNAL
      // (422) and SIGNAL_ALREADY_EXECUTED (409) are the NORMAL outcome of submitting
      // without a fresh scanner-qualified signal — benign no-trade rejections, not loss
      // events. Strip those toast lines before testing so they can't phantom-latch the
      // 6h lockout; a real loss-lockout toast on another line still latches.
      const cleaned = scoped.replace(/[^\n]*(MANUAL_NO_SCANNER_SIGNAL|SIGNAL_ALREADY_EXECUTED)[^\n]*/gi, "");
      if (re.test(cleaned)) {
        chrome.storage.local.set({ dayTradingSubmitBlockedUntil: Date.now() + SUBMIT_LOCKOUT_MS });
        clearInterval(iv);
        return;
      }
    } catch {}
    if (tries >= 24) clearInterval(iv); // ~12s @ 500ms — a slow /orders round-trip (validator reads quote+bars+positions) can exceed 4 s (an internal review P3-4)
  }, 500);
}

// Full submit guard: flags → local lockout → anti-spam latch. Returns null when
// the submit may proceed (and records the latch + arms the watcher), else a block.
async function guardDayTradingSubmit() {
  if (!(await dayTradingSubmitAllowed())) return submitBlocked();
  const now = Date.now();
  try {
    const { dayTradingSubmitBlockedUntil } = await chrome.storage.local.get("dayTradingSubmitBlockedUntil");
    if (dayTradingSubmitBlockedUntil && now < dayTradingSubmitBlockedUntil) {
      return { ok: false, blocked: true, reason: "Day-trading submit is LOCKED OUT for the rest of the session — a prior order hit a daily-loss lockout response. No further orders today (clears automatically, or toggle autonomous-submit off/on)." };
    }
  } catch {}
  try {
    const { dayTradingLastSubmit } = await chrome.storage.local.get("dayTradingLastSubmit");
    const sig = orderFormSig();
    if (dayTradingLastSubmit) {
      if (now - dayTradingLastSubmit.ts < SUBMIT_MIN_INTERVAL_MS) {
        return { ok: false, blocked: true, reason: "Submitting too fast (" + Math.round((now - dayTradingLastSubmit.ts) / 1000) + "s since the last submit). Min " + (SUBMIT_MIN_INTERVAL_MS / 1000) + "s between orders — looks like a loop; stop and reassess." };
      }
      if (dayTradingLastSubmit.sig === sig && now - dayTradingLastSubmit.ts < SUBMIT_DUP_WINDOW_MS) {
        return { ok: false, blocked: true, reason: "Duplicate order — this exact order was just submitted. Not re-submitting." };
      }
    }
    await chrome.storage.local.set({ dayTradingLastSubmit: { ts: now, sig } });
  } catch {}
  armLockoutWatcher();
  return null; // allowed
}

async function clickElement(handle, double) {
  let el = resolveHandle(handle);
  if (!el) return { error: `No element found for: ${handle}` };
  // If the handle resolved to a child node (the name text, avatar, or icon the
  // model picked), retarget to the nearest navigable ancestor. SPA rows nest the
  // real <a>/button above the visible text — clicking the child does nothing or
  // catches the wrong control (e.g. a hover "⋮" overflow). Mirrors the
  // teach-recorder logic (lcOnRecClick). Anchors are preferred so a sidebar
  // conversation row actually switches threads.
  try {
    const nav = el.closest && el.closest('a,button,[role="button"],[role="link"],[role="tab"],[onclick]');
    if (nav) el = nav;
  } catch (e) {
    lcWarn("clickElement nav-ancestor retarget", e);
  }
  // ServiceNow LOGIN button → do NOT bare-click it. The fields are often empty, or
  // autofilled but unregistered, so a click submits blank creds → "Invalid input in
  // user name!". Signal the dispatcher to run sn_login (fill stored creds + fire
  // events + submit) instead. Only when an actual login form is present.
  try {
    const hasLoginForm = !![...deepQueryAll('#user_name, #user_password, input[name="user_name"], input[name="user_password"]')][0];
    const txt = (el.innerText || el.value || "").trim();
    const looksLikeLogin = el.id === "sysverb_login" || (hasLoginForm && /\blog\s*in\b/i.test(txt) && txt.length < 20);
    if (hasLoginForm && looksLikeLogin) return { ok: false, needsSnLogin: true, origin: location.origin };
  } catch (e) {
    lcWarn("clickElement login-detect", e);
  }
  // Phase 4 HARD GUARD: never click a day-trading "Submit Order" button unless the
  // autonomous-submit kill-switch is ON. Independent of the LLM/prompt — the agent
  // physically cannot place an order while submission is disabled. (Validate/dry-run
  // is unaffected; the server's paper-only gate remains the ultimate backstop.)
  try {
    const txt = (el.innerText || el.value || "").trim();
    if (/submit\s*order/i.test(txt) && /day-trading/i.test(location.href)) {
      const g = await guardDayTradingSubmit();
      if (g) return g;
    }
    // REAL-MONEY page: separate guard, separate kill-switch, separate lockout (2026-09-11).
    if (/submit\s*order/i.test(txt) && /live-trading/i.test(location.href)) {
      const g = await guardLiveTradingSubmit();
      if (g) return g;
    }
    if (/live-trading/i.test(location.href) && el.id === "btnScanExec") { // MM pass 3 L9: Sched buttons are refused outright by S2
      if (!(await liveTradingSubmitAllowed())) return { ok: false, blocked: true, reason: "REAL-MONEY autonomous execution is OFF — \"" + (txt || el.id) + "\" places live orders outside the manual form. Enable BOTH the live-trading agent pack AND 'AUTONOMOUS submit (LIVE — REAL MONEY)' to allow it." };
      const g = await guardLiveTradingSubmit(); if (g) return g; // an internal review P5: the lockout latch binds here too
    }
    if (/live-trading/i.test(location.href) && double) double = false; // an internal review P5: one real-money click per tool call
  } catch (e) {
    lcWarn("clickElement submit-guard", e);
    if (/day-trading|live-trading/i.test(location.href)) { // MM pass 3 L2: never fall through to a click on a trading page
      return { ok: false, blocked: true, reason: "Trading-page click guard failed (" + ((e && e.message) || e) + ") — refusing the click. Reload the page (Ctrl+F5) and retry." };
    }
  }
  // REAL-MONEY (MM pass 2 S2): the agent NEVER operates the page's global bot controls (liquidate / halt / pause /
  // resume / scheduler). No toggle unlocks this; it sits OUTSIDE the guard try so a thrown guard cannot skip it.
  try {
    const txt2 = (el.innerText || el.value || "").trim();
    if (/live-trading/i.test(location.href) &&
        (/close\s*all|flatten|^\s*halt\b|\bpause\b|\bresume\b/i.test(txt2) ||
         /^(btnCloseAll|btnHalt|btnPause|btnResume|btnFlatten|btnSchedStart|btnSchedStop)$/.test(el.id || ""))) {
      return { ok: false, blocked: true, reason: "REAL-MONEY bot controls are OFF-LIMITS to the agent — \"" + (txt2 || el.id) + "\" liquidates/halts positions or starts/stops automation. Only a human clicks these." };
    }
    // Also gate the OTHER agent-initiated order-execution vectors on the page —
    // "Scan + Execute" (#btnScanExec, runScan(true)) and the auto-exec scheduler
    // "Start" (#btnSchedStart, startScheduler()) — under the SAME kill-switch, since
    // they place orders outside the manual form. (Human clicks bypass content.js.)
    if (/day-trading/i.test(location.href) && (el.id === "btnScanExec" || el.id === "btnSchedStart") && !(await dayTradingSubmitAllowed())) {
      const sb = submitBlocked();
      const why = sb.cause === "pack-toggle" ? "the 'Day-trading agent pack' toggle is unticked — tick it in Options and reload (Ctrl+F5)"
        : sb.cause === "submit-toggle" ? "the 'AUTONOMOUS submit (PAPER)' toggle is unticked — tick it in Options and retry"
        : sb.cause.indexOf("storage-error") === 0 ? "settings are unreadable from this page — reload (Ctrl+F5) and retry"
        : "a required toggle is off";
      return { ok: false, blocked: true, cause: sb.cause, reason: "Autonomous execution is OFF — \"" + (txt2 || el.id) + "\" places orders outside the manual form. Enable BOTH the day-trading agent pack AND 'AUTONOMOUS submit (PAPER)' to allow it: " + why + "." };
    }
  } catch (e) {
    lcWarn("clickElement submit-guard", e);
    if (/day-trading|live-trading/i.test(location.href)) { // MM pass 3 L2: never fall through to a click on a trading page
      return { ok: false, blocked: true, reason: "Trading-page click guard failed (" + ((e && e.message) || e) + ") — refusing the click. Reload the page (Ctrl+F5) and retry." };
    }
  }
  try {
    // DOUBLE-CLICK (double:true): two full click sequences + a real dblclick
    // event with detail:2 — listeners like SN Utils' "double-click the form to
    // toggle technical field-name pills" fire on dblclick, which a single
    // synthetic click never produces. Skipped for checkboxes (a double toggle
    // nets a NO-OP; the checkbox-safety path below handles them).
    if (double && !checkboxTarget(el)) {
      const win = el.ownerDocument.defaultView || window;
      clickRobust(el);
      clickRobust(el);
      try {
        el.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, cancelable: true, view: win, detail: 2 }));
      } catch {}
      return { ok: true, double_clicked: handle };
    }
    // Use the full pointer/mouse sequence (not a bare el.click()). React SPAs
    // like LinkedIn messaging listen on pointer/mouse events, so a synthetic
    // .click() alone does NOT switch the sidebar conversation — the main pane
    // stays on the old thread and the next read_page reads stale content.
    clickRobust(el);
    const out = { ok: true, clicked: handle };
    // NO-OP DETECTION (live UAT 2026-07-30, Workflow Studio "Add trigger"): Seismic /
    // next-experience components can swallow synthetic clicks entirely while the tool
    // still reports ok:true, sending the agent into a blind re-click loop. When the
    // element declares aria-expanded, wait for the re-render and report whether it
    // actually opened, plus the recovery path when it did not.
    try {
      if (el.hasAttribute && el.hasAttribute("aria-expanded")) {
        await new Promise((r) => setTimeout(r, 400));
        out.aria_expanded_after = el.getAttribute("aria-expanded");
        if (out.aria_expanded_after === "false") {
          out.note = "Control did NOT expand (aria-expanded still false) — this component likely requires a TRUSTED click. Do not re-click the same handle; try press_key Enter on it once, else desktop_screenshot + desktop_click at its on-screen position.";
        }
      }
    } catch {}
    return out;
  } catch (e) {
    return { error: e.message };
  }
}

// Read an element's REAL computed CSS (2026-07-22: an agent debugging a
// white-on-white portal button had NO way to read computed colors — DOM tools
// returned markup only, the vision model misread the screenshot, and it tried
// to click DevTools tabs, which are outside the page and unreachable). Returns
// the winning post-cascade values (including runtime-injected CSS), the
// EFFECTIVE background (first non-transparent ancestor), and the WCAG contrast
// ratio — "is this invisible?" becomes a deterministic one-call answer.
function getComputedStyleTool(sel, extraProps) {
  let el = resolveHandle(sel);
  if (!el) { try { el = [...deepQueryAll(sel)][0] || null; } catch {} }
  if (!el) return { error: `No element found for: ${sel} (pass a query_elements handle or a CSS selector).` };
  const win = el.ownerDocument.defaultView || window;
  const cs = win.getComputedStyle(el);
  const DEFAULT_PROPS = ["color", "background-color", "background-image", "font-size", "font-weight",
    "display", "visibility", "opacity", "z-index", "border-color", "text-decoration-line", "pointer-events"];
  const props = [...new Set([...DEFAULT_PROPS, ...(Array.isArray(extraProps) ? extraProps.map(String) : [])])];
  const styles = {};
  for (const p of props) { try { styles[p] = cs.getPropertyValue(p); } catch {} }
  const parseC = (s) => {
    const m = String(s).match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] } : null;
  };
  // Effective background: walk up (through shadow hosts) to the first
  // non-transparent background-color — what the eye actually sees behind the text.
  let bg = null, bgOwner = "";
  for (let node = el; node && node.nodeType === 1;) {
    const c = parseC(win.getComputedStyle(node).getPropertyValue("background-color"));
    if (c && c.a > 0.01) { bg = c; bgOwner = node.tagName.toLowerCase() + (node.id ? "#" + node.id : ""); break; }
    node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
  }
  if (!bg) { bg = { r: 255, g: 255, b: 255, a: 1 }; bgOwner = "(document default white)"; }
  const fg = parseC(cs.getPropertyValue("color"));
  let contrast = null;
  if (fg) {
    const lum = ({ r, g, b }) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const L1 = lum(fg), L2 = lum(bg);
    contrast = Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100;
  }
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(), id: el.id || undefined,
    classes: (el.className && String(el.className).slice(0, 200)) || undefined,
    styles,
    inline_style: (el.getAttribute && el.getAttribute("style")) || undefined,
    effective_background: `rgb(${bg.r}, ${bg.g}, ${bg.b}) (from ${bgOwner})`,
    contrast_ratio: contrast,
    contrast_verdict: contrast == null ? undefined :
      contrast < 1.5 ? "INVISIBLE — text ≈ background (e.g. white-on-white)" :
      contrast < 4.5 ? "LOW — fails WCAG AA for normal text" : "OK",
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    visible: !!(r.width && r.height) && cs.visibility !== "hidden" && cs.display !== "none",
    note: "These are the WINNING post-cascade values, including runtime-injected CSS that never appears in any stylesheet file."
  };
}

// Press a keyboard key on the focused element (and document, for global
// listeners). Main use: "Escape" to dismiss an open menu / overflow / popover
// the agent got stuck behind — without it the agent has no way to recover from
// a stray menu. Also supports Enter/Tab/Arrow keys etc.
async function pressKey(key) {
  const raw = String(key || "").trim();
  if (!raw) return { error: "key is required, e.g. 'Escape', 'Enter', 'Tab'." };
  const alias = { esc: "Escape", escape: "Escape", enter: "Enter", return: "Enter", tab: "Tab", space: " ", spacebar: " " };
  const keyName = alias[raw.toLowerCase()] || raw;
  const target = (document.activeElement && document.activeElement !== document.body)
    ? document.activeElement : document.body;
  // Phase 4 guard: Enter while focused on a day-trading order field is a submit
  // vector — block unless autonomous submit is allowed.
  if (keyName === "Enter" && /day-trading/i.test(location.href) && isOrderField(target)) {
    const g = await guardDayTradingSubmit();
    if (g) return g;
  }
  if (/live-trading/i.test(location.href) && /^(Enter|NumpadEnter| |Space)$/.test(keyName) && target) { // MM pass 4 M3 + pass 5 N2: S2 for keys, BEFORE the P6 latch so a refused key never consumes it
    const _bt = (target !== document.body && target.closest && target.closest("button,[role=\"button\"],a,input") ) ? (target.innerText || target.value || "").trim().slice(0, 40) : ""; // MM pass 5 N2: control-like elements only
    if (/^(btnCloseAll|btnHalt|btnPause|btnResume|btnFlatten|btnSchedStart|btnSchedStop)$/.test(target.id || "") || /close\s*all|flatten|^\s*halt\b|\bpause\b|\bresume\b/i.test(_bt)) {
      return { ok: false, blocked: true, reason: "REAL-MONEY bot controls are OFF-LIMITS to the agent (keyboard)." };
    }
  }
  if (/^(Enter|NumpadEnter| |Space)$/.test(keyName) && /live-trading/i.test(location.href) && (!target || target === document.body || isOrderField(target) || /submit\s*order/i.test((target.innerText || target.value || (target.getAttribute && target.getAttribute("aria-label")) || "")) || target.id === "btnScanExec" || target.id === "btnSchedStart")) { // an internal review P6
    const g = await guardLiveTradingSubmit();
    if (g) return g;
  }
  const win = target.ownerDocument?.defaultView || window;
  let dispatched = false;
  for (const type of ["keydown", "keypress", "keyup"]) {
    try {
      target.dispatchEvent(new win.KeyboardEvent(type, { key: keyName, bubbles: true, cancelable: true, view: win }));
      dispatched = true;
    } catch {}
  }
  // Escape rarely bubbles usefully from a deep target — also fire it on body and
  // document so menu/overlay libraries (artdeco, MUI, Radix) catch it and close.
  if (keyName === "Escape") {
    for (const node of [document.body, document]) {
      for (const type of ["keydown", "keyup"]) {
        try { node.dispatchEvent(new KeyboardEvent(type, { key: "Escape", bubbles: true, cancelable: true })); } catch {}
      }
    }
  }
  return dispatched ? { ok: true, pressed: keyName } : { error: `Could not dispatch key: ${keyName}` };
}

function lcSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// open_form_section — open a named SECTION TAB on a classic ServiceNow form
// ("When to run" / "Actions" / "Advanced" on a Business Rule; "Script" on a
// UI Policy). Classic forms hide most fields behind these tabs, and some tabs
// only EXIST while a controlling checkbox is checked — a Business Rule's
// Advanced tab (Condition + Script) appears only when the header's "Advanced"
// checkbox is ticked. The tool checks that box automatically when the
// requested tab is missing, so the model never scroll-loops hunting for a
// field that is not in the DOM yet.
// ---------------------------------------------------------------------------
function lcNormText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// All visible section tabs across frames/shadow roots. Classic UI marks them
// .tab_header (caption in .tab_caption_text). When ANY classic tabs exist, use
// ONLY those — mixing in [role='tab'] would pull ARIA tabs from the outer
// Polaris chrome / workspace nav / widgets into the candidate set and a generic
// caption like "Actions" could collide (master-mind M1). [role='tab'] is the
// fallback for workspace-style forms with no classic tab markup.
function findSectionTabs() {
  // Classic form section tabs are `.tabs2_tab` spans (role=tab, aria-selected,
  // class `tabs2_active` when active), each wrapped in a `.tab_header` container.
  // Target the `.tabs2_tab` itself: it is BOTH the real click target AND the
  // element carrying the selected-state we verify against — the outer
  // `.tab_header` has neither (verified LIVE 2026-07-15 on dev000000; targeting
  // `.tab_header` was why the earlier tool couldn't verify "When to run" and kept
  // reverting Advanced). Do NOT match `[id^='section_tab']` — those are the
  // section DESCRIPTION containers, not tab buttons.
  let classic = [];
  try { classic = [...deepQueryAll(".tabs2_tab")].filter(isVisible); } catch {}
  if (!classic.length) { try { classic = [...deepQueryAll(".tab_header")].filter(isVisible); } catch {} }
  if (classic.length) return classic;
  let aria = [];
  try { aria = [...deepQueryAll("[role='tab']")].filter(isVisible); } catch {}
  return aria;
}

// Count the visible code editors (Monaco / CodeMirror) on the page — diffed
// around a section toggle so we can tell a Script/Advanced tab actually revealed
// its editor even when no plain input field changed (the Script field is a code
// editor, not an <input>, so visibleFieldKeys() alone would miss it).
function visibleEditorCount() {
  try {
    return [...deepQueryAll(".monaco-editor, .CodeMirror")]
      .filter((e) => isVisible(e) && !(e.parentElement && e.parentElement.closest(".monaco-editor")))
      .length;
  } catch { return 0; }
}

// Is a section tab currently the active one? Classic UI doesn't always set
// aria-selected, so also accept the common selected-state class names.
function tabSelected(t) {
  try {
    if (t.getAttribute?.("aria-selected") === "true") return true;
    const cls = String(t.className || "");
    // `tabs2_active` is the classic active-tab class (no word boundary before the
    // "active" so the generic \bactive\b test below misses it — match explicitly).
    if (/tabs2_active/.test(cls)) return true;
    if (/\b(active|selected|tab_header_selected)\b/i.test(cls)) return true;
    // t may be the `.tab_header` wrapper — inspect its inner `.tabs2_tab`/role=tab.
    const inner = t.querySelector?.(".tabs2_tab, [role='tab']");
    if (inner && (inner.getAttribute("aria-selected") === "true" || /tabs2_active/.test(String(inner.className || "")))) return true;
  } catch {}
  return false;
}

function tabCaption(tab) {
  let cap = null;
  try { cap = tab.querySelector(".tab_caption_text"); } catch {}
  let text = (cap && cap.innerText) || tab.innerText || tab.getAttribute?.("aria-label") || "";
  // The caption is ALWAYS the first line: classic tabs append status text to the
  // caption node ("When to run\nContains unpopulated mandatory fields") and some
  // carry a trailing help/description block. Taking the first non-empty line
  // restores exact-name matching ("advanced" === "advanced").
  text = String(text).split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
  return text.replace(/\s+/g, " ").trim();
}

// Snapshot of the visible, identifiable form fields — diffed around a section
// click so the result can report exactly which fields the tab revealed.
function visibleFieldKeys() {
  const out = new Set();
  try {
    for (const el of deepQueryAll("input, select, textarea")) {
      if (!isVisible(el)) continue;
      const key = el.id || el.getAttribute?.("name");
      if (key) out.add(key);
    }
  } catch {}
  return out;
}

// Sections that are legitimately revealed by a controlling form checkbox.
// ALLOWLISTED ON PURPOSE (master-mind H2): without this, ANY absent section
// name was token-matched against checkbox ids — open_form_section
// {"section":"active"} would have toggled a Business Rule's ACTIVE checkbox
// (an unreported, unsaved record mutation) while merely failing the tab-open.
const CHECKBOX_GATED_SECTIONS = new Set(["advanced"]);

// Find the visible form CHECKBOX that controls a section. Canonical classic-UI
// field id first (ni.<table>.<field>, e.g. ni.sys_script.advanced — the
// Business Rule header checkbox that reveals the Advanced tab), then the
// generic id/name-tail and label matches.
function findControllingCheckbox(want) {
  if (/^[a-z0-9_]+$/.test(want)) {
    try {
      // NOTE: deepQueryAll is global across same-origin frames/shadow roots, so
      // a stacked dialog's [id$=".advanced"] could theoretically match first —
      // acceptable for the standard classic form (MM round-2, Low).
      const canonical = [...deepQueryAll('input[type="checkbox"][id$=".' + want + '"], input[type="checkbox"][name$=".' + want + '"]')].filter(isVisible);
      if (canonical.length) return canonical[0];
    } catch {}
  }
  let boxes = [];
  try { boxes = [...deepQueryAll('input[type="checkbox"]')].filter(isVisible); } catch {}
  for (const cb of boxes) {
    const idName = ((cb.id || "") + "." + (cb.getAttribute?.("name") || "")).toLowerCase();
    if (idName.split(/[.\s]+/).includes(want)) return cb;
    if (lcNormText(fieldInfo(cb).label) === want) return cb;
    try {
      const row = cb.closest("tr, .form-group");
      const lab = row && row.querySelector("label");
      if (lab && lcNormText(lab.innerText) === want) return cb;
    } catch {}
  }
  return null;
}

async function openFormSection(section) {
  const want = lcNormText(section);
  if (!want) return { error: "section is required, e.g. 'Advanced' or 'When to run'." };
  // Exact caption match wins over a contains match ("Advanced" must not grab
  // some other tab whose caption merely contains the word).
  const findTab = () =>
    findSectionTabs().find((t) => lcNormText(tabCaption(t)) === want) ||
    findSectionTabs().find((t) => lcNormText(tabCaption(t)).includes(want));
  const sectionNames = () => [...new Set(findSectionTabs().map(tabCaption).filter(Boolean))];

  let tab = findTab();
  let toggled = null;
  let checkboxNote = "";

  // Tab absent + a KNOWN checkbox-gated section (allowlist — see H2 note above):
  // check the controlling checkbox and wait for the tab to render. If the tab
  // still doesn't appear, REVERT the toggle — never leave the form silently
  // mutated behind an ok:false.
  if (!tab && CHECKBOX_GATED_SECTIONS.has(want)) {
    const cb = findControllingCheckbox(want);
    if (cb && !cb.checked) {
      const beforeKeys = visibleFieldKeys();
      const beforeEds = visibleEditorCount();
      clickRobust(cb);
      // Verify the click actually toggled the box on before we wait on it.
      const toggledOn = await waitUntil(() => cb.checked, 800, 100);
      toggled = fieldInfo(cb).label || cb.id || cb.getAttribute?.("name") || String(section);
      if (!toggledOn) {
        return {
          ok: false,
          error: 'Could not check the "' + toggled + '" checkbox (the click did not toggle it on). Inspect the form with query_elements — it may be read-only or hidden behind another control.',
          available_sections: sectionNames()
        };
      }
      // Wait for the section to materialise: EITHER a named tab renders OR the
      // checkbox reveals new fields / a code editor (instance markup varies, so
      // never depend on the tab alone — that was the bug that made the tool
      // revert a legitimately-useful toggle and thrash).
      await waitUntil(() => {
        if (findTab()) return true;
        if (visibleEditorCount() > beforeEds) return true;
        for (const k of visibleFieldKeys()) if (!beforeKeys.has(k)) return true;
        return false;
      }, 3000, 150);
      tab = findTab();
      const newFields = [...visibleFieldKeys()].filter((k) => !beforeKeys.has(k));
      const editorRevealed = visibleEditorCount() > beforeEds;
      if (!tab && (newFields.length || editorRevealed)) {
        // The checkbox revealed the section's fields/editor even though no named
        // tab matched. SUCCESS — do NOT revert; the model needs these fields.
        return {
          ok: true,
          opened: String(section),
          checked_checkbox_first: toggled,
          revealed_fields: newFields.length ? newFields.slice(0, 30) : undefined,
          revealed_editor: editorRevealed || undefined,
          available_sections: sectionNames(),
          note: "Checked the '" + toggled + "' checkbox and its fields are now visible. A Script field is a CODE EDITOR: use list_editors + get_editor_value/set_editor_value, never fill_input."
        };
      }
      if (!tab) {
        // FALLBACK — the checkbox is checked but neither a tab nor new fields
        // rendered. On the standard form the Advanced tab renders immediately
        // (verified LIVE 2026-07-15 on dev000000 — no save needed), so this path
        // is rare: a still-loading form or a customized view that only reveals
        // the section after the record is saved. Do NOT revert — the checkbox
        // MUST stay checked; give the model both recovery options transparently.
        return {
          ok: false,
          checkbox_checked: toggled,
          needs_save_first: true,
          error: 'Checked the "' + toggled + '" checkbox, but its tab/fields have not rendered yet. The checkbox is LEFT CHECKED (do NOT re-toggle it). Try open_form_section {"section":"Advanced"} once more (the tab may still be rendering); if it still does not appear, this view only reveals the Advanced tab after the record is saved — call save_record, then reopen the Advanced tab.',
          available_sections: sectionNames()
        };
      }
    } else if (cb && cb.checked) {
      // Already checked but the tab hasn't rendered yet — classic UI re-renders
      // sections asynchronously after the checkbox change (master-mind M2).
      await waitUntil(() => !!findTab(), 1500, 150);
      tab = findTab();
      if (!tab) checkboxNote = ' The "' + section + '" checkbox is ALREADY checked but no matching tab exists yet — if this is a new record, save it first with save_record, then reopen and retry.';
    }
  }

  if (!tab) {
    const avail = sectionNames();
    return {
      ok: false,
      error: 'No form section tab matches "' + section + '".' + checkboxNote,
      available_sections: avail,
      hint: avail.length
        ? "Pick one of available_sections. If the field you need is still missing, it may be gated by a form checkbox (e.g. a Business Rule's 'Advanced' checkbox reveals the Advanced tab with Condition + Script)."
        : "No section tabs found on this form — it may not use tabbed sections; use read_page / scroll_page instead."
    };
  }

  // VERIFY the section actually opened before claiming success (master-mind H1):
  // pre-click selected state counts (classic tabs may set neither aria-selected
  // nor reveal new fields when the section is already open); otherwise require
  // a positive postcondition — selected state or newly visible fields.
  const wasSelected = tabSelected(tab);
  const before = visibleFieldKeys();
  const beforeEds = visibleEditorCount();
  if (!wasSelected) clickRobust(tab);
  const verified = wasSelected || await waitUntil(() => {
    if (tabSelected(tab)) return true;
    if (visibleEditorCount() > beforeEds) return true;   // Script/Advanced tab revealed its code editor
    for (const k of visibleFieldKeys()) { if (!before.has(k)) return true; }
    return false;
  }, 2500, 150);
  const revealed = [...visibleFieldKeys()].filter((k) => !before.has(k)).slice(0, 30);
  const editorRevealed = visibleEditorCount() > beforeEds;

  if (!verified && !revealed.length && !editorRevealed) {
    return {
      ok: false,
      error: 'Clicked the "' + tabCaption(tab) + '" tab but could not verify the section opened (no selected state, no new fields, no editor).',
      checked_checkbox_first: toggled || undefined,
      available_sections: sectionNames(),
      hint: "The click may not have registered — retry once, or inspect the form with query_elements / read_page before acting."
    };
  }

  return {
    ok: true,
    opened: tabCaption(tab),
    already_open: (wasSelected && !revealed.length && !editorRevealed) || undefined,
    checked_checkbox_first: toggled || undefined,
    revealed_fields: revealed.length ? revealed : undefined,
    revealed_editor: editorRevealed || undefined,
    available_sections: sectionNames(),
    note: "Section is open — query_elements / read_page / list_editors now see its fields. A Script field is a CODE EDITOR: use list_editors + get_editor_value/set_editor_value, never fill_input."
  };
}

// Click Send on a Gmail compose view (opened via the ?view=cm compose URL by the
// send_sms tool, which pre-fills To + body). Verifies the "Message sent" toast.
async function sendGmailCompose({ to, body } = {}) {
  if (/accounts\.google\.com|\/signin|ServiceLogin/i.test(location.href)) {
    return { ok: false, error: "Gmail isn't signed in (or it's the wrong account) — open mail.google.com on the intended account, then retry." };
  }
  if (!/mail\.google\.com/i.test(location.href)) {
    return { ok: false, error: "Gmail compose didn't open (not on mail.google.com)." };
  }
  const want = String(to || "").toLowerCase();
  const bodySnippet = String(body || "").trim().toLowerCase().slice(0, 80);
  // Find the Send button INSIDE the compose whose To field contains the expected
  // gateway address — never click a global/unrelated Send (wrong-recipient guard).
  // Exclude "Send & Archive" / "Schedule send" variants.
  let btn = null;
  for (let i = 0; i < 40; i++) {
    const candidates = [...deepQueryAll('div[role="button"][aria-label], [role="button"][data-tooltip]')]
      .filter((b) => {
        if (!isVisible(b) || b.getAttribute("aria-disabled") === "true") return false;
        const lbl = (b.getAttribute("aria-label") || b.getAttribute("data-tooltip") || "").trim();
        return /^send\b/i.test(lbl) && !/archive|&|schedule|later/i.test(lbl);
      });
    btn = candidates.find((b) => {
      if (!want) return true;
      const box = (b.closest && (b.closest('[role="dialog"]') || b.closest("form"))) || document.body;
      return (box.innerText || "").toLowerCase().includes(want);
    });
    // Fallback: Gmail may render a saved contact's NAME instead of the address,
    // so the recipient-text match can miss. Use a single compose ONLY when it
    // genuinely looks like OUR compose: exactly one Send candidate, a rendered
    // recipient chip present (not a half-mounted compose), AND the compose
    // contains our message body. Keeps the contact-name case working while
    // rejecting unrelated/stale drafts (restores the identity guard).
    if (!btn && candidates.length === 1) {
      const box = (candidates[0].closest && (candidates[0].closest('[role="dialog"]') || candidates[0].closest("form"))) || null;
      if (box) {
        const txt = (box.innerText || "").toLowerCase();
        const toArea = box.querySelector('[email], [data-hovercard-id], [aria-label="To"]');
        const hasRecipient = !!(toArea && (((toArea.getAttribute && toArea.getAttribute("email")) || toArea.innerText || "").trim()));
        const bodyOk = !bodySnippet || txt.includes(bodySnippet);
        if (hasRecipient && bodyOk) btn = candidates[0];
      }
    }
    if (btn) break;
    await lcSleep(300);
  }
  if (!btn) {
    return { ok: false, error: `Refusing to send: could not find a Gmail compose addressed to ${to}. The compose may not have opened, or another compose window is in the way.` };
  }
  clickRobust(btn);
  // Require Gmail's "Message sent" toast to claim success — never report an
  // unconfirmed send (the agent must not say "sent" unless it actually went).
  for (let i = 0; i < 20; i++) {
    if (/Message sent|Your message has been sent/i.test(document.body.innerText || "")) {
      return { ok: true, confirmed: true };
    }
    await lcSleep(300);
  }
  return { ok: false, confirmed: false, error: "Clicked Send but did not see Gmail's 'Message sent' confirmation — the text may not have gone out; verify in Sent." };
}

// Set a <select> dropdown by visible option text (or value attribute).
function selectOption(handle, option) {
  const el = resolveHandle(handle);
  if (!el) return { error: `No element found for: ${handle}` };
  if (el.tagName !== "SELECT") {
    return { error: `Element is a <${el.tagName.toLowerCase()}>, not a <select>. Use fill_input for text fields.` };
  }
  try {
    const want = String(option ?? "").trim().toLowerCase();
    const opts = Array.from(el.options);
    let match = opts.find((o) => o.text.trim().toLowerCase() === want || o.value.trim().toLowerCase() === want);
    if (!match) match = opts.find((o) => o.text.trim().toLowerCase().includes(want));
    if (!match) {
      return { error: `No option matching "${option}".`, available_options: opts.slice(0, 30).map((o) => o.text.trim()) };
    }
    const win = el.ownerDocument.defaultView || window;
    el.value = match.value;
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true })); // fires SN onChange handlers
    return { ok: true, selected: match.text.trim(), value: match.value, field: fieldInfo(el) };
  } catch (e) {
    return { error: e.message };
  }
}

// Dispatch a realistic Enter keypress (used to SEND chat messages / submit).
// Includes key + code (modern handlers) AND keyCode/which (legacy handlers like
// some chat composers) so it works across Slack, Teams, ServiceNow, etc.
function pressEnter(el, win) {
  for (const type of ["keydown", "keypress", "keyup"]) {
    const ev = new win.KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    try {
      Object.defineProperty(ev, "keyCode", { get: () => 13 });
      Object.defineProperty(ev, "which", { get: () => 13 });
    } catch {}
    el.dispatchEvent(ev);
  }
}

// Is this a rich-text composer (contenteditable div) rather than a real
// <input>/<textarea>? Slack, Teams, Discord, Notion, Quill/ProseMirror editors,
// and many comment boxes are contenteditable and have NO .value.
function isContentEditableBox(el) {
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return false;
  return el.isContentEditable ||
    el.getAttribute?.("contenteditable") === "true" ||
    el.getAttribute?.("role") === "textbox";
}

// Robustly insert text into a rich-text composer (contenteditable). These editors
// (Teams CKEditor 5, Slack/Quill, ProseMirror, Lexical, Slate) have NO .value and
// ignore a plain textContent assignment — the text shows in the DOM but never
// reaches the editor's internal model, so the send posts nothing. Try, in order:
//   1) execCommand('insertText') — drives the editor's own input pipeline (works
//      for most editors and usually Teams).
//   2) synthetic paste with clipboardData — many editors (notably Teams' CKEditor)
//      route paste through their model API even when execCommand is ignored.
//   3) textContent + composed InputEvent — last resort (model may still ignore it,
//      but attemptSend's history check will then catch the non-send honestly).
// Each step short-circuits once the message actually lands in the box.
function landed(el, value) {
  // Compare with ALL whitespace stripped: composerText() is textContent, which
  // drops newlines at block/<br> boundaries, so a multi-line value whose needle
  // still contains "\n" can NEVER match — landed() then reports false for a fill
  // that DID land, every fallback strategy fires, and the composer ends up with
  // the text inserted twice (Outlook double-draft bug, 2026-08-31).
  const strip = (s) => normComposer(s).replace(/\s+/g, "");
  return strip(composerText(el)).includes(strip(value).slice(0, 16));
}
// Is this the (new or classic) Microsoft Teams web app? Its composer is CKEditor 5,
// which needs the MAIN-world model bridge below — generic DOM strategies are reverted.
function isTeamsHost() {
  try {
    return /(^|\.)teams\.cloud\.microsoft$/.test(location.hostname) ||
           /(^|\.)teams\.microsoft\.com$/.test(location.hostname);
  } catch { return false; }
}

// Ask the background worker to insert text into CKEditor 5 from the PAGE world
// (chrome.scripting.executeScript — CSP-safe, unlike inline <script> which Teams
// blocks). Returns the page-world result { ok, ckeditor, via } or an error object.
function runInMainWorldInsert(dataId, value) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "__LC_MAIN_INSERT_TEAMS__", dataId, value },
        (resp) => resolve(resp || { ok: false, error: "no main-world response" })
      );
    } catch (e) { resolve({ ok: false, error: String(e) }); }
  });
}

// Robustly insert text into a rich-text composer. ASYNC now (the Teams bridge is
// async) and returns a BOOLEAN — true only when the text actually LANDED, so the
// caller never reports a false fill. Strategy order:
//   0) Teams/CKEditor 5 → MAIN-world model bridge (the only thing Teams honors).
//   1) execCommand('insertText') — Slack/Quill/ProseMirror/plain contenteditable.
//   2) synthetic paste — editors that route paste through their model API.
//   3) textContent + composed InputEvent — last resort (CKEditor reverts this, so
//      landed() then returns false and we honestly report the failure).
async function insertIntoContentEditable(el, win, doc, value) {
  el.focus();
  // Select any existing draft so we replace it rather than append.
  try {
    const sel = win.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {}

  // Strategy 0 — Teams CKEditor 5 via the CSP-safe MAIN-world bridge.
  if (isTeamsHost()) {
    let dataId = "";
    try { dataId = tag(el) + "-bridge"; el.setAttribute("data-lc-bridge", dataId); } catch {}
    if (dataId) {
      const r = await runInMainWorldInsert(dataId, value);
      if (r && r.ok) {
        await waitUntil(() => landed(el, value), 800, 50);
        if (landed(el, value)) return true;
      }
      // r.ckeditor === false → not a CKEditor surface; fall through to generics.
    }
  }

  try { doc.execCommand("insertText", false, value); } catch {}
  // Editors that commit programmatic input asynchronously (React reconcilers,
  // Roosterjs) need a beat before the fallback fires — otherwise the next
  // strategy inserts a SECOND copy of text that had already landed.
  await waitUntil(() => landed(el, value), 400, 50);
  if (landed(el, value)) return true;
  // Strategy 2: synthetic paste.
  try {
    const dt = new win.DataTransfer();
    dt.setData("text/plain", value);
    el.dispatchEvent(new win.ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData: dt
    }));
  } catch {}
  await waitUntil(() => landed(el, value), 400, 50);
  if (landed(el, value)) return true;
  // Strategy 3: direct set + fire a composed input event.
  el.textContent = value;
  el.dispatchEvent(new win.InputEvent("input", {
    bubbles: true, cancelable: true, inputType: "insertText", data: value
  }));
  return landed(el, value);
}

async function fillInput(handle, value, submit) {
  const el = resolveHandle(handle);
  if (!el) return { error: `No element found for: ${handle}` };
  // Phase 4 guard: a fill+submit on a day-trading order field is a submit vector —
  // block it (defense-in-depth alongside the Submit-button guard) unless allowed.
  if (submit && /day-trading/i.test(location.href) && isOrderField(el)) {
    const g = await guardDayTradingSubmit();
    if (g) return g;
  }
  if (submit && /live-trading/i.test(location.href)) { // MM pass 4 M2: one explicit guarded Submit click only (fill+submit recorded a stale signature and double-fired)
    return { ok: false, blocked: true, reason: "REAL-MONEY fill+submit is disabled. Fill with submit:false, click Validate, then use ONE guarded Submit Order click." };
  }
  if (el.tagName === "SELECT") return selectOption(handle, value); // dropdowns: pick the matching option
  if (el.id && el.id.startsWith("sys_display.")) {
    // ServiceNow reference field — typed text never commits a value here.
    return {
      error: "This is a REFERENCE field; plain typing does not commit a value. Use set_reference_field to commit, or get_reference_suggestions to discover valid values first."
    };
  }
  try {
    const win = el.ownerDocument.defaultView || window;
    const doc = el.ownerDocument || document;
    el.focus();
    el.scrollIntoView({ block: "center" });

    if (isContentEditableBox(el)) {
      // Rich-text composer (Slack/Teams/Quill/ProseMirror/Lexical...). It has no
      // .value and ignores a plain textContent set; insertIntoContentEditable
      // drives the editor's own pipeline (Teams bridge → execCommand → paste → input).
      const inserted = await insertIntoContentEditable(el, win, doc, value);
      if (submit) {
        // Chat composer: a cleared box is NOT proof of a send — verify the message
        // actually posted to the thread (Teams clears the box without sending).
        const res = await attemptSend(el, win, value);
        if (res.confirmed) {
          return { ok: true, filled: handle, contenteditable: true, sent: true, field: fieldInfo(el),
            note: "Sent — verified the message in the conversation history." };
        }
        if (res.sent) {
          // Box emptied but the message is NOT visible in the thread — the classic
          // Teams "composer cleared but nothing posted" false positive.
          return { ok: false, filled: handle, contenteditable: true, sent: false, field: fieldInfo(el),
            error: "The composer cleared but I could NOT confirm the message in the conversation history — on Microsoft Teams the box often clears without the message posting. Do NOT say it was sent.",
            note: "Verify by reading the conversation. If absent: click the composer, retype, then click the Send (➤) button explicitly via query_elements 'button[aria-label*=\"Send\" i]' + click_element." };
        }
        return { ok: false, filled: handle, contenteditable: true, sent: false, field: fieldInfo(el),
          error: "Typed into the right box but the message did NOT send — it is STILL in the composer (or never inserted). Do NOT say it was sent.",
          note: "Prefer the send_chat_message tool for chat apps, or click the send button: query_elements '[data-qa=\"texty_send_button\"], button[aria-label*=\"Send\" i]' then click_element. If a confirmation dialog appears, click its Send button too." };
      }
      if (!inserted) {
        // Text never landed (e.g. new Teams/CKEditor 5 reverted it) — report HONESTLY
        // so the agent doesn't claim a fill that isn't there.
        return { ok: false, filled: handle, contenteditable: true, field: fieldInfo(el),
          error: "Typed into the composer but the text did NOT land — the editor (e.g. new Microsoft Teams / CKEditor 5) reverted the programmatic input. Do NOT report it as filled.",
          note: "For chat apps use send_chat_message (it drives the editor model + verifies the post). Otherwise click the composer and retry." };
      }
      return { ok: true, filled: handle, submitted: false, contenteditable: true, field: fieldInfo(el) };
    }

    // Standard <input>/<textarea>: set value via the element's OWN-frame native
    // setter (triggers React/Vue), then fire input/change.
    const ctor = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement : win.HTMLInputElement;
    const setter = ctor && Object.getOwnPropertyDescriptor(ctor.prototype, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    if (submit) {
      pressEnter(el, win);
      el.form?.requestSubmit?.();
    }
    // Echo back WHICH field was filled so the agent can catch wrong targets
    // (e.g. Description vs Short description).
    return { ok: true, filled: handle, submitted: !!submit, field: fieldInfo(el) };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Enforced-target chat send. Picks the composer whose label matches `recipient`
// and REFUSES if none matches — so the agent can never post to the wrong
// channel/DM (the failure where "Hi!" went to #general instead of a DM). Types
// the text, sends via Enter, and falls back to clicking the send button.
// ---------------------------------------------------------------------------
const COMPOSER_SELECTOR = '[contenteditable="true"], [role="textbox"], textarea';

function composerLabel(el) {
  const aria = el.getAttribute?.("aria-label") || "";
  const ph = el.getAttribute?.("placeholder") || "";
  let lbl = aria || ph;
  if (!lbl) { try { lbl = fieldInfo(el).label || ""; } catch {} }
  return String(lbl).trim();
}

// Teams' composer aria-label is the generic "Type a message", so the recipient
// guard can't match it. Recover the open conversation's name from the page title
// ("(2) Chat | Frederick Ige | Microsoft Teams") or the chat header, so
// sendChatMessage can still enforce the right-conversation check on Teams.
// Teams left-rail app names — NEVER a conversation. Without this filter the
// generic [role=heading] selector can surface "Calendar" while a 1:1 chat is
// open, which broke the draft_chat_message recipient guard (2026-07-24).
const TEAMS_APP_RAIL_NAMES = /^(chat|chats|microsoft teams|activity|teams|calendar|calls|files|apps|onedrive|more|copilot)$/i;

function detectTeamsConversationRecipient() {
  if (!isTeamsHost()) return "";
  try {
    const t = (document.title || "").replace(/^\(\d+\)\s*/, "");
    const m = t.match(/(?:Chat|Channel)\s*\|\s*(.+?)\s*\|\s*Microsoft Teams/i);
    if (m && m[1] && !TEAMS_APP_RAIL_NAMES.test(m[1].trim())) return m[1].trim();
  } catch {}
  const sels = [
    '[data-tid="thread-title"]', '[data-tid="chat-header-title"]',
    '[data-tid*="threadHeader" i] [role="heading"]',
    '[role="heading"][aria-level="1"]', '[aria-label^="Chat with" i]'
  ];
  for (const s of sels) {
    try {
      const el = [...deepQueryAll(s)].find(isVisible);
      if (el) {
        const x = (el.getAttribute("aria-label") || el.innerText || el.textContent || "")
          .replace(/^Chat with\s+/i, "").trim();
        if (x && !TEAMS_APP_RAIL_NAMES.test(x)) return x;
      }
    } catch {}
  }
  return "";
}

// Realistic click — React/Slack buttons ignore a bare .click(); they listen on
// pointer/mouse events. Fire the full sequence, then .click() as a backstop.
// The checkbox an element activates: the checkbox itself, or a <label> bound to
// one (for= or a wrapped input). Used so clickRobust doesn't DOUBLE-TOGGLE it.
function checkboxTarget(el) {
  try {
    if (el.tagName === "INPUT" && el.type === "checkbox") return el;
    if (el.tagName === "LABEL") {
      let box = null;
      const forId = el.getAttribute("for");
      if (forId) box = el.ownerDocument.getElementById(forId);
      if (!box) box = el.querySelector("input[type=checkbox]");
      if (box && box.type === "checkbox") return box;
    }
  } catch {}
  return null;
}

function clickRobust(el) {
  const win = el.ownerDocument.defaultView || window;
  try { el.scrollIntoView({ block: "center" }); } catch {}
  // CHECKBOX SAFETY (verified LIVE 2026-07-15 on dev000000): a checkbox TOGGLES on
  // every activation, so firing BOTH a synthetic `click` event AND el.click()
  // toggles it twice → net NO-OP — the reason the Advanced/Update checkboxes never
  // changed and open_form_section reported "could not check the checkbox". For a
  // checkbox (or a label bound to one) do a SINGLE native activation and verify.
  const box = checkboxTarget(el);
  if (box) {
    const want = !box.checked;
    try { el.click(); } catch {}                 // one real click → SN onclick renders Advanced etc.
    if (box.checked === want) return;
    try { box.click(); } catch {}                // el was a label that didn't propagate — click the box
    if (box.checked === want) return;
    try { box.checked = want; box.dispatchEvent(new win.Event("change", { bubbles: true })); } catch {} // last resort, no re-click
    return;
  }
  // ONE click only (live UAT 2026-08-02, SN "Run Fix Script" → Proceed): firing a
  // synthetic `click` event AND el.click() runs every click handler TWICE — on SN it
  // submitted the Fix Script twice in parallel, creating duplicate ATF suites/tests
  // (same-ms scaffold names). Same double-fire the checkbox path above always
  // documented. Keep the pointer/mouse preamble for React SPAs, but let el.click()
  // be the ONLY source of the actual `click` event.
  for (const t of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
    try {
      const Ctor = /pointer/.test(t) && win.PointerEvent ? win.PointerEvent : win.MouseEvent;
      el.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, view: win }));
    } catch {}
  }
  try { el.click(); } catch {}
}

// Drag one element onto another. HTML5 drag-and-drop (draggable=true + drop
// zones) is driven by the DRAG events (dragstart/dragover/drop) carrying a shared
// DataTransfer — a synthetic .click() or a plain mouse sequence does NOT trigger
// it, which is why the agent previously reported "I cannot drag". We fire BOTH:
//   (1) the full HTML5 DnD sequence with ONE shared DataTransfer (native draggable
//       widgets + most custom course/quiz DnD), and
//   (2) a pointer/mouse move sequence (SortableJS, react-dnd mouse backend,
//       interact.js, and other libraries that implement drag via mouse events).
// Covers the common cases without native OS-level dragging (which the sandbox
// can't do). Verifies by checking the source actually moved into/near the target.
function eventPoint(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

function fireDnd(type, el, win, dataTransfer, pt, related) {
  let ev;
  const init = {
    bubbles: true, cancelable: true, composed: true, view: win,
    clientX: pt.x, clientY: pt.y, screenX: pt.x, screenY: pt.y,
    button: 0, buttons: 1, relatedTarget: related || null
  };
  try {
    ev = new win.DragEvent(type, init);
    // Some engines build DragEvent without letting us pass dataTransfer in the
    // ctor — force it on so handlers reading e.dataTransfer work.
    if (dataTransfer && !ev.dataTransfer) Object.defineProperty(ev, "dataTransfer", { value: dataTransfer, configurable: true });
  } catch {
    // DragEvent unavailable → synthesize on a MouseEvent and attach dataTransfer.
    ev = new win.MouseEvent(type, init);
    if (dataTransfer) { try { Object.defineProperty(ev, "dataTransfer", { value: dataTransfer, configurable: true }); } catch {} }
  }
  try { el.dispatchEvent(ev); } catch {}
  return ev;
}

function firePointer(type, el, win, pt) {
  try {
    const Ctor = /pointer/.test(type) && win.PointerEvent ? win.PointerEvent : win.MouseEvent;
    el.dispatchEvent(new Ctor(type, {
      bubbles: true, cancelable: true, composed: true, view: win,
      clientX: pt.x, clientY: pt.y, screenX: pt.x, screenY: pt.y, button: 0, buttons: 1, pointerId: 1, isPrimary: true
    }));
  } catch {}
}

// Control <video>/<audio> playback directly via the media element API — the
// reliable way to change SPEED, play/pause, mute, or seek, independent of the
// player's custom skin/controls (a training course's "2x" menu is fragile and
// often buried; setting element.playbackRate always works). Pierces same-origin
// iframes + shadow DOM. Cross-origin embedded players can't be reached (sandbox).
function mediaSummary(m) {
  return {
    tag: m.tagName.toLowerCase(),
    playbackRate: Math.round(m.playbackRate * 100) / 100,
    paused: m.paused,
    muted: m.muted,
    currentTime: Math.round(m.currentTime),
    duration: Number.isFinite(m.duration) ? Math.round(m.duration) : null
  };
}

function controlMedia(opts = {}) {
  const medias = [...deepQueryAll("video, audio")];
  if (!medias.length) {
    return { error: "No <video> or <audio> element found on this page. If the player is embedded from another site (a cross-origin iframe), the sandbox can't reach it — use the player's own on-screen speed control instead." };
  }
  // Primary = the largest visible video (the main lesson player), falling back to
  // whichever is currently playing, then the first element.
  const visible = medias.filter((m) => { try { return isVisible(m); } catch { return true; } });
  const pool = visible.length ? visible : medias;
  const area = (m) => { try { const r = m.getBoundingClientRect(); return r.width * r.height; } catch { return 0; } };
  const primary = pool.slice().sort((a, b) => (b.tagName === "VIDEO") - (a.tagName === "VIDEO") || area(b) - area(a))[0]
    || pool.find((m) => !m.paused) || medias[0];

  const applied = [];
  // Speed: apply to ALL media so it works regardless of which element the course
  // tracks. Clamp to the browser-supported range (most cap effective rate at 16).
  if (opts.rate != null) {
    const r = Math.min(16, Math.max(0.1, Number(opts.rate)));
    for (const m of medias) {
      try {
        m.playbackRate = r;
        m.defaultPlaybackRate = r; // some players re-init from the default on the next segment
        applied.push("rate=" + r);
      } catch {}
    }
  }
  // play / pause / mute target the PRIMARY player.
  if (opts.action === "play") { try { primary.muted = primary.muted; primary.play && primary.play(); applied.push("play"); } catch (e) { applied.push("play-failed:" + e.message); } }
  else if (opts.action === "pause") { try { primary.pause && primary.pause(); applied.push("pause"); } catch {} }
  else if (opts.action === "mute") { try { primary.muted = true; applied.push("mute"); } catch {} }
  else if (opts.action === "unmute") { try { primary.muted = false; applied.push("unmute"); } catch {} }

  if (opts.seek != null) {
    try {
      let t;
      if (opts.seek === "start") t = 0;
      else if (opts.seek === "end") t = Number.isFinite(primary.duration) ? Math.max(0, primary.duration - 0.5) : primary.currentTime;
      else t = Math.max(0, Number(opts.seek));
      if (Number.isFinite(t)) { primary.currentTime = t; applied.push("seek=" + Math.round(t)); }
    } catch {}
  }

  return {
    ok: true,
    media_found: medias.length,
    applied,
    primary: mediaSummary(primary),
    all: medias.slice(0, 6).map(mediaSummary),
    note: "Set element.playbackRate directly (bypasses the player's speed menu). If a course RESETS the speed each segment, call this again; to make a gated video finish sooner, set a high rate and action:'play' (it must actually play through — seeking to the end often doesn't satisfy completion tracking)."
  };
}

async function dragDrop(sourceHandle, targetHandle) {
  const src = resolveHandle(sourceHandle);
  if (!src) return { error: `No source element found for: ${sourceHandle}` };
  const dst = resolveHandle(targetHandle);
  if (!dst) return { error: `No target/drop-zone element found for: ${targetHandle}` };
  const win = src.ownerDocument.defaultView || window;

  const doc = dst.ownerDocument;
  // Clamp a point inside the current viewport so elementFromPoint never returns
  // null (an off-screen drop coordinate is exactly why a drop "goes past" the zone).
  const clampPt = (p) => {
    const vw = (win.innerWidth || doc.documentElement.clientWidth || 0);
    const vh = (win.innerHeight || doc.documentElement.clientHeight || 0);
    return { x: Math.max(1, Math.min(p.x, vw - 2)), y: Math.max(1, Math.min(p.y, vh - 2)) };
  };
  // The element the browser would actually deliver the drop to = whatever is on
  // top at that point. HTML5 DnD + pointer libraries read document.elementFromPoint
  // to decide the drop target; dispatching only on `dst` misses those, so we
  // deliver enter/over/drop to the element under the point (it bubbles to dst).
  const deliverAt = (pt) => {
    let el = null;
    try { el = doc.elementFromPoint(pt.x, pt.y); } catch {}
    return el || dst;
  };

  try { src.scrollIntoView({ block: "center", inline: "center" }); } catch {}
  await new Promise((r) => setTimeout(r, 30));
  const srcPt = clampPt(eventPoint(src));

  let dataTransfer = null;
  try { dataTransfer = new win.DataTransfer(); } catch { try { dataTransfer = new DataTransfer(); } catch {} }
  // Some handlers read text/plain or the element id to know WHAT is being dragged.
  try { if (dataTransfer) dataTransfer.setData("text/plain", src.id || src.textContent?.trim().slice(0, 100) || "drag"); } catch {}

  // (2a) pointer/mouse press on the source (libraries begin their drag here).
  firePointer("pointerover", src, win, srcPt);
  firePointer("pointerenter", src, win, srcPt);
  firePointer("pointerdown", src, win, srcPt);
  firePointer("mousedown", src, win, srcPt);

  // (1a) HTML5 drag start on the source.
  fireDnd("dragstart", src, win, dataTransfer, srcPt);
  fireDnd("drag", src, win, dataTransfer, srcPt);

  // CRITICAL: scroll the DROP ZONE into view and recompute its point NOW — the
  // source scroll above (or the drag itself) can move the target off-screen, and a
  // drop fired at a stale/off-screen coordinate lands "past" the zone. Recompute
  // against the fresh rect right before the move.
  try { dst.scrollIntoView({ block: "center", inline: "center" }); } catch {}
  await new Promise((r) => setTimeout(r, 40));
  const dstPt = clampPt(eventPoint(dst));

  // Glide toward the drop point in several steps so throttled dragover/pointermove
  // handlers register the hover before the drop, delivering each to the element
  // actually under the moving point.
  const STEPS = 6;
  let lastPt = dstPt, lastEl = dst;
  for (let i = 1; i <= STEPS; i++) {
    const pt = clampPt({
      x: Math.round(srcPt.x + (dstPt.x - srcPt.x) * (i / STEPS)),
      y: Math.round(srcPt.y + (dstPt.y - srcPt.y) * (i / STEPS))
    });
    const at = deliverAt(pt);
    firePointer("pointermove", at, win, pt);
    firePointer("mousemove", at, win, pt);
    fireDnd("dragenter", at, win, dataTransfer, pt, src);
    fireDnd("dragover", at, win, dataTransfer, pt, src);
    // dragover must also reach the zone element so a zone-level handler that
    // preventDefaults (required for a valid drop) runs even if a child is on top.
    if (at !== dst) fireDnd("dragover", dst, win, dataTransfer, pt, src);
    lastPt = pt; lastEl = at;
    await new Promise((r) => setTimeout(r, 25));
  }

  // (1b) drop on the element under the final point (bubbles to the zone) + (2b) release.
  fireDnd("drop", lastEl, win, dataTransfer, lastPt, src);
  if (lastEl !== dst) fireDnd("drop", dst, win, dataTransfer, lastPt, src);
  firePointer("pointerup", lastEl, win, lastPt);
  firePointer("mouseup", lastEl, win, lastPt);
  fireDnd("dragend", src, win, dataTransfer, lastPt, dst);

  // Verify: did the source end up inside (or visually within) the drop zone?
  await new Promise((r) => setTimeout(r, 120));
  let moved = false;
  try {
    if (dst.contains(src)) moved = true;
    else if (!src.isConnected) moved = true; // widget replaced the source with a clone inside the zone
    else {
      const sr = src.getBoundingClientRect(), dr = dst.getBoundingClientRect();
      const cx = sr.left + sr.width / 2, cy = sr.top + sr.height / 2;
      if (cx >= dr.left && cx <= dr.right && cy >= dr.top && cy <= dr.bottom) moved = true;
    }
  } catch {}
  return {
    ok: true,
    dragged: sourceHandle,
    onto: targetHandle,
    moved_into_target: moved,
    note: moved
      ? "Source is now inside/over the drop zone."
      : "Fired the full HTML5 + mouse drag sequence (scrolled the drop zone into view and delivered the drop to the element under the point), but couldn't confirm the source landed in the target. Call read_page to check the actual result — it may have worked. If not, the drop zone handle may be a wrapper: query_elements for the INNER drop area (the element with the category label, or an element with class containing 'drop'/'zone'/'target') and pass THAT as target. As a last resort use the real-mouse desktop_* tools if enabled."
  };
}

// Click a button matching labelRe inside a visible modal dialog (e.g. the
// confirm button of an "Are you sure…?" prompt). Matches on text so it ignores
// "Cancel" and hits the action button.
function clickDialogButton(doc, labelRe) {
  let dialogs = [];
  try { dialogs = [...deepQueryAll('[role="dialog"], [role="alertdialog"]')].filter((d) => isVisible(d)); } catch {}
  for (const dlg of dialogs) {
    let btns = [];
    try { btns = [...dlg.querySelectorAll("button")].filter((b) => isVisible(b)); } catch {}
    const hit = btns.find((b) => labelRe.test((b.innerText || b.textContent || "").trim()));
    if (hit) { clickRobust(hit); return true; }
  }
  return false;
}

// Some sends pop a confirmation modal ("Are you sure you want to send…?").
function clickSendConfirmation(doc) {
  return clickDialogButton(doc, /^send\b/i);
}

// Find a "send" button near a composer (same conversation container preferred).
// Ordered most-specific first; EXCLUDES the "schedule" split-button caret so we
// don't open the scheduling menu instead of sending.
function findSendButton(composer) {
  const selectors = [
    '[data-qa="texty_send_button"]',                                  // Slack
    'button[data-tid="sendMessageCommand"]',                          // Teams
    'button[data-tid*="send" i]:not([data-tid*="schedul" i])',        // Teams
    'button[aria-label="Send message" i]',
    'button[aria-label*="Send" i]:not([aria-label*="schedul" i])',
    '[data-qa*="send" i]:not([data-qa*="schedul" i])',
    'button[type="submit"]'
  ];
  const container = composer.closest?.("form, [class*='composer' i], [class*='message_input' i], [data-qa*='message_input' i], [class*='compose' i], [data-tid*='compose' i]");
  for (const sel of selectors) {
    let cands = [];
    try {
      cands = [...deepQueryAll(sel)].filter((b) =>
        isVisible(b) && !b.disabled && b.getAttribute?.("aria-disabled") !== "true");
    } catch {}
    if (!cands.length) continue;
    if (container) {
      const inside = cands.find((b) => container.contains(b));
      if (inside) return inside;
      continue; // composer's container is known but this button isn't in it — keep looking
    }
    if (cands.length === 1) return cands[0]; // unambiguous; otherwise avoid an unrelated button
  }
  return null;
}

function composerText(el) {
  return isContentEditableBox(el) ? (el.textContent || "") : (el.value || "");
}

// Normalize composer text so Slack's reformatting (zero-width chars, nbsp, CRLF,
// collapsed spaces) doesn't fool the inserted/cleared checks.
function normComposer(s) {
  return String(s || "")
    .replace(/​/g, "")
    .replace(/ /g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Did the message actually get inserted? Prefix-tolerant: Slack rewrites emoji
// shortcodes / @mentions / URLs in the TAIL, rarely the first chars — so an
// empty composer (execCommand silently failed) returns false and we never
// falsely report a send.
function messagePresent(el, value) {
  // Whitespace-stripped compare: composerText() is textContent, which drops
  // newlines at block boundaries — a multi-line needle containing "\n" would
  // never match text that DID land (same bug class as landed()).
  const strip = (s) => normComposer(s).replace(/\s+/g, "");
  const want = strip(value);
  if (!want) return false;
  return strip(composerText(el)).includes(want.slice(0, 24));
}

async function waitUntil(fn, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}

// Did the message actually POST? Look for its text in the conversation thread —
// any visible element OUTSIDE the composer that contains the message's leading
// text. This is the REAL proof of a send; an emptied composer is necessary but
// NOT sufficient (Teams clears the box on send even when nothing posts). Skipped
// for very short messages, where a substring scan would false-match other UI.
function messageInHistory(composer, value) {
  // Whitespace-stripped compare: the rendered message row may break lines
  // differently than the typed value (\n vs \n\n vs block wraps), so a probe
  // that keeps newlines can miss a message that really posted.
  const strip = (s) => normComposer(s).replace(/\s+/g, "");
  const want = strip(value);
  const probe = want.slice(0, 40);
  if (probe.length < 8) return false; // too short to verify safely — caller trusts cleared()
  let nodes = [];
  try {
    nodes = [...deepQueryAll(MESSAGE_ROW_SELECTOR +
      ', [data-tid="chat-pane-message"], [data-tid*="messageBody" i], li, [role="listitem"], [class*="message" i]')]
      .filter((r) => isVisible(r) && r !== composer && !composer.contains(r) && !r.contains(composer));
  } catch {}
  for (const r of nodes) {
    try { if (strip(r.innerText || "").includes(probe)) return true; } catch {}
  }
  return false;
}

// Try to SEND the composer's content. Returns { sent, confirmed }:
//   - { sent:true, confirmed:true }  — message verified in the conversation history (real send)
//   - { sent:true, confirmed:false } — box cleared but post is UNVERIFIED; treat as failure for
//                                       verifiable messages (the Teams false-clear), success only
//                                       when the message was too short to verify
//   - { sent:false, confirmed:false } — text never inserted, or the box never cleared
// Click the send button (React onClick ignores isTrusted), else fall back to
// synthetic Enter; retry the other method. Polls instead of fixed waits.
async function attemptSend(el, win, value) {
  // Pre-send: if the text never landed in the box, do NOT report a send. This
  // closes the "execCommand returned true but inserted nothing" false positive.
  if (!messagePresent(el, value)) return { sent: false, confirmed: false };
  // Chat apps flip the Send button from disabled to enabled ASYNCHRONOUSLY after
  // the editor model registers the text — wait for it so we click a live button
  // instead of an ignored synthetic Enter. Originally Teams-only; a live Slack
  // failure (a live run: attemptSend reported "could NOT send", yet one manual
  // click of the same "Send now" button a call later sent fine) showed Slack
  // needs the same wait — so it now runs on EVERY host.
  await waitUntil(() => {
    const b = findSendButton(el);
    return !!b && b.getAttribute?.("aria-disabled") !== "true" && !b.disabled;
  }, 1500, 100);
  const before = normComposer(composerText(el)).length;
  // Change-detection (not substring-match) so emoji/mention/space rewrites in
  // the draft don't break the cleared check.
  const cleared = () => {
    const now = normComposer(composerText(el)).length;
    return now === 0 || now < before * 0.5;
  };
  const verifiable = normComposer(value).slice(0, 40).length >= 8;
  const confirmed = () => verifiable && messageInHistory(el, value);
  const doc = el.ownerDocument || document;
  const fire = () => { const b = findSendButton(el); if (b) clickRobust(b); else pressEnter(el, win); };

  for (let attempt = 0; attempt < 2; attempt++) {
    fire();
    // A "Are you sure you want to send?" modal may intercept — confirm it.
    await new Promise((r) => setTimeout(r, 200));
    clickSendConfirmation(doc);
    await waitUntil(() => confirmed() || cleared(), 2000, 150);
    if (confirmed()) return { sent: true, confirmed: true };
    if (cleared()) {
      // Box emptied — give an async post a moment to render in the thread.
      if (verifiable && await waitUntil(confirmed, 1500, 200)) return { sent: true, confirmed: true };
      // Cleared but not in history: trust the clear only when we couldn't verify
      // (short message). Otherwise it's a Teams-style false clear — report it.
      return { sent: true, confirmed: !verifiable };
    }
    // Not cleared, not confirmed → method-swap retry once (re-click the button;
    // synthetic Enter is ignored by Slack, so don't fall back to it here).
  }
  return { sent: false, confirmed: false };
}

// Shared composer targeting for send_chat_message / draft_chat_message: pick the
// visible composer whose label matches `recipient`, or return a refusal object —
// so text can never land in the wrong channel/DM. `toolName` personalizes the
// retry hint. Returns { target:{el,label} } or { error:{...} }.
function pickChatComposer(recipient, toolName) {
  const want = String(recipient || "").trim().toLowerCase();
  const nodes = [...deepQueryAll(COMPOSER_SELECTOR)].filter((el) => isVisible(el) && !el.disabled);
  if (!nodes.length) {
    return { error: { error: "No message composer is visible. Open the conversation first (click the recipient in the sidebar), then retry." } };
  }
  // On Teams the composer label is generic ("Type a message"); substitute the open
  // conversation's name (from the title/header) so the recipient guard still works.
  const teamsRecipient = detectTeamsConversationRecipient();
  const labeled = nodes.map((el) => {
    let label = composerLabel(el);
    if (teamsRecipient && /^(type a message|message|reply|write a message)$/i.test(label)) label = teamsRecipient;
    return { el, label };
  });

  // ENFORCED TARGETING: pick the composer whose label names the recipient.
  let target = null;
  if (want) {
    const wantIsMulti = /[,&]|\band\b/i.test(want);
    target = labeled.find((x) => x.label.toLowerCase().includes(want));
    // Group-chat safeguard: if the matched conversation lists MULTIPLE people
    // (commas / & / " and ") but the user named a SINGLE recipient, refuse — don't
    // broadcast a 1:1 message to a group. (If the user explicitly named a group,
    // `want` itself contains those markers, so we keep the match.)
    if (target && !wantIsMulti && /[,&]|\band\b/i.test(target.label)) target = null;
    // Label mismatch but only ONE composer is open: the label itself can be the
    // thing that's wrong (Teams' generic "Type a message" + a mis-detected
    // header). Accept the sole composer when the recipient provably belongs to
    // the OPEN thread — named in the conversation title or a visible message
    // sender — and the thread isn't a group. Same wrong-conversation guarantee,
    // one less refusal round-trip.
    if (!target && !wantIsMulti && nodes.length === 1) {
      const conv = detectConversationName() || "";
      let convIsMulti = /[,&]|\band\b/i.test(conv);
      let proven = conv.toLowerCase().includes(want);
      try {
        for (const s of CHAT_ROW_SELECTORS) {
          const rows = [...deepQueryAll(s)].filter(isVisible);
          if (!rows.length) continue;
          const senders = new Set(rows.slice(-25).map((r) => chatRowSender(r).toLowerCase()).filter(Boolean));
          if (!proven) proven = [...senders].some((n) => n.includes(want));
          // A NAMED group ("Project Falcon") has no comma/"and" in its title —
          // ≥3 distinct recent senders is the tell that this isn't a 1:1.
          if (senders.size >= 3) convIsMulti = true;
          break;
        }
      } catch {}
      if (proven && !convIsMulti) target = labeled[0];
    }
    if (!target) {
      return { error: {
        error: `Refused: no open message box matches recipient "${recipient}", so nothing was typed (avoids the wrong conversation).`,
        available_composers: labeled.map((x) => x.label).filter(Boolean).slice(0, 10),
        hint: `Open the correct conversation first (query_elements the recipient in the sidebar, click_element), then call ${toolName} again. Or retry with a recipient matching one of available_composers.`
      } };
    }
  } else if (nodes.length === 1) {
    target = labeled[0]; // unambiguous — only one composer
  } else {
    return { error: {
      error: "Several conversations are open — specify `recipient` so the text goes to the right one.",
      available_composers: labeled.map((x) => x.label).filter(Boolean).slice(0, 10)
    } };
  }
  return { target };
}

// Type text into a composer (contenteditable OR plain input/textarea) without
// sending. Shared by send_chat_message (which then sends) and draft_chat_message
// (which never does).
async function typeIntoComposer(el, value) {
  const win = el.ownerDocument.defaultView || window;
  const doc = el.ownerDocument || document;
  el.focus();
  el.scrollIntoView({ block: "center" });
  if (isContentEditableBox(el)) {
    await insertIntoContentEditable(el, win, doc, value);
  } else {
    const ctor = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement : win.HTMLInputElement;
    const setter = ctor && Object.getOwnPropertyDescriptor(ctor.prototype, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
  }
  return win;
}

async function sendChatMessage(recipient, message) {
  const value = String(message ?? "");
  if (!value.trim()) return { ok: false, sent: false, error: "Refused: the message is empty." };
  const picked = pickChatComposer(recipient, "send_chat_message");
  if (picked.error) return picked.error;
  const target = picked.target;
  const el = target.el;
  const win = await typeIntoComposer(el, value);

  // Send (prefer the send button; Enter is unreliable). The REAL proof is the
  // message appearing in the conversation history — an emptied composer alone is
  // not enough (Teams clears the box on send even when nothing posts).
  const res = await attemptSend(el, win, value);

  if (res.confirmed) {
    return {
      ok: true,
      sent: true,
      recipient_matched: target.label || undefined,
      message: value,
      note: "Sent — verified the message appears in the conversation history."
    };
  }
  if (res.sent) {
    // Box emptied but the message is NOT in the thread — the Teams false-clear.
    return {
      ok: false,
      sent: false,
      typed_into: target.label || undefined,
      message: value,
      error: "The composer cleared but I could NOT confirm the message in the conversation history — on Microsoft Teams the box often clears WITHOUT the message posting. Do NOT tell the user it was sent.",
      hint: "Read the conversation to check. If the message is absent: click the composer, retype the text, then click the Send (➤) button explicitly via query_elements 'button[aria-label*=\"Send\" i]' + click_element."
    };
  }
  return {
    ok: false,
    sent: false,
    typed_into: target.label || undefined,
    message: value,
    error: "Typed the message into the correct composer but could NOT send it — the text is still sitting in the box. Do NOT tell the user it was sent.",
    hint: "Find the send button near the composer and click it: query_elements selector '[data-qa=\"texty_send_button\"], button[aria-label*=\"Send\" i]', then click_element. Confirm success by the message appearing in the conversation HISTORY above the composer — NOT by text being present on the page (your unsent draft also shows in read_page)."
  };
}

// ---------------------------------------------------------------------------
// FAST chat reader — ONE call replaces get_tab_info + read_page(12000) + manual
// parsing for chat apps: returns the open conversation's name, the last N
// visible messages (sender + text + time, oldest-first), and the composer
// state. Read-only; solves the Teams "scroll_page doesn't move the thread" and
// Slack "read_page floods context with sidebar noise" playbook defects.
// ---------------------------------------------------------------------------
const CHAT_ROW_SELECTORS = [
  '[data-qa="message_container"]',                                  // Slack
  '[data-tid="chat-pane-item"], [data-tid="chat-pane-message"]',    // Teams chat
  '[data-tid*="messageBody" i]',                                    // Teams channel posts
  '[role="log"] [role="listitem"]',                                 // generic ARIA chat log
  '.c-message_kit__message'                                         // Slack legacy
];
const CHAT_TEXT_SELECTOR = '[data-qa="message-text"], [data-tid*="messageBody" i], .c-message__message_blocks, .p-rich_text_section';

function chatRowSender(row) {
  try {
    const el = row.querySelector('[data-qa="message_sender_name"], .c-message__sender, [data-tid="message-author-name"], [data-tid*="author" i], [itemprop="author"]');
    const s = el ? (el.innerText || el.textContent || "").trim() : "";
    if (s) return s.split("\n")[0].slice(0, 80);
  } catch {}
  // Teams message rows carry "Name, time, text"-style aria-labels.
  try {
    const m = (row.getAttribute?.("aria-label") || "").match(/^([^,]{2,60}?),\s/);
    if (m) return m[1].trim();
  } catch {}
  return "";
}

function chatRowTime(row) {
  try {
    const t = row.querySelector('time, [data-tid*="timestamp" i], .c-timestamp, [data-ts]');
    if (t) return (t.getAttribute?.("aria-label") || t.getAttribute?.("datetime") || t.innerText || "").trim().slice(0, 60);
  } catch {}
  return "";
}

function chatRowTruncated(row) {
  try {
    return [...row.querySelectorAll("a, button, [role='button']")]
      .some((b) => /^(see more|show more|read more)\b/i.test((b.innerText || "").trim()));
  } catch { return false; }
}

// The open conversation's display name: Teams header/title, else a chat-app
// header heading, else the tab title's leading segment.
function detectConversationName() {
  const teams = detectTeamsConversationRecipient();
  if (teams) return teams;
  const sels = ['[data-qa="channel_name"]', 'header [role="heading"]', '[role="main"] [role="heading"]'];
  for (const s of sels) {
    try {
      const el = [...deepQueryAll(s)].find(isVisible);
      const x = ((el && el.innerText) || "").trim().split("\n")[0];
      if (x && x.length <= 80) return x;
    } catch {}
  }
  try {
    const seg = (document.title || "").replace(/^\(\d+\)\s*/, "").split(/\s*[|–-]\s*/)[0].trim();
    if (seg && seg.length <= 80 && !/^(slack|microsoft teams|teams|discord|chat)$/i.test(seg)) return seg;
  } catch {}
  return "";
}

function readChatMessages(limit) {
  const n = Math.max(1, Math.min(30, Number(limit) || 5));
  let rows = [];
  for (const sel of CHAT_ROW_SELECTORS) {
    try { rows = [...deepQueryAll(sel)].filter(isVisible); } catch { rows = []; }
    if (rows.length) break;
  }
  if (!rows.length) {
    return { error: "No chat message rows found — this view may not be a chat conversation (or it is empty). Fall back to read_page." };
  }
  // Drop rows nested inside another matched row (selectors can double-match).
  rows = rows.filter((r) => !rows.some((o) => o !== r && o.contains(r)));

  // Document order == chronological in chat apps. Walk a little before the
  // window so grouped messages (Slack omits the sender on consecutive posts)
  // inherit the right sender.
  const start = Math.max(0, rows.length - n - 15);
  let lastSender = "";
  const collected = [];
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    let sender = chatRowSender(row);
    if (sender) lastSender = sender; else sender = lastSender;
    if (i < rows.length - n) continue; // warm-up rows: track sender only
    let text = "";
    try {
      const t = row.querySelector(CHAT_TEXT_SELECTOR);
      text = normComposer((t || row).innerText || "");
    } catch {}
    const entry = { n: collected.length + 1, sender: sender || "(unknown)", text: text.slice(0, 600) };
    if (text.length > 600) entry.text_truncated = true;
    const time = chatRowTime(row);
    if (time) entry.time = time;
    if (chatRowTruncated(row)) entry.has_see_more = true;
    collected.push(entry);
  }

  // Composer state so the model can go straight to draft/send without a
  // query_elements round-trip.
  let composers = [];
  try { composers = [...deepQueryAll(COMPOSER_SELECTOR)].filter((el) => isVisible(el) && !el.disabled); } catch {}
  const teamsRecipient = detectTeamsConversationRecipient();
  const composerLabels = composers.map((el) => {
    let l = composerLabel(el);
    if (teamsRecipient && /^(type a message|message|reply|write a message)$/i.test(l)) l = teamsRecipient;
    return l;
  }).filter(Boolean).slice(0, 10);

  const out = {
    ok: true,
    conversation: detectConversationName() || undefined,
    messages: collected,
    total_visible: rows.length,
    composer_present: composers.length > 0,
    composers: composerLabels,
    note: "Last " + collected.length + " visible messages, OLDEST first (the final entry is the newest). Senders on grouped messages are inherited from the row above. A has_see_more message is truncated on the page — click its 'see more' link only if you need the full text."
  };
  if (!composers.length && isTeamsHost()) {
    out.note += " No compose box is open (Teams channels hide it) — draft_chat_message opens it automatically.";
  }
  return out;
}

// ---------------------------------------------------------------------------
// DRAFT-ONLY composer fill: types a reply into the RIGHT composer and NEVER
// sends — for review-then-send-by-human workflows. Auto-opens Teams' hidden
// "Post in channel" compose box. Reuses the enforced-recipient targeting so a
// draft can't land in the wrong conversation.
// ---------------------------------------------------------------------------
function findTeamsComposeOpener() {
  try {
    return [...deepQueryAll('button, [role="button"]')].find((b) => {
      if (!isVisible(b)) return false;
      const t = ((b.innerText || "") + " " + (b.getAttribute?.("aria-label") || "")).trim();
      return /post in channel|start a post/i.test(t);
    }) || null;
  } catch { return null; }
}

async function draftChatMessage(message, recipient, subject) {
  const value = String(message ?? "");
  if (!value.trim()) return { ok: false, drafted: false, error: "Refused: the draft text is empty." };
  let picked = pickChatComposer(recipient, "draft_chat_message");
  // Teams CHANNELS hide the compose box until "Post in channel" is clicked —
  // open it instead of failing.
  if (picked.error && isTeamsHost()) {
    const opener = findTeamsComposeOpener();
    if (opener) {
      clickRobust(opener);
      await waitUntil(() => {
        try { return [...deepQueryAll(COMPOSER_SELECTOR)].some((el) => isVisible(el) && !el.disabled); }
        catch { return false; }
      }, 2500, 150);
      picked = pickChatComposer(recipient, "draft_chat_message");
    }
  }
  if (picked.error) return picked.error;
  const el = picked.target.el;
  await typeIntoComposer(el, value);
  if (!messagePresent(el, value)) {
    return { ok: false, drafted: false, composer: picked.target.label || undefined,
      error: "Typed into the composer but the text did NOT land (the editor reverted the programmatic input). Do NOT report a draft.",
      hint: "click_element the composer to focus it, then retry draft_chat_message once." };
  }
  // Optional Teams-channel subject line.
  let subjectFilled;
  if (subject != null && String(subject).trim()) {
    subjectFilled = false;
    try {
      const s = [...deepQueryAll('input[placeholder*="subject" i], [aria-label*="subject" i] input, input[aria-label*="subject" i], [data-tid*="subject" i] input')].find(isVisible);
      if (s) { await typeIntoComposer(s, String(subject)); subjectFilled = true; }
    } catch {}
  }
  const out = {
    ok: true, drafted: true, sent: false,
    composer: picked.target.label || undefined,
    draft: value,
    note: "Draft typed into the composer — NOT sent, by design. Tell the user to review it and send it themselves. Never press Enter in the composer or click the Send/Post button for a draft; if the user later explicitly asks you to send, use send_chat_message."
  };
  if (subjectFilled !== undefined) out.subject_filled = subjectFilled;
  return out;
}

// ---------------------------------------------------------------------------
// Delete ONE of YOUR OWN chat messages by its exact text (Slack/Teams hover-
// menu flow). Destructive — always approval-gated upstream. Targets by exact
// text, then VERIFIES the message vanished (count drop), so it never claims a
// delete it can't confirm and won't blast the wrong message.
// ---------------------------------------------------------------------------
const MESSAGE_ROW_SELECTOR = '[data-qa="message_container"], [role="listitem"], .c-message_kit__message';

function messageRowText(r) {
  let t = null;
  try { t = r.querySelector('[data-qa="message-text"], .c-message__message_blocks, .p-rich_text_section'); } catch {}
  return normComposer(((t || r).innerText) || "");
}

async function deleteChatMessage(text) {
  const want = normComposer(text);
  if (!want) return { error: "Refused: give the EXACT text of the message to delete." };
  const doc = document, win = window;
  const rows = () => {
    let out = [];
    try { out = [...deepQueryAll(MESSAGE_ROW_SELECTOR)].filter((r) => isVisible(r)); } catch {}
    return out;
  };

  // Prefer exact match; fall back to substring ONLY if unambiguous (refuse if it
  // would match several — never guess which message to delete).
  let matchFn = (r) => messageRowText(r) === want;
  let matches = rows().filter(matchFn);
  if (!matches.length) {
    matchFn = (r) => messageRowText(r).includes(want);
    const subs = rows().filter(matchFn);
    if (!subs.length) return { error: `No visible message matching "${text}". Scroll the conversation to it first, then retry.` };
    if (subs.length > 1) return { error: `"${text}" partially matches ${subs.length} messages — pass the EXACT full message text so the right one is deleted.` };
    matches = subs;
  }
  const countMatches = () => rows().filter(matchFn).length;
  const beforeCount = matches.length;
  const target = matches[matches.length - 1]; // most recent matching message

  // Reveal the per-message hover toolbar, then open its More-actions (⋮) menu.
  try { target.scrollIntoView({ block: "center" }); } catch {}
  for (const t of ["pointerover", "mouseover", "mousemove"]) {
    try { target.dispatchEvent(new win.MouseEvent(t, { bubbles: true, cancelable: true, view: win })); } catch {}
  }
  await new Promise((r) => setTimeout(r, 200));
  let moreBtn = null;
  try { moreBtn = target.querySelector('[data-qa="more_message_actions"], [aria-label*="More actions" i]'); } catch {}
  if (!moreBtn) {
    try { moreBtn = [...deepQueryAll('[data-qa="more_message_actions"], [aria-label*="More actions" i]')].filter((b) => isVisible(b)).pop(); } catch {}
  }
  if (!moreBtn) return { error: "Could not find the message's 'More actions' (⋮) button — you can only delete your OWN messages." };
  clickRobust(moreBtn);
  await new Promise((r) => setTimeout(r, 300));

  // Click "Delete message" in the menu.
  let del = null;
  try {
    del = [...deepQueryAll('[data-qa="delete_message"], [role="menuitem"], [role="menuitemradio"], button')]
      .filter((b) => isVisible(b))
      .find((b) => b.getAttribute?.("data-qa") === "delete_message" || /^delete message\b/i.test(((b.innerText || b.textContent) || "").trim()));
  } catch {}
  if (!del) {
    try { doc.body.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch {}
    return { error: "Opened the actions menu but found no 'Delete message' option — this message is likely not yours (you can only delete messages you sent)." };
  }
  clickRobust(del);
  await new Promise((r) => setTimeout(r, 300));

  // Confirm the "Delete message?" modal, then VERIFY the message is gone.
  clickDialogButton(doc, /^delete\b/i);
  const deleted = await waitUntil(() => countMatches() < beforeCount, 2500, 200);
  return deleted
    ? { ok: true, deleted: text, remaining_same_text: beforeCount - 1,
        note: beforeCount > 1 ? `Deleted 1; ${beforeCount - 1} message(s) with identical text remain — call again to delete each.` : "Deleted — verified gone from the thread." }
    : { ok: false, deleted: false, error: "Clicked Delete but the message is still visible — it may not have deleted (or isn't yours). Do NOT claim it was deleted." };
}

// ---------------------------------------------------------------------------
// Reference / autocomplete fields (e.g. ServiceNow Caller, Assigned to).
// Typing alone never commits these — a suggestion must be clicked. This tool
// types, waits for the AJAX dropdown, clicks the best match, and verifies.
// ---------------------------------------------------------------------------
const SUGGESTION_SELECTOR = [
  '[role="option"]',
  ".ac_row",                 // ServiceNow classic autocompleter rows
  '[id^="AC."] tr',
  ".ui-menu-item",           // jQuery UI
  '[role="listbox"] li',
  ".dropdown-menu li a",
  ".now-typeahead-item",     // Polaris / Next Experience
  ".lookup-result-item"
].join(", ");

function findSuggestions(doc, want) {
  const out = [];
  for (const el of deepQueryAll(SUGGESTION_SELECTOR, doc)) {
    if (!isVisible(el)) continue;
    const text = (el.innerText || "").trim();
    if (!text) continue;
    if (want && !text.toLowerCase().includes(want)) continue;
    out.push({ el, text: text.slice(0, 120) });
  }
  // Prefer exact matches, then prefix matches, then shortest (most specific).
  out.sort((a, b) => {
    const at = a.text.toLowerCase(), bt = b.text.toLowerCase();
    const score = (t) => (t === want ? 0 : t.startsWith(want) ? 1 : 2);
    return score(at) - score(bt) || a.text.length - b.text.length;
  });
  return out;
}

// Browse a reference field's suggestions WITHOUT committing anything.
// Types `query`, collects the dropdown entries, then restores the field.
async function getReferenceSuggestions(handle, query) {
  const el = resolveHandle(handle);
  if (!el) return { error: `No element found for: ${handle}` };
  if (el.tagName !== "INPUT") {
    return { error: `Element is a <${el.tagName.toLowerCase()}>, expected the reference field's <input>.` };
  }
  const doc = el.ownerDocument;
  const win = doc.defaultView || window;
  const original = el.value;

  el.focus();
  el.scrollIntoView({ block: "center" });
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, query);
  else el.value = query;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new win.KeyboardEvent(type, { key: query.slice(-1) || "a", bubbles: true }));
  }

  const deadline = Date.now() + 5000;
  let found = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    found = findSuggestions(doc, "");
    if (found.length) break;
  }

  // Close the dropdown and put the field back exactly as it was — no commit.
  el.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (setter) setter.call(el, original);
  else el.value = original;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));

  const texts = found.slice(0, 20).map((s) => s.text);
  return {
    count: texts.length,
    suggestions: texts,
    note: texts.length
      ? "Nothing was committed. Commit one with set_reference_field (use option_text for the exact suggestion)."
      : "No suggestions appeared for this query — try a shorter/different query."
  };
}

async function setReferenceField(handle, value, optionText) {
  const el = resolveHandle(handle);
  if (!el) return { error: `No element found for: ${handle}` };
  if (el.tagName !== "INPUT") {
    return { error: `Element is a <${el.tagName.toLowerCase()}>, expected the reference field's <input>.` };
  }
  const doc = el.ownerDocument;
  const win = doc.defaultView || window;

  // Snapshot the PRE-state (2026-07-19, a live false-verify): the old
  // check only tested "hidden value non-empty", so a suggestion click that never
  // committed still reported verified:true when the hidden field held a STALE
  // value (display "read", committed "create" — the agent then believed the
  // wrong ACL operation was set). Verification below requires the hidden value
  // to CHANGE, or to already equal the wanted text.
  const displayBefore = el.value;
  let hiddenEl = null;
  let committedBefore;
  if (el.id && el.id.startsWith("sys_display.")) {
    hiddenEl = doc.getElementById(el.id.replace(/^sys_display\./, ""));
    committedBefore = hiddenEl ? hiddenEl.value : undefined;
  }

  el.focus();
  el.scrollIntoView({ block: "center" });
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  // Fire the event sequence autocomplete widgets listen for (SN uses keyup).
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new win.KeyboardEvent(type, { key: value.slice(-1) || "a", bubbles: true }));
  }

  const want = String(optionText || value).trim().toLowerCase();
  const deadline = Date.now() + 5000;
  let matches = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    matches = findSuggestions(doc, want);
    if (matches.length) break;
  }
  if (!matches.length) {
    const visible = findSuggestions(doc, "").slice(0, 10).map((s) => s.text);
    return {
      error: `No autocomplete suggestion matching "${optionText || value}" appeared within 5s.`,
      visible_suggestions: visible,
      hint: visible.length ? "Retry with option_text set to one of visible_suggestions." : "The field may need different text, or it isn't an autocomplete field."
    };
  }

  const pick = matches[0];
  // Some autocompletes commit on mousedown, others on click — fire the full set.
  for (const t of ["mousedown", "mouseup", "click"]) {
    pick.el.dispatchEvent(new win.MouseEvent(t, { bubbles: true, cancelable: true, view: win }));
  }
  await new Promise((r) => setTimeout(r, 400));

  // Verify the commit. ServiceNow pairs 'sys_display.<table>.<field>' (visible)
  // with '<table>.<field>' (hidden value holder — a sys_id for real references,
  // the raw value for choice-like references such as ACL operation). A commit is
  // verified only when the hidden value CHANGED, or it already equals the wanted
  // text (re-setting an already-correct field). "Non-empty" alone is NOT proof —
  // a stale pre-existing value passes that test while the click silently failed.
  const committed = hiddenEl ? hiddenEl.value : undefined;
  const wantLc = want;
  const already = String(displayBefore).trim().toLowerCase() === wantLc
    || String(committed ?? "").trim().toLowerCase() === wantLc;
  let verified;
  if (committed === undefined) verified = undefined;          // no hidden pair found — can't judge
  else if (committed === "") verified = false;                // nothing committed at all
  else if (committed !== committedBefore) verified = true;    // the click committed a new value
  else verified = already;                                     // unchanged — OK only if it already held the want
  const base = {
    typed: value,
    clicked_suggestion: pick.text,
    display_value: el.value,
    committed_value: committed,
    committed_value_before: committedBefore,
    verified,
    field: fieldInfo(el)
  };
  if (verified === false) {
    return {
      ...base,
      ok: false,
      error: `Suggestion click did NOT commit: the hidden value is ${committed === "" ? "EMPTY" : `still "${committed}"`} while the display shows "${el.value}". The display text can lie — do not trust it. Retry set_reference_field (use option_text with an EXACT entry from get_reference_suggestions), and re-verify before saving.`
    };
  }
  return { ...base, ok: true };
}

function scrollPage(direction, amount = 800) {
  // ServiceNow (classic + Polaris) scrolls inside iframes or overflow DIVs, not the top
  // window — scrolling only windows and reporting window.scrollY always read 0 and looked
  // like a no-op to the agent (observed 2026-07-09: repeated scroll_page → scrollY:0 loops).
  // Scroll every scrollable target (windows AND each document's largest overflow container)
  // and report truthfully whether anything moved.
  const docs = [document];
  for (const f of deepQueryAll("iframe")) {
    try { const d = frameDoc(f); if (d) docs.push(d); } catch {}
  }
  const targets = [];
  for (const d of docs) {
    if (d.defaultView) targets.push({ kind: "window", win: d.defaultView });
    let best = null;
    try {
      for (const el of d.querySelectorAll("div, main, section")) {
        if (el.scrollHeight - el.clientHeight > 100) {           // cheap pre-filter first
          const cs = d.defaultView.getComputedStyle(el);
          if (/(auto|scroll)/.test(cs.overflowY) && (!best || el.scrollHeight > best.scrollHeight)) best = el;
        }
      }
    } catch {}
    if (best) targets.push({ kind: "element", el: best });
  }
  let moved = false, position = 0;
  for (const t of targets) {
    try {
      const obj = t.kind === "window" ? t.win : t.el;
      const before = t.kind === "window" ? obj.scrollY : obj.scrollTop;
      switch (direction) {
        case "top": obj.scrollTo({ top: 0 }); break;
        case "bottom": obj.scrollTo({ top: t.kind === "window" ? obj.document.body.scrollHeight : obj.scrollHeight }); break;
        case "up": obj.scrollBy({ top: -amount }); break;
        default: obj.scrollBy({ top: amount });
      }
      const after = t.kind === "window" ? obj.scrollY : obj.scrollTop;
      if (after !== before) moved = true;
      position = Math.max(position, Math.round(after));
    } catch {}
  }
  // moved:false at position 0 on "top"/"up" is normal (already there). For down/bottom,
  // moved:false means the page genuinely has nothing more to reveal — stop scrolling and
  // use query_elements instead.
  return { ok: true, moved, position };
}

// ---------------------------------------------------------------------------
// "Teach a workflow" recording: capture the user's clicks/typing (incl. inside
// same-origin iframes) and stream them to the service worker. State lives on
// window so it survives nothing but the page; navigations resume via storage.
// ---------------------------------------------------------------------------
function lcDescribeForRecord(el) {
  let label;
  try { label = fieldInfo(el).label; } catch {}
  // Stable per-element id so successive partial-typing events on the SAME field
  // (or an unlabeled chat composer) collapse to one "full words" step at dedupe.
  let recId;
  if (lcIsRecordableField(el)) { try { recId = tag(el); } catch {} }
  return {
    tag: el.tagName.toLowerCase(),
    text: String(el.innerText || el.value || "").trim().slice(0, 80) || undefined,
    id: el.id || undefined,
    name: (el.getAttribute && el.getAttribute("name")) || undefined,
    label: label || undefined,
    recId: recId || undefined
  };
}
function lcRecordEvent(ev) {
  try { chrome.runtime.sendMessage({ type: "RECORD_EVENT", event: ev }); } catch {}
}

// Is this an element whose typed CONTENT we capture verbatim (full words)?
// Form controls PLUS rich-text/chat composers (Slack/Teams/Notion/ServiceNow),
// which never fire a "change" event and so were invisible to the old recorder.
function lcIsRecordableField(el) {
  if (!el || el.nodeType !== 1) return false;
  if (/^(input|textarea|select)$/i.test(el.tagName)) return true;
  try { return isContentEditableBox(el); } catch { return false; }
}

// The field's CURRENT full text — passwords masked, everything else verbatim and
// UNTRUNCATED. Reads .value for form controls, visible text for composers.
function lcFieldValue(el) {
  if (el.getAttribute && el.getAttribute("type") === "password") return "***";
  if (/^(input|textarea|select)$/i.test(el.tagName)) return String(el.value || "");
  return String(el.innerText || el.textContent || "");
}

// Debounced per-field capture: record the FULL words a field holds once typing
// settles, not one event per keystroke. Successive captures on the same field
// collapse to the final value at dedupe (teach.js, keyed on target.recId), so a
// whole paragraph becomes a single "Type \"...\" into ..." step. A Set tracks
// pending fields so a capture still in flight when recording stops (or a chat box
// about to be cleared by Enter) is flushed rather than lost.
const LC_FIELD_DEBOUNCE_MS = 600;
const lcFieldTimers = new Map();   // el -> timeout id
const lcPendingFields = new Set(); // els with a capture queued or not-yet-flushed

function lcEmitFieldValue(el) {
  if (!window.__lcRecording || !lcIsRecordableField(el)) return;
  // A checkbox or radio holds no typed words. Its .value is a constant ("on", or the option name
  // such as "CSM"), so recording it as input saved 'Type "CSM" into "CSM"' and synthesis turned a
  // filter tick into a {csm_value} parameter (SIR0014155 Four Dragons recordings 2026-09-13).
  // Record the resulting STATE instead.
  const type = String((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
  if (el.tagName === "INPUT" && (type === "checkbox" || type === "radio")) {
    lcRecordEvent({ action: el.checked ? "check" : "uncheck", ts: Date.now(), url: location.href, target: lcDescribeForRecord(el) });
    return;
  }
  const value = lcFieldValue(el);
  if (!value) return; // empty (e.g. composer already cleared by a send) — nothing to record
  lcRecordEvent({
    action: el.tagName === "SELECT" ? "select" : "input",
    ts: Date.now(),
    url: location.href,
    target: lcDescribeForRecord(el),
    value // full words, no truncation
  });
}

function lcScheduleFieldCapture(el) {
  const prev = lcFieldTimers.get(el);
  if (prev) clearTimeout(prev);
  lcPendingFields.add(el);
  lcFieldTimers.set(el, setTimeout(() => {
    lcFieldTimers.delete(el);
    lcPendingFields.delete(el);
    lcEmitFieldValue(el);
  }, LC_FIELD_DEBOUNCE_MS));
}

function lcFlushFieldCapture(el) {
  const t = lcFieldTimers.get(el);
  if (t) { clearTimeout(t); lcFieldTimers.delete(el); }
  lcPendingFields.delete(el);
  lcEmitFieldValue(el);
}
function lcOnRecClick(e) {
  if (!window.__lcRecording) return;
  let el = e.target;
  if (el && el.nodeType === 1) {
    const clickable = el.closest && el.closest("a,button,[role=button],input,select,textarea,.btn,[onclick],td,li,label,.icon-search");
    el = clickable || el;
  }
  if (!el || el.nodeType !== 1) return;
  lcRecordEvent({ action: "click", ts: Date.now(), url: location.href, target: lcDescribeForRecord(el) });
}
// Final value on blur (input/textarea) or selection (select) — full words, no
// 200-char cap, password still masked (via lcFieldValue inside the flush).
function lcOnRecChange(e) {
  if (!window.__lcRecording) return;
  const el = e.target;
  if (!el || !/^(input|textarea|select)$/i.test(el.tagName)) return;
  lcFlushFieldCapture(el);
}

// Every keystroke / paste in any field or composer — debounced so we store full
// words, not fragments. This is what captures chat/rich-text boxes (Teams, Slack,
// Notion, ServiceNow) that the change-only path never saw.
function lcOnRecInput(e) {
  if (!window.__lcRecording) return;
  if (lcIsRecordableField(e.target)) lcScheduleFieldCapture(e.target);
}

// Enter in a chat composer SENDS and clears the box before our debounce could
// fire — flush the composer's text NOW so it isn't lost. (Shift+Enter is a
// newline, not a send, so let it keep buffering.)
function lcOnRecKeydown(e) {
  if (!window.__lcRecording) return;
  const el = e.target;
  if (e.key === "Enter" && !e.shiftKey && lcIsRecordableField(el) && isContentEditableBox(el)) {
    lcFlushFieldCapture(el);
  }
}
function lcAllDocs() {
  const docs = [document];
  try {
    for (const f of deepQueryAll("iframe")) {
      const d = frameDoc(f);
      if (d) docs.push(d);
    }
  } catch {}
  return docs;
}
// Attach the recording listeners to one document. Tracked in a WeakSet so a
// periodic re-scan skips docs already hooked and only wires up NEW ones —
// crucial for ServiceNow, whose same-origin gsft_main iframe gets a brand-new
// document object every time a record/form loads. addEventListener is itself
// idempotent for the same (fn, capture), so a missed-tracking re-attach is
// harmless; duplicate EVENTS from this reach-in plus the frame's own content
// script are collapsed at the single choke point in teach.js recordEvent().
const lcAttachedDocs = new WeakSet();
function lcAttachDoc(d) {
  if (!d || lcAttachedDocs.has(d)) return;
  try {
    d.addEventListener("click", lcOnRecClick, true);
    d.addEventListener("change", lcOnRecChange, true);
    d.addEventListener("input", lcOnRecInput, true);
    d.addEventListener("keydown", lcOnRecKeydown, true);
    lcAttachedDocs.add(d);
  } catch {}
}
function lcDetachDoc(d) {
  try {
    d.removeEventListener("click", lcOnRecClick, true);
    d.removeEventListener("change", lcOnRecChange, true);
    d.removeEventListener("input", lcOnRecInput, true);
    d.removeEventListener("keydown", lcOnRecKeydown, true);
  } catch {}
  lcAttachedDocs.delete(d);
}
let lcRescanTimer = null;
function lcRescanDocs() {
  if (!window.__lcRecording) return;
  for (const d of lcAllDocs()) lcAttachDoc(d);
}
function lcStartRecording() {
  if (window.__lcRecording) return;
  window.__lcRecording = true;
  lcRescanDocs();
  // Re-scan on a short cadence so late-loading / reloaded same-origin frames
  // (SN gsft_main on every form navigation) always get their listeners — the
  // one-shot attach at start went stale the moment the form reloaded.
  if (!lcRescanTimer) lcRescanTimer = setInterval(lcRescanDocs, 1000);
}
function lcStopRecording() {
  // Flush any field whose debounce hasn't fired yet so the last words aren't lost
  // (must run BEFORE clearing __lcRecording, which lcEmitFieldValue checks).
  for (const el of [...lcPendingFields]) { try { lcFlushFieldCapture(el); } catch {} }
  window.__lcRecording = false;
  if (lcRescanTimer) { clearInterval(lcRescanTimer); lcRescanTimer = null; }
  for (const d of lcAllDocs()) lcDetachDoc(d);
}

// ---------------------------------------------------------------------------
// Message dispatch (guarded against double-registration on re-injection).
// ---------------------------------------------------------------------------
if (!window.__localClaudeContentReady) {
  window.__localClaudeContentReady = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Liveness probe — a stale content script left by an extension reload keeps
    // window.__localClaudeContentReady set but CANNOT answer this (its runtime is
    // dead), so a successful PONG proves the listener is actually alive.
    if (msg?.type === "PING") { sendResponse?.({ ok: true, recording: !!window.__lcRecording }); return; }
    if (msg?.type === "RECORD_START") { lcStartRecording(); sendResponse?.({ ok: true }); return; }
    if (msg?.type === "RECORD_STOP") { lcStopRecording(); sendResponse?.({ ok: true }); return; }
    if (msg?.type !== "TOOL") return;
    const { name, args = {} } = msg;
    const run = async () => {
      if (/live-trading/i.test(location.href) && /^(send_chat_message|draft_chat_message|delete_chat_message|drag_drop|set_editor_value|save_record|_gmail_send)$/.test(name)) { // MM pass 3 L5 + pass 4 M1
        return { ok: false, blocked: true, reason: "This tool is not permitted on the REAL-MONEY page — use fill_input / click_element on the guarded order form." };
      }
      switch (name) {
        case "read_page": return readPage(args.max_chars);
        case "query_elements": return queryElements(args.selector, args.text, args.limit);
        case "click_element": return clickElement(args.selector, args.double);
        case "get_computed_style": return getComputedStyleTool(args.selector, args.properties);
        case "fill_input": return fillInput(args.selector, args.value, args.submit);
        case "send_chat_message": return await sendChatMessage(args.recipient, args.message);
        case "read_chat_messages": return readChatMessages(args.limit);
        case "draft_chat_message": return await draftChatMessage(args.message, args.recipient, args.subject);
        case "delete_chat_message": return await deleteChatMessage(args.text);
        case "select_option": return selectOption(args.selector, args.option);
        case "drag_drop": return await dragDrop(args.source, args.target);
        case "control_media": return controlMedia(args);
        case "open_form_section": return await openFormSection(args.section);
        case "set_reference_field": return await setReferenceField(args.selector, args.value, args.option_text);
        case "get_reference_suggestions": return await getReferenceSuggestions(args.selector, args.query ?? "");
        case "scroll_page": return scrollPage(args.direction, args.amount);
        case "press_key": return pressKey(args.key);
        case "_gmail_send": return await sendGmailCompose(args);
        default: return { error: `Unknown DOM tool: ${name}` };
      }
    };
    run()
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true; // keep channel open for the async response
  });

  // Resume recording after a navigation: a freshly-injected content script
  // checks whether a teach session is active and re-attaches its listeners.
  try {
    chrome.storage.local.get("teachRecording").then((o) => {
      if (o && o.teachRecording) {
        lcStartRecording(); // attach click/type listeners in EVERY frame (incl. same-origin SN gsft_main)
        // ...but only record a "navigate" STEP from the TOP frame's real user navigation. Cross-origin
        // challenge/analytics iframes (Cloudflare Turnstile at challenges.cloudflare.com/cdn-cgi/…,
        // reCAPTCHA, tag managers) re-inject constantly and were flooding the recording with junk
        // "Navigate to …" steps that drowned out the user's actual clicks/typing.
        let isTop = false; try { isTop = window.top === window; } catch { isTop = false; }
        const noisy = /(^|\.)challenges\.cloudflare\.com|\/cdn-cgi\/|turnstile|recaptcha|hcaptcha|doubleclick|googletagmanager|google-analytics|\/gen_204|about:blank/i.test(location.href);
        if (isTop && !noisy) {
          lcRecordEvent({ action: "navigate", ts: Date.now(), url: location.href, target: { text: document.title.slice(0, 80) } });
        }
      }
    });
  } catch {}
}

})();
