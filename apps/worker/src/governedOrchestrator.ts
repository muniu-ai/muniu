import type {
  AgentRunInput,
  AgentRuntimeId,
  AgentTask,
  ArtifactRef,
  FailureClassification,
  GateResultV2,
  Project,
  RunRecord,
  RunStageAttempt
} from "@mn/core";
import type { AgentExecutor } from "@mn/executors";
import {
  executeGovernedIncrement,
  sha256Canonical,
  type ApprovalDecision,
  type GovernedRunState,
  type GovernedStageHandlers,
  type LoopBudgetMeasurer,
  type LoopArtifact,
  type LoopArtifactKind
} from "@mn/loop";
import { validateSpecRevision, type SpecRevision } from "@mn/specs";
import { resolve } from "node:path";
import { RunOrchestrator, type RunOrchestratorOptions } from "./orchestrator.js";
import type { GateRegistryV2 } from "./gateRegistry.js";
import type { GateArtifactPublisher } from "./gateEngine.js";
import type { GateCommandExecutor } from "./gateEngine.js";
import {
  captureContractBaseline,
  changedWorkspacePaths,
  runGovernedGatePlan,
  snapshotWorkspace,
  snapshotWorkspaceContents,
  type WorkspaceContentSnapshot,
  type WorkspaceSnapshot
} from "./governedGateExecution.js";

export interface GovernedRunOrchestratorOptions extends RunOrchestratorOptions {
  onLoopCheckpoint?: (state: GovernedRunState) => void | Promise<void>;
  /** Content-addressed Spec lookup. The returned revision is accepted only
   * when its identity and digest exactly match the immutable run binding. */
  resolveSpecRevision?: (
    ref: NonNullable<AgentTask["specRef"]>
  ) => SpecRevision | undefined | Promise<SpecRevision | undefined>;
  /** Primarily for remote workers and deterministic tests. When omitted the
   * worker's complete builtin/multi-language registry is used. */
  gateRegistry?: GateRegistryV2;
  /** Enterprise external workers bind this to the active machine claim so Gate
   * bytes are registered before a checkpoint can reference them. */
  artifactPublisher?: GateArtifactPublisher;
  /** Enforced command surface for every command-backed Gate. Enterprise
   * workers must provide the executor from the same inspected sandbox lease
   * that ran the implementation candidate. */
  gateCommandExecutor?: GateCommandExecutor;
  /** Fail before any stage when this process is an enterprise data-plane
   * worker and cannot provide the enforced command surface. */
  requireEnforcedGateExecutor?: boolean;
  /** Enterprise API-backed authoritative budget accounting. */
  measureBudgetDelta?: LoopBudgetMeasurer;
  /** Converts a selected host workspace into an opaque authority reference.
   * Enterprise workers use a lease-bound mn://sandbox URI. */
  measurementWorkspaceUri?: (input: {
    readonly candidateId: string;
    readonly workspacePath: string;
  }) => string;
}

export interface GovernedRunExecutionOptions {
  readonly resumeFrom?: GovernedRunState;
  readonly approvalDecision?: ApprovalDecision;
  readonly abortSignal?: AbortSignal;
}

function loopArtifact(
  runId: string,
  id: string,
  kind: LoopArtifactKind,
  semantic: unknown
): LoopArtifact {
  return {
    id,
    kind,
    path: `mn://runs/${encodeURIComponent(runId)}/${encodeURIComponent(id)}`,
    digest: sha256Canonical(semantic),
    contentType: "application/vnd.mn.loop-artifact+json"
  };
}

function coreArtifact(artifact: LoopArtifact): ArtifactRef {
  const kind: ArtifactRef["kind"] =
    artifact.kind === "diff"
      ? "diff"
      : artifact.kind === "verification_evidence"
        ? "test-report"
        : artifact.kind === "architecture_decision"
          ? "summary"
          : artifact.kind === "learning_proposal"
            ? "summary"
            : "trace";
  return {
    id: artifact.id,
    kind,
    path: artifact.path,
    sha256: artifact.digest,
    ...(artifact.contentType ? { contentType: artifact.contentType } : {})
  };
}

function coreFailure(
  failure: GovernedRunState["failure"] | GovernedRunState["attempts"][number]["failure"]
): FailureClassification | undefined {
  if (!failure) return undefined;
  return {
    kind:
      failure.kind === "budget_exhausted"
        ? "context_exhausted"
        : failure.kind === "stage_failure"
          ? "test_failure"
          : "unknown",
    retryable: failure.retryable,
    reason: failure.reason
  };
}

function coreAttempt(
  attempt: GovernedRunState["attempts"][number]
): RunStageAttempt {
  return {
    id: attempt.id,
    runId: attempt.runId,
    stage: attempt.stage,
    attempt: attempt.attempt,
    status: attempt.status,
    inputArtifacts: attempt.inputArtifacts.map(coreArtifact),
    outputArtifacts: attempt.outputArtifacts.map(coreArtifact),
    inputDigest: attempt.inputDigest,
    ...(attempt.outputDigest ? { outputDigest: attempt.outputDigest } : {}),
    budgetUsage: { ...attempt.budgetUsage },
    ...(coreFailure(attempt.failure)
      ? { failure: coreFailure(attempt.failure) }
      : {}),
    startedAt: attempt.startedAt,
    ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {})
  };
}

function runStatus(state: GovernedRunState): RunRecord["status"] {
  switch (state.status) {
    case "running":
      return state.currentStage === "verification" ? "verifying" : "running";
    case "waiting_approval":
      return "waiting_approval";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "needs_human":
      return "failed";
  }
}

function projectLanguages(
  project: Project,
  selectedServices: readonly string[]
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    project.services
      .filter((service) => selectedServices.includes(service.id))
      .map((service) => [service.id, service.language])
  );
}

async function resolveBoundSpec(
  task: AgentTask,
  resolver: GovernedRunOrchestratorOptions["resolveSpecRevision"]
): Promise<SpecRevision | undefined> {
  if (!task.specRef || !resolver) return undefined;
  const revision = await resolver(task.specRef);
  if (!revision) return undefined;
  const validation = validateSpecRevision(revision);
  if (!validation.valid) {
    throw new TypeError(
      `Resolved Spec revision is invalid: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
  }
  if (
    revision.specSetId !== task.specRef.specSetId ||
    revision.revision !== task.specRef.revision ||
    revision.digest !== task.specRef.digest
  ) {
    throw new TypeError("Resolved Spec revision does not match the immutable Spec ref");
  }
  return revision;
}

function wrapExecutorWithBaseline(
  executor: AgentExecutor,
  baselines: Map<string, WorkspaceSnapshot>,
  contentBaselines: Map<string, WorkspaceContentSnapshot>
): AgentExecutor {
  return {
    provider: executor.provider,
    async run(input: AgentRunInput) {
      if (!baselines.has(input.candidateId)) {
        const [snapshot, contents] = await Promise.all([
          snapshotWorkspace(input.cwd),
          snapshotWorkspaceContents(input.cwd)
        ]);
        baselines.set(input.candidateId, snapshot);
        contentBaselines.set(input.candidateId, contents);
      }
      return executor.run(input);
    }
  };
}

function wrapExecutorsWithBaseline(
  executors: RunOrchestratorOptions["executors"],
  baselines: Map<string, WorkspaceSnapshot>,
  contentBaselines: Map<string, WorkspaceContentSnapshot>
): Partial<Record<AgentRuntimeId, AgentExecutor>> {
  const wrapped: Partial<Record<AgentRuntimeId, AgentExecutor>> = {};
  for (const runtimeId of ["builtin", "claude", "codex"] as const) {
    const executor = executors[runtimeId];
    if (executor) wrapped[runtimeId] = wrapExecutorWithBaseline(executor, baselines, contentBaselines);
  }
  return wrapped;
}

function encodeDiffManifest(
  paths: readonly string[],
  before: WorkspaceContentSnapshot,
  after: WorkspaceContentSnapshot
): string {
  const files = paths.map((path) => {
    const beforeValue = before.get(path);
    const afterValue = after.get(path);
    if (
      (before.has(path) && beforeValue === null) ||
      (after.has(path) && afterValue === null)
    ) {
      throw new Error(
        `Authoritative diff measurement cannot represent binary, symlink, or oversized path ${path}`
      );
    }
    return {
      path,
      before: before.has(path) ? beforeValue! : null,
      after: after.has(path) ? afterValue! : null
    };
  });
  return Buffer.from(
    JSON.stringify({ schemaVersion: 1, files }),
    "utf8"
  ).toString("base64");
}

function bindVerificationEvidence(
  bindings: Array<{ stageAttemptId: string; gateResultIds: string[] }>,
  stageAttemptId: string,
  gateResultIds: readonly string[]
): void {
  const binding = { stageAttemptId, gateResultIds: [...gateResultIds] };
  const existing = bindings.findIndex(
    (candidate) => candidate.stageAttemptId === stageAttemptId
  );
  if (existing === -1) bindings.push(binding);
  else bindings[existing] = binding;
}

/**
 * Runs governed-increment-v1 while keeping the classic candidate engine as the
 * implementation adapter. All governance, Harness and stage bindings remain
 * immutable; only a signed approval decision may resume the approval gate.
 */
export class GovernedRunOrchestrator {
  constructor(private readonly options: GovernedRunOrchestratorOptions) {}

  async run(
    project: Project,
    task: AgentTask,
    baseRun: RunRecord,
    execution: GovernedRunExecutionOptions = {}
  ): Promise<{ run: RunRecord; state: GovernedRunState }> {
    if (!task.specRef || !baseRun.governanceSnapshot || !baseRun.harnessManifest) {
      throw new TypeError(
        "governed-increment-v1 requires immutable Spec, Governance and Harness bindings"
      );
    }
    if (
      baseRun.harnessManifest.sandbox.enforcement === "enforced" &&
      this.options.requireEnforcedGateExecutor === true &&
      !this.options.gateCommandExecutor
    ) {
      throw new TypeError(
        "enforced governed-increment-v1 requires a sandbox Gate command executor"
      );
    }

    const specRevision = await resolveBoundSpec(
      task,
      this.options.resolveSpecRevision
    );
    const contractBaseline = await captureContractBaseline(project);
    const initialProjectSnapshot = await snapshotWorkspace(project.rootPath);

    let candidateRun: RunRecord = { ...baseRun };
    let latestGateResults: readonly GateResultV2[] = baseRun.gateResultsV2 ?? [];
    let allGateResults: GateResultV2[] = [...(baseRun.gateResultsV2 ?? [])];
    const verificationEvidence = [...(baseRun.verificationEvidence ?? [])].map(
      (binding) => ({
        stageAttemptId: binding.stageAttemptId,
        gateResultIds: [...binding.gateResultIds]
      })
    );
    let latestChangedPaths: readonly string[] = [];
    let latestDiffDigest = sha256Canonical([]);
    let latestDiffManifestBase64 = encodeDiffManifest([], new Map(), new Map());
    let repairSessionIds: Array<string | undefined> = baseRun.candidates.map(
      (candidate) => candidate.executionBinding?.sessionId
    );
    let repairWorkspacePaths: Array<string | undefined> = baseRun.candidates.map(
      (candidate) => candidate.worktreePath
    );
    let gateRepairFeedback = "";
    const candidateBaselines = new Map<string, WorkspaceSnapshot>();
    const candidateContentBaselines = new Map<string, WorkspaceContentSnapshot>();
    const selectedServices = baseRun.harnessManifest.selectedServices;
    const languageByService = projectLanguages(project, selectedServices);
    const handlers: GovernedStageHandlers = {
      discovery: async () => ({
        status: "completed",
        artifacts: [
          loopArtifact(baseRun.id, "discovery", "discovery", {
            selectedServices,
            languageByService,
            contextDigest: baseRun.harnessManifest!.context.digest
          })
        ]
      }),
      specification: async () => ({
        status: "completed",
        artifacts: [
          loopArtifact(baseRun.id, "approved-spec", "specification", task.specRef)
        ]
      }),
      impact_architecture: async () => ({
        status: "completed",
        artifacts: [
          loopArtifact(baseRun.id, "impact-architecture", "impact_report", {
            selectedServices,
            protectedPaths: baseRun.harnessManifest!.executionPolicy.protectedPaths,
            gates: baseRun.harnessManifest!.gatePlan.map((gate) => gate.id)
          })
        ]
      }),
      implementation: async (context) => {
        latestDiffManifestBase64 = encodeDiffManifest([], new Map(), new Map());
        const classicTask: AgentTask = {
          ...task,
          prompt: context.isRepair
            ? `${task.prompt}\n\nRepair the previously verified failure without changing the approved specification.\n\n${gateRepairFeedback}`
            : task.prompt,
          // governed-increment-v1 owns verification. Running classic gates here
          // would create unbound/skippable v1 evidence and execute every command
          // twice.
          strategy: {
            ...task.strategy,
            requiredGates: [],
            humanApproval: "never"
          }
        };
        const classic = new RunOrchestrator({
          ...this.options,
          executors: wrapExecutorsWithBaseline(
            this.options.executors,
            candidateBaselines,
            candidateContentBaselines
          ),
          onUpdate: (record) => {
            candidateRun = record;
          }
        });
        const implementationWorkspaceRunId =
          `${baseRun.id}--implementation-${context.attempt}`;
        const classicResult = await classic.run(project, classicTask, {
          runId: baseRun.id,
          workspaceRunId: implementationWorkspaceRunId,
          executionBindingTask: task,
          abortSignal: execution.abortSignal,
          ...(context.isRepair && repairSessionIds.length > 0
            ? { sessionIds: repairSessionIds }
            : {}),
          ...(context.isRepair && repairWorkspacePaths.length > 0
            ? { candidateWorkspacePaths: repairWorkspacePaths }
            : {})
        });
        candidateRun = {
          ...classicResult,
          id: baseRun.id,
          candidates: classicResult.candidates.map((candidate) => ({
            ...candidate,
            runId: baseRun.id
          }))
        };
        repairSessionIds = candidateRun.candidates.map(
          (candidate) => candidate.executionBinding?.sessionId
        );
        repairWorkspacePaths = candidateRun.candidates.map(
          (candidate) => candidate.worktreePath
        );
        if (candidateRun.status === "cancelled") {
          return {
            status: "cancelled",
            artifacts: [],
            reason: "Candidate execution was cancelled"
          };
        }
        const winner = candidateRun.candidates.find(
          (candidate) => candidate.id === candidateRun.winnerCandidateId
        );
        if (winner) {
          const before =
            resolve(winner.worktreePath) === resolve(project.rootPath)
              ? initialProjectSnapshot
              : candidateBaselines.get(winner.id);
          if (!before) {
            throw new Error(`Missing pre-execution snapshot for ${winner.id}`);
          }
          const [after, afterContents] = await Promise.all([
            snapshotWorkspace(winner.worktreePath),
            snapshotWorkspaceContents(winner.worktreePath)
          ]);
          latestChangedPaths = changedWorkspacePaths(before, after);
          const beforeContents = candidateContentBaselines.get(winner.id);
          if (!beforeContents) {
            throw new Error(`Missing pre-execution content snapshot for ${winner.id}`);
          }
          latestDiffManifestBase64 = encodeDiffManifest(
            latestChangedPaths,
            beforeContents,
            afterContents
          );
          const changedDigests = latestChangedPaths.map((path) => ({
            path,
            before: before.get(path) ?? null,
            after: after.get(path) ?? null
          }));
          latestDiffDigest = sha256Canonical(changedDigests);
        } else {
          latestChangedPaths = [];
          latestDiffDigest = sha256Canonical([]);
          latestDiffManifestBase64 = encodeDiffManifest([], new Map(), new Map());
        }
        const diffSemantic = {
          implementationAttempt: context.attempt,
          winnerCandidateId: candidateRun.winnerCandidateId ?? null,
          changedPaths: latestChangedPaths,
          diffDigest: latestDiffDigest
        };
        return {
          status: "completed",
          artifacts: [
            loopArtifact(
              baseRun.id,
              `implementation-${context.attempt}`,
              "diff",
              diffSemantic
            )
          ],
          budgetDelta: { changedFiles: latestChangedPaths.length },
          diffDigest: latestDiffDigest
        };
      },
      verification: async (context) => {
        const winner = candidateRun.candidates.find(
          (candidate) => candidate.id === candidateRun.winnerCandidateId
        );
        let verification;
        try {
          verification = winner
            ? await runGovernedGatePlan({
                project,
                task,
                manifest: baseRun.harnessManifest!,
                candidateRoot: winner.worktreePath,
                runId: baseRun.id,
                candidateId: winner.id,
                changedPaths: latestChangedPaths,
                ...(specRevision ? { spec: specRevision } : {}),
                contractBaseline,
                ...(this.options.gateRegistry
                  ? { registry: this.options.gateRegistry }
                  : {}),
                ...(this.options.gateCommandExecutor
                  ? { commandExecutor: this.options.gateCommandExecutor }
                  : {}),
                ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
                ...(execution.abortSignal
                  ? { abortSignal: execution.abortSignal }
                  : {}),
                ...(this.options.artifactPublisher
                  ? { artifactPublisher: this.options.artifactPublisher }
                  : {})
              })
            : undefined;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const semantic = {
            winnerCandidateId: candidateRun.winnerCandidateId ?? null,
            error: reason
          };
          const artifact = loopArtifact(
            baseRun.id,
            `verification-${context.attempt}`,
            "verification_evidence",
            semantic
          );
          bindVerificationEvidence(
            verificationEvidence,
            `${baseRun.id}:verification:${context.attempt}`,
            []
          );
          return {
            status: "failed",
            artifacts: [artifact],
            failure: {
              kind: "stage_failure",
              retryable: true,
              reason: `Governed Gate execution failed closed: ${reason}`
            },
            failureSignature: sha256Canonical(semantic),
            diffDigest: latestDiffDigest
          };
        }
        latestGateResults = verification?.results ?? [];
        allGateResults.push(...latestGateResults);
        bindVerificationEvidence(
          verificationEvidence,
          `${baseRun.id}:verification:${context.attempt}`,
          latestGateResults.map((gate) => gate.id)
        );
        candidateRun = {
          ...candidateRun,
          gates: [...(verification?.legacyResults ?? [])],
          gateResultsV2: [...allGateResults]
        };
        for (const gate of latestGateResults) {
          this.options.onEvent?.({
            runId: baseRun.id,
            candidateId: gate.candidateId,
            type: "gate",
            message: `${gate.gateId}: ${gate.status}`,
            timestamp: gate.finishedAt,
            data: gate
          });
        }
        const successful =
          Boolean(winner) &&
          candidateRun.status !== "failed" &&
          verification?.successful === true;
        const semantic = {
          winnerCandidateId: candidateRun.winnerCandidateId ?? null,
          gateResults: latestGateResults
        };
        const artifact = loopArtifact(
          baseRun.id,
          `verification-${context.attempt}`,
          "verification_evidence",
          semantic
        );
        if (successful) return { status: "completed", artifacts: [artifact] };
        gateRepairFeedback = JSON.stringify({
          schemaVersion: 1,
          kind: "gate-repair-feedback",
          verificationAttempt: context.attempt,
          failedGates: latestGateResults
            .filter((gate) => gate.status !== "pass")
            .map((gate) => ({
              gateId: gate.gateId,
              status: gate.status,
              summary: gate.summary,
              ...(gate.command === undefined
                ? {}
                : {
                    command: gate.command.display,
                    exitCode: gate.exitCode
                  })
            }))
        });
        return {
          status: "failed",
          artifacts: [artifact],
          failure: {
            kind: "stage_failure",
            retryable: true,
            reason: "Required verification evidence did not pass"
          },
          failureSignature:
            verification?.failureSignature ?? sha256Canonical(semantic),
          diffDigest: latestDiffDigest
        };
      },
      approval_demo: async () => ({
        status: "waiting_approval",
        artifacts: [
          loopArtifact(baseRun.id, "approval-material", "approval_material", {
            winnerCandidateId: candidateRun.winnerCandidateId,
            gateDigest: sha256Canonical(latestGateResults)
          })
        ]
      }),
      learning: async () => ({
        status: "completed",
        artifacts: [
          loopArtifact(baseRun.id, "learning-proposal", "learning_proposal", {
            runId: baseRun.id,
            specDigest: task.specRef!.digest,
            governanceDigest: baseRun.governanceSnapshot!.digest,
            harnessDigest: baseRun.harnessManifest!.digest,
            automaticActivationAllowed: false
          })
        ]
      })
    };

    let materialized = baseRun;
    const state = await executeGovernedIncrement({
      schemaVersion: 1,
      runId: baseRun.id,
      specRef: task.specRef,
      governanceSnapshot: baseRun.governanceSnapshot,
      harnessManifest: baseRun.harnessManifest,
      handlers,
      onCheckpoint: async (checkpoint) => {
        // A resumed trailing verification handler has an indeterminate
        // outcome. The Loop engine closes it as failed/interrupted before it
        // starts the replacement attempt, so there can be no GateResultV2 to
        // attach. Persist an explicit empty binding: absence would make the
        // checkpoint structurally incomplete, while attaching later Gate
        // results would misattribute evidence to work that was discarded.
        for (const attempt of checkpoint.attempts) {
          if (
            attempt.stage === "verification" &&
            attempt.status === "failed" &&
            attempt.failure?.kind === "interrupted"
          ) {
            bindVerificationEvidence(verificationEvidence, attempt.id, []);
          }
        }
        materialized = {
          ...baseRun,
          candidates: candidateRun.candidates,
          gates: candidateRun.gates,
          gateResultsV2: [...allGateResults],
          verificationEvidence: verificationEvidence.map((binding) => ({
            stageAttemptId: binding.stageAttemptId,
            gateResultIds: [...binding.gateResultIds]
          })),
          ...(candidateRun.winnerCandidateId
            ? { winnerCandidateId: candidateRun.winnerCandidateId }
            : {}),
          status: runStatus(checkpoint),
          stages: checkpoint.attempts.map(coreAttempt),
          budgetUsage: { ...checkpoint.budgetUsage },
          trace: {
            traceId: baseRun.trace?.traceId ?? baseRun.id,
            specDigest: task.specRef!.digest,
            governanceDigest: baseRun.governanceSnapshot!.digest,
            harnessDigest: baseRun.harnessManifest!.digest,
            evidenceIds: [
              ...checkpoint.attempts.flatMap((attempt) =>
                attempt.outputArtifacts.map((artifact) => artifact.id)
              ),
              ...allGateResults.map((gate) => gate.id)
            ]
          },
          // Queue/reclaim/approval bookkeeping is stamped by the API before a
          // remote worker resumes. The worker's Loop clock can legitimately be
          // a few milliseconds behind that server-issued Run timestamp even
          // though the governed checkpoint itself is monotonic. Never publish
          // a Run record that moves the control-plane clock backwards; the
          // governed state retains its own exact checkpoint timestamp.
          updatedAt: laterTimestamp(checkpoint.updatedAt, baseRun.updatedAt)
        };
        await this.options.onLoopCheckpoint?.(checkpoint);
        this.options.onUpdate?.(materialized);
      },
      ...(execution.resumeFrom ? { resumeFrom: execution.resumeFrom } : {}),
      ...(execution.approvalDecision
        ? { approvalDecision: execution.approvalDecision }
        : {}),
      ...(execution.abortSignal ? { signal: execution.abortSignal } : {}),
      ...(this.options.measureBudgetDelta
        ? {
            measureBudgetDelta: (request) => {
              const candidate = candidateRun.candidates.find(
                (entry) => entry.id === candidateRun.winnerCandidateId
              ) ?? candidateRun.candidates.at(-1);
              const workspaceUri =
                request.stage === "implementation" && candidate
                  ? this.options.measurementWorkspaceUri?.({
                      candidateId: candidate.id,
                      workspacePath: candidate.worktreePath
                    })
                  : undefined;
              return this.options.measureBudgetDelta!({
                ...request,
                ...(workspaceUri && candidate
                  ? { workspaceUri, candidateId: candidate.id }
                  : {})
              });
            }
          }
        : {})
    });

    return { run: materialized, state };
  }
}

function laterTimestamp(candidate: string, floor: string): string {
  const candidateMs = Date.parse(candidate);
  const floorMs = Date.parse(floor);
  if (!Number.isFinite(candidateMs) || !Number.isFinite(floorMs)) {
    throw new TypeError("Run timestamps must be valid before checkpoint materialization");
  }
  return candidateMs < floorMs ? floor : candidate;
}
