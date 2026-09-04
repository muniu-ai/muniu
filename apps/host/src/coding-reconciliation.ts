// SPDX-License-Identifier: Apache-2.0

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
  KernelError,
  sha256,
  StreamVersionConflictError,
  type InboxItem,
  type KernelStore,
  type KernelTransaction,
} from "@mn/kernel";
import type {
  Candidate,
  CodeEvidence,
  CodingControlPlaneCommitment,
  CodingExecutionResult,
  CodingTask,
  GateResult,
} from "@mn/plugin-coding";
import { createCodeEvidence } from "@mn/plugin-coding";
import { runnerToolId } from "./coding-runners.js";

export type CodingReconciliationDecision =
  | "terminate"
  | "mark_completed"
  | "create_new_call";

export interface CodingReconciliationDecisionInput {
  readonly tenantId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly expectedStreamVersion: number;
  readonly expectedCodingStreamVersion: number;
  readonly decision: CodingReconciliationDecision;
  readonly now: () => string;
  readonly id: (kind: string) => string;
}

export interface CodingReconciliationDecisionResult {
  readonly decision: CodingReconciliationDecision;
  readonly execution: Execution;
  readonly codingExecution: CodingReconciliationExecutionView;
  readonly task: CodingTask;
  readonly cleanupJobId: string;
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
  readonly externalInvocation?: ExternalInvocationCheckpoint;
  readonly result?: CodingExecutionResult;
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoredCandidate extends Candidate {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly diff: string;
}

interface StoredGateResult extends GateResult {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly executionId: string;
}

interface StoredCodeEvidence extends CodeEvidence {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly executionId: string;
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
): Promise<CodingReconciliationView> {
  return store.transact(tenantId, (transaction) => {
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
    const markCompletedAllowed = hasAuthoritativeEvidence(transaction, execution, run, task);
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
        summary: markCompletedAllowed
          ? "已持久化权威通过 Gate 与匹配的 CodeEvidence，可标记完成"
          : "尚无可用于标记完成的权威 Gate 与 CodeEvidence",
      },
      availableDecisions: markCompletedAllowed
        ? ["terminate", "mark_completed", "create_new_call"]
        : ["terminate", "create_new_call"],
    };
  });
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
    const requestDigest = sha256(request);
    const idempotencyScope = `coding.reconciliation:${input.executionId}`;
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
    if (input.decision === "mark_completed") {
      assertAuthoritativeEvidence(transaction, execution, run, task);
    }
    if (input.decision === "create_new_call") {
      assertNewCallReady(transaction, execution, run, task);
    }

    const occurredAt = input.now();
    const cleanupJob = createCleanupJob(input, execution, run, occurredAt);
    const nextExecution = settleExecution(execution, input.decision, occurredAt);
    const nextTask = settleTask(task, input.decision, occurredAt);
    const nextRun = settleCodingRun(run, nextTask, input.decision, cleanupJob.id, occurredAt);

    transaction.putProjection("execution", execution.id, nextExecution);
    transaction.appendEvent({
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
    transaction.appendEvent({
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
    transaction.appendEvent({
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
    transaction.putIdempotency({
      tenantId: input.tenantId,
      scope: idempotencyScope,
      key: input.idempotencyKey,
      requestDigest,
      response,
      createdAt: occurredAt,
    });
    return response;
  });
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
  for (const path of [invocation.sandboxPath, invocation.runnerArtifactPath]) {
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
}

function assertAuthoritativeEvidence(
  transaction: KernelTransaction,
  execution: Execution,
  run: StoredCodingRun,
  task: CodingTask,
): void {
  if (!hasAuthoritativeEvidence(transaction, execution, run, task)) {
    throw new KernelError(
      "CODING_RECONCILIATION_EVIDENCE_REQUIRED",
      "缺少已持久化的权威通过 Gate 或 CodeEvidence",
      "核对外部结果后选择 terminate 或 create_new_call",
    );
  }
}

function hasAuthoritativeEvidence(
  transaction: KernelTransaction,
  execution: Execution,
  run: StoredCodingRun,
  task: CodingTask,
): boolean {
  const evidence = run.result?.evidence;
  const candidate = evidence
    ? transaction.getProjection<StoredCandidate>("coding.candidate", evidence.candidateId)
    : undefined;
  const gate = evidence
    ? transaction.getProjection<StoredGateResult>("coding.gate-result", evidence.candidateId)
    : undefined;
  const storedEvidence = evidence
    ? transaction.getProjection<StoredCodeEvidence>("coding.code-evidence", evidence.digest)
    : undefined;
  const resultCandidate = evidence
    ? run.result?.candidates.find((item) => item.id === evidence.candidateId)
    : undefined;
  const resultGate = evidence
    ? run.result?.gates.find((item) => item.candidateId === evidence.candidateId)
    : undefined;
  const computedEvidenceDigest = storedEvidence
    ? recomputeCodeEvidenceDigest(storedEvidence)
    : undefined;
  return evidence !== undefined
    && candidate?.tenantId === execution.tenantId
    && candidate.workspaceId === execution.workspaceId
    && candidate.executionId === execution.id
    && candidate.taskId === task.id
    && candidate.diffDigest === evidence.diffDigest
    && candidate.sandbox.enforced
    && !candidate.sandbox.fallbackUsed
    && candidate.sandbox.evidenceDigest === run.controlPlane.sandboxDigest
    && gate?.tenantId === execution.tenantId
    && gate.workspaceId === execution.workspaceId
    && gate.executionId === execution.id
    && gate.status === "passed"
    && gate.authoritative
    && gate.evidenceDigest === evidence.gateEvidenceDigest
    && resultCandidate?.diffDigest === evidence.diffDigest
    && resultGate?.status === "passed"
    && resultGate.authoritative
    && resultGate.evidenceDigest === evidence.gateEvidenceDigest
    && storedEvidence?.tenantId === execution.tenantId
    && storedEvidence.workspaceId === execution.workspaceId
    && storedEvidence.executionId === execution.id
    && storedEvidence.taskId === task.id
    && storedEvidence.candidateId === evidence.candidateId
    && storedEvidence.runnerId === run.runnerId
    && evidence.runnerId === run.runnerId
    && storedEvidence.digest === evidence.digest
    && storedEvidence.digest === computedEvidenceDigest
    && storedEvidence.diffDigest === evidence.diffDigest
    && storedEvidence.gateEvidenceDigest === evidence.gateEvidenceDigest
    && storedEvidence.specDigest === run.controlPlane.specDigest
    && storedEvidence.governanceDigest === run.controlPlane.governanceDigest
    && storedEvidence.harnessDigest === run.controlPlane.harnessDigest
    && storedEvidence.sandboxDigest === run.controlPlane.sandboxDigest
    && storedEvidence.repositoryIndexDigest === run.controlPlane.repositoryIndexDigest;
}

function recomputeCodeEvidenceDigest(evidence: StoredCodeEvidence): string | undefined {
  try {
    return createCodeEvidence({
      taskId: evidence.taskId,
      candidateId: evidence.candidateId,
      runnerId: evidence.runnerId,
      specDigest: evidence.specDigest,
      governanceDigest: evidence.governanceDigest,
      harnessDigest: evidence.harnessDigest,
      sandboxDigest: evidence.sandboxDigest,
      repositoryIndexDigest: evidence.repositoryIndexDigest,
      gateEvidenceDigest: evidence.gateEvidenceDigest,
      diffDigest: evidence.diffDigest,
    }).digest;
  } catch {
    return undefined;
  }
}

function assertNewCallReady(
  transaction: KernelTransaction,
  execution: Execution,
  run: StoredCodingRun,
  task: CodingTask,
): void {
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
  const expectedAuthorityCommitment = authority ? sha256({
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
  if (!workspace || workspace.tenantId !== execution.tenantId
    || !workspace.activePluginIds.includes("coding")
    || (runnerPluginId !== undefined && !workspace.activePluginIds.includes(runnerPluginId))
    || !thread || thread.workspaceId !== execution.workspaceId || thread.pluginId !== "coding"
    || thread.resourceRef?.namespace !== "coding.task"
    || thread.resourceRef.resourceId !== task.id
    || !authority || authority.tenantId !== execution.tenantId
    || authority.workspaceId !== execution.workspaceId
    || authority.executionId !== execution.id
    || authority.principalId !== execution.executionPrincipalId
    || authority.commitment !== expectedAuthorityCommitment
    || !authority.toolIds.includes(runnerToolId(externalRunnerId))
    || !model || model.tenantId !== execution.tenantId || model.status !== "ready"
    || !model.defaultModel.trim()
    || (runnerPluginId !== undefined
      && (!runnerConfiguration
        || runnerConfiguration.tenantId !== execution.tenantId
        || runnerConfiguration.workspaceId !== execution.workspaceId
        || runnerConfiguration.runnerId !== run.runnerId
        || runnerConfiguration.status !== "confirmed"
        || runnerConfiguration.identityDigest !== sha256(runnerConfiguration.identity)))) {
    throw new KernelError(
      "CODING_NEW_CALL_NOT_READY",
      "当前工作区不能创建新的 Coding 调用",
      "检查 Coding 与 Runner 插件、模型连接和 Runner 确认状态",
    );
  }
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
      updatedAt: occurredAt,
    },
    streamVersion: run.streamVersion + 1,
    updatedAt: occurredAt,
  };
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
    },
    status: "available",
    attempts: 0,
    availableAt: occurredAt,
    fencingToken: 0,
    idempotencyKey: `coding:cleanup:${execution.id}:${run.generation}:${invocation.attempt}`,
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
  transaction.appendEvent({
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
  const commitment = sha256({
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
    role: "user",
    message: task.request,
    generation: 1,
    createdAt: occurredAt,
    source: "reconciliation.create_new_call",
  });
  transaction.putProjection("authority", authorityId, authority);
  transaction.putProjection("execution", executionId, execution);
  transaction.appendEvent({
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
    },
  });
  transaction.appendEvent({
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
