// SPDX-License-Identifier: Apache-2.0
import type {
  Approval, BusinessDecisionPortV1, BusinessInquirySourcePortV1, BusinessObjectSnapshotPortV1, EffectActionPortV1,
  EffectReceiptAndReconciliationPortV1, IssueQuotePackageInputV1, WorkerExecutionIdentityV1,
} from "@mn/contracts";
import { parseBusinessDecisionV1, parseBusinessObjectSnapshotV1, parseEffectAdmissionV1, parseEffectReceiptV1 } from "@mn/contracts";
import { BusinessActionLedger, KernelError, sha256, type AgentOsKernel, type KernelStore } from "@mn/kernel";
import { UnknownExternalSideEffectError, type WorkerJobHandler } from "./index.js";

export interface BusinessProviderPorts {
  readonly inquiries?: BusinessInquirySourcePortV1;
  readonly snapshots: BusinessObjectSnapshotPortV1;
  readonly decisions: BusinessDecisionPortV1;
  readonly actions: EffectActionPortV1;
  readonly receipts: EffectReceiptAndReconciliationPortV1;
}

export async function assertBusinessAuthorityCurrent(ports: BusinessProviderPorts, action: IssueQuotePackageInputV1, now: string): Promise<void> {
  const snapshot = parseBusinessObjectSnapshotV1(await ports.snapshots.read({ schemaVersion: "1", scope: action.scope,
    objectId: action.quote.id, version: action.quote.version, templateId: action.template.id, templateVersion: action.template.version }));
  const decision = parseBusinessDecisionV1(await ports.decisions.read({ schemaVersion: "1", scope: action.scope, decisionId: action.businessDecision.id }));
  if (sha256(snapshot.scope) !== sha256(action.scope) || sha256(decision.scope) !== sha256(action.scope)
    || snapshot.objectId !== action.quote.id || snapshot.version !== action.quote.version || snapshot.digest !== action.quote.digest
    || sha256(snapshot.template) !== sha256(action.template) || decision.id !== action.businessDecision.id
    || decision.digest !== action.businessDecision.digest || decision.snapshotDigest !== snapshot.digest
    || decision.snapshotVersion !== snapshot.version || decision.status !== "approved" || decision.revokedAt
    || Date.parse(decision.expiresAt) <= Date.parse(now)) {
    throw new KernelError("BUSINESS_APPROVAL_STALE", "报价、模板、业务批准或当前权限已变化", "重新核准当前报价后创建操作");
  }
}

export function createBusinessActionWorkerHandler(options: {
  readonly store: KernelStore;
  readonly kernel: AgentOsKernel;
  readonly ports: BusinessProviderPorts;
  readonly now?: () => string;
  readonly pollIntervalMs?: number;
}): WorkerJobHandler {
  const now = options.now ?? (() => new Date().toISOString());
  const ledger = new BusinessActionLedger(options.store, { now });
  return async (job, context) => {
    const actionId = job.payload.actionId;
    if (typeof actionId !== "string") throw new Error("业务动作任务缺少标识");
    const lease = () => ({ jobId: job.id, workerId: context.workerId, fencingToken: context.fencingToken, occurredAt: now() });
    let state = await ledger.get(job.tenantId, actionId);
    if (!state || state.executionId !== job.payload.executionId || state.workspaceId !== job.workspaceId) throw new Error("业务动作任务范围不一致");
    let dispatched = Boolean(state.dispatchStartedAt);
    try {
      state = await ledger.start(job.tenantId, actionId, lease());
      if (state.dispatchStartedAt || state.status === "needs_reconciliation") {
        dispatched = true;
        throw new UnknownExternalSideEffectError(state.executionId);
      }
      await assertBusinessAuthorityCurrent(options.ports, state.action, now());
      const intent = await ledger.intent(job.tenantId, actionId);
      const requested = await options.kernel.requestToolApproval(job.tenantId, state.action.scope.principalId,
        `business:${actionId}:approval`, intent);
      if (requested.mode !== "approval") throw new Error("外部出包动作必须逐次批准");
      state = await ledger.waiting(job.tenantId, actionId, requested.approval.id, lease());
      while (true) {
        if (context.signal.aborted) throw new Error("业务动作已停止");
        const approval = await options.store.transact(job.tenantId, tx => tx.getProjection<Approval>("approval", requested.approval.id));
        if (!approval || approval.status === "denied" || approval.status === "expired" || Date.parse(approval.expiresAt) <= Date.parse(now()))
          throw new KernelError("BUSINESS_APPROVAL_DENIED", "出包批准已拒绝或过期", "刷新出包操作");
        if (approval.status === "approved_once") break;
        await new Promise<void>(resolve => setTimeout(resolve, options.pollIntervalMs ?? 100));
      }
      await assertBusinessAuthorityCurrent(options.ports, state.action, now());
      if (context.signal.aborted) throw new Error("业务动作已停止");
      state = await ledger.dispatch(job.tenantId, actionId, intent, lease());
      dispatched = true;
      const identity: WorkerExecutionIdentityV1 = { executionId: state.executionId, generation: intent.generation,
        jobId: job.id, workerId: context.workerId, fencingToken: context.fencingToken };
      const admission = parseEffectAdmissionV1(await options.ports.actions.admit({ schemaVersion: "1", action: state.action,
        identity, approvalId: requested.approval.id, actionDigest: state.actionDigest }));
      if (admission.actionId !== state.id || admission.operationKey !== state.operationKey) throw new Error("业务准入回执不匹配");
      await ledger.record(job.tenantId, actionId, { admissionId: admission.admissionId }, lease());
      if (context.signal.aborted) throw new Error("业务动作已停止");
      const receipt = parseEffectReceiptV1(admission.receipt?.status === "completed" ? admission.receipt
        : await options.ports.actions.execute({ schemaVersion: "1", actionId: state.id, operationKey: state.operationKey,
          admissionId: admission.admissionId, identity }));
      if (receipt.actionId !== state.id || receipt.operationKey !== state.operationKey) throw new Error("业务完成回执不匹配");
      if (receipt.status === "completed") {
        const settled = await ledger.complete(job.tenantId, actionId, receipt, lease());
        context.acknowledgeJobSettlement?.(settled);
        return { actionId, operationKey: state.operationKey, status: "completed" };
      }
      if (receipt.status === "rejected") {
        await ledger.record(job.tenantId, actionId, { status: "rejected", receipt }, lease());
        return { actionId, operationKey: state.operationKey, status: "rejected" };
      }
      throw new UnknownExternalSideEffectError(state.executionId);
    } catch (error) {
      // Losing the lease must never be converted to a new write by the stale Worker.
      if (typeof error === "object" && error !== null && "code" in error && error.code === "STALE_FENCING_TOKEN") throw error;
      if (dispatched) {
        await ledger.record(job.tenantId, actionId, { status: "needs_reconciliation" }, lease());
        throw new UnknownExternalSideEffectError(state.executionId);
      }
      await ledger.record(job.tenantId, actionId, { status: "rejected" }, lease());
      throw new KernelError("BUSINESS_ACTION_REJECTED", "出包条件未通过，未发起业务写入", "核对当前权限、报价和批准状态");
    }
  };
}
