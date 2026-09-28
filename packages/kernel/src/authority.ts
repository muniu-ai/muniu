import type {
  Approval,
  CodingRunnerId,
  Execution,
  ExecutionAuthority,
  WorkspaceMembership,
  ResourceRef,
  ToolCallIntent,
  ToolEffectClass,
} from "@mn/contracts";
import { approvalStillMatches, isPotentiallyAutoApprovable } from "@mn/contracts";
import { sha256 } from "./canonical.js";
import { KernelError } from "./errors.js";
import type { KernelTransaction } from "./store.js";
import type { ToolAdmission } from "./tool-admission.js";

/** Check the human grant behind the execution, never the synthetic agent identity. */
export function assertCurrentExecutionAuthorization(
  transaction: Pick<KernelTransaction, "getProjection">,
  execution: Execution,
): void {
  const membership = transaction.getProjection<WorkspaceMembership>(
    "membership", `${execution.workspaceId}:${execution.initiatedBy}`,
  );
  if (!membership || membership.tenantId !== execution.tenantId
    || membership.workspaceId !== execution.workspaceId || membership.principalId !== execution.initiatedBy
    || membership.removedAt || !["owner", "operator"].includes(membership.workspaceRole)) {
    throw new KernelError("EXECUTION_AUTHORIZATION_REVOKED", "执行发起人的当前授权已撤销", "由有操作权限的成员重新发起执行");
  }
}

export function assertCurrentApprovalAuthorization(
  transaction: Pick<KernelTransaction, "getProjection">,
  approval: Approval,
): void {
  const membership = approval.decidedBy && transaction.getProjection<WorkspaceMembership>(
    "membership", `${approval.workspaceId}:${approval.decidedBy}`,
  );
  if (!membership || membership.tenantId !== approval.tenantId
    || membership.workspaceId !== approval.workspaceId || membership.principalId !== approval.decidedBy
    || membership.removedAt || !["owner", "operator", "reviewer"].includes(membership.workspaceRole)) {
    throw new KernelError("APPROVER_AUTHORIZATION_REVOKED", "批准人的当前审核授权已撤销", "由有审核权限的成员重新批准");
  }
}

/** The admission transaction rechecks approvals after asynchronous tool preparation. */
export function assertCurrentToolApproval(
  transaction: Pick<KernelTransaction, "getProjection" | "listProjections">,
  executionId: string,
  toolCallId: string,
  now: string,
): void {
  const approval = transaction.listProjections<Approval>("approval")
    .find(item => item.executionId === executionId && item.toolCallId === toolCallId);
  if (!approval) return;
  if (approval.status !== "approved_once" || approval.expiresAt <= now) {
    throw new KernelError("APPROVAL_EXPIRED", "工具调用批准已失效", "重新审阅当前操作");
  }
  assertCurrentApprovalAuthorization(transaction, approval);
}

/** Protected runtime payloads are opaque; unmatched starts conservatively require reconciliation. */
export function hasUnsettledToolCalls(
  transaction: Pick<KernelTransaction, "getProjection" | "listProjections">,
  executionId: string,
): boolean {
  if (transaction.listProjections<ToolAdmission>("toolAdmission")
    .some(admission => admission.executionId === executionId && admission.status === "started")) return true;
  const runtime = transaction.getProjection<{ readonly records: readonly { readonly type: string }[] }>("agent-runtime", executionId);
  let pending = 0;
  for (const record of runtime?.records ?? []) {
    if (record.type === "tool/started") pending += 1;
    if (record.type === "tool/result") pending = Math.max(0, pending - 1);
  }
  return pending > 0;
}

export type ExecutionAuthorityCommitmentInput = Pick<
  ExecutionAuthority,
  | "executionId"
  | "workspaceId"
  | "principalId"
  | "toolIds"
  | "dataScopes"
  | "autoAllowedEffects"
  | "budget"
  | "parentAuthorityId"
> & { readonly runnerId?: CodingRunnerId };

export function computeExecutionAuthorityCommitment(
  input: ExecutionAuthorityCommitmentInput,
): string {
  return sha256({
    executionId: input.executionId,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    toolIds: input.toolIds,
    dataScopes: input.dataScopes,
    autoAllowedEffects: input.autoAllowedEffects,
    budget: input.budget,
    parentAuthorityId: input.parentAuthorityId,
    runnerId: input.runnerId,
  });
}

function scopeIncludes(allowed: ResourceRef, requested: ResourceRef): boolean {
  return allowed.namespace === requested.namespace
    && (allowed.resourceId === "*" || allowed.resourceId === requested.resourceId)
    && (allowed.digest === undefined || allowed.digest === requested.digest);
}

export function assertAuthorityAttenuation(
  parent: ExecutionAuthority,
  child: ExecutionAuthority,
): void {
  const parentTools = new Set(parent.toolIds);
  const parentEffects = new Set(parent.autoAllowedEffects);
  if (child.toolIds.some((tool) => !parentTools.has(tool))) {
    throw new KernelError("AUTHORITY_ESCALATION", "子 Agent 申请了父 Agent 没有的工具", "缩小工具范围");
  }
  if (child.dataScopes.some((scope) => !parent.dataScopes.some((allowed) => scopeIncludes(allowed, scope)))) {
    throw new KernelError("AUTHORITY_ESCALATION", "子 Agent 申请了父 Agent 没有的数据范围", "缩小数据范围");
  }
  if (child.autoAllowedEffects.some((effect) => !parentEffects.has(effect))) {
    throw new KernelError("AUTHORITY_ESCALATION", "子 Agent 放宽了副作用策略", "使用父 Agent 的策略子集");
  }
  const pb = parent.budget;
  const cb = child.budget;
  if (
    cb.maxSubagentDepth >= pb.maxSubagentDepth ||
    cb.maxSubagents > pb.maxSubagents ||
    cb.maxTokens > pb.maxTokens ||
    cb.maxDurationMs > pb.maxDurationMs ||
    cb.currency !== pb.currency ||
    BigInt(cb.maxCostMinorUnits) > BigInt(pb.maxCostMinorUnits)
  ) {
    throw new KernelError("AUTHORITY_ESCALATION", "子 Agent 预算没有衰减", "降低子 Agent 预算");
  }
}

export function authorityAllowsIntent(
  authority: ExecutionAuthority,
  intent: ToolCallIntent,
): "auto" | "approval" {
  if (!authority.toolIds.includes(intent.toolId)) {
    throw new KernelError("TOOL_DENIED", "当前执行没有此工具权限", "移除工具调用或请求新的执行权限");
  }
  if (authority.executionId !== intent.executionId || authority.commitment !== intent.authorityCommitment) {
    throw new KernelError("AUTHORITY_MISMATCH", "工具调用的执行身份或权限承诺不匹配", "停止执行并重新生成工具调用");
  }
  if (intent.resourceRefs.some((resource) =>
    !authority.dataScopes.some((allowed) => scopeIncludes(allowed, resource)))) {
    throw new KernelError("RESOURCE_DENIED", "工具调用超出已授权资源范围", "缩小资源范围");
  }
  if (
    isPotentiallyAutoApprovable(intent.effectClass) &&
    authority.autoAllowedEffects.includes(intent.effectClass)
  ) {
    return "auto";
  }
  return "approval";
}

export function assertApprovalUsable(
  approval: Approval,
  approvedIntent: ToolCallIntent,
  currentIntent: ToolCallIntent,
  now: string,
): void {
  if (approval.status !== "approved_once") {
    throw new KernelError("APPROVAL_REQUIRED", "此操作尚未批准", "在收件箱中批准或拒绝");
  }
  if (approval.expiresAt <= now) {
    throw new KernelError("APPROVAL_EXPIRED", "批准已过期", "重新审阅当前操作");
  }
  if (!approvalStillMatches(approvedIntent, currentIntent)) {
    throw new KernelError("STALE_APPROVAL", "工具、参数、资源或执行代次已变化", "重新审阅当前操作");
  }
}

export const MANUAL_ONLY_EFFECTS: readonly ToolEffectClass[] = [
  "local_irreversible_write",
  "external_side_effect",
  "financial",
  "privileged",
  "unknown",
];
