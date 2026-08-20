import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GateResultV2, Project, RunRecord } from "@mn/core";
import type { SandboxLeaseAttestation } from "@mn/harness";
import type { GovernedRunState, LoopStageAttempt } from "@mn/loop";
import type { SpecRevision } from "@mn/specs";
import { issueLoopBudgetMeasurement } from "../src/loopBudgetMeasurement.js";
import {
  LOOP_DIFF_MANIFEST_CONTENT_TYPE,
  measureAuthoritativeLoopWorkspaceDiff
} from "../src/loopDiffMeasurement.js";
import {
  authorizeEnterpriseGateCheckpoint,
  type AuthoritativeGateAuthority
} from "../src/authoritativeGateVerification.js";
import {
  createGateArtifactHandleRecord,
  gateArtifactFromRecord
} from "../src/gateArtifactCas.js";
import { RunScopedCas } from "../src/runScopedCas.js";
import { MemoryStore } from "../src/store.js";
import type { RunJobQueueItem } from "../src/runJobQueue.js";
import { gateHasAuthoritativeReceipt } from "../src/server.js";

const signingKey = "checkpoint-gate-key-0123456789abcdef0123456789abcdef";
const tenantId = "tenant-a";
const runId = "run-a";
const candidateId = "candidate-a";
const claimDigest = "4".repeat(64);
const imageDigest = "8".repeat(64);

test("checkpoint authority re-executes once, persists a chainable receipt, and verifies history", async (t) => {
  const fixture = await checkpointFixture(t);
  const authority: AuthoritativeGateAuthority = {
    execute: async () => authorityResult(fixture.authorityGate)
  };
  const first = await authorizeEnterpriseGateCheckpoint({
    ...fixture.input,
    authority
  });
  assert.equal(first.error, undefined);
  assert.equal(first.newReceipts.length, 1);
  const record = first.newReceipts[0]!;
  fixture.store.authoritativeGateReceipts.set(record.id, record);
  fixture.store.governedLoopStates.set(runId, fixture.state);
  assert.equal(
    await gateHasAuthoritativeReceipt({
      run: fixture.input.incoming,
      gate: fixture.input.incoming.gateResultsV2![0]!,
      tenantId,
      projectId: "project-a",
      store: fixture.store,
      cas: fixture.input.cas,
      signingKey
    }),
    true,
    "enterprise evidence truth must require the signed Gate authority receipt"
  );

  const resumed = await authorizeEnterpriseGateCheckpoint({
    ...fixture.input,
    previousState: fixture.state,
    authority: {
      execute: async () => {
        throw new Error("historical Gate must not execute under a new claim");
      }
    }
  });
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.newReceipts.length, 0);

  fixture.store.authoritativeGateReceipts.set(record.id, {
    ...record,
    receipt: { ...record.receipt, signature: "f".repeat(64) }
  });
  assert.equal(
    await gateHasAuthoritativeReceipt({
      run: fixture.input.incoming,
      gate: fixture.input.incoming.gateResultsV2![0]!,
      tenantId,
      projectId: "project-a",
      store: fixture.store,
      cas: fixture.input.cas,
      signingKey
    }),
    false
  );
  const tampered = await authorizeEnterpriseGateCheckpoint({
    ...fixture.input,
    previousState: fixture.state,
    authority
  });
  assert.match(tampered.error ?? "", /signature mismatch/u);
});

test("checkpoint authority rejects workspace mutation during Gate execution", async (t) => {
  const fixture = await checkpointFixture(t);
  const decision = await authorizeEnterpriseGateCheckpoint({
    ...fixture.input,
    authority: {
      execute: async () => {
        await writeFile(
          join(fixture.candidateRoot, "service", "a.js"),
          "export const value = 3;\n",
          "utf8"
        );
        return authorityResult(fixture.authorityGate);
      }
    }
  });
  assert.match(decision.error ?? "", /changed during authoritative Gate execution/u);
});

test("checkpoint authority discards an interrupted verification without replaying Gates", async (t) => {
  const fixture = await checkpointFixture(t);
  const interrupted = {
    ...fixture.state.attempts[1]!,
    status: "failed" as const,
    failure: {
      kind: "interrupted" as const,
      retryable: true,
      reason: "previous verification outcome was indeterminate"
    }
  };
  const state = loopState([fixture.state.attempts[0]!, interrupted]);
  let executions = 0;
  const decision = await authorizeEnterpriseGateCheckpoint({
    ...fixture.input,
    state,
    previousState: fixture.input.previousState,
    incoming: {
      ...fixture.input.incoming,
      gateResultsV2: [],
      verificationEvidence: [{
        stageAttemptId: interrupted.id,
        gateResultIds: []
      }],
      sandboxEvidenceHistory: []
    },
    authority: {
      execute: async () => {
        executions += 1;
        return authorityResult(fixture.authorityGate);
      }
    }
  });

  assert.equal(decision.error, undefined);
  assert.equal(decision.newReceipts.length, 0);
  assert.equal(executions, 0);
});

test("checkpoint authority rejects evidence attached to an interrupted verification", async (t) => {
  const fixture = await checkpointFixture(t);
  const interrupted = {
    ...fixture.state.attempts[1]!,
    status: "failed" as const,
    failure: {
      kind: "interrupted" as const,
      retryable: true,
      reason: "previous verification outcome was indeterminate"
    }
  };
  const decision = await authorizeEnterpriseGateCheckpoint({
    ...fixture.input,
    state: loopState([fixture.state.attempts[0]!, interrupted]),
    authority: {
      execute: async () => authorityResult(fixture.authorityGate)
    }
  });

  assert.match(decision.error ?? "", /must have an empty evidence binding/u);
});

async function checkpointFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "mn-authoritative-gate-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const scratchRoot = join(root, "mn-docker-sandbox-test");
  const workspaceName = `${runId}--implementation-1-${candidateId}`;
  const candidateRoot = join(scratchRoot, workspaceName);
  await mkdir(join(projectRoot, "service"), { recursive: true });
  await mkdir(join(candidateRoot, "service"), { recursive: true });
  await writeFile(join(projectRoot, "service", "a.js"), "export const value = 1;\n");
  await writeFile(join(candidateRoot, "service", "a.js"), "export const value = 2;\n");
  const canonicalCandidateRoot = await realpath(candidateRoot);
  const measured = await measureAuthoritativeLoopWorkspaceDiff({
    projectRoot,
    candidateRoot
  });
  const cas = new RunScopedCas({ localRoot: join(root, "cas") });
  const diffRef = await cas.put({
    tenantId,
    projectId: "project-a",
    runId,
    contentType: LOOP_DIFF_MANIFEST_CONTENT_TYPE,
    content: measured.content
  });
  const workspaceUri = `mn://sandbox/lease-a/${workspaceName}`;
  const implementationProof = issueLoopBudgetMeasurement({
    tenantId,
    runId,
    workerId: "worker-a",
    claimDigest,
    stageAttemptId: `${runId}:implementation:1`,
    stage: "implementation",
    attempt: 1,
    intervalStartedAt: "2026-07-12T00:00:00.000Z",
    measuredAt: "2026-07-12T00:00:01.000Z",
    usageRequestIds: [],
    usageDigest: "5".repeat(64),
    diffArtifact: {
      id: diffRef.objectKey,
      uri: `mn://cas/loop-diffs/${encodeURIComponent(diffRef.objectKey)}`,
      digest: diffRef.digest,
      byteLength: diffRef.byteLength,
      candidateId,
      workspaceUri,
      leaseId: "lease-a",
      runtimeId: "2".repeat(64),
      runtimeProofDigest: "9".repeat(64),
      projectSnapshotDigest: measured.projectSnapshotDigest,
      candidateSnapshotDigest: measured.candidateSnapshotDigest
    },
    delta: {
      durationSeconds: 1,
      tokens: 0,
      costUsd: 0,
      changedFiles: measured.changedFiles,
      changedLines: measured.changedLines
    },
    signingKey
  });
  const execution = sandboxExecution();
  const authorityGate = gateResult({
    id: "authority-unit",
    workingDirectory: canonicalCandidateRoot,
    artifact: artifact("unit-log", "real gate output"),
    execution
  });
  const store = new MemoryStore();
  const log = Buffer.from("real gate output", "utf8");
  const gateRef = await cas.put({
    tenantId,
    projectId: "project-a",
    runId,
    contentType: "text/plain; charset=utf-8",
    content: log
  });
  const artifactRecord = createGateArtifactHandleRecord({
    tenantId,
    projectId: "project-a",
    runId,
    candidateId,
    gateResultId: "reported-unit",
    gateId: "unit",
    artifact: {
      id: "unit-log",
      kind: "log",
      contentType: "text/plain; charset=utf-8",
      digest: sha256(log),
      byteLength: log.byteLength
    },
    cas: gateRef,
    claimTokenHash: claimDigest,
    ownerId: "worker-a",
    registeredAt: "2026-07-12T00:00:02.000Z"
  });
  store.gateArtifactHandles.set(artifactRecord.handle, artifactRecord);
  const reportedGate = gateResult({
    id: "reported-unit",
    workingDirectory: workspaceUri,
    artifact: gateArtifactFromRecord(artifactRecord),
    execution
  });
  const spec = { specSetId: "spec-a", revision: 1, digest: "a".repeat(64) } as SpecRevision;
  const project: Project = {
    id: "project-a",
    tenantId,
    name: "Project A",
    rootPath: projectRoot,
    defaultBranch: "main",
    services: [{
      id: "service",
      name: "Service",
      path: "service",
      owners: ["team-a"],
      language: "javascript",
      contracts: []
    }],
    policyId: "default"
  };
  const harness = {
    specRef: { specSetId: "spec-a", revision: 1, digest: "a".repeat(64) },
    digest: "c".repeat(64)
  } as RunRecord["harnessManifest"];
  const governance = { digest: "b".repeat(64) } as RunRecord["governanceSnapshot"];
  const task = {
    id: "task-a",
    projectId: project.id,
    specRef: harness!.specRef
  } as Parameters<typeof authorizeEnterpriseGateCheckpoint>[0]["task"];
  const existing = baseRun({ project, harness, governance });
  const incoming: RunRecord = {
    ...existing,
    status: "verifying",
    candidates: [{
      id: candidateId,
      runId,
      provider: "claude",
      worktreePath: workspaceUri,
      status: "completed",
      gates: []
    }],
    winnerCandidateId: candidateId,
    gateResultsV2: [reportedGate],
    verificationEvidence: [{
      stageAttemptId: `${runId}:verification:1`,
      gateResultIds: [reportedGate.id]
    }],
    sandboxAttestation: attestation(),
    sandboxExecution: execution,
    sandboxEvidenceHistory: [{
      attestation: attestation(),
      execution,
      gateResultIds: [reportedGate.id],
      stageAttemptIds: [
        `${runId}:implementation:1`,
        `${runId}:verification:1`
      ]
    }]
  };
  const implementation = loopAttempt({
    id: `${runId}:implementation:1`,
    stage: "implementation",
    status: "completed",
    budgetMeasurement: implementationProof
  });
  const verification = loopAttempt({
    id: `${runId}:verification:1`,
    stage: "verification",
    status: "completed"
  });
  const runningVerification = { ...verification, status: "running" as const, finishedAt: undefined };
  const state = loopState([implementation, verification]);
  const previousState = loopState([implementation, runningVerification]);
  const item: RunJobQueueItem = {
    version: 2,
    runId,
    tenantId,
    projectId: project.id,
    taskId: "task-a",
    status: "running",
    priority: 0,
    attempt: 1,
    recovered: false,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:02.000Z",
    ownerId: "worker-a",
    claimTokenHash: claimDigest,
    workerCapabilityDigest: "d".repeat(64),
    claimedAt: "2026-07-12T00:00:00.000Z",
    claimExpiresAt: "2026-07-12T01:00:00.000Z"
  };
  return {
    store,
    state,
    candidateRoot: canonicalCandidateRoot,
    authorityGate,
    input: {
      existing,
      incoming,
      state,
      previousState,
      item,
      tenantId,
      workerId: "worker-a",
      signingKey,
      project,
      task,
      spec,
      runtimeVerifier: {
        verify: async () => ({
          runtimeId: execution.runtimeId,
          runtimeDigest: execution.runtimeDigest,
          imageDigest,
          projectRoot,
          scratchRoot,
          projectTarget: "/workspace/project",
          scratchTarget: "/workspace/scratch"
        })
      },
      store,
      cas,
      assertCurrentClaim: async () => true
    }
  };
}

function authorityResult(gate: GateResultV2) {
  return {
    results: [gate],
    legacyResults: [],
    successful: true,
    failureSignature: "f".repeat(64)
  };
}

function baseRun(input: {
  project: Project;
  harness: RunRecord["harnessManifest"];
  governance: RunRecord["governanceSnapshot"];
}): RunRecord {
  return {
    id: runId,
    tenantId,
    projectId: input.project.id,
    taskId: "task-a",
    status: "queued",
    candidates: [],
    gates: [],
    harnessManifest: input.harness,
    governanceSnapshot: input.governance,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z"
  };
}

function loopState(attempts: LoopStageAttempt[]): GovernedRunState {
  return {
    schemaVersion: 1,
    runId,
    workflowRef: {
      id: "governed-increment-v1",
      version: "1",
      digest: "0".repeat(64)
    },
    bindings: {
      specRef: { specSetId: "spec-a", revision: 1, digest: "a".repeat(64) },
      governanceDigest: "b".repeat(64),
      harnessDigest: "c".repeat(64)
    },
    limits: { maxRepairAttempts: 3 },
    status: "running",
    currentStage: "verification",
    nextInputArtifacts: [],
    attempts,
    budgetUsage: usage(),
    repairHistory: [],
    createdAt: "2026-07-12T00:00:00.000Z",
    digest: "f".repeat(64),
    updatedAt: "2026-07-12T00:00:02.000Z"
  };
}

function loopAttempt(input: {
  id: string;
  stage: LoopStageAttempt["stage"];
  status: LoopStageAttempt["status"];
  budgetMeasurement?: LoopStageAttempt["budgetMeasurement"];
}): LoopStageAttempt {
  return {
    id: input.id,
    runId,
    stage: input.stage,
    attempt: 1,
    status: input.status,
    inputArtifacts: [],
    outputArtifacts: [],
    inputDigest: "1".repeat(64),
    outputDigest: "2".repeat(64),
    budgetUsage: usage(),
    budgetDelta: { durationSeconds: 0, tokens: 0, costUsd: 0, changedFiles: 0, changedLines: 0 },
    ...(input.budgetMeasurement ? { budgetMeasurement: input.budgetMeasurement } : {}),
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:00:01.000Z"
  };
}

function usage() {
  return {
    durationSeconds: 1,
    tokens: 0,
    costUsd: 0,
    repairAttempts: 0,
    changedFiles: 1,
    changedLines: 2
  };
}

function gateResult(input: {
  id: string;
  workingDirectory: string;
  artifact: GateResultV2["artifacts"][number];
  execution: ReturnType<typeof sandboxExecution>;
}): GateResultV2 {
  return {
    schemaVersion: 2,
    id: input.id,
    runId,
    candidateId,
    gateId: "unit",
    runnerId: "unit",
    runnerVersion: "1",
    required: true,
    status: "pass",
    summary: "unit passed.",
    specClauseIds: ["acceptance-a"],
    command: { executable: "node", args: ["--test"], display: "node --test" },
    tool: { id: "node", version: "v22.0.0" },
    workingDirectory: input.workingDirectory,
    exitCode: 0,
    inputDigest: "7".repeat(64),
    outputDigest: "8".repeat(64),
    artifacts: [input.artifact],
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:00:01.000Z",
    freshUntil: "2026-07-12T01:00:01.000Z",
    sandboxExecution: input.execution
  };
}

function artifact(id: string, content: string) {
  const bytes = Buffer.from(content, "utf8");
  return {
    id,
    kind: "log" as const,
    contentType: "text/plain; charset=utf-8",
    digest: sha256(bytes),
    byteLength: bytes.byteLength,
    path: `mn://authority/${id}`
  };
}

function sandboxExecution() {
  return {
    backendId: "enterprise-container",
    backendVersion: "1",
    leaseId: "lease-a",
    attestationDigest: "1".repeat(64),
    runtimeId: "2".repeat(64),
    runtimeDigest: "3".repeat(64),
    imageDigest,
    runtimeProof: {
      schemaVersion: 1 as const,
      issuer: "mn-api" as const,
      issuedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T02:00:00.000Z",
      tenantId,
      runId,
      workerId: "worker-a",
      claimDigest,
      attestationDigest: "1".repeat(64),
      runtimeId: "2".repeat(64),
      runtimeDigest: "3".repeat(64),
      imageDigest,
      digest: "9".repeat(64),
      signature: "5".repeat(64)
    }
  };
}

function attestation(): SandboxLeaseAttestation {
  return {
    schemaVersion: 1,
    leaseId: "lease-a",
    issuer: "mn-api",
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-12T02:00:00.000Z",
    runId,
    tenantId,
    workerId: "worker-a",
    harnessDigest: "c".repeat(64),
    requirementsDigest: "e".repeat(64),
    workerCapabilityDigest: "d".repeat(64),
    claimDigest,
    backend: { id: "enterprise-container", version: "1" },
    policy: {
      mounts: [
        { source: "project", target: "/workspace/project", readOnly: true },
        { source: "scratch", target: "/workspace/scratch", readOnly: false }
      ],
      network: { mode: "deny", allowlist: [] },
      resources: { cpu: 1, memoryMb: 512, pids: 64, timeoutSeconds: 600 },
      secretNames: [],
      allowedTools: ["node"],
      readOnlyRootFilesystem: true,
      runtimeImage: { reference: "node:22-alpine", digest: imageDigest }
    },
    policyDigest: "6".repeat(64),
    digest: "1".repeat(64),
    signature: "0".repeat(64)
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
