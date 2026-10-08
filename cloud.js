// cloud.js — Agent Go SHIM.
// Local LLM's cloud.js held direct vendor API calls (OpenAI/Gemini/Anthropic/xAI) and
// their keys. Agent Go removes ALL direct vendor access from the extension — the backend
// owns the keys and does the vendor call. This shim keeps ONLY the model catalog that the
// options dropdown reads (CLOUD_MODELS); it makes no network calls and holds no keys.
// The authoritative per-tier allowlist is enforced server-side (see backend model-allowlist).
// Author: iDevOpsLLC

// ─────────────────────────────────────────────────────────────────────────────
// AGENT GO — PRODUCTION MODEL CATALOG (2026-07-18): show ONLY the 5 Ollama Cloud
// AGENTIC models (OpenAI came back 2026-09-29, see openaiHosted); the Anthropic / Gemini / xAI vendor groups are HIDDEN
// "for now" (user directive). Every :cloud model here bills the same flat Agent Go credit
// price per turn, but the upstream Ollama cost is NOT uniform: kimi-k3:cloud (the Auto default on
// plans that include it, 2026-09-15) draws Ollama extra usage. To UN-HIDE the vendor models later, restore the
// commented `openai`/`gemini`/`anthropic`/`xai` groups below — every consumer
// (options.js fillModels, the schedule picker) reads this object, so no other edit
// is needed. The backend still enforces the authoritative per-tier allowlist.
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-01 (owner): the picker shows the model id only, no description.
export const CLOUD_MODELS = {
  ollamaCloud: [
    // 2026-09-02 (owner): the SAME ten :cloud models the Local LLM extension lists
    // (its dropdown = what is pulled in the local Ollama: `ollama list | grep cloud`).
    // Order = role strength, glm first as the default. The backend routes every
    // ":cloud" id to Ollama Cloud and usage/admin tiers allow all of them; the free
    // tier is limited server-side to glm-5.2:cloud (model-allowlist.js).
    { id: "glm-5.2:cloud",             label: "glm-5.2:cloud" },
    // 2026-09-02 (owner): GLM 5.3 pair + DeepSeek V4 Flash, verified against Ollama Cloud
    // (/api/show): glm-5.3 = tools+thinking, glm-5.3-flash = tools+thinking+VISION, v4-flash = tools+thinking.
    { id: "glm-5.3:cloud",             label: "glm-5.3:cloud" },
    { id: "glm-5.3-flash:cloud",       label: "glm-5.3-flash:cloud" },
    { id: "deepseek-v4-pro:0813-cloud", label: "deepseek-v4-pro:0813-cloud" },
    { id: "deepseek-v4-pro:cloud",     label: "deepseek-v4-pro:cloud" },
    { id: "deepseek-v4-flash:cloud",   label: "deepseek-v4-flash:cloud" },
    // deepseek-v4.1-flash:cloud added 2026-09-15 (owner): live on Ollama Cloud (/api/show: completion, tools, thinking, vision).
    { id: "deepseek-v4.1-flash:cloud", label: "deepseek-v4.1-flash:cloud" },
    { id: "kimi-k3:cloud",             label: "kimi-k3:cloud" },
    { id: "kimi-k2.7-code:cloud",      label: "kimi-k2.7-code:cloud" },
    { id: "kimi-k2.5:cloud",           label: "kimi-k2.5:cloud" },
    { id: "minimax-m3:cloud",          label: "minimax-m3:cloud" },
    { id: "gpt-oss:120b-cloud",        label: "gpt-oss:120b-cloud" },
    { id: "nemotron-3-ultra:cloud",    label: "nemotron-3-ultra:cloud" }
    // Removed 2026-09-02 to match the Local LLM list: qwen3.5:397b:cloud (not pulled locally;
    // still used server-side by the phase-engine reverify chain — chains are not limited to
    // this dropdown). History: 07-18 UAT dropped gpt-oss (bailed) + nemotron (useless) and
    // swapped minimax-m3 for qwen3.5 — all three are back BY OWNER REQUEST for list parity;
    // the ⚠ labels carry the UAT verdicts so nobody picks them blind.
  ],
  // OpenAI UN-HIDDEN 2026-09-29 (owner). The backend runs these on the platform key and sends
  // the GPT-6 family to /v1/responses (chat/completions refuses function tools for it); all five
  // were live-verified returning a tool call that day. Tiers are enforced by model-allowlist.js:
  // nano on every plan, luna from Starter, the rest from Professional. gpt-6-astra-ultrafast is
  // left out on purpose: the backend refuses it on the platform key (BYOK only).
  // Keyed "openaiHosted", not "openai": the sidepanel schedule picker lists the "openai" group as
  // a vendor-KEY provider and would show these disabled with "add a key", which Agent Go has no field for.
  openaiHosted: [
    { id: "gpt-5-nano",    label: "gpt-5-nano" },
    { id: "gpt-6-luna",    label: "gpt-6-luna" },
    { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
    { id: "gpt-6.1-sol",   label: "gpt-6.1-sol" },
    { id: "gpt-6-astra",   label: "gpt-6-astra" }
  ]
  // HIDDEN for the Agent Go prod UAT — restore to bring vendor models back:
  // gemini:    [ { id: "gemini-flash-lite-latest", label: "gemini-flash-lite-latest — cheapest, 1M ctx" }, { id: "gemini-flash-latest", label: "gemini-flash-latest" }, { id: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview — most capable" } ],
  // anthropic: [ { id: "claude-haiku-4-5", label: "claude-haiku-4-5 — cheapest" }, { id: "claude-sonnet-5", label: "claude-sonnet-5" }, { id: "claude-opus-4-8", label: "claude-opus-4-8 — most capable" } ],
  // xai:       [ { id: "grok-4.5", label: "grok-4.5" } ]
};

// Fallback model = glm-5.2:cloud (allowed on every plan). settings.js DEFAULTS.model is "" (Auto): the
// service runs kimi-k3:cloud on paid plans and glm-5.2:cloud on free (owner 2026-09-15).
export const CLOUD_DEFAULT_MODEL = {
  ollamaCloud: "glm-5.2:cloud"
};
