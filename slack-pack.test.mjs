// slack-pack.test.mjs — URL gate + pack body sanity for the Slack auto-reply pack.
// Run: node slack-pack.test.mjs   Author: iDevOpsLLC
import { needsSlackPack, slackPackSource, SLACK_PACK } from "./slack-pack.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

console.log("— needsSlackPack (URL gate) —");
t("app.slack.com → true", needsSlackPack("https://app.slack.com/client/T0/B0") === true);
t("slack.com → true", needsSlackPack("https://acme.slack.com/messages/C0") === true);
t("subdomain of slack.com → true", needsSlackPack("https://org.slack.com/") === true);
t("query string does not widen gate", needsSlackPack("https://app.slack.com/c?x=1") === true);
t("gmail → false", needsSlackPack("https://mail.google.com/") === false);
t("teams → false (no cross-fire)", needsSlackPack("https://teams.cloud.microsoft/") === false);
t("slack.com marketing root → true (broad host)", needsSlackPack("https://slack.com/") === true);
t("empty → false", needsSlackPack("") === false);
t("null → false", needsSlackPack(null) === false);
t("garbage → false", needsSlackPack("not a url") === false);

console.log("— SLACK_PACK body —");
t("pack is non-empty string", typeof SLACK_PACK === "string" && SLACK_PACK.length > 500);
t("forbids clicking Send", /NEVER click a Send button/i.test(SLACK_PACK));
t("forbids send_* tools", /NEVER call a "send message" \/ "send chat" tool/i.test(SLACK_PACK));
t("forbids Enter in composer", /NEVER press the Enter key while the composer has focus/i.test(SLACK_PACK));
t("requires submit:false", /submit: false\s*← CRITICAL/i.test(SLACK_PACK));
t("forbids edit/delete/react", /NEVER edit, delete, or react to existing messages/i.test(SLACK_PACK));
t("forbids auto-loop", /NEVER auto-loop/i.test(SLACK_PACK));
t("no CB0/CB1 NUL-sentinel artifacts leaked", !/CB0|CB1/.test(SLACK_PACK));
t("has the forbidden-actions quick reference", /QUICK REFERENCE — FORBIDDEN ACTIONS/i.test(SLACK_PACK));
t("source label is a non-empty string", typeof slackPackSource() === "string" && slackPackSource().length > 0);

console.log("— approval gate (2026-07-24 Teams parity) —");
t("has the exact approval phrase (load-bearing safety line)", SLACK_PACK.includes("APPROVED — SEND IT"));
t("send click is gated on the exact phrase", /unless the user has typed the EXACT phrase "APPROVED — SEND IT"/i.test(SLACK_PACK));
t("rejects partial/paraphrase approvals", /No partial match, no paraphrase, no "go ahead", no "yes", no "SEND IT" alone/i.test(SLACK_PACK));
t("has the approval-gate procedure section", /THE APPROVAL GATE \(the only way a message gets sent\)/i.test(SLACK_PACK));
t("approved send is ONE click of the send arrow", /click the send arrow \(paper-plane\) button next to the composer ONCE/i.test(SLACK_PACK));
t("Enter stays forbidden even after approval", /Never press Enter even now/i.test(SLACK_PACK));
t("approved send is verified by read-back", /read_page once to confirm your message appears in the channel history/i.test(SLACK_PACK));
t("non-phrase replies never send", /do NOT click the send arrow\. Do NOT press Enter/i.test(SLACK_PACK));
t("drafts via draft_chat_message first (triggers the side-panel approval card)", /PREFERRED: call draft_chat_message/i.test(SLACK_PACK));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);