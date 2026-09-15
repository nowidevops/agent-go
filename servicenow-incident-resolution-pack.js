// servicenow-incident-resolution-pack.js — ServiceNow Incident-Resolution
// method pack. Injected (background.js) when the task is working/resolving a
// ServiceNow incident, the same keyword-gated way the research/RCA packs
// inject. Teaches the full ITIL loop — pull the record → diagnose from
// evidence → remediate (only with approval) → verify → resolution notes —
// on the live tools (sn_query_session, sn_recent_changes, sn_set_field,
// save_record). Kept concise so smaller local models aren't overloaded
// (the fable-pack default-ON lesson).
// Author: iDevOpsLLC

import { isServiceNowUrl } from "./servicenow-pack.js";

export function needsSnIncidentResolutionPack(taskText, tabUrl) {
  const t = String(taskText || "");
  const snCtx = isServiceNowUrl(tabUrl) || /\b(servicenow|service-now)\b/i.test(t) || /\bINC\d{5,}\b/i.test(t);
  if (!snCtx) return false;
  // Requires an ACTION verb on an incident — a pure "why did INC... happen"
  // (no resolve/fix verb) stays RCA territory by design.
  return /\b(resolve|resolving|resolution|fix|fixing|work|working|triage|troubleshoot\w*|close|closing|remediat\w*|handle|address)\b.{0,80}\b(incident|INC\d{5,})\b/i.test(t)
    || /\b(incident|INC\d{5,})\b.{0,80}\b(resolve|resolution|fix|fixed|triage|close|closure|remediat\w*|work(ed)? on|needs? (a )?fix)\b/i.test(t);
}

export const SN_INCIDENT_RESOLUTION_PACK = `SERVICENOW INCIDENT RESOLUTION MODE — this task is working a live incident. Follow the loop strictly: pull → diagnose → remediate → verify → document. Diagnosis is READ-ONLY; every WRITE (work notes, state, any fix) happens only at the marked points, and resolving/closing the incident requires the user's explicit go-ahead.

⛔ MANDATORY PLAN FIRST (no record-poking before a plan): POST a RESOLUTION PLAN as your reply — (a) the INCIDENT restated (number, reported symptom, affected user/CI if known), (b) the record data you will PULL and with which tool, (c) 2-4 candidate CAUSES ranked and the evidence that would confirm each, (d) the REMEDIATION path per cause + how you will VERIFY the fix, (e) which steps WRITE to the instance (these wait for approval). Only AFTER the plan is posted do you touch the instance.

1. PULL THE RECORD — get the full picture before theorizing: sn_query_session (or sn_query_table) on incident for number, short_description, description, state, priority, impact, urgency, category, assignment_group, assigned_to, cmdb_ci, opened_at, plus the latest work_notes/comments. If the form is open in the tab, read it with query_elements / read_page instead of REST.
2. CHECK FOR PRIOR ART — before diagnosing from scratch: sn_query_session for DUPLICATE/related incidents (same CI, similar short_descriptionLIKE terms, recent window), linked problem records and known errors, and change requests in the failure window. A matching known error or a just-implemented change often IS the answer.
3. DIAGNOSE from CAPTURED evidence, never from memory:
   - sn_recent_changes — what customizations changed right before the symptom started (highest-yield question).
   - Server errors: sn_query_table table "syslog" query "levelIN0,1^sys_created_onRELATIVEGE@hour@ago@24^ORDERBYDESCsys_created_on".
   - UI symptom: reproduce it — navigate, trigger the flow, read_console + read_network (401/403 = auth/ACL, 404 = missing resource, 5xx = server side).
   - Implicated code: sn_search_script_body / sn_fetch_script_by_name / get_editor_value.
   Build the TIMELINE (what changed vs. when errors started) and state the cause with confidence (high/medium/low) + the evidence item behind each claim.
4. REMEDIATE — propose the fix with exact steps FIRST. Apply it yourself ONLY if the user asked you to fix (not just investigate) — and log what you did as a work note: sn_set_field {field:"work_notes", value:"<diagnosis + action taken + evidence>"} then save_record. If the fix belongs to another team, say so and draft the escalation note instead.
5. VERIFY — prove the symptom is gone: re-run the failing flow / re-query the failing record / re-read console+network. No verification, no "resolved" claim.
6. RESOLUTION NOTES — draft close notes the next engineer can trust: cause (one sentence), evidence, fix applied, verification result, suggested resolution code. Then ASK the user before setting state to Resolved/Closed — never flip incident state on your own.
RULES: never assert a cause you cannot tie to a captured item (a log line, a change record, a request URL+status, a code line) — unproven theories go under "Unverified hypotheses" with what would settle them. Work notes are for facts and actions, not speculation. If the evidence points to a deeper recurring cause, recommend a problem record — do not silently expand scope.`;
