// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryKernelStore } from "@mn/kernel";
import { listCodingTaskSummaries } from "../src/index.js";

test("Coding 列表展示已持久化的 Diff、Gate、审批和下一步，并隔离其他工作区", async () => {
  const store = new InMemoryKernelStore();
  await store.transact("tenant-a", tx => {
    tx.putProjection("coding.repository", "repo", { id: "repo", workspaceId: "workspace", name: "example" });
    tx.putProjection("coding.task", "task", { id: "task", title: "修正文案", workspaceId: "workspace", repositoryId: "repo",
      status: "completed", updatedAt: "2026-09-04T00:00:00Z" });
    tx.putProjection("coding.execution", "execution", { executionId: "execution", taskId: "task", generation: 1,
      updatedAt: "2026-09-04T00:00:00Z", controlPlane: { harnessDigest: "fixed-harness" }, result: {
        task: { id: "task", workspaceId: "workspace" }, nextStep: "审阅最终 Diff", approval: "approved_once",
        candidates: [{ id: "candidate", summary: "修正三处文案" }],
        gates: [{ candidateId: "candidate", checks: [{ id: "git.diff-check", status: "passed" }] }],
        limits: { maxRepairAttempts: 3, maxDurationMs: 3600000 },
      } });
    tx.putProjection("coding.candidate", "candidate", { id: "candidate", taskId: "task", workspaceId: "workspace",
      executionId: "execution", diff: "--- a/message.txt\n+++ b/message.txt\n-old\n+new" });
    tx.putProjection("coding.execution", "foreign", { executionId: "foreign", taskId: "task", updatedAt: "2099-01-01T00:00:00Z",
      result: { task: { id: "task", workspaceId: "another" }, nextStep: "foreign-private" } });
  });
  const [summary] = await listCodingTaskSummaries(store, "tenant-a", "workspace");
  assert.ok(summary);
  assert.equal(summary.repository, "example");
  assert.equal(summary.diffSummary, "修正三处文案");
  assert.equal(summary.diff, "--- a/message.txt\n+++ b/message.txt\n-old\n+new");
  assert.deepEqual(summary.checks, [{ name: "git.diff-check", status: "pass" }]);
  assert.equal(summary.approval, "已单次批准");
  assert.equal(summary.nextAction, "审阅最终 Diff");
  assert.equal(summary.advanced?.harnessDigest, "fixed-harness");
  assert.equal(summary.advanced?.candidateCount, 1);
  assert.equal(JSON.stringify(summary).includes("foreign-private"), false);
  assert.deepEqual(await listCodingTaskSummaries(store, "tenant-b", "workspace"), []);
});
