// settings-model-default.test.mjs — Agent Go's agent model defaults to Auto (owner 2026-09-15): the
// service resolves it to kimi-k3:cloud on paid plans and glm-5.2:cloud on free. Profiles still on the
// old glm-5.2:cloud default move to Auto exactly once; a deliberate pick is kept.
// Author: iDevOpsLLC
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
const { CLOUD_MODELS } = await import("./cloud.js");
const MARKERS = { implementationPhasesDefaultV2: true, visionModelDefaultV2: true };

test("DEFAULTS: agent model is Auto with the migration marker", () => {
  assert.equal(DEFAULTS.model, "");
  assert.equal(DEFAULTS.modelAutoDefaultV1, true);
});

test("fresh install: Auto, nothing written", async () => {
  const c = fakeChrome(undefined);
  const s = await getSettings();
  assert.equal(s.model, "");
  assert.equal(c.writes.length, 0);
});

test("profile on the old glm-5.2:cloud default: moved to Auto once, stamped, other settings kept", async () => {
  const c = fakeChrome({ model: "glm-5.2:cloud", snPackEnabled: true, ...MARKERS });
  const s = await getSettings();
  assert.equal(s.model, "");
  assert.equal(c.writes.length, 1);
  assert.equal(c.current().model, "");
  assert.equal(c.current().modelAutoDefaultV1, true);
  assert.equal(c.current().snPackEnabled, true, "other settings untouched");
  await getSettings();
  assert.equal(c.writes.length, 1, "second read does not write again");
});

test("profile that picked another model: kept, no write", async () => {
  const c = fakeChrome({ model: "kimi-k2.7-code:cloud", ...MARKERS });
  const s = await getSettings();
  assert.equal(s.model, "kimi-k2.7-code:cloud");
  assert.equal(c.writes.length, 0);
});

test("re-picking glm-5.2:cloud after the migration sticks", async () => {
  const c = fakeChrome({ model: "", modelAutoDefaultV1: true, ...MARKERS });
  await saveSettings({ ...(await getSettings()), model: "glm-5.2:cloud" });
  assert.equal(c.current().model, "glm-5.2:cloud");
  assert.equal(c.current().modelAutoDefaultV1, true, "every save carries the marker");
  const s = await getSettings();
  assert.equal(s.model, "glm-5.2:cloud", "not re-migrated");
});

test("catalog lists deepseek-v4.1-flash:cloud and kimi-k3:cloud", () => {
  const ids = Object.values(CLOUD_MODELS).flat().map((m) => m.id);
  assert.ok(ids.includes("deepseek-v4.1-flash:cloud"));
  assert.ok(ids.includes("kimi-k3:cloud"));
});
