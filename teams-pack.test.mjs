// teams-pack.test.mjs — URL gate + pack body sanity for the Teams auto-reply pack.
// Run: node teams-pack.test.mjs   Author: iDevOpsLLC
import { needsTeamsPack, teamsPackSource, TEAMS_PACK } from "./teams-pack.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

console.log("— needsTeamsPack (URL gate) —");
t("teams.cloud.microsoft → true", needsTeamsPack("https://teams.cloud.microsoft/foo") === true);
t("teams.microsoft.com → true", needsTeamsPack("https://teams.microsoft.com/bar") === true);
t("subdomain of teams.cloud.microsoft → true", needsTeamsPack("https://tenant.teams.cloud.microsoft/x") === true);
t("query string + fragment do not widen gate", needsTeamsPack("https://teams.cloud.microsoft/c?x=1#frag") === true);
t("gmail → false", needsTeamsPack("https://mail.google.com/") === false);
t("slack → false (no cross-fire)", needsTeamsPack("https://app.slack.com/") === false);
t("microsoft.com marketing → false", needsTeamsPack("https://www.microsoft.com/en-us/microsoft-teams") === false);
t("empty → false", needsTeamsPack("") === false);
t("null → false", needsTeamsPack(null) === false);
t("garbage → false", needsTeamsPack("not a url") === false);

console.log("— TEAMS_PACK body —");
t("pack is non-empty string", typeof TEAMS_PACK === "string" && TEAMS_PACK.length > 500);
t("has the exact approval phrase (load-bearing safety line)", TEAMS_PACK.includes("APPROVED — SEND IT"));
t("forbids pressing Enter to submit", /NEVER press Ctrl\+Enter or Enter to submit/i.test(TEAMS_PACK));
t("forbids clicking Post without approval", /NEVER click the "Post" button/i.test(TEAMS_PACK));
t("forbids reactions/edit/forward", /NEVER delete, edit, react to, or forward/i.test(TEAMS_PACK));
t("scopes read to 5 most recent messages", /5 MOST RECENT messages/i.test(TEAMS_PACK));
t("states read-only default drafting behavior", /ALWAYS BE CREATIVE \(DEFAULT BEHAVIOR\)/i.test(TEAMS_PACK));
t("source label is a non-empty string", typeof teamsPackSource() === "string" && teamsPackSource().length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);