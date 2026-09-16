// knowledge-packs.test.mjs — gates, precedence and content of the five
// go-to-market knowledge-worker packs (KB/SOP writer, inbox drafter, meeting
// follow-up, contract review, RFP response). Run: node knowledge-packs.test.mjs
// Author: iDevOpsLLC
import { KB_ARTICLE_PACK, needsKbArticlePack } from "./kb-article-pack.js";
import { INBOX_PACK, needsInboxPack } from "./inbox-pack.js";
import { MEETING_FOLLOWUP_PACK, needsMeetingFollowupPack, isTranscriptUrl } from "./meeting-followup-pack.js";
import { CONTRACT_REVIEW_PACK, needsContractReviewPack } from "./contract-review-pack.js";
import { RFP_PACK, needsRfpPack } from "./rfp-pack.js";
import { needsSnPostDeployPack } from "./servicenow-postdeploy-pack.js";
import { needsSnCodeReviewPack } from "./servicenow-codereview-pack.js";
import { needsSnIncidentResolutionPack } from "./servicenow-incident-resolution-pack.js";
import { needsSnRcaPack } from "./servicenow-rca-pack.js";
import { needsRcaPack } from "./rca-pack.js";
import { needsResearchPack } from "./research-pack.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const SN_URL = "https://dev000000.service-now.com/now/nav/ui/classic/params/target/incident.do";

console.log("— KB / SOP writer gate —");
t("'write a knowledge article for INC…' trips", needsKbArticlePack("Write a knowledge article for INC0010001 from its resolution notes.", ""));
t("'turn this fix into a KB article' trips", needsKbArticlePack("Turn this fix into a KB article.", SN_URL));
t("'document this procedure' trips", needsKbArticlePack("Document this procedure so the team can repeat it.", ""));
t("'create an SOP for onboarding' trips", needsKbArticlePack("Create an SOP for onboarding a new contractor.", ""));
t("'draft a runbook' trips", needsKbArticlePack("Draft a runbook for restarting the MID server.", ""));
t("plain 'resolve INC…' does NOT trip", !needsKbArticlePack("Resolve INC0010001 — users cannot submit the form.", ""));
t("'code review this Business Rule' does NOT trip", !needsKbArticlePack("Code review this Business Rule.", SN_URL));
t("mention of 'knowledge' without an article noun does NOT trip", !needsKbArticlePack("What knowledge do you have about GlideAjax?", ""));

console.log("— inbox drafter gate (URL) —");
t("Gmail trips", needsInboxPack("https://mail.google.com/mail/u/0/#inbox"));
t("Outlook (office) trips", needsInboxPack("https://outlook.office.com/mail/inbox"));
t("Outlook (live) trips", needsInboxPack("https://outlook.live.com/mail/0/"));
t("Google Docs does NOT trip", !needsInboxPack("https://docs.google.com/document/d/abc"));
t("mail-lookalike host does NOT trip", !needsInboxPack("https://mail.google.com.evil.example/"));
t("garbage URL does NOT throw", needsInboxPack("not a url") === false);

console.log("— meeting follow-up gate —");
t("'follow up on this meeting' trips", needsMeetingFollowupPack("Follow up on this meeting with owners and dates.", ""));
t("'action items from the transcript' trips", needsMeetingFollowupPack("Pull the action items from the transcript.", ""));
t("'summarize this call and next steps' trips", needsMeetingFollowupPack("Summarize this call and list the next steps.", ""));
t("'what was decided in the retro' trips", needsMeetingFollowupPack("What was decided in the retro?", ""));
t("transcript tab + 'owners' trips", needsMeetingFollowupPack("Who are the owners here?", "https://otter.ai/u/abc"));
t("Teams recap URL counts as a transcript page", isTranscriptUrl("https://teams.microsoft.com/l/meetingrecap?x=1"));
t("Teams chat URL does not", !isTranscriptUrl("https://teams.microsoft.com/v2/"));
t("'schedule a meeting' does NOT trip", !needsMeetingFollowupPack("Schedule a meeting with the vendor next week.", ""));
t("'follow up with the customer' (no meeting noun) does NOT trip", !needsMeetingFollowupPack("Follow up with the customer about the invoice.", ""));

console.log("— contract review gate —");
t("'review this NDA against our playbook' trips", needsContractReviewPack("Review this NDA against our playbook."));
t("'redline the MSA' trips", needsContractReviewPack("Redline the MSA in the connected folder."));
t("'what are the risks in this vendor agreement' trips", needsContractReviewPack("What are the risks in this vendor agreement?"));
t("'summarize the key terms of the SOW' trips", needsContractReviewPack("Summarize the key terms of the SOW."));
t("'send the contract to legal' (no review verb) does NOT trip", !needsContractReviewPack("Send the contract to legal."));
t("'review my Script Include' (no contract noun) does NOT trip", !needsContractReviewPack("Review my Script Include for best practices."));

console.log("— RFP gate —");
t("'respond to this RFP' trips", needsRfpPack("Respond to this RFP using our answer library."));
t("'answer the security questionnaire' trips", needsRfpPack("Answer the security questionnaire from the folder."));
t("'shred the tender into requirements' trips", needsRfpPack("Shred the tender into requirements."));
t("'draft a proposal for Acme' trips", needsRfpPack("Draft a proposal response for Acme's RFI."));
t("'when is the RFP due' (no respond verb) does NOT trip", !needsRfpPack("When is the RFP due?"));
t("'write a business rule' does NOT trip", !needsRfpPack("Write a Business Rule that sets priority."));

console.log("— precedence: intended pack wins the background.js chain —");
function winner(task, url) {
  if (needsSnPostDeployPack(task, url)) return "postdeploy";
  if (needsKbArticlePack(task, url)) return "kb";
  if (needsContractReviewPack(task)) return "contract";
  if (needsRfpPack(task)) return "rfp";
  if (needsMeetingFollowupPack(task, url)) return "meeting";
  if (needsSnCodeReviewPack(task, url)) return "codereview";
  if (needsSnIncidentResolutionPack(task, url)) return "incident";
  if (needsSnRcaPack(task, url)) return "snrca";
  if (needsRcaPack(task)) return "rca";
  if (needsResearchPack(task)) return "research";
  return "none";
}
t("KB article from an incident → kb (not incident)", winner("Write a knowledge article for INC0010001 from its resolution notes.", SN_URL) === "kb");
t("SN code review still → codereview", winner("Code review this Business Rule for issues.", SN_URL) === "codereview");
t("resolve INC still → incident", winner("Resolve INC0012345 — users can't submit the form.", SN_URL) === "incident");
t("NDA review on an SN tab → contract (no SN vocabulary)", winner("Review this NDA against our playbook.", SN_URL) === "contract");
t("RFP response → rfp", winner("Respond to this RFP using our answer library.", "") === "rfp");
t("meeting follow-up → meeting", winner("Follow up on this meeting with owners and dates.", "") === "meeting");
t("post-deployment validation still → postdeploy", winner("Post-deployment validation: review the deployed update set content in ServiceNow.", SN_URL) === "postdeploy");
t("generic diagnosis still → rca", winner("Debug why my Node server keeps crashing.", "") === "rca");
t("deep research still → research", winner("Do deep research on MID Server sizing.", "") === "research");
t("'compare vendors' research is not mistaken for an RFP", winner("Do a detailed comparison of three CRM vendors for a 20-person team.", "") === "research");

console.log("— content: plan-first, read-only / draft-only, approval gate, real tool names —");
for (const [name, pack] of [["kb", KB_ARTICLE_PACK], ["meeting", MEETING_FOLLOWUP_PACK], ["contract", CONTRACT_REVIEW_PACK], ["rfp", RFP_PACK]]) {
  t(`${name}: mandates a plan before acting`, /MANDATORY PLAN FIRST/.test(pack));
}
t("kb: draft only, never published", /workflow_state "draft"/.test(KB_ARTICLE_PACK) && /NEVER set workflow_state to published/.test(KB_ARTICLE_PACK));
t("kb: scrubs PII", /SCRUB/.test(KB_ARTICLE_PACK) && /emails/.test(KB_ARTICLE_PACK));
t("kb: checks for an existing article first", /kb_knowledge" query "short_descriptionLIKE/.test(KB_ARTICLE_PACK));
t("inbox: exact approval phrase is the only send path", /"APPROVED — SEND IT"/.test(INBOX_PACK) && /NEVER click "Send"/.test(INBOX_PACK));
t("inbox: forbids send_email / send_sms without the phrase", /send_email or send_sms/.test(INBOX_PACK));
t("inbox: mailbox is read-only (no archive/delete/label)", /NEVER archive, delete/.test(INBOX_PACK));
t("inbox: privacy — no mail content into files", /Do not save_note, write_file, create_document/.test(INBOX_PACK));
t("inbox: five buckets", ["NEEDS REPLY", "WAITING ON THEM", "ACTION (NO REPLY)", "FYI", "NOISE"].every((b) => INBOX_PACK.includes(b)));
t("meeting: owner/date never guessed", /OWNER UNCLEAR/.test(MEETING_FOLLOWUP_PACK) && /DUE NOT SET/.test(MEETING_FOLLOWUP_PACK));
t("meeting: every action item quotes the transcript", /quotes the exact transcript line/.test(MEETING_FOLLOWUP_PACK));
t("meeting: send gated by exact phrase", /"APPROVED — SEND IT"/.test(MEETING_FOLLOWUP_PACK) && /NEVER click Send/.test(MEETING_FOLLOWUP_PACK));
t("contract: read-only on the contract file", /READ-ONLY/.test(CONTRACT_REVIEW_PACK) && /never edit it/.test(CONTRACT_REVIEW_PACK));
t("contract: not-legal-advice line", /not legal advice/.test(CONTRACT_REVIEW_PACK));
t("contract: default checklist covers liability cap + governing law", /limitation of liability/.test(CONTRACT_REVIEW_PACK) && /governing law/.test(CONTRACT_REVIEW_PACK));
t("contract: severity ladder", /WALK-AWAY \/ NEGOTIATE \/ ACCEPT/.test(CONTRACT_REVIEW_PACK));
t("rfp: compliance statement first", /COMPLY \/ PARTIALLY COMPLY \/ DO NOT COMPLY \/ CLARIFICATION NEEDED/.test(RFP_PACK));
t("rfp: gap list is mandatory", /GAP LIST \(mandatory section\)/.test(RFP_PACK));
t("rfp: fan-out capped", /max 4/.test(RFP_PACK));
t("rfp: a claim without a citation is a gap", /A claim you cannot cite is a GAP/.test(RFP_PACK));

// Drift guard: every tool a pack names must be a REAL extension tool.
const REAL = new Set(["sn_query_table", "sn_query_record", "sn_query_session", "sn_recent_changes", "sn_compare_record", "sn_search_script_body", "sn_fetch_script_by_name", "sn_fetch_script_by_sysid", "sn_api_reference", "sn_set_field", "sn_create_record", "sn_update_record", "sn_check_duplicate", "sn_query_schema", "sn_login",
  "read_page", "query_elements", "fill_input", "click_element", "select_option", "navigate", "scroll_page", "capture_screenshot", "get_tab_info", "list_tabs",
  "read_pdf", "read_file", "write_file", "search_files", "list_files", "create_document", "save_note", "get_note",
  "draft_chat_message", "send_chat_message", "read_chat_messages", "send_email", "send_sms", "spawn_subagent", "web_search", "fetch_page"]);
const TOOL_RE = /\b(sn_[a-z_]+|read_page|query_elements|fill_input|click_element|select_option|navigate|scroll_page|capture_screenshot|get_tab_info|list_tabs|read_pdf|read_file|write_file|search_files|list_files|create_document|save_note|get_note|draft_chat_message|send_chat_message|read_chat_messages|send_email|send_sms|spawn_subagent|web_search|fetch_page|[a-z]+_[a-z_]+_(?:record|table|value|message|screenshot|document|file|files|note|page|elements))\b/g;
for (const [name, pack] of [["kb", KB_ARTICLE_PACK], ["inbox", INBOX_PACK], ["meeting", MEETING_FOLLOWUP_PACK], ["contract", CONTRACT_REVIEW_PACK], ["rfp", RFP_PACK]]) {
  const named = [...new Set(pack.match(TOOL_RE) || [])].filter((n) => /_/.test(n) && !/^(kb_knowledge|kb_knowledge_base|kb_category|short_description|workflow_state|cmdb_ci|resolved_by|close_notes|work_notes|kb_knowledge_base|sn_ws|max_chars|read_ai)$/.test(n));
  const bogus = named.filter((n) => !REAL.has(n));
  t(`${name}: every named tool exists (${named.length} named)`, bogus.length === 0, bogus.join(", "));
}

console.log("— inbox pack: injection block must not reference ctx (2026-09-07 regression: ReferenceError skipped the pack) —");
{
  const src = (await import("node:fs")).readFileSync(new URL("./background.js", import.meta.url), "utf8");
  const start = src.indexOf("needsInboxPack(tabUrl)");
  const block = src.slice(start, src.indexOf("needsTeamsPack(tabUrl)", start));
  t("inbox block does not assign ctx.inboxDrafter", !/ctx\.inboxDrafter\s*=/.test(block), "ctx is not defined in runAgent");
  t("inbox block sets the local inboxDrafter flag", /\binboxDrafter = true;/.test(block));
  t("loopCtx carries inboxDrafter to agentLoop", /const loopCtx = \{[\s\S]*?\binboxDrafter,[\s\S]*?tradingPackInjected/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
