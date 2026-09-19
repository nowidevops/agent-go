// phase-parsers.test.mjs — adversarial unit tests for the phase-engine gate
// parsers + deterministic invariants. Plain node, no test framework:
//   node phase-parsers.test.mjs
// Covers consensus test cases T3, T4, T5, T6 (an internal review)
// plus the AWF-ported grammar behaviors. Author: iDevOpsLLC

import {
  stripThought, isGateFailOutput, parseReviewVerdict, parsePostVerdict,
  parseEvidenceTokens, checkEvidence, checkBasicInvariants,
  buildCiteTokens, recordEvidence, parsePlan, buildsInInstance
} from "./phase-parsers.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

// ---------------------------------------------------------------------------
console.log("— parseReviewVerdict —");

{ // happy path APPROVED/GO
  const r = parseReviewVerdict("VERDICT: APPROVED\nREADINESS: GO — meets all ACs\n\nLooks good.");
  t("approved-go", r.verdict === "APPROVED" && r.readiness === "GO" && !r.failClosed);
  t("approved-go reason", r.reason === "meets all ACs");
}
{ // T5: missing READINESS ⇒ fail-closed NO-GO
  const r = parseReviewVerdict("VERDICT: APPROVED\nEverything is great, ship it!");
  t("missing-readiness fail-closed", r.readiness === "NO-GO" && r.failClosed);
}
{ // T5: verdict only in a fenced quote ⇒ ignored ⇒ fail-closed
  const r = parseReviewVerdict("Here is what a verdict looks like:\n```\nVERDICT: APPROVED\nREADINESS: GO — example\n```\nI have thoughts.");
  t("fenced-verdict ignored", r.readiness === "NO-GO" && r.failClosed);
}
{ // T5: co-located GO and NO-GO ⇒ anchored NO-GO wins
  const r = parseReviewVerdict("VERDICT: APPROVED\nREADINESS: GO — mostly fine\nREADINESS: NO-GO — actually the flags are wrong");
  t("no-go precedence", r.readiness === "NO-GO");
}
{ // body prose "no-go" never matches (line-anchored only)
  const r = parseReviewVerdict("VERDICT: APPROVED\nREADINESS: GO — fine\nNote: rushing this would be a no-go situation generally.");
  t("prose no-go inert", r.readiness === "GO");
}
{ // thought block >600 chars before the verdict — must still parse (Gemini case)
  const think = "<think>" + "x".repeat(900) + "</think>";
  const r = parseReviewVerdict(think + "\nVERDICT: APPROVED\nREADINESS: GO — verified");
  t("thought-block tolerated", r.readiness === "GO" && !r.failClosed);
}
{ // unclosed think block, verdict after
  const r = parseReviewVerdict("<think>" + "y".repeat(700) + "\nVERDICT: REVISED\nREADINESS: NO-GO — evidence mismatch");
  t("unclosed-think tolerated", r.readiness === "NO-GO" && r.verdict === "REVISED");
}
{ // T6: REVISED with delimited body ⇒ deliverable extracted
  const r = parseReviewVerdict("VERDICT: REVISED\nREADINESS: GO — fixed the flag claims\nBEGIN_DELIVERABLE\nCorrected review body here.\nEND_DELIVERABLE");
  t("revised-delimited", r.deliverable === "Corrected review body here." && r.readiness === "GO");
}
{ // T6: REVISED without delimiters ⇒ fail-closed, no silent replacement
  const r = parseReviewVerdict("VERDICT: REVISED\nREADINESS: GO — fixed\nHere is my new version without delimiters.");
  t("revised-undelimited fail-closed", r.readiness === "NO-GO" && r.deliverableMissing && r.deliverable === null);
}
{ // deliverable containing literal verdict lines stays inert (delimiter design)
  const r = parseReviewVerdict("VERDICT: REVISED\nREADINESS: NO-GO — wrong values\nBEGIN_DELIVERABLE\nThe rule says VERDICT: APPROVED is required.\nEND_DELIVERABLE");
  t("verdict-in-body inert", r.readiness === "NO-GO" && r.deliverable.includes("VERDICT: APPROVED"));
}
{ // empty / garbage
  t("empty fail-closed", parseReviewVerdict("").readiness === "NO-GO");
  t("garbage fail-closed", parseReviewVerdict("lorem ipsum").readiness === "NO-GO");
}

// ---------------------------------------------------------------------------
console.log("— parsePostVerdict —");

{ const r = parsePostVerdict("Independent check complete.\nPOST_VERDICT: GO — invariants hold");
  t("post go", r.readiness === "GO" && !r.failClosed); }
{ // NO-GO precedence even when a later GO appears
  const r = parsePostVerdict("POST_VERDICT: NO-GO — mismatch\n...on reflection...\nPOST_VERDICT: GO — fine");
  t("post no-go precedence", r.readiness === "NO-GO"); }
{ t("post missing fail-closed", parsePostVerdict("all good!").readiness === "NO-GO"); }
{ // fenced POST_VERDICT ignored
  t("post fenced ignored", parsePostVerdict("```\nPOST_VERDICT: GO\n```").readiness === "NO-GO"); }

// ---------------------------------------------------------------------------
console.log("— gate-fail output —");
t("short output gate-fails", isGateFailOutput("  ok  "));
t("real output passes", !isGateFailOutput("This is a substantive answer."));

// ---------------------------------------------------------------------------
console.log("— evidence contract (T3/T4 replay) —");

// The 2026-07-15 ledger: query_elements actually observed Update=true, others false.
const LEDGER = [
  { id: "E1", tool: "query_elements", sequence: 1, success: true, truncated: false,
    observations: [
      { path: "sys_script.action_insert.checked", value: "false" },
      { path: "sys_script.action_update.checked", value: "true" },
      { path: "sys_script.action_delete.checked", value: "false" },
      { path: "sys_script.action_query.checked", value: "false" }
    ] },
  { id: "E2", tool: "get_editor_value", sequence: 2, success: true, truncated: false,
    observations: [ { path: "editor.0.chars", value: "398" } ] }
];

{ // T3a: UNCITED fabrication ("all flags true", no tokens) ⇒ coverage failure
  const draft = "High: The live record has Insert, Update, Delete, and Query enabled — the When to run fields all returned true.";
  const r = checkEvidence(draft, LEDGER);
  t("T3a uncited fabrication dies", !r.ok && r.failures.some((f) => f.kind === "uncited-claim"));
}
{ // T3b: CITED fabrication ⇒ exact value-match failure on insert
  const draft = "Insert is enabled [E1:sys_script.action_insert.checked=true] and Update is enabled [E1:sys_script.action_update.checked=true].";
  const r = checkEvidence(draft, LEDGER);
  t("T3b cited fabrication dies on value-match",
    !r.ok && r.failures.some((f) => f.kind === "value-mismatch" && f.detail.includes("action_insert")));
}
{ // honest draft passes
  const draft = "Only Update is enabled [E1:sys_script.action_update.checked=true]; Insert is disabled [E1:sys_script.action_insert.checked=false], Delete is disabled [E1:sys_script.action_delete.checked=false] and Query is disabled [E1:sys_script.action_query.checked=false].";
  const r = checkEvidence(draft, LEDGER);
  t("honest draft passes", r.ok, JSON.stringify(r.failures));
}
{ // T4: token citing a real-but-irrelevant entry/path ⇒ no-observation failure
  const draft = "Insert is enabled [E2:sys_script.action_insert.checked=true].";
  const r = checkEvidence(draft, LEDGER);
  t("T4 irrelevant evidence rejected", !r.ok && r.failures.some((f) => f.kind === "no-observation"));
}
{ // unresolved id
  const r = checkEvidence("Update is checked [E9:sys_script.action_update.checked=true].", LEDGER);
  t("unresolved id rejected", !r.ok && r.failures.some((f) => f.kind === "unresolved"));
}
{ // truncated OBSERVATION unusable (per-obs semantics — run #8)
  const led = [{ id: "E1", sequence: 1, success: true, truncated: true,
    observations: [{ path: "a.checked", value: "true", truncated: true }] }];
  const r = checkEvidence("A is checked [E1:a.checked=true].", led);
  t("truncated evidence rejected", !r.ok && r.failures.some((f) => f.kind === "truncated-evidence"));
}
{ // run #8: entry-level truncation must NOT poison complete sibling observations
  const led = [{ id: "E10", sequence: 1, success: true, truncated: true, observations: [
    { path: "title", value: "Prevent Incident Update | ServiceNow" },
    { path: "url", value: "https://dev000000.service-now.com/x" },
    { path: "text", value: "Skip to main content...", truncated: true } ] }];
  t("complete siblings of truncated text stay citable",
    checkEvidence("Title is right [E10:title]. URL is right [E10:url].", led).ok);
  t("the truncated text observation itself still dies",
    checkEvidence("Page says X [E10:text].", led).failures.some((f) => f.kind === "truncated-evidence"));
  t("builder never offers truncated observations",
    !buildCiteTokens(led[0]).some((s) => s.includes(" text=")));
}
{ // freshness: later contradicting observation supersedes
  const led = [
    { id: "E1", sequence: 1, success: true, truncated: false, observations: [{ path: "state.value", value: "New" }] },
    { id: "E3", sequence: 3, success: true, truncated: false, observations: [{ path: "state.value", value: "In Progress" }] }
  ];
  const r = checkEvidence("State is New [E1:state.value=New].", led);
  t("stale evidence rejected", !r.ok && r.failures.some((f) => f.kind === "stale-evidence"));
}
{ // sys_id claims need citations
  const r = checkEvidence("The culprit record is 1e991ce2934acf1013b7326efaba10d2 in sys_script.", LEDGER);
  t("uncited sys_id claim rejected", !r.ok && r.failures.some((f) => f.kind === "uncited-claim"));
}
{ // prose without claim-schemas needs no citations
  const r = checkEvidence("The naming convention could be clearer and the description field is empty, which reduces discoverability.", LEDGER);
  t("plain prose passes without tokens", r.ok, JSON.stringify(r.failures));
}

// ---------------------------------------------------------------------------
console.log("— leaf-suffix resolution (live BR regression 2026-07-15) —");

// sn_query_table results flatten to records[0].<field>; models cite the leaf.
const SN_LEDGER = [
  { id: "E3", tool: "sn_query_table", sequence: 3, success: true, truncated: false,
    observations: [
      { path: "instance", value: "https://dev000000.service-now.com" },
      { path: "count", value: "1" },
      { path: "records[0].action_insert", value: "false" },
      { path: "records[0].action_update", value: "true" },
      { path: "records[0].collection", value: "incident" }
    ] }
];
{ // the exact live false-NO-GO: leaf citation resolves via unique suffix
  const r = checkEvidence("Insert is disabled [E3:action_insert=false] on table incident [E3:collection=incident].", SN_LEDGER);
  t("leaf citation resolves via suffix", r.ok, JSON.stringify(r.failures));
}
{ // suffix resolution still enforces exact VALUE match
  const r = checkEvidence("Insert is enabled [E3:action_insert=true].", SN_LEDGER);
  t("suffix-resolved value mismatch still dies", !r.ok && r.failures.some((f) => f.kind === "value-mismatch"));
}
{ // AMBIGUOUS suffix (two records) does NOT resolve — fail-closed preserved
  const amb = [{ id: "E1", sequence: 1, success: true, truncated: false, observations: [
    { path: "records[0].name", value: "A" }, { path: "records[1].name", value: "B" }
  ] }];
  const r = checkEvidence("The rule name is A [E1:name=A].", amb);
  t("ambiguous suffix stays no-observation", !r.ok && r.failures.some((f) => f.kind === "no-observation"));
}
{ // exact path always wins over suffix candidates
  const led = [{ id: "E1", sequence: 1, success: true, truncated: false, observations: [
    { path: "name", value: "top" }, { path: "records[0].name", value: "nested" }
  ] }];
  t("exact path beats suffix", checkEvidence("Name is top [E1:name=top].", led).ok);
}

// ---------------------------------------------------------------------------
console.log("— live run #2 fixes: path-only tokens, quoted values, long prefixes —");

const SCRIPT_VAL = "/* Business Rule: Prevent Incident Update Without Assignment Group */ (function executeRule(current, previous) { current.setAbortAction(true); })(current, previous);";
const RUN2_LEDGER = [
  { id: "E1", sequence: 1, success: true, truncated: false, observations: [
    { path: "script", value: SCRIPT_VAL }, { path: "name", value: "Prevent Incident Update Without Assignme" } ] },
  { id: "E2", sequence: 2, success: true, truncated: false, observations: [
    { path: "records[0].role_conditions", value: "" }, { path: "records[0].action_insert", value: "false" } ] }
];
{ // path-only citation of long content resolves (the [E1:script] shorthand)
  const r = checkEvidence("The script uses setAbortAction correctly [E1:script]. Insert is false [E2:action_insert=false].", RUN2_LEDGER);
  t("path-only token resolves", r.ok, JSON.stringify(r.failures));
}
{ // path-only token on a NONEXISTENT path still dies
  const r = checkEvidence("See the condition [E1:condition].", RUN2_LEDGER);
  t("path-only nonexistent path dies", !r.ok && r.failures.some((f) => f.kind === "no-observation"));
}
{ // quoted empty value matches empty observation (role_conditions="")
  const r = checkEvidence('Role conditions are empty [E2:role_conditions=""].', RUN2_LEDGER);
  t("quoted empty value matches", r.ok, JSON.stringify(r.failures));
}
{ // ≥32-char prefix of a long value matches
  const r = checkEvidence(`Script header [E1:script=${SCRIPT_VAL.slice(0, 60)}].`, RUN2_LEDGER);
  t("long prefix matches", r.ok, JSON.stringify(r.failures));
}
{ // short prefix does NOT match (fail-closed)
  const r = checkEvidence("Script header [E1:script=/* Busi].", RUN2_LEDGER);
  t("short prefix still dies", !r.ok && r.failures.some((f) => f.kind === "value-mismatch"));
}
{ // wrong VALUE still dies even with quotes
  const r = checkEvidence('Insert is enabled [E2:action_insert="true"].', RUN2_LEDGER);
  t("quoted wrong value still dies", !r.ok && r.failures.some((f) => f.kind === "value-mismatch"));
}

// ---------------------------------------------------------------------------
console.log("— live run #3: bracket paths in citation tokens —");

{ // the exact run-3 failure: full bracket-style path must parse AND resolve
  const led = [{ id: "E2", sequence: 2, success: true, truncated: false, observations: [
    { path: "records.0.action_insert", value: "false" }, { path: "records.0.name", value: "BR" } ] }];
  const toks = parseEvidenceTokens("Insert is false [E2:records[0].action_insert=false].");
  t("bracket path parses whole", toks.length === 1 && toks[0].path === "records[0].action_insert" && toks[0].value === "false");
  t("bracket token resolves vs dot ledger", checkEvidence("Insert is false [E2:records[0].action_insert=false].", led).ok);
  t("dot token resolves too", checkEvidence("Insert is false [E2:records.0.action_insert=false].", led).ok);
  t("bracket token with WRONG value still dies",
    checkEvidence("Insert is true [E2:records[0].action_insert=true].", led).failures.some((f) => f.kind === "value-mismatch"));
  // legacy bracket-form ledger entries (pre-dot flattener) still resolve
  const legacyLed = [{ id: "E2", sequence: 2, success: true, truncated: false, observations: [
    { path: "records[0].action_insert", value: "false" } ] }];
  t("bracket ledger + leaf token resolves", checkEvidence("Insert is false [E2:action_insert=false].", legacyLed).ok);
}

// ---------------------------------------------------------------------------
console.log("— MM impl-review fixes: engine-built tokens, whitespace, hedges —");
{ // Terminal design (MM Tier-1.5): builder emits OBSERVATION-ID legend lines —
  // the token part serializes nothing, so bracket/long values can't break it.
  const entry = { id: "E1", observations: [
    { path: "condition", value: "current.getValue('watch_list')[0] != ''" },
    { path: "active", value: "true" },
    { path: "script", value: "x".repeat(300) } ] };
  const toks = buildCiteTokens(entry);
  t("every observation gets an id legend", toks.length === 3 && toks[0].startsWith("[E1.O1] =") && toks[1].startsWith("[E1.O2] ="));
  t("legend shows display-truncated values", toks[2].startsWith("[E1.O3] = script=") && toks[2].includes("(display cut"));
  t("wide valueChars for gate digests", buildCiteTokens(entry, 60, 400)[2].includes("x".repeat(300)));
  t("bracket value cannot break the token part", toks[0].indexOf("]") === "[E1.O1".length);
}
{ // observation-id tokens validate without any serialization
  const led = [{ id: "E6", sequence: 1, success: true, truncated: false, observations: [
    { path: "records.0.sys_scope.value", value: "global" },
    { path: "records.0.active", value: "true" } ] }];
  t("obs-id token resolves", checkEvidence("Scope is Global [E6.O1].", led).ok);
  t("obs-id out of range dies", checkEvidence("Nope [E6.O9].", led).failures.some((f) => f.kind === "no-observation"));
  t("obs-id satisfies coverage", checkEvidence("Active is true on the record [E6.O2].", led).ok);
  const trunc = [{ id: "E1", sequence: 1, success: true, truncated: false, observations: [
    { path: "text", value: "abc", truncated: true } ] }];
  t("obs-id on truncated obs dies", checkEvidence("Page says [E1.O1].", trunc).failures.some((f) => f.kind === "truncated-evidence"));
  const stale = [
    { id: "E1", sequence: 1, success: true, truncated: false, observations: [{ path: "state.value", value: "New" }] },
    { id: "E2", sequence: 2, success: true, truncated: false, observations: [{ path: "state.value", value: "Closed" }] }
  ];
  t("obs-id freshness via bound path", checkEvidence("State is New [E1.O1].", stale).failures.some((f) => f.kind === "stale-evidence"));
}
{ // B5: whitespace-padded token parses and resolves
  const led = [{ id: "E1", sequence: 1, success: true, truncated: false, observations: [{ path: "active", value: "true" }] }];
  t("spaced token parses and resolves", checkEvidence("Active is on [E1: active = true].", led).ok);
}
{ // B6: recommendation/hypothetical sentences are exempt from coverage
  const r = checkEvidence("Recommendation: set active=false after testing to disable the rule.", []);
  t("recommendation exempt from coverage", r.ok, JSON.stringify(r.failures));
  const r2 = checkEvidence("Consider whether Insert should be enabled=true for imports.", []);
  t("hypothetical exempt from coverage", r2.ok, JSON.stringify(r2.failures));
}
{ // 2026-07-19v: web_search + fetch_page are EVIDENCE tools (research role can cite sources)
  const ledger = [];
  const id1 = recordEvidence(ledger, "web_search", { query: "NVDA price target" }, { query: "NVDA price target", count: 2, results: [{ title: "NVDA Forecast", url: "https://example.com/nvda", snippet: "target $330" }, { title: "B", url: "https://b.com", snippet: "s" }] });
  t("web_search ledgers an entry", id1 === "E1" && ledger.length === 1);
  t("web_search flattens result url/snippet", ledger[0].observations.some((o) => o.value === "https://example.com/nvda") && ledger[0].observations.some((o) => o.value === "target $330"));
  const id2 = recordEvidence(ledger, "fetch_page", { url: "https://x.com" }, { url: "https://x.com", title: "T", text: "KeyBanc raised NVDA to $330" });
  t("fetch_page ledgers + text citable", id2 === "E2" && ledger[1].observations.some((o) => /KeyBanc/.test(o.value)));
  // a claim citing the ledgered url now RESOLVES (the exact a-live-run failure, fixed)
  const r = checkEvidence("Analysts set NVDA at $330 [E2:text].", ledger);
  t("research claim citing fetched page resolves", r.ok, JSON.stringify(r.failures || []).slice(0, 120));
}
{ // B3: observation-cap overflow is flagged, and the no-observation hint says so
  const ledger = [];
  const big = { count: 40, elements: Array.from({ length: 40 }, (_, i) => ({ id: "f" + i, checked: false, value: "v", type: "checkbox", disabled: false })) };
  recordEvidence(ledger, "query_elements", {}, big);
  t("obsTruncated flagged on overflow", ledger[0].obsTruncated === true);
  const r = checkEvidence("Field is on [E1:f39.checked=true].", ledger);
  t("no-observation mentions truncation", !r.ok && r.failures[0].detail.includes("truncated"));
}

// ---------------------------------------------------------------------------
console.log("— live run #5: positional aliases for query_elements —");
{
  const ledger = [];
  const { recordEvidence: rec } = await import("./phase-parsers.js");
  rec(ledger, "query_elements", {}, { count: 2, elements: [
    { id: "ni.sys_script.active", checked: true, type: "checkbox" },
    { id: "ni.sys_script.action_query", checked: false, type: "checkbox" }
  ] });
  t("keyed path resolves", checkEvidence("Active is on [E1:ni.sys_script.active.checked=true].", ledger).ok);
  t("positional bracket path resolves (run-5 case)",
    checkEvidence("Query is off [E1:elements[1].checked=false].", ledger).ok);
  t("positional dot path resolves", checkEvidence("Query is off [E1:elements.1.checked=false].", ledger).ok);
  t("positional path with WRONG value dies",
    checkEvidence("Query is on [E1:elements[1].checked=true].", ledger).failures.some((f) => f.kind === "value-mismatch"));
}

// ---------------------------------------------------------------------------
console.log("— basic invariants —");

{ const r = checkBasicInvariants("short", {});
  t("empty deliverable fails", !r.ok && r.failures.some((f) => f.kind === "empty")); }
{ // live run #2: an UNCITED truncated call (capped read_page) must NOT fail the run
  const led = [
    { id: "E1", sequence: 1, success: true, truncated: false, observations: [{ path: "records[0].action_insert", value: "false" }] },
    { id: "E3", sequence: 3, success: true, truncated: true, observations: [{ path: "title", value: "..." }] }
  ];
  t("uncited truncated call tolerated",
    checkBasicInvariants("x".repeat(100), { ledger: led }).ok &&
    checkEvidence("Insert is disabled [E1:action_insert=false].", led).ok);
  // (entry-level truncation no longer blanket-fails complete observations —
  // per-observation semantics are covered in the run #8 block above)
}
{ const draft = "See https://a.example/1 https://b.example/2 https://c.example/3 for details.";
  const fin = "Summary with https://a.example/1 only, plus padding ".padEnd(100, ".");
  const r = checkBasicInvariants(fin, { draftText: draft });
  t("citation loss fails", !r.ok && r.failures.some((f) => f.kind === "citations-lost")); }
{ // run #14: dropping the SINGLE incidental URL of a code review is tolerated
  const draft = "Reviewed https://dev000000.service-now.com/x — details follow. ".padEnd(100, ".");
  const fin = "Reviewed the record; details follow. ".padEnd(100, ".");
  t("single-URL drop tolerated", checkBasicInvariants(fin, { draftText: draft }).ok); }
{ const text = "A perfectly reasonable final deliverable body with no URLs and enough length to pass.";
  t("clean deliverable passes", checkBasicInvariants(text, { draftText: text }).ok); }

// ---------------------------------------------------------------------------
console.log("— live run #6: headings + proposed-artifact comments —");
{ // Issue-heading with tokens on the Evidence line beneath it (same paragraph)
  const led = [{ id: "E8", sequence: 1, success: true, truncated: false, observations: [
    { path: "ni.sys_script.action_insert.checked", value: "false" },
    { path: "ni.sys_script.action_update.checked", value: "true" } ] }];
  const para = 'Issue 4: Header comment says "Insert: false | Update: true" — verified correct\n- Severity: N/A\n- Evidence: Insert checkbox checked=false [E8:ni.sys_script.action_insert.checked=false]; Update checkbox checked=true [E8:ni.sys_script.action_update.checked=true].';
  const r = checkEvidence(para, led);
  t("cited paragraph exempts its heading", r.ok, JSON.stringify(r.failures));
}
{ // proposed remediated script's /* header comment */ is not a claim
  const artifact = "5. PRODUCTION ARTIFACTS\n\n/* Business Rule: X | Condition: current.assignment_group.nil() | Insert: false | Update: true */\n(function executeRule(current, previous) { })(current, previous);";
  const r = checkEvidence(artifact, []);
  t("block-comment artifact exempt", r.ok, JSON.stringify(r.failures));
}
{ // a fully token-less paragraph asserting state STILL fails (no regression on T3)
  const r = checkEvidence("Standalone paragraph: the Insert flag returned true on the live record.", []);
  t("token-less claim paragraph still dies", !r.ok && r.failures.some((f) => f.kind === "uncited-claim"));
}

// ---------------------------------------------------------------------------
console.log("— live run #9: reference-field parent nodes (prefix-group resolution) —");
{
  const led = [{ id: "E6", sequence: 1, success: true, truncated: false, observations: [
    { path: "records.0.sys_scope.link", value: "https://x/api/now/table/sys_scope/global" },
    { path: "records.0.sys_scope.value", value: "global" },
    { path: "records.0.active", value: "true" } ] }];
  t("path-only parent node resolves to its children",
    checkEvidence("Scope is Global [E6:records.0.sys_scope].", led).ok);
  t("valued parent node still dies (no concrete observation)",
    checkEvidence("Scope [E6:records.0.sys_scope=global].", led).failures.some((f) => f.kind === "no-observation"));
  t("nonexistent parent still dies",
    checkEvidence("Role is admin [E6:records.0.role_conditions].", led).failures.some((f) => f.kind === "no-observation"));
  t("child citation still works directly",
    checkEvidence("Scope value is global [E6:records.0.sys_scope.value=global].", led).ok);
}

// ---------------------------------------------------------------------------
console.log("— parsePlan (Tier 2) —");
{ const p = parsePlan('```json\n{"subtasks":[{"id":"s2","title":"b","prompt":"p2","depends_on":["s1"]},{"id":"s1","title":"a","prompt":"p1","depends_on":[]}],"synthesis_instructions":"merge"}\n```');
  t("plan parses + topo orders", p.ok && p.subtasks[0].id === "s1" && p.subtasks[1].id === "s2" && p.synthesis === "merge"); }
{ t("fast_path parses", parsePlan('{"fast_path": true}').fastPath === true); }
{ const p = parsePlan('{"subtasks":[{"id":"a","prompt":"x","depends_on":["b"]},{"id":"b","prompt":"y","depends_on":["a"]}]}');
  t("cycle rejected", !p.ok && /cycle/.test(p.error)); }
{ t("unknown dep rejected", !parsePlan('{"subtasks":[{"id":"a","prompt":"x","depends_on":["zz"]}]}').ok); }
{ t("self-dep rejected", !parsePlan('{"subtasks":[{"id":"a","prompt":"x","depends_on":["a"]}]}').ok); }
{ t("garbage rejected", !parsePlan("let me think about this first").ok); }
{ t("too many subtasks rejected", !parsePlan(JSON.stringify({ subtasks: Array.from({ length: 5 }, (_, i) => ({ id: "s" + i, prompt: "p" })) })).ok); }
{ t("duplicate ids rejected", !parsePlan('{"subtasks":[{"id":"a","prompt":"x"},{"id":"a","prompt":"y"}]}').ok); }
// AWF role-tagging + waves (2026-07-19u)
{ const p = parsePlan('{"subtasks":[{"id":"s1","prompt":"a","role":"research","depends_on":[]},{"id":"s2","prompt":"b","role":"code","depends_on":["s1"]}]}');
  t("role tags parsed", p.ok && p.subtasks[0].role === "research" && p.subtasks[1].role === "code"); }
{ const p = parsePlan('{"subtasks":[{"id":"s1","prompt":"a"}]}');
  t("missing role defaults to tools", p.ok && p.subtasks[0].role === "tools"); }
{ const p = parsePlan('{"subtasks":[{"id":"s1","prompt":"a","role":"bogus"}]}');
  t("invalid role defaults to tools", p.ok && p.subtasks[0].role === "tools"); }
{ const p = parsePlan('{"subtasks":[{"id":"s1","prompt":"a","depends_on":[]},{"id":"s2","prompt":"b","depends_on":[]},{"id":"s3","prompt":"c","depends_on":["s1","s2"]}]}');
  t("waves: independent s1,s2 in wave 0; s3 in wave 1", p.ok && p.waves.length === 2 && p.waves[0].length === 2 && p.waves[0].includes("s1") && p.waves[0].includes("s2") && p.waves[1].join() === "s3"); }

// BUILD-IN-INSTANCE re-tag (2026-07-20, live SN export a-live-run) — a "code"
// subtask that actually BUILDS a record in the instance is forced to "tools".
console.log("— build-in-instance re-tag —");
{ t("buildsInInstance: build Script Include", buildsInInstance("Build a client-callable Script Include named CallerInfoAjax") === true); }
{ t("buildsInInstance: create Business Rule in my instance", buildsInInstance("Create the Business Rule and save it in my instance") === true); }
{ t("buildsInInstance: persist verb + in-instance phrase (no artifact noun)", buildsInInstance("Add the guard clause to the record in the instance") === true); }
{ t("buildsInInstance: pure-code review is NOT a build", buildsInInstance("Review the Script Include for security defects") === false); }
{ t("buildsInInstance: write a script BODY is NOT a build (no persist/artifact-save intent)", buildsInInstance("Write the onChange logic that clears the field message") === false); }
{ t("buildsInInstance: bulk summarize is NOT a build", buildsInInstance("Summarize the three outputs into a table") === false); }
{ const p = parsePlan('{"subtasks":[{"id":"s1","title":"Build Script Include","prompt":"Build a client-callable Script Include CallerInfoAjax and save it","role":"code","depends_on":[]}]}');
  t("parsePlan: code subtask that builds a record is re-tagged to tools", p.ok && p.subtasks[0].role === "tools" && p.subtasks[0].retagged === true); }
{ const p = parsePlan('{"subtasks":[{"id":"s1","title":"Draft the BR script","prompt":"Write the onChange business rule script body that guards against null callers","role":"code","depends_on":[]},{"id":"s2","title":"Save it","prompt":"Save the business rule in the instance","role":"tools","depends_on":["s1"]}]}');
  t("parsePlan: pure-code drafting leg (no persist verb) stays code, save leg stays tools", p.ok && p.subtasks[0].role === "code" && p.subtasks[0].retagged === false && p.subtasks[1].role === "tools"); }
{ const p = parsePlan('{"subtasks":[{"id":"s1","prompt":"Research the latest ServiceNow release and build a summary","role":"research","depends_on":[]}]}');
  t("parsePlan: research is never re-tagged even with a build verb", p.ok && p.subtasks[0].role === "research"); }

// save_record as PERSISTENCE evidence (2026-07-20, live SN export a-live-run) —
// a successful save is a citable observation; the "unsaved stub" fabrication dies.
// sn_api_reference as CITABLE evidence (2026-07-20, live a-live-run) — the C:\redacted\path
// roster the tool returns must be ledgered + chunked so the drafter can cite it and
// the gates verify it (else a correct roster reads as "fabrication" and gets cut to 3).
console.log("— sn_api_reference citable evidence —");
{ const ledger = [];
  const roster = "GlideAggregate methods: " + "addAggregate getAggregate groupBy orderByAggregate hasNext next query ".repeat(200); // >24KB
  const id = recordEvidence(ledger, "sn_api_reference", { query: "GlideAggregate methods" }, { ok: true, mode: "lookup", file: "core-glide.md", text: roster });
  t("sn_api_reference is an evidence tool (ledgers an entry)", id === "E1" && ledger.length === 1 && ledger[0].success === true);
  const chunks = ledger[0].observations.filter((o) => o.path === "text" || /^text\.\d+$/.test(o.path));
  t("reference text is chunked into many citable pieces (>16)", chunks.length > 16, `chunks=${chunks.length}`);
  t("chunks are complete (not truncated) → citable", chunks.every((o) => !o.truncated));
  // citing a chunk RESOLVES (the a-live-run fix — the roster is now verifiable)
  const chk = checkEvidence("The reference documents groupBy and orderByAggregate [E1.text.2].", ledger);
  t("cited reference chunk resolves (no unresolved/truncated failure)", !chk.failures.some((f) => ["unresolved", "no-observation", "truncated-evidence"].includes(f.kind)), JSON.stringify(chk.failures)); }
{ // LINE-AWARE chunking (a-live-run): a method signature must never be split across
  // chunks, or a straddling method (setIntervalYearIncluded) sits in no complete chunk
  // and gets dropped from the roster. Each `- name(sig)` line stays whole in one chunk.
  const ledger = [];
  const lines = Array.from({ length: 120 }, (_, i) => `- \`methodNumber${i}(String argumentNameThatIsFairlyLong${i}, Boolean flag${i})\``);
  const pack = "# Reference\n\n**SomeClass** (120 methods):\n" + lines.join("\n");
  recordEvidence(ledger, "sn_api_reference", { query: "SomeClass methods" }, { ok: true, text: pack });
  const chunks = ledger[0].observations.filter((o) => o.path === "text" || /^text\.\d+$/.test(o.path)).map((o) => o.value);
  const split = lines.filter((ln) => !chunks.some((c) => c.includes(ln))); // any method line not wholly in a chunk
  t("no chunk exceeds the 500-char cap", chunks.every((c) => c.length <= 500));
  t("every method line is whole in some chunk (none split across a boundary)", split.length === 0, `split=${split.length}`); }

console.log("— save_record persistence evidence —");
{ const ledger = [];
  const id = recordEvidence(ledger, "save_record", {}, { ok: true, saved: true, sys_id: "540d2184939a4710103d72cdfaba1092", note: "Record saved and still open." });
  t("save_record ledgers a successful save", id === "E1" && ledger.length === 1 && ledger[0].success === true);
  t("save_record exposes the sys_id observation", ledger[0].observations.some((o) => /(^|\.)sys_id$/.test(o.path) && o.value === "540d2184939a4710103d72cdfaba1092"));
  // a claim citing the saved sys_id now RESOLVES (the a-live-run fix)
  const chk = checkEvidence("The Script Include was saved with sys_id 540d2184939a4710103d72cdfaba1092 [E1:sys_id=540d2184939a4710103d72cdfaba1092].", ledger);
  t("cited saved sys_id resolves + value-matches", chk.ok, JSON.stringify(chk.failures)); }
{ const ledger = [];
  // a BLOCKED save (mandatory field) carries `error` ⇒ non-citable, never a persisted record
  recordEvidence(ledger, "save_record", {}, { ok: false, saved: false, blocked_by: "unpopulated_mandatory_fields", error: "ServiceNow refused the save — required field(s) are still empty" });
  t("blocked save is recorded success:false (not citable as saved)", ledger[0].success === false);
  const chk = checkEvidence("The record was saved [E1:saved=true].", ledger);
  t("citing a blocked save as saved fails the gate", !chk.ok && chk.failures.some((f) => f.kind === "failed-evidence")); }
{ const ledger = [];
  // saves of DIFFERENT records (distinct sys_ids) must NOT cross-stale one another
  recordEvidence(ledger, "save_record", {}, { ok: true, saved: true, sys_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  recordEvidence(ledger, "save_record", {}, { ok: true, saved: true, sys_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
  const chk = checkEvidence("First record saved [E1:sys_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa].", ledger);
  t("distinct-record saves do not cross-stale", chk.ok, JSON.stringify(chk.failures)); }

// ---------------------------------------------------------------------------
// MM FINAL-AUDIT regressions (session 6a587136)
// ---------------------------------------------------------------------------

// query_elements value at 501 chars must be marked truncated (was silently cut
// and citable-as-complete).
{
  const ledger = [];
  recordEvidence(ledger, "query_elements", {}, { elements: [{ id: "ni.big", value: "x".repeat(501), checked: true }] });
  const valObs = ledger[0].observations.find((o) => o.path === "ni.big.value");
  const chkObs = ledger[0].observations.find((o) => o.path === "ni.big.checked");
  t("query_elements long value flagged truncated", valObs && valObs.truncated === true);
  t("query_elements short sibling stays complete", chkObs && !chkObs.truncated);
  const r = checkEvidence("The value is long [E1:ni.big.value=" + "x".repeat(40) + "]", ledger);
  t("truncated query_elements value not citable", r.failures.some((f) => f.kind === "truncated-evidence"));
}

// obsTruncated must be TRUE overflow, not length == cap.
{
  const ledger = [];
  const exactly120 = { elements: Array.from({ length: 30 }, (_, i) => ({ id: "f" + i, checked: true, value: "v", type: "checkbox", disabled: false })) };
  recordEvidence(ledger, "query_elements", {}, exactly120);
  t("exactly-120 observations is NOT overflow", ledger[0].observations.length === 120 && ledger[0].obsTruncated === false);
  const ledger2 = [];
  const over = { elements: Array.from({ length: 31 }, (_, i) => ({ id: "g" + i, checked: true, value: "v", type: "checkbox", disabled: false })) };
  recordEvidence(ledger2, "query_elements", {}, over);
  t("121st observation IS overflow", ledger2[0].obsTruncated === true);
}

// Scope-aware freshness: record B's later same-path observation must not stale
// record A's citation (different sys_id scopes).
{
  const ledger = [
    { id: "E1", tool: "sn_query_table", scope: { sysId: "aaa" }, sequence: 1, success: true, truncated: false,
      observations: [{ path: "records.0.active", value: "true" }, { path: "records.0.sys_id", value: "aaa" }] },
    { id: "E2", tool: "sn_query_table", scope: { sysId: "bbb" }, sequence: 2, success: true, truncated: false,
      observations: [{ path: "records.0.active", value: "false" }, { path: "records.0.sys_id", value: "bbb" }] }
  ];
  const r = checkEvidence("Record A is active [E1:records.0.active=true]", ledger);
  t("different-record later obs does NOT stale", !r.failures.some((f) => f.kind === "stale-evidence"), JSON.stringify(r.failures));
  const ledger2 = [
    { id: "E1", tool: "sn_query_table", scope: { sysId: "aaa" }, sequence: 1, success: true, truncated: false,
      observations: [{ path: "records.0.active", value: "true" }] },
    { id: "E2", tool: "sn_query_table", scope: { sysId: "aaa" }, sequence: 2, success: true, truncated: false,
      observations: [{ path: "records.0.active", value: "false" }] }
  ];
  const r2 = checkEvidence("Still active [E1:records.0.active=true]", ledger2);
  t("same-record re-read DOES stale", r2.failures.some((f) => f.kind === "stale-evidence"));
}
{ // WEB_SEARCH freshness exclusion (2026-07-20e, PE4 a-live-run): two DIFFERENT
  // web_search queries both expose results.0.snippet — a later query's snippet is
  // NOT a supersession of an earlier one's, and must not stale-NO-GO research.
  const webLedger = [
    { id: "E10", tool: "web_search", scope: {}, sequence: 10, success: true, truncated: false,
      observations: [{ path: "results.0.snippet", value: "Zurich GA September 10, 2025" }] },
    { id: "E14", tool: "web_search", scope: {}, sequence: 14, success: true, truncated: false,
      observations: [{ path: "results.0.snippet", value: "Australia GA May 5, 2026" }] }
  ];
  const rw = checkEvidence("The release GA'd in Sept 2025 [E10.O1].", webLedger);
  t("web_search snippets do NOT stale across queries", !rw.failures.some((f) => f.kind === "stale-evidence"), JSON.stringify(rw.failures));
  // Control: a ServiceNow record re-read (read_page — NOT a web tool) STILL stales.
  const snLedger = [
    { id: "E1", tool: "read_page", scope: { url: "https://x.service-now.com/nav_to.do?sys_id=a" }, sequence: 1, success: true, truncated: false, observations: [{ path: "state.value", value: "New" }] },
    { id: "E2", tool: "read_page", scope: { url: "https://x.service-now.com/nav_to.do?sys_id=a" }, sequence: 2, success: true, truncated: false, observations: [{ path: "state.value", value: "Closed" }] }
  ];
  t("SN record re-read still stales (freshness intact)", checkEvidence("State is New [E1.O1].", snLedger).failures.some((f) => f.kind === "stale-evidence"));
}
{ // sn_query FILTER scoping (2026-07-20i, live SN2 a-live-run): a count from one
  // encoded query is NOT superseded by a count from a DIFFERENT query.
  const diff = [
    { id: "E25", tool: "sn_query_session", scope: { query: "name=GetUserDepartmentAjax" }, sequence: 25, success: true, truncated: false, observations: [{ path: "count", value: "0" }] },
    { id: "E29", tool: "sn_query_session", scope: { query: "client_callable=true^active=true" }, sequence: 29, success: true, truncated: false, observations: [{ path: "count", value: "10" }] }
  ];
  const rd = checkEvidence("The Script Include does not exist [E25.O1].", diff);
  t("different sn_query filters do NOT stale each other", !rd.failures.some((f) => f.kind === "stale-evidence"), JSON.stringify(rd.failures));
  // Same filter re-run with a changed count DOES stale (state genuinely changed).
  const same = [
    { id: "E1", tool: "sn_query_session", scope: { query: "name=X" }, sequence: 1, success: true, truncated: false, observations: [{ path: "count", value: "0" }] },
    { id: "E2", tool: "sn_query_session", scope: { query: "name=X" }, sequence: 2, success: true, truncated: false, observations: [{ path: "count", value: "1" }] }
  ];
  t("same sn_query filter re-run DOES stale on a changed count", checkEvidence("Count is zero [E1.O1].", same).failures.some((f) => f.kind === "stale-evidence"));
}
{ // query_elements url scoping (2026-07-20m, live catalog a-live-run): DOM reads
  // of DIFFERENT records (different form URLs) must not stale each other; the tab
  // url is now carried into the ledger entry's scope.
  const led = [];
  recordEvidence(led, "query_elements", { selector: "input" }, { count: 1, elements: [{ id: "item_option_new.type", value: "5" }], url: "https://x.service-now.com/item_option_new.do?sys_id=aaa" });
  t("query_elements url is captured into scope", led[0] && led[0].scope && /sys_id=aaa/.test(led[0].scope.url || ""));
  const diffRec = [
    { id: "E23", tool: "query_elements", scope: { url: "https://x.service-now.com/item_option_new.do?sys_id=aaa" }, sequence: 23, success: true, truncated: false, observations: [{ path: "item_option_new.type.value", value: "5" }] },
    { id: "E30", tool: "query_elements", scope: { url: "https://x.service-now.com/item_option_new.do?sys_id=bbb" }, sequence: 30, success: true, truncated: false, observations: [{ path: "item_option_new.type.value", value: "2" }] }
  ];
  t("query_elements reads of different records (URLs) do NOT stale", !checkEvidence("Type is Select Box [E23.O1].", diffRec).failures.some((f) => f.kind === "stale-evidence"), JSON.stringify(checkEvidence("Type is Select Box [E23.O1].", diffRec).failures));
  const sameRec = [
    { id: "E1", tool: "query_elements", scope: { url: "https://x.service-now.com/item_option_new.do?sys_id=aaa" }, sequence: 1, success: true, truncated: false, observations: [{ path: "item_option_new.type.value", value: "5" }] },
    { id: "E2", tool: "query_elements", scope: { url: "https://x.service-now.com/item_option_new.do?sys_id=aaa" }, sequence: 2, success: true, truncated: false, observations: [{ path: "item_option_new.type.value", value: "2" }] }
  ];
  t("query_elements same-record re-read (same URL) DOES stale on change", checkEvidence("Type is Select Box [E1.O1].", sameRec).failures.some((f) => f.kind === "stale-evidence"));
}
{ // WEB PAGE TEXT is chunked into CITABLE observations (2026-07-20o, live BA2
  // a-live-run): fetch_page returned HN's top stories but the 500-char cap made
  // the body one uncitable truncated blob, so the model couldn't cite the stories.
  const body = "Hacker News. 1. Airport Simulator 156 points. 2. Foo 99 points. " + "x".repeat(1600); // ~1660 chars → multiple chunks
  const led = [];
  recordEvidence(led, "fetch_page", { url: "https://news.ycombinator.com" }, { url: "https://news.ycombinator.com/", title: "Hacker News", text: body, truncated: false });
  const textObs = (led[0].observations || []).filter((o) => o.path === "text" || /^text\.\d+$/.test(o.path));
  t("fetch_page long text is chunked into multiple observations", textObs.length >= 3, JSON.stringify(textObs.map((o) => o.path)));
  t("web text chunks are complete (NOT truncated) → citable", textObs.every((o) => !o.truncated));
  t("first chunk holds the page head (with the top story)", textObs[0] && /Airport Simulator 156 points/.test(textObs[0].value));
  const r = checkEvidence("The top story is Airport Simulator with 156 points [E1.O1].", led);
  t("citing a web text chunk does NOT fail truncated-evidence", !r.failures.some((f) => f.kind === "truncated-evidence"), JSON.stringify(r.failures));
  // A SHORT page (≤500) stays a single citable text obs (no regression).
  const shortLed = [];
  recordEvidence(shortLed, "fetch_page", { url: "https://x.com" }, { url: "https://x.com/", title: "X", text: "short body", truncated: false });
  t("short web text stays a single citable text obs", (shortLed[0].observations || []).some((o) => o.path === "text" && !o.truncated));
}

// Legacy freshness must skip truncated later observations (parity with obs-ID loop).
{
  const ledger = [
    { id: "E1", tool: "sn_fetch_script_by_sysid", scope: {}, sequence: 1, success: true, truncated: false,
      observations: [{ path: "script", value: "short body" }] },
    { id: "E2", tool: "sn_fetch_script_by_sysid", scope: {}, sequence: 2, success: true, truncated: false,
      observations: [{ path: "script", value: "different cut bo", truncated: true }] }
  ];
  const r = checkEvidence("The script [E1:script=short body]", ledger);
  t("truncated later obs cannot stale (legacy loop)", !r.failures.some((f) => f.kind === "stale-evidence"), JSON.stringify(r.failures));
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
