// providers.js — Agent Go backend SSE client.
// Replaces Local LLM's cloud.js: instead of calling model vendors directly, the extension
// sends OpenAI-shaped {model, messages, tools} to the Agent Go backend /v1/chat and reads the
// backend's normalized SSE events. The backend holds the vendor keys and meters the turn.
// Event shape (from functions/src/modules/llm-go/routes.js):
//   event: delta   data: <token/delta chunk>
//   event: result  data: { content, toolCalls, usage }
//   event: billed  data: { charged, amount, event }
//   event: billing_error data: { error, checkout }
//   event: error   data: { error }
//   event: done    data: {}
// Author: iDevOpsLLC

import { NOT_SIGNED_IN_STEPS } from "./auth.js";
// One metered turn against the backend. Returns { content, toolCalls, usage, billed }.
// onToken(delta) streams text; onUsage({usage,billed}) updates the header credit badge.
// Session-scoped task id — lets the backend apply its durable per-task turn cap. It rotates
// per service-worker session; the authoritative runaway guards are credits + rate limits.
const SESSION_TASK_ID = cryptoRandomId().replace("turn_", "task_");

// Overall per-turn watchdog. The backend BILLS-THEN-EMITS (no SSE bytes until the whole
// turn is generated), so this is a total-turn cap, not idle-between-bytes. Without it a
// hung/never-returning turn shows "Thinking…" forever — Local LLM's ollama.js has the
// equivalent stall guard (STREAM_IDLE_TIMEOUT_MS); we simply hadn't ported it.
const TURN_TIMEOUT_MS = 180000;

// Abort-aware delay for the transient-503 (cold-start) retry backoff. Resolves early if the
// caller aborts (Stop pressed / watchdog fired) so a retry sleep never outlives the request.
function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export async function llmgoChatStream({ backendUrl, token, model, messages, tools, turnId, taskId, byok, purpose, signal, onToken, onUsage }) {
  if (!backendUrl) throw new Error("Agent Go: backend URL not configured (Options → Account).");
  if (!token) { const e = new Error(NOT_SIGNED_IN_STEPS); e.code = 401; throw e; }

  // Arm the watchdog: abort the request if the whole turn hasn't returned in TURN_TIMEOUT_MS,
  // and combine it with the caller's own abort signal (user pressed Stop).
  const watchdog = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; watchdog.abort(); }, TURN_TIMEOUT_MS);
  const onExtAbort = () => watchdog.abort();
  if (signal) { if (signal.aborted) watchdog.abort(); else signal.addEventListener("abort", onExtAbort, { once: true }); }
  const reqSignal = watchdog.signal;

  try {
  // Stable ids across retries (below): a retried turn reuses the same X-Turn-Id so backend
  // dedup can never double-charge even if a retry reached billing.
  const turnHeader = turnId || cryptoRandomId();
  const taskHeader = taskId || SESSION_TASK_ID;
  // A 503 "temporarily unavailable" is the control-plane fail-closed brake. In practice it's
  // almost always the sub-second COLD-START window — a fresh backend instance blocks paid
  // inference until configService's FIRST Firestore read of config/agent-go resolves. It fires
  // in the FIRST middleware (masterKillGuard), BEFORE any auth/metering, so retrying the POST
  // can never double-charge. Retry a couple times with short backoff so a cold-start blip is
  // invisible to the user; a PERSISTENT 503 (a real master kill) still surfaces after retries.
  const MAX_503_RETRIES = 2;
  // BYOK: attach the user's own vendor key + provider so the backend runs the turn on THEIR
  // account and bills the flat $0.05 trigger fee. Sent per-request, never stored server-side.
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Turn-Id": turnHeader,
    "X-Task-Id": taskHeader
  };
  if (byok && byok.provider && byok.apiKey) {
    headers["X-Byok-Provider"] = byok.provider;
    headers["X-Byok-Key"] = byok.apiKey;
    if (byok.effort) headers["X-Byok-Effort"] = byok.effort; // reasoning effort for models that support it
    if (byok.provider === "custom" && byok.baseUrl) headers["X-Byok-Base-Url"] = byok.baseUrl; // OpenAI-compatible host (server allowlist)
  }
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${backendUrl.replace(/\/$/, "")}/v1/chat`, {
      method: "POST",
      headers,
      // `purpose` tags a call the backend prices on its own terms (e.g. "prompt_builder" = free,
      // included model, no tools); absent on normal agent turns.
      body: JSON.stringify(purpose ? { model, messages, tools, stream: true, purpose } : { model, messages, tools, stream: true }),
      signal: reqSignal
    });
    if (res.status === 503 && attempt < MAX_503_RETRIES && !reqSignal.aborted) {
      await sleepAbortable(600 * (attempt + 1), reqSignal); // 600ms, 1200ms
      continue;
    }
    break;
  }

  if (res.status === 402) { const e = new Error("Out of credits."); e.code = 402; throw e; }
  if (res.status === 401) { const e = new Error("Session expired — sign in again."); e.code = 401; throw e; }
  if (res.status === 403) { const e = new Error(`Model ${model} not permitted on your plan.`); e.code = 403; throw e; }
  if (res.status === 429) { const e = new Error("Rate/usage limit reached."); e.code = 429; throw e; }
  if (!res.ok) {
    // Surface the backend's actual error detail instead of a bare status code.
    let detail = "";
    try { const j = await res.json(); detail = (j && (j.error || j.message)) || ""; } catch (_e) { /* not JSON */ }
    throw new Error(`Agent Go backend ${res.status}${detail ? " — " + detail : ""}`);
  }
  if (!res.body) throw new Error("Agent Go backend: empty response");

  let content = "";
  let toolCalls = [];
  let usage = null;
  let billed = null;
  let billingError = null;

  await readSSE(res, reqSignal, (event, data) => {
    if (event === "delta") {
      const t = typeof data === "string" ? data : (data && (data.delta || data.text || data.content)) || "";
      if (t) { content += t; onToken && onToken(t); }
    } else if (event === "result") {
      if (data && typeof data.content === "string") content = data.content; // authoritative final content
      if (data && Array.isArray(data.toolCalls)) {
        // Reshape backend {id,name,arguments} -> Ollama-native {id, function:{name,arguments}}
        // so the VERBATIM-ported agent loop (background.js reads call.function.name/arguments)
        // dispatches correctly and replays a shape the backend can convert back to OpenAI.
        toolCalls = data.toolCalls.map((tc) => ({
          id: tc.id,
          function: { name: tc.name, arguments: tc.arguments },
          // Gemini's opaque thoughtSignature must survive the round-trip (replayed next turn).
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {})
        }));
      }
      if (data && data.usage) usage = data.usage;
    } else if (event === "billed") {
      billed = data; onUsage && onUsage({ usage, billed });
    } else if (event === "billing_error") {
      billingError = data;
    } else if (event === "error") {
      throw new Error((data && data.error) || "backend stream error");
    }
    // "done" ends the stream
  });

  if (billingError) { const e = new Error("Out of credits."); e.code = 402; e.checkout = billingError.checkout; throw e; }
  return { content, toolCalls, usage, billed };
  } catch (e) {
    // Watchdog fired (backend never returned) → RETRYABLE "stream stalled" (matched by
    // isRetryableTurnError → the loop re-rolls the turn). A user Stop rethrows the abort as-is.
    if (timedOut && !(signal && signal.aborted)) {
      throw new Error(`Agent Go stream stalled (no response for ${TURN_TIMEOUT_MS / 1000}s) — retrying.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) { try { signal.removeEventListener("abort", onExtAbort); } catch (_e) {} }
  }
}

// Vision: one non-streaming multimodal describe via /v1/vision.
export async function llmgoDescribe({ backendUrl, token, model, prompt, base64, signal }) {
  const res = await fetch(`${backendUrl.replace(/\/$/, "")}/v1/vision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Turn-Id": cryptoRandomId(), "X-Task-Id": SESSION_TASK_ID },
    body: JSON.stringify({ model, prompt, base64 }),
    signal
  });
  if (!res.ok) throw new Error(`Agent Go vision error ${res.status}`);
  const j = await res.json();
  return { content: j.content || "", vision_model: j.vision_model || model };
}

// Minimal SSE reader (mirrors Local LLM cloud.js readSSE contract): parses
// `event:`/`data:` frames separated by blank lines and invokes cb(event, parsedData).
async function readSSE(res, signal, cb) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    if (signal && signal.aborted) { try { await reader.cancel(); } catch (_e) {} return; }
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const dataLines = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (!dataLines.length) continue;
      const raw = dataLines.join("\n");
      let data = raw;
      try { data = JSON.parse(raw); } catch (_e) { /* keep raw string */ }
      cb(event, data);
    }
  }
}

function cryptoRandomId() {
  try {
    const a = new Uint8Array(16);
    (globalThis.crypto || {}).getRandomValues && globalThis.crypto.getRandomValues(a);
    return "turn_" + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch (_e) {
    // deterministic-but-unique-enough fallback (loop provides sequential turns)
    return "turn_" + Date.now().toString(36) + Math.round(performance.now()).toString(36);
  }
}

export { readSSE };
