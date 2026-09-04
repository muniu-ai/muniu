import assert from "node:assert/strict";
import test from "node:test";
import { enterpriseReadiness, assertNoLegacyDaemon } from "../src/index.js";

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
