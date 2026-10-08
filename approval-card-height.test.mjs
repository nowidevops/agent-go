// approval-card-height.test.mjs — the approval card must never shrink to a line in a full log.
// #log is a scrolling flex column and .tool.approval has overflow:hidden, so without a
// flex-shrink guard the card collapsed to 2 px and the run waited forever (2026-09-21).
// Run: node approval-card-height.test.mjs   Author: iDevOpsLLC
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, ok) => { if (ok) { pass++; console.log("  ok  " + name); } else { fail++; console.error("FAIL  " + name); } };
const html = readFileSync(join(here, "sidepanel.html"), "utf8"), css = readFileSync(join(here, "theme.css"), "utf8");
t("the log is a scrolling flex column (the trap exists)", /#log \{[^}]*display: flex;[^}]*flex-direction: column;/.test(html));
t("the approval card hides its overflow (the trap bites)", /\.tool\.approval \{[^}]*overflow: hidden/.test(css));
t("log items never shrink", html.includes("#log > * { flex-shrink: 0; }"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
