// workflow-studio-pack.js — Workflow Studio (modern Flow Designer: flows, subflows,
// actions, triggers, playbooks, decision tables) build+update pack. Injected ONLY for
// modern-builder tasks, as an overlay ON TOP of the ServiceNow pack (sibling of
// legacy-workflow-pack.js, which owns wf_* / workflow_ide.do). Distilled from:
//   research/legacy-workflow/02_web_docs.md §15        — Zurich Workflow Studio docs
//   research/legacy-workflow/05_workflow_studio_discovery.md — dev000000 empirical discovery
//   research/legacy-workflow/04_pack_architecture.md   — wiring recipe
// Author: iDevOpsLLC

// -----------------------------------------------------------------------------
// WFS_PACK — non-negotiable rules (concept map, data model, REST-safety verdict).
// -----------------------------------------------------------------------------
export const WFS_PACK = `
WORKFLOW STUDIO PACK — rules for the MODERN builder (/now/workflow-studio, sys_hub_*/sys_pd_*/sys_decision* tables). Legacy wf_*/workflow_ide.do is a DIFFERENT product — never mix the two.

TASK FIDELITY (live failure 2026-07-30): your plan MUST restate the user's actual request and its artifact type. A flow-creation task plans a sys_hub_flow — if your plan names a Business Rule, Script Include, or any artifact from a template EXAMPLE, you have copied the example, not the task: discard and re-plan. NEVER claim a tool result you did not actually run in THIS conversation — every "verified" line must cite a real call from this run. Never ask the user for the instance URL — get_tab_info gives it.
AUTH FALLBACK: if sn_query_table/sn_create_record return HTTP 401 (no MCP credentials) or a session WRITE returns 403 (CSRF + write ACLs), switch to sn_query_session (browser-session auth — works whenever the tab is logged in) for ALL reads, and do mutations through the Studio UI. Do not stall on 401/403; do not ask for passwords.

CONCEPT MAP (what each artifact IS):
- FLOW (sys_hub_flow, type=flow): trigger + ordered actions/flow logic/subflow calls + error handler; runs when the trigger fires.
- SUBFLOW (sys_hub_flow, type=subflow): NO trigger; declared inputs/outputs; called from flows, subflows, playbooks, or script (FlowAPI).
- ACTION (sys_hub_action_type_definition): reusable operation built of steps; grouped by spoke. Prefer OOB actions over building custom ones.
- TRIGGER: one per flow. Record-based (Created/Updated/Created or Updated + table + condition), Scheduled, or application-based (Service Catalog, SLA Task, Inbound Email…).
- PLAYBOOK (sys_pd_process_definition): human-interactive process = triggers → lanes/stages → activities (each powered by a flow/subflow/action). Users interact step-by-step ⇒ playbook; hands-off/high-frequency ⇒ flow.
- DECISION TABLE (sys_decision): if-then rule rows decoupled from code; each row = condition over declared inputs → answer record; consumed via the Decision flow logic or script.

DATA MODEL (verified on-instance):
- sys_hub_flow extends sys_hub_flow_base: name, internal_name, type (flow|subflow), active, status (draft|published), run_as, sc_callable, plus latest_snapshot / master_snapshot (32-char pointers into sys_hub_flow_snapshot). latest != master ⇒ unpublished draft edits exist.
- Graph = ordered sys_hub_flow_component rows (flow, order, sys_class_name, ui_id/parent_ui_id GUID nesting — an If/ForEach's children carry its ui_id as parent_ui_id). Node kinds: sys_hub_action_instance(_v2) (action_type; input VALUES in sys_variable_value rows document=sys_hub_action_instance), sys_hub_flow_logic(_instance_v2) (logic_definition; decision_table ref; workflow_reference for Call a Workflow), sys_hub_sub_flow_instance. NO transition table — sequence is order + nesting.
- Triggers: sys_hub_trigger_instance (v1, glide_var inputs) and sys_hub_trigger_instance_v2 (trigger_inputs is a gzip+base64 BLOB — unreadable/unwritable over REST). Flow inputs/outputs: sys_hub_flow_input/_output (model → flow).
- Playbooks: sys_pd_process_definition (status, sync_state, snapshot, designer_state json) → sys_pd_lane → sys_pd_activity; triggers sys_pd_trigger_definition/_instance; runtime sys_pd_context.
- Decision tables: sys_decision (name, label, active, answer_type + answer_table) → sys_decision_question rows (condition, answer=document_id into answer_table, order, default_answer, active) + sys_decision_input var models + sys_decision_multi_result(_element). NO blob fields.

REST-SAFE vs UI-ONLY (from live discovery):
- SAFE (Table API): ALL reads/verification; activate/deactivate a flow (PATCH sys_hub_flow active=true/false — the one blessed programmatic mutation, cf. /api/wfa_fluent/activate_flows); decision-table ROW CRUD (sys_decision_question + answer records + sys_decision header fields); cosmetic metadata.
- UI-ONLY (Studio SPA): CREATING flows/subflows/actions/playbooks and ALL graph edits (nodes, trigger config, action inputs). WHY: every Studio save writes a sys_hub_flow_snapshot (full clone of flow + components) and activation COMPILES it; the ENGINE RUNS THE COMPILED MASTER SNAPSHOT, not the live rows. Raw REST row writes create NO snapshot and NO compile ⇒ the published flow keeps running the old graph while design rows silently diverge. NEVER author the graph over raw REST.
- NEVER TOUCH runtime/engine tables: sys_flow_context, sys_flow_compiled_flow, sys_hub_snapshot(_chunk), sys_pd_context.
- No authoring REST API exists: FlowAPI (sn_fd) is script EXECUTION only (startFlow/startSubflow/startAction, decision execution); the "Workflow Studio API" scripted REST is a dashboards read; Flow Diagramming API is internal read-only.

LIFECYCLE + SCOPE GOTCHAS:
- Save (draft snapshot) → Test (manual run) → Activate/Publish (compile). Deactivating stops future triggering only; running contexts finish.
- Scope: a flow is authored IN an application scope and only editable in Studio with that scope selected; run_as System vs user changes what it can touch.
- Record triggers do NOT fire for non-interactive/workflow-initiated updates unless configured ("Run flow on update by workflows").
- Editing an ACTIVE flow edits a DRAFT (latest_snapshot); the master keeps running until you re-activate/publish. Verify after publish: latest_snapshot == master_snapshot.
- Script fields run server Rhino ES5 — var only, never const/let.`;

// -----------------------------------------------------------------------------
// WFS_NAV — Studio SPA navigation + operational recipes with exact tool ordering.
// -----------------------------------------------------------------------------
export const WFS_NAV = `
WORKFLOW STUDIO — HOW TO NAVIGATE + BUILD/UPDATE (exact tool order):

THE STUDIO SPA: <origin>/now/workflow-studio/home/process (build from the CURRENT tab's origin — never a placeholder host). It is a Polaris/Seismic SPA rendered in nested SHADOW DOM: read_page and query_elements both pierce open shadow roots — use query_elements {text:"..."} to find buttons/menu items by visible label rather than guessing CSS selectors; re-query after every navigation because the SPA re-renders and old element handles go stale. If a pane reads empty, scroll_page and read_page again (virtualized lists). Home tabs: Process (flows/subflows/actions/decision tables/playbooks lists), Operations (execution dashboards), Integrations (spokes). The Create button (top right) creates ANY artifact type; each artifact opens in its own tab inside Studio. Legacy nav entries (Flow Designer, Process Automation Designer) open the same Studio lists.
LIST/RECORD FALLBACK for verification (always available even when the SPA misbehaves): <origin>/sys_hub_flow.list, sys_hub_flow_component.list, sys_hub_trigger_instance_v2.list, sys_decision.list, sys_pd_process_definition.list — and sn_query_table / sn_query_session for reads when REST 401s. Direct-open one flow in Studio: search its name in the Process tab list (fill_input the list filter), click the row.

RECIPE — CREATE A FLOW (UI authoring + REST verification after every step):
1. navigate <origin>/now/workflow-studio/home/process → read_page to confirm the Studio home loaded (Process tab, Create button).
2. click Create → choose Flow → name it (fill_input), pick application scope + run-as → Build flow. VERIFY: sn_query_table {table:"sys_hub_flow", query:"name=<Name>", fields:"sys_id,internal_name,type,active,status,latest_snapshot,master_snapshot"} — a draft row must exist; capture sys_id.
3. ADD TRIGGER: click the "Add trigger" button (id flow_trigger_add_toggle; the "Add a trigger" text link opens the same picker). ⚠ TRUSTED-CLICK TRAP (live 2026-07-30): Studio widgets swallow synthetic clicks — click_element says ok:true but nothing opens (aria_expanded_after:"false" = did NOT open). Recovery: desktop_screenshot to locate the control, then desktop_click_hold at it (FIRM real press, down→pause→up — the reliable path; instant clicks also get swallowed). press_key Enter is a cheap secondary try. NEVER re-click the same handle more than twice. Once open, the picker is a two-pane dropdown (confirmed live 2026-07-30): "Select a Trigger" combobox → left pane categories (Record | Scheduled | Application), right pane options for the highlighted category, a "Search Triggers" input on top, and an "Abort trigger creation" link (its presence = picker IS open; read_page may still say {unchanged:true}). SELECTION RECIPE — Studio menus need a HARD (trusted) click; synthetic DOM clicks are swallowed even when the item is found. (1) fill_input the "Search Triggers" box with the option name (e.g. "Created") to flatten the list, (2) desktop_screenshot to see the open picker, (3) desktop_click_hold on the option — the FIRM press is the reliable selector here; one click_element attempt is fine, then go straight to desktop_click_hold (never loop DOM clicks). For the two-pane menu without search: desktop_click_hold on the category (e.g. "Record") pops the right pane; then desktop_click_hold the option ("Created") — or press at the category and release over the option using x2,y2. Options are plain nested elements — role=option/li selectors find NOTHING, so locate by query_elements {selector:"*", text:"Created"} or the screenshot. Keyboard fallback: press_key ArrowDown + Enter drives the combobox. Trigger names are "Created", "Updated", "Created or Updated" — NOT "Record Created" (confirmed live: sys_hub_trigger_definition). Pick one → set Table (e.g. incident) + Condition → Done. VERIFY: sn_query_table {table:"sys_hub_trigger_instance_v2", query:"flow=<sys_id>", fields:"sys_id,name,trigger_type"} (also check sys_hub_trigger_instance — older instances/types use v1); count 0 after Done = the trigger was NOT saved — reopen the picker instead of proceeding. Do NOT try to read trigger_inputs (gzip blob). The same trusted-click trap applies to "Add an Action, Flow Logic, or Subflow" and other Studio buttons — the aria_expanded_after / desktop_click recovery chain is the general rule in Workflow Studio.
3b. DUPLICATE GUARD: "Build flow" CREATES the sys_hub_flow record immediately — never click New/Build flow again for the same task; when opening from the list match the sys_id you captured (same name + different sys_id = a duplicate you made: keep the one you edit, deactivate the other, tell the user).
4. ADD ACTIONS/LOGIC one at a time (anatomy confirmed live 2026-07-30): click "Add an Action, Flow Logic, or Subflow" → the row is REPLACED by inline buttons [X][Action][Flow Logic][Subflow] — you MUST then click "Action" to open the searchable action list (renders in a now-popover; the X / "Close picker" button id flow_action_btnToggleAction closes it — do not click that). ⚠ The only always-present input (id header-title-input) is the FLOW NAME — NEVER type an action name into it; the action search box exists only after clicking "Action" (if query_elements finds no new input, the popover did not open — firm-click "Action" via desktop_click_hold). Pick the action (e.g. ServiceNow Core > Send Email) → fill the config panel (fill_input/select_option; data pills via the pill picker; list_editors + set_editor_value for script fields — NEVER fill_input a code editor) → Done. TRIGGER COMPLETENESS: "Created" alone is not a finished trigger — the Table field must be set (e.g. incident) before Done (id flow_trigger_btn_done); re-open the trigger (its name link, id flow_trigger_expand_form) after Done and confirm Table shows the value ("Select a table first" under Condition = Table is still unset). SELECT2 FIELDS (Table/reference pickers, id s2id_autogen*): type to filter, then click the div id select2-result-label-* (NOT the li — handles go stale on re-render; re-query first) or ArrowDown+Enter. Save (Studio auto-saves drafts; use the Save button when present). VERIFY after each node: sn_query_table {table:"sys_hub_flow_component", query:"flow=<sys_id>^ORDERBYorder", fields:"sys_id,sys_class_name,order,ui_id,parent_ui_id"} — count and order must match what you built; action input values: sn_query_table {table:"sys_variable_value", query:"document=sys_hub_action_instance^document_key=<component sys_id>", fields:"variable.element,value"}.
5. TEST: Studio Test button → pick a record/inputs → run → open execution details; or verify via sn_query_table {table:"sys_flow_context", query:"ORDERBYDESCsys_created_on", fields:"sys_id,name,state", limit:5}.
6. ACTIVATE: Studio Activate/Publish button. VERIFY: sn_query_table {table:"sys_hub_flow", query:"sys_id=<sys_id>", fields:"active,status,latest_snapshot,master_snapshot"} — active=true, status=published, and latest_snapshot == master_snapshot. If they differ, the draft did not publish — re-activate in Studio.

RECIPE — UPDATE AN EXISTING FLOW:
1. Find it: sn_query_table {table:"sys_hub_flow", query:"nameLIKE<name>", fields:"sys_id,name,active,status,latest_snapshot,master_snapshot,sys_updated_on,sys_scope.scope"}. Note the scope — Studio must be in that scope to edit (scope picker / app picker top of Studio).
2. Open in Studio (Process tab list → search → click row). Record the pre-edit sys_updated_on and master_snapshot.
3. Make the edit in the canvas/config panels (as in CREATE step 4). Save.
4. Re-activate/publish. VERIFY: re-query step 1 — sys_updated_on advanced, latest_snapshot == master_snapshot (published), and sn_query_table sys_hub_flow_component confirms the structural change (new/removed node, changed order). A click that "succeeded" is not evidence — never claim an edit you did not read back.
5. To DISABLE a flow without opening Studio: sn_update_record {table:"sys_hub_flow", sysId:"<sys_id>", fields:{active:"false"}} (re-enable with active:"true") — this is the ONE safe REST mutation on flows; verify by re-query.

RECIPE — DECISION TABLE (REST-safe row CRUD; UI for new input columns):
- READ: sn_query_table {table:"sys_decision", query:"nameLIKE<name>", fields:"sys_id,name,label,active,answer_type,answer_table"} then {table:"sys_decision_question", query:"decision_table=<d>^ORDERBYorder", fields:"sys_id,label,order,condition,answer,default_answer,active,input_table"}.
- ADD A ROW: sn_create_record {table:"sys_decision_question", fields:{decision_table:"<d>", label:"<Row label>", order:"200", condition:"<encoded query over the declared inputs, e.g. priority=1^category=network>", answer:"<sys_id of a record in the answer_table>", active:"true"}}. The answer field is a document_id into sys_decision.answer_table — create/find the answer record FIRST and verify it exists.
- EDIT/REORDER/DEFAULT: sn_update_record on the row (order, condition, answer, default_answer, active). Deactivate rather than delete.
- CREATING the table itself or ADDING INPUT COLUMNS (sys_decision_input var models): do it in Studio (Create → Decision Table; Inputs panel) — var-model authoring over REST is fragile. VERIFY every mutation by re-querying the row.
- Flows consume the table via the "Make a decision"/Decision flow logic (sys_hub_flow_logic.decision_table); scripts via sn_fd.FlowAPI decision-table execution. Row edits take effect without recompiling the flow.

RECIPE — SUBFLOW (outline): Create → Subflow → define Inputs/Outputs FIRST (Studio Inputs&Outputs panel; verify rows in sys_hub_flow_input/sys_hub_flow_output where model=<subflow sys_id>) → build steps as in CREATE step 4 (End with Assign Subflow Outputs) → Publish → call it from a flow via "Add a Subflow" (verify a sys_hub_sub_flow_instance component row on the caller).
RECIPE — ACTION (outline): prefer OOB actions; build a custom action only when no OOB/spoke action fits. Create → Action → inputs → steps (script step is ES5 var-only) → outputs → Test → Publish. Verify: sys_hub_action_type_definition row status/active.
RECIPE — PLAYBOOK (outline): Create → Playbook (needs Process Automation Designer plugins) → trigger (sys_pd_trigger_instance) → lanes/stages → activities picked from activity definitions (each backed by a flow/subflow/action). Everything is UI work; verify structure: sn_query_table sys_pd_process_definition (status, sync_state=COMPLETE) → sys_pd_lane {query:"process_definition=<p>"} → sys_pd_activity. Executions: sys_pd_context.
BLOCKED? If a Studio panel truly cannot be driven after real attempts (stale handles, closed shadow roots, canvas-only interaction), say exactly WHICH step is blocked and hand the user precise manual steps — never claim UI edits you did not verify via the REST reads above.`;

// -----------------------------------------------------------------------------
// WFS_REF — quick reference: trigger types, logic keywords, OOB actions, decision fields.
// -----------------------------------------------------------------------------
export const WFS_REF = `
WORKFLOW STUDIO QUICK-REFERENCE:
- TRIGGER TYPES: Record — Created | Updated | Created or Updated (table + condition; "Run flow on update by workflows" for non-interactive updates). Scheduled — Daily | Weekly | Monthly | Run Once | Repeat (+ Recurrence). Application — Service Catalog (RITM), SLA Task, Inbound Email, MetricBase, Kafka/stream, Performance Analytics, external/REST-started (trigger-less subflow via FlowAPI).
- FLOW LOGIC (sys_hub_flow_logic_definition names): If / Else If / Else / End, For Each, Do the following until, Do the following in Parallel, Parallel Branch, Exit Loop, Skip Iteration, Try / Catch, Wait for a duration of time, Set Flow Variables / Append to Flow Variables, Make a decision, Decision (decision-table), Go back to, Dynamic Flow, Call a Workflow (legacy bridge), Get Flow Outputs / Assign Subflow Outputs.
- COMMON OOB ACTIONS (global): Create Record, Update Record, Delete Record, Look Up Record, Look Up Records, Create Task, Ask For Approval, Wait For Condition, Send Email, Log.
- DECISION TABLE KEY FIELDS: sys_decision — name, label, active, answer_type, answer_table, reference_qualifier. sys_decision_question (one rule row) — decision_table, label, order, condition (encoded query over inputs), answer (document_id → answer_table record), default_answer, active, input_table. sys_decision_input — input var models (model → sys_decision). Multi-column results: sys_decision_multi_result + result_elements.
- VERIFY-QUERY CRIB: flow published? sys_hub_flow.active=true^status=published & latest_snapshot==master_snapshot. Graph shape? sys_hub_flow_component by flow, ORDERBYorder, check sys_class_name + parent_ui_id nesting. Ran? sys_flow_context by ORDERBYDESCsys_created_on. Playbook healthy? sys_pd_process_definition.sync_state=COMPLETE.`;

// Composed pack — what background.js injects.
export const WORKFLOW_STUDIO_PACK = WFS_PACK + "\n" + WFS_NAV + "\n" + WFS_REF;

// Keywords that signal a MODERN Workflow Studio / Flow Designer task (lowercased match).
// Deliberately excludes pure legacy vocabulary (workflow_ide, wf_* tables, "classic
// workflow") — legacy-workflow-pack.js owns those, mirroring its exclusion of these terms.
const WFS_KEYWORDS = [
  "workflow studio", "flow designer", "playbook", "subflow", "sub-flow",
  "decision table", "decision builder", "flow logic", "flow trigger",
  "flow action", "action step", "data stream action", "flow variable",
  "integration hub", "spoke action", "flowapi", "flow execution",
  "process automation designer", "record-triggered flow", "scheduled flow",
  "activate the flow", "publish the flow", "flow snapshot"
];

// Legacy-only phrases that must never drag this pack in.
const WFS_LEGACY_RE = /workflow_ide|classic workflow|legacy workflow|\bwf_[a-z0-9_]+\b/;

export function needsWfsPack(taskText, tabUrl) {
  if (/\/now\/workflow-studio/i.test(String(tabUrl || ""))) return true;
  if (/\$flow-designer|flow_designer\.do/i.test(String(tabUrl || ""))) return true;
  const t = String(taskText || "").toLowerCase();
  if (!t) return false;
  if (WFS_LEGACY_RE.test(t)) {
    // Legacy vocabulary present: only fire if a modern term is ALSO explicitly present
    // (e.g. a migration task mentioning both products).
    return /workflow studio|flow designer|playbook|decision table|sys_hub_|sys_pd_|sys_decision/.test(t);
  }
  if (/\b(sys_hub_|sys_pd_|sys_decision)[a-z0-9_]*\b/.test(t)) return true;   // modern table names
  if (WFS_KEYWORDS.some((k) => t.includes(k))) return true;
  // "flow" alone is too generic; require a build/lifecycle verb + "flow" as a word
  // (\bflow\b cannot match inside "workflow", so legacy phrasing stays excluded).
  // UAT 2026-07-30: "Create a sample flow for when an incident is created…" must fire —
  // the earlier /\ba (record-triggered )?flow\b/ form missed intervening adjectives.
  if (/\b(build|create|make|design|add|update|modify|edit|activate|deactivate|publish|test|debug)\b/.test(t) && /\bflows?\b/.test(t)) return true;
  return false;
}

export function wfsPackSource() {
  return "bundled";
}
