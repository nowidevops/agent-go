// cloud.js — Agent Go SHIM.
// Local LLM's cloud.js held direct vendor API calls (OpenAI/Gemini/Anthropic/xAI) and
// their keys. Agent Go removes ALL direct vendor access from the extension — the backend
// owns the keys and does the vendor call. This shim keeps ONLY the model catalog that the
// options dropdown reads (CLOUD_MODELS); it makes no network calls and holds no keys.
// The authoritative per-tier allowlist is enforced server-side (see backend model-allowlist).
// Author: iDevOpsLLC

// ─────────────────────────────────────────────────────────────────────────────
// AGENT GO — PRODUCTION MODEL CATALOG (2026-07-18): show ONLY the 5 Ollama Cloud
// AGENTIC models; the OpenAI / Anthropic / Gemini / xAI vendor groups are HIDDEN
// "for now" (user directive). Every :cloud model here bills the same flat Agent Go credit
// price per turn, but the upstream Ollama cost is NOT uniform: kimi-k3:cloud (the Auto default on
// plans that include it, 2026-09-15) draws Ollama extra usage. To UN-HIDE the vendor models later, restore the
// commented `openai`/`gemini`/`anthropic`/`xai` groups below — every consumer
// (options.js fillModels, the schedule picker) reads this object, so no other edit
// is needed. The backend still enforces the authoritative per-tier allowlist.
// ─────────────────────────────────────────────────────────────────────────────
export const CLOUD_MODELS = {
  ollamaCloud: [
    // 2026-09-02 (owner): the SAME ten :cloud models the Local LLM extension lists
    // (its dropdown = what is pulled in the local Ollama: `ollama list | grep cloud`).
    // Order = role strength, glm first as the default. The backend routes every
    // ":cloud" id to Ollama Cloud and usage/admin tiers allow all of them; the free
    // tier is limited server-side to glm-5.2:cloud (model-allowlist.js).
    { id: "glm-5.2:cloud",             label: "glm-5.2:cloud — GLM 5.2 (orchestrator · default on Free and Starter)" },
    // 2026-09-02 (owner): GLM 5.3 pair + DeepSeek V4 Flash, verified against Ollama Cloud
    // (/api/show): glm-5.3 = tools+thinking, glm-5.3-flash = tools+thinking+VISION, v4-flash = tools+thinking.
    { id: "glm-5.3:cloud",             label: "glm-5.3:cloud — GLM 5.3 (flagship · strongest open coder · long-horizon agentic)" },
    { id: "glm-5.3-flash:cloud",       label: "glm-5.3-flash:cloud — GLM 5.3 Flash (multimodal · vision · 18B active · fast)" },
    { id: "deepseek-v4-pro:0813-cloud", label: "deepseek-v4-pro:0813-cloud — DeepSeek V4 Pro 0813 (review · long context)" },
    { id: "deepseek-v4-pro:cloud",     label: "deepseek-v4-pro:cloud — DeepSeek V4 Pro (review · reasoning)" },
    // deepseek-v4.1-flash:cloud added 2026-09-15 (owner): live on Ollama Cloud (/api/show: completion, tools, thinking, vision).
    { id: "deepseek-v4.1-flash:cloud", label: "deepseek-v4.1-flash:cloud — DeepSeek V4.1 Flash (newest DeepSeek Flash · vision · tools · thinking · not on Free or Starter)" },
    { id: "kimi-k3:cloud",             label: "kimi-k3:cloud — Kimi K3 (newest Kimi · default where your plan includes it)" },
    { id: "kimi-k2.7-code:cloud",      label: "kimi-k2.7-code:cloud — Kimi K2.7 Code (repair · coding)" },
    { id: "kimi-k2.5:cloud",           label: "kimi-k2.5:cloud — Kimi K2.5 (general · reasoning)" },
    { id: "minimax-m3:cloud",          label: "minimax-m3:cloud — MiniMax M3 (general)" },
    { id: "gpt-oss:120b-cloud",        label: "gpt-oss:120b-cloud — GPT-OSS 120B (open OpenAI · ⚠ bailed mid-run in 07-18 UAT)" },
    { id: "nemotron-3-ultra:cloud",    label: "nemotron-3-ultra:cloud — Nemotron 3 Ultra (⚠ weak in 07-18 UAT)" }
    // Removed 2026-09-02 to match the Local LLM list: qwen3.5:397b:cloud (not pulled locally).
    // Ollama Cloud retires qwen3.5:397b and deepseek-v4-flash on 2026-09-25; both are out of the
    // phase-engine chains as of 2026-09-18 (reverify head is minimax-m3:cloud). History: 07-18 UAT dropped gpt-oss (bailed) + nemotron (useless) and
    // swapped minimax-m3 for qwen3.5 — all three are back BY OWNER REQUEST for list parity;
    // the ⚠ labels carry the UAT verdicts so nobody picks them blind.
  ]
  // HIDDEN for the Agent Go prod UAT — restore to bring vendor models back:
  // openai:    [ { id: "gpt-5-nano", label: "gpt-5-nano — cheapest" }, { id: "gpt-5-mini", label: "gpt-5-mini" }, { id: "gpt-5.6-luna", label: "gpt-5.6-luna" }, { id: "gpt-5.6-terra", label: "gpt-5.6-terra" }, { id: "gpt-5.6-sol", label: "gpt-5.6-sol — top 5.6" }, { id: "gpt-6-astra", label: "gpt-6-astra — GPT-6 Astra (ultra tier; service uses /v1/responses)" } ],
  // gemini:    [ { id: "gemini-flash-lite-latest", label: "gemini-flash-lite-latest — cheapest, 1M ctx" }, { id: "gemini-flash-latest", label: "gemini-flash-latest" }, { id: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview — most capable" } ],
  // anthropic: [ { id: "claude-haiku-4-5", label: "claude-haiku-4-5 — cheapest" }, { id: "claude-sonnet-5", label: "claude-sonnet-5" }, { id: "claude-opus-4-8", label: "claude-opus-4-8 — most capable" } ],
  // xai:       [ { id: "grok-4.5", label: "grok-4.5" } ]
};

// Fallback model = glm-5.2:cloud (allowed on every plan). settings.js DEFAULTS.model is "" (Auto): the
// service runs kimi-k3:cloud on paid plans and glm-5.2:cloud on free (owner 2026-09-15).
export const CLOUD_DEFAULT_MODEL = {
  ollamaCloud: "glm-5.2:cloud"
};
