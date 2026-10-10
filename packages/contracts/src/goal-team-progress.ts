// SPDX-License-Identifier: Apache-2.0
import type { CoordinationAttemptV2, CoordinationControlV2 } from "./coordination.js";
import type { GoalDetailV2, GoalResourceRefV2 } from "./goals.js";
import type { GoalTeamDetailV2 } from "./team-goals.js";

export type GoalResponseV2 = GoalDetailV2 | GoalTeamDetailV2;
export type GoalTeamActionV2 = "start" | "pause" | "resume" | "cancel" | "decide";
export interface GoalTeamNodeProgressV2 {
  readonly nodeId: string;
  readonly title: string;
  readonly status: "pending" | "queued" | "running" | "waiting_approval" | "awaiting_decision"
    | "completed" | "failed" | "paused" | "cancelled" | "needs_reconciliation";
  readonly attempts: number;
  readonly blockedReason?: string;
  readonly executionId?: string;
  readonly outputRefs: readonly GoalResourceRefV2[];
}
export interface GoalTeamProgressV2 {
  readonly goalId: string;
  readonly planRevisionId: string;
  readonly runId?: string;
  readonly nodes: readonly GoalTeamNodeProgressV2[];
  readonly allowedActions: readonly GoalTeamActionV2[];
  readonly attempts: readonly CoordinationAttemptV2[];
  readonly decisions: readonly CoordinationControlV2[];
}
export function isTeamGoalDetail(value: GoalResponseV2): value is GoalTeamDetailV2 {
  return value.plan !== null && "kind" in value.plan && value.plan.kind === "team-v1";
}
