// SPDX-License-Identifier: Apache-2.0
import type { GoalBudgetV2, GoalDeliverableSpecV2, GoalDeliverySetV2, GoalPlanProposalV2, GoalPlanRevisionV2, GoalResourceRefV2, GoalV2 } from "./goals.js";
import type { TeamSkillRefV2 } from "./team-skills.js";
import type { CodingRunnerId, ToolEffectClass } from "./models.js";

export type TeamTemplateIdV1 = "research-summary" | "business-proposal" | "code-delivery";
export interface TeamTemplateSummaryV1 {
  readonly id: TeamTemplateIdV1;
  readonly version: "1";
  readonly title: string;
  readonly description: string;
  readonly pluginId: "opc" | "coding";
  readonly nodeCount: number;
  readonly available: boolean;
  readonly unavailableReason?: string;
}
export interface TeamPlanLimitsV1 {
  readonly maxParallelNodes: number;
  readonly maxDelegationDepth: number;
  readonly maxNodes: number;
  readonly maxAttempts: number;
  readonly maxReworkRounds: number;
}
export type TeamOutputKindV1 = "analysis" | "artifact" | "evidence" | "self_assessment" | "review" | "decision";
export type TeamNodeInputV1 =
  | { readonly key: string; readonly kind: "goal" }
  | { readonly key: string; readonly kind: "source"; readonly resourceRef: GoalResourceRefV2 }
  | { readonly key: string; readonly kind: "node_output"; readonly nodeId: string; readonly outputKey: string };
export interface TeamNodeOutputSpecV1 {
  readonly key: string;
  readonly kind: TeamOutputKindV1;
  readonly description: string;
}
export interface TeamCapabilityRefV1 { readonly id: string; readonly version: string; readonly digest: string }
/** A Host-verified capability declaration describes requirements; it grants no authority. */
export interface TeamAgentCapabilityV1 extends TeamCapabilityRefV1 {
  readonly pluginId: "opc" | "coding";
  readonly agentDefinitionId: string;
  readonly inputKinds: readonly TeamNodeInputV1["kind"][];
  readonly outputKinds: readonly TeamOutputKindV1[];
  readonly toolIds: readonly string[];
  readonly effectClasses: readonly ToolEffectClass[];
  readonly runnerIds: readonly CodingRunnerId[];
  readonly isolation: "none" | "required_sandbox";
  readonly dataDestinations: readonly string[];
  readonly costControl: "hard_limit" | "observable" | "unknown";
  readonly independentReview: boolean;
  readonly evaluationVersion: string;
}
export interface TeamPlanNodeBaseV1 {
  readonly id: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly inputs: readonly TeamNodeInputV1[];
  readonly outputs: readonly TeamNodeOutputSpecV1[];
}
export interface TeamAgentNodeV1 extends TeamPlanNodeBaseV1 {
  readonly kind: "agent";
  readonly roleId: string;
  readonly executor: GoalPlanProposalV2;
  readonly capabilityRef: TeamCapabilityRefV1;
  readonly budget: GoalBudgetV2;
  readonly review?: { readonly independent: true; readonly producerNodeIds: readonly string[] };
}
export interface TeamHumanDecisionNodeV1 extends TeamPlanNodeBaseV1 {
  readonly kind: "human_decision";
  readonly prompt: string;
  readonly choices: readonly ("continue" | "stop")[];
}
export interface TeamJoinNodeV1 extends TeamPlanNodeBaseV1 {
  readonly kind: "join";
  readonly mappings: readonly { readonly outputKey: string; readonly fromNodeId: string; readonly fromOutputKey: string }[];
}
export type TeamPlanNodeV1 = TeamAgentNodeV1 | TeamHumanDecisionNodeV1 | TeamJoinNodeV1;
export interface TeamDeliverableBindingV1 {
  readonly deliverableKey: string;
  readonly nodeId: string;
  readonly outputKey: string;
}
export interface GoalTeamPlanProposalV2 {
  readonly skillRef?: TeamSkillRefV2;
  readonly outputFormat?: "items-v1";
  readonly kind: "team-v1";
  readonly template: { readonly id: TeamTemplateIdV1; readonly version: "1"; readonly digest: string };
  readonly pluginId: "opc" | "coding";
  readonly domainInputDigest: string;
  readonly threadStreamVersion: number;
  readonly nodes: readonly TeamPlanNodeV1[];
  readonly deliverableBindings: readonly TeamDeliverableBindingV1[];
  readonly limits: TeamPlanLimitsV1;
}
export interface GoalTeamPlanRevisionV2 extends GoalTeamPlanProposalV2 {
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
/** The first single-executor plan remains unchanged; later revisions use one coordinated executor. */
export interface GoalSinglePlanProposalV2 extends Omit<GoalTeamPlanProposalV2, 'kind' | 'template'> {
  readonly kind: 'single-v2';
}
export interface GoalSinglePlanRevisionV2 extends GoalSinglePlanProposalV2 {
  readonly id: string; readonly goalId: string; readonly threadId: string; readonly revision: number;
  readonly inputVersion: number; readonly criteriaVersion: string; readonly budget: GoalBudgetV2;
  readonly resourceRefs: readonly GoalResourceRefV2[]; readonly deliverables: readonly GoalDeliverableSpecV2[];
  readonly digest: string; readonly createdAt: string;
}
export type GoalCoordinatedPlanProposalV2 = GoalTeamPlanProposalV2 | GoalSinglePlanProposalV2;
export type GoalCoordinatedPlanV2 = GoalTeamPlanRevisionV2 | GoalSinglePlanRevisionV2;
export type GoalPlanV2 = GoalPlanRevisionV2 | GoalCoordinatedPlanV2;
export function isCoordinatedGoalPlan(plan: GoalPlanV2 | null | undefined): plan is GoalCoordinatedPlanV2 {
  return !!plan && 'kind' in plan && (plan.kind === 'team-v1' || plan.kind === 'single-v2');
}
export interface GoalCoordinatedDetailV2 {
  readonly goal: GoalV2; readonly plan: GoalCoordinatedPlanV2; readonly deliverySet: GoalDeliverySetV2 | null; readonly runId?: string;
}
export interface GoalTeamDetailV2 {
  readonly goal: GoalV2;
  readonly plan: GoalTeamPlanRevisionV2;
  readonly deliverySet: GoalDeliverySetV2 | null;
  readonly runId?: string;
}
export interface ProposeTeamGoalPlanV2 {
  readonly skillRef?: TeamSkillRefV2;
  readonly workspaceId: string;
  readonly expectedStreamVersion: number;
  readonly kind: "team-v1";
  readonly templateId: TeamTemplateIdV1;
  readonly templateVersion: "1";
  readonly modelBindingId: string;
}
