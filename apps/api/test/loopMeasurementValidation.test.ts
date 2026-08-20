import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProxyRequestLog } from "@mn/provider-catalog";
import type { RunRecord } from "@mn/core";
import type { GovernedRunState, LoopBudgetDelta } from "@mn/loop";
import {
  authoritativeProxyUsage,
  issueLoopBudgetMeasurement
} from "../src/loopBudgetMeasurement.js";
import {
  LOOP_DIFF_MANIFEST_CONTENT_TYPE,
  measureLoopDiffManifest
} from "../src/loopDiffMeasurement.js";
import type { PendingProviderUsageReservation } from "../src/enterprisePostgres.js";
import { RunScopedCas } from "../src/runScopedCas.js";
import type { RunJobQueueItem } from "../src/runJobQueue.js";
import { validateEnterpriseLoopBudgetMeasurements } from "../src/server.js";

const key = "loop-validation-key-0123456789abcdef0123456789abcdef";
const tenantId = "tenant-a";
const runId = "run-a";
const workerId = "worker-a";
const claimDigest = "1".repeat(64);
const claimedAt = "2026-07-12T00:00:00.000Z";
const measuredAt = "2026-07-12T00:00:01.000Z";

test("enterprise Loop measurement rejects pending usage then accepts finalized accounting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-loop-measurement-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cas = new RunScopedCas({ localRoot: root });
  const measuredDiff = measureLoopDiffManifest(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    files: [{ path: "services/orders/a.ts", before: "old\n", after: "new\n" }]
  })));
  const ref = await cas.put({
    tenantId,
    projectId: "project-a",
    runId,
    contentType: LOOP_DIFF_MANIFEST_CONTENT_TYPE,
    content: measuredDiff.content
  });
  const usage = authoritativeProxyUsage([], new Map());
  const delta: LoopBudgetDelta = {
    durationSeconds: 1,
    tokens: 0,
    costUsd: 0,
    changedFiles: measuredDiff.changedFiles,
    changedLines: measuredDiff.changedLines
  };
  const proof = issueLoopBudgetMeasurement({
    tenantId,
    runId,
    workerId,
    claimDigest,
    stageAttemptId: `${runId}:implementation:1`,
    stage: "implementation",
    attempt: 1,
    intervalStartedAt: claimedAt,
    measuredAt,
    usageRequestIds: usage.requestIds,
    usageDigest: usage.digest,
    diffArtifact: {
      id: ref.objectKey,
      uri: `mn://cas/loop-diffs/${encodeURIComponent(ref.objectKey)}`,
      digest: ref.digest,
      byteLength: ref.byteLength,
      ...diffDomain()
    },
    delta,
    signingKey: key
  });
  const state = governedState(proof);
  const input = validationInput({ state, cas });
  assert.equal(await validateEnterpriseLoopBudgetMeasurements(input), undefined);
  assert.match(
    (await validateEnterpriseLoopBudgetMeasurements(
      validationInput({
        state,
        cas,
        pendingReservations: [pendingUsageReservation()]
      })
    )) ?? "",
    /pending reservation/u
  );
  assert.equal(
    await validateEnterpriseLoopBudgetMeasurements(validationInput({ state, cas })),
    undefined
  );

  const lowDiffProof = issueLoopBudgetMeasurement({
    tenantId,
    runId,
    workerId,
    claimDigest,
    stageAttemptId: `${runId}:implementation:1`,
    stage: "implementation",
    attempt: 1,
    intervalStartedAt: claimedAt,
    measuredAt,
    usageRequestIds: [],
    usageDigest: usage.digest,
    diffArtifact: {
      id: ref.objectKey,
      uri: `mn://cas/loop-diffs/${encodeURIComponent(ref.objectKey)}`,
      digest: ref.digest,
      byteLength: ref.byteLength,
      ...diffDomain()
    },
    delta: { ...delta, changedFiles: 0, changedLines: 0 },
    signingKey: key
  });
  assert.match(
    (await validateEnterpriseLoopBudgetMeasurements(
      validationInput({ state: governedState(lowDiffProof), cas })
    )) ?? "",
    /does not match CAS bytes/u
  );

  const forged = {
    ...proof,
    signature: "f".repeat(64)
  };
  assert.match(
    (await validateEnterpriseLoopBudgetMeasurements(
      validationInput({ state: governedState(forged as typeof proof), cas })
    )) ?? "",
    /signature mismatch/u
  );
});

test("enterprise Loop measurement rejects token zero-reporting and old claim replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-loop-measurement-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cas = new RunScopedCas({ localRoot: root });
  const diff = measureLoopDiffManifest(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    files: []
  })));
  const ref = await cas.put({
    tenantId,
    projectId: "project-a",
    runId,
    contentType: LOOP_DIFF_MANIFEST_CONTENT_TYPE,
    content: diff.content
  });
  const emptyUsage = authoritativeProxyUsage([], new Map());
  const proof = issueLoopBudgetMeasurement({
    tenantId,
    runId,
    workerId,
    claimDigest,
    stageAttemptId: `${runId}:implementation:1`,
    stage: "implementation",
    attempt: 1,
    intervalStartedAt: claimedAt,
    measuredAt,
    usageRequestIds: [],
    usageDigest: emptyUsage.digest,
    diffArtifact: {
      id: ref.objectKey,
      uri: `mn://cas/loop-diffs/${encodeURIComponent(ref.objectKey)}`,
      digest: ref.digest,
      byteLength: ref.byteLength,
      ...diffDomain()
    },
    delta: {
      durationSeconds: 1,
      tokens: 0,
      costUsd: 0,
      changedFiles: 0,
      changedLines: 0
    },
    signingKey: key
  });
  const usageLog: ProxyRequestLog = {
    id: "provider-request-a",
    app: "codex",
    providerId: "provider-a",
    model: "model-a",
    inputTokens: 8,
    outputTokens: 3,
    statusCode: 200,
    latencyMs: 10,
    runId,
    candidateId: "candidate-a",
    trustedAssociation: {
      schemaVersion: 1,
      issuer: "mn-api",
      tenantId,
      runId,
      candidateId: "candidate-a",
      workerId,
      claimDigest,
      receiptDigest: "a".repeat(64),
      issuedAt: claimedAt,
      expiresAt: "2026-07-12T00:10:00.000Z",
      verifiedAt: measuredAt
    },
    createdAt: measuredAt
  };
  assert.match(
    (await validateEnterpriseLoopBudgetMeasurements(
      validationInput({
        state: governedState(proof),
        cas,
        logs: [usageLog]
      })
    )) ?? "",
    /under-reports/u
  );

  const oldClaimProof = issueLoopBudgetMeasurement({
    tenantId,
    runId,
    workerId,
    claimDigest: "2".repeat(64),
    stageAttemptId: `${runId}:implementation:1`,
    stage: "implementation",
    attempt: 1,
    intervalStartedAt: claimedAt,
    measuredAt,
    usageRequestIds: [],
    usageDigest: emptyUsage.digest,
    diffArtifact: {
      id: ref.objectKey,
      uri: `mn://cas/loop-diffs/${encodeURIComponent(ref.objectKey)}`,
      digest: ref.digest,
      byteLength: ref.byteLength,
      ...diffDomain()
    },
    delta: proof.delta,
    signingKey: key
  });
  assert.match(
    (await validateEnterpriseLoopBudgetMeasurements(
      validationInput({ state: governedState(oldClaimProof), cas })
    )) ?? "",
    /claim binding mismatch/u
  );
});

test("an interrupted implementation accounts usage without accepting discarded workspace bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-loop-measurement-interrupted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cas = new RunScopedCas({ localRoot: root });
  const usage = authoritativeProxyUsage([], new Map());
  const proof = issueLoopBudgetMeasurement({
    tenantId,
    runId,
    workerId,
    claimDigest,
    stageAttemptId: `${runId}:implementation:1`,
    stage: "implementation",
    attempt: 1,
    intervalStartedAt: claimedAt,
    measuredAt,
    usageRequestIds: usage.requestIds,
    usageDigest: usage.digest,
    delta: {
      durationSeconds: 1,
      tokens: 0,
      costUsd: 0,
      changedFiles: 0,
      changedLines: 0
    },
    signingKey: key
  });
  const completed = governedState(proof);
  const interruptedAttempt = {
    ...completed.attempts[0]!,
    status: "failed" as const,
    failure: {
      kind: "interrupted" as const,
      retryable: true,
      reason: "resumed from the last durable checkpoint"
    }
  };
  const interrupted: GovernedRunState = {
    ...completed,
    status: "running",
    currentStage: "implementation",
    attempts: [interruptedAttempt],
    budgetUsage: interruptedAttempt.budgetUsage
  };

  assert.equal(
    await validateEnterpriseLoopBudgetMeasurements(
      validationInput({
        state: interrupted,
        run: { ...run(), status: "running", candidates: [] },
        cas
      })
    ),
    undefined
  );
  assert.match(
    (await validateEnterpriseLoopBudgetMeasurements(
      validationInput({ state: completed, cas })
    )) ?? "",
    /no authoritative diff artifact/u
  );
});

test("a repair checkpoint keeps the first implementation proof while binding only the new winner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-loop-measurement-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cas = new RunScopedCas({ localRoot: root });
  const diff = measureLoopDiffManifest(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    files: []
  })));
  const ref = await cas.put({
    tenantId,
    projectId: "project-a",
    runId,
    contentType: LOOP_DIFF_MANIFEST_CONTENT_TYPE,
    content: diff.content
  });
  const usage = authoritativeProxyUsage([], new Map());
  const delta: LoopBudgetDelta = {
    durationSeconds: 1,
    tokens: 0,
    costUsd: 0,
    changedFiles: 0,
    changedLines: 0
  };
  const first = issueLoopBudgetMeasurement({
    tenantId,
    runId,
    workerId,
    claimDigest,
    stageAttemptId: `${runId}:implementation:1`,
    stage: "implementation",
    attempt: 1,
    intervalStartedAt: claimedAt,
    measuredAt,
    usageRequestIds: [],
    usageDigest: usage.digest,
    diffArtifact: {
      id: ref.objectKey,
      uri: `mn://cas/loop-diffs/${encodeURIComponent(ref.objectKey)}`,
      digest: ref.digest,
      byteLength: ref.byteLength,
      ...diffDomain(1)
    },
    delta,
    signingKey: key
  });
  const secondMeasuredAt = "2026-07-12T00:00:02.000Z";
  const second = issueLoopBudgetMeasurement({
    tenantId,
    runId,
    workerId,
    claimDigest,
    stageAttemptId: `${runId}:implementation:2`,
    stage: "implementation",
    attempt: 2,
    intervalStartedAt: measuredAt,
    measuredAt: secondMeasuredAt,
    usageRequestIds: [],
    usageDigest: usage.digest,
    diffArtifact: {
      id: ref.objectKey,
      uri: `mn://cas/loop-diffs/${encodeURIComponent(ref.objectKey)}`,
      digest: ref.digest,
      byteLength: ref.byteLength,
      ...diffDomain(2)
    },
    delta,
    previousMeasurement: first,
    signingKey: key
  });
  const previous = governedState(first);
  const secondAttempt = {
    ...previous.attempts[0]!,
    id: second.stageAttemptId,
    attempt: 2,
    budgetUsage: { ...second.cumulative, repairAttempts: 1 },
    budgetDelta: second.delta,
    budgetMeasurement: second,
    startedAt: measuredAt,
    finishedAt: secondMeasuredAt
  };
  const state: GovernedRunState = {
    ...previous,
    attempts: [previous.attempts[0]!, secondAttempt],
    budgetUsage: secondAttempt.budgetUsage,
    updatedAt: secondMeasuredAt
  };
  assert.equal(
    await validateEnterpriseLoopBudgetMeasurements(
      validationInput({
        state,
        previous,
        run: run(2),
        cas,
        now: "2026-07-12T00:00:03.000Z"
      })
    ),
    undefined
  );
});

function validationInput(input: {
  state: GovernedRunState;
  cas: RunScopedCas;
  logs?: ProxyRequestLog[];
  pendingReservations?: PendingProviderUsageReservation[];
  previous?: GovernedRunState;
  run?: RunRecord;
  now?: string;
}) {
  return {
    state: input.state,
    previous: input.previous,
    run: input.run ?? run(),
    item: item(),
    tenantId,
    workerId,
    signingKey: key,
    usageLedger: {
      readProviderUsageAccounting: async (scope: {
        tenantId: string;
        runId: string;
      }) => ({
        schemaVersion: 1 as const,
        tenantId: scope.tenantId,
        runId: scope.runId,
        usageLogs: input.logs ?? [],
        pendingReservations: input.pendingReservations ?? [],
        finalizedReservations: []
      })
    },
    providerStore: {
      listProviders: async () => []
    },
    cas: input.cas,
    now: input.now ?? "2026-07-12T00:00:02.000Z"
  };
}

function pendingUsageReservation(): PendingProviderUsageReservation {
  return {
    schemaVersion: 1,
    status: "pending",
    tenantId,
    reservationId: "reservation-pending",
    runId,
    candidateId: "candidate-a",
    workerId,
    claimDigest,
    receiptDigest: "a".repeat(64),
    verifiedAt: measuredAt,
    expiresAt: "2026-07-12T00:10:00.000Z"
  };
}

function governedState(
  proof: ReturnType<typeof issueLoopBudgetMeasurement>
): GovernedRunState {
  const attempt = {
    id: proof.stageAttemptId,
    runId,
    stage: "implementation" as const,
    attempt: 1,
    status: "completed" as const,
    inputArtifacts: [],
    outputArtifacts: [],
    inputDigest: "3".repeat(64),
    outputDigest: "4".repeat(64),
    budgetUsage: { ...proof.cumulative, repairAttempts: 0 },
    budgetDelta: proof.delta,
    budgetMeasurement: proof,
    startedAt: claimedAt,
    finishedAt: measuredAt
  };
  return {
    schemaVersion: 1,
    runId,
    workflowRef: { id: "governed-increment-v1", version: "1", digest: "5".repeat(64) },
    bindings: {
      specRef: { specSetId: "spec-a", revision: 1, digest: "6".repeat(64) },
      governanceDigest: "7".repeat(64),
      harnessDigest: "8".repeat(64)
    },
    limits: { maxRepairAttempts: 3 },
    status: "completed",
    attempts: [attempt],
    nextInputArtifacts: [],
    budgetUsage: attempt.budgetUsage,
    repairHistory: [],
    createdAt: claimedAt,
    updatedAt: measuredAt,
    digest: "9".repeat(64)
  };
}

function run(implementationAttempt = 1): RunRecord {
  const domain = diffDomain(implementationAttempt);
  const runtimeDigest = "e".repeat(64);
  return {
    id: runId,
    taskId: "task-a",
    projectId: "project-a",
    tenantId,
    status: "completed",
    candidates: [{
      id: domain.candidateId,
      runId,
      provider: "claude",
      worktreePath: domain.workspaceUri,
      status: "completed",
      gates: []
    }],
    winnerCandidateId: domain.candidateId,
    gates: [],
    createdAt: claimedAt,
    updatedAt: measuredAt,
    harnessManifest: {
      stopConditions: { maxRepairAttempts: 3 }
    } as RunRecord["harnessManifest"],
    sandboxExecution: {
      backendId: "enterprise-container",
      backendVersion: "1",
      leaseId: domain.leaseId,
      attestationDigest: "f".repeat(64),
      runtimeId: domain.runtimeId,
      runtimeDigest,
      runtimeProof: {
        schemaVersion: 1,
        issuer: "mn-api",
        issuedAt: claimedAt,
        expiresAt: "2026-07-12T00:10:00.000Z",
        tenantId,
        runId,
        workerId,
        claimDigest,
        attestationDigest: "f".repeat(64),
        runtimeId: domain.runtimeId,
        runtimeDigest,
        digest: domain.runtimeProofDigest,
        signature: "0".repeat(64)
      }
    }
  };
}

function diffDomain(implementationAttempt = 1) {
  return {
    candidateId: "claude-1",
    workspaceUri: `mn://sandbox/lease-a/run-a--implementation-${implementationAttempt}-claude-1`,
    leaseId: "lease-a",
    runtimeId: "a".repeat(64),
    runtimeProofDigest: "b".repeat(64),
    projectSnapshotDigest: "c".repeat(64),
    candidateSnapshotDigest: "d".repeat(64)
  };
}

function item(): RunJobQueueItem {
  return {
    version: 2,
    runId,
    projectId: "project-a",
    taskId: "task-a",
    tenantId,
    status: "running",
    priority: 0,
    attempt: 1,
    recovered: false,
    createdAt: claimedAt,
    updatedAt: measuredAt,
    ownerId: workerId,
    claimTokenHash: claimDigest,
    claimedAt,
    claimExpiresAt: "2026-07-12T00:10:00.000Z"
  };
}
