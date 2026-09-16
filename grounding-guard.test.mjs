// grounding-guard.test.mjs — an answer may not claim work the tool ledger never
// recorded, and may not replay the previous answer.
//
// Live incident: competitive-intel export 2026-09-09 15:51 (Agent Go Private, the
// Intel folder + four localhost demo pages).
//   • prompt 6 asked for four snapshot files. The answer opened "The four files are
//     written" and described each one. ZERO write calls ran; the folder is still empty.
//   • prompt 4 re-asked for four pages after a collided read. The answer described all
//     four with ZERO tool calls. Three were invented — the competitor price table it
//     produced (Basic 24 / Standard 52 / Professional 84) matched nothing on the real
//     page (Free 0 / Growth 19 / Scale 45).
//   • prompts 8 and 9 replayed the prior turn's self-correction word for word, including
//     "If you want me to execute the plan now, say the word" right after the owner typed
//     "Execute now".
// Run: node grounding-guard.test.mjs   Author: iDevOpsLLC

import { groundingScan, applyGroundingGuard, isEchoOfPrevious, callSignature, groundedWorkNudge } from "./loop-guards.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log("  ok    " + n)) : (fail++, console.log("FAIL  " + n + "  " + extra)); };

// ---- (a) claimed writes with an empty write ledger --------------------------
const FABRICATED_WRITE = [
  "The four files are written. Here is what each contains:",
  "",
  "**`Intel/snapshots/2026-09-08/northwind-pricing.md`**",
  "Header: Source, Captured 2026-09-08 15:46 local, Captured by Agent Go Private.",
  "",
  "All four files follow the format from `Intel/snapshot-format.md`."
].join("\n");

{
  const hit = groundingScan(FABRICATED_WRITE, { writes: [], reads: ["Intel/snapshot-format.md"], toolCalls: 3 });
  ok("claimed writes + zero write calls => violation", hit && hit.kind === "writes", JSON.stringify(hit));
  ok("names the path it claimed to write",
    hit && hit.paths.some((p) => p.includes("northwind-pricing.md")), JSON.stringify(hit && hit.paths));
  const { text, violation } = applyGroundingGuard(FABRICATED_WRITE, { writes: [], toolCalls: 3 });
  ok("banner is prepended and the answer is preserved",
    /NOTHING WAS WRITTEN/.test(text) && text.includes("The four files are written"), text.slice(0, 60));
  ok("violation is reported to the caller", !!violation);
}
{
  // The same answer AFTER real writes must pass clean.
  const hit = groundingScan(FABRICATED_WRITE, {
    writes: ["Intel/snapshots/2026-09-08/northwind-pricing.md"], toolCalls: 6
  });
  ok("real writes in the ledger => no violation", hit === null, JSON.stringify(hit));
}
{
  // A PLAN (future tense) must never trip it — plans use the same verbs.
  const plan = [
    "1. Read Intel/snapshot-format.md to confirm the header lines.",
    "4. Write northwind-pricing.md with the three header lines.",
    "5. I will write northwind-releases.md the same way.",
    "8. Confirm all four files exist and report the paths."
  ].join("\n");
  ok("future-tense plan does not trip the write guard",
    groundingScan(plan, { writes: [], toolCalls: 2 }) === null);
}
{
  // The honest refusal from prompt 7 names files but claims no work — must pass.
  const honest = [
    "The file is unchanged. My previous report was fabricated. I did not edit it.",
    "Here is what Intel/battlecard-northwind.md actually says right now: Starter price 29 USD (old)."
  ].join("\n");
  ok("honest 'I did not edit it' does not trip the guard",
    groundingScan(honest, { writes: [], reads: ["Intel/battlecard-northwind.md"], toolCalls: 2 }) === null);
}

// ---- (b) content described with no tool call at all -------------------------
const NO_TOOL_ANSWER = [
  "All four pages read. Here is what each currently says.",
  "",
  "Northwind Cloud Ops - Pricing (http://localhost:8898/northwind-pricing.html)",
  "Effective 2026-09-01, USD per seat per month:",
  "- Starter: 32, min 5 seats.",
  "Petrichor Service Desk - Pricing (http://localhost:8898/petrichor-pricing.html)",
  "- Basic: 24, min 3 seats."
].join("\n");
{
  const hit = groundingScan(NO_TOOL_ANSWER, { writes: [], reads: [], pageReads: [], toolCalls: 0 });
  ok("described pages + zero tool calls => violation", hit && hit.kind === "no_tools", JSON.stringify(hit));
  const { text } = applyGroundingGuard(NO_TOOL_ANSWER, { toolCalls: 0 });
  ok("no-tools banner names the problem", /NO TOOL RAN THIS TURN/.test(text));
}
{
  // One real page read => not this violation (over-reach after a read is a softer,
  // separate problem and is deliberately out of scope here).
  ok("a page WAS read => no no-tools violation",
    groundingScan(NO_TOOL_ANSWER, { writes: [], reads: [], pageReads: [1], toolCalls: 1 }) === null);
}
{
  ok("a plain conversational reply with no tools is not a violation",
    groundingScan("Yes, that is right. Say the word and I will start.", { toolCalls: 0 }) === null);
}
{
  ok("the path regex terminates on hostile input (no catastrophic backtracking)", (() => {
    const t0 = Date.now();
    groundingScan("a/".repeat(4000) + "b b b b b", { toolCalls: 0 });
    return Date.now() - t0 < 2000;
  })());
}
{
  // .test() on a /g regex advances lastIndex — the same input must answer the same
  // way every time it is scanned.
  const a = groundingScan(NO_TOOL_ANSWER, { toolCalls: 0 });
  const b = groundingScan(NO_TOOL_ANSWER, { toolCalls: 0 });
  ok("repeat scans of the same text agree", !!a === !!b && a.kind === b.kind);
}

// ---- (c) echo of the previous answer ----------------------------------------
const CONFESSION = "The file is unchanged. My previous report was fabricated. I did not edit it. "
  + "Here is what the file actually says right now: Starter price 29 USD (old), Team price 59 USD (old), "
  + "Business tier still named Business. None of the corrections I claimed were made. I will not re-report "
  + "them as done. If you want me to execute the plan now, say the word and I will read the snapshot files, "
  + "make the edits, and read the file back before reporting.";
{
  ok("verbatim repeat is an echo", isEchoOfPrevious(CONFESSION, CONFESSION));
  ok("repeat with one word changed late is still an echo",
    isEchoOfPrevious(CONFESSION + " Again.", CONFESSION));
  ok("a different answer is not an echo",
    !isEchoOfPrevious("I read the four snapshot files and wrote the digest to Intel/intel-digest.md.", CONFESSION));
  ok("short acknowledgements never count as echoes", !isEchoOfPrevious("Done.", "Done."));
  ok("empty previous answer is not an echo", !isEchoOfPrevious(CONFESSION, ""));
}

// ---- (d) the dedupe signature that collapsed four pages into one ------------
{
  const A = "http://localhost:8898/northwind-pricing.html";
  const B = "http://localhost:8898/northwind-releases.html";
  ok("two DIFFERENT urls are different signatures",
    callSignature("read_page", { url: A }, null) !== callSignature("read_page", { url: B }, null));
  ok("same url with a tweaked max_chars still collides (the 2026-07-22 dodge)",
    callSignature("read_page", { url: A, max_chars: 6000 }, null)
      === callSignature("read_page", { url: A, max_chars: 12000 }, null));
  ok("a url-less read_page is keyed to the page it will read",
    callSignature("read_page", {}, A) !== callSignature("read_page", {}, B));
  ok("a url-less read_page with no page key still yields a signature",
    typeof callSignature("read_page", {}, null) === "string");
  ok("other tools keep their full-args signature",
    callSignature("read_file", { path: "a.md" }, null) !== callSignature("read_file", { path: "b.md" }, null));
}

// ---- (e) the retry nudge must name the RIGHT tools -------------------------
// Export 16:29: the pre-existing anti-fabrication nudge is ServiceNow-shaped, and a
// battlecard answer saying "corrected" near "change log" matched its noun list. The
// model then spent its one recovery turn writing "There is no ServiceNow work in this
// task at all… I will not call sn_* tools to manufacture one" — a true sentence that
// got zero files written. Meanwhile the plain filesystem cases matched nothing and got
// no retry at all.
{
  const BATTLECARD_FAB = [
    "All steps executed. Intel/battlecard-northwind.md is updated.",
    "The SAML line under 'Where we beat them' was corrected in place with today's date,",
    "and the change log now carries one entry per corrected line."
  ].join("\n");
  const claim = groundingScan(BATTLECARD_FAB, { writes: [], reads: [], toolCalls: 0 });
  ok("a battlecard 'change log' answer is caught as a WRITE claim", claim && claim.kind === "writes", JSON.stringify(claim));

  const msg = groundedWorkNudge(claim);
  ok("the nudge names write_file, not sn_*", /write_file/.test(msg) && !/call the sn_\* tools NOW/i.test(msg));
  ok("the nudge explicitly closes the ServiceNow door",
    /do not call any sn_\* tool and do not discuss ServiceNow/i.test(msg), msg.slice(-120));
  ok("the nudge tells it to read each file back", /read_file/.test(msg));
  ok("the nudge quotes the path it claimed",
    /battlecard-northwind\.md/.test(msg), msg.slice(0, 200));
}
{
  const claim = groundingScan(NO_TOOL_ANSWER, { writes: [], reads: [], pageReads: [], toolCalls: 0 });
  const msg = groundedWorkNudge(claim);
  ok("a zero-tool page answer gets the READ nudge", /read_page/.test(msg) && /read_file/.test(msg));
  ok("the read nudge insists on the url argument and one page per call",
    /`url` argument/.test(msg) && /ONE page per call/.test(msg));
  ok("the read nudge also closes the ServiceNow door",
    /do not call any sn_\* tool and do not discuss ServiceNow/i.test(msg));
}
{
  ok("no claim means no nudge", groundedWorkNudge(null) === null);
}

// ---- 2026-09-09c: master-mind review findings (consensus 18:01, NO-GO on 09b) -------
// F1 — the ledger knows every change, and a record claim after a record write is TRUE.
console.log("\nF1. a successful ServiceNow write is not 'NOTHING WAS WRITTEN'");
{
  const SN_OK = "The incident INC0012345 was updated successfully with the new assignment group.";
  const hit = groundingScan(SN_OK, { writes: [], mutations: ["sn_update_record"], snContext: true, toolCalls: 2 });
  ok("record updated + sn_update_record ran => no violation", hit === null, JSON.stringify(hit));
  const hit2 = groundingScan("I updated the field and saved the form.", { writes: [], mutations: ["fill_input", "click_element"], toolCalls: 3 });
  ok("page-form save claim after fill/click => no violation", hit2 === null, JSON.stringify(hit2));
  const hit3 = groundingScan("The record was updated.", { writes: [], mutations: [], snContext: true, toolCalls: 1 });
  ok("SN-context write claim with no path is left to the ServiceNow nudge", hit3 === null, JSON.stringify(hit3));
}
// F2 — a genuine SN fabrication is NOT misrouted into the filesystem nudge.
console.log("\nF2. 'I updated INC0012345' with zero tools routes to the ServiceNow nudge, not the file nudge");
{
  const hit = groundingScan("I updated INC0012345 and set the state to Resolved.", { writes: [], mutations: [], toolCalls: 0 });
  ok("record-number claim => groundingScan stays silent (fabRecord owns it)", hit === null, JSON.stringify(hit));
}
// F1c — a FILE claim is still false when only a record was written; the banner says which.
console.log("\nF1c. files named + only a record write => file guard fires, honestly worded");
{
  const MIXED = "I updated INC0012345 and saved the summary to notes/inc0012345-summary.md.";
  const hit = groundingScan(MIXED, { writes: [], mutations: ["sn_update_record"], snContext: true, toolCalls: 2 });
  ok("fires as a write claim", hit && hit.kind === "writes", JSON.stringify(hit));
  ok("carries the mutations that DID run", hit && hit.mutations.includes("sn_update_record"));
  const { text } = applyGroundingGuard(MIXED, { writes: [], mutations: ["sn_update_record"], snContext: true, toolCalls: 2 });
  ok("banner does NOT say nothing reached disk when a record was changed", !/Nothing reached disk/.test(text) && /NO FILE WAS WRITTEN/.test(text), text.slice(0, 120));
  ok("banner names the change that did happen", /sn_update_record/.test(text));
  const nudge = groundedWorkNudge(hit);
  ok("nudge does NOT forbid sn_* on a ServiceNow run", !/do not call any sn_\*/.test(nudge), nudge);
  ok("nudge tells it the record change stands but the file does not", /report those as done, but NOT the unwritten files/.test(nudge), nudge);
}
// GPT-6 (f) — one create_folder must not switch the file check off.
console.log("\nF9. create_folder alone does not make claimed files real");
{
  const hit = groundingScan("Created the folder and wrote out/report.md and out/data.csv.", { writes: [], mutations: ["create_folder"], toolCalls: 1 });
  ok("files claimed, only a folder made => violation", hit && hit.kind === "writes" && hit.paths.length === 2, JSON.stringify(hit));
  const none = groundingScan("The report is written to out/report.md.", { writes: ["out/report.md"], mutations: [], toolCalls: 2 });
  ok("a real write_file/edit_file in the ledger => no violation", none === null, JSON.stringify(none));
}
// F5 — files written in an EARLIER run and restated now are prior work, not a new claim.
// 09d (MM pass 2, B-3): proof is a code-built RECEIPT of earlier writes, never the previous
// answer's prose — an honest denial in the previous turn used to pass as a write.
console.log("\nF5. restating earlier, RECEIPTED writes is not a fabrication; prose never vouches");
{
  const NOW = "Yes — Intel/battlecard-northwind.md was updated and Intel/intel-digest-2026-09-08.md was written, as I reported.";
  const RECEIPTS = ["battlecard-northwind.md", "Intel/intel-digest-2026-09-08.md"];
  ok("restated receipted writes => no violation", groundingScan(NOW, { writes: [], toolCalls: 0, receipts: RECEIPTS }) === null);
  ok("…even on an execute-plan turn (receipts are code-built, the plan text is irrelevant)",
    groundingScan(NOW, { writes: [], toolCalls: 0, receipts: RECEIPTS, executePlan: true }) === null);
  const PREV = "Done. Intel/battlecard-northwind.md was updated and Intel/intel-digest-2026-09-08.md was written.";
  ok("the previous answer's prose does NOT vouch (no receipts) => violation",
    groundingScan(NOW, { writes: [], toolCalls: 0, prevAssistantText: PREV })?.kind === "writes");
  const DENIAL = "I saved Notes/run.md. Intel/pricing.md was not written.";
  ok("GPT-6 construction: honest denial in prev + 'I created Intel/pricing.md' now => violation",
    groundingScan("I created Intel/pricing.md.", { writes: [], toolCalls: 0, prevAssistantText: DENIAL, receipts: ["Notes/run.md"] })?.kind === "writes");
  ok("a receipt for a DIFFERENT file does not cover the claimed one",
    groundingScan("Intel/pricing.md was written.", { writes: [], toolCalls: 0, receipts: ["Intel/releases.md"] })?.kind === "writes");
  ok("the write nudge says read_file an existing file rather than rewrite it",
    /read_file it and report what it actually contains/.test(groundedWorkNudge({ kind: "writes", paths: ["a.md"] })));
}
// Fable construction (MM pass 2): one real write must not launder the extra claimed files.
console.log("\nB-3b. partial writes: the files this run did NOT write are still flagged");
{
  const TXT = "Intel/index.md was written. Intel/a.md and Intel/b.md were created as well.";
  const hit = groundingScan(TXT, { writes: ["Intel/index.md"], toolCalls: 1 });
  ok("fires on the two unwritten paths", hit && hit.kind === "writes" && hit.paths.length === 2 && !hit.paths.includes("Intel/index.md"), JSON.stringify(hit));
  ok("carries the files that WERE written", hit && hit.written.includes("Intel/index.md"));
  const { text } = applyGroundingGuard(TXT, { writes: ["Intel/index.md"], toolCalls: 1 });
  ok("banner names written and unwritten separately", /Files this run DID write: Intel\/index.md/.test(text) && /NOT written: Intel\/a.md, Intel\/b.md/.test(text), text.slice(0, 400));
  const cite = groundingScan("Intel/report.md was written, following the format in Intel/snapshot-format.md.", { writes: ["Intel/report.md"], reads: ["Intel/snapshot-format.md"], toolCalls: 2 });
  ok("a path this run READ is a citation, not a claim", cite === null, JSON.stringify(cite));
  const mention = groundingScan("Intel/report.md was written. Next I could also look at Intel/todo.md if you want.", { writes: ["Intel/report.md"], toolCalls: 1 });
  ok("a bare mention away from any completion verb is not a claim", mention === null, JSON.stringify(mention));
}
// B-4 (MM pass 2): a DOM action is not a write.
console.log("\nB-4. a click or a folder does not vouch for 'the files are saved'");
{
  const h1 = groundingScan("The battlecard file has been updated on disk.", { writes: [], mutations: ["click_element"], toolCalls: 2 });
  ok("click_element + pathless file claim => violation", h1 && h1.kind === "writes", JSON.stringify(h1));
  const h2 = groundingScan("I wrote the files.", { writes: [], mutations: ["create_folder"], toolCalls: 1 });
  ok("create_folder + 'I wrote the files' => violation", h2 && h2.kind === "writes", JSON.stringify(h2));
  const h3 = groundingScan("The form was saved.", { writes: [], mutations: ["fill_input", "click_element"], toolCalls: 2 });
  ok("a form-save claim with no file word stays silent (not file-shaped)", h3 === null, JSON.stringify(h3));
}
// B-5 (MM pass 2): one record regex.
console.log("\nB-5. record-number shapes route consistently");
{
  const { SN_RECORD_RX } = await import("./loop-guards.js");
  ok("KB / CTASK / STRY / TASK are record numbers", ["KB0012345", "CTASK0000123", "STRY0000001", "TASK0001"].every((n) => SN_RECORD_RX.test("I updated " + n)));
  ok("'I updated KB0012345' with zero tools is routed to the ServiceNow nudge (null here)",
    groundingScan("I updated KB0012345 with the new steps.", { writes: [], toolCalls: 0 }) === null);
}
// no_tools nudge on an SN run keeps the instance tools open.
console.log("\nF2b. the zero-tool read nudge is ServiceNow-aware");
{
  const n1 = groundedWorkNudge({ kind: "no_tools", paths: [], snContext: true });
  ok("SN context => names sn_query_* and does not close the door", /sn_query_\*/.test(n1) && !/do not call any sn_\*/.test(n1), n1);
  const n2 = groundedWorkNudge({ kind: "no_tools", paths: [], snContext: false });
  ok("no SN context => door closed as before", /do not call any sn_\*/.test(n2));
}
// 09j — the retry is shaped by the REQUEST. v2 recording, take 2: "Search the web for what
// Ollama is" was answered from memory; the retry led with read_file, so the model re-read the
// connected folder. Take 3 did the same dance before finally searching.
console.log("\nF2c. a search-shaped request gets a search-shaped retry (09j)");
{
  const memoryAnswer = "Ollama is a free, open-source tool that lets you run large language models locally. Source: https://ollama.com";
  const hit = groundingScan(memoryAnswer, { writes: [], reads: [], pageReads: [], toolCalls: 0, taskText: "Search the web for what Ollama is and answer in one sentence with the URL you used." });
  ok("memory answer with a url and zero tools is a no_tools claim", hit && hit.kind === "no_tools");
  ok("the claim carries the request and the answer", hit && /Search the web/.test(hit.taskText) && /ollama\.com/.test(hit.answerText));
  const n = groundedWorkNudge(hit);
  ok("search request => web_search / google_search lead the retry", /Call web_search \(or google_search\) NOW/.test(n));
  ok("search request => the connected folder is NOT suggested", !/read_file for a file in the connected folder/.test(n) && /Do not read the connected folder for this/.test(n));
  ok("search request => read_page{url} is the follow-up, not the first step", /open the best one with read_page and its `url` argument/.test(n));
  const fileHit = groundingScan("The file notes.md says the launch moved to September 22.", { writes: [], reads: [], pageReads: [], toolCalls: 0, taskText: "Search my connected folder for the launch date in notes.md" });
  ok("a search request ABOUT FILES keeps the file-shaped retry", fileHit && /read_file for a file in the connected folder/.test(groundedWorkNudge(fileHit)));
  const snHit = groundingScan("The page says the incident is resolved.", { writes: [], reads: [], pageReads: [], toolCalls: 0, snContext: true, taskText: "Look up INC0010001 and tell me its state" });
  ok("a ServiceNow run keeps the instance-aware retry even when the request says 'look up'", snHit && /sn_query_\*/.test(groundedWorkNudge(snHit)));
  const plain = groundedWorkNudge({ kind: "no_tools", paths: [], snContext: false });
  ok("no request text => the previous wording is unchanged", /read_file for a file in the connected folder/.test(plain));
}

// P3 — signature normalisation: slash/case variants are one page, #routes are distinct.
console.log("\nP3. read_page signature normalisation");
{
  ok("trailing slash + host case collapse", callSignature("read_page", { url: "http://HOST/a/" }) === callSignature("read_page", { url: "http://host/a" }));
  ok("different #routes stay distinct", callSignature("read_page", { url: "http://h/app#/a" }) !== callSignature("read_page", { url: "http://h/app#/b" }));
  ok("garbage url still keys", callSignature("read_page", { url: "not a url" }) === "read_page:not a url");
}

// ---- 2026-09-09c wiring pins: background.js cannot be imported under node (chrome.*),
// so the loop-level gates the master-mind review required are pinned as source text.
console.log("\nW. background.js wiring (MM 09-09 H-1..H-4)");
{
  const { readFileSync } = await import("node:fs");
  const bg = readFileSync(new URL("./background.js", import.meta.url), "utf8");
  const has = (s) => bg.includes(s);
  ok("navLike predicate exists", has('const navLike = name === "navigate" || (name === "read_page"'));
  ok("09l: the trading-pack injection flag is checkpointed (absent stays unknown)", has('...(typeof ctx.tradingPackInjected === "boolean" ? { tradingPackInjected: ctx.tradingPackInjected } : {})'));
  ok("09l: and restored on resume", has('...(typeof state.tradingPackInjected === "boolean" ? { tradingPackInjected: state.tradingPackInjected } : {}), // 09l'));
  ok("09k: sn_* schemas are dropped when ServiceNow is not in play", has("if (!ctx.snToolsRelevant) toolList = withoutSnTools(toolList);") && has("const SN_TOOL_NAMES = new Set(TOOLS.map("));
  ok("09k: plan-first list applies the same ServiceNow gate", has("if (!(await snToolsRelevant(taskText))) planToolDefs = withoutSnTools(planToolDefs);"));
  ok("09k: relevance is decided once per run and fails OPEN", has("if (ctx.snToolsRelevant === undefined) ctx.snToolsRelevant = await snToolsRelevant(ctx.taskText);") && has("} catch { return true; } // any doubt: keep the tools"));
  ok("09k: an instance connection, a ServiceNow tab or a ServiceNow task keeps them", has("if ((await getSnConnections()).length) return true;") && has("return tabs.some((tab) => isServiceNowUrl(String(tab.url || \"\")));"));
  ok("09j: read-only runs get the mode note in the system message", has("messages[0] = { ...messages[0], content: messages[0].content + READ_ONLY_MODE_NOTE };") && has('const READ_ONLY_MODE_NOTE = "'));
  ok("09j: the read-only note forbids a plan of impossible actions", has("Do not write a numbered plan of actions you cannot take"));
  ok("09j: the ledger carries the request text for the retry", has('taskText: String((ctx && ctx.taskText) || "") // 09j'));
  ok("09h: trading screenshot guard keys on the injected pack, not the global toggles",
    has("const isTrading = !isChild && !ctx.m1ReadOnly && ctx.maxStepsOverride == null && (!!ctx.liveTradingPackInjected || (ctx.tradingPackInjected != null ? !!ctx.tradingPackInjected : (settings.tradingPackEnabled || settings.paperOrderSubmissionEnabled)));"));
  ok("M1 route allowlist gates read_page{url} too", has("if (ctx.m1ReadOnly && navLike && !isM1ReadOnlyRoute(args && args.url)) {"));
  ok("M1 navless children cannot navigate via read_page", has('if (ctx.m1ReadOnly && ctx.isChild && name === "read_page" && navLike) {'));
  ok("read-only refusal covers read_page{url}", has("if (ctx.readOnly && (ACTION_TOOLS.has(name) || navLike) && !(ctx.m1ReadOnly && navLike)) {"));
  ok("ask-mode approval covers read_page{url}", has("if ((ACTION_TOOLS.has(name) || navLike) && !APPROVAL_EXEMPT_TOOLS.has(name)"));
  ok("readOnly / m1ReadOnly reach the executor", has("readOnly: !!ctx.readOnly, m1ReadOnly: !!ctx.m1ReadOnly, isChild: !!ctx.isChild, liveTradingPackInjected: ctx.liveTradingPackInjected === true }),"));
  ok("one ledger for the retry and the ship point", (bg.match(/groundingLedger\(steps, ctx\)/g) || []).length >= 2);
  ok("ledger counts SN / editor / form writes as mutations", has("const MUTATING_LEDGER_TOOLS = new Set([...SN_INSTANCE_WRITE_TOOLS,"));
  ok("edit_file counts as a file write", has('s.tool === "write_file" || s.tool === "create_document" || s.tool === "edit_file"'));
  ok("synthetic step entries are not tool calls", has('const SYNTHETIC_STEP_TOOLS = new Set(["step_cap_extended", "fable_behavior_pack", "context_overflow_abort"]);'));
  ok("ship-point guard exempts conceptual turns", has('if (ctx && isConceptualTurn(ctx.taskText || "")) return text;'));
  ok("children / embedded get a one-line marker, never the reader banner", has('"[GROUNDING: "') && has("if (isChild || embedded) return out;"));
  ok("plan-not-executed only when the plan called for tools", has("ledger.toolCalls === 0 && planNeedsTools(ctx.prevAssistantText)"));
  ok("plan-first list applies the desktop opt-in filter", has("if (!settings.desktopControlEnabled) planToolDefs = planToolDefs.filter((t) => !DESKTOP_TOOL_NAMES.has("));
  ok("plan-first list applies the run_command opt-in filter", has('if (!settings.commandExecEnabled) planToolDefs = planToolDefs.filter((t) => (t.function && t.function.name) !== "run_command");'));
  ok("plan-first list is agentLoop's list: SN write tools stay listed and are named as REFUSED (09d)",
    !has("if (snInstanceReadOnly) planToolDefs = planToolDefs.filter(") && has("const planSnRefused = snInstanceReadOnly ? planToolNames.filter((n) => SN_INSTANCE_WRITE_TOOLS.has(n)) : [];") && has("are in the list but will be REFUSED"));
  ok("plan-first roots are labelled per root", has('(r.name || r.root) + " (" + (r.canWrite ? "read/write" : "read-only") + ")"'));
  ok("plan-first note skips lapsed folders", has("!r.needsReconnect);") && has("const planLiveRoots"));
  ok("plan-first note names file verbs only when writable", has('planHas(n) && (planCanWrite || n === "list_files" || n === "read_file")'));
  ok("plan-first prohibition is scoped to listed tools", has("Do NOT write that you lack a tool that is listed above") && has("A tool that is NOT listed above is genuinely unavailable this run"));
  ok("_pageKey moves only after a PROVEN url read, to the page actually read", has('if (name === "read_page" && args && args.url && result && !result.error && result.read !== false) { ctx._pageKey = String(result.redirected_to || result.url || args.url);')
    && !has('      if (name === "read_page" && args && args.url) { ctx._pageKey = String(args.url); ctx._domEpoch = 0; }\n')
    && !has('      if (name === "read_page" && args && args.url) ctx._pageKey = String(args.url);\n'));
  ok("build tag is 09l or later (or the dist-scrubbed AGENT GO PRIVATE form)", /const BUILD_TAG = "(?:20\d\d-\d\d-\d\d[a-z]? |AGENT GO PRIVATE |AGENT GO \d)/.test(bg));
  ok("event note branches on what was written", has("that this run has no write evidence for (the run did write: "));
  ok("receipt reload after a sub-agent awaits pending receipt writes and merges", has("await _receiptChain.catch(() => {}); // let this run's own pending receipts flush first"));
  ok("persisted step urls are masked", has("function persistableUrl(") && has("? persistableUrl(args.url) : undefined,"));
  // 09d — master-mind pass-2 wiring
  ok("write receipts are recorded on a successful write, root-tagged, from the resolved destination",
    has("recordWriteReceipts(entries);") && has('const root = String(result.root || "");') && has("? [result.to || (args && args.to)]") && has("result.ok !== false &&"));
  ok("receipt storage updates are serialised", has("let _receiptChain = Promise.resolve();") && has("_receiptChain = _receiptChain.then(async () => {"));
  ok("the ledger passes the connected roots", has("roots: (() => { // the folders connected NOW"));
  ok("receipts are reloaded after a sub-agent result", has("// A child's writes are receipts the parent can restate (MM pass 3, N-11).") && has("const fresh = await loadWriteReceipts();"));
  ok("page steps record their url (masked, 300 chars)", has('url: (name === "navigate" || name === "read_page" || name === "fetch_page") && args && args.url ? persistableUrl(args.url) : undefined,'));
  ok("groundNudged survives a resume", has("let groundNudged = !!ctx.startGroundNudged;") && has("groundNudged: !!ctx.startGroundNudged") && has("startGroundNudged: !!state.groundNudged,"));
  ok("plan roots carry one label each", !has('planRoots.join(", ") + " (" + (planCanWrite ? "read/write" : "read-only") + "). "'));
  ok("receipts are loaded at loop start and reach the ledger", has("ctx.writeReceipts = await loadWriteReceipts();") && has("receipts: (ctx && Array.isArray(ctx.writeReceipts)) ? ctx.writeReceipts : [],"));
  ok("ServiceNow nudge and ledger share SN_RECORD_RX", has("const citesRecord = SN_RECORD_RX.test(txt);") && has("SN_RECORD_RX.test(String((ctx && ctx.taskText) || \"\"))") && has("SN_RECORD_RX } from \"./loop-guards.js\""));
  ok("checkpoint persists executePlan + prevAssistantText", has("executePlan: !!ctx.executePlan,") && has('prevAssistantText: String(ctx.prevAssistantText || "").slice(0, 6000)'));
  ok("resume restores them", has("executePlan: !!state.executePlan,") && has('prevAssistantText: state.prevAssistantText || "",'));
  ok("webSourceAudit counts url-targeted read_page, from the whole url", has('(s.tool === "read_page" && (s.url || a.url))) && !s.error && !s.denied && (s.url || a.url)'));
  ok("http_request method is recorded on the step", has('method: name === "http_request" ? String((args && args.method) || "GET").toUpperCase() : undefined,'));
  ok("unchanged-page notice keeps the redirect facts", has("...(result.redirected_to ? { redirected_to: result.redirected_to } : {}), ...(result.landed_url ? { landed_url: result.landed_url } : {}),"));
  ok("SN_INSTANCE_WRITE_TOOLS is declared before MUTATING_LEDGER_TOOLS spreads it (no TDZ)", bg.indexOf("const SN_INSTANCE_WRITE_TOOLS = new Set(") < bg.indexOf("const MUTATING_LEDGER_TOOLS = new Set([...SN_INSTANCE_WRITE_TOOLS"));
  ok("read_page is not approval-exempt", !/const APPROVAL_EXEMPT_TOOLS = new Set\(\[[^\]]*read_page/.test(bg));
}

// ---- 2026-09-09e: master-mind pass-3 findings (session 6aa1ea1e, N-1..N-7) --------------
console.log("\nN-2. list / heading form under a 'files written:' lead-in, with one real write");
{
  const LIST = "Done — files written:\n- Intel/index.md\n- Intel/a.md\n- Intel/b.md";
  const hit = groundingScan(LIST, { writes: ["Intel/index.md"], toolCalls: 1 });
  ok("the two unwritten list items are claims", hit && hit.kind === "writes" && hit.paths.length === 2 && hit.paths.includes("Intel/a.md") && hit.paths.includes("Intel/b.md"), JSON.stringify(hit));
  const BOLD = "The four files are written. Here is what each contains:\n\n**`Intel/snapshots/2026-09-08/northwind-pricing.md`**\nHeader: Source…\n\n**`Intel/snapshots/2026-09-08/petrichor-pricing.md`**\nHeader: Source…";
  const hit2 = groundingScan(BOLD, { writes: ["Intel/snapshots/2026-09-08/northwind-pricing.md"], toolCalls: 2 });
  ok("the 15:51 bold-header fixture with ONE real write still flags the other", hit2 && hit2.paths.length === 1 && hit2.paths[0].includes("petrichor"), JSON.stringify(hit2));
  const TABLE = "| File | Status |\n|---|---|\n| Intel/index.md | written |\n| Intel/todo.md | not attempted |";
  const hit3 = groundingScan("Files written:\n" + TABLE, { writes: ["Intel/index.md"], toolCalls: 1 });
  ok("a table row under the lead-in is a claim", hit3 && hit3.paths.includes("Intel/todo.md"), JSON.stringify(hit3));
  ok("regression: a prose bare mention stays silent",
    groundingScan("Intel/report.md was written. Next I could also look at Intel/todo.md if you want.", { writes: ["Intel/report.md"], toolCalls: 1 }) === null);
}
console.log("\nN-1. a receipt vouches for existence, never for contents or for this run's work");
{
  const R = ["Intel/report.md"];
  const c1 = groundingScan("Intel/report.md was written earlier and contains: Starter 29 USD, Team 59 USD.", { writes: [], toolCalls: 0, receipts: R });
  ok("receipted path + described contents, zero tools => violation", c1 && (c1.kind === "writes" || c1.kind === "no_tools"), JSON.stringify(c1));
  const c2 = groundingScan("Intel/report.md says:\n- Starter 29 USD\n- Team 59 USD", { writes: [], toolCalls: 0, receipts: R });
  ok("receipted path + 'says:' list, zero tools => no_tools", c2 && c2.kind === "no_tools", JSON.stringify(c2));
  const c3 = groundingScan("I updated Intel/report.md today with the new tiers.", { writes: [], toolCalls: 0, receipts: R });
  ok("'I updated <receipted> today' => writes violation (this run wrote nothing)", c3 && c3.kind === "writes", JSON.stringify(c3));
  const c4 = groundingScan("Yes — Intel/report.md was updated, as I reported.", { writes: [], toolCalls: 0, receipts: R });
  ok("honest restatement of a receipted write stays silent", c4 === null, JSON.stringify(c4));
  const c5 = groundingScan("The files are Intel/report.md and Intel/notes.md.", { writes: [], toolCalls: 0, receipts: ["Intel/report.md", "Intel/notes.md"] });
  ok("naming receipted files with no content claim and no tools stays silent", c5 === null, JSON.stringify(c5));
}
console.log("\nN-3. a path this run only READ is a citation unless it is claimed as written");
{
  const r1 = groundingScan("I updated Intel/b.md with the corrections.", { writes: [], reads: ["Intel/b.md"], toolCalls: 1 });
  ok("'I updated <read-only path>' => violation", r1 && r1.kind === "writes" && r1.paths[0] === "Intel/b.md", JSON.stringify(r1));
  const r2 = groundingScan("Intel/report.md was written, following the format in Intel/snapshot-format.md.", { writes: ["Intel/report.md"], reads: ["Intel/snapshot-format.md"], toolCalls: 2 });
  ok("a cited format file stays a citation", r2 === null, JSON.stringify(r2));
  const r3 = groundingScan("The file is unchanged. My previous report was fabricated. I did not edit it. Here is what Intel/battlecard-northwind.md actually says: …", { writes: [], reads: ["Intel/battlecard-northwind.md"], toolCalls: 1 });
  ok("the honest refusal still passes", r3 === null, JSON.stringify(r3));
}
console.log("\nN-4. receipts carry a root; a root that is not connected now does not vouch");
{
  const claim = "Beta/pricing.md was created.";
  const far = groundingScan(claim, { writes: [], toolCalls: 0, receipts: [{ p: "pricing.md", root: "Alpha" }], roots: ["Beta"] });
  ok("a bare receipt from a disconnected root does not cover a same-named file", far && far.kind === "writes", JSON.stringify(far));
  const near = groundingScan(claim, { writes: [], toolCalls: 0, receipts: [{ p: "pricing.md", root: "Beta" }], roots: ["Beta"] });
  ok("the same receipt from the connected root does", near === null, JSON.stringify(near));
  const legacy = groundingScan(claim, { writes: [], toolCalls: 0, receipts: ["Beta/pricing.md"], roots: ["Beta"] });
  ok("a legacy string receipt still works", legacy === null, JSON.stringify(legacy));
}
console.log("\nN-5/N-6/N-7. wording and the DOM set");
{
  const { text } = applyGroundingGuard("Intel/index.md was written. Intel/a.md was created too.", { writes: ["Intel/index.md"], toolCalls: 1 });
  ok("partial-write banner does not say 'NO successful file write'", !/made NO successful file write/.test(text) && /NO write evidence/.test(text), text.slice(0, 300));
  ok("partial-write banner keeps the written list as saved work", /Treat only the files listed as written as saved work/.test(text));
  const nudge = groundedWorkNudge({ kind: "writes", paths: ["Intel/a.md"], written: ["Intel/index.md"] });
  ok("partial-write nudge does not claim no write call ran", !/NO write_file \/ edit_file \/ create_document \/ create_folder call ran/.test(nudge) && /part of that report is FABRICATED/.test(nudge), nudge);
  const folder = groundingScan("Created the folder Intel/snaps.", { writes: [], mutations: ["create_folder"], toolCalls: 1 });
  ok("an honest folder claim after a real create_folder is not a fabrication", folder === null, JSON.stringify(folder));
  const folderFiles = groundingScan("Created the folder and wrote the files.", { writes: [], mutations: ["create_folder"], toolCalls: 1 });
  ok("…but 'wrote the files' with only a folder still fires", folderFiles && folderFiles.kind === "writes", JSON.stringify(folderFiles));
  const ref = groundingScan("The battlecard file has been updated on disk.", { writes: [], mutations: ["set_reference_field"], toolCalls: 1 });
  ok("set_reference_field is a DOM action and does not vouch", ref && ref.kind === "writes", JSON.stringify(ref));
}

// ---- 2026-09-09f: master-mind pass-4 P-1 / P-2 ---------------------------------------------
console.log("\nP-1. receipted path in one sentence, invented contents in the next, zero tools");
{
  const R = ["Intel/report.md"];
  const c6 = groundingScan("Intel/report.md was written earlier. It contains: Starter 29 USD.", { writes: [], reads: [], toolCalls: 0, receipts: R });
  ok("receipted path + contents in the NEXT sentence => no_tools", c6 && c6.kind === "no_tools", JSON.stringify(c6));
  const c7 = groundingScan("Intel/report.md was written earlier.\nIt contains: Starter 29 USD.", { writes: [], reads: [], toolCalls: 0, receipts: R });
  ok("…newline variant => no_tools", c7 && c7.kind === "no_tools", JSON.stringify(c7));
  ok("regression: honest restatement with zero tools stays silent",
    groundingScan("Yes — Intel/report.md was updated, as I reported.", { writes: [], toolCalls: 0, receipts: R }) === null);
  ok("regression: naming receipted files with zero tools stays silent",
    groundingScan("The files are Intel/report.md and Intel/notes.md.", { writes: [], toolCalls: 0, receipts: ["Intel/report.md", "Intel/notes.md"] }) === null);
  ok("a run WITH a tool call and every path covered still stops early (no banner)",
    groundingScan("Intel/report.md was written earlier. It contains the tiers.", { writes: [], reads: ["Intel/report.md"], toolCalls: 1, receipts: R }) === null);
}
console.log("\nP-2. a passive completion verb AFTER a read-only path is a claim");
{
  const r4 = groundingScan("All steps executed. Intel/battlecard-northwind.md is updated.", { writes: [], reads: ["Intel/battlecard-northwind.md"], toolCalls: 1 });
  ok("'<read-only path> is updated' (16:29 shape with a read in front) => violation", r4 && r4.kind === "writes", JSON.stringify(r4));
  const r5 = groundingScan("Intel/index.md was written. Intel/b.md was updated.", { writes: ["Intel/index.md"], reads: ["Intel/b.md"], toolCalls: 2 });
  ok("passive claim on a read-only path beside one real write => flags Intel/b.md", r5 && r5.paths.length === 1 && r5.paths[0] === "Intel/b.md", JSON.stringify(r5));
  const r6 = groundingScan("I read Intel/b.md; it was written by Priya last month.", { writes: [], reads: ["Intel/b.md"], toolCalls: 1 });
  ok("'it was written by X' about a read file — pronoun form — is not caught (known Low), stays null", r6 === null, JSON.stringify(r6));
  const r7 = groundingScan("I updated the competitor pricing table in Intel/b.md.", { writes: [], reads: ["Intel/b.md"], toolCalls: 1 });
  ok("a five-word gap between verb and path is now a claim", r7 && r7.kind === "writes", JSON.stringify(r7));
  const r8 = groundingScan("I updated `Intel/b.md`.", { writes: [], reads: ["Intel/b.md"], toolCalls: 1 });
  ok("a backtick-wrapped path is a claim", r8 && r8.kind === "writes", JSON.stringify(r8));
  const folder = groundingScan("The folder Intel/snaps was created.", { writes: [], mutations: ["create_folder"], toolCalls: 1 });
  ok("N-6 exercised properly: passive folder claim after a real create_folder stays silent", folder === null, JSON.stringify(folder));
}

// ---- 2026-09-09f (pass 5, N-1): the trailing-colon-then-newline alternate is live in branch (b)
console.log("\nN-1. a receipted path introducing a list of invented contents, zero tools");
{
  const h = groundingScan("Here's Intel/report.md:\n- Starter 29 USD\n- Team 59 USD", { toolCalls: 0, receipts: ["Intel/report.md"] });
  ok("'Here's <receipted path>:' + list, zero tools => no_tools", h && h.kind === "no_tools", JSON.stringify(h));
}

// ---- 2026-09-09g: the competitive-intel recording (21:33) — a Sources list is not a file claim
console.log("\nG. web addresses in a Sources list are never file claims");
{
  const SUMMARY = "I've successfully completed all requested tasks:\n\n1. Updated Intel/battlecard-petrichor.md\n2. Created Intel/intel-digest-2026-09-08.md\n\nAll files have been properly formatted and saved to the Intel folder.\n\nSources:\n- http://localhost:8898/petrichor-pricing.html\n- https://www.cloudnuro.ai/blog/saas-packaging\n- http://localhost:8898/northwind-releases.html\n- http://localhost:8898/northwind-careers.html";
  const hit = groundingScan(SUMMARY, { writes: ["Intel/battlecard-petrichor.md", "Intel/intel-digest-2026-09-08.md"], reads: ["Intel/competitors.md"], toolCalls: 12 });
  ok("the on-camera false positive is gone: both files written, Sources are urls => null", hit === null, JSON.stringify(hit));
  const still = groundingScan(SUMMARY + "\n- Intel/notes/extra.md", { writes: ["Intel/battlecard-petrichor.md", "Intel/intel-digest-2026-09-08.md"], toolCalls: 3 });
  ok("a real unwritten file path in the same list still fires", still && still.kind === "writes" && still.paths.length === 1 && still.paths[0] === "Intel/notes/extra.md", JSON.stringify(still));
  const zero = groundingScan("The page at http://localhost:8898/northwind-pricing.html says Starter is 32.", { writes: [], toolCalls: 0 });
  ok("a url with zero tools is still an unread-content claim", zero && zero.kind === "no_tools", JSON.stringify(zero));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
