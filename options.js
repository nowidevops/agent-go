// options.js — Agent Go settings page: Local LLM's full options form (packs, tools,
// learning, diagnostics, shortcuts, workflows, zoom/detach) + the Agent Go account,
// plan, model and BYOK cards. No local Ollama, no vendor keys — the backend holds
// those and bills each turn. Rebuilt 2026-09-02 from Local LLM options.js by grafting
// the Agent Go account logic in and cutting the Ollama/provider/key UI out.
// Author: iDevOpsLLC

import { initCollapsibleSettings } from "./collapsible.js"; // settings categories collapsible, collapsed by default (2026-09-12)
import { DEFAULTS, getSettings, saveSettings, getSubmitEnabled, saveSubmitEnabled, getLiveSubmitEnabled, saveLiveSubmitEnabled } from "./settings.js";
import { CLOUD_MODELS } from "./cloud.js";
import { getAuth, setAuth, signOut } from "./auth.js";
import { updateState, checkForUpdate, dismissUpdate, downloadPageFor, updateSteps } from "./update-check.js";
import { parseKeyFile, pickEnvKey, providersInFile, customBaseUrlFor, PROVIDER_LABEL as BYOK_PROVIDER_LABEL } from "./byok-env.js";
import { getRootHandle, hasReadPermission, ensureReadPermission } from "./fsaccess.js";
import { getLessons, deleteLesson, clearLessons, getTrajectories, pruneTrajectories, computeDiagnostics } from "./learning.js";
import { getWorkflows, deleteWorkflow, clearWorkflows, seedDemoWorkflows } from "./teach.js";
import { shortcutOwner, NOT_SIGNED_IN, getShortcuts, saveShortcut, deleteShortcut, swapShortcuts, computeNextFire, formatSchedule, INTERVAL_CHOICES, formatInterval, normalizeSchedule, slug } from "./shortcuts.js";

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const fields = ["model", "numCtx", "maxSteps", "subagentConcurrency", "maxRoots", "whisperUrl", "desktopUrl", "desktopToken", "projectDir", "phaseFilesUrl"];
const el = (id) => document.getElementById(id);
const msg = el("msg");

function fill(s) {
  for (const f of fields) {
    if (f === "model") continue; // <select> filled by fillModels() (Agent Go catalog)
    el(f).value = s[f];
  }
  el("desktopControlEnabled").checked = !!s.desktopControlEnabled;
  el("commandExecEnabled").checked = !!s.commandExecEnabled;
  el("snPackEnabled").checked = !!s.snPackEnabled;
  el("wfPackEnabled").checked = !!s.wfPackEnabled;
  el("wfsPackEnabled").checked = !!s.wfsPackEnabled;
  el("fablePackEnabled").checked = !!s.fablePackEnabled;
  el("tradingPackEnabled").checked = !!s.tradingPackEnabled;
  el("scalpingPackEnabled").checked = !!s.scalpingPackEnabled;
  el("tradingPrefillEnabled").checked = !!s.tradingPrefillEnabled;
  el("riskPostureEnabled").checked = s.riskPostureEnabled !== false; // default ON
  // REAL-MONEY live pack (2026-09-11) — explicit true only; everything else reads as OFF
  el("liveTradingPackEnabled").checked = s.liveTradingPackEnabled === true;
  el("liveScalpingPackEnabled").checked = s.liveScalpingPackEnabled === true;
  el("liveTradingPrefillEnabled").checked = s.liveTradingPrefillEnabled === true;
  el("liveRiskPostureEnabled").checked = s.liveRiskPostureEnabled !== false; // default ON (tighten-only)
  el("autoExtendSteps").checked = s.autoExtendSteps !== false; // default ON (2026-08-20 owner: unfinished tasks must not be cut off by a hard cap)

  el("m1PackEnabled").checked = !!s.m1PackEnabled;
  el("inboxPackEnabled").checked = !!s.inboxPackEnabled;
  el("teamsPackEnabled").checked = !!s.teamsPackEnabled;
  el("slackPackEnabled").checked = !!s.slackPackEnabled;
  el("unslopPackEnabled").checked = s.unslopPackEnabled !== false; // default ON (owner directive 2026-08-19)
  el("implementationPhasesEnabled").checked = !!s.implementationPhasesEnabled;
  el("phaseEngineEnabled").checked = !!s.phaseEngineEnabled;   // OPT-IN (2026-07-20): reflect the stored value; user toggles it
  el("phaseModels").value = s.phaseModels && Object.keys(s.phaseModels).length
    ? JSON.stringify(s.phaseModels, null, 2) : "";
  el("phasePreset").value = ""; // the dropdown is an action to populate; it never reflects saved state
  el("additionalExcludedSymbols").value = Array.isArray(s.additionalExcludedSymbols) ? s.additionalExcludedSymbols.join(", ") : "";
  el("telemetryEnabled").checked = !!s.telemetryEnabled;
  el("autoWebSearch").checked = s.autoWebSearch !== false; // default ON
  // Agent Go: model + backend + BYOK (the key comes from machine-local storage via getSettings).
  el("model").value = s.model || "";
  el("backendUrl").value = s.backendUrl || DEFAULTS.backendUrl;
  el("byokProvider").value = s.byokProvider || "";
  el("byokModel").value = s.byokModel || "";
  el("byokKey").value = s.byokApiKey || "";
  el("byokEffort").value = s.byokEffort || "";
  el("byokBaseUrl").value = s.byokBaseUrl || "";
  syncByokUi();
}


// ===================== Agent Go account / plan / model / BYOK =====================
// Grafted verbatim from the Agent Go 2026-07-18 options.js ($ → el).
const $ = el;
// Signed-in tier gate for the admin-only settings block (day-trading + M1). false until /me says "admin".
let isAdminTier = false;
let isTradingTier = false; // usage or admin: the day-trading packs are visible + saveable (owner directive 2026-09-04)

// BYOK (bring-your-own-key) — suggested models per provider. The input is a datalist, so the
// user can also TYPE any model id not listed; the vendor is the final judge of the id.
const BYOK_MODELS = {
  // gpt-6-astra added 2026-09-05 (released 09-03/05; live-verified on /v1/models). The Agent Go
  // service routes the GPT-6 family through /v1/responses — chat-completions refuses function
  // tools for it (functions/src/modules/llm-go/sdk-dispatch.js usesResponsesApi).
  openai: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5-mini", "gpt-5-nano"],
  anthropic: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"], // claude-fable-5 retired → fable-5-1 (2026-09-01)
  gemini: ["gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-flash-latest", "gemini-flash-lite-latest"],
  xai: ["grok-4.5", "grok-4-1-fast-reasoning"],
  // custom: same curated list as Local LLM's Custom provider (cloud.js), plus a few direct-vendor ids.
  // Entries may be plain ids or { id, label }; the datalist shows the label, the field gets the id.
  custom: [
    { id: "stealth/ox-alpha", label: "Ox Alpha (OpenRouter stealth preview · 1M ctx · free) — reasoning coder for long agentic runs" },
    { id: "moonshotai/kimi-k3", label: "Kimi K3 (Moonshot · 1M ctx) — top agentic coder, rivals/beats GLM-5.2" },
    // deepseek/deepseek-v4.1-flash added 2026-09-10 (user request): DeepSeek V4.1 Flash on
    // OpenRouter — live-verified on /api/v1/models (1,048,576 ctx, 384K max output, tools +
    // reasoning) at $0.15/$0.60 per 1M. Cheap long-context drafter/researcher in the same
    // class as glm-5.3-flash; listed right after Kimi K3.
    { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash (1M ctx · 384K out · tools + reasoning) — $0.15/$0.60, via OpenRouter" },
    { id: "z-ai/glm-5.3", label: "GLM-5.3 (Z.ai · 1M ctx) — newest GLM, successor to 5.2, via OpenRouter" },
    { id: "z-ai/glm-5.3-flash", label: "GLM-5.3 Flash (Z.ai · 1M ctx) — cheap + fast 5.3, $0.075/$0.25, via OpenRouter" },
    { id: "z-ai/glm-5.2", label: "GLM-5.2 (Z.ai · 1M ctx) — the coding leader, via OpenRouter" },
    { id: "minimax/minimax-m3", label: "MiniMax M3 (1M ctx) — strong GLM-5.2 rival" },
    { id: "qwen/qwen3-coder", label: "Qwen3-Coder-480B (OpenRouter id)" },
    { id: "qwen3-coder-480b-a35b-instruct", label: "Qwen3-Coder-480B (DashScope id)" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek V4 chat (OpenRouter id)" },
    { id: "deepseek-chat", label: "DeepSeek V4 chat (api.deepseek.com id)" },
    { id: "moonshotai/kimi-k2", label: "Kimi K2 (OpenRouter id)" }
  ]
};

// BYOK mismatch guard: does the pasted KEY look like the selected provider's key, and does the
// MODEL not clearly belong to a DIFFERENT provider? Returns an error string or null. High-confidence
// heuristics only — an UNKNOWN model doesn't false-positive (only a model that clearly matches
// another vendor is flagged), so new/typed model ids still save cleanly.
function byokMismatch(provider, model, key) {
  const k = String(key || "").trim();
  const m = String(model || "").trim().toLowerCase();
  const keyOk = {
    openai:    /^sk-(?!ant-)/.test(k),      // sk- / sk-proj- (but NOT sk-ant-)
    anthropic: /^sk-ant-/.test(k),
    xai:       /^xai-/.test(k),
    gemini:    /^(AIza|AQ\.)/.test(k)        // Google API keys: AIza… or AQ.…
  };
  const keyHint = {
    openai:    'OpenAI keys start with "sk-" (not "sk-ant-").',
    anthropic: 'Anthropic keys start with "sk-ant-".',
    xai:       'xAI keys start with "xai-".',
    gemini:    'Google/Gemini keys start with "AIza" or "AQ.".'
  };
  if (provider === "custom") return null; // any host, any key shape, any model id — the endpoint is the judge
  if (provider in keyOk && !keyOk[provider]) {
    return `Mismatch: that API key doesn't look like a ${provider} key — ${keyHint[provider]} Fix the Provider or the key.`;
  }
  const belongsTo =
    /^claude-/.test(m) ? "anthropic" :
    /^gemini-/.test(m) ? "gemini" :
    /^grok-/.test(m) ? "xai" :
    /^(gpt-|o[0-9]|chatgpt)/.test(m) ? "openai" : null;
  if (belongsTo && belongsTo !== provider) {
    return `Mismatch: model "${model}" looks like a ${belongsTo} model, but Provider is ${provider}. Fix the Provider or the Model.`;
  }
  return null;
}

// ---- BYOK custom-endpoint host list: the service publishes the effective list on /status ----
const BYOK_DEFAULT_HOSTS = ["openrouter.ai", "dashscope-intl.aliyuncs.com", "dashscope.aliyuncs.com", "api.together.xyz", "api.groq.com", "api.deepseek.com", "api.mistral.ai", "api.fireworks.ai", "api.perplexity.ai", "api.cerebras.ai", "integrate.api.nvidia.com", "api.moonshot.ai", "api.moonshot.cn", "api.x.ai"];
let byokHostsFromService = null;
function byokKnownHosts() { return byokHostsFromService || BYOK_DEFAULT_HOSTS; }
async function refreshByokHosts(settings) {
  try {
    const base = String((settings && settings.backendUrl) || DEFAULTS.backendUrl).replace(/\/$/, "");
    const r = await fetch(base + "/status", { cache: "no-store" });
    const j = r.ok ? await r.json() : null;
    if (j && Array.isArray(j.byokCustomHosts) && j.byokCustomHosts.length) {
      byokHostsFromService = j.byokCustomHosts.map(String);
      const span = el("byokHostList"); if (span) span.textContent = byokHostsFromService.join(", ");
    }
  } catch (_e) { /* offline: the built-in list stands */ }
}

// ---- BYOK key import from a file (2026-09-03; mirrors Local LLM's "Load keys from .env") ----
// The parsed file stays in memory for this Options session (never stored), so switching
// provider re-fills the key without picking the file again. The field is filled; Save persists.
let byokFileKeys = null; // { openai?, anthropic?, gemini?, xai?, custom?, customBaseUrl?, source } — never the whole file
function byokReduce(env, source) {
  const out = { source: source || "" };
  for (const p of Object.keys(BYOK_PROVIDER_LABEL)) { const k = pickEnvKey(env, p); if (k) out[p] = k; }
  const b = customBaseUrlFor(env); if (b) out.customBaseUrl = b;
  return out;
}
function byokFileStatus(text, keep) {
  const s = el("byokFileStatus"); if (!s) return;
  s.textContent = text || "";
  if (!keep && text) setTimeout(() => { if (s.textContent === text) s.textContent = ""; }, 6000);
}
async function byokReadGrantedEnv(prompt) {
  // Same trusted-UI direct read as Local LLM: the agent's file tools still refuse .env; this is
  // the user configuring their own key on the Options page. Returns { text, source } or null.
  let root;
  try { root = await getRootHandle(); } catch (_e) { root = null; }
  if (!root) return null;
  try {
    const ok = prompt ? await ensureReadPermission(root) : await hasReadPermission(root);
    if (!ok) return null;
    const fh = await root.getFileHandle(".env");
    const file = await fh.getFile();
    if (file.size > 1_000_000) return null;
    return { text: await file.text(), source: (root.name || "the granted folder") + "/.env" };
  } catch (_e) { return null; }
}
// The button lives inside the key row, so a provider is always selected here.
function byokApplyKeys(keys, { announce } = {}) {
  const provider = el("byokProvider").value;
  if (!provider) return false;
  const have = Object.keys(BYOK_PROVIDER_LABEL).filter((p) => !!keys[p]);
  const key = keys[provider];
  if (!key) {
    if (announce) byokFileStatus("No " + (BYOK_PROVIDER_LABEL[provider] || provider) + " key in " + (keys.source || "that file") + (have.length ? " (it has: " + have.map((p) => BYOK_PROVIDER_LABEL[p]).join(", ") + ")." : "."));
    return false;
  }
  el("byokKey").value = key;
  if (provider === "custom" && !el("byokBaseUrl").value.trim() && keys.customBaseUrl) el("byokBaseUrl").value = keys.customBaseUrl;
  byokFileStatus("✓ " + (BYOK_PROVIDER_LABEL[provider] || provider) + " key loaded from " + (keys.source || "the file") + (have.length > 1 ? " (it also has " + have.filter((p) => p !== provider).map((p) => BYOK_PROVIDER_LABEL[p]).join(", ") + ")" : "") + " — click Save.", true);
  return true;
}
async function byokPickFile() {
  if (typeof window.showOpenFilePicker !== "function") { byokFileStatus("This browser cannot open files from here; paste the key instead."); return null; }
  try {
    const [h] = await window.showOpenFilePicker({ multiple: false });
    const file = await h.getFile();
    if (file.size > 1_000_000) { byokFileStatus("That file is too large to be a key file."); return null; }
    return { text: await file.text(), source: file.name };
  } catch (e) {
    if (e && e.name === "AbortError") byokFileStatus("");
    else if (e && e.name === "SecurityError") byokFileStatus("The browser wants a fresh click for the file picker — click Load again.");
    else byokFileStatus("Couldn't read that file.");
    return null;
  }
}
async function byokLoadKeyFromFile() {
  byokFileStatus("Loading…", true);
  // 1) a granted folder with a .env at its root (may ask for permission). If it has no key for
  //    the selected provider, 2) let the user pick any file.
  const granted = await byokReadGrantedEnv(true);
  if (granted) {
    const keys = byokReduce(parseKeyFile(granted.text), granted.source);
    if (keys[el("byokProvider").value]) { byokFileKeys = keys; byokApplyKeys(keys, { announce: true }); return; }
  }
  const picked = await byokPickFile();
  if (!picked) return;
  byokFileKeys = byokReduce(parseKeyFile(picked.text), picked.source);
  byokApplyKeys(byokFileKeys, { announce: true });
}
// Provider changed: if the key field is empty, fill it from the file read this session, or
// silently from a granted folder's .env (no prompt) — and say where it came from.
async function byokAutoFillFromFile() {
  const provider = el("byokProvider").value;
  if (!provider || el("byokKey").value) return;
  let keys = byokFileKeys;
  if (!keys) { const granted = await byokReadGrantedEnv(false); if (!granted) return; keys = byokReduce(parseKeyFile(granted.text), granted.source); }
  if (keys[provider]) byokApplyKeys(keys, { announce: false }); // byokApplyKeys writes the status line itself
}

// Repopulate the model datalist for the picked provider and enforce the product rule:
// while BYOK is selected, the Implementation-phases pipeline is UNCHECKED and READ-ONLY.
function syncByokUi() {
  const provider = $("byokProvider").value;
  const on = !!provider;
  $("byokModelRow").style.display = on ? "" : "none";
  $("byokKeyRow").style.display = on ? "" : "none";
  $("byokBaseUrlRow").style.display = provider === "custom" ? "" : "none";
  $("byokEffortRow").style.display = on ? "" : "none";
  const dl = $("byokModelList");
  dl.innerHTML = "";
  for (const m of BYOK_MODELS[provider] || []) {
    const opt = document.createElement("option");
    opt.value = typeof m === "string" ? m : m.id;
    if (typeof m !== "string" && m.label) opt.label = m.label; // Chrome shows "id — label" in the picker
    dl.appendChild(opt);
  }
  // Phase engine locks under BYOK; Implementation-phases stays USER-CONTROLLABLE (unchecked by
  // default, but the user may enable it even with BYOK active — user request 2026-07-18).
  for (const [boxId, noteId] of [["phaseEngineEnabled", "phaseEngineLockNote"]]) {
    const box = $(boxId);
    const note = $(noteId);
    if (!box) continue;
    if (on) {
      box.checked = false;
      box.disabled = true;
      box.title = "Disabled while Bring-your-own-key is active.";
    } else {
      box.disabled = false;
      box.title = "";
    }
    if (note) note.style.display = on ? "" : "none";
  }
}

function flash(target, msg, kind) {
  target.textContent = msg;
  target.className = `status show ${kind || ""}`;
  if (kind === "ok") setTimeout(() => { target.className = "status"; }, 2500);
}

function appBase(backendUrl) {
  // Agent Go reuses the Agentic Copilot account (Firebase). Sign-up, Stripe checkout, and the customer
  // portal all live on the Agentic Copilot WEB app — never on a separate llmgo.com domain.
  try {
    const u = new URL(backendUrl);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return "http://localhost:3000";
  } catch (_e) { /* ignore */ }
  return "https://ai.nowidevops.com";
}

function fillModels(tierAllowed) {
  const sel = $("model");
  // keep the "Auto" option, append every catalog model (backend enforces the real allowlist)
  const seen = new Set([""]);
  for (const list of Object.values(CLOUD_MODELS)) {
    for (const m of list) {
      if (seen.has(m.id)) continue; seen.add(m.id);
      const opt = document.createElement("option");
      opt.value = m.id; opt.textContent = m.label || m.id;
      sel.appendChild(opt);
    }
  }
}

async function refreshAccount(settings) {
  const auth = await getAuth();
  const signedIn = !!(auth && auth.idToken);
  $("signedOut").classList.toggle("hidden", signedIn);
  $("signedIn").classList.toggle("hidden", !signedIn);
  if (!signedIn) {
    isAdminTier = false; isTradingTier = false;
    for (const id of ["adminOnlyPacks", "tradingPacks", "adminOnlyDiag", "adminOnlyDiagCard", "adminOnlyLearning", "adminOnlyPhase", "adminPanelLink"]) { const n = $(id); if (n) n.style.display = "none"; }
    return;
  }
  $("userEmail").textContent = auth.email || "signed in";
  $("tierBadge").textContent = auth.tier || "free";
  // Admin-only fields (dev/debug levers) — the backend URL and the phase-engine role-chain
  // JSON. End users keep the fixed prod endpoint and never see the advanced JSON config.
  const showBackendUrl = (tier) => {
    const isAdmin = tier === "admin";
    isAdminTier = isAdmin;
    // Fable + M1 Finance settings: ADMIN-ONLY (owner directive 2026-09-02). Day-trading packs:
    // usage AND admin plans (owner directive 2026-09-04) — paper trading only.
    const ap = $("adminOnlyPacks"); if (ap) ap.style.display = isAdmin ? "" : "none";
    isTradingTier = isAdmin || tier === "usage";
    const tp = $("tradingPacks"); if (tp) tp.style.display = isTradingTier ? "" : "none";
    const ltp = $("liveTradingPacks"); if (ltp) ltp.style.display = isAdminTier ? "" : "none"; // REAL-MONEY section: admin only (2026-09-11)
    const ap2 = $("adminPanelLink"); if (ap2) { ap2.style.display = isAdmin ? "" : "none"; ap2.href = appBase($("backendUrl").value || DEFAULTS.backendUrl) + "/agent-go-admin.html"; ap2.target = "_blank"; ap2.rel = "noopener noreferrer"; }
    for (const id of ["adminOnlyDiag", "adminOnlyDiagCard", "adminOnlyLearning", "adminOnlyPhase"]) { const n = $(id); if (n) n.style.display = isAdmin ? "" : "none"; }
    const r = $("backendUrlRow"); if (r) r.style.display = isAdmin ? "" : "none";
    const pm = $("phaseModelsRow"); if (pm) pm.style.display = isAdmin ? "" : "none";
    // BYOK is a usage-tier capability (admin sees it too, for UAT). Hidden for other tiers;
    // the backend enforces the same rule server-side (403).
    const bc = $("byokCard"); if (bc) bc.style.display = (tier === "usage" || isAdmin) ? "" : "none";
  };
  showBackendUrl(auth.tier);
  // Best-effort live balance from /me.
  try {
    const res = await fetch(`${settings.backendUrl.replace(/\/$/, "")}/me`, {
      headers: { Authorization: `Bearer ${auth.idToken}` }
    });
    if (res.ok) {
      const me = await res.json();
      if (me.tier) { $("tierBadge").textContent = me.tier; showBackendUrl(me.tier); }
      if (typeof me.credits === "number") {
        $("creditBadge").textContent = `${(Math.round(me.credits * 100) / 100).toFixed(2)} credits`;
        $("creditBadge").title = `Live balance from the Agent Go service — refreshed ${new Date().toLocaleTimeString()} (auto-refreshes every 30s while this page is open).`;
      }
      if (me.email) $("userEmail").textContent = me.email;
    } else {
      $("creditBadge").textContent = "balance unavailable";
    }
  } catch (_e) {
    $("creditBadge").textContent = "offline";
  }
}

async function signIn(settings) {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) { flash($("acctStatus"), "Enter email and password.", "err"); return; }
  try {
    const res = await fetch(`${settings.backendUrl.replace(/\/$/, "")}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      // Turn the server's JSON error into a clean, professional message — a
      // non-developer must never see a raw JSON object or an HTTP status code.
      let serverMsg = "";
      try { const b = await res.json(); serverMsg = String((b && b.error) || "").trim(); } catch (_e) { /* not JSON */ }
      let friendly;
      if (res.status === 400 || res.status === 401) {
        friendly = "Incorrect email or password. Please check your details and try again.";
      } else if (res.status === 403) {
        // Render this one message as HTML so the support email STANDS OUT — a bold,
        // highlighted, clickable mailto link (pops against the red error text).
        const box = $("acctStatus");
        box.innerHTML = "This account isn’t enabled for Agent Go yet — please contact " +
          '<a href="mailto:info@nowidevops.com" style="color:var(--accent-blue);font-weight:700;text-decoration:underline">info@nowidevops.com</a>' +
          " to request access.";
        box.className = "status show err";
        return;
      } else if (res.status === 429) {
        friendly = "Too many sign-in attempts. Please wait a moment and try again.";
      } else if (res.status >= 500) {
        friendly = "The Agent Go service is temporarily unavailable. Please try again in a moment.";
      } else {
        friendly = "Sign-in failed. Please try again.";
      }
      flash($("acctStatus"), friendly, "err");
      return;
    }
    const j = await res.json();
    await setAuth({
      idToken: j.idToken, refreshToken: j.refreshToken,
      expiresAt: Date.now() + (Number(j.expiresIn || 3600) * 1000),
      email: j.email || email, tier: j.tier || "usage"
    });
    $("password").value = "";
    flash($("acctStatus"), "Signed in.", "ok");
    await refreshAccount(settings);
    // Shortcuts are per account: rebuild alarms/seeds for this owner and redraw the list.
    try { await chrome.runtime.sendMessage({ type: "account_changed" }); } catch (_e) {}
    try { await renderShortcuts(); } catch (_e) {}
  } catch (e) {
    flash($("acctStatus"), "Couldn’t connect to Agent Go. Please check your internet connection and try again.", "err");
  }
}


// Account + BYOK event wiring (from the Agent Go init()).
(function wireAccount() {
  fillModels();
  el("byokProvider").addEventListener("change", () => { syncByokUi(); byokAutoFillFromFile().catch(() => {}); });
  const byokLoadBtn = el("byokLoadFile");
  if (byokLoadBtn) {
    if (typeof window.showOpenFilePicker !== "function") byokLoadBtn.style.display = "none"; // no file picker here
    byokLoadBtn.addEventListener("click", () => byokLoadKeyFromFile().catch(() => byokFileStatus("Couldn't read that file.")));
  }
  const byokKeyToggle = el("byokKeyToggle");
  if (byokKeyToggle) byokKeyToggle.addEventListener("click", () => {
    const k = el("byokKey");
    const reveal = k.type === "password";
    k.type = reveal ? "text" : "password";
    byokKeyToggle.textContent = reveal ? "Hide" : "Show";
    byokKeyToggle.setAttribute("aria-label", reveal ? "Hide API key" : "Show API key");
  });
  const pwToggle = el("pwToggle");
  if (pwToggle) pwToggle.addEventListener("click", () => {
    const p = el("password");
    const reveal = p.type === "password";
    p.type = reveal ? "text" : "password";
    pwToggle.textContent = reveal ? "Hide" : "Show";
    pwToggle.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
  });
  el("signInBtn").addEventListener("click", async () => signIn(await getSettings()));
  el("signOutBtn").addEventListener("click", async () => {
    await signOut();
    flash(el("acctStatus"), "Signed out.", "ok");
    await refreshAccount(await getSettings());
    // Shortcuts are per account: drop the queued runs + alarms and blank the list.
    try { await chrome.runtime.sendMessage({ type: "account_changed" }); } catch (_e) {}
    try { await renderShortcuts(); } catch (_e) {}
  });
  const webApp = () => appBase(el("backendUrl").value || DEFAULTS.backendUrl);
  el("createLink").addEventListener("click", (e) => { e.preventDefault(); chrome.tabs.create({ url: `${webApp()}/signup` }); });
  // First release: usage tier only — a single "Buy credits" action → the Stripe credit-packs page.
  el("buyCreditsBtn").addEventListener("click", () => { chrome.tabs.create({ url: `${webApp()}/payments/checkout.html?action=add-credits` }); });
})();

async function load() {
  const s = await getSettings();
  fill(s);
  el("paperOrderSubmissionEnabled").checked = await getSubmitEnabled(); // storage.local, not in `settings`
  el("liveOrderSubmissionEnabled").checked = await getLiveSubmitEnabled(); // REAL-MONEY kill-switch, storage.local, default OFF
  await refreshAccount(s);
  startBalancePolling();
  initUpdateNotice(s).catch(() => {});
  refreshByokHosts(s).catch(() => {});
}

// ---- "A newer pack is available" (2026-09-03) ----------------------------------------------
// The stored answer (background checks daily) renders immediately; a fresh check runs when the
// stored one is older than six hours; "Check for updates" forces one.
function renderUpdateNotice(st) {
  const card = $("updateCard"), vt = $("versionText");
  if (vt) {
    let txt = "Agent Go " + st.current;
    if (st.newer) txt += " · " + st.latest + " is available" + (st.dismissed ? " (dismissed)" : "");
    else if (st.latest) txt += " · up to date";
    if (st.checkedAt) txt += " · checked " + new Date(st.checkedAt).toLocaleString();
    if (st.error) txt += st.latest ? " · last check failed (" + st.error + ")" : " · could not check (" + st.error + ")";
    vt.textContent = txt;
  }
  if (!card) return;
  card.style.display = st.available ? "" : "none";
  if (st.available) {
    $("updateText").textContent = "Agent Go " + st.latest + (st.built ? " (built " + st.built + ")" : "") + " is available. You have " + st.current + ".";
    $("updateSteps").textContent = updateSteps();
  }
}
async function initUpdateNotice(settings) {
  renderUpdateNotice(await updateState());
  const b = settings.backendUrl;
  $("updateDownloadBtn").addEventListener("click", () => chrome.tabs.create({ url: downloadPageFor(b) + "/agent-go.html" }));
  $("updateDismissBtn").addEventListener("click", async () => renderUpdateNotice(await dismissUpdate()));
  $("updateCheckBtn").addEventListener("click", async () => {
    const btn = $("updateCheckBtn"); btn.disabled = true; btn.textContent = "Checking…";
    try { renderUpdateNotice(await checkForUpdate({ backendUrl: b, force: true })); }
    finally { btn.disabled = false; btn.textContent = "Check for updates"; }
  });
  renderUpdateNotice(await checkForUpdate({ backendUrl: b }));
}

// LIVE BALANCE (owner request 2026-09-02): the credit badge used to read /me once, on page
// load, so a run's deductions never showed until Options was reopened. Poll /me every 30s
// while the page is VISIBLE (the tab/window is in front) and immediately on regaining focus;
// pause while hidden. Signed-out sessions skip the call (refreshAccount returns early).
const BALANCE_POLL_MS = 30000;
let balanceTimer = null;
let balanceBusy = false;
async function pollBalance() {
  if (balanceBusy || document.hidden) return;
  balanceBusy = true;
  try { await refreshAccount(await getSettings()); } catch (_e) { /* offline — badge already says so */ }
  finally { balanceBusy = false; }
}
function startBalancePolling() {
  if (balanceTimer) return;
  balanceTimer = setInterval(pollBalance, BALANCE_POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollBalance(); });
  window.addEventListener("focus", pollBalance);
}

// ---------- Phase-engine DOMAIN PRESETS (2026-07-19s) ----------
// The dropdown FILLS the phaseModels JSON box with a domain-tuned roster; empty
// = defaults (pure Ollama). The user still clicks Save. Each preset is a starting
// point they can edit. Frontier presets need the matching API keys (openai /
// gemini / anthropic) or the Claude subscription bridge; a leg with a missing
// key falls back to Ollama at run time.
const O = (m) => ({ provider: "ollama", model: m });
const PHASE_PRESETS = {
  "": null, // empty box → defaults
  // ServiceNow: pure Ollama (fast, $0, coding-strong), STRICT citation so every
  // claim about a record/field cites real evidence — the SN false-GO guard.
  servicenow: {
    roles: {
      orchestrator: [O("deepseek-v4-pro:0813-cloud"), O("glm-5.2:cloud")],
      review: [O("glm-5.2:cloud"), O("kimi-k2.7-code:cloud"), O("deepseek-v4-pro:0813-cloud")],
      reverify: [O("deepseek-v4-pro:0813-cloud"), O("kimi-k2.7-code:cloud")]
    },
    gateMode: "strict", maxRepairs: 3, gateWallSec: 240
  },
  // UI/UX: Claude has the strongest design + accessibility taste (subscription =
  // $0); Gemini as an independent visual/multimodal lens; glm tail.
  uiux: {
    roles: {
      orchestrator: [{ provider: "claude-sub", model: "claude-fable-5-1" }, { provider: "claude-sub", model: "claude-opus-5" }],
      review: [{ provider: "claude-sub", model: "claude-opus-5" }, { provider: "gemini", model: "gemini-3.1-pro-preview" }, O("glm-5.2:cloud")],
      reverify: [{ provider: "claude-sub", model: "claude-sonnet-5" }, O("glm-5.2:cloud")]
    },
    maxRepairs: 3, gateWallSec: 360
  },
  // Fitness: broad-knowledge + safety-aware general frontier (Gemini + Claude);
  // deepseek tail. Not strict (advice synthesizes across sources).
  fitness: {
    roles: {
      orchestrator: [{ provider: "gemini", model: "gemini-3.1-pro-preview" }, { provider: "claude-sub", model: "claude-fable-5-1" }],
      review: [{ provider: "claude-sub", model: "claude-opus-5" }, { provider: "gemini", model: "gemini-3.1-pro-preview" }, O("deepseek-v4-pro:0813-cloud")],
      reverify: [{ provider: "gemini", model: "gemini-3.1-pro-preview" }, { provider: "claude-sub", model: "claude-opus-5" }]
    },
    maxRepairs: 3, gateWallSec: 360
  },
  // Stock market: reasoning + factual rigor + risk caveats, STRICT citation.
  // ALL Claude on SUBSCRIPTION ($0, claude-sub — user 2026-07-19t); OpenAI sol
  // REMOVED, opus reviews instead; Gemini = the one independent-lab lens (paid);
  // deepseek tail. Fable reasons, opus reviews.
  stock: {
    roles: {
      orchestrator: [{ provider: "claude-sub", model: "claude-fable-5-1" }, { provider: "gemini", model: "gemini-3.1-pro-preview" }],
      review: [{ provider: "claude-sub", model: "claude-opus-5" }, { provider: "gemini", model: "gemini-3.1-pro-preview" }, O("deepseek-v4-pro:0813-cloud")],
      reverify: [{ provider: "gemini", model: "gemini-3.1-pro-preview" }, { provider: "claude-sub", model: "claude-opus-5" }]
    },
    gateMode: "strict", maxRepairs: 4, gateWallSec: 480
  },
  // Other / deep research: max intelligence, now $0-CLAUDE (claude-sub) + Gemini.
  // OpenAI sol REMOVED (user 2026-07-19t: swap sol → claude-sub); fable orch,
  // opus reviews, gemini reverifies (independent lab), fable/opus repair.
  other: {
    roles: {
      orchestrator: [{ provider: "claude-sub", model: "claude-fable-5-1" }, { provider: "gemini", model: "gemini-3.1-pro-preview" }],
      review: [{ provider: "claude-sub", model: "claude-opus-5" }, { provider: "gemini", model: "gemini-3.1-pro-preview" }, O("deepseek-v4-pro:0813-cloud")],
      reverify: [{ provider: "gemini", model: "gemini-3.1-pro-preview" }, { provider: "claude-sub", model: "claude-opus-5" }],
      repair: [{ provider: "claude-sub", model: "claude-fable-5-1" }, { provider: "claude-sub", model: "claude-opus-5" }]
    },
    maxRepairs: 5, gateWallSec: 600
  }
};
el("phasePreset").addEventListener("change", () => {
  const p = PHASE_PRESETS[el("phasePreset").value];
  el("phaseModels").value = p ? JSON.stringify(p, null, 2) : "";
});

function read() {
  return {
    model: el("model").value.trim(),
    backendUrl: el("backendUrl").value.trim(),
    byokProvider: el("byokProvider").value,
    byokModel: el("byokModel").value.trim(),
    byokApiKey: el("byokKey").value.trim(),
    byokEffort: el("byokEffort").value,
    byokBaseUrl: el("byokBaseUrl").value.trim().replace(/\/+$/, ""),
    numCtx: parseInt(el("numCtx").value, 10) || DEFAULTS.numCtx,
    // 0 is valid (= unlimited), so don't use the falsy `|| default` shortcut here.
    maxSteps: (() => {
      const v = parseInt(el("maxSteps").value, 10);
      return Number.isInteger(v) && v >= 0 ? v : DEFAULTS.maxSteps;
    })(),
    autoExtendSteps: el("autoExtendSteps").checked,
    // Concurrency is clamped to [1,4] in settings.normalize(); read it loosely here.
    subagentConcurrency: (() => {
      const v = parseInt(el("subagentConcurrency").value, 10);
      return Number.isInteger(v) && v >= 1 ? v : DEFAULTS.subagentConcurrency;
    })(),
    // 📁 Local files (MCP) — how many folders can be connected at once. Clamped to
    // [1,20] in settings.normalize(); read loosely here.
    maxRoots: (() => {
      const v = parseInt(el("maxRoots").value, 10);
      return Number.isInteger(v) && v >= 1 ? v : DEFAULTS.maxRoots;
    })(),
    whisperUrl: el("whisperUrl").value.trim().replace(/\/+$/, "") || DEFAULTS.whisperUrl,
    desktopUrl: el("desktopUrl").value.trim().replace(/\/+$/, "") || DEFAULTS.desktopUrl,
    desktopToken: el("desktopToken").value.trim(),
    desktopControlEnabled: el("desktopControlEnabled").checked,
    commandExecEnabled: el("commandExecEnabled").checked,
    projectDir: el("projectDir").value.trim(),
    phaseFilesUrl: el("phaseFilesUrl").value.trim().replace(/\/+$/, "") || DEFAULTS.phaseFilesUrl,
    snPackEnabled: el("snPackEnabled").checked,
    wfPackEnabled: el("wfPackEnabled").checked,
    wfsPackEnabled: el("wfsPackEnabled").checked,
    fablePackEnabled: el("fablePackEnabled").checked,
    tradingPackEnabled: el("tradingPackEnabled").checked,
    scalpingPackEnabled: el("scalpingPackEnabled").checked,
    tradingPrefillEnabled: el("tradingPrefillEnabled").checked,
    riskPostureEnabled: el("riskPostureEnabled").checked,
    liveTradingPackEnabled: el("liveTradingPackEnabled").checked === true,
    liveScalpingPackEnabled: el("liveScalpingPackEnabled").checked === true,
    liveTradingPrefillEnabled: el("liveTradingPrefillEnabled").checked === true,
    liveRiskPostureEnabled: el("liveRiskPostureEnabled").checked,
    m1PackEnabled: el("m1PackEnabled").checked,
    inboxPackEnabled: el("inboxPackEnabled").checked,
    teamsPackEnabled: el("teamsPackEnabled").checked,
    slackPackEnabled: el("slackPackEnabled").checked,
    unslopPackEnabled: el("unslopPackEnabled").checked,
    implementationPhasesEnabled: el("implementationPhasesEnabled").checked,
    phaseEngineEnabled: el("phaseEngineEnabled").checked,
    // Role-chain JSON: empty → {} (defaults). Invalid JSON or oversized input
    // also coerces to {} — settings.js normalize() guarantees shape safety, and
    // phase-engine's resolver validates roles/providers/denylist at run time.
    phaseModels: (() => {
      const v = el("phaseModels").value.trim();
      if (!v || v.length > 4096) return {};
      try { const o = JSON.parse(v); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; }
      catch { return {}; }
    })(),
    additionalExcludedSymbols: el("additionalExcludedSymbols").value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    telemetryEnabled: el("telemetryEnabled").checked,
    autoWebSearch: el("autoWebSearch").checked
  };
}

el("save").addEventListener("click", async () => {
  const r = read();
  // BYOK validation (Agent Go): a picked provider needs BOTH a model and a key to be usable.
  if (r.byokProvider && (!r.byokModel || !r.byokApiKey)) {
    flashMsg("Bring your own key: select or type a model AND paste your API key (or set Provider to Off).", true); return;
  }
  if (r.byokProvider === "custom") {
    let u = null; try { u = new URL(r.byokBaseUrl); } catch (_e) { u = null; }
    const KNOWN = byokKnownHosts();
    if (!u || u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port) {
      flashMsg("Custom endpoint: enter the https base URL of the host, e.g. https://openrouter.ai/api/v1 (no port, no query string).", true); return;
    }
    const host = u.hostname.toLowerCase();
    if (KNOWN.indexOf(host) === -1) {
      flashMsg("Custom endpoint: " + host + " is not a host the Agent Go service can call (exact host, no subdomain). Known hosts: " + KNOWN.join(", ") + ".", true); return;
    }
  }
  // Local bridges: loopback only (audio, screenshots and command output must not be POSTed
  // off-box by a mistyped URL), and the powerful opt-ins need the token.
  const loopback = (v) => { try { const x = new URL(v); return (x.protocol === "http:" || x.protocol === "https:") && (x.hostname === "localhost" || x.hostname === "127.0.0.1"); } catch (_e) { return false; } };
  if (!loopback(r.whisperUrl)) { flashMsg("Advanced settings: the Whisper server URL must be on this machine (http://localhost:8765).", true); return; }
  if (!loopback(r.desktopUrl)) { flashMsg("Advanced settings: the desktop control URL must be on this machine (http://localhost:8777).", true); return; }
  if ((r.desktopControlEnabled || r.commandExecEnabled) && !r.desktopToken) { flashMsg("Advanced settings: paste the desktop token before enabling desktop control or Run commands.", true); return; }
  // Mirror the backend's key-format check (printable ASCII, 20-512 chars) so a malformed
  // paste fails HERE with a clear message instead of as a 400 on the first turn.
  if (r.byokProvider && !/^[\x21-\x7E]{20,512}$/.test(r.byokApiKey)) {
    flashMsg("Bring your own key: that doesn't look like a valid API key (20+ characters, no spaces or line breaks).", true); return;
  }
  // Provider ↔ key ↔ model MISMATCH guard (user request 2026-07-18): catch pasting the wrong
  // provider's key, or a model that clearly belongs to a different provider, BEFORE saving.
  if (r.byokProvider) {
    const mm = byokMismatch(r.byokProvider, r.byokModel, r.byokApiKey);
    if (mm) { flashMsg(mm, true); return; }
  }
  // Product rule: BYOK forces the phase engine OFF (settings.js normalize() enforces it too).
  if (r.byokProvider) r.phaseEngineEnabled = false;
  // ADMIN-ONLY packs (owner directive 2026-09-02): when the signed-in tier is not admin the
  // day-trading + M1 controls are hidden, and their settings are written back OFF / default so
  // a value stored earlier (or synced from another profile) can never keep them enabled.
  if (!isAdminTier) {
    // Local bridges moved to "Advanced settings" (2026-09-03): available to every user who
    // installs the bridges pack, so they are no longer forced OFF here.
    r.telemetryEnabled = false;                       // diagnostics (admin-only section); phaseFilesUrl keeps its stored value
    r.phaseEngineEnabled = false;                     // phase engine + role chains (admin-only section); phaseModels keeps its stored value
    r.fablePackEnabled = false;
    r.m1PackEnabled = false;
  }
  // Day-trading packs (usage + admin, owner directive 2026-09-04): forced OFF only when the block
  // is hidden (free tier / signed out), so a synced value can never keep them on for a tier that
  // cannot see the controls.
  if (!isTradingTier) {
    r.tradingPackEnabled = false;
    r.scalpingPackEnabled = false;
    r.tradingPrefillEnabled = false;
    r.riskPostureEnabled = DEFAULTS.riskPostureEnabled;
    r.additionalExcludedSymbols = [];
  }
  // REAL-MONEY live pack (2026-09-11): ADMIN only — the live-trading module is admin-tier on the server.
  if (!isAdminTier) {
    r.liveTradingPackEnabled = false;
    r.liveScalpingPackEnabled = false;
    r.liveTradingPrefillEnabled = false;
    r.liveRiskPostureEnabled = DEFAULTS.liveRiskPostureEnabled;
  }
  const saved = await saveSettings(r);
  await saveSubmitEnabled(isTradingTier && el("paperOrderSubmissionEnabled").checked); // Phase 4 kill-switch (storage.local, never sync); usage + admin
  await saveLiveSubmitEnabled(isAdminTier && el("liveOrderSubmissionEnabled").checked === true); // REAL-MONEY kill-switch (storage.local, never sync, default OFF); admin only
  el("numCtx").value = saved.numCtx; // reflect the saved value (unclamped — your exact entry is kept)
  syncByokUi();
  document.dispatchEvent(new CustomEvent("ag-settings-saved")); // every Save write finished: clears Unsaved changes (settings-nav.js)
  flashMsg("✓ Saved");
});

el("reset").addEventListener("click", async () => {
  // Keep the account-bound values (backend URL) — reset only the behaviour settings.
  const cur = await getSettings();
  await saveSettings({ ...DEFAULTS, backendUrl: cur.backendUrl });
  await saveLiveSubmitEnabled(false); el("liveOrderSubmissionEnabled").checked = false; // REAL-MONEY kill-switch off on reset (an internal review P8)
  fill({ ...DEFAULTS, backendUrl: cur.backendUrl });
  document.dispatchEvent(new CustomEvent("ag-settings-saved")); // reset writes finished
  flashMsg("✓ Reset to defaults");
});

function flashMsg(text, isErr) {
  msg.textContent = text;
  msg.style.color = isErr ? "var(--accent-red)" : "var(--accent-green)";
  setTimeout(() => { msg.textContent = ""; msg.style.color = "var(--accent-green)"; }, isErr ? 6000 : 1800);
}

// ---------- C.3: service-URL reachability test ----------
// A `no-cors` probe resolves (opaquely) when the server is reachable and rejects
// on a connection failure, so we can report up/down WITHOUT depending on the
// server sending CORS headers (Whisper / the phase-files server often don't).
async function ping(url, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: ctrl.signal });
    return { up: true };
  } catch (e) {
    return { up: false, reason: e && e.name === "AbortError" ? "timed out" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function testUrl(inputId, statusId, probePath) {
  const statusEl = el(statusId);
  const base = el(inputId).value.trim().replace(/\/+$/, "");
  if (!base) { statusEl.textContent = "Enter a URL first."; statusEl.style.color = "var(--text-secondary)"; return; }
  statusEl.textContent = "Testing…";
  statusEl.style.color = "var(--text-secondary)";
  const res = await ping(base + (probePath || ""));
  statusEl.textContent = res.up ? "✓ Reachable" : `⚠ Not reachable (${res.reason})`;
  statusEl.style.color = res.up ? "var(--accent-green)" : "var(--accent-red)";
}

el("testWhisper").addEventListener("click", () => testUrl("whisperUrl", "whisperStatus", ""));
el("testPhase").addEventListener("click", () => testUrl("phaseFilesUrl", "phaseStatus", "/fable-behavior.md"));

// Desktop server sends CORS headers, so we can do a real /health GET and report
// the live screen size (falls back to the generic no-cors probe on any error).
el("testDesktop").addEventListener("click", async () => {
  const statusEl = el("desktopStatus");
  const base = el("desktopUrl").value.trim().replace(/\/+$/, "");
  if (!base) { statusEl.textContent = "Enter a URL first."; statusEl.style.color = "var(--text-secondary)"; return; }
  statusEl.textContent = "Testing…";
  statusEl.style.color = "var(--text-secondary)";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    // Send the token from the field (even unsaved) so Test verifies the exact
    // value a run would use — /health reports token_ok without echoing it.
    const tok = el("desktopToken").value.trim();
    const r = await fetch(base + "/health", { cache: "no-store", signal: ctrl.signal, headers: tok ? { "X-Desktop-Token": tok } : {} });
    clearTimeout(timer);
    const j = await r.json().catch(() => null);
    if (j && j.ok && j.screen) {
      const tokMsg = j.token_ok === true ? " · token ✓" : j.token_ok === false ? " · token ✗ WRONG" : " · token MISSING (paste it above)";
      statusEl.textContent = `✓ Reachable — screen ${j.screen.width}×${j.screen.height}${tokMsg}`;
      statusEl.style.color = j.token_ok === true ? "var(--accent-green)" : "var(--accent-orange)";
    } else {
      statusEl.textContent = j && j.error ? `⚠ ${j.error}` : "⚠ Reached, but desktop control is unavailable.";
      statusEl.style.color = "var(--accent-red)";
    }
  } catch {
    // CORS-less/opaque fallback: at least tell reachable vs not.
    await testUrl("desktopUrl", "desktopStatus", "/health");
  }
});

// ---------- Learning section ----------
async function renderLessons() {
  const box = el("lessonList");
  const lessons = await getLessons();
  el("lessonCount").textContent = lessons.length ? `(${lessons.length} lesson${lessons.length === 1 ? "" : "s"} — click to expand)` : "(none yet)";
  if (!lessons.length) {
    box.innerHTML = '<span style="color:var(--text-secondary)">No lessons yet — give a 👎 on a bad run and one will be distilled automatically.</span>';
    return;
  }
  box.innerHTML = "";
  for (const l of lessons) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border-color)";
    const w = document.createElement("span");
    w.style.cssText = "color:var(--accent-blue);min-width:32px";
    w.textContent = "×" + (Math.round((l.weight || 1) * 10) / 10);
    w.title = "Reinforcement weight";
    const t = document.createElement("span");
    t.style.flex = "1";
    t.textContent = l.text;
    const x = document.createElement("button");
    x.className = "secondary";
    x.style.cssText = "padding:2px 8px;font-size:11px";
    x.textContent = "✕";
    x.title = "Delete this lesson";
    x.addEventListener("click", async () => { await deleteLesson(l.id); renderLessons(); });
    row.append(w, t, x);
    box.appendChild(row);
  }
}

el("clearLessonsBtn").addEventListener("click", async () => {
  await clearLessons();
  renderLessons();
  el("learnMsg").textContent = "✓ Lessons cleared";
  setTimeout(() => (el("learnMsg").textContent = ""), 1800);
});

// C.2: manually prune trajectories older than 30 days (also auto-pruned on save).
el("pruneTrajBtn").addEventListener("click", async () => {
  const { removed, remaining } = await pruneTrajectories(30);
  el("learnMsg").textContent = removed
    ? `✓ Removed ${removed} old trajectory(ies) — ${remaining} kept`
    : `Nothing to prune — all ${remaining} trajectories are under 30 days`;
  setTimeout(() => (el("learnMsg").textContent = ""), 2800);
});

el("exportTraining").addEventListener("click", async () => {
  const data = await getTrajectories();
  if (!data.length) { el("learnMsg").textContent = "No trajectories yet."; return; }
  const jsonl = data.map((t) => JSON.stringify(t)).join("\n");
  const url = URL.createObjectURL(new Blob([jsonl], { type: "application/jsonl" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `local-claude-training-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
  el("learnMsg").textContent = `✓ Exported ${data.length} trajectories`;
  setTimeout(() => (el("learnMsg").textContent = ""), 2500);
});

renderLessons();

// ---------- C.7: local diagnostics (read-only over stored trajectories) ----------
function bar(pct) {
  const w = Math.max(0, Math.min(100, pct));
  return `<span style="display:inline-block;width:90px;height:8px;background:var(--bg-tertiary);border-radius:4px;vertical-align:middle;overflow:hidden">`
    + `<span style="display:block;height:8px;width:${w}%;background:${w > 50 ? "var(--accent-red)" : "var(--accent-blue)"}"></span></span>`;
}

function renderDiagnostics(d) {
  const out = el("diagOut");
  if (!d.runs) { out.innerHTML = '<span style="color:var(--text-secondary)">No runs recorded yet.</span>'; return; }
  const ss = d.stepSummary;
  const tools = d.toolList.map((t) =>
    `<tr><td style="padding:2px 8px 2px 0">${escapeHtml(t.name)}</td>`
    + `<td style="padding:2px 8px;text-align:right">${t.calls}</td>`
    + `<td style="padding:2px 8px;text-align:right;color:${t.fails ? "var(--accent-red)" : "var(--text-secondary)"}">${t.fails}${t.denied ? ` (+${t.denied} denied)` : ""}</td>`
    + `<td style="padding:2px 0 2px 8px">${bar(t.failRate)} <span style="color:var(--text-secondary)">${t.failRate}%</span></td></tr>`
  ).join("");
  const errs = d.topErrors.length
    ? d.topErrors.map(([msg, n]) => `<li><b style="color:var(--accent-red)">×${n}</b> ${escapeHtml(msg)}</li>`).join("")
    : '<li style="color:var(--text-secondary)">None 🎉</li>';

  out.innerHTML = `
    <div style="margin-bottom:8px">
      <b>${d.runs}</b> runs ·
      steps/run: ${ss ? `min ${ss.min} · median ${ss.median} · avg ${ss.avg} · max ${ss.max}` : "—"}
    </div>
    <div style="margin-bottom:8px;color:var(--text-secondary)">
      Run feedback: 👍 ${d.runFeedback.up} · 👎 ${d.runFeedback.down} · — ${d.runFeedback.none}
      &nbsp;|&nbsp; Step feedback: 👍 ${d.stepFeedback.up} · 👎 ${d.stepFeedback.down}
      &nbsp;|&nbsp; Auto-score: + ${d.autoScore.positive} / 0 ${d.autoScore.zero} / − ${d.autoScore.negative}
    </div>
    <table style="border-collapse:collapse;width:100%">
      <thead><tr style="color:var(--text-secondary);text-align:left">
        <th style="padding:2px 8px 4px 0">Tool</th><th style="padding:2px 8px;text-align:right">Calls</th>
        <th style="padding:2px 8px;text-align:right">Fails</th><th style="padding:2px 0 4px 8px">Fail rate</th>
      </tr></thead><tbody>${tools}</tbody>
    </table>
    <div style="margin-top:10px;color:var(--text-secondary)">Top errors:</div>
    <ul style="margin:4px 0 0;padding-left:18px">${errs}</ul>`;
}

el("analyzeBtn").addEventListener("click", async () => {
  const s = await getSettings();
  if (!s.telemetryEnabled) {
    el("diagMsg").textContent = "Enable 'local diagnostics' above and click Save first.";
    setTimeout(() => (el("diagMsg").textContent = ""), 3000);
    return;
  }
  el("diagMsg").textContent = "Analyzing…";
  const d = await computeDiagnostics();
  renderDiagnostics(d);
  el("diagMsg").textContent = "";
});

// ---------- Saved workflows (Teach) ----------
async function renderWorkflows() {
  const box = el("workflowList");
  const list = await getWorkflows();
  if (!list.length) {
    box.innerHTML = '<span style="color:var(--text-secondary)">No saved workflows yet — record one with the 🎬 button in the side panel.</span>';
    return;
  }
  box.innerHTML = "";
  for (const w of list) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:8px 0;border-bottom:1px solid var(--border-color)";

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:8px";
    const title = document.createElement("span");
    title.style.flex = "1";
    title.innerHTML = `${w.demo ? '<span title="Sample workflow for the public demo pages at ai.nowidevops.com/demo" style="font-size:10px;font-weight:700;color:var(--accent-orange);border:1px solid var(--accent-orange);border-radius:4px;padding:0 5px;margin-right:6px">DEMO</span>' : ""}<b>${escapeHtml(w.name)}</b> <span style="color:var(--text-secondary)">— ${w.steps?.length || 0} steps${w.parameters?.length ? ", " + w.parameters.length + " params" : ""}</span>`;
    const del = document.createElement("button");
    del.className = "secondary";
    del.style.cssText = "padding:3px 10px;font-size:11px";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete workflow "${w.name}"?\n\nThis cannot be undone.`)) return;
      await deleteWorkflow(w.id);
      renderWorkflows();
      el("wfMsg").textContent = "✓ Deleted";
      setTimeout(() => (el("wfMsg").textContent = ""), 1500);
    });
    head.append(title, del);

    const details = document.createElement("details");
    details.style.cssText = "margin-top:4px;color:var(--text-secondary)";
    const sum = document.createElement("summary");
    sum.style.cssText = "cursor:pointer;font-size:11px";
    sum.textContent = "View steps";
    details.appendChild(sum);
    const ol = document.createElement("ol");
    ol.style.cssText = "margin:6px 0 0;padding-left:20px";
    for (const s of w.steps || []) {
      const li = document.createElement("li");
      li.textContent = s;
      ol.appendChild(li);
    }
    details.appendChild(ol);

    wrap.append(head, details);
    box.appendChild(wrap);
  }
}

el("clearWorkflowsBtn").addEventListener("click", async () => {
  const list = await getWorkflows();
  if (!list.length) return;
  if (!confirm(`Delete ALL ${list.length} saved workflow(s)?\n\nThis cannot be undone.`)) return;
  await clearWorkflows();
  renderWorkflows();
  el("wfMsg").textContent = "✓ All workflows cleared";
  setTimeout(() => (el("wfMsg").textContent = ""), 1800);
});

// Demo workflows (teach.js seedDemoWorkflows): users get them once per version; the key-less dev copy always. Then show the list.
seedDemoWorkflows()
  .then((r) => { if (r && r.skippedFull) el("wfMsg").textContent = "Demo workflows not added: not enough room under the 50-workflow limit. Delete some to make room."; })
  .catch(() => {})
  .finally(() => renderWorkflows());

// ---------- Shortcuts (/ commands) ----------
// ---- schedule sub-form (Off / Every… / Daily / Weekly / Once) -------------
// Populate the interval dropdown from the shared INTERVAL_CHOICES so Options and
// the side-panel modal never diverge on the allowed "every N" presets.
(function initIntervalChoices() {
  const sel = el("scInterval");
  if (!sel || sel.options.length) return;
  for (const m of INTERVAL_CHOICES) {
    const o = document.createElement("option");
    o.value = String(m);
    o.textContent = formatInterval(m);
    sel.appendChild(o);
  }
  sel.value = "60";
})();

// Show only the fields relevant to the chosen recurrence, and preview the result.
function syncSchedFields() {
  const r = el("scRecur").value;
  const show = (id, on) => { const e = el(id); if (e) e.style.display = on ? "" : "none"; };
  show("scIntervalWrap", r === "interval");
  show("scWindowWrap", r === "interval");
  show("scDaysWrap", r === "interval" || r === "daily");
  show("scWeekdayWrap", r === "weekly");
  show("scDateWrap", r === "once");
  show("scTimeWrap", r === "once" || r === "daily" || r === "weekly");
  const hint = el("scSchedHint");
  if (hint) {
    if (r === "off") hint.textContent = "Runs only when you type the /command manually.";
    else if (r === "once" && !el("scDate").value) hint.textContent = "Pick a date — a one-time schedule needs one.";
    else {
      const label = formatSchedule(readScheduleForm());
      hint.textContent = label ? "Will run: " + label : "Incomplete schedule — it won't run until valid.";
    }
  }
}

// Fill the schedule controls from a saved schedule object (or reset to Off).
function setScheduleForm(schedule) {
  const s = schedule && schedule.enabled ? schedule : null;
  el("scRecur").value = s ? (s.recurrence || "once") : "off";
  el("scInterval").value = String(s && s.intervalMinutes ? s.intervalMinutes : 60);
  el("scWeekday").value = String(s && s.weekday != null ? s.weekday : 1);
  el("scDate").value = (s && s.date) || "";
  el("scTime").value = (s && s.time) || "09:00";
  el("scWindowStart").value = (s && s.windowStart) || "";
  el("scWindowEnd").value = (s && s.windowEnd) || "";
  if (el("scDays")) el("scDays").value = (s && s.days) || "all";
  syncSchedFields();
}

// Build a raw schedule object from the controls (saveShortcut normalizes it;
// "off" → null clears any existing schedule).
function readScheduleForm() {
  const r = el("scRecur").value;
  if (r === "off") return null;
  return {
    enabled: true,
    recurrence: r,
    date: el("scDate").value,
    time: el("scTime").value,
    weekday: parseInt(el("scWeekday").value, 10),
    intervalMinutes: parseInt(el("scInterval").value, 10),
    windowStart: el("scWindowStart").value,
    windowEnd: el("scWindowEnd").value,
    days: el("scDays") ? el("scDays").value : "all"
  };
}

el("scRecur").addEventListener("change", syncSchedFields);
for (const id of ["scInterval", "scWeekday", "scDate", "scTime", "scWindowStart", "scWindowEnd", "scDays"]) {
  const e = el(id); if (e) e.addEventListener("change", syncSchedFields);
}
syncSchedFields(); // initial visibility/hint state

function clearScForm() {
  el("scId").value = "";
  el("scName").value = "";
  el("scPrompt").value = "";
  el("scStartFrom").value = "";
  el("scModel").value = "";
  el("scCategory").value = "";
  setScheduleForm(null);
}

const shortcutCategory = (s) => (s.category || "").trim() || "General";

async function renderShortcuts() {
  const box = el("shortcutList");
  if (!(await shortcutOwner())) {
    // Per-account shortcuts (2026-09-02): nothing is readable while signed out.
    box.innerHTML = '<span style="color:var(--text-secondary)">' + escapeHtml(NOT_SIGNED_IN) + '</span>';
    return;
  }
  const all = await getShortcuts();
  if (!all.length) {
    box.innerHTML = '<span style="color:var(--text-secondary)">No shortcuts yet. Add one below, then type /name in the side panel.</span>';
    return;
  }
  // Search filter (name + prompt + category substring). Reordering is hidden
  // while a filter is active — moving within a partial view would be ambiguous.
  const q = (el("scFilter").value || "").trim().toLowerCase();
  const list = q ? all.filter((s) => (s.name + " " + s.prompt + " " + shortcutCategory(s)).toLowerCase().includes(q)) : all;
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<span style="color:var(--text-secondary)">No shortcuts match "${escapeHtml(q)}".</span>`;
    return;
  }
  // Group by category, in order of each category's first appearance in the
  // stored list (so ↑/↓ can move a whole group's leader too). Also refresh the
  // form's category autocomplete.
  const groups = [];
  const byCat = new Map();
  for (const s of list) {
    const c = shortcutCategory(s);
    if (!byCat.has(c)) { byCat.set(c, []); groups.push(c); }
    byCat.get(c).push(s);
  }
  try {
    el("scCatList").innerHTML = [...new Set(all.map(shortcutCategory))]
      .map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
  } catch {}

  const buildRow = (s) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-color)";
    row.dataset.scId = s.id;
    const name = document.createElement("span");
    name.style.flex = "1";
    name.innerHTML = `<b style="color:var(--accent-green)">/${escapeHtml(s.name)}</b> <span style="color:var(--text-secondary)">— ${escapeHtml(s.prompt.slice(0, 60))}${s.prompt.length > 60 ? "…" : ""}</span>`;
    name.title = s.prompt + (s.startFrom ? `\n\nStart from: ${s.startFrom}` : "") + (s.model ? `\nModel: ${s.model}` : "");
    const edit = document.createElement("button");
    edit.className = "secondary";
    edit.style.cssText = "padding:3px 10px;font-size:11px";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      el("scId").value = s.id;
      el("scName").value = s.name;
      el("scPrompt").value = s.prompt;
      el("scStartFrom").value = s.startFrom || "";
      el("scModel").value = s.model || "";
      el("scCategory").value = s.category || "";
      setScheduleForm(s.schedule);
      el("scName").scrollIntoView({ block: "center" });
    });
    const del = document.createElement("button");
    del.className = "secondary";
    del.style.cssText = "padding:3px 10px;font-size:11px";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete shortcut "/${s.name}"?`)) return;
      await deleteShortcut(s.id);
      try { await chrome.runtime.sendMessage({ type: "shortcuts_changed" }); } catch {} // drop its schedule alarm
      renderShortcuts();
    });
    // Reorder ↑/↓ within the shortcut's CATEGORY group (swaps storage order,
    // which is also the / menu's order). Hidden while searching.
    const movers = [];
    if (!q) {
      const mates = all.filter((x) => shortcutCategory(x) === shortcutCategory(s));
      const idx = mates.indexOf(s);
      for (const [glyph, delta, disabled] of [["↑", -1, idx <= 0], ["↓", 1, idx === mates.length - 1]]) {
        const b = document.createElement("button");
        b.className = "secondary";
        b.style.cssText = "padding:3px 8px;font-size:11px" + (disabled ? ";opacity:.35;cursor:default" : "");
        b.textContent = glyph;
        b.title = disabled ? "" : `Move ${glyph === "↑" ? "up" : "down"} within ${shortcutCategory(s)} (changes the / menu order)`;
        if (!disabled) b.addEventListener("click", async () => { await swapShortcuts(s.id, mates[idx + delta].id); renderShortcuts(); });
        movers.push(b);
      }
    }
    // Schedule badge (purple pill). Turns orange + ⚠ when the schedule can no
    // longer fire (e.g. a one-time date that has already passed).
    if (s.schedule && s.schedule.enabled) {
      const badge = document.createElement("span");
      const next = computeNextFire(s.schedule);
      badge.textContent = "⏰ " + formatSchedule(s.schedule) + (next ? "" : " ⚠");
      const color = next ? "var(--accent-purple)" : "var(--accent-orange)";
      badge.style.cssText = `font-size:10px;color:${color};border:1px solid ${color};border-radius:10px;padding:1px 7px;white-space:nowrap;flex:none`;
      badge.title = next
        ? "Next run: " + new Date(next).toLocaleString() + "\n(Click Edit to change the schedule.)"
        : "This schedule can’t run — its one-time date/time has passed. Click Edit to fix the date/time or change the schedule.";
      row.append(name, badge, ...movers, edit, del);
    } else {
      row.append(name, ...movers, edit, del);
    }
    return row;
  };

  for (const c of groups) {
    const head = document.createElement("div");
    head.textContent = c;
    head.style.cssText = "margin:10px 0 2px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--accent-blue)";
    box.appendChild(head);
    for (const s of byCat.get(c)) box.appendChild(buildRow(s));
  }
}

el("scSave").addEventListener("click", async () => {
  const name = el("scName").value.trim();
  const prompt = el("scPrompt").value.trim();
  if (!name || !prompt) { el("scMsg").textContent = "Name and prompt are required."; return; }
  if (!(await shortcutOwner())) { el("scMsg").textContent = NOT_SIGNED_IN; el("scMsg").style.color = "var(--accent-red)"; return; }
  el("scMsg").style.color = "";
  await saveShortcut({
    id: el("scId").value || undefined,
    name,
    prompt,
    startFrom: el("scStartFrom").value.trim(),
    model: el("scModel").value.trim(),
    category: el("scCategory").value.trim(),
    schedule: readScheduleForm()
  });
  try { await chrome.runtime.sendMessage({ type: "shortcuts_changed" }); } catch {} // keep schedule alarms in sync
  clearScForm();
  renderShortcuts();
  el("scMsg").textContent = "✓ Saved";
  setTimeout(() => (el("scMsg").textContent = ""), 1600);
});
el("scCancel").addEventListener("click", clearScForm);
el("scFilter").addEventListener("input", () => renderShortcuts());

// ---------------------------------------------------------------------------
// Export / Import shortcuts (JSON). Shortcuts live ONLY in chrome.storage.local
// (key "shortcuts") — not in git, wiped if the unpacked extension is removed —
// so this is the backup/restore path. Import MERGES: replace by id or (case-
// insensitive) name, add unknown entries, skip invalid ones.
// ---------------------------------------------------------------------------
function ioMsg(text) {
  el("scIoMsg").textContent = text;
  setTimeout(() => { if (el("scIoMsg").textContent === text) el("scIoMsg").textContent = ""; }, 6000);
}

el("scExport").addEventListener("click", async () => {
  const list = await getShortcuts();
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  a.download = `local-llm-shortcuts-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  ioMsg(`Exported ${list.length} shortcut${list.length === 1 ? "" : "s"}`);
});

async function importShortcuts(arr) {
  const list = await getShortcuts();
  let added = 0, updated = 0, skipped = 0;
  for (const raw of arr) {
    if (!raw || typeof raw !== "object" || !String(raw.name || "").trim() || !String(raw.prompt || "").trim()) { skipped++; continue; }
    const entry = {
      id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
      name: slug(raw.name),
      prompt: String(raw.prompt),
      startFrom: String(raw.startFrom || "").trim(),
      model: String(raw.model || "").trim(),
      category: String(raw.category || "").trim().slice(0, 40)
    };
    if ("schedule" in raw) entry.schedule = normalizeSchedule(raw.schedule);
    const i = list.findIndex((s) => s.id === entry.id || s.name.toLowerCase() === entry.name.toLowerCase());
    if (i >= 0) { entry.id = list[i].id; list[i] = { ...list[i], ...entry }; updated++; }
    else { list.push(entry); added++; }
  }
  await chrome.storage.local.set({ shortcuts: list });
  return { added, updated, skipped };
}

el("scImport").addEventListener("click", () => el("scImportFile").click());
el("scImportFile").addEventListener("change", async () => {
  const f = el("scImportFile").files[0];
  if (!f) return;
  try {
    const arr = JSON.parse(await f.text());
    if (!Array.isArray(arr)) throw new Error("expected a JSON array of shortcuts (an Export JSON file)");
    const r = await importShortcuts(arr);
    try { await chrome.runtime.sendMessage({ type: "shortcuts_changed" }); } catch {} // re-sync schedule alarms
    renderShortcuts();
    ioMsg(`Imported: ${r.added} added, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped (invalid)` : ""}`);
  } catch (e) {
    ioMsg("Import failed: " + e.message);
  }
  el("scImportFile").value = "";
});

renderShortcuts();

// ---------------------------------------------------------------------------
// View controls (user request 2026-07-23): zoom in/out (persisted across opens)
// and detach into a floating popup window.
// ---------------------------------------------------------------------------
const ZOOM_KEY = "optionsZoom";
let uiZoom = 1;
function applyZoom() {
  document.body.style.zoom = uiZoom;
  el("zoomPct").textContent = Math.round(uiZoom * 100) + "%";
}
function setZoom(z) {
  uiZoom = Math.min(1.8, Math.max(0.6, Math.round(z * 10) / 10));
  applyZoom();
  try { chrome.storage.local.set({ [ZOOM_KEY]: uiZoom }); } catch {}
}
el("zoomIn").addEventListener("click", () => setZoom(uiZoom + 0.1));
el("zoomOut").addEventListener("click", () => setZoom(uiZoom - 0.1));
el("zoomReset").addEventListener("click", () => setZoom(1));
el("detachBtn").addEventListener("click", () => {
  chrome.windows.create({ url: chrome.runtime.getURL("options.html"), type: "popup", width: 1040, height: 880 });
});
(async () => {
  try { const o = await chrome.storage.local.get(ZOOM_KEY); uiZoom = Number(o[ZOOM_KEY]) || 1; } catch {}
  applyZoom();
})();

load();

// 2026-09-08a: the agent can now save shortcuts itself (create_shortcut tool). Re-render
// the list whenever the stored shortcuts change under this page.
// 2026-09-13: same for saved workflows. A Settings tab opened before a 🎬 recording kept
// showing "No saved workflows yet" while the side panel listed and ran the new one.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const keys = Object.keys(changes);
    if (keys.some((k) => /shortcut/i.test(k))) renderShortcuts();
    if (keys.includes("teachWorkflows")) renderWorkflows();
  });
} catch {}

// Settings categories: collapsible, collapsed by default (owner directive 2026-09-12). Runs after the
// module has registered every handler, before the first paint the user can interact with.
try { initCollapsibleSettings(); } catch (e) { console.warn("[options] collapsible init failed", e); }

