// codex-sub.js — "ChatGPT (subscription)" agent-brain provider: mirrors
// claude-sub.js but through OpenAI's Codex CLI (`codex exec`), signed in with
// the user's ChatGPT account — Plus/Pro plan usage, no OpenAI API key.
// Same transcript serialization and <tool_call>{json}</tool_call> grammar
// (background.js extractTextToolCalls Format B executes the calls).
// Setup once:  npm install -g @openai/codex   then   codex login
// Author: iDevOpsLLC

import { serializeTranscript, assertBridgeUrl, TOOL_INSTRUCTIONS } from "./claude-sub.js";

export const CODEX_SUB_DEFAULT_MODEL = "gpt-5-codex";

// "gpt-5-codex" IS the CLI's plan default — translate it to "" (no -m flag) so
// the SAME configured model resolves identically in every codex call site
// (gate default* bridge and this agent-brain path — MM final-audit asymmetry).
export function codexModelArg(model) {
  return model && model !== CODEX_SUB_DEFAULT_MODEL ? model : "";
}

export async function codexSubChatStream({ desktopUrl, desktopToken, model, messages, tools, signal, onToken }) {
  const system = (messages || []).find((m) => m.role === "system")?.content || "";
  const toolBlock = Array.isArray(tools) && tools.length
    ? "\n\nAVAILABLE TOOLS (JSON Schemas):\n" + tools.map((t) => JSON.stringify(t.function)).join("\n") + TOOL_INSTRUCTIONS
    : "";
  const prompt = serializeTranscript(messages) + "\n\nASSISTANT:";
  const base = assertBridgeUrl(desktopUrl);
  const res = await fetch(base + "/codex", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(desktopToken ? { "X-Desktop-Token": desktopToken } : {})
    },
    body: JSON.stringify({
      system: (system + toolBlock).slice(0, 300000),
      prompt,
      model: codexModelArg(model), // "" → the CLI's plan default; -m only when explicitly chosen
      timeout_s: 570
    }),
    signal
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) {
    throw new Error((j && j.error) ||
      `ChatGPT subscription bridge HTTP ${res.status} — is the desktop-server running and the codex CLI installed + logged in (npm i -g @openai/codex; codex login)?`);
  }
  const content = String(j.content || "");
  if (onToken) onToken(content);
  return { content, tool_calls: [] };
}
