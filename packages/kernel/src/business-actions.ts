// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type {
  Approval, BusinessActionV1, BusinessScopeV1, EffectReceiptV1, Execution, ExecutionAuthority,
  IssueQuotePackageInputV1, JsonObject, ToolCallIntent, WorkspaceMembership, WorkerExecutionIdentityV1,
} from "@mn/contracts";
import { computeBusinessActionDigest, parseIssueQuotePackageInputV1 } from "@mn/contracts";
import { assertApprovalUsable, authorityAllowsIntent, computeExecutionAuthorityCommitment } from "./authority.js";
import { expireExecutionApprovals } from "./approvals.js";
import { sha256 } from "./canonical.js";
import { KernelError } from "./errors.js";
import { appendKernelEvent } from "./projections.js";
import type { KernelJobLeaseAssertion, KernelJobSettlementReceipt, KernelStore, KernelTransaction } from "./store.js";

export const BUSINESS_ACTION_NAMESPACE = "business.action";
export const BUSINESS_ACTION_JOB_KIND = "business.action.execute";
export const BUSINESS_ACTION_TOOL_ID = "industry.issueQuotePackage";
export const BUSINESS_ACTION_TOOL_VERSION = "1";

export interface BusinessActionState extends BusinessActionV1 {
  readonly dispatchStartedAt?: string;
  readonly admissionId?: string;
}

function fail(code: string, message: string): never {
  throw new KernelError(code, message, "刷新业务动作并核对当前权限与业务版本");
}

export function requireBusinessLease(tx: KernelTransaction, lease: KernelJobLeaseAssertion): void {
  if (!tx.assertJobLease) fail("BUSINESS_LEASE_UNAVAILABLE", "存储不支持业务动作租约校验");
  tx.assertJobLease(lease);
}

export function requireBusinessMembership(tx: KernelTransaction, action: BusinessActionV1): void {
  requireBusinessScopeMembership(tx, action.action.scope);
}

function requireBusinessScopeMembership(tx: KernelTransaction, scope: BusinessScopeV1, roles: readonly string[] = ["owner", "operator"]): void {
  const member = tx.getProjection<WorkspaceMembership>("membership", `${scope.workspaceId}:${scope.principalId}`);
  if (!member || member.removedAt || !roles.includes(member.workspaceRole)) fail("BUSINESS_SCOPE_REVOKED", "业务执行身份的工作区权限已撤销");
}

export class BusinessActionLedger {
  private readonly now: () => string;
  constructor(readonly store: KernelStore, options: { readonly now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get(tenantId: string, id: string): Promise<BusinessActionState | undefined> {
    return this.store.transact(tenantId, tx => tx.getProjection<BusinessActionState>(BUSINESS_ACTION_NAMESPACE, id));
  }

  async create(input: IssueQuotePackageInputV1, idempotencyKey: string): Promise<BusinessActionState> {
    parseIssueQuotePackageInputV1(input);
    const { actionId: _id, ...semanticRequest } = input;
    const requestDigest = sha256(semanticRequest);
    return this.store.transact(input.scope.tenantId, tx => {
      requireBusinessScopeMembership(tx, input.scope);
      const cached = tx.getIdempotency("business-action.create", idempotencyKey);
      if (cached) {
        if (cached.requestDigest !== requestDigest) fail("IDEMPOTENCY_CONFLICT", "幂等键对应的业务参数已变化");
        return this.require(tx, (cached.response as BusinessActionState).id);
      }
      const duplicate = tx.listProjections<BusinessActionState>(BUSINESS_ACTION_NAMESPACE)
        .find(item => item.operationKey === input.operationKey);
      if (duplicate) {
        const { principalId: _previousPrincipal, ...previousScope } = duplicate.action.scope;
        const { principalId: _currentPrincipal, ...currentScope } = input.scope;
        if (sha256(previousScope) !== sha256(currentScope)) fail("BUSINESS_SCOPE_MISMATCH", "已有出包操作不属于当前业务范围");
        tx.putIdempotency({ tenantId: input.scope.tenantId, scope: "business-action.create", key: idempotencyKey, requestDigest, response: duplicate, createdAt: this.now() });
        return duplicate;
      }
      const unresolved = tx.listProjections<BusinessActionState>(BUSINESS_ACTION_NAMESPACE).some(item =>
        item.workspaceId === input.scope.workspaceId && item.action.scope.customerId === input.scope.customerId
        && item.action.quote.id === input.quote.id && (item.status === "needs_reconciliation"
          || (item.status === "running" && Boolean(item.dispatchStartedAt))));
      if (unresolved) fail("BUSINESS_RECONCILIATION_REQUIRED", "此报价已有待核对出包操作，不能更换参数另行重试");
      const timestamp = this.now();
      const executionId = `execution-${randomUUID()}`;
      const jobId = `job-${randomUUID()}`;
      const threadId = `thread-${randomUUID()}`;
      const authorityId = `authority-${randomUUID()}`;
      const scope = input.scope;
      const execution: Execution = {
        id: executionId, tenantId: scope.tenantId, workspaceId: scope.workspaceId, threadId,
        pluginId: "industry", agentDefinitionId: "industry.issueQuotePackage", modelBindingId: "none",
        initiatedBy: scope.principalId, executionPrincipalId: scope.principalId,
        generation: 1, status: "queued", authorityId, streamVersion: 1, createdAt: timestamp, updatedAt: timestamp,
      };
      const authorityBody = {
        executionId, workspaceId: scope.workspaceId, principalId: scope.principalId,
        toolIds: [BUSINESS_ACTION_TOOL_ID],
        dataScopes: [{ namespace: "sales.quote", resourceId: input.quote.id, digest: input.quote.digest }],
        autoAllowedEffects: [],
        budget: { maxSubagentDepth: 0, maxSubagents: 0, maxTokens: 0, maxCostMinorUnits: "0", currency: "CNY", maxDurationMs: 86_400_000 },
      } satisfies Omit<ExecutionAuthority, "id" | "tenantId" | "commitment" | "streamVersion" | "createdAt" | "updatedAt">;
      const authority: ExecutionAuthority = { ...authorityBody, id: authorityId, tenantId: scope.tenantId,
        commitment: computeExecutionAuthorityCommitment(authorityBody), streamVersion: 1, createdAt: timestamp, updatedAt: timestamp };
      const action: BusinessActionState = {
        schemaVersion: "1", id: input.actionId, tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        executionId, jobId, operationKey: input.operationKey, actionDigest: computeBusinessActionDigest(input),
        action: input, status: "queued", streamVersion: 1, createdAt: timestamp, updatedAt: timestamp,
      };
      tx.putProjection("authority", authorityId, authority);
      tx.putProjection("execution", executionId, execution);
      tx.putProjection("thread", threadId, { id: threadId, tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        subject: "正式报价出包", pluginId: "industry", resourceRef: authorityBody.dataScopes[0],
        streamVersion: 1, createdAt: timestamp, updatedAt: timestamp });
      appendKernelEvent(tx, { tenantId: scope.tenantId, aggregateType: "thread", aggregateId: threadId,
        expectedStreamVersion: 0, type: "thread.created", actorId: scope.principalId, generation: 1,
        correlationId: input.actionId, publicPayload: { workspaceId: scope.workspaceId } });
      appendKernelEvent(tx, { tenantId: scope.tenantId, aggregateType: "execution", aggregateId: executionId,
        expectedStreamVersion: 0, type: "execution.queued", actorId: scope.principalId, executionId, generation: 1,
        correlationId: input.actionId, publicPayload: { workspaceId: scope.workspaceId, threadId, authorityId } });
      tx.putProjection(BUSINESS_ACTION_NAMESPACE, action.id, action);
      this.append(tx, action, 0, "created");
      const job = { id: jobId, tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        kind: BUSINESS_ACTION_JOB_KIND, payload: { executionId, actionId: action.id }, availableAt: timestamp,
        idempotencyKey: input.operationKey };
      tx.putProjection("job", jobId, { ...job, status: "available", attempts: 0, fencingToken: 0,
        streamVersion: 1, createdAt: timestamp, updatedAt: timestamp });
      appendKernelEvent(tx, { tenantId: scope.tenantId, aggregateType: "job", aggregateId: jobId,
        expectedStreamVersion: 0, type: "job.queued", actorId: scope.principalId, executionId, generation: 1,
        correlationId: action.id, publicPayload: { workspaceId: scope.workspaceId, kind: BUSINESS_ACTION_JOB_KIND } });
      tx.putJob(job);
      tx.putOutbox({ id: `outbox-${randomUUID()}`, tenantId: scope.tenantId, topic: "business.action.queued",
        payload: { actionId: action.id, executionId, jobId }, availableAt: timestamp });
      tx.putIdempotency({ tenantId: scope.tenantId, scope: "business-action.create", key: idempotencyKey,
        requestDigest, response: action, createdAt: timestamp });
      return action;
    });
  }

  async start(tenantId: string, id: string, lease: KernelJobLeaseAssertion): Promise<BusinessActionState> {
    return this.store.transact(tenantId, tx => {
      requireBusinessLease(tx, lease);
      const action = this.require(tx, id);
      if (action.jobId !== lease.jobId) fail("BUSINESS_JOB_MISMATCH", "业务动作与执行任务不一致");
      requireBusinessMembership(tx, action);
      if (action.dispatchStartedAt || action.status === "needs_reconciliation") return action;
      if (!["queued", "running", "waiting_approval"].includes(action.status)) fail("BUSINESS_ACTION_TERMINAL", "业务动作已经结束");
      const execution = this.execution(tx, action);
      if (!["queued", "running", "waiting_approval"].includes(execution.status)) fail("BUSINESS_EXECUTION_INACTIVE", "业务执行已停止");
      if (execution.status === "queued") this.writeExecution(tx, execution, "running", "started");
      return action.status === "queued" ? this.write(tx, action, { status: "running" }, "started") : action;
    });
  }

  async intent(tenantId: string, id: string): Promise<ToolCallIntent> {
    return this.store.transact(tenantId, tx => {
      const action = this.require(tx, id);
      const execution = this.execution(tx, action);
      const authority = tx.getProjection<ExecutionAuthority>("authority", execution.authorityId);
      if (!authority) fail("AUTHORITY_NOT_FOUND", "业务执行权限不存在");
      const resources = [{ namespace: "sales.quote", resourceId: action.action.quote.id, digest: action.action.quote.digest }];
      return { id: `${action.id}:issue`, executionId: action.executionId, generation: execution.generation,
        toolId: BUSINESS_ACTION_TOOL_ID, toolVersion: BUSINESS_ACTION_TOOL_VERSION, effectClass: "external_side_effect",
        intent: "生成已核准报价的正式文件包；发送仍由人工完成", normalizedArguments: action.action as unknown as JsonObject,
        argumentsDigest: action.actionDigest, resourceRefs: resources, resourcesDigest: sha256(resources),
        authorityCommitment: authority.commitment, expiresAt: new Date(Date.parse(action.createdAt) + 86_400_000).toISOString() };
    });
  }

  async waiting(tenantId: string, id: string, approvalId: string, lease: KernelJobLeaseAssertion): Promise<BusinessActionState> {
    return this.store.transact(tenantId, tx => {
      requireBusinessLease(tx, lease);
      const action = this.require(tx, id);
      return this.write(tx, action, { status: "waiting_approval", approvalId }, "approval_requested");
    });
  }

  async dispatch(tenantId: string, id: string, intent: ToolCallIntent, lease: KernelJobLeaseAssertion): Promise<BusinessActionState> {
    return this.store.transact(tenantId, tx => {
      requireBusinessLease(tx, lease);
      const action = this.require(tx, id);
      requireBusinessMembership(tx, action);
      if (action.dispatchStartedAt) fail("BUSINESS_DISPATCH_UNKNOWN", "业务动作已经发起，必须先核对结果");
      const execution = this.execution(tx, action);
      const authority = tx.getProjection<ExecutionAuthority>("authority", execution.authorityId);
      const approved = action.approvalId ? tx.getProjection<Approval>("approval", action.approvalId) : undefined;
      const persisted = tx.getProjection<ToolCallIntent>("toolIntent", intent.id);
      if (!authority || !approved || !persisted || execution.status !== "running" || execution.generation !== intent.generation)
        fail("STALE_APPROVAL", "出包批准或执行代次已失效");
      authorityAllowsIntent(authority, intent);
      assertApprovalUsable(approved, { ...persisted, normalizedArguments: intent.normalizedArguments }, intent, this.now());
      if (intent.argumentsDigest !== action.actionDigest || computeBusinessActionDigest(action.action) !== action.actionDigest)
        fail("BUSINESS_ACTION_CHANGED", "出包参数已变化");
      return this.write(tx, action, { status: "running", dispatchStartedAt: this.now() }, "dispatch_started");
    });
  }

  async record(tenantId: string, id: string, patch: Partial<Pick<BusinessActionState, "status" | "receipt" | "admissionId">>, lease?: KernelJobLeaseAssertion): Promise<BusinessActionState> {
    return this.store.transact(tenantId, tx => {
      if (lease) requireBusinessLease(tx, lease);
      const action = this.require(tx, id);
      if (["completed", "rejected", "terminated"].includes(action.status)) fail("BUSINESS_ACTION_TERMINAL", "业务动作已经结束");
      const next = this.write(tx, action, patch, "updated");
      if (patch.status === "rejected") {
        const execution = this.execution(tx, action);
        expireExecutionApprovals(tx, { tenantId, executionId: execution.id, generation: execution.generation,
          actorId: execution.initiatedBy, occurredAt: this.now(), reason: "业务出包条件未通过" });
        this.writeExecution(tx, execution, "failed", "rejected");
      }
      return next;
    });
  }

  async authorizeExternal(tenantId: string, id: string, identity: WorkerExecutionIdentityV1): Promise<{ allowed: true; actionDigest: string; expiresAt: string; leaseExpiresAt: string }> {
    const currentIntent = await this.intent(tenantId, id);
    return this.store.transact(tenantId, tx => {
      requireBusinessLease(tx, { ...identity, occurredAt: this.now() });
      const action = this.require(tx, id);
      requireBusinessMembership(tx, action);
      if (action.jobId !== identity.jobId || action.executionId !== identity.executionId || action.status !== "running" || !action.dispatchStartedAt)
        fail("BUSINESS_AUTHORITY_REVOKED", "业务动作当前不允许执行");
      const execution = this.execution(tx, action);
      const authority = tx.getProjection<ExecutionAuthority>("authority", execution.authorityId);
      const approval = action.approvalId ? tx.getProjection<Approval>("approval", action.approvalId) : undefined;
      const stored = tx.getProjection<ToolCallIntent>("toolIntent", currentIntent.id);
      const reviewer = approval?.decidedBy ? tx.getProjection<WorkspaceMembership>("membership", `${action.workspaceId}:${approval.decidedBy}`) : undefined;
      if (!authority || !approval || !stored || !reviewer || reviewer.removedAt || reviewer.workspaceRole === "viewer"
        || execution.status !== "running" || execution.generation !== identity.generation || currentIntent.generation !== identity.generation)
        fail("BUSINESS_AUTHORITY_REVOKED", "出包执行或批准人的当前权限已变化");
      authorityAllowsIntent(authority, currentIntent);
      assertApprovalUsable(approval, { ...stored, normalizedArguments: currentIntent.normalizedArguments }, currentIntent, this.now());
      const job = tx.getProjection<{ leaseExpiresAt: string }>("job", action.jobId);
      if (!job?.leaseExpiresAt) fail("BUSINESS_LEASE_UNAVAILABLE", "任务租约到期时间不可用");
      return { allowed: true, actionDigest: action.actionDigest, expiresAt: approval.expiresAt, leaseExpiresAt: job.leaseExpiresAt };
    });
  }

  async complete(tenantId: string, id: string, receipt: EffectReceiptV1, lease: KernelJobLeaseAssertion): Promise<KernelJobSettlementReceipt> {
    return this.store.transact(tenantId, tx => {
      requireBusinessLease(tx, lease);
      const action = this.require(tx, id);
      if (receipt.actionId !== action.id || receipt.operationKey !== action.operationKey || receipt.status !== "completed")
        fail("BUSINESS_RECEIPT_MISMATCH", "回执与当前出包操作不一致");
      if (!tx.settleJob) fail("BUSINESS_SETTLEMENT_UNAVAILABLE", "存储不支持业务动作事务结算");
      this.write(tx, action, { status: "completed", receipt }, "completed");
      this.writeExecution(tx, this.execution(tx, action), "completed", "completed");
      return tx.settleJob({ ...lease, outcome: "completed", value: { actionId: id, operationKey: action.operationKey } });
    });
  }

  async reconcile(tenantId: string, id: string, expectedStreamVersion: number, decision: "mark_completed" | "terminate", receipt?: EffectReceiptV1,
    request?: { readonly actorId: string; readonly idempotencyKey: string }): Promise<BusinessActionState> {
    return this.store.transact(tenantId, tx => {
      const action = this.require(tx, id);
      requireBusinessScopeMembership(tx, { ...action.action.scope, principalId: request?.actorId ?? action.action.scope.principalId }, ["owner", "operator", "reviewer"]);
      const requestDigest = sha256({ id, expectedStreamVersion, decision, actorId: request?.actorId ?? null });
      const cacheScope = `business-action.reconcile:${id}`;
      const cached = request ? tx.getIdempotency(cacheScope, request.idempotencyKey) : undefined;
      if (cached) {
        if (cached.requestDigest !== requestDigest) fail("IDEMPOTENCY_CONFLICT", "幂等键对应的核对决定已变化");
        return cached.response as BusinessActionState;
      }
      if (action.streamVersion !== expectedStreamVersion) fail("STREAM_VERSION_CONFLICT", "业务动作版本已变化");
      if (action.status !== "needs_reconciliation") fail("BUSINESS_RECONCILIATION_REQUIRED", "业务动作不处于待核对状态");
      if (decision === "mark_completed" && (!receipt || receipt.status !== "completed" || receipt.actionId !== id || receipt.operationKey !== action.operationKey))
        fail("BUSINESS_RECEIPT_REQUIRED", "只有业务系统确认的完成回执才能结案");
      if (decision === "terminate" && (!receipt || receipt.status !== "rejected" || receipt.reasonCode !== "ABANDONED"
        || receipt.actionId !== id || receipt.operationKey !== action.operationKey))
        fail("BUSINESS_ABANDONMENT_REQUIRED", "业务系统尚未确认此操作已永久放弃");
      const inboxId = `reconciliation:${action.executionId}:${action.jobId}`;
      const inbox = tx.getProjection<JsonObject>("inbox", inboxId);
      if (inbox) tx.putProjection("inbox", inboxId, { ...inbox, status: "resolved" });
      const next = this.write(tx, action, { status: decision === "mark_completed" ? "completed" : "terminated", ...(receipt ? { receipt } : {}) }, "reconciled", request?.actorId);
      this.writeExecution(tx, this.execution(tx, action), decision === "mark_completed" ? "completed" : "cancelled", "reconciled");
      const job = tx.getProjection<{ status: string }>("job", action.jobId);
      if (job && ["available", "leased"].includes(job.status)) {
        if (!tx.invalidateJob) fail("BUSINESS_INVALIDATION_UNAVAILABLE", "存储不支持停止当前业务任务");
        tx.invalidateJob({ jobId: action.jobId, reason: { code: "BUSINESS_RECONCILED" }, occurredAt: this.now() });
      }
      if (request) tx.putIdempotency({ tenantId, scope: cacheScope, key: request.idempotencyKey, requestDigest, response: next, createdAt: this.now() });
      return next;
    });
  }

  private require(tx: KernelTransaction, id: string): BusinessActionState {
    const action = tx.getProjection<BusinessActionState>(BUSINESS_ACTION_NAMESPACE, id);
    if (!action) fail("BUSINESS_ACTION_NOT_FOUND", "业务动作不存在");
    return action;
  }
  private execution(tx: KernelTransaction, action: BusinessActionState): Execution {
    const execution = tx.getProjection<Execution>("execution", action.executionId);
    if (!execution || execution.tenantId !== action.tenantId || execution.workspaceId !== action.workspaceId) fail("EXECUTION_NOT_FOUND", "业务执行不存在");
    return execution;
  }
  private write(tx: KernelTransaction, current: BusinessActionState, patch: Partial<BusinessActionState>, event: string, actorId?: string): BusinessActionState {
    const next = { ...current, ...patch, streamVersion: current.streamVersion + 1, updatedAt: this.now() };
    tx.putProjection(BUSINESS_ACTION_NAMESPACE, current.id, next);
    this.append(tx, next, current.streamVersion, event, actorId);
    return next;
  }
  private append(tx: KernelTransaction, action: BusinessActionState, expectedStreamVersion: number, suffix: string, actorId?: string): void {
    appendKernelEvent(tx, { tenantId: action.tenantId, aggregateType: "businessAction", aggregateId: action.id,
      expectedStreamVersion, type: `business_action.${suffix}`, actorId: actorId ?? action.action.scope.principalId,
      executionId: action.executionId, generation: 1, correlationId: action.id,
      publicPayload: { actionDigest: action.actionDigest, operationKey: action.operationKey, status: action.status } });
  }
  private writeExecution(tx: KernelTransaction, current: Execution, status: Execution["status"], suffix: string): void {
    const next = { ...current, status, streamVersion: current.streamVersion + 1, updatedAt: this.now(),
      ...(["completed", "failed", "cancelled"].includes(status) ? { finishedAt: this.now() } : {}) };
    tx.putProjection("execution", current.id, next);
    appendKernelEvent(tx, { tenantId: current.tenantId, aggregateType: "execution", aggregateId: current.id,
      expectedStreamVersion: current.streamVersion, type: `execution.business_${suffix}`, actorId: current.initiatedBy,
      executionId: current.id, generation: current.generation, correlationId: current.id, publicPayload: { status } });
  }
}
