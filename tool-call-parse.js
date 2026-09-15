// tool-call-parse.js — recover tool calls a model emitted as TEXT instead of
// via structured function-calling. This is the PRIMARY tool path for the
// claude-sub / codex-sub bridges (the CLI has no function-calling API, so tools
// are serialized into the prompt and the model emits <tool_call> grammar), and
// a fallback for local models (qwen-coder etc.) that leak text tool calls.
//
// Robustness matters: a call that fails to parse is SILENTLY DROPPED, which
// ends the agent turn as if the model gave a final answer — the run stalls and
// the user must prod it (2026-07-23 live: an Opus/claude-sub Script Include
// build stalled because a multi-line set_editor_value payload had raw newlines
// that broke JSON.parse). So the parser tolerates a missing closing tag
// (streaming/CLI truncation) and repairs literal control chars inside string
// values, and reports `malformed` so the caller can nudge a clean resend
// instead of ending the run. Author: iDevOpsLLC

// Lenient parse of one tool-call JSON body → object or null. Strict JSON.parse
// first, then a repair pass escaping the literal \n / \r / \t a model commonly
// leaves inside a string value (the killer for a multi-line code payload).
export function parseToolJson(raw) {
  let s = String(raw == null ? "" : raw).trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const i = s.indexOf("{");
  if (i === -1) return null;
  const j = s.lastIndexOf("}");
  const body = j > i ? s.slice(i, j + 1) : s.slice(i); // tolerate a missing close brace (truncation)
  try { return JSON.parse(body); } catch { /* try repair */ }
  try {
    let out = "", inStr = false, esc = false;
    for (const ch of body) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = !inStr; out += ch; continue; }
      if (inStr && (ch === "\n" || ch === "\r" || ch === "\t")) {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
        continue;
      }
      out += ch;
    }
    return JSON.parse(out);
  } catch { return null; }
}

// Parse a model's text output for tool calls. Returns { calls, cleaned,
// malformed }: calls[] = {function:{name,arguments}}, cleaned = the text with
// tool-call markup stripped, malformed = count of <tool_call>-looking spans
// that were detected but could not be parsed.
export function extractTextToolCalls(text) {
  const calls = [];
  let malformed = 0;
  if (!text || typeof text !== "string") return { calls, cleaned: text, malformed };
  let cleaned = text;

  // Format A: <function=NAME>...<parameter=KEY>VALUE</parameter>...</function>
  const fnRe = /<function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/function>/gi;
  let m;
  while ((m = fnRe.exec(text)) !== null) {
    const name = m[1].trim();
    const args = {};
    const pRe = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter>/gi;
    let pm;
    while ((pm = pRe.exec(m[2])) !== null) args[pm[1].trim()] = pm[2].trim();
    calls.push({ function: { name, arguments: args } });
    cleaned = cleaned.replace(m[0], "");
  }

  // Format B: <tool_call>{ "name":"…", "arguments":{…} }</tool_call>. Closing
  // tag OPTIONAL — a streaming/CLI truncation used to leave the call unmatched
  // and the run would stall on it.
  const tcRe = /<tool_call\b[^>]*>\s*([\s\S]*?)(?:<\/tool_call>|$)/gi;
  while ((m = tcRe.exec(text)) !== null) {
    const obj = parseToolJson(m[1]);
    const name = obj && (obj.name || (obj.function && obj.function.name));
    if (name) {
      const a = obj.arguments || obj.parameters || (obj.function && obj.function.arguments) || {};
      calls.push({ function: { name, arguments: a } });
      cleaned = cleaned.replace(m[0], "");
    } else {
      malformed++; // markup present but unparseable — caller nudges a resend
    }
  }

  cleaned = cleaned.replace(/<\/?tool_call\b[^>]*>/gi, "").trim();
  return { calls, cleaned, malformed };
}
