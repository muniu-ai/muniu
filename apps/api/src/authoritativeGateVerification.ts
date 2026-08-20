import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AgentTask,
  GateArtifactV2,
  GateResultV2,
  Project,
  RunRecord
} from "@mn/core";
import { sha256Canonical } from "@mn/governance";
import type {
  HarnessManifest,
  SandboxExecutionEvidence,
  SandboxLeaseAttestation
} from "@mn/harness";
import type { SpecRevision } from "@mn/specs";
import type { GovernedRunState, LoopStageAttempt } from "@mn/loop";
import {
  captureContractBaseline,
  projectAtSnapshot,
  runGovernedGatePlan,
  type GateCommandExecutionRequest,
  type GateCommandExecutionResult,
  type GateCommandExecutor,
  type GateResolvedToolIdentity,
  type GovernedGateExecutionResult
} from "@mn/worker";
import {
  sandboxRuntimeClaimLabels,
  type SandboxRuntimeVerificationResult,
  type SandboxRuntimeVerifier
} from "./dockerRuntimeVerifier.js";
import {
  LOOP_DIFF_MANIFEST_CONTENT_TYPE,
  measureAuthoritativeLoopWorkspaceDiff,
  measureLoopDiffManifest,
  resolveAuthoritativeCandidateWorkspace
} from "./loopDiffMeasurement.js";
import {
  resolveVerifiedGateArtifact
} from "./gateArtifactCas.js";
import type {
  AuthoritativeGateReceiptRecord,
  MemoryStore
} from "./store.js";
import type { RunJobQueueItem } from "./runJobQueue.js";
import type { RunScopedCas, RunScopedCasObjectRef } from "./runScopedCas.js";

const RECEIPT_SIGNATURE_DOMAIN = "mn-authoritative-gate-receipt-v1\0";
const MAX_DOCKER_OUTPUT_BYTES = 16 * 1024 * 1024;
const REQUIRED_MASKED_PATHS = Object.freeze([
  "/proc/acpi",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/scsi",
  "/proc/timer_list",
  "/proc/timer_stats",
  "/sys/firmware"
]);
const REQUIRED_READONLY_PATHS = Object.freeze([
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/sys",
  "/proc/sysrq-trigger"
]);
const TOOL_IDENTITY_SCRIPT = [
  "set -eu",
  "tool=$1",
  "resolved=$(command -v \"$tool\")",
  "canonical=$(readlink -f \"$resolved\")",
  "case \"$canonical\" in /bin/*|/sbin/*|/usr/*|/opt/*) ;; *) exit 65 ;; esac",
  "digest=$(sha256sum \"$canonical\")",
  "digest=${digest%% *}",
  "printf '%s\\n%s\\n' \"$canonical\" \"$digest\""
].join("\n");

export interface AuthoritativeGateExecutionInput {
  readonly project: Project;
  readonly task: AgentTask;
  readonly manifest: HarnessManifest;
  readonly spec?: SpecRevision;
  readonly candidateRoot: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly changedPaths: readonly string[];
  /** Authoritative implementation measurement that the private execution
   * snapshot must reproduce byte-for-byte before any Gate is allowed to run. */
  readonly projectSnapshotDigest: string;
  readonly candidateSnapshotDigest: string;
  readonly diffArtifact: Uint8Array;
  readonly sandboxExecution: SandboxExecutionEvidence;
  readonly runtime: SandboxRuntimeVerificationResult;
  readonly attestation: SandboxLeaseAttestation;
}

/** Injectable for route tests and remote authorities. Production uses the
 * Docker implementation below, which is the only component allowed to issue
 * command executions from the API process. */
export interface AuthoritativeGateAuthority {
  execute(input: AuthoritativeGateExecutionInput): Promise<GovernedGateExecutionResult>;
}

export interface DockerAuthoritativeGateAuthorityOptions {
  readonly dockerBinary?: string;
  readonly snapshotRootParent?: string;
}

/** Re-runs the complete governed plan from an API-owned immutable copy in a
 * fresh container. The worker runtime is evidence only: neither its writable
 * candidate directory nor its container is used by the authority execution. */
export class DockerAuthoritativeGateAuthority implements AuthoritativeGateAuthority {
  readonly #dockerBinary: string;
  readonly #snapshotRootParent: string;

  constructor(options: DockerAuthoritativeGateAuthorityOptions = {}) {
    this.#dockerBinary = safeExecutable(options.dockerBinary ?? "docker", "dockerBinary");
    this.#snapshotRootParent = resolve(options.snapshotRootParent ?? tmpdir());
  }

  async execute(input: AuthoritativeGateExecutionInput): Promise<GovernedGateExecutionResult> {
    assertAuthorityRuntimeBinding(input);
    const authorityRoot = await realpath(
      await mkdtemp(join(this.#snapshotRootParent, "mn-gate-authority-"))
    );
    const projectRoot = join(authorityRoot, "project");
    const candidateRoot = join(authorityRoot, "candidate");
    let containerId: string | undefined;
    try {
      await cp(await realpath(input.project.rootPath), projectRoot, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        preserveTimestamps: true
      });
      await cp(await realpath(input.candidateRoot), candidateRoot, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        preserveTimestamps: true
      });
      const copied = await assertAuthoritySnapshotBinding({
        projectRoot,
        candidateRoot,
        expectedProjectDigest: input.projectSnapshotDigest,
        expectedCandidateDigest: input.candidateSnapshotDigest,
        expectedDiffArtifact: input.diffArtifact
      });
      await makeTreeReadOnly(projectRoot);
      await makeTreeReadOnly(candidateRoot);
      const runtime = await createAuthorityContainer({
        dockerBinary: this.#dockerBinary,
        candidateRoot,
        attestation: input.attestation
      });
      containerId = runtime.containerId;
      const authorityProject = projectAtSnapshot(input.project, projectRoot);
      const result = await runGovernedGatePlan({
        project: authorityProject,
        task: input.task,
        manifest: input.manifest,
        candidateRoot,
        evidenceRoot: input.candidateRoot,
        runId: input.runId,
        candidateId: input.candidateId,
        changedPaths: [...input.changedPaths],
        ...(input.spec ? { spec: input.spec } : {}),
        contractBaseline: await captureContractBaseline(authorityProject),
        commandExecutor: authorityContainerCommandExecutor({
          dockerBinary: this.#dockerBinary,
          containerId: runtime.containerId,
          candidateRoot,
          candidateTarget: runtime.candidateTarget,
          attestation: input.attestation,
          sandboxExecution: input.sandboxExecution
        })
      });
      const after = await assertAuthoritySnapshotBinding({
        projectRoot,
        candidateRoot,
        expectedProjectDigest: input.projectSnapshotDigest,
        expectedCandidateDigest: input.candidateSnapshotDigest,
        expectedDiffArtifact: copied.content
      });
      if (!after.content.equals(copied.content)) {
        throw new Error("API-owned authority snapshot changed during Gate execution");
      }
      return result;
    } finally {
      if (containerId) {
        await dockerControl(this.#dockerBinary, ["rm", "-f", containerId], 30)
          .catch(() => undefined);
      }
      await makeTreeWritable(authorityRoot).catch(() => undefined);
      await rm(authorityRoot, { recursive: true, force: true });
    }
  }
}

export interface ReportedGateArtifactResolver {
  (
    gate: GateResultV2,
    artifact: GateArtifactV2
  ): Promise<Buffer | Uint8Array | undefined>;
}

export interface GateReconciliationInput {
  readonly reported: readonly GateResultV2[];
  readonly authoritative: readonly GateResultV2[];
  readonly resolveReportedArtifact: ReportedGateArtifactResolver;
  /** Converts an opaque mn://sandbox URI back to the authority-resolved host
   * path before it is compared with the re-execution result. */
  readonly resolveReportedWorkingDirectory: (value: string) => Promise<string> | string;
}

export interface GateReconciliationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly reportedResultsDigest?: string;
  readonly authoritativeResultsDigest?: string;
}

/** Exact reconciliation boundary. In particular, a valid claim and runtime
 * proof cannot turn a fabricated pass/exit/log into accepted evidence: every
 * artifact declaration is resolved to CAS bytes and compared with the bytes
 * emitted by the authority's independent execution. */
export async function reconcileAuthoritativeGateResults(
  input: GateReconciliationInput
): Promise<GateReconciliationResult> {
  if (input.reported.length !== input.authoritative.length) {
    return invalid(
      `reported Gate result count ${input.reported.length} does not match authoritative count ${input.authoritative.length}`
    );
  }
  const verifiedReported: unknown[] = [];
  const verifiedAuthority: unknown[] = [];
  for (let index = 0; index < input.authoritative.length; index += 1) {
    const reported = input.reported[index]!;
    const authoritative = input.authoritative[index]!;
    const reportedWorkingDirectory = await input.resolveReportedWorkingDirectory(
      reported.workingDirectory
    );
    const authoritativeWorkingDirectory = await realpath(
      resolve(authoritative.workingDirectory)
    );
    const scalarPairs: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["runId", reported.runId, authoritative.runId],
      ["candidateId", reported.candidateId, authoritative.candidateId],
      ["gateId", reported.gateId, authoritative.gateId],
      ["runnerId", reported.runnerId, authoritative.runnerId],
      ["runnerVersion", reported.runnerVersion, authoritative.runnerVersion],
      ["required", reported.required, authoritative.required],
      ["status", reported.status, authoritative.status],
      ["summary", reported.summary, authoritative.summary],
      ["exitCode", reported.exitCode, authoritative.exitCode],
      ["command", reported.command ?? null, authoritative.command ?? null],
      ["tool", reported.tool ?? null, authoritative.tool ?? null],
      ["specClauseIds", reported.specClauseIds, authoritative.specClauseIds],
      ["workingDirectory", resolve(reportedWorkingDirectory), authoritativeWorkingDirectory],
      ["inputDigest", reported.inputDigest, authoritative.inputDigest],
      ["sandboxExecution", reported.sandboxExecution ?? null, authoritative.sandboxExecution ?? null]
    ];
    for (const [field, actual, expected] of scalarPairs) {
      if (sha256Canonical(actual) !== sha256Canonical(expected)) {
        return invalid(
          `Gate ${authoritative.gateId} result ${index} ${field} does not match authoritative execution`
        );
      }
    }
    if (reported.artifacts.length !== authoritative.artifacts.length) {
      return invalid(
        `Gate ${authoritative.gateId} artifact count does not match authoritative execution`
      );
    }
    const reportedArtifacts: unknown[] = [];
    const authorityArtifacts: unknown[] = [];
    for (let artifactIndex = 0; artifactIndex < authoritative.artifacts.length; artifactIndex += 1) {
      const reportedArtifact = reported.artifacts[artifactIndex]!;
      const authorityArtifact = authoritative.artifacts[artifactIndex]!;
      const content = await input.resolveReportedArtifact(reported, reportedArtifact);
      if (!content) {
        return invalid(
          `Gate ${authoritative.gateId} artifact ${reportedArtifact.id} has no retrievable API-managed bytes`
        );
      }
      const bytes = Buffer.from(content);
      const actualDigest = sha256(bytes);
      if (
        actualDigest !== reportedArtifact.digest ||
        bytes.byteLength !== reportedArtifact.byteLength
      ) {
        return invalid(
          `Gate ${authoritative.gateId} artifact ${reportedArtifact.id} declaration does not match CAS bytes`
        );
      }
      const artifactPairs: ReadonlyArray<readonly [string, unknown, unknown]> = [
        ["id", reportedArtifact.id, authorityArtifact.id],
        ["kind", reportedArtifact.kind, authorityArtifact.kind],
        ["contentType", reportedArtifact.contentType, authorityArtifact.contentType],
        ["digest", actualDigest, authorityArtifact.digest],
        ["byteLength", bytes.byteLength, authorityArtifact.byteLength]
      ];
      for (const [field, actual, expected] of artifactPairs) {
        if (sha256Canonical(actual) !== sha256Canonical(expected)) {
          return invalid(
            `Gate ${authoritative.gateId} artifact ${reportedArtifact.id} ${field} does not match authoritative bytes`
          );
        }
      }
      reportedArtifacts.push(reportedArtifactSemantic(reportedArtifact, actualDigest));
      authorityArtifacts.push(authorityArtifactSemantic(authorityArtifact));
    }
    verifiedReported.push(reportedResultSemantic(reported, reported.workingDirectory, reportedArtifacts));
    verifiedAuthority.push(
      authoritativeResultSemantic(
        authoritative,
        authoritativeWorkingDirectory,
        authorityArtifacts
      )
    );
  }
  return Object.freeze({
    valid: true,
    reportedResultsDigest: sha256Canonical(verifiedReported),
    authoritativeResultsDigest: sha256Canonical(verifiedAuthority)
  });
}

/** Recomputes the durable worker-side receipt binding from API-managed bytes.
 * Unlike reconciliation it retains the opaque sandbox URI, so historical
 * receipts remain verifiable after their Docker scratch directory is gone. */
export async function verifiedReportedGateResultsDigest(input: {
  readonly results: readonly GateResultV2[];
  readonly resolveReportedArtifact: ReportedGateArtifactResolver;
}): Promise<string> {
  const semantics: unknown[] = [];
  for (const gate of input.results) {
    const artifacts: unknown[] = [];
    for (const artifact of gate.artifacts) {
      const content = await input.resolveReportedArtifact(gate, artifact);
      if (!content) {
        throw new TypeError(
          `Gate ${gate.gateId} artifact ${artifact.id} has no retrievable API-managed bytes`
        );
      }
      const bytes = Buffer.from(content);
      const actualDigest = sha256(bytes);
      if (actualDigest !== artifact.digest || bytes.byteLength !== artifact.byteLength) {
        throw new TypeError(
          `Gate ${gate.gateId} artifact ${artifact.id} declaration does not match CAS bytes`
        );
      }
      artifacts.push(reportedArtifactSemantic(artifact, actualDigest));
    }
    semantics.push(reportedResultSemantic(gate, gate.workingDirectory, artifacts));
  }
  return sha256Canonical(semantics);
}

export interface AuthoritativeGateReceipt {
  readonly schemaVersion: 1;
  readonly issuer: "mn-api";
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stageAttemptId: string;
  readonly attempt: number;
  readonly workerId: string;
  readonly claimDigest: string;
  readonly leaseId: string;
  readonly runtimeId: string;
  readonly runtimeDigest: string;
  readonly runtimeProofDigest: string;
  readonly candidateId: string;
  readonly workspaceUri: string;
  readonly diffArtifactDigest: string;
  readonly projectSnapshotDigest: string;
  readonly candidateSnapshotDigest: string;
  readonly specDigest: string;
  readonly governanceDigest: string;
  readonly harnessDigest: string;
  readonly reportedResultsDigest: string;
  readonly authoritativeResultsDigest: string;
  readonly passed: boolean;
  readonly previousReceiptDigest?: string;
  readonly issuedAt: string;
  readonly digest: string;
  readonly signature: string;
}

export type AuthoritativeGateReceiptBinding = Omit<
  AuthoritativeGateReceipt,
  "schemaVersion" | "issuer" | "issuedAt" | "digest" | "signature"
>;

export function issueAuthoritativeGateReceipt(
  binding: AuthoritativeGateReceiptBinding,
  signingKey: string,
  issuedAt = new Date().toISOString()
): AuthoritativeGateReceipt {
  const semantic = {
    schemaVersion: 1 as const,
    issuer: "mn-api" as const,
    ...normalizeReceiptBinding(binding),
    issuedAt: timestamp(issuedAt, "issuedAt")
  };
  const digest = sha256Canonical(semantic);
  return deepFreeze({
    ...semantic,
    digest,
    signature: signReceipt(digest, signingKey)
  });
}

export function verifyAuthoritativeGateReceipt(
  value: unknown,
  signingKey: string
): { readonly valid: boolean; readonly reason?: string; readonly receipt?: AuthoritativeGateReceipt } {
  try {
    if (!isRecord(value)) throw new TypeError("authoritative Gate receipt must be an object");
    const receipt = value as unknown as AuthoritativeGateReceipt;
    if (receipt.schemaVersion !== 1 || receipt.issuer !== "mn-api") {
      throw new TypeError("authoritative Gate receipt schema is unsupported");
    }
    const { digest, signature, issuedAt, schemaVersion: _schemaVersion, issuer: _issuer, ...raw } = receipt;
    const semantic = {
      schemaVersion: 1 as const,
      issuer: "mn-api" as const,
      ...normalizeReceiptBinding(raw as AuthoritativeGateReceiptBinding),
      issuedAt: timestamp(issuedAt, "issuedAt")
    };
    const expectedDigest = sha256Canonical(semantic);
    if (!safeEqual(digest, expectedDigest)) {
      throw new TypeError("authoritative Gate receipt content digest mismatch");
    }
    if (!safeEqual(signature, signReceipt(expectedDigest, signingKey))) {
      throw new TypeError("authoritative Gate receipt signature mismatch");
    }
    return { valid: true, receipt: deepFreeze({ ...semantic, digest, signature }) };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : "invalid authoritative Gate receipt"
    };
  }
}

export interface EnterpriseGateAuthorizationInput {
  readonly existing: RunRecord;
  readonly incoming: RunRecord;
  readonly state: GovernedRunState;
  readonly previousState?: GovernedRunState;
  readonly item: RunJobQueueItem;
  readonly tenantId: string;
  readonly workerId: string;
  readonly signingKey: string;
  readonly project: Project;
  readonly task: AgentTask;
  readonly spec: SpecRevision;
  readonly authority: AuthoritativeGateAuthority;
  readonly runtimeVerifier: SandboxRuntimeVerifier;
  readonly store: MemoryStore;
  readonly cas: RunScopedCas;
  /** Must inspect PostgreSQL, not a cached item. It is invoked before and
   * after every authority execution to close claim-release/reclaim races. */
  readonly assertCurrentClaim: () => Promise<boolean>;
}

export interface EnterpriseGateAuthorizationDecision {
  readonly error?: string;
  readonly newReceipts: readonly AuthoritativeGateReceiptRecord[];
}

/** Authorizes only newly completed verification attempts. Historical attempts
 * are checked against the append-only signed receipt chain and immutable Gate
 * evidence, but are never re-run under a later claim. */
export async function authorizeEnterpriseGateCheckpoint(
  input: EnterpriseGateAuthorizationInput
): Promise<EnterpriseGateAuthorizationDecision> {
  try {
    assertCheckpointBindings(input);
    const verificationAttempts = input.state.attempts
      .map((attempt, index) => ({ attempt, index }))
      .filter(({ attempt }) => attempt.stage === "verification" && attempt.status !== "running");
    const receiptRecords = [...input.store.authoritativeGateReceipts.values()]
      .filter(
        (record) =>
          record.tenantId === input.tenantId &&
          record.projectId === input.project.id &&
          record.runId === input.incoming.id
      );
    const receiptByAttempt = new Map<string, AuthoritativeGateReceiptRecord>();
    for (const record of receiptRecords) {
      if (receiptByAttempt.has(record.stageAttemptId)) {
        return decisionError(
          `verification attempt ${record.stageAttemptId} has duplicate authoritative receipts`
        );
      }
      receiptByAttempt.set(record.stageAttemptId, record);
    }
    const knownAttemptIds = new Set(verificationAttempts.map(({ attempt }) => attempt.id));
    const orphan = receiptRecords.find((record) => !knownAttemptIds.has(record.stageAttemptId));
    if (orphan) {
      return decisionError(
        `authoritative Gate receipt ${orphan.id} is not bound to a verification attempt`
      );
    }

    const resultsById = new Map(
      (input.incoming.gateResultsV2 ?? []).map((result) => [result.id, result])
    );
    const evidenceByAttempt = new Map(
      (input.incoming.verificationEvidence ?? []).map((binding) => [
        binding.stageAttemptId,
        binding.gateResultIds.map((id) => resultsById.get(id)).filter(
          (result): result is GateResultV2 => Boolean(result)
        )
      ])
    );
    const artifactResolver = async (gate: GateResultV2, artifact: GateArtifactV2) =>
      (await resolveVerifiedGateArtifact({
        tenantId: input.tenantId,
        projectId: input.project.id,
        runId: input.incoming.id,
        gate,
        artifact,
        store: input.store,
        cas: input.cas
      }))?.content;

    let previousReceiptDigest: string | undefined;
    const pending: AuthoritativeGateReceiptRecord[] = [];
    for (const { attempt, index } of verificationAttempts) {
      const reported = evidenceByAttempt.get(attempt.id);
      // The Loop recovery contract closes a trailing indeterminate handler as
      // failed/interrupted. It was never known to have produced Gate output,
      // so it must carry an explicit empty evidence binding and must never be
      // re-executed by a later claim. All ordinary failed/completed
      // verification attempts remain subject to authoritative replay.
      if (
        attempt.status === "failed" &&
        attempt.failure?.kind === "interrupted"
      ) {
        if (!reported || reported.length !== 0) {
          return decisionError(
            `interrupted verification attempt ${attempt.id} must have an empty evidence binding`
          );
        }
        if (receiptByAttempt.has(attempt.id)) {
          return decisionError(
            `interrupted verification attempt ${attempt.id} must not have an authoritative Gate receipt`
          );
        }
        continue;
      }
      if (!reported || reported.length === 0) {
        return decisionError(
          `verification attempt ${attempt.id} has no results for authoritative execution`
        );
      }
      const existingReceipt = receiptByAttempt.get(attempt.id);
      if (existingReceipt) {
        const historicalError = await validateHistoricalReceipt({
          input,
          attempt,
          reported,
          record: existingReceipt,
          expectedPreviousReceiptDigest: previousReceiptDigest,
          artifactResolver
        });
        if (historicalError) return decisionError(historicalError);
        previousReceiptDigest = existingReceipt.receipt.digest;
        continue;
      }

      const previousAttempt = input.previousState?.attempts[index];
      const newlyCompleted =
        !previousAttempt ||
        (previousAttempt.id === attempt.id && previousAttempt.status === "running");
      if (!newlyCompleted) {
        return decisionError(
          `historical verification attempt ${attempt.id} has no authoritative Gate receipt`
        );
      }
      const preceding = precedingImplementationAttempt(input.state.attempts, index);
      const diff = preceding?.budgetMeasurement?.diffArtifact;
      if (!preceding || !diff) {
        return decisionError(
          `verification attempt ${attempt.id} has no preceding authoritative implementation snapshot`
        );
      }
      if (
        diff.candidateId !== reported[0]!.candidateId ||
        reported.some((result) => result.candidateId !== diff.candidateId) ||
        input.incoming.winnerCandidateId !== diff.candidateId
      ) {
        return decisionError(
          `verification attempt ${attempt.id} candidate does not match its preceding implementation proof`
        );
      }
      const attestation = input.incoming.sandboxAttestation;
      const execution = input.incoming.sandboxExecution;
      if (
        !attestation ||
        !execution ||
        !input.item.claimTokenHash ||
        execution.leaseId !== attestation.leaseId ||
        execution.runtimeProof.claimDigest !== input.item.claimTokenHash
      ) {
        return decisionError(
          `verification attempt ${attempt.id} runtime does not match the active claim`
        );
      }
      const verificationWorkspaceUri = gateCandidateWorkspaceUri({
        reported,
        leaseId: attestation.leaseId,
        runId: input.incoming.id,
        candidateId: diff.candidateId,
        implementationWorkspaceUri: diff.workspaceUri,
        implementationLeaseId: diff.leaseId
      });

      if (!(await input.assertCurrentClaim())) {
        return decisionError("run job claim changed before authoritative Gate execution");
      }
      const beforeRuntime = await input.runtimeVerifier.verify({
        runtimeId: execution.runtimeId,
        attestation,
        projectRoot: input.project.rootPath
      });
      if (beforeRuntime.runtimeDigest !== execution.runtimeDigest) {
        return decisionError("authoritative Gate runtime digest changed before execution");
      }
      const candidateRoot = await resolveAuthoritativeCandidateWorkspace({
        workspaceUri: verificationWorkspaceUri,
        leaseId: attestation.leaseId,
        scratchRoot: beforeRuntime.scratchRoot,
        runId: input.incoming.id,
        implementationAttempt: preceding.attempt,
        candidateId: diff.candidateId
      });
      const beforeSnapshot = await measureAuthoritativeLoopWorkspaceDiff({
        projectRoot: beforeRuntime.projectRoot,
        candidateRoot
      });
      const diffBytes = await input.cas.readVerified(diffRef(diff));
      if (
        !diffBytes ||
        beforeSnapshot.projectSnapshotDigest !== diff.projectSnapshotDigest ||
        beforeSnapshot.candidateSnapshotDigest !== diff.candidateSnapshotDigest ||
        !beforeSnapshot.content.equals(diffBytes)
      ) {
        return decisionError(
          `verification attempt ${attempt.id} workspace changed after its implementation measurement`
        );
      }
      // Parse the stored bytes again at this boundary. This ensures changed
      // paths are sourced from the same CAS object bound into the measurement.
      const changedPaths = measureLoopDiffManifest(diffBytes).manifest.files.map(
        (file) => file.path
      );
      const authoritative = await input.authority.execute({
        project: input.project,
        task: input.task,
        manifest: input.existing.harnessManifest!,
        spec: input.spec,
        candidateRoot,
        runId: input.incoming.id,
        candidateId: diff.candidateId,
        changedPaths,
        projectSnapshotDigest: diff.projectSnapshotDigest,
        candidateSnapshotDigest: diff.candidateSnapshotDigest,
        diffArtifact: diffBytes,
        sandboxExecution: execution,
        runtime: beforeRuntime,
        attestation
      });
      const afterSnapshot = await measureAuthoritativeLoopWorkspaceDiff({
        projectRoot: beforeRuntime.projectRoot,
        candidateRoot
      });
      const afterRuntime = await input.runtimeVerifier.verify({
        runtimeId: execution.runtimeId,
        attestation,
        projectRoot: input.project.rootPath
      });
      if (!(await input.assertCurrentClaim())) {
        return decisionError("run job claim changed during authoritative Gate execution");
      }
      if (
        afterRuntime.runtimeId !== beforeRuntime.runtimeId ||
        afterRuntime.runtimeDigest !== beforeRuntime.runtimeDigest ||
        afterSnapshot.projectSnapshotDigest !== diff.projectSnapshotDigest ||
        afterSnapshot.candidateSnapshotDigest !== diff.candidateSnapshotDigest ||
        !afterSnapshot.content.equals(diffBytes)
      ) {
        return decisionError(
          `verification attempt ${attempt.id} workspace or runtime changed during authoritative Gate execution`
        );
      }
      const reconciliation = await reconcileAuthoritativeGateResults({
        reported,
        authoritative: authoritative.results,
        resolveReportedArtifact: artifactResolver,
        resolveReportedWorkingDirectory: (value) =>
          resolveGateWorkspaceUri({
            value,
            leaseId: attestation.leaseId,
            workspaceUri: verificationWorkspaceUri,
            candidateRoot
          })
      });
      if (
        !reconciliation.valid ||
        !reconciliation.reportedResultsDigest ||
        !reconciliation.authoritativeResultsDigest
      ) {
        return decisionError(
          reconciliation.reason ?? `verification attempt ${attempt.id} did not reconcile`
        );
      }
      const expectedPassed = attempt.status === "completed";
      if (authoritative.successful !== expectedPassed) {
        return decisionError(
          `verification attempt ${attempt.id} status does not match authoritative plan outcome`
        );
      }
      const receipt = issueAuthoritativeGateReceipt(
        {
          tenantId: input.tenantId,
          projectId: input.project.id,
          runId: input.incoming.id,
          stageAttemptId: attempt.id,
          attempt: attempt.attempt,
          workerId: input.workerId,
          claimDigest: input.item.claimTokenHash,
          leaseId: attestation.leaseId,
          runtimeId: execution.runtimeId,
          runtimeDigest: execution.runtimeDigest,
          runtimeProofDigest: execution.runtimeProof.digest,
          candidateId: diff.candidateId,
          workspaceUri: verificationWorkspaceUri,
          diffArtifactDigest: diff.digest,
          projectSnapshotDigest: diff.projectSnapshotDigest,
          candidateSnapshotDigest: diff.candidateSnapshotDigest,
          specDigest: input.spec.digest!,
          governanceDigest: input.existing.governanceSnapshot!.digest,
          harnessDigest: input.existing.harnessManifest!.digest,
          reportedResultsDigest: reconciliation.reportedResultsDigest,
          authoritativeResultsDigest: reconciliation.authoritativeResultsDigest,
          passed: expectedPassed,
          ...(previousReceiptDigest ? { previousReceiptDigest } : {})
        },
        input.signingKey
      );
      const record = Object.freeze({
        id: receipt.digest,
        tenantId: input.tenantId,
        projectId: input.project.id,
        runId: input.incoming.id,
        stageAttemptId: attempt.id,
        receipt
      });
      pending.push(record);
      receiptByAttempt.set(attempt.id, record);
      previousReceiptDigest = receipt.digest;
    }
    return Object.freeze({ newReceipts: Object.freeze(pending) });
  } catch (error) {
    return decisionError(
      error instanceof Error ? error.message : "authoritative Gate verification failed"
    );
  }
}

async function validateHistoricalReceipt(input: {
  readonly input: EnterpriseGateAuthorizationInput;
  readonly attempt: LoopStageAttempt;
  readonly reported: readonly GateResultV2[];
  readonly record: AuthoritativeGateReceiptRecord;
  readonly expectedPreviousReceiptDigest?: string;
  readonly artifactResolver: ReportedGateArtifactResolver;
}): Promise<string | undefined> {
  const verified = verifyAuthoritativeGateReceipt(
    input.record.receipt,
    input.input.signingKey
  );
  if (!verified.valid || !verified.receipt) {
    return `verification attempt ${input.attempt.id} has an invalid authoritative receipt: ${verified.reason ?? "verification failed"}`;
  }
  const receipt = verified.receipt;
  const record = input.record;
  if (
    record.id !== receipt.digest ||
    record.tenantId !== receipt.tenantId ||
    record.projectId !== receipt.projectId ||
    record.runId !== receipt.runId ||
    record.stageAttemptId !== receipt.stageAttemptId ||
    receipt.tenantId !== input.input.tenantId ||
    receipt.projectId !== input.input.project.id ||
    receipt.runId !== input.input.incoming.id ||
    receipt.stageAttemptId !== input.attempt.id ||
    receipt.attempt !== input.attempt.attempt ||
    receipt.specDigest !== input.input.spec.digest ||
    receipt.governanceDigest !== input.input.existing.governanceSnapshot?.digest ||
    receipt.harnessDigest !== input.input.existing.harnessManifest?.digest ||
    receipt.passed !== (input.attempt.status === "completed") ||
    receipt.previousReceiptDigest !== input.expectedPreviousReceiptDigest
  ) {
    return `verification attempt ${input.attempt.id} authoritative receipt binding is invalid`;
  }
  let currentDigest: string;
  try {
    currentDigest = await verifiedReportedGateResultsDigest({
      results: input.reported,
      resolveReportedArtifact: input.artifactResolver
    });
  } catch (error) {
    return error instanceof Error ? error.message : "historical Gate artifact verification failed";
  }
  if (currentDigest !== receipt.reportedResultsDigest) {
    return `verification attempt ${input.attempt.id} evidence does not match its authoritative receipt`;
  }
  const evidenceBinding = input.input.incoming.sandboxEvidenceHistory?.find((binding) =>
    binding.stageAttemptIds.includes(input.attempt.id) &&
    input.reported.every((result) => binding.gateResultIds.includes(result.id))
  );
  if (
    !evidenceBinding ||
    evidenceBinding.execution.leaseId !== receipt.leaseId ||
    evidenceBinding.execution.runtimeId !== receipt.runtimeId ||
    evidenceBinding.execution.runtimeDigest !== receipt.runtimeDigest ||
    evidenceBinding.execution.runtimeProof.digest !== receipt.runtimeProofDigest
  ) {
    return `verification attempt ${input.attempt.id} receipt is not bound to its historical sandbox runtime`;
  }
  return undefined;
}

function assertCheckpointBindings(input: EnterpriseGateAuthorizationInput): void {
  if (
    !input.existing.harnessManifest ||
    !input.existing.governanceSnapshot ||
    input.incoming.id !== input.existing.id ||
    input.state.runId !== input.incoming.id ||
    input.task.id !== input.incoming.taskId ||
    input.project.id !== input.incoming.projectId ||
    input.spec.specSetId !== input.existing.harnessManifest.specRef.specSetId ||
    input.spec.revision !== input.existing.harnessManifest.specRef.revision ||
    input.spec.digest !== input.existing.harnessManifest.specRef.digest ||
    input.item.runId !== input.incoming.id ||
    input.item.tenantId !== input.tenantId ||
    !input.item.claimTokenHash
  ) {
    throw new TypeError("authoritative Gate checkpoint immutable bindings are incomplete");
  }
}

function precedingImplementationAttempt(
  attempts: readonly LoopStageAttempt[],
  verificationIndex: number
): LoopStageAttempt | undefined {
  for (let index = verificationIndex - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt?.stage === "implementation" && attempt.status === "completed") {
      return attempt;
    }
  }
  return undefined;
}

function diffRef(
  diff: NonNullable<LoopStageAttempt["budgetMeasurement"]>["diffArtifact"]
): RunScopedCasObjectRef {
  if (!diff) throw new TypeError("authoritative Gate diff artifact is missing");
  return {
    schemaVersion: 1,
    objectKey: diff.id,
    digest: diff.digest,
    byteLength: diff.byteLength,
    contentType: LOOP_DIFF_MANIFEST_CONTENT_TYPE
  };
}

/** Derives the current, lease-local candidate root from Gate evidence. During
 * takeover this URI differs from the historical implementation URI, but its
 * complete bytes are verified against that implementation's CAS proof before
 * any authoritative Gate is executed. */
function gateCandidateWorkspaceUri(input: {
  readonly reported: readonly GateResultV2[];
  readonly leaseId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly implementationWorkspaceUri: string;
  readonly implementationLeaseId: string;
}): string {
  const parsed = input.reported.map((result) =>
    parseSandboxUri(result.workingDirectory, "Gate workingDirectory")
  );
  const workspace = parsed[0]?.segments[0];
  if (
    !workspace ||
    parsed.some(
      (value) => value.leaseId !== input.leaseId || value.segments[0] !== workspace
    )
  ) {
    throw new TypeError("Gate results do not share one active-lease candidate workspace");
  }
  const governed = `${input.runId}--governed-${input.candidateId}`;
  // Legacy implementation paths include the actual attempt number, while the
  // governed failover path is stable. Accept the legacy shape here and let
  // resolveAuthoritativeCandidateWorkspace enforce its exact attempt value.
  const legacy = new RegExp(
    `^${escapeRegex(input.runId)}--implementation-[1-9][0-9]*-${escapeRegex(input.candidateId)}$`,
    "u"
  );
  if (workspace !== governed && !legacy.test(workspace)) {
    throw new TypeError("Gate candidate workspace is not bound to its run and candidate");
  }
  if (input.implementationLeaseId === input.leaseId) {
    const implementation = parseSandboxUri(
      input.implementationWorkspaceUri,
      "implementation workspaceUri"
    );
    if (
      implementation.leaseId !== input.leaseId ||
      implementation.segments.length !== 1 ||
      implementation.segments[0] !== workspace
    ) {
      throw new TypeError("Gate candidate workspace differs from its implementation proof");
    }
  }
  return `mn://sandbox/${encodeURIComponent(input.leaseId)}/${encodeURIComponent(workspace)}`;
}

/** Resolves a reported Gate cwd under the one candidate URI admitted by the
 * implementation proof. It does not accept another lease or sibling scratch
 * directory. */
export async function resolveGateWorkspaceUri(input: {
  readonly value: string;
  readonly leaseId: string;
  readonly workspaceUri: string;
  readonly candidateRoot: string;
}): Promise<string> {
  const base = parseSandboxUri(input.workspaceUri, "workspaceUri");
  const requested = parseSandboxUri(input.value, "Gate workingDirectory");
  if (
    base.leaseId !== input.leaseId ||
    requested.leaseId !== input.leaseId ||
    base.segments.length !== 1 ||
    requested.segments[0] !== base.segments[0]
  ) {
    throw new TypeError("Gate workingDirectory is outside the implementation workspace URI");
  }
  const relativeSegments = requested.segments.slice(1);
  const root = await realpath(resolve(input.candidateRoot));
  const candidate = resolve(root, ...relativeSegments);
  const canonical = await realpath(candidate);
  const child = relative(root, canonical);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new TypeError("Gate workingDirectory escapes the authoritative candidate root");
  }
  return canonical;
}

function parseSandboxUri(
  value: string,
  field: string
): { readonly leaseId: string; readonly segments: readonly string[] } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new TypeError(`${field} must be a valid mn sandbox URI`, { cause: error });
  }
  let segments: string[];
  try {
    segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch (error) {
    throw new TypeError(`${field} contains invalid percent encoding`, { cause: error });
  }
  if (
    parsed.protocol !== "mn:" ||
    parsed.hostname !== "sandbox" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    segments.length < 2 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0")
    )
  ) {
    throw new TypeError(`${field} is not a safe mn sandbox URI`);
  }
  return { leaseId: segments[0]!, segments: segments.slice(1) };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function decisionError(error: string): EnterpriseGateAuthorizationDecision {
  return Object.freeze({ error, newReceipts: Object.freeze([]) });
}

async function assertAuthoritySnapshotBinding(input: {
  readonly projectRoot: string;
  readonly candidateRoot: string;
  readonly expectedProjectDigest: string;
  readonly expectedCandidateDigest: string;
  readonly expectedDiffArtifact: Uint8Array;
}) {
  const measured = await measureAuthoritativeLoopWorkspaceDiff({
    projectRoot: input.projectRoot,
    candidateRoot: input.candidateRoot
  });
  const expected = Buffer.from(input.expectedDiffArtifact);
  if (
    measured.projectSnapshotDigest !== digest(
      input.expectedProjectDigest,
      "projectSnapshotDigest"
    ) ||
    measured.candidateSnapshotDigest !== digest(
      input.expectedCandidateDigest,
      "candidateSnapshotDigest"
    ) ||
    !measured.content.equals(expected)
  ) {
    throw new Error(
      "API-owned authority snapshot does not reproduce the implementation measurement"
    );
  }
  return measured;
}

async function makeTreeReadOnly(root: string): Promise<void> {
  const stats = await lstat(root);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    const entries = await readdir(root);
    entries.sort(compareCodeUnits);
    for (const entry of entries) await makeTreeReadOnly(join(root, entry));
    await chmod(root, 0o555);
    return;
  }
  if (stats.isFile()) {
    await chmod(root, (stats.mode & 0o111) === 0 ? 0o444 : 0o555);
  }
}

async function makeTreeWritable(root: string): Promise<void> {
  const stats = await lstat(root);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    await chmod(root, 0o700);
    const entries = await readdir(root);
    for (const entry of entries) await makeTreeWritable(join(root, entry));
    return;
  }
  if (stats.isFile()) await chmod(root, 0o600);
}

interface AuthorityContainerRuntime {
  readonly containerId: string;
  readonly candidateTarget: string;
}

async function createAuthorityContainer(input: {
  readonly dockerBinary: string;
  readonly candidateRoot: string;
  readonly attestation: SandboxLeaseAttestation;
}): Promise<AuthorityContainerRuntime> {
  const image = input.attestation.policy.runtimeImage;
  if (!image) throw new TypeError("authority container has no approved runtime image");
  digest(image.digest, "authority image digest");
  const candidateRoot = await realpath(resolve(input.candidateRoot));
  if (/[,\r\n]/u.test(candidateRoot)) {
    throw new TypeError("authority snapshot path cannot be represented as a Docker mount");
  }
  const target = "/workspace/authority";
  const limits = input.attestation.policy.resources;
  const labels = {
    ...sandboxRuntimeClaimLabels(input.attestation),
    "io.mn.sandbox.role": "gate-authority"
  };
  const sleepSeconds = Math.max(60, limits.timeoutSeconds + 60);
  const created = await dockerControl(input.dockerBinary, [
    "create",
    "--read-only",
    "--network",
    "none",
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--runtime",
    "runc",
    "--log-driver",
    "none",
    "--cpus",
    String(limits.cpu),
    "--memory",
    `${limits.memoryMb}m`,
    "--memory-swap",
    `${limits.memoryMb}m`,
    "--pids-limit",
    String(limits.pids),
    "--shm-size",
    "16m",
    "--ulimit",
    "nofile=1024:1024",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    "65534:65534",
    ...Object.entries(labels).flatMap(([name, value]) => [
      "--label",
      `${name}=${value}`
    ]),
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16777216,mode=1777",
    "--mount",
    `type=bind,source=${candidateRoot},target=${target},readonly`,
    "--workdir",
    target,
    image.reference,
    "sleep",
    String(sleepSeconds)
  ], 60);
  if (created.exitCode !== 0) {
    throw new Error(`authority docker create failed: ${created.stderr || created.stdout}`);
  }
  const containerId = created.stdout.trim();
  digest(containerId, "authority container id");
  try {
    const started = await dockerControl(input.dockerBinary, ["start", containerId], 60);
    if (started.exitCode !== 0) {
      throw new Error(`authority docker start failed: ${started.stderr || started.stdout}`);
    }
    const [containerInspection, imageInspection] = await Promise.all([
      dockerControl(input.dockerBinary, ["inspect", containerId], 30),
      dockerControl(
        input.dockerBinary,
        ["image", "inspect", `sha256:${image.digest}`],
        30
      )
    ]);
    if (containerInspection.exitCode !== 0 || imageInspection.exitCode !== 0) {
      throw new Error(
        `authority Docker inspection failed: ${containerInspection.stderr || imageInspection.stderr}`
      );
    }
    await validateAuthorityContainerInspection({
      raw: containerInspection.stdout,
      imageRaw: imageInspection.stdout,
      containerId,
      candidateRoot,
      candidateTarget: target,
      expectedLabels: labels,
      expectedImageReference: image.reference,
      expectedImageDigest: image.digest,
      expectedSleepSeconds: sleepSeconds,
      attestation: input.attestation
    });
    return Object.freeze({ containerId, candidateTarget: target });
  } catch (error) {
    await dockerControl(input.dockerBinary, ["rm", "-f", containerId], 30)
      .catch(() => undefined);
    throw error;
  }
}

async function validateAuthorityContainerInspection(input: {
  readonly raw: string;
  readonly imageRaw: string;
  readonly containerId: string;
  readonly candidateRoot: string;
  readonly candidateTarget: string;
  readonly expectedLabels: Readonly<Record<string, string>>;
  readonly expectedImageReference: string;
  readonly expectedImageDigest: string;
  readonly expectedSleepSeconds: number;
  readonly attestation: SandboxLeaseAttestation;
}): Promise<void> {
  const parsed = JSON.parse(input.raw) as unknown;
  const imageParsed = JSON.parse(input.imageRaw) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    !isRecord(parsed[0]) ||
    !Array.isArray(imageParsed) ||
    imageParsed.length !== 1 ||
    !isRecord(imageParsed[0])
  ) {
    throw new Error("authority Docker inspection returned an invalid document");
  }
  const inspection = parsed[0];
  const imageInspection = imageParsed[0];
  const state = requiredRecord(inspection.State, "authority State");
  const host = requiredRecord(inspection.HostConfig, "authority HostConfig");
  const config = requiredRecord(inspection.Config, "authority Config");
  const imageConfig = requiredRecord(imageInspection.Config, "authority image Config");
  const networks = requiredRecord(
    requiredRecord(inspection.NetworkSettings, "authority NetworkSettings").Networks,
    "authority Networks"
  );
  const mounts = requiredArray(inspection.Mounts, "authority Mounts");
  const mount = mounts.length === 1 && isRecord(mounts[0]) ? mounts[0] : undefined;
  const labels = optionalRecord(config.Labels, "authority Config.Labels");
  const imageLabels = optionalRecord(imageConfig.Labels, "authority image Config.Labels");
  const expectedLabels = { ...imageLabels, ...input.expectedLabels };
  const limits = input.attestation.policy.resources;
  const capAdd = nullableStringArray(host.CapAdd, "authority CapAdd");
  const capDrop = nullableStringArray(host.CapDrop, "authority CapDrop");
  const securityOpt = nullableStringArray(host.SecurityOpt, "authority SecurityOpt");
  const devices = nullableArray(host.Devices, "authority Devices");
  const deviceRequests = nullableArray(
    host.DeviceRequests,
    "authority DeviceRequests"
  );
  const deviceCgroupRules = nullableArray(
    host.DeviceCgroupRules,
    "authority DeviceCgroupRules"
  );
  const ulimits = nullableArray(host.Ulimits, "authority Ulimits");
  const dnsOptions = nullableStringArray(host.DnsOptions, "authority DnsOptions");
  const dnsSearch = nullableStringArray(host.DnsSearch, "authority DnsSearch");
  const groupAdd = nullableStringArray(host.GroupAdd, "authority GroupAdd");
  const maskedPaths = nullableStringArray(host.MaskedPaths, "authority MaskedPaths");
  const readonlyPaths = nullableStringArray(host.ReadonlyPaths, "authority ReadonlyPaths");
  const logConfig = requiredRecord(host.LogConfig, "authority LogConfig");
  const portBindings = requiredRecord(host.PortBindings, "authority PortBindings");
  const restartPolicy = requiredRecord(host.RestartPolicy, "authority RestartPolicy");
  const tmpfs = requiredRecord(host.Tmpfs, "authority Tmpfs");
  const env = nullableStringArray(config.Env, "authority Config.Env");
  const imageEnv = nullableStringArray(imageConfig.Env, "authority image Config.Env");
  const tmpfsOptions = typeof tmpfs["/tmp"] === "string"
    ? new Set(tmpfs["/tmp"].split(","))
    : new Set<string>();
  if (
    inspection.Id !== input.containerId ||
    inspection.Image !== `sha256:${input.expectedImageDigest}` ||
    imageInspection.Id !== `sha256:${input.expectedImageDigest}` ||
    config.Image !== input.expectedImageReference ||
    state.Running !== true ||
    !mount ||
    mount.Type !== "bind" ||
    mount.Destination !== input.candidateTarget ||
    mount.RW !== false ||
    mount.Propagation !== "rprivate" ||
    typeof mount.Source !== "string" ||
    await realpath(mount.Source) !== await realpath(input.candidateRoot) ||
    host.ReadonlyRootfs !== true ||
    host.NetworkMode !== "none" ||
    host.PidMode !== "" ||
    host.IpcMode !== "private" ||
    host.UsernsMode !== "" ||
    host.CgroupnsMode !== "private" ||
    host.UTSMode !== "" ||
    host.Cgroup !== "" ||
    host.CgroupParent !== "" ||
    host.Runtime !== "runc" ||
    host.Isolation !== "" ||
    host.OomScoreAdj !== 0 ||
    host.NanoCpus !== Math.round(limits.cpu * 1_000_000_000) ||
    host.CpuShares !== 0 ||
    host.CpuPeriod !== 0 ||
    host.CpuQuota !== 0 ||
    host.CpuRealtimePeriod !== 0 ||
    host.CpuRealtimeRuntime !== 0 ||
    host.CpusetCpus !== "" ||
    host.CpusetMems !== "" ||
    host.CpuCount !== 0 ||
    host.CpuPercent !== 0 ||
    host.Memory !== limits.memoryMb * 1024 * 1024 ||
    host.MemoryReservation !== 0 ||
    host.MemorySwap !== limits.memoryMb * 1024 * 1024 ||
    host.MemorySwappiness !== null ||
    normalizedOomKillDisable(host.OomKillDisable) !== false ||
    host.ShmSize !== 16 * 1024 * 1024 ||
    host.PidsLimit !== limits.pids ||
    host.Privileged !== false ||
    capAdd.length !== 0 ||
    capDrop.length !== 1 ||
    capDrop[0] !== "ALL" ||
    securityOpt.length !== 1 ||
    !["no-new-privileges", "no-new-privileges:true"].includes(securityOpt[0]!) ||
    devices.length !== 0 ||
    deviceRequests.length !== 0 ||
    deviceCgroupRules.length !== 0 ||
    sha256Canonical(ulimits) !== sha256Canonical([
      { Name: "nofile", Hard: 1024, Soft: 1024 }
    ]) ||
    host.ExtraHosts !== null ||
    host.Dns !== null ||
    dnsOptions.length !== 0 ||
    dnsSearch.length !== 0 ||
    groupAdd.length !== 0 ||
    host.Links !== null ||
    host.PublishAllPorts !== false ||
    host.AutoRemove !== false ||
    host.Binds !== null ||
    host.VolumesFrom !== null ||
    sha256Canonical(logConfig) !== sha256Canonical({ Type: "none", Config: {} }) ||
    sha256Canonical(portBindings) !== sha256Canonical({}) ||
    sha256Canonical(restartPolicy) !== sha256Canonical({ Name: "no", MaximumRetryCount: 0 }) ||
    !requiredSubset(REQUIRED_MASKED_PATHS, maskedPaths) ||
    !requiredSubset(REQUIRED_READONLY_PATHS, readonlyPaths) ||
    config.User !== "65534:65534" ||
    config.WorkingDir !== input.candidateTarget ||
    config.OpenStdin !== false ||
    config.Tty !== false ||
    sha256Canonical(config.Env ?? null) !== sha256Canonical(imageConfig.Env ?? null) ||
    sha256Canonical(config.Entrypoint ?? null) !==
      sha256Canonical(imageConfig.Entrypoint ?? null) ||
    sha256Canonical(config.Cmd ?? null) !== sha256Canonical([
      "sleep",
      String(input.expectedSleepSeconds)
    ]) ||
    sha256Canonical(env) !== sha256Canonical(imageEnv) ||
    sha256Canonical(labels) !== sha256Canonical(expectedLabels) ||
    Object.keys(networks).length !== 1 ||
    !Object.hasOwn(networks, "none") ||
    Object.keys(tmpfs).length !== 1 ||
    !["rw", "noexec", "nosuid", "size=16777216", "mode=1777"].every(
      (option) => tmpfsOptions.has(option)
    ) ||
    tmpfsOptions.size !== 5
  ) {
    throw new Error("authority container inspection does not match the closed execution policy");
  }
}

function dockerControl(
  dockerBinary: string,
  args: readonly string[],
  timeoutSeconds: number
): Promise<GateCommandExecutionResult> {
  return new Promise((resolveResult, reject) => {
    execFile(
      dockerBinary,
      [...args],
      {
        timeout: Math.max(1, timeoutSeconds) * 1_000,
        maxBuffer: MAX_DOCKER_OUTPUT_BYTES
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveResult({ exitCode: 0, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code === "number") {
          resolveResult({ exitCode: code, stdout, stderr });
          return;
        }
        reject(new Error(`authority Docker control failed: ${stderr || error.message}`));
      }
    );
  });
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} is invalid`);
  return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> {
  if (value == null) return {};
  return requiredRecord(value, field);
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} is invalid`);
  return value;
}

function nullableArray(value: unknown, field: string): unknown[] {
  return value == null ? [] : requiredArray(value, field);
}

function nullableStringArray(value: unknown, field: string): string[] {
  const values = nullableArray(value, field);
  if (values.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} is invalid`);
  }
  return values as string[];
}

function normalizedOomKillDisable(value: unknown): boolean | "invalid" {
  return value === null || value === false ? false : value === true ? true : "invalid";
}

function requiredSubset(required: readonly string[], actual: readonly string[]): boolean {
  const values = new Set(actual);
  return required.every((item) => values.has(item));
}

function authorityContainerCommandExecutor(input: {
  readonly dockerBinary: string;
  readonly containerId: string;
  readonly candidateRoot: string;
  readonly candidateTarget: string;
  readonly attestation: SandboxLeaseAttestation;
  readonly sandboxExecution: SandboxExecutionEvidence;
}): GateCommandExecutor {
  const resolvedTools = new Map<string, string>();
  const resolveToolIdentity = async (
    requested: string,
    requestedCwd: string
  ): Promise<GateResolvedToolIdentity> => {
    const executable = bareExecutable(requested, "Gate executable");
    if (!input.attestation.policy.allowedTools.includes(executable)) {
      throw new Error(`Gate tool ${executable} is not allowed by the sandbox lease`);
    }
    const cwd = privateAuthorityContainerPath(
      input.candidateRoot,
      input.candidateTarget,
      requestedCwd
    );
    const result = await dockerExec(
      input.dockerBinary,
      input.containerId,
      cwd,
      "/bin/sh",
      ["-ceu", TOOL_IDENTITY_SCRIPT, "mn-tool-resolver", executable],
      30
    );
    const lines = result.stdout.trim().split(/\r?\n/u);
    const imageDigest = input.attestation.policy.runtimeImage?.digest;
    if (
      result.exitCode !== 0 ||
      lines.length !== 2 ||
      !trustedRuntimeExecutable(lines[0]!) ||
      !/^[a-f0-9]{64}$/u.test(lines[1]!) ||
      !imageDigest
    ) {
      throw new Error(
        `trusted authority runtime could not resolve ${executable}: ${result.stderr || result.stdout}`
      );
    }
    resolvedTools.set(lines[0]!, executable);
    return Object.freeze({
      schemaVersion: 1,
      requestedExecutable: executable,
      resolvedExecutable: lines[0]!,
      contentDigest: lines[1]!,
      imageDigest
    });
  };
  const execute = async (
    request: GateCommandExecutionRequest
  ): Promise<GateCommandExecutionResult> => {
    const executable = safeExecutable(request.executable, "Gate executable");
    const requested = resolvedTools.get(executable);
    if (
      !requested ||
      !trustedRuntimeExecutable(executable) ||
      !input.attestation.policy.allowedTools.includes(requested)
    ) {
      throw new Error("Gate executable was not resolved by the trusted authority runtime");
    }
    const cwd = privateAuthorityContainerPath(
      input.candidateRoot,
      input.candidateTarget,
      request.cwd
    );
    const timeoutSeconds = Math.max(
      1,
      Math.min(
        positiveInteger(request.timeoutSeconds, "Gate timeoutSeconds"),
        input.attestation.policy.resources.timeoutSeconds
      )
    );
    return dockerExec(
      input.dockerBinary,
      input.containerId,
      cwd,
      executable,
      request.args,
      timeoutSeconds,
      request.signal
    );
  };
  return Object.freeze({
    id: "docker/api-authority-exec",
    version: "2",
    sandboxExecution: input.sandboxExecution,
    resolveToolIdentity,
    execute,
    probeVersion: async (
      executable: string,
      args: readonly string[],
      cwd: string
    ) => {
      const result = await execute({
        executable,
        args,
        cwd,
        timeoutSeconds: 10,
        runId: input.attestation.runId,
        candidateId: "authority-version-probe"
      });
      return `${result.stdout}${result.stderr}`.trim().split(/\r?\n/u)[0] || "unknown";
    }
  });
}

function dockerExec(
  dockerBinary: string,
  runtimeId: string,
  cwd: string,
  executable: string,
  commandArgs: readonly string[],
  timeoutSeconds: number,
  signal?: AbortSignal
): Promise<GateCommandExecutionResult> {
  const args = [
    "exec",
    "--workdir",
    cwd,
    digest(runtimeId, "runtimeId"),
    executable,
    ...commandArgs.map((argument) => safeArgument(argument))
  ];
  return new Promise((resolveResult, reject) => {
    execFile(
      dockerBinary,
      args,
      {
        timeout: timeoutSeconds * 1_000,
        maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
        ...(signal ? { signal } : {})
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveResult({ exitCode: 0, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code === "number") {
          resolveResult({ exitCode: code, stdout, stderr });
          return;
        }
        if (signal?.aborted || (error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          resolveResult({ exitCode: null, stdout, stderr });
          return;
        }
        reject(new Error(`authoritative docker exec failed: ${stderr || error.message}`));
      }
    );
  });
}

function privateAuthorityContainerPath(
  candidateRoot: string,
  candidateTarget: string,
  requested: string
): string {
  if (!isAbsolute(requested) || requested.includes("\0")) {
    throw new TypeError("Gate working directory must be an absolute authority path");
  }
  const absolute = resolve(requested);
  const child = relative(resolve(candidateRoot), absolute);
  if (
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  ) {
    return child === ""
      ? candidateTarget
      : `${candidateTarget}/${child.split(sep).join("/")}`;
  }
  throw new TypeError("Gate working directory is outside the API-owned authority snapshot");
}

function assertAuthorityRuntimeBinding(input: AuthoritativeGateExecutionInput): void {
  const proof = input.sandboxExecution.runtimeProof;
  const approvedImage = input.attestation.policy.runtimeImage;
  const harnessImage = input.manifest.sandbox.runtimeImage;
  if (
    !approvedImage ||
    !harnessImage ||
    harnessImage.reference !== approvedImage.reference ||
    harnessImage.digest !== approvedImage.digest ||
    input.sandboxExecution.backendId !== input.attestation.backend.id ||
    input.sandboxExecution.backendVersion !== input.attestation.backend.version ||
    input.runtime.runtimeId !== input.sandboxExecution.runtimeId ||
    input.runtime.runtimeDigest !== input.sandboxExecution.runtimeDigest ||
    input.runtime.imageDigest !== approvedImage.digest ||
    input.sandboxExecution.imageDigest !== approvedImage.digest ||
    proof.runtimeId !== input.runtime.runtimeId ||
    proof.runtimeDigest !== input.runtime.runtimeDigest ||
    proof.imageDigest !== approvedImage.digest ||
    proof.attestationDigest !== input.attestation.digest ||
    input.sandboxExecution.leaseId !== input.attestation.leaseId ||
    input.attestation.runId !== input.runId
  ) {
    throw new TypeError("authoritative Gate runtime does not match the API-issued lease proof");
  }
  digest(input.projectSnapshotDigest, "projectSnapshotDigest");
  digest(input.candidateSnapshotDigest, "candidateSnapshotDigest");
  measureLoopDiffManifest(Buffer.from(input.diffArtifact));
  const candidate = resolve(input.candidateRoot);
  const scratch = resolve(input.runtime.scratchRoot);
  const child = relative(scratch, candidate);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new TypeError("authoritative Gate candidate is outside the inspected scratch mount");
  }
}

function reportedResultSemantic(
  result: GateResultV2,
  workingDirectory: string,
  artifacts: readonly unknown[]
): unknown {
  return {
    id: result.id,
    runId: result.runId,
    candidateId: result.candidateId,
    gateId: result.gateId,
    runnerId: result.runnerId,
    runnerVersion: result.runnerVersion,
    required: result.required,
    status: result.status,
    summary: result.summary,
    specClauseIds: result.specClauseIds,
    command: result.command ?? null,
    tool: result.tool ?? null,
    workingDirectory: resolve(workingDirectory),
    exitCode: result.exitCode,
    inputDigest: result.inputDigest,
    artifacts,
    sandboxExecution: result.sandboxExecution ?? null
  };
}

function authoritativeResultSemantic(
  result: GateResultV2,
  workingDirectory: string,
  artifacts: readonly unknown[]
): unknown {
  return {
    runId: result.runId,
    candidateId: result.candidateId,
    gateId: result.gateId,
    runnerId: result.runnerId,
    runnerVersion: result.runnerVersion,
    required: result.required,
    status: result.status,
    summary: result.summary,
    specClauseIds: result.specClauseIds,
    command: result.command ?? null,
    tool: result.tool ?? null,
    workingDirectory: resolve(workingDirectory),
    exitCode: result.exitCode,
    inputDigest: result.inputDigest,
    artifacts,
    sandboxExecution: result.sandboxExecution ?? null
  };
}

function reportedArtifactSemantic(artifact: GateArtifactV2, actualDigest: string): unknown {
  return {
    id: artifact.id,
    kind: artifact.kind,
    contentType: artifact.contentType,
    digest: actualDigest,
    byteLength: artifact.byteLength,
    handle: artifact.handle ?? null
  };
}

function authorityArtifactSemantic(artifact: GateArtifactV2): unknown {
  return {
    id: artifact.id,
    kind: artifact.kind,
    contentType: artifact.contentType,
    digest: artifact.digest,
    byteLength: artifact.byteLength
  };
}

function normalizeReceiptBinding(
  value: AuthoritativeGateReceiptBinding
): AuthoritativeGateReceiptBinding {
  if (typeof value.passed !== "boolean") {
    throw new TypeError("passed must be a boolean");
  }

  return {
    tenantId: identity(value.tenantId, "tenantId"),
    projectId: identity(value.projectId, "projectId"),
    runId: identity(value.runId, "runId"),
    stageAttemptId: identity(value.stageAttemptId, "stageAttemptId"),
    attempt: positiveInteger(value.attempt, "attempt"),
    workerId: identity(value.workerId, "workerId"),
    claimDigest: digest(value.claimDigest, "claimDigest"),
    leaseId: identity(value.leaseId, "leaseId"),
    runtimeId: digest(value.runtimeId, "runtimeId"),
    runtimeDigest: digest(value.runtimeDigest, "runtimeDigest"),
    runtimeProofDigest: digest(value.runtimeProofDigest, "runtimeProofDigest"),
    candidateId: identity(value.candidateId, "candidateId"),
    workspaceUri: safeUri(value.workspaceUri),
    diffArtifactDigest: digest(value.diffArtifactDigest, "diffArtifactDigest"),
    projectSnapshotDigest: digest(value.projectSnapshotDigest, "projectSnapshotDigest"),
    candidateSnapshotDigest: digest(value.candidateSnapshotDigest, "candidateSnapshotDigest"),
    specDigest: digest(value.specDigest, "specDigest"),
    governanceDigest: digest(value.governanceDigest, "governanceDigest"),
    harnessDigest: digest(value.harnessDigest, "harnessDigest"),
    reportedResultsDigest: digest(value.reportedResultsDigest, "reportedResultsDigest"),
    authoritativeResultsDigest: digest(
      value.authoritativeResultsDigest,
      "authoritativeResultsDigest"
    ),
    passed: value.passed,
    ...(value.previousReceiptDigest
      ? { previousReceiptDigest: digest(value.previousReceiptDigest, "previousReceiptDigest") }
      : {})
  };
}

function invalid(reason: string): GateReconciliationResult {
  return Object.freeze({ valid: false, reason });
}

function signReceipt(value: string, signingKey: string): string {
  if (typeof signingKey !== "string" || Buffer.byteLength(signingKey) < 32) {
    throw new TypeError("authoritative Gate signing key must contain at least 32 bytes");
  }
  return createHmac("sha256", signingKey)
    .update(RECEIPT_SIGNATURE_DOMAIN, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function safeEqual(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const actual = Buffer.from(left, "utf8");
  const expected = Buffer.from(right, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function safeExecutable(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a safe executable`);
  }
  return value;
}

function bareExecutable(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value)
  ) {
    throw new TypeError(`${field} must be a bare executable name`);
  }
  return value;
}

function trustedRuntimeExecutable(value: string): boolean {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    !/[\0\r\n]/u.test(value) &&
    !value.includes("/../") &&
    !value.endsWith("/..") &&
    ["/bin/", "/sbin/", "/usr/", "/opt/"].some((root) => value.startsWith(root))
  );
}

function safeArgument(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError("Gate command argument contains NUL");
  }
  return value;
}

function identity(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
  return value;
}

function safeUri(value: string): string {
  identity(value, "workspaceUri");
  const parsed = new URL(value);
  if (parsed.protocol !== "mn:" || parsed.hostname !== "sandbox") {
    throw new TypeError("workspaceUri must be an mn sandbox URI");
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function digest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 digest`);
  }
  return value;
}

function timestamp(value: string, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
