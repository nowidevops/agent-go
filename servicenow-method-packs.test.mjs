// servicenow-method-packs.test.mjs — gates + content of the four ServiceNow
// method packs (post-deployment / code review / incident resolution / RCA).
// Run: node servicenow-method-packs.test.mjs   Author: iDevOpsLLC
import { SN_POSTDEPLOY_PACK, needsSnPostDeployPack, postDeployProdTarget } from "./servicenow-postdeploy-pack.js";
import { SN_CODEREVIEW_PACK, needsSnCodeReviewPack } from "./servicenow-codereview-pack.js";
import { SN_INCIDENT_RESOLUTION_PACK, needsSnIncidentResolutionPack } from "./servicenow-incident-resolution-pack.js";
import { SN_RCA_PACK, needsSnRcaPack } from "./servicenow-rca-pack.js";
import { needsRcaPack } from "./rca-pack.js";
import { needsResearchPack } from "./research-pack.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const SN_URL = "https://dev000000.service-now.com/now/nav/ui/classic/params/target/incident_list.do";

console.log("\u2014 post-deployment gate \u2014");
const PD_A = `Post-deployment validation in ServiceNow.\nSource Instance: https://dev000000.service-now.com (NON-PRODUCTION \u2014 DEV)\nTarget Instance: https://test111111.service-now.com (NON-PRODUCTION \u2014 TEST)\nParent Update Set: https://dev000000.service-now.com/sys_update_set.do?sys_id=abc\nDEPLOYMENT TYPE: NON-PRODUCTION -> NON-PRODUCTION\nVerify and validate the deployed update set content, then smoke-test the story.`;
const PD_B = `Post-deployment validation in ServiceNow.\nSource Instance: https://uat222222.service-now.com (NON-PRODUCTION \u2014 UAT)\nTarget Instance: https://acme.service-now.com (PRODUCTION)\nParent Update Set: https://uat222222.service-now.com/sys_update_set.do?sys_id=abc\nDEPLOYMENT TYPE: NON-PRODUCTION -> PRODUCTION\nPRODUCTION IS STRICTLY READ-ONLY \u2014 verify by query and read only.`;
t("'post-deployment validation' + update set trips", needsSnPostDeployPack(PD_A, ""));
t("'validate the deployed update set' trips", needsSnPostDeployPack("Validate the deployed update set on my ServiceNow test instance.", ""));
t("'smoke test' on an SN tab trips", needsSnPostDeployPack("Smoke test the change that just went in.", SN_URL));
t("'the update set was committed to test' trips", needsSnPostDeployPack("The update set was committed to test \u2014 confirm everything landed.", SN_URL));
t("non-SN post-deployment task does NOT trip", !needsSnPostDeployPack("Post-deployment validation of the Node service on staging.", ""));
t("plain SN build task does NOT trip", !needsSnPostDeployPack("Create a Business Rule that sets priority.", SN_URL));
t("plain SN code review does NOT trip", !needsSnPostDeployPack("Do a code review of this Business Rule on the incident table.", ""));

console.log("\u2014 post-deployment TRACK detection (production pin is fail-safe) \u2014");
t("Track A (non-prod -> non-prod) pins nothing", postDeployProdTarget(PD_A) === null);
t("Track B (non-prod -> PRODUCTION) pins the TARGET host", postDeployProdTarget(PD_B) === "acme.service-now.com");
t("the SOURCE host is never the pin", postDeployProdTarget(PD_B) !== "uat222222.service-now.com");
t("'non-production' never reads as production", postDeployProdTarget("Post-deployment validation. This is a non-production deployment to https://test1.service-now.com.") === null);
t("prose 'promoted to production' still pins", postDeployProdTarget("Post-deployment validation of the update set promoted to production at https://acme.service-now.com.") === "acme.service-now.com");
t("'Target Instance: ... (PROD)' with no DEPLOYMENT TYPE line still pins", postDeployProdTarget("Source Instance: https://dev1.service-now.com\nTarget Instance: https://acme.service-now.com (PROD)") === "acme.service-now.com");
t("production stated but target ambiguous \u2192 no pin (never pin the wrong host)", postDeployProdTarget("Promoted to production. Instances: https://a.service-now.com and https://b.service-now.com.") === null);
t("no production signal at all \u2192 no pin", postDeployProdTarget("Verify the deployed update set on https://test1.service-now.com.") === null);


console.log("— code review gate —");
t("'code review this Business Rule' trips", needsSnCodeReviewPack("Do a code review of this Business Rule on the incident table.", ""));
t("'review my script include for best practices' trips", needsSnCodeReviewPack("Review my Script Include for best practices.", ""));
t("SN tab + 'audit the script' trips", needsSnCodeReviewPack("Audit the script on this form.", SN_URL));
t("generic (non-SN) code review does NOT trip", !needsSnCodeReviewPack("Code review my Python script.", ""));
t("SN build task (no review verb) does NOT trip", !needsSnCodeReviewPack("Create a Business Rule that sets priority.", SN_URL));

console.log("— incident resolution gate —");
t("'resolve INC0012345' trips", needsSnIncidentResolutionPack("Resolve INC0012345 — users can't submit the form.", ""));
t("'triage this ServiceNow incident' trips", needsSnIncidentResolutionPack("Triage this ServiceNow incident and propose a fix.", ""));
t("SN tab + 'work the incident' trips", needsSnIncidentResolutionPack("Work the incident that just came in.", SN_URL));
t("'incident needs a fix' (verb after noun) trips", needsSnIncidentResolutionPack("This ServiceNow incident needs a fix today.", ""));
t("pure 'why did INC... happen' (no action verb) does NOT trip", !needsSnIncidentResolutionPack("Why did INC0012345 happen?", ""));
t("non-SN 'resolve the incident' does NOT trip", !needsSnIncidentResolutionPack("Resolve the incident from yesterday's standup.", ""));

console.log("— SN RCA gate —");
t("'root cause' + SN table trips", needsSnRcaPack("Find the root cause: sc_req_item records stopped getting assigned.", ""));
t("SN tab + 'investigate the error' trips", needsSnRcaPack("Investigate the error on this form — why does saving fail?", SN_URL));
t("'debug the client script' trips", needsSnRcaPack("Debug the Client Script — the field never goes read-only.", ""));
t("generic (non-SN) RCA does NOT trip SN pack", !needsSnRcaPack("Debug why my Node server keeps crashing.", ""));
t("non-diagnosis SN task does NOT trip", !needsSnRcaPack("Create a catalog item for laptop requests.", SN_URL));

console.log("— precedence: the intended pack wins the background.js chain —");
function winner(task, url) {
  if (needsSnPostDeployPack(task, url)) return "postdeploy";
  if (needsSnCodeReviewPack(task, url)) return "codereview";
  if (needsSnIncidentResolutionPack(task, url)) return "incident";
  if (needsSnRcaPack(task, url)) return "snrca";
  if (needsRcaPack(task)) return "rca";
  if (needsResearchPack(task)) return "research";
  return "none";
}
t("post-deployment task \u2192 postdeploy, NOT codereview", winner("Post-deployment validation: review the deployed update set content in ServiceNow.", SN_URL) === "postdeploy");
t("post-deployment outranks a smoke-test-shaped review", winner("Smoke test and code review the update set that was committed to test.", SN_URL) === "postdeploy");
t("review task → codereview", winner("Code review this Business Rule for issues.", SN_URL) === "codereview");
t("'resolve INC + find root cause' → incident (method embeds diagnosis)", winner("Resolve INC0012345 — troubleshoot and find the root cause.", "") === "incident");
t("'why does the BR fail' (no resolve verb) → snrca", winner("Why does the Business Rule fail on update?", "") === "snrca");
t("generic diagnosis still → generic rca", winner("Debug why my Node server keeps crashing.", "") === "rca");
t("deep research still → research", winner("Do deep research on MID Server sizing and summarize with cited URLs.", "") === "research");

console.log("— pack content: plan-first + evidence discipline + real tool names —");
for (const [name, pack] of [["postdeploy", SN_POSTDEPLOY_PACK], ["codereview", SN_CODEREVIEW_PACK], ["incident", SN_INCIDENT_RESOLUTION_PACK], ["snrca", SN_RCA_PACK]]) {
  t(`${name}: mandates a plan before acting`, /MANDATORY PLAN FIRST/.test(pack));
  t(`${name}: evidence-tied claims`, /CAPTURED/.test(pack) && /evidence/i.test(pack));
}
t("postdeploy: two tracks, production is strictly read-only", /TRACK A/.test(SN_POSTDEPLOY_PACK) && /TRACK B/.test(SN_POSTDEPLOY_PACK) && /STRICTLY READ-ONLY/.test(SN_POSTDEPLOY_PACK));
t("postdeploy: unknown target environment defaults to the read-only track", /treat it as TRACK B/.test(SN_POSTDEPLOY_PACK));
t("postdeploy: no smoke test in production", /do NOT smoke-test in production|skip this step entirely/i.test(SN_POSTDEPLOY_PACK));
t("postdeploy: verifies the real update-set tables", ["sys_update_set", "sys_update_xml", "sys_remote_update_set", "sys_update_preview_problem"].every((x) => SN_POSTDEPLOY_PACK.includes(x)));
t("postdeploy: 'committed' is not proof \u2014 live-record parity required", /NOT proof/.test(SN_POSTDEPLOY_PACK) && /sn_compare_record/.test(SN_POSTDEPLOY_PACK));
t("postdeploy: hunts what update sets do NOT carry (broken references)", /BROKEN REFERENCES/.test(SN_POSTDEPLOY_PACK));
t("postdeploy: dead-trigger Business Rule is an automatic CRITICAL", /ZERO of insert\/update\/delete\/query checked/.test(SN_POSTDEPLOY_PACK));
t("postdeploy: severity-ranked issue report + GO/NO-GO", /Severity \(Critical\/High\/Medium\/Low\)/.test(SN_POSTDEPLOY_PACK) && /VERDICT: GO or NO-GO/.test(SN_POSTDEPLOY_PACK));
t("postdeploy: click-by-click is required", /## Click-by-Click Validation Steps/.test(SN_POSTDEPLOY_PACK) && /## Click-by-Click Build Guide/.test(SN_POSTDEPLOY_PACK));
t("postdeploy: never present a truncated manifest as complete", /NEVER present a truncated manifest as complete/.test(SN_POSTDEPLOY_PACK));
t("postdeploy: saves the report via write_file", /SAVE THE REPORT/.test(SN_POSTDEPLOY_PACK) && /write_file/.test(SN_POSTDEPLOY_PACK));
t("codereview: read-only unless asked to fix", /READ-ONLY/.test(SN_CODEREVIEW_PACK));
t("codereview: dead-trigger = automatic critical", /CRITICAL/.test(SN_CODEREVIEW_PACK) && /Insert\/Update\/Delete\/Query/.test(SN_CODEREVIEW_PACK));
t("codereview: GO/NO-GO verdict", /GO \/ NO-GO/.test(SN_CODEREVIEW_PACK));
t("codereview: saves report via write_file when a folder is given", /SAVE THE REPORT/.test(SN_CODEREVIEW_PACK) && /write_file/.test(SN_CODEREVIEW_PACK) && /INCOMPLETE/.test(SN_CODEREVIEW_PACK));
t("codereview: read-only is scoped to the instance, not the doc folder", /READ-ONLY ON THE INSTANCE/.test(SN_CODEREVIEW_PACK) && /NOT an instance write/.test(SN_CODEREVIEW_PACK));
t("incident: state change is approval-gated", /ASK the user/.test(SN_INCIDENT_RESOLUTION_PACK) && /never flip incident state/.test(SN_INCIDENT_RESOLUTION_PACK));
t("incident: verification before 'resolved'", /No verification, no "resolved"/.test(SN_INCIDENT_RESOLUTION_PACK));
t("snrca: 5-Whys + confidence verdict", /5-Whys/.test(SN_RCA_PACK) && /confidence \(high\/medium\/low\)/.test(SN_RCA_PACK));
t("snrca: sibling-rule ordering sweep", /ORDERBYorder/.test(SN_RCA_PACK));
// Every tool a pack names must be a REAL tool (drift guard).
const REAL = ["sn_query_table", "sn_query_record", "sn_query_session", "sn_recent_changes", "sn_compare_record", "sn_search_script_body", "sn_fetch_script_by_name", "sn_fetch_script_by_sysid", "sn_api_reference", "sn_set_field", "sn_check_duplicate", "sn_update_record", "save_record", "read_console", "read_network", "read_page", "query_elements", "list_editors", "get_editor_value", "set_editor_value", "open_form_section", "capture_screenshot", "navigate", "write_file"];
for (const [name, pack] of [["postdeploy", SN_POSTDEPLOY_PACK], ["codereview", SN_CODEREVIEW_PACK], ["incident", SN_INCIDENT_RESOLUTION_PACK], ["snrca", SN_RCA_PACK]]) {
  const named = [...new Set((pack.match(/\b(?:sn_[a-z_]+|read_console|read_network|read_page|query_elements|list_editors|[gs]et_editor_value|open_form_section|capture_screenshot|save_record|navigate|write_file)\b/g) || []))]
    .filter((n) => n !== "sn_ws"); // sn_ws.RESTMessageV2 is a platform API namespace, not a tool
  const bogus = named.filter((n) => !REAL.includes(n));
  t(`${name}: every named tool exists (${named.length} named)`, bogus.length === 0, bogus.join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
