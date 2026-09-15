// Author: iDevOpsLLC
// Extension-side UAT: the SSE parser that connects the ported agent loop to the LLM Go
// backend. Verifies frames split across chunks and multiple frames per chunk both parse,
// and that event/JSON-data are surfaced correctly (the contract background.js relies on).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSSE } from '../providers.js';

function fakeRes(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    body: {
      getReader() {
        return {
          read() {
            return i < chunks.length
              ? Promise.resolve({ value: enc.encode(chunks[i++]), done: false })
              : Promise.resolve({ value: undefined, done: true });
          },
          cancel() { return Promise.resolve(); }
        };
      }
    }
  };
}

test('providers.readSSE: parses event/data frames, JSON payloads, split + multi-frame chunks', async () => {
  const events = [];
  const res = fakeRes([
    'event: delta\ndata: {"delta":"He',                    // frame split mid-JSON across chunks
    'llo"}\n\n',
    'event: delta\ndata: {"delta":" world"}\n\nevent: result\ndata: {"content":"Hello world","toolCalls":[]}\n\n', // two frames, one chunk
    'event: billed\ndata: {"charged":true,"amount":0.3}\n\n',
    'event: done\ndata: {}\n\n'
  ]);
  await readSSE(res, null, (ev, data) => events.push([ev, data]));

  const kinds = events.map((e) => e[0]);
  assert.deepEqual(kinds, ['delta', 'delta', 'result', 'billed', 'done']);
  assert.equal(events[0][1].delta, 'Hello');            // reassembled across the chunk boundary
  assert.equal(events[1][1].delta, ' world');
  assert.equal(events[2][1].content, 'Hello world');
  assert.equal(events[3][1].charged, true);
  assert.equal(events[3][1].amount, 0.3);
});

test('providers.readSSE: aborts cleanly when signal already aborted', async () => {
  const events = [];
  const res = fakeRes(['event: delta\ndata: {"delta":"x"}\n\n']);
  await readSSE(res, { aborted: true }, (ev, data) => events.push([ev, data]));
  assert.equal(events.length, 0); // aborted before reading anything
});
