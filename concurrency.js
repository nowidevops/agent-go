// concurrency.js — small, dependency-free async concurrency primitives used by
// the C.6 sub-agent orchestrator. Kept separate from background.js (which pulls
// in chrome.* and Ollama) so the scheduling logic can be unit-tested in plain Node.
// Author: iDevOpsLLC

// Ordered, bounded-concurrency pool: keeps at most `limit` `fn` calls in flight
// and returns results indexed to the INPUT order (results[i] always corresponds
// to items[i], regardless of completion order). Workers pull the next index off a
// shared cursor until the list is drained. `fn(item, index)` may be async.
export async function runPooled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// Keyed serialization gate. `map` is a caller-owned Map<key, tailPromise>. Calling
// acquire chains behind any prior holder of the same key and resolves to a
// `release` function; callers MUST call it (in a finally) to let the next waiter
// on that key proceed. Different keys never block each other. This is how the
// orchestrator enforces "≤1 sub-agent driving a given tab at a time": same tabId →
// serialized, distinct tabIds → concurrent. A prior holder rejecting does NOT wedge
// the queue (we swallow it here) — the chain advances on settle, not success.
export async function acquireKeyedSlot(map, key) {
  const prev = map.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  map.set(key, prev.then(() => mine));
  try { await prev; } catch { /* prior holder failing must not block this waiter */ }
  return release;
}
