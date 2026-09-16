// kb-article-pack.js — Knowledge Article & SOP Writer method pack. Injected
// (background.js) when the task asks for a knowledge article, KB draft, SOP,
// runbook or how-to written from a resolved record or from screens the agent
// walked through. First of the five go-to-market packs (2026-09-04 brief).
//
// SAFETY-BY-DESIGN: the deliverable is a DRAFT. On ServiceNow the article is
// created in kb_knowledge with workflow_state "draft" through the approval-gated
// sn_create_record; it is never published, and no source record is modified.
// Off ServiceNow the article lands in the connected folder as a document.
// Author: iDevOpsLLC

export function needsKbArticlePack(taskText, tabUrl) {
  const t = String(taskText || "");
  const explicit = /\b(knowledge[- ]?(base )?article|kb[- ]?article|kb_knowledge|knowledge (base )?(draft|entry|doc)|standard operating procedure|\bsop\b|runbook|how[- ]to (guide|article|doc)|work instruction)\b/i.test(t);
  const documentVerb = /\b(write|draft|create|turn|convert|document|capture|publish)\b/i.test(t);
  const documentThis = /\b(document|write up|write down) (this|the) (resolution|fix|procedure|process|steps|workaround|setup|configuration)\b/i.test(t);
  const snTab = /\.service-now\.com\b/i.test(String(tabUrl || ""));
  return (explicit && documentVerb) || documentThis || (explicit && snTab);
}

export const KB_ARTICLE_PACK = `KNOWLEDGE ARTICLE / SOP WRITER MODE — turn a REAL resolution, procedure or walked-through screen flow into a reusable DRAFT article. Every step in the article must come from a record you read or a screen you saw THIS run; nothing is written from memory.

⛔ MANDATORY PLAN FIRST: before touching a tool, POST a plan — (a) the SOURCE you will draw from (a record number / sys_id, a URL, a transcript, or "walk the flow live"), (b) the ARTICLE TYPE (fix/known-error, how-to, SOP/runbook, reference), (c) the audience (end user / fulfiller / admin) and the target (ServiceNow knowledge base by name, or a document in the connected folder), (d) the sections you will fill. Only then gather.

1. GATHER THE SOURCE (read-only)
   - ServiceNow record: sn_query_record the incident / case / problem / change (short_description, description, close_notes / resolution notes, work_notes, cause, category, cmdb_ci, resolved_by) and any linked problem or KB. If the fix is a script, read it with sn_fetch_script_by_sysid — quote it, do not retype it.
   - A flow you must walk: navigate + read_page each screen; capture_screenshot ONLY the screens a reader needs to recognise (max 6). Note the exact menu path, field labels and button text as they appear.
   - A pasted or attached description: use it as-is and mark anything you could not verify.
   - Existing coverage: BEFORE drafting, search the knowledge base for the same fix (sn_query_table "kb_knowledge" query "short_descriptionLIKE<key phrase>^workflow_state!=retired"). If a live article already covers it, STOP and propose an update to that article instead of a duplicate.
2. SCRUB before writing: remove user names, emails, phone numbers, IPs, hostnames, ticket-specific dates and any credential. Replace with generic placeholders (<user>, <server>). Keep product, module and field names.
3. STRUCTURE (use exactly these sections; drop only the ones the type does not need)
   Title (verb-first, searchable: "Fix: <symptom>" / "How to <task>") · Applies to (product, version, role) · Symptoms / Problem · Cause · Resolution or Procedure (numbered steps, one action per step, exact labels in quotes, expected result after each step) · Verification (how the reader confirms it worked) · Rollback / Escalation (when to escalate, to whom) · Related records (INC/PRB/CHG numbers, links) · Keywords.
   Write in plain, active sentences. No "should be able to"; say what happens. Steps under 25 words each.
4. CREATE THE DRAFT (approval-gated)
   - ServiceNow target: resolve the knowledge base sys_id first (sn_query_table "kb_knowledge_base" query "titleLIKE<name>"; if none named, ASK which base). Then sn_create_record on kb_knowledge with short_description, text (article body as simple HTML: <h2>, <ol>, <p>), kb_knowledge_base, kb_category if known, workflow_state "draft", and the source record in the description or related list. NEVER set workflow_state to published/approved, never touch the source record, one create only (check sn_check_duplicate on the title first).
   - No ServiceNow target: create_document (docx) or write_file (markdown) into the connected folder, named "<Title> — DRAFT.docx".
5. REPORT: the article title, the record sys_id + URL (or file path), the source it was built from, the scrubbed items, and every line marked "VERIFY" that you could not confirm from the source. Then ask the owner to review before publishing.
RULES: draft only — publishing is a human action. Never invent a step, a menu path or a cause you did not read or see; write "VERIFY: <what is unknown>" instead. One article per run unless asked. Reading records and screens is free; every write (kb_knowledge create, file write) is announced before it happens.`;
