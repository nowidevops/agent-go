// auth.js — Agent Go account auth for the extension.
// "Just point to what we have": Agent Go reuses the existing project's Firebase auth (the
// same identity that gates the backend's verifyAuth + usage + Stripe billing). The user
// signs in once (side panel), and we cache a short-lived Firebase ID token.
//
// Tokens live in chrome.storage.LOCAL only (never `sync`) — same discipline as Local LLM's
// cloud creds. No provider API keys are ever stored here; the backend holds those.
// Author: iDevOpsLLC

const TOKEN_KEY = "llmgo_auth"; // { idToken, refreshToken, expiresAt, email, tier }

// The 401 text tells the user HOW to sign in, not only that they are not (owner, 2026-09-04:
// the panel showed a bare "Not signed in to Agent Go." after packs + thinking had already run).
export const NOT_SIGNED_IN_STEPS = "Not signed in to Agent Go. To sign in: (1) click ⚙ Settings at the top right of this panel; (2) in the Account card enter the email and password of your account; (3) click Sign in — the card then shows your email and plan; (4) come back to this panel and send your message again. No account yet? Click \"Create one\" under the Sign in button (opens the sign-up page), then sign in.";

export async function getAuth() {
  try {
    const { [TOKEN_KEY]: a } = await chrome.storage.local.get(TOKEN_KEY);
    return a || null;
  } catch (_e) { return null; }
}

export async function setAuth(auth) {
  await chrome.storage.local.set({ [TOKEN_KEY]: auth || null });
  return auth;
}

export async function signOut() {
  await chrome.storage.local.remove(TOKEN_KEY);
}

// Return a currently-valid ID token, refreshing via the backend if near expiry.
// Throws { code: 401 } when the user is not signed in.
export async function getAuthToken() {
  const a = await getAuth();
  if (!a || !a.idToken) { const e = new Error(NOT_SIGNED_IN_STEPS); e.code = 401; throw e; }
  const skewMs = 60 * 1000;
  if (a.expiresAt && Date.now() > (a.expiresAt - skewMs) && a.refreshToken) {
    try {
      const refreshed = await refreshIdToken(a);
      if (refreshed) return refreshed.idToken;
    } catch (_e) { /* fall through to the existing token; backend will 401 if truly expired */ }
  }
  return a.idToken;
}

// Refresh through the Agent Go backend (which proxies Firebase's secure-token endpoint so
// the Firebase web API key never lives in the extension).
async function refreshIdToken(a) {
  const s = await getBackendUrl();
  if (!s) return null;
  const res = await fetch(`${s.replace(/\/$/, "")}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: a.refreshToken })
  });
  if (!res.ok) return null;
  const j = await res.json();
  const next = {
    ...a,
    idToken: j.idToken || a.idToken,
    refreshToken: j.refreshToken || a.refreshToken,
    expiresAt: Date.now() + (Number(j.expiresIn || 3600) * 1000)
  };
  await setAuth(next);
  return next;
}

async function getBackendUrl() {
  try {
    const { settings } = await chrome.storage.sync.get("settings");
    return (settings && settings.backendUrl) || "";
  } catch (_e) { return ""; }
}
