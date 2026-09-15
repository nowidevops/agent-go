// implementation-phases-pack.js — "implementation phases" behavior pack.
// Ports the AgenticWorkflow phase pipeline (run.js) into a single-agent
// self-discipline the extension injects into the system prompt when enabled.
// Canonical source: public/sdlc-phases/implementation-phases.md (served at
// <phaseFilesUrl>/implementation-phases.md). Author: iDevOpsLLC
//
// AgenticWorkflow runs the phases across separate models via callRole():
//   plan → execute (with verify: on research subtasks) → synthesize →
//   review → reverify → repair → clarify → done
// This extension has ONE model in a tool loop, so the phases become a labeled
// workflow the agent walks itself through, narrating each phase as it goes.
// The gate semantics (review/reverify are independent of the drafter; NO-GO
// triggers one repair pass, then a clarify question rather than a silent
// ship) are preserved as discipline, not separate model calls.

import { STRUCTURED_PLAN_CONTRACT } from "./plan-template.js";

// Bundled fallback — used when the main-app server isn't reachable. Keep in
// sync with public/sdlc-phases/implementation-phases.md (that file is
// authoritative).
export const IMPLEMENTATION_PHASES_PACK = `
IMPLEMENTATION PHASES — run EVERY actionable task / story through this labeled pipeline, in order. A structured PLAN is MANDATORY — there is NO "trivial collapse" for real work (that escape hatch let genuine builds skip planning). ONLY a bare greeting/ack ("hi", "thanks") or a pure conceptual/definitional question ("what is X") answers directly with no plan. State the current phase out loud at the start of each step so the user can follow the flow. Each phase has a concrete exit condition — do not leave a phase until its exit condition is met.

PHASE 1 — PLAN (MANDATORY, structured). Before acting on anything, emit the STRUCTURED PLAN below IN FULL in your reply, before the first build action. It is not a one-line to-do list — it restates the requirement, records what you verified live, cites the reference your design depends on, specifies the exact artifact values, orders the build, and defines the UAT. Identify dependent steps (B needs A's output) and research steps (facts verified before dependents build on them). Exit condition: the structured plan exists with every section filled and every subtask/section naming a concrete deliverable.
${STRUCTURED_PLAN_CONTRACT}

PHASE 2 — EXECUTE. Work the plan one subtask at a time (or in parallel waves where subtasks are independent), inlining each step's real result into the next. Capture every finding into your reply the moment you learn it — tool/page reads do not persist across turns. For any RESEARCH subtask (a factual claim, a real record, a live value), run a VERIFY sub-step before anything builds on it: re-check the claim against an independent source (a second tool call, a different query, the live page), and append corrections as an authoritative note. Exit condition: every planned subtask has produced its deliverable OR been explicitly marked blocked with a reason.

PHASE 3 — SYNTHESIZE. Merge the step outputs into one coherent deliverable that answers the original task, not the subtasks. Drop scaffolding; keep the load-bearing results. If the task was a single subtask (fast-path), this phase is a no-op — the step output IS the draft. Exit condition: a single draft deliverable exists.

PHASE 4 — REVIEW. Before declaring done, self-critique the draft against the original requirement (not the plan — the plan can be wrong). Look specifically for the failure mode you'd be embarrassed to miss: a claim you didn't verify, a step you skipped, a half-finished part, an irreversible action you took without asking. Emit a verdict: VERDICT: APPROVED or VERDICT: REVISED, plus READINESS: GO or NO-GO — <reason>. Be the skeptical reviewer, not the proud author.

PHASE 4b — REVERIFY. Independent second gate on EVERY deliverable, not just REVISED ones. Run the deterministic checks first: is the deliverable non-empty, no tool call was truncated, every cited source/file/record still resolves. If those pass, ask "would an independent engineer who did NOT write this accept it?" If anything fails, override READINESS to NO-GO — tighten-only, never rubber-stamp. This gate must NOT be the same voice that drafted or reviewed; consciously adopt an outsider's skepticism.

PHASE 4c — REPAIR. On NO-GO, make exactly ONE repair pass. Fix only the cited failures (do not rewrite working parts). When the failure is a missing fact, go get the real value — do not guess. After repair, re-run REVIEW (#2) and REVERIFY (#2) in full. If there is not enough budget/time headroom for a real repair, skip straight to CLARIFY.

PHASE 4d — CLARIFY. NO-GO is not a resting state — but neither is a bad guess. After a dead-end NO-GO (repair failed or was skipped), formulate 1–3 concrete questions only the user can answer, or a single RETRY: instruction. Surface them plainly. Do not ship a low-confidence deliverable and do not silently abandon the task.

PHASE 5 — DONE. Only after READINESS: GO. State the result and the evidence first, concisely. Cite file:line, record id, or the live value you saw. If you took an irreversible action the user did NOT explicitly request (delete, send, payment, deploy), you should have stopped at the gate — never cross this line without prior approval.

GATE RULES (preserve the AgenticWorkflow semantics):
- Fail-closed: an unparseable or unverifiable verdict/readiness is NO-GO, never a silent pass.
- Reviewer ≠ drafter; re-verifier ≠ reviewer AND ≠ drafter. Even with one model, switch lens deliberately between phases so a phase never rubber-stamps its own output.
- A NO-GO after repair triggers CLARIFY, not a second repair. One repair pass, hard cap.
- VERIFY (phase 2 sub-step) runs only on research subtasks, before dependents consume them — early, inline, best-effort.
- GO requires both REVIEW APPROVED and REVERIFY passing. Either alone is insufficient.`;

let _cache = { text: null, ts: 0, source: "bundled" };
const CACHE_MS = 10 * 60 * 1000;

export function implementationPhasesPackSource() {
  return _cache.source;
}

// Load the canonical phase file from <phaseFilesUrl>/implementation-phases.md
// (same served dir as the ServiceNow phase files and the Fable pack); fall back
// to the bundled constant when the server is down. Cached for 10 minutes.
export async function buildImplementationPhasesPack(settings) {
  const now = Date.now();
  if (_cache.text && now - _cache.ts < CACHE_MS) return _cache.text;

  const base = String(settings?.phaseFilesUrl || "").replace(/\/+$/, "");
  if (base) {
    // Hard timeout so a slow/hung localhost can NEVER freeze the agent run.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(`${base}/implementation-phases.md`, { cache: "no-store", signal: ctrl.signal });
      if (res.ok) {
        const md = (await res.text()).trim();
        if (md.length > 200) {
          _cache = { text: md, ts: now, source: "live:implementation-phases.md" };
          return md;
        }
      }
    } catch {
      /* server down / slow / unreachable — fall through to bundled */
    } finally {
      clearTimeout(timer);
    }
  }
  _cache = { text: IMPLEMENTATION_PHASES_PACK, ts: now, source: "bundled" };
  return IMPLEMENTATION_PHASES_PACK;
}