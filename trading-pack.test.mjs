// trading-pack.test.mjs — pins the server-side sizing formula wherever the pack STATES it,
// so a future edit cannot restore the old formula at one site while the suite stays green.
// Master-mind pass 3 (6aa2f178, 2026-09-10) made this negative test a co-equal condition of
// P3-1; pass 4 (6aa46229, 2026-09-11) found it missing and found two more stale statements
// the gap had hidden. Run: node trading-pack.test.mjs   Author: iDevOpsLLC
import { readFileSync } from "node:fs";
import { TRADING_BODY } from "./trading-pack.js";

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
  /\(AGENT_ENTRY_MAX_PER_DAY \/ MAX_OPEN \/ LOSS_CAP \/ PRICE_CAP\) end the day's BUYING/.test(src));
t("B5: MAX_POSITIONS / DUPLICATE_SYMBOL end THIS cycle", /MAX_POSITIONS and DUPLICATE_SYMBOL end THIS\s+cycle/.test(src));
t("B5: cohort loss cap attributed to AGENT_ENTRY_LOSS_CAP", /cohort loss cap answers AGENT_ENTRY_LOSS_CAP \(422\)/.test(src));
t("thesis field is live and the pack says fill it", /#orderThesis, since 2026-09-10/.test(src));
t("notional cap is a server truth with a down-size rule", /NOTIONAL cap: qty × entry must be ≤ 10% of equity/.test(src) && /Down-size, never skip/.test(src));
t("self-check remediation is re-size, not NO-TRADE", /Any N → re-size and re-check \(NO-TRADE only if the re-sized qty < 1 share\)/.test(src));
t("body precedence is stated in the governing header", /If the STRATEGY BODY at the end of this pack conflicts with any block before it, the block before it wins/.test(src));
t("served-body loader rejects an HTML index-page fallback (6aa4632f F-7)",
  src.includes("!/^\\s*<(?:!doctype|html|head|body)/i.test(md) && /ENTRY RULES/.test(md)"));
t("scalp served-body loader has the same shape guard", /WHAT A SCALP IS\/i\.test\(md\)/.test(scalp));
t("TRADING_BODY exports and is substantial", typeof TRADING_BODY === "string" && TRADING_BODY.length > 2000);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
