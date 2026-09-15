// servicenow-postdeploy-pack.js — ServiceNow POST-DEPLOYMENT method pack:
// validate/verify what an update set actually landed on a target instance, and
// smoke-test it where that is allowed. Injected (background.js) when the task
// is post-deployment shaped, the same keyword-gated way the code-review /
// incident-resolution / RCA packs inject, and it OUTRANKS them in the chain —
// "review the deployed update set" is a deployment check, not a code review.
//
// The load-bearing distinction is the TARGET ENVIRONMENT:
//   Track A  non-prod → non-prod : verify the payload AND smoke-test the story.
//   Track B  non-prod → PRODUCTION : verify the payload, STRICTLY READ-ONLY.
// Track B is not left to the prompt's good intentions — postDeployProdTarget()
// extracts the production host and background.js pins the whole run read-only on
// it in code (snInstanceReadOnly guard), so the instance-write tools are refused
// even if the model decides a "quick check" is harmless. Author: iDevOpsLLC

// SN-flavored context: an SN instance tab, SN vocabulary, or update-set vocabulary
// in the task itself. Wider than the code-review pack's version because a
// deployment task talks about update sets and instances, not always about scripts.
function snContext(t, tabUrl) {
  return /\.(?:service-now\.com|example\.com)\b/i.test(String(tabUrl || ""))
    || /\b(servicenow|service-now|update set|sys_update_xml|sys_remote_update_set|business rule|script include|client script|ui action|ui policy|scripted rest|catalog item|record producer|flow designer|acl|sp_widget|service portal)\b/i.test(t)
    || /\.(?:service-now\.com|example\.com)\b/i.test(t);
}

export function needsSnPostDeployPack(taskText, tabUrl) {
  const t = String(taskText || "");
  if (!snContext(t, tabUrl)) return false;
  return /\bpost[-\s]?deploy(?:ment)?\b/i.test(t)
    || /\bdeployment\s+(?:validation|verification|check|review|sign[-\s]?off)\b/i.test(t)
    || /\bsmoke[-\s]?test/i.test(t)
    || /\b(?:validate|verify|confirm)\b[^.\n]{0,60}\b(?:deployed|committed|promoted|migrated|retrieved)\b/i.test(t)
    || /\b(?:deployed|committed|promoted|migrated|retrieved)\b[^.\n]{0,40}\bupdate set\b/i.test(t)
    || /\bupdate set\b[^.\n]{0,60}\b(?:was |has been |been )?(?:deployed|committed|promoted|migrated|retrieved)\b/i.test(t);
}

// Every host mentioned in the text, lowercased, in order of appearance.
function hostsIn(text) {
  return [...String(text || "").matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase());
}

// "production" that is NOT "non-production". Strip the negated form first so
// "this is a non-production deployment" can never read as a production one.
function saysProduction(text) {
  return /\bprod(?:uction)?\b/i.test(deNegate(text));
}
function deNegate(text) {
  return String(text || "").replace(/\bnon[-\s]?prod(?:uction)?\b/gi, "NONPROD");
}

// Is the TARGET of this deployment production? Returns the production host to pin
// read-only, or null. Primary signal is the machine-readable classification line
// the Post-Deployment preset directive forces the prompt writer to emit:
//   DEPLOYMENT TYPE: NON-PRODUCTION -> PRODUCTION
// Falls back to prose ("promoted to production", "Target Instance: ... (PROD)")
// when a hand-written prompt skipped the line. Fail-safe by design: an ambiguous
// task that names a production target pins read-only — the cost of a false
// positive is a skipped smoke test, the cost of a false negative is a prod write.
export function postDeployProdTarget(taskText) {
  const t = String(taskText || "");
  const lines = t.split(/\r?\n/);
  const typeLine = lines.find((l) => /\bdeployment\s+type\b/i.test(l)) || "";
  const targetLine = lines.find((l) => /\btarget\s+instance\b/i.test(l)) || "";

  let isProd;
  if (typeLine) {
    // Classify by the RIGHT of the arrow only — the source half is irrelevant.
    isProd = saysProduction(typeLine.split(/->|-->|→|=>/).pop());
  } else {
    isProd = (targetLine && saysProduction(targetLine))
      || /\b(?:to|into|onto)\s+(?:the\s+)?prod(?:uction)?\b/i.test(deNegate(t))
      || /\bprod(?:uction)?\s+(?:deployment|release|instance|target|environment)\b/i.test(deNegate(t));
  }
  if (!isProd) return null;

  // Which host to pin. The "Target Instance:" line is authoritative; otherwise a
  // single unambiguous host in the whole task. Two-plus hosts and no target line
  // means we cannot tell source from target — return null rather than pin the
  // wrong one (the pack text still enforces read-only at the prompt level).
  const fromTarget = hostsIn(targetLine)[0];
  if (fromTarget) return fromTarget;
  const all = [...new Set(hostsIn(t))];
  return all.length === 1 ? all[0] : null;
}

export const SN_POSTDEPLOY_PACK = `SERVICENOW POST-DEPLOYMENT MODE — this task is POST-DEPLOYMENT VALIDATION, VERIFICATION and (where allowed) SMOKE TESTING of an update set that has already been moved between instances. You are not building anything. Every statement you make must cite CAPTURED evidence — a queried record, a fetched script body, a field value you read, a screenshot. "It looks fine" is not a finding; "sys_script 'Set Priority' exists on the target, active=true, sys_updated_on 2026-08-20 14:02, script matches source byte-for-byte" is.

⛔ MANDATORY PLAN FIRST (no verdicts before evidence): before touching anything, POST a VALIDATION PLAN as your reply — (a) SOURCE instance and TARGET instance, each classified NON-PRODUCTION or PRODUCTION, (b) which TRACK you are on (A or B below) and therefore whether a smoke test is permitted, (c) the parent and child update sets you will verify (name + sys_id + URL), (d) how you will read each side (sn_query_table with the instance parameter for a connected instance, sn_query_session for the logged-in tab, navigate + read_page when neither), (e) the checks you will run. Only AFTER the plan is posted do you start querying.

⛔ ENVIRONMENT GATE — DO THIS FIRST, BEFORE ANY OTHER STEP. Classify the TARGET instance:
- TRACK A — NON-PRODUCTION → NON-PRODUCTION (dev→test, test→QA, QA→UAT): full validation AND a smoke test.
- TRACK B — NON-PRODUCTION → PRODUCTION: validation ONLY. THE PRODUCTION INSTANCE IS STRICTLY READ-ONLY.
If you cannot establish the target's environment from the task, ASK — do not guess, and until answered treat it as TRACK B.

🔒 TRACK B — PRODUCTION IS STRICTLY READ-ONLY. Forbidden on the production instance, without exception, even to "just confirm it works": creating/updating/deleting ANY record; clicking Save / Update / Submit / Insert / Delete / Copy / Repair on any form; Background Scripts (sys.scripts.do) or any Fix Script execution; "Execute Now" on a scheduled job; test-running a Flow, Workflow, or ATF suite; impersonating a user; previewing/committing/backing out an update set; changing a system property; adding an attachment. Verification in production is done by QUERY and READ ONLY (sn_query_table / sn_query_session / sn_fetch_script_by_name / navigate + read_page / query_elements / capture_screenshot). Typing into a LIST FILTER or a search box to read data is fine; anything that persists is not. If proving the fix genuinely requires exercising it, DO NOT run it — write up the exact test, who should run it, and the click steps, and hand it to the business. The instance-write tools are disabled in code for this run; if one is refused, that is the guardrail working — report it, do not route around it.

1. IDENTIFY THE UPDATE SETS — resolve the parent and every child to real records before verifying anything. On the SOURCE: sys_update_set (fields name,state,parent,application,sys_id) for the parent; then sys_update_set with query parent=<parent sys_id> for the children. Confirm every one is state=complete — a set left "in progress" was never fully captured, and anything added after it was marked complete never travelled. Record each sys_id; you will need them.
2. BUILD THE SOURCE MANIFEST — the ground truth of what SHOULD have landed. Query sys_update_xml with query update_set=<set sys_id> and fields name,type,target_name,action,sys_id, one query per set. Report the TOTAL row count per set and group by type. ⚠ The query tools cap results (~50 rows) — if a set carries more than you can list, say so explicitly, list what you retrieved, and open the same filtered list in the UI (navigate to sys_update_xml_list.do?sysparm_query=update_set=<sys_id>) to read the true count. NEVER present a truncated manifest as complete.
3. CONFIRM THE DEPLOYMENT ACTUALLY COMPLETED on the TARGET — query sys_remote_update_set by name and read state, commit_date, application, remote_sys_id, update_source. state must be "committed". "loaded" or "previewed" means the deployment NEVER APPLIED — that is a CRITICAL finding and you stop treating the rest as deployed. Verify the children were committed too, not just the parent, and that commit_date is consistent with the deployment window you were given.
4. READ THE PREVIEW PROBLEMS — query sys_update_preview_problem with remote_update_set=<remote set sys_id>. Every row resolved as SKIPPED is a payload item that did NOT apply — enumerate them by name and type; each is at minimum a High finding, and one skipped script is enough to make the deployment functionally incomplete. Rows accepted as "accept remote update" OVERWROTE something on the target — list what was overwritten, because that is how a target-only hotfix silently disappears.
5. VERIFY EVERY ARTIFACT LIVES ON THE TARGET — the remote update set saying "committed" is NOT proof the artifact works. For each item in the source manifest, query its REAL table on the target and confirm: the record EXISTS, active=true (where the type has an active flag), and sys_updated_on is at or after the commit. Then compare it to the source:
   - Cross-instance diff, when both instances are connected: sn_compare_record with table + sysId + instance_a=<source> + instance_b=<target> — it returns only the fields that actually DIFFER, which is exactly the evidence a finding needs.
   - Script bodies: sn_fetch_script_by_name / sn_fetch_script_by_sysid on EACH instance and compare the text. A difference in the script body after a deployment means the target is running something the source never shipped.
   - Only ONE instance reachable? Say so, and mark every cross-instance claim "NOT VERIFIED — no <source|target> connection". Never assert parity you did not measure.
6. VERIFY THE CONFIGURATION, NOT JUST THE SCRIPT — a deployed artifact with the wrong config is a dead artifact. Per type, read and report these fields:
   - Business Rule (sys_script): when, order, active, insert/update/delete/query flags, condition, filter_condition, script. ⚠ ZERO of insert/update/delete/query checked = it can never fire = CRITICAL.
   - Client Script (sys_script_client): type (onLoad/onChange/onSubmit/onCellEdit), table, field, ui_type, applies_extended, active, script.
   - Script Include (sys_script_include): api_name, client_callable, access, active, script.
   - UI Policy (sys_ui_policy) AND its actions (sys_ui_policy_action, query ui_policy=<sys_id>) — the actions are a SEPARATE table and are the classic "the policy came across but does nothing" miss.
   - UI Action (sys_ui_action): action_name, form_button/list_button/list_context_menu flags, condition, order, script.
   - ACL (sys_security_acl): operation, type, name, active, admin_overrides, script — AND its roles (sys_security_acl_role, query sys_security_acl=<sys_id>). Missing role rows = an ACL that grants far more than intended.
   - Catalog Item (sc_cat_item): active, category, workflow/flow, and its variables (item_option_new, query cat_item=<sys_id> — the label field is question_text, not question) plus variable sets (io_set_item).
   - Flow / Subflow (sys_hub_flow): active/status — ⚠ flows commonly arrive INACTIVE and must be published/activated on the target.
   - Scheduled Job (sysauto_script): active, run_type, run_time, script. ⚠ the sys_trigger next-run row does NOT travel — an inactive or unscheduled job on the target is a real finding.
   - Notification (sysevent_email_action): active, event/table, when-to-send conditions, recipients, template — and that any event it fires on exists in sysevent_register on the target.
   - Transform Map (sys_transform_map) plus its field maps (sys_transform_entry, query map=<sys_id>).
   - Scripted REST (sys_ws_definition + sys_ws_operation): active, base path, http_method, operation script, ACL requirement.
   - Widget (sp_widget): template, server/client script, option schema, and its sp_dependency links.
   - Dictionary/choices (sys_dictionary, sys_choice) and system properties (sys_properties): ⚠ property VALUES are environment-specific and are frequently different ON PURPOSE — report a difference as a question, not automatically as a defect.
7. HUNT THE THINGS UPDATE SETS DO NOT CARRY — this is where post-deployment defects actually live, and none of them show up as a preview problem: data records (anything not explicitly added to the update set), sys_choice rows in some cases, group/role MEMBERSHIP, scheduled-job triggers, homepages/dashboards/reports, attachments and images, and — the big one — BROKEN REFERENCES: any reference field in the payload pointing at a sys_id that exists only on the source (a group, a user, a template, an assignment rule, a catalog category). For every reference the deployed artifacts depend on, query the target for that sys_id and confirm it resolves. An unresolvable reference is a High or Critical finding even though the deployment reported success.
8. TRACK A ONLY — SMOKE TEST. Derive the test cases from the STORY's acceptance criteria (read the story first; if you were given a story number/URL, pull the record). For each criterion: state the expected behavior, exercise it in the UI on the target (navigate → set the fields → observe), and capture the evidence (read_page / query_elements / capture_screenshot / a follow-up query of the record). Prefer a NEW throwaway test record over touching existing data, and list every record you create or modify so it can be cleaned up. Include the NEGATIVE path — the security/ACL case where the behavior must NOT happen. After each test, check read_console for JavaScript errors and query syslog (level=error, recent) for server-side errors the UI swallowed. A criterion you could not exercise is reported as NOT TESTED with the reason — never as passed. Then give a test table: | # | Acceptance criterion | Steps | Expected | Actual | PASS/FAIL/NOT TESTED | Evidence |.
   TRACK B: skip this step entirely. Write the same table with the steps the business should run, every row marked NOT TESTED — PRODUCTION READ-ONLY, and name who should run it.
9. REPORT EVERY ISSUE FOUND — a severity-ranked table: | # | Severity (Critical/High/Medium/Low) | Environment (source/target) | Artifact (type · name · table · sys_id) | Expected | Actual | Evidence | Impact | Recommended fix |. No finding without its captured evidence. If you found nothing, say "No issues found" explicitly and show the coverage that entitles you to say it (items verified / items in the manifest). Close with a VERDICT: GO or NO-GO for this deployment, one sentence of reasoning. NO-GO on any unresolved Critical, any skipped payload item, or any manifest you could verify only in part.
10. CLICK-BY-CLICK — REQUIRED. End the report with:
   "## Click-by-Click Validation Steps" — the numbered UI path for a mid-level admin to REPRODUCE every check by hand: exact navigation (e.g. \`All → System Update Sets → Retrieved Update Sets\`), the filter or query to type, the fields to read, and what value proves the check passed. Include the list/filter URLs you used.
   "## Click-by-Click Build Guide" — ONLY when you are recommending a fix: numbered admin steps to apply it (navigation path, field-by-field values including checkboxes, the explicit Save/Update/Activate click, a test table, and rollback). ⚠ If the fix targets PRODUCTION, write the guide as instructions for the authorized person to execute — you do not execute it. If there is nothing to fix, say so instead of fabricating a guide.
11. SAVE THE REPORT — if the task names an output folder OR filesystem access is mounted (write_file available), write the FULL report as markdown into that folder BEFORE your final reply (e.g. POST_DEPLOYMENT_VALIDATION_<update-set-or-story>.md) and state the exact saved path. Saving locally is NOT an instance write and is allowed on Track B. A validation you were asked to document and did not write out is INCOMPLETE.

RULES: never assert an artifact deployed correctly because the update set says "committed" — prove it against the live record. Never assert an API or behavior you did not verify against sn_api_reference or the fetched code. Report honestly what you could not reach: an unconnected instance, a truncated manifest, an untestable criterion. A partial validation reported as partial is useful; a partial validation reported as complete is how a broken release reaches production.`;
