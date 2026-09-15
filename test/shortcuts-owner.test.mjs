// shortcuts-owner.test.mjs — shortcuts are private to the Agent Go account that
// created them (owner directive 2026-09-02). Pins: signed out ⇒ nothing readable
// and nothing writable; each account sees only its own list; the pre-scoping flat
// list migrates to the first signed-in account and is then gone; seeds are per
// account. Run: node test/shortcuts-owner.test.mjs   Author: iDevOpsLLC
import test from "node:test";
import assert from "node:assert/strict";

// In-memory chrome.storage.local + crypto stub.
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const ks = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of ks) if (k in store) out[k] = structuredClone(store[k]);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v); },
      async remove(k) { delete store[k]; }
    }
  }
};
if (!globalThis.crypto?.randomUUID) globalThis.crypto = { randomUUID: () => "id-" + Math.random().toString(16).slice(2) };

const { getShortcuts, saveShortcut, deleteShortcut, seedShortcuts, seedDefaultShortcuts, shortcutOwner, NOT_SIGNED_IN, SEED_SHORTCUTS } = await import("../shortcuts.js");

const signIn = (email) => { store.llmgo_auth = { idToken: "t", email, tier: "usage" }; };
const signOut = () => { delete store.llmgo_auth; };

test("signed out: no owner, empty list, save refused", async () => {
  signOut();
  assert.equal(await shortcutOwner(), null);
  assert.deepEqual(await getShortcuts(), []);
  await assert.rejects(() => saveShortcut({ name: "x", prompt: "p" }), (e) => e.message === NOT_SIGNED_IN);
  assert.equal(store.shortcutsByOwner, undefined, "nothing written while signed out");
});

test("legacy flat list migrates to the FIRST signed-in account, then disappears", async () => {
  store.shortcuts = [{ id: "L1", name: "legacy", prompt: "old prompt" }];
  signOut();
  assert.deepEqual(await getShortcuts(), [], "signed out cannot read the legacy list");
  assert.ok(Array.isArray(store.shortcuts), "legacy list untouched while signed out");
  signIn("Owner@Example.com");
  const mine = await getShortcuts();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, "L1");
  assert.equal(store.shortcuts, undefined, "legacy key removed after migration");
  assert.ok(store.shortcutsByOwner["owner@example.com"], "keyed by lower-cased email");
});

test("each account sees only its own shortcuts", async () => {
  signIn("owner@example.com");
  await saveShortcut({ name: "sn-story", prompt: "customer-dev STRY0000001 …", startFrom: "https://customer-dev.example.com" });
  const a = await getShortcuts();
  assert.equal(a.length, 2);
  signIn("someone-else@example.com");
  assert.deepEqual(await getShortcuts(), [], "the other account sees nothing");
  await saveShortcut({ name: "mine", prompt: "b's prompt" });
  assert.deepEqual((await getShortcuts()).map((s) => s.name), ["mine"]);
  signIn("owner@example.com");
  assert.deepEqual((await getShortcuts()).map((s) => s.name).sort(), ["legacy", "sn-story"], "owner's list unchanged by B");
  // delete stays inside the owner's bucket
  const id = (await getShortcuts()).find((s) => s.name === "legacy").id;
  await deleteShortcut(id);
  assert.deepEqual((await getShortcuts()).map((s) => s.name), ["sn-story"]);
  signIn("someone-else@example.com");
  assert.deepEqual((await getShortcuts()).map((s) => s.name), ["mine"]);
});

test("seeds are per account and never run signed out", async () => {
  signOut();
  assert.equal(await seedShortcuts(), 0);
  assert.equal(await seedDefaultShortcuts(), 0);
  signIn("fresh@example.com");
  const n = await seedShortcuts();
  assert.equal(n, SEED_SHORTCUTS.length);
  assert.equal(await seedShortcuts(), 0, "versioned: second call is a no-op for this account");
  assert.equal((await getShortcuts()).length, SEED_SHORTCUTS.length);
  signIn("someone-else@example.com");
  assert.equal((await getShortcuts()).filter((s) => SEED_SHORTCUTS.some((x) => x.id === s.id)).length, 0, "B has no seeds yet");
  assert.equal(await seedShortcuts(), SEED_SHORTCUTS.length, "B gets its own seeds once");
  // UAT starter pack: only the allow-listed accounts, once each
  signIn("maintainer@example.com");
  const uat = await seedDefaultShortcuts();
  assert.ok(uat > 0);
  assert.equal(await seedDefaultShortcuts(), 0);
  signIn("fresh@example.com");
  assert.equal(await seedDefaultShortcuts(), 0, "non-UAT account never gets the starter pack");
});
