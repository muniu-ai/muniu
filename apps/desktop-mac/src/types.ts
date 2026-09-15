// SPDX-License-Identifier: Apache-2.0
import type * as Contracts from "@mn/contracts";

export type ViewMode = "business" | "professional";
export type ProductPluginId = "opc" | "coding";
export type WorkspaceSummary = Pick<Contracts.Workspace, "id" | "name" | "viewMode" | "activePluginIds" | "streamVersion">;
export type WorkspaceMemberSummary = Contracts.WorkspaceMembership;
export type AgentThreadSummary = Contracts.Thread;
export type AgentExecutionStatus = Contracts.ExecutionStatus;
export type AgentExecutionSummary = Contracts.Execution;
export type ThreadTurnEntry = Contracts.ThreadTurnSessionEntry;
export type ThreadTurnView = Contracts.ThreadTurnView;
export type ThreadTurnsView = Contracts.ThreadTurnsView;
export type AgentCatalog = Contracts.AgentCatalogV2;
export type AgentCatalogAgent = Contracts.AgentCatalogAgentV2;
export type AgentCatalogSkill = Contracts.AgentCatalogSkillV2;
export type HomeSummary = Contracts.HomeV2;
export type SummaryItem = Contracts.HomeActionV2;
export type ApprovalSummary = Contracts.HomeApprovalV2;
export type InboxItemSummary = Contracts.InboxItemV2;
export type CodingReconciliationDecision = Contracts.CodingReconciliationDecisionV2;
export type CodingRepositorySummary = Contracts.CodingRepositoryV2;
export type CodingReconciliationView = Contracts.CodingReconciliationViewV2;
export type CodingReconciliationDecisionResult = Contracts.CodingReconciliationResultV2;
export type DeliverableSummary = Contracts.DeliverableSummaryV2;
export type ActivitySummary = Contracts.ActivityV2;
export type MemorySummary = Contracts.MemorySummaryV2;
export type OpportunitySummary = Contracts.OpportunitySummaryV2;
export type OpportunityState = Contracts.OpportunityState;
export type OpcOpportunityCommand =
  | "frame"
  | "start_research"
  | "record_signal"
  | "start_interviewing"
  | "record_interview"
  | "annotate_interview"
  | "start_evaluation"
  | "record_experiment"
  | "propose_commitment"
  | "confirm_commitment"
  | "prepare_offer"
  | "decide"
  | "pause"
  | "resume"
  | "abandon";
export type OpportunityDetail = Contracts.OpportunityViewV2;
export type OpportunityHypothesis = Contracts.Hypothesis;
export type OpportunitySignal = Contracts.Signal;
export type OpportunityInterview = Contracts.OpportunityViewV2["interviews"][number];
export type AssetSummary = Contracts.Asset;
export type OpportunityExperiment = Contracts.Experiment;
export type OpportunityCommitmentEvidence = Contracts.CommitmentEvidence;
export type OpportunityOffer = Contracts.MinimumPaidOffer;
export type OpportunityDecision = Contracts.Decision;
export type OpcDeliverablePreview = Contracts.OpcDeliverableV2;
export type EvidenceSummary = Contracts.OpportunityEvidenceV2;
export type CodingTaskSummary = Contracts.CodingTaskSummaryV2;
export type PluginHealth = Contracts.HostHealthV2["plugins"][number];
export type ApiFailure = Contracts.ApiErrorV2;
