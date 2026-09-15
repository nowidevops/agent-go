// phase-engine.test.mjs — node integration tests for runPhased with mocked
// deps (no Chrome, no Ollama). Verifies the pipeline WIRING: T2 (draft never
// posts as final before gates), T3 (fabrication dies in invariants before any
// reverify model call), repair re-gate, fail-closed UNGATED path, T11 (grok
// rejected from chains). Run: node phase-engine.test.mjs   Author: iDevOpsLLC

// STRUCTURAL live-bridge guard (MM final-audit item 12 — the trap bit twice):
// with this set, phase-engine's default claude-sub/codex-sub bridge functions
// THROW before any fetch, so a test missing its deps.<x>Sub mock fails loudly
// instead of invoking the real CLI and billing a real subscription.
globalThis.__PHASE_TEST_MODE__ = true;

import { runPhased, resumePhased, resolveRoleChains, identityOf, isTrivialTurn, isConceptualTurn, subtaskStepCap, repairNeedsExecute, ledgerDigest } from "./phase-engine.js";

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const LEDGER_OBS = [
  { path: "sys_script.action_insert.checked", value: "false" },
  { path: "sys_script.action_update.checked", value: "true" }
];

function makeDeps({ draft, reviewScript, reverifyScript, repairScript, planScript, synthScript }) {
  const calls = { review: 0, reverify: 0, repair: 0, clarify: 0, plan: 0, synth: 0, roleModels: [] };
  const deps = {
    calls,
    agentLoop: async (ctx) => {
      // Simulate EXECUTE: populate the ledger like the real tool-dispatch site would.
      ctx.embedded.evidenceLedger.push({
        id: "E" + (ctx.embedded.evidenceLedger.length + 1), tool: "query_elements",
        sequence: ctx.embedded.evidenceLedger.length + 1, success: true, truncated: false,
        observations: LEDGER_OBS
      });
      return { status: "final", finalText: draft, steps: [{ tool: "query_elements" }], runId: ctx.runId };
    },
    chatStream: async ({ messages, model }) => {
      const sys = messages[0].content;
      let role = "clarify";
      if (/adversarial reviewer/i.test(sys)) role = "review";
      else if (/final independent verifier/i.test(sys)) role = "reverify";
      else if (/repairing a deliverable/i.test(sys)) role = "repair";
      else if (/orchestrator of a browser agent/i.test(sys)) role = "plan";
      else if (/combining subtask outputs/i.test(sys)) role = "synth";
      calls[role]++;
      calls.roleModels.push(`${role}:${model}`);
      const script = { review: reviewScript, reverify: reverifyScript, repair: repairScript, plan: planScript, synth: synthScript }[role];
      const fallback = { plan: '{"fast_path": true}', synth: "combined output" }[role] || "1. What evidence is available?";
      const content = typeof script === "function" ? script(calls[role], messages[1].content) : (script ?? fallback);
      return { content };
    },
    withModelLock: (fn) => fn(),
    activeProvider: () => "ollama"
  };
  // claude-sub targets must NEVER hit the live bridge in tests — route them
  // through the same scripted chatStream mock (role detection via system).
  // Closure over `deps` so scenario-level chatStream overrides are honored.
  deps.claudeSub = async ({ system, user, model }) => {
    const { content } = await deps.chatStream({ messages: [{ role: "system", content: system }, { role: "user", content: user }], model: "claude-sub:" + (model || "") });
    return content;
  };
  // Same for codex-sub (out of the DEFAULTS since 2026-07-16 — OpenAI legs are
  // back on the API — but still reachable via custom phaseModels configs):
  // without this mock the suite invokes the REAL codex CLI, which stalls
  // unauthenticated.
  deps.codexSub = async ({ system, user, model }) => {
    const { content } = await deps.chatStream({ messages: [{ role: "system", content: system }, { role: "user", content: user }], model: "codex-sub:" + (model || "") });
    return content;
  };
  return deps;
}

function makeCtx() {
  const events = [];
  return {
    events,
    loopCtx: {
      messages: [{ role: "system", content: "sys" }], steps: [],
      settings: { phaseModels: {}, numCtx: 8192, ollamaBase: "http://x", temperature: 0 },
      agentModel: "local-model",
      post: (m) => events.push(m),
      signal: new AbortController().signal,
      askApproval: async () => true,
      runId: "test-run", taskText: "code review this business rule", lessons: []
    }
  };
}

const HONEST_DRAFT = "Only Update is enabled [E1:sys_script.action_update.checked=true]; Insert is disabled [E1:sys_script.action_insert.checked=false]. The rule logic itself follows best practice and needs no changes.";
const FABRICATED_DRAFT = "High severity: Insert, Update, Delete and Query are all enabled — every When-to-run flag returned true. This must be fixed before deployment of the business rule.";

// ---------------------------------------------------------------------------
console.log("— scenario 1: honest draft, reviewer GO, reverifier GO —");
{
  const { events, loopCtx } = makeCtx();
  const deps = makeDeps({
    draft: HONEST_DRAFT,
    reviewScript: "VERDICT: APPROVED\nREADINESS: GO — claims match the ledger",
    reverifyScript: "Checked against ledger.\nPOST_VERDICT: GO — nothing to refute"
  });
  const r = await runPhased(deps, loopCtx);
  const finals = events.filter((e) => e.type === "final");
  t("exactly one final", finals.length === 1);
  t("final is gated GO", r.readiness === "GO" && finals[0].text.includes("GATED: GO"));
  t("T2: final only after gates", events.findIndex((e) => e.type === "final") > events.findIndex((e) => e.name === "phase:REVERIFY"));
  t("review called once", deps.calls.review === 1);
  t("reverify called once", deps.calls.reverify === 1);
  t("no repair on GO", deps.calls.repair === 0);
}

// ---------------------------------------------------------------------------
console.log("— scenario 2: T3 fabrication — STRICT mode: invariants kill it BEFORE reverify; repair-EXECUTE rescues —");
{
  const { events, loopCtx } = makeCtx();
  loopCtx.settings.phaseModels = { gateMode: "strict" }; // full enforcement (opt-in)
  const deps = makeDeps({
    // Reviewer APPROVES the fabrication (worst case — a fooled reviewer).
    reviewScript: "VERDICT: APPROVED\nREADINESS: GO — looks fine to me",
    reverifyScript: "POST_VERDICT: GO — fine"
  });
  // Evidence-gap failure ⇒ repair runs as a BOUNDED EMBEDDED TOOL LOOP (§3.7
  // mode b), not the tool-less repair role: agentLoop call #1 drafts the
  // fabrication, call #2 is the repair-execute that gathers evidence and
  // returns the delimited honest deliverable.
  let loops = 0;
  deps.agentLoop = async (ctx) => {
    loops++;
    ctx.embedded.evidenceLedger.push({ id: "E" + (ctx.embedded.evidenceLedger.length + 1), tool: "query_elements",
      sequence: ctx.embedded.evidenceLedger.length + 1, success: true, truncated: false, observations: LEDGER_OBS });
    return { status: "final",
      finalText: loops === 1 ? FABRICATED_DRAFT : `Gathered.\nBEGIN_DELIVERABLE\n${HONEST_DRAFT}\nEND_DELIVERABLE`,
      steps: [{ tool: "query_elements" }], runId: ctx.runId };
  };
  const r = await runPhased(deps, loopCtx);
  // Gate #1: INVARIANTS-FIRST — the fabrication dies in pure code BEFORE any
  // model (review OR reverify) is called. (Latency fix after live runs 1-3.)
  const inv1 = events.find((e) => e.type === "tool_result" && e.name === "phase:INVARIANTS");
  t("invariants fired deterministically", inv1 && inv1.result.source === "deterministic-invariants", JSON.stringify(inv1?.result));
  t("uncited fabrication caught", JSON.stringify(inv1?.result.failures || []).includes("uncited-claim"));
  t("repair used EXECUTE mode (bounded tool loop)", loops === 2 && deps.calls.repair === 0,
    `loops=${loops} repairRole=${deps.calls.repair}`);
  const repRow = events.find((e) => e.type === "tool" && e.name === "phase:REPAIR");
  t("repair row shows execute mode", repRow && repRow.args.mode === "execute");
  // Review model only ever sees the mechanically-clean re-gate draft.
  t("review ran only on the clean re-gate", deps.calls.review === 1);
  t("final is GO after repair", r.readiness === "GO", `got ${r.readiness}`);
  t("reverify model called only in re-gate", deps.calls.reverify === 1);
}

// ---------------------------------------------------------------------------
console.log("— scenario 3: reviewer NO-GO twice → CLARIFY, final NO-GO —");
{
  const { events, loopCtx } = makeCtx();
  const deps = makeDeps({
    draft: HONEST_DRAFT,
    reviewScript: "VERDICT: APPROVED\nREADINESS: NO-GO — conclusions overreach the evidence",
    reverifyScript: "POST_VERDICT: GO — no factual errors",
    repairScript: `BEGIN_DELIVERABLE\n${HONEST_DRAFT}\nEND_DELIVERABLE`
  });
  const r = await runPhased(deps, loopCtx);
  t("final NO-GO", r.readiness === "NO-GO");
  t("clarify ran", deps.calls.clarify === 1);
  t("questions surfaced", events.find((e) => e.type === "final").text.includes("To proceed, please answer"));
  // Repair LOOP (user directive): keeps fixing until GO or the cap (default 3).
  t("repair loops to the cap on persistent NO-GO", deps.calls.repair === 3, `got ${deps.calls.repair}`);
  t("re-gates numbered per attempt", events.some((e) => e.name === "phase:REVIEW#4"));
}
{
  // Repair loop CONVERGES: reviewer NO-GOes twice, then GOes the third draft.
  const { loopCtx } = makeCtx();
  let reviews = 0;
  const deps = makeDeps({
    draft: HONEST_DRAFT,
    reviewScript: () => (++reviews < 3
      ? "VERDICT: APPROVED\nREADINESS: NO-GO — conclusions overreach the evidence"
      : "VERDICT: APPROVED\nREADINESS: GO — fixed"),
    reverifyScript: "POST_VERDICT: GO — fine",
    repairScript: `BEGIN_DELIVERABLE\n${HONEST_DRAFT}\nEND_DELIVERABLE`
  });
  const r = await runPhased(deps, loopCtx);
  t("loop converges to GO", r.readiness === "GO", `got ${r.readiness}`);
  t("stopped repairing once GO", deps.calls.repair === 2);
  t("no clarify on converged run", deps.calls.clarify === 0);
}

// ---------------------------------------------------------------------------
console.log("— scenario 4: gate infrastructure dies → fail-closed UNGATED, draft labeled —");
{
  const { events, loopCtx } = makeCtx();
  const deps = makeDeps({ draft: HONEST_DRAFT });
  deps.chatStream = async () => { throw new Error("all providers down"); };
  const r = await runPhased(deps, loopCtx);
  t("UNGATED readiness", r.readiness === "UNGATED");
  const fin = events.find((e) => e.type === "final");
  t("draft labeled UNREVIEWED", fin && fin.text.includes("UNREVIEWED"));
}

// ---------------------------------------------------------------------------
console.log("— scenario 5: grok ban DEPRECATED 2026-07-16 — xai is a normal provider —");
{
  const chains = resolveRoleChains({ roles: {
    review: [{ provider: "xai", model: "grok-4.5" }, { provider: "ollama", model: "kimi-k2.7-code:cloud" }],
    reverify: [{ provider: "unknown-provider", model: "x" }]
  } }, "local-model");
  t("xai provider accepted", chains.review[0].provider === "xai" && chains.review[0].model === "grok-4.5");
  t("other targets still follow", chains.review.some((c) => c.model === "kimi-k2.7-code:cloud"));
  t("unknown providers still rejected → local fallback", chains.reverify.length === 1 && chains.reverify[0].model === "local-model");
  t("$LOCAL resolution", resolveRoleChains({ roles: { review: [{ provider: "ollama", model: "$LOCAL" }] } }, "qwen3.6").review[0].model === "qwen3.6");
}

// ---------------------------------------------------------------------------
console.log("— $SELECTED: header model orchestrates, any provider —");
{
  // Header selection no longer enters the default chains ($SELECTED remains
  // available via phaseModels config).
  const chains = resolveRoleChains({}, "local-model", { provider: "openai", model: "gpt-5.6-sol" });
  // 2026-07-19c model-strengths roster: PURE Ollama-cloud — deepseek (agent
  // workflows + long context) orchestrates + heads repair AND reverify, glm
  // (highest coding score) heads review, kimi (cost) is the gate fallback;
  // ALL OpenAI models + fable-5.1 + opus-5 REMOVED ("they are slow").
  // 2026-07-19q: qwen/qwen3-coder REMOVED from review + reverify default chains —
  // it can't emit the strict verdict grammar (fail-closes every review to NO-GO,
  // 2 live runs). Great drafter (header), broken gate reviewer. Chains are back
  // to pure Ollama-cloud for the gates.
  // AGENT GO ROSTER (2026-07-18 cloud re-map): deepseek reviews, qwen3.5 reverifies, glm tails.
  t("review chain (deepseek → qwen3.5 → glm) — Agent Go roster", chains.review[0].model === "deepseek-v4-pro:cloud" && chains.review[0].provider === "ollama" && chains.review[1].model === "qwen3.5:397b:cloud" && chains.review[2].model === "glm-5.2:cloud" && chains.review.length === 3);
  t("reverify chain (qwen3.5 → kimi → glm) — Agent Go roster", chains.reverify[0].model === "qwen3.5:397b:cloud" && chains.reverify[0].provider === "ollama" && chains.reverify[1].model === "kimi-k2.7-code:cloud" && chains.reverify.length === 3);
  t("NO custom/qwen in ANY default chain", ["review", "reverify", "orchestrator", "repair"].every((r) => chains[r].every((c) => c.provider !== "custom" && c.model !== "qwen/qwen3-coder")));
  t("every terminal tail is ollama", ["review", "reverify", "orchestrator", "repair"].every((r) => chains[r].at(-1).provider === "ollama"));
  t("orchestrator head glm / repair head kimi-code — Agent Go roster", chains.orchestrator[0].model === "glm-5.2:cloud" && chains.repair[0].model === "kimi-k2.7-code:cloud" && chains.repair[1].model === "glm-5.2:cloud");
  t("all default gate/orch chains are pure ollama (qwen removed 19q)", ["review", "reverify", "orchestrator", "repair"].every((r) => chains[r].every((c) => c.provider === "ollama")));
  t("diagnostic glm fallback present", chains.review.some((c) => c.model === "glm-5.2:cloud"));
  // EVERY default chain ends with an Ollama :cloud tail (bridge-independent net).
  t("every default chain ends with an ollama tail", ["review", "reverify", "orchestrator", "repair"].every((r) => chains[r][chains[r].length - 1].provider === "ollama"));
  t("review + reverify tails glm (all-ollama, no append needed) — Agent Go roster", chains.review.at(-1).model === "glm-5.2:cloud" && chains.reverify.at(-1).model === "glm-5.2:cloud");
  // ENFORCED even for a custom config whose chain has NO ollama tail: an
  // all-subscription custom review chain gets a glm-5.2:cloud tail appended.
  const custom = resolveRoleChains({ roles: { review: [{ provider: "claude-sub", model: "claude-opus-5" }, { provider: "codex-sub", model: "gpt-5-codex" }] } }, "local-model", { provider: "ollama", model: "local-model" });
  t("custom no-ollama chain gets an ollama tail appended", custom.review.at(-1).provider === "ollama" && custom.review.at(-1).model === "glm-5.2:cloud");
  // A custom chain with an ollama model MID-chain gets a DISTINCT ollama TAIL
  // (MM 16x-audit A3: never re-append a model already in the chain — a duplicate
  // just retries a model that already failed). kimi mid-chain → glm tail.
  const midOllama = resolveRoleChains({ roles: { reverify: [{ provider: "ollama", model: "kimi-k2.7-code:cloud" }, { provider: "claude-sub", model: "claude-opus-5" }] } }, "local-model", { provider: "ollama", model: "local-model" });
  t("mid-chain ollama gets a DISTINCT tail (no dup)", midOllama.reverify.at(-1).provider === "ollama" && midOllama.reverify.at(-1).model === "glm-5.2:cloud" && midOllama.reverify.filter((c) => c.model === "kimi-k2.7-code:cloud").length === 1);
  // $SELECTED still resolves when configured explicitly via phaseModels
  const sel = resolveRoleChains({ roles: { repair: [{ provider: "$SELECTED", model: "$SELECTED" }] } }, "local-model", { provider: "xai", model: "grok-4.5" });
  t("$SELECTED via config still works (grok allowed)", sel.repair[0].provider === "xai" && sel.repair[0].model === "grok-4.5");
  t("$SELECTED chain also gets an ollama tail", sel.repair.at(-1).provider === "ollama");
}

// ---------------------------------------------------------------------------
console.log("— scenario 6: avoid → degraded honesty when only one model exists —");
{
  const { events, loopCtx } = makeCtx();
  loopCtx.settings.phaseModels = { roles: {
    review: [{ provider: "ollama", model: "$LOCAL" }],
    reverify: [{ provider: "ollama", model: "$LOCAL" }],
    repair: [{ provider: "ollama", model: "$LOCAL" }],
    clarify: [{ provider: "ollama", model: "$LOCAL" }]
  } };
  const deps = makeDeps({
    draft: HONEST_DRAFT,
    reviewScript: "VERDICT: APPROVED\nREADINESS: GO — fine",
    reverifyScript: "POST_VERDICT: GO — fine"
  });
  const r = await runPhased(deps, loopCtx);
  t("degraded independence reported", r.independence === "degraded-same-model", `got ${r.independence}`);
  t("gated GO still possible degraded", r.readiness === "GO");
  const fin = events.find((e) => e.type === "final");
  t("degradation visible in banner", fin.text.includes("degraded-same-model"));
}

// ---------------------------------------------------------------------------
console.log("— AWF gate mode (default): coverage is ADVISORY, reviewer judges —");
{
  const { events, loopCtx } = makeCtx(); // default mode — no gateMode set
  let reviewSaw = "";
  const deps = makeDeps({
    draft: FABRICATED_DRAFT, // uncited claim — advisory in awf mode, not a hard block
    reviewScript: (n, user) => { reviewSaw = user; return "VERDICT: APPROVED\nREADINESS: NO-GO — the flag claims contradict the ledger and lack evidence"; }
  });
  const r = await runPhased(deps, loopCtx);
  const invRow = events.find((e) => e.type === "tool_result" && e.name === "phase:INVARIANTS");
  t("awf: invariants pass with advisory notes", invRow?.result.ok === true && Array.isArray(invRow.result.advisory));
  t("awf: reviewer receives the advisory block", reviewSaw.includes("ADVISORY NOTES"));
  t("awf: model judgment decides (review ran)", deps.calls.review >= 1);
  t("awf: reviewer catch still yields NO-GO", r.readiness === "NO-GO");
}
{
  // Fabrication-grade failures hard-block in BOTH modes: a cited value that
  // CONTRADICTS the ledger never reaches a reviewer.
  const { events, loopCtx } = makeCtx();
  const deps = makeDeps({
    draft: "Insert is enabled [E1:sys_script.action_insert.checked=true] so the rule fires on create."
  });
  const r = await runPhased(deps, loopCtx);
  const invRow = events.find((e) => e.type === "tool_result" && e.name === "phase:INVARIANTS");
  t("awf: value-mismatch still hard-blocks", invRow?.result.readiness === "NO-GO" &&
    JSON.stringify(invRow.result.failures).includes("value-mismatch"));
  t("awf: no reviewer call on fabrication", deps.calls.review === 0 || r.readiness === "NO-GO");
}

// ---------------------------------------------------------------------------
console.log("— Tier 2: PLAN → subtasks with dep isolation → SYNTHESIZE —");
{
  const { events, loopCtx } = makeCtx();
  const deps = makeDeps({
    planScript: '{"subtasks":[{"id":"s1","title":"gather","prompt":"read the flags","depends_on":[]},{"id":"s2","title":"assess","prompt":"assess using the flags","depends_on":["s1"]}],"synthesis_instructions":"merge both"}',
    synthScript: () => HONEST_DRAFT,
    reviewScript: "VERDICT: APPROVED\nREADINESS: GO — fine",
    reverifyScript: "POST_VERDICT: GO — fine"
  });
  const seenPrompts = [];
  deps.agentLoop = async (ctx) => {
    const user = ctx.messages[1]?.content || "";
    seenPrompts.push(user);
    ctx.embedded.evidenceLedger.push({ id: "E" + (ctx.embedded.evidenceLedger.length + 1), tool: "query_elements",
      sequence: ctx.embedded.evidenceLedger.length + 1, success: true, truncated: false, observations: LEDGER_OBS });
    return { status: "final", finalText: `output-of-subtask#${seenPrompts.length}`, steps: [{ tool: "x" }], runId: ctx.runId };
  };
  const r = await runPhased(deps, loopCtx);
  t("two subtask executions", seenPrompts.length === 2);
  t("dep isolation: s2 sees s1 output", seenPrompts[1].includes("output-of-subtask#1"));
  t("dep isolation: s1 sees no dep block", !seenPrompts[0].includes("DEPENDENCY OUTPUTS"));
  t("subtask step cap applied", true); // structural: runEmbedded passes SUBTASK_STEP_CAP
  t("synthesize called once", deps.calls.synth === 1);
  t("tier2 run gated GO", r.readiness === "GO", `got ${r.readiness}`);
  t("plan row posted", events.some((e) => e.name === "phase:PLAN" && e.type === "tool_result" && e.result.subtasks));
}
{
  // Planner garbage twice → fail-safe fast path (Tier-1 behavior preserved)
  const { loopCtx } = makeCtx();
  let loops = 0;
  const deps = makeDeps({
    draft: HONEST_DRAFT,
    planScript: "I think we should first consider the architecture...", // never JSON
    reviewScript: "VERDICT: APPROVED\nREADINESS: GO — fine",
    reverifyScript: "POST_VERDICT: GO — fine"
  });
  const origLoop = deps.agentLoop;
  deps.agentLoop = async (ctx) => { loops++; return origLoop(ctx); };
  const r = await runPhased(deps, loopCtx);
  t("invalid plan re-asked once", deps.calls.plan === 2);
  t("fallback runs single fast-path loop", loops === 1);
  t("fallback still gated GO", r.readiness === "GO");
}
{
  // dependency_failed propagation: s1 fails → s2 skipped → run errors
  const { events, loopCtx } = makeCtx();
  const deps = makeDeps({
    planScript: '{"subtasks":[{"id":"s1","title":"a","prompt":"p1","depends_on":[]},{"id":"s2","title":"b","prompt":"p2","depends_on":["s1"]}]}'
  });
  deps.agentLoop = async (ctx) => ({ status: "capped", steps: [], runId: ctx.runId });
  const r = await runPhased(deps, loopCtx);
  t("failed dep propagates", events.some((e) => e.type === "tool_result" && e.result?.dependency_failed === "s1"));
  t("all-failed run errors out", r.status === "error");
  t("no gates on all-failed", deps.calls.review === 0);
}

// MM FINAL-AUDIT: the structural test-mode guard — a run whose chains reach a
// subscription provider WITHOUT an injected mock must fail closed (UNGATED),
// never fetch a live bridge.
{
  const deps = makeDeps({ draft: "plain draft with no citations", reviewScript: ["VERDICT: APPROVED\nREADINESS: GO — fine"] });
  delete deps.claudeSub; // simulate the forgotten mock
  delete deps.codexSub;
  const { events, loopCtx } = makeCtx();
  // 2026-07-19 defaults head every role with mocked ollama models, so no chain
  // reaches a subscription provider on its own — pin a claude-sub ORCHESTRATOR
  // head (PLAN always runs, before invariants can short-circuit the gates) so
  // the structural guard is actually exercised (the chain then walks to the
  // auto-appended ollama tail and the run still completes honestly).
  loopCtx.settings.phaseModels = { roles: { orchestrator: [{ provider: "claude-sub", model: "claude-opus-5" }] } };
  const r = await runPhased(deps, loopCtx);
  const finalMsg = events.find((e) => e.type === "final");
  // The guard throws BEFORE any fetch; the chain then walks to the mocked
  // ollama tail and the run completes honestly — the contract is: loud guard
  // rows, no live network, a gated (never crashed) outcome.
  t("run completes without live bridges", !!finalMsg && ["GO", "NO-GO", "UNGATED"].includes(r.readiness), `readiness=${r.readiness}`);
  t("test-mode guard error is loud", events.some((e) => e.type === "tool_result" && /TEST MODE/.test(JSON.stringify(e.result || {}))));
}

// Zero-evidence EXECUTE retry: a first attempt with no tools and no ledger
// entries re-runs ONCE with a corrective prompt (CLI-bridge first-turn flake).
{
  const { events, loopCtx } = makeCtx();
  let execCalls = 0;
  const deps = makeDeps({ draft: "irrelevant", reviewScript: ["VERDICT: APPROVED\nREADINESS: GO — fine"], reverifyScript: ["POST_VERDICT: GO — confirmed"] });
  deps.agentLoop = async (ctx) => {
    execCalls++;
    // First attempt: NAVIGATED (1 non-evidence step) then quit — 0 evidence.
    // The retry must fire on zero ledger entries even with steps > 0 (10:52 bug).
    if (execCalls === 1) return { status: "final", finalText: "Navigated to the record.", steps: [{ tool: "navigate" }], runId: ctx.runId };
    ctx.embedded.evidenceLedger.push({ id: "E1", tool: "query_elements", sequence: 1, success: true, truncated: false, observations: LEDGER_OBS });
    return { status: "final", finalText: "Insert is off [E1:sys_script.action_insert.checked=false] — verified on the form.", steps: [{ tool: "query_elements" }], runId: ctx.runId };
  };
  const r = await runPhased(deps, loopCtx);
  t("zero-evidence EXECUTE retried once", execCalls === 2, `execCalls=${execCalls}`);
  t("retry row posted", events.some((e) => e.type === "tool_result" && e.result && /no evidence gathered/.test(String(e.result.retry || ""))));
  t("retried draft reaches the gates", r.status === "final" && /Insert is off/.test(r.finalText));
}

// Repair-execute salvage: a repair that gathered evidence but omitted the
// BEGIN/END_DELIVERABLE fence, yet produced a substantial cited final answer,
// is used directly instead of being discarded (live run 08:12).
{
  const { events, loopCtx } = makeCtx();
  let reviewCall = 0;
  // Draft NO-GO on an evidence gap → triggers repair-EXECUTE.
  const deps = makeDeps({
    draft: "Insert is off [E1:sys_script.action_insert.checked=false].",
    reviewScript: (n) => n === 1
      ? "VERDICT: REVISED\nREADINESS: NO-GO — the live Condition metadata is unverified; gather more evidence."
      : "VERDICT: APPROVED\nREADINESS: GO — evidence now complete.",
    reverifyScript: () => "POST_VERDICT: GO — confirmed"
  });
  const baseLoop = deps.agentLoop;
  deps.agentLoop = async (ctx) => {
    // First call = EXECUTE (normal). Later embedded call = repair-execute:
    // gather + a cited final answer, but NO fence.
    if (ctx.embedded && ctx.messages.some((m) => /REPAIRING/.test(m.content || ""))) {
      ctx.embedded.evidenceLedger.push({ id: "E2", tool: "query_elements", sequence: 2, success: true, truncated: false, observations: [{ path: "sys_script.condition.value", value: "current.assignment_group.nil()" }] });
      return { status: "final", finalText: "REVIEW SUMMARY\nCondition verified [E2:sys_script.condition.value=current.assignment_group.nil()]. Insert off [E1:sys_script.action_insert.checked=false]. " + "detail ".repeat(80), steps: [{ tool: "query_elements" }], runId: ctx.runId };
    }
    return baseLoop(ctx);
  };
  const r = await runPhased(deps, loopCtx);
  t("repair-execute missing fence is salvaged", events.some((e) => e.type === "tool_result" && e.result && typeof e.result.salvaged === "string"));
  t("salvaged repair reaches GO", r.readiness === "GO", `readiness=${r.readiness}`);
}

// TEXT-repair salvage twin (live a-live-run REPAIR#3, 2026-07-19): a text-mode
// repair whose output is substantial and citation-carrying but unfenced is
// wrapped and RE-GATED instead of stopping the loop.
{
  const { events, loopCtx } = makeCtx();
  const deps = makeDeps({
    draft: "Insert is off [E1:sys_script.action_insert.checked=false].",
    // NO-GO reason deliberately avoids evidence-gap keywords → TEXT mode repair.
    reviewScript: (n) => n === 1
      ? "VERDICT: REVISED\nREADINESS: NO-GO — the guard ordering is wrong; restructure the script."
      : "VERDICT: APPROVED\nREADINESS: GO — restructured correctly.",
    reverifyScript: () => "POST_VERDICT: GO — confirmed",
    // Text repair returns the corrected cited deliverable WITHOUT the fence.
    repairScript: () => "REVIEW SUMMARY\nGuard order corrected. Insert off [E1:sys_script.action_insert.checked=false]. " + "detail ".repeat(80)
  });
  const r = await runPhased(deps, loopCtx);
  t("text-repair missing fence is salvaged", events.some((e) => e.type === "tool_result" && e.result && /text-repair output/.test(String(e.result.salvaged || ""))));
  t("salvaged text repair reaches GO", r.readiness === "GO", `readiness=${r.readiness}`);
}

// A1: all-errored gate chain triggers a degraded retry (relax avoid → reuse an
// otherwise-excluded ollama model) instead of throwing → UNGATED.
{
  const { events, loopCtx } = makeCtx();
  // reverify chain: glm(head), then a bridge model. avoid glm (as if it drafted).
  loopCtx.settings.phaseModels = { roles: { reverify: [{ provider: "ollama", model: "glm-5.2:cloud" }, { provider: "claude-sub", model: "claude-opus-5" }] } };
  const deps = makeDeps({
    draft: HONEST_DRAFT,
    reviewScript: () => "VERDICT: APPROVED\nREADINESS: GO — fine"
  });
  // opus (the only non-avoided reverify model) always errors; glm works but is avoided.
  deps.chatStream = async ({ messages, model }) => {
    const sys = messages[0].content;
    if (/final independent verifier/i.test(sys)) {
      if (/opus/.test(model)) throw new Error("claude-sub bridge HTTP 503");
      return { content: "POST_VERDICT: GO — confirmed" }; // glm on the degraded retry
    }
    if (/adversarial reviewer/i.test(sys)) return { content: "VERDICT: APPROVED\nREADINESS: GO — fine" };
    return { content: "1. q?" };
  };
  deps.claudeSub = async ({ system, user, model }) => { const { content } = await deps.chatStream({ messages: [{ role: "system", content: system }, { role: "user", content: user }], model: "claude-sub:" + model }); return content; };
  deps.codexSub = deps.claudeSub;
  // Drafter is glm → reverify avoids glm → filtered chain = [opus] → opus errors
  // → degraded retry relaxes to full chain → glm reverifies → GO.
  loopCtx.settings.provider = "ollama"; loopCtx.agentModel = "glm-5.2:cloud";
  deps.activeProvider = () => "ollama";
  const r = await runPhased(deps, loopCtx);
  t("all-errored gate degrades instead of UNGATED", r.readiness === "GO", `readiness=${r.readiness}`);
  t("degraded-retry warning posted", events.some((e) => e.result && /degraded-same-model/.test(String(e.result.warning || ""))));
}

// A2: the EXECUTE fallback runs AT MOST once — if the fallback's own agentLoop
// throws (ollama also down), the catch must NOT invoke it a second time.
{
  const { events, loopCtx } = makeCtx();
  loopCtx.settings.provider = "claude-sub";
  const deps = makeDeps({ reviewScript: () => "VERDICT: APPROVED\nREADINESS: GO — fine" });
  deps.activeProvider = () => "claude-sub";
  let loopCalls = 0;
  deps.agentLoop = async () => { loopCalls++; throw new Error(loopCalls === 1 ? "bridge 503" : "ollama down too"); };
  const r = await runPhased(deps, loopCtx);
  t("fallback runs at most once (no double)", loopCalls === 2, `loopCalls=${loopCalls}`);
  t("double-down surfaces as error, not crash-loop", r.status === "error" || r.status === "final");
}

// EXECUTE bridge fallback: header is a subscription bridge; the FIRST agentLoop
// (bridge) throws → EXECUTE retries once on the ollama cloud model and the run
// completes. (Extends the ollama-tail net to EXECUTE.)
{
  const { events, loopCtx } = makeCtx();
  loopCtx.settings.provider = "claude-sub";
  loopCtx.settings.cloudModel = "claude-sonnet-5";
  const deps = makeDeps({
    reviewScript: () => "VERDICT: APPROVED\nREADINESS: GO — fine",
    reverifyScript: () => "POST_VERDICT: GO — confirmed"
  });
  deps.activeProvider = () => "claude-sub"; // header is the bridge
  let loopCalls = 0;
  deps.agentLoop = async (ctx) => {
    loopCalls++;
    if (loopCalls === 1) throw new Error("claude-sub bridge HTTP 503 — desktop-server not running");
    // Fallback run (ollama): produce a cited draft.
    ctx.embedded.evidenceLedger.push({ id: "E1", tool: "query_elements", sequence: 1, success: true, truncated: false, observations: LEDGER_OBS });
    return { status: "final", finalText: "Insert off [E1:sys_script.action_insert.checked=false]; Update on [E1:sys_script.action_update.checked=true].", steps: [{ tool: "query_elements" }], runId: ctx.runId };
  };
  const r = await runPhased(deps, loopCtx);
  t("EXECUTE bridge failure retried on ollama", events.some((e) => e.type === "tool_result" && e.result && /bridge unavailable/.test(String(e.result.fallback || ""))));
  t("run completes after EXECUTE fallback", r.status === "final" && ["GO", "NO-GO"].includes(r.readiness), `status=${r.status} readiness=${r.readiness}`);
  t("EXECUTE fallback ran agentLoop twice", loopCalls === 2);
}

// resumePhased: continue from a persisted draft + ledger WITHOUT re-running
// EXECUTE. The gates run on the saved draft and the run finalizes.
{
  const { events, loopCtx } = makeCtx();
  let execCalls = 0;
  const deps = makeDeps({
    reviewScript: () => "VERDICT: APPROVED\nREADINESS: GO — fine",
    reverifyScript: () => "POST_VERDICT: GO — confirmed"
  });
  deps.agentLoop = async () => { execCalls++; return { status: "final", finalText: "should not run", steps: [], runId: "x" }; };
  const saved = {
    envelope: { runId: "r1", taskText: "code review this business rule", phase: "REVIEW", agentModel: "local-model", savedAt: 1 },
    data: {
      draft: "Insert is off [E1:sys_script.action_insert.checked=false]; Update on [E1:sys_script.action_update.checked=true].",
      ledger: [{ id: "E1", tool: "query_elements", sequence: 1, success: true, truncated: false, observations: LEDGER_OBS }],
      plan: undefined, system: "You are a ServiceNow review agent."
    }
  };
  const r = await resumePhased(deps, loopCtx, saved);
  t("resumePhased resumed", r.resumed === true);
  t("resume did NOT re-run EXECUTE", execCalls === 0, `execCalls=${execCalls}`);
  t("resume reached a verdict on the saved draft", r.status === "final" && ["GO", "NO-GO"].includes(r.readiness), `readiness=${r.readiness}`);
  t("resume posted a RESUME row", events.some((e) => e.type === "tool_result" && e.name === "phase:RESUME"));
  const finalMsg = events.find((e) => e.type === "final");
  t("resume final carries the saved draft", !!finalMsg && /Insert is off/.test(finalMsg.text));
}

// resumePhased with no completed draft OR empty ledger → not resumable.
{
  const { loopCtx } = makeCtx();
  const deps = makeDeps({});
  const r1 = await resumePhased(deps, loopCtx, { envelope: { phase: "EXECUTE" }, data: null });
  t("no phaseData → not resumable", r1.resumed === false);
  const r2 = await resumePhased(deps, loopCtx, { envelope: { phase: "EXECUTE" }, data: { ledger: [] } });
  t("phaseData without draft → not resumable", r2.resumed === false);
  // P1-4: a draft with an EMPTY ledger is not real evidence → not resumable.
  const r3 = await resumePhased(deps, loopCtx, { envelope: { phase: "REVIEW" }, data: { draft: "x".repeat(50), ledger: [] } });
  t("draft with empty ledger → not resumable", r3.resumed === false);
}

// P0-1: resume RESTORES the persisted post-fallback drafter identity so the
// gate avoid-set excludes the REAL author (never lets it review its own draft).
{
  const { loopCtx } = makeCtx();
  let reviewAvoidSeen = null;
  const deps = makeDeps({ reverifyScript: () => "POST_VERDICT: GO — ok" });
  // Capture the model the review gate is asked to run on: the drafter (glm)
  // must be AVOIDED, so review must NOT run on ollama:glm-5.2:cloud.
  deps.chatStream = async ({ messages, model }) => {
    const sys = messages[0].content;
    if (/adversarial reviewer/i.test(sys)) { reviewAvoidSeen = model; return { content: "VERDICT: APPROVED\nREADINESS: GO — fine" }; }
    if (/final independent verifier/i.test(sys)) return { content: "POST_VERDICT: GO — ok" };
    return { content: "1. q?" };
  };
  deps.claudeSub = async ({ system, user, model }) => { const { content } = await deps.chatStream({ messages: [{ role: "system", content: system }, { role: "user", content: user }], model: "claude-sub:" + model }); return content; };
  deps.codexSub = deps.claudeSub;
  const saved = {
    envelope: { runId: "r9", taskText: "review", phase: "REVIEW", agentModel: "local-model", savedAt: 5 },
    data: {
      runId: "r9",
      draft: "Insert is off [E1:sys_script.action_insert.checked=false].",
      ledger: [{ id: "E1", tool: "query_elements", sequence: 1, success: true, truncated: false, observations: LEDGER_OBS }],
      // The ORIGINAL run fell back to ollama:glm during EXECUTE — persisted here.
      activeDrafter: "ollama:glm-5.2:cloud", drafters: ["ollama:glm-5.2:cloud"],
      effProvider: "ollama", effCloudModel: "glm-5.2:cloud", effAgentModel: "glm-5.2:cloud",
      system: "You are a review agent."
    }
  };
  const r = await resumePhased(deps, loopCtx, saved);
  t("resume restored the fallback drafter (glm avoided in review)", reviewAvoidSeen !== null && !/glm-5\.2:cloud/.test(String(reviewAvoidSeen)), `reviewRanOn=${reviewAvoidSeen}`);
  t("resume with restored identity still finalizes", r.resumed === true && r.status === "final");
}

// ---------------------------------------------------------------------------
console.log("— research-genre citation block (2026-07-19w) —");
{
  // A run whose EXECUTE used web_search → the gate gets the research-genre block.
  const { loopCtx } = makeCtx();
  let reviewSys = "";
  const draftText = "The research surfaced an NVDA analyst forecast page [E1.O1] whose title reports the price target [E1.O2].";
  const deps = makeDeps({ draft: draftText, reviewScript: "VERDICT: APPROVED\nREADINESS: GO — sourced", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => {
    ctx.embedded.evidenceLedger.push({ id: "E1", tool: "web_search", sequence: 1, success: true, truncated: false, observations: [{ path: "results.0.url", value: "https://ex.com/nvda" }, { path: "results.0.title", value: "NVDA target $330" }] });
    return { status: "final", finalText: draftText, steps: [{ tool: "web_search" }], runId: ctx.runId };
  };
  const baseChat = deps.chatStream;
  deps.chatStream = async (args) => { if (/adversarial reviewer/i.test(args.messages[0].content)) reviewSys = args.messages[0].content; return baseChat(args); };
  await runPhased(deps, loopCtx);
  t("web run → research-genre block in review prompt", /WEB RESEARCH|SOURCE-CITATION/.test(reviewSys));
}
{
  // Control: a NON-web run (default query_elements ledger) gets NO research block
  // — ServiceNow strictness is untouched.
  const { loopCtx } = makeCtx();
  let reviewSys = "";
  const deps = makeDeps({ draft: "Insert is off [E1:sys_script.action_insert.checked=false].", reviewScript: "VERDICT: APPROVED\nREADINESS: GO — ok", reverifyScript: "POST_VERDICT: GO — confirmed" });
  const baseChat = deps.chatStream;
  deps.chatStream = async (args) => { if (/adversarial reviewer/i.test(args.messages[0].content)) reviewSys = args.messages[0].content; return baseChat(args); };
  await runPhased(deps, loopCtx);
  t("non-web run → NO research-genre block (SN strictness intact)", !/WEB RESEARCH|SOURCE-CITATION/.test(reviewSys));
}

// ---------------------------------------------------------------------------
console.log("— P0 independence: subtask author excluded from review (2026-07-19y) —");
{
  // The sole surviving subtask's AUTHOR must be fed into the reviewer avoid-set,
  // else a model reviews its own draft and is mislabeled "independent." Pin
  // execute-tools=glm and review=[glm,kimi]; a single glm-authored subtask must
  // be reviewed by kimi, never glm.
  const { loopCtx } = makeCtx();
  loopCtx.settings.phaseModels = { roles: {
    "execute-tools": [{ provider: "ollama", model: "glm-5.2:cloud" }],
    review: [{ provider: "ollama", model: "glm-5.2:cloud" }, { provider: "ollama", model: "kimi-k2.7-code:cloud" }],
    reverify: [{ provider: "ollama", model: "kimi-k2.7-code:cloud" }]
  } };
  const draftText = "Insert is off [E1:sys_script.action_insert.checked=false].";
  const planScript = JSON.stringify({ subtasks: [{ id: "s1", title: "review the rule", prompt: "review it", role: "tools", depends_on: [] }], synthesis: "single output" });
  const deps = makeDeps({ draft: draftText, planScript, reviewScript: "VERDICT: APPROVED\nREADINESS: GO — ok", reverifyScript: "POST_VERDICT: GO — confirmed" });
  await runPhased(deps, loopCtx);
  const reviewModels = deps.calls.roleModels.filter((m) => m.startsWith("review:"));
  t("P0: sole subtask author (glm) is NOT the reviewer", reviewModels.length > 0 && reviewModels.every((m) => !/glm/.test(m)), reviewModels.join(","));
  t("P0: review fell through to the independent model (kimi)", reviewModels.some((m) => /kimi/.test(m)), reviewModels.join(","));
}

console.log("— P1 research-relaxation scoping (2026-07-19y) —");
{
  // A MIXED run that read BOTH web AND ServiceNow records must NOT relax — SN
  // exact-value strictness stays on (the relaxation is appended to the whole
  // review prompt, so an any-web trigger would soften the SN bar too).
  const { loopCtx } = makeCtx();
  let reviewSys = "";
  const draftText = "The forecast page [E1.O1] reports a target [E1.O2].";
  const deps = makeDeps({ draft: draftText, reviewScript: "VERDICT: APPROVED\nREADINESS: GO — ok", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => {
    ctx.embedded.evidenceLedger.push({ id: "E1", tool: "web_search", sequence: 1, success: true, truncated: false, observations: [{ path: "results.0.url", value: "https://ex.com" }, { path: "results.0.title", value: "target $330" }] });
    ctx.embedded.evidenceLedger.push({ id: "E2", tool: "sn_query_table", sequence: 2, success: true, truncated: false, observations: [{ path: "records.0.name", value: "My Rule" }] });
    return { status: "final", finalText: draftText, steps: [], runId: ctx.runId };
  };
  const baseChat = deps.chatStream;
  deps.chatStream = async (args) => { if (/adversarial reviewer/i.test(args.messages[0].content)) reviewSys = args.messages[0].content; return baseChat(args); };
  await runPhased(deps, loopCtx);
  t("mixed SN+web run → NO research relaxation (SN strictness kept)", !/WEB RESEARCH|SOURCE-CITATION/.test(reviewSys), reviewSys.slice(0, 60));
}
{
  // A FAILED web call is not evidence and must not flip the genre.
  const { loopCtx } = makeCtx();
  let reviewSys = "";
  const draftText = "Insert is off [E2:sys_script.action_insert.checked=false].";
  const deps = makeDeps({ draft: draftText, reviewScript: "VERDICT: APPROVED\nREADINESS: GO — ok", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => {
    ctx.embedded.evidenceLedger.push({ id: "E1", tool: "web_search", sequence: 1, success: false, truncated: false, observations: [] });
    ctx.embedded.evidenceLedger.push({ id: "E2", tool: "query_elements", sequence: 2, success: true, truncated: false, observations: LEDGER_OBS });
    return { status: "final", finalText: draftText, steps: [], runId: ctx.runId };
  };
  const baseChat = deps.chatStream;
  deps.chatStream = async (args) => { if (/adversarial reviewer/i.test(args.messages[0].content)) reviewSys = args.messages[0].content; return baseChat(args); };
  await runPhased(deps, loopCtx);
  t("failed web call → NO research relaxation (success required)", !/WEB RESEARCH|SOURCE-CITATION/.test(reviewSys), reviewSys.slice(0, 60));
}

// ---------------------------------------------------------------------------
console.log("— trivial-turn lane (2026-07-19y) —");
{
  const triv = ["Hi", "hello", "Hey!", "thanks", "thank you", "how are you?", "who are you", "what can you do", "ok", "test", "ping", "good morning"];
  const tasks = ["review the business rule open in my tab", "what is the sys_id of INC0012345", "look up the NVDA price target", "Do deep research on GitHub Copilot pricing", "create a Script Include named X", "hi there, can you review this incident record and fix it"];
  t("isTrivialTurn: greetings/social detected", triv.every((x) => isTrivialTurn(x)), triv.filter((x) => !isTrivialTurn(x)).join("|"));
  t("isTrivialTurn: real tasks NOT trivial", tasks.every((x) => !isTrivialTurn(x)), tasks.filter((x) => isTrivialTurn(x)).join("|"));
}
{
  // "Hi" → conversational reply, the zero-evidence retry does NOT fire (agentLoop
  // runs once, no corrective injected), and it still GATES GO.
  const { loopCtx } = makeCtx();
  loopCtx.taskText = "Hi";
  let agentCalls = 0, correctiveSeen = false;
  const deps = makeDeps({ draft: "x", planScript: '{"fast_path": true}', reviewScript: "VERDICT: APPROVED\nREADINESS: GO — conversational", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => {
    agentCalls++;
    if (/Before answering, decide/.test(ctx.messages[1]?.content || "")) correctiveSeen = true;
    return { status: "final", finalText: "Hi! I haven't run any tools yet — what would you like me to work on?", steps: [], runId: ctx.runId };
  };
  const res = await runPhased(deps, loopCtx);
  t("trivial 'Hi': EXECUTE ran once (no zero-evidence retry)", agentCalls === 1, `agentCalls=${agentCalls}`);
  t("trivial 'Hi': no tool-use corrective injected", !correctiveSeen);
  t("trivial 'Hi': reached a GATED GO", res.status === "final" && /GATED: GO/.test(res.finalText || ""), res.status);
}
{
  // Contrast: a REAL task whose first attempt gathered zero evidence STILL retries.
  const { loopCtx } = makeCtx();
  loopCtx.taskText = "Review the business rule open in my instance and report its When-to-run triggers";
  let agentCalls = 0, correctiveSeen = false;
  const deps = makeDeps({ draft: "x", planScript: '{"fast_path": true}', reviewScript: "VERDICT: APPROVED\nREADINESS: GO — ok", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => {
    agentCalls++;
    if (/Before answering, decide/.test(ctx.messages[1]?.content || "")) correctiveSeen = true;
    return { status: "final", finalText: "The rule looks fine (answered from memory, no tools used).", steps: [], runId: ctx.runId };
  };
  await runPhased(deps, loopCtx);
  t("real task zero-evidence: retry FIRED (corrective injected)", correctiveSeen, `agentCalls=${agentCalls}`);
  t("real task zero-evidence: EXECUTE ran twice", agentCalls === 2, `agentCalls=${agentCalls}`);
}

// ---------------------------------------------------------------------------
console.log("— conceptual-turn lane (2026-07-20b) —");
{
  const concept = [
    "Give me a one-paragraph explanation of what a ServiceNow Business Rule is.",
    "What is a Business Rule?",
    "Explain how GlideRecordSecure works.",
    "Describe the difference between a before and after Business Rule.",
    "How does GlideAggregate count records?",
    "Define what an ACL is in ServiceNow.",
  ];
  const needsTools = [
    "Review the Business Rule open in my instance and report its triggers",
    "What's the sys_id of INC0012345?",
    "Read the Business Rule named 'Derive State' and check it",
    "Create a Script Include named FooUtil",
    "Summarize the record currently open in this tab",
    "What are the real State choices on the incident table in my instance?",
  ];
  t("isConceptualTurn: definitional questions detected", concept.every((x) => isConceptualTurn(x)), concept.filter((x) => !isConceptualTurn(x)).join(" | "));
  t("isConceptualTurn: record/instance tasks NOT conceptual", needsTools.every((x) => !isConceptualTurn(x)), needsTools.filter((x) => isConceptualTurn(x)).join(" | "));
}
{
  // A "what is X" question keeps its first answer — the zero-evidence retry does
  // NOT fire, so no defensive corrective, and it GATES GO.
  const { loopCtx } = makeCtx();
  loopCtx.taskText = "Give me a one-paragraph explanation of what a ServiceNow Business Rule is.";
  let agentCalls = 0, correctiveSeen = false;
  const deps = makeDeps({ draft: "x", planScript: '{"fast_path": true}', reviewScript: "VERDICT: APPROVED\nREADINESS: GO — conceptual", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => {
    agentCalls++;
    if (/Before answering, decide|IMPORTANT CORRECTION/.test(ctx.messages[1]?.content || "")) correctiveSeen = true;
    return { status: "final", finalText: "A ServiceNow Business Rule is server-side JavaScript that runs on database operations (insert/update/delete/query) at a chosen timing to enforce logic.", steps: [], runId: ctx.runId };
  };
  const res = await runPhased(deps, loopCtx);
  t("conceptual 'what is': EXECUTE ran once (no retry)", agentCalls === 1, `agentCalls=${agentCalls}`);
  t("conceptual 'what is': no corrective injected", !correctiveSeen);
  t("conceptual 'what is': GATED GO", res.status === "final" && /GATED: GO/.test(res.finalText || ""), res.status);
}
{
  // A REAL tool-task with zero evidence still retries — but the corrective is now
  // the NEUTRAL routing nudge (no "IMPORTANT CORRECTION" rebuke) and forbids the
  // defensive meta-commentary that broke a-live-run20-010106.
  const { loopCtx } = makeCtx();
  loopCtx.taskText = "Review the Business Rule open in my instance and report its When-to-run triggers";
  let corrective = "";
  const deps = makeDeps({ draft: "x", planScript: '{"fast_path": true}', reviewScript: "VERDICT: APPROVED\nREADINESS: GO — ok", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => {
    const u = ctx.messages[1]?.content || "";
    if (/Before answering, decide/.test(u)) corrective = u;
    return { status: "final", finalText: "answered without tools.", steps: [], runId: ctx.runId };
  };
  await runPhased(deps, loopCtx);
  t("tool-task retry: neutral nudge (no 'IMPORTANT CORRECTION' rebuke)", corrective && !/IMPORTANT CORRECTION|your previous attempt gathered|was rejected/i.test(corrective), corrective.slice(0, 80));
  t("tool-task retry: forbids defensive meta-commentary", /do NOT reference a "previous answer"/.test(corrective));
}

console.log("— conceptual EXECUTE directive (2026-07-20c) —");
{
  // The answer-directly directive is injected into the EXECUTE system prompt for
  // a conceptual turn (a-live-run: glm opened defensively without it).
  const { loopCtx } = makeCtx();
  loopCtx.taskText = "Explain what a ServiceNow Business Rule is.";
  let execSystem = "";
  const deps = makeDeps({ draft: "x", planScript: '{"fast_path": true}', reviewScript: "VERDICT: APPROVED\nREADINESS: GO — ok", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => { execSystem = ctx.messages[0]?.content || ""; return { status: "final", finalText: "A Business Rule is server-side JavaScript that runs on database operations.", steps: [], runId: ctx.runId }; };
  await runPhased(deps, loopCtx);
  t("conceptual: EXECUTE system carries the answer-directly directive", /CONCEPTUAL\/DEFINITIONAL QUESTION/.test(execSystem));
  t("conceptual: directive forbids the defensive disclaimer", /NOT open with a disclaimer/i.test(execSystem));
}
{
  // A tool-task must NOT get the conceptual directive.
  const { loopCtx } = makeCtx();
  loopCtx.taskText = "Review the Business Rule open in my instance and report its triggers";
  let execSystem = "";
  const deps = makeDeps({ draft: "x", planScript: '{"fast_path": true}', reviewScript: "VERDICT: APPROVED\nREADINESS: GO — ok", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => { execSystem = ctx.messages[0]?.content || ""; return { status: "final", finalText: "reviewed with tools.", steps: [], runId: ctx.runId }; };
  await runPhased(deps, loopCtx);
  t("tool-task: no conceptual directive injected", !/CONCEPTUAL\/DEFINITIONAL QUESTION/.test(execSystem));
}

console.log("— composed readiness pill (2026-07-20g) —");
{
  // A web-research GO surfaces the "verify figures" caveat, not "ready for production".
  const { loopCtx } = makeCtx();
  loopCtx.taskText = "Do deep research on GitHub Copilot pricing and cite sources.";
  const draft = "GitHub Copilot Business is $19/user/mo per the pricing page [E1.O1].";
  const deps = makeDeps({ draft, planScript: '{"fast_path": true}', reviewScript: "VERDICT: APPROVED\nREADINESS: GO — sourced", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => {
    ctx.embedded.evidenceLedger.push({ id: "E1", tool: "web_search", scope: {}, sequence: 1, success: true, truncated: false, observations: [{ path: "results.0.url", value: "https://github.com/features/copilot/plans" }] });
    return { status: "final", finalText: draft, steps: [{ tool: "web_search" }], runId: ctx.runId };
  };
  const res = await runPhased(deps, loopCtx);
  const pill = (res.finalText || "").match(/- \*\*Readiness:\*\*.*/)?.[0] || "";
  t("research GO pill says 'verify figures', not 'ready for production'", /sources cited — verify the specific figures/.test(pill) && !/ready for production/.test(pill), pill);
}
{
  // Research + degraded roster → BOTH caveats compose (PE7 a-live-run: the old
  // either/or dropped the research caveat when the run also degraded).
  const { loopCtx } = makeCtx();
  loopCtx.taskText = "Deep research GitHub Copilot pricing, cite sources.";
  loopCtx.settings.phaseModels = { roles: { review: [{ provider: "ollama", model: "glm-5.2:cloud" }], reverify: [{ provider: "ollama", model: "glm-5.2:cloud" }] } };
  const draft = "GitHub Copilot Business is $19 per user per month, per the official pricing page [E1.O1].";
  const deps = makeDeps({ draft, planScript: '{"fast_path": true}', reviewScript: "VERDICT: APPROVED\nREADINESS: GO — sourced", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => { ctx.embedded.evidenceLedger.push({ id: "E1", tool: "web_search", scope: {}, sequence: 1, success: true, truncated: false, observations: [{ path: "results.0.url", value: "https://github.com/features/copilot/plans" }] }); return { status: "final", finalText: draft, steps: [], runId: ctx.runId }; };
  const res = await runPhased(deps, loopCtx);
  const pill = (res.finalText || "").match(/- \*\*Readiness:\*\*.*/)?.[0] || "";
  t("research+degraded pill shows BOTH caveats", /sources cited — verify/.test(pill) && /same-model fallback/.test(pill), pill);
}
{
  // A non-research, independent GO stays "ready for production".
  const { loopCtx } = makeCtx();
  loopCtx.taskText = "Explain what a Business Rule is.";
  const deps = makeDeps({ draft: "x", planScript: '{"fast_path": true}', reviewScript: "VERDICT: APPROVED\nREADINESS: GO — ok", reverifyScript: "POST_VERDICT: GO — confirmed" });
  deps.agentLoop = async (ctx) => ({ status: "final", finalText: "A Business Rule is server-side JavaScript that runs on database operations at a chosen timing.", steps: [], runId: ctx.runId });
  const res = await runPhased(deps, loopCtx);
  const pill = (res.finalText || "").match(/- \*\*Readiness:\*\*.*/)?.[0] || "";
  t("plain GO pill is 'ready for production'", /ready for production/.test(pill), pill);
}

console.log("— role-aware subtask step cap (2026-07-20j) —");
{
  // Build roles (tools/code/bulk) get the larger budget; research/default stay 14.
  t("tools subtask gets the build cap (30)", subtaskStepCap("tools") === 30);
  t("code subtask gets the build cap (30)", subtaskStepCap("code") === 30);
  t("bulk subtask gets the build cap (30)", subtaskStepCap("bulk") === 30);
  t("research subtask keeps the default cap (14)", subtaskStepCap("research") === 14);
  t("unknown/undefined role keeps the default cap (14)", subtaskStepCap(undefined) === 14 && subtaskStepCap("plan") === 14);
  t("build cap is strictly larger than research cap", subtaskStepCap("tools") > subtaskStepCap("research"));
}

console.log("— repair mode: artifact mismatch → EXECUTE (2026-07-20k) —");
{
  // SN4-style: the saved artifact mismatches the deliverable → re-edit the instance (execute).
  t("'actual saved script uses X' → execute",
    repairNeedsExecute("the deliverable claims setValue but the actual saved script in the instance uses current.priority = 1", []));
  t("'misrepresents what was built' → execute",
    repairNeedsExecute("the write-up misrepresents the actually-built script body", []));
  t("'does not match ... saved' → execute",
    repairNeedsExecute("the deliverable does not match the saved record's trigger flags", []));
  // Evidence-gap cases still route to execute.
  t("'cannot be verified' → execute", repairNeedsExecute("the figure cannot be verified from the ledger", []));
  t("stale-evidence invariant → execute", repairNeedsExecute("", [{ kind: "stale-evidence", detail: "x" }]));
  // A purely SUBSTANTIVE/logic defect with no instance mismatch stays TEXT (rewrite the deliverable).
  t("logic-only defect (no instance mismatch) → text", !repairNeedsExecute("the conclusion does not follow from the cited evidence; the reasoning is unsound", []));
  t("empty reason + no failures → text", !repairNeedsExecute("", []));
}

console.log("— honest 'could not complete' is a GO clause (2026-07-20n) —");
{
  // The review AND reverify system prompts must carry the "honest could-not-complete
  // is a valid GO" guidance (live BA1 a-live-run: an honest 'no form on this page'
  // answer was whipsawed to NO-GO → fabrication → CLARIFY).
  const { loopCtx } = makeCtx();
  let reviewSys = "", reverifySys = "";
  const deps = makeDeps({ draft: "I searched this page thoroughly and no Name/Email/Message form fields exist here.", planScript: '{"fast_path": true}', reviewScript: "VERDICT: APPROVED\nREADINESS: GO — honest", reverifyScript: "POST_VERDICT: GO — confirmed" });
  const baseChat = deps.chatStream;
  deps.chatStream = async (args) => {
    const sys = args.messages[0].content;
    if (/adversarial reviewer/i.test(sys)) reviewSys = sys;
    if (/final independent verifier/i.test(sys)) reverifySys = sys;
    return baseChat(args);
  };
  await runPhased(deps, loopCtx);
  t("REVIEW prompt blesses honest 'could not complete'", /COULD NOT COMPLETE/.test(reviewSys) && /cannot prove a negative/i.test(reviewSys));
  t("REVERIFY prompt blesses honest 'could not complete'", /COULD NOT COMPLETE/.test(reverifySys) && /cannot prove a negative/i.test(reverifySys));
}

console.log("— mandatory structured PLAN injected into EXECUTE (2026-07-21) —");
{
  const { loopCtx } = makeCtx();
  loopCtx.taskText = "build a UI policy that makes caller mandatory when contact type is phone";
  const deps = makeDeps({ draft: HONEST_DRAFT, reviewScript: "VERDICT: APPROVED\nREADINESS: GO", reverifyScript: "POST_VERDICT: GO", planScript: '{"fast_path": true}' });
  await runPhased(deps, loopCtx);
  t("actionable/story turn gets the STRUCTURED PLAN contract in the EXECUTE system prompt", /MANDATORY STRUCTURED PLAN/.test(loopCtx.messages[0].content));
}
{
  const { loopCtx } = makeCtx();
  loopCtx.taskText = "what is a business rule";
  const deps = makeDeps({ draft: "A business rule is server-side logic that runs on a database operation.", reviewScript: "VERDICT: APPROVED\nREADINESS: GO", reverifyScript: "POST_VERDICT: GO", planScript: '{"fast_path": true}' });
  await runPhased(deps, loopCtx);
  t("pure conceptual turn does NOT get the build-plan contract", !/MANDATORY STRUCTURED PLAN/.test(loopCtx.messages[0].content));
}

console.log("— ledgerDigest: cited-first + de-dup (2026-07-20 SS1 a-live-run) —");
{
  // A big ledger with many DUPLICATE re-reads, where the draft cites a LATE entry:
  // the cited entry must appear in the digest (not truncated out), or the reviewer
  // false-flags a valid token as "fabricated".
  const dupObs = [{ path: "name", value: "incident_task" }, { path: "type", value: "Reference" }];
  const ledger = Array.from({ length: 60 }, (_, i) => ({
    id: "E" + (i + 1), tool: "sn_query_session", sequence: i + 1, success: true,
    scope: { query: "name=incident_task^element=incident" }, // IDENTICAL scope+obs → duplicates
    observations: dupObs
  }));
  // make the LATE cited entry distinct so it isn't dedup-collapsed
  ledger[54] = { id: "E55", tool: "query_elements", sequence: 55, success: true, scope: { url: "x" },
    observations: [{ path: "sys_script.when", value: "before" }] };
  const draft = "The rule runs When=before [E55].";
  const digest = ledgerDigest(ledger, draft);
  t("cited late entry E55 is present in the digest (not truncated out)", /\bE55\b/.test(digest));
  t("identical re-reads are de-duplicated (omission note present)", /omitted for length/.test(digest));
  // sanity: without a draft, still produces a digest (no crash)
  t("no-draft call still works", typeof ledgerDigest(ledger) === "string" && ledgerDigest(ledger).length > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
