// settings-phases-default.test.mjs — the "implementation phases" pack is ON by default
// (owner 2026-09-04) and the user can still turn it off.
//
// Three profiles matter: a fresh install (no saved settings), an old profile saved under the
// previous default (false, no marker — flipped ON exactly once), and a profile where the user
// unchecked the box after the migration (false + marker — must stay off).
import test from "node:test";
import assert from "node:assert/strict";

function fakeChrome(stored) {
  const writes = [];
  globalThis.chrome = {
    storage: {
      sync: {
        get: async () => (stored === undefined ? {} : { settings: stored }),
        set: async (obj) => { writes.push(obj); stored = obj.settings; },
      },
      local: { get: async () => ({}), set: async () => {} },
    },
  };
  return { writes, current: () => stored };
}

const { getSettings, saveSettings, DEFAULTS } = await import("./settings.js");

test("DEFAULTS: pack on, migration marker present", () => {
  assert.equal(DEFAULTS.implementationPhasesEnabled, true);
  assert.equal(DEFAULTS.implementationPhasesDefaultV2, true);
});

test("fresh install: pack is on, nothing written", async () => {
  const c = fakeChrome(undefined);
  const s = await getSettings();
  assert.equal(s.implementationPhasesEnabled, true);
  assert.equal(c.writes.length, 0);
});

test("old profile saved under the previous default: flipped on once and stamped", async () => {
  const c = fakeChrome({ implementationPhasesEnabled: false, snPackEnabled: true });
  const s = await getSettings();
  assert.equal(s.implementationPhasesEnabled, true);
  assert.equal(s.snPackEnabled, true, "other saved keys untouched");
  assert.equal(c.writes.length, 1);
  assert.equal(c.current().implementationPhasesDefaultV2, true);
  assert.equal(c.current().implementationPhasesEnabled, true);
  const again = await getSettings();
  assert.equal(c.writes.length, 1, "migration runs once");
  assert.equal(again.implementationPhasesEnabled, true);
});

test("user unchecked the box after the migration: stays off", async () => {
  const c = fakeChrome({ implementationPhasesEnabled: false, implementationPhasesDefaultV2: true });
  const s = await getSettings();
  assert.equal(s.implementationPhasesEnabled, false);
  assert.equal(c.writes.length, 0);
});

test("saveSettings keeps the marker, so an explicit uncheck survives the next read", async () => {
  const c = fakeChrome({ implementationPhasesEnabled: true, implementationPhasesDefaultV2: true });
  await saveSettings({ implementationPhasesEnabled: false });
  assert.equal(c.current().implementationPhasesDefaultV2, true);
  const s = await getSettings();
  assert.equal(s.implementationPhasesEnabled, false);
});
