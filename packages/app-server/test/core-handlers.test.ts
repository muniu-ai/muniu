// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { ThreadManager, type TurnExecutor } from "@mn/agent-kernel";
import { InMemoryAgentEventV3Store } from "@mn/agent-session";
import { CLIENT_METHODS } from "@mn/app-server-protocol";

import { createCoreAppServerHandlers } from "../src/index.js";

function identifiers() {
  let next = 0;
  return (kind: "thread" | "turn" | "item" | "event") => `${kind}-rpc-${++next}`;
}

class HoldingExecutor implements TurnExecutor {
  release: (() => void) | undefined;

  async execute(input: Parameters<TurnExecutor["execute"]>[0]) {
    await input.recordItem({ kind: "agentMessage", content: { text: "complete" } });
    await new Promise<void>((resolve) => { this.release = resolve; });
    return { status: "completed" as const, tokenUsage: { inputTokens: 2, outputTokens: 1 } };
  }
}

test("core app-server handlers project thread, turn, item and goal lifecycle", async () => {
  const executor = new HoldingExecutor();
  const threads = new ThreadManager({
    store: new InMemoryAgentEventV3Store(),
    id: identifiers(),
    executor
  });
  const notifications: Array<{ method: string; params: unknown }> = [];
  const handlers = createCoreAppServerHandlers({
    threads,
    defaults: {
      cwd: "/workspace",
      providerId: "openai",
      modelId: "gpt-5",
      permissionProfile: "workspace-write",
      sandbox: { mode: "workspace-write", network: false }
    },
    notify: async (method, params) => { notifications.push({ method, params }); },
    compact: async () => "bounded summary"
  });
  assert.deepEqual(Object.keys(handlers), CLIENT_METHODS.filter((method) => method !== "initialize"));
  const context = {
    clientInfo: { name: "sdk-test", version: "0.2.0" },
    signal: new AbortController().signal
  };
  const started = await handlers["thread/start"]({ cwd: "/repo", model: "gpt-5.1" }, context);
  assert.equal(started.thread.cwd, "/repo");
  assert.equal(started.thread.muniu.modelId, "gpt-5.1");
  await handlers["thread/goal/set"]({
    threadId: started.thread.id,
    objective: "ship v0.2",
    status: "active",
    tokenBudget: 100
  }, context);
  const turnStarted = await handlers["turn/start"]({
    threadId: started.thread.id,
    input: [{ type: "text", text: "continue" }],
    clientUserMessageId: "message-1"
  }, context);
  assert.equal(turnStarted.turn.status, "inProgress");
  assert.equal(turnStarted.turn.items[0]?.type, "userMessage");
  executor.release?.();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const read = await handlers["thread/read"]({ threadId: started.thread.id, includeTurns: true }, context);
  assert.equal(read.thread.turns[0]?.status, "completed");
  assert.equal(read.thread.turns[0]?.items[1]?.type, "agentMessage");
  assert.equal(read.thread.muniu.goal?.tokensUsed, 3);
  assert.deepEqual(notifications.map((entry) => entry.method), [
    "thread/started",
    "thread/goal/updated",
    "turn/started",
    "item/completed",
    "item/completed",
    "turn/completed"
  ]);
});

test("core app-server handlers expose fork, archive, tombstone and injected capabilities", async () => {
  const threads = new ThreadManager({
    store: new InMemoryAgentEventV3Store(),
    id: identifiers(),
    executor: { async execute() { return { status: "completed" }; } }
  });
  const handlers = createCoreAppServerHandlers({
    threads,
    defaults: {
      cwd: "/workspace",
      providerId: "openai",
      modelId: "gpt-5",
      permissionProfile: "read-only",
      sandbox: { mode: "read-only" }
    },
    enforceSecurityDefaults: true,
    models: async () => [{
      id: "gpt-5",
      model: "gpt-5",
      displayName: "GPT-5",
      description: "test model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: []
    }]
  });
  const context = {
    clientInfo: { name: "sdk-test", version: "0.2.0" },
    signal: new AbortController().signal
  };
  const parent = await handlers["thread/start"]({
    approvalPolicy: "on-request",
    sandbox: "danger-full-access"
  }, context);
  assert.equal(parent.thread.muniu.permissionProfile, "read-only");
  assert.deepEqual(parent.thread.muniu.sandbox, { mode: "read-only" });
  const child = await handlers["thread/fork"]({
    threadId: parent.thread.id,
    approvalPolicy: "on-request",
    sandbox: "danger-full-access"
  }, context);
  assert.equal(child.thread.muniu.permissionProfile, "read-only");
  assert.deepEqual(child.thread.muniu.sandbox, { mode: "read-only" });
  assert.equal(child.thread.parentThreadId, parent.thread.id);
  assert.equal((await handlers["model/list"]({}, context)).data[0]?.id, "gpt-5");
  await handlers["thread/archive"]({ threadId: child.thread.id }, context);
  assert.equal((await handlers["thread/list"]({ archived: true }, context)).data.length, 1);
  await handlers["thread/unarchive"]({ threadId: child.thread.id }, context);
  await handlers["thread/delete"]({ threadId: child.thread.id }, context);
  assert.equal((await handlers["thread/list"]({}, context)).data.length, 1);
});
