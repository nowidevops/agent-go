// servicenow-codereview-pack.js — ServiceNow Code-Review method pack. Injected
// (background.js) when the task is a review/audit of ServiceNow code, the same
// keyword-gated way the research/RCA packs inject. Turns "read the script and
// opine" into a fetch-real-code → context-sweep → checklist → severity-ranked
// findings → GO/NO-GO discipline built on the live evidence tools
// (get_editor_value, sn_fetch_script_by_name, sn_query_session). Kept concise
// so smaller local models aren't overloaded (the fable-pack default-ON lesson).
// Author: iDevOpsLLC

import { isServiceNowUrl } from "./servicenow-pack.js";

// SN-flavored context: an SN instance tab, or SN vocabulary in the task itself.
function snContext(t, tabUrl) {
  return isServiceNowUrl(tabUrl)
    || /\b(servicenow|service-now|business rule|script include|client script|ui action|ui policy|scripted rest|glide\w*|g_form|fix script|catalog (item|client) script|record producer|sys_script\w*|sp_widget|service portal)\b/i.test(t)
    || /\bINC\d{5,}|\bCHG\d{5,}|\bPRB\d{5,}/i.test(t);
}

export function needsSnCodeReviewPack(taskText, tabUrl) {
  const t = String(taskText || "");
  if (!snContext(t, tabUrl)) return false;
  return /\b(code review|peer review|review (this|the|my|our|each|all) .{0,40}(script|code|rule|include|widget|artifact|update set)|review (it|this|the record) for (quality|issues|defects|bugs|best practices)|audit (this|the|my) .{0,40}(script|code|rule|include|widget)|(quality|security|best[- ]practice) (check|review|audit)|find (issues|defects|problems|bugs) in (this|the|my) .{0,40}(script|code|rule))\b/i.test(t);
}

export const SN_CODEREVIEW_PACK = `SERVICENOW CODE REVIEW MODE — this task is a REVIEW. It is READ-ONLY ON THE INSTANCE: change no ServiceNow data (no record writes, no form saves, no sn_update_record) unless the user explicitly asked you to also fix it. Saving your report to a documentation folder (step 6) is NOT an instance write — it is required when asked. Every finding must cite CAPTURED evidence — a fetched line of code, a queried record, a field state you read.

⛔ MANDATORY PLAN FIRST (no verdicts before evidence): before reviewing, POST a REVIEW PLAN as your reply — (a) the ARTIFACT(S) under review (name, table, sys_id if known), (b) how you will FETCH the real code (get_editor_value on the open form / sn_fetch_script_by_name / sn_fetch_script_by_sysid / sn_search_script_body), (c) the CONTEXT queries you will run (sibling rules, ACLs, dictionary), (d) the CHECKLIST dimensions you will grade. Only AFTER the plan is posted do you fetch.

1. FETCH THE REAL CODE — never review from memory, a summary, or pasted approximations. Open form: list_editors + get_editor_value. Not open: sn_fetch_script_by_name / sn_search_script_body. Also READ the record's config, not just its script: query_elements for When/Order/Insert-Update-Delete-Query checkboxes, Active, Condition.
2. CONTEXT SWEEP — a script is only correct IN CONTEXT. Query the neighbors with sn_query_session: sibling Business Rules on the same table ordered by order (collection=<table>^active=true^ORDERBYorder) to catch ordering conflicts and overlapping logic; related ACLs / UI Policies / Data Policies when the review touches security or mandatory-field behavior. Use sn_recent_changes if the review asks "what changed".
3. CHECKLIST — grade each dimension with line-level evidence:
   - ES5 ONLY: var (never const/let), no arrow functions, no template literals, no "use strict".
   - GlideRecord: next()/get() checked before reads; getValue('field') not dot-notation reads; setLimit on large queries; GlideAggregate for counts; GlideRecordSecure for user-facing reads.
   - FORBIDDEN: eval(), hardcoded sys_ids, gs.log() in production, current.update() in a before Business Rule, getXMLWait(), new REST() (must be sn_ws.RESTMessageV2), synchronous GlideAjax.
   - CLIENT: correct handler signatures (onChange(control, oldValue, newValue, isLoading, isTemplate)), g_form methods that actually exist, isLoading guard.
   - TRIGGER IS LOAD-BEARING: a before/after Business Rule with ZERO of Insert/Update/Delete/Query checked can NEVER fire — that is an AUTOMATIC CRITICAL defect regardless of script quality.
   - Error handling (try/catch around integrations), recursion guards (setWorkflow(false)), performance (no queries in loops), security (ACL bypass, injection via addEncodedQuery from user input).
4. FINDINGS — a table, severity-ranked: | # | Severity (Critical/High/Medium/Low) | Finding | Evidence (file/record + exact line or field state) | Fix |. No finding without its captured evidence item; style nits go last.
5. VERDICT — GO / NO-GO with one-sentence reason. NO-GO on any unresolved Critical. If you recommend applying corrected code: put the FULL corrected artifact in a fenced \`\`\`javascript block with /* File: <Name>.js */ as its first line, and END with a "## Click-by-Click Build Guide" (numbered admin steps, field values, save step, test table, rollback).
6. SAVE THE REPORT — if the task names a save/output folder OR filesystem access is mounted (write_file available), you MUST write the FULL final report as a markdown file into that folder BEFORE your final answer (e.g. CODE_REVIEW_<story-or-artifact>.md), then state the exact saved path in your reply. A review that was asked to save documentation and did not write the file is INCOMPLETE.
RULES: never assert an API/behavior you didn't verify — check sn_api_reference or the fetched code itself; a method you cannot confirm exists goes under "Needs validation against the instance". Review the code that IS there, not the code you would have written — flag real defects, not preferences.`;
