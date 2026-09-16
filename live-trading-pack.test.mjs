// live-trading-pack.test.mjs — pins the REAL-MONEY pack's safety contract and its isolation
// from the PAPER pack: disjoint URL gates, all-OFF defaults, an explicit-true kill-switch,
// live-only lockout codes, mutual exclusion in background.js, separate content.js guards,
// separate storage keys, and the same server sizing formula the paper pack pins.
// Run: node live-trading-pack.test.mjs   Author: iDevOpsLLC
import { readFileSync } from "node:fs";
import {
  needsLiveTradingPack, liveTradingMode, liveTradingModeLabel, LIVE_TRADING_BODY
} from "./live-trading-pack.js";
import { needsTradingPack, tradingMode } from "./trading-pack.js";
import { DEFAULTS } from "./settings.js";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const src = read("./live-trading-pack.js");
const paper = read("./trading-pack.js");
const bg = read("./background.js");
const content = read("./content.js");
const settings = read("./settings.js");
const options = read("./options.js");
const optionsHtml = read("./options.html");
const tools = read("./tools.js");

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const count = (s, re) => (s.match(re) || []).length;

console.log("— URL gates are disjoint —");
t("live gate matches live-trading.html", needsLiveTradingPack("https://ai.nowidevops.com/live-trading.html"));
t("live gate does NOT match day-trading.html", !needsLiveTradingPack("https://ai.nowidevops.com/day-trading.html"));
t("paper gate does NOT match live-trading.html", !needsTradingPack("https://ai.nowidevops.com/live-trading.html"));
t("paper gate does NOT match live-trading-fo either", !needsTradingPack("http://localhost:3000/live-trading.html?tab=orders"));
t("live gate tolerates null/undefined", !needsLiveTradingPack(null) && !needsLiveTradingPack(undefined));

console.log("— defaults: every real-money flag is OFF; the paper defaults are untouched —");
t("liveTradingPackEnabled default false", DEFAULTS.liveTradingPackEnabled === false);
t("liveTradingPrefillEnabled default false", DEFAULTS.liveTradingPrefillEnabled === false);
t("liveScalpingPackEnabled default false", DEFAULTS.liveScalpingPackEnabled === false);
t("liveRiskPostureEnabled default true (tighten-only tool)", DEFAULTS.liveRiskPostureEnabled === true);
t("paper tradingPackEnabled default unchanged (true)", DEFAULTS.tradingPackEnabled === true);
t("paper tradingPrefillEnabled default unchanged (true)", DEFAULTS.tradingPrefillEnabled === true);
t("getLiveSubmitEnabled reads storage.local and requires === true", /liveOrderSubmissionEnabled === true;/.test(settings));
t("paper getSubmitEnabled still defaults ON when unset", /paperOrderSubmissionEnabled === undefined \? true/.test(settings));

console.log("— mode resolution requires explicit true, never truthy —");
t("analyze when nothing set", liveTradingMode({}) === "analyze");
t("prefill only on === true", liveTradingMode({ liveTradingPrefillEnabled: true }) === "prefill" && liveTradingMode({ liveTradingPrefillEnabled: 1 }) === "analyze");
t("submit only on === true AND prefill === true (three-toggle contract, MM P7)", liveTradingMode({ liveOrderSubmissionEnabled: true, liveTradingPrefillEnabled: true }) === "submit" && liveTradingMode({ liveOrderSubmissionEnabled: true }) === "analyze" && liveTradingMode({ liveOrderSubmissionEnabled: "yes", liveTradingPrefillEnabled: true }) === "prefill");
t("paper flags do not drive the live mode", liveTradingMode({ paperOrderSubmissionEnabled: true, tradingPrefillEnabled: true }) === "analyze");
t("live flags do not drive the paper mode", tradingMode({ liveOrderSubmissionEnabled: true, liveTradingPrefillEnabled: true }) === "analyze");
t("submit label says REAL MONEY", /REAL MONEY/.test(liveTradingModeLabel({ liveOrderSubmissionEnabled: true })));

console.log("— pack text: real-money wording and live-only codes —");
t("no 'This is a PAPER account' in the live pack", !/This is a PAPER account/.test(src));
t("no 'PAPER only' rule in the live pack", !/PAPER only/.test(src));
t("submit block requires the LIVE badge before any submit", /mode badge reads exactly "LIVE"/.test(src));
t("circuit breaker includes NON_LIVE and AGENT_ENTRY_LIVE_ONLY", /NON_LIVE or AGENT_ENTRY_LIVE_ONLY/.test(src));
t("paper's NON_PAPER code is not a live circuit-breaker code", !/NON_PAPER/.test(src));
t("thesis is mandatory on the live page", /thesis field is MANDATORY/.test(src));
t("Submit is clicked ONCE", /click "Submit Order" ONCE/.test(src));
t("every served-file fetch in the live pack targets a live-* file", (() => { const m = [...src.matchAll(/fetch\(`\$\{base\}\/([a-z-]+\.md)`/g)].map((x) => x[1]); return m.length === 2 && m.every((f) => f.startsWith("live-")); })());
t("served live body must carry REAL MONEY to be accepted", /\/REAL MONEY\/i\.test\(md\)/.test(src));
t("scalp overlay served file is live-scalping-strategy.md", /live-scalping-strategy\.md/.test(src));
t("HTML shape guard on both loaders", count(src, /!\/\^\\s\*<\(\?:!doctype\|html\|head\|body\)\/i\.test\(md\)/g) === 2);
t("LONG ONLY stated", /LONG ONLY/.test(LIVE_TRADING_BODY));
t("R:R floor is 1.0", /≥\s*1\.0/.test(LIVE_TRADING_BODY));

console.log("— sizing formula: same server formula as the paper pack, with the slippage buffer —");
const buffer = /floor\(\s*risk_budget\s*\/\s*\(\s*per_share_risk\s*\+\s*0\.001\s*×\s*entry\s*\)\s*\)/g;
t("slippage-buffer formula stated at exactly 3 sites", count(src, buffer) === 3, `found ${count(src, buffer)}`);
const budget = /min\(\s*0\.(?:005|5%)\s*×\s*equity,\s*\$?150\s*\)\s*×\s*0\.5/g;
t("risk_budget = min(0.5% × equity, $150) × 0.5 stated at exactly 3 sites", count(src, budget) === 3, `found ${count(src, budget)}`);
t("old buffer-less formula is gone", !/floor\(\s*risk_budget\s*\/\s*per_share_risk\s*\)/.test(src));

console.log("— paper pack file is byte-for-byte free of live references (not overridden) —");
t("trading-pack.js has no live-pack imports/refs", !/live-trading-pack|liveTradingPackEnabled|liveOrderSubmissionEnabled/.test(paper));
t("live pack does not import the paper body", !/import[^\n]*TRADING_BODY[^\n]*trading-pack\.js/.test(src));

console.log("— background.js: mutual exclusion + shared trading-run gates —");
t("paper injection is suppressed when the active tab is the live page", /settings\.tradingPackEnabled && !m1LocksRun && !isM1Origin && !liveTradingActive/.test(bg));
t("live injection is ACTIVE-TAB gated only AND admin-entitled (no task-text / open-tab trigger)", /settings\.liveTradingPackEnabled && liveTradingActive && liveAdminOk && !m1LocksRun && !isM1Origin/.test(bg) && !/allTabs\.some\(\(t\) => needsLiveTradingPack/.test(bg));
t("live kill-switch resolved in runAgent AND resumeAgent", count(bg, /settings\.liveOrderSubmissionEnabled = await getLiveSubmitEnabled\(\)/g) === 2);
t("liveTradingPackInjected drives isTrading (step cap + screenshot/read/pre-validate guards)", /const isTrading = [^\n]*!!ctx\.liveTradingPackInjected/.test(bg));
t("liveTradingPackInjected drives the num_ctx floor", /const bigPackRun = ctx\.m1ReadOnly \|\| \(!isChild && !!ctx\.liveTradingPackInjected\)/.test(bg));
t("liveTradingPackInjected survives a checkpoint/resume", /liveTradingPackInjected: ctx\.liveTradingPackInjected/.test(bg));
t("live pack posts a realMoney-tagged tool_result", /name: "live_trading_agent_pack", result: \{\s*ok: true,\s*realMoney: true/.test(bg));

console.log("— content.js: separate guard, separate kill-switch, separate lockout keys —");
t("liveTradingSubmitAllowed requires storage.local === true", /liveOrderSubmissionEnabled !== true\) return false;/.test(content));
t("liveTradingSubmitAllowed requires pack === true AND prefill === true (three-toggle DOM contract, MM pass 2 S1)", /settings\.liveTradingPackEnabled === true && settings\.liveTradingPrefillEnabled === true\);/.test(content));
t("paper guard still keys on paperOrderSubmissionEnabled === false (unchanged)", /paperOrderSubmissionEnabled === false\) return false;/.test(content));
t("live lockout regex has NON_LIVE + AGENT_ENTRY_LIVE_ONLY", /LIVE_LOCKOUT_RE = \/DAILY_TIER_\\w\+\|RISK_HALT\|BOT_HALTED\|NON_LIVE\|AGENT_ENTRY_LIVE_ONLY/.test(content));
t("live lockout uses its own storage key", /liveTradingSubmitBlockedUntil/.test(content) && /liveTradingLastSubmit/.test(content));
t("paper lockout keys are untouched", /dayTradingSubmitBlockedUntil/.test(content) && /dayTradingLastSubmit/.test(content));
t("Submit Order on live page → guardLiveTradingSubmit", /\/live-trading\/i\.test\(location\.href\)\) \{\s*const g = await guardLiveTradingSubmit\(\);/.test(content));
t("Enter/Space on live page (order field, Submit button, Scan/Sched, no target) → live guard (MM P6)", /\/\^\(Enter\|NumpadEnter\| \|Space\)\$\/\.test\(keyName\) && \/live-trading\/i\.test\(location\.href\)/.test(content) && /target\.id === "btnScanExec" \|\| target\.id === "btnSchedStart"\)\) \{ \/\/ MM 6aa484e7 P6/.test(content));
t("fill+submit on ANY live-page field → live guard (MM P3)", /if \(submit && \/live-trading\/i\.test\(location\.href\)\) \{/.test(content) && !/submit && \/live-trading\/i\.test\(location\.href\) && isOrderField\(el\)/.test(content));
t("Scan+Execute gated on the live page AND bound by the lockout latch; Sched buttons refused outright (MM P5 + pass 3 L9)", /\/live-trading\/i\.test\(location\.href\) && el\.id === "btnScanExec"\) \{[^\n]*\n\s*if \(!\(await liveTradingSubmitAllowed\(\)\)\)[^\n]*\n\s*const g = await guardLiveTradingSubmit\(\); if \(g\) return g;/.test(content) && /btnSchedStart\|btnSchedStop\)\$\//.test(content));
t("paper submit guard on day-trading page still present (4 vectors)", count(content, /guardDayTradingSubmit\(\)/g) >= 4);

console.log("— options: real-money section, explicit-true saves —");
t("options.html has the five live toggles", ["liveTradingPackEnabled", "liveScalpingPackEnabled", "liveTradingPrefillEnabled", "liveOrderSubmissionEnabled", "liveRiskPostureEnabled"].every((id) => optionsHtml.includes(`id="${id}"`)));
t("options.js saves live flags as === true (private: AND admin uid; free: tier-gated on save)", /liveTradingPackEnabled: (?:window\.__liveAdminOk === true && )?el\("liveTradingPackEnabled"\)\.checked === true/.test(options));
t("options.js saves the live kill-switch via saveLiveSubmitEnabled(=== true) (admin-gated in both builds)", /saveLiveSubmitEnabled\((?:isAdminTier && |window\.__liveAdminOk === true && )el\("liveOrderSubmissionEnabled"\)\.checked === true\)/.test(options));

console.log("— tools.js: set_session_max_loss targets the module that owns the active page —");
t("live page → /api/live-trading cap endpoint", /\/api\/live-trading\/session-goals\/agent-cap/.test(tools));
t("paper page → /api/day-trading cap endpoint (unchanged)", /\/api\/day-trading\/session-goals\/agent-cap/.test(tools));
t("apiPath is passed as an executeScript arg (no hardcoded fetch)", /const res = await fetch\(apiPath, \{/.test(tools));

console.log("— master-mind 6aa484e765a373ca07804de8 fix pass pins —");
t("P1: resumeAgent restores liveTradingPackInjected and re-derives it from the active live tab", /let liveResumed = state\.liveTradingPackInjected === true;/.test(bg) && /if \(active && needsLiveTradingPack\(active\.url\)\) liveResumed = true;/.test(bg) && /liveTradingPackInjected: liveResumed,/.test(bg));
t("P1: resumePhased loopCtx carries liveTradingPackInjected", /fsInfo,\s*liveTradingPackInjected: await/.test(bg));
t("P2: desktop action tools refused on the live page", /Desktop control is DISABLED on the Live Trading \(real-money\) page/.test(tools));
t("P2: http_request cannot mutate the live-trading API", /http_request cannot POST\/PUT\/DELETE to the live-trading API/.test(tools));
t("P2: live runs drop desktop action tools + run_command from the schema", /if \(ctx\.liveTradingPackInjected\) \{ \/\/ REAL-MONEY run: no OS control, no shell/.test(bg));
t("P2: desktop action tools always confirm", /\.\.\.DESKTOP_ACTION_TOOL_NAMES, \/\/ MM 6aa484e7 P2/.test(bg));
t("P4: children bound to the live tab are read-only", /childLiveReadOnly = true;/.test(bg) && /readOnly: parentCtx\.readOnly \|\| childM1ReadOnly \|\| childLiveReadOnly,/.test(bg));
t("P5: no double-click on the live page", /\/live-trading\/i\.test\(location\.href\) && double\) double = false;/.test(content));
t("P8: Reset clears the local live kill-switch", /await saveLiveSubmitEnabled\(false\); el\("liveOrderSubmissionEnabled"\)\.checked = false;/.test(options));
t("P9: paper risk-posture toggle no longer disables the live page tool", /if \(!isLivePage && ctx && ctx\.settings && ctx\.settings\.riskPostureEnabled === false\)/.test(tools));
t("P10: nudges are mode-aware on the live page", count(bg, /ctx\.liveTradingPackInjected && settings\.liveOrderSubmissionEnabled !== true/g) === 2);
t("P11: HANDS OFF + NEVER FABRICATE are code-composed, not in the overridable body", /const HARD_RULES_BLOCK = `═══ HANDS OFF THE BOT CONTROLS ═══/.test(src) && !/═══ HANDS OFF THE BOT CONTROLS ═══/.test(LIVE_TRADING_BODY) && !/═══ NEVER FABRICATE ═══/.test(LIVE_TRADING_BODY) && /\$\{HARD_RULES_BLOCK\}/.test(src));
t("P11: live scalp overlay has its own body and imports nothing from the paper overlay", /const LIVE_SCALPING_BODY = `/.test(src) && !/from "\.\/scalping-pack\.js"/.test(src));
t("P11: strategy caches are keyed by phaseFilesUrl", /_cache\.base === base/.test(src) && /_scalpCache\.base === base/.test(src));
t("Low: dup-signature includes the thesis", /g\("orderThesis"\)\]\.join/.test(content));

console.log("— master-mind 6aa490c665a373ca0780563b pass-2 ship-with pins —");
t("S2: bot controls unconditionally off-limits on the live page", /REAL-MONEY bot controls are OFF-LIMITS to the agent/.test(content) && /\/\^\(btnCloseAll\|btnHalt\|btnPause\|btnResume\|btnFlatten\|btnSchedStart\|btnSchedStop\)\$\//.test(content));
t("S3: executor-level refusal of run_command / desktop actions on a live run", /REAL-MONEY run: OS control and shell are refused \(schema-stripped and executor-refused\)/.test(bg));
t("S3: live flag reaches the executor ctx", /liveTradingPackInjected: ctx\.liveTradingPackInjected === true \}\)/.test(bg));
t("S4: drift guard refuses DOM actions on the live page without the live pack", /REAL-MONEY page reached mid-run without the live-trading pack/.test(bg));
t("S5: http_request normalizes the URL and refuses mutating redirects", /redirect: mutating \? "error" : "follow"/.test(tools) && /res = await fetch\(_u\.href, init\);/.test(tools) && /\/\^\\\/api\\\/live-trading\(\?:\\\/\|\$\)\/i\.test\(_path\)/.test(tools));
t("S6: live-bound children get no action tools in their schema", /\(parentCtx\.readOnly \|\| childLiveReadOnly\) \? CHILD_TOOLS\.filter/.test(bg));
t("S7: pre-validate helper is paper-page only", /args\.selector && !ctx\.liveTradingPackInjected\)/.test(bg));
t("Low: desktop_screenshot under the vision ban", /name === "capture_screenshot" \|\| name === "desktop_screenshot"/.test(bg));
t("Low: submit label with all three toggles", /REAL MONEY/.test(liveTradingModeLabel({ liveOrderSubmissionEnabled: true, liveTradingPrefillEnabled: true })) && /submit/.test(liveTradingModeLabel({ liveOrderSubmissionEnabled: true, liveTradingPrefillEnabled: true })));

console.log("— master-mind 6aa49b0d65a373ca078075c2 pass-3 pins —");
t("L1: paper Scan/Sched return uses the in-scope txt2 (no ReferenceError fall-through)", /Autonomous execution is OFF — \\"" \+ \(txt2 \|\| el\.id\)/.test(content) && !/Autonomous execution is OFF — \\"" \+ \(txt \|\| el\.id\)/.test(content));
t("L2: click guard catches fail CLOSED on trading pages (both blocks)", count(content, /Trading-page click guard failed/g) === 2);
t("L3: drift guard covers read_page{url} (navLike)", /\(ACTION_TOOLS\.has\(name\) \|\| name === "press_key" \|\| navLike\)\) \{ \/\/ MM pass 3 L3/.test(bg));
t("L4: http_request collapses dot segments after decode and reports the normalized href", /seg === "\.\."\) \{ const i = acc\.lastIndexOf\("\/"\)/.test(tools) && /url: _u\.href, method, status: res\.status/.test(tools));
t("L5+M1: generic submit helpers denied on the live page (dispatcher depth + executor enforcement)", /\/\^\(send_chat_message\|draft_chat_message\|delete_chat_message\|drag_drop\|set_editor_value\|save_record\|_gmail_send\)\$\/\.test\(name\)/.test(content) && /This helper is disabled for REAL-MONEY trading/.test(tools));
t("L6: run_command refused while the live page is active", /run_command is DISABLED while the Live Trading \(real-money\) page is active/.test(tools));
t("L7: an unbound child inherits the active live tab's pin", /tabId != null \? await chrome\.tabs\.get\(tabId\) : \(await chrome\.tabs\.query\(\{ active: true, lastFocusedWindow: true \}\)\)\[0\]/.test(bg));

console.log("— master-mind 6aa4a4bc65a373ca0780dd7f pass-4 pins (before arming autonomous submit) —");
t("M2: live fill+submit is refused outright (one guarded Submit click only)", /REAL-MONEY fill\+submit is disabled\. Fill with submit:false/.test(content));
t("M3: bot controls refused for keyboard activation on the live page", /REAL-MONEY bot controls are OFF-LIMITS to the agent \(keyboard\)/.test(content));
t("M4: guardLiveTradingSubmit internal catches fail closed", count(content, /Cannot verify or persist REAL-MONEY submit safety state/g) === 2);
t("N1: no review marker inside the paper reason string", !/places orders outside the manual form\. \/\* MM pass 3 L1 \*\//.test(content));
t("L10: lockout reason no longer suggests toggling", !/toggle the live autonomous-submit switch off\/on/.test(content));

t("N2: bot-control key refusal runs BEFORE the P6 latch and ignores document.body text", (() => { const a = content.indexOf("MM pass 4 M3 + pass 5 N2"); const b = content.indexOf("// MM 6aa484e7 P6"); return a > 0 && b > a && /target !== document\.body && target\.closest/.test(content); })());

console.log("— admin-tier-only gate (owner directive 2026-09-12) —");
t("background re-checks admin entitlement at injection time", /REAL-MONEY section is ADMIN TIER ONLY/.test(bg) && /let liveAdminOk = false;/.test(bg) && /REAL-MONEY pack is admin-tier only/.test(bg));
t("private: entitlement = signed license uid on the admin roster; free: signed-in tier === admin", /isLiveAdminUid\(lic\.uid\)/.test(bg) || /a\.tier === "admin"/.test(bg));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
