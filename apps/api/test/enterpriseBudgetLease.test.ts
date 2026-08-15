import assert from "node:assert/strict";
import test from "node:test";
import type { RunRecord } from "@mn/core";
import type { GovernedRunState } from "@mn/loop";
import { evaluateEnterpriseBudgetLease } from "../src/enterpriseBudgetLease.js";
import type { AuthoritativeProxyUsage } from "../src/loopBudgetMeasurement.js";
import type { RunJobQueueItem } from "../src/runJobQueue.js";

test("enterprise budget lease caps renewal at remaining duration", () => {
  const decision = evaluateEnterpriseBudgetLease({
    run: run({ maxDurationSeconds: 20, maxTokens: 100, maxCostUsd: 1 }),
    state: state(10, "2026-07-12T00:00:05.000Z"),
    item: item(),
    usage: usage(20, 0.1),
    requestedTtlMs: 30_000,
    now: "2026-07-12T00:00:10.000Z"
  });
  assert.equal(decision.stop, undefined);
  assert.equal(decision.observed.durationSeconds, 15);
  assert.equal(decision.ttlMs, 5_000);
});

test("enterprise budget lease stops duration, token and cost overruns", () => {
  const duration = evaluateEnterpriseBudgetLease({
    run: run({ maxDurationSeconds: 12 }),
    state: state(10, "2026-07-12T00:00:05.000Z"),
    item: item(),
    usage: usage(0, 0),
    requestedTtlMs: 30_000,
    now: "2026-07-12T00:00:08.000Z"
  });
  assert.equal(duration.stop?.dimension, "duration");
  const tokens = evaluateEnterpriseBudgetLease({
    run: run({ maxTokens: 10 }),
    state: state(0, "2026-07-12T00:00:05.000Z"),
    item: item(),
    usage: usage(11, 0),
    requestedTtlMs: 30_000,
    now: "2026-07-12T00:00:05.000Z"
  });
  assert.equal(tokens.stop?.dimension, "tokens");
  const cost = evaluateEnterpriseBudgetLease({
    run: run({ maxCostUsd: 0.25 }),
    state: state(0, "2026-07-12T00:00:05.000Z"),
    item: item(),
    usage: usage(1, 0.25000001),
    requestedTtlMs: 30_000,
    now: "2026-07-12T00:00:05.000Z"
  });
  assert.equal(cost.stop?.dimension, "cost");
});

test("conservative provider reconciliation forces a budget stop at the held amount", () => {
  const decision = evaluateEnterpriseBudgetLease({
    run: run({ maxTokens: 90, maxCostUsd: 4.5 }),
    state: state(0, "2026-07-12T00:00:05.000Z"),
    item: item(),
    usage: {
      ...usage(90, 4.5),
      requiresBudgetStop: true
    },
    requestedTtlMs: 30_000,
    now: "2026-07-12T00:00:05.000Z"
  });
  assert.equal(decision.ttlMs, 0);
  assert.equal(decision.stop?.dimension, "cost");
  assert.equal(decision.stop?.observed, 4.5);
});

function run(stopConditions: Record<string, number>): RunRecord {
  return {
    id: "run-a",
    taskId: "task-a",
    projectId: "project-a",
    tenantId: "tenant-a",
    status: "running",
    candidates: [],
    gates: [],
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    harnessManifest: { stopConditions } as unknown as RunRecord["harnessManifest"]
  };
}

function state(durationSeconds: number, startedAt: string): GovernedRunState {
  return {
    budgetUsage: {
      durationSeconds,
      tokens: 0,
      costUsd: 0,
      repairAttempts: 0,
      changedFiles: 0,
      changedLines: 0
    },
    attempts: [{ status: "running", startedAt }]
  } as unknown as GovernedRunState;
}

function item(): RunJobQueueItem {
  return {
    version: 2,
    runId: "run-a",
    tenantId: "tenant-a",
    projectId: "project-a",
    taskId: "task-a",
    status: "running",
    priority: 0,
    attempt: 1,
    recovered: false,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    claimedAt: "2026-07-12T00:00:00.000Z"
  };
}

function usage(tokens: number, costUsd: number): AuthoritativeProxyUsage {
  return {
    requestIds: tokens > 0 ? ["request-a"] : [],
    tokens,
    costUsd,
    allRequestsPriced: true,
    digest: "a".repeat(64)
  };
}
