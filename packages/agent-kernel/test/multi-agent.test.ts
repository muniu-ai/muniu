// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAgentEventV3Store } from "@mn/agent-session";

import {
  createSubAgentToolAdapters,
  MultiAgentManager,
  ThreadManager,
  type TurnExecutionInput,
  type TurnExecutionResult,
  type TurnExecutor
} from "../src/index.js";

function identifiers() {
  let next = 0;
  return (kind: "thread" | "turn" | "item" | "event"): string => `${kind}-multi-${++next}`;
}

async function root(manager: ThreadManager) {
  return manager.startThread({
    cwd: "/workspace/project",
    providerId: "openai",
    modelId: "gpt-5",
    permissionProfile: "workspace-write",
    sandbox: { mode: "workspace-write", network: false },
    source: "appServer"
  });
}

test("multi-agent graph persists inherited child authority, budget and parent activity", async () => {
  const store = new InMemoryAgentEventV3Store();
  const threadManager = new ThreadManager({
    store,
    id: identifiers(),
    executor: {
      async execute(input) {
        await input.recordItem({ kind: "agentMessage", content: { text: "child complete" } });
        return { status: "completed", tokenUsage: { inputTokens: 3, outputTokens: 2 } };
      }
    }
  });
  const parent = await root(threadManager);
  await threadManager.setGoal(parent.threadId, { objective: "root objective", status: "active", tokenBudget: 100 });
  const agents = new MultiAgentManager({ threadManager });
  const child = await agents.spawn(parent.threadId, {
    objective: "inspect tests",
    role: "reviewer",
    tokenBudget: 40
  });
  const waited = await agents.wait(parent.threadId, [child.threadId]);
  assert.equal(waited[0]?.status, "completed");

  const projected = await threadManager.readThread(child.threadId);
  assert.equal(projected.parentThreadId, parent.threadId);
  assert.equal(projected.permissionProfile, parent.permissionProfile);
  assert.deepEqual(projected.sandbox, parent.sandbox);
  assert.equal(projected.goal?.tokenBudget, 40);
  assert.equal(projected.goal?.objective.text, "inspect tests");
  const parentAfter = await threadManager.readThread(parent.threadId);
  assert.deepEqual(
    parentAfter.items.filter((item) => item.kind === "subAgentActivity")
      .map((item) => item.publicControls.kind),
    ["started", "completed"]
  );

  const reconstructed = new MultiAgentManager({ threadManager });
  assert.deepEqual((await reconstructed.graph(parent.threadId)).children.map((entry) => entry.threadId), [
    child.threadId
  ]);
});

class HoldingExecutor implements TurnExecutor {
  readonly executions: TurnExecutionInput[] = [];
  readonly releases: Array<(result: TurnExecutionResult) => void> = [];

  execute(input: TurnExecutionInput): Promise<TurnExecutionResult> {
    this.executions.push(input);
    return new Promise((resolve) => this.releases.push(resolve));
  }
}

test("multi-agent limits reject concurrent, depth, total and budget expansion", async () => {
  const executor = new HoldingExecutor();
  const threadManager = new ThreadManager({
    store: new InMemoryAgentEventV3Store(),
    id: identifiers(),
    executor
  });
  const parent = await root(threadManager);
  await threadManager.setGoal(parent.threadId, { objective: "bounded root", status: "active", tokenBudget: 50 });
  const agents = new MultiAgentManager({
    threadManager,
    maxAgentsPerRoot: 1,
    maxConcurrentPerRoot: 1,
    maxDepth: 1
  });

  await assert.rejects(
    () => agents.spawn(parent.threadId, { objective: "too expensive", tokenBudget: 51 }),
    /budget/iu
  );
  const child = await agents.spawn(parent.threadId, { objective: "hold", tokenBudget: 30 });
  await assert.rejects(
    () => agents.spawn(parent.threadId, { objective: "concurrent", tokenBudget: 10 }),
    /concurrent|limit/iu
  );
  await assert.rejects(
    () => agents.spawn(child.threadId, { objective: "too deep", tokenBudget: 1 }),
    /depth/iu
  );
  executor.releases[0]?.({ status: "completed" });
  await agents.wait(parent.threadId, [child.threadId]);
  await assert.rejects(
    () => agents.spawn(parent.threadId, { objective: "total", tokenBudget: 10 }),
    /agent limit/iu
  );
  await agents.close(parent.threadId, child.threadId);
  const replacement = await agents.spawn(parent.threadId, { objective: "replacement", tokenBudget: 10 });
  assert.notEqual(replacement.threadId, child.threadId);
  executor.releases[1]?.({ status: "completed" });
  await agents.wait(parent.threadId, [replacement.threadId]);
});

test("multi-agent interrupt and tool handlers cannot target unrelated threads", async () => {
  const executor: TurnExecutor = {
    async execute(input) {
      await new Promise<void>((resolve) => {
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { status: "interrupted" };
    }
  };
  const threadManager = new ThreadManager({
    store: new InMemoryAgentEventV3Store(),
    id: identifiers(),
    executor
  });
  const parent = await root(threadManager);
  const other = await root(threadManager);
  const agents = new MultiAgentManager({ threadManager });
  const child = await agents.spawn(parent.threadId, { objective: "wait" });
  await assert.rejects(
    () => agents.interrupt(other.threadId, child.threadId),
    /does not belong/iu
  );
  await agents.interrupt(parent.threadId, child.threadId);
  assert.equal((await agents.wait(parent.threadId, [child.threadId]))[0]?.status, "interrupted");
});

test("multi-agent tool adapters bind every operation to the calling parent thread", async () => {
  const threadManager = new ThreadManager({
    store: new InMemoryAgentEventV3Store(),
    id: identifiers(),
    executor: {
      async execute() {
        return { status: "completed", tokenUsage: { inputTokens: 1, outputTokens: 1 } };
      }
    }
  });
  const parent = await root(threadManager);
  await threadManager.setGoal(parent.threadId, { objective: "root", status: "active", tokenBudget: 25 });
  const adapters = createSubAgentToolAdapters(new MultiAgentManager({ threadManager }));
  const context = { sessionId: parent.threadId };
  const spawned = await adapters.spawn({ objective: "inspect", role: "reviewer", tokenBudget: 10 }, context);
  assert.equal(typeof spawned, "object");
  assert.notEqual(spawned, null);
  assert.equal(Array.isArray(spawned), false);
  const childThreadId = (spawned as { threadId: string }).threadId;

  assert.deepEqual(await adapters.wait({ threadIds: [childThreadId] }, context), [{
    threadId: childThreadId,
    parentThreadId: parent.threadId,
    status: "completed",
    role: "reviewer"
  }]);
  await adapters.close({ threadId: childThreadId }, context);
  await assert.rejects(
    () => Promise.resolve(adapters.resume({ threadId: childThreadId }, context)),
    /closed/iu
  );
  await assert.rejects(
    () => Promise.resolve(adapters.send({ threadId: childThreadId, input: [{ type: "unknown" }] }, context)),
    /input type/iu
  );
});
