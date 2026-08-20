// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { SerializedWorkerPostQueue } from "../src/serialized-worker-posts.js";

test("serialized worker posts retain the first failure without an unhandled rejection", async () => {
  const failure = new Error("owner API disappeared");
  const calls: string[] = [];
  const queue = new SerializedWorkerPostQueue();

  queue.enqueue(async () => {
    calls.push("first");
    throw failure;
  });
  queue.enqueue(async () => {
    calls.push("must-not-run");
  });

  await assert.rejects(queue.drain(), (error) => error === failure);
  assert.deepEqual(calls, ["first"]);
  await assert.rejects(queue.drain(), (error) => error === failure);
});

test("serialized worker posts preserve order and drain cleanly", async () => {
  const calls: string[] = [];
  const queue = new SerializedWorkerPostQueue();
  queue.enqueue(async () => {
    await Promise.resolve();
    calls.push("first");
  });
  queue.enqueue(async () => {
    calls.push("second");
  });

  await queue.drain();
  assert.deepEqual(calls, ["first", "second"]);
});
