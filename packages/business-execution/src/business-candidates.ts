// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { BusinessCandidateV1, BusinessScopeV1, Execution, ExecutionAuthority, ExecutionBudget, JsonObject, WorkspaceMembership } from "@mn/contracts";
import {
  computeExecutionAuthorityCommitment, sha256, KernelError, PROTECTED_PAYLOAD_KEY_NAMESPACE, appendKernelEvent,
  type KernelJobLeaseAssertion, type KernelJobSettlementReceipt, type KernelStore, type KernelTransaction,
} from "@mn/kernel";

export const BUSINESS_CANDIDATE_NAMESPACE = "business.candidate";
export const BUSINESS_CANDIDATE_JOB_KIND = "business.candidate.extract";

export interface BusinessCandidateState extends BusinessCandidateV1 {
  readonly sourceProtectedPayloadRef: string;
  readonly candidateProtectedPayloadRef?: string;
  readonly modelConnectionId: string;
  readonly modelConnectionVersion: number;
  readonly budget: ExecutionBudget;
}
export interface CreateBusinessCandidateInput {
  readonly id: string;
  readonly scope: BusinessScopeV1;
  readonly inquiryId: string;
  readonly inquiryRevision: string;
  readonly sourceDigest: string;
  readonly sourceProtectedPayloadRef: string;
  readonly sourceKeyRecord: JsonObject;
  readonly modelConnectionId: string;
  readonly modelConnectionVersion: number;
  readonly budget: ExecutionBudget;
}

function fail(code: string, message: string): never { throw new KernelError(code, message, "检查询价版本、模型连接和当前工作区权限"); }
export function assertBusinessCandidateMember(tx: KernelTransaction, state: Pick<BusinessCandidateState, "scope">): void {
  const member = tx.getProjection<WorkspaceMembership>("membership", `${state.scope.workspaceId}:${state.scope.principalId}`);
  if (!member || member.removedAt || !["owner", "operator"].includes(member.workspaceRole)) fail("BUSINESS_CANDIDATE_FORBIDDEN", "询价候选执行身份的权限已撤销");
}
function lease(tx: KernelTransaction, input: KernelJobLeaseAssertion): void {
  if (!tx.assertJobLease) fail("BUSINESS_LEASE_UNAVAILABLE", "存储不支持候选任务租约校验");
  tx.assertJobLease(input);
}

export class BusinessCandidateLedger {
  private readonly now: () => string;
  constructor(readonly store: KernelStore, options: { now?: () => string } = {}) { this.now = options.now ?? (() => new Date().toISOString()); }
  get(tenantId: string, id: string): Promise<BusinessCandidateState | undefined> {
    return this.store.transact(tenantId, tx => tx.getProjection<BusinessCandidateState>(BUSINESS_CANDIDATE_NAMESPACE, id));
  }
  create(input: CreateBusinessCandidateInput, idempotencyKey: string): Promise<BusinessCandidateState> {
    const requestDigest = sha256({ scope: input.scope, inquiryId: input.inquiryId, inquiryRevision: input.inquiryRevision,
      sourceDigest: input.sourceDigest, modelConnectionId: input.modelConnectionId, modelConnectionVersion: input.modelConnectionVersion, budget: input.budget });
    return this.store.transact(input.scope.tenantId, tx => {
      assertBusinessCandidateMember(tx, input);
      if (!idempotencyKey.trim() || input.budget.maxSubagents !== 0 || input.budget.maxSubagentDepth !== 0
        || input.budget.maxTokens <= 0 || input.budget.maxDurationMs <= 0) fail("INVALID_CANDIDATE_INPUT", "候选任务预算或幂等键无效");
      const cached = tx.getIdempotency("business-candidate.create", idempotencyKey);
      if (cached) {
        if (cached.requestDigest !== requestDigest) fail("IDEMPOTENCY_CONFLICT", "幂等键对应的候选输入已变化");
        return cached.response as BusinessCandidateState;
      }
      const timestamp = this.now();
      const executionId = `execution-${randomUUID()}`; const jobId = `job-${randomUUID()}`;
      const threadId = `thread-${randomUUID()}`; const authorityId = `authority-${randomUUID()}`;
      const scoped = input.scope;
      const execution: Execution = { id: executionId, tenantId: scoped.tenantId, workspaceId: scoped.workspaceId, threadId,
        pluginId: "industry", agentDefinitionId: "industry.rfq-candidate", modelBindingId: input.modelConnectionId,
        initiatedBy: scoped.principalId, executionPrincipalId: scoped.principalId, generation: 1, status: "queued", authorityId,
        streamVersion: 1, createdAt: timestamp, updatedAt: timestamp };
      const authorityBody = { workspaceId: scoped.workspaceId, executionId, principalId: scoped.principalId, toolIds: [],
        dataScopes: [{ namespace: "sales.inquiry", resourceId: input.inquiryId, digest: input.sourceDigest }],
        autoAllowedEffects: [], budget: input.budget } satisfies Omit<ExecutionAuthority, "id" | "tenantId" | "streamVersion" | "createdAt" | "updatedAt" | "commitment">;
      tx.putProjection("authority", authorityId, { ...authorityBody, id: authorityId, tenantId: scoped.tenantId,
        commitment: computeExecutionAuthorityCommitment(authorityBody), streamVersion: 1, createdAt: timestamp, updatedAt: timestamp });
      tx.putProjection("execution", executionId, execution);
      tx.putProjection("thread", threadId, { id: threadId, tenantId: scoped.tenantId, workspaceId: scoped.workspaceId,
        subject: "整理询价候选", pluginId: "industry", resourceRef: authorityBody.dataScopes[0], streamVersion: 1, createdAt: timestamp, updatedAt: timestamp });
      appendKernelEvent(tx, { tenantId: scoped.tenantId, aggregateType: "thread", aggregateId: threadId, expectedStreamVersion: 0,
        type: "thread.created", actorId: scoped.principalId, generation: 1, correlationId: input.id, publicPayload: { workspaceId: scoped.workspaceId } });
      appendKernelEvent(tx, { tenantId: scoped.tenantId, aggregateType: "execution", aggregateId: executionId, expectedStreamVersion: 0,
        type: "execution.queued", actorId: scoped.principalId, executionId, generation: 1, correlationId: input.id,
        publicPayload: { workspaceId: scoped.workspaceId, threadId, authorityId } });
      const state: BusinessCandidateState = { schemaVersion: "1", id: input.id, tenantId: scoped.tenantId, workspaceId: scoped.workspaceId,
        scope: scoped, inquiryId: input.inquiryId, inquiryRevision: input.inquiryRevision, sourceDigest: input.sourceDigest,
        sourceProtectedPayloadRef: input.sourceProtectedPayloadRef, executionId, jobId, workflowVersion: "1", status: "queued",
        modelConnectionId: input.modelConnectionId, modelConnectionVersion: input.modelConnectionVersion, budget: input.budget,
        streamVersion: 1, createdAt: timestamp, updatedAt: timestamp };
      tx.putProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, input.sourceProtectedPayloadRef, input.sourceKeyRecord);
      tx.putProjection(BUSINESS_CANDIDATE_NAMESPACE, state.id, state);
      this.event(tx, state, 0, "created", input.sourceProtectedPayloadRef);
      const job = { id: jobId, tenantId: scoped.tenantId, workspaceId: scoped.workspaceId, kind: BUSINESS_CANDIDATE_JOB_KIND,
        payload: { executionId, candidateId: state.id }, availableAt: timestamp, idempotencyKey: `candidate:${state.id}` };
      tx.putProjection("job", jobId, { ...job, status: "available", attempts: 0, fencingToken: 0,
        streamVersion: 1, createdAt: timestamp, updatedAt: timestamp });
      appendKernelEvent(tx, { tenantId: scoped.tenantId, aggregateType: "job", aggregateId: jobId, expectedStreamVersion: 0,
        type: "job.queued", actorId: scoped.principalId, executionId, generation: 1, correlationId: state.id,
        publicPayload: { workspaceId: scoped.workspaceId, kind: BUSINESS_CANDIDATE_JOB_KIND } });
      tx.putJob(job); tx.putOutbox({ id: `outbox-${randomUUID()}`, tenantId: scoped.tenantId, topic: "business.candidate.queued",
        payload: { candidateId: state.id, executionId, jobId }, availableAt: timestamp });
      tx.putIdempotency({ tenantId: scoped.tenantId, scope: "business-candidate.create", key: idempotencyKey,
        requestDigest, response: state, createdAt: timestamp });
      return state;
    });
  }
  assertActive(tx: KernelTransaction, state: BusinessCandidateState): void {
    assertBusinessCandidateMember(tx, state);
    const execution = tx.getProjection<Execution>("execution", state.executionId);
    if (!execution || execution.status !== "running" || execution.generation !== 1 || execution.modelBindingId !== state.modelConnectionId
      || execution.workspaceId !== state.workspaceId || execution.executionPrincipalId !== state.scope.principalId)
      fail("BUSINESS_CANDIDATE_INACTIVE", "询价候选执行已停止");
    const authority = tx.getProjection<ExecutionAuthority>("authority", execution.authorityId);
    const expectedAuthority = { workspaceId: state.workspaceId, executionId: state.executionId, principalId: state.scope.principalId,
      toolIds: [], dataScopes: [{ namespace: "sales.inquiry", resourceId: state.inquiryId, digest: state.sourceDigest }],
      autoAllowedEffects: [], budget: state.budget };
    if (!authority || authority.tenantId !== state.tenantId
      || computeExecutionAuthorityCommitment(authority) !== computeExecutionAuthorityCommitment(expectedAuthority)
      || authority.commitment !== computeExecutionAuthorityCommitment(expectedAuthority))
      fail("BUSINESS_CANDIDATE_AUTHORITY_CHANGED", "询价候选执行权限已变化");
    if (Date.parse(this.now()) - Date.parse(state.createdAt) >= state.budget.maxDurationMs) fail("BUSINESS_CANDIDATE_EXPIRED", "询价候选执行预算已过期");
  }
  start(tenantId: string, id: string, input: KernelJobLeaseAssertion): Promise<BusinessCandidateState> {
    return this.store.transact(tenantId, tx => {
      lease(tx, input); const state = this.require(tx, id);
      if (state.jobId !== input.jobId || !["queued", "running"].includes(state.status)) fail("BUSINESS_CANDIDATE_INACTIVE", "候选任务不能再次启动");
      const execution = tx.getProjection<Execution>("execution", state.executionId);
      if (!execution || !["queued", "running"].includes(execution.status)) fail("BUSINESS_CANDIDATE_INACTIVE", "询价执行已停止");
      if (execution.status === "queued") this.execution(tx, execution, "running");
      this.assertActive(tx, state);
      return state.status === "queued" ? this.write(tx, state, { status: "running" }, "started") : state;
    });
  }
  finish(tenantId: string, id: string, input: KernelJobLeaseAssertion, result: {
    readonly status: "completed" | "failed" | "needs_reconciliation";
    readonly candidateDigest?: string; readonly candidateProtectedPayloadRef?: string; readonly keyRecord?: JsonObject;
    readonly counts?: BusinessCandidateV1["counts"]; readonly reasonCode?: string;
  }): Promise<KernelJobSettlementReceipt> {
    return this.store.transact(tenantId, tx => {
      lease(tx, input); const state = this.require(tx, id);
      if (state.jobId !== input.jobId || (state.status !== "running" && !(state.status === "queued" && result.status === "failed")))
        fail("BUSINESS_CANDIDATE_INACTIVE", "候选任务已结算");
      if (result.status === "completed") {
        this.assertActive(tx, state);
        if (!result.candidateDigest || !result.candidateProtectedPayloadRef || !result.keyRecord || !result.counts) fail("CANDIDATE_ARTIFACT_REQUIRED", "候选缺少受保护成果");
        tx.putProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, result.candidateProtectedPayloadRef, result.keyRecord);
      }
      const { keyRecord: _key, ...patch } = result;
      this.write(tx, state, patch, "settled", result.candidateProtectedPayloadRef);
      const execution = tx.getProjection<Execution>("execution", state.executionId);
      if (!execution) fail("EXECUTION_NOT_FOUND", "询价执行不存在");
      this.execution(tx, execution, result.status === "completed" ? "completed" : result.status === "needs_reconciliation" ? "needs_reconciliation" : "failed");
      if (result.status === "needs_reconciliation") tx.putProjection("inbox", `candidate:${id}`, {
        id: `candidate:${id}`, tenantId, workspaceId: state.workspaceId, executionId: state.executionId, kind: "reconciliation",
        title: "询价模型用量或结果待核对", summary: "请求状态未知，未再次调用模型，也未生成可采纳成果", status: "open", createdAt: this.now() });
      if (!tx.settleJob) fail("BUSINESS_SETTLEMENT_UNAVAILABLE", "存储不支持候选任务事务结算");
      return tx.settleJob({ ...input, outcome: result.status === "completed" ? "completed" : "failed",
        value: { candidateId: id, status: result.status, ...(result.reasonCode ? { code: result.reasonCode } : {}) } });
    });
  }
  private require(tx: KernelTransaction, id: string): BusinessCandidateState {
    const state = tx.getProjection<BusinessCandidateState>(BUSINESS_CANDIDATE_NAMESPACE, id);
    if (!state) fail("BUSINESS_CANDIDATE_NOT_FOUND", "询价候选不存在"); return state;
  }
  private write(tx: KernelTransaction, state: BusinessCandidateState, patch: Partial<BusinessCandidateState>, suffix: string, protectedPayloadRef?: string): BusinessCandidateState {
    const next = { ...state, ...patch, streamVersion: state.streamVersion + 1, updatedAt: this.now() };
    tx.putProjection(BUSINESS_CANDIDATE_NAMESPACE, state.id, next); this.event(tx, next, state.streamVersion, suffix, protectedPayloadRef); return next;
  }
  private event(tx: KernelTransaction, state: BusinessCandidateState, expectedStreamVersion: number, suffix: string, protectedPayloadRef?: string): void {
    appendKernelEvent(tx, { tenantId: state.tenantId, aggregateType: "businessCandidate", aggregateId: state.id, expectedStreamVersion,
      type: `business_candidate.${suffix}`, actorId: state.scope.principalId, executionId: state.executionId, generation: 1, correlationId: state.id,
      publicPayload: { workspaceId: state.workspaceId, sourceDigest: state.sourceDigest, status: state.status,
        ...(state.candidateDigest ? { candidateDigest: state.candidateDigest } : {}) }, ...(protectedPayloadRef ? { protectedPayloadRef } : {}) });
  }
  private execution(tx: KernelTransaction, current: Execution, status: Execution["status"]): void {
    tx.putProjection("execution", current.id, { ...current, status, streamVersion: current.streamVersion + 1, updatedAt: this.now() });
    appendKernelEvent(tx, { tenantId: current.tenantId, aggregateType: "execution", aggregateId: current.id, expectedStreamVersion: current.streamVersion,
      type: "execution.business_candidate_updated", actorId: current.initiatedBy, executionId: current.id, generation: current.generation,
      correlationId: current.id, publicPayload: { status } });
  }
}
