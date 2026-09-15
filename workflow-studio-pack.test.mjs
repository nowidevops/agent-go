// workflow-studio-pack.test.mjs — detector, size discipline, and load-bearing
// content of the Workflow Studio pack. Run: node --test workflow-studio-pack.test.mjs
// (also runs standalone: node workflow-studio-pack.test.mjs)   Author: iDevOpsLLC
import { test } from "node:test";
import assert from "node:assert/strict";
import { WFS_PACK, WFS_NAV, WFS_REF, WORKFLOW_STUDIO_PACK, needsWfsPack, wfsPackSource } from "./workflow-studio-pack.js";
import { needsWfPack } from "./legacy-workflow-pack.js";

// --- detector: positives ---------------------------------------------------
test("needsWfsPack: explicit modern-builder wording", () => {
  assert.ok(needsWfsPack("build a flow in Workflow Studio that triggers on RITM create", ""));
  assert.ok(needsWfsPack("create a subflow in Flow Designer", ""));
  assert.ok(needsWfsPack("add a row to the decision table for approval routing", ""));
  assert.ok(needsWfsPack("build a playbook for customer onboarding", ""));
  assert.ok(needsWfsPack("wire the flow trigger to run daily", ""));
  // Live-UAT regression 2026-07-30: adjective between "a" and "flow" must not defeat the detector.
  assert.ok(needsWfsPack("Create a sample flow for when an incident is created to send any email to the caller_id user to inform the user that we have receive the incident and it will be resolved soon.", ""));
});

test("needsWfsPack: modern table names", () => {
  assert.ok(needsWfsPack("query sys_hub_flow for the published version", ""));
  assert.ok(needsWfsPack("check sys_hub_trigger_instance_v2 for this flow", ""));
  assert.ok(needsWfsPack("inspect sys_pd_process_definition sync_state", ""));
  assert.ok(needsWfsPack("update the sys_decision_question row order", ""));
});

test("needsWfsPack: workflow-studio tab URL wins with no keywords", () => {
  assert.ok(needsWfsPack("add an Update Record action after the trigger", "https://dev000000.service-now.com/now/workflow-studio/home/process"));
  assert.ok(needsWfsPack("", "https://acme.service-now.com/now/workflow-studio/home/process"));
});

test("needsWfsPack: lifecycle verbs + a flow", () => {
  assert.ok(needsWfsPack("activate the flow after testing", ""));
  assert.ok(needsWfsPack("create a record-triggered flow on incident", ""));
  assert.ok(needsWfsPack("build a scheduled flow that closes stale tickets", ""));
});

// --- detector: negatives + cross-pack exclusion ----------------------------
test("needsWfsPack: pure legacy tasks do NOT trigger", () => {
  assert.equal(needsWfsPack("build a legacy workflow for incident escalation", ""), false);
  assert.equal(needsWfsPack("open workflow_ide.do and add an approval", ""), false);
  assert.equal(needsWfsPack("query wf_workflow_version for the published version", ""), false);
  assert.equal(needsWfsPack("check out the classic workflow and publish it", ""), false);
});

test("needsWfsPack: generic SN / unrelated tasks do NOT trigger", () => {
  assert.equal(needsWfsPack("write a business rule on incident", ""), false);
  assert.equal(needsWfsPack("summarize this page", "https://example.com"), false);
  assert.equal(needsWfsPack("improve the agentic workflow docs", ""), false);
  assert.equal(needsWfsPack("publish the workflow after validation", ""), false); // legacy pack's territory
  assert.equal(needsWfsPack("", ""), false);
  assert.equal(needsWfsPack(null, null), false);
});

test("needsWfsPack: a plain ServiceNow tab URL alone does not trigger", () => {
  assert.equal(needsWfsPack("look at this record", "https://dev000000.service-now.com/incident.do?sys_id=abc"), false);
});

test("cross-pack exclusion holds BOTH directions", () => {
  // Modern tasks: WFS fires, legacy does not.
  for (const task of [
    "build a flow in Workflow Studio that triggers on RITM create",
    "create a subflow in Flow Designer",
    "add a decision table row via sys_decision_question",
  ]) {
    assert.ok(needsWfsPack(task, ""), `WFS should fire: ${task}`);
    assert.equal(needsWfPack(task, ""), false, `legacy must NOT fire: ${task}`);
  }
  // Legacy tasks: legacy fires, WFS does not.
  for (const task of [
    "build a legacy workflow for incident escalation",
    "fix the dangling wf_transition",
    "check out the workflow, change the timer, then publish it",
  ]) {
    assert.ok(needsWfPack(task, ""), `legacy should fire: ${task}`);
    assert.equal(needsWfsPack(task, ""), false, `WFS must NOT fire: ${task}`);
  }
  // Migration tasks naming BOTH products may fire both — that is intended.
  const both = "migrate the legacy workflow wf_workflow graph to a Workflow Studio flow";
  assert.ok(needsWfPack(both, ""));
  assert.ok(needsWfsPack(both, ""));
});

// --- size discipline (spec: WFS_PACK ~3-4 KB, WFS_NAV ~6-9 KB, WFS_REF ~2 KB, <18 KB) ---
test("pack sizes stay within the budgeted ranges", () => {
  // 2026-07-30: budget raised 4600→5700 for the TASK FIDELITY + AUTH FALLBACK rules
  // (live failure: template example copied as plan; 401 stall). Total pack stays <18 KB.
  assert.ok(WFS_PACK.length >= 2500 && WFS_PACK.length <= 5700, `WFS_PACK ${WFS_PACK.length} bytes (want ~3-5.5 KB)`);
  // 2026-07-30: budget raised 9800→11000 for live-UAT anatomy (trigger picker, action
  // picker inline buttons, name-field trap, trigger-table completeness). Total <18 KB.
  assert.ok(WFS_NAV.length >= 5000 && WFS_NAV.length <= 11000, `WFS_NAV ${WFS_NAV.length} bytes (want ~6-10.5 KB)`);
  assert.ok(WFS_REF.length >= 1200 && WFS_REF.length <= 2800, `WFS_REF ${WFS_REF.length} bytes (want ~2 KB)`);
  // 2026-07-30 (evening): cap 18000→18200 for the 403 session-write clause in AUTH
  // FALLBACK (legacy-run lesson: sn_create_record via session ⇒ 403 CSRF/ACL).
  assert.ok(WORKFLOW_STUDIO_PACK.length <= 18200, `composed pack ${WORKFLOW_STUDIO_PACK.length} bytes (cap 18.2 KB)`);
});

// --- load-bearing content: WFS_PACK rules ----------------------------------
// 2026-07-30 (evening): pins the AUTH FALLBACK lesson — without these, deleting
// the paragraph would pass all tests (the size cap is an upper bound only).
test("WFS_PACK carries the AUTH FALLBACK escape hatch", () => {
  assert.match(WFS_PACK, /AUTH FALLBACK/);
  assert.match(WFS_PACK, /401/, "no-MCP-credentials case");
  assert.match(WFS_PACK, /403/, "session-write CSRF/ACL case");
  assert.match(WFS_PACK, /sn_query_session/, "named fallback tool");
  assert.match(WFS_PACK, /do not stall/i, "no stalling on auth errors");
});

test("WFS_PACK carries the concept map + data model", () => {
  for (const term of ["FLOW", "SUBFLOW", "ACTION", "TRIGGER", "PLAYBOOK", "DECISION TABLE"]) {
    assert.ok(WFS_PACK.includes(term), `WFS_PACK missing concept ${term}`);
  }
  for (const table of ["sys_hub_flow", "sys_hub_flow_component", "sys_hub_trigger_instance_v2", "sys_hub_flow_logic", "sys_pd_process_definition", "sys_decision_question", "sys_variable_value"]) {
    assert.ok(WFS_PACK.includes(table), `WFS_PACK missing ${table}`);
  }
  assert.match(WFS_PACK, /latest_snapshot \/ master_snapshot|latest_snapshot.*master_snapshot/, "snapshot pointers");
  assert.match(WFS_PACK, /NO transition table/i, "order+nesting graph model");
});

test("WFS_PACK is honest about REST-safe vs UI-only", () => {
  assert.match(WFS_PACK, /REST-SAFE vs UI-ONLY/i);
  assert.match(WFS_PACK, /UI-ONLY[\s\S]*graph edits/i, "graph authoring is UI-only");
  assert.match(WFS_PACK, /NEVER author the graph over raw REST/i);
  assert.match(WFS_PACK, /gzip\+base64/, "v2 trigger blob fact");
  assert.match(WFS_PACK, /ENGINE RUNS THE COMPILED MASTER SNAPSHOT/i, "why raw REST is unsafe");
  assert.match(WFS_PACK, /active=true\/false|active:"false"/, "activation is the safe REST mutation");
  assert.match(WFS_PACK, /decision-table ROW CRUD/i, "decision rows are REST-safe");
  assert.match(WFS_PACK, /NEVER TOUCH[\s\S]*sys_flow_context/i, "runtime tables engine-owned");
  assert.match(WFS_PACK, /FlowAPI[\s\S]*EXECUTION only/i, "FlowAPI is not authoring");
});

test("WFS_PACK carries lifecycle + scope gotchas", () => {
  assert.match(WFS_PACK, /Activate\/Publish|re-activate\/publish/i);
  assert.match(WFS_PACK, /scope/i);
  assert.match(WFS_PACK, /var only, never const\/let/, "ES5 rule");
});

// --- load-bearing content: WFS_NAV recipes ---------------------------------
test("WFS_NAV names the SPA URL + shadow-DOM discipline + list fallback", () => {
  assert.match(WFS_NAV, /\/now\/workflow-studio\/home\/process/);
  assert.match(WFS_NAV, /shadow/i, "shadow DOM instruction");
  assert.match(WFS_NAV, /query_elements/, "query_elements guidance");
  assert.match(WFS_NAV, /sys_hub_flow\.list/, "record-list fallback");
});

test("WFS_NAV create-flow recipe: UI steps with REST verification in order", () => {
  const iCreate = WFS_NAV.indexOf("RECIPE — CREATE A FLOW");
  const iTrigger = WFS_NAV.indexOf("ADD TRIGGER");
  const iActions = WFS_NAV.indexOf("ADD ACTIONS/LOGIC");
  const iActivate = WFS_NAV.indexOf("ACTIVATE:");
  assert.ok(iCreate >= 0 && iCreate < iTrigger && iTrigger < iActions && iActions < iActivate, `create recipe out of order: ${[iCreate, iTrigger, iActions, iActivate].join(",")}`);
  assert.match(WFS_NAV, /sn_query_table \{table:"sys_hub_flow"/, "verify flow row");
  assert.match(WFS_NAV, /sn_query_table \{table:"sys_hub_flow_component"/, "verify components");
  assert.match(WFS_NAV, /latest_snapshot == master_snapshot/, "publish verification");
  assert.match(WFS_NAV, /NEVER fill_input a code editor/i);
});

test("WFS_NAV update recipe + safe REST deactivate", () => {
  assert.match(WFS_NAV, /RECIPE — UPDATE AN EXISTING FLOW/);
  assert.match(WFS_NAV, /sys_updated_on/, "sys_updated_on check");
  assert.match(WFS_NAV, /sn_update_record \{table:"sys_hub_flow", sysId:"<sys_id>", fields:\{active:"false"\}\}/, "REST deactivate");
  assert.match(WFS_NAV, /never claim an edit you did not read back/i, "verify-after-mutation");
});

test("WFS_NAV decision-table recipe is REST-first", () => {
  assert.match(WFS_NAV, /RECIPE — DECISION TABLE/);
  assert.match(WFS_NAV, /sn_create_record \{table:"sys_decision_question"/, "REST row create");
  assert.match(WFS_NAV, /document_id/, "answer is a document_id");
  assert.match(WFS_NAV, /INPUT COLUMNS[\s\S]*Studio/i, "input columns stay in the UI");
});

test("WFS_NAV carries subflow/action/playbook outlines + blocked honesty", () => {
  assert.match(WFS_NAV, /RECIPE — SUBFLOW/);
  assert.match(WFS_NAV, /RECIPE — ACTION/);
  assert.match(WFS_NAV, /RECIPE — PLAYBOOK/);
  assert.match(WFS_NAV, /never claim UI edits you did not verify/i);
});

// --- load-bearing content: quick reference ---------------------------------
test("WFS_REF covers triggers, logic, OOB actions, decision fields", () => {
  for (const t of ["Created or Updated", "Daily", "Service Catalog", "Inbound Email"]) {
    assert.ok(WFS_REF.includes(t), `trigger ref missing ${t}`);
  }
  for (const a of ["Create Record", "Update Record", "Look Up Records", "Ask For Approval", "Send Email", "Log"]) {
    assert.ok(WFS_REF.includes(a), `action ref missing ${a}`);
  }
  for (const l of ["For Each", "Do the following until", "Try / Catch", "Make a decision"]) {
    assert.ok(WFS_REF.includes(l), `logic ref missing ${l}`);
  }
  assert.match(WFS_REF, /answer_table/, "decision key fields");
  assert.match(WFS_REF, /default_answer/, "decision row fields");
});

// --- export shape mirrors legacy-workflow-pack.js conventions ---------------
test("export shape: composed pack + source telemetry", () => {
  assert.equal(typeof WORKFLOW_STUDIO_PACK, "string");
  assert.ok(WORKFLOW_STUDIO_PACK.includes(WFS_PACK) && WORKFLOW_STUDIO_PACK.includes(WFS_NAV) && WORKFLOW_STUDIO_PACK.includes(WFS_REF));
  assert.equal(wfsPackSource(), "bundled");
});
