// rfp-pack.js — RFP / RFI / security-questionnaire Response method pack.
// Injected (background.js) when the task asks to respond to, shred, or draft
// answers for an RFP, RFI, RFQ, tender, vendor or security questionnaire from
// the user's answer library. Fifth of the five go-to-market packs (2026-09-04).
//
// SAFETY-BY-DESIGN: every drafted answer cites the library file it came from;
// a requirement with no supporting material is a GAP for a human SME, never a
// confident claim. Inputs are read-only; the response document is the only
// write and it lands in the connected folder.
// Author: iDevOpsLLC

export function needsRfpPack(taskText) {
  const t = String(taskText || "");
  const rfpNoun = /\b(rfp|rfi|rfq|rfx|tender|bid|proposal|(security|vendor|due[- ]diligence|compliance|supplier) questionnaire|requirements? (matrix|traceability)|compliance matrix|statement of compliance)\b/i.test(t);
  const respondVerb = /\b(respond|response|answer|draft|shred|fill (in|out)|complete|prepare|write|map|extract the requirements)\b/i.test(t);
  return rfpNoun && respondVerb;
}

export const RFP_PACK = `RFP RESPONSE MODE — shred the request into numbered requirements, answer each one from the user's answer library with a citation, and flag every requirement you cannot support as a gap. A confident answer with no source is the one failure this method does not allow.

⛔ MANDATORY PLAN FIRST: before reading, POST a plan — (a) the REQUEST document (file or page) and how you will read all of it, (b) the ANSWER LIBRARY location (connected-folder paths found with list_files / search_files: prior responses, security docs, product sheets, certifications) — or "no library found" and what that means, (c) the response format the request demands (per-question table, narrative sections, form fields, page limits, due date), (d) the fan-out: one child per major section, max 4.

1. READ THE REQUEST END TO END (read_pdf / read_file / read_page). Capture the deadline, submission format, page or word limits, mandatory forms, evaluation criteria and scoring weights, and any "must / shall / required" language. Say how many pages you read.
2. SHRED into a REQUIREMENTS MATRIX: ID (R-001…) | Section | Requirement (verbatim) | Type = MANDATORY (must/shall) / DESIRABLE (should/may) / INFORMATIONAL | Answer format | Evaluation weight if stated. Do not merge two requirements into one row; the evaluator will not.
3. FIND THE EVIDENCE. For each requirement: search_files the library for 2–3 phrasings (feature name, standard name like "ISO 27001", "SOC 2", "SSO", "data residency"); read_file the best 1–2 hits; keep the file path and the quoted passage. Fan out with spawn_subagent by section (each child: its requirement rows in, rows back with answer + path + quote); wait for all children before drafting.
4. DRAFT each answer in the requested format, beginning with a compliance statement: COMPLY / PARTIALLY COMPLY / DO NOT COMPLY / CLARIFICATION NEEDED, then 2–5 sentences that answer the requirement in the evaluator's words, then "Source: <library path>". Reuse the library's approved wording; do not improve a certification, date, metric or customer name beyond what the source says.
5. GAP LIST (mandatory section): every requirement with no library source, an outdated source (older than the request asks for), or a conflict between sources → GAP | needs SME | suggested owner (security / product / legal / finance) | what evidence would close it. Never fill a gap with an assumption.
6. DELIVER: (a) Compliance summary — counts of Comply / Partial / Not / Gap, and the mandatory requirements at risk; (b) the Requirements Matrix; (c) the drafted responses; (d) the Gap List; (e) submission checklist (format, forms, limits, deadline). Save with create_document "<RFP name> — Response Draft.docx" (and the matrix as a second document or .md via write_file) when a folder is connected.
RULES: read-only inputs; the only writes are the deliverable files. Quote the request's wording in the matrix; quote the library's wording in the source line. A claim you cannot cite is a GAP. Say plainly when the library is thin — the gap list is an honest output, not a failure.`;
