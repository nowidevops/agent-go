// unslop-pack.test.mjs — body sanity for the always-on unslop writing-quality pack.
// Run: node unslop-pack.test.mjs   Author: iDevOpsLLC
import { UNSLOP_PACK, unslopPackSource } from "./unslop-pack.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

console.log("— UNSLOP_PACK body —");
t("pack is a non-empty string", typeof UNSLOP_PACK === "string" && UNSLOP_PACK.length > 500);
t("stays compact for small local models (< 4KB)", UNSLOP_PACK.length < 4096, `length=${UNSLOP_PACK.length}`);
t("declares scope: all prose, code exempt", /Code blocks are exempt/i.test(UNSLOP_PACK) && /documentation prose is not/i.test(UNSLOP_PACK));
t("has the self-audit question", /what makes this obviously AI generated/i.test(UNSLOP_PACK));
t("bans puffery vocabulary", /pivotal, crucial, testament/i.test(UNSLOP_PACK));
t("bans fancy 'is'", /"serves as", "stands as", "boasts"/i.test(UNSLOP_PACK));
t("bans 'not just X, but Y'", /not just X, but Y/i.test(UNSLOP_PACK));
t("bans em dashes and the parenthesis substitute", /No em dashes, and no parentheses or en dashes as substitutes/i.test(UNSLOP_PACK));
t("bans chatbot phrases", /I hope this helps!/i.test(UNSLOP_PACK));
t("bans filler", /"in order to" is "to"/i.test(UNSLOP_PACK));
t("bans abstract metaphor jargon", /substrate, wedge/i.test(UNSLOP_PACK));
t("has plain-speech rule: mechanism or number", /Name the mechanism or the number/i.test(UNSLOP_PACK));
t("has active-voice rule", /the loader parses the file/i.test(UNSLOP_PACK));
t("has add-voice rule", /vary sentence rhythm/i.test(UNSLOP_PACK));
t("practices what it preaches: no em dash in the pack text itself", !/—/.test(UNSLOP_PACK));
t("practices what it preaches: no curly quotes in the pack text", !/[‘’“”]/.test(UNSLOP_PACK));
t("source label is a non-empty string", typeof unslopPackSource() === "string" && unslopPackSource().length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
