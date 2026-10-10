// SPDX-License-Identifier: Apache-2.0
import type { GoalBudgetV2, GoalResourceRefV2, GoalUsageV2 } from './goals.js';

export interface FollowupPeriodBudgetV2 {
  readonly periodMs: 86400000 | 604800000;
  readonly maxRuns: number;
  readonly maxTokens: number;
  readonly maxCostMinorUnits: string;
  readonly currency: string;
}
export interface CreateFollowupV2 {
  readonly expectedStreamVersion: 0;
  readonly parentGoalId: string;
  readonly expectedGoalStreamVersion: number;
  readonly parentPlanDigest: string;
  readonly title: string;
  readonly instruction: string;
  readonly enabled: true;
  readonly trigger: { readonly kind: 'business_changed'; readonly sourceRef: GoalResourceRefV2 };
  readonly resourceRefs: readonly GoalResourceRefV2[];
  readonly modelBindingId: string;
  readonly perRunBudget: GoalBudgetV2;
  readonly periodBudget: FollowupPeriodBudgetV2;
  readonly maxRuns: number;
  readonly expiresAt: string;
}
export type FollowupStatusV2 = 'active' | 'paused' | 'stopped' | 'expired' | 'invalidated' | 'exhausted';
export interface FollowupPolicyV2 {
  readonly id: string; readonly workspaceId: string; readonly principalId: string;
  readonly streamVersion: number; readonly status: FollowupStatusV2; readonly definition: CreateFollowupV2;
  readonly authorizationDigest: string; readonly createdAt: string; readonly updatedAt: string;
  readonly stopConditions: readonly ('goal_closed' | 'permission_revoked' | 'expired' | 'max_runs')[];
  readonly reasonCode?: string;
}
export interface FollowupRunV2 {
  readonly id: string; readonly policyId: string; readonly workspaceId: string; readonly streamVersion: number;
  readonly status: 'pending' | 'running' | 'awaiting_acceptance' | 'accepted' | 'failed' | 'needs_reconciliation' | 'cancelled';
  readonly sourceRef: GoalResourceRefV2; readonly periodStartedAt: string; readonly reserved: GoalUsageV2;
  readonly goalId?: string; readonly executionId?: string; readonly actual?: GoalUsageV2;
  readonly reasonCode?: string; readonly createdAt: string; readonly updatedAt: string;
}
export interface FollowupDetailV2 {
  readonly policy: FollowupPolicyV2;
  readonly runs: readonly FollowupRunV2[];
  readonly currentPeriod: { readonly startedAt: string; readonly endsAt: string; readonly runCount: number;
    readonly settled: GoalUsageV2; readonly reserved: GoalUsageV2; readonly unknown: GoalUsageV2 };
  readonly allowedActions: { readonly pause: boolean; readonly resume: boolean; readonly stop: boolean };
}
export interface CommandFollowupV2 {
  readonly expectedStreamVersion: number;
  readonly command: 'pause' | 'resume' | 'stop';
}
