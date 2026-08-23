// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { BoundedOutboundQueue, InMemoryNotificationLog } from "../src/index.js";

test("disconnects with the last persisted cursor when the pending queue overflows", async () => {
  let releaseWrite: (() => void) | undefined;
  const writeBlocked = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const closes: unknown[] = [];
  let writeCount = 0;
  const queue = new BoundedOutboundQueue({
    maxPendingMessages: 1,
    maxPendingBytes: 1024,
    write: async () => {
      writeCount += 1;
      if (writeCount > 1) await writeBlocked;
    },
    close: (reason) => closes.push(reason)
  });

  assert.equal(queue.enqueue({ method: "warning", params: { message: "first" } }, "cursor-1"), true);
  await queue.idle();
  assert.equal(queue.enqueue({ method: "warning", params: { message: "second" } }, "cursor-2"), true);
  assert.equal(queue.enqueue({ method: "warning", params: { message: "third" } }, "cursor-3"), false);
  assert.deepEqual(closes, [{ reason: "backpressure", cursor: "cursor-1" }]);
  releaseWrite?.();
  await queue.idle();
});

test("replays 10,000 persisted notifications without loss", async () => {
  const log = new InMemoryNotificationLog();
  for (let index = 0; index < 10_000; index += 1) {
    await log.append({ method: "warning", params: { message: `event-${index}` } });
  }

  const replay = log.readAfter("5000");
  assert.equal(replay.length, 5_000);
  assert.equal(replay[0]?.cursor, "5001");
  assert.deepEqual(replay.at(-1), {
    cursor: "10000",
    notification: { method: "warning", params: { message: "event-9999" } }
  });
});
