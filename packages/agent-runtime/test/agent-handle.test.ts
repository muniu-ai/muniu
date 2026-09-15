// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentHandle,
  AgentScope,
  InMemoryRuntimeStore,
  PersistentInbox,
  PersistentModelBudget,
  UnknownToolOutcomeError,
  type LlmContribution,
  type ModelRequest,
  type ModelToolCall,
  type RuntimeAuthority,
  type RuntimeRecordInput,
  type ToolApprovalPort,
  type ToolContribution,
} from "../src/index.js";

const authority: RuntimeAuthority = {
  commitment: "authority-v1",
  toolIds: ["web.publish", "file.read"],
  dataScopes: [
    { namespace: "web", resourceId: "target" },
    { namespace: "workspace", resourceId: "repository" },
  ],
  effectClasses: ["external_side_effect", "local_read"],
  budget: {
    maxSubagentDepth: 2,
    maxSubagents: 2,
    maxTokens: 10_000,
    maxCostMinorUnits: "1000",
    currency: "CNY",
    maxDurationMs: 60_000,
  },
};

const approveAuthorizedTools: ToolApprovalPort = {
  async authorize(intent) {
    return ["local_read", "external_read", "local_reversible_write"].includes(intent.effectClass)
      ? { mode: "auto", intent }
      : { mode: "approve_once", approvedIntent: intent };
  },
};

test("subagents cannot allocate tokens already consumed by the parent model", async () => {
  const scope = executionScope();
  const store = new InMemoryRuntimeStore();
  let spawned = 0;
  scope.register("subagent", { id: "reviewer", async spawn() { spawned += 1; } });
  const budget = new PersistentModelBudget({ store, executionId: "execution-a", limits: authority.budget });
  await budget.reserve({ id: "model-1", requestDigest: "a".repeat(64), inputTokenLimit: 6000, maxOutputTokens: 1,
    rates: { id: "test", currency: "CNY", inputNanoMinorUnitsPerToken: "0",
      cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } });
  await budget.settle("model-1", { inputTokens: 6000, cachedInputTokens: 0, outputTokens: 1 });
  const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
    definition: { id: "agent", llmId: "unused", promptIds: [] }, authority, approval: approveAuthorizedTools });
  await assert.rejects(handle.spawnSubagent({ contributionId: "reviewer", scopeId: "child", authority: {
    toolIds: [], dataScopes: [], effectClasses: [], budget: { ...authority.budget, maxTokens: 5000,
      maxSubagentDepth: 0, maxSubagents: 0, maxCostMinorUnits: "0" },
  } }), /token/u);
  assert.equal(spawned, 0);
  await scope.dispose();
});

function executionScope(generation = 1): AgentScope {
  return AgentScope.tenant("tenant-a", generation)
    .createChild("workspace", "workspace-a")
    .createChild("thread", "thread-a")
    .createChild("execution", "execution-a");
}

test("子 Agent 生命周期不能超过父执行的剩余时间，取消父执行会关闭子 Scope", async () => {
  for (const cancel of [false, true]) {
    const scope = executionScope();
    const store = new InMemoryRuntimeStore();
    const timestamp = "2026-09-04T00:00:00.000Z";
    await store.append({ executionId: "execution-a", type: "budget/started",
      payload: { startedAtMs: Date.parse(timestamp) - 59_950, maxDurationMs: 60_000 } });
    let child: any;
    scope.register("subagent", { id: "reviewer", async spawn(context) { child = context; return "started"; } });
    const handle = await AgentHandle.open({ executionId: "execution-a", scope, store, now: () => timestamp,
      definition: { id: "agent", llmId: "unused", promptIds: [] }, authority, approval: approveAuthorizedTools });
    await handle.spawnSubagent({ contributionId: "reviewer", scopeId: "child", authority: {
      toolIds: [], dataScopes: [], effectClasses: [], budget: { ...authority.budget, maxTokens: 1,
        maxSubagentDepth: 0, maxSubagents: 0, maxCostMinorUnits: "0", maxDurationMs: 1000 },
    } });
    assert.equal(child.deadlineAt, "2026-09-04T00:00:00.050Z");
    if (cancel) await handle.cancel();
    else await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(child.signal.aborted, true);
    assert.throws(() => child.scope.resolveTurn());
    assert.equal((await store.readExecution("execution-a")).filter(record => record.type === "subagent/reserved").length, 1);
    await scope.dispose();
  }
});

test("model usage is retained with the response and duplicate calls never start tools", async () => {
  for (const duplicate of [false, true]) {
    const scope = executionScope();
    const store = new InMemoryRuntimeStore();
    let tools = 0;
    scope.register("llm", { id: "main", async complete() { return {
      text: "result", usage: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 8 },
      toolCalls: duplicate ? [1, 2].map(index => ({ id: "duplicate", toolId: "file.read", arguments: { index } })) : [],
    }; } });
    scope.register("tool", { id: "file.read", version: "1", effectClass: "local_read",
      prepare: () => ({ normalizedArguments: {}, resourceRefs: [] }), async execute() { tools += 1; return {}; } });
    const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
      definition: { id: "agent", llmId: "main", promptIds: [] }, authority, approval: approveAuthorizedTools });
    await handle.start("检查");
    await handle.whenIdle();
    assert.equal(tools, 0);
    assert.equal(handle.status, duplicate ? "failed" : "completed");
    if (!duplicate) assert.deepEqual((await store.readExecution("execution-a"))
      .find(record => record.type === "model/response")?.payload.usage,
    { inputTokens: 12, cachedInputTokens: 2, outputTokens: 8 });
    await scope.dispose();
  }
});

test("model boundaries share a persistent deadline and resume cannot reset it", async () => {
  const scope = executionScope();
  const store = new InMemoryRuntimeStore();
  let clock = Date.parse("2026-09-04T00:00:00.000Z");
  let calls = 0;
  scope.register("llm", { id: "main", async complete() {
    calls += 1;
    clock += 101;
    return { text: "", toolCalls: [{ id: "read", toolId: "file.read", arguments: {} }] };
  } });
  let tools = 0;
  scope.register("tool", { id: "file.read", version: "1", effectClass: "local_read",
    prepare: () => ({ normalizedArguments: {}, resourceRefs: [] }),
    async execute() { tools += 1; return {}; } });
  const options = { executionId: "execution-a", scope, store, definition: { id: "agent", llmId: "main", promptIds: [] },
    authority: { ...authority, budget: { ...authority.budget, maxDurationMs: 100 } }, approval: approveAuthorizedTools,
    now: () => new Date(clock).toISOString() };
  const handle = await AgentHandle.open(options);
  await handle.start("检查");
  await handle.whenIdle();
  assert.equal(handle.status, "paused");
  assert.equal(tools, 0);
  const reopened = await AgentHandle.open(options);
  await reopened.resume();
  await reopened.whenIdle();
  assert.equal(reopened.status, "paused");
  assert.equal(calls, 1);
  await scope.dispose();
});

test("model deadlines settle when a trusted model adapter ignores cancellation", async () => {
  const scope = executionScope();
  const store = new InMemoryRuntimeStore();
  let release!: (value: { text: string; toolCalls: [] }) => void;
  scope.register("llm", { id: "main", complete: () => new Promise(resolve => { release = resolve; }) });
  const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
    definition: { id: "agent", llmId: "main", promptIds: [] }, approval: approveAuthorizedTools,
    authority: { ...authority, budget: { ...authority.budget, maxDurationMs: 50 } } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await handle.start("检查");
    await Promise.race([handle.whenIdle(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("model adapter prevented deadline settlement")), 400);
    })]);
    assert.equal(handle.status, "paused");
  } finally {
    clearTimeout(timer);
    release?.({ text: "late result", toolCalls: [] });
    await handle.whenIdle();
    await scope.dispose();
  }
});

test("disposing an active Scope interrupts its Agent and aborts the model request", async () => {
  const scope = executionScope();
  const store = new InMemoryRuntimeStore();
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let modelSignal!: AbortSignal;
  scope.register("llm", { id: "main", async complete(_request, context) {
    modelSignal = context.signal;
    started();
    await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true }));
    return { text: "", toolCalls: [] };
  } });
  const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
    definition: { id: "agent", llmId: "main", promptIds: [] }, authority, approval: approveAuthorizedTools });
  await handle.start("检查");
  await waiting;
  await scope.dispose();
  assert.equal(modelSignal.aborted, true);
  await handle.whenIdle();
  assert.equal(handle.status, "interrupted");
});

test("provider tool call IDs cannot reuse an approval across turns", async () => {
  const scope = executionScope();
  const store = new InMemoryRuntimeStore();
  let calls = 0;
  scope.register("llm", { id: "main", async complete() {
    calls += 1;
    return calls % 2 ? { text: "", toolCalls: [{ id: "provider-reused-id", toolId: "web.publish", arguments: {} }] }
      : { text: "完成", toolCalls: [] };
  } });
  scope.register("tool", { id: "web.publish", version: "1", effectClass: "external_side_effect",
    prepare: () => ({ normalizedArguments: {}, resourceRefs: [] }), async execute() { return {}; } });
  await new PersistentInbox(store, "execution-a").enqueue("follow_up", "第二次");
  const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
    definition: { id: "agent", llmId: "main", promptIds: [] }, authority, approval: approveAuthorizedTools });
  await handle.start("第一次");
  await handle.whenIdle();
  assert.equal(handle.status, "completed");
  const intents = (await store.readExecution("execution-a")).filter(record => record.type === "tool/intent");
  assert.equal(intents.length, 2);
  assert.equal(new Set(intents.map(record => record.payload.toolCallId)).size, 2);
  await scope.dispose();
});

test("unexpected errors after starting a non-replayable tool require reconciliation", async () => {
  const scope = executionScope();
  const store = new InMemoryRuntimeStore();
  scope.register("llm", { id: "main", async complete() {
    return { text: "", toolCalls: [{ id: "publish", toolId: "web.publish", arguments: {} }] };
  } });
  scope.register("tool", { id: "web.publish", version: "1", effectClass: "external_side_effect",
    prepare: () => ({ normalizedArguments: {}, resourceRefs: [] }),
    async execute() { throw new Error("connection lost after dispatch"); } });
  const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
    definition: { id: "agent", llmId: "main", promptIds: [] }, authority, approval: approveAuthorizedTools });
  await handle.start("执行");
  await handle.whenIdle();
  assert.equal(handle.status, "needs_reconciliation");
  await scope.dispose();
});

test("subagent quotas are reserved before spawning and survive parent reopening", async () => {
  const scope = executionScope();
  const store = new InMemoryRuntimeStore();
  let spawned = 0;
  scope.register("subagent", { id: "reviewer", async spawn() {
    assert.equal((await store.readExecution("execution-a")).at(-1)?.type, "subagent/reserved");
    spawned += 1;
    return "done";
  } });
  const options = { executionId: "execution-a", scope, store,
    definition: { id: "agent", llmId: "main", promptIds: [] }, authority, approval: approveAuthorizedTools };
  const requested = { toolIds: ["file.read"], effectClasses: ["local_read" as const], dataScopes: [],
    budget: { maxSubagentDepth: 1, maxSubagents: 0, maxTokens: 4000, maxCostMinorUnits: "100", currency: "CNY", maxDurationMs: 1000 } };
  const first = await AgentHandle.open(options);
  await first.spawnSubagent({ contributionId: "reviewer", scopeId: "first", authority: requested });
  const reopened = await AgentHandle.open(options);
  await reopened.spawnSubagent({ contributionId: "reviewer", scopeId: "second", authority: requested });
  await assert.rejects(reopened.spawnSubagent({ contributionId: "reviewer", scopeId: "third", authority: requested }), /累计/u);
  await assert.rejects(reopened.spawnSubagent({ contributionId: "reviewer", scopeId: "first", authority: requested }), /已预留/u);
  assert.equal(spawned, 2);
  await scope.dispose();
});

test("compiled product jobs use AgentHandle FIFO turns and pinned Scope generations", async () => {
  const scope = executionScope();
  const store = new InMemoryRuntimeStore();
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const messages: string[] = [];
  scope.register("job", { id: "product.workflow", async run(input, signal) {
    assert.equal(signal.aborted, false);
    assert.equal(input.generation, 1);
    const records = await store.readExecution("execution-a");
    assert.equal(records.at(-1)?.type, "job/started");
    messages.push(String(input.message));
    if (input.turn === 1) { started(); await pending; }
    return { status: "completed", summary: `done:${input.message}` };
  } });
  const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
    definition: { id: "product.agent", llmId: "unused", promptIds: [], jobId: "product.workflow" },
    authority, approval: approveAuthorizedTools });
  await handle.followUp("first");
  const observed = await Promise.race([firstStarted.then(() => true), handle.whenIdle().then(() => false)]);
  assert.equal(observed, true, "the compiled product workflow must execute inside AgentHandle");
  await handle.followUp("second");
  release();
  await handle.whenIdle();
  assert.equal(handle.status, "completed");
  assert.deepEqual(messages, ["first", "second"]);
  assert.deepEqual((await handle.sessionLog.entries()).map(entry => entry.content), ["first", "done:first", "second", "done:second"]);
  await scope.dispose();
});

for (const status of ["running", "waiting_approval"] as const) test(`native job recovery from ${status} reads its checkpoint without repeating run or consuming a second turn`, async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  const inbox = new PersistentInbox(store, "execution-a");
  await inbox.enqueueInitial("original");
  await store.append({ executionId: "execution-a", type: "execution/status", payload: { status: "running" } });
  await inbox.beginTurn(1);
  await store.append({ executionId: "execution-a", type: "job/started", payload: { jobId: "product.workflow", turn: 1, generation: 1, authorityCommitment: authority.commitment } });
  if (status === "waiting_approval") await store.append({ executionId: "execution-a", type: "execution/status", payload: { status } });
  let runs = 0;
  let recoveries = 0;
  scope.register("job", { id: "product.workflow",
    async run() { runs += 1; throw new Error("must not replay"); },
    async recover(input) {
      assert.equal((await store.readExecution("execution-a")).filter(record => record.type === "execution/status").at(-1)?.payload.status, "running");
      recoveries += 1;
      assert.equal(input.message, "original");
      assert.equal(input.turn, 1);
      return { status: "completed", summary: "checkpoint-result" };
    },
  });
  const options = { executionId: "execution-a", scope, store,
    definition: { id: "product.agent", llmId: "unused", promptIds: [], jobId: "product.workflow" },
    authority, approval: approveAuthorizedTools };
  const handle = await AgentHandle.open(options);
  await handle.whenIdle();
  assert.equal(handle.status, "completed");
  assert.equal(runs, 0);
  assert.equal(recoveries, 1);
  const records = await store.readExecution("execution-a");
  assert.equal(records.filter(record => record.type === "turn/started").length, 1);
  assert.equal(records.filter(record => record.type === "job/started").length, 1);
  assert.equal(records.filter(record => record.type === "job/completed").length, 1);
  assert.equal((await AgentHandle.open(options)).status, "completed");
  assert.equal(recoveries, 1);
  await scope.dispose();
});

class ObservedStore extends InMemoryRuntimeStore {
  constructor(private readonly observed: string[]) {
    super();
  }

  override async append(input: RuntimeRecordInput) {
    this.observed.push(`persist:${input.type}`);
    return super.append(input);
  }
}

test("a steer committed at completion pauses instead of silently disappearing", async () => {
  let raced = false;
  class RacingStore extends InMemoryRuntimeStore {
    override async commit(executionId: string, expected: number, inputs: readonly RuntimeRecordInput[]) {
      if (!raced && inputs.some(input => input.type === "execution/status" && input.payload.status === "completed")) {
        raced = true;
        await super.append({ executionId, type: "inbox/enqueued", payload: { id: "late-steer", kind: "steer", text: "尚未应用的调整" } });
      }
      return super.commit(executionId, expected, inputs);
    }
  }
  const store = new RacingStore();
  const scope = executionScope();
  const requests: ModelRequest[] = [];
  scope.register("llm", { id: "main", async complete(request) {
    requests.push(request); return { text: "完成", toolCalls: [] };
  } });
  const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
    definition: { id: "agent", llmId: "main", promptIds: [] }, authority, approval: approveAuthorizedTools });
  await handle.start("首次要求");
  await handle.whenIdle();
  assert.equal(handle.status, "paused");
  assert.equal(requests.length, 1);
  assert.equal((await store.readExecution("execution-a")).some(record => record.type === "inbox/consumed" && record.payload.itemId === "late-steer"), false);
  await handle.resume();
  await handle.whenIdle();
  assert.equal(handle.status, "completed");
  assert.equal(requests.length, 2);
  assert.ok(requests[1]!.messages.some(message => message.role === "system" && message.content.includes("尚未应用的调整")));
  await scope.dispose();
});

test("消费输入、开始 turn 和原始消息在同一批次提交，终结竞争不会漏掉后续输入", async () => {
  let raced = false;
  let turnBatches = 0;
  class RacingStore extends InMemoryRuntimeStore {
    override async commit(executionId: string, expected: number, inputs: readonly RuntimeRecordInput[]) {
      if (inputs.some(input => input.type === "turn/started")) {
        assert.deepEqual(inputs.map(input => input.type), ["inbox/consumed", "turn/started", "session/entry"]);
        turnBatches += 1;
      }
      if (!raced && inputs.some(input => input.type === "execution/status" && input.payload.status === "completed")) {
        raced = true;
        await super.append({ executionId, type: "inbox/enqueued", payload: { id: "concurrent", kind: "follow_up", text: "终结前已提交的输入" } });
      }
      return super.commit(executionId, expected, inputs);
    }
  }
  const store = new RacingStore();
  const scope = executionScope();
  let calls = 0;
  scope.register("llm", { id: "main", complete: async () => { calls += 1; return { text: "完成", toolCalls: [] }; } });
  const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
    definition: { id: "agent", llmId: "main", promptIds: [] }, authority, approval: approveAuthorizedTools });
  await handle.followUp("首次输入");
  await handle.whenIdle();
  assert.equal(handle.status, "completed");
  assert.equal(calls, 2);
  assert.equal(turnBatches, 2);
  assert.deepEqual((await handle.sessionLog.entries()).filter(entry => entry.role === "user").map(entry => entry.content), ["首次输入", "终结前已提交的输入"]);
  await scope.dispose();
});

test("Worker 启动前收到的 follow_up 不会排在首次输入之前", async () => {
  const store = new InMemoryRuntimeStore();
  await store.append({ executionId: "execution-a", type: "inbox/enqueued", payload: { id: "early", kind: "follow_up", text: "后续要求" } });
  const scope = executionScope();
  const messages: string[] = [];
  scope.register("llm", { id: "main", complete: async (request) => {
    messages.push(request.messages.at(-1)!.content);
    return { text: "完成", toolCalls: [] };
  } });
  const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
    definition: { id: "agent", llmId: "main", promptIds: [] }, authority, approval: approveAuthorizedTools });
  await handle.start("首次要求");
  await handle.whenIdle();
  assert.deepEqual(messages, ["首次要求", "后续要求"]);
  assert.equal(handle.status, "completed");
  await scope.dispose();
});

test("动态权限上下文在每个模型边界刷新，贡献 generation 保持固定", async () => {
  const scope = executionScope();
  let visible = true;
  let calls = 0;
  scope.register("prompt", { id: "memory", refreshAtBoundary: true,
    render: () => visible ? "已授权记忆" : "没有可读记忆" });
  scope.register("tool", { id: "file.read", version: "1.0.0", effectClass: "local_read",
    prepare: () => ({ normalizedArguments: {}, resourceRefs: [{ namespace: "workspace", resourceId: "repository" }] }),
    execute: async () => { visible = false; return {}; } });
  scope.register("llm", { id: "main", complete: async (request) => {
    calls += 1;
    assert.equal(request.generation, 1);
    assert.equal(request.messages[0]?.content, calls === 1 ? "已授权记忆" : "没有可读记忆");
    return { text: "", toolCalls: calls === 1 ? [{ id: "read", toolId: "file.read", arguments: {} }] : [] };
  } });
  const handle = await AgentHandle.open({ executionId: "execution-a", scope,
    store: new InMemoryRuntimeStore(), definition: { id: "agent", llmId: "main", promptIds: ["memory"] },
    authority, approval: approveAuthorizedTools });
  await handle.followUp("检查");
  await handle.whenIdle();
  assert.equal(handle.status, "completed");
  assert.equal(calls, 2);
});

test("模型上下文和工具承诺均先持久化再产生外部调用", async () => {
  const observed: string[] = [];
  const store = new ObservedStore(observed);
  const scope = executionScope();
  scope.register("prompt", { id: "system", render: () => "系统约束" });
  let modelCall = 0;
  const model: LlmContribution = {
    id: "main",
    async complete(request) {
      observed.push("model");
      modelCall += 1;
      if (modelCall === 1) {
        return {
          text: "准备读取",
          toolCalls: [{ id: "call-a", toolId: "file.read", arguments: { path: "README.md" } }],
        };
      }
      assert.match(request.messages.map((message) => message.content).join("\n"), /读取完成/u);
      return { text: "完成", toolCalls: [] };
    },
  };
  const tool: ToolContribution = {
    id: "file.read",
    version: "1.0.0",
    effectClass: "local_read",
    prepare: (arguments_) => ({
      normalizedArguments: arguments_,
      resourceRefs: [{ namespace: "workspace", resourceId: "repository" }],
    }),
    async execute() {
      observed.push("tool");
      return { text: "读取完成" };
    },
  };
  scope.register("llm", model);
  scope.register("tool", tool);
  const handle = await AgentHandle.open({
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: ["system"] },
    authority,
    approval: approveAuthorizedTools,
  });

  await handle.followUp("检查仓库");
  await handle.whenIdle();

  assert.equal(handle.status, "completed");
  assert.ok(observed.indexOf("persist:model/request") < observed.indexOf("model"));
  assert.ok(observed.indexOf("persist:tool/intent") < observed.indexOf("tool"));
  const intent = (await store.readExecution("execution-a")).find((record) => record.type === "tool/intent");
  assert.deepEqual(Object.keys(intent?.payload ?? {}).sort(), [
    "argumentsDigest",
    "authorityCommitment",
    "boundary",
    "effectClass",
    "expiresAt",
    "generation",
    "intent",
    "normalizedArguments",
    "resourceRefs",
    "resourcesDigest",
    "toolCallId",
    "toolId",
    "toolVersion",
    "turn",
  ]);
});

test("follow_up 保持 FIFO；turn 内 generation 固定，HMR 只切换下一 turn", async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: Array<{ readonly model: string; readonly request: ModelRequest }> = [];
  let oldDisposed = false;
  const oldModel: LlmContribution = {
    id: "main",
    dispose: () => { oldDisposed = true; },
    async complete(request) {
      calls.push({ model: "old", request });
      await gate;
      assert.equal(oldDisposed, false);
      return { text: "第一轮完成", toolCalls: [] };
    },
  };
  const newModel: LlmContribution = {
    id: "main",
    async complete(request) {
      calls.push({ model: "new", request });
      return { text: "第二轮完成", toolCalls: [] };
    },
  };
  scope.register("llm", oldModel);
  const handle = await AgentHandle.open({
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority,
    approval: approveAuthorizedTools,
  });

  await handle.followUp("第一步");
  while (calls.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  scope.register("llm", newModel);
  await handle.followUp("第二步");
  release();
  await handle.whenIdle();

  assert.deepEqual(calls.map((call) => call.model), ["old", "new"]);
  assert.match(calls[0]?.request.messages.at(-1)?.content ?? "", /第一步/u);
  assert.match(calls[1]?.request.messages.at(-1)?.content ?? "", /第二步/u);
  assert.ok((calls[1]?.request.generation ?? 0) > (calls[0]?.request.generation ?? 0));
  assert.equal(oldDisposed, false);
  const tenantScope = scope.parent?.parent?.parent;
  assert.equal(tenantScope?.level, "tenant");
  await tenantScope?.dispose();
  assert.equal(oldDisposed, true);
});

test("steer 不进入在途请求，只在下一模型边界注入", async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requests: ModelRequest[] = [];
  const model: LlmContribution = {
    id: "main",
    async complete(request) {
      requests.push(request);
      if (requests.length === 1) {
        await gate;
        return {
          text: "先读取",
          toolCalls: [{ id: "call-a", toolId: "file.read", arguments: { path: "README.md" } }],
        };
      }
      return { text: "按纠偏完成", toolCalls: [] };
    },
  };
  scope.register("llm", model);
  scope.register("tool", {
    id: "file.read",
    version: "1.0.0",
    effectClass: "local_read",
    prepare: (arguments_) => ({
      normalizedArguments: arguments_,
      resourceRefs: [{ namespace: "workspace", resourceId: "repository" }],
    }),
    execute: async () => ({ text: "内容" }),
  });
  const handle = await AgentHandle.open({
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority,
    approval: approveAuthorizedTools,
  });

  await handle.followUp("开始");
  while (requests.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  await handle.steer("优先找反证");
  assert.doesNotMatch(requests[0]?.messages.map((entry) => entry.content).join("\n") ?? "", /优先找反证/u);
  release();
  await handle.whenIdle();

  assert.match(requests[1]?.messages.map((entry) => entry.content).join("\n") ?? "", /优先找反证/u);
});

test("cancel 中止在途模型；resume 只接受 paused 或 interrupted", async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  scope.register("llm", {
    id: "main",
    complete: async (_request, context) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { text: "不可达", toolCalls: [] };
    },
  });
  const handle = await AgentHandle.open({
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority,
    approval: approveAuthorizedTools,
  });
  await handle.followUp("开始");
  await modelStarted;
  await handle.cancel("用户取消");
  await handle.whenIdle();
  assert.equal(handle.status, "cancelled");
  await assert.rejects(() => handle.resume(), /paused|interrupted/u);

  for (const status of ["paused", "interrupted"] as const) {
    const resumedStore = new InMemoryRuntimeStore();
    await resumedStore.append({ executionId: `execution-${status}`, type: "execution/status", payload: { status } });
    const resumed = await AgentHandle.open({
      executionId: `execution-${status}`,
      scope: executionScope(),
      store: resumedStore,
      definition: { id: "assistant", llmId: "main", promptIds: [] },
      authority,
      approval: approveAuthorizedTools,
    });
    await resumed.resume();
    await resumed.whenIdle();
    assert.equal(resumed.status, "completed");
  }
});

test("resume 先恢复中断 turn，再处理已排队的后续输入", async () => {
  const store = new InMemoryRuntimeStore();
  const inbox = new PersistentInbox(store, "execution-a");
  await inbox.enqueueInitial("original");
  await inbox.beginTurn(1);
  await store.append({ executionId: "execution-a", type: "execution/status", payload: { status: "interrupted" } });
  await inbox.enqueue("follow_up", "next");
  const scope = executionScope(2);
  const requests: ModelRequest[] = [];
  scope.register("llm", { id: "main", async complete(request) { requests.push(request); return { text: "done", toolCalls: [] }; } });
  const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
    definition: { id: "assistant", llmId: "main", promptIds: [] }, authority, approval: approveAuthorizedTools });
  await handle.resume();
  await handle.whenIdle();
  assert.equal(requests.length, 2);
  assert.ok(requests[0]!.messages.some(message => message.role === "system" && message.content.startsWith("[resume]")));
  assert.equal(requests[0]!.messages.some(message => message.content === "next"), false);
  assert.ok(requests[1]!.messages.some(message => message.content === "next"));
});

test("resume 用新 generation 继续中断 turn，不复用旧模型请求", async () => {
  const store = new InMemoryRuntimeStore();
  const firstScope = executionScope(1);
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  firstScope.register("llm", {
    id: "main",
    async complete(_request, context) {
      firstStarted();
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { text: "不可达", toolCalls: [] };
    },
  });
  const first = await AgentHandle.open({
    executionId: "execution-a", scope: firstScope, store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority, approval: approveAuthorizedTools,
  });
  await first.followUp("整理中断前的证据");
  await started;
  await first.interrupt("Worker 已停止");
  await first.whenIdle();

  const requests: ModelRequest[] = [];
  const resumedScope = executionScope(2);
  resumedScope.register("llm", {
    id: "main",
    async complete(request) {
      requests.push(request);
      return { text: "已从持久上下文继续", toolCalls: [] };
    },
  });
  const resumed = await AgentHandle.open({
    executionId: "execution-a", scope: resumedScope, store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority, approval: approveAuthorizedTools,
  });
  await resumed.resume();
  await resumed.whenIdle();

  assert.equal(resumed.status, "completed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.generation, 2);
  assert.ok(requests[0]?.messages.some((message) =>
    message.role === "user" && message.content === "整理中断前的证据"));
  assert.ok(requests[0]?.messages.some((message) =>
    message.role === "system" && message.content.startsWith("[resume]")));
  const records = await store.readExecution("execution-a");
  assert.equal(records.filter((record) => record.type === "model/request").length, 2);
  assert.deepEqual(records
    .filter((record) => record.type === "model/request")
    .map((record) => record.payload.generation), [1, 2]);
});

test("native job 的工具已开始但结果未知时，resume 不重放工作流", async () => {
  const store = new InMemoryRuntimeStore();
  await store.append({ executionId: "execution-a", type: "execution/status", payload: { status: "running" } });
  await store.append({ executionId: "execution-a", type: "tool/intent", payload: {
    toolCallId: "native-external", toolId: "web.publish", effectClass: "external_side_effect",
  } });
  await store.append({ executionId: "execution-a", type: "tool/started", payload: { toolCallId: "native-external" } });
  await store.append({ executionId: "execution-a", type: "execution/status", payload: { status: "interrupted" } });
  const scope = executionScope(2);
  let calls = 0;
  scope.register("job", { id: "native", async run() { calls++; return { status: "completed" }; } });
  const handle = await AgentHandle.open({ executionId: "execution-a", scope, store,
    definition: { id: "assistant", llmId: "unused", promptIds: [], jobId: "native" }, authority, approval: approveAuthorizedTools });
  await handle.resume();
  await handle.whenIdle();
  assert.equal(handle.status, "needs_reconciliation");
  assert.equal(calls, 0);
});

test("resume 不重放中断前结果未知的高影响工具", async () => {
  const store = new InMemoryRuntimeStore();
  await store.append({ executionId: "execution-a", type: "execution/status", payload: { status: "running" } });
  await store.append({ executionId: "execution-a", type: "turn/started", payload: { turn: 1, generation: 1 } });
  await store.append({
    executionId: "execution-a", type: "tool/intent", payload: {
      toolCallId: "publish", toolId: "web.publish", toolVersion: "1.0.0",
      effectClass: "external_side_effect", generation: 1, intent: "发布",
    },
  });
  await store.append({ executionId: "execution-a", type: "execution/status", payload: { status: "waiting_approval" } });
  await store.append({ executionId: "execution-a", type: "execution/status", payload: { status: "running" } });
  await store.append({ executionId: "execution-a", type: "execution/status", payload: { status: "interrupted" } });
  let modelCalls = 0;
  const scope = executionScope(2);
  scope.register("llm", {
    id: "main", async complete() { modelCalls += 1; return { text: "不可达", toolCalls: [] }; },
  });
  const resumed = await AgentHandle.open({
    executionId: "execution-a", scope, store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority, approval: approveAuthorizedTools,
  });
  await resumed.resume();
  assert.equal(resumed.status, "needs_reconciliation");
  assert.equal(modelCalls, 0);
  assert.ok((await store.readExecution("execution-a"))
    .some((record) => record.type === "tool/outcome_unknown"));
});

test("Worker 停止会把在途模型标记为 interrupted", async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  scope.register("llm", {
    id: "main",
    complete: async (_request, context) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { text: "不可达", toolCalls: [] };
    },
  });
  const handle = await AgentHandle.open({
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority,
    approval: approveAuthorizedTools,
  });
  await handle.followUp("开始");
  await modelStarted;
  await handle.interrupt("Worker 已停止");
  await handle.whenIdle();
  assert.equal(handle.status, "interrupted");
  assert.equal((await store.readExecution("execution-a")).at(-1)?.payload.status, "interrupted");
});

test("不确定外部副作用进入 needs_reconciliation，重启后不自动重放", async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  let executions = 0;
  scope.register("llm", {
    id: "main",
    complete: async () => ({
      text: "发布",
      toolCalls: [{ id: "publish-a", toolId: "web.publish", arguments: { body: "draft" } }],
    }),
  });
  scope.register("tool", {
    id: "web.publish",
    version: "1.0.0",
    effectClass: "external_side_effect",
    prepare: (arguments_) => ({
      normalizedArguments: arguments_,
      resourceRefs: [{ namespace: "web", resourceId: "target" }],
    }),
    execute: async () => {
      executions += 1;
      throw new UnknownToolOutcomeError("连接在提交后中断");
    },
  });
  const options = {
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority,
    approval: approveAuthorizedTools,
  } as const;
  const handle = await AgentHandle.open(options);
  await handle.followUp("发布");
  await handle.whenIdle();

  assert.equal(handle.status, "needs_reconciliation");
  assert.equal(executions, 1);
  await assert.rejects(() => handle.resume(), /paused|interrupted/u);
  await assert.rejects(() => handle.followUp("重试"), /人工核对/u);

  const recovered = await AgentHandle.open(options);
  await recovered.whenIdle();
  assert.equal(recovered.status, "needs_reconciliation");
  assert.equal(executions, 1);
  assert.ok((await store.readExecution("execution-a")).some((record) => record.type === "tool/outcome_unknown"));
});

test("重启发现未闭合的外部工具意图时直接进入人工核对", async () => {
  const store = new InMemoryRuntimeStore();
  await store.append({ executionId: "execution-a", type: "execution/status", payload: { status: "running" } });
  await store.append({
    executionId: "execution-a",
    type: "tool/intent",
    payload: {
      toolCallId: "publish-before-crash",
      toolId: "web.publish",
      toolVersion: "1.0.0",
      effectClass: "external_side_effect",
      intent: "发布内容",
      normalizedArguments: { body: "draft" },
      argumentsDigest: "args",
      resourceRefs: [{ namespace: "web", resourceId: "target" }],
      resourcesDigest: "resources",
      generation: 1,
      authorityCommitment: authority.commitment,
    },
  });

  const recovered = await AgentHandle.open({
    executionId: "execution-a",
    scope: executionScope(),
    store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority,
    approval: approveAuthorizedTools,
  });

  assert.equal(recovered.status, "needs_reconciliation");
  const records = await store.readExecution("execution-a");
  assert.equal(records.filter((record) => record.type === "tool/outcome_unknown").length, 1);
  assert.equal(records.at(-1)?.payload.status, "needs_reconciliation");
});

test("人工副作用在中央批准完成前绝不执行", async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  let modelCalls = 0;
  let executions = 0;
  let observedIntent: Parameters<ToolApprovalPort["authorize"]>[0] | undefined;
  let approve!: () => void;
  const decision = new Promise<void>((resolve) => { approve = resolve; });
  scope.register("llm", {
    id: "main",
    async complete() {
      modelCalls += 1;
      return modelCalls === 1
        ? { text: "准备发布", toolCalls: [{ id: "publish", toolId: "web.publish", arguments: { body: "draft" } }] }
        : { text: "完成", toolCalls: [] };
    },
  });
  scope.register("tool", {
    id: "web.publish",
    version: "1.0.0",
    effectClass: "external_side_effect",
    prepare: (arguments_) => ({
      normalizedArguments: arguments_,
      resourceRefs: [{ namespace: "web", resourceId: "target" }],
    }),
    async execute() { executions += 1; return { published: true }; },
  });
  const handle = await AgentHandle.open({
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority,
    approval: {
      async authorize(intent) {
        observedIntent = intent;
        await decision;
        return { mode: "approve_once", approvedIntent: intent };
      },
    },
  });

  await handle.followUp("发布内容");
  while (observedIntent === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(handle.status, "waiting_approval");
  assert.equal(executions, 0);
  assert.ok((await store.readExecution("execution-a")).some((record) => record.type === "tool/intent"));

  approve();
  await handle.whenIdle();
  assert.equal(executions, 1);
  assert.equal(handle.status, "completed");
});

test("等待批准时取消会中止授权等待且绝不执行工具", async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  let executions = 0;
  let approvalStarted!: () => void;
  const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
  scope.register("llm", {
    id: "main",
    async complete() {
      return { text: "发布", toolCalls: [{ id: "publish", toolId: "web.publish", arguments: {} }] };
    },
  });
  scope.register("tool", {
    id: "web.publish",
    version: "1.0.0",
    effectClass: "external_side_effect",
    prepare: (arguments_) => ({
      normalizedArguments: arguments_,
      resourceRefs: [{ namespace: "web", resourceId: "target" }],
    }),
    async execute() { executions += 1; return { published: true }; },
  });
  const handle = await AgentHandle.open({
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority,
    approval: {
      authorize(_intent, signal) {
        approvalStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("approval aborted")), { once: true });
        });
      },
    },
  });

  await handle.followUp("发布内容");
  await started;
  await handle.cancel("用户取消");
  await handle.whenIdle();
  assert.equal(handle.status, "cancelled");
  assert.equal(executions, 0);
});

test("批准后执行会复核代次、工具版本、参数、资源和权限承诺", async (t) => {
  const staleFields = {
    generation: (intent: Parameters<ToolApprovalPort["authorize"]>[0]) => ({ ...intent, generation: intent.generation + 1 }),
    toolVersion: (intent: Parameters<ToolApprovalPort["authorize"]>[0]) => ({ ...intent, toolVersion: "2.0.0" }),
    argumentsDigest: (intent: Parameters<ToolApprovalPort["authorize"]>[0]) => ({ ...intent, argumentsDigest: "stale-arguments" }),
    resourcesDigest: (intent: Parameters<ToolApprovalPort["authorize"]>[0]) => ({ ...intent, resourcesDigest: "stale-resources" }),
    authorityCommitment: (intent: Parameters<ToolApprovalPort["authorize"]>[0]) => ({ ...intent, authorityCommitment: "stale-authority" }),
  } as const;

  for (const [field, makeStale] of Object.entries(staleFields)) {
    await t.test(field, async () => {
      const store = new InMemoryRuntimeStore();
      const scope = executionScope();
      let executions = 0;
      scope.register("llm", {
        id: "main",
        async complete() {
          return { text: "发布", toolCalls: [{ id: `publish-${field}`, toolId: "web.publish", arguments: { body: "draft" } }] };
        },
      });
      scope.register("tool", {
        id: "web.publish",
        version: "1.0.0",
        effectClass: "external_side_effect",
        prepare: (arguments_) => ({
          normalizedArguments: arguments_,
          resourceRefs: [{ namespace: "web", resourceId: "target" }],
        }),
        async execute() { executions += 1; return { published: true }; },
      });
      const handle = await AgentHandle.open({
        executionId: "execution-a",
        scope,
        store,
        definition: { id: "assistant", llmId: "main", promptIds: [] },
        authority,
        approval: {
          async authorize(intent) {
            return { mode: "approve_once", approvedIntent: makeStale(intent) };
          },
        },
      });
      await handle.followUp("发布内容");
      await handle.whenIdle();
      assert.equal(executions, 0);
      assert.equal(handle.status, "failed");
    });
  }
});

test("执行前复核期间发生 HMR 会使批准失效", async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  let modelCalls = 0;
  let prepares = 0;
  let executions = 0;
  scope.register("llm", {
    id: "main",
    async complete() {
      modelCalls += 1;
      return modelCalls === 1
        ? { text: "发布", toolCalls: [{ id: "publish", toolId: "web.publish", arguments: {} }] }
        : { text: "完成", toolCalls: [] };
    },
  });
  scope.register("tool", {
    id: "web.publish",
    version: "1.0.0",
    effectClass: "external_side_effect",
    prepare: (arguments_) => {
      prepares += 1;
      if (prepares === 2) {
        scope.register("prompt", { id: "hot-reload", render: () => "新提示" });
      }
      return {
        normalizedArguments: arguments_,
        resourceRefs: [{ namespace: "web", resourceId: "target" }],
      };
    },
    async execute() { executions += 1; return { published: true }; },
  });
  const handle = await AgentHandle.open({
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority,
    approval: approveAuthorizedTools,
  });

  await handle.followUp("发布内容");
  await handle.whenIdle();
  assert.equal(executions, 0);
  assert.equal(handle.status, "failed");
});

test("等待审批时重启会从已落盘响应续接，且不重发模型请求或重复已完成工具", async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  let modelCalls = 0;
  let reads = 0;
  let publishes = 0;
  let approvalStarted!: () => void;
  const waiting = new Promise<void>((resolve) => { approvalStarted = resolve; });

  scope.register("prompt", { id: "system", render: () => "只执行已批准的操作" });
  scope.register("llm", {
    id: "main",
    async complete(request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          text: "先读后发",
          toolCalls: [
            { id: "read", toolId: "file.read", arguments: { path: "README.md" } },
            { id: "publish", toolId: "web.publish", arguments: { body: "draft" } },
          ] as readonly ModelToolCall[],
        };
      }
      assert.match(request.messages.map((message) => message.content).join("\n"), /已读取/u);
      assert.match(request.messages.map((message) => message.content).join("\n"), /published/u);
      return { text: "完成", toolCalls: [] };
    },
  });
  scope.register("tool", {
    id: "file.read",
    version: "1.0.0",
    effectClass: "local_read",
    prepare: (arguments_) => ({
      normalizedArguments: arguments_,
      resourceRefs: [{ namespace: "workspace", resourceId: "repository" }],
    }),
    async execute() { reads += 1; return { text: "已读取" }; },
  });
  scope.register("tool", {
    id: "web.publish",
    version: "1.0.0",
    effectClass: "external_side_effect",
    prepare: (arguments_) => ({
      normalizedArguments: arguments_,
      resourceRefs: [{ namespace: "web", resourceId: "target" }],
    }),
    async execute() { publishes += 1; return { published: true }; },
  });

  const first = await AgentHandle.open({
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: ["system"] },
    authority,
    approval: {
      async authorize(intent) {
        if (intent.effectClass === "local_read") return { mode: "auto", intent };
        approvalStarted();
        return new Promise(() => {});
      },
    },
  });
  await first.followUp("发布草稿");
  await waiting;
  assert.equal(first.status, "waiting_approval");
  assert.equal(modelCalls, 1);
  assert.equal(reads, 1);
  assert.equal(publishes, 0);

  const recovered = await AgentHandle.open({
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: ["system"] },
    authority,
    approval: approveAuthorizedTools,
  });
  await recovered.whenIdle();

  assert.equal(recovered.status, "completed");
  assert.equal(modelCalls, 2);
  assert.equal(reads, 1);
  assert.equal(publishes, 1);
  const records = await store.readExecution("execution-a");
  const modelRequests = records.filter((record) => record.type === "model/request");
  assert.equal(modelRequests.length, 2);
  assert.deepEqual(modelRequests.map((record) => record.payload.boundary), [1, 2]);
  assert.equal(records.filter((record) => record.type === "tool/intent").length, 2);
  assert.equal(records.filter((record) => record.type === "tool/result").length, 2);
});

test("等待审批时重启后拒绝会失败，且不会重发模型请求或执行工具", async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  let modelCalls = 0;
  let executions = 0;
  let approvalStarted!: () => void;
  const waiting = new Promise<void>((resolve) => { approvalStarted = resolve; });
  scope.register("llm", {
    id: "main",
    async complete() {
      modelCalls += 1;
      return { text: "发布", toolCalls: [{ id: "publish", toolId: "web.publish", arguments: {} }] };
    },
  });
  scope.register("tool", {
    id: "web.publish",
    version: "1.0.0",
    effectClass: "external_side_effect",
    prepare: (arguments_) => ({
      normalizedArguments: arguments_,
      resourceRefs: [{ namespace: "web", resourceId: "target" }],
    }),
    async execute() { executions += 1; return { published: true }; },
  });
  const options = {
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority,
  } as const;
  const first = await AgentHandle.open({
    ...options,
    approval: {
      async authorize() {
        approvalStarted();
        return new Promise(() => {});
      },
    },
  });
  await first.followUp("发布");
  await waiting;

  const recovered = await AgentHandle.open({
    ...options,
    approval: { async authorize() { return { mode: "deny", reason: "审核拒绝" }; } },
  });
  await recovered.whenIdle();

  assert.equal(recovered.status, "failed");
  assert.match(String(recovered.lastError), /审核拒绝/u);
  assert.equal(modelCalls, 1);
  assert.equal(executions, 0);
  const records = await store.readExecution("execution-a");
  assert.equal(records.filter((record) => record.type === "model/request").length, 1);
  assert.equal(records.filter((record) => record.type === "tool/result").length, 0);
});

test("恢复等待审批的工具会复核固定代次、工具、参数、资源、权限和期限", async (t) => {
  const scenarios = [
    "generation",
    "toolVersion",
    "effectClass",
    "arguments",
    "resources",
    "authority",
    "expiry",
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario, async () => {
      const store = new InMemoryRuntimeStore();
      const scope = executionScope();
      let toolVersion = "1.0.0";
      let effectClass: ToolContribution["effectClass"] = "external_side_effect";
      let normalizedBody = "draft";
      let resourceId = "target";
      let executions = 0;
      let approvalStarted!: () => void;
      const waiting = new Promise<void>((resolve) => { approvalStarted = resolve; });
      scope.register("llm", {
        id: "main",
        async complete() {
          return {
            text: "发布",
            toolCalls: [{ id: "publish", toolId: "web.publish", arguments: { body: "draft" } }],
          };
        },
      });
      scope.register("tool", {
        id: "web.publish",
        get version() { return toolVersion; },
        get effectClass() { return effectClass; },
        prepare: () => ({
          normalizedArguments: { body: normalizedBody },
          resourceRefs: [{ namespace: "web", resourceId }],
        }),
        async execute() { executions += 1; return { published: true }; },
      });
      const fixedNow = "2026-09-04T10:00:00.000Z";
      const first = await AgentHandle.open({
        executionId: "execution-a",
        scope,
        store,
        definition: { id: "assistant", llmId: "main", promptIds: [] },
        authority,
        approval: {
          async authorize() {
            approvalStarted();
            return new Promise(() => {});
          },
        },
        now: () => fixedNow,
      });
      await first.followUp("发布");
      await waiting;

      if (scenario === "generation") {
        scope.register("prompt", { id: "changed", render: () => "变更" });
      } else if (scenario === "toolVersion") {
        toolVersion = "2.0.0";
      } else if (scenario === "effectClass") {
        effectClass = "financial";
      } else if (scenario === "arguments") {
        normalizedBody = "changed";
      } else if (scenario === "resources") {
        resourceId = "changed";
      }

      const recovered = await AgentHandle.open({
        executionId: "execution-a",
        scope,
        store,
        definition: { id: "assistant", llmId: "main", promptIds: [] },
        authority: scenario === "authority"
          ? { ...authority, commitment: "authority-v2" }
          : authority,
        approval: approveAuthorizedTools,
        now: () => scenario === "expiry" ? "2026-09-04T10:06:00.000Z" : fixedNow,
      });
      await recovered.whenIdle();

      assert.equal(recovered.status, "failed");
      assert.equal(executions, 0);
    });
  }
});

test("批准后非幂等副作用在结果落盘前崩溃，重启进入人工核对且不重放", async () => {
  const store = new InMemoryRuntimeStore();
  const scope = executionScope();
  let executions = 0;
  let executionStarted!: () => void;
  const started = new Promise<void>((resolve) => { executionStarted = resolve; });
  scope.register("llm", {
    id: "main",
    async complete() {
      return { text: "发布", toolCalls: [{ id: "publish", toolId: "web.publish", arguments: {} }] };
    },
  });
  scope.register("tool", {
    id: "web.publish",
    version: "1.0.0",
    effectClass: "external_side_effect",
    prepare: (arguments_) => ({
      normalizedArguments: arguments_,
      resourceRefs: [{ namespace: "web", resourceId: "target" }],
    }),
    execute: async () => {
      executions += 1;
      executionStarted();
      return new Promise(() => {});
    },
  });
  const options = {
    executionId: "execution-a",
    scope,
    store,
    definition: { id: "assistant", llmId: "main", promptIds: [] },
    authority,
    approval: approveAuthorizedTools,
  } as const;
  const first = await AgentHandle.open(options);
  await first.followUp("发布");
  await started;
  assert.equal(first.status, "running");

  const recovered = await AgentHandle.open(options);
  await recovered.whenIdle();

  assert.equal(recovered.status, "needs_reconciliation");
  assert.equal(executions, 1);
  const records = await store.readExecution("execution-a");
  assert.equal(records.filter((record) => record.type === "tool/outcome_unknown").length, 1);
});
