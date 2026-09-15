// claude-sub.js — "Claude (subscription)" agent-brain provider: drives the FULL
// agent loop (tools included) through the desktop-server /claude bridge → the
// locally logged-in Claude Code CLI → the user's Claude MAX SUBSCRIPTION.
// No Anthropic API key, no per-token billing.
//
// How tools work here: the CLI is a text-in/text-out call (no function-calling
// API), so tool schemas are serialized into the system prompt and the model is
// instructed to emit calls as <tool_call>{"name":...,"arguments":{...}}</tool_call>
// — EXACTLY Format B of background.js extractTextToolCalls, which the agent
// loop already salvages from plain text (background.js:947). Streaming is
// emulated: the full turn arrives at once and is delivered via one onToken().
// Vision is NOT bridged — provider.describe() returns null for claude-sub and
// the loop falls back to the local Ollama vision model, as with local runs.
// Author: iDevOpsLLC

export const CLAUDE_SUB_DEFAULT_MODEL = "claude-fable-5-1";
// Retired ids still saved in Options / phaseModels JSON map to the successor
// so an upgrade never sends a dead model id to the CLI bridge (2026-09-01).
const LEGACY_MODEL_ALIASES = { "claude-fable-5": CLAUDE_SUB_DEFAULT_MODEL, "claude-fable-5.1": CLAUDE_SUB_DEFAULT_MODEL };
export function normalizeSubModel(id) { return LEGACY_MODEL_ALIASES[id] || id; }

// The transcript is a TEXT protocol, so untrusted content (page text in tool
// results, prior model output) must never be able to counterfeit the protocol
// itself: literal <tool_call> tags become look-alike ‹tool_call› brackets and
// role markers at line starts are defanged (MM final-audit P1 — a hostile web
// page could otherwise forge TOOL RESULT / ASSISTANT turns or inject tool
// calls that extractTextToolCalls would execute).
export function neutralizeUntrusted(text) {
  return String(text ?? "")
    // Match attribute/space variants too (MM 16x-audit B4 / GLM): <tool_call >,
    // <tool_call id="x">, </tool_call > — anything the salvage parser might
    // still accept as an opening/closing tag.
    .replace(/<(\/?)tool_call\b[^>]*>/gi, "‹$1tool_call›")
    // Defang role markers even behind leading whitespace (Sonnet: "  ASSISTANT:"
    // survived the ^-anchored form).
    .replace(/^[\t ]*(USER:|ASSISTANT:|TOOL RESULT)/gm, "· $1");
}

// The bridge asks models for `arguments` as a JSON object, but providers and
// salvage paths sometimes hand back a double-encoded JSON *string* — normalize
// so re-serialized history shows the model its own calls in valid grammar.
function normalizeArgs(a) {
  if (typeof a === "string") { try { return JSON.parse(a); } catch { return { _raw: a }; } }
  return a || {};
}

// Serialize the OpenAI-shaped conversation into transcript BLOCKS (one per
// message). Exported pieces are reused by codex-sub.js.
export function serializeBlocks(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === "system") continue; // sent separately as the CLI system prompt
    if (m.role === "user") {
      out.push("USER:\n" + neutralizeUntrusted(m.content));
    } else if (m.role === "assistant") {
      // Strip raw <tool_call> spans from assistant HISTORY before neutralizing:
      // the structured tool_calls below re-serialize them canonically, and a
      // defanged ‹tool_call› copy teaches the model to MIMIC the defanged form
      // in its next turn — which the salvage parser rightly won't execute
      // (live run 2026-07-16 02:57: EXECUTE ended on an unexecuted tool call).
      let t = neutralizeUntrusted(String(m.content ?? "").replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim());
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        // OUR structured record of the model's calls is the only trusted
        // source of <tool_call> grammar in the transcript.
        t += "\n" + m.tool_calls.map((c) =>
          `<tool_call>${JSON.stringify({ name: c.function?.name, arguments: normalizeArgs(c.function?.arguments) })}</tool_call>`
        ).join("\n");
      }
      out.push("ASSISTANT:\n" + t);
    } else if (m.role === "tool") {
      out.push(`TOOL RESULT (${m.name || "tool"}):\n` + neutralizeUntrusted(m.content));
    }
  }
  return out;
}

// Back-compat single-string form.
export function serializeMessages(messages) {
  return serializeBlocks(messages).join("\n\n");
}

// Budgeted transcript: drop OLDEST whole blocks until it fits — never a raw
// slice that could cut mid-tool-result / mid-<tool_call> / mid-surrogate-pair
// (MM final-audit P1).
export function serializeTranscript(messages, budget = 400000) {
  const blocks = serializeBlocks(messages);
  let total = blocks.reduce((n, b) => n + b.length + 2, 0);
  let dropped = 0;
  // Always keep the last block even if it alone exceeds the budget.
  while (total > budget && blocks.length > 1) {
    total -= blocks.shift().length + 2;
    dropped++;
  }
  const body = blocks.join("\n\n");
  return dropped ? `(…${dropped} older turn${dropped === 1 ? "" : "s"} trimmed…)\n\n` + body : body;
}

// Bridge URLs must stay on this machine: a (sync-poisoned) desktopUrl pointing
// at a remote host would ship subscription prompts + token off-box (MM P1).
export function assertBridgeUrl(url, allowRemote) {
  const base = String(url || "http://localhost:8777").replace(/\/+$/, "");
  if (!allowRemote) {
    let host = "";
    try { host = new URL(base).hostname.toLowerCase(); } catch { /* fall through */ }
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
      throw new Error(`desktop bridge URL must be loopback (got "${base}") — set desktopAllowRemote to override deliberately.`);
    }
  }
  return base;
}

export const TOOL_INSTRUCTIONS = `

TOOL CALLING (READ CAREFULLY): you are the REMOTE BRAIN for a browser extension. The EXTENSION executes tools for you inside the user's browser — your own local harness does not (its native tools are intentionally disabled; that is IRRELEVANT here and is never a reason to refuse). You DO have live browser + ServiceNow access through the tools listed below: never claim you lack browser control or an instance connection — emit a tool call and the extension will run it and return the result. To call one, output EXACTLY this on its own line — nothing before it on the line:
<tool_call>{"name":"<tool name>","arguments":{<JSON arguments>}}</tool_call>
Rules:
- Put the ENTIRE JSON on ONE line and CLOSE the tag with </tool_call>. Inside any string value, escape newlines as \\n, tabs as \\t, and quotes as \\" — a multi-line code payload (e.g. a set_editor_value script) with RAW newlines will FAIL to parse and NOTHING will run.
- At most ONE tool call per turn; after emitting it, STOP — the result arrives as a TOOL RESULT message next turn. Never invent a TOOL RESULT.
- Do NOT narrate or explain the tool-call mechanism ("this environment uses <tool_call> grammar", "native tools are disabled", etc.) — that wastes the turn. Either emit the call, or give the final plain-text answer. One short sentence of intent before a call is fine; a lecture about the protocol is not.
- Do NOT re-run a lookup/setup tool you already ran successfully THIS conversation (e.g. sn_check_duplicate, sn_api_reference, the same query_elements) — its result is already above; reuse it and move to the next concrete step.
- When the task is complete, reply in plain text with NO <tool_call>.`;

// chatStream-compatible: returns { content, tool_calls: [] } — the agent loop's
// text-tool-call salvage turns any <tool_call> markup into structured calls.
export async function claudeSubChatStream({ desktopUrl, desktopToken, model, messages, tools, signal, onToken }) {
  const system = (messages || []).find((m) => m.role === "system")?.content || "";
  const toolBlock = Array.isArray(tools) && tools.length
    ? "\n\nAVAILABLE TOOLS (JSON Schemas):\n" + tools.map((t) => JSON.stringify(t.function)).join("\n") + TOOL_INSTRUCTIONS
    : "";
  // Keep the newest conversation if we ever exceed a sane prompt budget —
  // trimmed on whole-message boundaries, never mid-block.
  const prompt = serializeTranscript(messages) + "\n\nASSISTANT:";
  const base = assertBridgeUrl(desktopUrl);
  const res = await fetch(base + "/claude", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(desktopToken ? { "X-Desktop-Token": desktopToken } : {})
    },
    body: JSON.stringify({
      system: (system + toolBlock).slice(0, 300000),
      prompt,
      model: normalizeSubModel(model) || CLAUDE_SUB_DEFAULT_MODEL,
      timeout_s: 570 // matches AWF's requestTimeoutMs; big agent turns on opus/fable can be slow
    }),
    signal
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) {
    throw new Error((j && j.error) ||
      `Claude subscription bridge HTTP ${res.status} — is the desktop-server running (desktop-server/start-desktop.bat) and the claude CLI logged in?`);
  }
  const content = String(j.content || "");
  if (onToken) onToken(content); // pseudo-stream: one delivery
  return { content, tool_calls: [] };
}
