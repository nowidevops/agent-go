// settings.js — Agent Go user settings, persisted in chrome.storage.sync.
// Differs from Local LLM: no Ollama base, NO provider API keys (the backend holds those),
// provider is always "llmgo", and a backendUrl points at the Agent Go service.
// Author: iDevOpsLLC

export const DEFAULTS = {
  provider: "llmgo",                                  // single cloud provider
  // Agent Go backend base URL (includes the mount path). Defaults to the LOCAL dev-server for
  // pre-launch testing; set the production URL in Options once deployed.
  backendUrl: "https://ai.nowidevops.com/api/llm-go",
  model: "",                                          // "" = Auto: the service runs kimi-k3:cloud where the plan allows it, glm-5.2:cloud on free (owner 2026-09-15)
  modelAutoDefaultV1: true, // marker: the glm-5.2:cloud -> Auto default migration has been applied (see getSettings)
  // Paired vision model for screenshots (Ollama Cloud, flat rate). glm-5.3-flash replaced
  // gemma4:31b on 2026-09-05: on a real-screenshot bench gemma misread exact strings (version,
  // prices, dates — Ollama encodes its image into ~350 tokens vs ~2,700 for the others) while
  // glm-5.3-flash read every figure correctly at ~4s. Same $0.15 flat charge.
  visionModel: "glm-5.3-flash",
  visionModelDefaultV2: true, // marker: the gemma4→glm-5.3-flash default migration has been applied (see getSettings)
  temperature: 0.2,
  numCtx: 32768,
  maxSteps: 0,                                        // agent-loop cap; 0 = unlimited (Stop button cancels)
  autoWebSearch: true,
  subagentConcurrency: 3,   // Agent Go runs inference in the CLOUD (not a single local GPU), so sub-agents can pipeline in parallel. 3 matches the research pack's 3-child fan-out; the usage tier allows 60 req/min and admin is unlimited, so 3 concurrent is safe.
  desktopControlEnabled: false,                       // optional local desktop bridge (off by default)
  desktopUrl: "http://localhost:8777",
  desktopToken: "",
  whisperUrl: "http://localhost:8765",                // local Whisper STT server for dictation (🎤) / meeting listener (🎧) / teach narration; falls back to Web Speech when down. MUST be defined or voice features error with "…server at undefined".
  commandExecEnabled: false,
  projectDir: "",
  // Knowledge packs (ported verbatim; opt-in) — unchanged from Local LLM.
  snPackEnabled: false,  // OFF by default (user request 2026-07-18) — opt-in via Options. When on: real-API rules + artifact form maps + build-in-instance guidance (live sn-api-packs at ai.nowidevops.com, cached 10min; only injects on SN tasks/tabs).
  fablePackEnabled: false,
  tradingPackEnabled: true,             // ON by default (owner directive 2026-09-04); forced OFF for tiers that cannot see the controls
  implementationPhasesEnabled: true,   // ON by default (owner 2026-09-04); the user can uncheck it in Options
  implementationPhasesDefaultV2: true, // marker: the on-by-default migration has been applied to this profile (see getSettings)
  phaseEngineEnabled: false,
  phaseModels: {},
  telemetryEnabled: false,
  // ---- Local LLM feature parity (ported 2026-09-02; every key the current Local LLM
  // build reads, so the same packs / limits / tools work in Agent Go) ----
  autoExtendSteps: true,                // when a FINITE step cap expires mid-task, grant up to 2 bounded extensions instead of forcing the salvage turn (never on trading/M1 runs or sub-agents)
  phaseFilesUrl: "http://localhost:3000/sdlc-phases", // live ServiceNow/Fable knowledge pack source; falls back to bundled
  wfPackEnabled: false,                 // opt-in: ServiceNow LEGACY (Classic) Workflow pack (workflow_ide.do / wf_* authoring) — overlay on the SN pack
  wfsPackEnabled: false,                // opt-in: ServiceNow Workflow Studio pack (modern flows/subflows/actions, sys_hub_*) — overlay on the SN pack
  tradingPrefillEnabled: true,          // ON by default (owner directive 2026-09-04). day-trading Phase 2: the agent may FILL the order form but must NOT click Submit
  scalpingPackEnabled: false,           // opt-in: SCALPING overlay for the day-trading pack; only injects when tradingPackEnabled
  // ── REAL-MONEY live-trading pack (2026-09-11) — SEPARATE from the paper pack above; every flag OFF by default ──
  liveTradingPackEnabled: false,        // opt-in: inject the REAL-MONEY live-trading agent pack — ACTIVE-TAB-gated to live-trading.html only (never task-text / open-tab triggered). Analyze-only until the two flags below are also on.
  liveTradingPrefillEnabled: false,     // opt-in: live pack may FILL the order form (a human clicks Submit). Requires liveTradingPackEnabled.
  liveScalpingPackEnabled: false,       // opt-in: scalping overlay for the LIVE pack (own precedence header, own served file live-scalping-strategy.md). Only rides on an injected live pack.
  liveRiskPostureEnabled: true,         // set_session_max_loss on the LIVE page (TIGHTEN-ONLY on the live module's own cap). Default ON because it can only reduce risk.
  riskPostureEnabled: true,             // day-trading set_session_max_loss tool (TIGHTEN-ONLY session cap; server enforces)
  additionalExcludedSymbols: [],        // ADDITIVE day-trade exclusions (merged with trading-pack.js's long-term-holding list)
  m1PackEnabled: false,                 // opt-in: M1 Finance portfolio explorer pack — REAL-MONEY 401(k), FORCED read-only; URL-gated to dashboard.m1.com
  inboxPackEnabled: false,              // opt-in: inject the Gmail / Outlook inbox triage + reply DRAFTER pack — URL-gated to mail.google.com / outlook.office.com; read + draft only, sends gated by the exact approval phrase (and send_email/send_sms blocked in code)
  teamsPackEnabled: false,              // opt-in: Microsoft Teams READ-ONLY reply-drafter pack — URL-gated to teams.cloud.microsoft / teams.microsoft.com
  slackPackEnabled: false,              // opt-in: Slack READ-ONLY reply-drafter pack — URL-gated to app.slack.com / slack.com
  unslopPackEnabled: true,              // DEFAULT ON (owner directive 2026-08-19): unslop writing-quality pack on EVERY run
  maxRoots: 6,                          // 📁 Local files (MCP): how many local folders may be connected at once (clamped 1–MAX_CONNECTED_FOLDERS)
  // BYOK (bring-your-own-key): usage-tier users may run turns on their OWN vendor API key
  // for a flat $0.05 trigger fee per turn. Provider + model sync; the KEY is machine-local
  // (chrome.storage.local, like desktopToken) and is sent only with your own requests.
  byokProvider: "",   // "" (off) | "openai" | "anthropic" | "gemini" | "xai" | "custom" (OpenAI-compatible host, 2026-09-03)
  byokBaseUrl: "",    // custom provider only: https base URL of the chat-completions host (server allowlists it)
  byokModel: "",      // vendor model id — picked from the list or typed free-form
  byokApiKey: "",     // NEVER synced; stored in chrome.storage.local only
  byokEffort: ""      // "" (provider default) | low | medium | high — reasoning effort for BYOK models that support it
};

export const BYOK_PROVIDERS = ["openai", "anthropic", "gemini", "xai", "custom"];
export const BYOK_EFFORTS = ["", "low", "medium", "high"]; // "" = provider default (no reasoning override)

export const MAX_SUBAGENT_CONCURRENCY = 4;
export const MIN_NUM_CTX = 4096;

// 📁 Local files (MCP) — hard ceiling on how many folders can be connected at once
// (settings.maxRoots is clamped to [1, this]). Mirrors HARD_MAX_ROOTS in fsaccess.js.
export const MAX_CONNECTED_FOLDERS = 20;

function normalize(s) {
  const n = parseInt(s.numCtx, 10);
  s.numCtx = Number.isInteger(n) && n > 0 ? n : DEFAULTS.numCtx;
  const c = parseInt(s.subagentConcurrency, 10);
  s.subagentConcurrency = Number.isInteger(c) && c >= 1 ? Math.min(c, MAX_SUBAGENT_CONCURRENCY) : DEFAULTS.subagentConcurrency;
  s.provider = "llmgo";                               // always the cloud provider
  s.backendUrl = (typeof s.backendUrl === "string" && s.backendUrl.trim()) || DEFAULTS.backendUrl;
  // Auto-migrate off the non-existent placeholder domain (Phase 1 runs on Agentic Copilot infra, not llmgo.com).
  if (/llmgo\.com/i.test(s.backendUrl)) s.backendUrl = DEFAULTS.backendUrl;
  s.model = typeof s.model === "string" ? s.model.trim() : "";
  s.visionModel = (typeof s.visionModel === "string" && s.visionModel.trim()) || DEFAULTS.visionModel;
  s.whisperUrl = (typeof s.whisperUrl === "string" && s.whisperUrl.trim()) || DEFAULTS.whisperUrl;
  s.commandExecEnabled = !!s.commandExecEnabled;
  s.projectDir = typeof s.projectDir === "string" ? s.projectDir.trim() : "";
  // Clamp connected-folder cap to [1, MAX_CONNECTED_FOLDERS]; bad/empty → default 6.
  const mr = parseInt(s.maxRoots, 10);
  s.maxRoots = Number.isInteger(mr) && mr >= 1 ? Math.min(mr, MAX_CONNECTED_FOLDERS) : DEFAULTS.maxRoots;
  s.additionalExcludedSymbols = Array.isArray(s.additionalExcludedSymbols)
    ? s.additionalExcludedSymbols.map((x) => String(x || "").trim().toUpperCase()).filter(Boolean) : [];
  s.phaseEngineEnabled = !!s.phaseEngineEnabled;
  s.phaseModels = (s.phaseModels && typeof s.phaseModels === "object" && !Array.isArray(s.phaseModels)) ? s.phaseModels : {};
  // BYOK: provider must be one of the supported vendors (else off); while BYOK is selected BOTH
  // multi-turn pipelines (Implementation-phases pack AND the phase engine) are FORCED OFF
  // (product rule, user-confirmed 2026-07-18 — the options UI also greys the checkboxes out;
  // enforcing it here means a stale/synced value can never re-enable them).
  s.byokProvider = BYOK_PROVIDERS.includes(s.byokProvider) ? s.byokProvider : "";
  s.byokModel = typeof s.byokModel === "string" ? s.byokModel.trim() : "";
  s.byokBaseUrl = typeof s.byokBaseUrl === "string" ? s.byokBaseUrl.trim().replace(/\/+$/, "") : "";
  if (s.byokProvider === "custom" && !/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(\/[A-Za-z0-9._~\/-]*)?$/i.test(s.byokBaseUrl)) s.byokProvider = ""; // custom needs a usable base URL (same charset as the service: no %)
  // Local bridges are loopback-only and the powerful opt-ins need the token — enforced HERE, at
  // read time, not only in the Options Save handler, so a synced or legacy value cannot point the
  // agent at an off-box bridge (MM pass 6).
  const loopback = (v) => { try { const u = new URL(String(v || "")); return (u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "localhost" || u.hostname === "127.0.0.1"); } catch (_e) { return false; } };
  if (!loopback(s.whisperUrl)) s.whisperUrl = DEFAULTS.whisperUrl;
  if (!loopback(s.desktopUrl)) s.desktopUrl = DEFAULTS.desktopUrl;
  s.byokEffort = BYOK_EFFORTS.includes(s.byokEffort) ? s.byokEffort : "";
  if (s.byokProvider) { s.phaseEngineEnabled = false; } // Phase engine off under BYOK; Implementation-phases stays user-controllable (user request 2026-07-18)
  return s;
}

export async function getSettings() {
  try {
    const { settings } = await chrome.storage.sync.get("settings");
    const merged = normalize({ ...DEFAULTS, ...(settings || {}) });
    // One-time migration (2026-09-04): profiles saved under the old default carry
    // implementationPhasesEnabled:false without ever having chosen it. Flip them ON once and
    // stamp the marker; every later save keeps the marker, so an explicit uncheck sticks.
    const migration = {};
    if (settings && !settings.implementationPhasesDefaultV2) {
      migration.implementationPhasesEnabled = true;
      migration.implementationPhasesDefaultV2 = true;
    }
    // One-time migration (2026-09-05): profiles that stored the old vision default "gemma4:31b"
    // without ever having chosen it move to glm-5.3-flash once and get the marker; a profile
    // that picked another model, or re-picks gemma4 after the stamp, is kept. (A missing value
    // already resolves to the new default through normalize(), so it needs no write.)
    if (settings && !settings.visionModelDefaultV2 && settings.visionModel === "gemma4:31b") {
      migration.visionModel = DEFAULTS.visionModel;
      migration.visionModelDefaultV2 = true;
    }
    // One-time migration (2026-09-15): profiles still on the old default agent model move to Auto,
    // which the service resolves to Kimi K3 where the plan includes it and GLM 5.2 on Free and Starter. A profile that picked
    // another model, or re-picks glm-5.2:cloud after the stamp (every save carries it), is kept.
    if (settings && !settings.modelAutoDefaultV1 && settings.model === "glm-5.2:cloud") {
      migration.model = "";
      migration.modelAutoDefaultV1 = true;
    }
    if (Object.keys(migration).length) { // every pending migration lands in ONE write
      Object.assign(merged, migration);
      try {
        // Re-read right before writing so a save made by another page since the first read is kept,
        // and apply only the migrations that still hold on that fresh copy.
        const fresh = (await chrome.storage.sync.get("settings")).settings || settings;
        const apply = {};
        if (migration.implementationPhasesDefaultV2 && !fresh.implementationPhasesDefaultV2) Object.assign(apply, { implementationPhasesEnabled: true, implementationPhasesDefaultV2: true });
        if (migration.visionModelDefaultV2 && !fresh.visionModelDefaultV2 && fresh.visionModel === "gemma4:31b") Object.assign(apply, { visionModel: DEFAULTS.visionModel, visionModelDefaultV2: true });
        if (migration.modelAutoDefaultV1 && !fresh.modelAutoDefaultV1 && fresh.model === "glm-5.2:cloud") Object.assign(apply, { model: "", modelAutoDefaultV1: true });
        if (Object.keys(apply).length) await chrome.storage.sync.set({ settings: { ...fresh, ...apply } });
      } catch (e) { console.warn("[settings] default migration not persisted:", e && e.message); }
    }
    // desktopToken + byokApiKey are MACHINE-LOCAL secrets — storage.local, never sync.
    const { desktopToken, byokApiKey } = await chrome.storage.local.get(["desktopToken", "byokApiKey"]);
    if (desktopToken) merged.desktopToken = desktopToken;
    merged.byokApiKey = typeof byokApiKey === "string" ? byokApiKey : "";
    // The powerful opt-ins need the machine-local token; without it they are OFF at read time.
    if (!String(merged.desktopToken || "").trim()) { merged.desktopControlEnabled = false; merged.commandExecEnabled = false; }
    return merged;
  } catch (_e) {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(partial) {
  const merged = normalize({ ...DEFAULTS, ...partial });
  const { desktopToken, byokApiKey, ...synced } = merged;
  await chrome.storage.local.set({ desktopToken: desktopToken || "" });
  // Only touch the stored key when the caller actually passed one (options page) — other
  // callers saving unrelated settings must never clobber the machine-local secret.
  if (Object.prototype.hasOwnProperty.call(partial || {}, "byokApiKey")) {
    await chrome.storage.local.set({ byokApiKey: byokApiKey || "" });
  }
  await chrome.storage.sync.set({ settings: { ...synced, desktopToken: "", byokApiKey: "" } });
  return merged;
}

// BYOK is ACTIVE only when all three pieces are present (provider picked, model chosen/typed,
// key saved). Callers (provider.js / ollama.js) attach these to every /v1/chat turn.
export async function getByok() {
  const s = await getSettings();
  if (!s.byokProvider || !s.byokModel || !s.byokApiKey) return null;
  return { provider: s.byokProvider, model: s.byokModel, apiKey: s.byokApiKey, effort: s.byokEffort || "", baseUrl: s.byokProvider === "custom" ? s.byokBaseUrl : "" };
}

// ---------------------------------------------------------------------------
// Compatibility exports for the VERBATIM-ported files (background.js, phase-engine.js).
// Agent Go holds NO provider API keys — the backend does — so the cloud-cred stubs always
// return empty. These keep the ported import surface intact without reintroducing keys.
// ---------------------------------------------------------------------------
export async function getCloudCreds() {
  return { openaiKey: "", geminiKey: "", anthropicKey: "", xaiKey: "" };
}
export async function saveCloudCreds() {
  // No-op: keys are never stored client-side in Agent Go.
  return { openaiKey: "", geminiKey: "", anthropicKey: "", xaiKey: "" };
}

// Autonomous PAPER-submit kill-switch (day-trading pack) — storage.local, default OFF.
export async function getSubmitEnabled() {
  try {
    const { paperOrderSubmissionEnabled } = await chrome.storage.local.get("paperOrderSubmissionEnabled");
    // ON by default (owner directive 2026-09-04); an explicit false in storage.local is the kill-switch.
    return paperOrderSubmissionEnabled === undefined ? true : !!paperOrderSubmissionEnabled;
  } catch {
    return false;
  }
}
export async function saveSubmitEnabled(on) {
  await chrome.storage.local.set({ paperOrderSubmissionEnabled: !!on });
  return !!on;
}

// REAL-MONEY autonomous-submit kill-switch (2026-09-11) — storage.LOCAL, never sync, and
// DEFAULT OFF (unlike the paper switch): only an explicit true in storage.local enables the
// live pack's SUBMIT mode. Enabling autonomy on one machine never propagates to another.
export async function getLiveSubmitEnabled() {
  try {
    const { liveOrderSubmissionEnabled } = await chrome.storage.local.get('liveOrderSubmissionEnabled');
    return liveOrderSubmissionEnabled === true;
  } catch {
    return false;
  }
}

export async function saveLiveSubmitEnabled(on) {
  await chrome.storage.local.set({ liveOrderSubmissionEnabled: on === true });
  return on === true;
}

// Phase-engine per-place model-exclusion hook (ported verbatim from Local LLM). No blanket
// bans; malformed targets are rejected. A future user-stated exclusion has a single home here.
export function isBannedPhaseTarget(target) {
  if (!target || typeof target !== "object") return true; // malformed, never a real target
  return false;
}
