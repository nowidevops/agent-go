// model-lock.js — a single global mutex that serializes GPU inference calls.
// Author: iDevOpsLLC
//
// C.6 Phase 2 (sub-agent concurrency): on ONE local GPU there is one resident
// model, so concurrent Ollama /api/chat calls queue inside the server or thrash
// VRAM. When children run concurrently we still want only one inference in flight
// at a time, with DOM/tab work pipelining in the gaps. Every inference entry point
// (chatStream ×3 in the loop + chat ×N for vision / distillation / teach) funnels
// through withModelLock().
//
// CRITICAL: wrap ONLY the inference call — never DOM tools, tab loads, or the
// askApproval wait. If the lock were held across an approval prompt, a child
// blocked on the user would freeze every other agent (and the parent). The lock
// is released the instant the chat/chatStream promise settles.
//
// In Phase 1 (sequential children) there is never more than one inference in
// flight, so this lock is an uncontended no-op — adding it changes nothing for
// the default single-agent path.

// LLM GO CLOUD OVERRIDE: unlike Local LLM (one resident model on one local GPU),
// Agent Go runs every inference on the cloud backend, which serves concurrent requests
// fine — so the single-GPU serialization is unnecessary AND harmful here: it forced
// sub-agents to run their inference strictly one-at-a-time even at subagentConcurrency>1,
// which is the main reason deep research felt slow vs Local LLM. Backend limits tolerate
// it (admin = no rate limit; usage tier = 60 req/min; a research run is ~25 turns), and
// per-turn metering is idempotent per X-Turn-Id, so concurrent turns are billing-safe.
// Pass-through = children's inference now pipelines up to subagentConcurrency.
export function withModelLock(fn) {
  return Promise.resolve().then(() => fn());
}
