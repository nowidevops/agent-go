// ui-risk.test.mjs — the display-only risk tiers must stay in step with the real tool lists.
// Reads ACTION_TOOLS / ALWAYS_CONFIRM_TOOLS from background.js and DESKTOP_ACTION_TOOL_NAMES
// from tools.js as source text (no import side effects). Run: node --test ui-risk.test.mjs
// Author: iDevOpsLLC
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { riskTier, RISK_META } from "./ui-risk.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
const tools = fs.readFileSync(path.join(dir, "tools.js"), "utf8");

function setLiterals(src, name) {
  const start = src.search(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*new Set\\(\\[`));
  assert.ok(start >= 0, `${name} not found`);
  const end = src.indexOf("]);", start);
  // Drop // comments first: they quote words like "ask" that are not tool names.
  const body = src.slice(start, end).replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

const desktop = setLiterals(tools, "DESKTOP_ACTION_TOOL_NAMES");
const action = [...setLiterals(bg, "ACTION_TOOLS"), ...(bg.includes("...DESKTOP_ACTION_TOOL_NAMES") ? desktop : [])];
const alwaysConfirm = [...setLiterals(bg, "ALWAYS_CONFIRM_TOOLS"), ...desktop];

test("every tier has a label", () => {
  for (const t of ["read", "type", "send", "delete"]) assert.ok(RISK_META[t] && RISK_META[t].label);
});

test("no action tool is shown as read-only", () => {
  assert.ok(action.length >= 30, `expected the full ACTION_TOOLS list, got ${action.length}`);
  for (const name of action) {
    // http_request is method-dependent: background.js only asks approval for non-GET/HEAD calls,
    // so a GET really is read-only; a mutating method must never display as read.
    if (name === "http_request") {
      assert.notEqual(riskTier(name, { method: "POST" }), "read", "http_request POST must not display as read");
      continue;
    }
    assert.notEqual(riskTier(name, {}), "read", `${name} must not display as "Reads only"`);
  }
});

test("always-confirm tools are shown as type, send or delete", () => {
  for (const name of alwaysConfirm) assert.ok(["type", "send", "delete"].includes(riskTier(name, {})), name);
});

test("specific tiers", () => {
  assert.equal(riskTier("read_page", {}), "read");
  assert.equal(riskTier("delete_file", {}), "delete");
  assert.equal(riskTier("run_command", {}), "delete");
  assert.equal(riskTier("sn_wf_delete_activity", {}), "delete");
  assert.equal(riskTier("send_email", {}), "send");
  assert.equal(riskTier("send_chat_message", {}), "send");
  assert.equal(riskTier("fill_input", {}), "type");
  assert.equal(riskTier("http_request", { method: "GET" }), "read");
  assert.equal(riskTier("http_request", { method: "POST" }), "send");
  assert.equal(riskTier("move_file", { overwrite: true }), "delete");
  assert.equal(riskTier("move_file", {}), "type");
  assert.equal(riskTier("desktop_screenshot", {}), "read");
  assert.equal(riskTier("", {}), "read");
});
