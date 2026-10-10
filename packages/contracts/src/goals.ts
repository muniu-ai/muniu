// SPDX-License-Identifier: Apache-2.0
import type { CodingRunnerId, ResourceRef, ToolEffectClass } from "./models.js";

export interface AgentSchedulingRequestV2 {
  readonly runnerId: "auto" | CodingRunnerId;
  readonly strategy: "quality" | "balanced" | "cost";
  readonly modelBindingId?: string;
  readonly expectedValueMinorUnits?: string;
  readonly timeCostMinorUnitsPerHour?: string;
}
export interface AgentSchedulingCandidateV2 {
  readonly id: string; readonly label: string; readonly runnerId: CodingRunnerId; readonly modelBindingId: string;
  readonly fingerprint: string; readonly currency: string; readonly samples: number; readonly accepted: number;
  readonly qualityLowerBound: number; readonly evidence: "observed" | "insufficient";
  readonly expectedCostMinorUnits: string | null; readonly expectedDurationMs: number;
  readonly expectedTotalCostMinorUnits: string | null; readonly expectedNetValueMinorUnits: string | null;
  readonly roiBasisPoints: number | null; readonly eligible: boolean; readonly reasons: readonly string[];
}
export interface AgentSchedulingDecisionV2 {
  readonly algorithm: "quality-roi-v1"; readonly request: AgentSchedulingRequestV2;
  readonly selectedId: string; readonly candidates: readonly AgentSchedulingCandidateV2[];
  readonly taskClass: string; readonly evidenceDigest: string;
}

export interface GoalResourceRefV2 extends ResourceRef { readonly streamVersion: number }
export interface GoalBudgetV2 {
  readonly maxTokens: number;
  readonly maxCostMinorUnits: string;
  readonly currency: string;
  readonly maxDurationMs: number;
}
export interface GoalUsageV2 { readonly tokens: number; readonly costMinorUnits: string; readonly currency: string }
export interface GoalDeliverableSpecV2 {
  readonly key: string;
  readonly title: string;
  readonly required: boolean;
  readonly criteria: readonly { readonly id: string; readonly description: string }[];
}
export interface GoalPlanProposalV2 {
  readonly domainInputDigest: string;
  readonly threadStreamVersion: number;
  readonly pluginId: "opc" | "coding";
  readonly pluginVersion: string;
  readonly pluginPackageSha256?: string;
  readonly agentDefinitionId: string;
  readonly modelBindingId: string;
  readonly modelConnectionStreamVersion: number;
  readonly model: string;
  readonly runnerId: CodingRunnerId;
  readonly runnerBinding?: { readonly configurationStreamVersion: number; readonly identityDigest: string };
  readonly scheduling?: AgentSchedulingDecisionV2;
  readonly toolIds: readonly string[];
  readonly dataScopes: readonly ResourceRef[];
  readonly autoAllowedEffects: readonly ToolEffectClass[];
}
export interface GoalPlanRevisionV2 extends GoalPlanProposalV2 {
  readonly id: string;
  readonly goalId: string;
  readonly threadId: string;
  readonly revision: number;
  readonly inputVersion: number;
  readonly criteriaVersion: string;
  readonly budget: GoalBudgetV2;
  readonly resourceRefs: readonly GoalResourceRefV2[];
  readonly deliverables: readonly GoalDeliverableSpecV2[];
  readonly digest: string;
  readonly createdAt: string;
}
export interface GoalOutputRefV2 {
  readonly key: string;
  readonly resourceRef: GoalResourceRefV2;
  readonly digest: string;
  readonly criteriaVersion: string;
  readonly preview: string;
  readonly sourceRefs: readonly GoalResourceRefV2[];
  readonly checks: readonly {
    readonly checkId: string;
    readonly status: "passed" | "failed";
    readonly evidenceRefs: readonly GoalResourceRefV2[];
  }[];
}
export interface GoalExecutionObservationV2 {
  readonly executionStreamVersion: number;
  readonly generation: number;
  readonly usage?: GoalUsageV2;
  readonly outputs?: readonly GoalOutputRefV2[];
}
export interface GoalExecutionRefV2 {
  readonly executionId: string;
  readonly threadId: string;
  readonly planRevisionId: string;
  readonly generation: number;
}
export interface GoalDeliverySetV2 {
  readonly id: string;
  readonly goalId: string;
  readonly planRevisionId: string;
  readonly criteriaVersion: string;
  readonly items: readonly GoalOutputRefV2[];
  readonly digest: string;
  readonly createdAt: string;
}
export interface GoalDeliveryAcceptanceV2 {
  readonly id: string;
  readonly goalId: string;
  readonly deliverySetId: string;
  readonly criteriaVersion: string;
  readonly principalId: string;
  readonly acceptedAt: string;
  readonly items: readonly { readonly key: string; readonly digest: string; readonly reviewedCriterionIds: readonly string[] }[];
}
export type GoalStatusV2 = "draft" | "awaiting_authorization" | "running" | "waiting_approval"
  | "needs_reconciliation" | "failed" | "awaiting_acceptance" | "accepted" | "cancelled";
export interface GoalV2 {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly objective: string;
  readonly inputVersion: number;
  readonly criteriaVersion: string;
  readonly deliverables: readonly GoalDeliverableSpecV2[];
  readonly resourceRefs: readonly GoalResourceRefV2[];
  readonly budget: GoalBudgetV2;
  readonly status: GoalStatusV2;
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly planRevisionId?: string;
  readonly executionRef?: GoalExecutionRefV2;
  readonly reservation?: { readonly status: "reserved" | "unknown" | "settled"; readonly actual?: GoalUsageV2 };
  readonly authorization?: { readonly planDigest: string; readonly principalId: string; readonly membershipStreamVersion: number };
  readonly deliverySetId?: string;
  readonly acceptanceId?: string;
  readonly cancellationRequestedAt?: string;
  readonly reasonCode?: string;
}
export interface GoalDetailV2 { readonly goal: GoalV2; readonly plan: GoalPlanRevisionV2 | null; readonly deliverySet: GoalDeliverySetV2 | null }
