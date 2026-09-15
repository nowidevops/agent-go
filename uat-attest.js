// uat-attest.mjs — the SHARED, PURE attestation contract (browser + Node).
//
// This is the single source of truth for the read-only run attestation that
// `background.js` authors and `bridge.mjs` verifies. It has NO chrome / no fetch /
// no fs — only Web Crypto (`globalThis.crypto.subtle`, present in modern browsers
// AND Node 20+), so the SAME code runs in the extension and in the Node bridge and
// they cannot drift. An identical copy ships in the extension as `uat-attest.js`
// (keep the two byte-identical — see P2B_WIRING.md).
//
// Threat model (MM P2B blocker #1): the attestation must be authored by
// `background.js` (which holds the true `ctx.readOnly` that drives the :1399
// dispatch guard) and transmitted by background — NEVER authored by the panel page.
// The bridge re-checks every field; a panel-forged object fails.

export const SCHEMA_VERSION = 2;
export const ENFORCEMENT_PROFILE = "readonly-dispatch-v1";

/** Canonical, order-independent hash of an effective tool-name set. */
export async function allowlistHash(toolNames) {
  const canon = [...new Set((toolNames || []).map(String))].sort().join(",");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return "sha256:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the attestation. MUST be called from background.js with the EFFECTIVE run
 * context (the same `ctx.readOnly` + tool list the :1399 guard uses), not the UI toggle.
 * @param {object} p
 *   runId, claimToken, leaseVersion   run binding (from the bridge packet)
 *   readOnly                          ctx.readOnly (boolean)
 *   effectiveToolNames                names of the tools actually offered this run
 *   actionToolNames                   names in ACTION_TOOLS (the write set)
 *   extensionCommit                   pinned build id (bridge maps it to the expected hash)
 *   nonce, ts
 * @returns {Promise<object>} the attestation
 */
export async function buildAttestation(p) {
  const eff = (p.effectiveToolNames || []).map(String);
  const action = new Set((p.actionToolNames || []).map(String));
  return {
    runId: p.runId,
    claimToken: p.claimToken,
    leaseVersion: p.leaseVersion,
    actMode: p.readOnly ? "readonly" : "other",
    effectiveToolAllowlist: await allowlistHash(eff),
    actionToolsPresentInAllowlist: eff.filter((n) => action.has(n)), // MUST be [] under read-only
    enforcementProfile: ENFORCEMENT_PROFILE,
    extensionCommit: p.extensionCommit,
    schemaVersion: SCHEMA_VERSION,
    nonce: p.nonce,
    ts: p.ts,
  };
}

/**
 * The expected read-only allowlist hash the BRIDGE pins per (profile, commit).
 * The operator computes this ONCE at arm time from the extension's real read-only
 * tool set and puts the string in the bridge config's precomputed map — so
 * bridge.verifyAttestation stays synchronous.
 */
export async function expectedReadOnlyHash(readOnlyToolNames) {
  return allowlistHash(readOnlyToolNames);
}
