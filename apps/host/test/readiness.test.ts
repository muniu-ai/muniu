import assert from "node:assert/strict";
import test from "node:test";
import { enterpriseReadiness, assertNoLegacyDaemon, createAgentOsHost } from "../src/index.js";
import { InMemoryKernelStore } from "@mn/kernel";

test("KMS readiness 失败时不继续读取加密插件投影", async () => {
  const store = new InMemoryKernelStore();
  let unavailable = false;
  let readsAfterFailure = 0;
  const transact = store.transact.bind(store);
  store.transact = async (...args) => {
    if (unavailable) { readsAfterFailure += 1; throw new Error("KMS connection timed out"); }
    return transact(...args);
  };
  const issue = { code: "KMS_UNAVAILABLE", message: "密钥存储不可用", action: "恢复密钥存储" };
  const host = await createAgentOsHost({ store, readiness: () => ({ ready: false, issues: [issue] }),
    secretStore: { async save() { throw new Error("unused"); }, async read() { throw new Error("unused"); } } });
  try {
    unavailable = true;
    const response = await host.dispatch(new Request("http://host.test/v2/readiness"));
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).data, { ready: false, issues: [issue] });
    assert.equal(readsAfterFailure, 0);
    assert.equal((await host.dispatch(new Request("http://host.test/v2/health"))).status, 200);
  } finally { unavailable = false; await host.close(); }
});

test("旧 daemon 活跃时拒绝启动", async () => {
  await assert.rejects(
    assertNoLegacyDaemon(async () => true),
    /退出 0\.1 daemon/,
  );
  await assert.doesNotReject(assertNoLegacyDaemon(async () => false));
});

test("企业 readiness 要求保留策略和一致的 engine/plugin lock", () => {
  const missing = enterpriseReadiness({
    retention: {}, engineLockDigest: "a", workerEngineLockDigest: "b",
    pluginLockDigest: "c", workerPluginLockDigest: "c", postgresReady: true, s3Ready: true,
  });
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.issues.map((issue) => issue.code).sort(), [
    "ENGINE_LOCK_MISMATCH", "RETENTION_POLICY_REQUIRED",
  ]);
  assert.equal(enterpriseReadiness({
    retention: { businessDays: 365, executionDays: 30, deliverableDays: 365, auditDays: 2555 },
    engineLockDigest: "a", workerEngineLockDigest: "a",
    pluginLockDigest: "b", workerPluginLockDigest: "b", postgresReady: true, s3Ready: true,
  }).ready, true);
});
