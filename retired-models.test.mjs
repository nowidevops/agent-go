// retired-models.test.mjs — Ollama Cloud retired kimi-k2.5:cloud (2026-07-31) and deepseek-v4-flash:cloud /
// qwen3.5:397b:cloud (2026-09-25); each answers HTTP 410. No default chain or picker entry may route to
// one, and a saved profile still pointing at one reads as Auto ("").
// Run: node retired-models.test.mjs   Author: iDevOpsLLC
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const RETIRED = ["kimi-k2.5:cloud", "deepseek-v4-flash:cloud", "qwen3.5:397b:cloud"];
const routes = (src) => RETIRED.filter((m) => src.includes(`model: "${m}"`) || src.includes(`id: "${m}"`));

console.log("— retired Ollama Cloud models —");
t("no default role chain routes to a retired model", routes(readFileSync(new URL("./phase-engine.js", import.meta.url), "utf8")).length === 0);
t("the model picker lists no retired model", routes(readFileSync(new URL("./cloud.js", import.meta.url), "utf8")).length === 0);

let saved = {};
globalThis.chrome = { storage: { sync: { get: async () => ({ settings: saved }), set: async () => {} }, local: { get: async () => ({}) } } };
const { getSettings } = await import("./settings.js");
async function modelFor(m) {
  saved = { model: m, modelAutoDefaultV1: true, visionModelDefaultV2: true, implementationPhasesDefaultV2: true };
  return (await getSettings()).model;
}
for (const m of RETIRED) t(`saved ${m} reads as Auto`, (await modelFor(m)) === "");
t("a live model is kept", (await modelFor("kimi-k3:cloud")) === "kimi-k3:cloud");
t("Auto stays Auto", (await modelFor("")) === "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
