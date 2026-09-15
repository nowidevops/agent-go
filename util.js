// util.js — shared helpers for the service-worker-context modules:
//   * logErr   — surface an otherwise-silent failure to the dev console
//   * isTransient — classify an error as worth retrying (5xx / template / network)
//   * withRetry — retry a flaky async call with abortable exponential backoff
// Imported by background.js, vision.js, learning.js (all ES modules). NOT usable
// from content.js, which is a classic content script with no imports.
// Author: iDevOpsLLC

// One consistent, greppable prefix so these are easy to find in the dev console.
const PREFIX = "[local-claude]";

// Log a caught error that we would otherwise swallow. Keeps the same non-fatal
// behaviour (the caller still falls back), but leaves a breadcrumb so a partial
// failure is diagnosable instead of invisible.
export function logErr(context, e) {
  const msg = e && e.message ? e.message : String(e);
  try { console.warn(`${PREFIX} ${context}:`, msg); } catch {}
}

// Should this error be retried? YES for transient infrastructure hiccups:
//   - Ollama HTTP 5xx (overloaded / template re-roll)
//   - the qwen template-parser malform ("expected element type <function>...")
//   - a raw network failure reaching Ollama (crash / OOM / not-yet-up)
// NO for user-aborts (Stop) and for deterministic 4xx-style problems
// (model-not-found, context-too-large) — retrying those just wastes time.
export function isTransient(e) {
  if (!e) return false;
  if (e.name === "AbortError") return false;
  const m = String(e.message || "");
  if (/HTTP\s*4\d\d/.test(m)) return false;                 // 4xx — caller's fault, won't self-heal
  if (/not found|no such model|try pulling|unknown model/i.test(m)) return false;
  return (
    /HTTP\s*5\d\d/.test(m) ||                                // server error
    /expected element type/i.test(m) ||                      // qwen template malform
    /Couldn't reach Ollama|Failed to fetch|NetworkError|ECONN|load failed/i.test(m)
  );
}

// Sleep that resolves early (rejects) if the abort signal fires, so a retry
// backoff never delays a user's Stop.
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

// Run `fn` and retry it on transient failures with exponential backoff + jitter.
// Re-throws immediately on a non-transient error or once `tries` is exhausted, so
// the caller's existing error handling still runs on the final failure.
//   opts.tries   — total attempts (default 3)
//   opts.baseMs  — first backoff (default 400ms); doubles each retry
//   opts.signal  — AbortSignal; aborts both the call and the backoff
//   opts.onRetry — (attemptNumber, error) => void, e.g. to post a UI "retrying" note
//   opts.label   — context string for the console breadcrumb
export async function withRetry(fn, opts = {}) {
  const { tries = 3, baseMs = 400, signal, onRetry, label = "call" } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (e?.name === "AbortError" || !isTransient(e) || attempt === tries) throw e;
      logErr(`${label} transient failure (attempt ${attempt}/${tries}), retrying`, e);
      try { onRetry?.(attempt, e); } catch {}
      // 400ms, 800ms, 1600ms… plus up to 250ms jitter to avoid thundering retries.
      const backoff = baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      await abortableSleep(backoff, signal);
    }
  }
  throw lastErr; // unreachable (loop either returns or throws), kept for safety
}
