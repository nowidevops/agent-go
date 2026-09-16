// byok-env.test.mjs — key import from .env / JSON / loose text. Run: node byok-env.test.mjs
// Author: iDevOpsLLC
import { parseEnv, parseKeyFile, pickEnvKey, providersInFile } from "./byok-env.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const K = (p) => p + "-" + "a1B2c3D4".repeat(5); // realistic-length fake keys (not an all-x placeholder)

const env = parseEnv(`
# comment
export OPENAI_API_KEY="${K("sk")}"
ANTHROPIC_API_KEY='${K("sk-ant")}'
GEMINI_API_KEY=${K("AIza")} # trailing comment
XAI_API_KEY: ${K("xai")}
EMPTY=
QUOTED_HASH="abc#def"
`);
t("env: export + double quotes", env.OPENAI_API_KEY === K("sk"));
t("env: single quotes", env.ANTHROPIC_API_KEY === K("sk-ant"));
t("env: trailing comment stripped on unquoted value", env.GEMINI_API_KEY === K("AIza"));
t("env: NAME: value form", env.XAI_API_KEY === K("xai"));
t("env: quoted hash kept", env.QUOTED_HASH === "abc#def");
t("env: empty value", env.EMPTY === "");

t("pick: exact name", pickEnvKey(env, "openai") === K("sk"));
t("pick: anthropic", pickEnvKey(env, "anthropic") === K("sk-ant"));
t("pick: xai", pickEnvKey(env, "xai") === K("xai"));
t("pick: empty value is not a key", pickEnvKey({ OPENAI_API_KEY: "" }, "openai") === "");
t("pick: placeholder rejected", pickEnvKey({ OPENAI_API_KEY: "your-openai-api-key-goes-here-please" }, "openai") === "");
t("pick: too short rejected", pickEnvKey({ OPENAI_API_KEY: "sk-short" }, "openai") === "");
t("pick: whitespace inside rejected", pickEnvKey({ OPENAI_API_KEY: "sk-" + "a".repeat(20) + " " + "b".repeat(20) }, "openai") === "");
t("pick: alias GOOGLE_API_KEY", pickEnvKey({ GOOGLE_API_KEY: K("AIza") }, "gemini") === K("AIza"));
t("pick: case-insensitive name", pickEnvKey({ anthropic_api_key: K("sk-ant") }, "anthropic") === K("sk-ant"));
t("pick: loose name with provider + key", pickEnvKey({ myAnthropicKey: K("sk-ant") }, "anthropic") === K("sk-ant"));
t("pick: loose name needs key/token/secret", pickEnvKey({ anthropicModel: K("sk-ant") }, "anthropic") === "");
t("pick: grok alias for xai", pickEnvKey({ GROK_API_KEY: K("xai") }, "xai") === K("xai"));
t("pick: unknown provider", pickEnvKey(env, "nope") === "");

const json = parseKeyFile(JSON.stringify({ providers: { openai: { apiKey: K("sk") } }, ANTHROPIC_API_KEY: K("sk-ant"), n: 1 }));
t("json: top-level name", pickEnvKey(json, "anthropic") === K("sk-ant"));
t("json: nested provider object", pickEnvKey(json, "openai") === K("sk"));
t("json: providers listed", providersInFile(json).join(",") === "openai,anthropic");
t("json: broken JSON falls back to lines", parseKeyFile("{ not json\nOPENAI_API_KEY=" + K("sk")).OPENAI_API_KEY === K("sk"));
t("providersInFile: env order", providersInFile(env).join(",") === "openai,anthropic,gemini,xai");
t("providersInFile: none", providersInFile(parseEnv("FOO=bar")).length === 0);
t("crlf handled", parseEnv("A=1\r\nOPENAI_API_KEY=" + K("sk") + "\r\n").OPENAI_API_KEY === K("sk"));

// custom endpoint (2026-09-03)
{
  const { customBaseUrlFor } = await import("./byok-env.js");
  const c = parseEnv("OPENROUTER_API_KEY=" + K("sk-or-v1") + "\nDEEPSEEK_API_KEY=" + K("sk"));
  t("custom: openrouter key picked", pickEnvKey(c, "custom") === K("sk-or-v1"));
  t("custom: base url from the key name", customBaseUrlFor(c) === "https://openrouter.ai/api/v1");
  t("custom: listed on its own", providersInFile(c).join(",") === "custom");
  t("custom: unknown name has no base url", customBaseUrlFor({ CUSTOM_OPENAI_API_KEY: K("x") }) === "");
  t("custom: loose name", pickEnvKey({ myGroqToken: K("gsk") }, "custom") === K("gsk"));
  t("custom: does not steal the OpenAI key", pickEnvKey({ OPENAI_API_KEY: K("sk") }, "custom") === "");
}
t("providersInFile: four vendors, no custom", providersInFile(env).join(",") === "openai,anthropic,gemini,xai");

// MM pass-4 regressions (2026-09-03)
t("quoted value + trailing comment keeps no quotes", parseEnv('OPENAI_API_KEY="' + K("sk") + '" # prod').OPENAI_API_KEY === K("sk"));
t("quoted value + trailing comma keeps no quotes", parseEnv("OPENAI_API_KEY='" + K("sk") + "',").OPENAI_API_KEY === K("sk"));
t("unquoted value + trailing comma", parseEnv("OPENAI_API_KEY=" + K("sk") + ",").OPENAI_API_KEY === K("sk"));
t("azure openai key is not an openai key", pickEnvKey({ AZURE_OPENAI_API_KEY: "a".repeat(32) }, "openai") === "");
t("key URL is not a key", pickEnvKey({ OPENAI_KEY_URL: "https://vault.example.com/openai/key" }, "openai") === "");
t("key file path is not a key", pickEnvKey({ GEMINI_KEY_FILE: "<local path>" }, "gemini") === "");
t("windows path is not a key", pickEnvKey({ ANTHROPIC_KEY_PATH: String.raw`C:\redacted\path` }, "anthropic") === "");
t("secret ref is not a key", pickEnvKey({ ANTHROPIC_SECRET_NAME: "projects/123456/secrets/anthropic-key/versions/1" }, "anthropic") === "");
t("shell reference is not a key", pickEnvKey({ OPENAI_API_KEY: "${OPENAI_API_KEY_FROM_VAULT}" }, "openai") === "");
t("sk-xxx placeholder rejected", pickEnvKey({ OPENAI_API_KEY: "sk-" + "x".repeat(40) }, "openai") === "");
t("REPLACE_ME placeholder rejected", pickEnvKey({ OPENAI_API_KEY: "REPLACE_ME_WITH_YOUR_REAL_OPENAI_KEY" }, "openai") === "");
t("two loose candidates: do not guess", pickEnvKey({ openaiKeyA: K("sk-1"), openaiKeyB: K("sk-2") }, "openai") === "");
t("one loose candidate still resolves", pickEnvKey({ openaiKeyA: K("sk-1") }, "openai") === K("sk-1"));
{
  const dup = parseKeyFile(JSON.stringify({ unrelated: { OPENAI_API_KEY: K("sk-A") }, production: { OPENAI_API_KEY: K("sk-B") } }));
  t("json: duplicate nested names fail closed", pickEnvKey(dup, "openai") === "");
  const one = parseKeyFile(JSON.stringify({ production: { OPENAI_API_KEY: K("sk-B") } }));
  t("json: single nested name resolves via its dotted path", pickEnvKey(one, "openai") === K("sk-B"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
