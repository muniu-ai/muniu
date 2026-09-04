// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentHandle,
  AgentScope,
  InMemoryRuntimeStore,
  UnknownToolOutcomeError,
  type LlmContribution,
  type ModelRequest,
  type RuntimeAuthority,
  type RuntimeRecordInput,
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

function executionScope(): AgentScope {
  return AgentScope.tenant("tenant-a")
    .createChild("workspace", "workspace-a")
    .createChild("thread", "thread-a")
    .createChild("execution", "execution-a");
}

class ObservedStore extends InMemoryRuntimeStore {
  constructor(private readonly observed: string[]) {
    super();
  }

  override async append(input: RuntimeRecordInput) {
    this.observed.push(`persist:${input.type}`);
    return super.append(input);
  }
}

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
    "effectClass",
    "generation",
    "intent",
    "normalizedArguments",
    "resourceRefs",
    "resourcesDigest",
    "toolCallId",
    "toolId",
    "toolVersion",
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
    });
    await resumed.resume();
    assert.equal(resumed.status, "queued");
  }
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
  });

  assert.equal(recovered.status, "needs_reconciliation");
  const records = await store.readExecution("execution-a");
  assert.equal(records.filter((record) => record.type === "tool/outcome_unknown").length, 1);
  assert.equal(records.at(-1)?.payload.status, "needs_reconciliation");
});
