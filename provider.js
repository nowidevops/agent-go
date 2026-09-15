// provider.js — Agent Go drop-in. Same interface Local LLM's background.js already imports
// ({ chatStream, activeProvider }), so the agent loop is ported VERBATIM — only the
// destination changes: every turn goes to the Agent Go backend instead of Ollama/vendors.
// Author: iDevOpsLLC

import { llmgoChatStream, llmgoDescribe } from "./providers.js";
import { getAuthToken } from "./auth.js";
import { getByok } from "./settings.js";

// Agent Go collapses to a single cloud provider.
export function activeProvider() { return "llmgo"; }

export function providerLabel(settings) {
  const m = (settings && settings.model) || "auto";
  return `Agent Go / ${m}`;
}

// Streaming chat — args = { model, messages, tools, signal, onToken, settings, turnId, taskTurnCount }.
// Returns { content, toolCalls } (usage/billed surface via settings.onUsage if provided).
export async function chatStream(args) {
  const s = args.settings || {};
  const token = await getAuthToken();
  // BYOK: when the user configured their own vendor key, EVERY turn runs on their key and
  // their chosen model ($0.05 flat trigger fee) — per-call model overrides don't apply, since
  // the backend dispatches BYOK turns to the byok provider only.
  const byok = await getByok();
  const { content, toolCalls } = await llmgoChatStream({
    backendUrl: s.backendUrl,
    token,
    byok,
    model: byok ? byok.model : (args.model || s.model),
    messages: args.messages,
    tools: args.tools,
    turnId: args.turnId,
    taskTurnCount: args.taskTurnCount,
    signal: args.signal,
    onToken: args.onToken,
    onUsage: s.onUsage || args.onUsage
  });
  return { content, toolCalls };
}

// Vision describe — routed to the PAIRED vision model (glm isn't multimodal), like Local LLM
// pairs a text brain with a separate vision model. Returns { content, vision_model }.
export async function describe({ settings, prompt, base64, signal }) {
  const s = settings || {};
  const token = await getAuthToken();
  return llmgoDescribe({ backendUrl: s.backendUrl, token, model: s.visionModel || "gemma4:31b", prompt, base64, signal });
}
