import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject, JsonValue } from "@mn/contracts";
import { StaleFencingTokenError, type StoredJob } from "@mn/storage";
import {
  AgentOsWorker,
  createAgentTurnHandler,
  runWorkerLoop,
  UnknownExternalSideEffectError,
  WORKER_LEASE_MILLISECONDS,
  workerReadiness,
  type WorkerJobStore,
} from "../src/index.js";

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
  reconciliations: string[] = [];
  renewals = 0;
  renewFailure: unknown;
  claims = 0;
  async claimJob() { this.claims += 1; const value = this.claimed; this.claimed = undefined; return value; }
  async completeJob(id: string, _worker: string, token: number, result: JsonValue) { this.completed.push([id, token, result]); }
  async failJob(id: string, _worker: string, token: number, failure: JsonObject) { this.failed.push([id, token, failure]); }
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
