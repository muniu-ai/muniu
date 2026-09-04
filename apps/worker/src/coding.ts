// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KernelProjectionRuntimeStore,
  type ModelRequest,
  type RuntimeStore,
  type ToolApprovalPort,
} from "@mn/agent-runtime";
import type {
  CodingRunnerConfigurationV1,
  Deliverable,
  Execution,
  ExecutionAuthority,
  ExternalCodingRunnerId,
  Job,
  JsonObject,
  JsonValue,
  RunnerBinaryIdentityV1,
  Thread,
  ToolCallIntent,
  Workspace,
} from "@mn/contracts";
import { CODING_RUNNER_CONFIGURATION_NAMESPACE } from "@mn/contracts";
import {
  authorityAllowsIntent,
  sha256,
  type InboxItem,
  type KernelJobSettlementReceipt,
  type KernelStore,
  type KernelTransaction,
} from "@mn/kernel";
import {
  buildRepositoryIndex,
  CODING_DEFAULT_LIMITS,
  CodingExecutionEngine,
  createCodeEvidence,
  decideCodingExecution,
  type Candidate,
  type CandidateDraft,
  type CodingControlPlaneCommitment,
  type CodingExecutionResult,
  type CodingRunnerAdapter,
  type CodingTask,
  type CodeEvidence,
  type GateResult,
  type GateVerifier,
  type Repository,
  type RepositoryIndex,
  type RunnerEvent,
  RunnerKnownFailureError,
} from "@mn/plugin-coding";
import { StaleFencingTokenError, type StoredJob } from "@mn/storage";
import { createClaudeCliRunner } from "@mn/runner-claude-cli";
import { createCodexCliRunner } from "@mn/runner-codex-cli";

import { createKernelToolApprovalPort, type ToolApprovalKernel } from "./approval.js";
import {
  ModelTransportError,
  type ByokModelInvoker,
  type ByokProviderId,
} from "./model-invoker.js";
import {
  CandidateOperationAbortedError,
  copyCandidateTree,
  inspectCandidateTree,
  isCandidateOperationAborted,
  runControlledCommand,
  type CandidateTreeManifest,
} from "./candidate-materializer.js";

const MAX_TRACKED_FILES = 10_000;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_MODEL_CONTEXT_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const TOOL_INTENT_TTL_MS = 5 * 60 * 1000;
const CONTROLLED_GIT_TIMEOUT_MS = 30_000;
const CANDIDATE_GATE_TIMEOUT_MS = 10_000;
const GIT = "/usr/bin/git";
const DEFAULT_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";

interface StoredModelConnection {
  readonly id: string;
  readonly tenantId: string;
  readonly presetId: string;
  readonly secretRef: string;
  readonly defaultModel: string;
  readonly status: "pending" | "ready" | "invalid";
}

interface VersionedRepository extends Repository {
  readonly streamVersion: number;
  readonly updatedAt: string;
}

interface StoredCandidate extends Candidate {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly diff: string;
  readonly createdAt: string;
}

interface ExternalInvocationState {
  readonly runnerId: ExternalCodingRunnerId;
  readonly attempt: number;
  readonly identityDigest: string;
  readonly sandboxPath: string;
  readonly runnerArtifactPath: string;
  readonly status: "started" | "settled" | "outcome_unknown";
  readonly cleanupStatus?: "pending" | "cleaned";
  readonly cleanedAt?: string;
  readonly reconciliationDecision?: "terminate" | "mark_completed" | "create_new_call";
  readonly cleanupJobId?: string;
  readonly supervision: RunnerSupervisionCheckpoint;
  readonly terminationStatus: "unconfirmed" | "confirmed";
  readonly verification?: {
    readonly status: "pending" | "failed" | "passed";
    readonly jobId: string;
    readonly requestedBy: string;
    readonly requestedAt: string;
    readonly updatedAt: string;
    readonly failureReason?: string;
  };
  readonly startedAt: string;
  readonly updatedAt: string;
}

interface RunnerSupervisionCheckpoint {
  readonly protocol: "mn-runner-supervisor-v1";
  readonly statePath: string;
  readonly tokenDigest: string;
}

interface RunnerSupervisionLease extends RunnerSupervisionCheckpoint {
  readonly token: string;
}

interface StoredCodingRun {
  readonly executionId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly status: "running" | CodingExecutionResult["status"];
  readonly controlPlane: CodingControlPlaneCommitment;
  readonly baseRevision: string;
  readonly runnerId: "builtin" | ExternalCodingRunnerId;
  readonly externalInvocation?: ExternalInvocationState;
  readonly result?: CodingExecutionResult;
  readonly approvalIntent?: ToolCallIntent;
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RepositorySnapshot {
  readonly repository: VersionedRepository;
  readonly realPath: string;
  readonly baseRevision: string;
  readonly index: RepositoryIndex;
  readonly modelContext: string;
}

interface CandidateMaterial {
  readonly diff: string;
  readonly sandboxPath: string;
  readonly materialization?: {
    readonly rootPath: string;
    readonly basePath: string;
    readonly candidatePath: string;
    readonly baseManifest: CandidateTreeManifest;
    readonly candidateManifest: CandidateTreeManifest;
  };
}

interface StagedRunnerArtifact {
  readonly rootPath: string;
  readonly identity: RunnerBinaryIdentityV1;
}

interface ExternalRunnerAdapterEvent {
  readonly type: "runner_event" | "diagnostic" | "result";
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly message?: string;
  readonly status?: "completed" | "failed" | "cancelled" | "unknown";
  readonly reason?: string;
  readonly reconciliationRequired?: boolean;
}

interface ExternalRunnerAdapter {
  readonly id: string;
  readonly external: true;
  start(input: {
    readonly executionId: string;
    readonly repositoryPath: string;
    readonly expectedRepositoryRealPath: string;
    readonly resourceDigest: string;
    readonly preparedInput: string;
    readonly explicitlySelected: boolean;
  }): Promise<{ readonly sessionId: string }>;
  events(sessionId: string): AsyncIterable<ExternalRunnerAdapterEvent>;
  cancel(sessionId: string): Promise<void>;
  resume(sessionId: string, input: {
    readonly preparedInput: string;
    readonly explicitlySelected: boolean;
  }): Promise<void>;
}

interface ExternalRunnerSpawnSpec {
  readonly executable: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly shell: false;
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface ManagedExternalRunnerProcess {
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly completed: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

interface ExternalRunnerLaunch {
  (spec: ExternalRunnerSpawnSpec): ManagedExternalRunnerProcess;
  readonly supervision: RunnerSupervisionCheckpoint;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CodingWorkerJobContext {
  readonly workerId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
  readonly signal: AbortSignal;
  readonly acknowledgeJobSettlement?: (receipt: KernelJobSettlementReceipt) => void;
}

export interface CodingModelSecretReader {
  read(secretRef: string): Promise<string>;
}

export interface CodingExecutionWorkerOptions {
  readonly store: KernelStore;
  readonly secretStore: CodingModelSecretReader;
  readonly modelInvoker: ByokModelInvoker;
  readonly approvalKernel: ToolApprovalKernel;
  readonly sandboxRoot: string;
  readonly sandboxExecutable?: string;
  readonly acceptsSecretReference?: (reference: string) => boolean;
  readonly approvalPollIntervalMs?: number;
  readonly now?: () => string;
}

export interface CodingSandboxCleanupWorkerOptions {
  readonly store: KernelStore;
  readonly sandboxRoot: string;
  readonly sandboxExecutable?: string;
  readonly now?: () => string;
}

export class CodingWorkerOutcomeError extends Error {
  constructor(
    readonly executionId: string,
    readonly status: "failed" | "cancelled" | "needs_reconciliation",
    message: string,
  ) {
    super(message);
    this.name = "CodingWorkerOutcomeError";
  }
}

function fencedCodingStore(
  store: KernelStore,
  job: StoredJob,
  context: CodingWorkerJobContext,
  now: () => string,
): KernelStore {
  if (job.status !== "leased"
    || job.leaseOwner !== context.workerId
    || job.fencingToken !== context.fencingToken
    || job.leaseExpiresAt !== context.leaseExpiresAt) {
    throw new StaleFencingTokenError(job.id);
  }
  return {
    transact(tenantId, work) {
      if (tenantId !== job.tenantId) throw new Error("Coding Job 事务不能跨租户");
      return store.transact(tenantId, (transaction) => {
        if (!transaction.assertJobLease) {
          throw new Error("存储未实现事务内 Job fencing，Coding Worker 已拒绝写入");
        }
        transaction.assertJobLease({
          jobId: job.id,
          workerId: context.workerId,
          fencingToken: context.fencingToken,
          occurredAt: now(),
        });
        return work(transaction);
      });
    },
    readEvents(tenantId, afterPosition, limit) {
      return store.readEvents(tenantId, afterPosition, limit);
    },
  };
}

export function createCodingExecutionWorkerHandler(options: CodingExecutionWorkerOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const sandbox = new MacOsCodingSandbox({
    root: options.sandboxRoot,
    executable: options.sandboxExecutable ?? DEFAULT_SANDBOX_EXECUTABLE,
  });

  return async (job: StoredJob, context: CodingWorkerJobContext): Promise<JsonValue> => {
    const executionId = payloadString(job.payload, "executionId");
    if (job.payload.command !== undefined && job.payload.command !== "resume") {
      throw new Error("Coding Job command 无效");
    }
    const store = fencedCodingStore(options.store, job, context, now);
    const effectiveOptions: CodingExecutionWorkerOptions = { ...options, store };
    const state = await loadCodingState(store, job.tenantId, executionId);
    assertCodingState(job, state);
    const runnerId = state.execution.runnerId ?? "builtin";
    if (runnerId === "builtin"
      && options.acceptsSecretReference
      && !options.acceptsSecretReference(state.model.secretRef)) {
      throw new Error("模型密钥引用不属于当前运行环境");
    }
    const runtime = new KernelProjectionRuntimeStore({
      tenantId: job.tenantId,
      store,
      now,
      id: (sequence) => `${executionId}:coding-runtime:${sequence}`,
    });
    const approval = createKernelToolApprovalPort({
      tenantId: job.tenantId,
      actorId: state.execution.executionPrincipalId,
      kernel: options.approvalKernel,
      store,
      ...(options.approvalPollIntervalMs
        ? { pollIntervalMs: options.approvalPollIntervalMs }
        : {}),
      now: () => Date.parse(now()),
    });

    const recovered = await loadCodingRun(store, job.tenantId, executionId);
    if (recovered?.generation === state.execution.generation && recovered.result) {
      return settlePersistedResult({
        options: effectiveOptions,
        job,
        context,
        state,
        runtime,
        approval,
        run: recovered,
        now,
      });
    }
    if (recovered?.generation === state.execution.generation
      && recovered.externalInvocation?.status === "started") {
      const terminationConfirmed = await sandbox.waitForRunnerStopped(
        recovered.externalInvocation.supervision,
        context.signal,
      );
      const nextStep = "核对外部执行结果，再选择终止、标记完成或创建新调用";
      await runtime.append({
        executionId,
        type: "tool/outcome_unknown",
        payload: {
          runnerId: recovered.externalInvocation.runnerId,
          attempt: recovered.externalInvocation.attempt,
          reason: "Worker 恢复时发现外部 Runner 启动检查点没有确定终态",
        },
      });
      await persistCodingResult({
        store,
        tenantId: job.tenantId,
        job,
        context,
        state,
        controlPlane: recovered.controlPlane,
        baseRevision: recovered.baseRevision,
        result: {
          task: state.task,
          runnerId: recovered.runnerId,
          status: "needs_reconciliation",
          candidates: [],
          gates: [],
          nextStep,
          limits: {
            maxRepairAttempts: CODING_DEFAULT_LIMITS.maxRepairAttempts,
            maxDurationMs: state.authority.budget.maxDurationMs,
          },
          controlPlane: recovered.controlPlane,
        },
        material: new Map(),
        runnerTerminationConfirmed: terminationConfirmed,
        now: now(),
      });
      throw new CodingWorkerOutcomeError(
        executionId,
        "needs_reconciliation",
        nextStep,
      );
    }

    const snapshot = await inspectRepositoryControlled({
      repository: state.repository,
      execution: state.execution,
      authority: state.authority,
      runtime,
      approval,
      signal: context.signal,
      now,
    });
    const controlPlane = await sandbox.controlPlane(snapshot, state.task, runnerId);
    await persistRunning(
      store,
      job.tenantId,
      state,
      controlPlane,
      snapshot.baseRevision,
      runnerId,
      now(),
    );

    const builtinRunner = new BuiltinCodingRunner({
      execution: state.execution,
      authority: state.authority,
      task: state.task,
      model: state.model,
      snapshot,
      controlPlane,
      runtime,
      approval,
      sandbox,
      secretStore: options.secretStore,
      modelInvoker: options.modelInvoker,
      signal: context.signal,
      now,
    });
    const runner = runnerId === "builtin"
      ? builtinRunner
      : new ExternalCodingRunner({
          runnerId,
          configuration: state.runnerConfiguration!,
          execution: state.execution,
          authority: state.authority,
          task: state.task,
          snapshot,
          controlPlane,
          runtime,
          approval,
          sandbox,
          store,
          tenantId: job.tenantId,
          signal: context.signal,
          now,
    });
    let run: StoredCodingRun;
    let preserveForReconciliation = true;
    let cleanupCompleted = false;
    try {
      const registeredRunners = runnerId === "builtin" ? [builtinRunner] : [builtinRunner, runner];
      const engineResult = await new CodingExecutionEngine({
        runners: registeredRunners,
        now: () => Date.parse(now()),
      })
        .execute({
          task: state.task,
          controlPlane,
          gateVerifier: runner.gateVerifier,
          executionId,
          repositoryPath: snapshot.realPath,
          expectedRepositoryRealPath: state.repository.rootRealPath,
          selectedRunnerId: runnerId,
          externalRunnerConfirmed: runnerId !== "builtin",
          limits: { maxDurationMs: state.authority.budget.maxDurationMs },
        });
      if (context.signal.aborted && !isUserCancellation(context.signal)) {
        throw new Error("Coding 执行已中断");
      }
      const result = isUserCancellation(context.signal)
        ? cancelledCodingResult(engineResult)
        : engineResult;
      const approvalIntent = result.status === "waiting_approval"
        ? acceptanceIntent(state.execution, state.authority, state.repository, result, now())
        : undefined;
      preserveForReconciliation = result.status === "needs_reconciliation";
      run = await persistCodingResult({
        store,
        tenantId: job.tenantId,
        job,
        context,
        state,
        controlPlane,
        baseRevision: snapshot.baseRevision,
        result,
        approvalIntent,
        material: runner.material,
        runnerTerminationConfirmed: runner instanceof ExternalCodingRunner
          ? runner.terminationConfirmed
          : undefined,
        now: now(),
      });
      const deferredCleanup = run.externalInvocation?.cleanupStatus === "pending"
        && Boolean(run.externalInvocation.cleanupJobId);
      try {
        await runner.cleanup(preserveForReconciliation || deferredCleanup);
      } catch (error) {
        if (!deferredCleanup) throw error;
      }
      cleanupCompleted = true;
    } finally {
      if (!cleanupCompleted) await runner.cleanup(preserveForReconciliation);
    }
    return settlePersistedResult({
      options: effectiveOptions,
      job,
      context,
      state,
      runtime,
      approval,
      run,
      now,
    });
  };
}

export function createCodingSandboxCleanupWorkerHandler(
  options: CodingSandboxCleanupWorkerOptions,
) {
  const now = options.now ?? (() => new Date().toISOString());
  const sandbox = new MacOsCodingSandbox({
    root: options.sandboxRoot,
    executable: options.sandboxExecutable ?? DEFAULT_SANDBOX_EXECUTABLE,
  });
  return async (job: StoredJob, context: CodingWorkerJobContext): Promise<JsonValue> => {
    if (job.kind !== "coding.sandbox.cleanup") {
      throw new Error("Coding sandbox 清理 Job 类型无效");
    }
    const workspaceId = job.workspaceId;
    if (!workspaceId) throw new Error("Coding sandbox 清理 Job 缺少工作区");
    const executionId = payloadString(job.payload, "reconciliationExecutionId");
    const store = fencedCodingStore(options.store, job, context, now);
    const invocation = await store.transact(job.tenantId, (transaction) => {
      const run = transaction.getProjection<StoredCodingRun>("coding.execution", executionId);
      if (!run?.externalInvocation) throw new Error("人工核对没有可清理的外部 Runner 记录");
      return run.externalInvocation;
    });
    if (invocation.cleanupStatus === "cleaned") {
      return { executionId, status: "cleaned" };
    }
    await sandbox.cleanupReconciliationArtifacts(invocation);
    await store.transact(job.tenantId, (transaction) => {
      const current = transaction.getProjection<StoredCodingRun>("coding.execution", executionId);
      if (!current?.externalInvocation) throw new Error("外部 Runner 清理检查点不存在");
      if (current.externalInvocation.cleanupStatus === "cleaned") return;
      if (current.externalInvocation.sandboxPath !== invocation.sandboxPath
        || current.externalInvocation.runnerArtifactPath !== invocation.runnerArtifactPath
        || current.externalInvocation.identityDigest !== invocation.identityDigest) {
        throw new Error("外部 Runner 清理资源已变化，拒绝删除");
      }
      const occurredAt = now();
      const next: StoredCodingRun = {
        ...current,
        externalInvocation: {
          ...current.externalInvocation,
          cleanupStatus: "cleaned",
          cleanedAt: occurredAt,
          updatedAt: occurredAt,
        },
        streamVersion: current.streamVersion + 1,
        updatedAt: occurredAt,
      };
      transaction.putProjection("coding.execution", executionId, next);
      transaction.appendEvent({
        tenantId: job.tenantId,
        aggregateType: "coding.execution",
        aggregateId: executionId,
        expectedStreamVersion: current.streamVersion,
        type: "coding.sandbox_cleanup_completed",
        actorId: `worker:${context.workerId}`,
        executionId,
        generation: current.generation,
        correlationId: `coding:${executionId}:${current.generation}:cleanup`,
        publicPayload: {
          workspaceId,
          status: "cleaned",
          fencingToken: context.fencingToken,
        },
      });
    });
    return { executionId, status: "cleaned" };
  };
}

export function createCodingReconciliationVerificationWorkerHandler(
  options: CodingSandboxCleanupWorkerOptions,
) {
  const now = options.now ?? (() => new Date().toISOString());
  const sandbox = new MacOsCodingSandbox({
    root: options.sandboxRoot,
    executable: options.sandboxExecutable ?? DEFAULT_SANDBOX_EXECUTABLE,
  });
  return async (job: StoredJob, context: CodingWorkerJobContext): Promise<JsonValue> => {
    if (job.kind !== "coding.reconciliation.verify") {
      throw new Error("Coding 人工核对验证 Job 类型无效");
    }
    if (!job.workspaceId) throw new Error("Coding 人工核对验证 Job 缺少工作区");
    const executionId = payloadString(job.payload, "reconciliationExecutionId");
    const store = fencedCodingStore(options.store, job, context, now);
    const state = await store.transact(job.tenantId, (transaction) => {
      const execution = transaction.getProjection<Execution>("execution", executionId);
      const run = transaction.getProjection<StoredCodingRun>("coding.execution", executionId);
      const task = run
        ? transaction.getProjection<CodingTask>("coding.task", run.taskId)
        : undefined;
      const thread = execution
        ? transaction.getProjection<Thread>("thread", execution.threadId)
        : undefined;
      const workspace = execution
        ? transaction.getProjection<Workspace>("workspace", execution.workspaceId)
        : undefined;
      const authority = execution
        ? transaction.getProjection<ExecutionAuthority>("authority", execution.authorityId)
        : undefined;
      const repository = run
        ? transaction.getProjection<VersionedRepository>("coding.repository", run.repositoryId)
        : undefined;
      const model = execution
        ? transaction.getProjection<StoredModelConnection>("modelConnection", execution.modelBindingId)
        : undefined;
      const runnerConfiguration = execution && run && run.runnerId !== "builtin"
        ? transaction.getProjection<CodingRunnerConfigurationV1>(
            CODING_RUNNER_CONFIGURATION_NAMESPACE,
            `${execution.workspaceId}:${run.runnerId}`,
          )
        : undefined;
      return {
        execution,
        run,
        task,
        thread,
        workspace,
        authority,
        repository,
        model,
        runnerConfiguration,
      };
    });
    if (state.execution?.status === "completed"
      && state.run?.externalInvocation?.verification?.status === "passed") {
      return { executionId, status: "completed" };
    }
    const verification = state.run?.externalInvocation?.verification;
    if (!state.execution || state.execution.tenantId !== job.tenantId
      || state.execution.workspaceId !== job.workspaceId
      || state.execution.pluginId !== "coding"
      || state.execution.status !== "needs_reconciliation"
      || !state.run || state.run.executionId !== state.execution.id
      || state.run.generation !== state.execution.generation
      || state.run.status !== "needs_reconciliation"
      || !state.run.result || state.run.result.status !== "needs_reconciliation"
      || !state.run.externalInvocation
      || state.run.externalInvocation.status !== "outcome_unknown"
      || state.run.externalInvocation.terminationStatus !== "confirmed"
      || verification?.status !== "pending" || verification.jobId !== job.id
      || !state.task || state.task.status !== "needs_reconciliation"
      || state.task.workspaceId !== job.workspaceId
      || state.task.repositoryId !== state.run.repositoryId
      || !state.thread || state.thread.workspaceId !== job.workspaceId
      || state.thread.resourceRef?.namespace !== "coding.task"
      || state.thread.resourceRef.resourceId !== state.task.id) {
      throw new Error("Coding 人工核对验证状态不一致");
    }
    assertReconciliationBindings({
      tenantId: job.tenantId,
      execution: state.execution,
      run: state.run,
      task: state.task,
      authority: state.authority,
      repository: state.repository,
      model: state.model,
      runnerConfiguration: state.runnerConfiguration,
    });
    if (!state.workspace || state.workspace.tenantId !== job.tenantId
      || !state.workspace.activePluginIds.includes("coding")
      || !state.workspace.activePluginIds.includes(runnerPluginId(state.run.runnerId as ExternalCodingRunnerId))) {
      return persistReconciliationVerification({
        store,
        tenantId: job.tenantId,
        job,
        context,
        execution: state.execution,
        run: state.run,
        task: state.task,
        thread: state.thread,
        authority: state.authority!,
        repository: state.repository!,
        model: state.model!,
        runnerConfiguration: state.runnerConfiguration!,
        failureReason: "Coding 插件已停用，未执行保留候选验证",
        now: now(),
      });
    }
    const runtime = new KernelProjectionRuntimeStore({
      tenantId: job.tenantId,
      store,
      now,
      id: (sequence) => `${executionId}:reconciliation-runtime:${sequence}`,
    });
    let candidate: Candidate | undefined;
    let gate: GateResult | undefined;
    let evidence: CodeEvidence | undefined;
    let diff: string | undefined;
    let failureReason: string | undefined;
    try {
      const readIntent = createIntent({
        execution: state.execution,
        authority: state.authority!,
        toolId: "coding.repository.read",
        effectClass: "local_read",
        intent: `固化人工核对候选 ${executionId}`,
        normalizedArguments: {
          repositoryId: state.repository!.id,
          baseRevision: state.run.baseRevision,
          repositoryIndexDigest: state.run.controlPlane.repositoryIndexDigest,
          retainedSandboxPathDigest: sha256(state.run.externalInvocation.sandboxPath),
          generation: state.execution.generation,
          runnerIdentityDigest: state.run.externalInvocation.identityDigest,
        },
        resourceRefs: [{
          namespace: "repository",
          resourceId: state.repository!.id,
          digest: state.run.controlPlane.repositoryIndexDigest,
        }],
        now: now(),
      });
      assertAutoAuthorizedReconciliationIntent(state.authority!, readIntent);
      await runtime.append({
        executionId,
        type: "tool/intent",
        payload: readIntent as unknown as JsonObject,
      });
      const material = await sandbox.materializeExternalCandidate(
        state.run.externalInvocation.sandboxPath,
        state.run.baseRevision,
        context.signal,
      );
      diff = material.diff;
      if (!diff.trim()) throw new Error("保留候选没有可审阅 Diff");
      if (Buffer.byteLength(diff, "utf8") > MAX_PATCH_BYTES) {
        throw new Error("保留候选 Diff 超过 1 MiB 验证上限");
      }
      await recordToolResult(runtime, readIntent, {
        baseTreeDigest: material.materialization!.baseManifest.digest,
        candidateTreeDigest: material.materialization!.candidateManifest.digest,
        diffDigest: hashBytes(Buffer.from(diff)),
      });
      const candidateId = `${executionId}:generation:${state.execution.generation}:reconciliation:${state.run.externalInvocation.attempt}`;
      candidate = {
        id: candidateId,
        taskId: state.task.id,
        runnerId: state.run.runnerId,
        sequence: state.run.externalInvocation.attempt,
        baseRevision: state.run.baseRevision,
        diffDigest: hashBytes(Buffer.from(diff)),
        summary: `${runnerDisplayName(state.run.externalInvocation.runnerId)} 保留候选`,
        sandbox: {
          enforced: true,
          fallbackUsed: false,
          evidenceDigest: state.run.controlPlane.sandboxDigest,
        },
      };
      const gateIntent = createIntent({
        execution: state.execution,
        authority: state.authority!,
        toolId: "coding.gate.verify",
        effectClass: "local_read",
        intent: `验证人工核对候选 ${candidateId}`,
        normalizedArguments: {
          candidateId,
          diffDigest: candidate.diffDigest,
          baseTreeDigest: material.materialization!.baseManifest.digest,
          candidateTreeDigest: material.materialization!.candidateManifest.digest,
          generation: state.execution.generation,
          runnerIdentityDigest: state.run.externalInvocation.identityDigest,
        },
        resourceRefs: [{
          namespace: "repository",
          resourceId: state.repository!.id,
          digest: state.run.controlPlane.repositoryIndexDigest,
        }],
        now: now(),
      });
      assertAutoAuthorizedReconciliationIntent(state.authority!, gateIntent);
      await runtime.append({
        executionId,
        type: "tool/intent",
        payload: gateIntent as unknown as JsonObject,
      });
      const rawGate = await sandbox.verifyCandidate(material, context.signal);
      const afterGate = await sandbox.currentCandidateDiff(material, context.signal);
      if (hashBytes(Buffer.from(afterGate)) !== candidate.diffDigest) {
        throw new Error("权威 Gate 执行期间保留候选已变化");
      }
      const gateEvidenceDigest = sha256({
        candidateId,
        diffDigest: candidate.diffDigest,
        sandboxDigest: state.run.controlPlane.sandboxDigest,
        command: gateCommand(material),
        ...rawGate,
      });
      await recordToolResult(runtime, gateIntent, {
        candidateId,
        status: rawGate.exitCode === 0 ? "passed" : "failed",
        evidenceDigest: gateEvidenceDigest,
      });
      gate = {
        candidateId,
        status: rawGate.exitCode === 0 ? "passed" : "failed",
        authoritative: true,
        evidenceDigest: gateEvidenceDigest,
        checks: [{
          id: "git.diff-check",
          status: rawGate.exitCode === 0 ? "passed" : "failed",
          summary: rawGate.exitCode === 0
            ? "git diff --check 通过"
            : (rawGate.stderr || rawGate.stdout || "git diff --check 未通过").trim(),
        }],
        ...(rawGate.exitCode === 0 ? {} : { reason: "保留候选未通过权威 Gate" }),
      };
      if (gate.status === "passed") {
        evidence = createCodeEvidence({
          taskId: state.task.id,
          candidateId,
          runnerId: state.run.runnerId,
          specDigest: state.run.controlPlane.specDigest,
          governanceDigest: state.run.controlPlane.governanceDigest,
          harnessDigest: state.run.controlPlane.harnessDigest,
          sandboxDigest: state.run.controlPlane.sandboxDigest,
          repositoryIndexDigest: state.run.controlPlane.repositoryIndexDigest,
          gateEvidenceDigest,
          diffDigest: candidate.diffDigest,
        });
      } else {
        failureReason = gate.reason;
      }
    } catch (error) {
      if (context.signal.aborted || isCandidateOperationAborted(error)) throw error;
      failureReason = safeMessage(error);
    }
    return persistReconciliationVerification({
      store,
      tenantId: job.tenantId,
      job,
      context,
      execution: state.execution,
      run: state.run,
      task: state.task,
      thread: state.thread,
      authority: state.authority!,
      repository: state.repository!,
      model: state.model!,
      runnerConfiguration: state.runnerConfiguration!,
      ...(candidate && diff ? { candidate, diff } : {}),
      ...(gate ? { gate } : {}),
      ...(evidence ? { evidence } : {}),
      ...(failureReason ? { failureReason } : {}),
      now: now(),
    });
  };
}

async function settlePersistedResult(input: {
  readonly options: CodingExecutionWorkerOptions;
  readonly job: StoredJob;
  readonly context: CodingWorkerJobContext;
  readonly state: CodingState;
  readonly runtime: RuntimeStore;
  readonly approval: ToolApprovalPort;
  readonly run: StoredCodingRun;
  readonly now: () => string;
}): Promise<JsonValue> {
  const { result } = input.run;
  if (!result) throw new Error("Coding 执行检查点缺少持久结果");
  if (result.status === "completed" || result.status === "needs_human_decision") {
    return { executionId: input.state.execution.id, status: result.status };
  }
  if (result.status === "failed" || result.status === "cancelled"
    || result.status === "needs_reconciliation") {
    throw new CodingWorkerOutcomeError(input.state.execution.id, result.status, result.nextStep);
  }
  if (result.status !== "waiting_approval" || !input.run.approvalIntent) {
    throw new Error("Coding 执行结果状态无效");
  }
  await input.runtime.append({
    executionId: input.state.execution.id,
    type: "tool/intent",
    payload: input.run.approvalIntent as unknown as JsonObject,
  });
  let authorization: Awaited<ReturnType<ToolApprovalPort["authorize"]>>;
  try {
    authorization = await input.approval.authorize(
      input.run.approvalIntent,
      input.context.signal,
    );
  } catch (error) {
    const cancelledByUser = isUserCancellation(input.context.signal)
      || await input.options.store.transact(input.job.tenantId, (transaction) =>
        transaction.getProjection<Execution>("execution", input.state.execution.id)?.status
          === "cancelled");
    if (!cancelledByUser) throw error;
    const cancelled = await persistCodingDecision(
      input.options.store,
      input.job.tenantId,
      input.job,
      input.context,
      input.state,
      cancelledCodingResult(result),
      input.now(),
    );
    throw new CodingWorkerOutcomeError(
      input.state.execution.id,
      "cancelled",
      cancelled.nextStep,
    );
  }
  if (authorization.mode === "auto") {
    throw new Error("特权候选批准不能自动放行");
  }
  const decision = authorization.mode === "deny" ? "denied" : "approved_once";
  const decided = decideCodingExecution(result, decision);
  await input.runtime.append({
    executionId: input.state.execution.id,
    type: "tool/result",
    payload: {
      toolCallId: input.run.approvalIntent.id,
      status: decision === "approved_once" ? "completed" : "denied",
    },
  });
  const persisted = await persistCodingDecision(
    input.options.store,
    input.job.tenantId,
    input.job,
    input.context,
    input.state,
    decided,
    input.now(),
  );
  if (persisted.status === "cancelled") {
    throw new CodingWorkerOutcomeError(input.state.execution.id, "cancelled", persisted.nextStep);
  }
  return { executionId: input.state.execution.id, status: persisted.status };
}

interface CodingState {
  readonly execution: Execution;
  readonly authority: ExecutionAuthority;
  readonly thread: Thread;
  readonly task: CodingTask;
  readonly repository: VersionedRepository;
  readonly model: StoredModelConnection;
  readonly workspace?: Workspace;
  readonly runnerConfiguration?: CodingRunnerConfigurationV1;
}

async function loadCodingState(
  store: KernelStore,
  tenantId: string,
  executionId: string,
): Promise<CodingState> {
  return store.transact(tenantId, (transaction) => {
    const execution = transaction.getProjection<Execution>("execution", executionId);
    if (!execution) throw new Error("Execution 不存在");
    const authority = transaction.getProjection<ExecutionAuthority>("authority", execution.authorityId);
    if (!authority) throw new Error("Execution Authority 不存在");
    const thread = transaction.getProjection<Thread>("thread", execution.threadId);
    if (!thread) throw new Error("Thread 不存在");
    if (thread.resourceRef?.namespace !== "coding.task") {
      throw new Error("Coding Thread 未绑定 coding.task 资源");
    }
    const task = transaction.getProjection<CodingTask>("coding.task", thread.resourceRef.resourceId);
    if (!task) throw new Error("CodingTask 不存在");
    const repository = transaction.getProjection<VersionedRepository>(
      "coding.repository",
      task.repositoryId,
    );
    if (!repository) throw new Error("Coding Repository 不存在");
    const model = transaction.getProjection<StoredModelConnection>(
      "modelConnection",
      execution.modelBindingId,
    );
    if (!model) throw new Error("模型连接不存在");
    const runnerId = execution.runnerId ?? "builtin";
    const workspace = runnerId === "builtin"
      ? undefined
      : transaction.getProjection<Workspace>("workspace", execution.workspaceId);
    const runnerConfiguration = runnerId === "builtin"
      ? undefined
      : transaction.getProjection<CodingRunnerConfigurationV1>(
          CODING_RUNNER_CONFIGURATION_NAMESPACE,
          `${execution.workspaceId}:${runnerId}`,
        );
    return {
      execution,
      authority,
      thread,
      task,
      repository,
      model,
      ...(workspace ? { workspace } : {}),
      ...(runnerConfiguration ? { runnerConfiguration } : {}),
    };
  });
}

function assertCodingState(job: StoredJob, state: CodingState): void {
  if (state.execution.tenantId !== job.tenantId || state.authority.tenantId !== job.tenantId
    || state.thread.tenantId !== job.tenantId || state.model.tenantId !== job.tenantId) {
    throw new Error("Coding Job 不能跨租户读取执行配置");
  }
  if (state.execution.workspaceId !== job.workspaceId
    || state.authority.workspaceId !== state.execution.workspaceId
    || state.thread.workspaceId !== state.execution.workspaceId
    || state.task.workspaceId !== state.execution.workspaceId
    || state.repository.workspaceId !== state.execution.workspaceId) {
    throw new Error("Coding Job 的工作区配置不一致");
  }
  if (state.execution.pluginId !== "coding"
    || state.thread.pluginId !== "coding"
    || state.execution.agentDefinitionId !== "coding.builtin"
    || state.authority.executionId !== state.execution.id) {
    throw new Error("Coding Job 的执行配置不一致");
  }
  if (state.execution.status !== "running" && state.execution.status !== "waiting_approval") {
    throw new Error(`状态为 ${state.execution.status} 的 Coding Execution 不能由 Worker 处理`);
  }
  if (state.model.status !== "ready" || !state.model.defaultModel.trim()) {
    throw new Error("模型连接尚未就绪");
  }
  const runnerId = state.execution.runnerId ?? "builtin";
  if (runnerId !== "builtin" && runnerId !== "claude-cli" && runnerId !== "codex-cli") {
    throw new Error(`Coding Runner 不受支持：${String(runnerId)}`);
  }
  if (runnerId !== "builtin") {
    const pluginId = runnerPluginId(runnerId);
    if (!state.workspace
      || state.workspace.tenantId !== job.tenantId
      || state.workspace.id !== state.execution.workspaceId
      || !state.workspace.activePluginIds.includes("coding")
      || !state.workspace.activePluginIds.includes(pluginId)) {
      throw new Error(`工作区未启用外部 Runner 插件：${pluginId}`);
    }
    const configuration = state.runnerConfiguration;
    if (!configuration
      || configuration.tenantId !== job.tenantId
      || configuration.workspaceId !== state.execution.workspaceId
      || configuration.runnerId !== runnerId
      || configuration.status !== "confirmed") {
      throw new Error("外部 Runner 没有当前工作区的已确认配置");
    }
    if (!state.authority.toolIds.includes(runnerToolId(runnerId))) {
      throw new Error(`外部 Runner 缺少工具权限：${runnerToolId(runnerId)}`);
    }
  }
  for (const toolId of [
    "coding.repository.read",
    "coding.sandbox.write",
    "coding.gate.verify",
    "coding.candidate.accept",
  ]) {
    if (!state.authority.toolIds.includes(toolId)) {
      throw new Error(`Coding 执行缺少工具权限：${toolId}`);
    }
  }
}

function assertReconciliationBindings(input: {
  readonly tenantId: string;
  readonly execution: Execution;
  readonly run: StoredCodingRun;
  readonly task: CodingTask;
  readonly authority?: ExecutionAuthority;
  readonly repository?: VersionedRepository;
  readonly model?: StoredModelConnection;
  readonly runnerConfiguration?: CodingRunnerConfigurationV1;
}): void {
  const runnerId = input.run.runnerId;
  if (runnerId !== "claude-cli" && runnerId !== "codex-cli") {
    throw new Error("Coding 人工核对只接受显式外部 Runner");
  }
  const authority = input.authority;
  if (!authority
    || authority.tenantId !== input.tenantId
    || authority.workspaceId !== input.execution.workspaceId
    || authority.executionId !== input.execution.id
    || authority.principalId !== input.execution.executionPrincipalId
    || authority.commitment !== canonicalAuthorityCommitment(input.execution, authority, runnerId)
    || !authority.toolIds.includes("coding.repository.read")
    || !authority.toolIds.includes("coding.gate.verify")
    || !authority.toolIds.includes(runnerToolId(runnerId))
    || !authority.autoAllowedEffects.includes("local_read")) {
    throw new Error("Coding 人工核对的 ExecutionAuthority 绑定无效");
  }
  const repository = input.repository;
  if (!repository
    || repository.workspaceId !== input.execution.workspaceId
    || repository.id !== input.run.repositoryId
    || repository.id !== input.task.repositoryId
    || !isAbsolute(repository.rootRealPath)
    || resolve(repository.rootRealPath) !== repository.rootRealPath) {
    throw new Error("Coding 人工核对的 Repository 绑定无效");
  }
  const model = input.model;
  if (!model
    || model.id !== input.execution.modelBindingId
    || model.tenantId !== input.tenantId
    || model.status !== "ready"
    || !model.defaultModel.trim()) {
    throw new Error("Coding 人工核对的模型绑定无效");
  }
  const runnerConfiguration = input.runnerConfiguration;
  if (!runnerConfiguration
    || runnerConfiguration.id !== `${input.execution.workspaceId}:${runnerId}`
    || runnerConfiguration.tenantId !== input.tenantId
    || runnerConfiguration.workspaceId !== input.execution.workspaceId
    || runnerConfiguration.runnerId !== runnerId
    || runnerConfiguration.status !== "confirmed"
    || runnerConfiguration.identityDigest !== sha256(runnerConfiguration.identity)
    || runnerConfiguration.identityDigest !== input.run.externalInvocation?.identityDigest
    || input.execution.runnerId !== runnerId) {
    throw new Error("Coding 人工核对的 Runner 身份绑定无效");
  }
  const resourceDigest = input.run.controlPlane.repositoryIndexDigest;
  if (!authority.dataScopes.some((scope) => scope.namespace === "repository"
    && (scope.resourceId === "*" || scope.resourceId === repository.id)
    && (scope.digest === undefined || scope.digest === resourceDigest))) {
    throw new Error("Coding 人工核对超出 Repository 数据权限范围");
  }
}

function canonicalAuthorityCommitment(
  execution: Execution,
  authority: ExecutionAuthority,
  runnerId: ExternalCodingRunnerId,
): string {
  return sha256({
    executionId: execution.id,
    workspaceId: execution.workspaceId,
    principalId: authority.principalId,
    toolIds: authority.toolIds,
    dataScopes: authority.dataScopes,
    autoAllowedEffects: authority.autoAllowedEffects,
    budget: authority.budget,
    parentAuthorityId: authority.parentAuthorityId,
    runnerId,
  });
}

function assertAutoAuthorizedReconciliationIntent(
  authority: ExecutionAuthority,
  intent: ToolCallIntent,
): void {
  if (authorityAllowsIntent(authority, intent) !== "auto") {
    throw new Error("Coding 人工核对只执行已由 ExecutionAuthority 自动允许的只读工具");
  }
}

async function loadCodingRun(
  store: KernelStore,
  tenantId: string,
  executionId: string,
): Promise<StoredCodingRun | undefined> {
  return store.transact(tenantId, (transaction) =>
    transaction.getProjection<StoredCodingRun>("coding.execution", executionId));
}

async function inspectRepositoryControlled(input: {
  readonly repository: VersionedRepository;
  readonly execution: Execution;
  readonly authority: ExecutionAuthority;
  readonly runtime: RuntimeStore;
  readonly approval: ToolApprovalPort;
  readonly signal: AbortSignal;
  readonly now: () => string;
}): Promise<RepositorySnapshot> {
  const normalized = resolve(input.repository.rootRealPath);
  if (!input.repository.rootRealPath || normalized !== input.repository.rootRealPath) {
    throw new Error("仓库必须使用已规范化的绝对真实路径");
  }
  const actual = await realpath(normalized);
  if (actual !== input.repository.rootRealPath) throw new Error("仓库真实路径已变化，拒绝执行");
  const intent = createIntent({
    execution: input.execution,
    authority: input.authority,
    toolId: "coding.repository.read",
    effectClass: "local_read",
    intent: `读取受控仓库 ${input.repository.name}`,
    normalizedArguments: { repositoryId: input.repository.id, rootRealPath: actual },
    resourceRefs: [{ namespace: "repository", resourceId: input.repository.id }],
    now: input.now(),
  });
  await authorizeTool(input.runtime, input.approval, intent, input.signal);
  const snapshot = await inspectRepository(input.repository, actual, input.signal);
  await recordToolResult(input.runtime, intent, {
    baseRevision: snapshot.baseRevision,
    repositoryIndexDigest: snapshot.index.digest,
    trackedFiles: snapshot.index.entries.length,
  });
  return snapshot;
}

async function inspectRepository(
  repository: VersionedRepository,
  actualPath: string,
  signal: AbortSignal,
): Promise<RepositorySnapshot> {
  const topLevel = (await git(actualPath, ["rev-parse", "--show-toplevel"], signal)).stdout.trim();
  if (topLevel !== actualPath) throw new Error("仓库路径不是 Git 工作树根目录");
  const baseRevision = (await git(actualPath, ["rev-parse", "HEAD"], signal)).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(baseRevision)) throw new Error("无法固定仓库基础版本");
  const tree = parseGitTree((await git(actualPath, [
    "ls-tree", "-r", "-z", "--full-tree", baseRevision,
  ], signal)).stdout);
  const index = parseGitIndex((await git(actualPath, ["ls-files", "--stage", "-z"], signal)).stdout);
  const untracked = (await git(actualPath, [
    "ls-files", "--others", "--exclude-standard", "-z",
  ], signal)).stdout.split("\0").filter(Boolean);
  if (untracked.length > 0) {
    throw new Error("仓库存在未提交的未跟踪文件；为避免覆盖用户工作，已拒绝执行");
  }
  if (tree.size > MAX_TRACKED_FILES) throw new Error("仓库跟踪文件数量超过受控读取上限");
  if (index.size !== tree.size || [...tree].some(([path, entry]) => {
    const indexed = index.get(path);
    return !indexed || indexed.stage !== 0 || indexed.mode !== entry.mode || indexed.oid !== entry.oid;
  })) {
    throw new Error("仓库索引与固定 HEAD 不一致；为避免覆盖用户工作，已拒绝执行");
  }
  const entries: Array<{ path: string; digest: string; byteLength: number }> = [];
  const context: string[] = [];
  let totalBytes = 0;
  let contextBytes = 0;
  for (const [path, treeEntry] of tree) {
    if (signal.aborted) throw new CandidateOperationAbortedError();
    assertRelativeRepositoryPath(path);
    const absolute = join(actualPath, path);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (treeEntry.mode !== "100644" && treeEntry.mode !== "100755")) {
      throw new Error(`仓库包含不受支持的文件类型：${path}`);
    }
    const actualFile = await realpath(absolute);
    assertWithin(actualPath, actualFile, "跟踪文件");
    const handle = await open(actualFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let content: Buffer;
    try {
      const before = await handle.stat();
      content = await handle.readFile();
      const after = await handle.stat();
      if (!sameFileInfo(before, after) || !after.isFile() || after.isSymbolicLink()
        || after.nlink !== 1) {
        throw new Error(`仓库文件在受控读取期间发生变化：${path}`);
      }
    } finally {
      await handle.close();
    }
    if (signal.aborted) throw new CandidateOperationAbortedError();
    if (gitBlobOid(content, baseRevision.length) !== treeEntry.oid
      || ((stat.mode & 0o111) !== 0) !== (treeEntry.mode === "100755")) {
      throw new Error(`仓库跟踪文件与固定 HEAD 不一致：${path}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_INDEX_BYTES) throw new Error("仓库索引内容超过受控读取上限");
    entries.push({ path, digest: hashBytes(content), byteLength: content.byteLength });
    if (!content.includes(0) && contextBytes + content.byteLength <= MAX_MODEL_CONTEXT_BYTES) {
      context.push(`--- ${path}\n${content.toString("utf8")}`);
      contextBytes += content.byteLength;
    }
  }
  return {
    repository,
    realPath: actualPath,
    baseRevision,
    index: buildRepositoryIndex(entries),
    modelContext: context.join("\n\n"),
  };
}

interface ManagedCodingRunner extends CodingRunnerAdapter {
  readonly material: ReadonlyMap<string, CandidateMaterial>;
  readonly gateVerifier: GateVerifier;
  cleanup(preserveForReconciliation?: boolean): Promise<void>;
}

interface ExternalCodingRunnerOptions {
  readonly runnerId: ExternalCodingRunnerId;
  readonly configuration: CodingRunnerConfigurationV1;
  readonly execution: Execution;
  readonly authority: ExecutionAuthority;
  readonly task: CodingTask;
  readonly snapshot: RepositorySnapshot;
  readonly controlPlane: CodingControlPlaneCommitment;
  readonly runtime: RuntimeStore;
  readonly approval: ToolApprovalPort;
  readonly sandbox: MacOsCodingSandbox;
  readonly store: KernelStore;
  readonly tenantId: string;
  readonly signal: AbortSignal;
  readonly now: () => string;
}

class ExternalCodingRunner implements ManagedCodingRunner {
  readonly external = true;
  readonly material = new Map<string, CandidateMaterial>();
  readonly gateVerifier: GateVerifier;
  readonly id: ExternalCodingRunnerId;
  readonly #options: ExternalCodingRunnerOptions;
  #adapter?: ExternalRunnerAdapter;
  #artifact?: StagedRunnerArtifact;
  #sessionId?: string;
  #sandboxPath?: string;
  #sequence = 0;
  #intent?: ToolCallIntent;
  #abortListener?: () => void;
  #deadlineTimer?: NodeJS.Timeout;
  #timedOut = false;
  #terminalObserved = false;
  #hasCheckpoint = false;
  #launchRequested = false;
  #supervision?: RunnerSupervisionCheckpoint;
  #terminationConfirmed = false;

  get terminationConfirmed(): boolean {
    return this.#terminationConfirmed;
  }

  constructor(options: ExternalCodingRunnerOptions) {
    this.#options = options;
    this.id = options.runnerId;
    this.gateVerifier = { verify: (candidate, controlPlane) => this.#verify(candidate, controlPlane) };
  }

  async start(input: {
    readonly executionId: string;
    readonly repositoryPath: string;
    readonly expectedRepositoryRealPath: string;
    readonly resourceDigest: string;
    readonly preparedInput: string;
  }): Promise<{ readonly sessionId: string }> {
    try {
      if (input.executionId !== this.#options.execution.id
        || input.repositoryPath !== this.#options.snapshot.realPath
        || input.expectedRepositoryRealPath !== this.#options.snapshot.realPath
        || input.resourceDigest !== this.#options.controlPlane.repositoryIndexDigest) {
        throw new Error("外部 Runner 输入与已固定的 Execution 或仓库不一致");
      }
      if (this.#options.configuration.identityDigest
        !== sha256(this.#options.configuration.identity)) {
        throw new Error("Runner 确认记录摘要无效，已拒绝执行");
      }
      this.#sequence = 1;
      await this.#assertSourceUnchanged();
      this.#sandboxPath = await this.#options.sandbox.createExternalWorkingCopy(
        this.#options.snapshot,
        this.#sequence,
        this.#options.signal,
      );
      this.#artifact = await this.#options.sandbox.stageRunnerBinary(
        this.#options.configuration.identity,
      );
    } catch (error) {
      throw knownRunnerFailure(error);
    }
    await this.#authorizeAndCheckpoint("start");
    await this.#assertRunnerPluginActive();
    try {
      await this.#options.sandbox.verifyRunnerArtifact(
        this.#artifact!,
        this.#options.configuration.identity.version,
        this.#options.signal,
      );
    } catch (error) {
      throw knownRunnerFailure(error);
    }
    try {
      const launch = await this.#options.sandbox.externalLauncher(this.#sandboxPath!);
      this.#supervision = launch.supervision;
      this.#adapter = createExternalRunnerAdapter({
        runnerId: this.id,
        identity: this.#artifact!.identity,
        launch,
      });
    } catch (error) {
      throw knownRunnerFailure(error);
    }
    await this.#checkpointStarted();
    this.#launchRequested = true;
    const session = await this.#adapter!.start({
      executionId: input.executionId,
      repositoryPath: this.#sandboxPath,
      expectedRepositoryRealPath: this.#sandboxPath,
      resourceDigest: input.resourceDigest,
      preparedInput: externalRunnerInput(this.#options, input.preparedInput, this.#sequence),
      explicitlySelected: true,
    });
    this.#sessionId = session.sessionId;
    this.#terminalObserved = false;
    this.#abortListener = () => {
      if (this.#sessionId) void this.#adapter?.cancel(this.#sessionId).catch(() => undefined);
    };
    this.#options.signal.addEventListener("abort", this.#abortListener, { once: true });
    if (this.#options.signal.aborted) this.#abortListener();
    this.#deadlineTimer = setTimeout(() => {
      this.#timedOut = true;
      if (this.#sessionId) void this.#adapter?.cancel(this.#sessionId).catch(() => undefined);
    }, this.#options.authority.budget.maxDurationMs);
    this.#deadlineTimer.unref();
    return session;
  }

  async *events(sessionId: string): AsyncIterable<RunnerEvent> {
    if (!this.#adapter || !this.#sandboxPath || sessionId !== this.#sessionId) {
      throw new Error("外部 Runner 会话不存在");
    }
    for await (const event of this.#adapter.events(sessionId)) {
      if (event.type === "runner_event" && event.payload) {
        await this.#options.runtime.append({
          executionId: this.#options.execution.id,
          type: "runner/event",
          payload: {
            runnerId: this.id,
            eventType: typeof event.payload.type === "string" ? event.payload.type : "unknown",
            eventDigest: sha256(event.payload),
          },
        });
        yield { type: "runner_event", payload: event.payload };
        continue;
      }
      if (event.type === "diagnostic") {
        const message = event.message?.slice(0, 512) || "Runner 返回了诊断信息";
        await this.#options.runtime.append({
          executionId: this.#options.execution.id,
          type: "runner/diagnostic",
          payload: { runnerId: this.id, message },
        });
        yield { type: "diagnostic", message };
        continue;
      }
      if (event.type !== "result" || !event.status) continue;
      this.#terminalObserved = true;
      this.#terminationConfirmed = await this.#options.sandbox.waitForRunnerStopped(
        this.#supervision!,
        new AbortController().signal,
      );
      const resultStatus = this.#timedOut ? "unknown" as const : event.status;
      const result = !this.#terminationConfirmed
        ? {
            ...event,
            status: "unknown" as const,
            reason: "无法证明外部 Runner 已停止，必须保持人工核对",
            reconciliationRequired: true,
          }
        : this.#timedOut
        ? {
            ...event,
            status: "unknown" as const,
            reason: "Runner 超过 Execution 时限后被终止，外部结果需要人工核对",
            reconciliationRequired: true,
          }
        : event;
      await this.#recordOutcome(result);
      const effectiveStatus = this.#terminationConfirmed ? resultStatus : "unknown" as const;
      if (effectiveStatus !== "completed") {
        yield { type: "result", status: effectiveStatus, ...(result.reason ? { reason: result.reason } : {}) };
        return;
      }
      const material = await this.#options.sandbox.materializeExternalCandidate(
        this.#sandboxPath,
        this.#options.snapshot.baseRevision,
        this.#options.signal,
      );
      const diff = material.diff;
      if (!diff.trim()) {
        yield { type: "result", status: "failed", reason: "Runner 已完成，但没有生成可审阅 Diff" };
        return;
      }
      const candidateId = `${this.#options.execution.id}:generation:${this.#options.execution.generation}:candidate:${this.#sequence}`;
      const diffDigest = hashBytes(Buffer.from(diff));
      this.material.set(candidateId, material);
      yield {
        type: "candidate",
        candidate: {
          id: candidateId,
          sequence: this.#sequence,
          baseRevision: this.#options.snapshot.baseRevision,
          diffDigest,
          summary: `${runnerDisplayName(this.id)} 生成的候选变更`,
          sandbox: {
            enforced: true,
            fallbackUsed: false,
            evidenceDigest: this.#options.controlPlane.sandboxDigest,
          },
        },
      };
      return;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.#adapter || sessionId !== this.#sessionId) return;
    await this.#adapter.cancel(sessionId);
  }

  async resume(sessionId: string, input: { readonly preparedInput: string }): Promise<void> {
    if (!this.#adapter || sessionId !== this.#sessionId || !this.#sandboxPath) {
      throw new Error("外部 Runner 会话不存在");
    }
    this.#sequence += 1;
    try {
      await this.#assertSourceUnchanged();
    } catch (error) {
      throw knownRunnerFailure(error);
    }
    await this.#authorizeAndCheckpoint("resume");
    await this.#assertRunnerPluginActive();
    try {
      await this.#options.sandbox.verifyRunnerArtifact(
        this.#artifact!,
        this.#options.configuration.identity.version,
        this.#options.signal,
      );
    } catch (error) {
      throw knownRunnerFailure(error);
    }
    await this.#checkpointStarted();
    this.#terminalObserved = false;
    await this.#adapter.resume(sessionId, {
      preparedInput: externalRunnerInput(this.#options, input.preparedInput, this.#sequence),
      explicitlySelected: true,
    });
  }

  async cleanup(preserveForReconciliation = false): Promise<void> {
    if (this.#deadlineTimer) {
      clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = undefined;
    }
    if (this.#abortListener) {
      this.#options.signal.removeEventListener("abort", this.#abortListener);
      this.#abortListener = undefined;
    }
    if (this.#adapter && this.#sessionId && !this.#terminalObserved) {
      await this.#adapter.cancel(this.#sessionId);
      this.#terminalObserved = true;
    }
    if (this.#supervision && this.#launchRequested && !this.#terminationConfirmed) {
      this.#terminationConfirmed = await this.#options.sandbox.waitForRunnerStopped(
        this.#supervision,
        new AbortController().signal,
      );
      if (!this.#terminationConfirmed && !preserveForReconciliation) {
        throw new Error("无法证明外部 Runner 已停止，拒绝清理隔离资源");
      }
    }
    if (this.#sandboxPath) {
      if (!(preserveForReconciliation && this.#hasCheckpoint)) {
        await this.#options.sandbox.cleanup(this.#sandboxPath);
      }
      this.#sandboxPath = undefined;
    }
    if (this.#artifact) {
      await this.#options.sandbox.cleanupRunnerArtifact(this.#artifact);
      this.#artifact = undefined;
    }
    if (this.#supervision && !preserveForReconciliation) {
      await this.#options.sandbox.cleanupRunnerSupervision(this.#supervision);
      this.#supervision = undefined;
    }
  }

  async #authorizeAndCheckpoint(mode: "start" | "resume"): Promise<void> {
    if (!this.#sandboxPath || !this.#artifact) throw new Error("候选仓库或 Runner 制品尚未创建");
    const intent = createIntent({
      execution: this.#options.execution,
      authority: this.#options.authority,
      toolId: runnerToolId(this.id),
      effectClass: "external_side_effect",
      intent: `在受控候选仓库中${mode === "start" ? "启动" : "恢复"} ${runnerDisplayName(this.id)}`,
      normalizedArguments: {
        runnerId: this.id,
        mode,
        attempt: this.#sequence,
        binaryPath: this.#options.configuration.identity.realPath,
        binaryVersion: this.#options.configuration.identity.version,
        binarySha256: this.#options.configuration.identity.sha256,
        identityDigest: this.#options.configuration.identityDigest,
        stagedBinarySha256: this.#artifact.identity.sha256,
        stagedBinaryPathDigest: sha256(this.#artifact.identity.realPath),
        repositoryIndexDigest: this.#options.controlPlane.repositoryIndexDigest,
      },
      resourceRefs: [{
        namespace: "repository",
        resourceId: this.#options.snapshot.repository.id,
        digest: this.#options.controlPlane.repositoryIndexDigest,
      }],
      now: this.#options.now(),
    });
    try {
      await authorizeTool(this.#options.runtime, this.#options.approval, intent, this.#options.signal);
    } catch (error) {
      throw knownRunnerFailure(error);
    }
    this.#intent = intent;
  }

  async #checkpointStarted(): Promise<void> {
    if (!this.#sandboxPath || !this.#artifact) {
      throw new Error("候选仓库或 Runner 制品尚未创建");
    }
    await persistExternalInvocationStarted({
      store: this.#options.store,
      tenantId: this.#options.tenantId,
      state: {
        execution: this.#options.execution,
        task: this.#options.task,
      },
      runnerId: this.id,
      attempt: this.#sequence,
      identityDigest: this.#options.configuration.identityDigest,
      sandboxPath: this.#sandboxPath,
      runnerArtifactPath: this.#artifact.identity.realPath,
      supervision: this.#supervision!,
      occurredAt: this.#options.now(),
    });
    this.#hasCheckpoint = true;
  }

  async #recordOutcome(event: ExternalRunnerAdapterEvent): Promise<void> {
    if (!this.#intent || !event.status) throw new Error("Runner 结果缺少已持久化意图");
    if (event.status === "unknown") {
      await this.#options.runtime.append({
        executionId: this.#options.execution.id,
        type: "tool/outcome_unknown",
        payload: {
          toolCallId: this.#intent.id,
          runnerId: this.id,
          reason: event.reason ?? "Runner 没有返回可确认终态",
        },
      });
      return;
    }
    await this.#options.runtime.append({
      executionId: this.#options.execution.id,
      type: "tool/result",
      payload: {
        toolCallId: this.#intent.id,
        status: event.status === "completed" ? "completed" : event.status,
        runnerId: this.id,
      },
    });
  }

  async #assertSourceUnchanged(): Promise<void> {
    const actual = await realpath(this.#options.snapshot.realPath);
    const current = await inspectRepository(
      this.#options.snapshot.repository,
      actual,
      this.#options.signal,
    );
    if (current.realPath !== this.#options.snapshot.realPath
      || current.baseRevision !== this.#options.snapshot.baseRevision
      || current.index.digest !== this.#options.controlPlane.repositoryIndexDigest) {
      throw new Error("源仓库在外部 Runner 边界前已变化，拒绝使用旧确认");
    }
  }

  async #assertRunnerPluginActive(): Promise<void> {
    const pluginId = runnerPluginId(this.id);
    const active = await this.#options.store.transact(this.#options.tenantId, (transaction) => {
      const workspace = transaction.getProjection<Workspace>(
        "workspace",
        this.#options.execution.workspaceId,
      );
      return workspace?.tenantId === this.#options.tenantId
        && workspace.activePluginIds.includes("coding")
        && workspace.activePluginIds.includes(pluginId);
    });
    if (!active) {
      throw new RunnerKnownFailureError(`工作区未启用外部 Runner 插件：${pluginId}`);
    }
  }

  #verify(candidate: Candidate, controlPlane: CodingControlPlaneCommitment) {
    return verifySandboxCandidate({
      candidate,
      controlPlane,
      material: this.material,
      execution: this.#options.execution,
      authority: this.#options.authority,
      repository: this.#options.snapshot.repository,
      runtime: this.#options.runtime,
      approval: this.#options.approval,
      sandbox: this.#options.sandbox,
      signal: this.#options.signal,
      now: this.#options.now,
    });
  }
}

function createExternalRunnerAdapter(input: {
  readonly runnerId: ExternalCodingRunnerId;
  readonly identity: RunnerBinaryIdentityV1;
  readonly launch: ExternalRunnerLaunch;
}): ExternalRunnerAdapter {
  const options = {
    binaryPath: input.identity.requestedPath,
    confirmedIdentity: input.identity,
    inspectIdentity: () => inspectStagedRunnerIdentity(input.identity),
    launch: input.launch,
  };
  return input.runnerId === "claude-cli"
    ? createClaudeCliRunner(options)
    : createCodexCliRunner(options);
}

function runnerToolId(runnerId: ExternalCodingRunnerId): string {
  return runnerId === "claude-cli" ? "runner.claude.execute" : "runner.codex.execute";
}

function runnerPluginId(runnerId: ExternalCodingRunnerId): string {
  return runnerId === "claude-cli" ? "runner-claude-cli" : "runner-codex-cli";
}

function runnerDisplayName(runnerId: ExternalCodingRunnerId): string {
  return runnerId === "claude-cli" ? "Claude CLI" : "Codex CLI";
}

function knownRunnerFailure(error: unknown): RunnerKnownFailureError {
  return error instanceof RunnerKnownFailureError
    ? error
    : new RunnerKnownFailureError(safeMessage(error));
}

function isUserCancellation(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === "cancelled";
}

function cancelledCodingResult(result: CodingExecutionResult): CodingExecutionResult {
  const {
    approval: _approval,
    deliverable: _deliverable,
    ...base
  } = result;
  return {
    ...base,
    status: "cancelled",
    nextStep: "Execution 已由用户取消，候选隔离目录已清理",
  };
}

function gateCommand(material: CandidateMaterial): string {
  return material.materialization
    ? "git diff --no-index --check --binary --no-ext-diff --no-textconv --no-prefix -- a b"
    : "git diff --check HEAD --";
}

function externalRunnerInput(
  options: ExternalCodingRunnerOptions,
  input: string,
  attempt: number,
): string {
  return [
    "你正在木牛创建的受控候选仓库中工作。",
    "只修改当前工作目录内的文件；不要提交、推送或改写 Git 历史。",
    `任务：${options.task.request}`,
    `基础版本：${options.snapshot.baseRevision}`,
    `Spec：${options.controlPlane.specDigest}`,
    `Governance：${options.controlPlane.governanceDigest}`,
    `Harness：${options.controlPlane.harnessDigest}`,
    `尝试：${attempt}`,
    input === options.task.request ? "" : `Gate 反馈：\n${input}`,
  ].filter(Boolean).join("\n\n");
}

async function verifySandboxCandidate(input: {
  readonly candidate: Candidate;
  readonly controlPlane: CodingControlPlaneCommitment;
  readonly material: ReadonlyMap<string, CandidateMaterial>;
  readonly execution: Execution;
  readonly authority: ExecutionAuthority;
  readonly repository: Repository;
  readonly runtime: RuntimeStore;
  readonly approval: ToolApprovalPort;
  readonly sandbox: MacOsCodingSandbox;
  readonly signal: AbortSignal;
  readonly now: () => string;
}) {
  const material = input.material.get(input.candidate.id);
  if (!material) throw new Error("Gate 找不到候选隔离目录");
  if (hashBytes(Buffer.from(material.diff)) !== input.candidate.diffDigest) {
    throw new Error("Gate 前候选 Diff 摘要不一致");
  }
  const intent = createIntent({
    execution: input.execution,
    authority: input.authority,
    toolId: "coding.gate.verify",
    effectClass: "local_read",
    intent: `验证候选 ${input.candidate.id}`,
    normalizedArguments: {
      candidateId: input.candidate.id,
      diffDigest: input.candidate.diffDigest,
    },
    resourceRefs: [{
      namespace: "repository",
      resourceId: input.repository.id,
      digest: input.controlPlane.repositoryIndexDigest,
    }],
    now: input.now(),
  });
  await authorizeTool(input.runtime, input.approval, intent, input.signal);
  const currentDiff = await input.sandbox.currentCandidateDiff(material, input.signal);
  if (hashBytes(Buffer.from(currentDiff)) !== input.candidate.diffDigest) {
    throw new Error("Gate 执行前隔离目录中的 Diff 已变化");
  }
  const gate = await input.sandbox.verifyCandidate(material, input.signal);
  const evidenceDigest = sha256({
    candidateId: input.candidate.id,
    diffDigest: input.candidate.diffDigest,
    sandboxDigest: input.controlPlane.sandboxDigest,
    command: gateCommand(material),
    ...gate,
  });
  await recordToolResult(input.runtime, intent, {
    candidateId: input.candidate.id,
    status: gate.exitCode === 0 ? "passed" : "failed",
    evidenceDigest,
  });
  return {
    status: gate.exitCode === 0 ? "passed" as const : "failed" as const,
    authoritative: true,
    evidenceDigest,
    checks: [{
      id: "git.diff-check",
      status: gate.exitCode === 0 ? "passed" as const : "failed" as const,
      summary: gate.exitCode === 0
        ? "git diff --check 通过"
        : (gate.stderr || gate.stdout || "git diff --check 未通过").trim(),
    }],
    ...(gate.exitCode === 0 ? {} : { reason: "候选 Diff 未通过权威 Gate" }),
  };
}

class BuiltinCodingRunner implements ManagedCodingRunner {
  readonly id = "builtin";
  readonly external = false;
  readonly material = new Map<string, CandidateMaterial>();
  readonly gateVerifier: GateVerifier;
  readonly #options: BuiltinRunnerOptions;
  #sequence = 0;
  #feedback = "";

  constructor(options: BuiltinRunnerOptions) {
    this.#options = options;
    this.gateVerifier = { verify: (candidate, controlPlane) => this.#verify(candidate, controlPlane) };
  }

  async start(): Promise<{ sessionId: string }> {
    return { sessionId: `${this.#options.execution.id}:builtin` };
  }

  async *events(): AsyncIterable<RunnerEvent> {
    try {
      yield { type: "candidate", candidate: await this.#candidate() };
    } catch (error) {
      yield { type: "result", status: "failed", reason: safeMessage(error) };
    }
  }

  async cancel(): Promise<void> {
    // 每个候选都在隔离目录内完成；取消后不再启动新的模型或 Gate 边界。
  }

  async cleanup(): Promise<void> {
    const paths = new Set([...this.material.values()].map((item) => item.sandboxPath));
    await Promise.all([...paths].map((path) => this.#options.sandbox.cleanup(path)));
  }

  async resume(_sessionId: string, input: { readonly preparedInput: string }): Promise<void> {
    this.#feedback = input.preparedInput;
  }

  async #candidate(): Promise<CandidateDraft> {
    if (this.#options.signal.aborted) throw new Error("Coding 执行已取消");
    const sequence = ++this.#sequence;
    const current = await this.#inspectCurrentRepository(sequence);
    if (current.realPath !== this.#options.snapshot.realPath
      || current.baseRevision !== this.#options.snapshot.baseRevision
      || current.index.digest !== this.#options.controlPlane.repositoryIndexDigest) {
      throw new Error("仓库在模型边界前已变化，拒绝使用旧审批与旧上下文");
    }
    const request: ModelRequest = {
      executionId: this.#options.execution.id,
      agentId: "coding.builtin",
      generation: this.#options.execution.generation,
      messages: [
        {
          role: "system",
          content: [
            "你是木牛 Coding builtin Runner。",
            "只能调用 coding.sandbox.write 一次，参数必须是 {patch, summary}。",
            "patch 必须是基于固定 HEAD 的 unified diff；禁止声称已经通过 Gate。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `任务：${this.#options.task.request}`,
            `基础版本：${this.#options.snapshot.baseRevision}`,
            this.#feedback ? `上次 Gate 反馈：\n${this.#feedback}` : "",
            `受控仓库内容：\n${this.#options.snapshot.modelContext}`,
          ].filter(Boolean).join("\n\n"),
        },
      ],
      availableToolIds: ["coding.sandbox.write"],
    };
    await this.#options.runtime.append({
      executionId: this.#options.execution.id,
      type: "model/request",
      payload: request as unknown as JsonObject,
    });
    let apiKey: string;
    try {
      apiKey = await this.#options.secretStore.read(this.#options.model.secretRef);
    } catch {
      throw new ModelTransportError("无法读取模型凭据");
    }
    const response = await this.#options.modelInvoker({
      presetId: providerId(this.#options.model.presetId),
      model: this.#options.model.defaultModel,
      apiKey,
      request,
      signal: this.#options.signal,
    });
    await this.#options.runtime.append({
      executionId: this.#options.execution.id,
      type: "model/response",
      payload: response as unknown as JsonObject,
    });
    if (response.toolCalls.length !== 1 || response.toolCalls[0]?.toolId !== "coding.sandbox.write") {
      throw new Error("模型必须且只能提交一次 coding.sandbox.write 工具调用");
    }
    const call = response.toolCalls[0];
    const patch = requiredArgument(call.arguments, "patch");
    const summary = requiredArgument(call.arguments, "summary");
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES || patch.includes("\0")) {
      throw new Error("模型提交的 Diff 超过大小上限或包含空字节");
    }
    const patchDigest = hashBytes(Buffer.from(patch));
    const intent = createIntent({
      execution: this.#options.execution,
      authority: this.#options.authority,
      toolId: "coding.sandbox.write",
      effectClass: "local_reversible_write",
      intent: `在隔离目录生成第 ${sequence} 个候选`,
      normalizedArguments: { sequence, patchDigest, byteLength: Buffer.byteLength(patch) },
      resourceRefs: [{
        namespace: "repository",
        resourceId: this.#options.snapshot.repository.id,
        digest: this.#options.controlPlane.repositoryIndexDigest,
      }],
      now: this.#options.now(),
    });
    await authorizeTool(this.#options.runtime, this.#options.approval, intent, this.#options.signal);
    if (hashBytes(Buffer.from(patch)) !== patchDigest) throw new Error("Diff 在执行前已变化");
    const applied = await this.#options.sandbox.applyPatch(
      this.#options.snapshot,
      patch,
      sequence,
      this.#options.signal,
    );
    const candidateId = `${this.#options.execution.id}:generation:${this.#options.execution.generation}:candidate:${sequence}`;
    await recordToolResult(this.#options.runtime, intent, {
      candidateId,
      diffDigest: applied.diffDigest,
      sandboxDigest: this.#options.controlPlane.sandboxDigest,
    });
    this.material.set(candidateId, { diff: applied.diff, sandboxPath: applied.sandboxPath });
    return {
      id: candidateId,
      sequence,
      baseRevision: this.#options.snapshot.baseRevision,
      diffDigest: applied.diffDigest,
      summary,
      sandbox: {
        enforced: true,
        fallbackUsed: false,
        evidenceDigest: this.#options.controlPlane.sandboxDigest,
      },
    };
  }

  async #inspectCurrentRepository(sequence: number): Promise<RepositorySnapshot> {
    const actual = await realpath(this.#options.snapshot.realPath);
    const intent = createIntent({
      execution: this.#options.execution,
      authority: this.#options.authority,
      toolId: "coding.repository.read",
      effectClass: "local_read",
      intent: `在第 ${sequence} 个模型边界复核受控仓库`,
      normalizedArguments: {
        repositoryId: this.#options.snapshot.repository.id,
        rootRealPath: actual,
        sequence,
        expectedIndexDigest: this.#options.controlPlane.repositoryIndexDigest,
      },
      resourceRefs: [{
        namespace: "repository",
        resourceId: this.#options.snapshot.repository.id,
        digest: this.#options.controlPlane.repositoryIndexDigest,
      }],
      now: this.#options.now(),
    });
    await authorizeTool(this.#options.runtime, this.#options.approval, intent, this.#options.signal);
    const snapshot = await inspectRepository(
      this.#options.snapshot.repository,
      actual,
      this.#options.signal,
    );
    await recordToolResult(this.#options.runtime, intent, {
      baseRevision: snapshot.baseRevision,
      repositoryIndexDigest: snapshot.index.digest,
    });
    return snapshot;
  }

  async #verify(candidate: Candidate, controlPlane: CodingControlPlaneCommitment) {
    const material = this.material.get(candidate.id);
    if (!material) throw new Error("Gate 找不到候选隔离目录");
    if (hashBytes(Buffer.from(material.diff)) !== candidate.diffDigest) {
      throw new Error("Gate 前候选 Diff 摘要不一致");
    }
    const intent = createIntent({
      execution: this.#options.execution,
      authority: this.#options.authority,
      toolId: "coding.gate.verify",
      effectClass: "local_read",
      intent: `验证候选 ${candidate.id}`,
      normalizedArguments: { candidateId: candidate.id, diffDigest: candidate.diffDigest },
      resourceRefs: [{
        namespace: "repository",
        resourceId: this.#options.snapshot.repository.id,
        digest: controlPlane.repositoryIndexDigest,
      }],
      now: this.#options.now(),
    });
    await authorizeTool(this.#options.runtime, this.#options.approval, intent, this.#options.signal);
    const currentDiff = await this.#options.sandbox.currentCandidateDiff(
      material,
      this.#options.signal,
    );
    if (hashBytes(Buffer.from(currentDiff)) !== candidate.diffDigest) {
      throw new Error("Gate 执行前隔离目录中的 Diff 已变化");
    }
    const gate = await this.#options.sandbox.verifyCandidate(material, this.#options.signal);
    const evidenceDigest = sha256({
      candidateId: candidate.id,
      diffDigest: candidate.diffDigest,
      sandboxDigest: controlPlane.sandboxDigest,
      command: gateCommand(material),
      ...gate,
    });
    await recordToolResult(this.#options.runtime, intent, {
      candidateId: candidate.id,
      status: gate.exitCode === 0 ? "passed" : "failed",
      evidenceDigest,
    });
    return {
      status: gate.exitCode === 0 ? "passed" as const : "failed" as const,
      authoritative: true,
      evidenceDigest,
      checks: [{
        id: "git.diff-check",
        status: gate.exitCode === 0 ? "passed" as const : "failed" as const,
        summary: gate.exitCode === 0
          ? "git diff --check 通过"
          : (gate.stderr || gate.stdout || "git diff --check 未通过").trim(),
      }],
      ...(gate.exitCode === 0 ? {} : { reason: "候选 Diff 未通过权威 Gate" }),
    };
  }
}

interface BuiltinRunnerOptions {
  readonly execution: Execution;
  readonly authority: ExecutionAuthority;
  readonly task: CodingTask;
  readonly model: StoredModelConnection;
  readonly snapshot: RepositorySnapshot;
  readonly controlPlane: CodingControlPlaneCommitment;
  readonly runtime: RuntimeStore;
  readonly approval: ToolApprovalPort;
  readonly sandbox: MacOsCodingSandbox;
  readonly secretStore: CodingModelSecretReader;
  readonly modelInvoker: ByokModelInvoker;
  readonly signal: AbortSignal;
  readonly now: () => string;
}

class MacOsCodingSandbox {
  readonly #root: string;
  readonly #executable: string;
  #realRoot?: string;
  readonly #candidateBaseRevisions = new Map<string, string>();

  constructor(options: { readonly root: string; readonly executable: string }) {
    if (!isAbsolute(options.root)) throw new Error("Coding sandbox 根目录必须是绝对路径");
    if (!isAbsolute(options.executable)) throw new Error("sandbox-exec 必须是绝对路径");
    this.#root = resolve(options.root);
    this.#executable = resolve(options.executable);
  }

  async controlPlane(
    snapshot: RepositorySnapshot,
    task: CodingTask,
    runnerId: "builtin" | ExternalCodingRunnerId,
  ): Promise<CodingControlPlaneCommitment> {
    const root = await this.#initialize();
    return {
      protocol: "coding-v2",
      specDigest: sha256({ version: "coding-spec-v2", taskId: task.id, request: task.request }),
      governanceDigest: sha256({
        version: "coding-governance-v2",
        rules: ["preserve-user-work", "central-tool-policy", "no-unsandboxed-fallback"],
      }),
      harnessDigest: sha256({ version: "coding-harness-v2", gates: ["git.diff-check"], maxRepairs: 3 }),
      sandboxDigest: sha256({
        version: "macos-sandbox-exec-v2",
        executable: this.#executable,
        root,
        writeScope: "candidate-directory",
        candidateMaterialization: "worker-owned-no-index-v1",
        network: runnerId === "builtin" ? "denied" : "external-runner-provider-access",
        runnerId,
        fallback: "forbidden",
      }),
      repositoryIndexDigest: snapshot.index.digest,
    };
  }

  async applyPatch(
    snapshot: RepositorySnapshot,
    patch: string,
    sequence: number,
    signal: AbortSignal,
  ) {
    const repositoryPath = await this.createWorkingCopy(snapshot, sequence, signal);
    const candidateRoot = resolve(repositoryPath, "..");
    const patchPath = join(candidateRoot, "candidate.patch");
    await writeFile(patchPath, patch, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await requireSuccess(await this.#run(candidateRoot, repositoryPath, [
      "-c", "core.hooksPath=/dev/null",
      "apply", "--check", "--index", "--whitespace=nowarn", patchPath,
    ], signal), "候选 Diff 无法安全应用");
    await requireSuccess(await this.#run(candidateRoot, repositoryPath, [
      "-c", "core.hooksPath=/dev/null",
      "apply", "--index", "--whitespace=nowarn", patchPath,
    ], signal), "候选 Diff 应用失败");
    const diff = await this.diff(repositoryPath, signal);
    if (!diff.trim()) throw new Error("模型没有生成可审阅的代码变更");
    return {
      diff,
      diffDigest: hashBytes(Buffer.from(diff)),
      sandboxPath: repositoryPath,
    };
  }

  async createWorkingCopy(
    snapshot: RepositorySnapshot,
    sequence: number,
    signal: AbortSignal,
  ): Promise<string> {
    const root = await this.#initialize();
    const prefix = `${safePathPart(snapshot.repository.id)}-${sequence}-`;
    const candidateRoot = await mkdtemp(join(root, prefix));
    assertWithin(root, candidateRoot, "候选目录");
    const repositoryPath = join(candidateRoot, "repository");
    await mkdir(join(candidateRoot, "tmp"), { mode: 0o700 });
    await writeFile(join(candidateRoot, "empty.gitconfig"), "", { flag: "wx", mode: 0o600 });
    await requireSuccess(await this.#run(candidateRoot, undefined, [
      "-c", "protocol.file.allow=always",
      "clone", "--no-local", "--no-hardlinks", "--no-checkout", "--quiet",
      snapshot.realPath,
      repositoryPath,
    ], signal), "隔离仓库创建失败");
    await requireSuccess(await this.#run(candidateRoot, repositoryPath, [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "checkout", "--detach", "--quiet", snapshot.baseRevision,
    ], signal), "固定基础版本失败");
    const actualRepository = await realpath(repositoryPath);
    this.#candidateBaseRevisions.set(actualRepository, snapshot.baseRevision);
    return actualRepository;
  }

  async createExternalWorkingCopy(
    snapshot: RepositorySnapshot,
    sequence: number,
    signal: AbortSignal,
  ): Promise<string> {
    const repositoryPath = await this.createWorkingCopy(snapshot, sequence, signal);
    const materializationRoot = await this.#materializationRoot(repositoryPath, true);
    try {
      await writeFile(join(materializationRoot, "metadata.json"), `${JSON.stringify({
        protocol: "mn-untrusted-candidate-v1",
        repositoryPathDigest: sha256(repositoryPath),
        baseRevision: snapshot.baseRevision,
      })}\n`, { flag: "wx", mode: 0o600 });
      await copyCandidateTree({
        sourceRoot: repositoryPath,
        targetRoot: join(materializationRoot, "baseline"),
        signal,
        ignoreRootGit: true,
      });
      return repositoryPath;
    } catch (error) {
      await rm(materializationRoot, { recursive: true, force: true });
      await this.cleanup(repositoryPath);
      throw error;
    }
  }

  async materializeExternalCandidate(
    repositoryPath: string,
    expectedBaseRevision: string,
    signal: AbortSignal,
  ): Promise<CandidateMaterial> {
    const materializationRoot = await this.#materializationRoot(repositoryPath, false);
    const metadata = await this.#readMaterializationMetadata(
      materializationRoot,
      repositoryPath,
      expectedBaseRevision,
      signal,
    );
    if (metadata.baseRevision !== expectedBaseRevision) {
      throw new Error("候选固化基础版本与 Execution 检查点不一致");
    }
    const snapshotRoot = await mkdtemp(join(materializationRoot, "snapshot-"));
    assertWithin(materializationRoot, snapshotRoot, "Worker 候选快照");
    const basePath = join(snapshotRoot, "a");
    const candidatePath = join(snapshotRoot, "b");
    try {
      const baseManifest = await copyCandidateTree({
        sourceRoot: join(materializationRoot, "baseline"),
        targetRoot: basePath,
        signal,
      });
      const candidateManifest = await copyCandidateTree({
        sourceRoot: repositoryPath,
        targetRoot: candidatePath,
        signal,
        ignoreRootGit: true,
      });
      const diff = await this.#canonicalNoIndexDiff(snapshotRoot, signal);
      if (Buffer.byteLength(diff, "utf8") > MAX_PATCH_BYTES) {
        throw new Error("候选 Diff 超过 1 MiB 验证上限");
      }
      return {
        diff,
        sandboxPath: repositoryPath,
        materialization: {
          rootPath: snapshotRoot,
          basePath,
          candidatePath,
          baseManifest,
          candidateManifest,
        },
      };
    } catch (error) {
      await rm(snapshotRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async currentCandidateDiff(material: CandidateMaterial, signal: AbortSignal): Promise<string> {
    if (!material.materialization) return this.diff(material.sandboxPath, signal);
    await this.#assertMaterializedCandidate(material, signal);
    return this.#canonicalNoIndexDiff(material.materialization.rootPath, signal);
  }

  async verifyCandidate(material: CandidateMaterial, signal: AbortSignal): Promise<CommandResult> {
    if (!material.materialization) return this.verify(material.sandboxPath, signal);
    await this.#assertMaterializedCandidate(material, signal);
    const result = await this.#runMaterializedGit(
      material.materialization.rootPath,
      [
        "diff", "--no-index", "--check", "--binary", "--no-ext-diff", "--no-textconv",
        "--no-prefix", "--", "a", "b",
      ],
      signal,
      CANDIDATE_GATE_TIMEOUT_MS,
    );
    await this.#assertMaterializedCandidate(material, signal);
    return result.exitCode <= 1
      ? { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
      : result;
  }

  async stageRunnerBinary(confirmed: RunnerBinaryIdentityV1): Promise<StagedRunnerArtifact> {
    const root = await this.#initialize();
    if (!isAbsolute(confirmed.realPath) || confirmed.realPath.includes("\0")) {
      throw new Error("Runner 已确认真实路径无效");
    }
    const source = await open(
      confirmed.realPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    let bytes: Buffer;
    try {
      const before = await source.stat();
      if (!before.isFile() || (before.mode & 0o111) === 0 || before.size < 1) {
        throw new Error("Runner 必须是非空可执行普通文件");
      }
      bytes = await source.readFile();
      const after = await source.stat();
      if (!sameFileInfo(before, after)
        || String(after.dev) !== confirmed.device
        || String(after.ino) !== confirmed.inode
        || after.size !== confirmed.byteLength
        || after.mtimeMs !== confirmed.modifiedAtMs
        || hashBytes(bytes) !== confirmed.sha256) {
        throw new Error("Runner 二进制已变化，需要重新确认");
      }
    } finally {
      await source.close();
    }
    assertNativeMacExecutable(bytes);

    const artifactRoot = await mkdtemp(join(root, `runner-${confirmed.sha256.slice(0, 16)}-`));
    assertWithin(root, artifactRoot, "Runner 制品目录");
    const artifactPath = join(artifactRoot, "runner");
    const target = await open(artifactPath, "wx", 0o500);
    try {
      await target.writeFile(bytes);
      await target.sync();
    } finally {
      await target.close();
    }
    await chmod(artifactPath, 0o500);
    const info = await lstat(artifactPath);
    if (!info.isFile() || hashBytes(await readFile(artifactPath)) !== confirmed.sha256) {
      await rm(artifactRoot, { recursive: true, force: true });
      throw new Error("Runner 不可变副本校验失败");
    }
    await chmod(artifactRoot, 0o500);
    const identity: RunnerBinaryIdentityV1 = Object.freeze({
      requestedPath: artifactPath,
      realPath: artifactPath,
      version: confirmed.version,
      sha256: confirmed.sha256,
      device: String(info.dev),
      inode: String(info.ino),
      byteLength: info.size,
      modifiedAtMs: info.mtimeMs,
    });
    return Object.freeze({ rootPath: artifactRoot, identity });
  }

  async verifyRunnerArtifact(
    artifact: StagedRunnerArtifact,
    expectedVersion: string,
    signal: AbortSignal,
  ): Promise<void> {
    const root = await this.#initialize();
    const current = await inspectStagedRunnerIdentity(artifact.identity);
    assertWithin(root, artifact.rootPath, "Runner 制品目录");
    if (resolve(current.realPath, "..") !== artifact.rootPath) {
      throw new Error("Runner 制品目录结构无效");
    }
    const result = await command(
      this.#executable,
      ["-p", this.#runnerProbeProfile(), current.realPath, "--version"],
      artifact.rootPath,
      { TMPDIR: "/dev/null" },
      { signal, timeoutMs: 5_000 },
    );
    await requireSuccess(result, "Runner 版本探测失败");
    const version = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/u)[0]?.slice(0, 256) ?? "";
    if (!version || version !== expectedVersion) {
      throw new Error("Runner 不可变副本返回的版本与确认值不一致");
    }
    await inspectStagedRunnerIdentity(artifact.identity);
  }

  async cleanupRunnerArtifact(artifact: StagedRunnerArtifact): Promise<void> {
    await this.#cleanupRunnerArtifactPath(artifact.identity.realPath);
  }

  async cleanupReconciliationArtifacts(invocation: ExternalInvocationState): Promise<void> {
    if (invocation.terminationStatus !== "confirmed"
      || !await this.confirmRunnerStopped(invocation.supervision)) {
      throw new Error("无法证明外部 Runner 已停止，拒绝清理或终结人工核对");
    }
    await this.cleanup(invocation.sandboxPath);
    await this.#cleanupRunnerArtifactPath(invocation.runnerArtifactPath);
    await this.cleanupRunnerSupervision(invocation.supervision);
  }

  async #cleanupRunnerArtifactPath(artifactPath: string): Promise<void> {
    const root = await this.#initialize();
    if (!isAbsolute(artifactPath) || basename(artifactPath) !== "runner") {
      throw new Error("Runner 制品路径结构无效");
    }
    const artifactRoot = resolve(artifactPath, "..");
    assertWithin(root, artifactRoot, "Runner 制品目录");
    if (!basename(artifactRoot).startsWith("runner-")) {
      throw new Error("Runner 制品目录结构无效");
    }
    const info = await lstat(artifactRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Runner 制品目录类型无效");
    }
    await chmod(artifactRoot, 0o700);
    await rm(artifactRoot, { recursive: true, force: true });
  }

  async diff(repositoryPath: string, signal: AbortSignal): Promise<string> {
    const candidateRoot = await this.#candidateRoot(repositoryPath);
    const head = await this.#run(candidateRoot, repositoryPath, ["rev-parse", "HEAD"], signal);
    await requireSuccess(head, "读取候选基础版本失败");
    if (head.stdout.trim() !== this.#candidateBaseRevisions.get(repositoryPath)) {
      throw new Error("候选仓库基础版本已变化，拒绝产生 Diff");
    }
    const result = await this.#run(candidateRoot, repositoryPath, [
      "-c", "core.hooksPath=/dev/null",
      "diff", "--binary", "--no-ext-diff", "--no-color", "HEAD", "--",
    ], signal);
    await requireSuccess(result, "读取候选 Diff 失败");
    return result.stdout;
  }

  async verify(repositoryPath: string, signal: AbortSignal): Promise<CommandResult> {
    const candidateRoot = await this.#candidateRoot(repositoryPath);
    return this.#run(candidateRoot, repositoryPath, [
      "-c", "core.hooksPath=/dev/null",
      "diff", "--check", "HEAD", "--",
    ], signal);
  }

  async externalLauncher(
    repositoryPath: string,
  ): Promise<ExternalRunnerLaunch> {
    const root = await this.#initialize();
    const candidateRoot = await this.#candidateRoot(repositoryPath);
    const actualRepository = await realpath(repositoryPath);
    const profile = this.#profile(candidateRoot, true);
    const supervision = await this.#createRunnerSupervision(root);
    const launch = ((spec: ExternalRunnerSpawnSpec) => {
      if (spec.cwd !== actualRepository || !isAbsolute(spec.executable) || spec.shell !== false) {
        throw new Error("外部 Runner 启动参数未固定到候选仓库");
      }
      return launchManagedProcess({
        executable: this.#executable,
        cwd: actualRepository,
        args: ["-p", profile, spec.executable, ...spec.args],
        stdin: spec.stdin,
        shell: false,
        env: { ...spec.env, TMPDIR: join(candidateRoot, "tmp") },
      }, supervision);
    }) as ExternalRunnerLaunch;
    Object.defineProperty(launch, "supervision", {
      enumerable: true,
      value: Object.freeze({
        protocol: supervision.protocol,
        statePath: supervision.statePath,
        tokenDigest: supervision.tokenDigest,
      }),
    });
    return launch;
  }

  async waitForRunnerStopped(
    supervision: RunnerSupervisionCheckpoint,
    signal: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (signal.aborted) throw new Error("等待外部 Runner 停止时 Job 已失去租约或被取消");
      if (await this.confirmRunnerStopped(supervision)) return true;
      await abortableDelay(100, signal);
    }
    return false;
  }

  async confirmRunnerStopped(supervision: RunnerSupervisionCheckpoint): Promise<boolean> {
    const root = await this.#initialize();
    this.#assertSupervisionPath(root, supervision.statePath);
    const serialized = await readFile(supervision.statePath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!serialized) return false;
    try {
      const state = JSON.parse(serialized) as {
        readonly protocol?: unknown;
        readonly token?: unknown;
        readonly status?: unknown;
      };
      return state.protocol === supervision.protocol
        && typeof state.token === "string"
        && sha256(state.token) === supervision.tokenDigest
        && state.status === "terminated";
    } catch {
      return false;
    }
  }

  async cleanupRunnerSupervision(supervision: RunnerSupervisionCheckpoint): Promise<void> {
    const root = await this.#initialize();
    this.#assertSupervisionPath(root, supervision.statePath);
    if (!await this.confirmRunnerStopped(supervision)) {
      throw new Error("无法证明外部 Runner 已停止，拒绝清理监督记录");
    }
    const supervisorRoot = resolve(supervision.statePath, "..");
    await rm(supervisorRoot, { recursive: true, force: true });
    await rmdir(resolve(supervisorRoot, "..")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    });
  }

  async cleanup(repositoryPath: string): Promise<void> {
    const root = await this.#initialize();
    const candidateRoot = resolve(repositoryPath, "..");
    assertWithin(root, candidateRoot, "候选目录");
    if (basename(repositoryPath) !== "repository") throw new Error("候选仓库目录结构无效");
    this.#candidateBaseRevisions.delete(repositoryPath);
    await rm(candidateRoot, { recursive: true, force: true });
    const materializedBase = join(root, "materialized");
    const materializationRoot = join(materializedBase, basename(candidateRoot));
    assertWithin(materializedBase, materializationRoot, "候选固化目录");
    await rm(materializationRoot, { recursive: true, force: true });
    await rmdir(materializedBase).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    });
  }

  async #initialize(): Promise<string> {
    if (process.platform !== "darwin") {
      throw new Error("当前平台没有已审核的 Coding sandbox，已拒绝无沙箱执行");
    }
    const executable = await realpath(this.#executable).catch(() => "");
    if (executable !== this.#executable) throw new Error("sandbox-exec 不存在或真实路径已变化");
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.#root);
    this.#realRoot = root;
    return root;
  }

  async #createRunnerSupervision(root: string): Promise<RunnerSupervisionLease> {
    const supervisorBase = join(root, "supervisors");
    await mkdir(supervisorBase, { recursive: true, mode: 0o700 });
    const supervisorRoot = await mkdtemp(join(supervisorBase, "runner-supervisor-"));
    assertWithin(root, supervisorRoot, "Runner 监督目录");
    const statePath = join(supervisorRoot, "state.json");
    const token = randomBytes(32).toString("hex");
    await writeFile(statePath, `${JSON.stringify({
      protocol: "mn-runner-supervisor-v1",
      token,
      status: "prepared",
      updatedAt: new Date().toISOString(),
    })}\n`, { flag: "wx", mode: 0o600 });
    return Object.freeze({
      protocol: "mn-runner-supervisor-v1",
      statePath,
      token,
      tokenDigest: sha256(token),
    });
  }

  async #materializationRoot(repositoryPath: string, create: boolean): Promise<string> {
    const root = await this.#initialize();
    const candidateRoot = await this.#candidateRoot(repositoryPath);
    const base = join(root, "materialized");
    const materializationRoot = join(base, basename(candidateRoot));
    assertWithin(base, materializationRoot, "候选固化目录");
    if (create) {
      await mkdir(base, { recursive: true, mode: 0o700 });
      await mkdir(materializationRoot, { mode: 0o700 });
    }
    const actual = await realpath(materializationRoot);
    if (actual !== materializationRoot) throw new Error("候选固化目录真实路径已变化");
    const info = await lstat(actual);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("候选固化目录类型无效");
    return actual;
  }

  async #readMaterializationMetadata(
    materializationRoot: string,
    repositoryPath: string,
    expectedBaseRevision: string,
    signal: AbortSignal,
  ): Promise<{ readonly baseRevision: string }> {
    if (signal.aborted) throw new CandidateOperationAbortedError();
    const metadataPath = join(materializationRoot, "metadata.json");
    const handle = await open(metadataPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let serialized: string;
    try {
      const before = await handle.stat();
      serialized = await handle.readFile("utf8");
      const after = await handle.stat();
      if (!before.isFile() || !sameFileInfo(before, after)) {
        throw new Error("候选固化元数据在读取期间发生变化");
      }
    } finally {
      await handle.close();
    }
    if (signal.aborted) throw new CandidateOperationAbortedError();
    const value = JSON.parse(serialized) as {
      readonly protocol?: unknown;
      readonly repositoryPathDigest?: unknown;
      readonly baseRevision?: unknown;
    };
    if (value.protocol !== "mn-untrusted-candidate-v1"
      || value.repositoryPathDigest !== sha256(repositoryPath)
      || value.baseRevision !== expectedBaseRevision) {
      throw new Error("候选固化元数据与 Execution 检查点不一致");
    }
    return { baseRevision: expectedBaseRevision };
  }

  async #canonicalNoIndexDiff(snapshotRoot: string, signal: AbortSignal): Promise<string> {
    const result = await this.#runMaterializedGit(
      snapshotRoot,
      [
        "diff", "--no-index", "--binary", "--no-ext-diff", "--no-textconv", "--no-prefix",
        "--", "a", "b",
      ],
      signal,
      CANDIDATE_GATE_TIMEOUT_MS,
    );
    if (result.exitCode > 1) {
      await requireSuccess(result, "无法生成候选 canonical Diff");
    }
    return result.stdout;
  }

  async #assertMaterializedCandidate(
    material: CandidateMaterial,
    signal: AbortSignal,
  ): Promise<void> {
    const state = material.materialization;
    if (!state) throw new Error("候选缺少 Worker 固化快照");
    const root = await this.#initialize();
    assertWithin(join(root, "materialized"), state.rootPath, "Worker 候选快照");
    if (resolve(state.rootPath, "a") !== state.basePath
      || resolve(state.rootPath, "b") !== state.candidatePath) {
      throw new Error("Worker 候选快照目录结构无效");
    }
    const [baseManifest, candidateManifest] = await Promise.all([
      inspectCandidateTree({ root: state.basePath, signal }),
      inspectCandidateTree({ root: state.candidatePath, signal }),
    ]);
    if (baseManifest.digest !== state.baseManifest.digest
      || baseManifest.fileCount !== state.baseManifest.fileCount
      || baseManifest.totalBytes !== state.baseManifest.totalBytes
      || candidateManifest.digest !== state.candidateManifest.digest
      || candidateManifest.fileCount !== state.candidateManifest.fileCount
      || candidateManifest.totalBytes !== state.candidateManifest.totalBytes) {
      throw new Error("Worker 候选快照在 Gate 前发生变化");
    }
  }

  async #runMaterializedGit(
    snapshotRoot: string,
    gitArguments: readonly string[],
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<CommandResult> {
    const root = await this.#initialize();
    assertWithin(join(root, "materialized"), snapshotRoot, "Worker 候选快照");
    const actual = await realpath(snapshotRoot);
    if (actual !== snapshotRoot) throw new Error("Worker 候选快照真实路径已变化");
    const tmp = join(snapshotRoot, "tmp");
    await mkdir(tmp, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const profile = this.#profile(snapshotRoot, false);
    return command(
      this.#executable,
      ["-p", profile, GIT, ...gitArguments],
      snapshotRoot,
      {
        TMPDIR: tmp,
        GIT_DIR: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_PAGER: "cat",
      },
      { signal, timeoutMs, maxBufferBytes: 2 * MAX_PATCH_BYTES },
    );
  }

  #assertSupervisionPath(root: string, statePath: string): void {
    if (!isAbsolute(statePath) || basename(statePath) !== "state.json") {
      throw new Error("Runner 监督状态路径无效");
    }
    const supervisorRoot = resolve(statePath, "..");
    assertWithin(join(root, "supervisors"), supervisorRoot, "Runner 监督目录");
    if (!basename(supervisorRoot).startsWith("runner-supervisor-")) {
      throw new Error("Runner 监督目录结构无效");
    }
  }

  async #candidateRoot(repositoryPath: string): Promise<string> {
    const root = await this.#initialize();
    const actual = await realpath(repositoryPath);
    assertWithin(root, actual, "候选仓库");
    if (basename(actual) !== "repository") throw new Error("候选仓库目录结构无效");
    return resolve(actual, "..");
  }

  #run(
    candidateRoot: string,
    cwd: string | undefined,
    gitArguments: readonly string[],
    signal: AbortSignal,
  ) {
    const root = this.#realRoot;
    if (!root) throw new Error("Coding sandbox 尚未初始化");
    assertWithin(root, candidateRoot, "候选目录");
    const profile = this.#profile(candidateRoot, false);
    return command(this.#executable, ["-p", profile, GIT, ...gitArguments], cwd, {
      TMPDIR: join(candidateRoot, "tmp"),
      GIT_CONFIG_GLOBAL: join(candidateRoot, "empty.gitconfig"),
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_PAGER: "cat",
    }, { signal, timeoutMs: CONTROLLED_GIT_TIMEOUT_MS });
  }

  #profile(candidateRoot: string, allowNetwork: boolean): string {
    return [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      "(allow file-read*)",
      `(allow file-write* (subpath \"${schemeString(candidateRoot)}\"))`,
      "(allow file-write* (literal \"/dev/null\"))",
      allowNetwork ? "(allow network*)" : "(deny network*)",
    ].join("\n");
  }

  #runnerProbeProfile(): string {
    return [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      "(allow file-read*)",
      "(allow file-write* (literal \"/dev/null\"))",
      "(deny network*)",
    ].join("\n");
  }
}

async function persistReconciliationVerification(input: {
  readonly store: KernelStore;
  readonly tenantId: string;
  readonly job: StoredJob;
  readonly context: CodingWorkerJobContext;
  readonly execution: Execution;
  readonly run: StoredCodingRun;
  readonly task: CodingTask;
  readonly thread: Thread;
  readonly authority: ExecutionAuthority;
  readonly repository: VersionedRepository;
  readonly model: StoredModelConnection;
  readonly runnerConfiguration: CodingRunnerConfigurationV1;
  readonly candidate?: Candidate;
  readonly diff?: string;
  readonly gate?: GateResult;
  readonly evidence?: CodeEvidence;
  readonly failureReason?: string;
  readonly now: string;
}): Promise<JsonValue> {
  return input.store.transact(input.tenantId, (transaction) => {
    const execution = transaction.getProjection<Execution>("execution", input.execution.id);
    const run = transaction.getProjection<StoredCodingRun>("coding.execution", input.execution.id);
    const task = transaction.getProjection<CodingTask>("coding.task", input.task.id);
    const thread = transaction.getProjection<Thread>("thread", input.thread.id);
    const authority = transaction.getProjection<ExecutionAuthority>("authority", input.execution.authorityId);
    const repository = transaction.getProjection<VersionedRepository>(
      "coding.repository",
      input.repository.id,
    );
    const model = transaction.getProjection<StoredModelConnection>(
      "modelConnection",
      input.execution.modelBindingId,
    );
    const runnerConfiguration = transaction.getProjection<CodingRunnerConfigurationV1>(
      CODING_RUNNER_CONFIGURATION_NAMESPACE,
      input.runnerConfiguration.id,
    );
    if (execution?.status === "completed"
      && run?.externalInvocation?.verification?.status === "passed") {
      return { executionId: execution.id, status: "completed" };
    }
    if (!execution || execution.status !== "needs_reconciliation"
      || execution.generation !== input.execution.generation
      || !run || run.generation !== execution.generation
      || run.status !== "needs_reconciliation" || !run.result
      || run.externalInvocation?.status !== "outcome_unknown"
      || run.externalInvocation.verification?.status !== "pending"
      || run.externalInvocation.verification.jobId !== input.job.id
      || !task || task.status !== "needs_reconciliation"
      || !thread || thread.workspaceId !== execution.workspaceId
      || thread.resourceRef?.namespace !== "coding.task"
      || thread.resourceRef.resourceId !== task.id) {
      throw new Error("Coding 人工核对验证提交时状态已变化");
    }
    assertReconciliationBindings({
      tenantId: input.tenantId,
      execution,
      run,
      task,
      authority,
      repository,
      model,
      runnerConfiguration,
    });
    if (authority!.commitment !== input.authority.commitment
      || authority!.streamVersion !== input.authority.streamVersion
      || repository!.rootRealPath !== input.repository.rootRealPath
      || repository!.streamVersion !== input.repository.streamVersion
      || model!.id !== input.model.id
      || model!.defaultModel !== input.model.defaultModel
      || runnerConfiguration!.identityDigest !== input.runnerConfiguration.identityDigest
      || runnerConfiguration!.streamVersion !== input.runnerConfiguration.streamVersion) {
      throw new Error("Coding 人工核对验证绑定在 Gate 期间发生变化");
    }
    const passed = Boolean(input.candidate && input.diff && input.gate?.status === "passed"
      && input.gate.authoritative && input.gate.evidenceDigest && input.evidence
      && input.evidence.candidateId === input.candidate.id
      && input.evidence.diffDigest === input.candidate.diffDigest
      && input.evidence.gateEvidenceDigest === input.gate.evidenceDigest);
    const failureReason = input.failureReason
      ?? (passed ? undefined : "保留候选没有通过权威 Gate");
    let taskVersion = task.streamVersion;
    if (input.candidate && input.diff) {
      const storedCandidate: StoredCandidate = {
        ...input.candidate,
        tenantId: input.tenantId,
        workspaceId: execution.workspaceId,
        executionId: execution.id,
        diff: input.diff,
        createdAt: input.now,
      };
      transaction.putProjection("coding.candidate", input.candidate.id, storedCandidate);
      transaction.appendEvent({
        tenantId: input.tenantId,
        aggregateType: "coding.task",
        aggregateId: task.id,
        expectedStreamVersion: taskVersion++,
        type: "coding.reconciliation_candidate_recorded",
        actorId: `worker:${input.context.workerId}`,
        executionId: execution.id,
        generation: execution.generation,
        correlationId: `coding:${execution.id}:${execution.generation}:reconciliation-verify`,
        publicPayload: {
          workspaceId: execution.workspaceId,
          candidateId: input.candidate.id,
          diffDigest: input.candidate.diffDigest,
          runnerId: run.runnerId,
          fencingToken: input.context.fencingToken,
        },
      });
    }
    if (input.gate) {
      transaction.putProjection("coding.gate-result", input.gate.candidateId, {
        ...input.gate,
        tenantId: input.tenantId,
        workspaceId: execution.workspaceId,
        executionId: execution.id,
        createdAt: input.now,
      });
      transaction.appendEvent({
        tenantId: input.tenantId,
        aggregateType: "coding.task",
        aggregateId: task.id,
        expectedStreamVersion: taskVersion++,
        type: "coding.reconciliation_gate_recorded",
        actorId: `worker:${input.context.workerId}`,
        executionId: execution.id,
        generation: execution.generation,
        correlationId: `coding:${execution.id}:${execution.generation}:reconciliation-verify`,
        publicPayload: {
          workspaceId: execution.workspaceId,
          candidateId: input.gate.candidateId,
          status: input.gate.status,
          authoritative: input.gate.authoritative,
          evidenceDigest: input.gate.evidenceDigest!,
          fencingToken: input.context.fencingToken,
        },
      });
    }
    if (passed && input.evidence) {
      transaction.putProjection("coding.code-evidence", input.evidence.digest, {
        ...input.evidence,
        tenantId: input.tenantId,
        workspaceId: execution.workspaceId,
        executionId: execution.id,
        createdAt: input.now,
      });
      transaction.appendEvent({
        tenantId: input.tenantId,
        aggregateType: "coding.task",
        aggregateId: task.id,
        expectedStreamVersion: taskVersion++,
        type: "coding.reconciliation_evidence_recorded",
        actorId: `worker:${input.context.workerId}`,
        executionId: execution.id,
        generation: execution.generation,
        correlationId: `coding:${execution.id}:${execution.generation}:reconciliation-verify`,
        publicPayload: {
          workspaceId: execution.workspaceId,
          candidateId: input.evidence.candidateId,
          evidenceDigest: input.evidence.digest,
          fencingToken: input.context.fencingToken,
        },
      });
    }
    transaction.appendEvent({
      tenantId: input.tenantId,
      aggregateType: "coding.task",
      aggregateId: task.id,
      expectedStreamVersion: taskVersion++,
      type: passed
        ? "coding.reconciliation_verification_passed"
        : "coding.reconciliation_verification_failed",
      actorId: `worker:${input.context.workerId}`,
      executionId: execution.id,
      generation: execution.generation,
      correlationId: `coding:${execution.id}:${execution.generation}:reconciliation-verify`,
      publicPayload: {
        workspaceId: execution.workspaceId,
        status: passed ? "completed" : "needs_reconciliation",
        fencingToken: input.context.fencingToken,
      },
    });
    const nextTask: CodingTask = {
      ...task,
      stage: passed ? "learn" : "verify",
      status: passed ? "completed" : "needs_reconciliation",
      streamVersion: taskVersion,
      updatedAt: input.now,
    };
    transaction.putProjection("coding.task", task.id, nextTask);

    const { failureCode: _failureCode, finishedAt: _finishedAt, ...executionSource } = execution;
    const nextExecution: Execution = passed ? {
      ...executionSource,
      status: "completed",
      streamVersion: execution.streamVersion + 1,
      updatedAt: input.now,
      finishedAt: input.now,
    } : {
      ...execution,
      streamVersion: execution.streamVersion + 1,
      updatedAt: input.now,
    };
    transaction.putProjection("execution", execution.id, nextExecution);
    transaction.appendEvent({
      tenantId: input.tenantId,
      aggregateType: "execution",
      aggregateId: execution.id,
      expectedStreamVersion: execution.streamVersion,
      type: passed
        ? "execution.reconciliation_verified"
        : "execution.reconciliation_verification_failed",
      actorId: `worker:${input.context.workerId}`,
      executionId: execution.id,
      generation: execution.generation,
      correlationId: `coding:${execution.id}:${execution.generation}:reconciliation-verify`,
      publicPayload: {
        workspaceId: execution.workspaceId,
        status: nextExecution.status,
        fencingToken: input.context.fencingToken,
      },
    });

    const cleanupJob = passed
      ? codingCleanupJob(input, execution, run)
      : undefined;
    const { evidence: _oldEvidence, approval: _oldApproval, deliverable: _oldDeliverable, ...resultSource }
      = run.result;
    const nextResult: CodingExecutionResult = {
      ...resultSource,
      task: nextTask,
      status: passed ? "completed" : "needs_reconciliation",
      candidates: input.candidate ? [input.candidate] : [],
      gates: input.gate ? [input.gate] : [],
      ...(passed && input.evidence ? {
        evidence: input.evidence,
        approval: "approved_once" as const,
        deliverable: {
          kind: "code_change" as const,
          title: task.title,
          summary: input.candidate!.summary,
          diffDigest: input.candidate!.diffDigest,
          nextStep: "查看成果并记录学习结论",
        },
      } : {}),
      nextStep: passed
        ? "保留候选已通过权威 Gate，并依据人工决定标记完成"
        : `${failureReason}；请选择 terminate 或 create_new_call`,
    };
    const nextRun: StoredCodingRun = {
      ...run,
      status: nextResult.status,
      result: nextResult,
      externalInvocation: {
        ...run.externalInvocation,
        status: passed ? "settled" : "outcome_unknown",
        verification: {
          ...run.externalInvocation.verification,
          status: passed ? "passed" : "failed",
          ...(failureReason ? { failureReason } : {}),
          updatedAt: input.now,
        },
        ...(cleanupJob ? {
          cleanupStatus: "pending" as const,
          cleanupJobId: cleanupJob.id,
        } : {}),
        updatedAt: input.now,
      },
      streamVersion: run.streamVersion + 1,
      updatedAt: input.now,
    };
    transaction.putProjection("coding.execution", execution.id, nextRun);
    transaction.appendEvent({
      tenantId: input.tenantId,
      aggregateType: "coding.execution",
      aggregateId: execution.id,
      expectedStreamVersion: run.streamVersion,
      type: passed
        ? "coding.reconciliation_verification_passed"
        : "coding.reconciliation_verification_failed",
      actorId: `worker:${input.context.workerId}`,
      executionId: execution.id,
      generation: execution.generation,
      correlationId: `coding:${execution.id}:${execution.generation}:reconciliation-verify`,
      publicPayload: {
        workspaceId: execution.workspaceId,
        taskId: task.id,
        status: nextResult.status,
        ...(input.evidence ? { evidenceDigest: input.evidence.digest } : {}),
        ...(cleanupJob ? { cleanupJobId: cleanupJob.id } : {}),
        fencingToken: input.context.fencingToken,
      },
    });
    if (passed && nextResult.deliverable) {
      const deliverable: Deliverable = {
        id: `coding-deliverable:${execution.id}`,
        tenantId: input.tenantId,
        workspaceId: execution.workspaceId,
        pluginId: "coding",
        threadId: input.thread.id,
        executionId: execution.id,
        kind: nextResult.deliverable.kind,
        title: nextResult.deliverable.title,
        summary: nextResult.deliverable.summary,
        assetIds: [],
        nextAction: nextResult.deliverable.nextStep,
        streamVersion: 1,
        createdAt: input.now,
        updatedAt: input.now,
      };
      transaction.putProjection("deliverable", deliverable.id, deliverable);
      transaction.appendEvent({
        tenantId: input.tenantId,
        aggregateType: "deliverable",
        aggregateId: deliverable.id,
        expectedStreamVersion: 0,
        type: "deliverable.created",
        actorId: `worker:${input.context.workerId}`,
        executionId: execution.id,
        generation: execution.generation,
        correlationId: `coding:${execution.id}:${execution.generation}:reconciliation-verify`,
        publicPayload: {
          workspaceId: execution.workspaceId,
          pluginId: "coding",
          taskId: task.id,
          kind: deliverable.kind,
          diffDigest: nextResult.deliverable.diffDigest,
        },
      });
    }
    for (const item of transaction.listProjections<InboxItem>("inbox")) {
      if (item.executionId !== execution.id || item.status !== "open") continue;
      transaction.putProjection("inbox", item.id, passed ? {
        ...item,
        status: "resolved",
      } : {
        ...item,
        summary: nextResult.nextStep,
        risk: "gate_failed",
      });
    }
    if (cleanupJob) {
      transaction.putProjection("job", cleanupJob.id, cleanupJob);
      transaction.appendEvent({
        tenantId: input.tenantId,
        aggregateType: "job",
        aggregateId: cleanupJob.id,
        expectedStreamVersion: 0,
        type: "job.available",
        actorId: `worker:${input.context.workerId}`,
        executionId: execution.id,
        generation: execution.generation,
        correlationId: `coding:${execution.id}:${execution.generation}:reconciliation-verify`,
        publicPayload: {
          workspaceId: execution.workspaceId,
          jobId: cleanupJob.id,
          kind: cleanupJob.kind,
        },
      });
      transaction.putJob({
        id: cleanupJob.id,
        tenantId: cleanupJob.tenantId,
        workspaceId: cleanupJob.workspaceId,
        kind: cleanupJob.kind,
        payload: cleanupJob.payload,
        availableAt: cleanupJob.availableAt,
        idempotencyKey: cleanupJob.idempotencyKey,
      });
      transaction.putOutbox({
        id: `outbox:${cleanupJob.id}`,
        tenantId: input.tenantId,
        topic: "job.available",
        payload: {
          workspaceId: execution.workspaceId,
          jobId: cleanupJob.id,
          kind: cleanupJob.kind,
        },
        availableAt: input.now,
      });
    }
    return {
      executionId: execution.id,
      status: passed ? "completed" : "verification_failed",
      ...(input.evidence ? { evidenceDigest: input.evidence.digest } : {}),
    };
  });
}

function codingCleanupJob(
  input: { readonly tenantId: string; readonly now: string },
  execution: Execution,
  run: StoredCodingRun,
): Job {
  const id = `job:coding-cleanup:${sha256({
    executionId: execution.id,
    generation: execution.generation,
    attempt: run.externalInvocation!.attempt,
  }).slice(0, 24)}`;
  return {
    id,
    tenantId: input.tenantId,
    workspaceId: execution.workspaceId,
    kind: "coding.sandbox.cleanup",
    payload: { reconciliationExecutionId: execution.id },
    status: "available",
    attempts: 0,
    availableAt: input.now,
    fencingToken: 0,
    idempotencyKey: `coding:cleanup:${execution.id}:${execution.generation}:${run.externalInvocation!.attempt}`,
    streamVersion: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function enqueueCodingCleanupJob(
  transaction: KernelTransaction,
  cleanupJob: Job,
  execution: Execution,
  actorId: string,
  occurredAt: string,
): void {
  transaction.putProjection("job", cleanupJob.id, cleanupJob);
  transaction.appendEvent({
    tenantId: cleanupJob.tenantId,
    aggregateType: "job",
    aggregateId: cleanupJob.id,
    expectedStreamVersion: 0,
    type: "job.available",
    actorId,
    executionId: execution.id,
    generation: execution.generation,
    correlationId: `coding:${execution.id}:${execution.generation}:cleanup`,
    publicPayload: {
      workspaceId: execution.workspaceId,
      jobId: cleanupJob.id,
      kind: cleanupJob.kind,
    },
  });
  transaction.putJob({
    id: cleanupJob.id,
    tenantId: cleanupJob.tenantId,
    workspaceId: cleanupJob.workspaceId,
    kind: cleanupJob.kind,
    payload: cleanupJob.payload,
    availableAt: cleanupJob.availableAt,
    idempotencyKey: cleanupJob.idempotencyKey,
  });
  transaction.putOutbox({
    id: `outbox:${cleanupJob.id}`,
    tenantId: cleanupJob.tenantId,
    topic: "job.available",
    payload: {
      workspaceId: execution.workspaceId,
      jobId: cleanupJob.id,
      kind: cleanupJob.kind,
    },
    availableAt: occurredAt,
  });
}

async function persistRunning(
  store: KernelStore,
  tenantId: string,
  state: CodingState,
  controlPlane: CodingControlPlaneCommitment,
  baseRevision: string,
  runnerId: "builtin" | ExternalCodingRunnerId,
  occurredAt: string,
): Promise<void> {
  await store.transact(tenantId, (transaction) => {
    const current = transaction.getProjection<StoredCodingRun>("coding.execution", state.execution.id);
    if (current?.generation === state.execution.generation) {
      if (current.controlPlane.repositoryIndexDigest !== controlPlane.repositoryIndexDigest
        || current.controlPlane.sandboxDigest !== controlPlane.sandboxDigest
        || current.baseRevision !== baseRevision
        || current.runnerId !== runnerId) {
        throw new Error("Coding 执行恢复时控制面或仓库快照已变化");
      }
      return;
    }
    const streamVersion = current?.streamVersion ?? 0;
    const next: StoredCodingRun = {
      executionId: state.execution.id,
      generation: state.execution.generation,
      taskId: state.task.id,
      repositoryId: state.repository.id,
      status: "running",
      controlPlane,
      baseRevision,
      runnerId,
      streamVersion: streamVersion + 1,
      createdAt: current?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
    };
    transaction.putProjection("coding.execution", state.execution.id, next);
    transaction.putProjection("coding.control-plane", state.execution.id, {
      executionId: state.execution.id,
      generation: state.execution.generation,
      ...controlPlane,
      baseRevision,
      createdAt: occurredAt,
    });
    transaction.appendEvent({
      tenantId,
      aggregateType: "coding.execution",
      aggregateId: state.execution.id,
      expectedStreamVersion: streamVersion,
      type: "coding.execution_started",
      actorId: state.execution.executionPrincipalId,
      executionId: state.execution.id,
      generation: state.execution.generation,
      correlationId: `coding:${state.execution.id}:${state.execution.generation}`,
      publicPayload: {
        workspaceId: state.execution.workspaceId,
        taskId: state.task.id,
        repositoryId: state.repository.id,
        runnerId,
        baseRevision,
        ...controlPlane,
      },
    });
  });
}

async function persistExternalInvocationStarted(input: {
  readonly store: KernelStore;
  readonly tenantId: string;
  readonly state: Pick<CodingState, "execution" | "task">;
  readonly runnerId: ExternalCodingRunnerId;
  readonly attempt: number;
  readonly identityDigest: string;
  readonly sandboxPath: string;
  readonly runnerArtifactPath: string;
  readonly supervision: RunnerSupervisionCheckpoint;
  readonly occurredAt: string;
}): Promise<void> {
  await input.store.transact(input.tenantId, (transaction) => {
    const current = transaction.getProjection<StoredCodingRun>(
      "coding.execution",
      input.state.execution.id,
    );
    if (!current || current.generation !== input.state.execution.generation || current.result) {
      throw new Error("外部 Runner 启动检查点不存在或已终结");
    }
    if (current.runnerId !== input.runnerId
      || (current.externalInvocation && current.externalInvocation.attempt >= input.attempt)) {
      throw new Error("外部 Runner 尝试序号或身份与检查点不一致");
    }
    const next: StoredCodingRun = {
      ...current,
      externalInvocation: {
        runnerId: input.runnerId,
        attempt: input.attempt,
        identityDigest: input.identityDigest,
        sandboxPath: input.sandboxPath,
        runnerArtifactPath: input.runnerArtifactPath,
        supervision: input.supervision,
        terminationStatus: "unconfirmed",
        status: "started",
        startedAt: input.occurredAt,
        updatedAt: input.occurredAt,
      },
      streamVersion: current.streamVersion + 1,
      updatedAt: input.occurredAt,
    };
    transaction.putProjection("coding.execution", input.state.execution.id, next);
    transaction.appendEvent({
      tenantId: input.tenantId,
      aggregateType: "coding.execution",
      aggregateId: input.state.execution.id,
      expectedStreamVersion: current.streamVersion,
      type: "coding.external_runner_started",
      actorId: input.state.execution.executionPrincipalId,
      executionId: input.state.execution.id,
      generation: input.state.execution.generation,
      correlationId: `coding:${input.state.execution.id}:${input.state.execution.generation}`,
      publicPayload: {
        workspaceId: input.state.execution.workspaceId,
        taskId: input.state.task.id,
        runnerId: input.runnerId,
        attempt: input.attempt,
        identityDigest: input.identityDigest,
      },
    });
  });
}

async function persistCodingResult(input: {
  readonly store: KernelStore;
  readonly tenantId: string;
  readonly job: StoredJob;
  readonly context: CodingWorkerJobContext;
  readonly state: CodingState;
  readonly controlPlane: CodingControlPlaneCommitment;
  readonly baseRevision: string;
  readonly result: CodingExecutionResult;
  readonly approvalIntent?: ToolCallIntent;
  readonly material: ReadonlyMap<string, CandidateMaterial>;
  readonly runnerTerminationConfirmed?: boolean;
  readonly now: string;
}): Promise<StoredCodingRun> {
  const committed = await input.store.transact(input.tenantId, (transaction) => {
    const liveExecution = transaction.getProjection<Execution>(
      "execution",
      input.state.execution.id,
    );
    if (!liveExecution || liveExecution.generation !== input.state.execution.generation) {
      throw new Error("Coding Execution 已变化，拒绝提交过期结果");
    }
    const result = liveExecution.status === "cancelled"
      ? cancelledCodingResult(input.result)
      : input.result;
    if (result.status === "cancelled") {
      if (liveExecution.status !== "cancelled") {
        throw new Error("只有已取消的 Execution 可持久化 Coding 取消结果");
      }
    } else if (result.status === "failed" && liveExecution.status === "failed") {
      // 拒绝审批会先由内核终结 Execution，Coding 投影仍必须原子收敛。
    } else if (liveExecution.status !== "running" && liveExecution.status !== "waiting_approval") {
      throw new Error(`Coding Execution 已进入 ${liveExecution.status}，拒绝提交后续结果`);
    }
    const current = transaction.getProjection<StoredCodingRun>(
      "coding.execution",
      input.state.execution.id,
    );
    if (!current || current.generation !== input.state.execution.generation) {
      throw new Error("Coding 执行开始检查点不存在");
    }
    if (current.result) {
      return {
        run: current,
        receipt: settleCodingJob(transaction, input.job, input.context, current.result, input.now),
      };
    }
    const cleanupJob = current.externalInvocation
      && result.status !== "needs_reconciliation"
      && input.runnerTerminationConfirmed
      ? codingCleanupJob(
          { tenantId: input.tenantId, now: input.now },
          liveExecution,
          current,
        )
      : undefined;
    let taskVersion = input.state.task.streamVersion;
    for (const candidate of result.candidates) {
      const material = input.material.get(candidate.id);
      if (!material) throw new Error(`候选 ${candidate.id} 缺少持久化 Diff`);
      const stored: StoredCandidate = {
        ...candidate,
        tenantId: input.tenantId,
        workspaceId: input.state.execution.workspaceId,
        executionId: input.state.execution.id,
        diff: material.diff,
        createdAt: input.now,
      };
      transaction.putProjection("coding.candidate", candidate.id, stored);
      transaction.appendEvent({
        tenantId: input.tenantId,
        aggregateType: "coding.task",
        aggregateId: input.state.task.id,
        expectedStreamVersion: taskVersion++,
        type: "coding.candidate_recorded",
        actorId: input.state.execution.executionPrincipalId,
        executionId: input.state.execution.id,
        generation: input.state.execution.generation,
        correlationId: `coding:${input.state.execution.id}:${input.state.execution.generation}`,
        publicPayload: {
          workspaceId: input.state.execution.workspaceId,
          candidateId: candidate.id,
          sequence: candidate.sequence,
          runnerId: candidate.runnerId,
          baseRevision: candidate.baseRevision,
          diffDigest: candidate.diffDigest,
          sandboxDigest: candidate.sandbox.evidenceDigest!,
        },
      });
    }
    for (const gate of result.gates) {
      transaction.putProjection("coding.gate-result", gate.candidateId, {
        ...gate,
        tenantId: input.tenantId,
        workspaceId: input.state.execution.workspaceId,
        executionId: input.state.execution.id,
        createdAt: input.now,
      });
      transaction.appendEvent({
        tenantId: input.tenantId,
        aggregateType: "coding.task",
        aggregateId: input.state.task.id,
        expectedStreamVersion: taskVersion++,
        type: "coding.gate_result_recorded",
        actorId: input.state.execution.executionPrincipalId,
        executionId: input.state.execution.id,
        generation: input.state.execution.generation,
        correlationId: `coding:${input.state.execution.id}:${input.state.execution.generation}`,
        publicPayload: {
          workspaceId: input.state.execution.workspaceId,
          candidateId: gate.candidateId,
          status: gate.status,
          authoritative: gate.authoritative,
          ...(gate.evidenceDigest ? { evidenceDigest: gate.evidenceDigest } : {}),
        },
      });
    }
    if (result.evidence) {
      transaction.putProjection("coding.code-evidence", result.evidence.digest, {
        ...result.evidence,
        tenantId: input.tenantId,
        workspaceId: input.state.execution.workspaceId,
        executionId: input.state.execution.id,
        createdAt: input.now,
      });
      transaction.appendEvent({
        tenantId: input.tenantId,
        aggregateType: "coding.task",
        aggregateId: input.state.task.id,
        expectedStreamVersion: taskVersion++,
        type: "coding.code_evidence_recorded",
        actorId: input.state.execution.executionPrincipalId,
        executionId: input.state.execution.id,
        generation: input.state.execution.generation,
        correlationId: `coding:${input.state.execution.id}:${input.state.execution.generation}`,
        publicPayload: {
          workspaceId: input.state.execution.workspaceId,
          candidateId: result.evidence.candidateId,
          evidenceDigest: result.evidence.digest,
        },
      });
    }
    transaction.appendEvent({
      tenantId: input.tenantId,
      aggregateType: "coding.task",
      aggregateId: input.state.task.id,
      expectedStreamVersion: taskVersion++,
      type: `coding.execution_${result.status}`,
      actorId: input.state.execution.executionPrincipalId,
      executionId: input.state.execution.id,
      generation: input.state.execution.generation,
      correlationId: `coding:${input.state.execution.id}:${input.state.execution.generation}`,
      publicPayload: {
        workspaceId: input.state.execution.workspaceId,
        status: result.status,
        candidateCount: result.candidates.length,
        gateCount: result.gates.length,
      },
    });
    transaction.putProjection("coding.task", input.state.task.id, {
      ...input.state.task,
      stage: result.status === "waiting_approval" ? "approve" : "verify",
      status: result.status,
      streamVersion: taskVersion,
      updatedAt: input.now,
    });
    if (result.status === "needs_human_decision") {
      const inbox: InboxItem = {
        id: `coding-review:${input.state.execution.id}`,
        tenantId: input.tenantId,
        workspaceId: input.state.execution.workspaceId,
        executionId: input.state.execution.id,
        kind: "failure",
        title: "Coding Gate 已达到修复上限",
        summary: result.nextStep,
        risk: "gate_failed",
        resourceSummary: input.state.repository.name,
        createdAt: input.now,
        status: "open",
      };
      transaction.putProjection("inbox", inbox.id, inbox);
    }
    const next: StoredCodingRun = {
      ...current,
      status: result.status,
      result,
      ...(current.externalInvocation ? {
        externalInvocation: {
          ...current.externalInvocation,
          status: result.status === "needs_reconciliation"
            ? "outcome_unknown" as const
            : "settled" as const,
          terminationStatus: input.runnerTerminationConfirmed ? "confirmed" : "unconfirmed",
          ...(cleanupJob ? {
            cleanupStatus: "pending" as const,
            cleanupJobId: cleanupJob.id,
          } : {}),
          updatedAt: input.now,
        },
      } : {}),
      ...(input.approvalIntent ? { approvalIntent: input.approvalIntent } : {}),
      streamVersion: current.streamVersion + 1,
      updatedAt: input.now,
    };
    transaction.putProjection("coding.execution", input.state.execution.id, next);
    transaction.appendEvent({
      tenantId: input.tenantId,
      aggregateType: "coding.execution",
      aggregateId: input.state.execution.id,
      expectedStreamVersion: current.streamVersion,
      type: "coding.execution_result_persisted",
      actorId: input.state.execution.executionPrincipalId,
      executionId: input.state.execution.id,
      generation: input.state.execution.generation,
      correlationId: `coding:${input.state.execution.id}:${input.state.execution.generation}`,
      publicPayload: {
        workspaceId: input.state.execution.workspaceId,
        taskId: input.state.task.id,
        status: result.status,
      },
    });
    if (cleanupJob) {
      enqueueCodingCleanupJob(
        transaction,
        cleanupJob,
        liveExecution,
        input.state.execution.executionPrincipalId,
        input.now,
      );
    }
    return {
      run: next,
      receipt: settleCodingJob(transaction, input.job, input.context, result, input.now),
    };
  });
  if (committed.receipt) input.context.acknowledgeJobSettlement?.(committed.receipt);
  return committed.run;
}

function settleCodingJob(
  transaction: KernelTransaction,
  job: StoredJob,
  context: CodingWorkerJobContext,
  result: CodingExecutionResult,
  occurredAt: string,
): KernelJobSettlementReceipt | undefined {
  if (!context.acknowledgeJobSettlement
    || result.status === "waiting_approval"
    || result.status === "needs_reconciliation") {
    return undefined;
  }
  if (!transaction.settleJob) {
    throw new Error("存储未实现事务内 Job 终结，Coding Worker 已拒绝提交终态");
  }
  const completed = result.status === "completed" || result.status === "needs_human_decision";
  return transaction.settleJob({
    jobId: job.id,
    workerId: context.workerId,
    fencingToken: context.fencingToken,
    outcome: completed ? "completed" : "failed",
    value: completed
      ? { executionId: payloadString(job.payload, "executionId"), status: result.status }
      : result.status === "cancelled"
        ? {
            code: "EXECUTION_CANCELLED",
            message: "Agent turn 已由用户取消",
            retryable: false,
          }
        : {
            code: "JOB_EXECUTION_FAILED",
            message: result.nextStep,
            retryable: true,
          },
    occurredAt,
  });
}

async function persistCodingDecision(
  store: KernelStore,
  tenantId: string,
  job: StoredJob,
  context: CodingWorkerJobContext,
  state: CodingState,
  result: CodingExecutionResult,
  occurredAt: string,
): Promise<CodingExecutionResult> {
  const committed = await store.transact(tenantId, (transaction) => {
    const liveExecution = transaction.getProjection<Execution>("execution", state.execution.id);
    if (!liveExecution || liveExecution.generation !== state.execution.generation) {
      throw new Error("Coding Execution 已变化，拒绝提交过期审批结果");
    }
    const effectiveResult = liveExecution.status === "cancelled"
      ? cancelledCodingResult(result)
      : result;
    if (effectiveResult.status === "completed" && liveExecution.status !== "running") {
      throw new Error(`Coding Execution 已进入 ${liveExecution.status}，拒绝批准候选`);
    }
    if (effectiveResult.status === "cancelled"
      && liveExecution.status !== "cancelled"
      && liveExecution.status !== "failed") {
      throw new Error(`Coding Execution 已进入 ${liveExecution.status}，拒绝取消候选`);
    }
    const current = transaction.getProjection<StoredCodingRun>("coding.execution", state.execution.id);
    if (!current?.result) throw new Error("Coding 审批检查点不存在");
    if (current.result.status === "completed" || current.result.status === "cancelled") {
      return {
        result: current.result,
        receipt: settleCodingJob(transaction, job, context, current.result, occurredAt),
      };
    }
    if (current.result.status !== "waiting_approval") throw new Error("Coding 执行没有等待审批");
    const task = transaction.getProjection<CodingTask>("coding.task", state.task.id);
    if (!task) throw new Error("CodingTask 不存在");
    let taskVersion = task.streamVersion;
    if (effectiveResult.status === "completed" && effectiveResult.deliverable) {
      const deliverableId = `coding-deliverable:${state.execution.id}`;
      const deliverable: Deliverable = {
        id: deliverableId,
        tenantId,
        workspaceId: state.execution.workspaceId,
        pluginId: "coding",
        threadId: state.thread.id,
        executionId: state.execution.id,
        kind: effectiveResult.deliverable.kind,
        title: effectiveResult.deliverable.title,
        summary: effectiveResult.deliverable.summary,
        assetIds: [],
        nextAction: effectiveResult.deliverable.nextStep,
        streamVersion: 1,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      };
      transaction.putProjection("deliverable", deliverable.id, deliverable);
      transaction.appendEvent({
        tenantId,
        aggregateType: "deliverable",
        aggregateId: deliverable.id,
        expectedStreamVersion: 0,
        type: "deliverable.created",
        actorId: state.execution.executionPrincipalId,
        executionId: state.execution.id,
        generation: state.execution.generation,
        correlationId: `coding:${state.execution.id}:${state.execution.generation}`,
        publicPayload: {
          workspaceId: state.execution.workspaceId,
          pluginId: "coding",
          taskId: state.task.id,
          kind: deliverable.kind,
          diffDigest: effectiveResult.deliverable.diffDigest,
        },
      });
    }
    transaction.appendEvent({
      tenantId,
      aggregateType: "coding.task",
      aggregateId: state.task.id,
      expectedStreamVersion: taskVersion++,
      type: effectiveResult.status === "completed" ? "coding.candidate_approved" : "coding.candidate_denied",
      actorId: state.execution.executionPrincipalId,
      executionId: state.execution.id,
      generation: state.execution.generation,
      correlationId: `coding:${state.execution.id}:${state.execution.generation}`,
      publicPayload: {
        workspaceId: state.execution.workspaceId,
        status: effectiveResult.status,
        candidateId: effectiveResult.evidence!.candidateId,
      },
    });
    transaction.putProjection("coding.task", task.id, {
      ...task,
      stage: effectiveResult.status === "completed" ? "learn" : "approve",
      status: effectiveResult.status,
      streamVersion: taskVersion,
      updatedAt: occurredAt,
    });
    const next: StoredCodingRun = {
      ...current,
      status: effectiveResult.status,
      result: effectiveResult,
      streamVersion: current.streamVersion + 1,
      updatedAt: occurredAt,
    };
    transaction.putProjection("coding.execution", state.execution.id, next);
    transaction.appendEvent({
      tenantId,
      aggregateType: "coding.execution",
      aggregateId: state.execution.id,
      expectedStreamVersion: current.streamVersion,
      type: effectiveResult.status === "completed"
        ? "coding.execution_approved"
        : "coding.execution_denied",
      actorId: state.execution.executionPrincipalId,
      executionId: state.execution.id,
      generation: state.execution.generation,
      correlationId: `coding:${state.execution.id}:${state.execution.generation}`,
      publicPayload: { workspaceId: state.execution.workspaceId, status: effectiveResult.status },
    });
    return {
      result: effectiveResult,
      receipt: settleCodingJob(transaction, job, context, effectiveResult, occurredAt),
    };
  });
  if (committed.receipt) context.acknowledgeJobSettlement?.(committed.receipt);
  return committed.result;
}

function acceptanceIntent(
  execution: Execution,
  authority: ExecutionAuthority,
  repository: Repository,
  result: CodingExecutionResult,
  now: string,
): ToolCallIntent {
  const candidate = result.candidates.at(-1);
  if (!candidate || !result.evidence) throw new Error("等待审批的 Coding 结果缺少候选或 Evidence");
  return createIntent({
    execution,
    authority,
    toolId: "coding.candidate.accept",
    effectClass: "privileged",
    intent: `批准 Coding 任务“${result.task.title}”的候选成果`,
    normalizedArguments: {
      candidateId: candidate.id,
      diffDigest: candidate.diffDigest,
      evidenceDigest: result.evidence.digest,
    },
    resourceRefs: [{
      namespace: "repository",
      resourceId: repository.id,
      digest: result.controlPlane.repositoryIndexDigest,
    }],
    now,
  });
}

function createIntent(input: {
  readonly execution: Execution;
  readonly authority: ExecutionAuthority;
  readonly toolId: string;
  readonly effectClass: ToolCallIntent["effectClass"];
  readonly intent: string;
  readonly normalizedArguments: JsonObject;
  readonly resourceRefs: ToolCallIntent["resourceRefs"];
  readonly now: string;
}): ToolCallIntent {
  const argumentsDigest = sha256(input.normalizedArguments);
  const resourcesDigest = sha256(input.resourceRefs);
  return {
    id: `coding-tool:${sha256({
      executionId: input.execution.id,
      generation: input.execution.generation,
      toolId: input.toolId,
      argumentsDigest,
      resourcesDigest,
    })}`,
    executionId: input.execution.id,
    generation: input.execution.generation,
    toolId: input.toolId,
    toolVersion: "0.2.0",
    effectClass: input.effectClass,
    intent: input.intent,
    normalizedArguments: input.normalizedArguments,
    argumentsDigest,
    resourceRefs: input.resourceRefs,
    resourcesDigest,
    authorityCommitment: input.authority.commitment,
    expiresAt: new Date(Date.parse(input.now) + TOOL_INTENT_TTL_MS).toISOString(),
  };
}

async function authorizeTool(
  runtime: RuntimeStore,
  approval: ToolApprovalPort,
  intent: ToolCallIntent,
  signal: AbortSignal,
): Promise<void> {
  await runtime.append({
    executionId: intent.executionId,
    type: "tool/intent",
    payload: intent as unknown as JsonObject,
  });
  const authorization = await approval.authorize(intent, signal);
  if (authorization.mode === "deny") throw new Error(authorization.reason ?? "工具调用已拒绝");
}

async function recordToolResult(
  runtime: RuntimeStore,
  intent: ToolCallIntent,
  result: JsonObject,
): Promise<void> {
  await runtime.append({
    executionId: intent.executionId,
    type: "tool/result",
    payload: { toolCallId: intent.id, status: "completed", result },
  });
}

function providerId(value: string): ByokProviderId {
  if (value === "openai" || value === "deepseek" || value === "anthropic") return value;
  throw new Error("模型厂商预设不受支持");
}

function payloadString(payload: JsonObject, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Job payload 缺少 ${field}`);
  return value;
}

function requiredArgument(input: JsonObject, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`工具参数 ${field} 必须是非空字符串`);
  return value;
}

function assertRelativeRepositoryPath(path: string): void {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`仓库包含不安全路径：${path}`);
  }
}

function parseGitTree(serialized: string): ReadonlyMap<string, {
  readonly mode: string;
  readonly oid: string;
}> {
  const entries = new Map<string, { readonly mode: string; readonly oid: string }>();
  for (const record of serialized.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    const metadata = separator < 0 ? "" : record.slice(0, separator);
    const path = separator < 0 ? "" : record.slice(separator + 1);
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})$/u.exec(metadata);
    assertRelativeRepositoryPath(path);
    if (!match?.[1] || !match[2] || entries.has(path)) {
      throw new Error(`固定 HEAD 包含不支持的对象：${path || "<unknown>"}`);
    }
    entries.set(path, { mode: match[1], oid: match[2] });
  }
  return entries;
}

function parseGitIndex(serialized: string): ReadonlyMap<string, {
  readonly mode: string;
  readonly oid: string;
  readonly stage: number;
}> {
  const entries = new Map<string, { readonly mode: string; readonly oid: string; readonly stage: number }>();
  for (const record of serialized.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    const metadata = separator < 0 ? "" : record.slice(0, separator);
    const path = separator < 0 ? "" : record.slice(separator + 1);
    const match = /^(100644|100755|120000|160000) ([0-9a-f]{40,64}) ([0-3])$/u.exec(metadata);
    assertRelativeRepositoryPath(path);
    if (!match?.[1] || !match[2] || match[3] === undefined || entries.has(path)) {
      throw new Error(`Git 索引包含不支持的条目：${path || "<unknown>"}`);
    }
    entries.set(path, { mode: match[1], oid: match[2], stage: Number(match[3]) });
  }
  return entries;
}

function gitBlobOid(content: Uint8Array, objectIdLength: number): string {
  const algorithm = objectIdLength === 40 ? "sha1" : objectIdLength === 64 ? "sha256" : undefined;
  if (!algorithm) throw new Error("Git 对象摘要格式不受支持");
  return createHash(algorithm)
    .update(`blob ${content.byteLength}\0`, "utf8")
    .update(content)
    .digest("hex");
}

function assertWithin(root: string, target: string, label: string): void {
  const path = relative(root, target);
  if (!path || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error(`${label} 超出受控目录`);
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 48) || "coding";
}

function schemeString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameFileInfo(
  left: { readonly dev: number | bigint; readonly ino: number | bigint; readonly size: number | bigint; readonly mtimeMs: number },
  right: { readonly dev: number | bigint; readonly ino: number | bigint; readonly size: number | bigint; readonly mtimeMs: number },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function assertNativeMacExecutable(bytes: Buffer): void {
  if (bytes.length < 4) throw new Error("Runner 二进制过短");
  const magic = bytes.readUInt32BE(0);
  if (!new Set([
    0xfeedface,
    0xcefaedfe,
    0xfeedfacf,
    0xcffaedfe,
    0xcafebabe,
    0xbebafeca,
    0xcafebabf,
    0xbfbafeca,
  ]).has(magic)) {
    throw new Error(
      "Runner 必须是原生 macOS Mach-O 制品；不支持 npm/shebang 包装器，请安装官方原生 CLI",
    );
  }
}

async function inspectStagedRunnerIdentity(
  confirmed: RunnerBinaryIdentityV1,
): Promise<RunnerBinaryIdentityV1> {
  const handle = await open(
    confirmed.realPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!before.isFile()
      || !sameFileInfo(before, after)
      || confirmed.requestedPath !== confirmed.realPath
      || String(after.dev) !== confirmed.device
      || String(after.ino) !== confirmed.inode
      || after.size !== confirmed.byteLength
      || after.mtimeMs !== confirmed.modifiedAtMs
      || hashBytes(bytes) !== confirmed.sha256) {
      throw new Error("Runner 不可变副本已变化");
    }
    return confirmed;
  } finally {
    await handle.close();
  }
}

function git(
  cwd: string,
  arguments_: readonly string[],
  signal: AbortSignal,
): Promise<CommandResult> {
  return command(GIT, [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", "diff.external=",
    ...arguments_,
  ], cwd, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
  }, { signal, timeoutMs: CONTROLLED_GIT_TIMEOUT_MS }).then(async (result) => {
    await requireSuccess(result, `Git ${arguments_[0] ?? "命令"} 失败`);
    return result;
  });
}

function command(
  executable: string,
  arguments_: readonly string[],
  cwd?: string,
  environment: Readonly<Record<string, string>> = {},
  options?: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxBufferBytes?: number;
  },
): Promise<CommandResult> {
  const signal = options?.signal ?? new AbortController().signal;
  return runControlledCommand({
    executable,
    arguments: arguments_,
    ...(cwd ? { cwd } : {}),
    environment: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...environment,
    },
    signal,
    timeoutMs: options?.timeoutMs ?? CONTROLLED_GIT_TIMEOUT_MS,
    ...(options?.maxBufferBytes ? { maxBufferBytes: options.maxBufferBytes } : {}),
  });
}

function launchManagedProcess(
  spec: ExternalRunnerSpawnSpec,
  supervision: RunnerSupervisionLease,
): ManagedExternalRunnerProcess {
  const supervisorModule = fileURLToPath(new URL("./runner-supervisor.js", import.meta.url));
  const runnerEnvironment = Object.fromEntries(Object.entries(spec.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const supervisorConfig = Buffer.from(JSON.stringify({
    protocol: supervision.protocol,
    statePath: supervision.statePath,
    token: supervision.token,
    executable: spec.executable,
    cwd: spec.cwd,
    args: spec.args,
    env: runnerEnvironment,
  }), "utf8").toString("base64url");
  const child = spawn(process.execPath, [supervisorModule], {
    cwd: spec.cwd,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      MN_RUNNER_SUPERVISOR_CONFIG: supervisorConfig,
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    detached: false,
    windowsHide: true,
  });
  const control = child.stdio[3];
  let terminationRequested = false;
  const killChild = (signal: "SIGTERM" | "SIGKILL") => {
    if (signal === "SIGTERM" && control && "end" in control) {
      if (!terminationRequested) {
        terminationRequested = true;
        control.end();
      }
      return;
    }
    child.kill(signal);
  };
  let inputSettled = false;
  let resolveInput: (accepted: boolean) => void = () => {};
  const inputAccepted = new Promise<boolean>((resolveInputAccepted) => {
    resolveInput = resolveInputAccepted;
  });
  const settleInput = (accepted: boolean) => {
    if (inputSettled) return;
    inputSettled = true;
    resolveInput(accepted);
  };
  child.stdin.once("finish", () => settleInput(true));
  child.stdin.once("error", () => {
    settleInput(false);
    killChild("SIGTERM");
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolveProcess) => {
    let settled = false;
    child.once("error", () => {
      settleInput(false);
      if (settled) return;
      settled = true;
      resolveProcess({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      settleInput(false);
      if (settled) return;
      settled = true;
      resolveProcess({ code, signal });
    });
  });
  const completed = Promise.all([exited, inputAccepted]).then(([result, accepted]) => accepted
    ? result
    : { code: null, signal: result.signal });
  child.stderr.resume();
  child.stdin.end(spec.stdin, "utf8");
  return {
    stdout: child.stdout,
    completed,
    kill: killChild,
  };
}

async function requireSuccess(result: CommandResult, message: string): Promise<void> {
  if (result.exitCode === 0) return;
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(detail ? `${message}：${detail}` : message);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Job 已失去租约或被取消"));
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(new Error("Job 已失去租约或被取消"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
