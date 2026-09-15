// byok-env.js — read a provider API key out of a local file (.env, JSON, or any text with
// NAME=value lines) for the Bring-your-own-key card. Owner request 2026-09-03, mirroring the
// Local LLM extension's "Load keys from .env". Pure functions; the Options page does the file I/O.
// Author: iDevOpsLLC
//
// Parsed on this machine only. The result goes into the BYOK key field; the user still clicks Save.

export const ENV_KEY_NAMES = {
  openai: ["OPENAI_API_KEY", "OPENAI_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "GEMINI_KEY"],
  xai: ["XAI_API_KEY", "GROK_API_KEY"],
  custom: ["OPENROUTER_API_KEY", "DASHSCOPE_API_KEY", "TOGETHER_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "FIREWORKS_API_KEY", "PERPLEXITY_API_KEY", "MOONSHOT_API_KEY", "CUSTOM_OPENAI_API_KEY"]
};
export const PROVIDER_LABEL = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", xai: "xAI", custom: "Custom endpoint" };
/** For a custom-endpoint key found under a well-known name, the base URL that key belongs to. */
export const CUSTOM_BASE_URL_BY_NAME = {
  OPENROUTER_API_KEY: "https://openrouter.ai/api/v1",
  DASHSCOPE_API_KEY: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  TOGETHER_API_KEY: "https://api.together.xyz/v1",
  GROQ_API_KEY: "https://api.groq.com/openai/v1",
  DEEPSEEK_API_KEY: "https://api.deepseek.com",
  MISTRAL_API_KEY: "https://api.mistral.ai/v1",
  FIREWORKS_API_KEY: "https://api.fireworks.ai/inference/v1",
  PERPLEXITY_API_KEY: "https://api.perplexity.ai",
  MOONSHOT_API_KEY: "https://api.moonshot.ai/v1"
};
/** Which well-known custom name (if any) the file's usable custom key came from → its base URL, or "". */
export function customBaseUrlFor(env) {
  if (!env) return "";
  for (const n of ENV_KEY_NAMES.custom) {
    const v = env[n] != null ? env[n] : env[Object.keys(env).find((k) => k.toLowerCase() === n.toLowerCase()) || ""];
    if (v && pickEnvKey({ [n]: v }, "custom") && CUSTOM_BASE_URL_BY_NAME[n]) return CUSTOM_BASE_URL_BY_NAME[n];
  }
  return "";
}

/** .env / shell-export / "NAME: value" lines → { NAME: value }. Quotes and inline comments stripped. */
export function parseEnv(text) {
  const out = {};
  for (let line of String(text || "").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = /^(["'])(.*?)\1\s*,?\s*(#.*)?$/.exec(v); // quoted value, optionally followed by , or # comment
    if (q) v = q[2];
    else v = v.replace(/\s+#.*$/, "").replace(/,$/, "").trim(); // unquoted: drop a trailing " # comment" / ","
    out[m[1]] = v;
  }
  return out;
}

/** JSON of any shape → flat { NAME: value } for every string leaf (nested keys joined with "."). */
export function flattenJson(obj, prefix = "", out = {}) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? prefix + "." + k : k;
    if (typeof v === "string") out[name] = v;
    else if (v && typeof v === "object") flattenJson(v, name, out);
  }
  return out;
}

/** Any supported file text → { NAME: value }. JSON is tried first; everything else is treated as lines. */
export function parseKeyFile(text) {
  const t = String(text || "").trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return flattenJson(JSON.parse(t)); } catch (_e) { /* not JSON after all — fall through */ }
  }
  return parseEnv(t);
}

const PLACEHOLDER = /^your[-_ ]|^demo$|change[-_ ]?me|replace[-_ ]?me|^xxx+$|^sk-x+$|^<.*>$|^sk-\.\.\.|^\.\.\.$|placeholder|^todo|^example|^sample|\$\{/i;
// Values that are clearly not keys: URLs, paths, shell references.
const NOT_A_KEY = /:\/\/|^[\/~.]|\\|\$\{/;
// Names that hold something ABOUT a key rather than the key (only used by the loose pass).
const NOT_A_KEY_NAME = /(url|uri|file|path|endpoint|host|base|name|id)$/i;

/** The value to use for one provider, or "". Exact names first, then a case-insensitive name match. */
export function pickEnvKey(env, provider) {
  if (!env || !provider) return "";
  const names = ENV_KEY_NAMES[provider] || [];
  const clean = (v) => (typeof v === "string" && v.trim() && !PLACEHOLDER.test(v.trim()) && !NOT_A_KEY.test(v.trim()) && /^[\x21-\x7E]{20,512}$/.test(v.trim())) ? v.trim() : "";
  for (const n of names) { const v = clean(env[n]); if (v) return v; }
  const lower = Object.fromEntries(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) { const v = clean(lower[n.toLowerCase()]); if (v) return v; }
  // Last resort: a key whose name mentions the provider and "key" (e.g. "anthropicKey", "keys.openai").
  const tag = provider === "xai" ? /(xai|grok)/i : provider === "custom" ? /(openrouter|dashscope|together|groq|deepseek|mistral|fireworks|perplexity|moonshot|custom)/i : new RegExp(provider, "i");
  const loose = [];
  for (const [k, v] of Object.entries(env)) {
    if (!tag.test(k) || !/key|token|secret/i.test(k) || NOT_A_KEY_NAME.test(k)) continue;
    if (provider === "openai" && /azure/i.test(k)) continue; // Azure OpenAI keys are a different service
    const c = clean(v); if (c && loose.indexOf(c) === -1) loose.push(c);
  }
  return loose.length === 1 ? loose[0] : ""; // more than one candidate: do not guess

}

/** Every provider the file has a usable key for, in card order. */
export function providersInFile(env) {
  return Object.keys(ENV_KEY_NAMES).filter((p) => !!pickEnvKey(env, p));
}
