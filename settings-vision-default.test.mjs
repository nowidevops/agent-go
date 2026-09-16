// settings-vision-default.test.mjs — the paired vision model defaults to glm-5.3-flash
// (owner 2026-09-05; gemma4:31b misread exact strings on dense screenshots) and existing
// profiles move over exactly once, without overriding a deliberate choice.
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

test("DEFAULTS: vision model is glm-5.3-flash with the migration marker", () => {
  assert.equal(DEFAULTS.visionModel, "glm-5.3-flash");
  assert.equal(DEFAULTS.visionModelDefaultV2, true);
});

test("fresh install: glm-5.3-flash, nothing written", async () => {
  const c = fakeChrome(undefined);
  const s = await getSettings();
  assert.equal(s.visionModel, "glm-5.3-flash");
  assert.equal(c.writes.length, 0);
});

test("old profile lacking BOTH markers: one combined write covers both migrations", async () => {
  const c = fakeChrome({ visionModel: "gemma4:31b", implementationPhasesEnabled: false });
  const s = await getSettings();
  assert.equal(s.visionModel, "glm-5.3-flash");
  assert.equal(s.implementationPhasesEnabled, true);
  assert.equal(c.writes.length, 1, "both migrations in ONE storage write");
  assert.equal(c.current().visionModelDefaultV2, true);
  assert.equal(c.current().implementationPhasesDefaultV2, true);
});

test("old profile still on gemma4:31b (no marker): moved once and stamped", async () => {
  const c = fakeChrome({ visionModel: "gemma4:31b", snPackEnabled: true, implementationPhasesDefaultV2: true });
  const s = await getSettings();
  assert.equal(s.visionModel, "glm-5.3-flash");
  assert.equal(s.visionModelDefaultV2, true);
  assert.equal(c.writes.length, 1);
  assert.equal(c.current().visionModel, "glm-5.3-flash");
  assert.equal(c.current().snPackEnabled, true, "other settings untouched");
  const again = await getSettings();
  assert.equal(again.visionModel, "glm-5.3-flash");
  assert.equal(c.writes.length, 1, "second read does not write again");
});

test("old profile with an empty vision model: resolves to the new default without a write", async () => {
  const c = fakeChrome({ visionModel: "", implementationPhasesDefaultV2: true });
  const s = await getSettings();
  assert.equal(s.visionModel, "glm-5.3-flash");
  assert.equal(c.writes.length, 0);
});

test("profile that chose a different vision model: left alone, NOT stamped (no write)", async () => {
  const c = fakeChrome({ visionModel: "minimax-m3", implementationPhasesDefaultV2: true });
  const s = await getSettings();
  assert.equal(s.visionModel, "minimax-m3");
  assert.equal(c.writes.length, 0);
});

test("mixed state: another vision model + missing phases marker → exactly one write, vision untouched, vision marker absent", async () => {
  const c = fakeChrome({ visionModel: "minimax-m3", implementationPhasesEnabled: false });
  const s = await getSettings();
  assert.equal(s.visionModel, "minimax-m3");
  assert.equal(s.implementationPhasesEnabled, true, "phases migration still applies");
  assert.equal(c.writes.length, 1);
  assert.equal(c.current().visionModel, "minimax-m3");
  assert.equal(c.current().visionModelDefaultV2, undefined, "vision marker is only stamped by the vision migration or a save");
});

test("saveSettings stamps the marker, so a deliberate gemma4 re-pick after the migration sticks", async () => {
  const c = fakeChrome({ visionModel: "glm-5.3-flash", visionModelDefaultV2: true, implementationPhasesDefaultV2: true });
  await saveSettings({ ...(await getSettings()), visionModel: "gemma4:31b" });
  assert.equal(c.current().visionModel, "gemma4:31b");
  assert.equal(c.current().visionModelDefaultV2, true, "marker persisted by the save (DEFAULTS carries it)");
  const s = await getSettings();
  assert.equal(s.visionModel, "gemma4:31b", "not re-migrated");
});

test("profile that re-picked gemma4:31b AFTER the migration (marker present): kept", async () => {
  const c = fakeChrome({ visionModel: "gemma4:31b", visionModelDefaultV2: true, implementationPhasesDefaultV2: true });
  const s = await getSettings();
  assert.equal(s.visionModel, "gemma4:31b");
  assert.equal(c.writes.length, 0);
});
