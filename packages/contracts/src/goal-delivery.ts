// SPDX-License-Identifier: Apache-2.0
import type { GoalOutputRefV2 } from './goals.js';

export type GoalDeliveryItemDecisionV2 =
  | { readonly key: string; readonly digest: string; readonly decision: 'accept'; readonly reviewedCriterionIds: readonly string[] }
  | { readonly key: string; readonly digest: string; readonly decision: 'request_changes'; readonly failedCriterionIds: readonly string[]; readonly instruction: string }
  | { readonly key: string; readonly digest: string; readonly decision: 'defer'; readonly reason?: string };
export interface GoalDeliveryDecisionV2 {
  readonly id: string; readonly goalId: string; readonly deliverySetId: string; readonly criteriaVersion: string;
  readonly principalId: string; readonly decidedAt: string; readonly goalStreamVersion: number; readonly items: readonly GoalDeliveryItemDecisionV2[];
}
/** This records an explicit reuse decision; it is not an authorization grant. */
export interface GoalOutputReuseV2 {
  readonly nodeId: string; readonly sourcePlanRevisionId: string; readonly sourceNodeId: string;
  readonly sourceAttemptId: string; readonly inputDigest: string; readonly outputs: readonly GoalOutputRefV2[];
}
export interface GoalReworkV2 {
  readonly id: string; readonly goalId: string; readonly sourcePlanRevisionId: string; readonly sourceDeliverySetId: string;
  readonly decisionId: string; readonly planRevisionId: string; readonly round: number; readonly createdAt: string;
  readonly affectedNodeIds: readonly string[]; readonly reuses: readonly GoalOutputReuseV2[];
  readonly retainedOutputs: readonly { readonly sourceDeliverySetId: string; readonly key: string; readonly outputDigest: string; readonly output: GoalOutputRefV2 }[];
}
