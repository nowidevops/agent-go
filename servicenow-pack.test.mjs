// servicenow-pack.test.mjs — isServiceNowInstanceHost + navigate host-correction
// logic (2026-07-20f, live PE5 a-live-run: a stray www.servicenow.com tab
// hijacked a real dev000000.service-now.com navigation to the marketing site).
// Run: node servicenow-pack.test.mjs   Author: iDevOpsLLC
import { isServiceNowInstanceHost, isServiceNowUrl, resolvePackFile, lookupSnApiReference, detectSnPhase, buildServiceNowPack, detectSnArtifactType, wrapSnClassicTarget } from "./servicenow-pack.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

console.log("— isServiceNowInstanceHost (instance vs corporate property) —");
const instances = ["dev000000.service-now.com", "acme.service-now.com", "hi.service-now.com", "empxyz123.service-now.com"];
const notInstances = ["www.servicenow.com", "servicenow.com", "docs.servicenow.com", "community.servicenow.com", "store.servicenow.com", "developer.servicenow.com", "nowlearning.servicenow.com", "github.com"];
t("real instances (hyphenated service-now.com) → true", instances.every(isServiceNowInstanceHost), instances.filter((h) => !isServiceNowInstanceHost(h)).join("|"));
t("corporate/docs/marketing (servicenow.com) → false", notInstances.every((h) => !isServiceNowInstanceHost(h)), notInstances.filter(isServiceNowInstanceHost).join("|"));
// isServiceNowUrl is intentionally broad — it DOES match the marketing site (that
// breadth is exactly why the old host-correction guard misfired).
t("isServiceNowUrl matches www.servicenow.com (why the old guard broke)", isServiceNowUrl("https://www.servicenow.com/docs"));

console.log("— host-correction decision (both must be genuine instances) —");
// Mirrors the navigate guard: correct iff cur & req are both instances and differ.
const shouldCorrect = (cur, req) => cur !== req && isServiceNowInstanceHost(cur) && isServiceNowInstanceHost(req);
t("PE5 bug FIXED: www.servicenow.com tab does NOT hijack a real instance nav",
  shouldCorrect("www.servicenow.com", "dev000000.service-now.com") === false);
t("original purpose kept: hallucinated instance host IS corrected on a real instance",
  shouldCorrect("dev000000.service-now.com", "dev99999.service-now.com") === true);
t("intentional instance→docs nav is NOT corrected",
  shouldCorrect("dev000000.service-now.com", "docs.servicenow.com") === false);
t("same instance host → no correction",
  shouldCorrect("dev000000.service-now.com", "dev000000.service-now.com") === false);

// ---------------------------------------------------------------------------
// sn_api_reference — <local path> on-demand lookup (2026-07-20). resolvePackFile is
// PURE (no network); lookupSnApiReference with no phaseFilesUrl exercises the
// server-down paths (index from the built-in map; fallback to bundled rules).
// ---------------------------------------------------------------------------
console.log("— sn_api_reference: resolvePackFile (pure resolver) —");
t("artifact hint wins", resolvePackFile("anything", "business_rule", null).file === "business-rules.md");
t("method name → core-glide", resolvePackFile("how does GlideAggregate count?", "", null).file === "core-glide.md");
t("g_form method → client-scripts", resolvePackFile("g_form.getReference callback", "", null).file === "client-scripts.md");
t("RESTMessageV2 → scripted-rest", resolvePackFile("build a RESTMessageV2 call", "", null).file === "scripted-rest.md");
t("AbstractAjaxProcessor → script-includes", resolvePackFile("client callable AbstractAjaxProcessor", "", null).file === "script-includes.md");
t("artifact words (no method) → business-rules", resolvePackFile("write a business rule", "", null).file === "business-rules.md");
t("unknown query → core-glide default", resolvePackFile("something totally unrelated", "", null).file === "core-glide.md");
{ // manifest keyword scoring beats the built-in maps and needs no code change
  const manifest = [{ file: "widget-x.md", artifact: "service_portal_widget", title: "Widgets", keywords: ["sputil", "$sp", "widget"] }];
  t("manifest keyword scoring resolves", resolvePackFile("how to use spUtil in a widget", "", manifest).file === "widget-x.md"); }
{ // method-roster routing (2026-07-20 fix): a "list methods" query lands on the roster pack
  const manifest = [
    { file: "core-glide.md", artifact: "core_platform", title: "core", keywords: ["gliderecord", "glideaggregate", "methods", "list methods", "exact methods"] },
    { file: "business-rules.md", artifact: "business_rule", title: "br", keywords: ["business rule"] }
  ];
  t("'list exact methods on GlideAggregate' → core-glide roster", resolvePackFile("list the exact methods available on GlideAggregate", "", manifest).file === "core-glide.md");
  t("bare method name still → core-glide (built-in index, no manifest)", resolvePackFile("GlideRecord methods", "", null).file === "core-glide.md"); }

console.log("— sn_api_reference: lookupSnApiReference (server-down paths) —");
{ const r = await lookupSnApiReference({}, "index");
  t("index mode lists available references", r.ok && r.mode === "index" && /business-rules\.md/.test(r.available)); }
{ const r = await lookupSnApiReference({}, "GlideAggregate");
  t("server-down lookup falls back to bundled rules (never empty)", r.ok && r.mode === "fallback" && typeof r.text === "string" && r.text.length > 200); }
{ const r = await lookupSnApiReference({}, "   ");
  t("blank query → index mode (not an error)", r.ok && r.mode === "index"); }

// ---------------------------------------------------------------------------
// Phase framing: a BUILD task must NOT be misrouted to the read-only review preset
// by a phase word buried in quoted DATA (2026-07-20, live SS1 a-live-run).
// ---------------------------------------------------------------------------
console.log("— detectSnPhase: build vs review framing —");
const SS1 = `On the incident table, write an AFTER Business Rule: when a P1 incident moves into state 2, create three child incident_task records — "Triage evidence", "Notify stakeholders", "Close-out review" — assigned to the group. Give me the record settings and the script.`;
t("SS1 build task is NOT routed to review (quoted 'Close-out review' ignored)", detectSnPhase(SS1) === null);
t("quoted review word alone does not trigger review", detectSnPhase(`create a task named "Close-out review"`) === null);
t("build verb before a review word → build", detectSnPhase("write a business rule that creates a review task") === null);
t("genuine review request still routes to review", (detectSnPhase("review this business rule for bugs") || {}).mode === "review");
t("review-and-fix (leads with review) stays review", (detectSnPhase("review the incident business rule and apply fixes") || {}).mode === "review");
t("genuine verify request still routes to verify", (detectSnPhase("verify the business rule has been implemented") || {}).mode === "verify");
t("grooming 'write a user story' NOT hijacked to build (signal begins with a build verb)", (detectSnPhase("write a user story for the incident intake") || {}).mode === "grooming");
t("grooming 'write acceptance criteria' stays grooming", (detectSnPhase("write acceptance criteria for the P1 flow") || {}).mode === "grooming");

console.log("— buildServiceNowPack: reference-first only on build runs (offline/bundled) —");
{ const buildPack = await buildServiceNowPack({}, SS1);
  t("build task pack carries the REFERENCE step", /REFERENCE FILLS THE PLAN/.test(buildPack));
  t("reference step names the artifact + save discipline", /business rule/i.test(buildPack) && /save_record/.test(buildPack));
  t("build task pack carries the MANDATORY STRUCTURED PLAN", /MANDATORY STRUCTURED PLAN/.test(buildPack) && /UAT/.test(buildPack));
  t("build pack carries the hard PLAN-BEFORE-BUILD gate", /PLAN-BEFORE-BUILD GATE/.test(buildPack));
  t("reference step tells the model to read the index + select", /"query":"index"/.test(buildPack) && /select the right reference/i.test(buildPack)); }

// Flow artifact detection (2026-07-21, live a-live-run): "Build a Flow" injected
// core-glide instead of flow-designer because detection required "flow designer".
console.log("— detectSnArtifactType: Flow —");
t("'Build a Flow that triggers…' → flow_designer", detectSnArtifactType("Build a Flow that triggers when a New Hire Onboarding RITM is created") === "flow_designer");
t("'create a flow' → flow_designer", detectSnArtifactType("create a flow to notify approvers") === "flow_designer");
t("'flow designer' still → flow_designer", detectSnArtifactType("build this in flow designer") === "flow_designer");
t("a Business Rule task is NOT flow", detectSnArtifactType("write a business rule on incident") === "business_rule");
{ const flowPack = await buildServiceNowPack({}, "Build a Flow that triggers when a RITM is created and asks the manager for approval");
  t("Flow build pack names flow-designer.md as the reference", /flow-designer\.md/.test(flowPack));
  t("Flow build pack carries the Workflow Studio one-hop nav", /now\/workflow-studio\/home/.test(flowPack) && /do NOT try \/flow-designer/i.test(flowPack));
  t("Flow build pack mandates EXECUTE (Save + Activate), not just docs", /PERSISTING A FLOW = Save \+ Activate/.test(flowPack) && /INCOMPLETE build/.test(flowPack)); }
{ const reviewPack = await buildServiceNowPack({}, "review this business rule for bugs");
  t("review task pack does NOT carry the build reference-first mandate", !/REFERENCE-FIRST \(this is a BUILD task\)/.test(reviewPack)); }

// wrapSnClassicTarget (2026-08-02, live INC1926570 run on customer-dev: bare
// sys_assignment_rule_list.do → SN "Page not found", 6 calls burned before the
// list ever opened). navigate uses this to self-heal a classic 404 in one call.
console.log("— wrapSnClassicTarget (polaris wrapper for bare classic .do) —");
t("bare list .do is wrapped",
  wrapSnClassicTarget("https://customer-dev.example.com/sys_assignment_rule_list.do")
  === "https://customer-dev.example.com/now/nav/ui/classic/params/target/sys_assignment_rule_list.do");
t("query string survives the wrap",
  wrapSnClassicTarget("https://customer-dev.example.com/sys_user_group_list.do?sysparm_query=name=Acquisition Service Desk EAS")
  === "https://customer-dev.example.com/now/nav/ui/classic/params/target/sys_user_group_list.do?sysparm_query=name=Acquisition%20Service%20Desk%20EAS");
t("form .do with sys_id is wrapped",
  wrapSnClassicTarget("https://dev000000.service-now.com/incident.do?sys_id=abc123")
  === "https://dev000000.service-now.com/now/nav/ui/classic/params/target/incident.do?sys_id=abc123");
t("already-wrapped URL returns unchanged",
  wrapSnClassicTarget("https://customer-dev.example.com/now/nav/ui/classic/params/target/sys_assignment_rule_list.do")
  === "https://customer-dev.example.com/now/nav/ui/classic/params/target/sys_assignment_rule_list.do");
t("shell/auth pages are never wrapped",
  ["login.do", "logout.do", "welcome.do", "home.do", "navpage.do", "nav_to.do", "side_door.do"]
    .every((p) => wrapSnClassicTarget(`https://dev000000.service-now.com/${p}`) === `https://dev000000.service-now.com/${p}`));
t("non-ServiceNow URL returns unchanged",
  wrapSnClassicTarget("https://example.com/thing.do") === "https://example.com/thing.do");
t("non-.do SN path returns unchanged",
  wrapSnClassicTarget("https://dev000000.service-now.com/now/workflow-studio/home") === "https://dev000000.service-now.com/now/workflow-studio/home");
t("unparseable input returns unchanged", wrapSnClassicTarget("not a url") === "not a url");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
