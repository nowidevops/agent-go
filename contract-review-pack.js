// contract-review-pack.js — Contract Playbook Review method pack. Injected
// (background.js) when the task asks to review, redline or risk-check a
// contract, NDA, MSA, SOW, DPA, order form or terms against a playbook.
// Fourth of the five go-to-market packs (2026-09-04 brief).
//
// SAFETY-BY-DESIGN: READ-ONLY on the contract. The deliverable is a review memo
// with clause citations and proposed redline language; the agent never edits
// the contract file and never states clause text it did not read. The memo
// carries the "not legal advice" line by rule.
// Author: iDevOpsLLC

export function needsContractReviewPack(taskText) {
  const t = String(taskText || "");
  const contractNoun = /\b(contract|nda|non-disclosure|msa|master (services?|subscription) agreement|sow|statement of work|dpa|data processing (agreement|addendum)|order form|terms (of service|and conditions)|\bt&cs?\b|eula|licen[cs]e agreement|lease|vendor agreement|service agreement|agreement)\b/i.test(t);
  const reviewVerb = /\b(review|redline|red-line|mark ?up|risk[- ]check|check .{0,40}against|compare .{0,40}(playbook|standard|template)|what (are|is) the (risks?|issues?)|flag (the )?(risks?|issues?|deviations?)|negotiat\w*|summari[sz]e the (key )?terms)\b/i.test(t);
  const playbook = /\bplaybook\b/i.test(t);
  return contractNoun && (reviewVerb || playbook);
}

export const CONTRACT_REVIEW_PACK = `CONTRACT PLAYBOOK REVIEW MODE — read the whole agreement, compare every material clause with the user's playbook, and deliver a review memo with citations and proposed redlines. The contract file is READ-ONLY; you never edit it.

⛔ MANDATORY PLAN FIRST: before reading, POST a plan — (a) the CONTRACT source (file path in the connected folder, or the open page) and how you will read it end to end, (b) the PLAYBOOK you will apply (a file named playbook / positions / standards in the connected folder found with search_files, or the DEFAULT CHECKLIST below when none exists — say which), (c) the user's side (customer / vendor / licensor / licensee — ask if unclear), (d) the memo format and where it will be saved.

1. READ THE WHOLE CONTRACT. read_pdf for PDFs, read_file for .docx/.md/.txt, read_page for a web page. Read every page; for long documents read in sections and keep a running clause index (section number → title → page). Never review from a partial read; state the page count read.
2. LOAD THE PLAYBOOK. search_files for "playbook", "positions", "contract standards"; read_file the match. Each playbook line = clause · preferred position · acceptable fallback · walk-away. If no playbook exists, apply the DEFAULT CHECKLIST: term & termination (for convenience, for cause, notice periods) · auto-renewal · fees, payment terms, late fees, price increases · limitation of liability (cap, carve-outs) · indemnification (scope, mutuality) · IP ownership & licence back · confidentiality (term, exclusions) · data protection & security (DPA, breach notice, sub-processors) · warranties & disclaimers · SLA & service credits · assignment & change of control · non-solicit / exclusivity · insurance · governing law, venue, dispute resolution · audit rights · survival.
3. CLAUSE-BY-CLAUSE. For every playbook item: FOUND (section + page, the operative sentence quoted verbatim) or ABSENT (say so — absence of a cap or a carve-out is a finding). Then: position vs playbook = ALIGNED / DEVIATION / MISSING; severity = WALK-AWAY / NEGOTIATE / ACCEPT; plain-English impact in one sentence; PROPOSED REDLINE — the replacement or added wording, ready to paste, marked as insertion/deletion.
4. DEFINED TERMS: check the definitions the flagged clauses depend on ("Confidential Information", "Affiliates", "Services") and note when a definition widens or narrows a clause.
5. MEMO (deliver in this order): Summary verdict (sign as-is / sign with N redlines / do not sign) · Top risks (max 5, worst first) · Clause table (Clause | Section/page | Position | Severity | Redline) · Absent protections · Questions for the counterparty · Definitions notes · "This is an AI-assisted first pass, not legal advice; a lawyer reviews before signature."
6. SAVE when asked or when a folder is connected: create_document "<Contract name> — Review Memo.docx" (or write_file .md). Never write into the contract file itself.
RULES: quote only text you read; if a clause is ambiguous, say so instead of resolving it. Never state governing law, a cap amount, a notice period or a date you did not find on the page. Do not summarise "standard" clauses as fine without reading them. One contract per run.`;
