// loop-guards.js — wording for the agent loop's repeat refusals (2026-09-07c; grounding 2026-09-09c).
// Pure (no chrome.*) so it is unit-testable: node pdf-folder-ocr.test.mjs
//
// Why this exists: the Records-folder run (export 2026-09-07 17:32) called
// read_pdf with a connected-folder path that the tool then rejected; the
// LOOP BREAKER and the CYCLE BREAKER in background.js counted those FAILED
// calls like successful reads and told the model "you are re-fetching content
// you already read (the earlier copy was trimmed from context)". Nothing had
// been read. A refusal must say what actually happened.
// Author: iDevOpsLLC

// CONSECUTIVE-CALL SIGNATURE (2026-09-09). read_page used to collapse to the bare
// string "read_page" so that a model could not dodge the loop breaker by tweaking
// max_chars between identical re-reads (2026-07-22 dashboard transcript, 9 calls to
// open one folder). That also made four reads of four DIFFERENT pages look like one
// repeated call: the competitive-intel run (export 2026-09-09 15:51) was told "you
// have ALREADY called read_page with these exact arguments" about pages it had never
// opened, and invented all three of them. Keep the url, drop max_chars — same page
// with a tweaked cap still collides, different pages never do. A url-less read_page
// is keyed to the page it will read.
// 2026-09-09c: the key is normalised the way sameHttpUrl compares (host case, trailing
// slash) so "HOST/a/" and "host/a" are one page; the #fragment is KEPT because on a
// hash-routed SPA it is the route, and two routes must never collapse into one call.
export function normalizeUrlKey(u) {
  const s = String(u == null ? "" : u).trim();
  try {
    const U = new URL(s);
    const path = U.pathname.length > 1 ? U.pathname.replace(/\/+$/, "") : U.pathname;
    return U.protocol + "//" + U.host.toLowerCase() + path + U.search + U.hash;
  } catch { return s; }
}
export function callSignature(name, args, pageKey) {
  if (name === "read_page") {
    const url = args && args.url ? String(args.url) : (pageKey || "active-tab");
    return "read_page:" + normalizeUrlKey(url);
  }
  return name + ":" + JSON.stringify(args);
}

export function repeatRefusal({ name, kind, seen, lastError, pageScoped = true }) {
  const n = Number(seen) || 0;
  if (lastError) {
    const why = String(lastError).replace(/\s+/g, " ").trim().slice(0, 400);
    return `REPEATED FAILING CALL: ${name} with these exact arguments has now been called ${n} times and it FAILED every time — nothing was read. Last error: ${why} ── Do NOT call it again with the same arguments. Either fix what the error names (different arguments, the tool it points you to, or a one-line request to the user for what is missing) or state plainly in your final answer that this source could not be read and why. Never present content from a call that failed as if you had read it.`;
  }
  if (kind === "consecutive") {
    return `You have ALREADY called ${name} with these exact arguments — its result is in the conversation above. Do NOT call it again. Use the information you already gathered and write your final answer NOW.`;
  }
  return `CYCLE DETECTED: this is call #${n} of ${name} with these arguments${pageScoped ? " on the same page" : ""}. You are re-fetching content you already read (the earlier copy was trimmed from context to fit the window). Do NOT fetch it again. Write your findings NOW for every artifact you have already read, in plain text as your final answer; note briefly anything you could not retain.`;
}

// TRUNCATION DETECTOR (2026-09-03; moved here from background.js 2026-09-08a). Cheap,
// conservative: only a LONG answer can be judged cut off, and only on strong signs — an
// open code fence, a dangling table row / list item / heading, no closing punctuation on
// the last line, or a lettered section the request asked for that the answer never
// reached. Returns the reason, or "" when the answer looks complete.
// 2026-09-08a: a last line that ENDS ON A URL is complete — a source list's final
// "https://…/whats_the/" was read as a mid-sentence "/" (resume-tailoring export 01:00),
// the model was told it had been cut off, and its denial was appended to the answer.
export function looksTruncated(text, taskText) {
  const t = String(text || "").replace(/\s+$/, "");
  if (t.length < 1200) return "";
  const fences = (t.match(/```/g) || []).length;
  if (fences % 2 === 1) return "an unclosed code block";
  const last = (t.split("\n").filter((l) => l.trim()).pop() || "").trim();
  if (/^#{1,6}\s+\S/.test(last)) return "it ends on a heading with nothing under it";
  if (/^\|/.test(last) && !/\|\s*$/.test(last)) return "it ends inside a table row";
  if (/^([-*+]|\d+[.)])\s*$/.test(last)) return "it ends on an empty list marker";
  const endsWithUrl = /https?:\/\/[^\s<>"'`)\]]+[)\]]*[.,;:]?$/i.test(last);
  if (!endsWithUrl && (/[,;:(\[{/—–-]$/.test(last) || /\b(and|or|the|a|an|to|of|with|for|in|on|at|by|via|then|check|open|set|see)$/i.test(last))) return "the last line stops mid-sentence";
  // Lettered sections the request enumerated ("A. …", "B. …") that the answer never reached.
  const asked = Array.from(new Set((String(taskText || "").match(/^\s*([A-Z])\.\s+[A-Z]/gm) || []).map((m) => m.trim()[0])));
  if (asked.length >= 3) {
    const have = new Set((t.match(/^\s*(?:#+\s*)?([A-Z])[.)]\s+\S/gm) || []).map((m) => m.trim().replace(/^#+\s*/, "")[0]));
    const missing = asked.filter((l) => !have.has(l));
    if (missing.length && missing.length < asked.length) return "sections " + missing.join(", ") + " of the request are missing";
  }
  if (/\b(checklist)\b/i.test(String(taskText || "")) && !/checklist/i.test(t)) return "the requested checklist is missing";
  return "";
}

// A reply to the "you were cut off — continue" prompt that DENIES being cut off (or
// answers with the NOTHING_MISSING sentinel the prompt offers) is not part of the
// answer: background.js ships the original piece alone instead of appending it.
export function isNonContinuation(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/^NOTHING_MISSING\b/.test(t)) return true;
  const head = t.slice(0, 400);
  if (/\b(was not|wasn't|were not|weren't|is not|isn't|never|nothing|none of)\b[^.\n]{0,80}\b(cut off|truncated|incomplete|interrupted)\b/i.test(head)) return true;
  if (/there (is|was) no (previous|prior|earlier) (message|response|reply|answer)/i.test(head)) return true;
  if (/nothing (left|more|further|remaining) to (continue|add|finish|complete)/i.test(head)) return true;
  if (/\b(already|fully|in fact) complete\b/i.test(head) && /\b(previous|prior|last|my|the) (message|response|reply|answer|document)\b/i.test(head)) return true;
  if (/^(I )?(cannot|can't|am unable to) (complete|continue)/i.test(head) && /cut off|truncat|previous message/i.test(head)) return true;
  return false;
}

// TOOL-RESULT DELIVERY CAP (2026-09-08b). Every tool result enters the model's
// message history through capToolPayload. The original flat `.slice(0, 8000)`
// (there since the first commit) silently dropped everything past 8,000 chars of
// JSON: a 9-page MSA that read_pdf extracted in full reached the model as pages
// 1-4 cut mid-sentence, with the "COMPLETE document" note itself cut off
// (contract-review export 2026-09-08 02:14). Doubled to 16,000 per the owner, and
// any cut is now announced at the tail so the model knows what it did not get.
export const TOOL_RESULT_MAX_CHARS = 16000;
export function capToolPayload(str, max = TOOL_RESULT_MAX_CHARS) {
  const s = String(str == null ? "" : str);
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : TOOL_RESULT_MAX_CHARS;
  if (s.length <= cap) return s;
  return s.slice(0, cap) +
    `\n…[EXTENSION CUT: this tool result was ${s.length} chars and only the first ${cap} were delivered — the rest was NOT read. A larger max_chars will NOT help (the cut happens after the tool). Read the remainder in parts instead: read_file with start_line, fetch_page / get_editor_value with offset, or ask the user to split the document. Never report a cut document as complete.]`;
}

// GROUNDING GUARD (2026-09-09). The competitive-intel export (15:51) is the case:
// prompt 6 asked for four snapshot files and the answer opened "The four files are
// written", then described each one's contents — with ZERO write_file / create_folder
// calls in the run and nothing on disk. Prompt 4 re-asked for four pages after a failed
// read and the answer described all four with ZERO tool calls; three of them were
// invented, and one invented competitor price table had not a single real number in it.
//
// The prompt already forbids this in several places. It did not hold, exactly like the
// trading fabrication above, so it is enforced in code: an answer that claims work the
// tool ledger never recorded gets an unmissable correction banner instead of shipping
// clean. Pure + exported so it is unit-testable: node grounding-guard.test.mjs

// Past/perfect completion claims only. "I will write" / "Write x.md" (a plan) must NOT
// fire — the plan turn never reaches this guard, but an execute answer may restate it.
const WRITE_DONE_RX =
  /(?:\b(?:is|are|was|were|have been|has been|had been)\s+(?:now\s+|all\s+)?(?:written|created|saved|updated|appended)\b)|(?:\bI\s+(?:have\s+|just\s+)?(?:wrote|written|created|saved|updated|appended|edited)\b)|(?:\b(?:written|created|saved|updated)\s+(?:this\s+run|successfully)\b)|(?:\bfiles?\s+written\s*:)|(?:\bwrote\s+(?:the\s+)?(?:file|files|four|three|two)\b)|(?:\b(?:wrote|created|saved|updated|appended)\s+(?:to\s+|into\s+)?(?:[\w.-]+[\\/])+[\w.-]+\.[a-z0-9]{1,5}\b)/i;

// A path with at least one separator and a document-ish extension. Written as
// slash-separated segments (no overlapping quantifiers) so it cannot backtrack.
const DOC_EXT = "md|markdown|txt|json|csv|ya?ml|html?|js|mjs|ts|py|docx?|xlsx?|pdf";
const CLAIMED_PATH_RX = new RegExp("(?:[\\w.-]+[\\\\/])+[\\w.-]+\\.(?:" + DOC_EXT + ")\\b", "g");
// Same pattern without /g — .test() on a global regex advances lastIndex between
// calls and would answer false every other time.
const CLAIMED_PATH_TEST_RX = new RegExp("(?:[\\w.-]+[\\\\/])+[\\w.-]+\\.(?:" + DOC_EXT + ")\\b");

// A ServiceNow record number in the claim: the write is about a RECORD, and the
// ServiceNow nudge in background.js owns that shape (MM 09-09 F2).
// 09d: ONE regex, exported — background.js uses it for the ledger's snContext and for the
// ServiceNow fabRecord nudge, so a record shape routed AWAY from the file guard is always
// a shape the ServiceNow nudge catches (MM pass 2, B-5: "I updated KB0012345" escaped both).
export const SN_RECORD_RX = /\b(?:INC|CHG|RITM|PRB|SCTASK|REQ|STRY|KB|CTASK|TASK|DFCT|ENHC|PTASK|RFC)\d{3,}\b/i;
// Page actions that change a DOM, not a record or a file. A cookie-banner click must not
// vouch for "the files are saved to disk" (MM pass 2, B-4).
export const DOM_ACTION_TOOLS = new Set(["fill_input", "click_element", "press_key", "select_option", "drag_drop", "open_form_section", "control_media", "create_folder", "scroll_page", "set_reference_field"]);
// Path identity for the ledger: slashes and case normalised, suffix match either way
// ("Intel/a.md" claimed vs "a.md" written relative to the Intel root).
export function samePath(a, b) {
  const n = (s) => String(s || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").toLowerCase();
  const A = n(a), B = n(b);
  if (!A || !B) return false;
  if (A === B) return true;
  return A.endsWith("/" + B) || B.endsWith("/" + A);
}
// A sentence that asserts CONTENTS or CURRENT-RUN work about a path. A write receipt from an
// earlier run proves the file exists — not what it says, and not that this run touched it
// (MM pass 3, N-1: "Intel/report.md was written earlier and contains: Starter 29 USD").
const CONTENT_OR_NOW_RX = /\b(?:contains?|says?|reads?|shows?|lists?|includes?|states?|now\s+(?:has|says|reads|contains)|today|just\s+(?:now\s+)?(?:updated|wrote|edited|saved|created)|according\s+to|the\s+contents?|as\s+follows|here\s+is\s+(?:what|the))\b|:\s*$|:\s*\n/i; // :\s*\n is dead inside receipted() but LIVE in the body-wide (b) test (MM pass 5, N-1)
// A completion verb a few words BEFORE the path in the same sentence: "I updated Intel/b.md".
// A path this run only READ is excused as a citation unless it is claimed this way (N-3).
const VERB_BEFORE_RX = /\b(?:wrote|written|saved|created|updated|edited|corrected|modified|appended|rewrote|regenerated|fixed)\b(?:\s+[\w'-]+){0,5}\s+[`*_]*$/i;
function claimedBefore(sentence, path) {
  const i = sentence.indexOf(path);
  return i >= 0 && VERB_BEFORE_RX.test(sentence.slice(0, i));
}
// …and the passive form AFTER the path: "Intel/b.md was updated", "X has been corrected"
// (MM pass 4, P-2 — the 16:29 battlecard shape with the plan-prescribed read in front).
const VERB_AFTER_RX = /^[`*_]*\s*(?:[\w'`*-]+\s+){0,3}(?:is|are|was|were|has\s+been|have\s+been|had\s+been|got)\s+(?:now\s+|all\s+|also\s+|just\s+|successfully\s+)?(?:written|created|saved|updated|edited|corrected|modified|appended|rewritten|regenerated|fixed)\b/i;
function claimedAfter(sentence, path) {
  const i = sentence.indexOf(path);
  return i >= 0 && VERB_AFTER_RX.test(sentence.slice(i + path.length));
}
// A markdown list item, table row, bold/code/heading line — the shapes a model uses under a
// "files written:" lead-in (MM pass 3, N-2; the 15:51 fixture is exactly this shape).
const LIST_LINE_RX = /^\s*(?:[-*\u2022>]|\d+[.)]|\||\*\*|`|#)/;
// A receipt entry is a string path (legacy) or {p, root}. It covers `path` when the path
// matches and its root is one of the roots connected NOW (N-4).
function receiptCovers(r, path, roots) {
  const rp = typeof r === "string" ? r : (r && r.p);
  if (!rp || !samePath(rp, path)) return false;
  const root = typeof r === "string" ? "" : String((r && r.root) || "");
  return !root || !roots || !roots.length || roots.includes(root);
}
// The claim is about FILES: a path, a file/folder noun, an extension, or "to disk".
const FILE_SHAPED_RX = /\b(?:files?|folders?|director(?:y|ies)|documents?|markdown|snapshots?|on\s+disk|to\s+disk|saved\s+to|written\s+to)\b|\.(?:md|markdown|txt|json|csv|ya?ml|html?|docx?|xlsx?|pdf)\b/i;
// The banners this module prepends; a previous answer carrying one was itself caught.
export const GUARD_BANNER_RX = /NOTHING WAS WRITTEN|NO FILE WAS WRITTEN|NO TOOL RAN THIS TURN/;

// ledger: { writes: [file paths written this run — write_file, edit_file, create_document,
// create_folder, move/copy], reads, pageReads, toolCalls (REAL tool calls, synthetic
// entries excluded), mutations: [names of other state-changing tools that succeeded —
// sn_update_record, save_record, fill_input…], snContext: bool, prevAssistantText,
// executePlan: bool }.
// The sentences of `body` that contain `needle` (sentence = up to . ! ? or a line break).
// A web address is a SOURCE, never a file claim: "Sources: - http://host/page.html" under an
// answer that says "saved to the folder" used to match the path pattern on "host/page.html"
// and flag an honest summary (competitive-intel recording 2026-09-09 21:33). Strip urls
// before any path is extracted.
function stripUrls(text) { return String(text || "").replace(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi, " "); }
const URL_G_RX = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
// "https://Host/path/." and "https://host/path" are the same address.
function normUrl(u) { return String(u || "").replace(/[.,;:!?]+$/, "").replace(/\/+$/, "").toLowerCase(); }
function urlSet(text) { return new Set((String(text || "").match(URL_G_RX) || []).map(normUrl)); }
// The answer hands the turn back to the user: it ends on a question, or asks for input outright.
const ASKS_USER_RX = /\b(?:I\s+(?:still\s+)?need\s+(?:from\s+you|you\s+to|your|the\s+values?)|please\s+(?:provide|give|tell|reply|confirm)|reply\s+with|what\s+(?:value|values|should)|which\s+(?:value|one))\b/i;
function asksUser(body) { const t = String(body || "").trim(); return /\?\s*$/.test(t) || ASKS_USER_RX.test(t); }
// Content words that turn a question into a description ("https://x lists three plans. Want more?").
// Narrower than CONTENT_OR_NOW_RX on purpose: "the instructions say to ask" is not page content.
const ASK_DESCRIBES_RX = /\b(?:currently|contains?|shows?|lists?|includes?|according\s+to|the\s+contents?|as\s+follows|priced?|costs?)\b/i;
// A sentence that hands the turn back: a question, an ask, or an action still to come
// ("I'll navigate to https://…"). Only these sentences may carry an excused url or "the page".
// Body-level excusal let "https://x is a pricing page with three tiers. Want more?" through.
const WILL_DO_RX = /\b(?:I'?ll|I\s+will|I\s+can|shall\s+I|should\s+I|let\s+me|want\s+me\s+to)\b[^.!?\n]*\b(?:navigate|open|go|visit|load|start|run|fill|click|type)\b/i;
const PAGE_PHRASE_RX = /\b(?:the\s+page|this\s+page|the\s+file|currently\s+says|as\s+of\s+(?:the\s+)?snapshot)\b/i;
function splitSentences(body) { return String(body || "").split(/(?<=[.!?])\s+|\n+/); }
function handsBack(s) { return /\?\s*$/.test(s.trim()) || ASKS_USER_RX.test(s) || WILL_DO_RX.test(s); }
function sentencesWith(body, needle) {
  return String(body || "").split(/(?<=[.!?])\s+|\n+/).filter((s) => s.includes(needle));
}
export function groundingScan(text, ledger = {}) {
  const body = String(text || "");
  if (!body.trim()) return null;
  const writes = ledger.writes || [];
  const reads = ledger.reads || [];
  const pageReads = ledger.pageReads || [];
  const mutations = ledger.mutations || [];
  const receipts = ledger.receipts || []; // paths written by EARLIER runs — code-built, never prose
  const toolCalls = Number(ledger.toolCalls) || 0;
  const snContext = !!ledger.snContext;

  // (a) Claimed a completed write the ledger does not support. ROUTED, not guessed
  // (MM 09-09 F1/F2 — the 09b version branded a successful sn_update_record run
  // "NOTHING WAS WRITTEN" and then forbade the sn_* tools in the retry):
  //   • a path claimed as written that this run did not write → file guard, whatever
  //     else ran — INCLUDING when other files were written (partial fabrication);
  //   • no path, but the claim is file-shaped, nothing real mutated and the task is not
  //     ServiceNow-shaped → a file claim with nothing behind it;
  //   • no path and a record number / SN context → the ServiceNow nudge owns it;
  //   • no path and a record/message mutation succeeded → the claim is about THAT change.
  if (WRITE_DONE_RX.test(body)) {
    const paths = [...new Set((stripUrls(body).match(CLAIMED_PATH_RX) || []).map((p) => p.trim()))].slice(0, 12);
    const snShaped = snContext || SN_RECORD_RX.test(body);
    const fileShaped = paths.length > 0 || FILE_SHAPED_RX.test(body);
    const realMutations = mutations.filter((m) => !DOM_ACTION_TOOLS.has(m));
    // A claimed path is covered when this run wrote it, or an earlier run wrote it (receipt)
    // and this run merely restates it, or this run READ it (a cited source, not a claim).
    const roots = Array.isArray(ledger.roots) ? ledger.roots : [];
    const receipted = (p) => receipts.some((r) => receiptCovers(r, p, roots))
      && !sentencesWith(body, p).some((s) => CONTENT_OR_NOW_RX.test(s));
    const readCited = (p) => reads.some((r) => samePath(r, p)) && !sentencesWith(body, p).some((s) => claimedBefore(s, p) || claimedAfter(s, p));
    const covered = (p) => writes.some((w) => samePath(w, p)) || receipted(p) || readCited(p);
    let unwritten = paths.filter((p) => !covered(p));
    if (writes.length && unwritten.length) {
      // Some files WERE written: a path is a claim when its sentence carries a completion
      // verb ("Intel/b.md was updated"), or when it is a list / table / heading line under a
      // completion lead-in earlier in the answer ("files written:" then "- Intel/b.md").
      // A bare mention in prose elsewhere is not a claim.
      unwritten = unwritten.filter((p) => {
        const ss = sentencesWith(body, p);
        if (ss.some((s) => WRITE_DONE_RX.test(s))) return true;
        return ss.some((s) => LIST_LINE_RX.test(s)) && WRITE_DONE_RX.test(body.slice(0, body.indexOf(p)));
      });
    }
    // "Created the folder Intel/snaps." after a real create_folder is honest work (N-6): a
    // folder path has no extension, so CLAIMED_PATH_RX never extracts it.
    const folderOnly = mutations.includes("create_folder") && !/\bfiles?\b/i.test(body);
    const pathless = paths.length === 0 && fileShaped && !snShaped && !realMutations.length && !writes.length && !folderOnly;
    if (unwritten.length || pathless) {
      return { kind: "writes", paths: unwritten, written: writes.slice(0, 12), toolCalls, mutations: mutations.slice(0, 8), snContext };
    }
    // Every claimed path is covered by this run's writes, a receipt or a read — but only a run
    // that actually called a tool gets to stop here. A zero-tool answer falls through to (b),
    // whose body-wide content test sees "It contains: …" in the NEXT sentence (MM pass 4, P-1).
    if (paths.length && !unwritten.length && toolCalls > 0) return null;
  }
  // (b) Described page/file content with NO tool call at all this run. Requiring zero
  // calls keeps this precise: a run that read something and then over-reached is a
  // different, softer problem than a run that touched nothing and answered anyway.
  if (toolCalls === 0 && !reads.length && !pageReads.length) {
    const mentioned = (stripUrls(body).match(CLAIMED_PATH_RX) || []).map((p) => p.trim());
    const roots = Array.isArray(ledger.roots) ? ledger.roots : [];
    // Receipted paths may be NAMED with no tool call; their CONTENTS may not be described (N-1).
    const allReceipted = mentioned.length > 0 && !CONTENT_OR_NOW_RX.test(body)
      && mentioned.every((p) => receipts.some((r) => receiptCovers(r, p, roots)));
    // A question back to the user that describes nothing is not a memory answer. Its urls are
    // excused only when the TASK already carried them ("navigate to https://…" echoed back) —
    // "summarize https://x" answered from memory still fires. Saved-workflow replay 2026-09-13
    // 20:53 (SIR0014155): the model asked for two parameter values, quoted step 1's url, and
    // the retry sent it back to argue instead of run.
    // Excusal is per SENTENCE: an echoed url is dropped only from a sentence that hands the turn
    // back, and "the page" is skipped only when every sentence using it does. A declarative
    // sentence about the task's url ("https://x is a pricing page with three tiers.") still fires.
    const asking = asksUser(body) && !ASK_DESCRIBES_RX.test(body);
    const echoed = asking ? urlSet(ledger.taskText) : new Set();
    const urlBody = echoed.size
      ? splitSentences(body).map((s) => (handsBack(s) ? s.replace(URL_G_RX, (u) => (echoed.has(normUrl(u)) ? " " : u)) : s)).join("\n")
      : body;
    const pagePhrase = PAGE_PHRASE_RX.test(body)
      && !(asking && splitSentences(body).filter((s) => PAGE_PHRASE_RX.test(s)).every(handsBack));
    const claimsContent = /\bhttps?:\/\/\S+/i.test(urlBody) || (CLAIMED_PATH_TEST_RX.test(stripUrls(body)) && !allReceipted)
      || pagePhrase;
    if (claimsContent) return { kind: "no_tools", paths: [], toolCalls: 0, mutations: [], snContext, taskText: String(ledger.taskText || ""), answerText: body };
  }
  return null;
}

export function applyGroundingGuard(text, ledger = {}) {
  const hit = groundingScan(text, ledger);
  if (!hit) return { text, violation: null };
  let banner;
  if (hit.kind === "writes") {
    const other = hit.mutations && hit.mutations.length ? hit.mutations : [];
    banner =
      (other.length || (hit.written && hit.written.length)
        ? "\u26A0\uFE0F **NO FILE WAS WRITTEN FOR PART OF THIS ANSWER — IT CLAIMS FILES THE RUN DID NOT WRITE**\n\n"
        : "\u26A0\uFE0F **NOTHING WAS WRITTEN — THIS ANSWER CLAIMS FILES THAT DO NOT EXIST**\n\n") +
      (hit.written && hit.written.length
        ? "The answer below reports files as written, created or updated that this run has NO write evidence for. "
        : "The answer below reports files as written, created or updated, but this run made " +
          "NO successful file write (write_file, edit_file, create_document, create_folder, move_file, copy_file). ") +
      (hit.paths.length
        ? "Paths named in the answer that were NOT written: " + hit.paths.join(", ") + ". "
        : "") +
      (hit.written && hit.written.length
        ? "Files this run DID write: " + hit.written.join(", ") + ". "
        : "") +
      (other.length
        ? "The only other changes this run made were: " + other.join(", ") + " — those stand; the files named above do not. "
        : (hit.written && hit.written.length ? "" : "Nothing reached disk. ")) +
      (hit.written && hit.written.length
        ? "Treat only the files listed as written as saved work; the others are not. Re-run the request for them and check the "
        : "Do not treat any file named below as saved work. Re-run the request and check the ") +
      "\uD83D\uDCC1 filesystem audit line for the paths actually written.\n\n---\n\n";
  } else {
    banner =
      "\u26A0\uFE0F **NO TOOL RAN THIS TURN — THE CONTENT BELOW WAS NOT READ FROM ANYWHERE**\n\n" +
      "The answer below describes pages or files, but this run made no tool call at all: nothing " +
      "was opened, fetched or read. Any page text, price, date, name or file content below came " +
      "from the model, not from a source. Treat all of it as UNVERIFIED and ask again.\n\n---\n\n";
  }
  return { text: banner + text, violation: hit };
}

// The retry message for a claim groundingScan caught, worded for the work that was
// ACTUALLY claimed. The pre-existing anti-fabrication nudge in background.js is
// ServiceNow-shaped ("you did NOT query or update ServiceNow… call the sn_* tools NOW"),
// and on a filesystem task it does real damage: in the competitive-intel run (export
// 16:29) a battlecard answer saying "corrected" near "change log" matched its SN noun
// list, and the model burned its one recovery turn writing "there is no ServiceNow work
// in this task at all" instead of writing the files. So this wording names the right
// tools and closes the ServiceNow door explicitly.
// 09j: request shapes the retry (see groundedWorkNudge). "search / look up / google / find
// out / latest / current / news / who is / what is X" reads as a web question; a file noun or
// path reads as a folder question.
export const SEARCH_REQUEST_RX = /\b(?:search(?:\s+(?:the\s+)?(?:web|internet|online))?|look\s*(?:it|this|that)?\s*up|google|bing|web\s+search|find\s+out|latest|news)\b/i;
// "this page / the open tab / these pages" is a READ request even when it says "look up".
const PAGE_REQUEST_RX = /\b(?:this|the\s+(?:open|active|current)|these|those)\s+(?:page|pages|tab|article|site)\b/i;
export const FILE_REQUEST_RX = /\b(?:files?|folders?|director(?:y|ies)|documents?|\.(?:md|txt|json|csv|pdf|docx?|xlsx?)|connected\s+folder|local\s+files?)\b/i;
// 2026-09-13: a request that drives the BROWSER — a url to open, a step to click / type / fill /
// check, a saved-workflow replay. The generic retry led with read_file, so the Four Dragons
// replay (SIR0014155 21:05) called list_files on a run with no folder connected.
// A browser STEP (navigate / click / check / fill / type / log in / submit / replay) outranks the
// search retry: "Click the Search button" is a UI step, not a web question. A bare url does not.
const BROWSER_STEP_RX = /\b(?:navigate\s+to|click\s+(?:the|on)|type\s+.{1,80}?\s+into|fill\s+(?:in|out)|(?:un)?check\s+the\s+["“][^"”]{1,60}["”]\s+box|log\s*(?:in\s+to|into)|sign\s*(?:in\s+to|into)|open\s+(?:the\s+)?(?:site|website|page|tab|url|link)|submit\s+the\s+form|replay\s+this\s+learned\s+workflow)\b/i;
export const BROWSER_REQUEST_RX = new RegExp("\\bhttps?:\\/\\/|" + BROWSER_STEP_RX.source, "i");

export function groundedWorkNudge(claim) {
  if (!claim) return null;
  const paths = claim.paths && claim.paths.length
    ? " You named: " + claim.paths.slice(0, 6).join(", ") + "."
    : "";
  // 2026-09-09c (MM F1/F2): the ServiceNow door is closed ONLY when the run has no
  // ServiceNow in it. On an instance task the sn_* tools may be exactly what is missing.
  const snDoor = claim.snContext ? "" : " This is a LOCAL FILE task: do not call any sn_* tool and do not discuss ServiceNow.";
  if (claim.kind === "writes") {
    const other = (claim.written && claim.written.length ? " Files that WERE written this turn: " + claim.written.join(", ") + "." : "") +
      (claim.mutations && claim.mutations.length
        ? " Other changes that did run: " + claim.mutations.join(", ") + " — report those as done, but NOT the unwritten files."
        : "");
    const lead = claim.written && claim.written.length
      ? "STOP — part of that report is FABRICATED. You reported files as written that NO write call of this turn produced — only the files listed as WRITTEN below were written; the ones you named were not."
      : "STOP — that report is FABRICATED. You reported files as written, but NO write_file / edit_file / create_document / create_folder call ran this turn, so those files were not written by you.";
    return lead + paths + other +
      " Do NOT describe file contents you have not written. Call the tools NOW: if a file already exists from EARLIER work, read_file it and report what it actually contains — do not rewrite it; otherwise create_folder first if the folder is new, then one write_file per file, and after each one read it back with read_file before you report it. Report ONLY paths a write actually returned ok for." + snDoor;
  }
  // 09j: a SEARCH-shaped request gets a search-shaped retry. The old text led with
  // read_file, so a run asked "what is Ollama" re-read the connected folder (v2 take 2).
  const task = String(claim.taskText || "");
  const wantsSearch = SEARCH_REQUEST_RX.test(task) && !PAGE_REQUEST_RX.test(task) && !BROWSER_STEP_RX.test(task);
  const aboutFiles = FILE_REQUEST_RX.test(task) || (claim.paths && claim.paths.length > 0);
  if (wantsSearch && !aboutFiles && !claim.snContext) {
    return "STOP \u2014 that answer came from memory. NO tool ran this turn, and the request asks for a web search, so nothing in it is sourced." + paths +
      " Call web_search (or google_search) NOW with the question as the query, wait for the results, open the best one with read_page and its `url` argument if you need the page itself, and answer ONLY from what those tools returned, citing the url. Do not read the connected folder for this; it is not a file question.";
  }
  // 2026-09-13: a BROWSER-shaped request gets a browser-shaped retry, with the folder tools named
  // as off-limits. A file noun or path in the request still gets the file retry below.
  if (BROWSER_REQUEST_RX.test(task) && !aboutFiles && !claim.snContext) {
    return "STOP — that answer came from memory. NO tool ran this turn: nothing was opened, clicked or read, so none of it is sourced." + paths +
      " This is a BROWSER task. Call the browser tools NOW and wait for each result before the next: navigate to the url in the request, read_page to see the page, then query_elements to find each control and click_element / fill_input for each step, and read_page again to verify the result. Report ONLY what those tools returned." +
      " Do not call list_files or read_file; no local folder is part of this task. Do not call any sn_* tool and do not discuss ServiceNow.";
  }
  const readTools = claim.snContext
    ? " read_file for a file in the connected folder, read_page with the `url` argument for a web page — ONE page per call, one at a time, because they share a single tab — and the sn_query_* tools for instance records."
    : " read_file for a file in the connected folder, and read_page with the `url` argument for a web page — ONE page per call, one at a time, because they share a single tab.";
  return "STOP — that report is FABRICATED. NO tool ran this turn: nothing was opened, fetched or read, so every page text, price, date, name and file path in your answer came from you, not from a source." + paths +
    " Call the tools NOW and wait for each result before the next:" + readTools + " Report ONLY what the tool results actually returned." + (claim.snContext ? "" : " This is a LOCAL FILE and WEB PAGE task: do not call any sn_* tool and do not discuss ServiceNow.");
}

// ECHO GUARD (2026-09-09). After the honest self-correction in the competitive-intel run,
// the next TWO turns replayed that same paragraph word for word — including "If you want
// me to execute the plan now, say the word" immediately after the owner typed "Execute
// now" — with no tool calls behind it. A local model under a long history re-emits its
// last answer instead of acting. Repeating the previous answer is never a valid reply.
export function isEchoOfPrevious(text, prevAssistant) {
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  const a = norm(text), b = norm(prevAssistant);
  if (!a || !b || a.length < 120) return false;
  if (a === b) return true;
  const head = Math.min(300, Math.floor(Math.min(a.length, b.length) * 0.9));
  return head >= 120 && a.slice(0, head) === b.slice(0, head);
}
