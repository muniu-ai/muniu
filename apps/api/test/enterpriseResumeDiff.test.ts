import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { GovernedRunState } from "@mn/loop";
import type { EnterpriseClaimSnapshot } from "../src/enterprisePostgres.js";
import { enterpriseResumeDiffFromClaim } from "../src/enterpriseResumeDiff.js";
import { issueLoopBudgetMeasurement } from "../src/loopBudgetMeasurement.js";

const signingKey = "enterprise-resume-diff-test-signing-key-v1";
const digest = "a".repeat(64);

test("selects only the signed winner diff bound to an active claim payload", () => {
  const claim = fixtureClaim();
  const selected = enterpriseResumeDiffFromClaim(claim, {
    stageAttemptId: "run-a:implementation:1",
    candidateId: "builtin-1",
    digest
  }, signingKey);
  assert.equal(selected.ref.objectKey, selected.artifact.id);
  assert.equal(selected.ref.contentType, "application/vnd.mn.loop-diff-manifest+json");
  assert.equal(selected.artifact.workspaceUri, "mn://sandbox/lease-old/run-a--governed-builtin-1");
});

test("rejects requests that are not the durable signed winner proof", () => {
  const claim = fixtureClaim();
  assert.throws(
    () => enterpriseResumeDiffFromClaim(claim, {
      stageAttemptId: "run-a:implementation:1",
      candidateId: "codex-1",
      digest
    }, signingKey),
    /does not match/u
  );
  assert.throws(
    () => enterpriseResumeDiffFromClaim(claim, {
      stageAttemptId: "run-a:implementation:1",
      candidateId: "builtin-1",
      digest
    }, "wrong-enterprise-resume-diff-signing-key"),
    /signature/u
  );
});

function fixtureClaim(): EnterpriseClaimSnapshot {
  const tenantId = "tenant-a";
  const projectId = "project-a";
  const runId = "run-a";
  const objectKey = casObjectKey(tenantId, projectId, runId, digest);
  const workspaceUri = "mn://sandbox/lease-old/run-a--governed-builtin-1";
  const proof = issueLoopBudgetMeasurement({
    tenantId,
    runId,
    workerId: "worker-old",
    claimDigest: "b".repeat(64),
    stageAttemptId: "run-a:implementation:1",
    stage: "implementation",
    attempt: 1,
    intervalStartedAt: "2026-01-01T00:00:00.000Z",
    measuredAt: "2026-01-01T00:00:01.000Z",
    usageRequestIds: [],
    usageDigest: "c".repeat(64),
    diffArtifact: {
      id: objectKey,
      uri: `mn://cas/loop-diffs/${encodeURIComponent(objectKey)}`,
      digest,
      byteLength: 123,
      candidateId: "builtin-1",
      workspaceUri,
      leaseId: "lease-old",
      runtimeId: "d".repeat(64),
      runtimeProofDigest: "e".repeat(64),
      projectSnapshotDigest: "f".repeat(64),
      candidateSnapshotDigest: "1".repeat(64)
    },
    delta: {
      durationSeconds: 1,
      tokens: 0,
      costUsd: 0,
      changedFiles: 1,
      changedLines: 2
    },
    signingKey
  });
  const state = {
    schemaVersion: 1,
    runId,
    attempts: [{
      id: proof.stageAttemptId,
      runId,
      stage: "implementation",
      attempt: 1,
      status: "completed",
      inputArtifacts: [],
      outputArtifacts: [],
      inputDigest: "2".repeat(64),
      outputDigest: "3".repeat(64),
      budgetUsage: { durationSeconds: 1, tokens: 0, costUsd: 0, repairAttempts: 0 },
      budgetDelta: proof.delta,
      budgetMeasurement: proof,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z"
    }]
  } as unknown as GovernedRunState;
  return {
    item: {
      runId,
      tenantId,
      projectId,
      taskId: "task-a"
    },
    payload: {
      run: {
        id: runId,
        tenantId,
        projectId,
        taskId: "task-a",
        winnerCandidateId: "builtin-1",
        candidates: [{ id: "builtin-1", worktreePath: workspaceUri }]
      },
      governedResumeState: state
    },
    checkpointDigest: "4".repeat(64)
  } as unknown as EnterpriseClaimSnapshot;
}

function casObjectKey(
  tenantId: string,
  projectId: string,
  runId: string,
  contentDigest: string
): string {
  const scope = [tenantId, projectId, runId]
    .map((value) => createHash("sha256").update(value).digest("hex").slice(0, 24))
    .join("/");
  return `cas/v1/${scope}/${contentDigest.slice(0, 2)}/${contentDigest}`;
}
