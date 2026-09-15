// click-by-click.js — the "## Click-by-Click Build Guide" deliverable standard,
// ported VERBATIM-in-spirit from AgenticWorkflow/workflow/click-by-click-pack.md
// so the extension's phase-engine produces the SAME complete deliverables AWF
// does. A deliverable that BUILDS / CHANGES / DEPLOYS / CONFIGURES anything must
// END with an admin-executable, click-along build guide; purely informational
// deliverables (a code review with no change to apply, an explanation, a
// comparison) omit it. Injected into the EXECUTE drafter + SYNTHESIZE prompts
// and ENFORCED by the REVIEW gate (missing/vague guide → REVISED, the reviewer
// writes it from the deliverable's own content). Author: iDevOpsLLC

// The full structural spec — injected into the drafter/synthesizer so the guide
// is authored with the concrete values (names, tables, fields, nav paths) the
// steps need.
export const CLICK_BY_CLICK_SPEC = `CLICK-BY-CLICK BUILD GUIDE — REQUIRED FINAL SECTION (for any deliverable that BUILDS, CHANGES, DEPLOYS, or CONFIGURES anything: ServiceNow artifacts, code an admin must install, integrations, settings, dashboards, scheduled jobs, flows). The deliverable MUST END with a section titled exactly:

## Click-by-Click Build Guide

Audience: a mid-level admin who has never seen this task and will build/apply everything BY HAND, clicking along. Executable start-to-finish with no outside knowledge. Required structure, in order:
1. Header block — one line each: what is being built/changed and why; target instance/system; the application SCOPE to select before starting; hard constraints (e.g. "never modify OOB component X", "stay in scope Y"); any pre-build blocking gates to verify first.
2. Architecture & key values table — every table, property, endpoint, scope, sys_id, and value the steps reference later, collected in ONE table up front (| Item | Value |).
3. One numbered section per artifact, in dependency order (parents before children). Each gives: the exact UI navigation path (e.g. \`All → System Definition → Business Rules → New\`); field-by-field fill-in as \`**Field:** value\` including checkboxes (✔ / ✗) and picker choices; where code goes (paste the complete code inline, or point to the exact section of THIS deliverable that holds it — never "add appropriate code"); the save action (**Submit** / **Save** / **Update** / **Activate**) as its own explicit step.
4. Wiring/configuration steps (events, data bindings, placements, mappings) as their own numbered steps with exact source → target names — never "wire it up as usual".
5. Security step — ACLs, roles, or permissions the build requires, called out explicitly (never leave an endpoint or record open by omission). If a role is referenced, tell the reader to verify it exists on the target instance first.
6. Test / verify table — \`| # | Test | Steps | Expected |\` covering each artifact plus the end-to-end flow (include a negative/security test where applicable).
7. Artifacts summary table — \`| # | Type | Name | Table/Location |\` of everything created/changed.
8. Rollback — how to disable or remove everything safely (kill-switch/deactivate/delete order — children before parents).
9. Caveats / gotchas — version/instance differences, sealed OOB components, naming/length limits, error-prone steps (mark ⚠ inline).

Style: imperative numbered steps ("Click **New**", "Set **Name:** \`...\`"); bold UI labels; backticked values; ⚠ on error-prone steps; no step may depend on knowledge not in an earlier step or the key-values table.

EXEMPTION: purely informational deliverables (a code REVIEW that only recommends — the admin applies nothing new — an explanation, a comparison, a research memo) omit the section entirely. Do NOT fabricate a guide for a deliverable that builds nothing.`;

// Short requirement line for the drafter's system prompt (points at the fuller
// spec, which the EXECUTE agent already carries via the SN pack when relevant).
export const CLICK_BY_CLICK_DRAFTER = `\n\nCOMPLETE DELIVERABLE (AWF parity): if this deliverable recommends or requires APPLYING any concrete change — deploy/replace a script, reconfigure a record, change an Order, deactivate/activate rules, add/remove an artifact, adjust settings — it MUST END with a "## Click-by-Click Build Guide": numbered, admin-executable UI steps built from the CONCRETE values you observed (exact navigation paths, field-by-field values incl. checkboxes, save/activate clicks, a security/ACL step, a test/verify table, an artifacts summary table, and rollback). A CODE REVIEW that recommends applying a corrected artifact or configuration changes IS such a deliverable — include the guide (as a real ServiceNow code review does). ONLY a purely informational answer with NOTHING to apply (an explanation, a comparison, a "no changes needed / all clean" review) omits the guide — never fabricate one for a document that changes nothing.`;

// Gate enforcement line appended to REVIEW_SYSTEM.
export const CLICK_BY_CLICK_REVIEW = `\n\nCOMPLETE-DELIVERABLE CHECK: if the deliverable recommends or requires APPLYING any concrete change (deploy/replace a script, reconfigure a record, change an Order, deactivate/activate rules, add/remove an artifact, adjust settings), it MUST END with a "## Click-by-Click Build Guide" a mid-level admin could follow BY HAND (exact navigation paths, field-by-field values, save/activate clicks, a security/ACL step, a test/verify table, an artifacts summary, rollback). A CODE REVIEW that recommends a corrected artifact or configuration changes COUNTS — it needs the guide. A missing guide, or one too vague to execute, on such a deliverable IS a defect: issue VERDICT: REVISED and WRITE the guide yourself from the deliverable's content; a REVISED deliverable must carry it forward intact. ONLY a purely informational deliverable with nothing to apply (an explanation, a comparison, a "no changes needed" review) is EXEMPT — do not demand or fabricate a guide for one.`;
