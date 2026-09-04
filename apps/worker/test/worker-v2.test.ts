import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject, JsonValue } from "@mn/contracts";
import type { StoredJob } from "@mn/storage";
import {
  AgentOsWorker,
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
  claims = 0;
  async claimJob() { this.claims += 1; const value = this.claimed; this.claimed = undefined; return value; }
  async completeJob(id: string, _worker: string, token: number, result: JsonValue) { this.completed.push([id, token, result]); }
  async failJob(id: string, _worker: string, token: number, failure: JsonObject) { this.failed.push([id, token, failure]); }
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
  assert.equal(store.failed.length, 1);
  assert.equal(store.failed[0]?.[2].code, "UNKNOWN_EXTERNAL_SIDE_EFFECT");
  assert.deepEqual(await worker.pollOnce(), { status: "idle" });
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
