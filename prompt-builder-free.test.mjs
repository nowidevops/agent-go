// prompt-builder-free.test.mjs — the Prompt Builder call is tagged so the backend can price
// it at zero (owner 2026-09-04): purpose:"prompt_builder" rides in the request body, and a
// normal agent turn carries no purpose at all.
import test from "node:test";
import assert from "node:assert/strict";

const bodies = [];
globalThis.chrome = globalThis.chrome || { storage: { local: { get: async () => ({}), set: async () => {} }, sync: { get: async () => ({}), set: async () => {} } } };
globalThis.fetch = async (_url, init) => {
  bodies.push(JSON.parse(init.body));
  const sse = 'event: result\ndata: {"content":"PROMPT","toolCalls":[],"usage":{}}\n\n'
            + 'event: billed\ndata: {"charged":false,"amount":0,"event":"prompt_builder_free"}\n\n'
            + 'event: done\ndata: {}\n\n';
  return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
};

const { llmgoChatStream } = await import("./providers.js");
const common = { backendUrl: "https://example.test/api/llm-go", token: "t", model: "gpt-5.6-sol", messages: [{ role: "user", content: "goal" }], tools: [] };

test("purpose:prompt_builder is sent in the body and the free billed event comes back", async () => {
  const r = await llmgoChatStream({ ...common, purpose: "prompt_builder" });
  assert.equal(r.content, "PROMPT");
  assert.equal(bodies.at(-1).purpose, "prompt_builder");
  assert.equal(r.billed.charged, false);
  assert.equal(r.billed.event, "prompt_builder_free");
});

test("a normal turn carries no purpose key", async () => {
  await llmgoChatStream({ ...common });
  assert.equal("purpose" in bodies.at(-1), false);
});
