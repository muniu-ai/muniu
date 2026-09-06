import type { JsonObject } from "./json.js";
import type { ResourceRef, ToolEffectClass } from "./models.js";

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
    approved.executionId === current.executionId &&
    approved.generation === current.generation &&
    approved.toolId === current.toolId &&
    approved.toolVersion === current.toolVersion &&
    approved.argumentsDigest === current.argumentsDigest &&
    approved.resourcesDigest === current.resourcesDigest &&
    approved.authorityCommitment === current.authorityCommitment
  );
}
