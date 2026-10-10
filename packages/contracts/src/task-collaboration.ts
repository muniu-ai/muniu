// SPDX-License-Identifier: Apache-2.0
import type { GoalV2 } from './goals.js';
import type { WorkspaceRole } from './models.js';
export interface GoalAssignmentV2 {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly streamVersion: number;
  readonly responsiblePrincipalId: string | null;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}
export interface AssignmentMemberV2 {
  readonly principalId: string;
  readonly displayName: string;
  readonly workspaceRole: WorkspaceRole;
  readonly available: boolean;
  readonly unavailableReason?: string;
}
export interface GoalAssignmentSummaryV2 {
  readonly streamVersion: number;
  readonly responsible: AssignmentMemberV2 | null;
}
export interface GoalAssignmentDetailV2 {
  readonly assignment: GoalAssignmentV2;
  readonly summary: GoalAssignmentSummaryV2;
  readonly members: readonly AssignmentMemberV2[];
  readonly allowedActions: { readonly assign: boolean; readonly clear: boolean };
}
export interface SetGoalAssignmentV2 {
  readonly workspaceId: string;
  readonly expectedStreamVersion: number;
  readonly responsiblePrincipalId: string | null;
}
export type GoalListItemV2 = GoalV2 & { readonly assignment: GoalAssignmentSummaryV2 };
export interface CommandNotificationV2 {
  readonly workspaceId: string;
  readonly expectedStreamVersion: number;
  readonly command: 'mark_read' | 'mark_unread';
}
