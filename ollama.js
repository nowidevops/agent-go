// ollama.js — Agent Go SHIM.
// Local LLM talked to a local Ollama daemon here. Agent Go has no local daemon: this shim
// keeps the auxiliary `chat` helper (used by learning.js / teach.js / vision.js fallback)
// working by routing those one-off calls through the Agent Go backend, so they are metered
// like any other turn. `listModels` returns nothing (no local models); `modelCapabilities`
// is permissive so the options UI treats any backend model as capable.
// Author: iDevOpsLLC

import { llmgoChatStream } from "./providers.js";
import { getAuthToken } from "./auth.js";
import { getSettings, getByok } from "./settings.js";

// Non-streaming helper — returns { content, toolCalls } (matches callers reading .content).
export async function chat({ model, messages, tools, signal }) {
  const s = await getSettings();
  let token = "";
  try { token = await getAuthToken(); } catch (_e) { return { content: "", toolCalls: [] }; } // best-effort aux calls
  try {
    const byok = await getByok(); // BYOK: aux turns also run on the user's key/model
    const { content, toolCalls } = await llmgoChatStream({
      backendUrl: s.backendUrl, token, byok, model: byok ? byok.model : (model || s.model), messages, tools, signal
    });
    return { content, toolCalls: toolCalls || [] };
  } catch (_e) {
    return { content: "", toolCalls: [] }; // aux callers (reflection/teach) are best-effort
  }
}

// Streaming passthrough for any code that imported ollama.chatStream directly.
export function chatStream(args) {
  return chat(args).then((r) => {
    if (args && typeof args.onToken === "function" && r.content) args.onToken(r.content);
    return r;
  });
}

// No local models in the cloud edition.
export async function listModels() { return []; }

// Permissive — the backend enforces the real per-tier allowlist server-side.
export async function modelCapabilities() { return ["tools", "vision"]; }
