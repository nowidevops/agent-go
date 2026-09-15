// servicenow-rca-pack.js — ServiceNow Root-Cause-Analysis method pack. The
// platform-specific sibling of rca-pack.js: injected (background.js) when the
// diagnosis is ServiceNow-shaped, and checked BEFORE the generic RCA pack so
// SN tasks get the SN evidence playbook (sn_recent_changes, syslog, sibling-
// rule ordering, sys_audit) instead of the generic one. Same evidence-first
// discipline; kept concise so smaller local models aren't overloaded (the
// fable-pack default-ON lesson).
// Author: iDevOpsLLC

import { isServiceNowUrl } from "./servicenow-pack.js";
import { needsRcaPack } from "./rca-pack.js";

export function needsSnRcaPack(taskText, tabUrl) {
  const t = String(taskText || "");
  // Diagnosis-shaped (same gate as the generic pack) + ServiceNow context.
  if (!needsRcaPack(t)) return false;
  return isServiceNowUrl(tabUrl)
    || /\b(servicenow|service-now|business rule|script include|client script|ui action|ui policy|glide\w*|g_form|flow designer|catalog item|record producer|update set|sys_[a-z0-9_]+|sc_[a-z0-9_]+|cmdb\w*)\b/i.test(t)
    || /\bINC\d{5,}|\bCHG\d{5,}|\bPRB\d{5,}/i.test(t);
}

export const SN_RCA_PACK = `SERVICENOW ROOT CAUSE ANALYSIS MODE — this task is a diagnosis on a ServiceNow instance. Every causal claim must be tied to a piece of CAPTURED evidence (a change record, a log line, a code line, a field state, a failed request). Diagnosis is READ-ONLY: change nothing (no writes, no saves) unless the user explicitly asked you to also fix it.

⛔ MANDATORY PLAN FIRST (no log-chasing before a plan): POST an RCA PLAN as your reply — (a) SYMPTOM restated (what is broken / which record-table-module / since when / exact error text), (b) 2-4 candidate HYPOTHESES ranked by plausibility, (c) the EVIDENCE you will gather per hypothesis and WHICH tool, (d) what observation would CONFIRM or REFUTE each. Only AFTER the plan is posted do you run the sweep.

1. SYMPTOM — restate precisely: what breaks, on which table/record/module, since when, exact error text. Unclear? REPRODUCE first: navigate to the record, trigger the flow, read_page / capture_screenshot.
2. EVIDENCE SWEEP — run ALL that apply BEFORE settling on a hypothesis:
   - sn_recent_changes — THE highest-yield question: what customizations changed in the window before the problem started (pass record_sys_id for field-level audit of one record; sn_compare_record to diff versions).
   - Server errors: sn_query_table table "syslog" query "levelIN0,1^sys_created_onRELATIVEGE@hour@ago@24^ORDERBYDESCsys_created_on".
   - EXECUTION-ORDER CONFLICTS (classic SN root cause): sn_query_session {table:"sys_script", query:"collection=<table>^active=true^ORDERBYorder"} — a Business Rule at a later order silently overwriting or aborting what an earlier one did. Same idea for stacked UI Policies / Data Policies / ACLs when the symptom is a field going read-only/mandatory/hidden "by itself".
   - IMPLICATED CODE: sn_search_script_body to find every script touching the field/table, then sn_fetch_script_by_name / get_editor_value to read it. Check the record's OWN config too — an "impossible" bug is often a trigger checkbox (Insert/Update/Delete/Query), Active flag, or Condition that doesn't match the assumption.
   - UI symptom: reproduce ONCE with the taps live, then read_console (real JS errors, file:line) + read_network (failed requests: 401/403 auth/ACL, 404 missing, 5xx server).
3. TIMELINE — order the evidence by timestamp: when did errors start vs. what changed just before (update sets, changes, releases).
4. HYPOTHESES — 2-4 candidate causes RANKED by the evidence. For each: the observation that would prove or disprove it.
5. TEST each hypothesis with a REAL read/query — not reasoning alone. Discard what the evidence refutes; say so explicitly.
6. VERDICT — your final answer MUST contain:
   - Root cause (one sentence) + confidence (high/medium/low).
   - Evidence table: each claim → the exact captured item (change record sys_id, syslog line, script name + line, console line, request URL+status).
   - 5-Whys chain from symptom to root cause.
   - Recommended fix + how to VERIFY it worked — and if the fix means applying a change to the instance, end with a "## Click-by-Click Build Guide" (numbered admin steps from the concrete values you observed, save step, test table, rollback).
RULES: never assert a cause you cannot tie to a captured evidence item — "likely"/"probably" theories go under "Unverified hypotheses" with what access/repro would settle them. An empty query result is NOT proof of absence — re-check with exact = syntax before concluding a record doesn't exist. If a recurring or systemic cause emerges, recommend a problem record.`;
