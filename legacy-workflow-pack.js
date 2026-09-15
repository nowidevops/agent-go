// legacy-workflow-pack.js — Classic Workflow (workflow_ide.do / wf_* tables) build+update pack.
// Injected ONLY for legacy-workflow tasks, as an overlay ON TOP of the ServiceNow pack
// (like scalping is to trading). Distilled from four researched sources (2026-07-30):
//   research/legacy-workflow/01_pdf_digest.md   — Platform PDF ch. "Classic Workflow" (p.4369-4578)
//   research/legacy-workflow/02_web_docs.md     — Zurich official docs sweep (139 topics)
//   research/legacy-workflow/03_instance_discovery.md — dev000000 dictionary + business-rule dump
//   research/legacy-workflow/04_pack_architecture.md  — wiring recipe
// Live-UAT hardening 2026-07-30 (dev000000, "Incident Created - Notify Caller" run):
//   direct-open via &sysparm_sys_id; session REST 403 ⇒ UI dialog; activity-properties
//   dialog recipe (var__m_* fields, Advanced checkbox, Monaco); Validate DOM ids;
//   publish traps (readonly Published checkbox, non-DOM Workflow Actions menu) +
//   desktop_click_hold recovery + published=true read-back before any success claim.
// Author: iDevOpsLLC

// -----------------------------------------------------------------------------
// WF_PACK — non-negotiable rules (data model, lifecycle, validators, gotchas).
// -----------------------------------------------------------------------------
export const WF_PACK = `
LEGACY (CLASSIC) WORKFLOW PACK — non-negotiable rules for creating/updating legacy workflows (wf_* tables / workflow_ide.do). Maintenance-mode (Workflow Studio replaced it) but create/edit works on every instance.

DATA MODEL (design-time = what you author; runtime = engine-owned, NEVER insert):
- DESIGN-TIME: wf_workflow (identity: name, table) → wf_workflow_version (one graph snapshot; start→Begin activity, published, checked_out, checked_out_by, condition, stage_field) → wf_activity (canvas node; workflow_version, name, activity_definition = a wf_activity_definition sys_id, x, y) → wf_condition (an activity's EXIT PORT — transitions attach to conditions, never directly to activities) → wf_transition (from, to, condition). Activity input values = sys_variable_value rows (document='wf_activity', document_key=<activity sys_id>, variable=<wf_activity_variable sys_id>, value=<text>). Palette = wf_activity_definition (+ wf_activity_variable input models, wf_condition_default port templates). Stages = wf_stage per version. Workflow input variables = var_dictionary.
- RUNTIME (read-only for you): wf_context (one per run: state, stage, scratchpad), wf_executing (live activities), wf_history / wf_transition_history / wf_log. Never insert into wf_context/wf_executing — start runs via the engine (record insert matching the version's condition, or new Workflow().startFlow(...)).

CHECKOUT / PUBLISH LIFECYCLE (version-level — wf_workflow itself carries NO checkout fields):
- A workflow MUST be checked out before ANY edit. ONE user holds the checkout; checkout clones the published version into a personal wf_workflow_version (published=false, checked_out_by=me). Everyone else keeps running the published version.
- At most ONE published version ever exists: setting published=true fires the "Unpublish other workflow versions" BR which unpublishes every sibling — you NEVER unpublish manually. Publish also flushes the cluster cache ("Unload Workflow Version" BR), so a REST publish goes live without the editor.
- Runtime selection: checkout holder runs their checked-out version; everyone else the published one; NO published version ⇒ it does not run at all (a subflow in that state hangs its parent). Publish never touches RUNNING contexts.

RUN-BLOCKING VALIDATORS (CRITICAL blocks publish AND run; validate before every publish):
1. ValidateDanglingTransition — a wf_transition with an empty "to" is INVISIBLE on the canvas but present in the DB and silently hangs the workflow. Fix: delete the transition row with empty To.
2. ValidateSubflows — a subflow that is inactive, deleted, or has no published version hangs the parent at that activity.
VALIDATION CHECKLIST before publish: (a) no wf_transition with empty to; (b) every activity except Begin reachable; (c) every exit condition you rely on has a transition; (d) subflows Active + published; (e) no current.update() in scripts; (f) parallel branches converge through a Join (Incomplete exit wired); (g) staged workflows: End carries stage Complete/Completed.

TOP GOTCHAS:
- UPDATE-SET/PUBLISH FOOTGUN: a workflow enters the update set ONLY at publish (one wf_workflow-typed record) — but INPUT VARIABLES (var_dictionary) write update-set entries IMMEDIATELY on create/delete; a variable deletion can ship without the workflow and break production. Keep variable edits + publish in ONE set; committing an older set later silently regresses the published version (last commit wins).
- NEVER current.update() in ANY workflow script — the engine persists current at transaction end; calling it can loop infinitely.
- Set Values applies when the workflow QUIESCES or ends, NOT immediately; last writer wins; it does NOT cancel pending approvals (use Approval Action).
- Lock needs a 1-second Timer BEFORE it, and NO waiting activities (approvals/tasks/timers/wait-for-*) between Lock and Unlock.
- Re-running the SAME Create Task / Catalog Task activity on a record (e.g. same subflow twice) REOPENS the first task instead of creating a second — use different subflows or a Run Script insert.
- First End reached CANCELS all other executing branches — converge with Join first.
- Wait for condition only sees EXTERNAL record updates; if the workflow itself sets the watched value, insert a 1s Timer after.
- All workflow scripts are server ES5 Rhino: var only, never const/let.
- Max activity count defaults to 100 (blank ⇒ -1 ⇒ context cancelled) — Turnstile for intentional loops.
- Approval activities are greyed out when approval ENGINES are on for the table — activities OR engines, never both.`;

// -----------------------------------------------------------------------------
// WF_NAV — operational recipes with exact tool ordering (REST mode + UI mode).
// -----------------------------------------------------------------------------
export const WF_NAV = `
LEGACY WORKFLOW — HOW TO BUILD/UPDATE (exact tool order; two modes):

NEVER START IN THE EDITOR: the Workflow Editor's New Workflow dialog, Workflow Actions menu and the canvas are GWT/canvas-rendered — query_elements sees nothing and screenshots show no dialog (2026-09-03 run: seven wasted clicks/screenshots). Create and wire the workflow over REST (MODE A below); use the editor ONLY to click Validate, to let the user watch, and to read the validation report. INPUT WRITES: the first 403 with an ACL reason on sys_variable_value means the activity form is read-only too — go straight to sn_wf_fix_script with ALL inputs of the version in one script (every PDI since 2026-09-02 refuses that table over the API; the tool remembers and stops re-trying rows). PUBLISH: sn_wf_publish only (step 8).
MODE A — REST (PREFERRED whenever sn_* tools work): everything is plain Table API rows; NO special workflow endpoints exist. The server business rules do half the build FOR you. ORDERED INSERT PLAN for a NEW workflow (verified against the live BR scripts; full plan executed live via session auth 2026-07-30):
0. PRE-FLIGHT: sn_check_duplicate {table:"wf_workflow", name:"<Name>"} — never build a second copy. Resolve EVERY referenced group/user/field first (sn_query_session sys_user_group / sys_dictionary / sys_choice); a referenced group that doesn't exist gets CREATED (sn_create_record sys_user_group), never hardcoded or assumed.
1. CREATE THE SHELL: sn_create_record {table:"wf_workflow_version", fields:{name:"<Name>", table:"<target table e.g. incident>", description:"...", published:"false", condition_type:"run_match", condition:"<ENCODED QUERY or empty>"}} — with the workflow field OMITTED/blank. condition_type MUST be set (empty ⇒ the engine skips the version). condition is a CONDITIONS field = encoded query (sys_mod_count=0 ≈ insert-only), NEVER JavaScript — current.operation() == 'insert' there never matches (refused by the tool). Reliable insert-only gate on ANY table: empty condition + first node an If "Is New Record?" with Advanced script answer = (current.operation() == 'insert') ? 'yes' : 'no'; No → End (live 2026-09-04 on incident; same on every task/custom table). The "Workflow initialize" before-insert BR then AUTO-CREATES: the wf_workflow parent, the Begin activity (x=20,y=20), the End activity (x=400,y=150), Begin's "Always" wf_condition, the Begin→End wf_transition, and sets the version's start pointer. Capture the returned version sys_id. (If you pre-create wf_workflow and set the workflow field, NONE of this fires and you must scaffold Begin/End/start yourself — don't.)
2. READ BACK Begin/End: sn_query_table {table:"wf_activity", query:"workflow_version=<v>", fields:"sys_id,name,activity_definition,x,y"} — distinguish Begin/End by name.
3. INSERT EACH REAL NODE: sn_create_record {table:"wf_activity", fields:{workflow_version:"<v>", name:"Check priority", activity_definition:"<wf_activity_definition sys_id>", x:"160", y:"100"}}. Do NOT set width/height or insert conditions — BRs default sizes and auto-copy the definition's exit ports. activity_definition is declared as ref→wf_element_definition but you pass the wf_activity_definition sys_id (same sys_id space). Find definitions: sn_query_table {table:"wf_activity_definition", query:"nameLIKEIf", fields:"sys_id,name,table"}.
4. READ BACK THE AUTO-GENERATED PORTS — NEVER INSERT wf_condition for standard ports: the "Create default conditions" after-insert BR copies the definition's wf_condition_default rows (If ⇒ Yes+No; Approval ⇒ Approved+Rejected; no defaults ⇒ a single Always/true/order-0). sn_query_table {table:"wf_condition", query:"activity=<new activity sys_id>", fields:"sys_id,name,condition,order"}. Only insert a wf_condition yourself for a genuinely CUSTOM exit (e.g. name Error, condition activity.state=='faulted').
5. SET ACTIVITY INPUTS = sn_wf_fix_script {workflow_version:"<v>", set:[{activity:"<name>", inputs:{<element>:"<value>"}}, …]} with EVERY activity's inputs in ONE script, then run it (elements from sn_query_table {table:"wf_activity_variable", query:"model=<definition sys_id>", fields:"element,order"} — Run Script = script; Timer = timer_type + duration; Notification = subject/message/…). A direct sn_create_record on sys_variable_value is ACL-refused on every PDI tested (09-02 → 09-04); try it at most once. For Switch, set its vars BEFORE relying on its case conditions (a BR builds them).
6. REWIRE TRANSITIONS: delete the auto Begin→End wf_transition (find it: sn_query_table {table:"wf_transition", query:"from=<Begin sys_id>"}; no delete tool exists — repoint it instead with sn_update_record {table:"wf_transition", sysId:"<t>", fields:{to:"<first real activity>"}}). Then for each remaining edge sn_create_record {table:"wf_transition", fields:{condition:"<wf_condition sys_id>", to:"<target activity sys_id>", from:"<source activity sys_id>"}} — from is server-derived from condition.activity, but supply it anyway. EVERY condition you rely on gets a transition; NO transition may have an empty to.
   WORKED EXAMPLE (Begin→If→RunScript→End): version v auto-has Begin(Always)→End. Insert If (step 3) → read its Yes/No conditions (step 4). Insert Run Script → read its Always condition; set its script var (step 5). Repoint Begin's Always transition to=<If>. Create: {condition:<If.Yes>, to:<RunScript>}, {condition:<If.No>, to:<End>}, {condition:<RunScript.Always>, to:<End>}.
7. OPTIONAL STAGES: sn_create_record {table:"wf_stage", fields:{workflow_version:"<v>", name:"Fulfillment", value:"fulfillment", order:"200"}}; set stage_field on the version. Stage defaults largely self-populate (Stage Init BR).
8. PUBLISH = sn_wf_publish {workflow_version:"<v>"} — the ONLY route: graph pre-flight (empty-to / unreachable / dead-end = blockers), condition sanity, condition_type default, PATCH published + read-back, then the CACHE FLUSH (cache.do in your signed-in tab; refused/ignored publish ⇒ publish Fix Script with GlideCacheManager.flushTable). WHY (dev000000 2026-09-04): a raw published=true PATCH read back true and the engine started NOTHING for six test records — it reads versions through a cache the Table API never invalidates; cache.do was the one change before the next incident ran. Never PATCH published=true yourself, never hunt the editor's Publish menu; after ANY edit to a published version call sn_wf_publish again. No server-side graph validator exists — the pre-flight is the gate.
9. ATTACH if catalog: sn_update_record {table:"sc_cat_item", sysId:"<item>", fields:{workflow:"<wf_workflow sys_id>"}}.
10. LIVE TEST — ONE RECORD PER HYPOTHESIS: after sn_wf_publish create ONE test record; read back wf_context {query:"id=<sys_id>"}, wf_history, wf_executing, sys_email {query:"instance=<sys_id>"}. count 0 after a flushed publish = the version's table/condition/condition_type does not match (or another version is published) — read the version back and fix THAT; a second identical test proves nothing (the guard refuses a third). Insert-only proof = ONE update to an existing record → no new context (or If→No→End). A Timer/Wait is proven by its wf_executing row (state executing) — never by sys_trigger. If the Timer outlives the run, OFFER a one-shot scheduled shortcut for <due + 2 min> that runs the verification query on the TARGET table (e.g. <table> where parent=<sys_id>, or whatever the timed activity writes) — state the query in the answer either way.
11. WHAT YOU LEFT BEHIND: END the answer with a "Records created on the instance" section (table, number/name, sys_id; test records + helper Fix Scripts marked) and ONE question — "Close the test records and delete the helper Fix Scripts <names/sys_ids> now?". Never close/delete them yourself.
12. ANSWER COMPLETENESS: if the request enumerated sections (A., B., …) or asked for a checklist, check every one is present before you finish. A long build guide goes in TWO messages if needed (evidence table first, then the guide); an answer cut off by the output limit is a failed task, not a finished one.
UPDATE AN EXISTING WORKFLOW over REST: find it (sn_query_table wf_workflow by name → wf_workflow_version {query:"workflow=<w>^ORDERBYDESCsys_updated_on", fields:"sys_id,published,checked_out_by,active"}). CHECKOUT DISCIPLINE: graph edits (steps 3-6 style) go on an unpublished version; input/script tweaks via sn_wf_activity_set / sn_wf_fix_script; finish with sn_wf_publish (its pre-flight is the checklist; it flushes the cache the edit left stale). VERIFY AFTER EVERY MUTATION by reading the row back — never claim a write you did not read back.

MODE B — UI (when REST writes are refused 401/403 — don't retry the write; 403 is PER-TABLE (live 07-30): wf_workflow_version/wf_activity/wf_transition inserts can succeed while sys_variable_value 403s — keep building over REST, use the UI/Fix Script ONLY for the failing table): navigate to <origin>/workflow_ide.do?sysparm_nostack=true&sysparm_use_polaris=false (the CURRENT tab's origin, never a placeholder host), then read_page to confirm the welcome screen (Published / Checked Out tabs, New Workflow).
- OPEN DIRECTLY BY URL (live 2026-07-30): append &sysparm_sys_id=<wf_workflow_version sys_id> to the editor URL — the canvas opens on that version. Double-clicking the TREE node can silently no-op (read_page {unchanged:true}); resolve the version sys_id via sn_query_session and use the URL route.
- NEW WORKFLOW: click "New Workflow" (query_elements by text → click_element), fill Name + Table in the popup form (fill_input / select_option), Submit → workflow opens checked-out with Begin→End already connected.
- OPEN + CHECKOUT: hamburger/gear menu (title bar) → "Open Existing" / "Checkout" (menu options are real DOM — query_elements {text:"Checkout"}). Published workflows show read-only properties until checked out; the title bar shows "Checked out by <name>" vs "Published".
- ADD ACTIVITIES: palette drag-to-canvas is CANVAS WORK (there is NO in-page click-at-x/y tool; drag_drop needs DOM handles at both ends — try ONCE, a drop onto a transition line auto-splices) — LAST RESORT; add nodes over REST (step 3) instead. DOM-reachable surfaces: the properties dialog on drop, double-click an existing activity (click_element {double:true}), right-click menus (Add Condition / Reorder Conditions / Copy Activity); keyboard: Tab/arrows between nodes, Enter = edit, inside a node Tab cycles Properties/Title/menu/Delete/ports — port option "Link to..." creates a transition without dragging.
- EXISTING ACTIVITIES: sn_wf_activity_set {activity_sys_id, inputs} edits inputs (API → own form → verified); sn_wf_delete_activity {activity_sys_id, rewire_to} removes a node; when every write is refused (403 both auth paths / read-only fields) sn_wf_fix_script creates a Fix Script (server-side GlideRecord, no ACLs) — one "Run Fix Script" click, then verify. Catalog Task inputs: advanced_script, task_short_description, task_set_values (the Values field).
- ACTIVITY PROPERTIES dialogs are gsft forms (live 07-30): canvas nodes ARE DOM — query_elements {selector:"div[id], span[id]", text:"<activity name>"} → click_element {double:true}. Inputs are wf_activity.vars.var__m_<activity_definition sys_id>.<element>; the Advanced checkbox (ni. prefix, element advanced) reveals the script editor (list_editors + set_editor_value — NEVER fill_input a code editor); Submit = the Update button id sysverb_update (text "Submit" finds NOTHING). ⚠ set SELECT fields (e.g. timer_type) BEFORE dependent inputs — a select re-renders the dialog and drops typed values; re-query handles after every select. VERIFY: sn_query_session {table:"sys_variable_value", query:"document=wf_activity^document_key=<activity sys_id>"} — count 0 = NOTHING saved; redo, don't proceed.
- VALIDATE VIA DOM (live): button id workflow_canvas_validate_button; report modal id validate_workflow (close: validate_workflow_closemodal). Require Critical:0 before publish.
- PUBLISH TRAPS (live 07-30 / 09-04): the version FORM's Published checkbox is readonly (sn_set_field silently no-ops); Workflow Actions EXPANDS (aria_expanded_after:"true") but its items are canvas-rendered, not DOM — never loop clicks; an API publish that reads back true still runs nothing until the cache is flushed. ROUTE: sn_wf_publish {workflow_version}; desktop_click_hold on the menu only when it cannot create its Fix Script either. NEVER report a publish without reading back wf_workflow_version {query:"workflow=<w>^published=true"} — count 0 = NOT published; say so and correct any earlier claim.
- RECORD-LIST FALLBACK (canvas unreachable): the graph is rows — <origin>/wf_workflow.list (Versions related list), <origin>/wf_workflow_version.do?sys_id=<v> (Workflow Activities related list; each activity form's Workflow Transitions tab is THE place to delete a dangling empty-To transition), <origin>/wf_activity.list, wf_transition.list, wf_condition.list; sn_query_session for reads when REST 401s; save_record to persist.
- MENU OPERATIONS: Edit Inputs (workflow input variables), Edit Stages, Properties, Validate Workflow, Show Contexts, Publish, Set Inactive, Delete (blocked while contexts exist).
- UPDATE RECIPE (UI): (1) open the version via &sysparm_sys_id → menu Checkout; (2) double-click the activity → edit in its dialog → Submit; transitions via keyboard "Link to..." or select+Delete on the arrow; (3) Validate (DOM button), fix every CRITICAL; (4) sn_wf_publish {workflow_version}; (5) VERIFY wf_workflow_version {query:"workflow.name=<name>^published=true"} is yours. A click that "succeeded" is not evidence — read the graph back.
- If the canvas step genuinely cannot be done with dialogs/keyboard/record-lists after a real attempt, report THAT step as blocked (desktop_* coordinate tools only if the user has desktop control enabled) — never claim graph edits you did not verify.

DISCOVERY BEFORE DESIGN (live 2026-07-30): before adding a counter/flag field or a Set Values increment, query sys_dictionary for an existing OOB field — e.g. incident.reopen_count already exists, incremented by the OOB before-update BR "Reopen Count" (current.reopen_count += 1, gated on Incident().hasReopened() — platform-owned, never reimplement). READ the OOB field; your own counter double-counts.
REVIEW TASKS: when asked to REVIEW a workflow, first PROVE it exists — sn_query_session wf_workflow by name AND an empty-query count of the table. Absent ⇒ report FAIL — NOTHING TO REVIEW citing those queries, mark best-practice checks N/A (not pass), and never emit an invented review or "remediated" artifact.
TESTING/RUNS: the editor's Start button works only for Global-table workflows — otherwise INSERT a matching record into the target table. Check execution: wf_context (state/stage), wf_history, wf_log. Cancel: context Related Link, or new Workflow().cancel(context).`;

// -----------------------------------------------------------------------------
// Activity quick-reference — the most-used activities (inputs + exit conditions).
// -----------------------------------------------------------------------------
export const WF_ACTIVITY_REF = `
LEGACY WORKFLOW ACTIVITY QUICK-REFERENCE (key inputs → exit conditions):
- Approval - User (global): Users/Groups (EMPTY ⇒ auto-Approved), Wait for = Anyone/Everyone/First response/script (answer='approved'|'rejected', counts.*), When anyone rejects, due-date/schedule block → Approved | Rejected (+Error/Skipped). Harden Approved with && activity.state != 'faulted'.
- Approval - Group (task tables): Groups (empty ⇒ auto-Approved), Wait for per-group variants/script (groups[group_id].*) → Approved | Rejected.
- If (global): Condition builder + optional Advanced script (answer = 'yes'; BOTH must pass) → Yes | No.
- Switch (global): Type = Variable|Field + per-case exit conditions (cases auto-built from config) → one condition per case + Else.
- Wait for condition (global): Condition and/or script (answer = true); re-evaluated on EXTERNAL record updates only; optional Timeout duration → Always (+Timeout skip).
- Timer (global, runs as System): user/relative duration, field, or script (answer = seconds); schedule + timezone → Complete | Cancelled.
- Create Task (task tables): Task type (any task-extending table), priority, Wait for completion, values via Fields/Template/Values, Advanced script (use the task variable) → Closed Complete | Closed Incomplete | Closed Skipped | Deleted | Cancelled. Duplicate-reopen gotcha applies.
- Catalog Task (sc_req_item only): same shape + catalog-variable slushbucket → same exits.
- Run Script (global): one input, script (ES5 var-only; set activity.result to drive custom exits; changes to current auto-persist — never current.update()) → Always (add Error: activity.state=='faulted').
- Notification (global): To users/groups or Advanced To-script (answer = comma-sep sys_ids), Subject, Message (\${field} substitution) → Always.
- Subflow (drag a workflow from the Workflows palette tab): inputs per the subflow's Edit Inputs (literals or \${workflow.scratchpad.x}); subflow must be Active + published or the parent HANGS; Return Value activity on every subflow end path maps back to parent scratchpad → subflow's exits.
- Join (global): converge parallel branches → Complete (all predecessors arrived) | Incomplete (a predecessor bypassed it — ALWAYS wire Incomplete).
- Set Values (global): field=value pairs applied at QUIESCE/end (not immediately; last writer wins) → Always.
- Branch: one Always condition, multiple concurrent transitions. Lock/Unlock: mutex by Key (1s Timer before Lock) → Success | Failure. Turnstile: Allowed iterations → Continue | Cancel. Create Event: registered platform event, quoted string params. Rollback To: jumps back along transition wiring, resets intervening approvals/tasks.
Begin/End are located by attributes begin=true/end=true on the definition — never hardcode their sys_ids.`;

// Composed pack — what background.js injects.
export const LEGACY_WORKFLOW_PACK = WF_PACK + "\n" + WF_NAV + "\n" + WF_ACTIVITY_REF;

// Keywords that signal a LEGACY workflow task (checked lowercase against the task).
// Deliberately narrow: bare "workflow" / "workflow studio" / "flow designer" must
// NOT trigger this pack (those are the modern builder — SN pack handles them).
const WF_KEYWORDS = [
  "legacy workflow", "classic workflow", "workflow_ide", "workflow editor",
  "workflow canvas", "workflow activity", "workflow activities", "workflow transition",
  "workflow stage", "workflow version", "workflow context", "workflow condition",
  "workflow scratchpad", "checkout the workflow", "check out the workflow",
  "publish the workflow", "workflow checkout", "workflow publish"
];

// Modern-builder phrases that must not be dragged in by the publish/checkout heuristic.
const WF_MODERN_RE = /workflow studio|flow designer|sys_hub_/;

export function needsWfPack(taskText, tabUrl) {
  if (/workflow_ide\.do/i.test(String(tabUrl || ""))) return true;
  const t = String(taskText || "").toLowerCase();
  if (!t) return false;
  if (/\bwf_[a-z0-9_]+\b/.test(t)) return true;                    // any wf_* table name
  if (WF_KEYWORDS.some((k) => t.includes(k))) return true;
  // publish/checkout verbs + "workflow" (not the modern builders) = lifecycle task
  if (/\b(publish|unpublish|check(ed)? ?out)\b/.test(t) && /\bworkflow\b/.test(t) && !WF_MODERN_RE.test(t)) return true;
  // UAT 2026-07-30: plain authoring phrasing ("create a workflow that…") must also fire.
  // \bworkflows?\b never matches "flow" alone, so Studio tasks stay excluded; WF_MODERN_RE
  // still vetoes when modern builders are named explicitly.
  if (/\b(build|create|make|design|add|update|modify|edit)\b/.test(t) && /\bworkflows?\b/.test(t) && !WF_MODERN_RE.test(t)) return true;
  return false;
}

export function wfPackSource() {
  return "bundled";
}
