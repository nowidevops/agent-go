// tool-call-parse.test.mjs — text-tool-call recovery robustness (2026-07-23).
// Run: node tool-call-parse.test.mjs   Author: iDevOpsLLC
import { parseToolJson, extractTextToolCalls } from "./tool-call-parse.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

console.log("— parseToolJson —");
t("clean JSON", parseToolJson('{"name":"a","arguments":{"x":1}}')?.name === "a");
t("fenced ```json block", parseToolJson('```json\n{"name":"a","arguments":{}}\n```')?.name === "a");
t("prose around the object is stripped", parseToolJson('sure: {"name":"a","arguments":{}} done')?.name === "a");
// THE bug: a code payload with RAW newlines inside a string value.
const codeVal = 'var X = 1;\nfunction f() {\n  return 2;\n}';
const rawNL = `{"name":"set_editor_value","arguments":{"index":0,"value":"var X = 1;\n  return 2;"}}`;
const repaired = parseToolJson(rawNL);
t("repairs literal newlines inside a string value", repaired && repaired.name === "set_editor_value" && repaired.arguments.value.includes("return 2"));
t("truncated mid-value → null (not a wrong parse)", parseToolJson('{"name":"a","arguments":{"value":"unterminat') === null);
t("no object → null", parseToolJson("just prose") === null);

console.log("— extractTextToolCalls: happy paths —");
let r = extractTextToolCalls('Setting it now.\n<tool_call>{"name":"sn_set_field","arguments":{"field":"client_callable","value":"true"}}</tool_call>');
t("recovers a well-formed <tool_call>", r.calls.length === 1 && r.calls[0].function.name === "sn_set_field");
t("cleaned text drops the markup", !r.cleaned.includes("tool_call") && r.cleaned.includes("Setting it now"));
t("no malformed flag on a good call", r.malformed === 0);

r = extractTextToolCalls('<function=navigate><parameter=url>https://x.test</parameter></function>');
t("Format A <function=…> still works", r.calls.length === 1 && r.calls[0].function.name === "navigate" && r.calls[0].function.arguments.url === "https://x.test");

console.log("— extractTextToolCalls: the stall cases (previously dropped → run ended) —");
r = extractTextToolCalls('Writing the script.\n<tool_call>{"name":"set_editor_value","arguments":{"index":0,"value":"var G = 1;\nfunction getCount(){\n  return 2;\n}"}}</tool_call>');
t("multi-line set_editor_value now recovers (was: JSON.parse throw → drop)", r.calls.length === 1 && r.calls[0].function.name === "set_editor_value");
t("recovered code value keeps its newlines", /\n/.test(r.calls[0].function.arguments.value));

r = extractTextToolCalls('<tool_call>{"name":"save_record","arguments":{}}'); // NO closing tag (truncation)
t("missing </tool_call> still recovers", r.calls.length === 1 && r.calls[0].function.name === "save_record");

r = extractTextToolCalls('<tool_call >{"name":"list_editors","arguments":{}}</tool_call >'); // attribute/space variant
t("tag with spaces/attrs recovers", r.calls.length === 1 && r.calls[0].function.name === "list_editors");

console.log("— malformed detection (drives the resend nudge) —");
r = extractTextToolCalls('<tool_call>{ this is not json at all }</tool_call>');
t("truly-broken JSON → 0 calls + malformed>0", r.calls.length === 0 && r.malformed >= 1);
r = extractTextToolCalls('Here is my final answer with no tool call.');
t("plain answer → 0 calls, 0 malformed", r.calls.length === 0 && r.malformed === 0);

console.log("— safety: does NOT invent calls from prose/JSON that isn't a tool_call —");
r = extractTextToolCalls('The config is {"name":"foo","port":8080} for reference.');
t("bare JSON without <tool_call> is ignored", r.calls.length === 0 && r.malformed === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
