// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InMemoryAgentEventV3Store, JsonlAgentEventV3Store } from "@mn/agent-session";

import {
  ContextCompactionError,
  ContextManager,
  ThreadManager,
  TurnAttemptError,
  TurnRunner,
  type TurnExecutionInput,
  type TurnExecutionResult,
  type TurnExecutor
} from "../src/index.js";

function identifiers() {
  let next = 0;
  return (kind: "thread" | "turn" | "item" | "event"): string => `${kind}-runtime-${++next}`;
}

test("ContextManager orders instruction sources and compacts without discarding protected state", async () => {
  const manager = new ContextManager({ contextWindowTokens: 1_000, maxOutputTokens: 200, safetyMarginTokens: 100 });
  const context = manager.assemble({
    systemInvariants: ["system"],
    signedGovernanceSpec: ["governance"],
    appDeveloperInstructions: ["developer"],
    repositoryInstructions: ["AGENTS"],
    selectedSkills: ["skill"],
    userInputs: ["user"],
    toolResults: ["tool"]
  });
  assert.deepEqual(context.entries.map((entry) => entry.source), [
    "systemInvariant",
    "signedGovernanceSpec",
    "appDeveloperInstructions",
    "repositoryInstructions",
    "selectedSkill",
    "userInput",
    "toolResult"
  ]);
  assert.deepEqual(context.instructionSources, [
    "systemInvariant",
    "signedGovernanceSpec",
    "appDeveloperInstructions",
    "repositoryInstructions",
    "selectedSkill"
  ]);
  assert.equal(manager.compactionThresholdTokens, 700);
  assert.equal(manager.needsCompaction(699), false);
  assert.equal(manager.needsCompaction(700), true);

  const compacted = await manager.compact({
    previousSummary: "old",
    goal: "finish migration",
    pendingApprovals: ["approval-one"],
    plan: ["step one"],
    diff: "diff --git a/a b/a",
    artifactRefs: ["cas://sha256/abc"],
    entries: context.entries,
    summarize: async () => "bounded summary"
  });
  assert.equal(compacted.summary, "bounded summary");
  assert.equal(compacted.goal, "finish migration");
  assert.deepEqual(compacted.pendingApprovals, ["approval-one"]);
  assert.deepEqual(compacted.artifactRefs, ["cas://sha256/abc"]);

  await assert.rejects(
    () => manager.compact({
      goal: "do not lose",
      pendingApprovals: [],
      plan: [],
      artifactRefs: [],
      entries: context.entries,
      summarize: async () => { throw new Error("provider failed"); }
    }),
    ContextCompactionError
  );
});

test("TurnRunner retries and reroutes only retryable model failures", async () => {
  const attempts: string[] = [];
  const runner = new TurnRunner({
    retriesPerRoute: 1,
    routes: [
      {
        providerId: "provider-a",
        modelId: "model-a",
        async execute() {
          attempts.push("a");
          throw new TurnAttemptError("temporary", true);
        }
      },
      {
        providerId: "provider-b",
        modelId: "model-b",
        async execute() {
          attempts.push("b");
          return { status: "completed" };
        }
      }
    ]
  });
  const result = await runner.execute({
    threadId: "thread-reroute",
    turnId: "turn-reroute",
    input: [{ type: "text", text: "run" }],
    context: { entries: [], instructionSources: [] },
    signal: new AbortController().signal,
    recordItem: async () => "item-reroute"
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(attempts, ["a", "a", "b"]);
});

class ControlledExecutor implements TurnExecutor {
  readonly executions: TurnExecutionInput[] = [];
  readonly steering: Array<{ turnId: string; clientUserMessageId?: string }> = [];
  private release!: (result: TurnExecutionResult) => void;

  execute(input: TurnExecutionInput): Promise<TurnExecutionResult> {
    this.executions.push(input);
    return new Promise((resolve) => { this.release = resolve; });
  }

  steer(input: { turnId: string; clientUserMessageId?: string }): Promise<void> {
    this.steering.push(input);
    return Promise.resolve();
  }

  finish(result: TurnExecutionResult): void {
    this.release(result);
  }
}

test("ThreadManager keeps stable lifecycle facts across idempotent start, steer and interrupt", async () => {
  const store = new InMemoryAgentEventV3Store();
  const executor = new ControlledExecutor();
  const manager = new ThreadManager({
    store,
    executor,
    id: identifiers(),
    now: (() => {
      let second = 0;
      return () => `2026-08-23T00:00:${String(second++).padStart(2, "0")}.000Z`;
    })()
  });
  const thread = await manager.startThread({
    cwd: "/workspace/project",
    providerId: "openai",
    modelId: "gpt-5",
    permissionProfile: "workspace-write",
    sandbox: { mode: "workspace-write" },
    source: "appServer"
  });

  const running = manager.runTurn(thread.threadId, {
    input: [{ type: "text", text: "implement" }],
    clientUserMessageId: "client-message-one"
  });
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = manager.runTurn(thread.threadId, {
    input: [{ type: "text", text: "implement" }],
    clientUserMessageId: "client-message-one"
  });
  assert.equal(executor.executions.length, 1);
  await manager.steerTurn(thread.threadId, executor.executions[0]!.turnId, {
    input: [{ type: "text", text: "also update tests" }],
    clientUserMessageId: "client-steer-one"
  });
  assert.equal(executor.steering[0]?.turnId, executor.executions[0]!.turnId);
  assert.equal(executor.steering[0]?.clientUserMessageId, "client-steer-one");
  await manager.interruptTurn(thread.threadId, executor.executions[0]!.turnId);
  assert.equal(executor.executions[0]!.signal.aborted, true);
  executor.finish({ status: "interrupted", tokenUsage: { inputTokens: 8, outputTokens: 2 } });
  const [first, second] = await Promise.all([running, duplicate]);
  assert.equal(first.turnId, second.turnId);
  assert.equal(first.status, "interrupted");

  const projected = await manager.readThread(thread.threadId);
  assert.equal(projected.turns.length, 1);
  assert.equal(projected.turns[0]?.status, "interrupted");
  assert.equal(projected.items.filter((item) => item.kind === "userMessage").length, 2);
});

test("ThreadManager enforces goal token budgets and spills large item content to CAS", async () => {
  const executor: TurnExecutor = {
    async execute(input) {
      await input.recordItem({
        kind: "agentMessage",
        content: { text: "x".repeat(140 * 1024) }
      });
      return { status: "completed", tokenUsage: { inputTokens: 7, outputTokens: 5 } };
    }
  };
  const manager = new ThreadManager({ store: new InMemoryAgentEventV3Store(), executor, id: identifiers() });
  const thread = await manager.startThread({
    cwd: "/workspace/project",
    providerId: "openai",
    modelId: "gpt-5",
    permissionProfile: "workspace-write",
    sandbox: { mode: "workspace-write" },
    source: "appServer"
  });
  await manager.setGoal(thread.threadId, { objective: "bounded", status: "active", tokenBudget: 10 });
  const result = await manager.runTurn(thread.threadId, { input: [{ type: "text", text: "run" }] });
  assert.equal(result.status, "completed");
  const projected = await manager.readThread(thread.threadId);
  assert.equal(projected.goal?.tokensUsed, 12);
  const agentItem = projected.items.find((item) => item.kind === "agentMessage");
  assert.equal(typeof agentItem?.publicControls.casRef, "string");
  assert.equal(agentItem?.publicControls.inlineTruncated, true);

  await assert.rejects(
    () => manager.runTurn(thread.threadId, { input: [{ type: "text", text: "over budget" }] }),
    /token budget/iu
  );
});

test("ThreadManager interrupts on compaction failure and reconstructs pending work from facts", async () => {
  let executed = false;
  const manager = new ThreadManager({
    store: new InMemoryAgentEventV3Store(),
    id: identifiers(),
    contextManager: new ContextManager({
      contextWindowTokens: 100,
      maxOutputTokens: 20,
      safetyMarginTokens: 10
    }),
    executor: {
      async execute() {
        executed = true;
        return { status: "completed" };
      }
    }
  });
  const thread = await manager.startThread({
    cwd: "/workspace/project",
    providerId: "openai",
    modelId: "gpt-5",
    permissionProfile: "workspace-write",
    sandbox: { mode: "workspace-write" },
    source: "appServer"
  });
  const result = await manager.runTurn(thread.threadId, {
    input: [{ type: "text", text: "compact first" }],
    estimatedInputTokens: 70,
    summarizeContext: async () => { throw new Error("summary unavailable"); }
  });
  assert.equal(result.status, "interrupted");
  assert.equal(executed, false);
  const recovery = await manager.recoverThread(thread.threadId);
  assert.equal(recovery.thread.turns[0]?.status, "interrupted");
  assert.equal(recovery.lastSequence, recovery.thread.lastSequence);
  assert.match(recovery.lastDigest, /^[a-f0-9]{64}$/u);
});

test("ThreadManager withholds structured output that fails its schema", async () => {
  const manager = new ThreadManager({
    store: new InMemoryAgentEventV3Store(),
    id: identifiers(),
    executor: {
      async execute() {
        return { status: "completed", structuredOutput: { count: "invalid" } };
      }
    }
  });
  const thread = await manager.startThread({
    cwd: "/workspace/project",
    providerId: "openai",
    modelId: "gpt-5",
    permissionProfile: "workspace-write",
    sandbox: { mode: "workspace-write" },
    source: "appServer"
  });

  const result = await manager.runTurn(thread.threadId, {
    input: [{ type: "text", text: "return a count" }],
    outputSchema: {
      type: "object",
      required: ["count"],
      properties: { count: { type: "integer" } }
    }
  });
  assert.equal(result.status, "failed");
  assert.equal(result.structuredOutput, undefined);
  assert.match(result.error ?? "", /structured output failed validation/iu);
});

test("ThreadManager projects names, forks, archives, tombstones and goal clearing", async () => {
  const manager = new ThreadManager({
    store: new InMemoryAgentEventV3Store(),
    id: identifiers(),
    executor: { async execute() { return { status: "completed" }; } }
  });
  const parent = await manager.startThread({
    cwd: "/workspace/project",
    providerId: "openai",
    modelId: "gpt-5",
    permissionProfile: "workspace-write",
    sandbox: { mode: "workspace-write" },
    source: "appServer"
  });
  await manager.setThreadName(parent.threadId, "platform upgrade");
  await manager.setGoal(parent.threadId, { objective: "finish", status: "active" });
  assert.equal(await manager.clearGoal(parent.threadId), true);
  assert.equal(await manager.clearGoal(parent.threadId), false);

  const child = await manager.forkThread(parent.threadId);
  assert.equal(child.parentThreadId, parent.threadId);
  assert.equal(child.cwd, "/workspace/project");
  assert.equal(child.name, "platform upgrade");

  await manager.archiveThread(parent.threadId);
  assert.equal((await manager.readThread(parent.threadId)).archived, true);
  await manager.unarchiveThread(parent.threadId);
  assert.equal((await manager.readThread(parent.threadId)).archived, false);
  await manager.deleteThread(parent.threadId);
  assert.equal((await manager.readThread(parent.threadId)).tombstoned, true);
  assert.equal((await manager.listThreads()).some((thread) => thread.threadId === parent.threadId), false);
  assert.equal((await manager.listThreads({ includeTombstoned: true })).length, 2);
});

test("ThreadManager reconstructs a completed thread after a durable store restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-thread-manager-v3-"));
  const first = new ThreadManager({
    store: new JsonlAgentEventV3Store(root),
    id: identifiers(),
    executor: {
      async execute(input) {
        await input.recordItem({ kind: "agentMessage", content: { text: "persisted" } });
        return { status: "completed", tokenUsage: { inputTokens: 2, outputTokens: 1 } };
      }
    }
  });
  const thread = await first.startThread({
    cwd: "/workspace/project",
    providerId: "openai",
    modelId: "gpt-5",
    permissionProfile: "workspace-write",
    sandbox: { mode: "workspace-write" },
    source: "appServer"
  });
  await first.runTurn(thread.threadId, { input: [{ type: "text", text: "persist" }] });

  const reopened = new ThreadManager({
    store: new JsonlAgentEventV3Store(root),
    executor: { async execute() { return { status: "completed" }; } }
  });
  const recovered = await reopened.recoverThread(thread.threadId);
  assert.equal(recovered.thread.cwd, "/workspace/project");
  assert.equal(recovered.thread.turns[0]?.status, "completed");
  assert.equal(recovered.thread.items.some((item) => item.kind === "agentMessage"), true);
  assert.equal(recovered.activeTurnId, undefined);
});
