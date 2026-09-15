// legacy-workflow-pack.test.mjs — detector, size discipline, and load-bearing
// content of the Classic Workflow pack. Run: node --test legacy-workflow-pack.test.mjs
// (also runs standalone: node legacy-workflow-pack.test.mjs)   Author: iDevOpsLLC
import { test } from "node:test";
import assert from "node:assert/strict";
import { WF_PACK, WF_NAV, WF_ACTIVITY_REF, LEGACY_WORKFLOW_PACK, needsWfPack, wfPackSource } from "./legacy-workflow-pack.js";

// --- detector: positives ---------------------------------------------------
test("needsWfPack: explicit legacy/classic wording", () => {
  assert.ok(needsWfPack("build a legacy workflow for incident escalation", ""));
  assert.ok(needsWfPack("update the Classic Workflow attached to this catalog item", ""));
  assert.ok(needsWfPack("open the workflow editor and add an approval", ""));
  // Live-UAT regression 2026-07-30: plain authoring phrasing fires; Studio "flow" phrasing must not.
  assert.ok(needsWfPack("Create a sample workflow to assign tasks", ""));
  assert.ok(!needsWfPack("Create a sample flow for when an incident is created to send an email", ""));
});

test("needsWfPack: wf_* table names", () => {
  assert.ok(needsWfPack("query wf_workflow_version for the published version", ""));
  assert.ok(needsWfPack("insert a wf_activity row", ""));
  assert.ok(needsWfPack("fix the dangling wf_transition", ""));
  assert.ok(needsWfPack("read the wf_context state", ""));
});

test("needsWfPack: workflow_ide tab URL wins with no keywords", () => {
  assert.ok(needsWfPack("add an If activity after Begin", "https://dev000000.service-now.com/workflow_ide.do?sysparm_nostack=true"));
  assert.ok(needsWfPack("", "https://acme.service-now.com/workflow_ide.do"));
});

test("needsWfPack: lifecycle verbs + workflow", () => {
  assert.ok(needsWfPack("check out the workflow, change the timer, then publish it", ""));
  assert.ok(needsWfPack("publish this workflow after validation", ""));
  assert.ok(needsWfPack("who has the workflow checked out?", ""));
});

test("needsWfPack: graph vocabulary (activity/transition/stage/version)", () => {
  assert.ok(needsWfPack("add a workflow activity between Begin and End", ""));
  assert.ok(needsWfPack("rewire the workflow transition to the End activity", ""));
  assert.ok(needsWfPack("set the workflow stage field", ""));
});

// --- detector: negatives ---------------------------------------------------
test("needsWfPack: modern builders do NOT trigger", () => {
  assert.equal(needsWfPack("build a flow in Workflow Studio that triggers on RITM create", ""), false);
  assert.equal(needsWfPack("create a subflow in Flow Designer", ""), false);
  assert.equal(needsWfPack("publish the flow from workflow studio", ""), false);
});

test("needsWfPack: generic SN / unrelated tasks do NOT trigger", () => {
  assert.equal(needsWfPack("write a business rule on incident", ""), false);
  assert.equal(needsWfPack("summarize this page", "https://example.com"), false);
  assert.equal(needsWfPack("improve the agentic workflow docs", ""), false);
  assert.equal(needsWfPack("", ""), false);
  assert.equal(needsWfPack(null, null), false);
});

test("needsWfPack: a plain ServiceNow tab URL alone does not trigger", () => {
  assert.equal(needsWfPack("look at this record", "https://dev000000.service-now.com/incident.do?sys_id=abc"), false);
});

// --- size discipline (04_pack_architecture: 3-10 KB blocks; SN_NAV ~9 KB max).
// WF_NAV/composed caps raised 2026-07-30 for the live-UAT hardening additions
// (direct-open URL, 403 fallback, activity-dialog recipe, publish traps), and again
// (evening) for DISCOVERY BEFORE DESIGN + REVIEW absence-proof (US-10 review run). ---
test("pack sizes stay within the budgeted ranges", () => {
  assert.ok(WF_PACK.length >= 2500 && WF_PACK.length <= 4600, `WF_PACK ${WF_PACK.length} bytes (want ~3-4 KB)`);
  // 07-31: third raise (US-01 build run: pre-flight, per-table 403, dialog mechanics).
  // OPEN QUESTION for the pack owner: caps have moved 4x — decide whether to convert
  // to a hard composed-token budget (add a lesson = trim a lesson) before the next one.
  // 13500 → 14000 on 2026-09-02: one line routing existing-activity edits/removals to
  // sn_wf_activity_set / sn_wf_delete_activity / sn_wf_fix_script (STRY0000001).
  // 14000 → 18000 on 2026-09-04 (owner: "workflows can be very long and complex"): the
  // publish-that-runs lessons (sn_wf_publish, condition field type, one test per
  // hypothesis, records-left-behind) were added AND the superseded UI-mode canvas /
  // publish-menu prose was compressed, so the raise buys lesson room, not repetition.
  assert.ok(WF_NAV.length >= 5000 && WF_NAV.length <= 18000, `WF_NAV ${WF_NAV.length} bytes (want ~6-18 KB)`);
  assert.ok(WF_ACTIVITY_REF.length >= 1200 && WF_ACTIVITY_REF.length <= 2800, `WF_ACTIVITY_REF ${WF_ACTIVITY_REF.length} bytes (want ~2 KB)`);
  assert.ok(LEGACY_WORKFLOW_PACK.length <= 26000, `composed pack ${LEGACY_WORKFLOW_PACK.length} bytes (cap 26 KB)`);
});

// --- load-bearing content: WF_PACK rules -----------------------------------
test("WF_PACK carries the data model + lifecycle rules", () => {
  for (const table of ["wf_workflow", "wf_workflow_version", "wf_activity", "wf_transition", "wf_condition", "wf_context", "sys_variable_value"]) {
    assert.ok(WF_PACK.includes(table), `WF_PACK missing ${table}`);
  }
  assert.match(WF_PACK, /checked out/i, "checkout rule");
  assert.match(WF_PACK, /ONE published version|one published version/i, "single-published-version rule");
  assert.match(WF_PACK, /never insert into wf_context/i, "runtime tables are engine-owned");
});

test("WF_PACK names the two run-blocking validators + checklist", () => {
  assert.match(WF_PACK, /ValidateDanglingTransition/);
  assert.match(WF_PACK, /ValidateSubflows/);
  assert.match(WF_PACK, /VALIDATION CHECKLIST/);
});

test("WF_PACK carries the top gotchas", () => {
  assert.match(WF_PACK, /update set ONLY at publish/i, "update-set/publish footgun");
  assert.match(WF_PACK, /current\.update\(\)/, "never current.update()");
  assert.match(WF_PACK, /QUIESCES|quiesce/i, "Set Values quiesce");
  assert.match(WF_PACK, /1-second Timer|1s Timer/, "Lock 1s timer");
  assert.match(WF_PACK, /REOPENS the first task/i, "duplicate catalog-task reopen");
});

// --- load-bearing content: WF_NAV recipes ----------------------------------
test("WF_NAV REST mode: ordered insert plan exploiting server BRs", () => {
  assert.match(WF_NAV, /sn_create_record \{table:"wf_workflow_version"/, "POST wf_workflow_version first");
  assert.match(WF_NAV, /workflow field OMITTED/i, "blank workflow ⇒ server auto-scaffold");
  assert.match(WF_NAV, /AUTO-CREATES/i, "documents the Workflow initialize BR magic");
  assert.match(WF_NAV, /NEVER INSERT wf_condition for standard ports/i, "read-back-not-insert conditions rule");
  assert.match(WF_NAV, /wf_activity_variable/, "variable model resolution");
  // 2026-09-04: the publish step is the sn_wf_publish tool (pre-flight + publish + cache
  // flush), never a raw published:"true" PATCH — a PATCH that read back true still ran nothing.
  assert.match(WF_NAV, /8\. PUBLISH = sn_wf_publish \{workflow_version:"<v>"\}/, "publish via sn_wf_publish last");
  assert.doesNotMatch(WF_NAV, /sn_update_record \{table:"wf_workflow_version"[^}]*published:"true"/, "no raw published=true PATCH recipe");
  // Ordering: shell insert (step 1) before activity insert (step 3) before condition read-back (step 4) before transitions (step 6) before publish (step 8).
  const iShell = WF_NAV.indexOf('sn_create_record {table:"wf_workflow_version"');
  const iAct = WF_NAV.indexOf('sn_create_record {table:"wf_activity"');
  const iCond = WF_NAV.indexOf('table:"wf_condition"');
  const iTrans = WF_NAV.indexOf('sn_create_record {table:"wf_transition"');
  const iPub = WF_NAV.indexOf('8. PUBLISH = sn_wf_publish');
  assert.ok(iShell >= 0 && iShell < iAct && iAct < iCond && iCond < iTrans && iTrans < iPub, `insert plan out of order: ${[iShell, iAct, iCond, iTrans, iPub].join(",")}`);
});

test("WF_NAV carries the worked Begin→If→RunScript→End example", () => {
  assert.match(WF_NAV, /WORKED EXAMPLE \(Begin→If→RunScript→End\)/);
});

// Live-UAT hardening 2026-07-30 (dev000000 "Incident Created - Notify Caller" run)
test("WF_NAV UI mode: live-UAT lessons are load-bearing", () => {
  assert.match(WF_NAV, /401\/403/, "session-write 403 triggers UI mode");
  assert.match(WF_NAV, /sysparm_sys_id=<wf_workflow_version sys_id>/, "direct-open canvas by URL");
  assert.match(WF_NAV, /unchanged:true/, "tree double-click no-op symptom");
  assert.match(WF_NAV, /var__m_/, "activity dialog field naming convention");
  assert.match(WF_NAV, /workflow_canvas_validate_button/, "Validate DOM button id");
  assert.match(WF_NAV, /validate_workflow_closemodal/, "validation modal close id");
  assert.match(WF_NAV, /PUBLISH TRAPS/, "publish traps section present");
  assert.match(WF_NAV, /aria_expanded_after/, "non-DOM Workflow Actions menu symptom");
  assert.match(WF_NAV, /desktop_click_hold/, "desktop firm-press recovery");
  assert.match(WF_NAV, /published=true/, "publish read-back before success claim");
  assert.match(WF_NAV, /count 0 = NOT published/i, "explicit not-published verdict");
  assert.match(WF_NAV, /count 0 = NOTHING saved/i, "sys_variable_value read-back gate");
  // US-10 review run (evening 07-30): discovery-first + honest-review rules.
  assert.match(WF_NAV, /DISCOVERY BEFORE DESIGN/, "check OOB fields before inventing counters");
  assert.match(WF_NAV, /reopen_count/, "concrete OOB counter example");
  assert.match(WF_NAV, /NOTHING TO REVIEW/, "absence-proof review verdict");
  assert.match(WF_NAV, /N\/A \(not pass\)/, "N/A vs pass honesty rule");
  // US-01 build run (23:28 07-30): pre-flight, per-table 403, dialog mechanics.
  assert.match(WF_NAV, /sn_check_duplicate/, "duplicate guard before create");
  assert.match(WF_NAV, /403 is PER-TABLE/, "per-table 403 scoping — keep REST elsewhere");
  assert.match(WF_NAV, /sysverb_update/, "dialog Update button id");
  assert.match(WF_NAV, /SELECT fields \(e\.g\. timer_type\) BEFORE/, "selects before dependent inputs");
});

test("WF_NAV UI mode: workflow_ide.do URL + DOM-first, canvas-last discipline", () => {
  assert.match(WF_NAV, /workflow_ide\.do\?sysparm_nostack=true&sysparm_use_polaris=false/);
  assert.match(WF_NAV, /LAST RESORT/i, "canvas drag is last resort");
  assert.match(WF_NAV, /NO in-page click-at-x\/y/i, "no coordinate clicking in-page");
  assert.match(WF_NAV, /Link to\.\.\./, "keyboard transition creation");
  assert.match(WF_NAV, /wf_workflow\.list/, "record-list fallback");
  assert.match(WF_NAV, /Checkout/, "UI checkout step");
  assert.match(WF_NAV, /Validate Workflow/, "UI validate step");
  assert.match(WF_NAV, /VERIFY/i, "verify-after-mutation discipline");
});

// --- load-bearing content: activity quick-reference ------------------------
test("WF_ACTIVITY_REF covers the most-used activities", () => {
  for (const a of ["Approval - User", "Approval - Group", "If", "Switch", "Wait for condition", "Timer", "Create Task", "Catalog Task", "Run Script", "Notification", "Subflow", "Join", "Set Values"]) {
    assert.ok(WF_ACTIVITY_REF.includes(a), `activity ref missing ${a}`);
  }
  assert.match(WF_ACTIVITY_REF, /Incomplete/, "Join Incomplete exit");
  assert.match(WF_ACTIVITY_REF, /begin=true\/end=true|begin=true/, "Begin/End by attributes, not sys_id");
});

// --- export shape mirrors servicenow-pack.js conventions --------------------
test("export shape: composed pack + source telemetry", () => {
  assert.equal(typeof LEGACY_WORKFLOW_PACK, "string");
  assert.ok(LEGACY_WORKFLOW_PACK.includes(WF_PACK) && LEGACY_WORKFLOW_PACK.includes(WF_NAV) && LEGACY_WORKFLOW_PACK.includes(WF_ACTIVITY_REF));
  assert.equal(wfPackSource(), "bundled");
});
