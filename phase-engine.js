// phase-engine.js — CODE-ENFORCED phase pipeline for the local-claude-extension.
// Ports the AgenticWorkflow engine's gate discipline (review → reverify →
// one-shot repair → clarify, fail-closed everywhere) around the existing
// agentLoop, which runs as the EXECUTE phase in EMBEDDED mode (BL-2).
// Plan + consensus: IMPROVEMENTS_PHASE_ENGINE.md, an internal review.
//
// Dependency shape (no circular imports — background.js passes its internals):
//   deps = { agentLoop, chatStream, withModelLock, activeProvider }
// This module imports ONLY pure/leaf modules (phase-parsers, settings, run-state).
// Author: iDevOpsLLC

import {
  parseReviewVerdict, parsePostVerdict, isGateFailOutput,
  checkEvidence, checkBasicInvariants, buildCiteTokens, parsePlan, SUBTASK_ROLES, WEB_EVIDENCE_TOOLS, SN_EVIDENCE_TOOLS, SNAPSHOT_EVIDENCE_TOOLS, isServiceNowUrl
} from "./phase-parsers.js";
import { isBannedPhaseTarget } from "./settings.js";
import { savePhaseState, savePhaseData, clearPhaseState } from "./run-state.js";
import { assertBridgeUrl } from "./claude-sub.js";
import { codexModelArg } from "./codex-sub.js";
import { CLICK_BY_CLICK_REVIEW } from "./click-by-click.js";
import { STRUCTURED_PLAN_CONTRACT } from "./plan-template.js";
import { UNSLOP_PACK } from "./unslop-pack.js"; // pure leaf module (static string)

// ---------------------------------------------------------------------------
// Role-chain resolution (§3.2) — structured {provider, model} targets.
// ---------------------------------------------------------------------------

// Default chains (per plan §3.2): gate roles prefer :cloud (independence +
// no VRAM thrash); $LOCAL resolves to the run's resident local model.
// 2026-07-15 (user directive after live run #4 latency): deepseek + glm ONLY —
// kimi-k2.7-code:cloud proved very slow as the review head (minutes of silent
// thinking per gate). It remains a valid target via settings.phaseModels, just
// not a default. With glm-5.2:cloud as the usual drafter, review resolves to
// deepseek; reverify then has no third model and runs degraded-same-model
// (honestly labeled) — the deterministic invariants remain the primary net.
// $SELECTED = the model chosen in the side-panel header (the run's own
// provider+model — user directive 2026-07-15: "the model selected and shown
// in the header must be the model that does the orchestration"). It drafts
// (EXECUTE) and coordinates (REPAIR/CLARIFY; PLAN/SYNTHESIZE in Tier 2);
// the independent GATES (review/reverify) stay deepseek/glm on purpose —
// avoid-rules would strip the drafter from them anyway.
// AWF parity: the ORCHESTRATOR role owns the critical coordination phases —
// PLAN + SYNTHESIZE (Tier 2) + CLARIFY (now) — exactly as run-core.js routes
// them, and its model class heads REPAIR. The orchestrator IS the header-
// selected model ($SELECTED, any provider). Only the independent GATES
// (review/reverify) are pinned to deepseek/glm.
// AWF-EXACT EXPERIMENT (user directive 2026-07-16): the defaults below are
// agentic-workflow's models.cloud.config.json chains VERBATIM — to isolate
// whether the gate-stall pattern is Ollama-cloud model limitations or the
// engine. Requires OpenAI + Anthropic + Gemini keys in Options; the trailing
// glm fallback is a DIAGNOSTIC (a gate row showing glm means a key is missing).
// Prior Ollama-cloud defaults (kimi review / deepseek reverify / $SELECTED
// orchestrator+repair) are restorable from BUILD_TAG 16d-16h history.
// BILLING SPLIT (user directive 2026-07-16, superseding the same-day "fully
// subscription" directive): OpenAI legs are BACK ON THE API — the Codex CLI
// bridge produced poor-quality gate output ("not good at all"), so codex-sub
// is out of the defaults (still selectable via phaseModels / the header).
//   openai     = OpenAI models via the API (requires OpenAI key in Options)
//   claude-sub = Anthropic models via the local Claude Code CLI (Claude Max)
//   ollama :cloud tail = Ollama subscription (also the missing-key diagnostic)
// 2026-07-16 user roster unchanged: "sonnet-5 for execution, gpt-5.6-sol for
// review, and opus-4.8 for reverify" — EXECUTE comes from the header (pick
// Claude (subscription) + claude-sonnet-5 in Options); gate heads set here.
// Tool-less sol API calls run at reasoning_effort 'low' (cloud.js, 15q).
// glm-5.2:cloud promoted from diagnostic tail to FIRST FALLBACK in both gates
// (user 2026-07-16: "glm-5.2 is a very good model") — it reviews whenever the
// head is slow/unavailable, and stays $0 API (Ollama subscription).
// AGENT GO CLOUD RE-MAP (2026-07-18): Agent Go has ONE provider — the cloud backend
// (activeProvider()==="llmgo"; provider.js dispatches args.model to /api/llm-go, which routes any
// :cloud tag to Ollama Cloud). Local LLM's multi-provider role targets (claude-sub / openai
// bridges) don't exist here, so EVERY role target uses provider "ollama" + a valid Ollama-Cloud
// AGENTIC model tag; walkChain passes target.model straight to the backend (line ~298). The 4
// tags are all pulled on the account: glm-5.2:cloud, deepseek-v4-pro:cloud, minimax-m3:cloud,
// kimi-k2.7-code:cloud. Independence-by-design: the gates differ from the EXECUTE brain (glm) so
// they catch its blind spots. Every chain ENDS with a glm-5.2:cloud tail so a phase always
// completes. Ranking (user 2026-07-18: "glm-5.2 is the strongest / can play the Orchestrator"):
//   glm-5.2:cloud       = ORCHESTRATOR + EXECUTE brain + reliable tail (strongest all-round)
//   deepseek-v4-pro:cloud = REVIEW head    (deepest reasoning/verification, independent of glm)
//   minimax-m3:cloud      = REVERIFY head  (a 3rd independent perspective to refute the draft;
//                                          took the seat 2026-09-18 — Ollama Cloud retires qwen3.5:397b on 09-25)
//   kimi-k2.7-code:cloud  = REPAIR head    (code-specialist — best at the corrected fix)
const DEFAULT_ROLES = {
  orchestrator: [{ provider: "ollama", model: "glm-5.2:cloud" }, { provider: "ollama", model: "deepseek-v4-pro:cloud" }],
  review:   [{ provider: "ollama", model: "deepseek-v4-pro:cloud" }, { provider: "ollama", model: "glm-5.2:cloud" }],
  reverify: [{ provider: "ollama", model: "minimax-m3:cloud" }, { provider: "ollama", model: "kimi-k2.7-code:cloud" }, { provider: "ollama", model: "glm-5.2:cloud" }],
  repair:   [{ provider: "ollama", model: "kimi-k2.7-code:cloud" }, { provider: "ollama", model: "glm-5.2:cloud" }],
  // AWF-parity EXECUTE SPECIALIST ROLES (Local LLM 2026-07-19u, ported 2026-09-02): the PLAN
  // tags each subtask with one of {tools,code,bulk,research}; EXECUTE routes it to that
  // role's chain. Mapped onto Agent Go's Ollama-Cloud catalog: "tools" leads with $SELECTED
  // (the header model drives the browser), code → kimi-k2.7-code (code specialist),
  // bulk → glm → kimi-k2.5 (cheap volume), research → glm → deepseek (fast reader first).
  "execute-tools":    [{ provider: "$SELECTED", model: "$SELECTED" }, { provider: "ollama", model: "glm-5.2:cloud" }],
  "execute-code":     [{ provider: "ollama", model: "kimi-k2.7-code:cloud" }, { provider: "ollama", model: "glm-5.2:cloud" }],
  "execute-bulk":     [{ provider: "ollama", model: "glm-5.2:cloud" }, { provider: "ollama", model: "kimi-k2.5:cloud" }],
  "execute-research": [{ provider: "ollama", model: "glm-5.2:cloud" }, { provider: "ollama", model: "deepseek-v4-pro:cloud" }]
};
const KNOWN_ROLES = new Set(Object.keys(DEFAULT_ROLES));
// xai included since 2026-07-16 — the grok-4.1-era ban is deprecated (grok-4.5
// allowed unless the user excludes it somewhere explicitly).
// claude-sub = Anthropic models via the LOCAL Claude Code CLI bridge
// (desktop-server /claude) — bills the user's Claude SUBSCRIPTION, not the API.
// "llmgo" = Agent Go's own cloud provider — added so a CUSTOM role chain written with either
// provider:"ollama" OR provider:"llmgo" survives resolveRoleChains (both dispatch target.model
// straight to the backend, which routes any :cloud tag to Ollama Cloud). The vendor/bridge
// providers remain listed but are dead paths in Agent Go (no keys/bridges in the extension).
const KNOWN_PROVIDERS = new Set(["ollama", "llmgo", "openai", "gemini", "anthropic", "xai", "claude-sub", "codex-sub", "custom"]);
const MAX_CHAIN = 6;
// The always-available last-resort tail: Ollama cloud, reached WITHOUT the
// desktop-server bridge (localhost:11434 direct). glm-5.2:cloud is the confirmed
// default cloud model.
const DEFAULT_TAIL_CLOUD_MODEL = "glm-5.2:cloud";
// A DISTINCT second cloud model for the tail when glm is already used earlier
// (so the appended tail is a real additional attempt, not a duplicate).
const SECOND_TAIL_CLOUD_MODEL = "deepseek-v4-pro:0813-cloud";
// Same allowlist the desktop-server enforces (MM final-audit P0): model ids
// reach CLI argv — validate the shape CLIENT-side too, defense in depth.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function identityOf(t) { return `${t.provider}:${t.model}`; }

// TRIVIAL-TURN LANE (2026-07-19y, live a-live-run): a greeting / thanks /
// acknowledgement / meta-question about the agent legitimately produces ZERO
// evidence. The zero-evidence retry's corrective is written for a ServiceNow
// task ("the record is already open in the tab… BROWSER TOOLS FIRST…"), so
// firing it on "Hi" makes the drafter hallucinate a task from whatever tabs are
// open (a-live-run: "Hi" → unsolicited artifact + SN-dashboard browsing, then
// a fabricated review NO-GO'd). A claim-free conversational reply should skip
// the retry and go straight to the gates, which correctly APPROVE it
// (a-live-run). STRICT by design: only unambiguous social/meta turns match;
// anything that could be an actionable task (or a request naming a record/page)
// falls through to the normal evidence-seeking retry.
export function isTrivialTurn(taskText) {
  const s = String(taskText || "").trim();
  if (!s || s.length > 80) return false;                 // real tasks run longer
  const low = s.toLowerCase().replace(/[!.?,\s]+$/g, "").trim();
  return /^(hi+|hey+|hello+|hiya|yo|sup|howdy|greetings|good (morning|afternoon|evening|day)|thanks?|thank you|thx|ty|ok|okay|k|cool|nice|great|awesome|got it|sounds good|will do|nvm|never ?mind|how are you|how'?s it going|who are you|what can you do|what do you do|are you (there|working|online|ready)|test|testing|ping)$/i.test(low);
}

// CONCEPTUAL / DEFINITIONAL turn (2026-07-20b, live a-live-run20-010106): a
// "what is X / explain X / how does X work" question needs NO evidence — it's
// answered from knowledge (grounded by the domain pack). Firing the zero-evidence
// retry on it REPLACED a good first answer with a DEFENSIVE non-answer: the
// corrective is injected as a user turn, so the model read "your previous attempt
// gathered ZERO evidence — rejected" as the USER criticizing it and replied
// "You're right to call that out… I did not run any sn_* tools…" instead of
// explaining the concept. Skip the retry for these. GUARDED: a question that
// names a SPECIFIC live record / instance / page / number is NOT conceptual —
// it needs tools — so it falls through to the normal retry.
export function isConceptualTurn(taskText) {
  const s = String(taskText || "").trim();
  if (!s || s.length > 300) return false;
  // Names something LIVE to read/act on → needs tools, not conceptual.
  if (/\b(my instance|this record|this page|this tab|this rule|this script|currently open|open in (my|the|this)|in my instance|on my instance|the (record|rule|script|widget|flow) (open|currently))\b/i.test(s)) return false;
  if (/\bsys_id\b|\b(inc|ritm|chg|prb|sctask|task|kb)\d{4,}\b|https?:\/\//i.test(s)) return false;
  if (/\b(named|called)\b/i.test(s) && /\b(business rule|script include|client script|ui policy|ui action|widget|flow|catalog item|incident|record|table|group|user)\b/i.test(s)) return false;
  // Definitional / explanatory / comparative openers.
  return /^\s*(what\s+(is|are|'s|does|do|means?)\b|which\b|why\b|how\s+(does|do|to|is|are)\b|explain\b|define\b|describe\b|summari[sz]e\b|tell me about\b|compare\b|what does\b|difference between\b|give me\b[^.?!]{0,60}\b(explanation|overview|summary|definition|rundown|primer|breakdown)\b)/i.test(s);
}

// Resolve the effective role chains: user config (settings.phaseModels.roles)
// validated target-by-target, else defaults; $LOCAL → localModel; banned
// (grok/xai) and malformed targets dropped at THIS layer too (defense in depth).
export function resolveRoleChains(phaseModels, localModel, selectedTarget) {
  const userRoles = (phaseModels && typeof phaseModels === "object" && phaseModels.roles && typeof phaseModels.roles === "object") ? phaseModels.roles : {};
  const selected = selectedTarget && selectedTarget.model
    ? { provider: String(selectedTarget.provider || "ollama"), model: String(selectedTarget.model) }
    : { provider: "ollama", model: localModel };
  const out = {};
  for (const role of KNOWN_ROLES) {
    const raw = Array.isArray(userRoles[role]) && userRoles[role].length ? userRoles[role] : DEFAULT_ROLES[role];
    const chain = [];
    for (const t of raw.slice(0, MAX_CHAIN)) {
      if (!t || typeof t !== "object") continue;
      let target = { provider: String(t.provider || ""), model: String(t.model || "") };
      // $SELECTED → the header-selected provider+model (the run's own brain).
      if (target.model === "$SELECTED" || target.provider === "$SELECTED") target = { ...selected };
      if (!KNOWN_PROVIDERS.has(target.provider)) continue;
      if (isBannedPhaseTarget(target)) continue;                 // BL-5 / T11 (also drops a banned $SELECTED)
      if (target.model === "$LOCAL") target.model = localModel;
      if (!target.model) continue;
      if (!MODEL_RE.test(target.model)) continue;   // never let a flag-shaped id near CLI argv
      // De-dup: $SELECTED often coincides with a listed default (e.g. glm).
      if (chain.some((c) => identityOf(c) === identityOf(target))) continue;
      chain.push(target);
    }
    // TAIL SAFETY NET (user 2026-07-16): every non-empty chain must END with an
    // Ollama model. Ollama goes DIRECT to localhost:11434 — not through the
    // desktop-server bridge — so a phase can still complete when the bridge is
    // down or both subscription CLIs are logged out. If the resolved chain
    // doesn't already end in one (e.g. a custom phaseModels config, or all
    // ollama entries fell mid-chain), append a bridge-independent tail: prefer
    // an ollama already in the chain, else glm-5.2:cloud. (An EMPTY chain — every
    // target rejected — falls through to the guaranteed local-model default
    // below, which is even more certain to be present than a cloud model.)
    if (chain.length && chain[chain.length - 1].provider !== "ollama") {
      // Prefer a DISTINCT ollama model not already in the chain (MM 16x-audit
      // A3: appending a COPY of a mid-chain ollama just retries a model that
      // already failed). glm first, else deepseek, else — only if both are
      // already present — reuse the first mid-chain ollama.
      const has = (m) => chain.some((c) => c.provider === "ollama" && c.model === m);
      let tailModel = !has(DEFAULT_TAIL_CLOUD_MODEL) ? DEFAULT_TAIL_CLOUD_MODEL
        : !has(SECOND_TAIL_CLOUD_MODEL) ? SECOND_TAIL_CLOUD_MODEL
        : (chain.find((c) => c.provider === "ollama") || {}).model;
      if (tailModel) {
        // Clamp to MAX_CHAIN INCLUDING the tail (append ran after raw.slice, so a
        // full 6-entry config would otherwise resolve to 7 — MM 16x-audit A3).
        if (chain.length >= MAX_CHAIN) chain = chain.slice(0, MAX_CHAIN - 1);
        // De-dup guard: never append an identity already present at any position.
        if (!chain.some((c) => c.provider === "ollama" && c.model === tailModel)) {
          chain.push({ provider: "ollama", model: tailModel });
        }
      }
    }
    out[role] = chain.length ? chain : [{ provider: "ollama", model: localModel }];
  }
  return out;
}

// ---------------------------------------------------------------------------
// callRole (§3.1) — fresh 2-message tool-less call, chain-walked, avoid-aware.
// ---------------------------------------------------------------------------

// Per-gate wall clock (idle-stall alone isn't a ceiling — MM finding). MM
// final-audit: configurable via phaseModels.gateWallSec (60-600, default 240)
// because slow-but-valid 3-4 min reasoning turns were killed at a fixed 240s.
function gateWallMs(settings) {
  const s = Number(settings?.phaseModels?.gateWallSec);
  return Math.min(600, Math.max(60, Number.isFinite(s) && s ? s : 240)) * 1000;
}

// STRUCTURAL test guard (MM final-audit item 12 — the live-bridge trap bit
// twice): with globalThis.__PHASE_TEST_MODE__ set, the live defaults throw
// BEFORE any fetch, so a missing deps.claudeSub/deps.codexSub mock fails the
// suite loudly instead of billing a real subscription.
function assertNotTestMode(which) {
  if (globalThis.__PHASE_TEST_MODE__) {
    throw new Error(`TEST MODE: live ${which} bridge call blocked — inject deps.${which} in the test.`);
  }
}

// Default live implementation of the Claude-subscription bridge call (tests
// inject deps.claudeSub instead — a unit test must never bill the Max plan).
async function defaultClaudeSubCall({ settings, system, user, model, signal, timeoutS }) {
  assertNotTestMode("claudeSub");
  const base = assertBridgeUrl(settings.desktopUrl, settings.desktopAllowRemote);
  const res = await fetch(base + "/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(settings.desktopToken ? { "X-Desktop-Token": settings.desktopToken } : {}) },
    body: JSON.stringify({ system, prompt: user, model, timeout_s: timeoutS || 230 }),
    signal
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error((j && j.error) || `claude-sub bridge HTTP ${res.status} — is the desktop-server running (start-desktop.bat) and the claude CLI logged in?`);
  return String(j.content || "");
}

// ChatGPT-plan twin of the above (Codex CLI behind /codex).
async function defaultCodexSubCall({ settings, system, user, model, signal, timeoutS }) {
  assertNotTestMode("codexSub");
  const base = assertBridgeUrl(settings.desktopUrl, settings.desktopAllowRemote);
  const res = await fetch(base + "/codex", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(settings.desktopToken ? { "X-Desktop-Token": settings.desktopToken } : {}) },
    body: JSON.stringify({ system, prompt: user, model: codexModelArg(model), timeout_s: timeoutS || 230 }),
    signal
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error((j && j.error) || `codex-sub bridge HTTP ${res.status} — desktop-server running and codex CLI installed + logged in?`);
  return String(j.content || "");
}

async function callRole(deps, ctx, role, system, user, { avoid = [], phasePost } = {}) {
  const avoidSet = new Set(avoid);
  const filtered = ctx.chains[role].filter((t) => !avoidSet.has(identityOf(t)));
  const errors = [];
  // Aggregate per-role deadline (MM 16x-audit A3 / Sonnet): without it a chain
  // of N models each waiting the full wall clock = N × gateWallSec (~70 min
  // pathological). Cap the whole role at 2× a single wall clock.
  const roleDeadline = Date.now() + gateWallMs(ctx.settings) * 2;

  if (filtered.length) {
    const r = await walkChain(deps, ctx, role, system, user, filtered, "independent", errors, phasePost, roleDeadline);
    if (r) return r;
  }
  // DEGRADED RETRY (MM 16x-audit A1 — the reverify ollama-net exhaustion fix):
  // reach here when the avoid-filtered chain was EMPTY *or* every model in it
  // ERRORED. Relax the avoid set ONCE and retry the FULL chain — this lets a
  // bridge-independent ollama model that was excluded (e.g. glm avoided because
  // it drafted the EXECUTE fallback) still complete the gate rather than the
  // whole role throwing → UNGATED. Honestly labeled degraded-same-model.
  const full = ctx.chains[role].filter((t) => !filtered.some((f) => identityOf(f) === identityOf(t)));
  const retryChain = full.length ? full : ctx.chains[role].slice();
  ctx.post && ctx.post({ type: "tool_result", name: `phase:${role}`, result: {
    warning: `${filtered.length ? "every independent model errored" : "avoid-set exhausted this role's chain"} — relaxing to a reused/degraded model (independence: degraded-same-model)` } });
  const r2 = await walkChain(deps, ctx, role, system, user, retryChain, "degraded-same-model", errors, phasePost, roleDeadline);
  if (r2) return r2;
  throw new Error(`All models failed for role "${role}": ${errors.join(" | ")}`);
}

// Walk one chain of targets; return the first success or null if all fail.
async function walkChain(deps, ctx, role, system, user, chain, independence, errors, phasePost, roleDeadline) {
  const { chatStream, withModelLock } = deps;
  const wallMs = gateWallMs(ctx.settings);
  const capS = Math.round(wallMs / 1000);
  for (const target of chain) {
    if (roleDeadline && Date.now() > roleDeadline) {
      errors.push(`${identityOf(target)}: role deadline exceeded — not attempted`);
      break;
    }
    // Already-aborted guard (validation note): an abort dispatched BEFORE the
    // listener attaches below would never fire it — check explicitly so a
    // stopped run can't issue one more gate call.
    if (ctx.signal.aborted) throw new Error("aborted");
    // Per-call CLONED settings (BL-4): never mutate the run's settings object.
    const callSettings = { ...ctx.settings };
    if (target.provider !== "ollama") { callSettings.provider = target.provider; callSettings.cloudModel = target.model; }
    // Visibility: gate calls are tool-less and DON'T stream, and cloud
    // reasoning models can think silently for minutes — post a pending row per
    // attempt so the user sees who is working instead of a "stuck" pipeline
    // (observed twice on phase:CLARIFY, 2026-07-15).
    const attempt = `phase:${role} @ ${identityOf(target)}`;
    const t0 = Date.now();
    ctx.post && ctx.post({ type: "tool", name: attempt, args: { note: `tool-less gate call — reasoning models may be silent for 1-4 min; wall-clock cap ${capS}s` } });
    // Liveness heartbeat (user read a silent pending gate as "stuck" FOUR times
    // — bridge calls emit nothing until done): pulse the row every 20s while the
    // call runs so "thinking" is visible within one short interval, not after a
    // 45s void at the terminal gate. Best-effort — a torn-down UI must not kill
    // the call. (Opus reverify measured ~37s live; a healthy gate resolves well
    // inside the wall clock — a pulse past cap_s means it's about to walk.)
    const heartbeat = ctx.post
      ? setInterval(() => { try { ctx.post({ type: "tool_result", name: attempt, result: { still_running: true, waited_s: Math.round((Date.now() - t0) / 1000), cap_s: capS } }); } catch { /* UI gone */ } }, 20000)
      : null;
    const wall = new AbortController();
    const timer = setTimeout(() => wall.abort(), wallMs);
    const onAbort = () => wall.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    try {
      let content;
      if (target.provider === "claude-sub" || target.provider === "codex-sub") {
        // SUBSCRIPTION billing: route through the desktop-server CLI bridges
        // (/claude = Claude Code CLI on the Max plan; /codex = Codex CLI on the
        // ChatGPT plan) — no API keys, no per-token cost. Not under the model
        // lock: remote-CLI calls, not local-GPU inference. Injectable via
        // deps.claudeSub / deps.codexSub so unit tests NEVER hit live bridges.
        const bridge = target.provider === "claude-sub"
          ? (deps.claudeSub || defaultClaudeSubCall)
          : (deps.codexSub || defaultCodexSubCall);
        content = await bridge({ settings: callSettings, system, user, model: target.model, signal: wall.signal, timeoutS: Math.max(30, capS - 10) });
      } else {
        ({ content } = await withModelLock(() => chatStream({
          base: callSettings.ollamaBase,
          model: target.provider === "ollama" ? target.model : callSettings.cloudModel,
          settings: callSettings,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          tools: [], // gate calls are TOOL-LESS by design (§3.1)
          options: { temperature: 0, num_ctx: callSettings.numCtx },
          signal: wall.signal,
          onToken: () => {}
        })));
      }
      if (isGateFailOutput(content)) {
        ctx.post && ctx.post({ type: "tool_result", name: attempt, result: { ok: false, error: "gate-fail (<10 chars) — walking to next model", ms: Date.now() - t0 } });
        errors.push(`${identityOf(target)}: gate-fail (<10 chars)`); continue;
      }
      ctx.post && ctx.post({ type: "tool_result", name: attempt, result: { ok: true, ms: Date.now() - t0 } });
      phasePost && phasePost({ model: identityOf(target), independence });
      return { content, target, identity: identityOf(target), independence };
    } catch (e) {
      ctx.post && ctx.post({ type: "tool_result", name: attempt, result: { ok: false, error: String(e?.message || e).slice(0, 160), ms: Date.now() - t0 } });
      if (ctx.signal.aborted) throw e; // user stop — do not walk the chain
      errors.push(`${identityOf(target)}: ${String(e?.message || e).slice(0, 120)}`);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  }
  return null; // every model in this chain failed — caller decides whether to relax
}

// ---------------------------------------------------------------------------
// Gate prompts
// ---------------------------------------------------------------------------

// Shared citation grammar — the SAME vocabulary for every role (MM impl-review
// must-fix #2: EXECUTE saw `_cite` while gates saw a different digest and were
// never taught the grammar; repair — the one-shot last chance — was the least
// informed model in the pipeline).
const CITE_GRAMMAR = `EVIDENCE CITATION GRAMMAR: the ledger below lists observations as "[E6.O2] = path=value" legend lines. The citation token is the SHORT ID PART ONLY — e.g. [E6.O2] — copied verbatim next to the claim it supports; never write the path or value inside a token. A claim is properly cited iff its [E<n>.O<k>] token appears beside it. Tokens mark OBSERVED state only: when recommending a NEW/proposed value, do NOT attach a token to the proposed value (cite the CURRENT value it replaces instead).`;

const REVIEW_SYSTEM = `You are an independent, adversarial reviewer. You did NOT produce the draft — judge it coldly against the task and the evidence ledger.
${CITE_GRAMMAR}
DIVISION OF LABOR (IMPORTANT — read carefully, it defines YOUR job): a DETERMINISTIC gate has ALREADY validated citation-token RESOLUTION — every token points to a real ledger observation that came from a SUCCESSFUL, non-truncated, non-stale tool call. It has ALSO exact-value-matched the LEGACY valued tokens written as [E6:path=value]. Do NOT re-check token mechanics, formatting, or whether citations are "missing" — token-style complaints are NOT grounds for NO-GO, and PROPOSED/recommended new values are intentionally uncited (tokens mark observed state only). BUT — and this is YOURS ALONE — for OBSERVATION-ID tokens written as [E6.O2] the gate did NOT compare the claim's stated value against the observation: it only confirmed the observation exists. So for every claim carrying an [E<n>.O<k>] token, YOU MUST read that observation's value in the EVIDENCE LEDGER legend below and confirm the draft's stated value actually matches it. A number/name/state asserted next to an [E<n>.O<k>] token that does NOT match the legend value (or asserts a precision the legend doesn't show) is a FABRICATION and is grounds for NO-GO. (Facts read live from the web are the one exception — see the web-sourced-genre note lower in this prompt, if present.)
YOUR job is SUBSTANCE: (1) do the conclusions actually FOLLOW from the cited evidence? (2) is the technical reasoning correct (logic errors, wrong API behavior, broken proposed code)? (3) does any claim OVERREACH what its evidence shows, or assert platform behavior as instance fact? (4) are the recommendations sound and safe? Substantive errors, unjustified conclusions, and evidence-contradicting statements are NO-GO.
DELIVERABLE GENRE: this is a CODE REVIEW. It legitimately (a) quotes evidence content at length — quoted claims were already verified by the deterministic gate, and digest values marked "(display cut…)" are display truncation, NOT unverifiable evidence; and (b) MUST include a PROPOSED remediated artifact — new code AUTHORED BY THE REVIEWER-DRAFTER as the recommended fix. A proposed artifact is a recommendation, not fabricated evidence: judge whether the proposed code is technically correct, never reject it for being new or uncited.
YOUR OWN EPISTEMIC BAR: hold your verdict to the same standard you hold the draft. NO-GO on an API/platform-validity claim ONLY if you are CERTAIN the draft is wrong (e.g. "!current.field.changes()" — negating a boolean GlideElement method — IS valid ServiceNow; do not fail it). When you merely SUSPECT a technical issue you cannot verify against the ledger, note it as a "verify before deploy" caution and still judge the rest on its merits — an unverifiable suspicion is not grounds for NO-GO.
HONEST "COULD NOT COMPLETE" IS A VALID DELIVERABLE — GO IT: if the draft reports in GOOD FAITH that the task could not be done — the target (a form field, record, element, page, or the requested form itself) was searched for with reasonable effort and NOT found, or a tool genuinely failed — and it makes NO fabricated claim of work performed or results obtained, that is a GO, NOT a NO-GO. A thorough good-faith search that turns up nothing is SUFFICIENT to report absence: you CANNOT prove a negative, so do NOT demand "proof that it doesn't exist," and do NOT NO-GO for "failing to complete the task" — an accurate "I searched and it isn't here, here's what I'd do once it is" IS the correct deliverable when the task is genuinely not doable on the current page. Reserve NO-GO for the OPPOSITE failure: a claim of an action or result the evidence does NOT support (e.g. "I filled the fields" when no fill was observed).
LIVE-WEB FACTS (AWF verifier-blindness fix): research-role subtasks in this run may have used LIVE web_search for CURRENT facts (versions, releases, docs, events) that postdate your training cutoff. Do NOT judge a cited recent factual claim as fabricated merely because you don't recognize it — the researcher verified it live. Reserve a FACTUAL no-go for a claim you are CERTAIN is false, never for one you simply can't confirm from memory. Never strip a citation or URL from a REVISED deliverable.
OUTPUT FORMAT (MANDATORY, first two lines, nothing before them):
VERDICT: APPROVED|REVISED
READINESS: GO|NO-GO — <one-line reason>
If VERDICT is REVISED, follow with the corrected deliverable between BEGIN_DELIVERABLE and END_DELIVERABLE lines. Keep every valid citation token from the draft (verbatim); never invent new tokens.${CLICK_BY_CLICK_REVIEW}`;

const REVERIFY_SYSTEM = `You are a final independent verifier. The deliverable already passed review; your job is to REFUTE it if you can.
${CITE_GRAMMAR}
DIVISION OF LABOR: a deterministic gate validated token RESOLUTION (each token points to a real, successful, non-truncated, non-stale observation) and exact-value-matched the LEGACY [E6:path=value] tokens — but it did NOT value-check OBSERVATION-ID [E6.O2] tokens. So do NOT judge token mechanics or missing-citation style (proposed new values are intentionally uncited), BUT for any claim carrying an [E<n>.O<k>] token, confirm its stated value against that observation's value in the ledger legend — a value asserted next to an [E<n>.O<k>] token that does not match the legend is a fabrication and grounds for NO-GO (facts read live from the web are excepted — see the web-sourced-genre note if present). REFUTE on SUBSTANCE ONLY: conclusions that don't follow from the cited evidence, incorrect technical reasoning, overreach beyond what the ledger shows, unsafe recommendations. Do not assume facts not in the ledger.
DELIVERABLE GENRE: a CODE REVIEW quotes verified evidence at length and MUST include a PROPOSED remediated artifact (new code authored as the fix) — that is a recommendation, not fabricated evidence; judge only its technical correctness. Digest values marked "(display cut…)" are display truncation, not unverifiable evidence.
SOURCE OF TRUTH: the ledger was read from the LIVE ServiceNow instance — it IS the record of truth for instance state. Never speculate that instance state differs from the ledger, and never NO-GO on a platform/API-validity suspicion you cannot verify (note it as a caution instead).
HONEST "COULD NOT COMPLETE" IS VALID — do NOT refute it: if the deliverable reports in good faith that the task could not be done (the target was searched for and NOT found, or a tool failed) and makes NO fabricated claim of work/results, that is a GO. A thorough good-faith search that finds nothing is SUFFICIENT to report absence — you CANNOT prove a negative, so do NOT NO-GO for "asserting it doesn't exist without proof" or for "not completing the task." Refute only a claim of an action/result the evidence does NOT support.
LIVE-WEB FACTS: research-role subtasks may have used LIVE web_search for CURRENT facts newer than your training cutoff — do NOT refute a cited recent factual claim just because you don't recognize it; only a claim you are CERTAIN is false is grounds for NO-GO.
OUTPUT FORMAT (MANDATORY, last line):
POST_VERDICT: GO|NO-GO — <one-line reason>`;

const REPAIR_SYSTEM = `You are repairing a deliverable that FAILED its quality gate. Fix ONLY what the failure reasons require, using ONLY the evidence ledger — never invent values.
${CITE_GRAMMAR}
Every factual claim about UI/field/record state must carry a token COPIED VERBATIM from the ledger. If a claim has no supporting token in the ledger, delete or soften the claim — do not fabricate a token.
OUTPUT FORMAT (MANDATORY): the corrected deliverable between BEGIN_DELIVERABLE and END_DELIVERABLE lines. No other commentary.`;

const CLARIFY_SYSTEM = `A deliverable failed its quality gates even after one repair. Formulate 1-3 concrete questions for the USER whose answers would unblock the task. Number them. Be specific; no filler. Output ONLY the numbered questions — no reasoning, no preamble.
SOURCE OF TRUTH RULE: the live ServiceNow instance IS the source of truth and the agent has tools to read it. NEVER ask the user for anything readable from the instance (record fields, scripts, checkbox states, names, sys_ids) — those are the agent's job to gather. Ask ONLY about things the instance cannot answer: requirement intent, business decisions, scope choices, credentials/access limits.`;

// Tier 2 — PLAN (orchestrator decomposes; AWF planner semantics: subtasks are
// grouped into dependency WAVES and run in PARALLEL within a wave, each ROUTED to
// a specialist model by its role tag).
const PLAN_SYSTEM = `You are the orchestrator of a browser agent. A PLAN is MANDATORY for every actionable task — there is NO fast-path for real work.
Respond with ONLY a JSON object, no prose:
- BUILD / IMPLEMENTATION task ("a story" — anything that creates, edits, configures, or SAVES an artifact/record, or must gather live evidence to build against): you MUST decompose it into subtasks that follow the MANDATORY STRUCTURED PLAN below — NEVER {"fast_path": true}. At minimum: (s1, role "tools") verify prerequisites LIVE + reference-cited design; (s2, role "tools", depends_on s1) build the artifact + confirm saved; (s3, role "tools", depends_on s2) UAT verification. Split further when the task has separable parts. Shape: {"subtasks":[{"id":"s1","title":"...","role":"tools|code|bulk|research","prompt":"<self-contained instruction; the executor sees ONLY this prompt plus outputs of its depends_on>","depends_on":[]}], "synthesis_instructions":"<how to combine the outputs into the structured plan+build deliverable>"}
- ONLY a pure CONCEPTUAL / INFORMATIONAL question (define/explain X, a single fact lookup) with NOTHING to build or change may use {"fast_path": true}.
ROLE TAG (routes each subtask to the best specialist model — AWF parity):
- "tools": interacts with the live page/instance (read a form, query records, click, fill, save). DEFAULT — use it whenever the subtask must touch the browser/ServiceNow.
- "code": writes or reviews code/script bodies (no page interaction needed beyond what a depends_on already gathered).
- "bulk": high-volume mechanical text (summarize, reformat, list, tabulate) over already-gathered inputs.
- "research": needs facts NOT on the open page — versions, docs, current events; this role is told to use live web_search.
Rules: at most 4 subtasks; ids s1..s4; depends_on lists ids whose OUTPUT this subtask needs; subtasks with NO unmet dependency run IN PARALLEL, so make independent parts truly independent; every prompt must be self-contained. Any subtask that reads/edits the live instance MUST be role "tools". In particular, BUILDING, CREATING, or SAVING a record/artifact in the instance (a Script Include, Business Rule, Client Script, UI Policy, Flow, Catalog Item, etc.) is a "tools" subtask — NEVER "code". Reserve "code" for writing or reviewing a script BODY that a "tools" subtask will then save; a "code" subtask never persists anything on its own.
${STRUCTURED_PLAN_CONTRACT}`;

const SYNTH_SYSTEM = `You are the orchestrator combining subtask outputs into ONE final deliverable for the user's task.
{CITE}
Preserve citation tokens VERBATIM from the subtask outputs — never retype or invent tokens. Do not add claims that no subtask output supports. Follow the synthesis instructions if given.${CLICK_BY_CLICK_REVIEW}`.replace("{CITE}", CITE_GRAMMAR);

const SUBTASK_STEP_CAP = 14; // research/default per-subtask budget; cap-salvage still yields a draft
// BUILD subtasks (tools/code/bulk) need MORE room than research: a real
// create → populate → save-and-verify flow in the ServiceNow UI (navigate, check
// duplicate, fill fields, toggle a checkbox, set the script editor, save, read
// back) legitimately runs ~20-30 steps — the 14-cap truncated it mid-build so a
// multi-artifact task ("build BOTH X and Y") never saved (live SN2 a-live-run).
const SUBTASK_STEP_CAP_BUILD = 30; // 2026-07-20j (user-set)
export function subtaskStepCap(role) {
  return (role === "tools" || role === "code" || role === "bulk") ? SUBTASK_STEP_CAP_BUILD : SUBTASK_STEP_CAP;
}

// REPAIR MODE: does this gate failure need an EXECUTE repair (re-run tools against
// the live instance) rather than a text-only rewrite of the deliverable?
//  - EVIDENCE GAP: a hard evidence-invariant failed, or the reviewer says a claim
//    is unverified/missing — re-READ the instance to gather it.
//  - ARTIFACT MISMATCH (2026-07-20k, live SN4 a-live-run): the reviewer says the
//    SAVED artifact is wrong or the deliverable misrepresents what was actually
//    built/saved. Text-repair can only rewrite the write-up — it can NEVER fix the
//    instance, so it oscillates forever between "describe the flaw" and "claim the
//    fix." Route to EXECUTE so the repair RE-EDITS + re-saves the record.
const EVIDENCE_GAP_KINDS = new Set(["no-observation", "uncited-claim", "truncated-evidence", "unresolved", "stale-evidence"]);
export function repairNeedsExecute(gateReason, invariantFailures) {
  const reason = String(gateReason || "");
  const wantsEvidence = /without evidence|unverified|cannot (?:be )?verif|not verified|missing evidence|no evidence/i.test(reason);
  const wantsRebuild = /actual(?:ly)? saved|saved script|in the instance[^.]{0,40}(?:uses|shows|has)|does not match[^.]{0,40}(?:saved|built|instance)|misrepresent|not what was (?:actually )?(?:built|saved)|instance (?:record|form)[^.]{0,30}(?:differs|does not)/i.test(reason);
  const invGap = (invariantFailures || []).some((f) => f && EVIDENCE_GAP_KINDS.has(f.kind));
  return invGap || wantsEvidence || wantsRebuild;
}

// The digest speaks the SAME canonical token vocabulary as the drafter's
// `_cite` map (buildCiteTokens) — one grammar across all phases (MM fix #2).
// Never slices mid-token: per-entry token cap, then a whole-line global cap.
export function ledgerDigest(ledger, draft) {
  // Gate roles get WIDE display values (400 chars) — run #10: a 60-char digest
  // hid the script content, so the reviewer judged verified full quotes as
  // "overreach". Long lines, higher global cap; never slices mid-line.
  const entries = ledger || [];
  const lineFor = (e) =>
    `${e.id} ${e.tool}${e.success ? "" : " FAILED"}${e.truncated ? " TRUNCATED" : ""}${e.obsTruncated ? " OBS-TRUNCATED" : ""}:\n  ` +
    buildCiteTokens(e, 40, 400).join("\n  ");
  // CITED-FIRST + DE-DUP (2026-07-20, live SS1 a-live-run): the ledger grew to 51
  // entries (many were IDENTICAL re-reads of the same dictionary), the 24000-char cap
  // truncated the digest below the cited E18–E51, so the reviewer saw them as absent and
  // NO-GO'd VALID citations as "fabricated" — 4 wasted rounds on a correct deliverable.
  // Guarantee every CITED entry is in the digest (so the reviewer can verify each token),
  // then fill remaining budget with the rest, dropping duplicate re-reads first. A cited
  // entry is NEVER omitted; only non-cited (and duplicate) entries are trimmed for length.
  const citedIds = new Set((String(draft || "").match(/\[E(\d+)/g) || []).map((m) => "E" + m.slice(2)));
  const sig = (e) => `${e.tool}|${JSON.stringify(e.scope || {})}|${(e.observations || []).map((o) => `${o.path}=${o.value}`).join(",")}`;
  const cited = entries.filter((e) => citedIds.has(e.id));
  const rest = entries.filter((e) => !citedIds.has(e.id));
  const seen = new Set(cited.map(sig)); // a non-cited dup of a cited entry is redundant too
  const out = [];
  let total = 0, omitted = 0;
  for (const e of cited) { const l = lineFor(e); out.push(l); total += l.length + 1; } // always shown
  for (const e of rest) {
    const s = sig(e);
    if (seen.has(s)) { omitted++; continue; } // identical re-read of an already-shown observation set
    seen.add(s);
    const l = lineFor(e);
    if (total + l.length > 24000) { omitted++; continue; }
    out.push(l); total += l.length + 1;
  }
  if (omitted) out.push(`(…${omitted} duplicate/low-value non-cited ledger entr${omitted === 1 ? "y" : "ies"} omitted for length — every CITED entry is shown above and is admissible)`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// gateDeliverable — REVIEW + deterministic invariants + REVERIFY (AWF shape)
// ---------------------------------------------------------------------------

async function gateDeliverable(deps, ctx, draft, suffix, drafterIdentities, post, priorRounds = []) {
  const { taskText, ledger } = ctx;
  // Domain grounding (run #16: kimi confabulated "nil() returns false for an
  // empty reference field" — reviewers judged platform semantics from memory
  // while the DRAFTER had the curated API reference): gates get the same pack.
  const domainBlock = ctx.domainPack
    ? `\n\nDOMAIN REFERENCE (authoritative API/platform semantics — judge platform-behavior claims against THIS, never against memory; if the reference does not settle a platform question, it is NOT grounds for NO-GO):\n${String(ctx.domainPack).slice(0, 12000)}`
    : "";
  // RESEARCH GENRE (2026-07-19w): a run whose ledger contains web evidence is a
  // web-research deliverable, NOT a ServiceNow-record verification. Its facts are
  // synthesized from LONG web pages the researcher read LIVE — the exact number
  // lives deep in a page whose ledger observation is necessarily truncated, so
  // the SN-record contract ("cite an observation whose value EXACTLY matches")
  // does not fit. Switch the gate to SOURCE-citation semantics. This is scoped:
  // it activates ONLY when web tools were used, so ServiceNow strictness is
  // untouched (the 19u NVDA run honestly reported sources but couldn't state a
  // number because the reviewer demanded exact-value grounding it couldn't see).
  // Research-genre detection (an internal review, 2026-07-19y — P1 fixes):
  //  (1) require e.success — a FAILED web call is not evidence and must not
  //      flip the genre (old code let a failed fetch_page relax the gate);
  //  (2) http_request dropped from WEB_EVIDENCE_TOOLS upstream (too generic);
  //  (3) `!hasSnEvidence` — in a MIXED run that ALSO read ServiceNow records,
  //      keep full SN exact-value strictness. The relaxation is appended to the
  //      WHOLE review prompt, so without this guard it softened the reviewer's
  //      bar on SN claims too. A run with any SN evidence never relaxes.
  const hasWebEvidence = Array.isArray(ledger) && ledger.some((e) => e && e.success && WEB_EVIDENCE_TOOLS.has(e.tool));
  const hasSnEvidence = Array.isArray(ledger) && ledger.some((e) => e && (SN_EVIDENCE_TOOLS.has(e.tool) || isServiceNowUrl(e.scope && e.scope.url)));
  const researchBlock = (hasWebEvidence && !hasSnEvidence)
    ? `\n\nDELIVERABLE GENRE = WEB RESEARCH (this run used live web_search / fetch_page, and read NO ServiceNow records). SOURCE-CITATION RULE: the facts here were read LIVE from the cited web pages — the full page text is far longer than the short snippet shown in the ledger digest, so a specific figure (a price target, version, date) will NOT appear verbatim in the digest even when the page states it. Therefore: a factual claim is SUPPORTED when it (a) carries a citation token pointing to a web_search/fetch_page observation AND (b) that source is credible and on-topic for the claim. Do NOT NO-GO a cited figure merely because the exact value is absent from the truncated digest — the researcher read the full page. Reserve NO-GO for: a factual claim with NO cited source, a claim citing a clearly irrelevant/off-topic source, an internal contradiction, or an obviously implausible value. Every stated figure MUST carry a source token; an UNSOURCED number is still a fabrication. IMPORTANT — this relaxation applies ONLY to facts read from the WEB; it does NOT lower the bar for any other claim.`
    : "";
  // VISION-SNAPSHOT genre (2026-07-20w, live desktop-control UAT a-live-run): the
  // 20v fix made capture_screenshot/desktop_screenshot descriptions citable evidence
  // (good — it killed the empty-ledger retry). But a screenshot description is a
  // LOCAL VISION MODEL's fuzzy read of the WHOLE screen, so reverify NO-GO'd a
  // SUCCESSFUL "type into Notepad" task because the description (a) showed text from
  // OTHER windows (a VS Code terminal running `wc`) and (b) misread the em dash —
  // so the exact typed string wasn't verbatim in it. Relax the gate the same way
  // research is relaxed: a vision description is advisory corroboration of app/UI
  // STATE, never a verbatim transcript, and the ACTION TOOL's own success result is
  // the real proof a keystroke/click landed.
  const hasSnapshotEvidence = Array.isArray(ledger) && ledger.some((e) => e && e.success && SNAPSHOT_EVIDENCE_TOOLS.has(e.tool));
  const snapshotBlock = hasSnapshotEvidence
    ? `\n\nEVIDENCE INCLUDES VISION SNAPSHOTS (this run used capture_screenshot / desktop_screenshot). VISION-EVIDENCE RULE: a screenshot's \`description\` is a LOCAL VISION MODEL's read of the ENTIRE visible screen — it (a) includes text belonging to OTHER windows behind/beside the target (editors, terminals, chats), (b) misreads punctuation, em dashes, small or trailing text, and (c) is NOT a verbatim transcript. Therefore, for a claim whose [E<n>.O<k>] token points at a VISION-SNAPSHOT observation: do NOT NO-GO merely because the exact requested/target string is absent from, or differs slightly from, the fuzzy description, or because the description also contains unrelated windows' text. The DETERMINISTIC proof that a keystroke/click was delivered is the ACTION TOOL's own success result (desktop_type → {ok:true, typed:N}, desktop_click/press_keys → ok), which the executor already validated — the screenshot is corroboration of app STATE, not a court transcript. Treat the description as ADVISORY: use it to confirm the target app is present and the action plausibly occurred. Reserve NO-GO for a claim the description clearly CONTRADICTS (e.g. 'saved successfully' when it shows an error dialog, or an app that never opened). This relaxation applies to VISION-SNAPSHOT observations ONLY; it does not lower the bar for web or ServiceNow claims.`
    : "";
  // Goalpost pinning (run #16: four rounds, four DIFFERENT objections — repair
  // chased a moving target): after round 1, a reviewer may NO-GO only on prior
  // objections still unfixed or defects NEWLY INTRODUCED by the repair.
  const priorBlock = priorRounds.length
    ? `\n\nPRIOR GATE ROUNDS (this draft was REPAIRED to address these):\n${priorRounds.map((r, i) => `Round ${i + 1}: ${r.slice(0, 400)}`).join("\n")}\nRULE: NO-GO now ONLY if (a) a prior objection above is still unfixed, or (b) the repair INTRODUCED a new defect. Raising a brand-new objection about text that existed in earlier rounds you did not flag is moving the goalposts — if neither (a) nor (b) applies, you MUST GO.`
    : "";
  const phaseTag = (p) => `phase:${p}${suffix}`;
  const mark = (p, args) => { post({ type: "tool", name: phaseTag(p), args: args || {} }); };
  const markDone = (p, result) => { post({ type: "tool_result", name: phaseTag(p), result }); };

  // Deterministic invariants as a reusable stage — pure code, ~0ms.
  // GATE MODE (user directive after 11 live runs: "copy what's proven in
  // agentic-workflow"): AWF gates let MODEL JUDGMENT decide and hard-fail only
  // cheap invariants. Mode "awf" (default) hard-blocks only FABRICATION-GRADE
  // failures — a cited value CONTRADICTING the ledger, a nonexistent citation,
  // stale evidence, empty deliverable (zero false positives across 11 runs);
  // everything that produced the false-positive parade (coverage,
  // path-resolution, truncation) becomes ADVISORY NOTES handed to the reviewer,
  // who judges like AWF's reviewers — but armed with the ledger digest.
  // Mode "strict" (phaseModels: {"gateMode":"strict"}) keeps full enforcement.
  const strictMode = ctx.settings?.phaseModels?.gateMode === "strict";
  const HARD_KINDS = new Set(["value-mismatch", "stale-evidence", "unresolved", "failed-evidence", "empty", "citations-lost"]);
  const runInvariants = (text) => {
    const basic = checkBasicInvariants(text, { draftText: draft, ledger });
    const evidence = checkEvidence(text, ledger);
    const all = [...basic.failures, ...evidence.failures];
    if (strictMode) return { hard: all, advisory: [] };
    return { hard: all.filter((f) => HARD_KINDS.has(f.kind)), advisory: all.filter((f) => !HARD_KINDS.has(f.kind)) };
  };

  // ---- Stage 0: INVARIANTS FIRST (latency fix, live runs 1-3: a 1-4 min
  // reasoning-model review repeatedly ran ahead of an instant deterministic
  // NO-GO — models must only ever see mechanically-clean drafts) ----
  mark("INVARIANTS");
  let inv = runInvariants(draft);
  if (inv.hard.length) {
    markDone("INVARIANTS", { readiness: "NO-GO", source: "deterministic-invariants", failures: inv.hard.slice(0, 12) });
    return { deliverable: draft, readiness: "NO-GO",
      reason: inv.hard.map((f) => `${f.kind}: ${f.detail}`).join("; ").slice(0, 600),
      review: { verdict: "N/A", readiness: "NO-GO", reason: "invariants failed before review" },
      invariantFailures: inv.hard, reviewerIdentity: null, independence: "n/a" };
  }
  markDone("INVARIANTS", { ok: true, tokens_checked: (deliverableTokenCount(draft)), advisory: inv.advisory.length ? inv.advisory.slice(0, 8) : undefined });

  // ---- REVIEW ----
  mark("REVIEW");
  let deliverable = draft;
  const advisoryBlock = inv.advisory.length
    ? `\n\nADVISORY NOTES from the deterministic gate (informational, NOT automatic failures — weigh them in your substantive judgment):\n${inv.advisory.slice(0, 10).map((f) => `- ${f.kind}: ${f.detail}`).join("\n")}`
    : "";
  const reviewUser = `TASK:\n${taskText}\n\nEVIDENCE LEDGER (ground truth — the ONLY admissible evidence):\n${ledgerDigest(ledger, draft)}${advisoryBlock}${priorBlock}\n\nDRAFT DELIVERABLE:\n${draft}`;
  const r = await callRole(deps, ctx, "review", REVIEW_SYSTEM + domainBlock + researchBlock + snapshotBlock, reviewUser, { avoid: drafterIdentities });
  const review = parseReviewVerdict(r.content);
  const reviewerIdentity = r.identity;
  const coDrafters = [...drafterIdentities];
  if (review.verdict === "REVISED" && review.deliverable) {
    deliverable = review.deliverable;
    coDrafters.push(reviewerIdentity); // REVISED adoption ⇒ reviewer is a co-drafter (Opus finding)
    // A revised deliverable is NEW text — it must clear the (hard) invariants too.
    const inv2 = runInvariants(deliverable);
    if (inv2.hard.length) {
      markDone("REVIEW", { verdict: review.verdict, readiness: "NO-GO", source: "revised-failed-invariants", failures: inv2.hard.slice(0, 12), model: reviewerIdentity });
      return { deliverable, readiness: "NO-GO",
        reason: "reviewer's REVISED deliverable failed invariants: " + inv2.hard.map((f) => `${f.kind}: ${f.detail}`).join("; ").slice(0, 500),
        review, invariantFailures: inv2.hard, reviewerIdentity, independence: r.independence };
    }
  }
  markDone("REVIEW", { verdict: review.verdict, readiness: review.readiness, reason: review.reason, model: reviewerIdentity, independence: r.independence, failClosed: review.failClosed || undefined });

  // Review NO-GO ⇒ done — don't pay for the reverify model on an already-failed gate.
  if (review.readiness === "NO-GO") {
    return { deliverable, readiness: "NO-GO", reason: `review: ${review.reason}`, review, invariantFailures: [], reviewerIdentity, independence: r.independence };
  }

  // ---- REVERIFY (model): only for invariant-clean, review-approved deliverables ----
  mark("REVERIFY");
  const rvUser = `TASK:\n${taskText}\n\nEVIDENCE LEDGER:\n${ledgerDigest(ledger, deliverable)}${priorBlock}\n\nDELIVERABLE TO REFUTE:\n${deliverable}`;
  const rv = await callRole(deps, ctx, "reverify", REVERIFY_SYSTEM + domainBlock + researchBlock + snapshotBlock, rvUser, { avoid: coDrafters.concat(reviewerIdentity) });
  const postV = parsePostVerdict(rv.content);
  markDone("REVERIFY", { readiness: postV.readiness, reason: postV.reason, model: rv.identity, independence: rv.independence, failClosed: postV.failClosed || undefined });

  const readiness = postV.readiness === "NO-GO" ? "NO-GO" : "GO";
  const reason = readiness === "GO" ? (review.reason || postV.reason) : `reverify: ${postV.reason}`;
  const independence = [r.independence, rv.independence].includes("degraded-same-model") ? "degraded-same-model" : "independent";
  return { deliverable, readiness, reason, review, invariantFailures: [], reviewerIdentity, independence };
}

// Small helper for the INVARIANTS ok row — how many citation tokens were
// validated. Counts BOTH grammars: obs-ID [E6.O2] (primary) and legacy
// [E1:path=value] (MM final-audit: the old regex missed obs-ID tokens and the
// telemetry read 0 on every modern run).
function deliverableTokenCount(text) {
  const s = String(text || "");
  return (s.match(/\[E\d+\.O\d+\]/g) || []).length + (s.match(/\[E\d+:/g) || []).length;
}

// Shared domain-grounding block (2026-07-20): the SAME C:\redacted\path
// the gates judge against is also handed to the tool-less ORCHESTRATOR phases
// (PLAN / SYNTHESIZE / CLARIFY) so every phase reasons from ONE source of truth.
// Tool-capable phases (EXECUTE / repair-execute) additionally have the on-demand
// sn_api_reference tool; the pack already advertises it (SN_REF_TOOL_NOTE).
function domainGroundingBlock(ctx) {
  return ctx && ctx.domainPack
    ? `\n\nDOMAIN REFERENCE (authoritative ServiceNow API/platform semantics from C:\\redacted\\path):\n${String(ctx.domainPack).slice(0, 12000)}`
    : "";
}

// Style block for the roles that WRITE user-facing prose (SYNTHESIZE / REPAIR /
// CLARIFY). The always-on unslop pack rides the agent-loop system prompt
// (background.js), but these roles use their OWN system prompts and would
// otherwise emit final text without the edit rules (validation-gates finding
// R1, 2026-08-19). Same default-ON gate as background.js.
function stylePackBlock(ctx) {
  return ctx?.settings?.unslopPackEnabled !== false ? "\n\n" + UNSLOP_PACK : "";
}

// ---------------------------------------------------------------------------
// runPhased — the pipeline entry (called by background.js when the toggle is on)
// ---------------------------------------------------------------------------

export async function runPhased(deps, loopCtx) {
  const { post, signal, settings, agentModel, runId, taskText } = loopCtx;
  const ledger = [];
  // The header-selected model: for the (possibly cloud) provider chosen in the
  // panel, this is the run's own brain — it drafts AND orchestrates ($SELECTED).
  const selectedProvider = deps.activeProvider(settings);
  // Fallback when cloudModel is unset: the subscription CLIs must get THEIR
  // plan default, never the local Ollama model id (MM final-audit — a
  // valid-shaped but wrong-provider id would reach the CLI's -m/--model).
  const providerDefault = selectedProvider === "claude-sub" ? "claude-fable-5-1"
    : selectedProvider === "codex-sub" ? "gpt-5-codex"
    : agentModel;
  const selectedTarget = selectedProvider === "ollama"
    ? { provider: "ollama", model: agentModel }
    : { provider: selectedProvider, model: settings.cloudModel || providerDefault };
  const chains = resolveRoleChains(settings.phaseModels, agentModel, selectedTarget);
  const ctx = { settings, signal, chains, taskText, ledger, post, domainPack: loopCtx.domainPack || null };

  const persist = async (phase, extra) => {
    const env = await savePhaseState({ runId, taskText: taskText.slice(0, 400), phase, agentModel, chainsHash: JSON.stringify(chains).length, ...extra });
    if (!env.ok) post({ type: "tool_result", name: "phase:persist", result: { ok: false, warning: `phase state not durable: ${env.reason}` } }); // visible, never silent (BL-3)
  };

  // Drafter identity = the HEADER-selected provider+model (for a cloud provider
  // the agent brain is settings.cloudModel, not the local agentModel id) — this
  // is what the review gate's avoid-rule excludes. MUTABLE (MM 16x-audit A4a):
  // an EXECUTE bridge fallback re-authors the draft on ollama, so the single
  // source of truth `activeDrafter` is updated there and used everywhere the
  // drafter is attributed (repair identity, gate avoid-set).
  let activeDrafter = identityOf(selectedTarget);
  const drafters = [activeDrafter];

  // MANDATORY STRUCTURED PLAN (user directive 2026-07-21): inject the plan contract
  // into the EXECUTE system prompt for every ACTIONABLE task, so the drafter (fast-path
  // OR wave subtasks — both read loopCtx.messages[0]) plans → builds → UATs with the
  // sample's rigor, regardless of which packs are on. Skipped only for a bare greeting/
  // ack or a pure conceptual/definitional question (a build plan there is noise).
  const isActionableTurn = !isTrivialTurn(taskText) && !isConceptualTurn(taskText);
  if (isActionableTurn && loopCtx.messages && loopCtx.messages[0]) {
    loopCtx.messages[0].content += "\n" + STRUCTURED_PLAN_CONTRACT;
  }

  // ---- PLAN (Tier 2): orchestrator decomposition. FAIL-SAFE — any planner
  // failure (bad JSON after one re-ask, chain exhausted) degrades to the
  // single-subtask fast path, never blocks the run.
  post({ type: "tool", name: "phase:PLAN", args: {} });
  await persist("PLAN");
  let plan = { ok: true, fastPath: true, subtasks: [], synthesis: "" };
  try {
    const planGround = domainGroundingBlock(ctx); // same C:\redacted\path
    const p1 = await callRole(deps, ctx, "orchestrator", PLAN_SYSTEM + planGround, `TASK:\n${taskText}`, { avoid: [] });
    let parsed = parsePlan(p1.content);
    if (!parsed.ok) {
      const p2 = await callRole(deps, ctx, "orchestrator", PLAN_SYSTEM + planGround, `TASK:\n${taskText}\n\nYour previous plan was INVALID (${parsed.error}). Respond with ONLY the corrected JSON object.`, { avoid: [] });
      parsed = parsePlan(p2.content);
    }
    if (parsed.ok) plan = parsed;
    post({ type: "tool_result", name: "phase:PLAN", result: plan.fastPath
      ? { ok: true, fast_path: true }
      : { ok: true, subtasks: plan.subtasks.map((s) => ({ id: s.id, title: s.title, role: s.role, depends_on: s.depends_on, ...(s.retagged ? { retagged_to_tools: true } : {}) })) } });
  } catch (e) {
    if (signal.aborted) { post({ type: "aborted" }); return { status: "aborted", runId }; }
    post({ type: "tool_result", name: "phase:PLAN", result: { ok: false, fallback: "fast_path", error: String(e?.message || e).slice(0, 160) } });
  }

  // Run ONE embedded agentLoop with the given user prompt; shared evidence
  // ledger across all subtasks (ids stay globally unique: E1..En).
  const runEmbedded = async (userPrompt, stepCap) => {
    const subCtx = {
      ...loopCtx,
      messages: userPrompt === null ? loopCtx.messages
        : [{ role: "system", content: loopCtx.messages[0].content }, { role: "user", content: userPrompt }],
      steps: [],
      embedded: { evidenceLedger: ledger },
      maxStepsOverride: stepCap
    };
    return deps.agentLoop(subCtx);
  };

  // AWF-parity ROLE-ROUTED subtask runner (2026-07-19u): run one subtask on the
  // model resolved for its role (execute-tools/code/bulk/research), sharing the
  // ledger. A per-subtask CLONED settings object routes the model without
  // mutating the run's settings. "tools" keeps the header (browser driver);
  // others get their Ollama specialist. research gets a live-web-search nudge.
  const runSubtask = async (userPrompt, target, { research, role } = {}) => {
    const callSettings = { ...loopCtx.settings };
    if (target && target.provider !== "ollama") { callSettings.provider = target.provider; callSettings.cloudModel = target.model; }
    else if (target) { callSettings.provider = "ollama"; callSettings.cloudModel = target.model; }
    // Ensure the research subtask actually reaches the web even if the user turned
    // auto-search off — the role's whole purpose is off-page facts.
    if (research) callSettings.autoWebSearch = true;
    const subCtx = {
      ...loopCtx,
      settings: callSettings,
      agentModel: target && target.provider === "ollama" ? target.model : (loopCtx.agentModel),
      messages: [{ role: "system", content: loopCtx.messages[0].content }, { role: "user", content: userPrompt }],
      steps: [],
      embedded: { evidenceLedger: ledger },
      maxStepsOverride: subtaskStepCap(role)
    };
    return deps.agentLoop(subCtx);
  };
  // Bounded concurrency pool — runs items(fn) with at most `limit` in flight.
  // Order-preserving results. Used for parallel dependency waves.
  const runPool = async (items, limit, fn) => {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
  };

  // ---- EXECUTE (fast path = Tier-1 behavior; multi = sequential subtasks) ----
  let draft, execSteps = [];
  try {
    if (plan.fastPath) {
      // CONCEPTUAL-TURN DIRECTIVE (2026-07-20c, live a-live-run, FRESH convo):
      // skipping the retry (20b) stopped the corrective-driven defensiveness, but
      // the drafter (glm) STILL opened a definitional answer with a sycophantic
      // disclaimer ("You're right to call that out… I did not run any sn_* tools")
      // — primed by the evidence-heavy EXECUTE system prompt. Nudge the drafter,
      // at the source, to answer the concept directly with no disclaimers.
      if (isConceptualTurn(taskText) && loopCtx.messages && loopCtx.messages[0]) {
        loopCtx.messages[0].content += "\n\nTHIS TURN IS A CONCEPTUAL/DEFINITIONAL QUESTION — it needs NO tools and NO live instance data. Answer it directly and completely from your knowledge, grounded by the ServiceNow reference already in your context. Do NOT open with a disclaimer, do NOT say \"you're right\" or reference any \"previous answer/attempt\", do NOT explain which tools you did or did not run, and do NOT offer to query the instance unless the user asked — just give the explanation the user asked for.";
      }
      post({ type: "tool", name: "phase:EXECUTE", args: { model: identityOf(selectedTarget) } });
      await persist("EXECUTE");
      loopCtx.embedded = { evidenceLedger: ledger };
      // EXECUTE runs the HEADER model (the drafter). When that's a subscription
      // BRIDGE provider (claude-sub/codex-sub), it depends on the desktop-server
      // + a logged-in CLI — if either is down, agentLoop throws or returns a
      // non-final. BRIDGE FALLBACK (user 2026-07-16, extending the ollama-tail
      // net to EXECUTE): retry the draft ONCE on the bridge-INDEPENDENT ollama
      // cloud model (localhost:11434 direct) so the run still produces a draft.
      const headerIsBridge = selectedProvider === "claude-sub" || selectedProvider === "codex-sub";
      let fallbackRan = false; // LATCH (MM 16x-audit A2): the fallback can run AT MOST once
      const runExecuteOnOllamaFallback = async (why) => {
        fallbackRan = true;
        post({ type: "tool_result", name: "phase:EXECUTE", result: { ok: false, error: String(why).slice(0, 140), fallback: `bridge unavailable — retrying EXECUTE on ollama:${DEFAULT_TAIL_CLOUD_MODEL}` } });
        // Redirect ALL subsequent embedded runs (repair-execute) to ollama too —
        // if the bridge is down now it will still be down at repair time.
        loopCtx.settings = { ...loopCtx.settings, provider: "ollama", cloudModel: DEFAULT_TAIL_CLOUD_MODEL };
        loopCtx.agentModel = DEFAULT_TAIL_CLOUD_MODEL;
        ctx.settings = loopCtx.settings;
        activeDrafter = `ollama:${DEFAULT_TAIL_CLOUD_MODEL}`; // A4a: single source of truth
        drafters[0] = activeDrafter;                          // gates avoid the RIGHT drafter now
        post({ type: "tool", name: "phase:EXECUTE", args: { model: activeDrafter, note: "bridge fallback" } });
        const fbCtx = { ...loopCtx, steps: [], embedded: { evidenceLedger: ledger } };
        return deps.agentLoop(fbCtx);
      };
      let exec;
      try {
        exec = await deps.agentLoop(loopCtx);
        // A non-final from a bridge header is usually a bridge failure surfaced
        // as a status, not a throw — fall back too (unless the user aborted).
        if (headerIsBridge && exec.status !== "final" && exec.status !== "aborted") {
          exec = await runExecuteOnOllamaFallback(`EXECUTE ended "${exec.status}" on the bridge`);
        }
      } catch (e) {
        if (signal.aborted) throw e;
        // Only fall back if we haven't already (A2: a throw from INSIDE the
        // fallback's own agentLoop must not trigger a second fallback — it would
        // just fail identically against the same dead ollama).
        if (!headerIsBridge || fallbackRan) throw e;
        exec = await runExecuteOnOllamaFallback(e?.message || e);
      }
      if (exec.status === "aborted") return exec;                   // resumable / user stop — no gates
      // ZERO-EVIDENCE RETRY (live runs 02:43 / 03:03 / A-B 03:05; 10:52 —
      // navigated then quit): a CLI-bridged drafter's FIRST turn sometimes ends
      // with NO EVIDENCE — refusing ("no browser control"), answering from
      // imagination with zero tools, OR doing only non-evidence steps (a bare
      // navigate) and stopping before it reads the form. The trigger is ZERO
      // LEDGER ENTRIES regardless of step count (a navigate is 1 step but 0
      // evidence — the earlier steps===0 guard missed it). One deterministic
      // corrective re-run before wasting the gate chain on an evidence-free draft.
      // ZERO-EVIDENCE-RETRY GATE: skip for a greeting/social/meta turn
      // (a-live-run) OR a conceptual/definitional question (a-live-run20-010106)
      // — both legitimately produce zero evidence and the gates approve the
      // direct answer; firing the corrective made "Hi" browse tabs and made a
      // "what is X" question answer defensively instead of explaining.
      if (exec.status === "final" && ledger.length === 0 && !isTrivialTurn(taskText) && !isConceptualTurn(taskText)) {
        post({ type: "tool_result", name: "phase:EXECUTE", result: { ok: false, steps: (exec.steps || []).length, evidence_entries: 0, retry: "no evidence gathered — re-running EXECUTE with a routing nudge" } });
        exec = await runEmbedded(
          // NEUTRAL routing nudge (2026-07-20b): NOT a second-person rebuke — the
          // old "IMPORTANT CORRECTION: your previous attempt was rejected" was
          // injected as a USER turn, so the model read it as user criticism and
          // replied "You're right to call that out… I did not run any sn_* tools"
          // instead of answering (a-live-run20-010106). Reframed as a decision
          // instruction that re-states the task first and FORBIDS defensive
          // meta-commentary, while keeping the tool-use push for real tasks.
          `${taskText}\n\nBefore answering, decide what THIS task needs:\n• If it requires reading or acting on something specific (a ServiceNow record, a web page, a file, the current tab), you MUST use your tools to gather real evidence carrying _ev/_cite tokens FIRST — never answer such a task from memory or stop after navigating: BROWSER TOOLS FIRST (read_page; list_editors + get_editor_value for a Script code editor; query_elements for field/checkbox state; open_form_section for fields behind tabs, e.g. Advanced → Condition + Script; for a BUILD task sn_check_duplicate then fill/save the form). Do NOT reproduce the output-format template (empty "REVIEW SUMMARY" / "REQUIREMENTS TRACEABILITY" / "DEPLOYMENT CHECKLIST" headings) as your answer.\n• If it is a conversational, definitional, or explanatory request that needs no external evidence, ANSWER THE QUESTION directly and completely. Do NOT explain what you did or did not do, do NOT reference a "previous answer" or "previous attempt", do NOT apologize, and do NOT add caveats about tools you didn't use or offer to "ground it in the instance" unless the user asked — just give the answer the user asked for.`,
          undefined
        );
        if (exec.status === "aborted") return exec;
      }
      if (exec.status !== "final" || !exec.finalText) {
        post({ type: "error", text: `Phase engine: EXECUTE ended without a deliverable (${exec.status}).` });
        await clearPhaseState();
        return exec;
      }
      draft = exec.finalText;
      execSteps = exec.steps || [];
      post({ type: "tool_result", name: "phase:EXECUTE", result: { ok: true, steps: execSteps.length, evidence_entries: ledger.length } });
    } else {
      // AWF-parity WAVE EXECUTE (2026-07-19u): subtasks run in dependency WAVES,
      // each ROUTED to its role's model (execute-tools/code/bulk/research), still
      // with AWF isolation (an executor sees ONLY its prompt + its depends_on
      // outputs). Waves run in dependency ORDER; within a wave subtasks are
      // SEQUENTIAL (conc=1) — every role, RESEARCH included (it now reads pages
      // via navigate+read_page, 19x), shares the ONE active browser tab, so
      // nothing can safely run concurrently. See the conc=1 note below.
      const outputs = {};   // id → { ok, text, status, role }
      await persist("EXECUTE");
      const byId = new Map(plan.subtasks.map((s) => [s.id, s]));
      const waves = plan.waves && plan.waves.length ? plan.waves : plan.subtasks.map((s) => [s.id]);
      const totalN = plan.subtasks.length;
      let stIndex = 0;
      for (const wave of waves) {
        const waveSubs = wave.map((id) => byId.get(id)).filter(Boolean);
        // SEQUENTIAL waves (2026-07-19x): research now READS pages in the browser
        // (navigate + read_page — renders JS, opens the tab the user sees), so it
        // shares the ONE active tab like every other role. Nothing can safely run
        // concurrently on a single tab, so waves run wave-by-wave but each wave is
        // sequential. (Dependency ORDERING is still honored by the wave structure;
        // the model lock serialized inference anyway, so this loses ~nothing.)
        const conc = 1;
        await runPool(waveSubs, conc, async (st) => {
          const idx = ++stIndex;
          const tag = `phase:EXECUTE ${idx}/${totalN} (${st.id}:${st.role})`;
          const failedDep = st.depends_on.find((d) => !outputs[d]?.ok);
          if (failedDep) {
            outputs[st.id] = { ok: false, text: "", status: "dependency_failed", role: st.role };
            post({ type: "tool", name: tag, args: { title: st.title } });
            post({ type: "tool_result", name: tag, result: { ok: false, dependency_failed: failedDep } });
            return;
          }
          const depContext = st.depends_on.length
            ? "\n\nDEPENDENCY OUTPUTS:\n" + st.depends_on.map((d) => `--- output of ${d} ---\n${(outputs[d]?.text || "").slice(0, 6000)}`).join("\n")
            : "";
          const roleTarget = (ctx.chains["execute-" + st.role] || ctx.chains["execute-tools"])[0];
          const roleIdentity = identityOf(roleTarget); // author of this subtask's output — fed into the gate avoid-set (P0)
          const researchNote = st.role === "research"
            ? "\n\nThis is a RESEARCH subtask: gather CURRENT off-page facts (versions, prices, docs, events) — never from memory. HOW TO READ SOURCES (FAST PATH FIRST): (1) use google_search to DISCOVER candidate source URLs and read its AI Overview summary (Google is richer + far less rate-limited than web_search, and its AI Overview often answers a current-fact question directly — reach for it FIRST; fall back to web_search only if google_search is blocked by a consent/bot wall); (2) READ each source with fetch_page FIRST — it is FAST, does NOT open or disturb a tab, and returns clean readable text that BYPASSES ads, pop-ups, and cookie-consent banners a real page load would hit; its body is fully citable (chunked as [E<n>.text], [E<n>.text.1], …). (3) FALL BACK to navigate + read_page ONLY when fetch_page ERRORS or returns THIN content — a JS-rendered site (finance / dashboard / SPA) comes back as just nav / menu / titles with no real body because fetch_page runs no JavaScript; navigate + read_page opens the tab and EXECUTES the page's JS so client-side numbers render. google_search is often the FASTEST path to a current fact and its AI Overview is readable even when the official docs site is a JS reader you cannot extract — reach for it early rather than wrestling an unscrapable official page. You may also fetch_page a known source URL directly. FOLLOW THE SOURCE TO THE ANSWER — DO NOT STOP ONE HOP SHORT: if a web_search result, a page's table-of-contents, or a link on a page NAMES the exact resource that would answer the question (e.g. a title like \"release highlights\", \"what's new\", \"changelog\", or a section link to the specific topic), you MUST OPEN that named URL/section (fetch_page first, navigate + read_page fallback) BEFORE you may conclude \"the detail was not captured.\" A landing / overview / table-of-contents page that only points at where the answer lives is NOT the answer — drill into the page it points to. Concluding \"could not find it\" while a directly-relevant, specifically-named source URL is still unopened is a research failure, not an honest answer. WHEN A PAGE WON'T YIELD ITS BODY — PIVOT, DO NOT OCR: if read_page returns only boilerplate ('Loading application...', 'Skip to main content', header / nav / cookie text) with NO real article body, the page is a JS-app / iframe reader that neither fetch_page nor read_page can extract (ServiceNow's docs.servicenow.com/docs/r/ Fluid-Topics reader is the classic case — its content lives in an iframe both tools miss). Do NOT hammer capture_screenshot to OCR it: a screenshot of a JS-unrendered page returns only the page's chrome / marketing text, which is NOT the article and MUST NOT be cited as feature-level facts (that path fabricates). After at most ONE screenshot that adds no new article text, STOP screenshotting and PIVOT to an alternate readable source for the same fact — a support.servicenow.com/kb 'kb_article_view' KB URL, a print / plain variant of the page, or a reputable secondary source surfaced by web_search — read it with fetch_page. Honest 'could not complete' is only valid once you have opened the named sources AND exhausted these pivots and they still lacked the detail. CITATION FOR WEB FACTS: attach a PATH-ONLY source token (e.g. [E3.O2]) to each stated figure, and put the figure itself in your PROSE — never inside a value token like [E3:price=330] (the page text is longer than the ledgered snippet, so a value-match would fail). PREFER a token pointing at the READ_PAGE observation of the page you actually read the number from — a bare web_search result title/snippet is a weaker source than the rendered page body; only fall back to a search-result token when you could not open the page. SPOT-CHECKABILITY (required): immediately after each figure, quote the EXACT phrase from the source that states it, in quotation marks — e.g. `the current price target is $330 (\"consensus 12-month target of $330\") [E3.O2]` — so a human can verify the number against the source. One source token per figure; an unsourced number is not allowed; a number with no accompanying source quote is treated as unsupported."
            : "";
          post({ type: "tool", name: tag, args: { title: st.title, model: roleIdentity } });
          const r = await runSubtask(  // role drives the step-cap (build roles get more room)
            `SUBTASK ${st.id} (role: ${st.role}) of the larger task "${taskText.slice(0, 300)}":\n${st.prompt}${depContext}${researchNote}\n\nWhen done, end your turn with the subtask's result as plain text (with evidence citation tokens).`,
            roleTarget,
            { research: st.role === "research", role: st.role }
          );
          if (r.status === "aborted") { outputs[st.id] = { ok: false, text: "", status: "aborted", role: st.role, identity: roleIdentity }; return; }
          outputs[st.id] = { ok: r.status === "final" && !!r.finalText, text: r.finalText || "", status: r.status, role: st.role, identity: roleIdentity };
          execSteps = execSteps.concat(r.steps || []);
          post({ type: "tool_result", name: tag, result: { ok: outputs[st.id].ok, status: r.status, role: st.role, steps: (r.steps || []).length, evidence_entries: ledger.length } });
        });
        if (signal.aborted) return { status: "aborted", steps: execSteps, runId }; // user stop between waves — resumable
      }
      const good = plan.subtasks.filter((s) => outputs[s.id]?.ok);
      if (!good.length) {
        post({ type: "error", text: "Phase engine: every subtask failed — nothing to synthesize." });
        await clearPhaseState();
        return { status: "error", runId };
      }
      // P0 INDEPENDENCE (an internal review, 2026-07-19y): every model that
      // AUTHORED surviving content is a drafter and must be excluded from the
      // reviewer/reverify roster — otherwise, when a single subtask survives, its
      // own author could review it and be reported "independent." Feed all
      // surviving authors into `drafters` BEFORE the gate (the synthesizer, when
      // it runs, is added just below; the whole set is checkpointed for resume).
      for (const s of good) {
        const idn = outputs[s.id]?.identity;
        if (idn && !drafters.includes(idn)) drafters.push(idn);
      }

      // ---- SYNTHESIZE (orchestrator; skipped when only one output) ----
      if (good.length === 1) {
        draft = outputs[good[0].id].text;
      } else {
        post({ type: "tool", name: "phase:SYNTHESIZE", args: {} });
        await persist("SYNTHESIZE");
        const synthUser = `TASK:\n${taskText}\n\nSYNTHESIS INSTRUCTIONS:\n${plan.synthesis || "Combine the outputs into one coherent deliverable."}\n\nSUBTASK OUTPUTS:\n` +
          plan.subtasks.map((s) => `--- ${s.id}: ${s.title} (${outputs[s.id].ok ? "ok" : outputs[s.id].status}) ---\n${(outputs[s.id].text || "(no output)").slice(0, 12000)}`).join("\n");
        const sy = await callRole(deps, ctx, "orchestrator", SYNTH_SYSTEM + domainGroundingBlock(ctx) + stylePackBlock(ctx), synthUser, { avoid: [] });
        draft = sy.content.trim();
        drafters.push(sy.identity); // the synthesizer co-authored the draft
        post({ type: "tool_result", name: "phase:SYNTHESIZE", result: { ok: true, model: sy.identity, subtasks_combined: good.length } });
      }
    }
  } catch (e) {
    await clearPhaseState();
    if (signal.aborted) { post({ type: "aborted" }); return { status: "aborted", runId }; }
    post({ type: "error", text: `Phase engine: EXECUTE/SYNTHESIZE crashed — ${String(e?.message || e).slice(0, 300)}` });
    return { status: "error", runId };
  }
  // Hand off to the shared gate → repair → clarify → final tail. Extracted so
  // resumePhased() can re-enter it with a persisted draft + ledger after an
  // interruption, WITHOUT re-running the expensive EXECUTE (Tier 3 resume).
  return gateAndFinalize({ deps, ctx, post, signal, runId, taskText, ledger, persist, draft, drafters, activeDrafter, execSteps, plan, runEmbedded, system: loopCtx.messages[0].content, effAgentModel: loopCtx.agentModel });
}

// ---------------------------------------------------------------------------
// resumePhased (Tier 3) — continue a phased run that was interrupted (MV3
// eviction / browser restart / reload) AFTER the expensive EXECUTE, WITHOUT
// re-gathering evidence. Uses the persisted draft + ledger (savePhaseData) and
// re-enters gateAndFinalize. Returns { resumed: false } when there is nothing
// resumable (interrupted before EXECUTE finished, so no draft was saved) — the
// caller then starts a fresh run. Same deps/loopCtx shape as runPhased.
// ---------------------------------------------------------------------------
export async function resumePhased(deps, loopCtx, saved) {
  const { post, signal, runId, taskText } = loopCtx;
  const env = saved?.envelope, data = saved?.data;
  // Only the gate stages are resumable: they need a completed draft + a
  // NON-EMPTY ledger (an empty ledger is not real evidence — P1-4).
  // Interruptions during PLAN/EXECUTE saved no phaseData → nothing to resume.
  if (!env || !data || !data.draft || !Array.isArray(data.ledger) || data.ledger.length === 0) {
    return { resumed: false, reason: "no completed EXECUTE (draft + evidence) to resume from" };
  }
  post({ type: "tool_result", name: "phase:RESUME", result: { ok: true, from_phase: env.phase || "?", evidence_entries: data.ledger.length, note: "continuing from the persisted draft (evidence gathered ≤1h ago — re-verify before applying); EXECUTE not re-run" } });

  const ledger = data.ledger;
  // EFFECTIVE settings (MM 16z-audit P1-1): restore the provider/model the
  // ORIGINAL run ended on — if it fell back off a dead bridge to ollama, a
  // resumed repair-EXECUTE must use that SAME ollama path, not the header
  // provider (which is likely still down).
  const settings = { ...loopCtx.settings };
  if (data.effProvider) settings.provider = data.effProvider;
  if (data.effCloudModel !== undefined) settings.cloudModel = data.effCloudModel;
  const agentModel = data.effAgentModel || loopCtx.agentModel;
  const selectedProvider = data.effProvider || deps.activeProvider(settings);
  const providerDefault = selectedProvider === "claude-sub" ? "claude-fable-5-1"
    : selectedProvider === "codex-sub" ? "gpt-5-codex" : agentModel;
  const selectedTarget = selectedProvider === "ollama"
    ? { provider: "ollama", model: agentModel }
    : { provider: selectedProvider, model: settings.cloudModel || providerDefault };
  const chains = resolveRoleChains(settings.phaseModels, agentModel, selectedTarget);
  const ctx = { settings, signal, chains, taskText, ledger, post, domainPack: loopCtx.domainPack || null };
  const persist = async (phase, extra) => {
    const e = await savePhaseState({ runId, taskText: taskText.slice(0, 400), phase, agentModel, chainsHash: JSON.stringify(chains).length, ...extra });
    if (!e.ok) post({ type: "tool_result", name: "phase:persist", result: { ok: false, warning: `phase state not durable: ${e.reason}` } });
  };
  // RESTORE the exact persisted drafter identities (MM 16z-audit P0-1) — the
  // gate avoid-set must exclude the ACTUAL author (e.g. ollama:glm after a
  // fallback), NOT a freshly-derived selectedTarget. Fall back to the derived
  // identity only for legacy checkpoints that predate this field.
  const activeDrafter = data.activeDrafter || identityOf(selectedTarget);
  const drafters = Array.isArray(data.drafters) && data.drafters.length ? data.drafters.slice() : [activeDrafter];
  // Rebuild runEmbedded from the PERSISTED system prompt so a resumed
  // repair-EXECUTE gathers evidence with the same SN pack + citations. If the
  // persisted system was TRUNCATED (P1-2), prefer a freshly-rebuilt one when
  // available rather than driving a repair-EXECUTE off a mid-cut prompt.
  const rebuilt = (loopCtx.messages && loopCtx.messages[0] && loopCtx.messages[0].content) || "";
  const sysPrompt = (data.systemTruncated && rebuilt) ? rebuilt : (data.system || rebuilt || "");
  const runEmbedded = async (userPrompt, stepCap) => deps.agentLoop({
    ...loopCtx, settings, agentModel,
    messages: userPrompt === null
      ? [{ role: "system", content: sysPrompt }]
      : [{ role: "system", content: sysPrompt }, { role: "user", content: userPrompt }],
    steps: [], embedded: { evidenceLedger: ledger }, maxStepsOverride: stepCap
  });

  const r = await gateAndFinalize({ deps, ctx, post, signal, runId, taskText, ledger, persist,
    draft: data.draft, drafters, activeDrafter, execSteps: [], plan: data.plan || { fastPath: true }, runEmbedded, system: sysPrompt, effAgentModel: agentModel });
  return { resumed: true, ...r };
}

// The gate → repair → clarify → final-emission tail of a phased run. Called by
// runPhased after EXECUTE/SYNTHESIZE, and by resumePhased on a persisted draft.
async function gateAndFinalize({ deps, ctx, post, signal, runId, taskText, ledger, persist, draft, drafters, activeDrafter, execSteps, plan, runEmbedded, system, effAgentModel }) {
  const exec = { steps: execSteps || [] }; // downstream banner/return shape
  await persist("REVIEW");
  // Persist the resume payload (MM 16z-audit P0-1/P1-1/P1-2): draft+ledger, the
  // EXACT post-fallback drafter identities (so a resumed gate's avoid-set still
  // excludes the real author — never lets it review its own draft), the
  // EFFECTIVE provider/model (so a resumed repair-EXECUTE uses the redirected
  // ollama path when the original run fell back off a dead bridge), and the
  // system prompt WITH a truncation flag (a cut system must not silently drive a
  // resumed repair-EXECUTE). runId binds envelope↔data (P0-3).
  const sysFull = system ? String(system) : "";
  const systemTruncated = sysFull.length > 60000;
  // Reusable checkpoint so the LATEST draft (after each repair) is what a
  // mid-repair interruption resumes from (MM 16z-audit P1-4), not the original.
  const checkpointData = async (curDraft, curDrafters) => {
    const r = await savePhaseData({
      runId, draft: String(curDraft).slice(0, 200000), ledger,
      plan: plan && plan.fastPath ? undefined : plan,
      system: systemTruncated ? sysFull.slice(0, 60000) : (sysFull || undefined),
      systemTruncated: systemTruncated || undefined,
      drafters: Array.isArray(curDrafters) ? curDrafters.slice() : undefined,
      activeDrafter,
      effProvider: ctx.settings.provider, effCloudModel: ctx.settings.cloudModel, effAgentModel
    });
    if (!r.ok) post({ type: "tool_result", name: "phase:persist", result: { ok: false, warning: `phase data not durable: ${r.reason}` } });
    return r;
  };
  await checkpointData(draft, drafters);

  try {
    // ---- Gate #1 ----
    let gate = await gateDeliverable(deps, ctx, draft, "", drafters, post);

    // ---- REPAIR LOOP: fix until GO or the attempt cap (user directive
    // 2026-07-16: "if it's NO-GO I want the SYSTEM to fix the issue" — this
    // intentionally EXCEEDS AWF's one-repair bound). Two modes per round (§3.7):
    // (a) text-only correction via the repair role — default;
    // (b) repair-EXECUTE — when the gate failed on MISSING/UNRESOLVED evidence
    //     (or the reviewer demands evidence), a short embedded tool loop
    //     (≤6 steps) re-reads the INSTANCE (source of truth) to gather it.
    // Cap: phaseModels.maxRepairs (default 3, clamp 1-5). CLARIFY only after
    // the loop is exhausted.
    const maxRepairs = Math.min(5, Math.max(1, Number(ctx.settings?.phaseModels?.maxRepairs) || 3));
    let attempts = 0;
    const repairIdentities = [];
    const gateHistory = []; // objection history — pins the goalposts across rounds
    const repairDomain = ctx.domainPack
      ? `\n\nDOMAIN REFERENCE (authoritative API/platform semantics — your corrected code must conform to THIS):\n${String(ctx.domainPack).slice(0, 12000)}`
      : "";
    while (gate.readiness === "NO-GO" && attempts < maxRepairs && !signal.aborted) {
      attempts++;
      const tag = attempts === 1 ? "phase:REPAIR" : `phase:REPAIR#${attempts}`;
      const evidenceGap = repairNeedsExecute(gate.reason, gate.invariantFailures);
      post({ type: "tool", name: tag, args: { mode: evidenceGap ? "execute" : "text", attempt: `${attempts}/${maxRepairs}`, reason: gate.reason.slice(0, 200) } });
      await persist("REPAIR", { attempt: attempts, reason: gate.reason.slice(0, 300), mode: evidenceGap ? "execute" : "text" });
      try {
        let repairedRaw, repIdentity, embeddedErr = "";
        if (evidenceGap) {
          const r = await runEmbedded(
            `You are REPAIRING a deliverable that FAILED its quality gate (attempt ${attempts} of ${maxRepairs}).\nGATE FAILURES:\n${gate.reason}\n\nFAILED DELIVERABLE:\n${gate.deliverable.slice(0, 12000)}\n\nUse your tools — BROWSER TOOLS FIRST on the open tab. There are TWO cases; pick the one the failures describe:\n(A) WRONG or MISMATCHED SAVED ARTIFACT — the record in the instance has the wrong script, a wrong field/checkbox, or does NOT match what the deliverable claims. FIX THE INSTANCE, do not just reword the write-up: re-open the record, correct it (set_editor_value for the script; sn_set_field for checkboxes/choice fields — e.g. UNCHECK an over-set trigger like action_update; fill_input for text fields), then save_record, then RE-READ (read_page / get_editor_value / query_elements) to confirm the now-correct state. NEVER claim a fix you did not actually apply to the record.\n(B) MISSING/UNVERIFIED evidence — GATHER it from the live instance (read_page, query_elements, open_form_section, get_editor_value).\nEach tool result carries _ev and _cite tokens. THEN in your FINAL turn output the ENTIRE corrected deliverable wrapped in these exact lines — BEGIN_DELIVERABLE on its own line, then the full deliverable, then END_DELIVERABLE on its own line — every factual claim carrying a token copied VERBATIM from _cite and describing the ACTUAL now-saved state (never a state you did not apply). If a claim's evidence can't be gathered, delete or soften it. Emitting the wrapped deliverable is REQUIRED — a turn with only tool calls and no BEGIN_DELIVERABLE wastes the whole repair.`,
            12 // bounded: room to RE-EDIT + save + re-read the artifact AND write the deliverable
          );
          if (r.status === "aborted") return r;
          repairedRaw = r.finalText || "";
          repIdentity = activeDrafter; // A4a: the run's own brain (ollama after a bridge fallback)
          // SALVAGE (live run 08:12: repair-execute gathered fresh evidence via
          // browser tools but never wrapped its answer — all that work was
          // discarded). If it forgot the fence but produced a substantial final
          // answer that carries citation tokens, treat that final text AS the
          // deliverable rather than throwing the repair away.
          if (!/BEGIN_DELIVERABLE/.test(repairedRaw) && r.status === "final") {
            const ft = String(r.finalText || "");
            if (ft.trim().length > 400 && /\[E\d+(\.O\d+)?[:\]]/.test(ft)) {
              repairedRaw = `BEGIN_DELIVERABLE\n${ft.trim()}\nEND_DELIVERABLE`;
              post({ type: "tool_result", name: tag, result: { ok: true, salvaged: "repair-execute final text used as deliverable (fence omitted by model)", model: repIdentity } });
            }
          }
          // MM final-audit: don't mask the embedded run's REAL failure (error /
          // step-cap) behind the generic "no delimited deliverable" line below.
          if (r.error) embeddedErr = String(r.error).slice(0, 160);
          else if (r.status && r.status !== "final") embeddedErr = `embedded repair ended with status "${r.status}"`;
        } else {
          const repUser = `TASK:\n${taskText}\n\nEVIDENCE LEDGER:\n${ledgerDigest(ledger, gate.deliverable)}\n\nFAILED DELIVERABLE (repair attempt ${attempts} of ${maxRepairs}):\n${gate.deliverable}\n\nGATE FAILURE REASONS (fix EXACTLY these — the reviewer will re-judge):\n${gate.reason}`;
          const rep = await callRole(deps, ctx, "repair", REPAIR_SYSTEM + repairDomain + stylePackBlock(ctx), repUser, { avoid: [] });
          repairedRaw = rep.content;
          repIdentity = rep.identity;
          // SALVAGE — text-mode twin of the 16t repair-execute net (live
          // a-live-run REPAIR#3: deepseek's text repair contained the corrected
          // guarded script but omitted the BEGIN/END_DELIVERABLE fence — the
          // whole round was discarded and the loop died one re-gate short of a
          // possible GO). Same bar: substantial + citation-carrying. Safe: the
          // salvaged draft still re-enters invariants + review below — salvage
          // never skips a gate, it only stops good work being thrown away.
          if (!/BEGIN_DELIVERABLE/.test(String(repairedRaw))) {
            const ft = String(repairedRaw || "");
            if (ft.trim().length > 400 && /\[E\d+(\.O\d+)?[:\]]/.test(ft)) {
              repairedRaw = `BEGIN_DELIVERABLE\n${ft.trim()}\nEND_DELIVERABLE`;
              post({ type: "tool_result", name: tag, result: { ok: true, salvaged: "text-repair output used as deliverable (fence omitted by model)", model: repIdentity } });
            }
          }
        }
        const m = String(repairedRaw).match(/BEGIN_DELIVERABLE\s*([\s\S]*?)\s*END_DELIVERABLE/);
        if (!m || !m[1].trim()) {
          post({ type: "tool_result", name: tag, result: { ok: false, error: `repair produced no delimited deliverable — stopping the repair loop${embeddedErr ? ` (underlying: ${embeddedErr})` : ""}` } });
          break;
        }
        post({ type: "tool_result", name: tag, result: { ok: true, mode: evidenceGap ? "execute" : "text", model: repIdentity, attempt: `${attempts}/${maxRepairs}` } });
        repairIdentities.push(repIdentity);
        gateHistory.push(gate.reason);
        gate = await gateDeliverable(deps, ctx, m[1].trim(), `#${attempts + 1}`, drafters.concat(repairIdentities), post, gateHistory);
        // Re-checkpoint the repaired draft (P1-4): a mid-loop interruption now
        // resumes from THIS draft + the accumulated repair identities.
        await checkpointData(gate.deliverable, drafters.concat(repairIdentities));
      } catch (e) {
        // MM final-audit: a USER ABORT must not be swallowed here — rethrow so
        // the outer handler returns {status:"aborted"} instead of emitting a
        // final result for a run the user stopped.
        if (signal.aborted) throw e;
        post({ type: "tool_result", name: tag, result: { ok: false, error: String(e?.message || e).slice(0, 200) } });
        break;
      }
    }

    // ---- CLARIFY (best-effort) ----
    let userQuestion = null;
    if (gate.readiness === "NO-GO" && !signal.aborted) {
      post({ type: "tool", name: "phase:CLARIFY", args: {} });
      try {
        // AWF parity: CLARIFY is an ORCHESTRATOR duty (run-core.js routes
        // clarify to the orchestrator role) — the header-selected model.
        const cl = await callRole(deps, ctx, "orchestrator", CLARIFY_SYSTEM + domainGroundingBlock(ctx) + stylePackBlock(ctx), `TASK:\n${taskText}\n\nWHY THE GATES FAILED:\n${gate.reason}\n\nDELIVERABLE EXCERPT:\n${gate.deliverable.slice(0, 4000)}`, { avoid: [] });
        // Question hygiene (live run #11: raw model REASONING leaked into the
        // final — "Wait, the excerpt doesn't explicitly show…"): keep ONLY
        // numbered question lines when present; fall back to trimmed text.
        const numbered = cl.content.split(/\n/).filter((l) => /^\s*\d+[.)]\s/.test(l));
        userQuestion = (numbered.length ? numbered.join("\n") : cl.content.trim()).slice(0, 2000);
        // The row stays machine-shaped (count only); the QUESTIONS render as
        // natural language in the final answer (user feedback: no prose in JSON).
        post({ type: "tool_result", name: "phase:CLARIFY", result: { ok: true, model: cl.identity, questions_count: numbered.length || 1 } });
      } catch (e) {
        post({ type: "tool_result", name: "phase:CLARIFY", result: { ok: false, error: String(e?.message || e).slice(0, 200) } });
      }
    }

    // ---- DONE: the phase engine (not agentLoop) owns the final emission ----
    const banner = gate.readiness === "GO"
      ? `✅ GATED: GO — ${gate.reason || "review + reverify passed"} (review verdict: ${gate.review.verdict}; independence: ${gate.independence})`
      : `🛑 GATED: NO-GO — ${gate.reason}${gate.independence === "degraded-same-model" ? " (independence: degraded-same-model)" : ""}`;
    // AWF-parity RUN SUMMARY + readiness pill (2026-07-19u, feature 4): a compact
    // ledger of what ran — the readiness decision, the role-routed subtask
    // breakdown, evidence gathered, gate rounds, and the billing model. The
    // extension doesn't meter tokens (Ollama defaults are $0), so billing is
    // qualitative, not a fabricated dollar figure.
    const roleCounts = (plan && !plan.fastPath && Array.isArray(plan.subtasks))
      ? plan.subtasks.reduce((m, s) => { m[s.role] = (m[s.role] || 0) + 1; return m; }, {})
      : null;
    const subtaskLine = roleCounts
      ? `${plan.subtasks.length} subtasks (${Object.entries(roleCounts).map(([r, n]) => `${r}×${n}`).join(", ")})`
      : "single-focus (fast path)";
    // Honest readiness pill (an internal review, 2026-07-19y — P2): a GO is not
    // unconditionally "ready for production." A web-research GO certifies the
    // figures are SOURCED, not that each number was value-matched to the page —
    // spot-check before acting. A degraded-same-model GO wasn't independently
    // reviewed. Say so rather than over-stating.
    // Compose EVERY caveat that applies — a research run in a small roster is
    // often ALSO degraded, and both matter (2026-07-20g, live PE7 a-live-run:
    // the old either/or prioritized the degraded caveat and DROPPED the research
    // "verify figures" one). Plain "ready for production" only when neither holds.
    const isWebResearch = Array.isArray(ledger) && ledger.some((e) => e && e.success && WEB_EVIDENCE_TOOLS.has(e.tool));
    const goCaveats = [];
    if (isWebResearch) goCaveats.push("sources cited — verify the specific figures against the sources before acting");
    if (gate.independence === "degraded-same-model") goCaveats.push("same-model fallback (independence degraded — advisory, not a second opinion)");
    const goPill = goCaveats.length
      ? "✅ GO — " + goCaveats.map((c) => "⚠️ " + c).join(" · ")
      : "✅ GO — ready for production";
    const runSummary = [
      "## Run summary",
      `- **Readiness:** ${gate.readiness === "GO" ? goPill : `🛑 NO-GO — ${String(gate.reason || "").slice(0, 160)}`}`,
      `- **Execution:** ${subtaskLine}`,
      `- **Evidence:** ${ledger.length} observation${ledger.length === 1 ? "" : "s"} · ${execSteps.length} tool step${execSteps.length === 1 ? "" : "s"}`,
      `- **Gates:** review ×${gateHistory.length + 1} → reverify (reviewer ${gate.reviewerIdentity || "?"} · independence ${gate.independence})`,
      `- **Billing:** default roster is Ollama-cloud subscription ($0/token); any paid-API or subscription-bridge leg runs only when a preset/config selects it`
    ].join("\n");
    const finalText = `${gate.deliverable}\n\n---\n${runSummary}\n\n${banner}${userQuestion ? `\n\n### ❓ To proceed, please answer:\n\n${userQuestion}` : ""}`;
    await clearPhaseState();
    // phaseMeta drives the '⬇ phase-report.md' export button (MM 16z-audit P1-3:
    // the button existed but the engine never attached this, so it was dead).
    const phaseMeta = {
      task: taskText.slice(0, 400),
      roster: `review ${gate.reviewerIdentity || "?"} / independence ${gate.independence}`,
      plan: (plan && !plan.fastPath) ? plan.subtasks : undefined,
      ledger,
      gates: gateHistory.map((reason, i) => ({ phase: `review#${i + 1}`, readiness: "NO-GO", reason }))
        .concat([{ phase: "final", readiness: gate.readiness, model: gate.reviewerIdentity, reason: gate.reason }]),
      deliverable: gate.deliverable, readiness: gate.readiness
    };
    post({ type: "final", text: finalText, runId, phaseMeta });
    return { status: "final", finalText, steps: exec.steps, runId, readiness: gate.readiness, independence: gate.independence };
  } catch (e) {
    if (signal.aborted) { post({ type: "aborted" }); return { status: "aborted", steps: exec.steps, runId }; }
    // Gate infrastructure failure (chains exhausted etc.): FAIL CLOSED — surface
    // the draft explicitly as UNREVIEWED, never as a gated pass (T2 spirit).
    const finalText = `${draft}\n\n---\n⚠️ UNGATED: the phase-engine gates could not run (${String(e?.message || e).slice(0, 300)}). Treat the above as an UNREVIEWED draft.`;
    await clearPhaseState();
    post({ type: "final", text: finalText, runId });
    return { status: "final", finalText, steps: exec.steps, runId, readiness: "UNGATED" };
  }
}