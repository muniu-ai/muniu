// SPDX-License-Identifier: Apache-2.0
import type { GoalBudgetV2, GoalDeliverySetV2, GoalUsageV2 } from './goals.js';
import type { GoalDeliveryDecisionV2, GoalReworkV2 } from './goal-delivery.js';
import type { GoalCoordinatedPlanV2 } from './team-goals.js';

export interface GoalDeliveryReviewStateV2 {
  readonly decisions: readonly GoalDeliveryDecisionV2[];
  readonly reworks: readonly GoalReworkV2[];
  readonly history: readonly {
    readonly planRevisionId: string;
    readonly revision: number;
    readonly deliverySet: GoalDeliverySetV2 | null;
    readonly usage?: GoalUsageV2;
  }[];
}

export interface GoalReworkPreviewV2 {
  readonly id: string;
  readonly goalId: string;
  readonly sourcePlanRevisionId: string;
  readonly sourceDeliverySetId: string;
  readonly decisionId: string;
  readonly expectedGoalStreamVersion: number;
  readonly round: number;
  readonly affectedNodeIds: readonly string[];
  readonly reusedNodeIds: readonly string[];
  readonly retainedDeliverableKeys: readonly string[];
  readonly remainingBudget: GoalBudgetV2;
  readonly deadlineAt: string;
  readonly additionalWork: readonly string[];
  readonly authorization: { readonly requiresApproval: boolean; readonly reasons: readonly string[] };
  readonly plan: GoalCoordinatedPlanV2;
  readonly digest: string;
  readonly createdAt: string;
}
