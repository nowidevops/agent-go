// meeting-followup-pack.js — Meeting Follow-up method pack. Injected
// (background.js) when the task asks for action items, decisions, minutes or a
// follow-up from a meeting transcript, recap page or recording notes. Third of
// the five go-to-market packs (2026-09-04 brief).
//
// SAFETY-BY-DESIGN: every action item quotes the transcript line it came from;
// an owner or date that was not said is marked, never guessed. The follow-up is
// DRAFTED (chat composer or email composer); sending stays behind the same
// exact approval phrase the chat and inbox packs use. CRM / task-tool writes
// happen only when the user asks for them and each one is announced first.
// Author: iDevOpsLLC

const TRANSCRIPT_HOSTS = /(^|\.)(otter\.ai|fireflies\.ai|fathom\.video|tldv\.io|gong\.io|zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.cloud\.microsoft|read\.ai|grain\.com|avoma\.com)$/i;

export function isTranscriptUrl(tabUrl) {
  try {
    const u = new URL(String(tabUrl || ""));
    const h = u.hostname.toLowerCase();
    if (h === "teams.microsoft.com" || h === "teams.cloud.microsoft") return /recap|transcript|meeting/i.test(u.pathname + u.search + u.hash);
    return TRANSCRIPT_HOSTS.test(h);
  } catch {
    return false;
  }
}

export function needsMeetingFollowupPack(taskText, tabUrl) {
  const t = String(taskText || "");
  const meetingNoun = /\b(meeting|call|standup|stand-up|sync|transcript|recap|recording|minutes|1:1|one[- ]on[- ]one|retro|retrospective|kickoff|kick-off|workshop)\b/i.test(t);
  const followVerb = /\b(follow[- ]?up|action items?|next steps?|decisions?|minutes|who owns|owners?|summar(y|ise|ize) (the|this) (meeting|call|transcript|recap)|recap (the|this)|what was (agreed|decided))\b/i.test(t);
  const onTranscript = isTranscriptUrl(tabUrl) && /\b(follow|action|summar|recap|minutes|next step|decision|owner)/i.test(t);
  return (meetingNoun && followVerb) || onTranscript;
}

export const MEETING_FOLLOWUP_PACK = `MEETING FOLLOW-UP MODE — turn a meeting transcript, recap or notes into owners, action items and a follow-up that goes out today. The summary is not the product; the follow-up and the captured commitments are.

⛔ MANDATORY PLAN FIRST: before reading anything, POST a plan — (a) the SOURCE (this tab's transcript / a file in the connected folder / pasted notes) and how you will read all of it, (b) the DELIVERABLES the user asked for (action-item table, decisions, follow-up message, minutes document, CRM or task entries), (c) WHERE each deliverable goes (chat composer, email composer, document, task tool), (d) that nothing is sent without the exact approval phrase.

1. READ THE WHOLE SOURCE. On a transcript page: read_page (max_chars 20000); if the page is longer, scroll_page down and read_page again until the end marker or no new text; note speaker names as shown. A file: read_pdf or read_file. Pasted text: use it. Never summarise from a partial read — say how much you read (e.g. "62 of 62 minutes").
2. EXTRACT, with evidence. Build four lists; every row quotes the exact transcript line (with timestamp or speaker) it came from:
   DECISIONS — what was agreed, by whom, and any condition attached.
   ACTION ITEMS — Owner | Task (verb first) | Due | Evidence quote. An owner who was not named = "OWNER UNCLEAR"; a due date that was not said = "DUE NOT SET". Never infer either from job titles or habit.
   OPEN QUESTIONS — asked and not answered.
   RISKS / BLOCKERS — anything a speaker flagged as a problem.
   A discussed topic with no commitment is not an action item; leave it out.
3. FOLLOW-UP MESSAGE (default deliverable). Draft it in this order: one-line purpose, decisions (bullets), action items as "@Owner — task — due", open questions with who should answer, "reply if I missed or misstated anything". Under 200 words. Written in the user's voice for the attendees, second person, no filler.
   - Chat (Teams/Slack tab open): draft_chat_message into the right conversation — it never sends.
   - Email: open the reply or a new message in the mail tab and type into the composer; NEVER click Send.
   - Neither open: put the message in your reply as a copy block.
4. OPTIONAL DELIVERABLES — only when asked, each announced before it happens: create_document minutes (docx) into the connected folder; a task or CRM note typed into the tool the user names, one record at a time, no status changes.
5. OUTPUT: coverage read · DECISIONS · ACTION ITEMS table · OPEN QUESTIONS · RISKS · the follow-up draft and where it is parked · "Nothing was sent." Then: "Reply 'APPROVED — SEND IT' to send the follow-up, or tell me what to change."
RULES: the exact phrase "APPROVED — SEND IT" is the only thing that sends a message; click Send ONCE, confirm it appears, report "Sent ✓". Quotes are evidence, not decoration — an action item without a quote is removed. Do not attribute a commitment to someone who did not make it. Same-day follow-up is the goal: read, extract and draft in one turn.`;
