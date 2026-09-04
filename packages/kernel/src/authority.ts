import type {
  Approval,
  ExecutionAuthority,
  ResourceRef,
  ToolCallIntent,
  ToolEffectClass,
} from "@mn/contracts";
import { approvalStillMatches, isPotentiallyAutoApprovable } from "@mn/contracts";
import { KernelError } from "./errors.js";

function scopeKey(scope: ResourceRef): string {
  return `${scope.namespace}:${scope.resourceId}`;
}

export function assertAuthorityAttenuation(
  parent: ExecutionAuthority,
  child: ExecutionAuthority,
): void {
  const parentTools = new Set(parent.toolIds);
  const parentScopes = new Set(parent.dataScopes.map(scopeKey));
  const parentEffects = new Set(parent.autoAllowedEffects);
  if (child.toolIds.some((tool) => !parentTools.has(tool))) {
    throw new KernelError("AUTHORITY_ESCALATION", "子 Agent 申请了父 Agent 没有的工具", "缩小工具范围");
  }
  if (child.dataScopes.some((scope) => !parentScopes.has(scopeKey(scope)))) {
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
  const allowedScopes = new Set(authority.dataScopes.map(scopeKey));
  if (intent.resourceRefs.some((resource) => !allowedScopes.has(scopeKey(resource)))) {
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
