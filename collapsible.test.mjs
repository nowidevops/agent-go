// collapsible.test.mjs — Settings categories are collapsible and collapsed by default (owner
// directive 2026-09-12), the Save row is never folded away, and a focused field expands its
// ancestors. Runs the real options.html through jsdom. Run: node collapsible.test.mjs
// Author: iDevOpsLLC
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch { console.log("SKIP collapsible.test.mjs — run `npm i -D jsdom` to enable this suite"); process.exit(process.env.AGENTGO_ALLOW_SKIP === "0" ? 1 : 77); }

const html = readFileSync(new URL("./options.html", import.meta.url), "utf8");
const dom = new JSDOM(html, { url: "chrome-extension://test/options.html" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.location = dom.window.location;
const { initCollapsibleSettings } = await import("./collapsible.js");
initCollapsibleSettings();

let pass = 0, fail = 0;
const t = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); } };
const inHiddenBody = (el) => { let n = el; while (n) { if (n.classList && n.classList.contains("cat-body") && n.hidden) return true; n = n.parentElement; } return false; };

const heads = [...document.querySelectorAll(".cat-head")];
const bodies = [...document.querySelectorAll(".cat-body")];
t("at least 12 categories became toggles", heads.length >= 12, String(heads.length));
t("every category has a body and every body starts hidden", bodies.length === heads.length && bodies.every((b) => b.hidden));
t("every h2 inside a non-details card is a toggle", [...document.querySelectorAll(".card:not(details) > h2")].every((h) => h.classList.contains("cat-head")));
t("every pack-group title is a toggle", [...document.querySelectorAll(".packGroupTitle")].every((h) => h.classList.contains("cat-head")));
t("Save and Reset are never inside a collapsed body", !inHiddenBody(document.getElementById("save")) && !inHiddenBody(document.getElementById("reset")));
t("toggles are keyboard-accessible (role=button, tabindex, aria-expanded)", heads.every((h) => h.getAttribute("role") === "button" && h.getAttribute("tabindex") === "0" && h.getAttribute("aria-expanded") === "false"));
heads[0].click();
t("click expands a category", heads[0].getAttribute("aria-expanded") === "true" && bodies[0].hidden === false);
heads[0].click();
t("second click collapses it again", heads[0].getAttribute("aria-expanded") === "false" && bodies[0].hidden === true);
const live = document.getElementById("liveTradingPackEnabled");
t("REAL-MONEY toggle starts inside a collapsed body", !!live && inHiddenBody(live));
live.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
t("focusing a field expands every collapsed ancestor", !inHiddenBody(live));
for (const id of ["ollamaBase", "model", "maxSteps", "phaseFilesUrl", "desktopControlEnabled", "liveOrderSubmissionEnabled"]) {
  const e = document.getElementById(id); if (e) t(`field #${id} still exists after wrapping`, true);
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
