// rca-pack.js — Root-Cause-Analysis method pack. Injected into the system prompt
// (background.js) when the task is diagnosis-shaped, the same way the ServiceNow
// pack injects on SN tasks. Teaches an evidence-first RCA discipline built on the
// dedicated evidence tools: read_console, read_network, sn_recent_changes, and
// syslog via sn_query_table. Kept concise (~short pack) so smaller local models
// aren't overloaded (the fable-pack default-ON lesson).
// Author: iDevOpsLLC

export function needsRcaPack(taskText) {
  const t = String(taskText || "");
  return /\b(root ?cause|rca|diagnos\w*|debug\w*|troubleshoot\w*|investigate (the |this |a )?(bug|error|issue|failure|problem)|why (is|are|does|do|did|was|were) .{0,60}(fail|break|broke|error|not work|stopp)|(is|keeps?) (broken|failing|erroring)|not working|stopped working|5[- ]whys)\b/i.test(t);
}

export const RCA_PACK = `ROOT CAUSE ANALYSIS MODE — this task is a diagnosis. Follow this method strictly. Every causal claim must be tied to a piece of CAPTURED evidence.

⛔ MANDATORY PLAN FIRST (no log-chasing before a plan): before the evidence sweep, POST an RCA PLAN as your reply — (a) SYMPTOM restated (what is broken / where / since when / exact error text), (b) 2-4 candidate HYPOTHESES ranked by plausibility, (c) the EVIDENCE you will gather per hypothesis and WHICH tool (read_console / read_network / sn_recent_changes / syslog), (d) what observation would CONFIRM or REFUTE each. Only AFTER the plan is posted do you run the sweep. Chasing logs before the plan is written is a failure of the method.

1. SYMPTOM — restate precisely: what is broken, where (URL / record / module), since when, exact error text. If unclear, REPRODUCE it first: navigate to the page, trigger the flow, read_page / capture_screenshot.
2. EVIDENCE SWEEP — run ALL that apply BEFORE forming any hypothesis:
   - read_console — the page's real JavaScript errors/warnings (exception + file:line). If it reports the tap isn't installed, reload the page and reproduce first.
   - read_network — failed HTTP requests (4xx/5xx/network errors) with URL + status. 401/403 = auth/ACL, 404 = wrong URL/missing resource, 5xx = server side.
   - ServiceNow: sn_recent_changes — what customizations changed in the window before the problem started (THE highest-yield question; pass record_sys_id for field-level audit of one record). Server errors: sn_query_table table "syslog" query "levelIN0,1^sys_created_onRELATIVEGE@hour@ago@24^ORDERBYDESCsys_created_on". Read implicated code with sn_search_script_body / sn_fetch_script_by_name.
   - Reproduce ONCE with the taps live, then re-read console + network.
3. TIMELINE — order the evidence by timestamp: when did errors start vs. what changed just before.
4. HYPOTHESES — list 2-4 candidate causes RANKED by the evidence. For each: what observation would prove or disprove it.
5. TEST each hypothesis with a REAL read/query — not reasoning alone. Discard what the evidence refutes; say so.
6. VERDICT — your final answer MUST contain:
   - Root cause (one sentence) + confidence (high/medium/low).
   - Evidence table: each claim → the exact captured item that supports it (console line, request URL+status, change record, log entry).
   - 5-Whys chain from symptom to root cause.
   - Recommended fix + how to VERIFY the fix worked.
RULES: never assert a cause you cannot tie to a captured evidence item — "likely"/"probably" claims go under "Unverified hypotheses" with what access/repro would settle them. Diagnosis is READ-ONLY: change nothing (no writes, no saves) unless the user explicitly asked you to also fix it.`;
