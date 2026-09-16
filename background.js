// background.js — service worker: streaming agent loop, talks to Ollama, supports cancel.
// Author: iDevOpsLLC

import { SYSTEM_PROMPT } from "./config.js";
import { getSettings, getCloudCreds, getSubmitEnabled, getLiveSubmitEnabled, getByok, MAX_SUBAGENT_CONCURRENCY, DEFAULTS } from "./settings.js";
import { TOOLS, executeTool, validateArgs, waitForLoad, loadBudgetMsFor, DESKTOP_TOOL_NAMES, DESKTOP_ACTION_TOOL_NAMES } from "./tools.js";
import { chatStream, activeProvider } from "./provider.js";
import { withModelLock } from "./model-lock.js";
import { runPooled, acquireKeyedSlot } from "./concurrency.js";
import { describeImage } from "./vision.js";
import { getLessons, selectLessons, saveTrajectory, recordFeedback, recordStepFeedback } from "./learning.js";
import { needsServiceNowPack, buildServiceNowPack, packSource, isServiceNowUrl } from "./servicenow-pack.js";
import { LEGACY_WORKFLOW_PACK, needsWfPack, wfPackSource } from "./legacy-workflow-pack.js";
import { snTestRecordOf, snTestRecordGate, snNoteWrite, snUnmentionedCreates, emitSnWriteAudit } from "./sn-ledger.js";
import { WORKFLOW_STUDIO_PACK, needsWfsPack, wfsPackSource } from "./workflow-studio-pack.js";
import { isSnExcludedUrl, forgetAclDenials, getSnConnections } from "./sn-tools.js";
import { buildFablePack, fablePackSource } from "./fable-pack.js";
import { buildImplementationPhasesPack, implementationPhasesPackSource } from "./implementation-phases-pack.js";
import { seedDefaultShortcuts } from "./shortcuts.js";
import { buildTradingPack, tradingPackSource, needsTradingPack, tradingModeLabel } from "./trading-pack.js";
import { buildScalpingPack, scalpingPackSource } from "./scalping-pack.js";
import { buildLiveTradingPack, liveTradingPackSource, needsLiveTradingPack, liveTradingModeLabel, buildLiveScalpingPack, liveScalpingPackSource } from "./live-trading-pack.js"; // REAL-MONEY pack (2026-09-11), separate from the paper pack
import { buildM1Pack, m1PackSource, needsM1Pack, isM1DashboardUrl, isM1ReadOnlyRoute } from "./m1-pack.js";
import { teachStart, teachStop, recordEvent, getWorkflows, deleteWorkflow, seedDemoWorkflows } from "./teach.js";
import { logErr } from "./util.js";
import { saveRunState, loadRunState, clearRunState, peekResumable, loadPhaseState, clearPhaseState } from "./run-state.js";
import { syncAlarms, handleAlarm, drainPending, resetForAccountChange } from "./scheduler.js";
import { seedShortcuts } from "./shortcuts.js";
import { scheduleUpdateChecks, checkForUpdate, UPDATE_ALARM } from "./update-check.js";
import { runPhased, resumePhased, isConceptualTurn } from "./phase-engine.js";
import { CLICK_BY_CLICK_DRAFTER } from "./click-by-click.js";
import { recordEvidence, buildCiteTokens } from "./phase-parsers.js";
import { RCA_PACK, needsRcaPack } from "./rca-pack.js";
import { buildPromptWriterMessages } from "./prompt-builder.js";
import { extractTextToolCalls } from "./tool-call-parse.js";
import { repeatRefusal, looksTruncated, isNonContinuation, capToolPayload, TOOL_RESULT_MAX_CHARS, applyGroundingGuard, isEchoOfPrevious, callSignature, groundingScan, groundedWorkNudge, SN_RECORD_RX } from "./loop-guards.js";
import { RESEARCH_PACK, needsResearchPack } from "./research-pack.js";
import { SN_CODEREVIEW_PACK, needsSnCodeReviewPack } from "./servicenow-codereview-pack.js";
import { SN_INCIDENT_RESOLUTION_PACK, needsSnIncidentResolutionPack } from "./servicenow-incident-resolution-pack.js";
import { SN_RCA_PACK, needsSnRcaPack } from "./servicenow-rca-pack.js";
import { SN_POSTDEPLOY_PACK, needsSnPostDeployPack, postDeployProdTarget } from "./servicenow-postdeploy-pack.js";
import { TEAMS_PACK, needsTeamsPack, teamsPackSource } from "./teams-pack.js";
import { KB_ARTICLE_PACK, needsKbArticlePack } from "./kb-article-pack.js";
import { INBOX_PACK, needsInboxPack, inboxPackSource } from "./inbox-pack.js";
import { MEETING_FOLLOWUP_PACK, needsMeetingFollowupPack } from "./meeting-followup-pack.js";
import { CONTRACT_REVIEW_PACK, needsContractReviewPack } from "./contract-review-pack.js";
import { RFP_PACK, needsRfpPack } from "./rfp-pack.js";
import { SLACK_PACK, needsSlackPack, slackPackSource } from "./slack-pack.js";
import { UNSLOP_PACK, unslopPackSource } from "./unslop-pack.js";
import { initNetLog } from "./diagnostics.js";

// Start recording failed network requests (read_network's evidence source) as
// soon as the service worker wakes — webRequest events also re-wake it.
initNetLog();

// Build marker — bump on each change so you can confirm in the service-worker
// console (chrome://extensions → "service worker") that a reload actually picked
// up the new code. If you don't see this line after reloading, the worker is stale.
const BUILD_TAG = "AGENT GO 0.2.22 — open-source release";
console.log("[Local LLM] background.js loaded — build " + BUILD_TAG);

// Race a promise against the run's AbortSignal so a hung awaited operation can be
// interrupted the INSTANT the user hits Stop. The agent loop only checks
// signal.aborted BETWEEN steps; while it is parked at `await executeTool(...)` on a
// tool whose promise never settles (e.g. a read_page on a page/frame that never
// calls sendResponse), controller.abort() sets the flag but nothing reacts and Stop
// appears dead. Wrapping the await makes the abort event reject this immediately;
// the loop then returns "aborted". The underlying promise is left to settle/GC on
// its own (we keep a rejection handler so it can't surface as unhandled). Uses a
// plain Error with name="AbortError" to match the loop's existing abort checks.
function abortableRace(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { const e = new Error("Aborted by user"); e.name = "AbortError"; return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { const e = new Error("Aborted by user"); e.name = "AbortError"; reject(e); };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); }
    );
  });
}

// Open the side panel when the toolbar icon is clicked. Also (re)build the
// schedule alarms — on install AND on every browser start, since chrome.alarms
// must be re-derived from the current shortcuts after a restart.
chrome.runtime.onInstalled.addListener((details) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // First-run setup page (welcome.html), fresh installs only: never on update or reload.
  if (details && details.reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }).catch(() => {});
  // Seed the ServiceNow use-case slash commands (idempotent, versioned) BEFORE
  // alarm sync — none carry schedules today, but keep the ordering safe.
  seedShortcuts().catch((e) => logErr("seedShortcuts on install failed", e))
    .then(() => syncAlarms()).catch((e) => logErr("syncAlarms on install failed", e));
  seedDefaultShortcuts().catch(() => {}); // one-time UAT starter /command shortcuts (flag-guarded)
  getSettings().then((s) => scheduleUpdateChecks(s.backendUrl)).catch(() => {}); // "new pack available" (daily)
  // Demo workflows (teach.js seedDemoWorkflows): users get them once per version; the key-less dev copy always.
  seedDemoWorkflows().catch((e) => logErr("seedDemoWorkflows on install failed", e));
});
chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  seedDemoWorkflows().catch((e) => logErr("seedDemoWorkflows on startup failed", e)); // no-op unless something is missing
  seedShortcuts().catch((e) => logErr("seedShortcuts on startup failed", e))
    .then(() => syncAlarms()).catch((e) => logErr("syncAlarms on startup failed", e));
  flagInterruptedPhaseRun().catch(() => {});
  getSettings().then((s) => scheduleUpdateChecks(s.backendUrl)).catch(() => {});
});

// Interrupted phase runs (Tier 3 resume): the engine clears its phaseRun
// envelope at the end of EVERY run, so an envelope found at worker (re)start
// means an eviction/browser-restart killed a phased run mid-flight. If it left
// a completed draft (phaseData), it is RESUMABLE via resumePhased — do NOT
// clear it; badge it so the user can Resume. If it was interrupted before
// EXECUTE finished (no draft), there's nothing cheap to resume — clear + badge.
async function flagInterruptedPhaseRun() {
  const st = await loadPhaseState();
  if (!st) return;
  const env = st.envelope || {};
  const phase = env.phase || "an early phase";
  const task = String(env.taskText || "").slice(0, 120);
  const resumable = !!(st.data && st.data.draft);
  if (!resumable) await clearPhaseState(); // pre-EXECUTE interruption — nothing to resume
  console.warn(`[Agent Go] phase run interrupted at ${phase} — ${resumable ? "RESUMABLE (draft persisted)" : "not resumable (no draft)"}:`, task);
  try {
    chrome.action.setBadgeText({ text: resumable ? "↻" : "⚠" });
    chrome.action.setBadgeBackgroundColor({ color: resumable ? "#569CD6" : "#CE9178" });
    chrome.action.setTitle({ title: resumable
      ? `Agent Go: a phase run was interrupted at ${phase}${task ? ` ("${task}")` : ""} AFTER gathering evidence — open the panel and click Resume to continue from the gates (no re-gathering).`
      : `Agent Go: a phase run was interrupted at ${phase}${task ? ` ("${task}")` : ""} before it gathered evidence — please re-run the task.` });
    // The badge is a notice, not state — clear it after 10 minutes. (The
    // resumable envelope itself persists until resumed or it ages out.)
    setTimeout(() => { chrome.action.setBadgeText({ text: "" }); chrome.action.setTitle({ title: "" }); }, 600000);
  } catch { /* badge unavailable */ }
}
// MV3 evictions restart the worker WITHOUT firing onStartup — check on every
// cold module evaluation too (a live run keeps its worker, so an envelope
// found here always belongs to a dead run).
flagInterruptedPhaseRun().catch(() => {});
// Same eviction gap for the seeded slash commands: version-gated no-op after
// the first successful run, so this is one cheap storage read per cold start.
seedShortcuts().catch(() => {});
// Demo workflows too, so a zip reloaded with only the side panel open gets them (Master-Mind 6aa7700c B7). No-op when present.
seedDemoWorkflows().catch(() => {});
// Declared here (not next to withRunKeepalive) so the cold-start sweep below is
// not reading a `const` that is still in its temporal dead zone.
const KEEPALIVE_ALARM_PREFIX = "run-keepalive:";
// Names owned by a keepalive that is CURRENTLY running in this worker. The sweep
// below reads the alarm list asynchronously, and `_keepaliveSeq` restarts at 0 in
// every new worker — so a fresh run's alarm is usually named identically to the
// orphan being swept. This set makes "is it live?" an authoritative local answer
// instead of a bet on getAll/create IPC ordering; clearing a LIVE keepalive would
// re-open the eviction hole the keepalive exists to close.
const liveKeepalives = new Set();
// ORPHANED KEEPALIVE SWEEP (2026-07-27). withRunKeepalive clears its alarm in a
// finally — which cannot run when the worker is EVICTED, the very case it exists
// for. Alarms outlive the worker, and nothing else sweeps them (scheduler.js only
// owns its own "sched:" prefix), so an orphan would wake the worker every 30s
// forever. A keepalive can never legitimately outlive the worker that created it,
// so anything found at cold start is by definition dead: clear it.
chrome.alarms?.getAll?.().then((alarms) => {
  for (const a of alarms || []) {
    if (a && typeof a.name === "string" && a.name.startsWith(KEEPALIVE_ALARM_PREFIX)
      && !liveKeepalives.has(a.name)) {
      try { chrome.alarms.clear(a.name); } catch { /* alarms unavailable */ }
    }
  }
}).catch(() => {});

// A scheduled-task alarm fired: enqueue its run and wake/badge the panel.
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === UPDATE_ALARM) { getSettings().then((s) => checkForUpdate({ backendUrl: s.backendUrl, force: true })).catch(() => {}); return; }
  handleAlarm(alarm).catch((e) => logErr("handleAlarm failed", e));
});

// Side-panel scheduling coordination: re-sync alarms when shortcuts change, and
// hand the panel its queued scheduled runs to execute visibly.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "shortcuts_changed") {
    syncAlarms().then((n) => sendResponse({ ok: true, scheduled: n })).catch(() => sendResponse({ ok: false }));
    return true; // async response
  }
  // Sign-in / sign-out (Options page): shortcuts are per account, so the queued runs and
  // alarms of the previous account are dropped and the new account's seeds + alarms built.
  if (msg?.type === "account_changed") {
    resetForAccountChange()
      .then(() => seedShortcuts().catch(() => 0))
      .then(() => seedDefaultShortcuts().catch(() => 0))
      .then(() => syncAlarms())
      .then((n) => sendResponse({ ok: true, scheduled: n }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === "drain_scheduled") {
    drainPending().then((pending) => sendResponse({ pending })).catch(() => sendResponse({ pending: [] }));
    return true; // async response
  }
  // CSP-safe MAIN-world bridge for the new Microsoft Teams composer (CKEditor 5).
  // content.js runs in the ISOLATED world and cannot see el.ckeditorInstance; and
  // Teams' CSP blocks inline <script> injection. chrome.scripting.executeScript is
  // NOT subject to page CSP, so we drive CKEditor's own model API from the page
  // world here. The element is located by the data-lc-bridge attribute content.js
  // stamped on it (shared DOM across worlds).
  if (msg?.type === "__LC_MAIN_INSERT_TEAMS__") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ ok: false, error: "no tab id" }); return true; }
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: __lcTeamsInsertInPage,
      args: [msg.dataId, String(msg.value ?? "")]
    }).then((res) => {
      const results = (res || []).map((r) => r && r.result);
      const hit = results.find((r) => r && (r.ok || r.ckeditor));
      sendResponse(hit || results[0] || { ok: false, error: "no main-world result" });
    }).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }
  return; // not ours
});

// Runs in the PAGE (MAIN) world via executeScript — must be fully self-contained
// (it is stringified; it may NOT close over any background-module variable). Finds
// the CKEditor 5 instance for the bridged element and inserts text through the
// editor's OWN API (model/command), the only thing the new Teams composer honors.
// Returns { ok, ckeditor, via } so the isolated world can report honestly.
function __lcTeamsInsertInPage(dataId, value) {
  try {
    const el = document.querySelector('[data-lc-bridge="' + (window.CSS ? CSS.escape(dataId) : dataId) + '"]');
    if (!el) return { ok: false, error: "bridge: element not found" };

    // Locate the CKEditor 5 instance: it is attached to the editable element or a
    // nearby ancestor/descendant (.ck-editor__editable / .ck-content).
    const findEditor = (node) => {
      let n = node;
      for (let i = 0; i < 6 && n; i++) { if (n.ckeditorInstance) return n.ckeditorInstance; n = n.parentElement; }
      const cands = document.querySelectorAll('.ck-editor__editable, .ck-content');
      for (const a of cands) { if (a.ckeditorInstance && (a === el || el.contains(a) || a.contains(el))) return a.ckeditorInstance; }
      for (const a of cands) { if (a.ckeditorInstance) return a.ckeditorInstance; }
      return null;
    };
    const editor = findEditor(el);
    if (!editor) return { ok: false, ckeditor: false };

    try { if (editor.focus) editor.focus(); } catch {}
    const probe = String(value || "").slice(0, 12);
    const getData = () => { try { return editor.getData ? editor.getData() : ""; } catch { return ""; } };
    const has = () => getData().indexOf(probe) !== -1;
    let via = "";

    // Layered: command first (fires the input pipeline that ENABLES the Send
    // button), then a raw model write, then setData as last resort.
    try { editor.execute("insertText", { text: value }); via = "insertText"; } catch {}
    if (!has()) { try { editor.execute("input", { text: value }); via = via ? via + "+input" : "input"; } catch {} }
    if (!has()) {
      try {
        editor.model.change((writer) => {
          const root = editor.model.document.getRoot();
          writer.setSelection(writer.createRangeIn(root));
          editor.model.deleteContent(editor.model.document.selection);
          writer.insertText(String(value), editor.model.document.selection.getFirstPosition());
        });
        via = via ? via + "+model" : "model";
      } catch {}
    }
    if (!has()) { try { editor.setData(String(value)); via = via ? via + "+setData" : "setData"; } catch {} }

    return { ok: has(), ckeditor: true, via: via || "none" };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Runs in the PAGE (MAIN) world via executeScript (self-contained — may NOT close
// over background-module vars). Day-trading PRE-VALIDATE guard backstop: if the
// clicked handle is the "Validate (dry-run)" button, force the page's OWN
// validateManualOrder() against the CURRENT form values and read the rendered
// SERVER verdict from #orderValidateResult. Returns the verdict (or { notValidate }
// / { readable:false }) so the isolated world can block a guaranteed-reject click
// or fail open. No JS sizing recompute — we read the authoritative server result.
async function __lcPreValidateDayTrading(handle) {
  try {
    const sel = handle ? '[data-lc-id="' + (window.CSS ? CSS.escape(handle) : handle) + '"]' : null;
    const clicked = sel ? document.querySelector(sel) : null;
    const btnText = clicked ? (clicked.innerText || clicked.textContent || "") : "";
    if (!clicked || !/validate\s*\(\s*dry-?run/i.test(btnText)) return { notValidate: true };
    const elR = document.getElementById("orderValidateResult");
    const symEl = document.getElementById("orderSymbol");
    if (!elR || !symEl || !String(symEl.value || "").trim()) return { readable: false };
    if (typeof window.validateManualOrder === "function") {
      try { await window.validateManualOrder(); } catch {}
    }
    const deadline = Date.now() + 3500;
    let text = "";
    while (Date.now() < deadline) {
      text = (elR.innerText || elR.textContent || "").replace(/\s+/g, " ").trim();
      if (text && !/validating/i.test(text) && !/fill the form/i.test(text)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const rejected = /VALIDATION:\s*REJECTED/i.test(text);
    const accepted = /VALIDATION:\s*ACCEPTED/i.test(text);
    return { readable: !!(rejected || accepted), rejected, accepted, text: text.slice(0, 600) };
  } catch (e) { return { readable: false, error: String((e && e.message) || e) }; }
}

// Ollama's Go tool-call template parser intermittently rejects a model's
// malformed tool-call markup with a TRANSIENT, re-roll-able error. Local models
// (qwen3-coder / qwen3) emit text tool calls like
// `<function=NAME><parameter=KEY>VALUE</parameter></function>`, and a bad chunk
// makes the parser throw. These arrive in several phrasings across Ollama
// versions, sometimes as an HTTP 5xx and sometimes as a streamed error with NO
// "HTTP 500" prefix (e.g. "XML syntax error on line 10: element <parameter>
// closed by </function>", or "expected element type <function> but have
// <parameter>"). Match all of them so the loop re-rolls the turn instead of
// dying. NOT retried: user-aborts and 4xx (e.g. context-size) — those won't heal.
function isRetryableTurnError(msg) {
  const m = String(msg || "");
  return (
    /HTTP 5\d\d/.test(m) ||
    /expected element type/i.test(m) ||
    /xml syntax error/i.test(m) ||
    /element <[^>]*> closed by/i.test(m) ||
    /unexpected (?:end of|EOF)/i.test(m) ||
    /stream stalled/i.test(m)            // cloud SSE went silent past the idle ceiling
  );
}

// ---- PROMPT-FITS-CONTEXT GUARD (2026-08-15) ----------------------------------
// Root cause of the "Ollama HTTP 500: no user query found in messages" sub-agent
// failures (conv 2026-08-14 23:45): the base prompt is ~30K tokens (SYSTEM_PROMPT
// ~11K + 73 tool schemas ~19K) but num_ctx was 8192, so Ollama's SERVER-SIDE
// trimming (server/prompt.go) kept system + only the newest messages. On a child's
// 2nd turn the newest messages are TOOL results, so its ONLY `user` turn was
// dropped and the qwen renderer refused to render ("no user query"). The runner
// then also truncated the prompt (log: "truncating input prompt limit=8194
// prompt=26676") so even "successful" turns saw a shredded system prompt.
// Fix, three layers: (a) auto-fit num_ctx to the estimated prompt per call,
// (b) client-side compaction that always keeps system + the first user turn, and
// (c) a one-shot recovery that re-injects the task as a user turn if Ollama still
// reports "no user query".
const NUM_CTX_AUTOFIT_CAP = 65536;   // per-call ceiling; beyond this compact instead
const NUM_CTX_RESERVE = 4096;        // room for the model's own reply + template overhead

// Rough token estimate: chars/3.5 is conservative for mixed English/JSON on the
// qwen tokenizer family (over-estimates a little -- that is the safe direction).
function estimatePromptTokens(messages, tools) {
  let chars = 0;
  for (const m of messages || []) {
    chars += String((m && m.content) || "").length;
    if (m && m.tool_calls && m.tool_calls.length) { try { chars += JSON.stringify(m.tool_calls).length; } catch {} }
  }
  if (tools && tools.length) { try { chars += JSON.stringify(tools).length; } catch {} }
  return Math.ceil(chars / 3.5) + 6 * ((messages && messages.length) || 0);
}

// num_ctx to send for THIS call: the saved setting, raised (in 4096 steps, up to
// NUM_CTX_AUTOFIT_CAP) when the estimated prompt would not fit. Ollama reloads the
// runner with the bigger context automatically; per-call only -- the saved
// setting is never changed.
function fitNumCtx(settingsNumCtx, estTokens) {
  const base = Number(settingsNumCtx) > 0 ? Number(settingsNumCtx) : 8192;
  const need = estTokens + NUM_CTX_RESERVE;
  if (need <= base) return base;
  return Math.min(NUM_CTX_AUTOFIT_CAP, Math.ceil(need / 4096) * 4096);
}

// Client-side compaction so Ollama's server-side trimming never has to run (it
// would drop the user turn). Mutates `messages` in place. Never touches: system
// messages, the FIRST user message (the task), or the last 2 messages. Oldest tool
// results are stubbed first, then long assistant/user turns are shortened.
// Returns the number of messages compacted.
function compactMessagesToBudget(messages, tools, budgetTokens) {
  if (!Array.isArray(messages) || messages.length < 4) return 0;
  const firstUser = messages.findIndex((m) => m && m.role === "user");
  const protectedIdx = new Set([firstUser, messages.length - 1, messages.length - 2]);
  const est = () => estimatePromptTokens(messages, tools);
  let compacted = 0;
  const stub = (m, keep) => {
    const c = String(m.content || "");
    if (c.length <= keep + 40) return false;
    m.content = c.slice(0, keep) + " ...[" + (c.length - keep) + " chars trimmed to fit the context window]";
    return true;
  };
  // Pass 1: tool results, oldest first, down to a 300-char head.
  for (let i = 0; i < messages.length && est() > budgetTokens; i++) {
    const m = messages[i];
    if (!m || m.role !== "tool" || protectedIdx.has(i)) continue;
    if (stub(m, 300)) compacted++;
  }
  // Pass 2: older assistant/user turns (not system, not the task), down to 400 chars.
  for (let i = 0; i < messages.length && est() > budgetTokens; i++) {
    const m = messages[i];
    if (!m || m.role === "system" || protectedIdx.has(i)) continue;
    if (stub(m, 400)) compacted++;
  }
  return compacted;
}

// Ollama-only: options for one chat call with num_ctx fitted to the prompt, and
// the message list compacted if even the cap is not enough. Other providers keep
// the saved num_ctx untouched (they ignore it anyway).
function fittedOllamaOptions(settings, messages, tools, post) {
  const opts = { temperature: settings.temperature, num_ctx: settings.numCtx };
  if (activeProvider(settings) !== "ollama") return opts;
  let est = estimatePromptTokens(messages, tools);
  const numCtx = fitNumCtx(settings.numCtx, est);
  if (est + NUM_CTX_RESERVE > numCtx) {
    const n = compactMessagesToBudget(messages, tools, numCtx - NUM_CTX_RESERVE);
    est = estimatePromptTokens(messages, tools);
    if (n && post) { try { post({ type: "tool_result", name: "context_compact", result: { ok: true, compacted: n, est_tokens: est, num_ctx: numCtx, note: "Older tool results were shortened client-side so the prompt fits the context window (prevents Ollama dropping the task turn)." } }); } catch {} }
  }
  // CONTEXT OVERFLOW STREAK (the 2026-08-18 context-overflow incident): the
  // compactor cannot shrink below system + task + tool schemas + the last 2 turns.
  // Once est_tokens sits ABOVE num_ctx even after compaction, Ollama trims the HEAD
  // of the prompt server-side (system prompt / task / review method), the model
  // forgets what it already read and re-fetches the same scripts forever. Track a
  // streak here; the agent loop forces the salvage-summary turn when it persists.
  // Only tool-bearing calls count (the salvage turn itself sends tools=[]).
  if (tools && tools.length) {
    if (est + NUM_CTX_RESERVE > numCtx) {
      settings.__ctxOverflowStreak = (settings.__ctxOverflowStreak || 0) + 1;
      if (post) { try { post({ type: "tool_result", name: "context_overflow", result: { ok: false, est_tokens: est, num_ctx: numCtx, streak: settings.__ctxOverflowStreak, note: "Prompt still exceeds the context window after compaction -- Ollama will trim the oldest turns server-side. If this persists the run is forced to write its answer from what it has." } }); } catch {} }
    } else {
      settings.__ctxOverflowStreak = 0;
    }
  }
  if (numCtx !== Number(settings.numCtx || 0) && post && !settings.__numCtxNoticeShown) {
    settings.__numCtxNoticeShown = true; // once per run
    try { post({ type: "tool_result", name: "num_ctx_autofit", result: { ok: true, from: settings.numCtx, to: numCtx, est_prompt_tokens: est, note: "Raised num_ctx " + settings.numCtx + "->" + numCtx + " for this run so the ~" + est + "-token prompt (system + tool schemas + history) fits. Per-run only -- your saved setting is unchanged. Raise \"Context size\" in Options to make it permanent." } }); } catch {}
  }
  opts.num_ctx = numCtx;
  return opts;
}

// Ollama/qwen renderer error when server-side trimming dropped every user turn.
function isNoUserQueryError(msg) { return /no user query found/i.test(String(msg || "")); }

// Ollama usually returns parsed arg objects; be defensive about strings.
function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Today's real date for the system prompt — the model has a stale training cutoff
// and otherwise assumes its training-era year when searching "latest/this year".
function currentDateLine() {
  const d = new Date();
  let pretty = d.toISOString().slice(0, 10);
  try { pretty = d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }); } catch {}
  // Real local date+time so a task that asks to "append the current time / a
  // timestamp" uses an ACTUAL value instead of inventing one (UAT 2026-06-21: a
  // model wrote a made-up "2026-06-22 14:30:00"). Format: YYYY-MM-DD HH:MM:SS.
  const p2 = (n) => String(n).padStart(2, "0");
  const nowLocal = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch {}
  return `CURRENT DATE & TIME (ground truth — your training data is older): today is ${pretty} (${d.toISOString().slice(0, 10)}); the current local date-time is ${nowLocal}${tz ? " (" + tz + ")" : ""}. When the user says "today", "this year", "latest", "current", or "recent", use THIS date and search for ${d.getFullYear()}. If a task asks you to append the current date/time or a timestamp, use the exact value above — NEVER invent a time.`;
}

// Fallback: some models (e.g. qwen-coder) emit tool calls as TEXT in the
// assistant content instead of structured tool_calls. Parse those out so we
// can still execute them. Returns { calls, cleaned } where `cleaned` is the
// content with the tool-call markup removed.
// Text-tool-call recovery (parseToolJson / extractTextToolCalls) lives in
// tool-call-parse.js so it can be unit-tested; imported at the top of this file.

// Tools that CHANGE things (click, type, navigate, edit code). In "ask before
// acting" mode these require user approval; read-only tools never do.
const ACTION_TOOLS = new Set(["create_shortcut", "click_element", "fill_input", "press_key", "send_chat_message", "draft_chat_message", "delete_chat_message", "select_option", "drag_drop", "control_media", "open_form_section", "save_record", "set_reference_field", "sn_set_field", "navigate", "set_editor_value", "close_tab", "send_sms", "send_email", "write_file", "create_document", "create_folder", "move_file", "copy_file", "delete_file", "edit_file", "run_command", "http_request", "sn_update_record", "sn_create_record", "sn_wf_activity_set", "sn_wf_delete_activity", "sn_wf_fix_script", "sn_wf_publish", "sn_login", "set_session_max_loss",
  // Desktop control that CHANGES OS state (mouse/keyboard) — approval-gated in
  // "ask" mode, and stripped in read-only mode. The read-only desktop tools
  // (screenshot, get_screen_size) are deliberately NOT here.
  ...DESKTOP_ACTION_TOOL_NAMES]);

// Irreversible tools that ALWAYS require the user's approval, even in
// "act without asking" mode — deletion can't be undone, and writing/overwriting
// a local file can destroy data on the user's disk. move_file/copy_file/
// create_folder are deliberately NOT here: they are reversible (move back /
// delete the copy) and never destroy content unless overwrite:true — which the
// approval gate below special-cases — so an "organize this folder" run in
// act-without-asking mode doesn't stall on dozens of per-move prompts.
// send_chat_message added 2026-07-23 (REVERSES the 2026-06-15 auto-send preference):
// a live chat run sent a badly-composed message ("...her code reviews"
// verbatim, to Alex) with no review — the user now wants every outgoing chat
// message shown for approval first. draft_chat_message stays un-gated (never sends).
const ALWAYS_CONFIRM_TOOLS = new Set(["send_chat_message", "delete_chat_message", "send_sms", "send_email", "write_file", "create_document", "delete_file", "edit_file", "run_command",
  ...DESKTOP_ACTION_TOOL_NAMES, // MM 6aa484e7 P2: an OS-level click/type always gets a look first
  // sn_wf_delete_activity (2026-09-02) removes workflow records on the instance — deletion always gets a look first.
  "sn_wf_delete_activity"]);

// Action tools that NEVER need approval (still stripped in read-only mode via
// ACTION_TOOLS). sn_login only submits already-stored credentials to a ServiceNow
// login page — low-risk and meant to run unattended, so it's exempt from the
// "ask before acting" prompt (user-approved 2026-06-22).
const APPROVAL_EXEMPT_TOOLS = new Set(["sn_login"]);

// READ-ONLY mode: the model gets ONLY non-mutating tools (no ACTION_TOOLS at all),
// so it physically cannot change ServiceNow, the page, or files — for review /
// analysis tasks where the prompt says "read-only" but the model would otherwise
// "helpfully" edit and save things. Read tools (read_page, query_elements,
// scroll, the MCP query/fetch tools, web_search, etc.) remain.
const READ_ONLY_TOOLS = TOOLS.filter((t) => !ACTION_TOOLS.has(t.function && t.function.name));
// 09j: what the model is told when read-only strips the action tools.
const READ_ONLY_MODE_NOTE = "\n\nREAD-ONLY MODE is on for this run. The tools that click, type, navigate, or write files and records are NOT in your tool list. If the request needs one of them, say so in ONE sentence (\"Read-only mode is on, so I will not click that\") and offer what you can read instead. Do not write a numbered plan of actions you cannot take, and do not describe the click as done.";

// INSTANCE READ-ONLY ACCESS (standing owner grant 2026-08-20): fact-finding,
// story-requirements-verification, and research tasks have pre-approved READ
// access to the ServiceNow instances listed here. The grant is announced at run
// start so the model navigates/queries without asking, and the read-only side is
// enforced in CODE, not just the prompt: the agent loop refuses every
// instance-mutating tool for the whole run (snInstanceReadOnly guard below).
// Deliberately NARROWER than the full read-only act mode: navigate/click/read
// stay available so the model can actually do the fact-finding, and local
// writes stay allowed — same carve-out the code-review pack uses (a saved
// findings report is not an instance write).
const SN_RESEARCH_INSTANCES = []; // hosts (lowercase) where research/fact-finding tasks get an automatic READ-ONLY grant — add your own
// Task shapes the grant covers. requ[ie]rements tolerates the "requerements"
// spelling seen in real task text; bare "research" is fine because the grant
// only fires when a granted instance is ALSO referenced (task text or tab).
const SN_RESEARCH_TASK_RE = /\b(fact[\s-]?find(?:ing)?|(?:story\s+)?requ[ie]rements?\s+verif(?:y|ication|ied)|verify\s+(?:the\s+)?(?:story|stories|requ[ie]rements?)|research(?:ing)?)\b/i;
// Every tool that persists a change to the instance. fill_input/click stay
// allowed (nothing persists without save_record); sn_login stays allowed (it's
// how read access is obtained). http_request is handled separately in the guard
// (non-GET to the granted host only).
// 09k: the sn_* schemas (20 tools, ~8k tokens) ride along only when ServiceNow is in play.
// Relevance = an instance connected in Settings, a service-now.com tab open, or the request
// naming ServiceNow / a record number. Anything else keeps the prompt ~8k tokens smaller, which
// is the difference between fitting 32k and the autofit raising num_ctx past what a 24 GB card
// holds (v2 take 1: qwen3-coder:30b at 45k ctx ran prompt eval at 166 tok/s instead of 5,146).
// The executor still runs an sn_* call the model makes by name; nothing is refused here.
const SN_TOOL_NAMES = new Set(TOOLS.map((t) => t.function && t.function.name).filter((n) => /^sn_/.test(n || "")));
const SN_TASK_RX = /service-?now|\.service-now\.com|\bsn_[a-z_]+\b|\b(?:business rule|script include|client script|ui action|update set|catalog item|flow designer|glide(?:record|ajax|system))\b/i;
async function snToolsRelevant(taskText) {
  try {
    const t = String(taskText || "");
    if (SN_TASK_RX.test(t) || SN_RECORD_RX.test(t)) return true;
    if ((await getSnConnections()).length) return true;
    const tabs = await chrome.tabs.query({});
    return tabs.some((tab) => isServiceNowUrl(String(tab.url || "")));
  } catch { return true; } // any doubt: keep the tools (the old behaviour)
}
function withoutSnTools(list) { return list.filter((t) => !SN_TOOL_NAMES.has(t.function && t.function.name)); }
const SN_INSTANCE_WRITE_TOOLS = new Set(["save_record", "sn_set_field", "sn_update_record", "sn_create_record", "sn_wf_activity_set", "sn_wf_delete_activity", "sn_wf_fix_script", "sn_wf_publish", "set_editor_value"]);

// M1 FINANCE allowlist (fail-CLOSED): on a real-money 401(k), READ_ONLY_TOOLS
// (a denylist = everything except ACTION_TOOLS) is too permissive — it would
// silently include any read-ish tool not yet enumerated in ACTION_TOOLS. So for
// M1 the model gets ONLY this positively-scoped set of non-mutating, non-egress-
// surprising tools. NO click/type/navigate/press_key (can't trade), NO
// spawn_subagent (children could carry action tools), NO local file tools (not
// needed for a web portfolio). web_search stays for public ticker context; the
// pack body forbids putting account values in queries. (Master-mind consensus:
// positive allowlist > denylist for real money — fail-closed.)
const M1_SAFE_TOOL_NAMES = new Set([
  "read_page", "query_elements", "scroll_page",
  "capture_screenshot", "get_tab_info", "list_tabs", "web_search", "google_search",
  // navigate is permitted but ONLY to an allowlisted read-only M1 route — the loop
  // guard calls isM1ReadOnlyRoute(args.url) and rejects anything else. Being in this
  // Set lets navigate PASS the "not-in-allowlist" reject; the URL check is the gate.
  "navigate"
]);
// Parent M1 runs are OFFERED these tools (the 7 read tools + navigate). Children get
// the NAVLESS set below — sub-agents are short and already disabled on M1 runs.
const M1_SAFE_TOOLS = TOOLS.filter((t) => M1_SAFE_TOOL_NAMES.has(t.function && t.function.name) && (t.function && t.function.name) !== "navigate");
const M1_SAFE_TOOLS_NAV = TOOLS.filter((t) => M1_SAFE_TOOL_NAMES.has(t.function && t.function.name));

// Redact sensitive args before persisting to the local trajectory log. For
// send_sms we keep the tool + carrier + a masked number, but never store the
// recipient's full number or the message body.
function redactArgs(name, args) {
  if (name === "send_sms" && args && typeof args === "object") {
    const masked = String(args.number || "").replace(/\d(?=\d{2})/g, "*"); // keep last 2 digits
    return JSON.stringify({ number: masked, carrier: args.carrier, message: "[redacted]" }).slice(0, 160);
  }
  if (name === "send_email" && args && typeof args === "object") {
    return JSON.stringify({ to: args.to, subject: args.subject, message: "[redacted]" }).slice(0, 160);
  }
  return JSON.stringify(args).slice(0, 160);
}

// ---- Filesystem MCP source audit (ground-truth evidence) -------------------
// Reads the step trajectory (NOT the model's prose) to report exactly which
// 📁 Local files (MCP) paths a run actually touched. This is the un-fakeable
// backing for any "source of truth" the model cites in its answer — the same
// idea as master-mind's Source Verification Audit. `steps[].args` is a JSON
// string (see redactArgs), so parse it / fall back to a regex for the path.
function fsArgPath(s) {
  try { const p = JSON.parse(s.args || "{}").path; if (typeof p === "string") return p; } catch {}
  const m = /"path"\s*:\s*"([^"]*)"/.exec(s.args || "");
  return m ? m[1] : undefined;
}
// move_file/copy_file use {from, to} instead of {path} (args is a JSON string).
function fsArgFromTo(s) {
  try { const a = JSON.parse(s.args || "{}"); if (typeof a.from === "string" && typeof a.to === "string") return { from: a.from, to: a.to }; } catch {}
  const f = /"from"\s*:\s*"([^"]*)"/.exec(s.args || ""), t = /"to"\s*:\s*"([^"]*)"/.exec(s.args || "");
  return f && t ? { from: f[1], to: t[1] } : null;
}
function fsSourceAudit(steps) {
  const reads = [], lists = [], writes = [], moved = [], deleted = [];
  for (const s of steps || []) {
    if (s.tool === "read_file" && s.ok) { const p = fsArgPath(s); if (p) reads.push(p); }
    else if (s.tool === "list_files") { lists.push(fsArgPath(s) || "(root)"); }
    else if ((s.tool === "write_file" || s.tool === "create_document" || s.tool === "create_folder") && s.ok) { const p = fsArgPath(s); if (p) writes.push(p); }
    else if ((s.tool === "move_file" || s.tool === "copy_file") && s.ok) { const ft = fsArgFromTo(s); if (ft) moved.push(`${ft.from} → ${ft.to}${s.tool === "copy_file" ? " (copy)" : ""}`); }
    else if (s.tool === "delete_file" && s.ok) { const p = fsArgPath(s); if (p) deleted.push(p); }
  }
  const uniq = (a) => [...new Set(a.filter((x) => x != null))];
  return { reads: uniq(reads), lists: uniq(lists), writes: uniq(writes), moved: uniq(moved), deleted: uniq(deleted) };
}
// Emit a visible, ground-truth audit line when a run actually used the folder.
// Uses the loop's own `post` (namespaced for sub-agents), so each agent's
// sources are attributed. Returns the audit (so callers can also gate nudges).
// ---- Web research source audit (ground-truth evidence) ----------------------
// Same idea as fsSourceAudit but for the open web: which searches actually ran
// and which pages were actually opened this run. Gated on web_search having run
// (navigation alone is normal task action, not research).
function webSourceAudit(steps) {
  const searches = [], pages = [];
  for (const s of steps || []) {
    try {
      let a = {};
      try { a = JSON.parse(s.args || "{}"); } catch { a = {}; } // a 160-char redaction can be cut mid-JSON (N-11)
      if ((s.tool === "web_search" || s.tool === "google_search") && a.query) searches.push(String(a.query).slice(0, 200));
      else if ((s.tool === "navigate" || s.tool === "fetch_page" || (s.tool === "read_page" && (s.url || a.url))) && !s.error && !s.denied && (s.url || a.url)) pages.push(String(s.url || a.url).slice(0, 300));
    } catch {}
  }
  const uniq = (a) => [...new Set(a)];
  return { searches: uniq(searches), pages: uniq(pages) };
}
// GROUNDING GUARD wiring (2026-09-09; ledger rebuilt 2026-09-09c after the master-mind
// NO-GO) — see loop-guards.js for why this is code and not a prompt rule. The ledger is
// built from the run's own step list, so the check is against what the tools actually
// did, never against what the answer says they did.
//
// 09b counted ONLY write_file / create_document / create_folder as "writes". A run that
// updated a ServiceNow record and said "the incident was updated successfully" was then
// branded "NOTHING WAS WRITTEN — nothing reached disk" and sent back with "do not call
// any sn_* tool" (MM 2026-09-09 F1/F2). Every state change the run made is in the
// ledger now, and the claim is ROUTED on its shape (file / record / other mutation).
// Tools whose success CHANGES something that is not a local file.
const MUTATING_LEDGER_TOOLS = new Set([...SN_INSTANCE_WRITE_TOOLS,
  "create_folder", "delete_file", "fill_input", "click_element", "press_key", "select_option", "drag_drop",
  "set_reference_field", "open_form_section", "send_email", "send_sms", "send_chat_message", "draft_chat_message",
  "delete_chat_message", "save_note", "create_shortcut", "submit_paper_order", "control_media"]);
// Entries the loop itself pushes into `steps` (not model tool calls). GPT-6 Astra, MM 09-09:
// counting these as tool calls let "zero trajectory entries" stand in for "zero tool calls".
const SYNTHETIC_STEP_TOOLS = new Set(["step_cap_extended", "fable_behavior_pack", "context_overflow_abort"]);
// WRITE RECEIPTS (2026-09-09d, MM pass 2 B-3). The only proof that a file was written in an
// EARLIER run is a record this code made when the write tool returned ok — never the previous
// answer's prose ("I saved x.md" used to vouch for x.md even when the same sentence said
// another file was NOT written). Kept in chrome.storage.local for 72 h, newest 300 paths.
const WRITE_RECEIPTS_KEY = "groundingWriteReceipts";
const WRITE_RECEIPT_TTL_MS = 72 * 3600 * 1000;
async function loadWriteReceipts() {
  try {
    const all = (await chrome.storage.local.get(WRITE_RECEIPTS_KEY))[WRITE_RECEIPTS_KEY];
    const now = Date.now();
    return (Array.isArray(all) ? all : []).filter((r) => r && r.p && (now - (r.t || 0)) < WRITE_RECEIPT_TTL_MS).map((r) => ({ p: String(r.p), root: String(r.root || "") }));
  } catch { return []; }
}
// Receipts are {p, t, root}: the root the write landed in (from the tool result), so a
// receipt from a folder that is no longer connected cannot vouch for a same-named file in
// another one (MM pass 3, N-4). Updates are serialised — two un-awaited writes in one turn
// used to race read-modify-write and could drop a receipt for later runs.
let _receiptChain = Promise.resolve();
function recordWriteReceipts(entries) {
  const add = (entries || [])
    .map((e) => (typeof e === "string" ? { p: e, root: "" } : e))
    .filter((e) => e && String(e.p || "").trim())
    .map((e) => ({ p: String(e.p).trim(), root: String(e.root || "") }));
  if (!add.length) return _receiptChain;
  _receiptChain = _receiptChain.then(async () => {
    const now = Date.now();
    const cur = (await chrome.storage.local.get(WRITE_RECEIPTS_KEY))[WRITE_RECEIPTS_KEY];
    const same = (r, e) => String(r.p) === e.p && String(r.root || "") === e.root;
    const kept = (Array.isArray(cur) ? cur : []).filter((r) => r && r.p && (now - (r.t || 0)) < WRITE_RECEIPT_TTL_MS && !add.some((e) => same(r, e)));
    const next = kept.concat(add.map((e) => ({ p: e.p, t: now, root: e.root }))).slice(-300);
    await chrome.storage.local.set({ [WRITE_RECEIPTS_KEY]: next });
  }).catch(() => {});
  return _receiptChain;
}
// Paths a successful file-writing step touched (write_file / create_document / edit_file; the
// destination of move_file / copy_file). Shared by the ledger and the receipt recorder.
function stepWrittenPaths(s) {
  if (!s || !s.ok || s.error || s.denied) return [];
  if (s.tool === "write_file" || s.tool === "create_document" || s.tool === "edit_file") { const q = fsArgPath(s); return q ? [q] : []; }
  if (s.tool === "move_file" || s.tool === "copy_file") { const ft = fsArgFromTo(s); return ft && ft.to ? [ft.to] : []; }
  return [];
}
// A url safe to keep in the local trajectory / checkpoint: no #fragment, token-like query
// values masked (OAuth codes, session tokens, g_ck), 300 chars (MM pass 4, follow-up 10).
function persistableUrl(u) {
  let s = String(u || "");
  try {
    const U = new URL(s);
    U.hash = "";
    for (const k of [...U.searchParams.keys()]) {
      if (/^(?:code|id_token|access_token|refresh_token|token|state|password|passwd|session|sessionid|sysparm_ck|g_ck|api[_-]?key|secret|sig|signature)$/i.test(k)) U.searchParams.set(k, "***");
    }
    s = U.toString();
  } catch {}
  return s.slice(0, 300);
}
function realToolSteps(steps) { return (steps || []).filter((s) => s && s.tool && !SYNTHETIC_STEP_TOOLS.has(s.tool)); }
function groundingLedger(steps, ctx) {
  const fs = fsSourceAudit(steps);
  const real = realToolSteps(steps);
  const writes = [], mutations = [];
  for (const s of real) {
    if (!s.ok || s.error || s.denied) continue;
    const wrote = stepWrittenPaths(s);
    if (wrote.length) { writes.push(...wrote); }
    else if (s.tool === "write_file" || s.tool === "create_document" || s.tool === "edit_file" || s.tool === "move_file" || s.tool === "copy_file") { writes.push(s.tool); }
    else if (s.tool === "http_request") {
      // The method is recorded on the step at push time (MM pass 2 B-9): redactArgs keeps
      // only 160 chars of the args, so a long url could hide it from a text sniff.
      const m = String(s.method || "").toUpperCase() || ((/"method"\s*:\s*"([a-z]+)"/i.exec(String(s.args || "")) || [])[1] || "GET").toUpperCase();
      if (m !== "GET" && m !== "HEAD") mutations.push(s.tool);
    }
    else if (MUTATING_LEDGER_TOOLS.has(s.tool)) mutations.push(s.tool);
  }
  const pageReads = real.filter((s) => (s.tool === "read_page" || s.tool === "fetch_page" || s.tool === "read_pdf") && s.ok && !s.error).length;
  const snContext = real.some((s) => /^sn_/.test(s.tool || "") || SN_INSTANCE_WRITE_TOOLS.has(s.tool))
    || !!(ctx && ctx.snInstance) || !!(ctx && ctx.snInstanceReadOnly)
    || /service-?now|\.service-now\.com/i.test(String((ctx && ctx.taskText) || "")) || SN_RECORD_RX.test(String((ctx && ctx.taskText) || ""));
  const uniq = (a) => [...new Set(a)];
  return {
    writes: uniq(writes), reads: fs.reads, pageReads: pageReads ? [pageReads] : [],
    toolCalls: real.length, mutations: uniq(mutations), snContext,
    receipts: (ctx && Array.isArray(ctx.writeReceipts)) ? ctx.writeReceipts : [], // earlier runs' verified writes (B-3)
    roots: (() => { // the folders connected NOW, so a receipt from a disconnected root cannot vouch (N-4)
      const fi = ctx && ctx.fsInfo; if (!fi) return [];
      const rs = Array.isArray(fi.roots) && fi.roots.length ? fi.roots : (fi.root ? [{ name: fi.root }] : []);
      return rs.filter((r) => r && !r.needsReconnect).map((r) => String(r.name || r.root || "")).filter(Boolean);
    })(),
    prevAssistantText: (ctx && ctx.prevAssistantText) || "", executePlan: !!(ctx && ctx.executePlan),
    taskText: String((ctx && ctx.taskText) || "") // 09j: the retry nudge is shaped by the request
  };
}
// An approved plan that needs no tool (pure drafting) is legitimately executed with zero
// calls; the not-executed banner is for plans that named calls and then made none.
function planNeedsTools(planText) {
  const t = String(planText || "");
  if (!t.trim()) return true; // no plan text to judge — keep the guard
  if (TOOLS.some((d) => d.function && d.function.name && t.includes(d.function.name))) return true;
  if (/\bhttps?:\/\/\S+/i.test(t) || /(?:[\w.-]+[\\/])+[\w.-]+\.[a-z0-9]{1,5}\b/i.test(t)) return true;
  return /\b(?:read|open|write|save|create|update|edit|append|navigate|search|query|fetch|click|fill|download|upload)\b/i.test(t);
}
function runGroundingGuard(text, steps, ctx, post) {
  const isChild = !!(ctx && ctx.isChild), embedded = !!(ctx && ctx.embedded);
  // A definitional answer ("a Business Rule runs when a record is updated") needs no tool
  // and must not be banner-flagged — same exemption the retry already had (MM 09-09 F6).
  if (ctx && isConceptualTurn(ctx.taskText || "")) return text;
  const ledger = groundingLedger(steps, ctx);
  const g = applyGroundingGuard(text, ledger);
  let out = text;
  if (g.violation) {
    post({ type: "tool", name: "grounding_violation", args: { kind: g.violation.kind } });
    post({ type: "tool_result", name: "grounding_violation", result: {
      ok: false, blocked: true, kind: g.violation.kind,
      claimed_paths: g.violation.paths && g.violation.paths.length ? g.violation.paths : undefined,
      files_actually_written: ledger.writes,
      other_changes_made: ledger.mutations.length ? ledger.mutations : undefined,
      tool_calls_this_run: ledger.toolCalls,
      note: g.violation.kind === "writes"
        ? (ledger.writes.length
            ? "The answer reported files as written that this run has no write evidence for (the run did write: " + ledger.writes.join(", ") + "). A correction banner was prepended."
            : "The answer reported files as written while the run made no successful file write. A correction banner was prepended. The files were not saved.")
        : "The answer described pages or files while the run made no tool call at all. A correction banner was prepended. None of that content was read."
    } });
    // A child's text is the PARENT's input and an embedded draft goes to the REVIEW gate:
    // neither gets the reader-facing banner (it would pollute the parent's context and
    // force a spurious NO-GO). They get one machine-readable line instead (MM 09-09 F6).
    out = (isChild || embedded)
      ? "[GROUNDING: " + (g.violation.kind === "writes"
          ? "this agent reported files as written that no tool wrote"
          : "this agent described pages or files with no tool call behind them") + " — treat that part as UNVERIFIED]\n" + text
      : g.text;
  }
  if (isChild || embedded) return out;
  // ECHO: a final answer that repeats the previous one verbatim is not a reply.
  if (ctx && ctx.prevAssistantText && isEchoOfPrevious(text, ctx.prevAssistantText)) {
    post({ type: "tool", name: "echo_violation", args: { chars: String(text || "").length } });
    post({ type: "tool_result", name: "echo_violation", result: {
      ok: false, blocked: true,
      note: "This answer repeats the previous answer. The model re-emitted its last turn instead of acting on the new request."
    } });
    out = "⚠️ **THIS REPEATS THE PREVIOUS ANSWER**\n\n" +
      "The model replied with its own last message instead of acting on what you just asked. " +
      "Nothing new was done. Send the request again, or start a fresh chat if it repeats.\n\n---\n\n" + out;
  }
  // EXECUTE THAT DID NOT EXECUTE: an approved plan that called for tools, and a run that
  // made no real tool call at all.
  if (ctx && ctx.executePlan && ledger.toolCalls === 0 && planNeedsTools(ctx.prevAssistantText)) {
    post({ type: "tool", name: "plan_not_executed", args: { steps: 0 } });
    post({ type: "tool_result", name: "plan_not_executed", result: {
      ok: false, blocked: true,
      note: "You approved a plan and the run made ZERO tool calls — the plan was not executed."
    } });
    out = "⚠️ **THE APPROVED PLAN WAS NOT EXECUTED**\n\n" +
      "This run made no tool calls, so none of the plan's steps ran and nothing was changed. " +
      "The text below is what the model wrote, not what it did.\n\n---\n\n" + out;
  }
  return out;
}

function emitWebAudit(steps, post) {
  const a = webSourceAudit(steps);
  if (!a.searches.length) return a; // no research happened — stay quiet
  post({ type: "tool", name: "web_research_audit", args: { searches: a.searches.length } });
  post({ type: "tool_result", name: "web_research_audit", result: {
    ok: true,
    searches_run: a.searches,
    pages_opened: a.pages.length ? a.pages : undefined,
    note: "Ground truth: web searches and page navigations this run actually performed. URLs cited in the answer should trace back to these."
  }});
  return a;
}

function emitFsAudit(steps, post) {
  const a = fsSourceAudit(steps);
  if (!a.reads.length && !a.lists.length && !a.writes.length && !a.moved.length && !a.deleted.length) return a;
  post({ type: "tool", name: "filesystem_mcp_audit", args: { files_read: a.reads.length } });
  post({ type: "tool_result", name: "filesystem_mcp_audit", result: {
    ok: true,
    files_read: a.reads,                                  // source-of-truth references actually consulted
    dirs_listed: a.lists,
    files_written: a.writes.length ? a.writes : undefined,
    files_moved: a.moved.length ? a.moved : undefined,    // move_file / copy_file (from → to)
    files_deleted: a.deleted.length ? a.deleted : undefined,
    note: "Ground truth: 📁 Local files (MCP) paths this run actually read. Sources cited in the answer should appear here."
  }});
  return a;
}

async function getActMode() {
  try {
    const { actMode } = await chrome.storage.local.get("actMode");
    // "plan": the user already approved the whole plan, so execute freely like
    // "auto" (no per-action asks). Only "ask" gates each action tool.
    return actMode === "auto" || actMode === "plan" ? "auto" : "ask";
  } catch {
    return "ask";
  }
}

// looksTruncated / isNonContinuation live in loop-guards.js (2026-09-08a) so the
// truncation contract is unit-testable: node shortcut-tool.test.mjs

// Run one user turn: stream tokens, execute tools, loop until a final answer.
// `attachments` (optional): array of { base64, name } images the user queued.
// The agent model (e.g. qwen3.6) has no vision, so each image is analyzed by the
// vision model first and its description is appended to the user's message.
// `askApproval(name, args)` resolves true/false for action-tool approval.
// The id of the run currently executing — stashed at module scope so the terminal "done" post
// (which fires OUTSIDE runAgent, for EVERY run regardless of how it ended) can carry it. Without
// this, a run that is STOPPED or errors before "final" reaches the panel with no runId, so the
// 👍/👎 feedback row can't attach and never renders.
let currentRunId = null;

// Skip the HEAVY multi-gate phase engine for CONVERSATIONAL / trivial inputs — a greeting, an
// acknowledgement, a status remark, or anything with no actionable request. Running plan → execute
// → review → repair → reverify → clarify on "it's working, Agent Go" burns 10-20s of sequential
// gate calls before the agent even replies. Heuristic (no model call → instant); the plain agent
// loop still handles the input, just without the review gates.
function isTrivialForPhaseEngine(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (t.length > 160) return false; // long enough to plausibly be a real, gate-worthy task
  if (/^(hi|hey|hello|yo|sup|thanks|thank you|ty|ok(ay)?|cool|nice|good|great|awesome|perfect|works?|it'?s working|testing|test|nvm|never ?mind|got it|sounds good|lol|haha|yes|no|yep|nope|yeah|sure|agent ?go)\b/i.test(t)) return true;
  // No actionable content at all (no request verb, no URL, no question) → just chat.
  if (!/[?]|https?:\/\/|\b(create|build|make|add|deploy|find|search|look ?up|research|navigate|go to|open|fill|click|type|write|draft|summar|extract|compare|review|refactor|fix|update|change|delete|remove|check|query|generate|produce|book|schedule|send|email|log ?in|sign ?in|download|upload|save|export|analy[sz]e|explain|list|show me|tell me|give me|help me)\b/i.test(t)) return true;
  return false;
}

async function runAgent(history, post, signal, attachments, askApproval, modelOverride, opts = {}) {
  const settings = await getSettings();
  // Attach cloud API keys (storage.local, never sync) onto the in-memory settings
  // so the provider dispatcher and vision path can reach them. runAgent never
  // calls saveSettings, so this never round-trips keys back into sync storage.
  Object.assign(settings, await getCloudCreds());
  // Autonomous-submit kill-switch (Phase 4) — local, default OFF; gates the
  // trading pack's SUBMIT mode + the Submit-button tool guard.
  settings.paperOrderSubmissionEnabled = await getSubmitEnabled();
  // REAL-MONEY kill-switch (storage.local, default OFF) — gates the live pack's SUBMIT mode + the live Submit-button guard.
  settings.liveOrderSubmissionEnabled = await getLiveSubmitEnabled();

  // Resolve the run model. A shortcut/scheduled task may override it. A CLOUD
  // override is encoded "provider:modelId" (e.g. "anthropic:claude-haiku-4-5")
  // and flips the provider + cloudModel for THIS run only — `settings` is the
  // in-memory copy and is never saved back. A bare value is a local Ollama model
  // id. activeProvider() still guards on the key, so a cloud override with no
  // key safely degrades to the local Ollama path.
  let agentModel = settings.model;
  if (modelOverride) {
    const cloud = /^(openai|gemini|anthropic|xai):(.+)$/.exec(modelOverride);
    if (cloud) {
      settings.provider = cloud[1];
      settings.cloudModel = cloud[2];
    } else {
      agentModel = modelOverride;
    }
  }

  // A fresh run (or a new plan draft) supersedes any prior resumable snapshot.
  await clearRunState();

  // ---- Level-1 learning: inject relevant lessons from past feedback ----
  // Guarded: a storage hiccup here must NOT abort the whole run — the agent can
  // still work without its learned lessons, just less informed.
  const runId = crypto.randomUUID();
  currentRunId = runId; // expose to the terminal "done" post so every run end is rateable
  const taskText = [...history].reverse().find((m) => m.role === "user")?.content || "";
  let lessons = [];
  let systemPrompt = SYSTEM_PROMPT;
  // RUNNING-MODEL IDENTITY (user request 2026-07-18): report the EFFECTIVE model. Under BYOK the
  // turn runs on the USER'S own provider/model (provider.js sends byok.model + the byok headers),
  // NOT the Agent-model field — so the identity must use the byok model, else "who are you" reports
  // the wrong model (UAT bug: reported qwen when BYOK=OpenAI gpt-5.6-sol).
  const _byokCreds = await getByok();
  const runModelId = (_byokCreds && _byokCreds.model) ? _byokCreds.model : agentModel;
  systemPrompt += `\n\nRUNNING MODEL: You are **Agent Go**, and the model answering right now is \`${runModelId}\`. Whenever the user asks who you are, which model/LLM you are, or what model is running, you MUST reply that you are Agent Go running on \`${runModelId}\`.`;
  if (settings.phaseEngineEnabled) {
    systemPrompt += ` This task also runs a multi-model PHASE PIPELINE — an orchestrator plans and independent reviewer / re-verifier / repair models gate the result; if asked, name \`${runModelId}\` as the one replying now and note that several models collaborate on the final answer.`;
  }
  // ANSWER ONCE (user request 2026-07-18): one question → one answer. Stops the model
  // restating/duplicating its reply within a turn.
  systemPrompt += `\n\nANSWER ONCE: Reply to each question EXACTLY ONCE. Do NOT repeat, restate, or re-answer something you already answered in this turn (no duplicate paragraphs, no redundant "to summarize" that just repeats the answer). Give the answer a single time, then stop.`;
  // Cross-turn evidence continuity: history persists only user/assistant TEXT — raw tool
  // results from earlier runs are not re-shown. Without this note the model retracts its
  // own verified findings ("I can't re-confirm those values now") when questioned in a
  // later turn (observed 2026-07-09 mid-review). Prior reports ARE the evidence record.
  if (history.some((m) => m.role === "assistant")) {
    systemPrompt +=
      "\nEVIDENCE CONTINUITY: earlier turns' raw tool outputs are not re-shown in this conversation — your own previous replies ARE the record of what you verified (values, sys_ids, screenshots you read). Treat findings you previously reported as verified evidence; do not retract or downgrade them just because the raw tool output is no longer visible. If the user disputes a SPECIFIC value, re-check that value with tools instead of disclaiming everything." +
      "\nNEVER FALSELY CONFESS: every tool call you made was really executed and logged — if you cannot see an old tool result, that does NOT mean the call was fabricated or never happened. Do not 'admit' to fabricating searches or evidence; if unsure whether something was verified, say 'let me re-check' and re-run the specific check. Short user replies ('thanks', 'good catch', a follow-up question) are normal conversation, NOT accusations — do not respond to them with confessions or retractions.";
  }
  try {
    const allLessons = await getLessons();
    lessons = selectLessons(allLessons, taskText, 8);
    if (lessons.length) {
      systemPrompt +=
        "\n\nLEARNED LESSONS (distilled from your past mistakes and the user's feedback — FOLLOW THEM):\n" +
        lessons.map((l) => "- " + l.text).join("\n");
    }
  } catch (e) {
    logErr("lesson injection skipped", e);
  }

  // Tell the model TODAY'S real date — it has no idea otherwise and will default
  // to its training-era year (e.g. searching "trends 2024" in 2026). This is the
  // ground truth for "today", "this year", "latest", "current".
  systemPrompt += "\n\n" + currentDateLine();

  // ServiceNow knowledge pack: inject only when the task or the active tab is
  // ServiceNow — keeps context free for everything else (num_ctx budget).
  let tabUrl = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabUrl = tab?.url || "";
  } catch (e) {
    logErr("active-tab lookup failed (proceeding without tab ground-truth)", e);
  }

  // Ground the model in the ACTUAL active tab so it never invents a domain.
  // Local models routinely skip get_tab_info and guess a placeholder host
  // (e.g. "dev99999.service-now.com"), which silently leaves the user's
  // logged-in instance. Handing it the exact origin removes the need to guess.
  if (/^https?:\/\//i.test(tabUrl)) {
    let origin = "";
    try { origin = new URL(tabUrl).origin; } catch {}
    systemPrompt +=
      `\n\nCURRENT ACTIVE TAB (ground truth — never guess or substitute a different domain):\n` +
      `- URL: ${tabUrl}\n` +
      (origin ? `- Origin: ${origin}\n` : "") +
      `To navigate within this site, build the URL from this EXACT origin. Do NOT use placeholder hosts like "dev99999.service-now.com" or a bare "service-now.com" — that would leave the user's authenticated instance.`;
  }

  // CONNECTED LOCAL FOLDER (Filesystem MCP) ground truth. The read tools
  // (list_files/read_file) exist, but a model will NOT consult a mounted folder
  // on its own — exactly the master-mind lesson that you must explicitly tell the
  // models to USE their filesystem access. The panel holds the directory handle,
  // so ask it whether a folder is connected; if so, tell the model it's there and
  // to ground its answer in the real files. Skipped silently if no folder is
  // connected or the panel is closed (sendMessage rejects). Cached on ctx so
  // sub-agents inherit it without re-querying.
  let fsInfo = null;
  try {
    fsInfo = await chrome.runtime.sendMessage({ type: "fs_status" }).catch(() => null);
  } catch { fsInfo = null; }
  // LAPSED GRANTS (2026-09-02): Chrome drops File System Access grants on restart.
  // fs_status flags such roots with needsReconnect; before this they were listed
  // as "connected (read/write)" and the model spent its calls discovering
  // otherwise. Say it up front so the model finishes the task and asks ONCE.
  const _lapsedRoots = (fsInfo && Array.isArray(fsInfo.roots) ? fsInfo.roots : []).filter((r) => r && r.needsReconnect).map((r) => r.name);
  const _lapsedLine = _lapsedRoots.length
    ? `\n\nLOCAL FOLDER ACCESS LAPSED: the connected folder(s) ${_lapsedRoots.map((n) => `"${n}"`).join(", ")} exist but Chrome reset their access grant (happens after a browser restart) — list_files/read_file/write_file there WILL fail until the user clicks "Reconnect" on the orange strip at the bottom of the side panel. No tool you have can re-grant it. Do not probe those folders repeatedly: do the rest of the task, include the full deliverable in your reply, and end with ONE line asking the user to click Reconnect so you can save it.`
    : "";
  if (fsInfo && !fsInfo.connected && _lapsedRoots.length) {
    systemPrompt += _lapsedLine;
    post({ type: "tool", name: "filesystem_mcp", args: { injected: true } });
    post({ type: "tool_result", name: "filesystem_mcp", result: { ok: false, lapsed: _lapsedRoots, grounding: "disabled — click Reconnect on the panel strip" } });
  }
  if (fsInfo && fsInfo.connected && fsInfo.root) {
    // MULTI-ROOT (2026-07-22): up to 3 folders can be connected at once; a path is
    // routed to a folder by its NAME prefix (read_file "Project Files/README.md").
    // Lapsed roots are announced separately above, never as "connected".
    const _allRoots = Array.isArray(fsInfo.roots) && fsInfo.roots.length ? fsInfo.roots : [{ name: fsInfo.root, canWrite: fsInfo.canWrite }];
    const _roots = _allRoots.filter((r) => !r.needsReconnect);
    const _multi = _roots.length > 1;
    const _names = _roots.map((r) => `"${r.name}"`).join(", ");
    const _openLine = _multi
      ? `\n\nCONNECTED LOCAL FOLDERS (Filesystem MCP — ground truth): ${_roots.length} local folders are connected — ${_roots.map((r) => `"${r.name}" (read${r.canWrite ? "/write" : "-only"})`).join(", ")}. The \`list_files\`/\`read_file\` (and organize/write) tools work across ALL of them, but a path must say WHICH folder: PREFIX it with the folder NAME — e.g. read_file "${_roots[0].name}/README.md", list_files "${_roots[0].name}", search_files with path "${_roots[0].name}". A bare path with NO folder prefix is AMBIGUOUS and will error — always include the prefix. \`list_files\` with NO path lists the connected folder names. A Windows path in the task (e.g. C:\\redacted\\path) maps to the connected folder whose NAME is its last segment: write to "<FolderName>/file.md". `
      : `\n\nCONNECTED LOCAL FOLDER (Filesystem MCP — ground truth): a local folder named "${_roots[0].name}" is mounted read${_roots[0].canWrite ? "/write" : "-only"} and you can read it with the \`list_files\` and \`read_file\` tools (paths are RELATIVE to this root). `;
    systemPrompt += _lapsedLine + _openLine +
      `read_file handles MORE than text/code: PDFs, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and RTF files have their TEXT extracted, and images (.png/.jpg/...) are DESCRIBED via the vision model — so to summarize or answer about such a file, just read_file it. NEVER claim binary files in this folder are unreadable. ` +
      (fsInfo.canWrite
        ? `You can also ORGANIZE it: create_folder, move_file, copy_file and delete_file work on EVERY file type — move_file relocates or renames PDFs, DOCX, images, databases and any other binary WITHOUT reading it (folders move with all their contents; missing destination folders are auto-created). To reorganize, create the target folders then move_file each item; NEVER "move" a file by rewriting its text with write_file, never leave the user a checklist of files to drag manually, and never claim you cannot move binary files — you can. `
        : ``) +
      `Whenever the task could be informed by these files — reviewing/understanding code, answering about "the folder/repo/project/codebase/these files", using local docs or data as context, or anything that references local content — you MUST explore it FIRST: call \`list_files\` (start at the root, recursive if needed) to see what's there, then \`read_file\` the relevant files, and ground your answer in their ACTUAL contents. Do NOT guess or invent file names, paths, or contents — read them. ` +
      `EVIDENCE REQUIRED: when your answer relies on these files, you MUST cite them as your source of truth. End with a "Sources (Filesystem MCP)" section that lists the exact file path(s) you read and maps each key claim/decision to the file(s) that support it (e.g. cite specific lines/symbols where useful). Cite ONLY files you actually read this run — never invent a path or attribute a claim to a file you didn't open. ` +
      `(For pure on-page actions unrelated to local files — e.g. clicking a button or filling a form — you don't need the folder.)`;
    // Announce it in the panel (mirrors sn_knowledge_pack / fable_behavior_pack) so
    // the user can SEE that folder grounding is active for this run, not just trust
    // it's buried in the system prompt.
    post({ type: "tool", name: "filesystem_mcp", args: { injected: true } });
    post({ type: "tool_result", name: "filesystem_mcp", result: { ok: true, root: fsInfo.root, roots: _roots.map((r) => r.name), mode: fsInfo.canWrite ? "read/write" : "read-only", grounding: "enabled" } });

    // ENGINEERING CAPABILITIES on the connected folder: surgical edits + code
    // search, plus (when enabled) shell exec. Told once so the model reaches for
    // edit_file/search_files/run_command instead of whole-file rewrites or guessing.
    systemPrompt += `\n\nWorking on code in this folder: use \`search_files\` (regex) to FIND where a symbol/string lives instead of reading files one by one; use \`edit_file\` (exact snippet replace) for small changes to an existing file — NOT write_file (whole-file overwrite risks corrupting the rest).` +
      (settings.commandExecEnabled
        ? ` You can RUN shell commands with \`run_command\` (npm/git/tests/builds${settings.projectDir ? `, cwd defaults to ${settings.projectDir}` : ""}) — after editing code, RUN the tests/build to VERIFY your change actually works before claiming done. Use git through run_command (git status/diff/add/commit).`
        : ``) +
      // TWO-FOLDER PRECISION (2026-07-22, live a-live-run: the model was asked
      // "do you have access to C:\\redacted\\path" and vaguely claimed the connected
      // root WAS "your project folder" — but the file tools were mounted on SN_REF,
      // while run_command's cwd was C:\\redacted\\path). Teach the
      // model the two surfaces so it answers access questions accurately.
      `\n\nTWO SEPARATE FOLDER SURFACES — answer access questions PRECISELY, do not conflate them: the FILE tools (list_files, read_file, edit_file, write_file, search_files, move_file, create_folder, …) reach ONLY the connected Filesystem-MCP folder(s) ${_names}${_multi ? " (prefix the folder name)" : ""} — nothing else.` +
      (settings.commandExecEnabled && settings.projectDir
        ? ` run_command runs shell commands in a DIFFERENT working directory — "${settings.projectDir}" — which may be a completely separate folder on disk. So to read or change files under "${settings.projectDir}" (or anywhere else), you MUST use run_command (dir/ls, type/cat, git, npm, …) or pass an explicit cwd; the file tools will NOT reach it. When asked whether you can access a given path: the file tools reach only ${_names}; run_command reaches "${settings.projectDir}" and any cwd/path you pass.`
        : ` run_command is off, so nothing outside ${_names} is reachable — say exactly that if asked about another path.`) +
      ` NEVER assume a connected folder is "the project/repo" or that it equals some other path the user names — the connected folder name(s) are literally ${_names}; if you don't know what a folder contains, list_files it before answering.`;

    // PROJECT CONTEXT auto-load: read a conventions file from the folder root so
    // the agent follows the repo's rules (like Claude Code reading CLAUDE.md).
    // Best-effort, capped; silently skipped if none present or the panel is closed.
    try {
      for (const cf of ["AGENTS.md", "CLAUDE.md", ".cursorrules", "CONTRIBUTING.md"]) {
        const r = await chrome.runtime.sendMessage({ type: "fs_op", op: "read_file", args: { path: cf, max_chars: 4000 } }).catch(() => null);
        if (r && r.content && String(r.content).trim()) {
          systemPrompt += `\n\nPROJECT CONVENTIONS (from ${fsInfo.root}/${cf} — follow these while working in this folder):\n${String(r.content).slice(0, 4000)}`;
          post({ type: "tool", name: "project_context", args: { file: cf } });
          post({ type: "tool_result", name: "project_context", result: { ok: true, file: cf, chars: Math.min(4000, String(r.content).length) } });
          break; // first one wins
        }
      }
    } catch {}
  }

  let domainPackText = null; // phase-engine gate roles get the SAME domain reference (run #16: reviewers confabulated GlideElement semantics from memory)
  if (settings.snPackEnabled && needsServiceNowPack(taskText, tabUrl)) {
    // Guarded: buildServiceNowPack already falls back to the bundled constant on a
    // dead server, but an unexpected throw must never abort the run — just skip the
    // pack and tell the user it was skipped (visible in the tool log).
    try {
      // taskText drives artifact-type detection so the matched sn-api-packs/*.md
      // reference (same files local-llm-masters injects) rides along with the rules.
      const pack = await buildServiceNowPack(settings, taskText);
      systemPrompt += "\n" + pack;
      domainPackText = pack;
      post({ type: "tool", name: "sn_knowledge_pack", args: { injected: true } });
      post({ type: "tool_result", name: "sn_knowledge_pack", result: { ok: true, source: packSource(), reason: isServiceNowUrl(tabUrl) ? "ServiceNow tab" : "ServiceNow keywords in task" } });
    } catch (e) {
      logErr("ServiceNow pack injection skipped", e);
      post({ type: "tool_result", name: "sn_knowledge_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }

  // Legacy (Classic) Workflow pack — a domain OVERLAY on top of the SN pack (like
  // scalping is to trading): wf_* table authoring, workflow_ide.do editor recipes,
  // checkout→validate→publish lifecycle. Bundled text only; never aborts the run.
  if (settings.wfPackEnabled && needsWfPack(taskText, tabUrl)) {
    try {
      systemPrompt += "\n\n" + LEGACY_WORKFLOW_PACK;
      if (domainPackText != null) domainPackText += "\n\n" + LEGACY_WORKFLOW_PACK; // phase-engine gate roles see it too
      post({ type: "tool", name: "legacy_workflow_pack", args: { injected: true } });
      post({ type: "tool_result", name: "legacy_workflow_pack", result: { ok: true, source: wfPackSource(), reason: /workflow_ide/i.test(String(tabUrl || "")) ? "Workflow IDE tab" : "classic-workflow keywords in task" } });
    } catch (e) {
      logErr("Legacy workflow pack injection skipped", e);
      post({ type: "tool_result", name: "legacy_workflow_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }

  // Workflow Studio pack — the MODERN-builder sibling of the legacy pack (flows,
  // subflows, actions, triggers, playbooks, decision tables; sys_hub_*/sys_pd_*/
  // sys_decision*). Studio SPA recipes + honest REST-safe vs UI-only line. Both
  // workflow packs may co-inject only on explicit cross-product (migration) tasks.
  if (settings.wfsPackEnabled && needsWfsPack(taskText, tabUrl)) {
    try {
      systemPrompt += "\n\n" + WORKFLOW_STUDIO_PACK;
      if (domainPackText != null) domainPackText += "\n\n" + WORKFLOW_STUDIO_PACK; // phase-engine gate roles see it too
      post({ type: "tool", name: "workflow_studio_pack", args: { injected: true } });
      post({ type: "tool_result", name: "workflow_studio_pack", result: { ok: true, source: wfsPackSource(), reason: /\/now\/workflow-studio/i.test(String(tabUrl || "")) ? "Workflow Studio tab" : "modern-builder keywords in task" } });
    } catch (e) {
      logErr("Workflow Studio pack injection skipped", e);
      post({ type: "tool_result", name: "workflow_studio_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }

  // Method packs (keyword-gated, mutually exclusive — most specific first):
  // the three ServiceNow method packs outrank the generic ones on SN-shaped
  // tasks (code review is the most distinct shape; incident-resolution wins
  // over SN-RCA when the task explicitly asks to resolve/fix an incident,
  // because its method embeds the diagnosis; RCA still wins over RESEARCH on
  // ambiguity). Small (~1-2KB each) and injected only when the task shape
  // matches, per the fable-pack lesson (always-on packs overloaded smaller
  // local models). They stack ON TOP of the SN knowledge pack above (domain
  // facts vs. method discipline).
  // Post-deployment validation OUTRANKS the code-review pack: "verify the
  // deployed update set" is a deployment check whose method (manifest → commit
  // state → preview problems → live-record parity → smoke test) is nothing like a
  // code review's, and its production track carries a code-enforced read-only
  // pin the review pack has no notion of.
  let snPostDeployProdHost = null;
  if (needsSnPostDeployPack(taskText, tabUrl)) {
    systemPrompt += "\n\n" + SN_POSTDEPLOY_PACK;
    // Track B: a PRODUCTION target pins the whole run read-only on that host in
    // code (snInstanceReadOnly, below). The pack's "strictly read-only in
    // production" rule must not depend on the model choosing to obey it.
    snPostDeployProdHost = postDeployProdTarget(taskText);
    post({ type: "tool", name: "servicenow_postdeployment_pack", args: { injected: true } });
    post({ type: "tool_result", name: "servicenow_postdeployment_pack", result: { ok: true, mode: "sn-post-deployment", track: snPostDeployProdHost ? "B — PRODUCTION target (read-only, enforced in code)" : "A — non-production target (validate + smoke test)", production_target: snPostDeployProdHost, method: "update-set manifest → commit state → preview problems → live-record parity → config + broken references → smoke test (non-prod only) → issues + GO/NO-GO → click-by-click" } });
  } else if (needsKbArticlePack(taskText, tabUrl)) {
    // Knowledge-worker packs (go-to-market brief 2026-09-04). Explicit article /
    // SOP / contract / RFP / meeting shapes are more specific than review or
    // incident phrasing, so they sit ahead of the ServiceNow method packs; the
    // gate regexes require their own nouns, so "review this Business Rule" still
    // reaches the code-review pack (knowledge-packs.test.mjs pins the precedence).
    systemPrompt += "\n\n" + KB_ARTICLE_PACK;
    post({ type: "tool", name: "kb_article_pack", args: { injected: true } });
    post({ type: "tool_result", name: "kb_article_pack", result: { ok: true, mode: "kb-article-sop-writer", method: "source record/screens → scrub → structured draft → kb_knowledge (draft, approval-gated) or document" } });
  } else if (needsContractReviewPack(taskText)) {
    systemPrompt += "\n\n" + CONTRACT_REVIEW_PACK;
    post({ type: "tool", name: "contract_review_pack", args: { injected: true } });
    post({ type: "tool_result", name: "contract_review_pack", result: { ok: true, mode: "contract-playbook-review", method: "read whole contract → playbook or default checklist → clause table with citations → redlines → memo (read-only)" } });
  } else if (needsRfpPack(taskText)) {
    systemPrompt += "\n\n" + RFP_PACK;
    post({ type: "tool", name: "rfp_response_pack", args: { injected: true } });
    post({ type: "tool_result", name: "rfp_response_pack", result: { ok: true, mode: "rfp-response", method: "shred → requirements matrix → library evidence (fan-out ≤4) → cited answers → gap list → response document" } });
  } else if (needsMeetingFollowupPack(taskText, tabUrl)) {
    systemPrompt += "\n\n" + MEETING_FOLLOWUP_PACK;
    post({ type: "tool", name: "meeting_followup_pack", args: { injected: true } });
    post({ type: "tool_result", name: "meeting_followup_pack", result: { ok: true, mode: "meeting-follow-up", method: "read whole transcript → decisions/actions with quotes → draft follow-up (send gated by exact phrase)" } });
  } else if (needsSnCodeReviewPack(taskText, tabUrl)) {
    systemPrompt += "\n\n" + SN_CODEREVIEW_PACK;
    post({ type: "tool", name: "servicenow_codereview_pack", args: { injected: true } });
    post({ type: "tool_result", name: "servicenow_codereview_pack", result: { ok: true, mode: "sn-code-review", method: "fetch real code → context sweep → checklist → severity findings → GO/NO-GO" } });
  } else if (needsSnIncidentResolutionPack(taskText, tabUrl)) {
    systemPrompt += "\n\n" + SN_INCIDENT_RESOLUTION_PACK;
    post({ type: "tool", name: "servicenow_incident_resolution_pack", args: { injected: true } });
    post({ type: "tool_result", name: "servicenow_incident_resolution_pack", result: { ok: true, mode: "sn-incident-resolution", method: "pull record → prior art → diagnose → remediate (approval-gated) → verify → resolution notes" } });
  } else if (needsSnRcaPack(taskText, tabUrl)) {
    systemPrompt += "\n\n" + SN_RCA_PACK;
    post({ type: "tool", name: "servicenow_root_cause_analysis_pack", args: { injected: true } });
    post({ type: "tool_result", name: "servicenow_root_cause_analysis_pack", result: { ok: true, mode: "sn-root-cause-analysis", evidence_tools: ["sn_recent_changes", "sn_query_table(syslog)", "sn_query_session(sys_script ordering)", "sn_search_script_body", "read_console", "read_network"] } });
  } else if (needsRcaPack(taskText)) {
    systemPrompt += "\n\n" + RCA_PACK;
    post({ type: "tool", name: "rca_pack", args: { injected: true } });
    post({ type: "tool_result", name: "rca_pack", result: { ok: true, mode: "root-cause-analysis", evidence_tools: ["read_console", "read_network", "sn_recent_changes", "sn_query_table(syslog)"] } });
  } else if (needsResearchPack(taskText)) {
    systemPrompt += "\n\n" + RESEARCH_PACK;
    post({ type: "tool", name: "research_pack", args: { injected: true } });
    post({ type: "tool_result", name: "research_pack", result: { ok: true, mode: "deep-research", method: "decompose → parallel gather → verify → cite" } });
  }

  // INSTANCE READ-ONLY ACCESS (standing owner grant 2026-08-20): fact-finding /
  // story-requirements-verification / research tasks get pre-approved read-only
  // access to the instances in SN_RESEARCH_INSTANCES (currently customer-dev). Fires
  // when the task shape matches AND the task text or active tab points at a
  // granted instance. Announced as a pack so the user SEES the grant is active;
  // the write-tool refusal itself is enforced in agentLoop (snInstanceReadOnly
  // guard) and survives resume + sub-agents.
  const _researchInstance = SN_RESEARCH_INSTANCES.find((h) =>
    String(taskText || "").toLowerCase().includes(h) ||
    String(tabUrl || "").toLowerCase().startsWith("https://" + h)) || null;
  const _researchGrant = (_researchInstance && SN_RESEARCH_TASK_RE.test(String(taskText || ""))) ? _researchInstance : null;
  // Two independent sources of an instance read-only pin. The production
  // post-deployment pin wins when both fire: it is the stricter reason, and the
  // host it names is the one that must not be written to.
  const snInstanceReadOnly = snPostDeployProdHost || _researchGrant;
  if (snPostDeployProdHost) {
    systemPrompt += `\n\nPRODUCTION TARGET — READ-ONLY, ENFORCED IN CODE: this post-deployment validation targets https://${snPostDeployProdHost}, a PRODUCTION instance, so you are on TRACK B: verify by QUERY and READ ONLY. The instance-write tools (save_record, sn_set_field, sn_update_record, sn_create_record, set_editor_value) and non-GET http_request to that host are DISABLED for this run and will be refused — do not attempt them and do not look for a way around them. Do not click Save / Update / Submit / Delete on any form there, do not run background or fix scripts, do not impersonate anyone, and do NOT smoke-test in production: write the test up for the business to run instead. Reading, querying, navigating, screenshotting, and saving your report to the connected local folder are all allowed and expected.`;
    post({ type: "tool", name: "sn_production_readonly", args: { injected: true } });
    post({ type: "tool_result", name: "sn_production_readonly", result: { ok: true, instance: snPostDeployProdHost, mode: "read-only", reason: "post-deployment validation against a PRODUCTION target (Track B)" } });
  }
  if (_researchGrant) {
    systemPrompt += `\n\nINSTANCE ACCESS — READ-ONLY (standing grant): you HAVE pre-approved access to https://${_researchGrant} for this fact-finding/verification/research task — navigate there and query it freely without asking permission (sn_query_session is the preferred lookup; navigate/read_page for forms and lists). The instance is READ-ONLY for this run: the write tools (save_record, sn_set_field, sn_update_record, sn_create_record, set_editor_value) are DISABLED in code and will be refused — do not attempt them, and never "helpfully" fix what you find; put it in your report instead. Filling a list filter or search box to READ data is fine; changing record data is not. Saving your findings/report to the connected local folder is allowed and expected.`;
    post({ type: "tool", name: "sn_readonly_access", args: { injected: true } });
    post({ type: "tool_result", name: "sn_readonly_access", result: { ok: true, instance: _researchGrant, mode: "read-only", reason: "fact-finding / requirements-verification / research task (standing owner grant 2026-08-20)" } });
  }

  // Policy-excluded SN instance: say so UP FRONT every turn. The call-time sn_* error
  // alone doesn't persist across turns — the model re-tried excluded tools at the start
  // of each new user message (2026-07-09 session: 5 wasted calls). One line here ends that.
  // (2026-08-02 INC0012345 run: the old blanket "do NOT call any sn_* tool" line
  // also banned the SESSION-based tools — sn_query_session / sn_check_duplicate /
  // sn_set_field — which run through the logged-in tab's g_ck token and need NO
  // credentials, so they work fine on excluded instances. The agent obeyed the
  // ban and fell back to navigate + read_page list-scraping for every lookup,
  // burning ~6 calls per record. Ban only the REST-credential tools.)
  if (isSnExcludedUrl(tabUrl)) {
    systemPrompt += "\nPOLICY: the current instance is EXCLUDED from the REST-credential ServiceNow tools — no API credentials exist for it, so sn_query_table / sn_query_record / sn_query_schema / sn_fetch_script_by_name / sn_fetch_script_by_sysid / sn_search_script_body / sn_recent_changes / sn_compare_record / sn_update_record / sn_create_record ALL fail here. Do NOT call those this conversation — even if the task text names one (e.g. 'use sn_query_table'): use the session equivalent below and say in your note that REST is policy-excluded on this instance. The SESSION tools still work — they go through the logged-in tab, not REST credentials: sn_query_session (structured record lookup — the PREFERRED replacement for sn_query_table here), sn_check_duplicate, sn_set_field, save_record, open_form_section. For record lookups, sn_query_session in ONE call beats navigate + read_page list-scraping every time; use the page tools (navigate / read_page / query_elements / capture_screenshot / list_editors) for forms and everything else.";
  }

  // "Act like Fable 5.1" behavior pack — universal operating discipline, injected
  // on every task when enabled (no domain gate, unlike the ServiceNow pack).
  if (settings.fablePackEnabled) {
    try {
      const pack = await buildFablePack(settings);
      systemPrompt += "\n\n" + pack;
      post({ type: "tool", name: "fable_behavior_pack", args: { injected: true } });
      post({ type: "tool_result", name: "fable_behavior_pack", result: { ok: true, source: fablePackSource() } });
    } catch (e) {
      logErr("Fable pack injection skipped", e);
      post({ type: "tool_result", name: "fable_behavior_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }

  // Unslop writing-quality pack — ALWAYS-ON by owner directive (2026-08-19):
  // auto-injected on every run so all final prose gets the AI-tell edit pass.
  // Style overlay only (constrains how the final text reads, not what the agent
  // does), so it stacks with every domain/method pack above. Default ON;
  // unslopPackEnabled:false in settings is the only off switch.
  if (settings.unslopPackEnabled !== false) {
    systemPrompt += "\n\n" + UNSLOP_PACK;
    post({ type: "tool", name: "unslop_pack", args: { injected: true } });
    post({ type: "tool_result", name: "unslop_pack", result: { ok: true, source: unslopPackSource(), mode: "writing-quality", reason: "always-on (owner directive 2026-08-19)" } });
  }

  // "Implementation phases" pipeline pack — ports the AgenticWorkflow multi-model
  // gate discipline (plan → execute → verify → synthesize → review → reverify →
  // repair → clarify → done) into a single-agent self-discipline the agent
  // narrates as it works. Universal (no domain gate), like the Fable pack.
  // T14 (phase-engine plan): when the CODE-enforced phase engine is on, the
  // prompt-only pack is superseded and NOT injected — narrated phases would
  // fight the real gates.
  if (settings.implementationPhasesEnabled && !settings.phaseEngineEnabled) {
    try {
      const pack = await buildImplementationPhasesPack(settings);
      systemPrompt += "\n\n" + pack;
      post({ type: "tool", name: "implementation_phases_pack", args: { injected: true } });
      post({ type: "tool_result", name: "implementation_phases_pack", result: { ok: true, source: implementationPhasesPackSource() } });
    } catch (e) {
      logErr("Implementation phases pack injection skipped", e);
      post({ type: "tool_result", name: "implementation_phases_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }
  // PAPER day-trading agent pack — URL-gated to the Day Trading page (unlike the
  // universal Fable pack). Phase 1: read/analyze/journal ONLY; the pack itself
  // hard-forbids placing orders. Also surfaces the resolved provider/model here
  // so the (eventually autonomous) trading path visibly confirms it is NOT
  // silently running on local Ollama.
  // DOMAIN PRECEDENCE: a REAL-MONEY M1 run WINS over the day-trading pack. Compute M1
  // state FIRST. m1Context is ACTIVE-TAB based (needsM1Pack(tabUrl)) — NOT triggered by
  // a merely-open M1 tab or a generic phrase like "what's working", which previously
  // caused BOTH the trading-pack co-injection on M1 runs AND a reverse desync that
  // force-locked legitimate trading runs to read-only. Enforcement (m1ReadOnly) stays
  // origin-wide via isM1DashboardUrl below; this only governs PACK INJECTION.
  // SAFE-BY-DEFAULT: read-only ENFORCEMENT on the real-money M1 brokerage is
  // TOGGLE-INDEPENDENT — the instant the active tab is on dashboard.m1.com, the run is
  // locked read-only even if the user never enabled the M1 pack. (A forgotten toggle
  // previously left the account fully exposed: the trading pack injected from a merely-
  // open day-trading tab and click_element succeeded on a live brokerage. Master-mind
  // NO-GO.) The insight-pack BODY stays OPT-IN (m1PackEnabled) for privacy; only the
  // mechanical guard is always-on.
  const isM1Origin = isM1DashboardUrl(tabUrl);                               // toggle-INDEPENDENT (enforcement)
  const m1Context = !!(settings.m1PackEnabled && needsM1Pack(tabUrl));       // active M1 portfolio tab (BODY injection)
  const m1LocksRun = !!(settings.m1PackEnabled && (isM1Origin || m1Context)); // BODY injection (opt-in)

  // Trading pack — enabled AND trading-related AND NOT an M1 run (mutual exclusion).
  // Trigger on: active tab is day-trading, OR the task text is trading-related, OR any
  // OPEN tab is the day-trading page (a slim "run a cycle" trigger from another tab).
  // REAL-MONEY page precedence (2026-09-11): when the ACTIVE tab is live-trading.html the PAPER pack is
  // never injected (its any-open-tab / task-text triggers would otherwise put paper rules on a live form).
  const liveTradingActive = needsLiveTradingPack(tabUrl);
  let tradingContext = false;
  if (settings.tradingPackEnabled && !m1LocksRun && !isM1Origin && !liveTradingActive) { // never run the trading pack on the real-money M1 origin (toggle-independent) or on the live-trading page
    tradingContext = needsTradingPack(tabUrl);
    if (!tradingContext) {
      if (/\b(day[- ]?trad|trading pack|manual order|place (a |an )?(manual )?order|decision cycle)\b/i.test(taskText)) {
        tradingContext = true;
      } else {
        try {
          const allTabs = await chrome.tabs.query({});
          if (allTabs.some((t) => needsTradingPack(t.url))) tradingContext = true;
        } catch { /* tabs query unavailable — fall back to active-tab gate */ }
      }
    }
  }
  let tradingPackInjected = false;
  if (settings.tradingPackEnabled && tradingContext) {
    try {
      const pack = await buildTradingPack(settings);
      systemPrompt += "\n\n" + pack;
      tradingPackInjected = true;
      const prov = activeProvider(settings);
      post({ type: "tool", name: "trading_agent_pack", args: { injected: true } });
      post({ type: "tool_result", name: "trading_agent_pack", result: {
        ok: true,
        source: tradingPackSource(),
        mode: tradingModeLabel(settings),
        provider: prov,
        model: prov === "ollama" ? settings.model : (settings.cloudModel || "(provider default)")
      } });
    } catch (e) {
      logErr("Trading pack injection skipped", e);
      post({ type: "tool_result", name: "trading_agent_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }
  // Scalping OVERLAY (opt-in) — only rides on a successfully injected trading pack
  // (never standalone), appended AFTER it so the base pack's mode/floor/gate blocks
  // read first and the overlay's precedence header points back up at them.
  if (tradingPackInjected && settings.scalpingPackEnabled) {
    try {
      const pack = await buildScalpingPack(settings);
      systemPrompt += "\n\n" + pack;
      post({ type: "tool", name: "scalping_overlay_pack", args: { injected: true } });
      post({ type: "tool_result", name: "scalping_overlay_pack", result: { ok: true, source: scalpingPackSource(), mode: tradingModeLabel(settings) } });
    } catch (e) {
      logErr("Scalping overlay injection skipped", e);
      post({ type: "tool_result", name: "scalping_overlay_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }
  // REAL-MONEY live-trading pack (2026-09-11) — ACTIVE-TAB gate ONLY (no task-text / open-tab
  // trigger: real money needs the live page in front), opt-in toggle, never on an M1 run, and
  // mutually exclusive with the paper pack above (liveTradingActive suppresses it).
  let liveTradingPackInjected = false;
  // REAL-MONEY section is ADMIN TIER ONLY (owner directive 2026-09-12): re-checked HERE at injection time, not only in Options.
  let liveAdminOk = false;
  if (settings.liveTradingPackEnabled && liveTradingActive) {
    try { const { llmgo_auth: a } = await chrome.storage.local.get("llmgo_auth"); liveAdminOk = !!(a && a.idToken && a.tier === "admin"); } catch { liveAdminOk = false; }
    if (!liveAdminOk) post({ type: "tool_result", name: "live_trading_agent_pack", result: { ok: false, skipped: true, error: "REAL-MONEY pack is admin-tier only — sign in with an admin account." } });
  }
  if (settings.liveTradingPackEnabled && liveTradingActive && liveAdminOk && !m1LocksRun && !isM1Origin) {
    try {
      const pack = await buildLiveTradingPack(settings);
      systemPrompt += "\n\n" + pack;
      liveTradingPackInjected = true;
      const prov = activeProvider(settings);
      post({ type: "tool", name: "live_trading_agent_pack", args: { injected: true, realMoney: true } });
      post({ type: "tool_result", name: "live_trading_agent_pack", result: {
        ok: true,
        realMoney: true,
        source: liveTradingPackSource(),
        mode: liveTradingModeLabel(settings),
        provider: prov,
        model: prov === "ollama" ? settings.model : (settings.cloudModel || "(provider default)")
      } });
    } catch (e) {
      logErr("Live trading pack injection skipped", e);
      post({ type: "tool_result", name: "live_trading_agent_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }
  if (liveTradingPackInjected && settings.liveScalpingPackEnabled) {
    try {
      const pack = await buildLiveScalpingPack(settings);
      systemPrompt += "\n\n" + pack;
      post({ type: "tool", name: "live_scalping_overlay_pack", args: { injected: true, realMoney: true } });
      post({ type: "tool_result", name: "live_scalping_overlay_pack", result: { ok: true, realMoney: true, source: liveScalpingPackSource(), mode: liveTradingModeLabel(settings) } });
    } catch (e) {
      logErr("Live scalping overlay injection skipped", e);
      post({ type: "tool_result", name: "live_scalping_overlay_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }
  // M1 Finance portfolio explorer pack — injected on the WHOLE dashboard.m1.com origin
  // (m1LocksRun), not just /portfolio, so the agent has the insight workflow on /d/home
  // and the concentration pages too (enforcement was already origin-wide; injection now
  // matches). needsM1Pack/m1Context stays narrow — it governs trading-pack mutual
  // exclusion, not injection. This is a REAL-MONEY 401(k): the run is pinned to a FORCED
  // read-only tool allowlist (read tools + allowlisted navigate) below, so trading is
  // mechanically impossible. The SAFETY_BLOCK is code-prepended even on /login (benign:
  // the AUTH rule says STOP and no write/auth tool exists).
  if (settings.m1PackEnabled && m1LocksRun) {
    try {
      const pack = await buildM1Pack(settings);
      systemPrompt += "\n\n" + pack;
      const prov = activeProvider(settings);
      post({ type: "tool", name: "m1_exploration_pack", args: { injected: true } });
      post({ type: "tool_result", name: "m1_exploration_pack", result: {
        ok: true,
        source: m1PackSource(),
        mode: "FORCED READ-ONLY — portfolio insight only (no trades, edits, transfers, or login)",
        provider: prov,
        privacy: prov === "ollama"
          ? "local model — account data stays on this machine"
          : "CLOUD model selected — page content/screenshots egress to the provider; prefer a local model for a real-money account",
        reason: needsM1Pack(tabUrl) ? "active M1 portfolio tab" : "M1 task + open M1 portfolio tab"
      } });
    } catch (e) {
      logErr("M1 pack injection skipped", e);
      post({ type: "tool_result", name: "m1_exploration_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }

  // Inbox triage + reply DRAFTER pack — URL-gated to Gmail / Outlook on the web
  // + opt-in. Read, sort, draft into the reply composer; never send, archive,
  // delete or label. The exact "APPROVED — SEND IT" phrase is the only send path,
  // and the send_email / send_sms tools are blocked in code for this run unless
  // the latest user message carries that phrase (ctx.inboxDrafter, per-call loop).
  let inboxDrafter = false; // set below when the pack is in the prompt; agentLoop reads ctx.inboxDrafter (send gate)
  if (settings.inboxPackEnabled && needsInboxPack(tabUrl)) {
    try {
      systemPrompt += "\n\n" + INBOX_PACK;
      inboxDrafter = true;
      const prov = activeProvider(settings);
      post({ type: "tool", name: "inbox_drafter_pack", args: { injected: true } });
      post({ type: "tool_result", name: "inbox_drafter_pack", result: {
        ok: true,
        source: inboxPackSource(),
        mode: "READ-ONLY mailbox — triage + drafts into the reply composer; NEVER sends without exact 'APPROVED — SEND IT' phrase (send_email/send_sms blocked in code)",
        provider: prov,
        privacy: prov === "ollama"
          ? "local model — email content stays on this machine"
          : "CLOUD model selected — email content egresses to the provider; prefer a local model for private mail",
        reason: "active Gmail / Outlook tab"
      } });
    } catch (e) {
      logErr("Inbox pack injection skipped", e);
      post({ type: "tool_result", name: "inbox_drafter_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }

  // Teams READ-ONLY auto-reply drafter pack — URL-gated to a Microsoft Teams tab
  // (teams.cloud.microsoft / teams.microsoft.com) + opt-in. The agent reads the 5
  // most recent messages in the currently open conversation and DRAFTS a reply into
  // the compose box, but the pack hard-forbids posting/sending without the user's
  // exact "APPROVED — SEND IT" phrase. Safety lines are in the pack body verbatim.
  if (settings.teamsPackEnabled && needsTeamsPack(tabUrl)) {
    try {
      systemPrompt += "\n\n" + TEAMS_PACK;
      const prov = activeProvider(settings);
      post({ type: "tool", name: "teams_auto_reply_pack", args: { injected: true } });
      post({ type: "tool_result", name: "teams_auto_reply_pack", result: {
        ok: true,
        source: teamsPackSource(),
        mode: "READ-ONLY drafter — drafts into compose box; NEVER sends without exact 'APPROVED — SEND IT' phrase",
        provider: prov,
        privacy: prov === "ollama"
          ? "local model — Teams message content stays on this machine"
          : "CLOUD model selected — Teams message content/screenshots egress to the provider; prefer a local model for private messages",
        reason: "active Microsoft Teams tab"
      } });
    } catch (e) {
      logErr("Teams pack injection skipped", e);
      post({ type: "tool_result", name: "teams_auto_reply_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }

  // Slack READ-ONLY reply drafter pack — URL-gated to a Slack workspace tab
  // (app.slack.com / slack.com) + opt-in. The agent reads channel messages and
  // drafts replies into the composer, but the pack hard-forbids sending (never
  // click Send, never call a send_* tool, never press Enter in the composer).
  if (settings.slackPackEnabled && needsSlackPack(tabUrl)) {
    try {
      systemPrompt += "\n\n" + SLACK_PACK;
      const prov = activeProvider(settings);
      post({ type: "tool", name: "slack_auto_reply_pack", args: { injected: true } });
      post({ type: "tool_result", name: "slack_auto_reply_pack", result: {
        ok: true,
        source: slackPackSource(),
        mode: "READ-ONLY drafter — types into composer; NEVER sends (no Send click, no send_* tool, no Enter)",
        provider: prov,
        privacy: prov === "ollama"
          ? "local model — Slack message content stays on this machine"
          : "CLOUD model selected — Slack message content/screenshots egress to the provider; prefer a local model for private messages",
        reason: "active Slack workspace tab"
      } });
    } catch (e) {
      logErr("Slack pack injection skipped", e);
      post({ type: "tool_result", name: "slack_auto_reply_pack", result: { ok: false, skipped: true, error: String(e.message || e) } });
    }
  }
  // Auto web-search (default ON; toggle in Options). Make web_search the reflex
  // for external/world QUESTIONS — but explicitly NOT for page actions like
  // filling a form, so a "fill this in" request never triggers a search.
  if (settings.autoWebSearch) {
    systemPrompt +=
      "\n\nAUTO WEB-SEARCH IS ON. When the user asks a QUESTION whose answer is NOT on the current page — external facts, trends, \"what is/are\", current events, products, companies, prices, statistics, comparisons — your FIRST action is a search, automatically (the user need not say \"search\"). PREFER google_search — Google's results are richer and less rate-limited than web_search (DuckDuckGo), and its AI Overview often answers a current-fact question directly; use web_search only as a secondary. " +
      "This applies ONLY to information-seeking questions. It does NOT apply to ACTIONS or page work: filling in or saving a form, clicking, creating/updating a record, sending a message, reading or summarizing the CURRENT page, editing code — do those DIRECTLY with your page tools and do NOT web_search for them. When the task is to ACT on the page, act; do not search.";
  }

  const steps = []; // trajectory record for feedback/training

  const messages = [{ role: "system", content: systemPrompt }, ...history];

  if (Array.isArray(attachments) && attachments.length) {
    const lastUser = messages[messages.length - 1];
    for (let i = 0; i < attachments.length; i++) {
      if (signal.aborted) { post({ type: "aborted" }); return; }
      const att = attachments[i];
      if (!att || !att.base64) continue;
      const label = att.name || `image ${i + 1}`;
      post({ type: "tool", name: "analyze_image", args: { name: label, image: `${i + 1}/${attachments.length}` } });
      const result = await describeImage({
        base64: att.base64,
        focus: lastUser?.content || "",
        settings,
        signal
      });
      post({ type: "tool_result", name: "analyze_image", result });
      if (result.description && lastUser) {
        lastUser.content =
          (lastUser.content || "") +
          `\n\n[Attached image ${i + 1}/${attachments.length} "${label}" — analysis by ${result.vision_model}]:\n${result.description}`;
      }
    }
  }

  // PLAN-FIRST: one planning turn with NO tools — the model drafts a numbered
  // plan and stops, the UI shows it for approval, and nothing is executed yet.
  if (opts.planFirst) {
    // TOOL VISIBILITY DURING PLANNING (2026-09-09b; rebuilt 09c after the master-mind
    // review). The planning turn runs with tools:[] so the model can only produce text. A
    // local model reads that empty schema as a statement about its CAPABILITIES and writes
    // the conclusion into the plan: "I will not be able to actually execute this plan
    // because I don't have access to the file system tools" (export 16:47) — and on the
    // approved execute turn, where the tools ARE present, it repeats that and calls
    // nothing. So the planning prompt states the real toolset. 09c: the list is derived
    // EXACTLY as agentLoop derives the execute turn's list (mode/M1 base, then the desktop
    // and run_command opt-ins, then the instance read-only pin) so the plan can never be
    // promised a tool the execute turn strips; lapsed (needsReconnect) folders are not
    // advertised; file verbs are named only when present and the folder is writable; and
    // the prohibition is scoped to the tools actually listed (MM 09-09 F4).
    let planActMode = "auto";
    try { planActMode = (await chrome.storage.local.get("actMode")).actMode || "auto"; } catch {}
    const planM1 = !!(m1LocksRun || isM1Origin);
    let planToolDefs = planM1 ? M1_SAFE_TOOLS_NAV : (planActMode === "readonly" ? READ_ONLY_TOOLS : TOOLS);
    if (!settings.desktopControlEnabled) planToolDefs = planToolDefs.filter((t) => !DESKTOP_TOOL_NAMES.has(t.function && t.function.name));
    if (!settings.commandExecEnabled) planToolDefs = planToolDefs.filter((t) => (t.function && t.function.name) !== "run_command");
    if (!(await snToolsRelevant(taskText))) planToolDefs = withoutSnTools(planToolDefs); // 09k: same gate as the execute turn
    const planToolNames = planToolDefs.map((t) => t.function && t.function.name).filter(Boolean);
    const planHas = (n) => planToolNames.includes(n);
    const planAllRoots = fsInfo
      ? (Array.isArray(fsInfo.roots) && fsInfo.roots.length ? fsInfo.roots : [{ name: fsInfo.root, canWrite: fsInfo.canWrite }])
      : [];
    const planLiveRoots = planAllRoots.filter((r) => r && (r.name || r.root) && !r.needsReconnect);
    const planRoots = planLiveRoots.map((r) => (r.name || r.root) + " (" + (r.canWrite ? "read/write" : "read-only") + ")");
    // agentLoop's schema keeps the SN write tools on an instance-read-only run and REFUSES them
    // at dispatch; the plan says exactly that instead of silently dropping them (MM pass 2 B-7).
    const planSnRefused = snInstanceReadOnly ? planToolNames.filter((n) => SN_INSTANCE_WRITE_TOOLS.has(n)) : [];
    const planCanWrite = planLiveRoots.some((r) => r.canWrite) && planHas("write_file");
    const planFileVerbs = ["list_files", "read_file", "write_file", "edit_file", "create_folder"]
      .filter((n) => planHas(n) && (planCanWrite || n === "list_files" || n === "read_file"));
    const capabilityNote =
      "\n\nYOUR TOOLS ON THE NEXT TURN — the same list the execute turn is given: " + planToolNames.join(", ") + "." +
      (planSnRefused.length
        ? " This run is pinned READ-ONLY on the instance " + snInstanceReadOnly + ": " + planSnRefused.join(", ") + " are in the list but will be REFUSED — do not plan them."
        : "") +
      (planRoots.length && planFileVerbs.length
        ? " A local folder is CONNECTED and mounted right now: " + planRoots.join(", ") + ". " +
          planFileVerbs.join(", ") + " work on it — paths are relative to that folder."
        : "") +
      (planActMode === "readonly" && !planM1 ? " READ-ONLY mode is on: plan reading and analysis only — no page actions, no file or record writes, no navigation." : "") +
      (planM1 ? " M1 real-money pin: only the read-only M1 tools listed above." : "") +
      " Tools are withheld from THIS message only so the plan arrives as text." +
      " Do NOT write that you lack a tool that is listed above, or that a listed folder is not connected — that is false and it stops the work from happening." +
      " A tool that is NOT listed above is genuinely unavailable this run; if the request needs one, say which step it blocks. Plan the real calls by name, then stop.";
    const planMessages = messages.concat({
      role: "user",
      content:
        "PLANNING MODE: Before doing anything, write a concise numbered PLAN of the tool steps you will take to accomplish my request. Do NOT call any tools or take any action yet — output only the plan, then stop. I will approve or adjust it." +
        capabilityNote
    });
    post({ type: "assistant_start" });
    let planText = "";
    for (let attempt = 0; ; attempt++) {
      try {
        ({ content: planText } = await withModelLock(() => chatStream({
          base: settings.ollamaBase,
          model: agentModel,
          settings,                                  // selects provider (ollama/openai/gemini)
          messages: planMessages,
          tools: [], // no tools during planning, so it can only produce text
          options: fittedOllamaOptions(settings, planMessages, [], post),
          signal,
          onToken: (delta) => post({ type: "token", delta })
        })));
        break;
      } catch (e) {
        if (e.name === "AbortError" || signal.aborted) { post({ type: "aborted" }); return; }
        if (isRetryableTurnError(e.message) && attempt < 2) {
          post({ type: "assistant_retry", attempt: attempt + 1 });
          continue;
        }
        post({ type: "error", text: e.message });
        return;
      }
    }
    post({ type: "assistant_end" });
    // Strip any tool-call markup the model leaked despite tools:[], and bail if
    // the plan is empty (so the UI never shows an approve card for nothing).
    const { cleaned } = extractTextToolCalls(planText);
    const finalPlan = (cleaned || planText || "").trim();
    if (!finalPlan) {
      post({ type: "error", text: "The model returned an empty plan. Try rephrasing your request, or give it a starting URL." });
      return;
    }
    if (finalPlan !== (planText || "").trim()) post({ type: "rewrite_assistant", text: finalPlan }); // clean the shown bubble too
    post({ type: "plan", text: finalPlan, runId });
    return; // wait for the user to approve; execution is a separate run
  }

  // EXECUTE an approved plan: the plan is already in history (assistant text);
  // tell the model to carry it out fully in this run with its tools.
  if (opts.executePlan) {
    // Defensive: only execute when the latest history item is a real (non-empty)
    // assistant plan — guards against a stale/forged executePlan with bad history.
    const last = history[history.length - 1];
    if (!last || last.role !== "assistant" || !String(last.content || "").trim()) {
      post({ type: "error", text: "Cannot execute: the latest message isn't a plan. Send your request again to get a fresh plan." });
      return;
    }
    messages.push({
      role: "user",
      content:
        "I APPROVED the plan above. Execute it now using your browser tools. Follow the plan (adapt only as needed), complete ALL of it in this run, and write a short final summary when done."
    });
  }

  // Read-only mode (a 4th act mode): strip every write/action tool so a "review
  // only / never modify" task is physically enforced, not just requested.
  let readOnly = false;
  try { readOnly = (await chrome.storage.local.get("actMode")).actMode === "readonly"; } catch {}
  // M1 real-money pin: when the pack is enabled, FORCE read-only across the ENTIRE
  // dashboard.m1.com origin (NOT just the narrow /portfolio injection gate) OR when
  // the portfolio pack context is active. This closes BLOCKER 3 — non-portfolio M1
  // pages (/login, /transfer, /activity) and a fail-open gate-miss would otherwise
  // leave full action tools live on a real-money brokerage page. Pinning forces the
  // fail-closed M1 allowlist + runtime guard regardless of the user's act mode.
  // Enforcement = injection-lock OR raw M1 origin (toggle-independent). This is the
  // line that makes a forgotten M1 toggle safe: on any dashboard.m1.com tab the run is
  // read-only even with m1PackEnabled=false.
  const m1ReadOnly = m1LocksRun || isM1Origin;
  if (m1ReadOnly) readOnly = true;
  // 09j: the tools are stripped in read-only mode but the model was never TOLD, so it
  // answered an action request with a plan of tool calls it could not make (v2 take 3)
  // or a paragraph of alternatives (take 2). One line in the system message fixes both.
  if (readOnly && !m1ReadOnly && messages[0] && messages[0].role === "system") {
    messages[0] = { ...messages[0], content: messages[0].content + READ_ONLY_MODE_NOTE };
  }
  // NOTE: the num_ctx FLOOR that prevents the local "stuck forever" overflow hang lives
  // in agentLoop() (not here), so it applies to BOTH a fresh run AND a resumed run after
  // MV3 worker eviction — a resumed M1 run would otherwise revert to the stale saved
  // num_ctx and re-hang. See the floor block at the top of agentLoop.

  // Hand off to the shared loop (also used by resumeAgent). Everything the loop
  // needs to checkpoint and resume is passed explicitly so the same code path
  // serves both a fresh run and a resumed one.
  const loopCtx = {
    messages, steps, settings, agentModel,
    post, signal, askApproval,
    runId, taskText, lessons,
    startStep: 0, startNudged: false,
    allowSubagents: !m1ReadOnly, // top-level run may delegate; NEVER on a real-money M1 run (symmetry with resume)
    drainSteer: opts.drainSteer, // Claude-Code-style mid-run steering ("/btw")
    tools: m1ReadOnly ? M1_SAFE_TOOLS_NAV : (readOnly ? READ_ONLY_TOOLS : undefined), // M1 → fail-closed allowlist (read tools + allowlisted navigate); read-only → no write tools
    readOnly,
    snInstanceReadOnly, // instance-scoped read-only pin (fact-finding/verification/research standing grant) — host string or null
    m1ReadOnly, // pins the stricter M1 allowlist guard in agentLoop
    inboxDrafter, // inbox pack in the prompt: send_email/send_sms blocked unless the latest user message carries the exact approval phrase
    tradingPackInjected, // precise num_ctx-floor gate: pack ACTUALLY in the prompt, not just the global toggle
    liveTradingPackInjected, // REAL-MONEY pack in the prompt (2026-09-11): same trading-run gates (num_ctx floor, step cap, screenshot/read/pre-validate guards)
    fsInfo, // connected-folder ground truth, so sub-agents inherit it (see runChild)
    domainPack: domainPackText, // gate roles judge platform-behavior claims against THIS, not memory (run #16)
    executePlan: !!opts.executePlan, // an approved-plan run that makes ZERO tool calls did not execute (2026-09-09)
    // The last assistant answer, so the echo guard can catch a turn that just replays it.
    prevAssistantText: (() => {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i] && history[i].role === "assistant" && String(history[i].content || "").trim()) {
          return String(history[i].content);
        }
      }
      return "";
    })()
  };

  // Phase engine (IMPROVEMENTS_PHASE_ENGINE.md; MM 6a581885): CODE-enforced
  // gates around the loop. The loop runs as EXECUTE in embedded mode and the
  // engine owns the final emission — an unreviewed draft never posts as final
  // (T2). Toggle off → the exact pre-existing path below (T1).
  if (settings.phaseEngineEnabled && !isTrivialForPhaseEngine(taskText)) {
    // EXECUTE must cite evidence: teach the citation-token grammar the
    // deterministic invariant validates (§3.5.2). Evidence ids arrive as `_ev`
    // on each tool result.
    messages[0].content += "\n\nEVIDENCE CITATIONS (MANDATORY): each evidence tool result starts with `_ev` (its id, e.g. \"E3\") and `_cite` — legend lines like \"[E3.O2] = ni.sys_script.active.checked=true\". In your FINAL answer, every factual claim about UI/field/record state MUST be followed by the SHORT ID TOKEN ONLY — e.g. [E3.O2] — copied verbatim from the matching `_cite` line. Never write paths or values inside a token; never invent an id. If no `_cite` line supports a claim, do not make the claim: gather more evidence or say you could not verify it.";
    messages[0].content += CLICK_BY_CLICK_DRAFTER; // AWF parity: build/config deliverables end with a Click-by-Click Build Guide
    await withRunKeepalive(() => runPhased({ agentLoop, chatStream, withModelLock, activeProvider }, loopCtx));
    return;
  }

  await withRunKeepalive(() => agentLoop(loopCtx));
}

// MV3 KEEPALIVE (MM final-audit P0; 16z-audit P0-2 extends it to resume): a
// subscription-bridge turn blocks on a single fetch for minutes with no other
// extension activity — a periodic alarm resets the service worker's idle timer
// for the whole run. RUN-SCOPED alarm name (16z-audit P2) so overlapping
// runs don't clear each other's keepalive. Cleared in finally — never leaks.
//
// 2026-07-27: this now wraps EVERY top-level run, not just the phase-engine ones.
// A plain (phase-engine-off) run had no keepalive, so any tool that blocked for
// >30s with no intervening extension-API call got the worker evicted mid-tool.
// That is not a slow run — it is a DEAD one: eviction destroys the pending promise
// AND every setTimeout that implements our tool timeouts, so no net can fire, no
// tool_result is ever posted, and the panel simply goes quiet (live a-live-run,
// query_elements on a large ServiceNow form). The keepalive is what lets those
// in-worker timers survive long enough to turn a hang into a reportable error.
let _keepaliveSeq = 0;
async function withRunKeepalive(fn) {
  const name = KEEPALIVE_ALARM_PREFIX + (++_keepaliveSeq);
  liveKeepalives.add(name); // claim it BEFORE creating, so the cold-start sweep can never race it
  try { chrome.alarms?.create(name, { periodInMinutes: 0.5 }); } catch { /* alarms unavailable */ }
  try { return await fn(); }
  finally {
    liveKeepalives.delete(name);
    try { chrome.alarms?.clear(name); } catch { /* ignore */ }
  }
}

// The core agent loop, shared by runAgent (fresh) and resumeAgent (continued).
// It checkpoints a durable snapshot after every completed step so the run can be
// resumed after a worker eviction / panel close / browser restart. See
// run-state.js for the resume contract (clean-boundary-only, no tool replay).
async function agentLoop(ctx) {
  const { messages, steps, settings, agentModel, post, signal, askApproval, runId, taskText, lessons } = ctx;
  const isChild = !!ctx.isChild; // C.6: sub-agents must not touch the parent's durable state
  // Phase-engine EMBEDDED mode (BL-2): the loop is the EXECUTE phase inside
  // phase-engine.js. The ENGINE owns the lifecycle — no `final` emission, no
  // trajectory save, no clearRunState from in here; results return structured.
  // ctx.embedded.evidenceLedger collects code-built evidence entries (§3.5.1).
  const embedded = ctx.embedded || null;
  // Earlier runs' verified file writes, for the grounding ledger (MM pass 2 B-3).
  if (!Array.isArray(ctx.writeReceipts)) { try { ctx.writeReceipts = await loadWriteReceipts(); } catch { ctx.writeReceipts = []; } }

  // Desktop-control gate: when the opt-in toggle is OFF, strip every desktop_*
  // tool from what the model can even see (the executor also hard-refuses them —
  // defense in depth). Computed once here so it covers a fresh run, a resumed run,
  // AND sub-agents (which arrive with ctx.tools already set). M1/read-only lists
  // are unaffected: their allow/deny lists never contain the desktop action tools.
  const baseToolList = ctx.tools || TOOLS;
  let toolList = settings.desktopControlEnabled
    ? baseToolList
    : baseToolList.filter((t) => !DESKTOP_TOOL_NAMES.has(t.function && t.function.name));
  // run_command is offered ONLY when its separate opt-in is on (the executor also
  // hard-refuses it otherwise). Same defense-in-depth pattern as desktop_*.
  if (!settings.commandExecEnabled) {
    toolList = toolList.filter((t) => (t.function && t.function.name) !== "run_command");
  }
  if (ctx.liveTradingPackInjected) { // REAL-MONEY run: no OS control, no shell (MM 6aa484e7 P2)
    toolList = toolList.filter((t) => !DESKTOP_ACTION_TOOL_NAMES.has(t.function && t.function.name) && (t.function && t.function.name) !== "run_command");
  }
  // 09k: ServiceNow tool schemas only when ServiceNow is in play (decided once per run; a
  // resumed run and a sub-agent decide on their own task text + the same connection/tab facts).
  if (ctx.snToolsRelevant === undefined) ctx.snToolsRelevant = await snToolsRelevant(ctx.taskText);
  if (!ctx.snToolsRelevant) toolList = withoutSnTools(toolList);

  // CODEX CANNOT BE THE BROWSER AGENT (proven live 2026-07-16, error
  // "codex/sandbox-state-meta: missing field sandboxPolicy"): the Codex CLI is
  // an agentic coding tool that runs its OWN tools/sandbox — when handed a
  // browser task + tool schemas it tries to EXECUTE them itself (and errors),
  // instead of emitting the <tool_call> TEXT the extension executes. Unlike the
  // Claude CLI, it has no clean way to disable its native tools. It works ONLY
  // as a tool-less reviewer gate (phase-engine review/reverify, which don't go
  // through agentLoop). So fail FAST + CLEARLY here instead of a 10-min doomed
  // run. (Gate calls never reach this — they use callRole/deps.codexSub.)
  if (activeProvider(settings) === "codex-sub" && toolList && toolList.length) {
    post({ type: "error", text: "ChatGPT / Codex can't drive the browser tools — the Codex CLI runs its own sandbox and errors (\"missing field sandboxPolicy\") instead of using the extension's tools. It works only as a REVIEWER in the Phase engine, not as the agent that reads the page.\n\nFix: set the header provider to \"Claude (subscription)\" or a local Ollama model for the agent. Keep ChatGPT for the Phase engine's review gate (it's excellent there)." });
    if (embedded) return { status: "error", error: "codex-sub cannot drive browser tools", steps: [], runId };
    return { status: "error", error: "codex-sub cannot drive browser tools", steps, runId };
  }

  // num_ctx FLOOR for M1 on local Ollama (root-cause fix for the "stuck forever" hang):
  // an M1 run's system prompt + M1 pack alone exceed a stale 8192 num_ctx, so Ollama
  // silently slides the window, drops the system prompt + tool schema, and the local
  // model loops emitting prose with no tool call (no idle-stall fires; local step cap is
  // Infinity → infinite hang). Raise num_ctx FOR THIS RUN ONLY (settings is a per-run
  // object, never persisted) to a 16384 floor — the documented "good middle", under the
  // 32768 default. Placed HERE in agentLoop (not runAgent) so it ALSO applies to a
  // RESUMED run after MV3 eviction (which would otherwise revert to the stale saved
  // num_ctx and re-hang). Cloud ignores num_ctx; scoped to M1+Ollama to leave other
  // runs' VRAM behavior unchanged. (Master-mind consensus.)
  const M1_MIN_NUM_CTX = 16384;
  // Trading-pack runs carry a comparably large prompt (pack + tool schema) and hit
  // the SAME silent context-overflow hang on local Ollama — the gate was previously
  // m1ReadOnly-only, leaving 60-step trading cycles exposed (master-mind 6a491b6a).
  // Prefer the PRECISE injection flag (pack actually in the prompt). 09l checkpoints it, so
  // only a checkpoint written before 09l lacks it; that case falls back to the global-toggle
  // heuristic (fail-closed: the guard and the floor stay ON).
  const bigPackRun = ctx.m1ReadOnly || (!isChild && !!ctx.liveTradingPackInjected) ||
    (!isChild && (ctx.tradingPackInjected != null
      ? !!ctx.tradingPackInjected
      : (settings.tradingPackEnabled || settings.paperOrderSubmissionEnabled)));
  if (bigPackRun && activeProvider(settings) === "ollama" && (settings.numCtx || 0) < M1_MIN_NUM_CTX) {
    const was = settings.numCtx;
    settings.numCtx = M1_MIN_NUM_CTX;
    post({ type: "tool", name: "num_ctx_floor", args: { raised: true } });
    post({ type: "tool_result", name: "num_ctx_floor", result: {
      ok: true, from: was, to: M1_MIN_NUM_CTX,
      note: `Raised num_ctx ${was}→${M1_MIN_NUM_CTX} for this ${ctx.m1ReadOnly ? "M1" : "trading"} run so the prompt fits (prevents the context-overflow hang). Per-run only — your saved setting is unchanged. If Ollama OOMs, close other GPU apps or lower other packs.`
    } });
  }

  // Write a checkpoint at the current (clean) conversation boundary. `nextStep`
  // is the step index to resume AT, and `nudged` preserves the one-shot
  // silent-turn recovery flag across a resume. MF-2: children NEVER checkpoint —
  // they share the single "activeRun" key and would clobber the parent snapshot.
  // Embedded runs do NOT write the standalone "activeRun" snapshot — the phase
  // engine persists its own phaseRun/phaseData envelope (checkpointOwner:
  // "phase-engine", BL-2/BL-3). Children never checkpoint either (MF-2).
  const checkpoint = (isChild || embedded)
    ? async () => {}
    : (nextStep, nudged) =>
        saveRunState({
          runId, taskText, agentModel,
          messages, steps,
          lessonIds: (lessons || []).map((l) => l.id),
          step: nextStep, nudged: !!nudged,
          // Persist the safety pin so a resume after MV3 eviction can't revert a
          // real-money M1 run to prompt-only enforcement (review BLOCKER 1).
          m1ReadOnly: !!ctx.m1ReadOnly, readOnly: !!ctx.readOnly,
          snInstanceReadOnly: ctx.snInstanceReadOnly || null, // instance read-only pin survives MV3 eviction too
          // The grounding guard's inputs survive a resume too (MM pass 2 B-3): an approved
          // plan that resumes after eviction is still an execute-plan run.
          executePlan: !!ctx.executePlan,
          prevAssistantText: String(ctx.prevAssistantText || "").slice(0, 6000),
          groundNudged: !!ctx.startGroundNudged,
          // 09l (MM 6aa23373 D-1): the trading-pack injection flag survives a resume, so the
          // screenshot guard keeps its precise answer instead of the global-toggle fallback.
          // Absent in an older checkpoint stays absent (= unknown), never coerced to false.
          ...(typeof ctx.tradingPackInjected === "boolean" ? { tradingPackInjected: ctx.tradingPackInjected } : {}),
          ...(typeof ctx.liveTradingPackInjected === "boolean" ? { liveTradingPackInjected: ctx.liveTradingPackInjected } : {})
        });

  // Step cap: a sub-agent gets an explicit finite budget (MF-5); a top-level run
  // uses the user's setting. `maxSteps = 0` means UNLIMITED and is honored on EVERY
  // provider — including cloud (per user directive: no tool-usage limit). A long,
  // legitimate workflow (e.g. a multi-phase ServiceNow build: plan → execute →
  // verify → review → reverify → repair) must be able to run to completion —
  // saving and verifying a record — without being truncated mid-flight. The run is
  // still bounded in practice by three guards: the Stop button, the loop-breaker
  // (identical tool call repeated too many times), and the model itself ending the
  // turn with no tool call. NOTE: cloud runs append each (often large) tool result
  // to `messages`, so a very long unconverged loop grows the request payload and
  // per-step latency; that's a cost/latency tradeoff the user has accepted, not a
  // correctness cap. To re-impose a ceiling, set Max agent steps > 0 in Settings.
  //
  // A day-trading cycle (regime → research fan-out → fill → validate → submit) is
  // legitimately long; give the trading pack a higher dedicated floor automatically
  // when the user HAS set a finite cap, without hand-tuning maxSteps. A user-set
  // higher maxSteps still wins; children use their own override.
  const TRADING_STEP_CAP = 110;
  const userCap = settings.maxSteps > 0 ? settings.maxSteps : Infinity;
  let cap = ctx.maxStepsOverride != null ? ctx.maxStepsOverride : userCap;
  // NOT on an M1 real-money run: even with the trading toggle on, an M1 (read-only) run
  // must never inherit trading step-caps or the trading screenshot guard (that guard
  // firing on M1 gave a FALSE sense of protection in a real run). Gate trading behavior
  // off whenever this run is M1-locked.
  // 09h: key on the pack ACTUALLY injected this run (URL-gated), never the global toggles --
  // both toggles are ON by default since 09-04, so the old test disabled capture_screenshot
  // on every page of a fresh install (v2 recording 2026-09-09 23:26: Wikipedia chart refused).
  const isTrading = !isChild && !ctx.m1ReadOnly && ctx.maxStepsOverride == null && (!!ctx.liveTradingPackInjected || (ctx.tradingPackInjected != null ? !!ctx.tradingPackInjected : (settings.tradingPackEnabled || settings.paperOrderSubmissionEnabled)));
  if (isTrading) {
    cap = Math.max(cap, TRADING_STEP_CAP); // Math.max(Infinity, 60) === Infinity, so Ollama stays unlimited
  }

  let nudged = ctx.startNudged || false; // one-shot silent-turn recovery (see below)
  try { forgetAclDenials(); } catch {} // per-run: an ACL granted since the last run must not stay "remembered" (MM 09-04 pass 2)
  let fabNudged = false; // one-shot anti-fabrication recovery (claims tool work it never did)
  let groundNudged = !!ctx.startGroundNudged; // one-shot: claimed file writes / page reads the tool ledger never recorded (2026-09-09)
  let continuations = 0; // TRUNCATION CONTINUATION (2026-09-03): a cut-off final answer is continued, at most twice
  let truncPrefix = "";  // the cut-off part(s), joined in front of the continuation for the saved final text
  let emptyNudged = false; // one-shot convergence nudge after a run of fruitless lookups
  let srcNudged = false; // one-shot: cite Filesystem MCP sources the answer was built on
  let webNudged = false; // one-shot: cite the web sources (URLs) a researched answer was built on
  let ledgerNudged = false; // one-shot: the answer must list the records the run created on the instance (2026-09-04)
  let budgetNudged = false; // one-shot: trading cycle running low on steps → force convergence to the form/answer
  let malformedNudged = false; // one-shot: model emitted an unparseable <tool_call> → ask it to resend cleanly
  let noUserQueryRecovered = false; // one-shot: Ollama trimmed away the user turn -> re-inject the task (see PROMPT-FITS-CONTEXT GUARD)
  for (let step = ctx.startStep || 0; step < cap; step++) {
    if (signal.aborted) {
      post({ type: "aborted" });
      return { status: "aborted", steps, runId }; // keep the snapshot — the run is resumable
    }
    // Loop-breaker tripped (same tool call repeated too many times) → stop stepping
    // and fall through to the salvage-summary turn so the model answers from what it has.
    if (ctx._loopAbort) break;
    // CONTEXT OVERFLOW → salvage. Two consecutive tool-bearing calls whose prompt
    // still exceeded num_ctx after client-side compaction (see fittedOllamaOptions)
    // means the model is now running with its head trimmed by Ollama; more tool
    // steps only feed the fetch → trim → forget → re-fetch cycle. Stop stepping and
    // let the salvage turn (tools=[] frees the schema budget) write the answer.
    if ((settings.__ctxOverflowStreak || 0) >= 2) {
      const note = { ok: false, error: "Context window overflow persisted for " + settings.__ctxOverflowStreak + " consecutive steps (prompt > num_ctx after compaction). Stopping tool use and writing the final answer from what was gathered." };
      post({ type: "tool_result", name: "context_overflow_abort", result: note, stepIndex: steps.length, runId });
      steps.push({ tool: "context_overflow_abort", args: {}, ok: false, error: note.error.slice(0, 160) });
      ctx._loopAbort = true;
      break;
    }
    // STEERING (Claude-Code style): inject any messages the user typed mid-run so
    // the model adapts THIS turn without the run being stopped. Top-level run only
    // (children are isolated). Drained at the clean step boundary, so it's part of
    // the next checkpoint too.
    if (ctx.drainSteer) {
      for (const s of ctx.drainSteer()) {
        // Entries are {text, attachments} (older builds queued bare strings).
        const item = typeof s === "string" ? { text: s, attachments: [] } : (s || {});
        let content = String(item.text || "").trim();
        const atts = Array.isArray(item.attachments) ? item.attachments : [];
        // Steered images go through the vision model exactly like images attached
        // at run start — the description (never the base64) reaches the agent model.
        for (let i = 0; i < atts.length; i++) {
          if (signal.aborted) break;
          const att = atts[i];
          if (!att || !att.base64) continue;
          const label = att.name || `image ${i + 1}`;
          post({ type: "tool", name: "analyze_image", args: { name: label, image: `${i + 1}/${atts.length}` } });
          const result = await describeImage({ base64: att.base64, focus: content || taskText || "", settings, signal });
          post({ type: "tool_result", name: "analyze_image", result });
          if (result.description) {
            content += `${content ? "\n\n" : ""}[Attached image ${i + 1}/${atts.length} "${label}" — analysis by ${result.vision_model}]:\n${result.description}`;
          }
        }
        if (content) {
          messages.push({ role: "user", content });
          post({ type: "steer_applied", text: String(item.text || "").trim() || `(image${atts.length > 1 ? "s" : ""} analyzed)` });
        }
      }
    }
    // CONVERGENCE NUDGE (one-shot): if the last several tool calls in a row all
    // came back empty/errored, the model is fishing for data that isn't there.
    // Nudge it ONCE to stop searching and answer from what it has (or state plainly
    // that the thing doesn't exist) rather than burning the whole step budget — and
    // on a cloud run, inflating the context until the stream stalls.
    if (!emptyNudged && (ctx._emptyStreak || 0) >= 5) {
      emptyNudged = true;
      messages.push({
        role: "user",
        content: "Your last several lookups all returned NOTHING (no records / errors). The data you're searching for likely does not exist on this instance. STOP searching now. Either: (a) write your answer using what you already gathered, or (b) state plainly which specific item could not be found and proceed with the rest. Do NOT keep re-querying. Do not invent anything."
      });
    }
    // TRADING STEP-BUDGET NUDGE (one-shot): a day-trading cycle has a HARD cap
    // (TRADING_STEP_CAP). Observed runs burned the whole budget wandering off-task
    // tabs (Docs/Settings/Alerts) and re-reading the page, hitting the cap
    // mid-analysis — full cost, no trade, no dry-run. When the budget runs low,
    // push the agent ONCE to stop exploring and converge: go straight to the order
    // form (fill → Validate → submit only if ACCEPTED) or give its final NO-TRADE.
    if (!budgetNudged && isTrading && Number.isFinite(cap) && step >= cap - 18) {
      budgetNudged = true;
      messages.push({
        role: "user",
        content: `STEP BUDGET LOW — only ${cap - step} of ${cap} steps remain this cycle. STOP exploring tabs and STOP re-reading the page. Converge NOW: if a candidate already clears the rule table and the tradability floor, go DIRECTLY to the "Place Manual Order" form — query the fields, fill SYMBOL/SIDE/QTY/TYPE/STOP/TARGET, click Validate, and ${(ctx.liveTradingPackInjected && settings.liveOrderSubmissionEnabled !== true) ? "then STOP — a human clicks Submit Order on the real-money page" : "Submit ONLY if it says \"VALIDATION: ACCEPTED\""}. If nothing qualifies, output your final NO-TRADE answer right now. Do NOT open Docs/Settings/Alerts/scheduler. Running out of steps before you act wastes the entire cycle.`
      });
    }
    // STEP-CAP AUTO-EXTEND (2026-08-20): a finite cap that expires while the model
    // is still mid-task turns a nearly-done run into a hard "NOT RUN" (live
    // STRY0000001: the portal UAT was skipped ~8 calls short of complete). On the
    // LAST budgeted step, if the run is still healthy (no loop-breaker, no
    // context-overflow streak), grant a bounded extension instead of letting the
    // loop fall through to the salvage turn. Guardrails: opt-out via Settings
    // (autoExtendSteps); top-level runs only — children keep their MF-5 budget
    // (the parent re-spawns if it wants more); NEVER on trading or M1 runs (those
    // caps are safety ceilings, not convenience limits); at most 2 extensions of
    // half the ORIGINAL cap each (min 10 steps), so a runaway run still ends.
    // The injected message explicitly permits answering immediately, so a model
    // that was about to converge on this step is not pushed back into tool use.
    // (Extension state lives in ctx — an MV3 eviction + resume recomputes the cap
    // from settings and forfeits any granted extension; acceptable, fail-closed.)
    if (
      settings.autoExtendSteps !== false &&
      Number.isFinite(cap) && step === cap - 1 &&
      !isChild && !embedded && !isTrading && !ctx.m1ReadOnly &&
      !ctx._loopAbort && (settings.__ctxOverflowStreak || 0) < 2 &&
      (ctx._capExtensions || 0) < 2
    ) {
      ctx._capExtensions = (ctx._capExtensions || 0) + 1;
      if (!ctx._baseCap) ctx._baseCap = cap;
      // Floor of 10 extra steps — but only when the user's cap is itself >= 10. A
      // tiny cap (maxSteps 1-9) is a deliberate tight leash; granting +10 would
      // overshoot it 5-20x (validation-gates finding). Small caps extend by half.
      const grant = Math.max(ctx._baseCap < 10 ? 1 : 10, Math.ceil(ctx._baseCap / 2));
      cap += grant;
      const note = { ok: true, extension: `${ctx._capExtensions}/2`, granted_steps: grant, new_cap: cap, note: "Step cap auto-extended — the budget expired while the task was still in progress. Disable in Settings (Auto-extend step cap) to keep hard caps." };
      post({ type: "tool_result", name: "step_cap_extended", result: note, stepIndex: steps.length, runId });
      steps.push({ tool: "step_cap_extended", args: {}, ok: true });
      messages.push({
        role: "user",
        content: `STEP BUDGET EXTENDED: your tool-call budget ran out before the task was fully complete, so it has been raised by ${grant} steps (extension ${ctx._capExtensions} of 2 — after the last one the run WILL be cut off). Any tool-call limit stated in the task text is superseded by this extension. Use the extra steps ONLY to FINISH the remaining required work — do the still-missing deliverables first (required tests / verification / the final report), skip anything already done, and do NOT restart discovery or re-verify what you already verified. If everything required is in fact done, write the consolidated final answer now instead of calling tools.`
      });
    }
    post({ type: "assistant_start" });

    let content = "";
    let toolCalls = [];
    // Some models (notably qwen3.6) intermittently emit malformed tool-call
    // markup that Ollama's template parser rejects with a transient HTTP 5xx
    // ("expected element type <function> but have <parameter>"). It's a re-roll
    // dice-roll, so retry the turn a couple of times before surfacing it. Never
    // retry user-aborts or 4xx (e.g. context-size) — those won't fix by retrying.
    // Subscription bridges (claude-sub/codex-sub) DON'T stream — the whole turn
    // arrives at once, so no `token` events fire during the (often multi-minute)
    // call and the UI's "thinking…" looks frozen/hung. Pulse a heartbeat so the
    // single-agent subscription path shows life, exactly like the phase engine's
    // gate calls do. (Local Ollama streams, so no heartbeat needed there.)
    const subProvider = activeProvider(settings); // "claude-sub" / "codex-sub" / "llmgo" / ...
    // NON-STREAMING providers emit NO token events during a turn, so the UI looks frozen while a
    // long turn — especially the model writing the VERY FINAL report — generates. Pulse a heartbeat
    // so the user sees a live "Writing… Xs" instead of a stuck "thinking…". This covers the two
    // subscription bridges AND the Agent Go cloud backend (llmgo), which bills-then-emits the whole
    // reply at once. (Local Ollama streams token-by-token, so it needs no heartbeat.)
    const subLike = subProvider === "claude-sub" || subProvider === "codex-sub" || subProvider === "llmgo";
    const subLabel = subProvider === "claude-sub" ? "Claude subscription"
      : subProvider === "codex-sub" ? "ChatGPT subscription" : "Agent Go cloud";
    for (let attempt = 0; ; attempt++) {
      let heartbeat = null; const hbT0 = Date.now();
      try {
        if (subLike) {
          // Fire once IMMEDIATELY so the bubble names the provider right away (the
          // side panel owns the per-second tick); then keep the connection warm.
          const beat = () => { try { post({ type: "assistant_working", waited_s: Math.round((Date.now() - hbT0) / 1000), provider: subLabel, cap_s: 570 }); } catch { /* UI gone */ } };
          beat();
          heartbeat = setInterval(beat, 15000);
        }
        // withModelLock serializes inference across concurrent sub-agents (C.6
        // Phase 2); it wraps ONLY this call, never the tool/approval work below.
        ({ content, toolCalls } = await withModelLock(() => chatStream({
          base: settings.ollamaBase,
          model: agentModel,
          settings,                                  // selects provider (ollama/openai/gemini)
          messages,
          tools: toolList, // ctx.tools || TOOLS, minus desktop_* when the toggle is off (MF-3: children get a filtered list; no spawn_subagent / close_tab)
          options: fittedOllamaOptions(settings, messages, toolList, post), // num_ctx auto-fit + client-side compaction (see PROMPT-FITS-CONTEXT GUARD)
          signal,
          onToken: (delta) => post({ type: "token", delta })
        })));
        break;
      } catch (e) {
        if (e.name === "AbortError" || signal.aborted) {
          post({ type: "aborted" });
          return { status: "aborted", steps, runId };
        }
        // "no user query found in messages": Ollama's server-side trimming dropped
        // every user turn (context too small). Retrying verbatim is pointless -- the
        // 500 is deterministic. Re-inject the task as a fresh user turn ONCE (after
        // the tool results, where the trimmer keeps it) and retry.
        if (isNoUserQueryError(e.message) && !noUserQueryRecovered) {
          noUserQueryRecovered = true;
          messages.push({
            role: "user",
            content: "(Context was trimmed -- restating the task.) " + String(taskText || "Continue the task above.").slice(0, 2000) +
              "\n\nUse the tool results already gathered above; if you have enough, answer now in plain text."
          });
          post({ type: "assistant_retry", attempt: attempt + 1 });
          continue;
        }
        if (isRetryableTurnError(e.message) && attempt < 2) {
          post({ type: "assistant_retry", attempt: attempt + 1 });
          continue; // re-roll this turn
        }
        // Non-transient / exhausted: surface it but KEEP the snapshot so the user
        // can resume once the cause clears (e.g. Ollama restarted).
        post({ type: "error", text: e.message });
        return { status: "error", error: e.message, steps, runId };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    }

    post({ type: "assistant_end" });

    // Fallback: recover tool calls the model wrote as plain text.
    let malformedToolCall = false;
    if (!toolCalls || toolCalls.length === 0) {
      const parsed = extractTextToolCalls(content);
      if (parsed.calls.length) {
        toolCalls = parsed.calls;
        content = parsed.cleaned;
        post({ type: "rewrite_assistant", text: content }); // clean up the shown bubble
      } else if (parsed.malformed) {
        malformedToolCall = true; // detected <tool_call> markup that would not parse
      }
    }

    messages.push({ role: "assistant", content, tool_calls: toolCalls });

    // TERMINAL self_feedback: when the model's ONLY tool call(s) this turn are
    // self_feedback AND it already produced a substantive answer, that IS the
    // model self-rating after finishing the task. Record it, but do NOT spend
    // another full model round-trip just to hear "ok, done" — that trailing turn
    // was the ~90s "still spinning after the deliverable was shown". Run it inline,
    // then fall through to the finalization below and end the run on this answer.
    if (toolCalls && toolCalls.length && toolCalls.every((c) => c.function?.name === "self_feedback") && String(content || "").trim()) {
      for (const c of toolCalls) {
        const a = parseArgs(c.function?.arguments);
        post({ type: "tool", name: "self_feedback", args: {} });
        try {
          const r = await executeTool("self_feedback", a, { settings, signal, subScope: ctx.subScope, snInstance: ctx.snInstance });
          post({ type: "tool_result", name: "self_feedback", result: r, runId });
        } catch (e) {
          post({ type: "tool_result", name: "self_feedback", result: { error: String(e?.message || e) }, runId });
        }
      }
      toolCalls = []; // finalize on the answer we already have — no extra model turn
    }

    if (!toolCalls || toolCalls.length === 0) {
      // MALFORMED TOOL-CALL RECOVERY (2026-07-23, live claude-sub Script Include
      // run): the model emitted <tool_call> markup that couldn't be parsed
      // (truncated mid-JSON, or literal newlines inside a set_editor_value code
      // value). Recovery found 0 executable calls, so WITHOUT this the loop treats
      // the broken call as a FINAL ANSWER and the run ends — the user sees the
      // narration, nothing happened, and has to prod it ("Are you there?"). Nudge
      // ONCE to resend the call cleanly and CONTINUE the loop instead of ending.
      if (malformedToolCall && !malformedNudged) {
        malformedNudged = true;
        messages.push({
          role: "user",
          content: "Your last tool call did not parse, so NOTHING ran. Re-send that SINGLE call now as ONE `<tool_call>{\"name\":\"…\",\"arguments\":{…}}</tool_call>` with the ENTIRE JSON on one line, every newline inside a string value escaped as \\n, and the closing </tool_call> present. No commentary before or after, and do not explain the tool-call format — just emit the corrected call."
        });
        await checkpoint(step + 1, nudged);
        continue; // give the model another turn to emit a clean call
      }
      // SILENT-TURN RECOVERY: the model returned NO text and NO tool call after
      // already gathering info (e.g. read_page) — common with small local models
      // (qwen3.6 etc.). Nudge it ONCE to actually answer, instead of ending the
      // run blank with "the model ended the turn without a text reply".
      if (!String(content || "").trim() && steps.length > 0 && !nudged) {
        nudged = true;
        messages.push({
          role: "user",
          content: "Use what you gathered above to ANSWER my original question now, in plain text — do NOT call any tool. If the task was an action you already completed, briefly summarize what you did and what you found."
        });
        await checkpoint(step + 1, nudged); // clean boundary (assistant + injected user)
        continue; // re-run the model for a text answer
      }

      // GROUNDED-WORK RECOVERY (2026-09-09). Runs BEFORE the ServiceNow nudge below,
      // because that one is SN-shaped and misfires on filesystem work: in the
      // competitive-intel run (export 16:29) a battlecard task whose answer said
      // "corrected" near the words "change log" tripped `claimsWrite`, and the model
      // spent its one recovery turn arguing "there is no ServiceNow work in this task"
      // instead of writing the files. Worse, the plain filesystem cases — "The four
      // files are written" with zero write calls, four pages described with zero tool
      // calls — matched NOTHING and got no retry at all. The banner at the ship point
      // catches those honestly, but honest-and-useless is still useless: the point is
      // to make the model go and DO the work. groundingScan classifies the claim with
      // no SN bias, so the nudge can name the right tools.
      if (!groundNudged && String(content || "").trim() && !isConceptualTurn(ctx.taskText || "")) {
        const claim = groundingScan(String(content), groundingLedger(steps, ctx));
        if (claim) {
          groundNudged = true; ctx.startGroundNudged = true; // persisted by the checkpoint (MM pass 3, N-13)
          post({ type: "tool", name: "grounded_work_retry", args: { kind: claim.kind } });
          post({ type: "tool_result", name: "grounded_work_retry", result: {
            ok: false, kind: claim.kind, retrying: true,
            note: "The answer claimed work no tool performed. Sending it back to do it for real (once)."
          } });
          messages.push({ role: "user", content: groundedWorkNudge(claim) });
          await checkpoint(step + 1, nudged);
          continue; // send it back to do the work for real
        }
      }

      // ANTI-FABRICATION RECOVERY: the model produced a NON-empty final answer that
      // CLAIMS tool work it never actually performed this run — e.g. a "Sub-agent
      // Execution Summary" table when spawn_subagent was never called, or "updated
      // the record / INC0012345" when no sn_* tool ran. (Root cause seen in UAT:
      // the parent confabulated 5 successful sub-agent updates with the literal
      // INC0012345 placeholder from the tool docs, calling zero tools.) Nudge ONCE
      // to actually execute, instead of shipping invented results as success.
      if (!fabNudged && String(content || "").trim()) {
        const txt = String(content);
        const meaningful = steps.filter((s) => s.tool && s.tool !== "fable_behavior_pack");
        const ranSpawn = steps.some((s) => s.tool === "spawn_subagent");
        const ranSN = steps.some((s) => /^sn_/.test(s.tool || ""));
        const ranWrite = steps.some((s) => ["sn_update_record", "sn_create_record", "sn_wf_activity_set", "sn_wf_delete_activity", "sn_wf_fix_script", "sn_wf_publish", "set_editor_value", "fill_input", "click_element", "set_reference_field", "select_option"].includes(s.tool));
        // (a) reports sub-agent execution but no sub-agent was ever spawned
        const fabSubagent = ctx.allowSubagents && !ranSpawn &&
          /sub-?agent/i.test(txt) && /\b(success|complete|completed|done|executed|finished|status|summary)\b/i.test(txt);
        // (b) cites a SN record number / claims a record write, but took NO action at all
        const citesRecord = SN_RECORD_RX.test(txt); // one regex with the grounding ledger (MM pass 2 B-5)
        const claimsWrite = /\b(updated|saved|appended|modified|wrote|created|set)\b/i.test(txt) &&
          /\b(record|incident|change|request|description|field|sys_id|table)\b/i.test(txt);
        // CONCEPTUAL-TURN EXEMPTION (2026-07-20z, live a-live-run): a definitional
        // answer to "what is a Business Rule?" NATURALLY says "runs when a record is
        // inserted, UPDATED, or deleted" — which trips claimsWrite (updated + record)
        // with zero tools run (correct — a concept needs none). The nudge then fired
        // "STOP — FABRICATED, call sn_* tools NOW", and the model abandoned its clean
        // definition to answer that corrective DEFENSIVELY ("you're right, I ran no
        // tools…") — a non-answer. The zero-evidence retry already skips conceptual
        // turns for this exact reason (see isConceptualTurn); this guard must too. A
        // question naming a LIVE record/instance is NOT conceptual and still fires.
        const conceptual = isConceptualTurn(ctx.taskText || "");
        const fabRecord = !conceptual && !ranSpawn && !ranSN && !ranWrite && meaningful.length === 0 && (citesRecord || claimsWrite);
        if (fabSubagent || fabRecord) {
          fabNudged = true;
          const msg = fabSubagent
            ? "STOP — that report is FABRICATED. You did NOT run any sub-agent: `spawn_subagent` was never called this turn, so those results do not exist. Do NOT present invented sub-agent outcomes as success. Call `spawn_subagent` NOW (one per task) and report ONLY what the children actually return. If you truly cannot, say so plainly — never invent results."
            : "STOP — that report is FABRICATED. You did NOT query or update ServiceNow: no `sn_query_table` / `sn_update_record` ran this turn, so you have NO real record, sys_id, or incident number. Placeholder values in the tool docs (e.g. INC0012345) are EXAMPLES, not real data. Call the `sn_*` tools NOW and report ONLY the real values returned. If a tool errors, report the exact error — never invent a result.";
          messages.push({ role: "user", content: msg });
          await checkpoint(step + 1, nudged);
          continue; // force the model to actually do the work
        }
      }

      // TRUNCATION CONTINUATION (2026-09-03, live dev000000 legacy-workflow run: the answer
      // stopped mid-sentence in section H and sections I + the verification checklist never
      // arrived — the output limit was hit and the run ended as if complete). A long final
      // answer that ends without closing punctuation, inside an open code fence, or short of
      // a lettered/numbered section the request asked for is CONTINUED, not shipped: the
      // model is told to resume exactly where it stopped, and the pieces are joined.
      if (String(content || "").trim() && continuations < 2) {
        // Judge the JOINED answer, not the latest piece: a continuation that only carries the
        // tail sections is not "missing A-H" — they are in the piece before it (dev000000 run,
        // 2026-09-04: a complete two-part guide got a third "nothing left to continue" turn).
        const why = looksTruncated((truncPrefix ? truncPrefix + "\n" : "") + String(content), ctx.taskText || "");
        if (why) {
          continuations++;
          truncPrefix += (truncPrefix ? "\n" : "") + String(content);
          post({ type: "continued", why, n: continuations });
          messages.push({
            role: "user",
            content: "Your previous message was CUT OFF at its end (" + why + "). Continue EXACTLY where you stopped: do not repeat anything you already wrote, do not restart or summarise the document, do not apologise. Finish the remaining part — including every remaining lettered/numbered section the request asked for and the final checklist if one was requested. Plain text, no tool calls. If NOTHING is in fact missing, reply with exactly: NOTHING_MISSING"
          });
          await checkpoint(step + 1, nudged);
          continue;
        }
      }
      if (truncPrefix) {
        // A "continuation" that denies being cut off is not part of the answer (2026-09-08a,
        // resume-tailoring export 01:00: "I cannot complete this request because there is no
        // previous message … that was cut off" was appended to a complete research answer).
        content = isNonContinuation(content) ? truncPrefix : truncPrefix + "\n" + String(content || "");
        truncPrefix = "";
      }

      // SOURCE-CITATION NUDGE (one-shot): the run DID read local files (📁 Local
      // files / Filesystem MCP) — so the answer is grounded in them — but the model
      // didn't cite ANY of them as evidence. Push it ONCE to add a "Sources
      // (Filesystem MCP)" section referencing the exact paths it read. Fires only
      // when files were actually read AND none are referenced, so a properly-cited
      // answer (or a non-folder task) is never interrupted.
      if (!srcNudged && String(content || "").trim()) {
        const audit = fsSourceAudit(steps);
        if (audit.reads.length) {
          const txt = String(content);
          const cited = audit.reads.some((p) => {
            const base = String(p).split(/[\/\\]/).pop();
            return txt.includes(p) || (base && txt.includes(base));
          }) || /\b(sources?|evidence|references?|filesystem|read_file|\bMCP\b)\b/i.test(txt);
          if (!cited) {
            srcNudged = true;
            messages.push({
              role: "user",
              content: `You based this answer on local files you READ via 📁 Local files (MCP) — ${audit.reads.slice(0, 12).map((p) => `"${p}"`).join(", ")} — but you did not cite them. Revise your answer to include a "Sources (Filesystem MCP)" section that lists the exact file path(s) you read and maps each key claim/decision to the file(s) that support it. Cite ONLY files you actually read this run; do not invent paths or contents.`
            });
            await checkpoint(step + 1, nudged);
            continue; // re-run so the answer carries its evidence
          }
        }
      }

      // WEB-CITATION NUDGE (one-shot): the run DID research the web (web_search
      // ran) but the answer carries no URL and no Sources section — push once to
      // cite the sources actually consulted. Mirrors the Filesystem MCP nudge.
      if (!webNudged && String(content || "").trim()) {
        const wa = webSourceAudit(steps);
        if (wa.searches.length) {
          const txt = String(content);
          const cited = /https?:\/\//i.test(txt) || /\bsources?\b/i.test(txt);
          if (!cited) {
            webNudged = true;
            messages.push({
              role: "user",
              content: `You researched this answer with web_search (queries: ${wa.searches.slice(0, 6).map((q) => `"${q}"`).join(", ")}${wa.pages.length ? `; pages opened: ${wa.pages.slice(0, 6).join(", ")}` : ""}) but cited NO sources. Revise your answer to include a "Sources" section listing the URLs your claims came from — ONLY urls from this run's search results or pages you navigated to. Never invent a URL.`
            });
            await checkpoint(step + 1, nudged);
            continue; // re-run so the answer carries its evidence
          }
        }
      }

      // RECORD-LEDGER NUDGE (one-shot, 2026-09-04): the run created records on the
      // instance (test incidents, helper Fix Scripts, workflow rows) and the answer
      // does not name some of them. Push once for a "Records created on the
      // instance" section + the cleanup question — the model never deletes them.
      if (!ledgerNudged && String(content || "").trim() && (ctx._snCreated || []).length) {
        const missing = snUnmentionedCreates(ctx, content);
        const tests = (ctx._snTestRecords || []).map((t) => t.display || t.sys_id);
        const helpers = (ctx._snCreated || []).filter((r) => r.helper).map((r) => `${r.display || "Fix Script"} ${r.sys_id}`);
        if (missing.length) {
          ledgerNudged = true;
          messages.push({
            role: "user",
            content: `Your answer leaves out records this run CREATED on the instance: ${missing.slice(0, 20).map((r) => `${r.table} ${r.display || ""} ${r.sys_id}`.replace(/\s+/g, " ").trim()).join("; ")}${missing.length > 20 ? ` (+${missing.length - 20} more)` : ""}. Revise the answer (keep everything else) and END it with a section "Records created on the instance" that lists EVERY record this run created — table, number/name, sys_id — marking test records${tests.length ? ` (${tests.join(", ")})` : ""} and helper Fix Scripts${helpers.length ? ` (${helpers.join(", ")})` : ""} as such, followed by ONE question: whether to close the test records and delete the helper Fix Scripts now. Do NOT delete or close anything yourself, and do not invent records you did not create.`
          });
          await checkpoint(step + 1, nudged);
          continue;
        }
      }

      // Auto-score the run: verified commits are +, errors and denials are −.
      // MF-2: children do NOT save trajectories or clear the parent snapshot.
      // BL-2: embedded (phase-engine EXECUTE) runs return the draft to the
      // engine — no trajectory, no clearRunState, and CRITICALLY no `final`
      // post (an unreviewed draft must never ship to the UI — T2).
      if (!isChild && !embedded) {
        const negatives = steps.filter((s) => s.error || s.denied).length;
        const positives = steps.filter((s) => s.verified === true).length;
        await saveTrajectory({
          id: runId,
          ts: Date.now(),
          task: taskText.slice(0, 400),
          steps,
          finalText: (content || "").slice(0, 300),
          autoScore: positives - negatives,
          feedback: null,
          usedLessons: (lessons || []).map((l) => l.id)
        });
        await clearRunState(); // run finished cleanly — nothing left to resume
      }
      emitFsAudit(steps, post); // ground-truth evidence line (if the folder was used)
      emitSnWriteAudit(ctx, post); // ground-truth list of records created on the instance (2026-09-04)
      emitWebAudit(steps, post); // ground-truth web-research line (if web_search ran)
      if (embedded) {
        return { status: "final", finalText: content, steps, runId,
          evidenceLedger: embedded.evidenceLedger, modelIdentity: `${activeProvider(settings)}:${agentModel}` };
      }
      // GROUNDING / ECHO / NOT-EXECUTED guards (2026-09-09) — last thing before the answer
      // ships, so a claim the ledger does not support cannot reach the user clean.
      content = runGroundingGuard(content, steps, ctx, post);
      post({ type: "final", text: content, runId });
      return { status: "final", finalText: content, steps, runId };
    }

    // C.6: per-turn fan-out budget — reserve ≥60% of the context window for the
    // parent and split the remaining 40% across this turn's children (MF-9), and
    // cap children-per-turn (MF-7).
    const spawnThisTurn = toolCalls.filter((c) => c.function?.name === "spawn_subagent").length;
    const childResultCap = spawnThisTurn
      ? Math.max(512, Math.min(4096, Math.floor((settings.numCtx || 8192) * 4 * 0.4 / spawnThisTurn)))
      : 4096;
    // C.6 Phase 2: accepted sub-agent spawns are DEFERRED to after this turn's
    // tool loop, then run together (concurrently if the user raised the setting)
    // so siblings can pipeline their DOM/IO. Rejections still resolve inline.
    const acceptedSpawns = [];

    for (const call of toolCalls) {
      if (signal.aborted) {
        post({ type: "aborted" });
        return { status: "aborted", steps, runId };
      }
      const name = call.function?.name;
      const args = parseArgs(call.function?.arguments);
      // read_page{url} NAVIGATES (09-09a). Every gate that governs navigate governs it too,
      // or the url branch is a side door around read-only mode, ask-mode approval and the
      // M1 route allowlist (MM 09-09 F3). One predicate, used by all three gates below.
      const navLike = name === "navigate" || (name === "read_page" && !!(args && args.url && String(args.url).trim()));

      // Inbox-drafter send guard (defense-in-depth for the inbox pack): while the
      // mailbox pack is active, send_email / send_sms run only if the LATEST user
      // message carries the exact approval phrase. The prompt rule alone is not a
      // guardrail; this is.
      if (ctx.inboxDrafter && (name === "send_email" || name === "send_sms")) {
        const lastUser = String([...messages].reverse().find((m) => m.role === "user")?.content || "");
        if (!/APPROVED \u2014 SEND IT/.test(lastUser)) {
          const ro = { error: `Inbox drafter mode: "${name}" is blocked. Drafts stay in the composer; a message is sent only after the user types the exact phrase "APPROVED \u2014 SEND IT" in this conversation.` };
          post({ type: "tool", name, args });
          post({ type: "tool_result", name, result: ro, stepIndex: steps.length, runId });
          messages.push({ role: "tool", name, content: JSON.stringify(ro) });
          steps.push({ tool: name, args: redactArgs(name, args), error: ro.error.slice(0, 160) });
          continue;
        }
      }
      // M1 fail-closed guard (defense-in-depth) — MUST be the FIRST check in the loop,
      // BEFORE the spawn_subagent interception below, so a text-recovered tool call
      // (incl. spawn_subagent, recovered by extractTextToolCalls) cannot slip past it.
      // On a real-money 401(k) reject ANY tool not in the positive M1 allowlist.
      // Positive-scoped so an unenumerated write/egress tool can never get through.
      if (ctx.m1ReadOnly && !M1_SAFE_TOOL_NAMES.has(name)) {
        const ro = { error: `M1 portfolio mode is READ-ONLY: "${name}" is disabled. This is a real-money 401(k) — no trading, editing, typing, or sub-agents. Use ONLY read tools (read_page, query_elements, scroll_page, capture_screenshot, get_tab_info, list_tabs, web_search, google_search), or navigate to an allowlisted read-only M1 page, and write your insight report.` };
        post({ type: "tool", name, args });
        post({ type: "tool_result", name, result: ro, stepIndex: steps.length, runId });
        messages.push({ role: "tool", name, content: JSON.stringify(ro) });
        steps.push({ tool: name, args: redactArgs(name, args), error: ro.error.slice(0, 160) });
        continue;
      }
      // navigate is permitted under M1 ONLY to an allowlisted READ-ONLY route (fail-closed
      // URL check). A transactional/login/off-origin target is refused here, before the
      // tab ever moves. Catches text-recovered navigate too (same per-call loop).
      if (ctx.m1ReadOnly && ctx.isChild && name === "read_page" && navLike) {
        // M1 children are NAVLESS (CHILD_TOOLS minus navigate); a url on read_page must
        // not hand the navigation back (MM 09-09 F3).
        const ro = { error: "M1 portfolio mode: sub-agents do not navigate. Call read_page WITHOUT url to read the tab you were given." };
        post({ type: "tool", name, args });
        post({ type: "tool_result", name, result: ro, stepIndex: steps.length, runId });
        messages.push({ role: "tool", name, content: JSON.stringify(ro) });
        steps.push({ tool: name, args: redactArgs(name, args), error: ro.error.slice(0, 160) });
        continue;
      }
      if (ctx.m1ReadOnly && navLike && !isM1ReadOnlyRoute(args && args.url)) {
        const ro = { error: `M1 portfolio mode is READ-ONLY: navigation to "${String((args && args.url) || "").slice(0, 200)}" is blocked. Only read-only M1 pages on dashboard.m1.com are allowed (home, your Invest portfolio, Concentration analysis sector/asset/region). Trading, transfer, settings, login, and off-origin URLs are mechanically refused. Read the href of a read-only insight link and navigate to that, or ask the user to open the page.` };
        post({ type: "tool", name, args });
        post({ type: "tool_result", name, result: ro, stepIndex: steps.length, runId });
        messages.push({ role: "tool", name, content: JSON.stringify(ro) });
        steps.push({ tool: name, args: redactArgs(name, args), error: ro.error.slice(0, 160) });
        continue;
      }

      // C.6: sub-agent delegation, intercepted BEFORE the normal dispatch so the
      // orchestrator (not executeTool) runs the child loop. Recursion is blocked
      // here too (MF-4) — a text-recovered spawn_subagent from a child is rejected.
      if (name === "spawn_subagent") {
        post({ type: "tool", name, args });
        // Rejections (recursion / invalid args / cap) resolve inline — no child runs.
        let rejection = null;
        if (!ctx.allowSubagents) {
          rejection = { error: "spawn_subagent is unavailable inside a sub-agent (recursion is not allowed)." };
        } else {
          const invalid = validateArgs("spawn_subagent", args);
          if (invalid) rejection = invalid;
          else if (acceptedSpawns.length >= 8) rejection = { error: "Fan-out cap reached: at most 8 sub-agents per turn. Spawn the rest in a follow-up turn." };
          else if ((ctx._childrenSpawned || 0) >= 24) rejection = { error: "Run-wide sub-agent cap (24) reached. Finish with the results you have." };
        }
        if (rejection) {
          post({ type: "tool_result", name, result: rejection, stepIndex: steps.length, runId });
          messages.push({ role: "tool", name, content: capToolPayload(JSON.stringify(rejection)) });
          steps.push({ tool: name, args: redactArgs(name, args), ok: false, error: String(rejection.error).slice(0, 160) });
          continue;
        }
        // Accepted — reserve a unique child index now (so concurrent children never
        // collide on childId) and defer the actual run to the post-loop orchestrator.
        ctx._childrenSpawned = (ctx._childrenSpawned || 0) + 1;
        acceptedSpawns.push({ args, childIndex: ctx._childrenSpawned, resultCap: childResultCap });
        continue;
      }

      // LOOP BREAKER: local models (qwen3-coder) sometimes re-issue the SAME tool
      // call CONSECUTIVELY over and over (e.g. fetching the identical script 20+
      // times) and never produce an answer. We track CONSECUTIVE identical calls
      // (a different call resets the counter, so legitimate repeated read_page
      // between actions is never blocked). After 2 in a row, refuse and push the
      // model to use what it has; if it keeps looping, force the salvage summary.
      // read_page's signature IGNORES its args: the 2026-07-22 dashboard transcript
      // showed the model dodging this guard by tweaking max_chars between otherwise
      // identical re-reads (9 read_page calls to open one folder). Consecutive
      // read_page calls are duplicates regardless of arg tweaks — any intervening
      // DIFFERENT tool still resets the counter, so click→read→click→read is fine.
      // 2026-09-09: keyed by the target url so four reads of four DIFFERENT pages are
      // four signatures. Same page with a tweaked max_chars still collides (the 2026-07-22
      // dodge). See callSignature in loop-guards.js for the incident.
      const callSig = callSignature(name, args, ctx._pageKey);
      if (ctx._lastSig === callSig) ctx._consec = (ctx._consec || 1) + 1;
      else { ctx._lastSig = callSig; ctx._consec = 1; }
      if (ctx._consec >= 3) {
        // A repeat of a call that FAILED is not a re-read: say so, with the error
        // (2026-09-07c; wording lives in loop-guards.js so it is testable).
        const dupResult = { error: repeatRefusal({ name, kind: "consecutive", seen: ctx._consec, lastError: ctx._sigLastErr && ctx._sigLastErr.get(callSig) }) };
        post({ type: "tool", name, args });
        post({ type: "tool_result", name, result: dupResult, stepIndex: steps.length, runId });
        messages.push({ role: "tool", name, content: JSON.stringify(dupResult) });
        steps.push({ tool: name, args: redactArgs(name, args), error: dupResult.error.slice(0, 160) });
        ctx._dupBlocks = (ctx._dupBlocks || 0) + 1;
        if (ctx._dupBlocks >= 3) ctx._loopAbort = true; // still looping → salvage a final answer
        continue;
      }

      // CYCLE BREAKER (non-consecutive repeats; incident 2026-08-18): the guard
      // above only sees back-to-back duplicates. A context-starved model instead
      // cycles through a SET of pages — navigate A → get_editor_value → navigate B →
      // open_form_section → get_editor_value → navigate A ... — re-fetching the same
      // 14K-char script every 5 steps because compaction stubbed the earlier copy.
      // Count TOTAL occurrences of each call signature over the whole run. Page-
      // scoped read tools (get_editor_value, list_editors, read_page, open_form_
      // section, query_elements ...) are keyed by the last navigated URL, so reading
      // editor index 0 on three DIFFERENT pages is three distinct signatures, while
      // the third fetch of the SAME page's editor is refused. navigate itself is
      // keyed by its own URL. Refusals share the _dupBlocks counter → salvage.
      if (name === "navigate" && args && args.url) { ctx._pageKey = String(args.url); ctx._domEpoch = 0; }
      // DOM EPOCH (2026-09-09): on a SPA a click replaces the visible content without
      // navigating, so page-scoped read signatures collided across genuinely different
      // views (Signals tab vs Watchlist vs the Analysis panel a row-click opens). Any
      // interaction that mutates the DOM starts a new epoch, so the next read is a new
      // signature. A repeated read with no interaction in between still cycles.
      const DOM_MUTATING = ["click_element", "fill_input", "select_option", "press_key",
        "submit_form", "scroll", "hover", "open_form_section", "set_editor_value"];
      if (DOM_MUTATING.indexOf(name) !== -1) ctx._domEpoch = (ctx._domEpoch || 0) + 1;
      // sn_query_* are keyed by table+query ONLY (fields/limit dropped): the
      // 2026-08-18 13:34 run re-issued the same failing `questionLIKEStart Date`
      // query 12x, each time with a shorter `fields` list, and every variant was a
      // fresh signature. Same table + same query = the same fetch; the 3rd one is
      // refused. Also not page-scoped -- a REST query returns the same rows
      // regardless of which SN page is active.
      const isSnQuery = /^sn_query_(session|table)$/.test(name);
      // A navigate to a URL named in the task itself ("open …/workflow_ide.do so I can follow
      // along") is intentional wherever it happens — e.g. returning the tab to that page at the
      // end of the run — and must not be refused as a re-fetch cycle (2026-09-03).
      const userAskedForUrl = name === "navigate" && args && args.url && String(ctx.taskText || "").includes(String(args.url).split("&sysparm_sys_id=")[0]);
      const cycleSig = userAskedForUrl ? null : name === "navigate" ? callSig
        : isSnQuery ? name + ":" + JSON.stringify({ table: args && args.table, query: args && args.query })
        : (ctx._pageKey || "") + "#" + (ctx._domEpoch || 0) + "|" + callSig;
      if (!ctx._sigCounts) ctx._sigCounts = new Map();
      const seen = cycleSig == null ? 0 : (ctx._sigCounts.get(cycleSig) || 0) + 1;
      if (cycleSig != null) ctx._sigCounts.set(cycleSig, seen);
      if (seen >= 3) {
        const cyc = { error: repeatRefusal({ name, kind: "cycle", seen, lastError: ctx._sigLastErr && ctx._sigLastErr.get(cycleSig), pageScoped: name !== "navigate" }) };
        post({ type: "tool", name, args });
        post({ type: "tool_result", name, result: cyc, stepIndex: steps.length, runId });
        messages.push({ role: "tool", name, content: JSON.stringify(cyc) });
        steps.push({ tool: name, args: redactArgs(name, args), error: cyc.error.slice(0, 160) });
        ctx._dupBlocks = (ctx._dupBlocks || 0) + 1;
        if (ctx._dupBlocks >= 3) ctx._loopAbort = true;
        continue;
      }

      // READ-ONLY guard (defense-in-depth): even if a write tool leaks into the
      // list or is text-recovered, refuse it. The model must only READ + analyze.
      // CARVE-OUT: on an M1 run, navigate is in ACTION_TOOLS but was already validated
      // against the read-only route allowlist by the M1 navigate guard above — so don't
      // re-block it here (this guard would otherwise kill the allowlisted navigation).
      if (ctx.liveTradingPackInjected && (name === "run_command" || DESKTOP_ACTION_TOOL_NAMES.has(name))) { // MM pass 2 S3: schema stripping is not enforcement
        const g = { error: "REAL-MONEY run: OS control and shell are refused (schema-stripped and executor-refused)." };
        post({ type: "tool", name, args }); post({ type: "tool_result", name, result: g, stepIndex: steps.length, runId });
        messages.push({ role: "tool", name, content: JSON.stringify(g) }); steps.push({ tool: name, args: redactArgs(name, args), error: g.error.slice(0, 160) }); continue;
      }
      // MM pass 2 S4: a run that did not start on the live page may not act on it (drift guard; children are read-only via P4).
      if (!ctx.liveTradingPackInjected && !isChild && (ACTION_TOOLS.has(name) || name === "press_key" || navLike)) { // MM pass 3 L3
        let driftLive = false;
        try { const [drift] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); driftLive = !!(drift && needsLiveTradingPack(drift.url)); } catch {}
        if (driftLive) {
          const g = { error: "REAL-MONEY page reached mid-run without the live-trading pack — DOM actions refused here. Start a NEW run with live-trading.html active and the live pack enabled." };
          post({ type: "tool", name, args }); post({ type: "tool_result", name, result: g, stepIndex: steps.length, runId });
          messages.push({ role: "tool", name, content: JSON.stringify(g) }); steps.push({ tool: name, args: redactArgs(name, args), error: g.error.slice(0, 160) }); continue;
        }
      }
      if (ctx.readOnly && (ACTION_TOOLS.has(name) || navLike) && !(ctx.m1ReadOnly && navLike)) {
        const ro = name === "read_page"
          ? { error: `READ-ONLY mode is ON: read_page with a \`url\` would NAVIGATE the tab, and navigation is an action this mode disables. Call read_page WITHOUT url to read the page that is already open, or ask the user to open ${String((args && args.url) || "").slice(0, 200)} and then read it.` }
          : { error: `READ-ONLY mode is ON: ${name} and all changes are DISABLED. Do NOT modify ServiceNow, the page, or files. Gather what you need with read tools (read_page, query_elements, sn_query_*, sn_fetch_*, read_file, web_search, google_search) and write your analysis/report.` };
        post({ type: "tool", name, args });
        post({ type: "tool_result", name, result: ro, stepIndex: steps.length, runId });
        messages.push({ role: "tool", name, content: JSON.stringify(ro) });
        steps.push({ tool: name, args: redactArgs(name, args), error: ro.error.slice(0, 160) });
        continue;
      }

      // INSTANCE READ-ONLY guard (standing owner grant 2026-08-20): fact-finding /
      // requirements-verification / research runs keep navigate/read/report tools,
      // but every instance-mutating tool is refused in code — a prompt-level
      // "read-only" alone doesn't stop a model from "helpfully" fixing what it
      // finds. Narrower than ctx.readOnly: local writes (the findings report)
      // stay allowed. Also blocks non-GET http_request aimed at the granted host.
      if (ctx.snInstanceReadOnly && (SN_INSTANCE_WRITE_TOOLS.has(name) ||
          (name === "http_request" && String((args && args.method) || "GET").toUpperCase() !== "GET" && String((args && args.url) || "").toLowerCase().includes(ctx.snInstanceReadOnly)))) {
        const ro = { error: `INSTANCE READ-ONLY: this run is pinned READ-ONLY on ${ctx.snInstanceReadOnly} (a production post-deployment validation, or the fact-finding/verification/research standing grant) — ${name} is DISABLED and no ServiceNow data may be changed. Gather evidence with sn_query_session / read_page / query_elements, and put anything that needs fixing in your report instead of fixing it. Saving the report locally (write_file/create_document) is still allowed.` };
        post({ type: "tool", name, args });
        post({ type: "tool_result", name, result: ro, stepIndex: steps.length, runId });
        messages.push({ role: "tool", name, content: JSON.stringify(ro) });
        steps.push({ tool: name, args: redactArgs(name, args), error: ro.error.slice(0, 160) });
        continue;
      }

      // TEST-RECORD GUARD (2026-09-04): a test record whose predecessor started no
      // workflow context, with nothing changed since, is refused after the second
      // dead one (annotated after the first). See snTestRecordGate.
      if (name === "sn_create_record" && snTestRecordOf(args)) {
        const gate = snTestRecordGate(ctx, args);
        if (gate && gate.refuse) {
          const tg = { error: gate.refuse };
          post({ type: "tool", name, args });
          post({ type: "tool_result", name, result: tg, stepIndex: steps.length, runId });
          messages.push({ role: "tool", name, content: JSON.stringify(tg) });
          steps.push({ tool: name, args: redactArgs(name, args), error: tg.error.slice(0, 160) });
          continue;
        }
        ctx._pendingTestNote = gate && gate.note ? gate.note : null;
      }

      // TRADING-MODE GUARDS (hard, code-controlled): keep a day-trading cycle from
      // burning its hard step cap on things that never help a trade decision. Two
      // observed cycles re-read the page ~24× and took 7 screenshots, hitting the
      // cap mid-analysis (full cost, no trade). These backstop the trading-pack
      // prompt rules so they can't be ignored. Parent run only (children are short).
      if (isTrading) {
        // (a) Vision is off-limits — the pack forbids reading prices/levels off a
        // chart screenshot (vision misreads them); use the app's numeric data.
        if (name === "capture_screenshot" || name === "desktop_screenshot") { // MM pass 2 Low
          const g = { error: "capture_screenshot is DISABLED in day-trading mode — vision misreads prices/levels. Use the app's NUMERIC data instead (read_page / query_elements / the Analysis tab), then act on a candidate." };
          post({ type: "tool", name, args });
          post({ type: "tool_result", name, result: g, stepIndex: steps.length, runId });
          messages.push({ role: "tool", name, content: JSON.stringify(g) });
          steps.push({ tool: name, args: redactArgs(name, args), error: g.error.slice(0, 160) });
          continue;
        }
        // (b) Re-read cap — allow a generous number of page reads, then refuse: the
        // content is already in the conversation and the model needs to ACT.
        if (name === "read_page") {
          if ((ctx._tradeReads || 0) >= 12) {
            const g = { error: `You have already called read_page 12 times this cycle — the page content is in the conversation above. STOP re-reading. Act on what you have: go to the "Place Manual Order" form (fill → Validate → ${(ctx.liveTradingPackInjected && settings.liveOrderSubmissionEnabled !== true) ? "STOP; a human clicks Submit" : "submit only if ACCEPTED"}) or output your final NO-TRADE answer NOW.` };
            post({ type: "tool", name, args });
            post({ type: "tool_result", name, result: g, stepIndex: steps.length, runId });
            messages.push({ role: "tool", name, content: JSON.stringify(g) });
            steps.push({ tool: name, args: redactArgs(name, args), error: g.error.slice(0, 160) });
            continue;
          }
          ctx._tradeReads = (ctx._tradeReads || 0) + 1;
        }
        // (c) PRE-VALIDATE GUARD (deterministic backstop the prompt can't be talked
        // out of). The order form AUTO-validates on input and renders the SERVER's
        // dry-run verdict. When the agent is about to click "Validate (dry-run)", run
        // that same validation in-page and read the verdict: if it ALREADY rejects,
        // hand the agent the exact reasons and SKIP the wasted click (a guaranteed-
        // reject Validate + its follow-up read burns ~2 steps). FAIL-OPEN: on accepted
        // / non-Validate click / unreadable / any error, do nothing and let the click
        // proceed (never a false block; the server remains the hard backstop).
        if (name === "click_element" && args && args.selector && !ctx.liveTradingPackInjected) { // MM pass 2 S7: paper page only
          let pre = null;
          try {
            const [vtab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (vtab && vtab.id != null) {
              const [r] = await chrome.scripting.executeScript({
                target: { tabId: vtab.id }, world: "MAIN",
                func: __lcPreValidateDayTrading, args: [String(args.selector)]
              });
              pre = r && r.result;
            }
          } catch { /* fail-open */ }
          if (pre && pre.rejected) {
            const g = { error: `PRE-VALIDATE (saved a wasted Validate click): the dry-run ALREADY REJECTS this order — ${pre.text} ── Do NOT re-click Validate. If the blockers are sizing (OVERSIZE / RISK_TOO_HIGH), the server's rejection text includes "resubmit with qty=N (server-computed max)" — use EXACTLY that N as the new quantity (do NOT recompute your own qty; your formula produced the rejected number). If it says "no valid qty passes the caps — NO-TRADE this symbol", ABANDON the symbol (no resubmit). If neither phrase is present, re-size with the PACK'S sizing formula (risk_budget and notional cap as stated in the pack — do not use any other formula). For RR_TOO_LOW fix the target (never widen the stop), then try ONCE more. If the blockers are MAX_POSITIONS or DUPLICATE_SYMBOL, that is a NO-TRADE this cycle — do NOT retry and do NOT close existing positions to make room.` };
            post({ type: "tool", name, args });
            post({ type: "tool_result", name, result: g, stepIndex: steps.length, runId });
            messages.push({ role: "tool", name, content: JSON.stringify(g) });
            steps.push({ tool: name, args: redactArgs(name, args), error: g.error.slice(0, 160) });
            continue;
          }
        }
      }

      let result;
      // "Ask before acting": pause for user approval on state-changing tools.
      // Irreversible tools (delete) ALWAYS pause, regardless of the act mode.
      // A move/copy with overwrite:true REPLACES an existing file — destructive,
      // so it always pauses too (plain moves/copies are reversible and don't).
      const destructiveOverwrite = (name === "move_file" || name === "copy_file") && args && args.overwrite === true;
      // http_request: a GET is read-only (no forced prompt); any other method
      // CHANGES remote state, so it always pauses like a write.
      const mutatingHttp = name === "http_request" && !["GET", "HEAD"].includes(String(args && args.method || "GET").toUpperCase());
      if ((ACTION_TOOLS.has(name) || navLike) && !APPROVAL_EXEMPT_TOOLS.has(name) && (ALWAYS_CONFIRM_TOOLS.has(name) || destructiveOverwrite || mutatingHttp || (await getActMode()) === "ask")) {
        const approved = await askApproval(name, args);
        if (signal.aborted) {
          post({ type: "aborted" });
          return { status: "aborted", steps, runId };
        }
        if (!approved) {
          post({ type: "tool", name, args });
          result = { error: "User DENIED this action. Do not retry it. Ask the user how they want to proceed, or take a different approach." };
          // stepIndex = the slot this step will occupy in steps[] (for C.5 per-step feedback).
          post({ type: "tool_result", name, result, stepIndex: steps.length, runId });
          messages.push({ role: "tool", name, content: JSON.stringify(result) });
          steps.push({ tool: name, args: redactArgs(name, args), denied: true });
          ctx._pendingTestNote = null; // a denied create never happened — its gate note must not attach to the next one (MM 09-04 pass 2 C8)
          continue;
        }
      }

      // M1 budget guard: clamp read_page on a real-money M1 run so a huge page can't
      // blow the local context window (a contributor to the overflow hang). The M1
      // insight workflow needs the holdings table, not the whole marketing-laden DOM.
      if (ctx.m1ReadOnly && name === "read_page") {
        const cap = 8000;
        const req = Number(args.max_chars);
        if (!Number.isFinite(req) || req > cap) args.max_chars = cap;
      }
      post({ type: "tool", name, args });
      try {
        // abortableRace: if the user hits Stop while this tool is in flight (a hung
        // read_page whose page never responds), reject NOW instead of waiting for the
        // tool's own timeout — Stop must feel instant. Any non-abort error becomes a
        // normal tool-error result the model can react to and continue from.
        result = await abortableRace(
          executeTool(name, args, { settings, signal, subScope: ctx.subScope, snInstance: ctx.snInstance,
            readOnly: !!ctx.readOnly, m1ReadOnly: !!ctx.m1ReadOnly, isChild: !!ctx.isChild, liveTradingPackInjected: ctx.liveTradingPackInjected === true }), // pins reach the executor (MM 09-09 H-2a; live flag MM pass 2 S3)
          signal
        );
      } catch (e) {
        if (e && (e.name === "AbortError" || signal.aborted)) {
          post({ type: "aborted" });
          return { status: "aborted", steps, runId };
        }
        result = { error: e.message };
      }
      // Remember whether THIS signature's latest REAL result was an error, so a
      // later repeat refusal can say "this call FAILED N times with: …" instead
      // of claiming the content was read (2026-09-07c, Records-folder run).
      // Refusals `continue` above this point, so they never overwrite it.
      // A url-targeted read_page navigates too (2026-09-09), so it moves the page key the
      // way navigate does — but only once the read is PROVEN (result without error). A
      // refused or mismatched read must not re-key the page (MM 09-09 P3).
      if (name === "read_page" && args && args.url && result && !result.error && result.read !== false) { ctx._pageKey = String(result.redirected_to || result.url || args.url); ctx._domEpoch = 0; }
      // A file write that returned ok becomes a RECEIPT for later runs (MM pass 2 B-3).
      if (result && !result.error && result.ok !== false && (name === "write_file" || name === "create_document" || name === "edit_file" || name === "move_file" || name === "copy_file")) {
        // move/copy: the tool's RESOLVED destination (a directory target becomes dir/name), not args.to (N-4).
        const wp = name === "move_file" || name === "copy_file"
          ? [result.to || (args && args.to)]
          : [result.path || (args && args.path)];
        const root = String(result.root || "");
        const entries = wp.filter(Boolean).map((x) => ({ p: String(x), root }));
        recordWriteReceipts(entries);
        if (!Array.isArray(ctx.writeReceipts)) ctx.writeReceipts = [];
        ctx.writeReceipts.push(...entries);
      }
      if (!ctx._sigLastErr) ctx._sigLastErr = new Map();
      {
        const errText = result && result.error ? String(result.error) : null;
        ctx._sigLastErr.set(callSig, errText);
        if (cycleSig != null) ctx._sigLastErr.set(cycleSig, errText);
      }
      // UNCHANGED-PAGE SHORT-CIRCUIT (2026-07-22 dashboard transcript: 22 tool
      // calls to open one folder; several read_page results were byte-identical,
      // each re-ingesting the full page text for zero new information). If a
      // read_page returns the SAME url+title+text as the previous read_page,
      // collapse the payload to a tiny "unchanged" notice — the full text is
      // already in the conversation. The notice also tells the model WHY the
      // re-read was pointless: an intervening click that left the page identical
      // means the click had no visible effect.
      if (name === "read_page" && result && !result.error && typeof result.text === "string") {
        let h = 5381;
        const s = String(result.url || "") + " " + String(result.title || "") + " " + result.text;
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        const pageSig = h + ":" + s.length;
        if (ctx._lastPageSig === pageSig) {
          result = {
            unchanged: true, url: result.url, title: result.title,
            // Name what was ASKED for as well as what was read (2026-09-09): the
            // competitive-intel run got `url: northwind-pricing` for a page it never opened.
            ...(args && args.url && String(args.url) !== result.url ? { requested_url: String(args.url) } : {}),
            ...(result.redirected_to ? { redirected_to: result.redirected_to } : {}), ...(result.landed_url ? { landed_url: result.landed_url } : {}), // keep the redirect facts (MM pass 2 B-1)
            note: "Page is IDENTICAL to your previous read_page result — nothing changed; the full text is already in the conversation above. Do NOT call read_page again." +
              (ctx._prevToolName === "click_element"
                ? " Your last click had NO visible effect — do NOT repeat it. Pick a DIFFERENT element from query_elements, or navigate(url) directly if you know the target URL."
                : " Act on what you already have, or take a genuinely different action (query_elements with a precise selector+text filter, navigate, scroll_page). Never click Refresh/Re-scan to 'fix' navigation.")
          };
        } else {
          ctx._lastPageSig = pageSig;
        }
      }
      // SAME-PDF SHORT-CIRCUIT (2026-07-23 HealthScan run: read_pdf was called
      // 4× on one file — twice with IDENTICAL args, re-ingesting 12K chars for
      // zero new information). Identical file + cap + payload → tiny notice
      // with the exact next action instead of the full text again.
      if (name === "read_pdf" && result && !result.error && typeof result.text === "string") {
        const pdfSig = String(result.path || result.url || "") + "|" + (args.max_chars ?? "default") + "|" + result.text.length;
        if (ctx._lastPdfSig === pdfSig) {
          result = {
            unchanged: true, path: result.path || result.url, pages: result.pages, chars: result.chars,
            note: "IDENTICAL to your previous read_pdf result — that text is already in the conversation above; do NOT re-read it. " +
              (result.truncated
                ? `To get the REST of the document, re-call read_pdf with max_chars: ${(result.chars || 0) + 2000}.`
                : "You already have the COMPLETE document — extract what you need from the text above and continue the task.")
          };
        } else {
          ctx._lastPdfSig = pdfSig;
        }
      }
      // Instance write ledger + test-record outcomes (2026-09-04) — see snNoteWrite.
      try {
        snNoteWrite(ctx, name, args, result);
        if (name === "sn_create_record" && ctx._pendingTestNote && result && !result.error) {
          result.note = (result.note ? result.note + " " : "") + ctx._pendingTestNote;
        }
        ctx._pendingTestNote = null;
      } catch {}
      ctx._prevToolName = name;
      post({ type: "tool_result", name, result, stepIndex: steps.length, runId });
      // Phase engine (§3.5.1): record evidence in the CODE-built ledger and hand
      // the model the entry id (`_ev`) so it can emit [E<n>:path=value] citation
      // tokens the deterministic invariant later validates. Standalone runs are
      // untouched (evId stays null → identical message payload).
      const evId = embedded ? recordEvidence(embedded.evidenceLedger, name, args, result) : null;
      // MM impl-review must-fix #1: `_cite` is now the list of COMPLETE,
      // copyable token strings (engine-built — the model never serializes a
      // token itself; long/multi-line/bracket values are pre-forced to
      // path-only form). Placed FIRST in the payload so the TOOL_RESULT_MAX_CHARS cut
      // can only ever truncate the raw result tail, never the tokens.
      let toolPayload;
      if (evId) {
        const entry = embedded.evidenceLedger[embedded.evidenceLedger.length - 1];
        toolPayload = JSON.stringify({ _ev: evId, _cite: buildCiteTokens(entry, 60), ...result });
      } else {
        toolPayload = JSON.stringify(result);
      }
      messages.push({ role: "tool", name, content: capToolPayload(toolPayload) });
      steps.push({
        tool: name,
        args: redactArgs(name, args),
        ok: !result?.error,
        error: result?.error ? String(result.error).slice(0, 160) : undefined,
        method: name === "http_request" ? String((args && args.method) || "GET").toUpperCase() : undefined, // for the grounding ledger (B-9)
        // The page a navigation/read targeted, kept whole: redactArgs keeps only 160 chars of the
        // args, which dropped long urls from the web-research audit (MM pass 3, N-11).
        url: (name === "navigate" || name === "read_page" || name === "fetch_page") && args && args.url ? persistableUrl(args.url) : undefined,
        verified: result?.verified
      });
      // CONVERGENCE TRACKING: a tool result that carries no usable data (an error,
      // or a query that matched nothing) tells the model nothing new. The a customer
      // workflow run kept re-querying for a group that didn't exist (count:0 over
      // and over) and never converged. Count consecutive fruitless results; any
      // result that DID return data resets the streak.
      const fruitless = !!result?.error || result?.count === 0 ||
        (Array.isArray(result?.records) && result.records.length === 0);
      ctx._emptyStreak = fruitless ? (ctx._emptyStreak || 0) + 1 : 0;
    }

    // C.6 Phase 2: run this turn's accepted sub-agents — concurrently when the
    // user has raised Sub-agent concurrency, otherwise strictly one at a time
    // (Phase 1 behavior). Inference stays globally serialized by the model lock;
    // concurrency only pipelines the children's DOM/IO. Results are appended to
    // messages/steps in spawn order so the conversation stays deterministic.
    if (acceptedSpawns.length) {
      const concurrency = Math.min(settings.subagentConcurrency || 1, MAX_SUBAGENT_CONCURRENCY);
      const outcomes = await runSubagents(acceptedSpawns, { parentCtx: ctx, post, signal, askApproval, concurrency });
      for (const { args, result } of outcomes) {
        post({ type: "tool_result", name: "spawn_subagent", result, stepIndex: steps.length, runId });
        messages.push({ role: "tool", name: "spawn_subagent", content: capToolPayload(JSON.stringify(result)) });
        steps.push({ tool: "spawn_subagent", args: redactArgs("spawn_subagent", args), ok: !result?.error, error: result?.error ? String(result.error).slice(0, 160) : undefined });
        // A child's writes are receipts the parent can restate (MM pass 3, N-11).
        try {
          await _receiptChain.catch(() => {}); // let this run's own pending receipts flush first
          const fresh = await loadWriteReceipts();
          const own = Array.isArray(ctx.writeReceipts) ? ctx.writeReceipts : [];
          ctx.writeReceipts = fresh.concat(own.filter((o) => !fresh.some((f) => f.p === o.p && f.root === o.root)));
        } catch {}
      }
      if (signal.aborted) { post({ type: "aborted" }); return { status: "aborted", steps, runId }; }
    }

    // End-of-step CLEAN boundary: assistant message + all its tool results are
    // now in `messages`. Persist so an eviction here resumes from the next step
    // without replaying any tool. (See run-state.js for the at-least-once note.)
    await checkpoint(step + 1, nudged);
  }

  // Step cap reached. Rather than dead-ending with no result, make ONE best-effort
  // summarization turn (NO tools) from what was already gathered — this salvages a
  // capped run AND a capped sub-agent (which would otherwise return an empty result).
  if (!signal.aborted && steps.length > 0) {
    messages.push({
      role: "user",
      content: "You have reached your step limit — do NOT call any tool. Using ONLY the information you already gathered above, write your best final answer now in plain text. If it is incomplete, give what you have and briefly note what was missing. Do not invent anything."
    });
    post({ type: "assistant_start" });
    let capText = "";
    try {
      ({ content: capText } = await withModelLock(() => chatStream({
        base: settings.ollamaBase, model: agentModel, settings, messages, tools: [],
        options: fittedOllamaOptions(settings, messages, [], post),
        signal, onToken: (delta) => post({ type: "token", delta })
      })));
    } catch (e) {
      if (e.name === "AbortError" || signal.aborted) { post({ type: "aborted" }); return { status: "aborted", steps, runId }; }
    }
    post({ type: "assistant_end" });
    if (capText && capText.trim()) {
      if (!isChild && !embedded) {
        const negatives = steps.filter((s) => s.error || s.denied).length;
        const positives = steps.filter((s) => s.verified === true).length;
        await saveTrajectory({
          id: runId, ts: Date.now(), task: taskText.slice(0, 400), steps,
          finalText: capText.slice(0, 300), autoScore: positives - negatives,
          feedback: null, usedLessons: (lessons || []).map((l) => l.id)
        });
        await clearRunState();
      }
      emitFsAudit(steps, post); // ground-truth evidence line (if the folder was used)
      emitSnWriteAudit(ctx, post); // ground-truth list of records created on the instance (2026-09-04)
      emitWebAudit(steps, post); // ground-truth web-research line (if web_search ran)
      if (embedded) {
        // BL-2: a capped-but-salvaged draft still goes through the gates.
        return { status: "final", finalText: capText, steps, runId,
          evidenceLedger: embedded.evidenceLedger, modelIdentity: `${activeProvider(settings)}:${agentModel}` };
      }
      capText = runGroundingGuard(capText, steps, ctx, post);
      post({ type: "final", text: capText, runId });
      return { status: "final", finalText: capText, steps, runId };
    }
  }

  // No salvageable answer — surface the cap. (Embedded: the phase engine
  // surfaces the failure; don't double-post or touch the standalone snapshot.)
  if (!isChild && !embedded) await clearRunState();
  if (!embedded) post({ type: "error", text: `Stopped after ${cap} steps (step limit reached — set Max agent steps to 0 in Settings for unlimited).` });
  return { status: "capped", steps, runId };
}

// Child tool list once (MF-3 + MF-10): no spawn_subagent (recursion depth = 1) and
// no close_tab (a child must not close a user's tab; the orchestrator cleans up).
const CHILD_TOOLS = TOOLS.filter((t) => {
  const n = t.function && t.function.name;
  return n !== "spawn_subagent" && n !== "close_tab" && n !== "create_shortcut";
});

// C.6 Phase 2 ORCHESTRATOR: run this turn's accepted sub-agents and return their
// results aligned to the input order. With concurrency=1 (default) it is exactly
// the Phase 1 sequential loop. With concurrency>1 children pipeline under a bounded
// pool; a shared `tabGuard` keeps ≤1 child driving any single tab, and the global
// model lock (model-lock.js) keeps inference serialized regardless. One child
// throwing never sinks its siblings — its slot resolves to a structured error.
async function runSubagents(specs, { parentCtx, post, signal, askApproval, concurrency }) {
  const tabGuard = new Map(); // tabId -> tail promise (per-tab serialization)
  // ENFORCED ISOLATION: in a fan-out (2+ children) every child that didn't get an
  // explicit tab gets its OWN fresh tab, so siblings can never share/override one
  // tab (which corrupts their pages — e.g. one child's navigate clobbering another).
  const forceNewTab = specs.length > 1;
  const runOne = async (spec) => {
    if (signal.aborted) {
      return { args: spec.args, result: { ok: false, child: "child" + spec.childIndex, status: "aborted", error: "stopped before this sub-agent started" } };
    }
    let result;
    try {
      result = await runChild({ parentCtx, args: spec.args, post, signal, askApproval, childIndex: spec.childIndex, resultCap: spec.resultCap, tabGuard, forceNewTab });
    } catch (e) {
      result = { ok: false, child: "child" + spec.childIndex, status: "error", error: String(e?.message || e) };
    }
    return { args: spec.args, result };
  };

  if (concurrency <= 1 || specs.length <= 1) {
    const out = [];
    for (const spec of specs) out.push(await runOne(spec)); // strictly sequential
    return out;
  }
  return runPooled(specs, concurrency, runOne); // ordered bounded pool (concurrency.js)
}

// C.6 (SEQUENTIAL per child): run ONE sub-agent to completion and return a capped,
// structured result. A child is a fresh agentLoop with its own message stack
// (num_ctx isolation), bound to a specific tab (MF-1), with checkpoint/trajectory
// suppressed (MF-2), no recursion (MF-4), a finite step budget (MF-5), and its
// events/approvals namespaced by childId (MF-6).
// First http(s) URL appearing in free text (used to pre-navigate an enforced
// isolation tab to the page the child's task is about).
function firstUrlIn(text) {
  const m = String(text || "").match(/https?:\/\/[^\s"'<>)\]]+/i);
  return m ? m[0] : null;
}

// Derive a tab-matching hint from a child's task text when it NAMES a site/instance
// but gives no URL (e.g. "the logged-in dev000000 tab"). Prefers a full
// *.service-now.com host, then a ServiceNow-style instance shortname (dev/test/
// demo/empNNNN). Returns a lowercase substring to match against open tabs, or null.
function deriveTabHint(task) {
  const t = String(task || "");
  let m = t.match(/\b([a-z0-9][a-z0-9-]*\.service-now\.com)\b/i);
  if (m) return m[1].toLowerCase();
  m = t.match(/\b((?:dev|test|demo|emp|empabc)\d{3,})\b/i);
  if (m) return m[1].toLowerCase();
  return null;
}

// Find an ALREADY-OPEN tab whose http(s) URL/host contains `hint` (case-insensitive).
// Used to bind a child to an existing instance/site tab instead of opening a blank
// one or trusting a hallucinated numeric tab id. Returns the chrome.tabs.Tab or null.
async function matchOpenTabByHint(hint) {
  const h = String(hint || "").toLowerCase().trim();
  if (!h) return null;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return null; }
  const httpTabs = tabs.filter((t) => /^https?:\/\//i.test(String(t.url || "")));
  // Prefer a hostname match; fall back to a full-URL substring match.
  const byHost = httpTabs.find((t) => { try { return new URL(t.url).hostname.toLowerCase().includes(h); } catch { return false; } });
  if (byHost) return byHost;
  return httpTabs.find((t) => String(t.url).toLowerCase().includes(h)) || null;
}

async function runChild({ parentCtx, args, post, signal, askApproval, childIndex, resultCap, tabGuard, forceNewTab }) {
  const settings = parentCtx.settings;
  const childId = "child" + childIndex;
  const childRunId = parentCtx.runId + "." + childId;

  // ---- resolve the child's tab (MF-1) ----
  // Flat scope params (scope_url / scope_tab_id). validateArgs already folds any
  // legacy nested { scope:{url,tabId} } into these, but fall back defensively too.
  const scopeUrl = args.scope_url ?? (args.scope && args.scope.url);
  const scopeTabId = args.scope_tab_id ?? (args.scope && args.scope.tabId);
  const scopeTabMatch = args.scope_tab_match ?? (args.scope && args.scope.match);
  // ServiceNow instance to target WITHOUT a tab (its sn_* tools use stored creds).
  const scopeInstance = args.scope_instance ?? (args.scope && args.scope.instance) ?? "";
  // Pre-resolve an explicit scope_tab_id: if it doesn't exist (models sometimes
  // INVENT ids like 1,2,3 from "Sub-agent 1/2/3"), DON'T hard-fail — fall through to
  // matching the tab by an instance/host hint derived from the task. (UAT 2026-06-21:
  // 5 children all died on "No tab with id: 1..5" because the model guessed ids.)
  let scopeTab = null;
  if (scopeTabId != null) { try { scopeTab = await chrome.tabs.get(Number(scopeTabId)); } catch { scopeTab = null; } }
  // Explicit match hint, else one derived from the task text (e.g. "dev000000").
  const tabHint = scopeTabMatch || deriveTabHint(args.task);
  const matchedTab = (!scopeUrl && !scopeTab && tabHint) ? await matchOpenTabByHint(tabHint) : null;
  // createdTab = we opened it; keepOpen = leave it open after the child finishes.
  // Every tab a child OPENS persists (keepOpen=true) so the user keeps each child's
  // workspace — e.g. 5 sub-agents logging into 5 instances leaves all 5 tabs open
  // side by side. (Previously scope_url tabs were treated as ephemeral and closed in
  // finally, so each login flashed open then vanished, leaving 0–1 tabs. Bug fixed.)
  // preloaded=false: the pre-navigation's budget ran out with the page still
  // arriving (slow server). The child is told, so its first navigate RESUMES the
  // in-flight load instead of restarting it (2026-09-07 six-instance login run).
  let tabId = null, createdTab = false, keepOpen = false, preloaded = true;
  try {
    if (scopeUrl) {
      const t = await chrome.tabs.create({ url: String(scopeUrl), active: false });
      tabId = t.id; createdTab = true; keepOpen = true;
      preloaded = await waitForLoad(tabId, loadBudgetMsFor(scopeUrl));
    } else if (scopeTab) {
      tabId = scopeTab.id; // real, existing tab id
    } else if (matchedTab) {
      tabId = matchedTab.id; // bound to an already-open instance/site tab (not closed)
    } else if (scopeInstance) {
      tabId = null; // tab-free SN child: its sn_* tools target the instance via stored creds
    } else if (forceNewTab || firstUrlIn(args.task)) {
      // Enforced isolation: give this child its OWN new tab so siblings never share/
      // override one tab. Two triggers:
      //   1. forceNewTab — 2+ children spawned in the SAME turn (classic fan-out).
      //   2. the task names a specific URL — covers the model spawning children ONE
      //      PER TURN (forceNewTab is false each turn). Without this they'd ALL fall
      //      through to the active tab and just navigate it to different URLs,
      //      clobbering each other (symptom: "5 logins, only 1 tab").
      // Pre-navigate to the URL in its task if there is one; otherwise open a blank
      // tab and let the child navigate. Persist it so the user keeps each workspace.
      const url = firstUrlIn(args.task);
      const t = await chrome.tabs.create({ url: url || "about:blank", active: false });
      tabId = t.id; createdTab = true; keepOpen = true;
      if (url) preloaded = await waitForLoad(tabId, loadBudgetMsFor(url));
    } else if (parentCtx.subScope && parentCtx.subScope.tabId != null) {
      tabId = parentCtx.subScope.tabId; // inherit the parent's bound tab if any
    } else {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tabId = t ? t.id : null;
    }
  } catch (e) {
    return { ok: false, child: childId, error: `Could not open/resolve the sub-agent's tab: ${e.message}` };
  }

  // ---- per-tab guard (Phase 2): ≤1 child drives a given tab at a time ----
  // Concurrent siblings bound to the SAME tab (e.g. several defaulting to the
  // active tab, which share one content script) would race the DOM, so we chain
  // them through a per-tab promise. Children on distinct tabs — the real fan-out
  // win, especially scope.url which always gets a fresh tab — never wait here.
  let releaseTabSlot = () => {};
  if (tabGuard && tabId != null) {
    releaseTabSlot = await acquireKeyedSlot(tabGuard, tabId);
    if (signal.aborted) {
      releaseTabSlot();
      if (createdTab && tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} }
      return { ok: false, child: childId, status: "aborted", error: "stopped" };
    }
  }

  // ---- child system prompt with the BOUND-TAB ground truth (MF-8) ----
  // The tab/origin block is normally injected in runAgent (not agentLoop), so a
  // directly-invoked child would otherwise reason about the wrong tab.
  let tabUrl = "";
  try { if (tabId != null) tabUrl = (await chrome.tabs.get(tabId)).url || ""; } catch {}
  let childSystem = SYSTEM_PROMPT +
    "\n\nYOU ARE A SUB-AGENT. Do ONLY the delegated task below — nothing more. Return ONLY the requested result as your final plain-text message; do not chat, ask questions, or attempt to spawn further sub-agents (you cannot)." +
    "\n\nEFFICIENCY — you have a SMALL step budget, so be decisive: call read_page ONCE, then immediately WRITE your answer from what it returned. Do NOT scroll repeatedly, re-read the same page, click 'Download'/PDF/'Read more' links, or hunt for elements — a single read_page is almost always enough to summarize an article. If read_page already shows the content, summarize it NOW as your final plain-text answer instead of taking another tool step." +
    "\n\n" + currentDateLine();
  if (/^https?:\/\//i.test(tabUrl)) {
    let origin = ""; try { origin = new URL(tabUrl).origin; } catch {}
    childSystem +=
      `\n\nYOUR BOUND TAB (act ONLY on this tab — ground truth, never guess a different domain):\n- URL: ${tabUrl}\n` +
      (origin ? `- Origin: ${origin}\n` : "") +
      (preloaded ? "" : `- STATUS: that page is STILL LOADING (slow server — it has not finished arriving). Your FIRST step must be navigate with exactly that URL: it waits for the in-flight load without restarting it. Do not read, click, screenshot, or reload before navigate returns ok:true; if navigate reports still_loading twice, report the site as not responding and stop.\n`);
  }
  if (scopeInstance) {
    childSystem +=
      `\n\nYOUR SERVICENOW INSTANCE: "${scopeInstance}". Your sn_* tools (sn_query_table / sn_query_record / sn_query_schema / sn_update_record) automatically target this connected instance via stored credentials — you do NOT need an open tab. Do not pass a different instance.`;
  }
  // Inherit the parent's connected-folder ground truth (Filesystem MCP) so a
  // delegated sub-task that needs local files reads them instead of guessing.
  const fsInfo = parentCtx && parentCtx.fsInfo;
  if (fsInfo && fsInfo.connected && fsInfo.root) {
    const _cr = Array.isArray(fsInfo.roots) && fsInfo.roots.length ? fsInfo.roots : [{ name: fsInfo.root }];
    childSystem += _cr.length > 1
      ? `\n\nCONNECTED LOCAL FOLDERS (Filesystem MCP): ${_cr.length} folders are connected — ${_cr.map((r) => `"${r.name}"`).join(", ")}; read them with \`list_files\`/\`read_file\`, PREFIXING each path with the folder name (e.g. read_file "${_cr[0].name}/file"). If your task involves local files/code/context, read the relevant files FIRST and ground your result in their ACTUAL contents — never invent names or contents. CITE the exact file path(s) you read (with folder prefix) in your returned result.`
      : `\n\nCONNECTED LOCAL FOLDER (Filesystem MCP): a local folder named "${fsInfo.root}" is mounted read${fsInfo.canWrite ? "/write" : "-only"}; read it with \`list_files\`/\`read_file\` (paths RELATIVE to the root). If your delegated task involves these files, code, or local context, read the relevant files FIRST and ground your result in their ACTUAL contents — do not invent file names or contents. CITE the exact file path(s) you read as your source of truth in your returned result, so the parent can attribute the evidence.`;
  }
  const expectHint = args.expect ? `\n\nReturn format: ${String(args.expect).slice(0, 500)}` : "";
  const childMessages = [
    { role: "system", content: childSystem },
    { role: "user", content: String(args.task) + expectHint }
  ];

  // ---- namespaced post + approval so the panel routes child events (MF-6) ----
  const childPost = (m) => post({ ...m, childId });
  const childAskApproval = (n, a) => askApproval(n, a, { childId, childTask: String(args.task).slice(0, 120) });

  // Sub-agent M1 re-evaluation (defense-in-depth, toggle-independent): if the child is
  // bound to a dashboard.m1.com tab, lock it read-only even if the PARENT wasn't an M1
  // run — real-money safety must never depend on the parent's mode. (The executor
  // target-tab guard also covers this; this keeps the child's tool SCHEMA navless too.)
  let childM1ReadOnly = !!parentCtx.m1ReadOnly;
  let childLiveReadOnly = false; // REAL-MONEY: a child bound to live-trading.html never writes (MM 6aa484e7 P4)
  if (!childM1ReadOnly) { // MM pass 3 L7: an UNBOUND child inherits the active tab's real-money pin too
    try { const bt = tabId != null ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]; if (bt && isM1DashboardUrl(bt.url)) childM1ReadOnly = true; if (bt && needsLiveTradingPack(bt.url)) childLiveReadOnly = true; } catch { /* tab gone — fall back to parent flag */ }
  }

  let ret;
  try {
    ret = await agentLoop({
      messages: childMessages,
      steps: [],
      settings,
      agentModel: parentCtx.agentModel,
      post: childPost,
      signal,                         // shared abort — Stop cancels the whole tree
      askApproval: childAskApproval,
      runId: childRunId,
      taskText: String(args.task),
      lessons: [],
      startStep: 0,
      startNudged: false,
      isChild: true,                  // MF-2
      subScope: { tabId },            // MF-1
      snInstance: scopeInstance || undefined, // tab-free SN instance targeting
      allowSubagents: false,          // MF-4
      tools: childM1ReadOnly
        ? CHILD_TOOLS.filter((t) => M1_SAFE_TOOL_NAMES.has(t.function && t.function.name) && (t.function && t.function.name) !== "navigate") // M1: navless fail-closed allowlist for children (defense-in-depth; spawning is already blocked in M1 mode)
        : ((parentCtx.readOnly || childLiveReadOnly) ? CHILD_TOOLS.filter((t) => !ACTION_TOOLS.has(t.function && t.function.name)) : CHILD_TOOLS), // MF-3 + MF-10 (+ read-only; live-bound child MM pass 2 S6)
      readOnly: parentCtx.readOnly || childM1ReadOnly || childLiveReadOnly,   // children inherit read-only enforcement (+ M1 tab → forced)
      snInstanceReadOnly: parentCtx.snInstanceReadOnly || null, // children inherit the instance read-only pin (standing grant)
      m1ReadOnly: childM1ReadOnly, // child M1 pin: parent's OR its own bound M1 tab
      maxStepsOverride: (args.max_steps != null ? args.max_steps : 8), // MF-5
      childId
    });
  } catch (e) {
    ret = { status: "error", error: e.message };
  } finally {
    releaseTabSlot(); // free the per-tab guard so the next child on this tab can run
    // Close only ephemeral (explicit scope_url) tabs; enforced-isolation tabs persist.
    if (createdTab && !keepOpen && tabId != null) { try { await chrome.tabs.remove(tabId); } catch {} } // MF-10 cleanup
  }

  // ---- capped, structured result fed back to the parent (MF-9) ----
  const status = ret && ret.status;
  let text = (ret && ret.finalText) || "";
  const cap = resultCap || 4096;
  const truncated = text.length > cap;
  if (truncated) text = text.slice(0, cap) + " …[truncated]";
  return {
    ok: status === "final",
    child: childId,
    task: String(args.task).slice(0, 200),
    status: status || "unknown",
    result: text,
    steps: (ret && ret.steps && ret.steps.length) || 0,
    truncated: truncated || undefined,
    error: status === "final"
      ? undefined
      : (ret && ret.error) ||
        (status === "aborted" ? "sub-agent was stopped" :
         status === "capped" ? "sub-agent hit its step budget before finishing" :
         "sub-agent produced no result")
  };
}

// Resume a previously-checkpointed run from its durable snapshot. Re-feeds the
// saved conversation to the model and continues — does NOT replay executed tools.
async function resumeAgent(post, signal, askApproval, drainSteer) {
  const settings = await getSettings();
  Object.assign(settings, await getCloudCreds()); // cloud keys for the dispatcher (see runAgent)
  settings.paperOrderSubmissionEnabled = await getSubmitEnabled(); // Phase 4 kill-switch (see runAgent)
  settings.liveOrderSubmissionEnabled = await getLiveSubmitEnabled(); // REAL-MONEY kill-switch (see runAgent)

  // PHASE-AWARE RESUME (Tier 3): a phased run persists to phaseRun/phaseData
  // (NOT activeRun). If an interrupted phased run left a completed draft +
  // ledger, continue it through the GATES without re-running the expensive
  // EXECUTE. If the interruption was before EXECUTE finished (no draft), fall
  // through to a normal message — there's nothing cheap to resume.
  const phaseSaved = await loadPhaseState();
  if (phaseSaved) {
    // Best-effort domain grounding for the resumed gates (buildServiceNowPack
    // returns the pack TEXT directly, and self-falls-back to the bundled pack).
    let domainPackText = phaseSaved.data?.system || null; // the persisted system prompt already carries the pack
    try { if (!domainPackText && settings.snPackEnabled) domainPackText = await buildServiceNowPack(settings, phaseSaved.envelope?.taskText || ""); } catch { /* best-effort */ }
    let fsInfo = null;
    try { fsInfo = await chrome.runtime.sendMessage({ type: "fs_status" }).catch(() => null); } catch { fsInfo = null; }
    post({ type: "resumed", step: 0, task: phaseSaved.envelope?.taskText || "(phase run)" });
    const loopCtx = {
      messages: phaseSaved.data?.system ? [{ role: "system", content: phaseSaved.data.system }] : [{ role: "system", content: "" }],
      steps: [], settings,
      agentModel: phaseSaved.envelope?.agentModel || settings.model,
      post, signal, askApproval,
      runId: phaseSaved.envelope?.runId || ("resume-" + (phaseSaved.envelope?.savedAt || 0)),
      taskText: phaseSaved.envelope?.taskText || "",
      lessons: [], domainPack: domainPackText, fsInfo,
      liveTradingPackInjected: await (async () => { try { const [a] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return !!(a && needsLiveTradingPack(a.url)); } catch { return false; } })() // MM 6aa484e7 P1
    };
    const res = await withRunKeepalive(() => resumePhased({ agentLoop, chatStream, withModelLock, activeProvider }, loopCtx, phaseSaved));
    if (res.resumed) return;
    await clearPhaseState(); // couldn't resume (interrupted pre-EXECUTE) — clear the stale envelope
    post({ type: "error", text: "The interrupted phase run had no completed draft to resume (it stopped during planning/gathering). Please re-run the task." });
    return;
  }

  const state = await loadRunState();
  if (!state) {
    post({ type: "error", text: "Nothing to resume — the previous run already finished, was superseded, or expired." });
    return;
  }
  // Re-probe the connected folder so children spawned AFTER resume still inherit
  // it (the parent's own block is already persisted in state.messages[0]).
  let fsInfo = null;
  try { fsInfo = await chrome.runtime.sendMessage({ type: "fs_status" }).catch(() => null); } catch { fsInfo = null; }
  post({ type: "resumed", step: state.step, task: state.taskText });
  // Restore the M1 safety pin (review BLOCKER 1): the persisted snapshot value OR'd
  // with a fresh re-derivation from the CURRENT active tab (the tab may have moved /
  // been redirected to /login during the eviction window). Without this, a resumed
  // M1 run would fall back to the full tool set and revert to prompt-only safety.
  let m1ReadOnly = !!state.m1ReadOnly;
  let readOnly = !!state.readOnly;
  let liveResumed = state.liveTradingPackInjected === true; // REAL-MONEY pack flag survives MV3 eviction (MM 6aa484e7 P1)
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && isM1DashboardUrl(active.url)) m1ReadOnly = true;
    if (active && needsLiveTradingPack(active.url)) liveResumed = true; // live tab active ⇒ live run, whatever the checkpoint said // toggle-INDEPENDENT: a resumed run on dashboard.m1.com is read-only regardless of the M1 toggle
  } catch { /* tabs query unavailable — fall back to the persisted pin */ }
  if (m1ReadOnly) readOnly = true;
  await withRunKeepalive(() => agentLoop({
    messages: state.messages,
    steps: state.steps || [],
    settings,
    agentModel: state.agentModel || settings.model,
    post, signal, askApproval,
    runId: state.runId,
    taskText: state.taskText || "",
    lessons: (state.lessonIds || []).map((id) => ({ id })), // only ids matter (for usedLessons)
    startStep: state.step || 0,
    startNudged: !!state.nudged,
    allowSubagents: !m1ReadOnly, // resumed run may delegate — but NEVER on a real-money M1 run
    tools: m1ReadOnly ? M1_SAFE_TOOLS_NAV : (readOnly ? READ_ONLY_TOOLS : undefined), // re-apply the fail-closed pin (read tools + allowlisted navigate)
    readOnly,
    snInstanceReadOnly: state.snInstanceReadOnly || null, // restore the instance read-only pin across MV3 eviction
    executePlan: !!state.executePlan, // grounding guard inputs restored (MM pass 2 B-3)
    prevAssistantText: state.prevAssistantText || "",
    startGroundNudged: !!state.groundNudged, // the one-shot grounded retry stays one-shot across a resume (N-13)
    ...(typeof state.tradingPackInjected === "boolean" ? { tradingPackInjected: state.tradingPackInjected } : {}), // 09l: restored, absent stays unknown
    liveTradingPackInjected: liveResumed, // REAL-MONEY pack survives MV3 eviction (MM 6aa484e7 P1)
    m1ReadOnly,
    drainSteer, // steering works on resumed runs too
    fsInfo // re-probed connected-folder ground truth for post-resume sub-agents
  }));
}

// Feedback (👍/👎) can arrive any time after a run — handle it on the global
// message channel, not the per-run port.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "feedback") return;
  (async () => {
    const settings = await getSettings();
    sendResponse(await recordFeedback(msg.runId, msg.value, settings));
  })();
  return true; // async response
});

// C.5: per-step 👍/👎 from a tool-result bubble (can arrive mid-run).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "step_feedback") return;
  (async () => {
    const settings = await getSettings();
    sendResponse(await recordStepFeedback(msg, settings));
  })();
  return true; // async response
});

// Resumable-run lookup + discard for the side panel's "Resume previous run" bar.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Both branches MUST call sendResponse on every path. The panel's unclean-death
  // handler awaits peek_resume before it can tell the user the run died, so a
  // rejected storage read that skipped sendResponse would leave that message
  // pending until the channel closes — the silent-hang bug, in the very handler
  // written to report it. Rejections resolve to "nothing to resume" instead.
  if (msg?.type === "peek_resume") {
    peekResumable()
      .then((info) => sendResponse({ resumable: info }))
      .catch((e) => { logErr("peekResumable failed", e); sendResponse({ resumable: null }); });
    return true; // async response
  }
  if (msg?.type === "discard_resume") {
    // Discard BOTH kinds of resumable state (standalone activeRun + phased).
    Promise.all([clearRunState(), clearPhaseState()])
      .then(() => sendResponse({ ok: true }))
      .catch((e) => { logErr("discard_resume failed", e); sendResponse({ ok: false }); });
    return true;
  }
  return; // not ours
});

// Prompt Builder: vision availability for the 📎 attach row — mirrors the
// describe() routing exactly: openai/gemini/anthropic/xai/custom send images
// to the SAME cloud model; claude-sub/codex-sub/ollama fall back to the LOCAL
// vision model, so with no visionModel configured there is NO vision at all.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "vision_info") return;
  (async () => {
    const s = await getSettings();
    const p = activeProvider(s);
    if (["openai", "gemini", "anthropic", "xai", "custom"].includes(p)) {
      sendResponse({ available: true, via: "cloud", model: s.cloudModel || p });
      return;
    }
    // Non-vision provider (ollama / claude-sub / codex-sub): AUTO-PAIRED with
    // the local vision model — the same fallback describeImage takes, defaulted
    // to DEFAULTS.visionModel so an empty setting never means "no vision".
    // The only real failure is that model not being pulled in Ollama — verify
    // against /api/tags (unreachable Ollama = unknown → report paired anyway;
    // fail-open, the describe call will surface the real error).
    const vm = s.visionModel || DEFAULTS.visionModel;
    let pulled = null;
    try {
      const r = await fetch(s.ollamaBase + "/api/tags");
      const names = (((await r.json()) || {}).models || []).map((m) => String(m.name || ""));
      pulled = names.some((n) => n === vm || n.split(":")[0] === vm.split(":")[0]);
    } catch { /* unknown */ }
    if (pulled === false) sendResponse({ available: false, via: "none", model: vm, hint: `ollama pull ${vm}` });
    else sendResponse({ available: true, via: "local", model: vm, paired: true });
  })();
  return true; // async response
});

// Prompt Builder (✍️ modal in the side panel): one non-tool model call that
// rewrites a rough goal into a capability-aware prompt. Serialized behind the
// model lock like every other inference so it can't collide with a run.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "build_prompt") return;
  (async () => {
    try {
      const goal = String(msg.goal || "").trim();
      if (!goal) { sendResponse({ ok: false, error: "Describe your goal first." }); return; }
      const settings = await getSettings();
      let page = null;
      if (msg.includePage) {
        try {
          const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (t) page = { title: t.title, url: t.url };
        } catch { /* page context is best-effort */ }
      }
      // Attachments: images are vision-described (cloud vision if configured,
      // local vision model otherwise); text files pass through truncated. The
      // writer bakes the specifics into the prompt because the RUNNING agent
      // never sees these files.
      const attachments = [];
      for (const f of (Array.isArray(msg.files) ? msg.files.slice(0, 5) : [])) {
        if (f && f.kind === "image" && typeof f.dataUrl === "string") {
          const b64 = f.dataUrl.includes(",") ? f.dataUrl.split(",")[1] : f.dataUrl;
          // Auto-pair: never describe with an empty vision model — same default
          // the vision_info handler reports.
          const v = await describeImage({ base64: b64, focus: goal, settings: { ...settings, visionModel: settings.visionModel || DEFAULTS.visionModel } });
          attachments.push({ name: String(f.name || "image"), kind: "image", summary: v.description || v.error || "" });
        } else if (f && f.kind === "text" && typeof f.text === "string") {
          attachments.push({ name: String(f.name || "file"), kind: "text", summary: f.text.slice(0, 6000) });
        }
      }
      const messages = buildPromptWriterMessages(goal, page, msg.preset,
        Array.isArray(msg.snAreas) ? msg.snAreas.slice(0, 24).map(String) : [], attachments);
      // Free (owner 2026-09-04): the backend prices purpose:"prompt_builder" at 0, runs it on the
      // included model whatever the user selected, and caps it per account per hour. Attached
      // images were already described above at the vision rate.
      const { content } = await withModelLock(() => chatStream({
        base: settings.ollamaBase, model: settings.model, settings, messages, tools: [], purpose: "prompt_builder"
      }));
      const prompt = String(content || "").trim()
        .replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim(); // belt-and-braces fence strip
      if (!prompt) { sendResponse({ ok: false, error: "The model returned an empty prompt — try again." }); return; }
      // Echo the provider:model that ACTUALLY ran, so the UI can display it —
      // proof of which brain wrote the prompt (cloud model for cloud providers,
      // settings.model only on the ollama path).
      const prov = activeProvider(settings);
      const ranModel = prov === "ollama" ? settings.model : "included model (free)";
      sendResponse({ ok: true, prompt, model: `${prov}:${ranModel}` });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // async response
});

// "Teach a workflow" coordination + saved-workflow management.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case "RECORD_EVENT":
      // Persist first; mirror to an open side panel ONLY if the event was kept
      // (not a dual-frame duplicate), so the live step list matches what saves.
      recordEvent(msg.event).then((kept) => {
        if (!kept) return;
        try { chrome.runtime.sendMessage({ type: "teach_event", event: msg.event }).catch(() => {}); } catch {}
      });
      return;
    case "teach_start":
      teachStart().then(sendResponse, (e) => sendResponse({ ok: false, error: "Teach failed to start: " + String((e && e.message) || e) }));
      return true;
    case "teach_stop":
      getSettings().then((s) => teachStop(msg.narration, s)).then(sendResponse, (e) => sendResponse({ ok: false, error: "Teach failed: " + String((e && e.message) || e) }));
      return true;
    case "get_workflows":
      getWorkflows().then(sendResponse, () => sendResponse([]));
      return true;
    case "delete_workflow":
      deleteWorkflow(msg.id).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    default:
      return;
  }
});

// Long-lived connection to the side panel; supports run + stop + approvals.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "agent") return;
  let controller = null;
  const pendingApprovals = new Map();
  let approvalSeq = 0;
  // Mid-run steering ("/btw"): messages the user types while the agent works queue
  // here and are drained into the conversation at the next step boundary.
  let steerQueue = [];
  const drainSteer = () => { const s = steerQueue; steerQueue = []; return s; };

  const post = (m) => {
    try {
      port.postMessage(m);
    } catch {
      /* panel closed */
    }
  };

  // Ask the panel to approve an action tool; resolves false on deny/abort.
  // `meta` (optional) carries { childId, childTask } so a sub-agent's approval
  // request is labeled and routed to the right child panel (MF-6).
  function askApproval(name, args, meta) {
    return new Promise((resolve) => {
      const id = ++approvalSeq;
      const signal = controller.signal;
      const done = (v) => {
        pendingApprovals.delete(id);
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => done(false);
      pendingApprovals.set(id, done);
      signal.addEventListener("abort", onAbort);
      post({ type: "approval_request", id, name, args, ...(meta || {}) });
    });
  }

  port.onMessage.addListener(async (msg) => {
    // An exception ESCAPING the run must never strand the panel. `done` is what
    // ends the spinner, and a throw here leaves the port CONNECTED — so the
    // panel's onDisconnect net (added 2026-07-27) never fires either, and the run
    // hangs silently forever: the exact failure mode the keepalive/deadline work
    // fixed, reached through a different door. Report it, then always finish.
    // Normal errors are already posted from inside runAgent/agentLoop, so this
    // catch only ever fires for something genuinely unhandled (no double-report).
    if (msg.type === "run" || msg.type === "resume") {
      controller = new AbortController();
      steerQueue = [];
      try {
        if (msg.type === "run") {
          await runAgent(msg.history, post, controller.signal, msg.attachments, askApproval, msg.modelOverride, {
            planFirst: msg.planFirst,
            executePlan: msg.executePlan,
            drainSteer
          });
        } else {
          await resumeAgent(post, controller.signal, askApproval, drainSteer);
        }
      } catch (e) {
        logErr(msg.type === "run" ? "runAgent failed" : "resumeAgent failed", e);
        // An AbortError is the user's own Stop escaping — the panel already said
        // "⏹ Stopped."; don't contradict it with an error. Still finish cleanly.
        if (!(e && e.name === "AbortError")) {
          post({ type: "error", text: "The run stopped with an unexpected error: " + String((e && e.message) || e) });
        }
      } finally {
        post({ type: "done" });
      }
    } else if (msg.type === "stop") {
      controller?.abort();
    } else if (msg.type === "steer") {
      // Side message injected mid-run — applied at the next step (no interruption).
      // May carry attached images ({base64, name}) alongside (or instead of) text;
      // the drain point runs them through the vision model like a normal send.
      const steerText = msg.text ? String(msg.text).trim() : "";
      const steerAtts = Array.isArray(msg.attachments)
        ? msg.attachments.filter((a) => a && a.base64)
        : [];
      if (steerText || steerAtts.length) steerQueue.push({ text: steerText, attachments: steerAtts });
    } else if (msg.type === "approve") {
      const done = pendingApprovals.get(msg.id);
      if (done) done(!!msg.approved);
    }
  });

  port.onDisconnect.addListener(() => controller?.abort());
});
