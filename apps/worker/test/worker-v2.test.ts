import assert from "node:assert/strict";
import test from "node:test";
import type { Approval, JsonObject, JsonValue, ToolCallIntent } from "@mn/contracts";
import {
  StaleFencingTokenError,
  type JobClaimOptions,
  type StoredJob,
} from "@mn/storage";
import {
  AgentOsWorker,
  AgentExecutionInterruptedError,
  AgentExecutionCancelledError,
  createByokModelInvoker,
  createAgentTurnHandler,
  createKernelToolApprovalPort,
  runWorkerLoop,
  UnknownExternalSideEffectError,
  WORKER_LEASE_MILLISECONDS,
  workerHandlerReadiness,
  workerReadiness,
  type WorkerJobStore,
} from "../src/index.js";

const approvalIntent: ToolCallIntent = {
  id: "call-approval-1",
  executionId: "execution-1",
  generation: 1,
  toolId: "external.publish",
  toolVersion: "1.0.0",
  effectClass: "external_side_effect",
  intent: "发布验证页面",
  normalizedArguments: { url: "https://example.com" },
  argumentsDigest: "arguments",
  resourceRefs: [{ namespace: "web", resourceId: "https://example.com" }],
  resourcesDigest: "resources",
  authorityCommitment: "authority",
  expiresAt: "2026-09-04T00:05:00.000Z",
};

const modelRequest = {
  executionId: "execution-1",
  agentId: "opc.opportunity-validator",
  generation: 1,
  messages: [
    { role: "system" as const, content: "只陈述已有证据" },
    { role: "user" as const, content: "整理证据缺口" },
  ],
  availableToolIds: [],
};

function job(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    id: "job-1", tenantId: "local", workspaceId: "workspace-1", kind: "tool.execute",
    payload: { executionId: "execution-1" }, status: "leased", attempts: 1,
    availableAt: "2026-09-04T00:00:00.000Z", leaseOwner: "worker-1",
    leaseExpiresAt: "2026-09-04T00:00:30.000Z", fencingToken: 7,
    idempotencyKey: "job-key", createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z", ...overrides,
  };
}

class FakeStore implements WorkerJobStore {
  claimed: StoredJob | undefined = job();
  completed: Array<[string, number, JsonValue]> = [];
  failed: Array<[string, number, JsonObject]> = [];
  interrupted: Array<[string, number, string]> = [];
  reconciliations: string[] = [];
  renewals = 0;
  renewFailure: unknown;
  claims = 0;
  lastClaimOptions: JobClaimOptions | undefined;
  async claimJob(_workerId: string, _now: string, options?: JobClaimOptions) {
    this.claims += 1;
    this.lastClaimOptions = options;
    const value = this.claimed;
    this.claimed = undefined;
    return value;
  }
  async completeJob(id: string, _worker: string, token: number, result: JsonValue) { this.completed.push([id, token, result]); }
  async failJob(id: string, _worker: string, token: number, failure: JsonObject) { this.failed.push([id, token, failure]); }
  async interruptJob(id: string, _worker: string, token: number, reason: string) {
    this.interrupted.push([id, token, reason]);
  }
  async renewJobLease() {
    this.renewals += 1;
    if (this.renewFailure !== undefined) throw this.renewFailure;
  }
  async markNeedsReconciliation(executionId: string) { this.reconciliations.push(executionId); }
}

test("Worker 使用固定 30 秒租约并在 lock 不一致时拒绝 claim", async () => {
  assert.equal(WORKER_LEASE_MILLISECONDS, 30_000);
  assert.equal(workerReadiness({
    engineLockDigest: "host", expectedEngineLockDigest: "worker",
    pluginLockDigest: "same", expectedPluginLockDigest: "same",
  }).ready, false);
  const store = new FakeStore();
  const worker = new AgentOsWorker({
    id: "worker-1", store,
    lock: { engineLockDigest: "host", expectedEngineLockDigest: "worker", pluginLockDigest: "x", expectedPluginLockDigest: "x" },
    handlers: {},
  });
  assert.equal((await worker.pollOnce()).status, "not_ready");
  assert.equal(store.claims, 0);
});

test("Worker readiness 校验受信 kind 声明，并且只 claim 已注册 handler", async () => {
  const handler = async () => ({ ok: true });
  assert.equal(workerHandlerReadiness(
    { "coding.reconciliation.verify": handler },
    ["coding.reconciliation.verify"],
    ["coding.reconciliation.verify"],
  ).ready, true);
  assert.equal(workerHandlerReadiness(
    { "coding.reconciliation.verify": handler },
    ["coding.reconciliation.verify", "coding.sandbox.cleanup"],
  ).issues.some(({ code }) => code === "WORKER_HANDLER_DECLARATION_MISMATCH"), true);
  assert.equal(workerHandlerReadiness(
    { "coding.reconciliation.verify": handler },
    ["coding.reconciliation.verify"],
    ["coding.reconciliation.verify", "coding.sandbox.cleanup"],
  ).issues.some(({ code }) => code === "WORKER_DEPLOYMENT_CAPABILITY_MISMATCH"), true);

  const mismatchedStore = new FakeStore();
  const mismatched = new AgentOsWorker({
    id: "worker-mismatch",
    store: mismatchedStore,
    lock: {
      engineLockDigest: "same",
      expectedEngineLockDigest: "same",
      pluginLockDigest: "same",
      expectedPluginLockDigest: "same",
    },
    handlers: { "coding.reconciliation.verify": handler },
    kinds: ["coding.reconciliation.verify", "coding.sandbox.cleanup"],
  });
  assert.equal(mismatched.readiness().ready, false);
  assert.equal((await mismatched.pollOnce()).status, "not_ready");
  assert.equal(mismatchedStore.claims, 0);

  const store = new FakeStore();
  store.claimed = job({ kind: "coding.reconciliation.verify" });
  const worker = new AgentOsWorker({
    id: "worker-capability",
    store,
    lock: {
      engineLockDigest: "same",
      expectedEngineLockDigest: "same",
      pluginLockDigest: "same",
      expectedPluginLockDigest: "same",
    },
    handlers: { "coding.reconciliation.verify": handler },
  });
  assert.equal((await worker.pollOnce()).status, "completed");
  assert.deepEqual(store.lastClaimOptions?.kinds, ["coding.reconciliation.verify"]);
});

test("未知外部副作用不重放并进入人工核对", async () => {
  const store = new FakeStore();
  const worker = new AgentOsWorker({
    id: "worker-1", store,
    lock: { engineLockDigest: "a", expectedEngineLockDigest: "a", pluginLockDigest: "b", expectedPluginLockDigest: "b" },
    handlers: { "tool.execute": async () => { throw new UnknownExternalSideEffectError("execution-1"); } },
  });
  assert.deepEqual(await worker.pollOnce(), { status: "needs_reconciliation", jobId: "job-1" });
  assert.deepEqual(store.reconciliations, ["execution-1"]);
  assert.equal(store.completed.length, 0);
  assert.equal(store.failed.length, 0);
  assert.deepEqual(await worker.pollOnce(), { status: "idle" });
});

test("poll loop 会持续认领任务并可由 AbortSignal 安全停止", async () => {
  const store = new FakeStore();
  const abort = new AbortController();
  const worker = new AgentOsWorker({
    id: "worker-1", store,
    lock: { engineLockDigest: "a", expectedEngineLockDigest: "a", pluginLockDigest: "b", expectedPluginLockDigest: "b" },
    handlers: { "tool.execute": async () => { abort.abort(); return { ok: true }; } },
  });
  await runWorkerLoop(worker, { signal: abort.signal, idleDelayMs: 1 });
  assert.equal(store.completed.length, 1);
});

test("停止信号中断在途 handler，且不提交未知结果", async () => {
  const store = new FakeStore();
  const stop = new AbortController();
  let started!: () => void;
  const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
  const worker = new AgentOsWorker({
    id: "worker-1", store,
    lock: { engineLockDigest: "a", expectedEngineLockDigest: "a", pluginLockDigest: "b", expectedPluginLockDigest: "b" },
    handlers: {
      "tool.execute": async (_job, context) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
        });
        return { unreachable: true };
      },
    },
  });
  const polling = worker.pollOnce(stop.signal);
  await handlerStarted;
  stop.abort();
  assert.deepEqual(await polling, { status: "interrupted", jobId: "job-1" });
  assert.equal(store.completed.length, 0);
  assert.equal(store.failed.length, 0);
  assert.deepEqual(store.interrupted, [["job-1", 7, "Worker 已停止"]]);
});

test("续租失败先作废执行结果，再通知 handler 取消", async () => {
  const store = new FakeStore();
  store.renewFailure = new StaleFencingTokenError("job-1");
  const worker = new AgentOsWorker({
    id: "worker-1", store,
    lock: { engineLockDigest: "a", expectedEngineLockDigest: "a", pluginLockDigest: "b", expectedPluginLockDigest: "b" },
    leaseRenewIntervalMs: 1,
    handlers: {
      "tool.execute": async (_job, context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { stopped: true };
      },
    },
  });
  assert.deepEqual(await worker.pollOnce(), { status: "lost_lease", jobId: "job-1" });
  assert.equal(store.renewals, 1);
  assert.equal(store.completed.length, 0);
  assert.equal(store.failed.length, 0);
});

test("agent-turn handler 从持久配置打开 AgentHandle 并处理消息", async () => {
  const { AgentScope, InMemoryRuntimeStore } = await import("@mn/agent-runtime");
  const scope = AgentScope.tenant("local")
    .createChild("workspace", "workspace-1")
    .createChild("thread", "thread-1")
    .createChild("execution", "execution-1");
  scope.register("llm", { id: "main", async complete() { return { text: "完成", toolCalls: [] }; } });
  const handler = createAgentTurnHandler({
    resolveOptions: () => ({
      executionId: "execution-1", scope, store: new InMemoryRuntimeStore(),
      definition: { id: "coding.builtin", llmId: "main", promptIds: [] },
      authority: {
        commitment: "authority", toolIds: [], dataScopes: [], effectClasses: [],
        budget: { maxSubagentDepth: 0, maxSubagents: 0, maxTokens: 1000, maxCostMinorUnits: "0", currency: "CNY", maxDurationMs: 1000 },
      },
      approval: { async authorize(intent) { return { mode: "auto" as const, intent }; } },
    }),
  });
  const result = await handler(job({ kind: "agent.turn", payload: { executionId: "execution-1", message: "开始" } }), {
    workerId: "worker-1", fencingToken: 1,
    leaseExpiresAt: "2026-09-04T00:00:30.000Z", signal: new AbortController().signal,
  });
  assert.deepEqual(result, { executionId: "execution-1", status: "completed" });
});

test("Worker 重试已完成的 Agent turn 时不重复调用模型", async () => {
  const { AgentScope, InMemoryRuntimeStore } = await import("@mn/agent-runtime");
  const runtime = new InMemoryRuntimeStore();
  await runtime.append({
    executionId: "execution-1",
    type: "execution/status",
    payload: { status: "completed", reason: "模型结果已持久化" },
  });
  const scope = AgentScope.tenant("local")
    .createChild("workspace", "workspace-1")
    .createChild("thread", "thread-1")
    .createChild("execution", "execution-1");
  let calls = 0;
  scope.register("llm", {
    id: "main",
    async complete() { calls += 1; return { text: "不应调用", toolCalls: [] }; },
  });
  const handler = createAgentTurnHandler({
    resolveOptions: () => ({
      executionId: "execution-1", scope, store: runtime,
      definition: { id: "coding.builtin", llmId: "main", promptIds: [] },
      authority: {
        commitment: "authority", toolIds: [], dataScopes: [], effectClasses: [],
        budget: { maxSubagentDepth: 0, maxSubagents: 0, maxTokens: 1000, maxCostMinorUnits: "0", currency: "CNY", maxDurationMs: 1000 },
      },
      approval: { async authorize(intent) { return { mode: "auto" as const, intent }; } },
    }),
  });
  assert.deepEqual(await handler(job({
    kind: "agent.execution.run",
    payload: { executionId: "execution-1", message: "原始输入" },
  }), {
    workerId: "worker-2", fencingToken: 2,
    leaseExpiresAt: "2026-09-04T00:00:30.000Z", signal: new AbortController().signal,
  }), { executionId: "execution-1", status: "completed" });
  assert.equal(calls, 0);
});

test("resume Job 不需要原始 message，并以新 generation 继续持久化上下文", async () => {
  const {
    AgentScope, InMemoryRuntimeStore, PersistentSessionLog,
  } = await import("@mn/agent-runtime");
  const runtime = new InMemoryRuntimeStore();
  await runtime.append({ executionId: "execution-1", type: "execution/status", payload: { status: "running" } });
  await runtime.append({ executionId: "execution-1", type: "turn/started", payload: { turn: 1, generation: 1 } });
  await new PersistentSessionLog(runtime, "execution-1").append({
    role: "user", content: "原始任务", turn: 1,
  });
  await runtime.append({
    executionId: "execution-1", type: "model/request",
    payload: { turn: 1, boundary: 1, generation: 1 },
  });
  await runtime.append({ executionId: "execution-1", type: "execution/status", payload: { status: "interrupted" } });
  const scope = AgentScope.tenant("local", 2)
    .createChild("workspace", "workspace-1")
    .createChild("thread", "thread-1")
    .createChild("execution", "execution-1");
  const requests: Array<{ generation: number }> = [];
  scope.register("llm", {
    id: "main",
    async complete(request) { requests.push(request); return { text: "已恢复", toolCalls: [] }; },
  });
  const handler = createAgentTurnHandler({
    resolveOptions: () => ({
      executionId: "execution-1", scope, store: runtime,
      definition: { id: "coding.builtin", llmId: "main", promptIds: [] },
      authority: {
        commitment: "authority", toolIds: [], dataScopes: [], effectClasses: [],
        budget: { maxSubagentDepth: 0, maxSubagents: 0, maxTokens: 1000, maxCostMinorUnits: "0", currency: "CNY", maxDurationMs: 1000 },
      },
      approval: { async authorize(intent) { return { mode: "auto" as const, intent }; } },
    }),
  });
  assert.deepEqual(await handler(job({
    kind: "agent.execution.run",
    payload: { executionId: "execution-1", command: "resume", generation: 2 },
  }), {
    workerId: "worker-2", fencingToken: 2,
    leaseExpiresAt: "2026-09-04T00:00:30.000Z", signal: new AbortController().signal,
  }), { executionId: "execution-1", status: "completed" });
  assert.deepEqual(requests.map((request) => request.generation), [2]);
});

test("重领崩溃后的运行中 Agent Job 会转为 interrupted，不标为普通失败", async () => {
  const store = new FakeStore();
  const worker = new AgentOsWorker({
    id: "worker-1", store,
    lock: { engineLockDigest: "a", expectedEngineLockDigest: "a", pluginLockDigest: "b", expectedPluginLockDigest: "b" },
    handlers: { "tool.execute": async () => { throw new AgentExecutionInterruptedError("execution-1"); } },
  });
  assert.deepEqual(await worker.pollOnce(), { status: "interrupted", jobId: "job-1" });
  assert.deepEqual(store.interrupted, [["job-1", 7, "Agent turn 已中断，需要显式恢复"]]);
  assert.equal(store.failed.length, 0);
});

test("用户取消会终结物理 Job，且不会作为可重试失败处理", async () => {
  const store = new FakeStore();
  const worker = new AgentOsWorker({
    id: "worker-1", store,
    lock: { engineLockDigest: "a", expectedEngineLockDigest: "a", pluginLockDigest: "b", expectedPluginLockDigest: "b" },
    handlers: { "tool.execute": async () => { throw new AgentExecutionCancelledError("execution-1"); } },
  });
  assert.deepEqual(await worker.pollOnce(), { status: "cancelled", jobId: "job-1" });
  assert.equal(store.failed.length, 1);
  assert.deepEqual(store.failed[0]?.[2], {
    code: "EXECUTION_CANCELLED", message: "Agent turn 已由用户取消", retryable: false,
  });
});

test("内核审批端口只在同一持久化意图获单次批准后放行", async () => {
  const approval: Approval = {
    id: "approval-1", tenantId: "local", workspaceId: "workspace-1",
    executionId: "execution-1", toolCallId: approvalIntent.id,
    effectClass: approvalIntent.effectClass, intent: approvalIntent.intent,
    resourceRefs: approvalIntent.resourceRefs,
    authorityCommitment: approvalIntent.authorityCommitment,
    expiresAt: approvalIntent.expiresAt, status: "pending", streamVersion: 1,
    createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z",
  };
  let currentApproval = approval;
  const requested: ToolCallIntent[] = [];
  const projections = {
    async transact<T>(_tenantId: string, work: (transaction: {
      getProjection<U>(namespace: string, id: string): U | undefined;
    }) => T): Promise<T> {
      return work({
        getProjection<U>(namespace: string, id: string): U | undefined {
          if (namespace === "approval" && id === approval.id) return currentApproval as U;
          if (namespace === "toolIntent" && id === approvalIntent.id) return approvalIntent as U;
          return undefined;
        },
      });
    },
  };
  const port = createKernelToolApprovalPort({
    tenantId: "local", actorId: "agent:opc", store: projections,
    pollIntervalMs: 1,
    now: () => Date.parse("2026-09-04T00:00:02.000Z"),
    kernel: {
      async requestToolApproval(_tenantId, _actorId, key, intent) {
        assert.equal(key, "agent-runtime:execution-1:1:call-approval-1");
        requested.push(intent);
        return { mode: "approval" as const, approval };
      },
    },
  });
  const authorization = port.authorize(approvalIntent, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 2));
  currentApproval = {
    ...currentApproval,
    status: "approved_once",
    streamVersion: 2,
    decidedBy: "local-owner",
    decidedAt: "2026-09-04T00:00:01.000Z",
    updatedAt: "2026-09-04T00:00:01.000Z",
  };
  assert.deepEqual(await authorization, { mode: "approve_once", approvedIntent: approvalIntent });
  assert.deepEqual(requested, [approvalIntent]);
});

test("内核审批端口保留自动授权并响应取消", async (t) => {
  const projections = {
    async transact<T>(_tenantId: string, work: (transaction: {
      getProjection<U>(namespace: string, id: string): U | undefined;
    }) => T): Promise<T> {
      return work({ getProjection: () => undefined });
    },
  };
  await t.test("自动授权", async () => {
    const autoIntent = { ...approvalIntent, effectClass: "external_read" as const };
    const port = createKernelToolApprovalPort({
      tenantId: "local", actorId: "agent:opc", store: projections,
      kernel: { async requestToolApproval() { return { mode: "auto" as const, intent: autoIntent }; } },
    });
    assert.deepEqual(await port.authorize(autoIntent, new AbortController().signal), {
      mode: "auto", intent: autoIntent,
    });
  });
  await t.test("等待中取消", async () => {
    const controller = new AbortController();
    const port = createKernelToolApprovalPort({
      tenantId: "local", actorId: "agent:opc", store: projections, pollIntervalMs: 1,
      kernel: { async requestToolApproval() {
        return {
          mode: "approval" as const,
          approval: {
            ...({} as Approval), id: "missing", expiresAt: approvalIntent.expiresAt,
          },
        };
      } },
    });
    const waiting = port.authorize(approvalIntent, controller.signal);
    controller.abort();
    await assert.rejects(waiting, /已取消/u);
  });
});

test("成功结果必须携带当前 fencing token 提交", async () => {
  const store = new FakeStore();
  const worker = new AgentOsWorker({
    id: "worker-1", store,
    lock: { engineLockDigest: "a", expectedEngineLockDigest: "a", pluginLockDigest: "b", expectedPluginLockDigest: "b" },
    handlers: { "tool.execute": async () => ({ ok: true }) },
  });
  assert.deepEqual(await worker.pollOnce(), { status: "completed", jobId: "job-1" });
  assert.deepEqual(store.completed, [["job-1", 7, { ok: true }]]);
});

test("BYOK 模型调用按三家厂商的固定协议发送且只解析文本", async (t) => {
  await t.test("OpenAI 使用 Responses API 并禁用服务端存储", async () => {
    let called = false;
    const invoke = createByokModelInvoker({
      fetch: async (input, init) => {
        called = true;
        assert.equal(String(input), "https://api.openai.com/v1/responses");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer openai-key");
        assert.ok(init?.signal);
        assert.deepEqual(JSON.parse(String(init?.body)), {
          model: "gpt-5",
          input: modelRequest.messages,
          store: false,
        });
        return Response.json({
          output: [{ type: "message", content: [{ type: "output_text", text: "OpenAI 结果" }] }],
        });
      },
    });
    assert.deepEqual(await invoke({
      presetId: "openai", model: "gpt-5", apiKey: "openai-key",
      request: modelRequest, signal: new AbortController().signal,
    }), { text: "OpenAI 结果", toolCalls: [] });
    assert.equal(called, true);
  });

  await t.test("DeepSeek 使用 Chat Completions", async () => {
    const invoke = createByokModelInvoker({
      fetch: async (input, init) => {
        assert.equal(String(input), "https://api.deepseek.com/chat/completions");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer deepseek-key");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          model: "deepseek-chat",
          messages: modelRequest.messages,
          stream: false,
        });
        return Response.json({ choices: [{ message: { content: "DeepSeek 结果" } }] });
      },
    });
    assert.deepEqual(await invoke({
      presetId: "deepseek", model: "deepseek-chat", apiKey: "deepseek-key",
      request: modelRequest, signal: new AbortController().signal,
    }), { text: "DeepSeek 结果", toolCalls: [] });
  });

  await t.test("Anthropic 使用 Messages API 并拆分 system prompt", async () => {
    const invoke = createByokModelInvoker({
      fetch: async (input, init) => {
        assert.equal(String(input), "https://api.anthropic.com/v1/messages");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-api-key"), "anthropic-key");
        assert.equal(headers.get("anthropic-version"), "2023-06-01");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          model: "claude-sonnet-4-5",
          max_tokens: 4096,
          system: "只陈述已有证据",
          messages: [{ role: "user", content: "整理证据缺口" }],
        });
        return Response.json({ content: [{ type: "text", text: "Anthropic 结果" }] });
      },
    });
    assert.deepEqual(await invoke({
      presetId: "anthropic", model: "claude-sonnet-4-5", apiKey: "anthropic-key",
      request: modelRequest, signal: new AbortController().signal,
    }), { text: "Anthropic 结果", toolCalls: [] });
  });
});

test("BYOK 模型适配器声明受限工具并还原三家厂商的工具调用", async (t) => {
  const toolRequest = {
    ...modelRequest,
    availableToolIds: ["opc.public-web.read"],
  };

  await t.test("OpenAI Responses", async () => {
    const invoke = createByokModelInvoker({
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tools: Array<{ name: string; parameters: unknown }>;
        };
        assert.deepEqual(body.tools, [{
          type: "function",
          name: "mn_tool_1",
          description: "木牛受控工具：opc.public-web.read",
          parameters: { type: "object", additionalProperties: true },
          strict: false,
        }]);
        return Response.json({
          output: [{
            type: "function_call",
            call_id: "call-openai",
            name: "mn_tool_1",
            arguments: JSON.stringify({ url: "https://example.com" }),
          }],
        });
      },
    });
    assert.deepEqual(await invoke({
      presetId: "openai", model: "gpt-5", apiKey: "key",
      request: toolRequest, signal: new AbortController().signal,
    }), {
      text: "",
      toolCalls: [{
        id: "call-openai", toolId: "opc.public-web.read",
        arguments: { url: "https://example.com" },
      }],
    });
  });

  await t.test("DeepSeek Chat Completions", async () => {
    const invoke = createByokModelInvoker({
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { tools: unknown };
        assert.deepEqual(body.tools, [{
          type: "function",
          function: {
            name: "mn_tool_1",
            description: "木牛受控工具：opc.public-web.read",
            parameters: { type: "object", additionalProperties: true },
          },
        }]);
        return Response.json({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call-deepseek",
                type: "function",
                function: {
                  name: "mn_tool_1",
                  arguments: JSON.stringify({ url: "https://example.com/docs" }),
                },
              }],
            },
          }],
        });
      },
    });
    assert.deepEqual(await invoke({
      presetId: "deepseek", model: "deepseek-chat", apiKey: "key",
      request: toolRequest, signal: new AbortController().signal,
    }), {
      text: "",
      toolCalls: [{
        id: "call-deepseek", toolId: "opc.public-web.read",
        arguments: { url: "https://example.com/docs" },
      }],
    });
  });

  await t.test("Anthropic Messages", async () => {
    const invoke = createByokModelInvoker({
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { tools: unknown };
        assert.deepEqual(body.tools, [{
          name: "mn_tool_1",
          description: "木牛受控工具：opc.public-web.read",
          input_schema: { type: "object", additionalProperties: true },
        }]);
        return Response.json({
          content: [{
            type: "tool_use",
            id: "call-anthropic",
            name: "mn_tool_1",
            input: { url: "https://example.com/pricing" },
          }],
        });
      },
    });
    assert.deepEqual(await invoke({
      presetId: "anthropic", model: "claude-sonnet-4-5", apiKey: "key",
      request: toolRequest, signal: new AbortController().signal,
    }), {
      text: "",
      toolCalls: [{
        id: "call-anthropic", toolId: "opc.public-web.read",
        arguments: { url: "https://example.com/pricing" },
      }],
    });
  });
});

test("BYOK 模型适配器把持久化工具结果带入下一模型边界", async () => {
  const invoke = createByokModelInvoker({
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: unknown };
      assert.deepEqual(body.input, [
        { role: "system", content: "只陈述已有证据" },
        { role: "user", content: "整理证据缺口" },
        {
          role: "user",
          content: "[工具 opc.public-web.read 的结果]\n{\"status\":200}",
        },
      ]);
      return Response.json({ output_text: "已整理" });
    },
  });
  assert.deepEqual(await invoke({
    presetId: "openai", model: "gpt-5", apiKey: "key",
    request: {
      ...modelRequest,
      messages: [...modelRequest.messages, {
        role: "tool" as const,
        name: "opc.public-web.read",
        toolCallId: "call-1",
        content: "{\"status\":200}",
      }],
    },
    signal: new AbortController().signal,
  }), { text: "已整理", toolCalls: [] });
});

test("模型调用失败时不暴露密钥或响应正文", async () => {
  const invoke = createByokModelInvoker({
    fetch: async () => new Response("upstream leaked deepseek-key", { status: 401 }),
  });
  await assert.rejects(
    invoke({
      presetId: "deepseek", model: "deepseek-chat", apiKey: "deepseek-key",
      request: modelRequest, signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 401/u);
      assert.doesNotMatch(error.message, /deepseek-key|upstream leaked/u);
      return true;
    },
  );
});

test("模型调用同时响应外部取消和超时", async (t) => {
  const waitForAbort = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () => reject(new Error("upstream aborted with secret"));
      if (init?.signal?.aborted) rejectAbort();
      else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
    });

  await t.test("外部取消", async () => {
    const controller = new AbortController();
    controller.abort();
    const invoke = createByokModelInvoker({ fetch: waitForAbort, timeoutMs: 1_000 });
    await assert.rejects(invoke({
      presetId: "openai", model: "gpt-5", apiKey: "secret",
      request: modelRequest, signal: controller.signal,
    }), /模型调用已取消/u);
  });

  await t.test("超时", async () => {
    const invoke = createByokModelInvoker({ fetch: waitForAbort, timeoutMs: 1 });
    await assert.rejects(invoke({
      presetId: "anthropic", model: "claude-sonnet-4-5", apiKey: "secret",
      request: modelRequest, signal: new AbortController().signal,
    }), /模型调用超时/u);
  });
});
