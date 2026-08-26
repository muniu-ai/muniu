// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { ContributorBus } from "../src/index.js";

test("contributor bus runs stable priority order with isolated frozen payloads", async () => {
  const bus = new ContributorBus();
  const order: string[] = [];
  bus.register("context.collect", {
    id: "later",
    priority: 20,
    contribute(payload) {
      order.push("later");
      assert.equal(Object.isFrozen(payload), true);
      return { source: "later" };
    }
  });
  const unregister = bus.register("context.collect", {
    id: "first",
    priority: 10,
    contribute(payload) {
      order.push("first");
      assert.equal(Object.isFrozen(payload), true);
      return { source: "first" };
    }
  });

  assert.deepEqual(await bus.emit("context.collect", { threadId: "thread-one" }), [
    { source: "first" },
    { source: "later" }
  ]);
  assert.deepEqual(order, ["first", "later"]);
  unregister();
  assert.deepEqual(await bus.emit("context.collect", { threadId: "thread-one" }), [
    { source: "later" }
  ]);
  bus.dispose();
  assert.throws(() => bus.register("tools.collect", {
    id: "closed",
    contribute: () => null
  }), /disposed/iu);
});

test("contributor bus exposes every platform lifecycle channel", () => {
  assert.deepEqual(ContributorBus.channels, [
    "thread.beforeStart",
    "thread.started",
    "turn.beforeStart",
    "turn.started",
    "turn.completed",
    "context.collect",
    "tools.collect",
    "approval.requested",
    "items.ordered",
    "tokenUsage.recorded",
    "config.changed",
    "skill.invoked",
    "domain.record.validate",
    "operation.compile",
    "attention.collect",
    "effect.authorize",
    "settlement.observe",
    "evidence.append"
  ]);
});
