// trading-pack.test.mjs — pins the server-side sizing formula wherever the pack STATES it,
// so a future edit cannot restore the old formula at one site while the suite stays green.
// Master-mind pass 3 (6aa2f178, 2026-09-10) made this negative test a co-equal condition of
// P3-1; pass 4 (6aa46229, 2026-09-11) found it missing and found two more stale statements
// the gap had hidden. Run: node trading-pack.test.mjs   Author: iDevOpsLLC
import { readFileSync } from "node:fs";
import { TRADING_BODY, buildTradingPack } from "./trading-pack.js";

const src = readFileSync(new URL("./trading-pack.js", import.meta.url), "utf8");
const scalp = readFileSync(new URL("./scalping-pack.js", import.meta.url), "utf8");
const bg = readFileSync(new URL("./background.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const count = (s, re) => (s.match(re) || []).length;

console.log("— sizing formula: every statement carries the server's slippage buffer —");
// Sites: the pre-Validate self-check (:58), the COHORT_GATE budget bullet (:~181), the
// ENTRY RULES "Size BY FORMULA" bullet (:~299). Spacing differs per site; the tokens do not.
const buffer = /floor\(\s*risk_budget\s*\/\s*\(\s*per_share_risk\s*\+\s*0\.001\s*×\s*entry\s*\)\s*\)/g;
t("slippage-buffer formula stated at exactly 3 sites", count(src, buffer) === 3, `found ${count(src, buffer)}`);
const budget = /min\(\s*0\.(?:005|5%)\s*×\s*equity,\s*\$?150\s*\)\s*×\s*0\.5/g;
t("risk_budget = min(0.5% × equity, $150) × 0.5 stated at exactly 3 sites", count(src, budget) === 3, `found ${count(src, budget)}`);
t("old buffer-less formula is gone", !/floor\(\s*risk_budget\s*\/\s*per_share_risk\s*\)/.test(src));
t("no bare 0.5%-of-equity budget without the $150 cap and scout multiplier",
  !/0\.005\s*(?:×|\*|·)\s*equity(?![^\n]{0,40}\$?150)/.test(src), "a site states 0.005×equity without min(…,150)");

console.log("— retired gates and old numbers are not restated anywhere in the pack —");
t("no R:R ≥ 2.0 floor", !/≥\s*2\.0/.test(src));
t("no short-side rule", !/below both for shorts/i.test(src));
// The floor may be NAMED as retired (:79 comment, :147 "no $5 floor"); it must not exist as a rule block.
t("no Tradability Floor rule block", !/═══\s*TRADABILITY FLOOR/i.test(src) && !/apply the tradability floor/i.test(src));
t("no EXCLUDED_SYMBOLS list", !/EXCLUDED_SYMBOLS/.test(src));
t("no 15:55 window", !/15:55/.test(src));
t("LONG ONLY is stated", /LONG ONLY/.test(src));
t("R:R floor is 1.0", /≥\s*1\.0/.test(src) || />=\s*1\.0/.test(src));

console.log("— pass-4 ship gate (6aa46229) —");
t("B3: scalping overlay states no budget number of its own", !/0\.5% risk/i.test(scalp) && !/10% notional cap\)/.test(scalp));
t("B1 (scalp): scalp sizing carries the slippage buffer", /floor\(risk_budget \/ \(per_share_risk \+ 0\.001 × entry\)\)/.test(scalp));
t("B2: pre-validate guard message quotes no formula of its own", !/0\.005\s*(?:·|×|\*)\s*equity/.test(bg));
t("B5: cap codes end the day's buying, not 'move to the next candidate'",
  /AGENT_ENTRY_MAX_PER_DAY \/ LOSS_CAP \/\s+PRICE_CAP end the day's BUYING/.test(src) && !/MAX_OPEN \/ LOSS_CAP \/ PRICE_CAP\) end the day's BUYING/.test(src));
t("B5: MAX_POSITIONS / DUPLICATE_SYMBOL end THIS cycle", /MAX_POSITIONS and DUPLICATE_SYMBOL end THIS\s+cycle/.test(src));
t("B5: cohort loss cap attributed to AGENT_ENTRY_LOSS_CAP", /cohort loss cap answers AGENT_ENTRY_LOSS_CAP \(422\)/.test(src));
t("09-15: stopped-out symbol is done for the session, not re-shopped",
  /AGENT_ENTRY_STOPPED_OUT_TODAY \(422\) means that SYMBOL is\s+done for the session/.test(src) &&
  /stopped out at a loss today \(the server answers AGENT_ENTRY_STOPPED_OUT_TODAY\)/.test(src));
console.log("— 09-17 entry brakes (server rev V3): the agent is told what each one answers (an internal review D-list) —");
t("cohort rev is V4 (2026-09-22); V3 and V2 no longer stated as current", /rev V4, 2026-09-22/.test(src) && !/rev V3, 2026-09-17\)/.test(src) && !/rev V2, 2026-09-10\)/.test(src));
t("F6: exception is a SESSION bar under VWAP + YOUR ENTRY back above; no '5-minute bar', no 'real pullback'",
  /a session bar closed UNDER session VWAP and your entry is back\s+ABOVE it/.test(src) && !/a 5-minute bar\s+closed UNDER/.test(src) && !/a real pullback and reclaim/.test(src));
t("F2: server owns the reclaim; build the order and let Validate answer; never assert an unseen reclaim",
  /you cannot see the reclaim in the Analysis panel/.test(src) && /BUILD THE ORDER and let Validate decide the reclaim exception/.test(src) && /never assert a reclaim you\s+did not observe/.test(src));
t("F2/F8: below 10% is NOT a filter (stated in the code block AND the entry rules); no 'under 8% up' preference; no 7-of-9 anecdote in the prompt",
  /Below 10%\s+the cap does not exist/.test(src) && /Below \+10% the day's move is NOT a filter/.test(src) && !/Prefer names EARLIER in their move: under 8% up/.test(src) && !/seven of nine entries were up 7-20% at entry/.test(src));
t("F2/F10: no limit shaving; EXTENDED_DAY_MOVE not fixable on this order", /never shave the limit to read under the cap/.test(src) && /EXTENDED_DAY_MOVE\s+cannot be fixed on this order/.test(src));
t("EXTENDED_DAY_MOVE listed with the per-order codes", /VWAP_EXTENSION, EXTENDED_DAY_MOVE, RISK_TOO_HIGH/.test(src));
t("F1: streak is the server's shared consecutive counter, reset by a win; NOT 'one agent trade closed at a loss today'",
  /one counter shared with the bot's trades, reset by a win of at least a quarter of that\s+trade's risk/.test(src) && !/once one agent trade has closed at a loss today/.test(src));
t("F1: in-flight positions count against a SEPARATE exposure limit, never the 3-loss breaker",
  /SEPARATE exposure limit \(config\s+agentEntry\.streakExposureLimit, 3 today\)\. They do NOT trip the 3-loss breaker, which still counts CLOSED\s+losses only/.test(src) && !/count toward the 3-loss breaker/.test(src));
t("F1: streak 1 refuses a THIRD agent position, streak 2 a SECOND; bot positions do not count; do not keep the count yourself",
  /Streak 1: the server refuses a THIRD agent position; streak 2: a SECOND/.test(src) && /Bot\s+positions do not count here/.test(src) && /Do not keep\s+this count yourself/.test(src));
t("F1/F7: AGENT_ENTRY_STREAK_EXPOSURE ends THIS cycle, not the day; no read loop; not a day-ender",
  /it ends THIS cycle \(no retry, no other\s+symbol, no read loop\), not the day/.test(src) && /do not sit in a read loop and do not declare the day over/.test(src));
t("F3: CIRCUIT BREAKER line carves out the three end-cycle codes and names the 30-minute pause as cycle-ending",
  /EXCEPT MAX_POSITIONS, DUPLICATE_SYMBOL, AGENT_ENTRY_MAX_OPEN, AGENT_ENTRY_STREAK_EXPOSURE and AGENT_ENTRY_INDEX_CHOP, which end THIS CYCLE/.test(src) && /is the 30-minute loss-streak breaker: it ends this cycle, not the day/.test(src));
t("F5: TTL cancel is asynchronous, not a loss but caps the symbol (an internal review B-2), partial remainder keeps working, no re-place lower",
  /wholly unfilled after\s+~5 minutes is cancelled by the server/.test(src) && /The cancel is asynchronous/.test(src) && /A\s+TTL cancel is not a loss, but it caps that symbol for the rest of the session/.test(src) && /remainder keeps working/.test(src) && /Do not re-place the same limit lower on\s+the same stale thesis/.test(src));
t("F5: no universal causal rhetoric ('thesis was wrong about the price', 'fills because the stock is falling')",
  !/the thesis was\s+wrong about the price/.test(src) && !/fills because the stock is falling/.test(src));
t("F4: below-market limit still allowed when price is already there (VWAP_EXTENSION remedy scoped, not banned)",
  /use a limit a little below the last price only when price is\s+already there so it can fill inside the 5-minute TTL, or wait one cycle/.test(src) && /send the below-market limit only when price is already there/.test(src) && /it never makes a spent day move acceptable/.test(src));
t("F9/F11/F12: cap is a risk control not the floor; 8 is marked config; unknown prior close is over the cap",
  /is a RISK control on today's move/.test(src) && /riskSettings\.maxEntryDayMovePct, 10 today/.test(src) && /an unknown prior close is\s+treated as over the cap/.test(src));
t("entry rules read the day move before building the order", /Day move \(the stock's % change on the day[^)]*\): read it on the Watchlist row BEFORE building the order/.test(src));
t("entries-per-day cap states 20, not the stale 10", /entries per day \(20\)/.test(src) && !/entries per day \(10\)/.test(src));
console.log("— delta pass (an internal review): breaker carve-out at EVERY AGENT_ENTRY_RISK_BLOCKED site; no plausible-pullback prerequisite —");
t("B1: RISK_BLOCKED per-order sentence carries the UNLESS clause (breaker / pause blocks every symbol, ends THIS cycle)",
  /AGENT_ENTRY_RISK_BLOCKED is a NO-TRADE for that order only — UNLESS its text reports a circuit\s+breaker or an active trading pause/.test(src) && /blocks EVERY symbol: end THIS cycle, report the text verbatim, do not shop another candidate\s+and do not poll; it does not end the day/.test(src));
t("B1: taxonomy line carves the breaker out of 'fix THIS order or move to the next candidate'",
  /\(except an\s+AGENT_ENTRY_RISK_BLOCKED whose text reports a circuit-breaker trip or active pause — that blocks\s+every symbol and ends THIS cycle, see CIRCUIT BREAKER\)/.test(src));
t("B1: 'circuit breaker' is NOT listed among the checks that size you down", !/\(PDT, circuit breaker/.test(src));
t("B4: both literal server pause strings are quoted at 2 sites each",
  count(src, /3 consecutive losses — circuit breaker triggered\. Trading\s+paused for 30 minutes\./g) === 2 && count(src, /Circuit breaker active\. Trading paused for N more minutes\./g) === 2);
t("B2: no 'plausible pullback' prerequisite; Validate decides the reclaim exception",
  !/with a plausible pullback/.test(src) && /let Validate decide the reclaim exception; do not\s+require a visible or "plausible" pullback before validating/.test(src));
t("B5: unknown prior close is over the cap ON SUBMIT; on a dry-run it is a warning only", /treated as over the cap on submit \(on a dry-run that one case is only a WARNING/.test(src));
t("B7: TTL and streak limit are config-marked like the cap", /config agentEntry\.limitTtlMinutes, 5 today/.test(src) && /config\s+agentEntry\.streakExposureLimit, 3 today/.test(src));
t("dual-site brake sentences are stated at exactly 2 sites (deleting one site must fail, as the sizing formula does)",
  count(src, /Below \+?10%/g) === 2 && count(src, /only when price is\s+already there/g) === 3 && count(src, /ends this cycle, not the day|ends THIS cycle/g) >= 3);
t("F5: active-pause trigger, cancel-pending counting and SYMBOL_UNRECONCILED are pinned",
  /or a breaker pause is active/.test(src) && /keep counting it as yours until\s+it clears/.test(src) && /\(AGENT_ENTRY_SYMBOL_UNRECONCILED\)/.test(src));
t("cap: the pack states 10 (live riskSettings.maxEntryDayMovePct since 2026-09-18) and never 8 as the current cap", count(src, /\b8%/g) === 0 && !/\b8 today\b/.test(src) && !/maxEntryDayMovePct[^)]*\b8\b/.test(src) && /10 today\)/.test(src));
t("pass-3 F2: dry-run DOES evaluate the reclaim exception; only an unknown prior close is warning-on-dry-run / block-on-submit",
  /the reclaim\s+exception itself IS evaluated on the dry-run/.test(src) && /a Validate\s+ACCEPTED that carries DAY_MOVE_UNVERIFIABLE can still be refused on submit/.test(src) && !/trust the submit\s+result\)/.test(src));
t("pass-3 F3: the entry-rules circuit-breaker line no longer lumps the 3-loss breaker with the day-ending halt codes",
  /the 3-consecutive-loss breaker instead answers AGENT_ENTRY_RISK_BLOCKED/.test(src) && !/the loss ladder and the losing-trade count halt entries/.test(src));
t("pass-3 F9: day move is distinguished from the 10%-of-equity notional cap", /not the 10%-of-equity notional cap, a different number/.test(src));
t("thesis field is live and the pack says fill it", /#orderThesis, since 2026-09-10/.test(src));
t("notional cap is a server truth with a down-size rule", /NOTIONAL cap: qty × entry must be ≤ 10% of equity/.test(src) && /Down-size, never skip/.test(src));
t("self-check remediation is re-size, not NO-TRADE", /Any N → re-size and re-check \(NO-TRADE only if the re-sized qty < 1 share\)/.test(src));
t("body precedence is stated in the governing header", /If the STRATEGY BODY at the end of this pack conflicts with any block before it, the block before it wins/.test(src));
t("served-body loader rejects an HTML index-page fallback (6aa4632f F-7)",
  src.includes("!/^\\s*<(?:!doctype|html|head|body)/i.test(md) && /ENTRY RULES/.test(md)"));
t("scalp served-body loader has the same shape guard", /WHAT A SCALP IS\/i\.test\(md\)/.test(scalp));
t("TRADING_BODY exports and is substantial", typeof TRADING_BODY === "string" && TRADING_BODY.length > 2000);

console.log("— 2026-09-22 V4 gates: the four server refusals are explained, with the right scope for each —");
t("cohort rev is V4 in the header comment and the cohort bullet", /AGENT_V4_VWAP_CHASE_INDEXCHOP_PAPER_2026_09_22/.test(src) && /rev V4, 2026-09-22/.test(src) && !/rev V3, 2026-09-17\)/.test(src));
t("BELOW VWAP bullet: reclaim is shown by price, per-symbol, no limit-raising, three-bar floor",
  /BELOW VWAP \(server, 2026-09-22; config agentEntry\.requireAboveVwap\)/.test(src) && /AGENT_ENTRY_BELOW_VWAP/.test(src)
  && /three or\s+more 5-minute bars/.test(src) && /do not lift a limit over VWAP\s+while the price is still under it/.test(src) && /not the VWAP_EXTENSION rule/.test(src));
t("CHASE AFTER A CANCELLED LIMIT bullet: LOWEST cancelled limit is the reference, at-or-under allowed, market priced by the server, reference only moves down, not dry-run visible",
  /CHASE AFTER A CANCELLED LIMIT \(server, 2026-09-22; config agentEntry\.blockChaseAfterCancel\)/.test(src) && /AGENT_ENTRY_CHASE_AFTER_CANCEL/.test(src)
  && /At or under that price is still allowed/.test(src) && /a limitPrice on a market order does not count/.test(src) && /use the LOWEST such price/.test(src)
  && /The reference only moves DOWN/.test(src) && /nothing you place raises it/.test(src) && /Validate can say ACCEPTED\s+and Submit still answer AGENT_ENTRY_CHASE_AFTER_CANCEL/.test(src));
t("an internal review B-2: the TTL bullet no longer says a later cycle may judge the symbol fresh at the then-current price",
  !/judge it fresh at the\s+then-current price/.test(src) && /caps that symbol for the rest of the session/.test(src));
t("INDEX CHOP bullet: server reads SPY ADX itself, dry-run warning named, ends THIS cycle not the day, UNAVAILABLE proceeds",
  /INDEX CHOP \(server, 2026-09-22; config agentEntry\.indexRegimeGateEnabled and\s+agentEntry\.indexAdxFloor, 18 today\)/.test(src) && /AGENT_ENTRY_INDEX_CHOP/.test(src)
  && /INDEX_REGIME_CHOP/.test(src) && /ends\s+THIS cycle for buying, not the day/.test(src) && /INDEX_REGIME_UNAVAILABLE means the read failed and the\s+gate stood down/.test(src)
  && /do not try another symbol \(the index is the same for all of them\)/.test(src));
t("BREAKER PROBATION bullet: counter restarts at 2, one position at a time, one more loss re-trips",
  /BREAKER PROBATION \(server, 2026-09-22\)/.test(src) && /restarts at 2, not 0/.test(src) && /ONE\s+more closed loss — yours or the bot's — trips the pause again/.test(src)
  && /while one is\s+open or pending/.test(src));
t("per-order list: BELOW_VWAP and CHASE are per-SYMBOL; INDEX_CHOP joins the end-THIS-cycle group",
  /AGENT_ENTRY_BELOW_VWAP and\s+AGENT_ENTRY_CHASE_AFTER_CANCEL are per-SYMBOL for this cycle/.test(src) && /and so do AGENT_ENTRY_STREAK_EXPOSURE,\s+AGENT_ENTRY_INDEX_CHOP and AGENT_ENTRY_MAX_OPEN/.test(src));
t("an internal review B-1: ACCEPTED is not sufficient at the point of action — all three Submit sites carry the INDEX_REGIME_CHOP exception",
  /SUBMIT ONLY IF it says "VALIDATION: ACCEPTED" AND the warnings do NOT contain INDEX_REGIME_CHOP/.test(src)
  && /Only after an ACCEPTED validation with no INDEX_REGIME_CHOP warning, click "Submit Order"/.test(src)
  && /green light to click Submit unless\s+its WARNINGS include INDEX_REGIME_CHOP/.test(src)
  && /Other warnings \(DAY_MOVE_UNVERIFIABLE, INDEX_REGIME_UNAVAILABLE\) do not stop the\s+submit/.test(src)
  && /every WARNING code, and any INDEX_REGIME reading/.test(src));
t("a 422 after an ACCEPTED Validate is named as normal for the per-symbol gates the dry-run does not run",
  /A 422 on Submit after an ACCEPTED Validate is normal for the per-symbol gates the dry-run does not run \(AGENT_ENTRY_BELOW_VWAP, AGENT_ENTRY_CHASE_AFTER_CANCEL, AGENT_ENTRY_STOPPED_OUT_TODAY\)/.test(src));
t("an internal review B-3: agent max-open is config-only and non-actionable; MAX_OPEN ends THIS cycle, not the day's buying",
  /agentEntry\.maxOpen — lowered for the first V4 sessions, normally\s+3/.test(src) && !/maxOpen: 1 while/.test(src)
  && /Do not count against the agent limit yourself/.test(src) && /AGENT_ENTRY_MAX_OPEN ends THIS cycle/.test(src)
  && !/AGENT_ENTRY_MAX_OPEN[^\n]*end the day's BUYING/.test(src) && !/MAX_OPEN \/ LOSS_CAP \/ PRICE_CAP\) end the day's BUYING/.test(src)
  && /the lower agent-only limit is the server's to answer \(AGENT_ENTRY_MAX_OPEN\)/.test(src));
t("the circuit-breaker carve-out lists MAX_OPEN and INDEX_CHOP among the codes that end THIS CYCLE",
  count(src, /EXCEPT MAX_POSITIONS, DUPLICATE_SYMBOL, AGENT_ENTRY_MAX_OPEN, AGENT_ENTRY_STREAK_EXPOSURE and AGENT_ENTRY_INDEX_CHOP, which end THIS CYCLE/g) >= 1);
t("regime bridge: the agent's own regime read is never a veto, the server's INDEX_REGIME_CHOP is obeyed, and it is learned only from Validate",
  /The one regime\s+condition the server enforces is INDEX_REGIME_CHOP, answered on Validate/.test(src)
  && /never skip a cycle or a candidate because a chart, a web search or your own ADX\s+says the index is choppy, and never submit through an INDEX_REGIME_CHOP/.test(src)
  && /do not carry an old reading forward/.test(src) && !/best moment came within two minutes of the fill/.test(src));
t("*_UNAVAILABLE per-order line carves out the INDEX_REGIME_UNAVAILABLE warning", /the INDEX_REGIME_UNAVAILABLE warning is not one\s+of them and needs no action/.test(src));
t("BELOW VWAP: marketable-limit bypass named, not dry-run visible", /a buy limit above the market fills at the market, under\s+VWAP/.test(src) && /Validate can say ACCEPTED and\s+Submit still answer AGENT_ENTRY_BELOW_VWAP/.test(src));
t("self-check carries the VWAP and cancelled-limit items", /entry at or above session VWAP per the Analysis panel\? Y\/N \| no cancelled agent limit of yours on this symbol today priced under your entry\? Y\/N/.test(src));

console.log("— an internal review Q8: negative pins — the old permissions cannot come back quietly —");
for (const [name, re] of [
  ["'sufficient below them' (old Direction rule)", /sufficient below them/i],
  ["'only fires on entries too far ABOVE' (old Direction rule)", /only fires on entries too far ABOVE/i],
  ["'never below' (old Direction rule)", /never below\b/i],
  ["'judge it fresh at the then-current price' (old TTL sentence)", /judge it fresh at the\s+then-current price/i],
  ["'high throwaway limit' (replaced by the reference-only-moves-down rule)", /high throwaway limit/i],
  ["'maxOpen: 1 while' (hard-coded rollout value)", /maxOpen: 1 while/],
]) t("absent: " + name, !re.test(src));
t("parked 09-21 SPREAD bullet is NOT restated in the V4 bullets (release build strips it)", count(src, /SPREAD vs STOP \(server, 2026-09-21\)/g) <= 1);


console.log("— composed prompt (buildTradingPack, submit mode): the brake sentences reach the model, not just the source file —");
let composedText = "";
try {
  composedText = await Promise.race([
    buildTradingPack({ tradingPackEnabled: true, tradingPrefillEnabled: true, paperOrderSubmissionEnabled: true, phaseFilesUrl: "http://127.0.0.1:9" }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("buildTradingPack timeout")), 8000))
  ]);
} catch (e) { composedText = ""; console.error("  composed pass unavailable: " + e.message); }
t("composed prompt is non-empty", typeof composedText === "string" && composedText.length > 5000);
for (const [name, re] of [
  ["DAY-MOVE CAP bullet", /DAY-MOVE CAP \(server, 2026-09-17/],
  ["STREAK EXPOSURE bullet", /STREAK EXPOSURE \(server, 2026-09-17\)/],
  ["LIMIT ORDERS EXPIRE bullet", /LIMIT ORDERS EXPIRE \(server, 2026-09-17/],
  ["CIRCUIT BREAKER carve-out", /EXCEPT MAX_POSITIONS, DUPLICATE_SYMBOL, AGENT_ENTRY_MAX_OPEN, AGENT_ENTRY_STREAK_EXPOSURE and AGENT_ENTRY_INDEX_CHOP, which end THIS CYCLE/],
  ["BELOW VWAP bullet", /BELOW VWAP \(server, 2026-09-22/],
  ["CHASE AFTER A CANCELLED LIMIT bullet", /CHASE AFTER A CANCELLED LIMIT \(server, 2026-09-22/],
  ["INDEX CHOP bullet", /INDEX CHOP \(server, 2026-09-22/],
  ["BREAKER PROBATION bullet", /BREAKER PROBATION \(server, 2026-09-22\)/],
  ["direction rule requires at or above VWAP", /Entry at or above session VWAP is a server rule since 2026-09-22/],
  ["MODE block: ACCEPTED AND no INDEX_REGIME_CHOP", /SUBMIT ONLY IF it says "VALIDATION: ACCEPTED" AND the warnings do NOT contain INDEX_REGIME_CHOP/],
  ["old Direction permission absent from the prompt", /^(?![\s\S]*sufficient below them)/],
  ["old TTL permission absent from the prompt", /^(?![\s\S]*judge it fresh at the\s+then-current price)/],
  ["RISK_BLOCKED UNLESS clause", /NO-TRADE for that order only — UNLESS its text reports a circuit/],
  ["below 10% is not a filter (code block)", /Below 10%\s+the cap does not exist/],
  ["7-of-9 anecdote absent from the prompt", /^(?![\s\S]*seven of nine entries)/]
]) t("composed: " + name, re.test(composedText));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
