// SPDX-License-Identifier: Apache-2.0
import type { CodingRunnerId, ResourceRef, ToolEffectClass, VersionedEntity } from './models.js';

export interface CoordinationAuthorityV2 {
  readonly toolIds: readonly string[];
  readonly dataScopes: readonly ResourceRef[];
  readonly autoAllowedEffects: readonly ToolEffectClass[];
}
export interface CoordinationBudgetV2 {
  readonly currency: string;
  readonly maxTokens: number;
  readonly maxCostMinorUnits: string;
}
export interface CoordinationLimitsV2 {
  readonly maxParallel: number;
  readonly maxNodes: number;
  readonly maxAttempts: number;
  readonly maxDepth: number;
  readonly maxReworkRounds?: number;
}
export interface CoordinationNodeV2 {
  readonly id: string;
  readonly kind?: 'agent' | 'human_decision' | 'join';
  readonly dependsOn: readonly string[];
  readonly pluginId: string;
  readonly agentDefinitionId: string;
  readonly modelBindingId: string;
  readonly runnerId?: CodingRunnerId;
  readonly pluginPackageSha256?: string;
  readonly role: CoordinationAuthorityV2;
  readonly budget: CoordinationBudgetV2;
}
export interface CoordinationRunV2 extends VersionedEntity {
  readonly groupId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly initiatedBy: string;
  readonly membershipStreamVersion: number;
  readonly grant: CoordinationAuthorityV2;
  readonly budgets: readonly CoordinationBudgetV2[];
  readonly nodes: readonly CoordinationNodeV2[];
  readonly limits: CoordinationLimitsV2;
  readonly deadlineAt: string;
  readonly status: 'active' | 'paused' | 'cancelled' | 'superseded' | 'completed';
}
export interface CoordinationAttemptV2 extends VersionedEntity {
  readonly groupId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly revisionId: string;
  readonly nodeId: string;
  readonly ordinal: number;
  readonly executionId: string;
  readonly generation: number;
  readonly threadId: string;
  readonly jobId: string;
  readonly requestDigest: string;
  readonly status: 'queued' | 'completed' | 'failed' | 'paused' | 'interrupted' | 'cancelled' | 'needs_reconciliation';
  readonly reservation: {
    readonly budget: CoordinationBudgetV2;
    readonly status: 'reserved' | 'settled';
    readonly usage?: { readonly currency: string; readonly tokens: number; readonly costMinorUnits: string };
  };
}
export interface CoordinationGroupV2 extends VersionedEntity {
  readonly workspaceId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly currentRunId: string;
  readonly budgets: readonly CoordinationBudgetV2[];
  readonly limits: CoordinationLimitsV2;
  readonly nodeIds: readonly string[];
  readonly deadlineAt: string;
  readonly reworkRounds?: number;
  readonly initialAccounting?: CoordinationInitialAccountingV2;
  readonly counterReservations?: readonly CoordinationCounterReservationV2[];
}
/** A one-time, verified charge from the original non-coordinated execution. Its Job is never rewritten. */
export interface CoordinationInitialAccountingV2 {
  readonly executionId: string; readonly jobId: string; readonly generation: number; readonly revisionId: string;
  readonly executionStreamVersion: number; readonly jobStreamVersion: number; readonly runtimeLastSequence: number;
  readonly usage: { readonly currency: string; readonly tokens: number; readonly costMinorUnits: string };
  readonly usageEvidenceDigest: string; readonly deadlineAt: string;
  readonly counterReservations: readonly { readonly kind: string; readonly id: string; readonly limit: number }[];
}
export interface CoordinationCounterReservationV2 {
  readonly kind: string; readonly id: string; readonly executionId: string; readonly limit: number;
}
export interface CoordinationNodeReuseInputV2 {
  readonly nodeId: string; readonly sourceAttemptId: string; readonly inputDigest: string; readonly outputDigest: string;
}
export interface CoordinationNodeReuseV2 extends VersionedEntity, CoordinationNodeReuseInputV2 {
  readonly workspaceId: string; readonly groupId: string; readonly runId: string; readonly revisionId: string;
}
export interface CoordinationControlV2 extends VersionedEntity {
  readonly workspaceId: string;
  readonly runId: string;
  readonly revisionId: string;
  readonly nodeId: string;
  readonly kind: 'human_decision' | 'join';
  readonly decision: 'approved' | 'rejected';
  readonly decidedBy: string;
  readonly evidenceDigest: string;
}
export interface CoordinationBindingV2 {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly revisionId: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly attemptId?: string;
}
