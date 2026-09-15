// scalping-pack.test.mjs — overlay composition + guardrail-precedence sanity for
// the opt-in scalping overlay. Run: node scalping-pack.test.mjs   Author: iDevOpsLLC
import { buildScalpingPack, scalpingPackSource, SCALPING_BODY } from "./scalping-pack.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

console.log("— SCALPING_BODY (bundled overlay body) —");
t("body is a substantial string", typeof SCALPING_BODY === "string" && SCALPING_BODY.length > 1000);
t("defines what a scalp is", /WHAT A SCALP IS/i.test(SCALPING_BODY));
t("has the candidate filter on top of the floor", /SCALP CANDIDATE FILTER \(on top of the Tradability Floor\)/i.test(SCALPING_BODY));
t("tighter stops never looser ratios", /tighter STOPS, never looser RATIOS/i.test(SCALPING_BODY));
t("never widen the stop / lower the target standard", /do NOT widen the stop and do NOT lower the target standard/i.test(SCALPING_BODY));
t("keeps the server R:R rule authoritative", /SERVER'S minimum reward:risk/i.test(SCALPING_BODY));
t("sizing formula applies unchanged", /base pack's formula applies UNCHANGED/i.test(SCALPING_BODY));
t("has the time-stop rule", /TIME STOP/i.test(SCALPING_BODY) && /~15 minutes/i.test(SCALPING_BODY));
t("one scalp at a time, no averaging down", /One scalp at a time\. Never average down/i.test(SCALPING_BODY));
t("does not unlock the opening 15 minutes", /does NOT unlock the opening 15 minutes/i.test(SCALPING_BODY));
t("stays inside the base trading window", /09:45–15:55 ET/.test(SCALPING_BODY));
t("expects more no-trades, not fewer", /expect MORE no-trades, not fewer/i.test(SCALPING_BODY));
t("no new bucket/tag invented on the form", /do not invent a new bucket\/tag/i.test(SCALPING_BODY));
t("no template-literal backtick leakage", !SCALPING_BODY.includes("`"));

console.log("— buildScalpingPack (composed prompt, bundled fallback) —");
const pack = await buildScalpingPack({ phaseFilesUrl: "" }); // no server → bundled body
t("returns a string containing the body", typeof pack === "string" && pack.includes("WHAT A SCALP IS"));
t("labeled as an overlay on the day-trading pack", /applies IN ADDITION to the day-trading pack above/i.test(pack));
t("precedence header is code-prepended", pack.indexOf("GUARDRAIL PRECEDENCE") !== -1 && pack.indexOf("GUARDRAIL PRECEDENCE") < pack.indexOf("WHAT A SCALP IS"));
t("precedence: cannot change MODE", /does NOT and CANNOT change/i.test(pack) && /your MODE \(analyze \/ prefill \/ submit\)/i.test(pack));
t("precedence: floor + cohort gate + exclusions intact", /TRADABILITY FLOOR/.test(pack) && /SERVER ENTRY-POLICY GATE/.test(pack) && /LONG-TERM HOLDINGS exclusion/.test(pack));
t("precedence: base pack wins on conflict", /the DAY-TRADING PACK'S rule wins/i.test(pack));
t("paper-only stated", /PAPER only, always\./.test(pack));
t("source label reports bundled without a server", scalpingPackSource() === "bundled", `got ${scalpingPackSource()}`);

console.log("— no permission language in the overlay (mode lives in trading-pack) —");
t("never grants Submit permission", !/you may (fill AND )?submit/i.test(pack));
t("never grants form-fill permission", !/You MAY populate/i.test(pack));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
