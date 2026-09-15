// prompt-builder.test.mjs — Prompt Builder meta-prompt + message assembly
// (2026-07-22e). Run: node prompt-builder.test.mjs   Author: iDevOpsLLC
import { PROMPT_WRITER_SYSTEM, buildPromptWriterMessages, SN_AREAS } from "./prompt-builder.js";
import { needsServiceNowPack } from "./servicenow-pack.js";
import { needsSnPostDeployPack, postDeployProdTarget } from "./servicenow-postdeploy-pack.js";
import { needsSnCodeReviewPack } from "./servicenow-codereview-pack.js";
import { needsResearchPack } from "./research-pack.js";
import { needsRcaPack } from "./rca-pack.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

console.log("— capability sheet covers every promptable tool family —");
for (const kw of ["navigate", "read_page", "query_elements", "capture_screenshot", "sn_query_table", "sn_api_reference", "search_files", "create_document", "run_command", "desktop_click", "spawn_subagent", "scope_url", "Read-only", "google_search", "fetch_page", "set_editor_value"]) {
  t(`mentions ${kw}`, PROMPT_WRITER_SYSTEM.includes(kw));
}

console.log("— prompt-writing lessons from the 2026-07-22 transcript are encoded —");
t("mandates step budgets", /step budget|at most N tool calls/i.test(PROMPT_WRITER_SYSTEM));
t("mandates exact URLs / no guessing", /EXACT URLs/i.test(PROMPT_WRITER_SYSTEM) && /never guess/i.test(PROMPT_WRITER_SYSTEM));
t("mandates a verify / finish criterion", /verify criterion|finish line/i.test(PROMPT_WRITER_SYSTEM));
t("forbids inventing details; uses placeholders", PROMPT_WRITER_SYSTEM.includes("NEVER invent") && PROMPT_WRITER_SYSTEM.includes("<PASTE RECORD NUMBER>"));
t("output is the prompt ONLY (no fences/preamble)", /ONLY the finished prompt/i.test(PROMPT_WRITER_SYSTEM) && /no markdown code fences/i.test(PROMPT_WRITER_SYSTEM));

console.log("— message assembly —");
const noPage = buildPromptWriterMessages("open my dashboard folder", null);
t("system + user roles", noPage.length === 2 && noPage[0].role === "system" && noPage[1].role === "user");
t("goal is embedded verbatim", noPage[1].content.includes("open my dashboard folder"));
t("no page block when page is null", !noPage[1].content.includes("ACTIVE TAB"));

const withPage = buildPromptWriterMessages("summarize this page", { title: "<local path> Folder Dashboard", url: "http://localhost:8790/" });
t("active-tab context woven in", withPage[1].content.includes("ACTIVE TAB") && withPage[1].content.includes("http://localhost:8790/"));

const chromePage = buildPromptWriterMessages("do a thing", { title: "Extensions", url: "chrome://extensions" });
t("chrome:// tabs are excluded from context", !chromePage[1].content.includes("chrome://extensions"));

console.log("— preset directives force pack-trigger phrasing —");
const pSn = buildPromptWriterMessages("build a BR", null, "servicenow")[1].content;
const pRev = buildPromptWriterMessages("check this script", null, "review")[1].content;
const pRes = buildPromptWriterMessages("compare vendors", null, "research")[1].content;
const pBro = buildPromptWriterMessages("fill the form", null, "browser")[1].content;
const pFf = buildPromptWriterMessages("verify STRY0000001", null, "factfinding")[1].content;
t("servicenow preset directive included", pSn.includes("PRESET: ServiceNow build") && pSn.includes('"ServiceNow"'));
t("review preset directive included", pRev.includes("PRESET: Code review") && pRev.includes("READ-ONLY"));
t("factfinding preset directive included", pFf.includes("PRESET: Fact finding") && pFf.includes('"fact finding"') && pFf.includes("READ-ONLY"));
t("factfinding directive carries the 3-step structure", pFf.includes("READ the user story") && pFf.includes("FIND AND LIST every artifact") && pFf.includes("RE-WRITE the story"));
t("research preset directive included", pRes.includes("PRESET: Deep research") && pRes.includes('"deep research"'));
t("browser preset directive included", pBro.includes("PRESET: Browser task") && pBro.includes("step budget"));
t("unknown preset adds no directive", !buildPromptWriterMessages("x", null, "nope")[1].content.includes("PRESET:"));
t("no preset adds no directive", !buildPromptWriterMessages("x", null)[1].content.includes("PRESET:"));

console.log("— the mandated phrasing actually trips the REAL run-time detectors —");
t("'ServiceNow' trips needsServiceNowPack", needsServiceNowPack("In my ServiceNow instance https://dev000000.service-now.com, build a Business Rule.", ""));
t("chip template phrasing trips needsResearchPack", needsResearchPack("Do deep research on MID Server sizing and summarize with cited URLs."));
t("'investigate the issue' (browser directive's RCA phrasing) trips needsRcaPack", needsRcaPack("Investigate the issue on the checkout page — why does saving fail?"));
t("fact-finding chip template trips needsServiceNowPack", needsServiceNowPack("Fact finding for ServiceNow user story STRY0000001 in https://customer-dev.example.com: read the story, list every artifact involved, re-write it. Read-only — change nothing.", ""));
// The standing read-only instance grant (background.js SN_RESEARCH_TASK_RE, owner
// directive 2026-08-20) matches on "fact finding" — keep this phrase-shape assertion
// in sync with that regex so the chip's output keeps tripping the grant.
t("fact-finding phrase shape matches the instance-grant regex", /\bfact[\s-]?find(?:ing)?\b/i.test("Fact finding for ServiceNow user story STRY0000001"));

console.log("\u2014 post-deployment preset \u2014");
const pPd = buildPromptWriterMessages("validate the deployment", null, "postdeploy")[1].content;
t("postdeploy preset directive included", pPd.includes("PRESET: Post-deployment validation"));
t("forces the pack-trigger phrasing", pPd.includes('"ServiceNow"') && pPd.includes('"post-deployment validation"'));
t("mandates the machine-readable DEPLOYMENT TYPE line", pPd.includes("DEPLOYMENT TYPE: NON-PRODUCTION -> NON-PRODUCTION") && pPd.includes("DEPLOYMENT TYPE: NON-PRODUCTION -> PRODUCTION"));
t("mandates source/target/parent/child inputs", ["Source Instance:", "Target Instance:", "Parent Update Set:", "Child Update Set:"].every((k) => pPd.includes(k)));
t("unknown target environment defaults to the PRODUCTION (read-only) track", /defaulting to the read-only track is the safe error/.test(pPd));
t("mandates the strictly-read-only production line", pPd.includes("PRODUCTION IS STRICTLY READ-ONLY"));
t("mandates smoke test only on a non-production target", /NON-PRODUCTION TARGET ONLY \u2014 a SMOKE TEST/.test(pPd));
t("mandates the issue report + GO / NO-GO verdict", pPd.includes("REPORT EVERY ISSUE FOUND") && pPd.includes("GO / NO-GO"));
t("mandates the click-by-click sections", pPd.includes("## Click-by-Click Validation Steps") && pPd.includes("## Click-by-Click Build Guide"));
t("forbids inventing instance hosts", /never invent a host/.test(pPd));

console.log("\u2014 the postdeploy chip output trips the REAL run-time detectors \u2014");
const PD_PROMPT = `Post-deployment validation in ServiceNow.
Source Instance: https://dev000000.service-now.com (NON-PRODUCTION \u2014 DEV)
Target Instance: https://acme.service-now.com (PRODUCTION)
Parent Update Set: https://dev000000.service-now.com/sys_update_set.do?sys_id=abc
DEPLOYMENT TYPE: NON-PRODUCTION -> PRODUCTION
Verify and validate the deployed update set content, report every issue found, and give the click-by-click steps.`;
t("trips needsServiceNowPack", needsServiceNowPack(PD_PROMPT, ""));
t("trips needsSnPostDeployPack", needsSnPostDeployPack(PD_PROMPT, ""));
t("production target is detected and pinned", postDeployProdTarget(PD_PROMPT) === "acme.service-now.com");
t("postdeploy does NOT hijack the code-review pack chain", !(needsSnCodeReviewPack(PD_PROMPT, "") && !needsSnPostDeployPack(PD_PROMPT, "")));

console.log("— ServiceNow focus areas (multi-select) —");
const pAreas = buildPromptWriterMessages("prompt for async lookup", null, "servicenow", ["GlideAjax", "Client Script", "Script Include"])[1].content;
t("selected areas woven into the directive", pAreas.includes("SERVICENOW FOCUS AREAS: GlideAjax, Client Script, Script Include"));
t("directive mandates exact naming + sn_api_reference grounding", pAreas.includes("EXACTLY as written") && pAreas.includes("sn_api_reference"));
t("directive scopes: no other artifact types", pAreas.includes("stay WITHIN these areas"));
t("unknown area names are dropped (allowlist)", !buildPromptWriterMessages("x", null, "servicenow", ["DROP TABLE", "GlideAjax"])[1].content.includes("DROP TABLE"));
t("all-unknown list adds no areas block", !buildPromptWriterMessages("x", null, "servicenow", ["bogus"])[1].content.includes("SERVICENOW FOCUS AREAS"));
t("no areas param adds no areas block", !buildPromptWriterMessages("x", null, "servicenow")[1].content.includes("SERVICENOW FOCUS AREAS"));
t("SN_AREAS names all trip needsServiceNowPack context (sanity: 'ServiceNow' + area)", SN_AREAS.every((a) => needsServiceNowPack(`In my ServiceNow instance, work on the ${a}.`, "")));

console.log("— attachments (images vision-described, text quoted) —");
const pAtt = buildPromptWriterMessages("fix the form", null, null, null, [
  { name: "error.png", kind: "image", summary: "Red banner: 'Mandatory field Caller is empty'" },
  { name: "notes.md", kind: "text", summary: "Table is incident. Field caller_id." }
])[1].content;
t("attachment block present with bake-in instruction", pAtt.includes("SUPPORTING CONTEXT FROM THE USER'S ATTACHED FILES") && pAtt.includes("will NOT have these files"));
t("image marked vision-described with its summary", pAtt.includes("[image (vision-described)] error.png") && pAtt.includes("Mandatory field Caller"));
t("text file quoted with its content", pAtt.includes("[file] notes.md") && pAtt.includes("caller_id"));
t("no attachments → no block", !buildPromptWriterMessages("x", null)[1].content.includes("SUPPORTING CONTEXT"));
t("malformed attachments dropped", !buildPromptWriterMessages("x", null, null, null, [{ name: "a" }, null, { summary: "s" }])[1].content.includes("SUPPORTING CONTEXT"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
