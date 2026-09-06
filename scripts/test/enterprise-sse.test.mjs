// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { readSsePage } from "../lib/enterprise-sse.mjs";

test("enterprise fixture reads through a complete SSE cursor and cancels the live stream", async () => {
  let cancelled = false;
  const page = "id: 1\nevent: kernel\ndata: {}\n\nid: 2\nevent: cursor\ndata: {\"position\":2}\n\n";
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of new TextEncoder().encode(page)) controller.enqueue(Uint8Array.of(byte));
    },
    cancel() { cancelled = true; },
  });
  assert.equal(await readSsePage(new Response(stream)), page);
  assert.equal(cancelled, true);
});

test("enterprise fixture rejects an SSE stream ending without a cursor", async () => {
  await assert.rejects(readSsePage(new Response("id: 1\nevent: kernel\ndata: {}\n\n")), /cursor/);
});
