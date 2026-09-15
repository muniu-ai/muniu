// SPDX-License-Identifier: Apache-2.0
import { appendKernelEvent } from "@mn/kernel";

import { basename, isAbsolute, normalize } from "node:path";

import type {
  CodingReconciliationViewV2,
  CodingRunnerConfigurationV1,
  Execution,
  ExecutionAuthority,
  ExternalCodingRunnerId,
  Job,
  Thread,
  Workspace,
  WorkspaceMembership,
} from "@mn/contracts";
import { CODING_RUNNER_CONFIGURATION_NAMESPACE } from "@mn/contracts";
import {
  computeExecutionAuthorityCommitment,
  KernelError,
  sha256,
  StreamVersionConflictError,
  type InboxItem,
  type KernelStore,
  type KernelTransaction,
} from "@mn/kernel";
import type {
  CodingControlPlaneCommitment,
  CodingExecutionResult,
  CodingTask,
} from "@mn/plugin-coding";
import { runnerToolId } from "./coding-runners.js";

export type CodingReconciliationDecision =
  | "terminate"
  | "mark_completed"
  | "create_new_call";

export const CODING_RECONCILIATION_WORKER_JOB_KINDS = Object.freeze([
  "coding.reconciliation.verify",
  "coding.sandbox.cleanup",
] as const);

export interface CodingReconciliationVerificationReadiness {
  readonly ready: boolean;
  readonly missingKinds: readonly string[];
  readonly summary: string;
}

export interface CodingNewCallReadiness {
  readonly allowed: boolean;
  readonly summary: string;
}

export type CodingNewCallReadinessResolver = (input: {
  readonly workspaceId: string;
  readonly runnerId: ExternalCodingRunnerId;
}) => Promise<CodingNewCallReadiness>;

export function codingReconciliationVerificationReadiness(
  trustedWorkerSupportedKinds: readonly string[] | undefined,
): CodingReconciliationVerificationReadiness {
  const supported = new Set(trustedWorkerSupportedKinds ?? []);
  const missingKinds = CODING_RECONCILIATION_WORKER_JOB_KINDS
    .filter((kind) => !supported.has(kind));
  return {
    ready: missingKinds.length === 0,
    missingKinds,
    summary: missingKinds.length === 0
      ? "Worker 已声明保留候选验证与清理能力"
      : "Worker 未同时声明受信的保留候选验证与清理能力，不能标记完成",
  };
}

export interface CodingReconciliationDecisionInput {
  readonly tenantId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly expectedStreamVersion: number;
  readonly expectedCodingStreamVersion: number;
  readonly decision: CodingReconciliationDecision;
  readonly verificationReadiness: CodingReconciliationVerificationReadiness;
  readonly newCallRuntimeReadiness?: CodingNewCallReadiness;
  readonly idempotencyScope?: string;
  readonly idempotencyRequest?: unknown;
  readonly now: () => string;
  readonly id: (kind: string) => string;
}

export interface CodingReconciliationDecisionResult {
  readonly decision: CodingReconciliationDecision;
  readonly status: "settled" | "verification_pending";
  readonly execution: Execution;
  readonly codingExecution: CodingReconciliationExecutionView;
  readonly task: CodingTask;
  readonly cleanupJobId?: string;
  readonly verificationJobId?: string;
  readonly newExecution?: Execution;
}

export interface CodingReconciliationExecutionView {
  readonly executionId: string;
  readonly status: CodingExecutionResult["status"];
  readonly streamVersion: number;
  readonly result: CodingExecutionResult;
}

export type CodingReconciliationView = CodingReconciliationViewV2;

interface ExternalInvocationCheckpoint {
  readonly runnerId: ExternalCodingRunnerId;
  readonly attempt: number;
  readonly identityDigest: string;
  readonly sandboxPath: string;
  readonly runnerArtifactPath: string;
  readonly status: "started" | "settled" | "outcome_unknown";
  readonly cleanupStatus?: "pending" | "cleaned";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly reconciliationDecision?: CodingReconciliationDecision;
  readonly cleanupJobId?: string;
  readonly supervision: {
    readonly protocol: "mn-runner-supervisor-v1";
    readonly statePath: string;
    readonly tokenDigest: string;
  };
  readonly terminationStatus: "unconfirmed" | "confirmed";
  readonly verification?: {
    readonly status: "pending" | "failed" | "passed";
    readonly jobId: string;
    readonly requestedBy: string;
    readonly requestedAt: string;
    readonly updatedAt: string;
    readonly failureReason?: string;
  };
}

interface StoredCodingRun {
  readonly turn?: number;
  readonly executionId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly status: "running" | CodingExecutionResult["status"];
  readonly controlPlane: CodingControlPlaneCommitment;
  readonly baseRevision: string;
  readonly runnerId: "builtin" | ExternalCodingRunnerId;
  readonly externalInvocation?: ExternalInvocationCheckpoint;
  readonly result?: CodingExecutionResult;
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoredModelConnection {
  readonly id: string;
  readonly tenantId: string;
  readonly status: "pending" | "ready" | "invalid";
  readonly defaultModel: string;
}

const REVIEW_ROLES = new Set(["owner", "operator", "reviewer"]);

export async function getCodingReconciliation(
  store: KernelStore,
  tenantId: string,
  actorId: string,
  executionId: string,
  verificationReadiness: CodingReconciliationVerificationReadiness,
  resolveNewCallRuntimeReadiness?: CodingNewCallReadinessResolver,
): Promise<CodingReconciliationView> {
  const view = await store.transact<CodingReconciliationView>(tenantId, (transaction) => {
    const execution = transaction.getProjection<Execution>("execution", executionId);
    if (!execution || execution.pluginId !== "coding") {
      throw new KernelError("EXECUTION_NOT_FOUND", "Coding 执行不存在", "刷新收件箱");
    }
    assertReviewer(transaction, execution.workspaceId, actorId);
    const run = transaction.getProjection<StoredCodingRun>("coding.execution", executionId);
    const task = run
      ? transaction.getProjection<CodingTask>("coding.task", run.taskId)
      : undefined;
    if (execution.status !== "needs_reconciliation"
      || (execution.runnerId !== "claude-cli" && execution.runnerId !== "codex-cli")
      || !run || run.executionId !== execution.id || run.generation !== execution.generation
      || run.runnerId !== execution.runnerId
      || run.externalInvocation?.runnerId !== execution.runnerId
      || run.externalInvocation.status !== "outcome_unknown"
      || run.status !== "needs_reconciliation"
      || run.result?.status !== "needs_reconciliation"
      || !task || task.workspaceId !== execution.workspaceId
      || task.repositoryId !== run.repositoryId || task.status !== "needs_reconciliation") {
      throw new KernelError(
        "CODING_RECONCILIATION_STATE_INVALID",
        "Coding 执行没有待核对的外部调用",
        "刷新收件箱",
      );
    }
    assertCleanupPaths(run.externalInvocation);
    const runnerStopped = run.externalInvocation.terminationStatus === "confirmed";
    const verification = run.externalInvocation.verification;
    const markCompletedAllowed = runnerStopped
      && verification === undefined
      && verificationReadiness.ready;
    const newCall = newCallReadiness(transaction, execution, run, task);
    const availableDecisions = reconciliationDecisions({
      runnerStopped,
      verificationPending: verification?.status === "pending",
      markCompletedAllowed,
      newCallAllowed: newCall.allowed,
    });
    return {
      executionId,
      workspaceId: execution.workspaceId,
      taskTitle: task.title,
      nextStep: run.result.nextStep,
      runnerId: execution.runnerId,
      status: "needs_reconciliation",
      expectedStreamVersion: execution.streamVersion,
      expectedCodingStreamVersion: run.streamVersion,
      evidence: {
        candidateCount: run.result.candidates.length,
        gateCount: run.result.gates.length,
        markCompletedAllowed,
        ...(run.result.evidence ? { codeEvidenceDigest: run.result.evidence.digest } : {}),
        summary: !runnerStopped
          ? "无法证明旧 Runner 已停止；为避免重复外联，暂不允许验证、清理或创建新调用"
          : verification?.status === "pending"
          ? "正在对保留的候选运行权威 Gate；不会重放外部 Runner"
          : verification?.status === "failed"
            ? verification.failureReason ?? "保留候选未通过权威 Gate"
            : verificationReadiness.ready
              ? "选择标记完成后，将先对保留候选运行权威 Gate；不会重放外部 Runner"
              : verificationReadiness.summary,
      },
      newCall,
      availableDecisions,
    };
  });
  if (!resolveNewCallRuntimeReadiness || !view.newCall.allowed) return view;
  const runtimeReadiness = await resolveNewCallRuntimeReadiness({
    workspaceId: view.workspaceId,
    runnerId: view.runnerId,
  });
  if (runtimeReadiness.allowed) return view;
  return {
    ...view,
    newCall: runtimeReadiness,
    availableDecisions: view.availableDecisions.filter((decision) =>
      decision !== "create_new_call"),
  };
}

export async function decideCodingReconciliation(
  store: KernelStore,
  input: CodingReconciliationDecisionInput,
): Promise<CodingReconciliationDecisionResult> {
  if (!Number.isSafeInteger(input.expectedStreamVersion) || input.expectedStreamVersion < 1
    || !Number.isSafeInteger(input.expectedCodingStreamVersion)
    || input.expectedCodingStreamVersion < 1) {
    throw new KernelError(
      "EXPECTED_STREAM_VERSION_REQUIRED",
      "人工核对需要有效的 core 与 Coding stream version",
      "刷新执行状态后重试",
    );
  }
  return store.transact(input.tenantId, (transaction) => {
    const request = {
      executionId: input.executionId,
      expectedStreamVersion: input.expectedStreamVersion,
      expectedCodingStreamVersion: input.expectedCodingStreamVersion,
      decision: input.decision,
    };
    const requestDigest = sha256(input.idempotencyRequest ?? request);
    const idempotencyScope = input.idempotencyScope
      ?? `coding.reconciliation:${input.executionId}`;
    const previous = transaction.getIdempotency(idempotencyScope, input.idempotencyKey);
    if (previous) {
      if (previous.requestDigest !== requestDigest) {
        throw new KernelError(
          "IDEMPOTENCY_KEY_REUSED",
          "幂等键已用于不同请求",
          "使用新的 Idempotency-Key",
        );
      }
      return previous.response as CodingReconciliationDecisionResult;
    }

    const execution = transaction.getProjection<Execution>("execution", input.executionId);
    if (!execution || execution.pluginId !== "coding") {
      throw new KernelError("EXECUTION_NOT_FOUND", "Coding 执行不存在", "刷新收件箱");
    }
    assertReviewer(transaction, execution.workspaceId, input.actorId);
    if (execution.streamVersion !== input.expectedStreamVersion) {
      throw new StreamVersionConflictError(input.expectedStreamVersion, execution.streamVersion);
    }
    if (execution.status !== "needs_reconciliation") {
      throw new KernelError(
        "INVALID_EXECUTION_TRANSITION",
        `执行处于 ${execution.status}，不能进行人工核对`,
        "刷新执行状态",
      );
    }

    const run = transaction.getProjection<StoredCodingRun>("coding.execution", input.executionId);
    if (!run || run.executionId !== execution.id || run.generation !== execution.generation) {
      throw new KernelError(
        "CODING_RECONCILIATION_STATE_INVALID",
        "Coding 执行检查点不存在或代次不一致",
        "停止操作并检查事件与投影",
      );
    }
    if (run.streamVersion !== input.expectedCodingStreamVersion) {
      throw new StreamVersionConflictError(input.expectedCodingStreamVersion, run.streamVersion);
    }
    if ((execution.runnerId !== "claude-cli" && execution.runnerId !== "codex-cli")
      || run.runnerId !== execution.runnerId
      || run.externalInvocation?.runnerId !== execution.runnerId
      || run.status !== "needs_reconciliation"
      || run.result?.status !== "needs_reconciliation"
      || run.externalInvocation?.status !== "outcome_unknown") {
      throw new KernelError(
        "CODING_RECONCILIATION_STATE_INVALID",
        "Coding 执行没有待核对的外部调用",
        "刷新 Coding 执行状态",
      );
    }
    const task = transaction.getProjection<CodingTask>("coding.task", run.taskId);
    if (!task || task.workspaceId !== execution.workspaceId
      || task.repositoryId !== run.repositoryId || task.status !== "needs_reconciliation") {
      throw new KernelError(
        "CODING_RECONCILIATION_STATE_INVALID",
        "Coding 任务与待核对执行不一致",
        "停止操作并检查事件与投影",
      );
    }
    assertCleanupPaths(run.externalInvocation);
    const staticNewCall = newCallReadiness(transaction, execution, run, task);
    const runtimeNewCall = input.newCallRuntimeReadiness ?? {
      allowed: false,
      summary: "尚未校验 Runner 插件运行态，暂时不能创建新调用",
    };
    const effectiveNewCall = staticNewCall.allowed ? runtimeNewCall : staticNewCall;
    const runnerStopped = run.externalInvocation.terminationStatus === "confirmed";
    const verificationPending = run.externalInvocation.verification?.status === "pending";
    const availableDecisions = reconciliationDecisions({
      runnerStopped,
      verificationPending,
      markCompletedAllowed: runnerStopped
        && run.externalInvocation.verification === undefined
        && input.verificationReadiness.ready,
      newCallAllowed: effectiveNewCall.allowed,
    });
    assertReconciliationDecisionAvailable(
      input.decision,
      availableDecisions,
      run.externalInvocation,
      input.verificationReadiness,
      effectiveNewCall,
    );
    if (input.decision === "mark_completed") {
      return requestReconciliationVerification(
        transaction,
        input,
        execution,
        run,
        task,
        idempotencyScope,
        requestDigest,
      );
    }

    const occurredAt = input.now();
    if (verificationPending) {
      invalidateVerificationJob(transaction, input, execution, run, occurredAt);
    }
    const cleanupJob = createCleanupJob(input, execution, run, occurredAt);
    const nextExecution = settleExecution(execution, input.decision, occurredAt);
    const nextTask = settleTask(task, input.decision, occurredAt);
    const nextRun = settleCodingRun(run, nextTask, input.decision, cleanupJob.id, occurredAt);

    transaction.putProjection("execution", execution.id, nextExecution);
    appendKernelEvent(transaction, {
      tenantId: input.tenantId,
      aggregateType: "execution",
      aggregateId: execution.id,
      expectedStreamVersion: execution.streamVersion,
      type: `execution.${nextExecution.status}`,
      actorId: input.actorId,
      executionId: execution.id,
      generation: execution.generation,
      correlationId: `coding-reconciliation:${execution.id}`,
      publicPayload: {
        workspaceId: execution.workspaceId,
        previousStatus: execution.status,
        status: nextExecution.status,
        reconciliationDecision: input.decision,
      },
    });

    transaction.putProjection("coding.task", task.id, nextTask);
    appendKernelEvent(transaction, {
      tenantId: input.tenantId,
      aggregateType: "coding.task",
      aggregateId: task.id,
      expectedStreamVersion: task.streamVersion,
      type: "coding.reconciliation_decided",
      actorId: input.actorId,
      executionId: execution.id,
      generation: execution.generation,
      correlationId: `coding-reconciliation:${execution.id}`,
      publicPayload: {
        workspaceId: execution.workspaceId,
        decision: input.decision,
        status: nextTask.status,
      },
    });

    transaction.putProjection("coding.execution", execution.id, nextRun);
    appendKernelEvent(transaction, {
      tenantId: input.tenantId,
      aggregateType: "coding.execution",
      aggregateId: execution.id,
      expectedStreamVersion: run.streamVersion,
      type: "coding.reconciliation_decided",
      actorId: input.actorId,
      executionId: execution.id,
      generation: execution.generation,
      correlationId: `coding-reconciliation:${execution.id}`,
      publicPayload: {
        workspaceId: execution.workspaceId,
        taskId: task.id,
        decision: input.decision,
        status: nextRun.status,
        cleanupJobId: cleanupJob.id,
      },
    });

    resolveExecutionInbox(transaction, execution.id);
    putAvailableJob(transaction, cleanupJob, execution.id, execution.generation, input.actorId);

    const newExecution = input.decision === "create_new_call"
      ? createNewCall(transaction, input, execution, run, task, occurredAt)
      : undefined;
    const response: CodingReconciliationDecisionResult = {
      decision: input.decision,
      status: "settled",
      execution: nextExecution,
      codingExecution: {
        executionId: nextRun.executionId,
        status: nextRun.status as CodingExecutionResult["status"],
        streamVersion: nextRun.streamVersion,
        result: nextRun.result!,
      },
      task: nextTask,
      cleanupJobId: cleanupJob.id,
      ...(newExecution ? { newExecution } : {}),
    };
    putReconciliationIdempotency(
      transaction,
      input,
      response,
      occurredAt,
      idempotencyScope,
      requestDigest,
    );
    return response;
  });
}

function requestReconciliationVerification(
  transaction: KernelTransaction,
  input: CodingReconciliationDecisionInput,
  execution: Execution,
  run: StoredCodingRun,
  task: CodingTask,
  idempotencyScope: string,
  requestDigest: string,
): CodingReconciliationDecisionResult {
  if (run.externalInvocation?.verification) {
    throw new KernelError(
      "CODING_RECONCILIATION_VERIFICATION_UNAVAILABLE",
      run.externalInvocation.verification.status === "pending"
        ? "保留候选正在执行权威验证"
        : "保留候选已验证失败，不能直接标记完成",
      run.externalInvocation.verification.status === "pending"
        ? "等待验证完成后刷新人工核对详情"
        : "选择 terminate 或 create_new_call",
    );
  }
  const occurredAt = input.now();
  const verificationJob = createVerificationJob(input, execution, run, occurredAt);
  const nextExecution: Execution = {
    ...execution,
    streamVersion: execution.streamVersion + 1,
    updatedAt: occurredAt,
  };
  const nextTask: CodingTask = {
    ...task,
    stage: "verify",
    streamVersion: task.streamVersion + 1,
    updatedAt: occurredAt,
  };
  const nextRun: StoredCodingRun = {
    ...run,
    result: {
      ...run.result!,
      task: nextTask,
      nextStep: "正在对保留候选运行权威 Gate；不会重放外部 Runner",
    },
    externalInvocation: {
      ...run.externalInvocation!,
      reconciliationDecision: "mark_completed",
      verification: {
        status: "pending",
        jobId: verificationJob.id,
        requestedBy: input.actorId,
        requestedAt: occurredAt,
        updatedAt: occurredAt,
      },
      updatedAt: occurredAt,
    },
    streamVersion: run.streamVersion + 1,
    updatedAt: occurredAt,
  };
  transaction.putProjection("execution", execution.id, nextExecution);
  appendKernelEvent(transaction, {
    tenantId: input.tenantId,
    aggregateType: "execution",
    aggregateId: execution.id,
    expectedStreamVersion: execution.streamVersion,
    type: "execution.reconciliation_verification_requested",
    actorId: input.actorId,
    executionId: execution.id,
    generation: execution.generation,
    correlationId: `coding-reconciliation:${execution.id}`,
    publicPayload: {
      workspaceId: execution.workspaceId,
      status: "needs_reconciliation",
      verificationJobId: verificationJob.id,
    },
  });
  transaction.putProjection("coding.task", task.id, nextTask);
  appendKernelEvent(transaction, {
    tenantId: input.tenantId,
    aggregateType: "coding.task",
    aggregateId: task.id,
    expectedStreamVersion: task.streamVersion,
    type: "coding.reconciliation_verification_requested",
    actorId: input.actorId,
    executionId: execution.id,
    generation: execution.generation,
    correlationId: `coding-reconciliation:${execution.id}`,
    publicPayload: {
      workspaceId: execution.workspaceId,
      status: "verification_pending",
      verificationJobId: verificationJob.id,
    },
  });
  transaction.putProjection("coding.execution", execution.id, nextRun);
  appendKernelEvent(transaction, {
    tenantId: input.tenantId,
    aggregateType: "coding.execution",
    aggregateId: execution.id,
    expectedStreamVersion: run.streamVersion,
    type: "coding.reconciliation_verification_requested",
    actorId: input.actorId,
    executionId: execution.id,
    generation: execution.generation,
    correlationId: `coding-reconciliation:${execution.id}`,
    publicPayload: {
      workspaceId: execution.workspaceId,
      taskId: task.id,
      status: "verification_pending",
      verificationJobId: verificationJob.id,
    },
  });
  putAvailableJob(transaction, verificationJob, execution.id, execution.generation, input.actorId);
  const response: CodingReconciliationDecisionResult = {
    decision: "mark_completed",
    status: "verification_pending",
    execution: nextExecution,
    codingExecution: {
      executionId: nextRun.executionId,
      status: nextRun.status as CodingExecutionResult["status"],
      streamVersion: nextRun.streamVersion,
      result: nextRun.result!,
    },
    task: nextTask,
    verificationJobId: verificationJob.id,
  };
  putReconciliationIdempotency(
    transaction,
    input,
    response,
    occurredAt,
    idempotencyScope,
    requestDigest,
  );
  return response;
}

function assertReviewer(
  transaction: KernelTransaction,
  workspaceId: string,
  actorId: string,
): void {
  const membership = transaction.getProjection<WorkspaceMembership>(
    "membership",
    `${workspaceId}:${actorId}`,
  );
  if (!membership || !REVIEW_ROLES.has(membership.workspaceRole)) {
    throw new KernelError(
      "WORKSPACE_ACCESS_DENIED",
      "无权核对此工作区的 Coding 执行",
      "联系工作区所有者授予 reviewer、operator 或 owner 权限",
    );
  }
}

function assertCleanupPaths(invocation: ExternalInvocationCheckpoint): void {
  for (const path of [
    invocation.sandboxPath,
    invocation.runnerArtifactPath,
    invocation.supervision?.statePath,
  ]) {
    if (!path || !isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
      throw new KernelError(
        "CODING_RECONCILIATION_STATE_INVALID",
        "外部调用的清理路径无效",
        "停止操作并检查受保护的执行检查点",
      );
    }
  }
  if (basename(invocation.runnerArtifactPath) !== "runner"
    || invocation.runnerArtifactPath === invocation.sandboxPath) {
    throw new KernelError(
      "CODING_RECONCILIATION_STATE_INVALID",
      "外部 Runner 制品路径无效",
      "停止操作并检查受保护的执行检查点",
    );
  }
  if (invocation.supervision?.protocol !== "mn-runner-supervisor-v1"
    || basename(invocation.supervision.statePath) !== "state.json"
    || !/^[a-f0-9]{64}$/u.test(invocation.supervision.tokenDigest)) {
    throw new KernelError(
      "CODING_RECONCILIATION_STATE_INVALID",
      "外部 Runner 监督记录无效",
      "停止操作并检查受保护的执行检查点",
    );
  }
}

function assertRunnerStopped(invocation: ExternalInvocationCheckpoint): void {
  if (invocation.terminationStatus !== "confirmed") {
    throw new KernelError(
      "CODING_RUNNER_TERMINATION_UNCONFIRMED",
      "无法证明旧 Runner 已停止，不能验证、清理或创建新调用",
      "等待 Worker 监督器确认进程组终止；若长期未恢复，请保留现场并检查 Worker 日志",
    );
  }
}

function reconciliationDecisions(input: {
  readonly runnerStopped: boolean;
  readonly verificationPending: boolean;
  readonly markCompletedAllowed: boolean;
  readonly newCallAllowed: boolean;
}): readonly CodingReconciliationDecision[] {
  if (!input.runnerStopped) return [];
  if (input.verificationPending) return ["terminate"];
  return [
    "terminate",
    ...(input.markCompletedAllowed ? ["mark_completed" as const] : []),
    ...(input.newCallAllowed ? ["create_new_call" as const] : []),
  ];
}

function assertReconciliationDecisionAvailable(
  decision: CodingReconciliationDecision,
  availableDecisions: readonly CodingReconciliationDecision[],
  invocation: ExternalInvocationCheckpoint,
  verificationReadiness: CodingReconciliationVerificationReadiness,
  newCall: CodingNewCallReadiness,
): void {
  if (availableDecisions.includes(decision)) return;
  assertRunnerStopped(invocation);
  if (invocation.verification?.status === "pending") {
    throw new KernelError(
      "CODING_RECONCILIATION_DECISION_UNAVAILABLE",
      "保留候选正在执行权威验证，此时只能终止",
      "选择 terminate，或等待验证结束后刷新",
    );
  }
  if (decision === "mark_completed" && !verificationReadiness.ready) {
    throw new KernelError(
      "CODING_RECONCILIATION_VERIFICATION_UNAVAILABLE",
      verificationReadiness.summary,
      "部署同时实现 coding.reconciliation.verify 与 coding.sandbox.cleanup 的受信 Worker handler",
    );
  }
  if (decision === "create_new_call" && !newCall.allowed) {
    throw new KernelError(
      "CODING_NEW_CALL_NOT_READY",
      newCall.summary,
      "检查 Coding 与 Runner 插件、模型连接和 Runner 确认状态",
    );
  }
  throw new KernelError(
    "CODING_RECONCILIATION_DECISION_UNAVAILABLE",
    "当前状态不允许该人工核对决定",
    "刷新人工核对详情并选择可用操作",
  );
}

function newCallReadiness(
  transaction: KernelTransaction,
  execution: Execution,
  run: StoredCodingRun,
  task: CodingTask,
): { readonly allowed: boolean; readonly summary: string } {
  const workspace = transaction.getProjection<Workspace>("workspace", execution.workspaceId);
  const thread = transaction.getProjection<Thread>("thread", execution.threadId);
  const authority = transaction.getProjection<ExecutionAuthority>("authority", execution.authorityId);
  const model = transaction.getProjection<StoredModelConnection>(
    "modelConnection",
    execution.modelBindingId,
  );
  const runnerPluginId = run.runnerId === "claude-cli"
    ? "runner-claude-cli"
    : run.runnerId === "codex-cli" ? "runner-codex-cli" : undefined;
  const runnerConfiguration = runnerPluginId
    ? transaction.getProjection<CodingRunnerConfigurationV1>(
        CODING_RUNNER_CONFIGURATION_NAMESPACE,
        `${execution.workspaceId}:${run.runnerId}`,
      )
    : undefined;
  const externalRunnerId = run.runnerId as ExternalCodingRunnerId;
  const expectedAuthorityCommitment = authority ? computeExecutionAuthorityCommitment({
    executionId: execution.id,
    workspaceId: execution.workspaceId,
    principalId: authority.principalId,
    toolIds: authority.toolIds,
    dataScopes: authority.dataScopes,
    autoAllowedEffects: authority.autoAllowedEffects,
    budget: authority.budget,
    parentAuthorityId: authority.parentAuthorityId,
    runnerId: externalRunnerId,
  }) : undefined;
  const allowed = Boolean(run.externalInvocation?.terminationStatus === "confirmed"
    && workspace
    && workspace.tenantId === execution.tenantId
    && workspace.activePluginIds.includes("coding")
    && (runnerPluginId === undefined || workspace.activePluginIds.includes(runnerPluginId))
    && thread && thread.workspaceId === execution.workspaceId && thread.pluginId === "coding"
    && thread.resourceRef?.namespace === "coding.task"
    && thread.resourceRef.resourceId === task.id
    && authority && authority.tenantId === execution.tenantId
    && authority.workspaceId === execution.workspaceId
    && authority.executionId === execution.id
    && authority.principalId === execution.executionPrincipalId
    && authority.commitment === expectedAuthorityCommitment
    && authority.toolIds.includes(runnerToolId(externalRunnerId))
    && model && model.tenantId === execution.tenantId && model.status === "ready"
    && model.defaultModel.trim()
    && (runnerPluginId === undefined
      || (runnerConfiguration
        && runnerConfiguration.tenantId === execution.tenantId
        && runnerConfiguration.workspaceId === execution.workspaceId
        && runnerConfiguration.runnerId === run.runnerId
        && runnerConfiguration.status === "confirmed"
        && runnerConfiguration.identityDigest === sha256(runnerConfiguration.identity))));
  return allowed
    ? { allowed: true, summary: "Coding、Runner、权限与模型连接均已就绪" }
    : { allowed: false, summary: "Coding、Runner、权限或模型连接已失效，暂时不能创建新调用" };
}

function settleExecution(
  execution: Execution,
  decision: CodingReconciliationDecision,
  occurredAt: string,
): Execution {
  const {
    failureCode: _failureCode,
    finishedAt: _finishedAt,
    ...current
  } = execution;
  const status = decision === "mark_completed" ? "completed" : "cancelled";
  return {
    ...current,
    status,
    streamVersion: execution.streamVersion + 1,
    updatedAt: occurredAt,
    finishedAt: occurredAt,
  };
}

function settleTask(
  task: CodingTask,
  decision: CodingReconciliationDecision,
  occurredAt: string,
): CodingTask {
  return {
    ...task,
    stage: decision === "mark_completed" ? "learn"
      : decision === "create_new_call" ? "implement" : task.stage,
    status: decision === "mark_completed" ? "completed"
      : decision === "create_new_call" ? "active" : "cancelled",
    streamVersion: task.streamVersion + 1,
    updatedAt: occurredAt,
  };
}

function settleCodingRun(
  run: StoredCodingRun,
  task: CodingTask,
  decision: CodingReconciliationDecision,
  cleanupJobId: string,
  occurredAt: string,
): StoredCodingRun {
  const status = decision === "mark_completed" ? "completed" : "cancelled";
  const nextStep = decision === "mark_completed"
    ? "已依据权威 Gate 与 CodeEvidence 标记完成"
    : decision === "create_new_call"
      ? "旧调用已终止，新的独立调用已经入队"
      : "旧调用已终止；清理完成后可提交新的 Coding turn";
  return {
    ...run,
    status,
    result: {
      ...run.result!,
      task,
      status,
      ...(decision === "mark_completed" ? { approval: "approved_once" as const } : {}),
      nextStep,
    },
    externalInvocation: {
      ...run.externalInvocation!,
      status: "settled",
      reconciliationDecision: decision,
      cleanupJobId,
      cleanupStatus: "pending",
      ...(run.externalInvocation?.verification?.status === "pending"
        ? {
            verification: {
              ...run.externalInvocation.verification,
              status: "failed" as const,
              failureReason: "用户已终止待核对验证",
              updatedAt: occurredAt,
            },
          }
        : {}),
      updatedAt: occurredAt,
    },
    streamVersion: run.streamVersion + 1,
    updatedAt: occurredAt,
  };
}

function invalidateVerificationJob(
  transaction: KernelTransaction,
  input: CodingReconciliationDecisionInput,
  execution: Execution,
  run: StoredCodingRun,
  occurredAt: string,
): void {
  const verification = run.externalInvocation?.verification;
  if (!verification || verification.status !== "pending") return;
  const job = transaction.getProjection<Job>("job", verification.jobId);
  if (!job
    || job.tenantId !== input.tenantId
    || job.workspaceId !== execution.workspaceId
    || job.kind !== "coding.reconciliation.verify"
    || job.payload.reconciliationExecutionId !== execution.id
    || (job.status !== "available" && job.status !== "leased")) {
    throw new KernelError(
      "CODING_RECONCILIATION_STATE_INVALID",
      "待核对验证 Job 与 Coding 执行不一致",
      "停止操作并检查 Job、事件与投影",
    );
  }
  if (!transaction.invalidateJob) {
    throw new KernelError(
      "CODING_RECONCILIATION_JOB_CONTROL_UNAVAILABLE",
      "当前存储无法在领域事务中使验证 Job 失效",
      "升级到支持 Job fencing 失效的存储实现",
    );
  }
  const failure = {
    code: "EXECUTION_CANCELLED",
    message: "用户在人工核对中终止了权威验证",
  } as const;
  const invalidation = transaction.invalidateJob({
    jobId: job.id,
    reason: failure,
    occurredAt,
  });
  const {
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    ...jobWithoutLease
  } = job;
  transaction.putProjection("job", job.id, {
    ...jobWithoutLease,
    status: "failed",
    failure,
    fencingToken: invalidation.fencingToken,
    streamVersion: job.streamVersion + 1,
    updatedAt: occurredAt,
  });
  appendKernelEvent(transaction, {
    tenantId: input.tenantId,
    aggregateType: "job",
    aggregateId: job.id,
    expectedStreamVersion: job.streamVersion,
    type: "job.failed",
    actorId: input.actorId,
    executionId: execution.id,
    generation: execution.generation,
    correlationId: `coding-reconciliation:${execution.id}`,
    publicPayload: {
      workspaceId: execution.workspaceId,
      jobId: job.id,
      kind: job.kind,
      status: "failed",
      failureCode: failure.code,
      fencingToken: invalidation.fencingToken,
    },
  });
  transaction.putOutbox({
    id: input.id("outbox"),
    tenantId: input.tenantId,
    topic: "job.failed",
    payload: {
      workspaceId: execution.workspaceId,
      executionId: execution.id,
      jobId: job.id,
      kind: job.kind,
      failureCode: failure.code,
      fencingToken: invalidation.fencingToken,
    },
    availableAt: occurredAt,
  });
}

function createCleanupJob(
  input: CodingReconciliationDecisionInput,
  execution: Execution,
  run: StoredCodingRun,
  occurredAt: string,
): Job {
  const invocation = run.externalInvocation!;
  const id = input.id("job");
  return {
    id,
    tenantId: input.tenantId,
    workspaceId: execution.workspaceId,
    kind: "coding.sandbox.cleanup",
    payload: {
      reconciliationExecutionId: execution.id,
      codingRunId: `${execution.id}:${run.generation}:${run.turn ?? 1}`,
    },
    status: "available",
    attempts: 0,
    availableAt: occurredAt,
    fencingToken: 0,
    idempotencyKey: `coding:cleanup:${execution.id}:${run.generation}:${run.turn ?? 1}:${invocation.attempt}`,
    streamVersion: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

function createVerificationJob(
  input: CodingReconciliationDecisionInput,
  execution: Execution,
  run: StoredCodingRun,
  occurredAt: string,
): Job {
  const invocation = run.externalInvocation!;
  const id = input.id("job");
  return {
    id,
    tenantId: input.tenantId,
    workspaceId: execution.workspaceId,
    kind: "coding.reconciliation.verify",
    payload: { reconciliationExecutionId: execution.id },
    status: "available",
    attempts: 0,
    availableAt: occurredAt,
    fencingToken: 0,
    idempotencyKey: `coding:reconciliation-verify:${execution.id}:${run.generation}:${invocation.attempt}`,
    streamVersion: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

function resolveExecutionInbox(transaction: KernelTransaction, executionId: string): void {
  for (const item of transaction.listProjections<InboxItem>("inbox")) {
    if (item.executionId === executionId && item.status === "open") {
      transaction.putProjection("inbox", item.id, { ...item, status: "resolved" });
    }
  }
}

function putAvailableJob(
  transaction: KernelTransaction,
  job: Job,
  correlationExecutionId: string,
  generation: number,
  actorId: string,
): void {
  transaction.putProjection("job", job.id, job);
  appendKernelEvent(transaction, {
    tenantId: job.tenantId,
    aggregateType: "job",
    aggregateId: job.id,
    expectedStreamVersion: 0,
    type: "job.available",
    actorId,
    executionId: correlationExecutionId,
    generation,
    correlationId: `coding-reconciliation:${correlationExecutionId}`,
    publicPayload: {
      ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
      jobId: job.id,
      kind: job.kind,
    },
  });
  transaction.putJob({
    id: job.id,
    tenantId: job.tenantId,
    ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
    kind: job.kind,
    payload: job.payload,
    availableAt: job.availableAt,
    idempotencyKey: job.idempotencyKey,
  });
  transaction.putOutbox({
    id: `outbox:${job.id}`,
    tenantId: job.tenantId,
    topic: "job.available",
    payload: {
      ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
      jobId: job.id,
      kind: job.kind,
    },
    availableAt: job.availableAt,
  });
}

function putReconciliationIdempotency(
  transaction: KernelTransaction,
  input: CodingReconciliationDecisionInput,
  response: CodingReconciliationDecisionResult,
  createdAt: string,
  scope: string,
  requestDigest: string,
): void {
  transaction.putIdempotency({
    tenantId: input.tenantId,
    scope,
    key: input.idempotencyKey,
    requestDigest,
    response,
    createdAt,
  });
}

function createNewCall(
  transaction: KernelTransaction,
  input: CodingReconciliationDecisionInput,
  previousExecution: Execution,
  run: StoredCodingRun,
  task: CodingTask,
  occurredAt: string,
): Execution {
  const previousAuthority = transaction.getProjection<ExecutionAuthority>(
    "authority",
    previousExecution.authorityId,
  )!;
  const thread = transaction.getProjection<Thread>("thread", previousExecution.threadId)!;
  const executionId = input.id("execution");
  const authorityId = input.id("authority");
  const turnId = input.id("turn");
  const jobId = input.id("job");
  const commitment = computeExecutionAuthorityCommitment({
    executionId,
    workspaceId: previousExecution.workspaceId,
    principalId: previousAuthority.principalId,
    toolIds: previousAuthority.toolIds,
    dataScopes: previousAuthority.dataScopes,
    autoAllowedEffects: previousAuthority.autoAllowedEffects,
    budget: previousAuthority.budget,
    parentAuthorityId: previousAuthority.parentAuthorityId,
    runnerId: run.runnerId,
  });
  const {
    id: _previousAuthorityId,
    executionId: _previousAuthorityExecutionId,
    commitment: _previousCommitment,
    streamVersion: _previousAuthorityStreamVersion,
    createdAt: _previousAuthorityCreatedAt,
    updatedAt: _previousAuthorityUpdatedAt,
    ...authoritySource
  } = previousAuthority;
  const authority: ExecutionAuthority = {
    ...authoritySource,
    id: authorityId,
    executionId,
    commitment,
    streamVersion: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const {
    id: _previousExecutionId,
    authorityId: _previousExecutionAuthorityId,
    initiatedBy: _previousInitiatedBy,
    generation: _previousGeneration,
    status: _previousStatus,
    streamVersion: _previousStreamVersion,
    createdAt: _previousCreatedAt,
    updatedAt: _previousUpdatedAt,
    startedAt: _previousStartedAt,
    finishedAt: _previousFinishedAt,
    failureCode: _previousFailureCode,
    parentExecutionId: _previousParentExecutionId,
    ...executionSource
  } = previousExecution;
  const execution: Execution = {
    ...executionSource,
    id: executionId,
    authorityId,
    initiatedBy: input.actorId,
    generation: 1,
    status: "queued",
    streamVersion: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const job: Job = {
    id: jobId,
    tenantId: input.tenantId,
    workspaceId: previousExecution.workspaceId,
    kind: "agent.execution.run",
    payload: { executionId, message: task.request },
    status: "available",
    attempts: 0,
    availableAt: occurredAt,
    fencingToken: 0,
    idempotencyKey: `execution:${executionId}:generation:1`,
    streamVersion: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };

  transaction.putProjection("thread", thread.id, {
    ...thread,
    streamVersion: thread.streamVersion + 1,
    updatedAt: occurredAt,
  });
  transaction.putProjection("session-log-entry", turnId, {
    id: turnId,
    tenantId: input.tenantId,
    workspaceId: previousExecution.workspaceId,
    threadId: thread.id,
    executionId,
    threadStreamVersion: thread.streamVersion + 1,
    role: "user",
    message: task.request,
    generation: 1,
    createdAt: occurredAt,
    source: "reconciliation.create_new_call",
  });
  transaction.putProjection("authority", authorityId, authority);
  transaction.putProjection("execution", executionId, execution);
  appendKernelEvent(transaction, {
    tenantId: input.tenantId,
    aggregateType: "thread",
    aggregateId: thread.id,
    expectedStreamVersion: thread.streamVersion,
    type: "thread.turn_submitted",
    actorId: input.actorId,
    executionId,
    generation: 1,
    correlationId: `coding-reconciliation:${previousExecution.id}`,
    publicPayload: {
      workspaceId: previousExecution.workspaceId,
      executionId,
      pluginId: "coding",
      runnerId: run.runnerId,
      source: "reconciliation.create_new_call",
      turnId,
    },
  });
  appendKernelEvent(transaction, {
    tenantId: input.tenantId,
    aggregateType: "execution",
    aggregateId: executionId,
    expectedStreamVersion: 0,
    type: "execution.queued",
    actorId: input.actorId,
    executionId,
    generation: 1,
    correlationId: `coding-reconciliation:${previousExecution.id}`,
    publicPayload: {
      workspaceId: previousExecution.workspaceId,
      threadId: previousExecution.threadId,
      authorityId,
      runnerId: run.runnerId,
      replacesExecutionId: previousExecution.id,
    },
  });
  putAvailableJob(transaction, job, executionId, 1, input.actorId);
  return execution;
}
