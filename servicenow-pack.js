// servicenow-pack.js — ServiceNow knowledge pack, injected ONLY for SN tasks.
// Distilled from three battle-tested sources in the Agentic Copilot project:
//   1. public/sdlc-phases/phase-07.md + phase-08.md ("USE REAL METHODS ONLY" —
//      proven to fix wrong-SN-code from local Ollama models)
//   2. _ADMIN/SERVICENOW_ARTIFACTS/servicenow_script_detection_rules.md (API tables)
//   3. OUTPUT_BUILDER.md (production guardrails, proven across 36 modules)
// Author: iDevOpsLLC

import { STRUCTURED_PLAN_CONTRACT } from "./plan-template.js";

export const SN_PACK = `
SERVICENOW KNOWLEDGE PACK (proven rules — follow EXACTLY when writing or editing ServiceNow code):

CODE RULES:
- var only — NEVER const/let (server runs ES5 Rhino; const/let break scripts). 2-space indent, real multi-line code.
- No eval(). No hardcoded sys_ids (query reference records by name, or gs.getProperty()). No gs.log() in production — use gs.info()/gs.error() with context. No current.update() in before Business Rules. No "use strict".

CLIENT SCRIPTS (there is NO "form" object and NO change-handler registration — fixed signatures + global g_form):
- onChange: function onChange(control, oldValue, newValue, isLoading, isTemplate) { if (isLoading || newValue === '') return; ... }
  CRITICAL: the FIRST parameter is the field CONTROL, not a value — oldValue/newValue are 2nd/3rd. Never onChange(oldValue, newValue).
- onLoad: function onLoad() { ... }   onSubmit: function onSubmit() { ... return true; } // return false blocks submit
- g_form methods: getValue/setValue/clearValue/setVisible/setMandatory/setReadOnly/setDisplay('field', true|false)/getReference('field', callback)/addErrorMessage/addInfoMessage/showFieldMsg('field','msg','error')/hideFieldMsg. A checkbox value is the STRING 'true' or 'false'.
- These do NOT exist — never write them: form.getField(), field.addonChange(), field.isUnsetValue(), g_form.addError().

SERVER-SIDE:
- Business Rule shape: (function executeRule(current, previous) { ... })(current, previous);
- Script Include shape: var MyUtil = Class.create(); MyUtil.prototype = { initialize: function() {}, ..., type: 'MyUtil' };
- GlideRecord: var gr = new GlideRecord('table'); gr.addQuery(...); gr.query(); while (gr.next()) { ... } — ALWAYS check next()/get() before reading; use getValue('field') not dot-notation; add .name when dot-walking reference fields; setLimit() on large queries; GlideAggregate for counts (never getRowCount()); GlideRecordSecure for user-facing reads.
- gs: gs.info/gs.warn/gs.error, gs.getProperty, gs.getUserID, gs.addErrorMessage, gs.nil. Wrap server logic in an IIFE; try/catch around integrations.
- Check field.changes() before processing in Business Rules; use setWorkflow(false) when updating related records to avoid recursion.

MODERN APIs (current pattern — NEVER the deprecated one):
- Outbound REST: new sn_ws.RESTMessageV2() + setHttpMethod()/setEndpoint(), check getStatusCode() before parsing. NEVER new REST().
- Client-callable Script Include: extends AbstractAjaxProcessor, reads this.getParameter('sysparm_x'), called via ASYNCHRONOUS GlideAjax with a callback (never getXMLWait()).
- ACL script: set a boolean answer (answer = ...); NEVER acl.deny() or onLoad() in an ACL.
- ATF: tests are sys_atf_test + sys_atf_step records — there is NO new ATF.Test() JS class.

ARTIFACT SHAPES:
- Scripted artifact (BR / Script Include / Client Script / UI Action / Scripted REST / Fix Script) = one raw code file.
- Flow Designer = a step-by-step BUILD RECIPE (trigger, numbered steps, data pills) — never a single .js file.
- Service Portal widget = MULTI-PART: HTML template / CSS / Client controller / Server script / Option schema.
- Prefer low-code (Flow Designer, UI/Data Policies, Decision Tables) over scripting when it fits.
- Never fabricate sys_ids, table names, or API methods — if unknown, say validation against the instance is required.`;

// Navigation recipe — appended to EVERY ServiceNow pack (bundled or live) so the
// agent gets the URL right on a real instance. Distilled from the dev99999 /
// ui_builder.do failure: local models guess both the HOST and the PATH.
export const SN_NAV = `
TOOL ORDER — BROWSER TOOLS FIRST (user directive 2026-07-16): when the record you need is OPEN in the tab (or one navigate away), start with the BROWSER tools — read_page, query_elements, list_editors, get_editor_value, open_form_section. They read through the logged-in UI session and never hit REST auth (the sn_* REST tools 401 on instances with Basic-Auth restrictions — every wasted first step tonight was an sn_* call the form could have answered). Reach for sn_* REST tools ONLY for data that is NOT on an open form (cross-table queries, records with no tab open, bulk lookups) — and if one fails, fall straight back to the browser tools, never retry REST more than once.

NAVIGATION (you are driving a LIVE ServiceNow instance — get the URL right):
- ORIGIN: build every URL from the CURRENT tab's origin (see "CURRENT ACTIVE TAB"). NEVER type a placeholder host like dev99999.service-now.com or a bare service-now.com — that abandons the logged-in session. Custom domains (e.g. *.example.com) are NORMAL; stay on the one you are on.
- LISTS / FORMS (classic): <origin>/now/nav/ui/classic/params/target/<target>. Examples: incident list = incident_list.do; one record = incident.do?sys_id=<id>; Business Rules = sys_script_list.do; ACLs = sys_security_acl_list.do.
- OPEN A TABLE IN ONE STEP (2026-08-02: an agent burned 6 calls opening sys_assignment_rule — bare .do 404'd, it re-read the unchanged page, guessed the wrapper, then browsed sys_db_object by label): build the LIST/FORM URL in the wrapper form above on the FIRST navigate. If navigate returns page_not_found, do NOT re-read the page, re-navigate variants, or browse sys_db_object lists — settle table existence with ONE structured call: sn_query_session {table:"sys_db_object", query:"name=<table>", fields:"name,label"}. A read_page that comes back "unchanged" means the page did NOT change — never read it again; act on what you already have.
- UI BUILDER: open it directly at <origin>/now/builder/ui/home — then open the target experience/app by name from that landing page. There is NO "ui_builder.do"; never use it.
- DO NOT INVENT *.do PAGE NAMES. A .do target is valid ONLY as "<table>_list.do", "<table>.do", or a real platform page you have actually seen.
- LIST FILTER SYNTAX (sysparm_query): NEVER put quotes around values — nameLIKE"Network" is INVALID (the quotes become literal characters and the list comes back falsely EMPTY). Correct forms: exact match sysparm_query=name=Network Admins · contains sysparm_query=nameLIKENetwork · starts-with sysparm_query=nameSTARTSWITHSLA. An empty list from a query you built is NOT proof a record doesn't exist — re-check with exact = syntax or the column header search box before concluding anything is missing.
- OTHER APPS / WORKSPACES / App Engine Studio: if you don't know the exact URL, open them by CLICKING their link — read_page to locate the "All" / navigator menu, query_elements for a link whose visible text matches, then click_element it (or type the name into the navigator filter and click the result). Never fabricate a URL.
- CONFIRM: after every navigate, call read_page (or get_tab_info) to verify you actually landed on the intended page before acting.
- CHECK THE ACTIVE TAB BEFORE sn_query_session: sn_query_session rides the CURRENTLY ACTIVE browser tab's login session — if that tab is not the ServiceNow instance (e.g. it is the extension's own Settings/options page, or a different site), the call fails with a permission/host error instead of querying the instance. Before calling sn_query_session (or any browser-session SN tool) if the active tab may have changed, call get_tab_info first; if it is not the target ServiceNow host, switch to it (list_tabs + switch_tab, or navigate) before retrying.
- STAY ON THE RECORD: do not open version-history dialogs, "Versions" related links, or helper-extension links (anything labeled [SN Utils] or similar) — the update set and audit data you need are already in the page text/header. If a popup opens, press Escape and continue from the form.
- SCHEMA FIELD NAMES ARE VISIBLE ON THE FORM (SN Utils pills): the user's SN Utils helper extension shows each field's TECHNICAL column name as a small pill next to / under its label (e.g. Number → number, "Change reason" → u_change_reason, or table.field like sc_task.u_change_reason). read_page and query_elements can read these pills directly — so to learn a field's REAL name, READ the pill beside its label instead of guessing, querying sys_dictionary, or opening the field's ⚙/Dictionary. If the pills are NOT visible, DOUBLE-CLICK an empty spot in the middle of the form — click_element {selector:<form-area handle>, double:true} — to toggle them on, then read the labels again. Do NOT single-click a pill itself: that opens the SN Utils context menu (Open Dictionary / Copy field name / choice list); if one opens, press_key Escape and continue. Field names read off these pills are citable evidence.
- FORM SECTION TABS HIDE FIELDS: classic forms split fields across SECTION TABS below the header (e.g. a UI Policy's "Run scripts" checkbox and Script True/False editors live under its "Script" tab; Business Rules use "When to run" / "Actions" / "Advanced"). If an expected field/checkbox/editor is not found, do NOT keep scrolling or re-querying — call open_form_section with the section's name (e.g. {"section":"Advanced"}); it clicks the tab, auto-checks any controlling checkbox the tab hides behind, and reports the revealed fields plus available_sections.
- REST FAILS → READ THE FORM WITH DOM TOOLS: the sn_* tools (sn_query_table, sn_query_record, sn_fetch_script_by_sysid, ...) hit the REST API and can fail (401/403 auth, 404, wrong table, no record) even though the record is RIGHT THERE in the open tab. When ANY sn_* tool fails and the record's form is open, do not retry REST more than once and do NOT give up on evidence — switch to the browser tools: query_elements (reports each field's live state: checked/value/type/disabled — e.g. a Business Rule's Insert/Update/Delete/Query checkboxes), get_editor_value for Script code editors, open_form_section for fields hidden behind section tabs, read_page for headers/labels. DOM evidence from the logged-in form is first-class evidence — cite it the same way.
- CLICK-BY-CLICK BUILD GUIDE (required for build/change deliverables): if your deliverable recommends or requires APPLYING any concrete change — deploy/replace a script, reconfigure a record, change an Order, deactivate/activate rules, add/remove an artifact, adjust settings — it MUST END with a section titled exactly "## Click-by-Click Build Guide": numbered, admin-executable UI steps built from the CONCRETE values you observed (exact navigation path e.g. All → System Definition → Business Rules → open the record; field-by-field values incl. checkboxes ✔/✗; the Save/Update/Activate click as its own step; a security/ACL step; a test/verify table | # | Test | Steps | Expected |; an artifacts-summary table; and rollback — children before parents). A CODE REVIEW that recommends applying a corrected artifact or config change COUNTS — include the guide (this is what a complete ServiceNow deliverable looks like). ONLY a purely-informational answer with nothing to apply ("no changes needed", an explanation) omits it — never fabricate a guide for a document that changes nothing.
- FENCE YOUR CODE ARTIFACTS: when your deliverable includes a corrected / production / remediated script, wrap it in a FENCED code block — a line with three backticks and the language (e.g. \`\`\`javascript), the code, then a closing three-backtick line — with a "/* File: <DescriptiveName>.js */" as the FIRST line inside the fence. This applies to every standalone artifact (Business Rule, Script Include, Client Script, Fix Script, etc.). The fence is what lets the deliverable be downloaded as a real .js file; unfenced code cannot be. Never put a production artifact as bare/indented text — always fence it.
- NEVER PLACEHOLDER A SCRIPT — EMIT IT IN FULL, WORLD-CLASS: the "Script" (or code) portion of EVERY artifact you report or build MUST contain the COMPLETE script body, written out line by line. NEVER substitute a reference, sys_id, evidence/citation token, label, abbreviation, ellipsis, or any short stand-in for the code — e.g. "CB0", "[script]", "// see above", "// same as before", "...", or a one-line summary is a BROKEN deliverable. A reader must be able to copy the exact, runnable script verbatim from your reply. Write it to WORLD-CLASS ServiceNow standard: ES5 ONLY (\`var\`, no const/let/arrow/template-literals/destructuring — the Rhino engine rejects them), a \`/* File: Name.js */\` header + a short block comment stating purpose, guard clauses and null checks (\`if (!current.isValidRecord()) return;\`), correct \`current.\`/\`previous.\`/\`gs.\`/GlideRecord/GlideAjax idioms, \`.setAbortAction(true)\` where appropriate, and NO \`eval\`/hardcoded sys_ids/\`gs.log\` spam. If you also set the code into the instance via set_editor_value, the SAME full script MUST appear fenced in your reply — the instance write and the shown source must be byte-identical. An artifact whose Script shows only a token/label has NOT been delivered.
- A SYS_ID YOU EXPECT TO EXIST BUT CAN'T FIND MAY HAVE BEEN DELETED: when reviewing an update-set batch and a referenced sys_id (32 hex chars) returns 0 rows from the live table no matter which field you query, do not keep retrying with different field-name guesses (sys_idLIKE, nameLIKE, name=) — for an exact sys_id, query sys_id=<value> once. If that still returns 0 rows, check sys_update_xml for that same sys_id with action=DELETE: a later update set in the same batch may have deleted the record after an earlier one created or updated it. Report what the create/update/delete sequence actually shows instead of treating the missing record as unverifiable, and stop retrying the same lookup.
- SYS_UPDATE_XML'S DIFF CONTENT FIELD IS "payload", NOT "xml"/"element": when querying sys_update_xml via sn_query_session for the actual script/config diff of a customization, request the field named payload — that returns the full XML diff body. Other field-name guesses come back empty even though the record exists, which can wrongly look like the diff is unreadable.
- FIND A RECORD BY NAME (lookup, e.g. "what's the sys_id of X?") → sn_query_session FIRST when MCP isn't connected: sn_query_table hits the REST API and returns "No ServiceNow instance connected" if you haven't set up the ServiceNow MCP (URL+user+pass in the side panel). sn_query_session instead queries through the logged-in browser UI session — but it needs a ServiceNow page ACTIVE. So the fast path is: (1) if list_tabs shows a logged-in instance tab, navigate the ACTIVE tab to that instance (e.g. <origin>/incident_list.do); (2) then call sn_query_session {table, query:"short_description=<name>", fields:"number,short_description,sys_id,state"} — it returns the exact sys_id in ONE structured call. PREFER this over navigate + read_page UI-scraping (which returns slow, unstructured list text). Only fall back to UI-scraping if sn_query_session itself errors. If a name query returns 0 rows, broaden with LIKE (short_descriptionLIKE<words>) before concluding "not found" — and if still nothing, honestly report no match + the closest records (never invent a sys_id).
- INSTANCE-WIDE CONTEXT → sn_query_session: the open form shows ONE record. A thorough review also checks its NEIGHBORS. sn_query_session queries any table through the logged-in UI session (works when sn_query_table 401s). For a Business Rule code review, query sibling rules on the SAME table to catch ORDERING CONFLICTS and OVERLAPPING logic — e.g. sn_query_session {table:"sys_script", query:"collection=incident^active=true^ORDERBYorder", fields:"name,sys_id,order,when,action_insert,action_update,active,condition"}. Compare their order/when/action flags against the rule under review (a validator that aborts at order 100 can wrongly block an update that a later assignment rule at order 1050 would make valid; multiple active rules enforcing the same thing = redundancy). Its results are citable evidence. Also usable for sys_ui_policy, sys_data_policy2, sys_security_acl when the review needs that breadth. Do NOT invent conflicts you didn't query — only report what the results show.
- TOGGLE CHECKBOXES + CHOICE FIELDS WITH sn_set_field, NOT click_element: a ServiceNow checkbox (Glide AJAX enabled/client_callable, Active, Mobile callable, ...) usually does NOT flip when you click its label/span, and fill_input can't set one — DO NOT loop clicking + re-querying (that burns your whole step budget for nothing). Call sn_set_field {field:"client_callable", value:"true"} (value "true"/"false" for a checkbox; the stored value for a choice/select). It uses the form's native g_form.setValue so the real onChange fires. Set the field once, then move on — re-query only if you must confirm, then save_record.
- REFERENCE FIELDS — set by SYS_ID with sn_set_field when you have it: if you already know the target's sys_id (you just created or read that record), call sn_set_field {field:"question", value:"<32-char sys_id>"} — g_form.setValue commits a reference BY SYS_ID reliably. Do NOT reach for set_reference_field / get_reference_suggestions when you have the sys_id: those type a NAME into the autocomplete and can fail to commit (the field DISPLAYS the text while the hidden value stays EMPTY) or hang searching — exactly the trap that stalls a build. Reserve set_reference_field for when you ONLY have a name to search and no sys_id.
- CHECK FOR A DUPLICATE BEFORE CREATING: before you create ANY new record, call sn_check_duplicate {table, name} (add sys_id if you have one) — table is the record's OWN table (sys_script for a Business Rule, sys_ui_action for a UI Action, etc.). It queries through the logged-in UI session, so it works even when sn_query_table returns HTTP 401. If it returns duplicate:true, do NOT create another — open the existing record by its sys_id and update that instead, or report it already exists. Only create when it returns "safe to create."
- SET FIELDS WITH sn_set_field — THE RELIABLE WAY (reference, glide_list, choice, plain): sn_set_field drives the form's own g_form.setValue(), so it sets ANY field type instantly with NO slushbucket DOM, NO "Lookup using list" popup, NO autocomplete race. This is how you build a record end-to-end without getting stuck on a widget. Workflow for a REFERENCE or GLIDE_LIST field (Owner, Assigned to, Category, Catalogs, Watch list, Groups…): (1) get the target record's sys_id with sn_query_session on the reference table (e.g. sc_catalog for Catalogs, sys_user for a user, sys_user_group for a group), then (2) sn_set_field { field:"<name>", value:"<sys_id>", display:"<name>" } (comma-join multiple sys_ids + names for a list; pass append:true to ADD to a list). For a CHOICE field, sn_set_field with the choice value. Use sn_form_fields FIRST if you don't know the field names/types/which are mandatory — it lists every field with type ('reference_or_list' / 'choice' / plain) + mandatory flag. set_reference_field (type + autocomplete) still works for simple reference fields, but sn_set_field is the robust primitive. Do NOT click the magnifying-glass lookup icon (it opens a fragile popup window) and NEVER loop trying to drive a slushbucket by hand.
- LIST / GLIDE_LIST fields are usually OPTIONAL — don't block on them. If a list field (e.g. Catalogs) is NOT mandatory (no red asterisk), you may SKIP it: fill the required fields, save_record, report done, and mention the optional list can be added later. If it IS required (or the user asked for a specific value), set it with sn_set_field per the workflow above — one clean call, verified — never a 4-minute slushbucket fight.
- SAVE-TIME DIALOG "Select a user role for Access Control" (client-callable Script Include): checking "Client callable" (Glide AJAX enabled) and saving pops a MODAL titled "Select a user role for Access Control on this Client Callable Script Include". It is an OPTIONAL ACL prompt and it BLOCKS the save from confirming — handle it in ONE decisive step; do NOT re-query the page in a loop or treat it as an un-clickable "javascript popup" (it is a normal DOM modal, fully clickable via your tools). Steps: query_elements {selector:"button", text:"Cancel"} then click_element that handle — click CANCEL by default; the Script Include still SAVES and remains client-callable, and the user can add an ACL later. Only pick OK instead (query text:"OK") if the user EXPLICITLY asked to restrict the Script Include to a role — first set the role with sn_set_field, then click OK. After dismissing, confirm the save by reading the 32-char sys_id. Never stall on this dialog.
- DON'T ABANDON UNSAVED WORK: navigate now AUTO-DISMISSES the "Leave site? Changes you made may not be saved" prompt and proceeds — so navigating away from a form DISCARDS its unsaved changes silently. If you are mid-building a record that is part of the task, call save_record FIRST, then navigate. Only navigate away from a dirty form when that form's changes are genuinely throwaway (wrong/leftover form). To build TWO artifacts (e.g. a GlideAjax pair), finish + save the first before opening the second.
- SAVING PERSISTS THE RECORD — VERIFY IT: to save a form, call save_record (NOT a bare click_element on the "Submit"/"Update" button). A raw click reports only that the button was clicked, not that the record saved — a mandatory-field block or a client script can silently refuse the insert (a click that "succeeds" can create ZERO records). save_record does a Save-and-stay (you remain ON the saved record), returns ok:false + the empty field names when a mandatory field blocks the save (record NOT created), and returns ok:true with the real sys_id only once persistence is confirmed. Never claim a record was created until save_record confirms it.
- BUSINESS RULE FORM MAP (sys_script): header fields = Name, Table, Application, Active, and an "Advanced" CHECKBOX (top right). Section tabs: "When to run" (When before/after/async/display, Order, Insert/Update/Delete/Query checkboxes, Filter Conditions, Role conditions) · "Actions" (Set field values, Add message, Abort action) · "Advanced" (Condition + Script). CRITICAL: the "Advanced" tab — and therefore the Condition and Script fields — appears ONLY while the header's "Advanced" checkbox is checked. Reliable order to add a Business Rule script (verified live): (1) fill Name + Table, then open_form_section {"section":"When to run"} and set When = before + the Insert/Update checkboxes; (2) open_form_section {"section":"Advanced"} — this checks the Advanced checkbox AND opens the tab, and the Condition field + Script code-editor render (no save needed on the standard form); (3) fill the Condition and use list_editors + set_editor_value to write the Script (the Script field is a CODE EDITOR — NEVER fill_input); (4) call save_record to persist and VERIFY the record actually saved. If open_form_section returns needs_save_first (a customized view that hides Advanced until saved), call save_record first, then reopen the Advanced tab. Never trust a bare click on Submit as proof of a save — use save_record.
- BUILD IT IN THE INSTANCE, DON'T JUST DESCRIBE IT: when the user asks you to CREATE / BUILD / ADD / DEPLOY an artifact (or names an instance URL), your job is to CREATE THE RECORD in the ServiceNow UI through the logged-in browser session — NOT to hand back code and stop. The REST/MCP write tools need credentials that are OFTEN ABSENT (Basic-Auth-restricted instances 401), but the BROWSER is already logged in, so ALWAYS create through the form: sn_check_duplicate first → get_tab_info → build the new-record URL from the CURRENT origin → navigate → fill the header fields → set the script/code field with set_editor_value (a code editor — Monaco on modern instances, CodeMirror on older — list_editors reports which; NEVER fill_input) → save_record → report the real sys_id it returns. ALSO show the fenced code you saved so the user has the source. Fall back to "here is the code to paste" ONLY if creation is genuinely blocked (no writable session) or the user asked EXPLICITLY to just "write"/"show" the code without deploying.
- NEW-RECORD URL: <origin>/<table>.do?sys_id=-1 opens a BLANK form for that table (sys_script_include.do?sys_id=-1 · sys_script_client.do?sys_id=-1 · sys_ui_action.do?sys_id=-1 · sys_script.do?sys_id=-1 for a Business Rule). Build <origin> from get_tab_info — never guess the host.
- SCRIPT INCLUDE FORM MAP (sys_script_include): header fields = Name, API Name (AUTO-fills from Name — leave it), Client callable (CHECKBOX — tick it for a GlideAjax-called include), Application, Active, Accessible from. The Script field is a CODE EDITOR → list_editors + set_editor_value (NEVER fill_input). Flow: navigate sys_script_include.do?sys_id=-1 → fill Name → tick Client callable if called from GlideAjax → set_editor_value the Script body → save_record → verify sys_id. A client-callable include extends AbstractAjaxProcessor.
- CLIENT SCRIPT FORM MAP (sys_script_client): header fields = Name, Table, UI Type (Desktop/Mobile/Both), Type (onChange/onLoad/onSubmit/onCellEdit), Field name (REQUIRED, and shown ONLY when Type=onChange), Active, Applies to. Script field is a CODE EDITOR → set_editor_value. Flow: navigate sys_script_client.do?sys_id=-1 → fill Name + Table → set Type (+ Field name if onChange) → set_editor_value the Script → save_record.
- GLIDEAJAX = TWO RECORDS: "create a GlideAjax call" means creating BOTH a client-callable Script Include (server) AND a Client Script (client) that invokes it — create each as above (two separate save_record calls). The GlideAjax('<Name>') string in the Client Script MUST match the Script Include's Name EXACTLY.
- DON'T RE-HUNT CONTENT YOU ALREADY HAVE: once a script's full body has been captured via get_editor_value or a sn_query_session script field with truncated:false, treat that text as final — do not re-attempt to locate the same content by clicking into the editor, searching with ctrl+f, or re-querying elements. Reuse the text you already captured instead of repeating a click/search/escape loop.
- BUSINESS RULE TRIGGER IS LOAD-BEARING — VERIFY IT (2026-07-19, live false-GO: a before-update BR was GATED GO on script correctness while Insert AND Update were BOTH unchecked → the rule can NEVER fire; a perfect script on an untriggered rule is DEAD CODE). A Business Rule runs ONLY when its "When to run" trigger matches: for When=before/after at least ONE of Insert/Update/Delete/Query MUST be checked (When=display/async have their own semantics). RULE: (a) BUILD — after save_record, RE-READ ni.sys_script.action_insert/action_update/action_delete/action_query via query_elements and confirm the intended trigger(s) are checked:true; cite them as evidence. If the story says "on Update" then action_update MUST be true. (b) REVIEW/REVERIFY/GATE — a Business Rule deliverable that claims to enforce/prevent/auto-set anything is INCOMPLETE and must be NO-GO unless the evidence shows a matching trigger checked. A before/after BR with zero action_* triggers checked is an AUTOMATIC CRITICAL defect regardless of script quality — never GO it. Judging the script's logic alone while the record can't fire is the exact false-GO this rule closes.
- FLOW DESIGNER / WORKFLOW STUDIO — GET THERE IN ONE HOP (2026-07-21, live a-live-run: ~20 wasted steps guessing URLs). Do NOT try /flow-designer (404), /flow_designer.do (no exact match), or /now/builder/ui/home (that is UI Builder, NOT flows). Modern instances open flows in WORKFLOW STUDIO — navigate directly to <origin>/now/workflow-studio/home, then click the "Flows" tab → "New" → "Flow", set the flow Name, click "Build flow". (Classic Flow Designer, if present, is <origin>/$flow-designer.do — the $ prefix; but prefer Workflow Studio.) A flow is a step-by-step BUILD RECIPE (trigger → numbered actions → data pills), NOT a single script — read the injected flow-designer reference for the trigger/action/decision shapes. To check whether a flow already exists, sn_query_session {table:"sys_hub_flow", query:"nameLIKE<name>", fields:"name,sys_id,active,status"}.
- FLOW — EXECUTE THE PLAN, DON'T STOP AT DOCS (2026-07-21): a Flow has NO script editor and NO save_record, so "build it" here means DRIVING the Workflow Studio UI, not writing a recipe. After you post the plan, actually BUILD the flow: (1) set the TRIGGER (e.g. Record Created on sc_req_item, with the condition from the plan); (2) add EACH action from your Build Order IN ORDER — click "+"/"Add an Action, Flow Logic, or Subflow", pick the action (Ask for Approval, Create Record, Update/Add to List field, Look Up Record, Wait/Timer, If/Else Flow Logic for the manager-empty branch, Parallel/async for the "without waiting" path), and set its inputs by dragging/selecting DATA PILLS from the trigger/prior steps as the plan specifies; (3) SAVE, then ACTIVATE the flow. PERSISTING A FLOW = Save + Activate in Workflow Studio (there is no save_record). VERIFY it exists and is active: sn_query_session {table:"sys_hub_flow", query:"nameLIKE<name>", fields:"name,sys_id,active,status"}. A plan / click-by-click recipe WITHOUT an actually created + activated flow is an INCOMPLETE build — the task said BUILD it. Build methodically and save as you go; if a specific action genuinely can't be completed in the UI after a real attempt, report THAT step as blocked with what you tried and how far the flow got — never claim a flow (or an action/branch) you did not actually build.
- CLASSIC WORKFLOW ACTIVITY SCRIPTS → sn_wf_activity_vars (2026-09-02, live STRY0000001: two runs, ~70 calls, never read one advanced_script). A wf_activity row is only the canvas node; what an activity DOES — a Catalog Task / Create Task's advanced_script (task.short_description = …), short_description, description, values (Set Values), assignment_group; a Run Script's script — lives in sys_variable_value (document=wf_activity, document_key=<activity sys_id>). Querying wf_activity for advanced_script/script/vars/input returns NOTHING, wf_activity_variable holds the input MODEL (no values), wf_activity_variable_value does not exist, and clicking canvas nodes navigates away. Call sn_wf_activity_vars {workflow_version:"<sysparm_sys_id from the workflow_ide.do URL>"} ONCE to get every activity's inputs, or {activity_sys_id:"<id>,<id>"} for specific ones; cite the element→value it returns. Two versions in the story (published=true = live; published=false = a checked-out draft) → read both with two calls and say which is which. TO CHANGE an activity's inputs (a story that says "update the SCTASK short description/description", "change the Advanced script", "edit Set Values"): sn_wf_activity_set {activity_sys_id:"<DRAFT activity>", inputs:{advanced_script:"…", values:"…"}} — one call, API-or-form, verified. Never sn_update_record a sys_variable_value row (customer instances 403 it on every auth path and its form renders Value read-only), never DOM-hunt the Workflow Editor dialog. To REMOVE an activity ("delete the X task from the workflow"): sn_wf_delete_activity {activity_sys_id, rewire_to:<the node it led to>}. IF THE INSTANCE REFUSES THOSE TOO (403 on every auth path, read-only form fields): sn_wf_fix_script {workflow_version:"<draft>", name:"<STRY> <title>", set:[{activity:"<name>", inputs:{advanced_script:"…", task_set_values:"assignment_group=…^description=…^EQ"}}], remove:[{activity:"<name>", rewire_to:"<name>"}]} — a Fix Script runs server-side GlideRecord under no table ACLs (the owner's proven route, 2026-09-02); the tool creates the sys_script_fix record and you (or the owner) click "Run Fix Script" on it, then verify with sn_wf_activity_vars. NOTE the Catalog Task Set Values input is task_set_values (short description literal: task_short_description). Both refuse the published version: edit the checked-out draft (published=false; sn_wf_activity_vars {workflow_version:"<draft>"} gives its activity sys_ids), then PUBLISH with sn_wf_publish {workflow_version:"<draft>"} — graph pre-flight + publish + read-back + the cache flush a Table-API publish skips (2026-09-04: a version that read back published=true started nothing for six test records until cache.do was loaded); never the editor's Workflow Actions → Publish (canvas-rendered) and never a bare published=true PATCH.
- VARIABLE-HEAVY CATALOG FORMS — DON'T read_page THE WHOLE FORM: a catalog task (sc_task), catalog item / record producer, or sc_req_item whose sections (Notes, Checklist, "Variables", etc.) contain many variables has an ENORMOUS DOM — a full read_page is slow and returns a wall of low-signal text. To get a SPECIFIC variable's value, use query_elements with a targeted selector for THAT field (match its visible label, e.g. query_elements {text:"Shipping address"}), or fetch the values structurally via sn_query_session (the item's variables live in sc_item_option_mtom → sc_item_option.value keyed by item_option_new.question_text; for the parent request/task query sc_req_item / sc_task fields directly). Reserve read_page for a SHORT header/label scan, never as a way to dump every variable. If a read_page result comes back with "partial":true, the cost guard stopped early because the form was too big — do NOT re-read the same form (you will just get the same partial); act on what you have, or switch to query_elements for the one field you need.`;

// Keywords that signal a ServiceNow task (checked against the user's request).
const SN_KEYWORDS = [
  "servicenow", "service-now", "glide", "gliderecord", "glideajax", "glideaggregate",
  "g_form", "business rule", "script include", "client script", "ui action", "ui policy",
  "ui page", "scripted rest", "rest message", "widget", "sp_widget", "service portal",
  "flow designer", "subflow", "catalog item", "record producer", "incident", "change request",
  "problem record", "cmdb", "atf test", "fix script", "scheduled job", "transform map",
  "acl", "sys_id", "update set", "mid server", "sn_ws", "gs.", "current.", "dot-walk"
];

// Robustly recognise a ServiceNow instance URL — including CUSTOM DOMAINS
// (e.g. customer-dev.example.com) that a bare "service-now.com" test
// misses. Matches the SN host family OR the modern/classic SN URL paths.
export function isServiceNowUrl(url) {
  if (!url) return false;
  return /service-?now/i.test(url)                                   // service-now.com, servicenow.com, *.example.com
    || /\/now\/(nav|builder|workspace|experience|uxbuilder)\b/i.test(url) // modern app paths
    || /\/(?:nav_to\.do|[a-z0-9_]+_list\.do)\b/i.test(url)          // SN classic nav / list pages
    || /[?&](?:sysparm_|sys_id=)/i.test(url);                        // SN hallmark query params
}

// A genuine ServiceNow INSTANCE host (a logged-in instance you can query/build on)
// — NOT a corporate property. Instances use the HYPHENATED service-now.com
// (dev000000.service-now.com, acme.service-now.com); www / docs / community / store
// / developer / nowlearning.servicenow.com are the non-hyphenated marketing/docs
// sites and are NOT instances. Used by navigate's host-correction so a stray
// www.servicenow.com tab can't hijack a real instance navigation (live PE5
// a-live-run). Custom-domain instances aren't auto-detected — callers fail SAFE
// by simply not correcting.
export function isServiceNowInstanceHost(host) {
  return /\.service-now\.com$/i.test(String(host || "").toLowerCase());
}

// POLARIS URL NORMALIZER (2026-07-19, from live a-live-run): the browser's
// address bar shows polaris-wrapped URLs with the target segment PERCENT-ENCODED
// (/now/nav/ui/classic/params/target/sys_user.do%3Fsys_id%3DX?sys_id=X). Models
// copy that URL from read_page output and re-navigate to it — and each re-nav
// NESTS the wrapper (…%3Fsys_id%3DX%3Fsys_id%3DX…) until the page 404s ("Page
// not found" / bare "ServiceNow" title, observed twice in the live run). This
// pure function unwraps: decode the target segment (bounded), keep only the
// first path?query pair (nested duplicates repeat the query), and rebuild the
// clean single-wrap form models use successfully. A clean URL round-trips
// unchanged. Returns the normalized URL string (=== input when no change).
export function normalizeSnPolarisUrl(urlString) {
  try {
    const u = new URL(urlString);
    const m = u.pathname.match(/^\/now\/nav\/ui\/classic\/params\/target\/(.+)$/);
    if (!m || !isServiceNowUrl(u.href)) return urlString;
    let t = m[1];
    if (!/%[0-9a-f]{2}/i.test(t)) return urlString;      // clean target — nothing to unwrap
    for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(t); i++) {
      try { t = decodeURIComponent(t); } catch { break; } // malformed escape — stop, use as-is
    }
    // Nested wrappers duplicate the query: sys_user.do?sys_id=X?sys_id=X → keep the first pair.
    const q1 = t.indexOf("?");
    if (q1 >= 0) {
      const q2 = t.indexOf("?", q1 + 1);
      if (q2 >= 0) t = t.slice(0, q2);
    }
    return `${u.origin}/now/nav/ui/classic/params/target/${t}`;
  } catch {
    return urlString; // unparseable input — never block navigation on the normalizer
  }
}

// POLARIS WRAPPER for bare classic .do targets (2026-08-02, live INC0012345 run
// on customer-dev: navigating <origin>/sys_assignment_rule_list.do rendered the SN
// "Page not found" page, and the agent burned 6 tool calls — re-read, wrapper
// guess, sys_db_object label-browsing — before ever seeing the list). The
// canonical form SN_NAV already teaches is
// <origin>/now/nav/ui/classic/params/target/<table>_list.do?<query>; this pure
// helper rebuilds a bare "<name>.do" / "<name>_list.do" URL into that form so
// navigate can self-heal a classic 404 in ONE call. Non-table platform pages
// (login/home/nav shells) and already-wrapped or non-.do URLs return unchanged.
export function wrapSnClassicTarget(urlString) {
  try {
    const u = new URL(urlString);
    if (!isServiceNowUrl(u.href)) return urlString;
    const m = u.pathname.match(/^\/([a-z0-9_]+\.do)$/i);
    if (!m) return urlString;
    // Shell / auth / navigation pages are not classic table targets — never wrap.
    if (/^(login|logout|welcome|home|navpage|nav_to|side_door|angular|ni)\.do$/i.test(m[1])) return urlString;
    return `${u.origin}/now/nav/ui/classic/params/target/${m[1]}${u.search || ""}`;
  } catch {
    return urlString; // unparseable — never block navigation on the wrapper
  }
}

// Inject the pack when the task mentions ServiceNow concepts OR the active tab
// is a ServiceNow instance. Also catch raw SN table names (sys_user_group.list,
// sc_req_item, cmdb_ci_*) — observed 2026-07-09: a review task naming
// sys_user_group.list ran pack-less because the active tab was chrome://extensions
// right after an extension reload.
export function needsServiceNowPack(taskText, tabUrl) {
  if (isServiceNowUrl(tabUrl)) return true;
  const t = String(taskText || "").toLowerCase();
  if (SN_KEYWORDS.some((k) => t.includes(k))) return true;
  return /\b(sys|sc|cmdb|sn|sysapproval|kb|task_sla|u)_[a-z0-9_]+\.(list|do)\b/.test(t)   // table.list / table.do
    || /\b(sys_user|sys_script|sys_ui|sc_req_item|sc_task|sc_request|cmdb_ci|sysapproval)[a-z0-9_]*\b/.test(t);
}

// ---------------------------------------------------------------------------
// PHASE DETECTION — pick the SDLC phase preset that matches the USER'S INTENT,
// not always Implementation. "Verify if X has been implemented" must load the
// Final-Validation reviewer (read-only, evidence-based verdicts), not phase-08
// build rules (2026-07-09: a verify task got "follow EXACTLY when writing
// code" and the agent offered to CREATE the missing artifact mid-review).
// Most specific first; no match = implementation default (phase-08/07 path).
// ---------------------------------------------------------------------------
const SN_PHASE_SIGNALS = [
  {
    // NOTE: file is phase-09 ON PURPOSE. phase-18's live content is a deployment-GATE
    // rubric (Inputs Received / GO-NO-GO / Handoff) built for reviewing deliverable
    // packages — routed to a live-instance AC check it made the model grade everything
    // "NOT VERIFIED, NO-GO" and claim no ACs were supplied (2026-07-09 18:29 run).
    // phase-09's looser critique content produced every good review today; the verify
    // DISCIPLINE (item-by-item + never-execute) lives in the directive below.
    file: "phase-09.md", label: "VERIFY IMPLEMENTATION (live instance)", mode: "verify",
    words: ["verify", "validate", "has been implemented", "was implemented", "is implemented",
            "implemented requirement", "implemented requirements", "review the implementation",
            "confirm that", "confirm whether", "check if", "check whether", "check that", "audit"],
    directive: "The user asked you to VERIFY requirements against the LIVE INSTANCE — check and report, do NOT build. The requirements ARE in the user's message: verify EACH listed field/value by NAVIGATING to the existing record and READING it (read_page / query_elements / screenshots / editors), then report item-by-item VERIFIED / NOT IMPLEMENTED / PARTIAL with the evidence you saw (record, field, actual value vs required value — a table works well). Ignore any deployment-gate/GO-NO-GO template structure — this is a field-level implementation check, not a release gate. If something is missing, record the gap and continue — do NOT create or modify anything unless the user explicitly asks you to fix it. CRITICAL: requirement text often contains BUILD steps (\"Click New\", \"Fill in\", \"Click Submit\") — those describe what SHOULD ALREADY EXIST. Verify the RESULT (find the existing record and check its values); NEVER execute the steps. Opening a New-record form or typing into fields during verification is a violation."
  },
  {
    file: "phase-09.md", label: "SELF CRITIQUE (code review)", mode: "review",
    words: ["review", "critique", "code review", "find issues", "find bugs", "assess", "evaluate", "quality check"],
    directive: "The user asked for a REVIEW — analyze and report findings (severity-ordered, with evidence), do NOT change anything unless the user explicitly asks you to apply fixes. READ-ONLY discipline: never click New, never fill or submit forms, never modify records. If the requirement text contains build steps (\"Click New\", \"Fill in\", \"Click Submit\"), those describe what should already exist — locate the EXISTING record and verify its values; never execute the steps."
  },
  {
    file: "phase-03.md", label: "UAT (test plan)", mode: "uat",
    words: ["uat", "user acceptance", "test plan", "acceptance test plan"],
    directive: "The user asked for a UAT plan — produce black-box, business-readable test steps from the requirements; do not build or modify anything."
  },
  {
    file: "phase-06.md", label: "TECHNICAL APPROACH (design)", mode: "design",
    words: ["technical approach", "solution design", "architecture", "solution options", "design a solution", "how would you implement"],
    directive: "The user asked for a technical approach — propose and compare solutions; do not build anything yet."
  },
  {
    file: "phase-01.md", label: "GROOMING (story)", mode: "grooming",
    words: ["groom", "grooming", "write a user story", "write acceptance criteria", "story points"],
    directive: "The user asked for story grooming — produce the story/acceptance-criteria deliverable; do not build anything."
  },
];

// Strip QUOTED literals + code so task DATA never drives phase classification
// (2026-07-20, live SS1 a-live-run): "write an AFTER Business Rule … child tasks
// 'Triage evidence', 'Notify stakeholders', 'Close-out review'" got routed to the
// READ-ONLY review preset (phase-09) because the naive t.includes("review") matched
// the quoted TASK NAME "Close-out review". A build task then ran read-only → the
// script was never set, the record never saved, and the review-shaped deliverable
// bloated citations → 4 NO-GO rounds. Remove "…", '…', `…`, and ``` fences before
// matching phase words so a word inside a name/sample/snippet can't set the mode.
function stripDataLiterals(t) {
  return String(t)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*'/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[“”][^“”]*[“”]/g, " "); // curly quotes
}

// Strong BUILD/authoring verbs — a task LEADING with one of these is a build, even
// if a review/verify word appears later (unquoted). "review this BR and apply fixes"
// still leads with "review" → stays review; "write a BR that creates a review task"
// leads with "write" → build.
const BUILD_VERB_RE = /\b(write|create|build|implement|generate|develop|author|configure|add|make|set ?up|deploy|provision)\b/;

export function detectSnPhase(taskText) {
  const raw = String(taskText || "").toLowerCase();
  if (!raw) return null;
  const t = stripDataLiterals(raw);                    // phase words in DATA don't count
  let matched = null, matchIdx = Infinity;
  for (const p of SN_PHASE_SIGNALS) {
    for (const w of p.words) {
      const i = t.indexOf(w);
      if (i >= 0 && i < matchIdx) { matched = p; matchIdx = i; }
    }
  }
  if (!matched) return null; // implementation default
  // BUILD-PRIMARY OVERRIDE: if a build verb appears STRICTLY BEFORE the review/verify
  // signal, the task's primary intent is to BUILD — don't route to a read-only
  // review/verify preset (which would never set/save the artifact). Strict `<` (not
  // `<=`) so a grooming/design signal that itself BEGINS with a build verb —
  // "write a user story", "write acceptance criteria" — is NOT hijacked to build.
  const bm = BUILD_VERB_RE.exec(t);
  if (bm && bm.index < matchIdx) return null;
  return matched;
}

// Bundled fallback for verify/review tasks when the phase-files server is down —
// the discipline matters more than the full preset.
export const SN_REVIEW_PACK = `
SERVICENOW VERIFICATION/REVIEW PACK (the user asked you to VERIFY or REVIEW — NOT to build):
- CHECK and REPORT, item by item: VERIFIED / NOT IMPLEMENTED / PARTIAL, with the evidence you saw (record, field value, page).
- READ-ONLY posture: navigate, open records, read lists/forms/scripts, compare against the requirement. Do NOT create, update, delete, or submit anything unless the user explicitly asks you to fix it.
- If an item is missing, say so and move to the NEXT item — do not offer to build it mid-verification; list all gaps at the end.
- Never fabricate table names, sys_ids, or field values — read them from the instance.`;

// ---------------------------------------------------------------------------
// ARTIFACT-MATCHED API PACKS — the same authoritative per-artifact references
// local-llm-masters uses (public/sn-api-packs/*.md, served from the main app's
// origin). Keep this map in sync with SN_API_PACKS.map in local-llm-masters.html
// and PACK_MAP in _ADMIN/SN_MASTER_BENCH/run_gauntlet.js.
// ---------------------------------------------------------------------------
const SN_API_PACK_MAP = {
  service_portal_widget: "sp-widget.md",
  scripted_rest: "scripted-rest.md",
  client_script: "client-scripts.md",
  ui_policy: "client-scripts.md",
  ui_action: "client-scripts.md",
  business_rule: "business-rules.md",
  script_include: "script-includes.md",
  acl_script: "acl-security.md",
  fix_script: "fix-scripts.md",
  scheduled_job: "fix-scripts.md",
  flow_designer: "flow-designer.md",
  atf_test: "atf.md",
  catalog_item: "catalog.md",
};
const SN_API_PACK_DEFAULT = "core-glide.md";

// Keyword → artifact type. EXPLICIT ARTIFACT NAMES FIRST — table-context words like
// sc_req_item appear in tasks about ANY artifact type (observed 2026-07-09: a Business
// Rule task on sc_req_item matched "requested item" and got catalog.md instead of
// business-rules.md). A miss lands on core-glide.md, which covers the platform broadly.
const ARTIFACT_SIGNALS = [
  // Tier 1 — the task names its artifact type outright
  ["business_rule", ["business rule"]],
  ["script_include", ["script include", "ajax processor", "abstractajaxprocessor"]],
  ["ui_policy", ["ui policy"]],
  ["ui_action", ["ui action"]],
  ["client_script", ["client script"]],
  ["service_portal_widget", ["widget", "service portal", "sp_widget", "client controller"]],
  ["scripted_rest", ["scripted rest", "rest api", "rest endpoint", "restapirequest", "rest resource"]],
  ["flow_designer", ["flow designer", "subflow", "flow action", "data pill", "build a flow", "create a flow", "new flow", "a flow that", "flow that triggers", "flow trigger", "workflow studio", "sys_hub_flow"]],
  ["atf_test", ["atf", "automated test framework", "sys_atf"]],
  ["fix_script", ["fix script", "background script", "one-time script", "data fix", "migration script", "backfill"]],
  ["scheduled_job", ["scheduled job", "sysauto"]],
  ["catalog_item", ["catalog item", "record producer", "catalog client script"]],
  ["acl_script", ["acl", "access control"]],
  // Tier 2 — weaker contextual signals, only when nothing explicit matched
  ["catalog_item", ["service catalog", "variable set"]],
  ["script_include", ["glideajax"]],
  ["client_script", ["onchange", "onload", "onsubmit", "g_form"]],
];

export function detectSnArtifactType(taskText) {
  const t = String(taskText || "").toLowerCase();
  for (const [type, words] of ARTIFACT_SIGNALS) {
    if (words.some((w) => t.includes(w))) return type;
  }
  return "";
}

// Per-file cache for API packs (10 min, same policy as the general rules).
const _apiPackCache = {};

async function fetchSnApiPack(settings, file) {
  const now = Date.now();
  const hit = _apiPackCache[file];
  if (hit && now - hit.ts < CACHE_MS) return hit.text;
  let origin = "";
  try { origin = new URL(String(settings?.phaseFilesUrl || "")).origin; } catch { /* no server configured */ }
  let text = "";
  if (origin) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500); // a hung localhost must never freeze the run
    try {
      const res = await fetch(`${origin}/sn-api-packs/${file}`, { cache: "no-store", signal: ctrl.signal });
      if (res.ok) {
        const body = (await res.text()).trim();
        if (body.length > 200) text = body;
      }
    } catch { /* server down — run proceeds on the general pack alone */ } finally {
      clearTimeout(timer);
    }
  }
  _apiPackCache[file] = { text, ts: now };
  return text;
}

// ---------------------------------------------------------------------------
// ON-DEMAND API-REFERENCE LOOKUP (2026-07-20) — C:\redacted\path
// ServiceNow API Reference) made queryable IN EVERY PHASE so all models share
// ONE source of truth. Tool-capable phases (EXECUTE, repair-execute) call the
// `sn_api_reference` tool with a free-text query; the tool-less gate phases
// receive the SAME corpus by injection (buildServiceNowPack → domainPack).
// Resolution PREFERS a served manifest (/sn-api-packs/_manifest.json — extend it
// to grow coverage with NO code change), then a built-in method/artifact index,
// then a broad-platform default; it NEVER returns empty (bundled core rules are
// the last resort when the pack server is down). The corpus files are the
// PyMuPDF extractions of C:\redacted\path
// ---------------------------------------------------------------------------

// API-method / class → pack, so a query naming a METHOD (not an artifact type)
// still resolves (e.g. "GlideAggregate", "getReference", "RESTMessageV2").
const SN_API_METHOD_INDEX = [
  ["core-glide.md",      ["glideaggregate", "gliderecord", "glidedatetime", "gliderecordsecure", "glideelement", "gs.", "glidesystem", "getrowcount", "addquery", "addencodedquery", "setlimit", "getdisplayvalue", "getunique"]],
  ["client-scripts.md",  ["g_form", "getreference", "g_user", "g_scratchpad", "setvalue", "setmandatory", "setvisible", "setreadonly", "showfieldmsg", "hidefieldmsg", "onchange", "onload", "onsubmit"]],
  ["script-includes.md", ["abstractajaxprocessor", "class.create", "getparameter", "glideajax", "getxmlanswer", "getxmlwait", "client callable", "client-callable"]],
  ["scripted-rest.md",   ["restmessagev2", "sn_ws", "restapirequest", "restapiresponse", "setendpoint", "sethttpmethod", "getstatuscode", "scripted rest"]],
  ["business-rules.md",  ["executerule", "current.update", "setabortaction", "setworkflow", "previous.", "before business rule", "after business rule", "eventqueue", "gs.eventqueue"]],
  ["acl-security.md",    ["canread", "canwrite", "sys_security_acl", "access control", "acl"]],
  ["flow-designer.md",   ["flow designer", "subflow", "data pill", "flowapi", "sn_fd"]],
  ["atf.md",             ["sys_atf", "atf step", "automated test framework", "assertelement"]],
  ["catalog.md",         ["cat_item", "sc_cart", "record producer", "variable set", "catalog client script", "producer."]],
  ["fix-scripts.md",     ["fix script", "background script", "gs.print", "data fix", "backfill", "one-time script"]],
  ["sp-widget.md",       ["$sp", "sputil", "c.server.get", "data.", "service portal widget"]],
];

// Free-text query words that ask for the CATALOG of available references.
const INDEX_QUERIES = new Set(["", "index", "list", "toc", "contents", "help", "packs", "catalog", "available", "what", "?"]);

// Manifest (served, extensible) — the resolution source of truth for coverage.
// [{file, artifact, title, keywords:[...]}]. Cached 10 min like the packs.
let _manifestCache = { arr: null, ts: 0 };
async function fetchPackManifest(settings) {
  const now = Date.now();
  if (_manifestCache.arr && now - _manifestCache.ts < CACHE_MS) return _manifestCache.arr;
  let origin = "";
  try { origin = new URL(String(settings?.phaseFilesUrl || "")).origin; } catch { /* no server configured */ }
  let arr = null;
  if (origin) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(`${origin}/sn-api-packs/_manifest.json`, { cache: "no-store", signal: ctrl.signal });
      if (res.ok) { const j = await res.json(); arr = Array.isArray(j) ? j : (Array.isArray(j?.packs) ? j.packs : null); }
    } catch { /* server down — resolution falls back to the built-in maps */ } finally { clearTimeout(timer); }
  }
  _manifestCache = { arr, ts: now };
  return arr;
}

// PURE resolver (exported for unit tests) — pick the pack file for a query.
// Order: explicit artifact hint → manifest keyword scoring → method index →
// artifact detection on the query text → broad-platform default.
export function resolvePackFile(query, artifactHint, manifest) {
  const q = String(query || "").toLowerCase();
  if (artifactHint && SN_API_PACK_MAP[artifactHint]) return { file: SN_API_PACK_MAP[artifactHint], artifact: artifactHint, why: "artifact-hint" };
  if (Array.isArray(manifest) && manifest.length) {
    let best = null, bestScore = 0;
    for (const row of manifest) {
      const kws = [].concat(row.keywords || [], row.title || "", row.artifact || "").map((k) => String(k).toLowerCase());
      let score = 0;
      for (const k of kws) { if (k && q.includes(k)) score += (k.length > 3 ? 2 : 1); }
      if (score > bestScore) { bestScore = score; best = row; }
    }
    if (best && bestScore > 0) return { file: best.file, artifact: best.artifact || "", why: "manifest" };
  }
  for (const [file, kws] of SN_API_METHOD_INDEX) { if (kws.some((k) => q.includes(k))) return { file, artifact: "", why: "method-index" }; }
  const at = detectSnArtifactType(query);
  if (at && SN_API_PACK_MAP[at]) return { file: SN_API_PACK_MAP[at], artifact: at, why: "artifact-detect" };
  return { file: SN_API_PACK_DEFAULT, artifact: "", why: "default" };
}

// The tool entry point. Returns authoritative reference text (or the catalog in
// index mode); never throws, never empty. settings.phaseFilesUrl origin serves
// the corpus (same host as sdlc-phases + sn-api-packs).
export async function lookupSnApiReference(settings, query, artifactHint = "") {
  const q = String(query || "").trim();
  const manifest = await fetchPackManifest(settings);
  if (INDEX_QUERIES.has(q.toLowerCase())) {
    const rows = Array.isArray(manifest) && manifest.length
      ? manifest.map((r) => `- ${r.file} — ${r.title || r.artifact || r.file}`)
      : [...new Set(Object.entries(SN_API_PACK_MAP).map(([a, f]) => `- ${f} — ${a.replace(/_/g, " ")}`))].concat(`- ${SN_API_PACK_DEFAULT} — core platform / Glide`);
    return { ok: true, mode: "index",
      source: "C:\\redacted\\path)",
      available: rows.join("\n"),
      note: "Call sn_api_reference again with a specific query (an API method/class/table/event or artifact type) to pull that reference's authoritative text." };
  }
  const pick = resolvePackFile(q, artifactHint, manifest);
  const text = await fetchSnApiPack(settings, pick.file);
  if (text) {
    return { ok: true, mode: "lookup", query: q, artifact: pick.artifact || undefined, file: pick.file, resolved_by: pick.why,
      source: "C:\\redacted\\path)", text };
  }
  // Pack server unreachable — return bundled core rules so the model is never
  // left ungrounded (honest about the degraded source).
  return { ok: true, mode: "fallback", query: q, file: pick.file,
    source: "bundled SN core rules (the sn-api-packs server was unreachable — the full C:\\redacted\\path)",
    text: SN_PACK };
}

// Advertised to every SN run's drafter (appended to the pack) AND injected into
// the tool-less gates — so all phases know the C:\redacted\path
// tool-capable phases can call the tool.
export const SN_REF_TOOL_NOTE = `
AUTHORITATIVE API REFERENCE ON DEMAND (single source of truth): the official ServiceNow API Reference (C:\\redacted\\path) is authoritative for how any API method, table field, or event actually behaves. Whenever you are unsure of a method signature, whether a method exists, valid event names, or a table/field — CALL the sn_api_reference tool ({"query":"<API method/class/table/event or artifact type>"}) and follow what it returns over your memory; its text OVERRIDES any conflicting recollection or code sample. To LIST the methods of a class, query the class name (e.g. {"query":"GlideAggregate methods"}) — the pack contains the COMPLETE documented method roster for the core Glide classes (GlideRecord, GlideAggregate, GlideElement, GlideDateTime, GlideSystem, GlideForm/g_form). Use {"query":"index"} to see what references exist.
GROUND IN WHAT THE TOOL RETURNS — DO NOT GREP THE RAW PDF: answer from the pack sn_api_reference gives you. If a specific method or detail is NOT in the returned reference, say so plainly ("not in the documented reference — validate against the live instance") — do NOT invent it, and do NOT try to open, read, or search the raw reference PDF yourself (do NOT run_command a python/PyMuPDF script, and do NOT read_file the multi-hundred-MB PDF — read_file is scoped to the connected folder and a raw-PDF grep will dead-end). The sn_api_reference tool IS your access path to C:\\redacted\\path
CITE THE REFERENCE (so the gates can verify it): the sn_api_reference result is recorded in the evidence ledger — its returned text is chunked into citation tokens (_cite / [E<n>.text], [E<n>.text.1], …). When you state what the reference documents (e.g. a class's method list), attach the token for the chunk that contains it, exactly as you cite any other evidence — using the EXACT token strings the tool result gives you in its _cite list; never invent an [E<n>.O<k>] or chunk number that the result did not return (a made-up token fails the deterministic gate and forces a repair). An answer that lists methods FROM the reference WITHOUT citing its ledger tokens will read to the reviewer as unsupported/fabricated — cite the chunk and the roster is verified authoritative.`;

// ---------------------------------------------------------------------------
// LIVE LOADER — reads the actual SDLC phase presets over HTTP so the pack
// never drifts from the source. Falls back to the bundled SN_PACK constant
// when the main app server isn't running. Result cached for 10 minutes.
// ---------------------------------------------------------------------------
let _cache = { text: null, ts: 0, source: "bundled" };
const CACHE_MS = 10 * 60 * 1000;

// Pull the proven "code rules + USE REAL METHODS ONLY API reference" region
// out of a phase preset, ignoring the surrounding SDLC scaffolding.
function extractRules(md) {
  const startMarkers = ["Rules for ALL code", "Use var for ALL", "SERVICENOW API - USE REAL", "ServiceNow API Reference"];
  const endMarkers = ["6. SELF-CHECK", "2. MISSING INFORMATION", "\nHARD RULES"];
  let start = -1;
  for (const m of startMarkers) {
    const i = md.indexOf(m);
    if (i >= 0) { start = i; break; }
  }
  if (start < 0) return null;
  let end = md.length;
  for (const m of endMarkers) {
    const i = md.indexOf(m, start);
    if (i >= 0) end = Math.min(end, i);
  }
  const slice = md.slice(start, end).trim();
  return slice.length > 200 ? slice.slice(0, 4500) : null;
}

let _lastSource = "bundled";
export function packSource() {
  return _lastSource;
}

// General code rules (live phase preset or bundled constant) — cached WITHOUT the
// navigation recipe so composition happens per call.
async function loadGeneralRules(settings) {
  const now = Date.now();
  if (_cache.text && now - _cache.ts < CACHE_MS) return _cache;

  const base = String(settings?.phaseFilesUrl || "").replace(/\/+$/, "");
  if (base) {
    for (const f of ["phase-08.md", "phase-07.md"]) {
      // Hard timeout so a slow/hung localhost can never freeze the agent run.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      try {
        const res = await fetch(`${base}/${f}`, { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) continue;
        const rules = extractRules(await res.text());
        if (rules) {
          const text = "SERVICENOW KNOWLEDGE PACK (live from " + f + " — follow EXACTLY when writing/editing ServiceNow code):\n" + rules;
          _cache = { text, ts: now, source: "live:" + f };
          return _cache;
        }
      } catch {
        /* server down / slow / unreachable — fall through to bundled */
      } finally {
        clearTimeout(timer);
      }
    }
  }
  _cache = { text: SN_PACK, ts: now, source: "bundled" };
  return _cache;
}

// Per-file cache for intent-matched phase presets (10 min, same policy).
const _phaseCache = {};

async function fetchPhaseFile(settings, file) {
  const now = Date.now();
  const hit = _phaseCache[file];
  if (hit && now - hit.ts < CACHE_MS) return hit.text;
  const base = String(settings?.phaseFilesUrl || "").replace(/\/+$/, "");
  let text = "";
  if (base) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(`${base}/${file}`, { cache: "no-store", signal: ctrl.signal });
      if (res.ok) {
        const body = (await res.text()).trim();
        // From the top (role + principles + task live there), capped for the
        // local-model context budget.
        if (body.length > 300) text = body.slice(0, 4200);
      }
    } catch { /* server down — bundled fallback */ } finally {
      clearTimeout(timer);
    }
  }
  _phaseCache[file] = { text, ts: now };
  return text;
}

// STICKY PHASE — a review/verify conversation stays in review mode across follow-up
// turns. Observed 2026-07-09: mid-review "Okay, you may continue" carried no phase
// keywords, so the turn silently flipped to phase-08 BUILD rules inside a review.
// A detected phase is remembered 30 min and reused for continuation turns UNLESS the
// new turn shows build intent ("apply the fix", "create", ...) — that releases it.
const PHASE_STICKY_MS = 30 * 60 * 1000;
const BUILD_INTENT_WORDS = ["create", "build", "implement", "write", "generate", "develop",
  "apply", "fix ", "add ", "insert", "modify", "change the", "update the", "set the"];
// In-memory cache backed by chrome.storage.session: MV3 service workers unload after
// ~30s idle and wipe module state — observed 2026-07-09: a "Thank you" turn after the
// user read a long review report came back as phase-08 BUILD because the sticky was
// lost with the SW. storage.session survives SW restarts (cleared on browser exit).
let _stickyPhase = { file: null, ts: 0 };

async function loadStickyPhase() {
  if (_stickyPhase.file) return _stickyPhase;
  try {
    const o = await chrome.storage.session.get("snStickyPhase");
    if (o && o.snStickyPhase) _stickyPhase = o.snStickyPhase;
  } catch { /* non-extension context (tests) — memory only */ }
  return _stickyPhase;
}

function saveStickyPhase(file, ts) {
  _stickyPhase = { file, ts };
  try { chrome.storage.session.set({ snStickyPhase: _stickyPhase }); } catch { /* memory only */ }
}

async function resolvePhase(taskText) {
  const detected = detectSnPhase(taskText);
  if (detected) { saveStickyPhase(detected.file, Date.now()); return { phase: detected, sticky: false }; }
  const sticky = await loadStickyPhase();
  if (sticky.file && Date.now() - sticky.ts < PHASE_STICKY_MS) {
    const t = String(taskText || "").toLowerCase();
    if (!BUILD_INTENT_WORDS.some((w) => t.includes(w))) {
      const phase = SN_PHASE_SIGNALS.find((p) => p.file === sticky.file);
      if (phase) { saveStickyPhase(phase.file, Date.now()); return { phase, sticky: true }; }  // continuation keeps it alive
    }
    saveStickyPhase(null, 0);                              // build intent releases review mode
  }
  return { phase: null, sticky: false };
}

// Full pack = intent-matched phase guidance (verify/review/uat/design/grooming —
// implementation phase-08/07 only as the build default) + artifact-matched API
// reference + navigation recipe. taskText drives BOTH detections.
export async function buildServiceNowPack(settings, taskText) {
  const { phase, sticky } = await resolvePhase(taskText);
  let text, source;
  if (phase) {
    const live = await fetchPhaseFile(settings, phase.file);
    if (live) {
      text = "SERVICENOW " + phase.label + " PACK (live from " + phase.file + " — this is a " + phase.mode.toUpperCase() + " task, NOT implementation):\n" +
        phase.directive + "\n\n" + live;
      source = "live:" + phase.file + " (" + phase.mode + (sticky ? ", sticky" : "") + ")";
    } else {
      // Server down: verify/review keep the bundled reviewer discipline; the
      // planning modes fall back to the directive + general rules.
      text = (phase.mode === "verify" || phase.mode === "review")
        ? SN_REVIEW_PACK
        : phase.directive + "\n" + SN_PACK;
      source = "bundled (" + phase.mode + (sticky ? ", sticky" : "") + ")";
    }
  } else {
    const general = await loadGeneralRules(settings);
    text = general.text;
    source = general.source;
  }
  const artifactType = detectSnArtifactType(taskText);
  const file = SN_API_PACK_MAP[artifactType] || SN_API_PACK_DEFAULT;
  const apiPack = await fetchSnApiPack(settings, file);
  if (apiPack) {
    text += "\n\n--- ServiceNow API Reference (artifact-matched: " + file +
      " — authoritative for signatures and table names; prefer this over memory) ---\n" + apiPack;
  }
  text += "\n" + SN_NAV;
  // Every SN run (any phase) carries the C:\redacted\path
  // lookup tool note, so all models operate under ONE source of truth.
  text += "\n" + SN_REF_TOOL_NOTE;
  // AUTO-REFERENCE ROUTING (2026-07-20, live SS1 a-live-run): on a BUILD/implementation
  // run (no review/verify/uat/design/grooming phase), deterministically GUIDE the drafter
  // to the exact reference(s) this task needs — and make it reference-first + build-and-SAVE.
  // In the SS1 run glm never called sn_api_reference at all and (framed as review) never
  // saved; naming the packs up front + mandating a citable reference-first read fixes both.
  if (!phase) {
    const artifactLabel = artifactType ? artifactType.replace(/_/g, " ") : "";
    const recordsLikely = /\b(record|records|gliderecord|glideaggregate|query|insert|create|table|incident|task|catalog)\b/i.test(String(taskText || ""));
    // MANDATORY STRUCTURED PLAN first (user directive 2026-07-21) — the SN build gets
    // the same Requirement→Findings→SN_REF→Design→Build→UAT plan as the sample.
    text += "\n" + STRUCTURED_PLAN_CONTRACT;
    text += `\n\nREFERENCE FILLS THE PLAN (this is a BUILD task): as PART OF PLANNING (before you write the plan out), call sn_api_reference to load the authoritative C:\\redacted\\path's REFERENCE VERIFICATION section — this is not permission to start building. YOU pick the right reference: call {"query":"index"} to see every available reference, then read the one(s) that match the artifact you're building (e.g. flow-designer for a Flow, business-rules for a Business Rule, sp-widget for a widget) — do NOT rely only on any auto-injected pack, which may not match your artifact.` +
      (artifactLabel ? ` For this task, the artifact reference is likely ${file} — start with {"query":"${artifactLabel}"}.` : ` Query the artifact type you are building.`) +
      (recordsLikely ? ` Also call {"query":"GlideRecord methods"} if you will create/query records.` : ``) +
      ` Cite the returned [E#.text…] tokens in the plan (an uncited API claim will be rejected by the reviewer). ONLY AFTER you have posted the FULL structured plan + UAT (per the ⛔ PLAN-BEFORE-BUILD gate above) do you build: set the script with set_editor_value, persist with save_record, and re-read to confirm. Building BEFORE the plan is posted is a failure; and a plan WITHOUT the persisted build (set_editor_value + save_record) is an INCOMPLETE build.`;
  }
  _lastSource = source + (apiPack ? " + api:" + file : "") + (!phase ? " + ref-first" : "");
  return text;
}
