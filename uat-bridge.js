// uat-bridge.js — BACKGROUND-side client for the P2B nightly UAT bridge.
//
// Runs in background.js (the service worker) because ONLY background holds the true
// ctx.readOnly + effective tool list that make the attestation trustworthy, and the
// per-night bearer token must never reach the panel page. The panel merely asks
// background to pull-and-run the next card, and tells background when a run is done;
// background does all bridge I/O and authors + transmits the attestation.
//
// See P2B_WIRING.md for the exact hooks. This module is NEW and UNWIRED until those
// hooks are added and the extension is reloaded + smoke-tested by a human.
//
// Arming (human, per night): set chrome.storage.local["uatArmed"] =
//   { token: "<per-night bearer>", port: <bridge port>, build: "<pinned build id>",
//     expiresAt: <epoch ms, e.g. 07:00> }.  Disarm = remove the key (or it auto-expires).

import { buildAttestation } from "./uat-attest.js";

const A = "uatArmed";

/** Current armed permit, or null if disarmed/expired. */
export async function uatPermit(nowMs) {
  let p; try { ({ [A]: p } = await chrome.storage.local.get(A)); } catch { return null; }
  if (!p || !p.token || !p.port) return null;
  if (p.expiresAt && nowMs > p.expiresAt) { await uatDisarm("permit expired"); return null; }
  return p;
}
export async function uatDisarm(reason) {
  try { await chrome.storage.local.remove(A); } catch {}
  try { console.warn("[uat-bridge] disarmed:", reason); } catch {}
}

function base(p) { return `http://127.0.0.1:${p.port}`; }
function authHeaders(p) { return { "Authorization": `Bearer ${p.token}`, "Content-Type": "application/json" }; }

/**
 * Pull ONE packet for the open panel to run. Background-only (holds the token).
 * @returns {Promise<null|{runId,cardId,claimToken,leaseVersion,prompt,verify,actMode}>}
 */
export async function uatPullNext(nowMs) {
  const p = await uatPermit(nowMs);
  if (!p) return null;
  let res;
  try { res = await fetch(base(p) + "/next", { method: "GET", headers: authHeaders(p) }); }
  catch (e) { console.warn("[uat-bridge] /next fetch failed:", e && e.message); return null; }
  if (res.status === 204) return null;      // nothing queued
  if (res.status === 401 || res.status === 403) { await uatDisarm(`/next ${res.status}`); return null; }
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

// Compact defense-in-depth redaction (the bridge ALSO re-redacts server-side).
function redact(text) {
  let s = String(text || "");
  s = s.replace(/\b(Authorization\s*[:=]\s*)(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]+/gi, "$1$2 [REDACTED]");
  s = s.replace(/\b(Set-Cookie|Cookie)\s*[:=]\s*[^\r\n]+/gi, "$1: [REDACTED]");
  s = s.replace(/\b(X-UserToken\s*[:=]\s*)[^\s"',&]+/gi, "$1[REDACTED]");
  s = s.replace(/\b(g_ck['"\s]*[:=]\s*['"]?)[A-Za-z0-9._\-+/=]{16,}/gi, "$1[REDACTED]");
  s = s.replace(/\b(password|passwd|pwd|secret|api[_-]?key|apikey|token|access[_-]?token)(['"]?\s*[:=]\s*['"]?)[^\s"',&}]+/gi, "$1$2[REDACTED]");
  return s;
}

/**
 * Author the attestation from the REAL run context and POST the result. Background-only.
 * `runFacts` MUST come from the ctx that drove the run (NOT the UI toggle):
 *   { readOnly, effectiveToolNames, actionToolNames }
 * `outcome` is the four-state grade + evidence the run produced.
 *
 * @returns {Promise<{ok:boolean, status:number, body?:any}>}
 */
export async function uatPostResult(packet, runFacts, outcome, transcriptText, nowMs) {
  const p = await uatPermit(nowMs);
  if (!p) return { ok: false, status: 0, body: "disarmed" };

  const attestation = await buildAttestation({
    runId: packet.runId, claimToken: packet.claimToken, leaseVersion: packet.leaseVersion,
    readOnly: !!runFacts.readOnly,
    effectiveToolNames: runFacts.effectiveToolNames || [],
    actionToolNames: runFacts.actionToolNames || [],
    extensionCommit: p.build,                      // pinned build id; bridge's approvedCommits must contain it
    nonce: `${packet.runId}:${nowMs}`, ts: nowMs,
  });

  const body = {
    runId: packet.runId, cardId: packet.cardId, claimToken: packet.claimToken, leaseVersion: packet.leaseVersion,
    result: outcome.result,                         // pass | fail | skip | inconclusive
    section: outcome.section, mode: outcome.mode,
    evidence: outcome.evidence || "", reason: outcome.reason || "",
    models: outcome.models || [], toolEvents: outcome.toolEvents || [],
    failureSignature: outcome.failureSignature ?? null,
    requiresSession: !!outcome.requiresSession, prerequisite: outcome.prerequisite ?? null,
    artifactHash: outcome.artifactHash, extensionCommit: p.build,
    transcript: redact(transcriptText),             // bridge re-redacts server-side too
    attestation,
  };

  let res;
  try { res = await fetch(base(p) + "/result", { method: "POST", headers: authHeaders(p), body: JSON.stringify(body) }); }
  catch (e) { return { ok: false, status: 0, body: String(e && e.message) }; }
  if (res.status === 401 || res.status === 403) { await uatDisarm(`/result ${res.status}`); }
  if (res.status === 422) { await uatDisarm("POLICY_NOT_ATTESTED"); } // bridge rejected the attestation
  let j = null; try { j = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, body: j };
}
