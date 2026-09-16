// shortcuts.js — "/" slash commands: built-ins + user-defined prompt shortcuts.
// A shortcut = { id, name (slug), prompt, startFrom (url), model (override),
//   schedule? { enabled, recurrence: "once"|"daily"|"weekly"|"interval",
//   date "YYYY-MM-DD" (once), time "HH:MM" (24h), weekday 0–6 (weekly, 0=Sun),
//   intervalMinutes (interval, e.g. 30/60/120 = every 30 min / 1 h / 2 h),
//   windowStart "HH:MM" + windowEnd "HH:MM" (interval only — active-hours window;
//   fires only between Start and End each day. Empty = all day),
//   days "all"|"weekdays"|"market" (interval + daily — which calendar days may fire:
//   every day / Mon–Fri / Mon–Fri excluding NYSE holidays; default "all") } }.
// Author: iDevOpsLLC

export const BUILTINS = [
  { name: "compact", description: "Clear history and keep a summary" },
  { name: "clear", description: "Clear the conversation" }
];

// ---------------------------------------------------------------------------
// SEED SHORTCUTS — ServiceNow use-case stories designed to exercise the
// 🛡️ Phase engine (enable the Options toggle; the engine wraps EVERY run when
// ON — these stories are evidence-heavy so the invariants/REVIEW/REVERIFY
// gates have real substance to validate). Installed once per SEED version by
// seedShortcuts() (background.js, on install/startup); user edits/deletes are
// respected — a deleted seed is NOT re-added unless the version is bumped.
// Deterministic ids (seed-*) so a re-run can never duplicate an entry.
// v2 (2026-07-19): +17 category stories from "C:\redacted\path
// conversations\ServiceNow AI Prompt Guide.txt" + UI Builder / Decision Table /
// Playbook / Legacy Workflow / Flow Custom Action use cases (user request).
export const SHORTCUT_SEED_VERSION = 2;
export const SEED_SHORTCUTS = [
  {
    id: "seed-br-review",
    name: "br-review",
    prompt: "Perform a full code review of the ServiceNow Business Rule open in the current tab. BROWSER TOOLS FIRST: read_page, then open_form_section for 'When to run' and 'Advanced', get_editor_value for the Script, and query_elements for the live Table/When/Order/Active/Insert/Update values — cite every observed value as evidence. Then use sn_query_session on sys_script (collection=<this table>^active=true^ORDERBYorder) to list sibling rules and flag ordering conflicts or overlapping conditions — do not invent conflicts you did not query. Deliver: verdict on correctness/performance/best-practice (var-only ES5, no hardcoded sys_ids, guard-first returns, setAbortAction semantics), every claim evidence-cited, a corrected artifact in a ```javascript fence with /* File: <Name>.js */ as the first line, and a Click-by-Click Build Guide for applying the fix.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-br-build",
    name: "br-build",
    prompt: "Create a ServiceNow Business Rule on the instance open in the current tab, exactly to this story: BEFORE Update on Incident, abort the save with a user message when assignment_group is empty, unless the update is only setting assignment_group. FIRST call sn_check_duplicate (table sys_script) with the intended name so we never create a duplicate. Then build it on a new sys_script form: fill Name and Table, open_form_section 'When to run' (When=before, Update=true, Insert=false), open_form_section 'Advanced' (checkbox auto-checks), set the Condition and the Script via set_editor_value (ES5 var-only, guard-first, current.setAbortAction(true) with gs.addErrorMessage), then save_record and RE-READ the saved record to verify every field persisted as intended — cite the verified values as evidence. Deliver the final script in a ```javascript fence with /* File: */ header plus a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-br-conflict-audit",
    name: "br-conflict-audit",
    prompt: "Audit the ServiceNow instance open in the current tab for Business Rule conflicts on the table of the record/list currently open (if none is open, ask which table). Use sn_query_session on sys_script (collection=<table>^active=true^ORDERBYorder, fields: name,order,when,action_insert,action_update,condition,filter_condition,sys_id) to pull EVERY active rule. Analyze for: same-order collisions, before/after ordering that defeats intent, overlapping or contradictory conditions, duplicate logic across rules, and abort-vs-set races. Every finding must cite the queried evidence — never assert a rule you did not retrieve. Deliver a ranked conflict report (Critical/High/Medium) with a recommended order map, which rules to merge or deactivate, and a Click-by-Click Build Guide for the changes. Do NOT modify anything — this is a read-only audit.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-client-script-review",
    name: "client-script-review",
    prompt: "Review the ServiceNow Client Script (or UI Policy) open in the current tab together with everything else that manipulates the same fields. Read the open form with browser tools (get_editor_value for the script; query_elements for Type/Table/UI Type/Field values) and cite each observed value. Then sn_query_session BOTH sys_script_client AND sys_ui_policy for the same table (active=true) to find overlaps: two artifacts fighting over the same field's visibility/mandatory state, onChange handlers missing the isLoading/newValue guard, g_form.getReference calls that should be async GlideAjax, DOM access (gElement/jQuery) that breaks on Next Experience, and server-data lookups that belong in a display Business Rule. Deliver an evidence-cited review, a corrected script in a ```javascript fence with /* File: */ header, and a Click-by-Click Build Guide; flag any UI-Policy-vs-Client-Script consolidation opportunity.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-acl-audit",
    name: "acl-audit",
    prompt: "Run a read-only security audit of table access control on the ServiceNow instance open in the current tab, for the table of the record/list currently open (ask if ambiguous). Use sn_query_session on sys_security_acl (name STARTSWITH <table>, active=true, fields: name,operation,type,admin_overrides,script,condition,description,sys_id) and on sys_data_policy2 for the same table. Report with citations: operations with NO acl (read/write/create/delete gaps), wildcard (*) field ACLs that mask field-level intent, ACLs relying only on admin_overrides, script-based ACLs whose script is empty or always-true, and data-policy vs UI-policy enforcement mismatches. Every claim must cite a queried record — if a query returns nothing, report the gap as UNVERIFIED rather than asserting from memory. Deliver a ranked findings table (Critical/High/Medium), remediation recommendations, and a Click-by-Click Build Guide. Do NOT create or modify any record.",
    startFrom: "",
    model: ""
  },
  // ---- v2 seeds: one complex story per ServiceNow AI Prompt Guide category ----
  {
    id: "seed-br-suite",
    name: "br-suite",
    prompt: "Build a coordinated Business Rule SUITE on the incident table of the instance open in the current tab — three rules that must cooperate without colliding: (1) BEFORE insert+update 'Derive Priority' setting priority from impact+urgency only when priority is empty or impact/urgency changed; (2) AFTER insert 'Auto-Assign by Category' setting assignment_group from category/subcategory (document the mapping you choose from real sys_user_group records you query); (3) ASYNC update 'Audit Short Description' logging old→new short_description changes via gs.eventQueue or a work note (do NOT invent custom tables without checking). BEFORE creating anything: sn_check_duplicate each rule name AND sn_query_session sys_script (collection=incident^active=true^ORDERBYorder) to pick non-colliding Order values — justify the order map with citations. Build each via the verified form flow (fill → When to run → Advanced → set Condition + Script → save_record) and RE-READ every saved record to verify When/Order/Insert/Update/Active persisted exactly. ES5 var-only, guard-first, no hardcoded sys_ids. Deliver all three scripts in ```javascript fences with /* File: */ headers, the final order map, and a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-client-script-build",
    name: "client-script-build",
    prompt: "Build the complete client-side field-behavior set for the incident form on the instance open in the current tab: (1) onChange(category) that clears subcategory and re-evaluates dependent fields — with the isLoading/newValue===oldValue guard; (2) onLoad that hides assignment_group when priority is 1 using g_form.setDisplay (never DOM access); (3) onSubmit that blocks submission with a clear g_form.addErrorMessage when the 'u_reviewed' checkbox is false (verify the real field name on the form first — cite it). Any server data a script needs must come from g_scratchpad populated by a DISPLAY Business Rule you also build — no synchronous GlideRecord/getReference on the client. FIRST sn_query_session sys_script_client AND sys_ui_policy for incident to prove none of this collides with existing artifacts (cite what you find); sn_check_duplicate every name. Create each record, set the script via the code editor tools, save_record, and re-read Type/Table/UI Type/Active to confirm persistence. Deliver every script in ```javascript fences with /* File: */ headers plus a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-ui-policy-matrix",
    name: "ui-policy-matrix",
    prompt: "Implement a conditional field-behavior MATRIX on the change_request form of the instance open in the current tab using UI Policies as the primary mechanism: (1) make justification mandatory when type is Emergency; (2) make implementation_plan + backout_plan mandatory AND visible only when state reaches Assess; (3) a role-dependent behavior — hide risk_impact_analysis from non-itil users — and be HONEST about mechanism: plain UI Policy conditions cannot read roles, so use a UI Policy script (isVisible via g_user.hasRole) or justify a different mechanism, citing platform behavior. FIRST sn_query_session sys_ui_policy + sys_ui_policy_action + sys_script_client for change_request and identify overlaps/conflicts with citations — propose which existing client scripts should be RETIRED into policies. Order the policies deliberately and document why. Build each policy + actions via the form, save, re-read to verify conditions/order/actions persisted. Deliver the policy matrix table, any policy scripts in ```javascript fences with /* File: */ headers, and a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-script-include-build",
    name: "script-include-build",
    prompt: "Create two production-grade Script Includes on the instance open in the current tab: (1) 'AssignmentGroupResolver' — NOT client-callable — with getGroup(companySysId, locationSysId) implementing a documented fallback chain (exact company+location → company only → a default you justify from real sys_user_group data you query and cite); (2) 'MyIncidentsAjax' — client-callable, extends AbstractAjaxProcessor — getMyOpenIncidents() returning number/short_description/priority for the SESSION user via GlideRecordSecure ONLY (ACL-respecting), with a hard row cap and zero parameters trusted from the client without validation. Explain the security posture: why (1) must not be client-callable and how (2) avoids data leakage. sn_check_duplicate both names; build via sys_script_include forms (name/api_name/client_callable/access), set scripts via the code editors, save_record, re-read client_callable+active to verify. ES5 var-only, JSDoc headers, no gs.sleep, no hardcoded sys_ids. Deliver both scripts in ```javascript fences with /* File: */ headers + a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-glideajax-roundtrip",
    name: "glideajax-roundtrip",
    prompt: "Build a complete GlideAjax round-trip on the instance open in the current tab: a client-callable Script Include 'UserInfoAjax' (extends AbstractAjaxProcessor) exposing (1) getManagerName — returns the display name of the manager of a user sys_id passed as sysparm_user, validating the parameter is a 32-char sys_id and using GlideRecordSecure; and (2) isRefUnique — validates that a proposed value for a reference field is unique on its table, with the table name checked against an explicit ALLOWLIST inside the script (never trust a client-supplied table name raw — explain why). Then the consuming onChange Client Script on the incident caller_id field that calls getManagerName ASYNCHRONOUSLY (getXMLAnswer callback — never getXMLWait) and writes the result to a form annotation or g_form.showFieldMsg. sn_check_duplicate both names; create both records via their forms + code editors, save, re-read client_callable/table/type to verify. Deliver both artifacts in ```javascript fences with /* File: */ headers, a security-notes section, and a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-catalog-item-build",
    name: "catalog-item-build",
    prompt: "Build a Record Producer + catalog client-script set on the instance open in the current tab: Record Producer 'Report a Facilities Issue' targeting the incident table with variables (location reference, issue_type choice, urgency choice, description multi-line, photo_attached checkbox). Producer script: map variables to incident fields, pre-populate location + assignment defaults from the SUBMITTING user's department/location (producer.script runs server-side — cite the current.variables API you use), set contact_type. Catalog Client Script (onChange on issue_type): show/hide + make mandatory the dependent variables — cascade rules documented. FIRST sn_check_duplicate the producer name and sn_query_session item_option_new for an existing item with the same variable set (cite findings). Create the producer, add each variable (verify each saved with its question text + type by re-reading), attach the scripts via the editors, save. State honestly anything the catalog UI blocked you from completing. Deliver the producer script + client script in ```javascript fences with /* File: */ headers, the variable table, and a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-flow-build",
    name: "flow-build",
    prompt: "Create a Flow Designer flow on the instance open in the current tab: trigger = incident Created where priority is 1; logic = (1) IF assignment_group is empty THEN look up the on-call group (document your lookup), (2) create an approval for the group manager, (3) on approve → update state to In Progress + post a work note; on reject → set on hold with reason. Flow Designer is a canvas app at <origin>/now/workflow — drive it with browser tools (query_elements/click/fill), and if a canvas step resists DOM automation, say EXACTLY which step and continue documenting instead of fabricating success. VERIFY what you actually created by querying sys_hub_flow + sys_hub_trigger_instance + sys_hub_action_instance via sn_query_session and CITE the records — the flow's existence must be proven from tables, not assumed from the UI. Activate only after verification. Deliver: the verified flow structure (trigger + each action with its config), citations for every claim, an honest list of any steps that need manual completion, and a complete Click-by-Click Build Guide someone could follow in the Flow Designer UI.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-flow-action-build",
    name: "flow-action-build",
    prompt: "Build a CUSTOM ACTION in Flow Designer on the instance open in the current tab, then use it in a flow. Action 'Post Incident Summary': inputs = incident record reference + audience string; one script step (ES5) that composes a summary (number, priority, age in hours, assignment group display value) and returns it as an output string, plus an error output the script populates instead of throwing raw. Open Action Designer (<origin>/now/workflow → New → Action), define inputs/outputs, paste the script via the code editor tools. VERIFY the action exists by querying sys_hub_action_type_definition (and its snapshot/published state) via sn_query_session with citations. Then add the action as a step in a simple flow (trigger: incident updated to resolved) wiring the record input from the trigger, and verify the step via sys_hub_action_instance. Canvas steps that resist DOM automation must be reported honestly with the exact blocker — never claim an unverified publish. Deliver the action script in a ```javascript fence with /* File: */ header, the input/output table, citations, and a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-acl-harden",
    name: "acl-harden",
    prompt: "Harden table security on the incident table of the instance open in the current tab (the WRITE companion to /acl-audit): (1) a read ACL restricting record access to members of the assignment group (script: gs.getUser().isMemberOf(current.assignment_group) — plus the roles you justify); (2) a write ACL DENYING changes when state is Resolved or Closed except for users with itil_admin (script-based, document the matrix). FIRST run the read-only audit: sn_query_session sys_security_acl for incident and cite the existing coverage this must integrate with — never create a duplicate operation ACL blindly. ACL editing requires the security_admin elevated role: attempt elevation through the user menu (Elevate role), and if elevation or High Security settings block you, STOP and report exactly what's needed instead of pretending. Create each ACL via the form (operation, type record, admin_overrides FALSE — justify), set scripts via the editor, save, re-read operation/active/admin_overrides to verify. This changes production security posture — list residual risks and a rollback note. Deliver both ACL scripts in ```javascript fences with /* File: */ headers + a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-scheduled-job-build",
    name: "scheduled-job-build",
    prompt: "Build two Scheduled Script Executions (sysauto_script) on the instance open in the current tab — both with a DRY-RUN-FIRST design: a top-level var DRY_RUN = true flag that logs what WOULD change without writing, so the first scheduled run is observational. (1) 'Close Stale Resolved Incidents' nightly: resolved >30 days with no update → state Closed, close notes appended; batched with setLimit, per-record try/catch, explicit autoSysFields/setWorkflow decisions DOCUMENTED (what downstream BRs/notifications you are choosing to skip or keep and why). (2) 'Weekly Manager Report' Mondays 7am: GlideAggregate open-incident counts per assignment group, oldest incident age, emailed via gs.eventQueue to a documented recipient source — no hardcoded emails. sn_check_duplicate both names; create via the sysauto_script form (run type/time verified by re-reading the saved record), scripts via the editor. Do NOT execute either job — creation only; say so plainly. Deliver both scripts in ```javascript fences with /* File: */ headers, the schedule table, and a Click-by-Click Build Guide including how to flip DRY_RUN off after reviewing the first run's log.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-transform-map-build",
    name: "transform-map-build",
    prompt: "Build a complete user-import pipeline on the instance open in the current tab: (1) an import set table for HR user data (create via a manual Load Data stub or document the shape: user_name, first_name, last_name, email, department, manager_username, active_flag); (2) a Transform Map to sys_user coalescing on user_name — field maps for the simple fields, a SCRIPTED field map resolving manager_username → the manager reference (look up sys_user by user_name; unresolved → log + leave empty, never guess), and department resolved against cmn_department; (3) an onBefore transform script that SKIPS rows where active_flag is false (ignore = true) and validates email format — rejects logged with row numbers to the import log, not silently dropped. sn_check_duplicate the map name; sn_query_session sys_transform_map for existing sys_user maps that could double-process (cite). Create the map + field maps + scripts via forms/editors, save, re-read coalesce settings to verify. Deliver all scripts in ```javascript fences with /* File: */ headers, the field-map table, and a Click-by-Click Build Guide including a safe test procedure with a 3-row sample.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-rest-integration-build",
    name: "rest-integration-build",
    prompt: "Build both directions of a REST integration on the instance open in the current tab: (1) OUTBOUND — a Script Include 'RemoteIncidentClient' using RESTMessageV2 to GET open incidents from a second ServiceNow instance: endpoint + credentials MUST come from a REST Message record with a Basic auth Credential/alias — absolutely no usernames/passwords/tokens in script text (state this rule in the code comments); handle non-200s, timeouts (setHttpTimeout), and JSON parse failures explicitly, returning a typed result object. (2) INBOUND — a Scripted REST API 'Custom Incident Report' (GET /api/<scope>/incident_report) returning number/priority/age/assignment_group with sysparm-driven filters, PAGINATION (limit/offset with a hard cap), and GlideRecordSecure so ACLs apply to the caller — explain why that matters. sn_check_duplicate names; create the REST Message + method + Scripted REST service/resource via their forms, scripts via the editors, save + re-read to verify each. Do NOT invoke the outbound call against a live remote without approval. Deliver every script in ```javascript fences with /* File: */ headers + a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-discovery-review",
    name: "discovery-review",
    prompt: "Run an evidence-based MID Server / Discovery health review on the instance open in the current tab (read-only — this is diagnosis, not build). Query via sn_query_session and CITE every claim: ecc_agent (MID servers: status, validated, last refreshed, version), discovery_schedule (active schedules, MID selection method), discovery_status for the last runs (started/completed/state/counts), and ecc_queue for stuck output records older than 1 hour. Analyze: MIDs down or unvalidated, schedules pointing at dead MIDs, error-heavy runs, capability gaps. A PDI often has NO MID server — if the tables come back empty, report each check as UNVERIFIED/N-A honestly and pivot to deliverables: (1) a MID connectivity test script (ECC queue ping probe) as an ARTIFACT ONLY — do not execute; (2) an outline for a Discovery pattern for a custom application (identification section, steps, variables) referencing the pattern tables (sn_disco_pattern / sa_pattern per version — cite which exists on THIS instance). Deliver a ranked findings table, both artifacts in fenced blocks with /* File: */ headers, and a Click-by-Click guide for validating a MID and testing the pattern.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-cmdb-reconcile",
    name: "cmdb-reconcile",
    prompt: "Solve a CMDB data-quality problem on the instance open in the current tab: manual edits are overwriting discovered CI data. Deliver two artifacts + evidence: (1) READ the current IRE configuration for the cmdb_ci_server class — sn_query_session cmdb_identifier + cmdb_identifier_entry + cmdb_reconciliation_definition (cite what identification and reconciliation rules actually exist; empty result = say UNVERIFIED, do not invent rules); (2) BUILD a BEFORE update Business Rule on cmdb_ci_server that, when a human (interactive session, gs.isInteractive()) edits a discovery-managed attribute, stamps a work note and flips discovery_source to 'ManualEntry' ONLY for the attributes a reconciliation rule doesn't already protect — document the interaction between your BR and IRE precedence honestly; (3) write (as an ARTIFACT ONLY, never execute) a reconciliation trigger script using the IdentificationEngine / CMDB API for the class, with the payload shape commented. sn_check_duplicate the BR name; build it via the verified form flow, save, re-read to verify. ES5 var-only. Deliver the BR + script in ```javascript fences with /* File: */ headers, the cited IRE rule inventory, and a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-notification-build",
    name: "notification-build",
    prompt: "Build a CAB notification package on the instance open in the current tab: (1) a Notification (sysevent_email_action) on change_request 'Assigned to CAB member' — fired when assigned_to changes and the assignee is in the CAB group (condition documented; look up and CITE the real group from sys_user_group, don't guess its name); recipients = assigned_to + watch list, subject with ${number} ${short_description}; (2) an Email Script (sys_script_email) embedded via ${mail_script:...} that renders an HTML table of OTHER open changes for the same CI (GlideRecordSecure, max 10 rows, EVERY field value passed through an HTML-escape helper you write inline — explain the injection risk being prevented), with a plain-text fallback line when none. sn_check_duplicate both names; create both via their forms, script via the editor, save + re-read event/condition/active to verify. Do NOT send a test email without approval — offer the test procedure instead. Deliver the email script in a ```javascript fence with /* File: */ header, the notification config table, and a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-portal-widget-build",
    name: "portal-widget-build",
    prompt: "Build a Service Portal widget 'My Open Incidents' on the instance open in the current tab — all four parts: (1) SERVER script: GlideRecordSecure over incident for the SESSION user (caller or opened_by — support both via a widget option), orderBy priority, pagination via options.page_size (default 5, hard cap 25), return plain data objects only (never GlideRecord refs to the client — explain why); (2) CLIENT controller: loading state, a refresh action via server.update(), and click-through to the ticket page; (3) HTML template: ng-repeat with priority badge classes, empty-state message, NO inline styles that fight the portal theme; (4) an option schema JSON for page_size + which-user-field. Build the widget in sp_widget via the form's code editors (each field verified by reading back a snippet after save), sn_check_duplicate the widget id/name first. ES5 in server script (portal requirement — state it). Deliver all four blocks in fences with /* File: */ headers (server.js, client.js, template.html, options.json) + a Click-by-Click Build Guide including how to place it on a portal page.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-decision-table-build",
    name: "decision-table-build",
    prompt: "Build declarative assignment logic on the instance open in the current tab — two mechanisms, then compare them honestly: (1) a DECISION TABLE 'Incident Assignment Matrix' with three inputs (category, impact, location) → answer = assignment group reference; create the table, define the inputs, and populate AT LEAST 6 decision rows covering the matrix + a default row (every group cited from real sys_user_group records you query — no invented groups); verify the rows persisted by querying the decision tables (sys_decision + its question/answer/row tables on this version — cite which exist) via sn_query_session; write the CALLER snippet (sn_dt.DecisionTableAPI / GlideDecisionTable per version) as an artifact. (2) a DATA LOOKUP DEFINITION (dl_definition + matcher/setter fields) setting urgency from category+impact on incident, rows populated and cited. Then a short comparison: when a Decision Table beats a Data Lookup beats an Assignment Rule, grounded in what you just built. Deliver the caller snippet in a ```javascript fence with /* File: */ header, both row matrices as tables, citations, and a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-ui-action-build",
    name: "ui-action-build",
    prompt: "Build two advanced UI artifacts on the instance open in the current tab: (1) a UI ACTION 'Escalate to Major Incident' on incident, visible ONLY when state is On Hold AND the user has the itil role (condition field: current.state + gs.hasRole — cite the actual On Hold state VALUE from sys_choice, never assume the number); it must be a client+server hybrid: client onclick validates a confirmation via g_form, then gsftSubmit into the server-side branch (if(typeof window == 'undefined') pattern) that sets priority 1, adds a work note, and inserts a task — document the hybrid pattern's moving parts; (2) a DYNAMIC FILTER Script Include 'MyLocationCIs' (returns cmdb_ci sys_ids for the session user's location) registered as a Dynamic Filter Option (sys_filter_option_dynamic) so it appears in reference qualifiers and list filters — reference-qualifier-safe (returns an array/comma string, no side effects). sn_check_duplicate both names; build via forms + editors, save, re-read condition/table/active to verify each. Deliver both scripts in ```javascript fences with /* File: */ headers + a Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-refactor-code",
    name: "refactor-code",
    prompt: "Refactor the ServiceNow artifact open in the current tab for a NEW use case. Step 1 — capture the ORIGINAL faithfully: read the open record's script via the code editor tools (get_editor_value) plus its type/table/when config, and summarize what it does now, every claim cited from the actual code. Step 2 — the TARGET: if I did not describe the new use case in this conversation, STOP and ask numbered clarify questions (desired behavior, inputs/outputs, business logic, constraints) — do not invent requirements. Step 3 — refactor honoring the standard constraints: retain reusable logic, extract repeated blocks into named functions, remove hardcoded sys_ids/magic strings into named vars or system properties (justify each), guard-first returns, ES5 var-only for Rhino contexts, performance notes for every GlideRecord loop you touch. Step 4 — produce a CHANGE LOG table (original behavior → new behavior → why) and flag anything the refactor intentionally does NOT preserve. Do NOT save over the original without approval — deliver the refactored code in a ```javascript fence with /* File: */ header, the change log, a regression-test checklist, and a Click-by-Click apply guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-uib-page-build",
    name: "uib-page-build",
    prompt: "Build a UI Builder experience page on the instance open in the current tab: open UI Builder at <origin>/now/builder/ui/home (this exact path — do not guess others), pick or note an experience (e.g. the Service Operations Workspace landing or a portal experience) and create page 'team-incident-board': (1) a DATA RESOURCE 'Look Up Records' fetching open incidents for a group taken from a required PAGE PARAMETER groupId; (2) a repeater/list component bound to that data with priority-based styling; (3) an EVENT MAPPING wiring row-click → 'open record' navigation with the clicked sys_id; (4) a client state parameter for the active filter toggled by a button component. UI Builder is a heavy canvas app — drive what you can with browser tools, and for each step the canvas blocks, record the exact blocker honestly and keep going. PROVE what was created from tables, not the UI: sn_query_session sys_ux_page, sys_ux_screen (or the macroponent tables on this version — cite which exist), and the page registry, citing each record. Deliver: the verified structure (data resource config, bindings, events, params) with citations, the honest gap list, and a complete Click-by-Click Build Guide for the whole page.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-playbook-build",
    name: "playbook-build",
    prompt: "Build a Playbook (Process Automation Designer) on the instance open in the current tab for a Major Incident response process: stages Triage → Investigate → Communicate → Resolve, with activities per stage — Triage: a form activity capturing severity + a decision; Investigate: a task activity assigned to the assignment group; Communicate: an activity posting a status note (or notification) on a timer; Resolve: a confirmation activity gating closure. Open PAD (<origin>/now/process-automation or via the Process Automation Designer nav entry — cite which path exists on this instance), create the process definition targeting the incident table with a trigger condition (priority 1). Canvas steps that resist DOM automation: report the exact blocker and continue — never fabricate a published process. PROVE the build from tables via sn_query_session: sys_pd_process_definition, sys_pd_lane/stage and activity tables on this version (cite which tables exist and the records created). Explain honestly where the playbook surfaces (workspace Playbook tab) and what activation requires. Deliver the verified process structure with citations, the gap list, and a full Click-by-Click Build Guide.",
    startFrom: "",
    model: ""
  },
  {
    id: "seed-legacy-workflow-review",
    name: "legacy-workflow-review",
    prompt: "Reverse-engineer and review a LEGACY Workflow (wf_workflow) on the instance open in the current tab — pick the one attached to sc_req_item (or ask which if several). The graphical Workflow Editor resists DOM automation, so work from TABLES via sn_query_session and cite everything: wf_workflow → its PUBLISHED wf_workflow_version → wf_activity rows (name, activity definition, stage) → wf_transition rows (from/to/condition) — then RECONSTRUCT the graph as an ordered adjacency list. Analyze the reconstructed graph for: activities with no outbound transition (dead ends), approval activities missing a rejected path, timer activities whose timeout has no escape transition, always-true/always-false conditions, unreachable activities, and script activities with hardcoded sys_ids (pull each wf_activity's vars/script and review the code). Compare against how the same process would look in Flow Designer and state honestly whether migration is worth it, grounded in the actual graph. Deliver: the cited graph map, a ranked findings table (Critical/High/Medium) with a citation per finding, corrected activity scripts (if any) in ```javascript fences with /* File: */ headers, and a Click-by-Click guide for applying fixes in the Workflow Editor (checkout → edit → publish).",
    startFrom: "",
    model: ""
  }
];

// Merge missing seeds into storage exactly once per SHORTCUT_SEED_VERSION.
// Match by id OR name (case-insensitive) so a user's own same-named shortcut
// is never clobbered and a prior seed edit is never overwritten.
export async function seedShortcuts() {
  // Per owner (2026-09-02): seeds land in the signed-in account's private list; a
  // signed-out session seeds nothing and keeps the version unset so it can seed later.
  const owner = await shortcutOwner();
  if (!owner) return 0;
  const { shortcutSeedVersionByOwner: sv } = await chrome.storage.local.get("shortcutSeedVersionByOwner");
  const seen = sv && typeof sv === "object" ? sv : {};
  if ((seen[owner] || 0) >= SHORTCUT_SEED_VERSION) return 0;
  const list = await getShortcuts();
  const have = new Set(list.flatMap((s) => [String(s.id), String(s.name || "").toLowerCase()]));
  let added = 0;
  for (const seed of SEED_SHORTCUTS) {
    if (have.has(seed.id) || have.has(seed.name.toLowerCase())) continue;
    list.push({ ...seed });
    added++;
  }
  await writeShortcuts(list);
  await chrome.storage.local.set({ shortcutSeedVersionByOwner: { ...seen, [owner]: SHORTCUT_SEED_VERSION } });
  return added;
}

export const RECURRENCES = ["once", "daily", "weekly", "interval"];

// Allowed "every N" presets, in minutes (5 min … 24 h). Shown in the modal; the
// engine repeats natively via chrome.alarms periodInMinutes (min 1 min in prod).
export const INTERVAL_CHOICES = [5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440];

// Coerce arbitrary input into a clean schedule object, or null when scheduling is
// off / unusable. Kept permissive but bounded so a malformed value can never throw
// in the alarm engine.
// Calendar-day filters. "market" = US equity market days (Mon–Fri minus NYSE
// full-day holidays, computed by rule so no yearly table maintenance is needed).
export const DAY_MODES = ["all", "weekdays", "market"];

// Anonymous Gregorian algorithm → Easter Sunday (month 1-12, day) for a year.
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// nth weekday of a month (n>=1) or last (n=-1); wd 0=Sun..6=Sat.
function nthWeekday(y, m, wd, n) {
  if (n > 0) { const first = new Date(y, m, 1); const off = (wd - first.getDay() + 7) % 7; return new Date(y, m, 1 + off + 7 * (n - 1)); }
  const last = new Date(y, m + 1, 0); const off = (last.getDay() - wd + 7) % 7; return new Date(y, m, last.getDate() - off);
}
// Fixed-date holiday with NYSE observance: Sat → preceding Fri, Sun → following Mon
// (exception: New Year's Day on a Saturday is NOT observed on Dec 31 — NYSE rule).
function observed(y, m, d, isNewYear) {
  const dt = new Date(y, m, d);
  if (dt.getDay() === 6) return isNewYear ? null : new Date(y, m, d - 1);
  if (dt.getDay() === 0) return new Date(y, m, d + 1);
  return dt;
}
// Set of "YYYY-MM-DD" NYSE full-day closures for a year (rule-based; the same nine
// holidays NYSE has observed since 2022 incl. Juneteenth). Cached per year.
const _holidayCache = new Map();
export function nyseHolidays(year) {
  if (_holidayCache.has(year)) return _holidayCache.get(year);
  const list = [];
  const push = (d) => { if (d) list.push(ymd(d)); };
  push(observed(year, 0, 1, true));            // New Year's Day
  push(nthWeekday(year, 0, 1, 3));             // MLK Day — 3rd Monday Jan
  push(nthWeekday(year, 1, 1, 3));             // Presidents' Day — 3rd Monday Feb
  const e = easterSunday(year); push(new Date(e.getFullYear(), e.getMonth(), e.getDate() - 2)); // Good Friday
  push(nthWeekday(year, 4, 1, -1));            // Memorial Day — last Monday May
  push(observed(year, 5, 19, false));          // Juneteenth
  push(observed(year, 6, 4, false));           // Independence Day
  push(nthWeekday(year, 8, 1, 1));             // Labor Day — 1st Monday Sep
  push(nthWeekday(year, 10, 4, 4));            // Thanksgiving — 4th Thursday Nov
  push(observed(year, 11, 25, false));         // Christmas
  const set = new Set(list);
  _holidayCache.set(year, set);
  return set;
}
// Is this local calendar day allowed under the schedule's day mode?
export function isActiveDay(mode, nowMs = Date.now()) {
  const m = DAY_MODES.includes(mode) ? mode : "all";
  if (m === "all") return true;
  const d = new Date(nowMs);
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  if (m === "weekdays") return true;
  return !nyseHolidays(d.getFullYear()).has(ymd(d));
}
// Start of the next allowed calendar day strictly AFTER the day containing nowMs.
function nextActiveMidnight(mode, nowMs) {
  const t = new Date(nowMs); t.setHours(0, 0, 0, 0);
  for (let i = 1; i <= 366; i++) {
    t.setDate(t.getDate() + 1);
    if (isActiveDay(mode, t.getTime())) return t.getTime();
  }
  return null;
}

export function normalizeSchedule(raw) {
  if (!raw || typeof raw !== "object" || !raw.enabled) return null;
  const recurrence = RECURRENCES.includes(raw.recurrence) ? raw.recurrence : "once";
  const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(raw.time || "") ? raw.time : "09:00";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date || "") ? raw.date : "";
  let weekday = parseInt(raw.weekday, 10);
  if (!(weekday >= 0 && weekday <= 6)) weekday = 1; // default Monday
  // interval: "every N minutes". Clamp to [1, 10080] (1 week); default 60 (1 h).
  let intervalMinutes = parseInt(raw.intervalMinutes, 10);
  if (!(intervalMinutes >= 1 && intervalMinutes <= 10080)) intervalMinutes = 60;
  // Active-hours window (interval only): fire only between Start and End each day.
  // Both must be valid HH:MM and End strictly after Start, else the window is
  // dropped (treated as "all day") so it can never wedge the engine.
  const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
  let windowStart = HHMM.test(raw.windowStart || "") ? raw.windowStart : "";
  let windowEnd = HHMM.test(raw.windowEnd || "") ? raw.windowEnd : "";
  if (recurrence !== "interval" || toMinutes(windowStart) >= toMinutes(windowEnd)) {
    windowStart = "";
    windowEnd = "";
  }
  // Calendar-day filter (interval + daily only). Anything else → "all".
  let days = DAY_MODES.includes(raw.days) ? raw.days : "all";
  if (recurrence !== "interval" && recurrence !== "daily") days = "all";
  // "once" needs a concrete date; without one it can't be scheduled.
  if (recurrence === "once" && !date) return null;
  return { enabled: true, recurrence, date, time, weekday, intervalMinutes, windowStart, windowEnd, days };
}

// "HH:MM" → minutes since local midnight, or -1 when absent/garbled. Used to
// compare against the active-hours window.
function toMinutes(t) {
  if (!t) return -1;
  const [h, m] = String(t).split(":").map((n) => parseInt(n, 10));
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : -1;
}

// True when `nowMs` falls inside the schedule's active-hours window (or there is
// no window). Only interval schedules carry a window. Local wall-clock based.
export function isWithinWindow(schedule, nowMs = Date.now()) {
  const s = normalizeSchedule(schedule);
  if (!s) return true;
  if (!isActiveDay(s.days, nowMs)) return false;   // weekend / market holiday → skip
  if (!s.windowStart || !s.windowEnd) return true;
  const now = new Date(nowMs);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= toMinutes(s.windowStart) && mins <= toMinutes(s.windowEnd);
}

// Next fire time (ms epoch) for a schedule, or null if it can't fire (e.g. a
// one-time schedule whose date+time is already in the past). `nowMs` is injectable
// for testing. Uses LOCAL time — the date/time the user picked is their wall clock.
export function computeNextFire(schedule, nowMs = Date.now()) {
  const s = normalizeSchedule(schedule);
  if (!s) return null;

  // interval: fire one period from now. chrome.alarms then repeats it natively.
  if (s.recurrence === "interval") {
    const period = s.intervalMinutes * 60_000;
    if (!s.windowStart || !s.windowEnd) {
      const next = nowMs + period;
      if (isActiveDay(s.days, next)) return next;
      // lands on a weekend/holiday → first fire = period after the next allowed midnight
      const mid = nextActiveMidnight(s.days, next);
      return mid == null ? null : mid + period;
    }
    // Active-hours window: align the next fire to today's window (or open it
    // tomorrow). Out-of-window fires of the native periodic alarm are skipped in
    // the engine; this keeps the displayed "next run" honest.
    const mid = new Date(nowMs); mid.setHours(0, 0, 0, 0);
    const openOff = toMinutes(s.windowStart) * 60_000, closeOff = toMinutes(s.windowEnd) * 60_000;
    const open = mid.getTime() + openOff;
    const close = mid.getTime() + closeOff;
    // "open on the next allowed day" — respects weekends/holidays under days mode
    const nextOpen = () => { const nm = nextActiveMidnight(s.days, nowMs); return nm == null ? null : nm + openOff; };
    if (!isActiveDay(s.days, nowMs)) return nextOpen(); // today is off → next allowed day's open
    if (nowMs < open) return open;                 // before today's window → open today
    if (nowMs < close) {                           // inside the window
      const next = nowMs + period;
      return next <= close ? next : nextOpen();    // past close → next allowed day
    }
    return nextOpen();                             // after today's window → next allowed day
  }

  const [hh, mm] = s.time.split(":").map((n) => parseInt(n, 10));
  const now = new Date(nowMs);

  if (s.recurrence === "once") {
    const [y, mo, d] = s.date.split("-").map((n) => parseInt(n, 10));
    const when = new Date(y, mo - 1, d, hh, mm, 0, 0).getTime();
    return when > nowMs ? when : null;
  }

  if (s.recurrence === "daily") {
    const t = new Date(now); t.setHours(hh, mm, 0, 0);
    if (t.getTime() <= nowMs) t.setDate(t.getDate() + 1); // already passed today → tomorrow
    for (let i = 0; i < 366 && !isActiveDay(s.days, t.getTime()); i++) t.setDate(t.getDate() + 1); // skip weekends/holidays
    return t.getTime();
  }

  // weekly: next occurrence of s.weekday at the given time (this week or next).
  const t = new Date(now); t.setHours(hh, mm, 0, 0);
  let delta = (s.weekday - t.getDay() + 7) % 7;
  if (delta === 0 && t.getTime() <= nowMs) delta = 7; // today but the time passed → next week
  t.setDate(t.getDate() + delta);
  return t.getTime();
}

const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Minutes → compact human label: 30→"30 min", 60→"1 h", 120→"2 h", 1440→"24 h".
export function formatInterval(min) {
  const m = parseInt(min, 10) || 60;
  return m % 60 === 0 ? `${m / 60} h` : `${m} min`;
}

// "HH:MM" (24h) → "9:00 AM". Tolerant of a missing/garbled value (→ 9:00 AM).
export function formatTime12(t) {
  const [h, m] = String(t || "09:00").split(":").map((n) => parseInt(n, 10));
  const hh = Number.isInteger(h) ? h : 9;
  const mm = Number.isInteger(m) ? m : 0;
  const ap = hh < 12 ? "AM" : "PM";
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${ap}`;
}

// Short human label for a schedule (no leading icon), e.g. "Daily · 9:00 AM",
// "Mon · 9:00 AM", "Once · Jun 25, 9:00 AM". Returns null when scheduling is off.
// Shared by the Options badge and the side-panel modal so they never diverge.
export const DAY_MODE_LABEL = { all: "", weekdays: "weekdays", market: "market days" };
export function formatSchedule(schedule) {
  const s = normalizeSchedule(schedule);
  if (!s) return null;
  const daysSuffix = DAY_MODE_LABEL[s.days] ? ` · ${DAY_MODE_LABEL[s.days]}` : "";
  if (s.recurrence === "interval") {
    const base = `Every ${formatInterval(s.intervalMinutes)}`;
    return (s.windowStart && s.windowEnd
      ? `${base} · ${formatTime12(s.windowStart)}–${formatTime12(s.windowEnd)}`
      : base) + daysSuffix;
  }
  const t = formatTime12(s.time);
  if (s.recurrence === "daily") return `Daily · ${t}${daysSuffix}`;
  if (s.recurrence === "weekly") return `${WEEKDAY_ABBR[s.weekday] || "Mon"} · ${t}`;
  let d = s.date;
  try { d = new Date(s.date + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch {}
  return `Once · ${d}, ${t}`;
}

export function slug(s) {
  return (
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 40) || "shortcut"
  );
}

function uniqueName(base, list, selfId) {
  const taken = new Set(list.filter((s) => s.id !== selfId).map((s) => s.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`.toLowerCase())) n++;
  return `${base}-${n}`;
}

// ---------------------------------------------------------------------------
// PER-OWNER STORAGE (owner directive 2026-09-02): a shortcut is visible ONLY to the
// Agent Go account that created it. Agent Go is a shared-machine product — two people
// can sign in on the same Chrome profile — and a shortcut's prompt / start URL /
// schedule is private data (instance URLs, story numbers, research targets). So the
// list lives under `shortcutsByOwner[<signed-in email>]` in chrome.storage.LOCAL
// (never sync): signed out ⇒ no shortcuts are readable and none can be created;
// sign-out ⇒ the other account's list is unreadable through this module. Every
// consumer (side panel / menu, Options, scheduler alarms, seeds, import/export)
// goes through getShortcuts()/writeShortcuts(), so the scoping is enforced in one
// place. A pre-scoping `shortcuts` array (this machine's owner) is migrated to the
// FIRST account that signs in after the upgrade and then removed.
// ---------------------------------------------------------------------------
const OWNED_KEY = "shortcutsByOwner";   // { [emailLower]: Shortcut[] }
const LEGACY_KEY = "shortcuts";         // pre-2026-09-02 flat list (migrated once)
export const NOT_SIGNED_IN = "Sign in to Agent Go to create or use shortcuts — they are private to your account.";

// The signed-in account's key (lower-cased email) or null when signed out.
export async function shortcutOwner() {
  try {
    const { llmgo_auth: a } = await chrome.storage.local.get("llmgo_auth");
    const email = String((a && a.email) || "").trim().toLowerCase();
    return email && a && a.idToken ? email : null;
  } catch { return null; }
}

async function readOwned() {
  const { [OWNED_KEY]: m } = await chrome.storage.local.get(OWNED_KEY);
  return m && typeof m === "object" && !Array.isArray(m) ? m : {};
}

// One-time migration of the legacy flat list to the signed-in owner. Runs lazily
// on the first scoped read while signed in; a signed-out session leaves the legacy
// list untouched AND unreadable.
async function migrateLegacy(owner) {
  const { [LEGACY_KEY]: legacy } = await chrome.storage.local.get(LEGACY_KEY);
  if (!Array.isArray(legacy)) return;
  const m = await readOwned();
  const mine = Array.isArray(m[owner]) ? m[owner] : [];
  const have = new Set(mine.map((x) => String(x.id)));
  for (const sc of legacy) if (sc && sc.id && !have.has(String(sc.id))) mine.push(sc);
  m[owner] = mine;
  await chrome.storage.local.set({ [OWNED_KEY]: m });
  await chrome.storage.local.remove(LEGACY_KEY);
}

export async function getShortcuts() {
  const owner = await shortcutOwner();
  if (!owner) return [];
  await migrateLegacy(owner);
  const m = await readOwned();
  return Array.isArray(m[owner]) ? m[owner] : [];
}

// Persist the signed-in owner's list. Throws when signed out — a write with no
// owner would have to land in a shared bucket, which is exactly the leak this closes.
async function writeShortcuts(list) {
  const owner = await shortcutOwner();
  if (!owner) throw new Error(NOT_SIGNED_IN);
  const m = await readOwned();
  m[owner] = Array.isArray(list) ? list : [];
  await chrome.storage.local.set({ [OWNED_KEY]: m });
}

export async function saveShortcut(sc) {
  const list = await getShortcuts();
  const clean = {
    name: uniqueName(slug(sc.name), list, sc.id),
    prompt: String(sc.prompt || "").trim(),
    startFrom: String(sc.startFrom || "").trim(),
    model: String(sc.model || "").trim()
  };
  // Only touch `schedule` when the caller actually provides it, so editors that
  // don't manage scheduling (e.g. the Options form) never wipe an existing one.
  if ("schedule" in sc) clean.schedule = normalizeSchedule(sc.schedule); // null = off/unusable
  // Same guard for `category` (Options groups the list by it; empty = General).
  if ("category" in sc) clean.category = String(sc.category || "").trim().slice(0, 40);
  if (sc.id) {
    const i = list.findIndex((s) => s.id === sc.id);
    if (i >= 0) list[i] = { ...list[i], ...clean };
    else list.push({ id: sc.id, ...clean });
  } else {
    list.push({ id: crypto.randomUUID(), ...clean });
  }
  await writeShortcuts(list);
  return list;
}

// Swap two shortcuts' positions in the stored order — which is the order the
// side panel's / menu lists them in. Used by the Options ↑/↓ reorder buttons
// (they pass the neighbor WITHIN the same category group).
export async function swapShortcuts(idA, idB) {
  const list = await getShortcuts();
  const i = list.findIndex((s) => s.id === idA);
  const j = list.findIndex((s) => s.id === idB);
  if (i < 0 || j < 0 || i === j) return list;
  [list[i], list[j]] = [list[j], list[i]];
  await writeShortcuts(list);
  return list;
}

export async function deleteShortcut(id) {
  const list = await getShortcuts();
  await writeShortcuts(list.filter((s) => s.id !== id));
}

// UAT starter pack: a top-8 set of /command shortcuts for the pre-live shakedown
// (2 knowledge-work, 5 ServiceNow, 1 browser). Seeded ONCE on first run and gated by
// a flag, so deleting a seeded shortcut does NOT resurrect it. Names are slugs; run
// them by typing "/name" in the side panel.
const DEFAULT_SHORTCUTS = [
  { name: "research", prompt: "Do deep research on the current Wall Street analyst price target for NVIDIA (NVDA) and cite your sources." },
  { name: "summarize", prompt: "Summarize this page in five bullet points, then list any action items you can find." },
  { name: "sn-scriptinclude", prompt: "In my open ServiceNow instance, create a client-callable Script Include named GetActiveIncidentCount that returns the number of active incidents. Build it directly in the instance — don't just show me the code." },
  { name: "sn-glideajax", prompt: "Create a GlideAjax call that fetches the current user's department name. Build BOTH the client-callable Script Include and the Client Script directly in my instance, with matching names." },
  { name: "sn-review", prompt: "Review the Business Rule \"Derive State value from Parent Incident\" in my instance. Pull the real script, check it against sibling rules on the same table, and flag any issues." },
  { name: "sn-buildbr", prompt: "Create a before-insert Business Rule on the incident table that sets Priority to 1 when both Impact and Urgency are 1. Build it in my instance and confirm it saved." },
  { name: "sn-choices", prompt: "What are the real choice values for the \"State\" field on the incident table in my instance? Only give me values that actually exist there." },
  { name: "hn", prompt: "Go to news.ycombinator.com and give me the top five story titles with their point counts." }
];

// UAT-only: seed ONLY for the two allowlisted UAT accounts, so these test shortcuts never
// appear for general end users when Agent Go opens up.
const UAT_SEED_EMAILS = new Set(["maintainer@example.com"]); // accounts that get the starter shortcuts seeded once — put your maintainer emails here

export async function seedDefaultShortcuts() {
  // Gate on the signed-in email; the seeded flag is PER OWNER (2026-09-02) so each UAT
  // account gets its own private starter set exactly once. Not signed in / other
  // account → skip WITHOUT setting the flag.
  const email = await shortcutOwner();
  if (!email || !UAT_SEED_EMAILS.has(email)) return 0;
  const { shortcutsSeededByOwner: sf } = await chrome.storage.local.get("shortcutsSeededByOwner");
  const seeded = sf && typeof sf === "object" ? sf : {};
  if (seeded[email]) return 0;                   // already seeded once for this account — never re-add
  const list = await getShortcuts();
  const have = new Set(list.map((s) => s.name.toLowerCase()));
  let added = 0;
  for (const d of DEFAULT_SHORTCUTS) {
    const nm = slug(d.name);
    if (have.has(nm)) continue;                  // don't clobber a same-named user shortcut
    list.push({ id: crypto.randomUUID(), name: nm, prompt: d.prompt, startFrom: "", model: "" });
    have.add(nm); added++;
  }
  await writeShortcuts(list);
  await chrome.storage.local.set({ shortcutsSeededByOwner: { ...seeded, [email]: true } });
  return added;
}
