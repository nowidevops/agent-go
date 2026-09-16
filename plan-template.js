// plan-template.js — the MANDATORY structured PLAN contract, shared by all three
// planning surfaces so they enforce ONE discipline (user directive 2026-07-21):
//   • phase-engine.js  (🛡️ CODE-enforced phase engine — PLAN_SYSTEM + EXECUTE)
//   • implementation-phases-pack.js  (🧭 prompt pipeline pack, when the engine is off)
//   • servicenow-pack.js  (ServiceNow build directive)
// Modeled on the production sample C:\redacted\path
// No fast-path / "trivial collapse" for actionable work: every use case and every
// story gets this plan BEFORE the build. Only bare greetings/acks and pure
// conceptual/definitional questions ("what is X") answer directly (a build plan for
// those is noise). Author: iDevOpsLLC

// The contract itself — domain-general, but calls out ServiceNow specifics where the
// sample does (SN_REF citation, record field tables, UAT). Injected verbatim.
export const STRUCTURED_PLAN_CONTRACT = `
MANDATORY STRUCTURED PLAN (every actionable task / story — NO fast-path, NO "trivial" skip).
⛔ PLAN-BEFORE-BUILD GATE (hard, overrides every "do X first" instruction below): you may NOT create, set, save, click-to-build, add a flow action, or otherwise mutate ANY record/artifact until you have POSTED the COMPLETE plan below (all seven sections) + the UAT table as a written reply. Research tools (sn_api_reference, sn_query_*, read_page, query_elements) are used ONLY to FILL the plan's FINDINGS and REFERENCE sections — run them, then WRITE THE PLAN OUT IN FULL, and only THEN build. Beginning the build before the plan is written is a FAILURE of the task. If the user said "give me the recipe/plan, then build," the plan IS that recipe — post it first.
Sections (adapt to the task):
1. REQUIREMENT — QUOTE the user's request verbatim first, then restate exactly what must be TRUE when done (the acceptance criteria). Number them so the UAT can trace to each. ⛔ FIDELITY: every artifact in the plan must trace to a noun in the quoted request — a "flow" task plans a Flow (sys_hub_flow), a "workflow" a Workflow. If your plan names an artifact type or scenario the user never said (e.g. a Business Rule for a flow task), you have copied reference/example vocabulary — discard and re-plan. (2026-07-30: a flow-email task produced an unrelated ITIL Business Rule plan stitched from API-pack snippets.)
2. FINDINGS / PREREQUISITES — what you verified LIVE with tools: which fields / records / state already EXIST vs. must be CREATED. Cite each finding to a tool call that ACTUALLY RAN in this conversation — a finding with no real call behind it is FABRICATION and voids the plan; write "NOT VERIFIED — check in EXECUTE" instead. Do not design against assumptions. (2026-07-30: a plan claimed four live verifications that were never executed.)
3. REFERENCE VERIFICATION — for every API / platform behavior your design relies on, cite the AUTHORITATIVE reference. For ServiceNow: call sn_api_reference and cite its [E#.text…] token. SELECT THE RIGHT REFERENCE BASED ON THE REQUIREMENTS — call {"query":"index"} to see every available reference, then read the file that matches the artifact the requirements call for (flow-designer for a Flow, business-rules for a Business Rule, sp-widget for a widget, …); do not rely on a possibly-mismatched auto-injected pack. Behaviors NOT in the reference (config/runtime semantics) are live-instance validation items — say so explicitly, never assert them from memory.
4. DESIGN — the concrete artifact(s) with EXACT values: record type, field-by-field settings (a table is best), script shape, conditions, triggers. No vagueness — an implementer must be able to build it verbatim.
5. BUILD ORDER — the ordered steps to create it (children before parents), ENDING with "confirm saved — read the records back and verify the field values".
6. UAT / VERIFICATION — a numbered test table ("| # | Steps | Expected result |") that proves EACH numbered requirement, plus explicit pass criteria and a rollback note.
7. ARTIFACTS — what will be saved (names, sys_ids — filled in after the build).
ONLY AFTER the full plan + UAT is posted: EXECUTE it — create/set/save the real artifacts and re-read to confirm; a plan or write-up WITHOUT the persisted build is an INCOMPLETE deliverable. Finally, run your own UAT table against what you built.`;

// A shorter banner used where the full contract is too heavy but the mandate must
// still be visible (e.g. a one-line reinforcement).
export const STRUCTURED_PLAN_ONELINE =
  "PLAN FIRST (mandatory for every story — no fast-path): emit a structured plan (Requirement → Findings verified live → Reference-cited design → Build order → UAT table → Artifacts), THEN build and verify it.";
