import type { JsonObject } from "./json.js";
import type { ResourceRef, ToolEffectClass } from "./models.js";

export class ExecutionBudgetExceededError extends Error {
  constructor(readonly dimension: "duration" | "coding_repair" | "tokens" | "cost" | "model_unknown" | "model_overrun") {
    super(dimension === "duration" ? "执行时间预算已耗尽，请审阅现有成果后决定是否创建新执行"
      : dimension === "coding_repair" ? "本次执行的三次修复预算已耗尽，请审阅失败原因后作出决定"
      : dimension === "tokens" ? "执行的 token 预算不足，请审阅现有成果后决定是否创建新执行"
      : dimension === "cost" ? "执行的预估费用预算不足，请审阅现有成果后决定是否创建新执行"
      : dimension === "model_unknown" ? "模型请求尚未结算，请核对厂商用量后决定是否创建新执行"
      : "模型实际用量超出预留上限，已停止后续调用");
    this.name = "ExecutionBudgetExceededError";
  }
}

export interface ToolCallIntent {
  readonly id: string;
  readonly executionId: string;
  readonly generation: number;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly effectClass: ToolEffectClass;
  readonly intent: string;
  readonly normalizedArguments: JsonObject;
  readonly argumentsDigest: string;
  readonly resourceRefs: readonly ResourceRef[];
  readonly resourcesDigest: string;
  readonly authorityCommitment: string;
  readonly expiresAt: string;
}

export type ApprovalDecision = "approve_once" | "deny";
export type ToolCallCommitment = Omit<ToolCallIntent, "normalizedArguments">;

const AUTO_EFFECTS = new Set<ToolEffectClass>([
  "local_read",
  "external_read",
  "local_reversible_write",
]);

export function isPotentiallyAutoApprovable(effectClass: ToolEffectClass): boolean {
  return AUTO_EFFECTS.has(effectClass);
}

export function approvalStillMatches(
  approved: ToolCallCommitment,
  current: ToolCallCommitment,
): boolean {
  return (
    approved.id === current.id &&
    approved.effectClass === current.effectClass &&
    approved.expiresAt === current.expiresAt &&
    approved.executionId === current.executionId &&
    approved.generation === current.generation &&
    approved.toolId === current.toolId &&
    approved.toolVersion === current.toolVersion &&
    approved.argumentsDigest === current.argumentsDigest &&
    approved.resourcesDigest === current.resourcesDigest &&
    approved.authorityCommitment === current.authorityCommitment
  );
}
