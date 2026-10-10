// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { GoalV2 } from "@mn/contracts";
import { InMemoryKernelStore, sha256 } from "@mn/kernel";
import { scheduleGoal, taskClass } from "../src/goal-scheduling.js";

const now = "2026-10-10T00:00:00.000Z";
const goal = { id: "current", tenantId: "local", workspaceId: "w", threadId: "thread", objective: "经营复盘", resourceRefs: [], deliverables: [{ criteria: [{ id: "c", description: "事实可追溯" }] }], budget: { maxTokens: 100000, maxCostMinorUnits: "1000", currency: "CNY", maxDurationMs: 3600000 } } as unknown as GoalV2;
test("历史按工作区、类型、配置版本与结算隔离，待验收不算成功", async () => {
  const store = new InMemoryKernelStore();
  await store.transact("local", tx => {
    tx.putProjection("workspace", "w", { id: "w", activePluginIds: ["opc", "runner-codex-cli"] });
    tx.putProjection("thread", "thread", { pluginId: "opc" });
    tx.putProjection("modelConnection", "m", { id: "m", tenantId: "local", displayName: "DeepSeek", presetId: "deepseek", defaultModel: "deepseek-v4-flash", status: "ready", streamVersion: 1 });
    tx.putProjection("coding.runner-configuration", "w:codex-cli", { id: "w:codex-cli", tenantId: "local", status: "confirmed", identity: {}, identityDigest: sha256({}), streamVersion: 1 });
    const request = { runnerId: "auto", strategy: "quality" } as const;
    const initial = scheduleGoal(tx, goal, request, now);
    assert.equal(initial.selectedId, "builtin:m");
    const cli = initial.candidates.find(candidate => candidate.id === "codex-cli")!;
    for (let index = 0; index < 9; index++) {
      const id = `g${index}`;
      const state = { ...goal, id, streamVersion: 1, status: index === 6 ? "awaiting_acceptance" : index === 4 ? "failed" : "accepted",
        workspaceId: index === 7 ? "other" : "w", updatedAt: index === 8 ? "2025-01-01T00:00:00.000Z" : now,
        executionRef: { executionId: id }, planRevisionId: id, reservation: { status: "settled", actual: { tokens: 10, costMinorUnits: "15", currency: "CNY" } } };
      tx.putProjection("goal.state", id, state);
      tx.putProjection("execution", id, { createdAt: "2026-10-09T23:59:00.000Z", updatedAt: now });
      tx.putProjection("goal.plan", id, { scheduling: { taskClass: index === 5 ? "coding:large" : taskClass(goal, "opc"), selectedId: cli.id, candidates: [cli] } });
    }
    const historical = scheduleGoal(tx, goal, { runnerId: "codex-cli", strategy: "quality" }, now);
    const selected = historical.candidates.find(candidate => candidate.id === "codex-cli")!;
    assert.equal(selected.samples, 5);
    assert.equal(selected.accepted, 4);
    assert.equal(selected.expectedCostMinorUnits, "15");
    assert.equal(selected.expectedDurationMs, 60000);
    tx.putProjection("coding.runner-configuration", "w:codex-cli", { tenantId: "local", status: "confirmed", identity: {}, identityDigest: sha256({}), streamVersion: 2 });
    const changed = scheduleGoal(tx, goal, { runnerId: "codex-cli", strategy: "quality" }, now);
    assert.equal(changed.candidates.find(candidate => candidate.id === "codex-cli")!.samples, 0);
    assert.notEqual(changed.evidenceDigest, historical.evidenceDigest);
  });
});
