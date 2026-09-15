// editors.test.mjs — classifySavedUrl: the save-fallback's URL decision
// (2026-07-20h, live SN1 a-live-run: g_form.save() couldn't confirm a new-record
// insert, but the Insert UI action did — success is read from the resulting URL).
// Run: node editors.test.mjs   Author: iDevOpsLLC
import { classifySavedUrl } from "./editors.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const HEX = "0b6d2974530313008cd9ddeeff7b12b2";

console.log("— classifySavedUrl —");
t("saved record URL → sys_id",
  classifySavedUrl(`https://dev000000.service-now.com/sys_script_include.do?sys_id=${HEX}`)?.sys_id === HEX);
t("polaris double-encoded classic URL → sys_id",
  classifySavedUrl(`https://dev000000.service-now.com/now/nav/ui/classic/params/target/sys_script_include.do%3Fsys_id%3D${HEX}%26sys_is_list%3Dtrue`)?.sys_id === HEX);
t("record-list URL → list (insert exited to list = success)",
  classifySavedUrl("https://dev000000.service-now.com/now/nav/ui/classic/params/target/sys_script_include_list.do")?.list === true);
t("NEW-record form (sys_id=-1) → null (not saved)",
  classifySavedUrl("https://dev000000.service-now.com/sys_script_include.do?sys_id=-1&sys_is_list=true") === null);
t("unrelated URL → null",
  classifySavedUrl("https://github.com/features/copilot/plans") === null);
t("empty → null", classifySavedUrl("") === null);
t("does NOT mistake sys_is_list param for a list nav",
  classifySavedUrl("https://x.service-now.com/sys_script_include.do?sys_id=-1&sys_is_list=true") === null);
t("malformed percent escape does NOT throw (falls back to raw)",
  (() => { try { return classifySavedUrl("https://x.service-now.com/incident.do?q=100%") === null; } catch (e) { return false; } })());
t("malformed escape still finds a plain sys_id in the raw URL",
  (() => { try { return classifySavedUrl(`https://x.service-now.com/incident.do?sys_id=${HEX}&bad=%E0%A4`)?.sys_id === HEX; } catch (e) { return false; } })());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
