// phase-parsers.js — pure, node-testable gate parsers + deterministic invariants
// for the phase engine (IMPROVEMENTS_PHASE_ENGINE.md §3.5/§3.6).
// Ported from the AgenticWorkflow engine's gate semantics (run-core.js) per
// an internal review, with the consensus amendments:
// fail-closed everywhere, anchored-NO-GO precedence, thought-block stripping,
// BEGIN/END_DELIVERABLE delimiters, and the structured evidence contract
// (citation tokens + exact value-match + coverage + freshness).
// ZERO chrome/DOM dependencies — unit-tested with plain node (phase-parsers.test.mjs).
// Author: iDevOpsLLC

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------

// Strip reasoning/thought blocks so a >600-char think preamble can't push the
// verdict lines out of the head window (Gemini finding, plan §3.6). Handles
// <think>/<thought>/<reasoning> tags (paired or unclosed-at-start).
export function stripThought(text) {
  let t = String(text || "");
  t = t.replace(/<(think|thought|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  // Unclosed leading think block: drop everything up to the first verdict-ish
  // anchor if the text starts with an opening tag that never closes.
  const open = t.match(/^\s*<(think|thought|thinking|reasoning)>/i);
  if (open) {
    const anchor = t.search(/^\s*(VERDICT|READINESS|POST_VERDICT)\s*:/mi);
    t = anchor >= 0 ? t.slice(anchor) : "";
  }
  return t;
}

// Remove fenced code blocks so quoted/example verdict text can never be
// mistaken for the reviewer's own verdict (T5).
export function stripFences(text) {
  return String(text || "").replace(/```[\s\S]*?```/g, "");
}

// AWF worker-level gate: an output that trims to <10 chars is a failed call
// (run-core.js:631 semantics) — the chain walks on.
export const MIN_GATE_OUTPUT_CHARS = 10;
export function isGateFailOutput(text) {
  return String(text || "").trim().length < MIN_GATE_OUTPUT_CHARS;
}

// ---------------------------------------------------------------------------
// REVIEW verdict — VERDICT: APPROVED|REVISED + READINESS: GO|NO-GO — <reason>
// ---------------------------------------------------------------------------

const HEAD_WINDOW = 600; // AWF head-window size, applied AFTER thought-strip

// Line-anchored regexes only — body prose ("this is a no-go area") never matches.
const RE_VERDICT = /^[ \t]*VERDICT:\s*(APPROVED|REVISED)\b/gim;
const RE_READINESS = /^[ \t]*READINESS:\s*(GO|NO-GO)\b[ \t]*(?:[—:-][ \t]*(.*))?$/gim;

function anchoredMatches(re, text) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m);
  return out;
}

// Parse the reviewer's output. FAIL-CLOSED: anything missing/unparseable is
// NO-GO. Precedence: ANY anchored NO-GO beats a co-located GO (consensus T5).
// REVISED requires the corrected deliverable inside BEGIN_DELIVERABLE /
// END_DELIVERABLE; REVISED without delimiters fail-closes and the ORIGINAL
// deliverable is retained (T6).
export function parseReviewVerdict(raw) {
  const cleaned = stripFences(stripThought(raw));
  const head = cleaned.slice(0, HEAD_WINDOW);

  let verdicts = anchoredMatches(RE_VERDICT, head);
  let readiness = anchoredMatches(RE_READINESS, head);
  // Line-anchored full-text fallback ONLY when the head yields nothing at all
  // (AWF fallback semantics) — still anchored, still precedence-checked.
  if (!verdicts.length && !readiness.length) {
    verdicts = anchoredMatches(RE_VERDICT, cleaned);
    readiness = anchoredMatches(RE_READINESS, cleaned);
  }

  const verdict = verdicts.length ? verdicts[0][1].toUpperCase() : null;
  let go = null, reason = "";
  if (readiness.length) {
    const anyNoGo = readiness.find((m) => m[1].toUpperCase() === "NO-GO");
    const pick = anyNoGo || readiness[0]; // anchored NO-GO wins
    go = pick[1].toUpperCase() === "GO";
    reason = (pick[2] || "").trim();
  }

  const failClosed = verdict === null || go === null;
  const result = {
    verdict: verdict || "REVISED",           // unknown verdict treated as needing scrutiny
    readiness: failClosed || go === false ? "NO-GO" : "GO",
    reason: failClosed ? (reason || "fail-closed: missing/unparseable VERDICT or READINESS line") : reason,
    failClosed,
    deliverable: null,                        // set below for well-formed REVISED
    deliverableMissing: false
  };

  if (!failClosed && verdict === "REVISED") {
    const d = cleaned.match(/BEGIN_DELIVERABLE\s*([\s\S]*?)\s*END_DELIVERABLE/);
    if (d && d[1].trim()) {
      result.deliverable = d[1].trim();
    } else {
      // REVISED but no delimited body — fail closed, keep the original draft.
      result.readiness = "NO-GO";
      result.failClosed = true;
      result.deliverableMissing = true;
      result.reason = result.reason || "fail-closed: REVISED without BEGIN_DELIVERABLE/END_DELIVERABLE body";
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// REVERIFY verdict — POST_VERDICT: GO|NO-GO — <reason>
// ---------------------------------------------------------------------------

// Capture the WHOLE first token after POST_VERDICT: (not just literal GO|NO-GO) so a
// slightly-off phrasing from a local model — "POST_VERDICT: pass" / "approved" / "fail" —
// is classified instead of silently unmatched → fail-closed (the live defect: a valid
// "pass" reverify burned all 3 repair attempts and killed the run).
const RE_POST = /^[ \t]*POST_VERDICT:\s*([A-Za-z][A-Za-z-]*)\b[ \t]*(?:[—:\-][ \t]*(.*))?$/gim;

// Verdict-word synonyms. NO-GO is checked FIRST (precedence). An unrecognized word maps to
// null → the caller fails CLOSED, so tolerance never weakens the gate for a genuine unknown.
const GO_WORDS = new Set(["GO", "PASS", "PASSED", "PASSES", "APPROVED", "APPROVE", "OK", "YES", "CONFIRMED", "VERIFIED", "ACCEPT", "ACCEPTED", "GOOD"]);
const NOGO_WORDS = new Set(["NO-GO", "NOGO", "FAIL", "FAILED", "FAILS", "REJECT", "REJECTED", "NO", "BLOCK", "BLOCKED", "REVISE", "REVISED", "DENY", "DENIED", "STOP"]);
function classifyGo(word) {
  const w = String(word || "").toUpperCase().replace(/[^A-Z-]/g, "");
  if (NOGO_WORDS.has(w)) return "NO-GO";
  if (GO_WORDS.has(w)) return "GO";
  return null; // unrecognized → fail-closed at the caller
}

// FAIL-CLOSED + NO-GO precedence: any anchored NO-GO ⇒ NO-GO (a model that
// "changes its mind" to GO after a NO-GO does not get the benefit of the doubt).
export function parsePostVerdict(raw) {
  const cleaned = stripFences(stripThought(raw));
  const ms = anchoredMatches(RE_POST, cleaned);
  if (!ms.length) return { readiness: "NO-GO", reason: "fail-closed: no anchored POST_VERDICT line", failClosed: true };
  const classed = ms.map((m) => ({ go: classifyGo(m[1]), word: m[1], reason: (m[2] || "").trim() }));
  const noGo = classed.find((c) => c.go === "NO-GO");
  if (noGo) return { readiness: "NO-GO", reason: noGo.reason, failClosed: false };
  const goPick = classed.filter((c) => c.go === "GO").pop();
  if (goPick) return { readiness: "GO", reason: goPick.reason, failClosed: false };
  // A POST_VERDICT line existed but no word was recognized → fail closed, surfacing the raw word.
  return { readiness: "NO-GO", reason: `fail-closed: unrecognized POST_VERDICT verdict "${classed[classed.length - 1].word}"`, failClosed: true };
}

// ---------------------------------------------------------------------------
// Evidence contract (§3.5) — citation tokens + deterministic invariants
// ---------------------------------------------------------------------------

// Citation token grammar: [E12:update.checked=true] or path-only [E1:script]
//   id    → ledger entry id ("E12")
//   path  → observation path ("update.checked"). May contain [N] array
//           segments — live run #3 (2026-07-15): the model cited
//           [E2:records[0].action_insert=false] and the old path class ended
//           the token at the `]` of `[0]`, so resolution failed on "records[0".
//           The path now accepts base segments OR bracketed indices.
//   value → asserted value (OPTIONAL — live run #2: models cite long content
//           like a script body by path alone; a path-only token is a reference
//           claim, validated for existence but asserting no value)
// MM impl-review B5: whitespace-tolerant — "[E1: active = true]" is a common
// LLM formatting habit; the value is trimmed after capture.
const RE_TOKEN = /\[E(\d+)\s*:\s*((?:[^\[\]\s=]+|\[\d+\])+)\s*(?:=\s*([^\]]*))?\]/g;

// Canonical path form: bracketed indices become dot segments
// (records[0].name → records.0.name) so bracket- and dot-style citations both
// resolve against the ledger regardless of which the model wrote.
function normalizePath(p) {
  return String(p || "").replace(/\[(\d+)\]/g, ".$1");
}

export function parseEvidenceTokens(text) {
  RE_TOKEN.lastIndex = 0;
  const out = [];
  let m;
  while ((m = RE_TOKEN.exec(String(text || ""))) !== null) {
    out.push({ id: "E" + m[1], path: m[2], value: m[3] !== undefined ? m[3].trim() : null, index: m.index });
  }
  return out;
}

// ---------------------------------------------------------------------------
// OBSERVATION-ID citations — the TERMINAL fix for the serialization class
// (MM impl-review consensus 6a582ddc, Tier-1.5): the model cites [E6.O2],
// a short id the ENGINE minted; it serializes no path, no value, no brackets,
// no quotes — so nothing can be mis-serialized. O<k> = the entry's k-th
// recorded observation (1-based). The legacy [E:path=value] grammar remains
// fully supported for backward compat.
// ---------------------------------------------------------------------------

const RE_OBS_TOKEN = /\[E(\d+)\.O(\d+)\]/g;

export function parseObsIdTokens(text) {
  RE_OBS_TOKEN.lastIndex = 0;
  const out = [];
  let m;
  while ((m = RE_OBS_TOKEN.exec(String(text || ""))) !== null) {
    out.push({ id: "E" + m[1], obsIndex: Number(m[2]), index: m.index });
  }
  return out;
}

function hasAnyToken(text) {
  return parseEvidenceTokens(text).length > 0 || parseObsIdTokens(text).length > 0;
}

// MM impl-review must-fix #1: the model must never SERIALIZE a token itself —
// the engine builds the complete, copyable token string per observation.
// Values that are long (>32 chars — also the prefix-match floor), multi-line,
// or contain token-grammar characters ("]", "[", "=") are FORCED to path-only
// form, which deletes the whole class of bracket/quote/newline value bugs (B1/B2).
export function buildCiteTokens(entry, cap = 60, valueChars = 60) {
  // OBSERVATION-ID form (terminal fix): "[E6.O2] = path=value" legend lines.
  // The citable TOKEN is the [E6.O2] part; the legend after "=" tells the
  // model (and gate reviewers) what the id attests. valueChars controls the
  // DISPLAY width: drafters get 60 (they cite ids, not text); GATE ROLES get
  // wide values (live run #10: deepseek called full script quotes "overreach"
  // because the 60-char digest hid the content the deterministic gate had
  // already verified — a reviewer can't judge a code review without the code).
  // Display cuts are labeled so they're never mistaken for evidence truncation.
  const out = [];
  (entry.observations || []).forEach((o, i) => {
    if (o.truncated || out.length >= cap) return; // truncated obs stay uncitable (run #8)
    const v = String(o.value ?? "");
    const shown = v.slice(0, valueChars);
    out.push(`[${entry.id}.O${i + 1}] = ${o.path}=${shown}${v.length > valueChars ? " …(display cut; full value verified by the deterministic gate)" : ""}`);
  });
  return out;
}

// Deterministic value comparison (live run #2 lessons):
//  * strip ONE layer of matching wrapping quotes from the asserted value
//    (models write role_conditions="" for an empty observed value)
//  * exact match, OR a ≥32-char prefix relation in either direction (ledger
//    values are capped at 500 chars; requiring byte-exact reproduction of a
//    long script body is brittle, while a 32-char prefix collision with a
//    FABRICATED value is implausible — still deterministic, still fail-closed
//    on real contradictions)
function valueMatches(asserted, observed) {
  let a = String(asserted), b = String(observed);
  const q = a.match(/^(["'])([\s\S]*)\1$/);
  if (q) a = q[2];
  if (a === b) return true;
  if (a.length >= 32 && b.startsWith(a)) return true;
  if (b.length >= 32 && a.startsWith(b)) return true;
  return false;
}

// Deterministic claim-schema detectors for the COVERAGE check (§3.5.3c).
// Tier-1 scope (documented honestly): UI boolean field state, 32-hex sys_ids,
// explicit field=value assertions about ServiceNow-ish flag fields. Sentences
// matching one of these with ZERO citation tokens ⇒ coverage failure.
const CLAIM_SCHEMAS = [
  // "Insert ... true", "Update is checked", "Delete and Query are enabled", …
  /\b(insert|update|delete|query|active|advanced|checked|enabled|disabled)\b[^.!?\n]{0,80}\b(true|false|checked|unchecked|enabled|disabled)\b/i,
  // bare 32-hex sys_id claims
  /\b[0-9a-f]{32}\b/
  // MM impl-review B6: the generic field=value schema is REMOVED from hard-fail
  // coverage — it over-matched recommendations, hypotheticals, and narrative
  // prose ("Set active=true after testing"), producing deterministic NO-GOs on
  // honest deliverables. Value-claims that DO carry tokens are still validated.
];

// Recommendation / hypothetical sentences are advice about a DESIRED state,
// not assertions about the OBSERVED state — exempt from coverage (MM B6).
const RE_HEDGE = /\b(recommend(ed|ation)?|consider|should|could|would|suggest(ed|ion)?|propose[ds]?|option(al)?|e\.g\.|for example|if\b|after\b|instead|alternatively|to fix|fix needed|change made|set\b)/i;

function sentences(text) {
  return String(text || "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// Resolve a cited path against an entry's observations. Exact match first;
// otherwise a UNIQUE leaf-suffix match (e.g. token path "action_insert"
// resolves to "records[0].action_insert" when exactly one observation ends
// with ".action_insert"). Ambiguous suffixes do NOT resolve — determinism and
// fail-closed behavior are preserved. (Live BR regression 2026-07-15: models
// naturally cite the leaf field name, while sn_query_table results flatten to
// records[N].field — exact-only matching false-NO-GO'd an honest review.)
function resolveObservation(entry, path) {
  const obs = entry.observations || [];
  const want = normalizePath(path);
  const matches = (o) => normalizePath(o.path) === want ||
    (o.aliases || []).some((a) => normalizePath(a) === want);
  const exact = obs.find(matches);
  if (exact) return exact;
  const suffix = obs.filter((o) => normalizePath(o.path).endsWith("." + want));
  return suffix.length === 1 ? suffix[0] : null;
}

// Scope-aware freshness (MM final-audit P1: record A's later observation must
// not stale record B's same-named field). Two entries are the "same scope"
// only when the tool matches AND no scope discriminator (sysId, url, or an
// observed sys_id value) proves they targeted different objects. Unknown
// scopes stay comparable — fail-closed for genuinely re-read state.
function sameEvidenceScope(a, b) {
  if (a.tool !== b.tool) return false;
  // WEB SOURCES are cited as-read, not as mutable record state (2026-07-20e, live
  // PE4 a-live-run): two web_search calls both expose `results.0.snippet`, but a
  // DIFFERENT query's first result is NOT a supersession of an earlier query's —
  // yet with no url/sysId scope they looked "same-scope" and hard-NO-GO'd research
  // deliverables with a spurious stale-evidence loop. A web search/fetch never
  // stales another. (ServiceNow record freshness uses read_page/sn_* — NOT web
  // tools — so instance re-read staleness is untouched.)
  if (WEB_EVIDENCE_TOOLS.has(a.tool)) return false;
  // Vision snapshots are read as-seen at a moment; a later shot never invalidates
  // citing the one you read (2026-07-20v). No scope discriminator exists for them,
  // so without this two screenshots would collapse to one scope and stale-loop.
  if (SNAPSHOT_EVIDENCE_TOOLS.has(a.tool)) return false;
  const sidA = a.scope?.sysId, sidB = b.scope?.sysId;
  if (sidA && sidB && sidA !== sidB) return false;
  const urlA = a.scope?.url, urlB = b.scope?.url;
  if (urlA && urlB && urlA !== urlB) return false;
  // Different encoded-query FILTERS = different result sets, not a re-read of the
  // same state (live SN2 a-live-run: a count from name=X was falsely "superseded"
  // by a count from client_callable=true — two unrelated sn_query_session calls).
  const qA = a.scope?.query, qB = b.scope?.query;
  if (qA && qB && qA !== qB) return false;
  // Different local paths = different reads, not a re-read of one another (2026-07-20x):
  // list_files('src') never supersedes list_files('docs'); search_files patterns differ.
  const pA = a.scope?.path, pB = b.scope?.path;
  if (pA && pB && pA !== pB) return false;
  const obsSid = (e) => {
    const o = (e.observations || []).find((o) => /(^|\.)sys_id$/.test(normalizePath(o.path)));
    return o ? String(o.value) : null;
  };
  const oa = obsSid(a), ob = obsSid(b);
  if (oa && ob && oa !== ob) return false;
  return true;
}

// The deterministic invariant. Runs in pure code BEFORE any reverify model
// call. ledger: [{id, tool, observations:[{path, value}], sequence, success,
// truncated}]. Returns {ok, failures:[{kind, detail}]} — any failure ⇒ NO-GO.
export function checkEvidence(draft, ledger) {
  const failures = [];
  const byId = new Map((ledger || []).map((e) => [e.id, e]));

  // ---- Observation-id tokens [E6.O2] — nothing serialized, direct binding ----
  for (const t of parseObsIdTokens(draft)) {
    const e = byId.get(t.id);
    if (!e) { failures.push({ kind: "unresolved", detail: `${t.id}.O${t.obsIndex} — ${t.id} not in ledger` }); continue; }
    if (!e.success) { failures.push({ kind: "failed-evidence", detail: `${t.id} was a failed call` }); continue; }
    const obs = (e.observations || [])[t.obsIndex - 1];
    if (!obs) { failures.push({ kind: "no-observation", detail: `${t.id} has no observation O${t.obsIndex}` }); continue; }
    if (obs.truncated) { failures.push({ kind: "truncated-evidence", detail: `${t.id}.O${t.obsIndex} (${obs.path}) is truncated — cite a complete observation` }); continue; }
    // Freshness by the bound observation's own path (same scope only).
    for (const later of ledger) {
      if (later.sequence > e.sequence && later.success && !later.truncated && sameEvidenceScope(e, later)) {
        const lo = resolveObservation(later, obs.path);
        if (lo && !lo.truncated && !valueMatches(String(obs.value), lo.value)) {
          failures.push({ kind: "stale-evidence", detail: `${t.id}.O${t.obsIndex} (${obs.path}) superseded by ${later.id} ("${lo.value}")` });
          break;
        }
      }
    }
  }

  // ---- Legacy [E:path=value] tokens (fully supported) ----
  const tokens = parseEvidenceTokens(draft);

  for (const t of tokens) {
    const e = byId.get(t.id);
    if (!e) { failures.push({ kind: "unresolved", detail: `${t.id} not in ledger` }); continue; }
    if (!e.success) { failures.push({ kind: "failed-evidence", detail: `${t.id} was a failed call` }); continue; }
    const obs = resolveObservation(e, t.path);
    if (!obs) {
      // Prefix-group resolution for PATH-ONLY tokens (live run #9): a reference
      // field comes back as an object ({link, value}), flattened to child
      // observations (records.0.sys_scope.value, .link). Citing the parent
      // node path-only ([E6:records.0.sys_scope]) is a legitimate reference to
      // that recorded group. VALUED tokens never prefix-resolve — a value can
      // only be asserted against one concrete observation.
      if (t.value === null) {
        const want = t.path.replace(/\[(\d+)\]/g, ".$1");
        const kids = (e.observations || []).filter((o) => o.path.replace(/\[(\d+)\]/g, ".$1").startsWith(want + "."));
        if (kids.length && kids.some((k) => !k.truncated)) continue; // resolved as a group reference
      }
      failures.push({ kind: "no-observation", detail: `${t.id} has no observation at ${t.path}${e.obsTruncated ? " (entry's observation list was truncated — re-gather with a narrower query)" : ""}` });
      continue;
    }
    // Truncation is judged PER OBSERVATION (run #8): a cut `text` field must
    // not poison the entry's complete siblings (title/url/checked/…).
    if (obs.truncated) { failures.push({ kind: "truncated-evidence", detail: `${t.id}:${t.path} is truncated — cannot verify (cite a complete observation instead)` }); continue; }
    if (t.value === null) continue; // path-only reference: existence verified, no value asserted
    if (!valueMatches(t.value, obs.value)) {
      failures.push({ kind: "value-mismatch", detail: `${t.id}:${t.path} asserted "${t.value}" but ledger records "${obs.value}"` });
      continue;
    }
    // Freshness: any LATER same-scope observation of the same path with a
    // different value invalidates the citation (§3.5.3d). Same resolver and
    // same truncated-observation exclusion as the obs-ID loop (MM final-audit:
    // this loop was missing !lo.truncated — a cut later value could stale a
    // valid citation on a spurious mismatch).
    for (const later of ledger) {
      if (later.sequence > e.sequence && later.success && !later.truncated && sameEvidenceScope(e, later)) {
        const lo = resolveObservation(later, t.path);
        if (lo && !lo.truncated && !valueMatches(t.value, lo.value)) {
          failures.push({ kind: "stale-evidence", detail: `${t.id}:${t.path} superseded by ${later.id} ("${lo.value}")` });
          break;
        }
      }
    }
  }

  // Coverage: claim-schema sentences with zero tokens. Exemptions (each from a
  // live false positive):
  //  * hedged sentences (recommendations/hypotheticals) — desired state, not
  //    observed state (MM B6, run #2);
  //  * /* block comments */ and ``` fences — PROPOSED artifact content, not
  //    claims about the instance (run #6: the remediated script's header
  //    comment "Insert: false | Update: true" tripped the boolean schema);
  //  * PARAGRAPH scope — a heading like "Issue 4: Header comment says X —
  //    verified correct" whose Evidence line (with tokens) sits directly
  //    beneath it is cited AT PARAGRAPH LEVEL (run #6). A paragraph with ≥1
  //    token is treated as cited; only fully token-less paragraphs are checked
  //    sentence-by-sentence. (Trade-off, stated honestly: a fabricated
  //    sentence inside an otherwise-cited paragraph is not caught by coverage
  //    — value-match still catches it whenever it carries a token.)
  const prose = stripFences(draft).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const para of prose.split(/\n\s*\n/)) {
    if (hasAnyToken(para)) continue;
    for (const s of sentences(para)) {
      if (RE_HEDGE.test(s)) continue;
      if (CLAIM_SCHEMAS.some((re) => re.test(s))) {
        failures.push({ kind: "uncited-claim", detail: s.slice(0, 160) });
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Evidence-ledger recording (§3.5.1) — code-built at the tool-dispatch site.
// ---------------------------------------------------------------------------

// Tools whose successful results count as EVIDENCE the deliverable may cite.
export const EVIDENCE_TOOLS = new Set([
  "query_elements", "get_editor_value", "list_editors", "read_page", "read_file",
  // MM 16z-audit P1-5: the tool is named sn_query_record in tools.js, NOT
  // sn_get_record — the old entry was DEAD, so sn_query_record results never
  // ledgered and legitimate citations hard-failed no-observation.
  "sn_fetch_script_by_sysid", "sn_query_table", "sn_query_record", "sn_query_session",
  "sn_wf_activity_vars", // workflow activity inputs (advanced_script etc.) — 2026-09-02
  // WEB/RESEARCH evidence (2026-07-19v, live a-live-run): the AWF research role
  // gathered real NVDA data via web_search + fetch_page (14 steps) but the ledger
  // stayed EMPTY because these weren't evidence tools — so every research claim
  // was uncited and the deliverable NO-GO'd to "no data". These flatten cleanly:
  // web_search → results.<i>.{title,url,snippet}; fetch_page/http_request →
  // {url,title,text}. Now a research subtask can CITE its sources ([E3.O5]=url).
  "web_search", "fetch_page", "http_request",
  // read_pdf (2026-07-20): fetches a PDF URL and extracts its text layer — a
  // real web-sourced observation, cite it like fetch_page.
  "read_pdf",
  // google_search (2026-07-20u): the preferred research search. It was added to
  // WEB_EVIDENCE_TOOLS but NOT here — so its results/AI-Overview never ledgered and
  // a google_search research task would empty-ledger NO-GO (same class as the
  // web_search omission above). Flattens as results.<i>.{title,url,snippet} + aiOverview.
  "google_search",
  // VISION SNAPSHOTS (2026-07-20v, live desktop-control UAT a-live-run): a
  // capture_screenshot / desktop_screenshot returns a `description` (local vision
  // model's read of the screen) — that IS observable evidence of UI state (e.g.
  // "Notepad shows the typed text"). They weren't evidence tools, so a screenshot-
  // driven task (all desktop control, image-only pages) produced an EMPTY ledger →
  // the zero-evidence retry re-ran the WHOLE task (doubling steps) AND the gate
  // NO-GO'd a task that actually SUCCEEDED as "could not complete". Now the final
  // screenshot's description is citable and confirms completion.
  "capture_screenshot", "desktop_screenshot",
  // LOCAL-FOLDER READS (2026-07-20x, live no-op run a-live-run): list_files
  // (directory listing) and search_files (regex code search) READ the connected
  // MCP folder — real observations — but weren't evidence tools. A run that listed
  // the folder to confirm "the PR folder is connected" produced evidence_entries:0
  // → zero-evidence retry AND reverify NO-GO'd the TRUE statement as "no observation
  // supports this". read_file was already here; its list/search siblings belong too.
  // list_files → {root,path,content,count}; search_files → {root,content/hits}.
  "list_files", "search_files",
  // get_tab_info → {title,url}: a light read of the active tab. The same no-op run
  // cited the open artifact's title from it; ledger it so "you're on page X" claims
  // are grounded, not flagged unsupported.
  "get_tab_info",
  // sn_api_reference → {text} (2026-07-20, live a-live-run): the C:\redacted\path
  // CRITICAL — it MUST be citable evidence. When it wasn't, the drafter got the full
  // GlideAggregate method roster from the tool but the ledger stayed EMPTY, so the
  // gates (which judge against the ledger + the SLICED domainPack — the roster sits
  // past the 12000-char injection cut) called the correct 30-method answer a
  // "fabrication" and repaired it down to 3 methods. Ledger the reference text so the
  // drafter can CITE the roster and the gates VERIFY it — exactly like fetch_page /
  // read_file (external authoritative content, not instance state). Its `text` is
  // chunked below with a HIGHER cap so a whole ≤24KB pack is citable end-to-end.
  "sn_api_reference",
  // save_record → {ok,saved,sys_id,note} (2026-07-20, live SN export a-live-run):
  // the WRITE whose RESULT is the authoritative PERSISTENCE proof. Every other
  // evidence tool is a READ; save_record was excluded, so a SUCCESSFUL save left
  // NO ledger observation. In a-live-run turn 3 the Script Include WAS saved
  // (save_record → {saved:true, sys_id:"540d2184…"}) but, the ledger being blind
  // to it, the reviewer/repair anchored to the PRE-edit list_editors stub (141
  // chars) and walked the deliverable back to a fabricated "unsaved stub — no
  // sys_id exists yet", directly contradicting a save the tools layer had
  // confirmed. Ledger the save so "created/saved, sys_id X" is grounded and the
  // opposite fabrication ("not saved") is caught. saveServiceNowRecord only sets
  // saved:true after polling a real 32-hex sys_id; a blocked/failed save carries
  // `error` ⇒ recordEvidence marks it success:false (an honest non-citable entry,
  // never mistakable for a persisted record). The sys_id observation also drives
  // freshness: a re-save of the SAME record supersedes the earlier save; saves of
  // DIFFERENT records (distinct sys_ids) never cross-stale (sameEvidenceScope).
  "save_record"
]);

// Point-in-time VISION snapshots. Ledgerable (above) but staleness-EXEMPT: two
// screenshots of an evolving screen have no sysId/url/query scope, so without this
// a later shot would falsely "supersede" an earlier cited one (spurious stale-
// evidence). A screenshot is read as-seen, never a mutable record another re-reads.
// Kept SEPARATE from WEB_EVIDENCE_TOOLS so they do NOT flip the research genre.
export const SNAPSHOT_EVIDENCE_TOOLS = new Set(["capture_screenshot", "desktop_screenshot"]);

// The web-sourced evidence tools — a run whose ledger contains any of these is
// RESEARCH-flavored, and the gates switch to source-citation semantics (a claim
// citing a credible on-topic source is supported; exact-value match is NOT
// required for a fact synthesized from a long web page). 2026-07-19w.
// an internal review (2026-07-19y) P1 fix: `http_request` REMOVED — it is a
// generic tool that can target ServiceNow REST / localhost, so a non-research
// (even failed) http_request was falsely activating the research relaxation.
// It stays in EVIDENCE_TOOLS (still ledgerable) but is no longer a research
// SIGNAL. Only genuine web-discovery/read tools flip the genre now.
export const WEB_EVIDENCE_TOOLS = new Set(["web_search", "google_search", "fetch_page", "read_pdf"]);

// ServiceNow-record evidence tools — a run whose ledger contains any of these
// (or a DOM read on a ServiceNow instance) carries instance-record claims that
// MUST keep exact-value strictness. Used to KILL the research relaxation in a
// MIXED SN+web run (an internal review P1: the relaxation was run-global and
// softened the reviewer's bar on SN prose whenever any web tool also fired).
export const SN_EVIDENCE_TOOLS = new Set(["sn_fetch_script_by_sysid", "sn_query_table", "sn_query_record", "sn_query_session", "sn_wf_activity_vars"]);

// A ledger scope url that belongs to a ServiceNow instance (DOM fallback reads
// SN records via read_page/query_elements/get_editor_value when REST 401s).
export function isServiceNowUrl(u) {
  return typeof u === "string" && /service-now\.com|\/nav_to\.do|\/now\/nav\/|sysparm_|sys_id=/i.test(u);
}

const MAX_OBS = 120;         // per-entry observation cap (aliases live ON observations, not as extra rows — MM B3/B7)
const MAX_OBS_VALUE = 500;   // per-observation value cap (chars)

// Flatten a tool result into {path, value} observations. query_elements gets a
// purpose-built shape (`<id|name>.checked/value/type`) — the exact fields the
// 2026-07-15 fabrication was about; everything else flattens shallowly
// (primitives only, depth ≤ 3).
function flattenObservations(name, result) {
  const obs = [];
  // TRUE overflow tracking (MM final-audit: `length >= MAX_OBS` false-positived
  // at exactly 120 observations) — set only when a value was actually skipped.
  let overflow = false;
  const push = (path, value) => {
    if (value === undefined || value === null) return;
    if (obs.length >= MAX_OBS) { overflow = true; return; }
    const s = String(value);
    // Observation-level truncation (live run #8): a value cut at the cap can't
    // be exactly verified — mark it, don't poison the whole entry.
    obs.push({ path, value: s.slice(0, MAX_OBS_VALUE), truncated: s.length > MAX_OBS_VALUE || undefined });
  };
  if (name === "query_elements" && Array.isArray(result?.elements)) {
    result.elements.forEach((el, i) => {
      const key = el.id || el.name || el.selector;
      if (!key) return;
      // ONE observation per field, with the positional form as an ALIAS on the
      // same row (MM B3/B7: alias-as-separate-row doubled ledger consumption
      // and made short leaf-suffixes ambiguous). Both path shapes resolve;
      // live run #5's raw-JSON citations (elements[9].checked) hit the alias.
      for (const f of ["checked", "value", "type", "disabled"]) {
        if (el[f] !== undefined) {
          if (obs.length >= MAX_OBS) { overflow = true; continue; }
          const s = String(el[f]);
          // Same per-observation truncation contract as push() (MM final-audit:
          // this branch cut values silently, leaving them citable-as-complete).
          obs.push({ path: `${key}.${f}`, value: s.slice(0, MAX_OBS_VALUE), truncated: s.length > MAX_OBS_VALUE || undefined, aliases: [`elements.${i}.${f}`] });
        }
      }
      if (el.text) push(`${key}.text`, el.text);
    });
    return { obs, overflow };
  }
  // WEB/PAGE CONTENT — chunk the `text` body into CITABLE pieces (2026-07-20o, live
  // BA2 a-live-run): fetch_page/read_page/read_pdf return the page body in `text`;
  // the generic push caps it at 500 chars AND marks it truncated, so the whole page
  // becomes UNCITABLE — the model read Hacker News's top stories but could not cite
  // them and (honestly but WRONGLY) reported "not in the ledger". Split the text
  // into COMPLETE ≤500-char chunks (text, text.1, text.2, …) so every part is
  // citable; bound the chunk count so a huge page can't blow the ledger.
  // The long-form CONTENT field differs by tool: web/page reads carry the body in
  // `text`; vision snapshots (capture_screenshot/desktop_screenshot) carry the
  // screen read in `description` (2026-07-20v). Chunk whichever is present into
  // COMPLETE ≤500-char pieces so the whole thing is citable, not truncated-uncitable.
  const CONTENT_FIELD = (name === "fetch_page" || name === "read_page" || name === "read_pdf" || name === "sn_api_reference") ? "text"
    : (name === "capture_screenshot" || name === "desktop_screenshot") ? "description"
    : (name === "list_files" || name === "search_files") ? "content"
    : null;
  if (CONTENT_FIELD && typeof result?.[CONTENT_FIELD] === "string") {
    const cf = CONTENT_FIELD;
    const full = result[cf];
    if (full.length > MAX_OBS_VALUE) {
      // sn_api_reference returns a whole API-reference pack (method rosters run 8-22KB)
      // that must be citable END-TO-END, so it gets a higher chunk cap; web/page reads
      // keep the tighter 16 (8000-char) budget so a huge page can't blow the ledger.
      const MAX_TEXT_CHUNKS = name === "sn_api_reference" ? 48 : 16; // 48 × 500 = 24000 chars
      if (name === "sn_api_reference") {
        // LINE-AWARE chunking (2026-07-20, live a-live-run): the reference packs are
        // line-structured (one `- \`method(sig)\`` per line). Fixed 500-char slicing
        // split a signature across two chunks, so a method that straddled a boundary
        // (setIntervalYearIncluded) sat in NO complete chunk → could not be cited → the
        // reviewer flagged it and it was dropped from the roster (29/30, with a false
        // "not in the reference" claim). Pack whole lines into chunks so every method
        // signature is intact within one chunk and individually citable.
        let buf = "", n = 0;
        const flush = () => { obs.push({ path: n === 0 ? cf : `${cf}.${n}`, value: buf }); n++; buf = ""; };
        for (const ln of full.split("\n")) {
          if (n >= MAX_TEXT_CHUNKS || obs.length >= MAX_OBS) { overflow = true; break; }
          if (buf && buf.length + ln.length + 1 > MAX_OBS_VALUE) flush();
          buf = buf ? buf + "\n" + ln : ln;
          // a single line longer than the cap (rare): hard-split it so it still fits.
          while (buf.length > MAX_OBS_VALUE && n < MAX_TEXT_CHUNKS && obs.length < MAX_OBS) {
            const cut = buf.slice(0, MAX_OBS_VALUE); buf = buf.slice(MAX_OBS_VALUE);
            obs.push({ path: n === 0 ? cf : `${cf}.${n}`, value: cut }); n++;
          }
        }
        if (buf && n < MAX_TEXT_CHUNKS && obs.length < MAX_OBS) flush();
        if (full.split("\n").length && n >= MAX_TEXT_CHUNKS) overflow = true;
      } else {
        for (let i = 0; i < MAX_TEXT_CHUNKS && i * MAX_OBS_VALUE < full.length; i++) {
          if (obs.length >= MAX_OBS) { overflow = true; break; }
          // complete slice → NO truncated flag → citable
          obs.push({ path: i === 0 ? cf : `${cf}.${i}`, value: full.slice(i * MAX_OBS_VALUE, (i + 1) * MAX_OBS_VALUE) });
        }
        if (full.length > MAX_TEXT_CHUNKS * MAX_OBS_VALUE) overflow = true; // tail beyond the cap dropped
      }
    } else {
      push(cf, full);
    }
    // sibling metadata (url, title, chars, …) stays citable — these results are shallow
    for (const k of Object.keys(result)) { if (k !== cf && typeof result[k] !== "object") push(k, result[k]); }
    return { obs, overflow };
  }
  (function walk(v, path, depth) {
    if (obs.length >= MAX_OBS) { overflow = true; return; }
    if (depth > 3) return;
    if (v === null || v === undefined) return;
    if (typeof v !== "object") { push(path, v); return; }
    // Dot-form array segments (records.0.name, not records[0].name): keeps
    // ledger paths free of the `]` that terminates citation tokens. Walk up to
    // 50 rows to match sn_query_session's max limit (MM 16z-audit P2: a 20-row
    // cap left rows 21-50 uncitable); MAX_OBS + overflow still bound total size.
    if (Array.isArray(v)) { if (v.length > 50) overflow = true; v.slice(0, 50).forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i), depth + 1)); return; }
    for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k, depth + 1);
  })(result, "", 0);
  // Tool-level truncation localizes to the CONTENT observation (read_page cuts
  // `text`, get_editor_value cuts `value`) — the sibling metadata (title, url,
  // chars, …) is complete and stays citable (live run #8: entry-wide truncation
  // failed [E10:title]/[E10:url] because the page TEXT was cut).
  if (result?.truncated) {
    for (const o of obs) {
      if (o.path === "text" || o.path === "value" || o.path.endsWith(".text") || o.path.endsWith(".value")) o.truncated = true;
    }
  }
  return { obs, overflow };
}

// Append one ledger entry for an executed tool call. Returns the entry id
// (e.g. "E3") so the caller can surface it to the model for citation, or null
// when the tool isn't an evidence tool.
export function recordEvidence(ledger, name, args, result) {
  if (!Array.isArray(ledger) || !EVIDENCE_TOOLS.has(name)) return null;
  const id = "E" + (ledger.length + 1);
  const flat = result?.error ? { obs: [], overflow: false } : flattenObservations(name, result);
  ledger.push({
    id,
    tool: name,
    // `query` (encoded-query filter) discriminates LIST/COUNT reads: a count or
    // records.N.* from filter A is NOT a re-read of filter B's — different filters
    // return different result sets (2026-07-20i, live SN2 a-live-run). A single-
    // record read keys on sysId instead; both are freshness discriminators.
    // sn_wf_activity_vars keys on its activity list / version the same way a
    // single-record read keys on sysId — two different activities are never a
    // re-read of each other.
    scope: { url: result?.url || args?.url || undefined, sysId: args?.sysId || args?.activity_sys_id || args?.workflow_version || undefined, query: args?.query || undefined, path: args?.path || undefined },
    observations: flat.obs,
    obsTruncated: flat.overflow, // MM B3: surfaced, never silent (true overflow, not length==cap)
    sequence: ledger.length + 1,
    success: !result?.error,
    truncated: !!result?.truncated
  });
  return id;
}

// ---------------------------------------------------------------------------
// PLAN parsing (Tier 2) — the orchestrator's decomposition, validated in code.
// AWF semantics: subtasks with depends_on, topologically ordered, cycles
// rejected. FAIL-SAFE, never fail-closed: an unparseable/invalid plan degrades
// to the single-subtask fast path (= Tier-1 behavior), it never blocks a run.
// ---------------------------------------------------------------------------

export const MAX_SUBTASKS = 4; // sequential browser work — more is latency, not parallelism (model-lock)

// BUILD-IN-INSTANCE RE-TAG (2026-07-20, live SN export a-live-run): the
// orchestrator tagged a "Build Script Include" subtask as role "code" and the
// code specialist (glm — a code WRITER) emitted the class body as TEXT and never
// drove the browser to create/save the record. Yet all three gates passed the
// run as GO because the TWIN "tools" subtask ("Build onChange Client Script")
// HAD saved its record, so the combined deliverable LOOKED built. Two follow-up
// turns confirmed the Script Include did not exist. PLAN_SYSTEM already tells the
// planner "any subtask that edits the instance MUST be role 'tools'", but the
// model violated its own rule. Enforce it in CODE: a subtask whose text clearly
// CREATES/SAVES a ServiceNow artifact in the live instance is forced to "tools"
// (the browser-driving role that carries the build step cap), whatever the
// planner labeled it. Scoped TIGHT so it never steals a legitimate pure-code
// "write the script body; a later tools subtask saves it" leg: it requires BOTH
// a CREATE/persist verb AND (a concrete SN artifact noun OR an explicit "in
// my/the/this instance" phrase), fires ONLY on code/bulk (research is never
// touched — its purpose is off-page facts), and uses creation verbs only (not
// bare update/edit) to keep precision high.
const SN_ARTIFACT_RE = /\b(script include|business rule|client script|ui policy|ui action|ui page|ui script|scripted rest(?: api)?|rest message|inbound (?:email )?action|transform map|import set|data source|scheduled job|fix script|acl|access control(?: list)?|catalog item|order guide|record producer|flow|subflow|widget|notification|email template|update set|application menu|dictionary entry)\b/i;
const PERSIST_VERB_RE = /\b(build|create|add|insert|make|set ?up|deploy|provision|register|generate|author|save|persist|configure)\b/i;
const IN_INSTANCE_RE = /\b(?:in|on|to|into)\s+(?:my|the|this|your)\s+instance\b/i;

// True when the subtask must PERSIST an artifact to the live instance ⇒ it must
// run role "tools", not a text-only "code"/"bulk" leg. Exported for the test.
export function buildsInInstance(text) {
  const s = String(text || "");
  if (!PERSIST_VERB_RE.test(s)) return false;
  return SN_ARTIFACT_RE.test(s) || IN_INSTANCE_RE.test(s);
}

export function parsePlan(raw, maxSubtasks = MAX_SUBTASKS) {
  const cleaned = stripThought(String(raw || "")).replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "no JSON object found" };
  let plan;
  try { plan = JSON.parse(cleaned.slice(start, end + 1)); }
  catch (e) { return { ok: false, error: "JSON parse: " + String(e.message).slice(0, 80) }; }
  if (plan.fast_path === true) return { ok: true, fastPath: true, subtasks: [], synthesis: "" };
  if (!Array.isArray(plan.subtasks) || !plan.subtasks.length) return { ok: false, error: "no subtasks array" };
  if (plan.subtasks.length > maxSubtasks) return { ok: false, error: `too many subtasks (max ${maxSubtasks})` };

  const subtasks = [];
  const ids = new Set();
  for (const s of plan.subtasks) {
    const id = String(s?.id || "").trim();
    const prompt = String(s?.prompt || "").trim();
    if (!id || !prompt) return { ok: false, error: "subtask missing id or prompt" };
    if (ids.has(id)) return { ok: false, error: `duplicate subtask id ${id}` };
    ids.add(id);
    const deps = Array.isArray(s.depends_on) ? s.depends_on.map(String) : [];
    // AWF-parity ROLE tag (2026-07-19u): the planner tags each subtask with one
    // specialist role so EXECUTE can route it to that role's model chain. Unknown
    // / missing → "tools" (the browser-driving default — the extension's EXECUTE
    // always runs the agent loop with browser tools; the tag only picks the model
    // and, for research, enables a web-search nudge).
    let role = SUBTASK_ROLES.has(String(s.role || "").toLowerCase()) ? String(s.role).toLowerCase() : "tools";
    // CODE-ENFORCED instance-persistence guard (see buildsInInstance above): a
    // build/create/save-a-record subtask MUST run the browser-driving "tools"
    // role, never a text-only "code"/"bulk" leg that would emit the artifact as
    // prose and never save it. Only code/bulk are eligible; research is exempt.
    let retagged = false;
    if ((role === "code" || role === "bulk") && buildsInInstance(`${s.title || ""} ${prompt}`)) {
      role = "tools"; retagged = true;
    }
    subtasks.push({ id, title: String(s.title || id).slice(0, 120), prompt: prompt.slice(0, 4000), depends_on: deps, role, retagged });
  }
  for (const s of subtasks) {
    for (const d of s.depends_on) if (!ids.has(d)) return { ok: false, error: `subtask ${s.id} depends on unknown ${d}` };
    if (s.depends_on.includes(s.id)) return { ok: false, error: `subtask ${s.id} depends on itself` };
  }
  // Kahn topological sort; leftover nodes ⇒ cycle ⇒ reject (MM Tier-2 gate).
  // Each Kahn BATCH is a parallel WAVE (AWF dependency waves): all subtasks in a
  // wave have their deps satisfied by earlier waves, so they can run concurrently.
  const ordered = [];
  const waves = [];
  const pending = new Map(subtasks.map((s) => [s.id, new Set(s.depends_on)]));
  while (pending.size) {
    const ready = [...pending.entries()].filter(([, d]) => d.size === 0).map(([id]) => id);
    if (!ready.length) return { ok: false, error: "dependency cycle detected" };
    waves.push(ready.slice());
    for (const id of ready) {
      ordered.push(subtasks.find((s) => s.id === id));
      pending.delete(id);
      for (const d of pending.values()) d.delete(id);
    }
  }
  return { ok: true, fastPath: false, subtasks: ordered, waves, synthesis: String(plan.synthesis_instructions || "").slice(0, 2000) };
}

// AWF-parity EXECUTE specialist roles (2026-07-19u). Kept in phase-parsers so the
// planner-output validator and the engine share ONE source of truth.
export const SUBTASK_ROLES = new Set(["tools", "code", "bulk", "research"]);

// AWF deterministic invariants that ride along with the evidence contract
// (run-core.js:1038-1042 semantics).
export const MIN_DELIVERABLE_CHARS = 40;

export function checkBasicInvariants(finalText, { draftText = "" } = {}) {
  const failures = [];
  if (String(finalText || "").trim().length <= MIN_DELIVERABLE_CHARS) {
    failures.push({ kind: "empty", detail: `deliverable ≤ ${MIN_DELIVERABLE_CHARS} chars` });
  }
  // NOTE (live run #2): the former blanket "any ledger entry truncated ⇒ fail"
  // invariant was over-broad — a capped read_page marks itself truncated and
  // failed runs whose deliverable never cited it. Truncation is now enforced
  // where it matters: checkEvidence fails any CITED truncated entry
  // ("truncated-evidence"), and an uncited truncated call supports no claim.
  // AWF's citation-preservation invariant targets research deliverables with a
  // MEANINGFUL citation set. Threshold ≥3 (live run #14: a code review whose
  // single incidental instance URL was dropped in an honest REVISED pass
  // hard-failed on "URLs 1→0").
  const urls = (t) => new Set((String(t || "").match(/https?:\/\/[^\s)>"']+/g) || []));
  const draftUrls = urls(draftText), finalUrls = urls(finalText);
  if (draftUrls.size >= 3 && finalUrls.size < Math.ceil(draftUrls.size * 0.6)) {
    failures.push({ kind: "citations-lost", detail: `URLs ${draftUrls.size}→${finalUrls.size} (<60% preserved)` });
  }
  return { ok: failures.length === 0, failures };
}
