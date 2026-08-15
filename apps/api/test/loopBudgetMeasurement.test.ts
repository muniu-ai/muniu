import assert from "node:assert/strict";
import test from "node:test";
import type { ProxyRequestLog } from "@mn/provider-catalog";
import { sha256Canonical } from "@mn/loop";
import {
  applyFailClosedUnpricedCost,
  authoritativeProxyUsage,
  issueLoopBudgetMeasurement,
  verifyLoopBudgetMeasurement
} from "../src/loopBudgetMeasurement.js";

const key = "loop-measurement-key-0123456789abcdef0123456789abcdef";

test("API measurement proof is signed, claim-bound and cumulative", () => {
  const first = issueLoopBudgetMeasurement({
    tenantId: "tenant-a",
    runId: "run-a",
    workerId: "worker-a",
    claimDigest: "1".repeat(64),
    stageAttemptId: "run-a:discovery:1",
    stage: "discovery",
    attempt: 1,
    intervalStartedAt: "2026-07-12T00:00:00.000Z",
    measuredAt: "2026-07-12T00:00:02.000Z",
    usageRequestIds: ["request-1"],
    usageDigest: "2".repeat(64),
    delta: {
      durationSeconds: 2,
      tokens: 12,
      costUsd: 0.01,
      changedFiles: 0,
      changedLines: 0
    },
    signingKey: key
  });
  const second = issueLoopBudgetMeasurement({
    tenantId: "tenant-a",
    runId: "run-a",
    workerId: "worker-b",
    claimDigest: "3".repeat(64),
    stageAttemptId: "run-a:specification:1",
    stage: "specification",
    attempt: 1,
    intervalStartedAt: "2026-07-12T00:01:00.000Z",
    measuredAt: "2026-07-12T00:01:01.000Z",
    usageRequestIds: ["request-1", "request-2"],
    usageDigest: "4".repeat(64),
    delta: {
      durationSeconds: 1,
      tokens: 5,
      costUsd: 0.02,
      changedFiles: 0,
      changedLines: 0
    },
    previousMeasurement: first,
    signingKey: key
  });

  assert.equal(second.previousMeasurementDigest, first.digest);
  assert.deepEqual(second.cumulative, {
    durationSeconds: 3,
    tokens: 17,
    costUsd: 0.03,
    changedFiles: 0,
    changedLines: 0
  });
  assert.equal(
    verifyLoopBudgetMeasurement(second, {
      tenantId: "tenant-a",
      runId: "run-a",
      workerId: "worker-b",
      claimDigest: "3".repeat(64),
      signingKey: key
    }).valid,
    true
  );
  assert.equal(
    verifyLoopBudgetMeasurement(second, {
      tenantId: "tenant-a",
      runId: "run-a",
      workerId: "worker-a",
      claimDigest: "1".repeat(64),
      signingKey: key
    }).valid,
    false
  );
});

test("self-resealed low usage and copied signatures are rejected", () => {
  const proof = issueLoopBudgetMeasurement({
    tenantId: "tenant-a",
    runId: "run-a",
    workerId: "worker-a",
    claimDigest: "1".repeat(64),
    stageAttemptId: "run-a:implementation:1",
    stage: "implementation",
    attempt: 1,
    intervalStartedAt: "2026-07-12T00:00:00.000Z",
    measuredAt: "2026-07-12T00:00:01.000Z",
    usageRequestIds: ["request-1"],
    usageDigest: "2".repeat(64),
    diffArtifact: {
      id: "diff-1",
      uri: "mn://runs/run-a/artifacts/diff-1",
      digest: "3".repeat(64),
      byteLength: 123,
      ...diffDomain()
    },
    delta: {
      durationSeconds: 1,
      tokens: 100,
      costUsd: 0.1,
      changedFiles: 2,
      changedLines: 40
    },
    signingKey: key
  });
  const { digest: _digest, signature, ...oldSemantic } = proof;
  const semantic = {
    ...oldSemantic,
    delta: { ...proof.delta, tokens: 0, costUsd: 0, changedLines: 0 },
    cumulative: { ...proof.cumulative, tokens: 0, costUsd: 0, changedLines: 0 }
  };
  const forged = { ...semantic, digest: sha256Canonical(semantic), signature };
  assert.equal(
    verifyLoopBudgetMeasurement(forged, {
      tenantId: "tenant-a",
      runId: "run-a",
      signingKey: key
    }).valid,
    false
  );
});

test("proxy usage semantic is deterministic and exposes unpriced requests", () => {
  const logs: ProxyRequestLog[] = [
    usageLog("request-b", 3, 2),
    usageLog("request-a", 7, 4)
  ];
  const usage = authoritativeProxyUsage(
    logs,
    new Map([
      ["request-a", 0.03],
      ["request-b", undefined]
    ])
  );
  assert.deepEqual(usage.requestIds, ["request-a", "request-b"]);
  assert.equal(usage.tokens, 16);
  assert.equal(usage.costUsd, 0.03);
  assert.equal(usage.allRequestsPriced, false);
  assert.match(usage.digest, /^[a-f0-9]{64}$/u);
  const failClosed = applyFailClosedUnpricedCost(usage, 0.25);
  assert.equal(failClosed.costUsd, 0.25000001);
  assert.equal(failClosed.allRequestsPriced, false);
  assert.notEqual(failClosed.digest, usage.digest);
  assert.deepEqual(failClosed.requestIds, usage.requestIds);
});

test("local replay remains auditable without increasing provider budget", () => {
  const upstream = usageLog("request-upstream", 7, 4);
  const replay: ProxyRequestLog = {
    ...usageLog("request-replay", 0, 0),
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningOutputTokens: 0,
    replayed: true
  };
  const usage = authoritativeProxyUsage(
    [upstream, replay],
    new Map([
      [upstream.id, 0.03],
      [replay.id, 0]
    ])
  );

  assert.deepEqual(usage.requestIds, ["request-replay", "request-upstream"]);
  assert.equal(usage.tokens, 11);
  assert.equal(usage.costUsd, 0.03);
  assert.equal(usage.allRequestsPriced, true);
});

function diffDomain() {
  return {
    candidateId: "claude-1",
    workspaceUri: "mn://sandbox/lease-a/run-a--implementation-1-claude-1",
    leaseId: "lease-a",
    runtimeId: "4".repeat(64),
    runtimeProofDigest: "5".repeat(64),
    projectSnapshotDigest: "6".repeat(64),
    candidateSnapshotDigest: "7".repeat(64)
  };
}

function usageLog(id: string, inputTokens: number, outputTokens: number): ProxyRequestLog {
  return {
    id,
    app: "codex",
    providerId: "provider-a",
    model: "model-a",
    inputTokens,
    outputTokens,
    statusCode: 200,
    latencyMs: 10,
    runId: "run-a",
    candidateId: "candidate-a",
    createdAt: "2026-07-12T00:00:00.000Z"
  };
}
