// SPDX-License-Identifier: Apache-2.0
import type { AgentCatalogV2, CodingReconciliationDecisionV2, CodingReconciliationViewV2 } from "./api.js";
import type { JsonObject, JsonValue } from "./json.js";
import type {
  Approval, Asset, AssetTombstone, CodingRunnerConfigurationV1, Deliverable, Execution,
  MemoryRecord, MemoryTombstone, PluginInstallation, PluginPurgeResult, RunnerBinaryInspectionV1,
  ShareGrant, Thread, ThreadTurnsView, Workspace, WorkspaceMembership,
} from "./models.js";
import type { EvidenceLevel, Interview, OpportunityAggregate, OpportunityState } from "./opc.js";
import type { PluginManifestV1 } from "./plugin.js";
import type { WorkspacePluginSurfaceV1 } from "./plugin-surfaces.js";
import type { BusinessActionV1 } from "./business-effects.js";
import type { BusinessCandidateContentV1, BusinessCandidateV1 } from "./business-candidates.js";

export interface HostHealthV2 {
  readonly core: { readonly status: "healthy" };
  readonly plugins: readonly { readonly pluginId: string; readonly status: "healthy" | "degraded"; readonly message?: string }[];
}
export interface ReadinessV2 {
  readonly ready: boolean;
  readonly issues: readonly { readonly code: string; readonly message: string; readonly action: string }[];
}
export interface InboxItemV2 {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly executionId?: string;
  readonly navigation?: {
    readonly threadId: string;
    readonly pluginId: string;
    readonly resourceRef?: Thread["resourceRef"];
  };
  readonly revocationId?: string;
  readonly streamVersion?: number;
  readonly kind: "approval" | "agent_question" | "credential" | "failure" | "reconciliation";
  readonly title: string;
  readonly summary: string;
  readonly risk?: string;
  readonly resourceSummary?: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly status: "open" | "resolved";
}
export interface DeliverableSummaryV2 {
  readonly id: string;
  readonly pluginId: string;
  readonly title: string;
  readonly outcome: string;
  readonly decision?: string;
  readonly nextAction?: string;
  readonly createdAt: string;
}
export interface HomeActionV2 {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly pluginId?: string;
}
export interface HomeApprovalV2 {
  readonly id: string;
  readonly title: string;
  readonly intent: string;
  readonly resourceSummary: string;
  readonly risk: string;
  readonly expiresAt: string;
  readonly streamVersion: number;
}
export interface HomeV2 {
  readonly todayActions: readonly HomeActionV2[];
  readonly blockers: readonly HomeActionV2[];
  readonly approvals: readonly HomeApprovalV2[];
  readonly recentDeliverables: readonly DeliverableSummaryV2[];
}
export interface ActivityV2 {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly cost: string;
  readonly occurredAt: string;
}
export interface MemorySummaryV2 {
  readonly id: string;
  readonly namespace: string;
  readonly resourceId: string;
  readonly summary: string;
  readonly source: string;
  readonly confidence: number;
  readonly status: MemoryRecord["status"];
  readonly streamVersion: number;
}
export type MemoryViewV2 = Omit<MemoryRecord, "protectedPayloadRef"> & { readonly value: JsonObject };
export interface ModelConnectionV2 {
  readonly defaultForNewExecutions?: boolean;
  readonly id: string;
  readonly tenantId: string;
  readonly presetId: string;
  readonly displayName: string;
  readonly defaultModel: string;
  readonly discoveredModels: readonly string[];
  readonly status: "pending" | "ready" | "invalid";
  readonly streamVersion: number;
}
export interface ModelPresetV2 {
  readonly id: string;
  readonly displayName: string;
  readonly secretLabel: string;
  readonly suggestedModels: readonly string[];
}
export type PluginCatalogItemV2 = Pick<PluginManifestV1,
  "version" | "displayName" | "description" | "license" | "permissions" | "packageSha256" | "release"> & {
  readonly pluginId: string;
  readonly trustBoundary: "process_equivalent";
};
export interface OfficialPluginV2 {
  readonly pluginId: string;
  readonly version: string;
  readonly activeByDefault: false;
  readonly trustBoundary: "process_equivalent";
}
export interface OpportunityEvidenceV2 {
  readonly id: string;
  readonly stance: "supporting" | "opposing" | "neutral";
  readonly summary: string;
  readonly source: string;
  readonly capturedAt: string;
  readonly humanConfirmed?: boolean;
}
export interface OpportunitySummaryV2 {
  readonly id: string;
  readonly title: string;
  readonly targetCustomer: string;
  readonly problem: string;
  readonly falsifiableHypothesis: string;
  readonly status: OpportunityState;
  readonly evidenceLevel: EvidenceLevel;
  readonly evidence: readonly OpportunityEvidenceV2[];
  readonly gaps: readonly string[];
  readonly nextAction: string;
  readonly streamVersion: number;
}
export type OpportunityViewV2 = Omit<OpportunityAggregate, "interviews"> & {
  readonly interviews: readonly (Interview & { readonly rawRecord: string })[];
};
export interface OpcDeliverableV2 {
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly validationStatus: string;
  readonly nextAction: string;
  readonly content: JsonObject;
}
export type StoredOpcDeliverableV2 = Deliverable & { readonly validationStatus: string; readonly content: JsonObject };
export interface ReadOnlySampleV2 {
  readonly id: string;
  readonly pluginId: "opc" | "coding";
  readonly effectClass: "external_read" | "local_read";
  readonly status: "completed";
  readonly summary: string;
}
export interface CodingRepositoryV2 {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly rootRealPath: string;
  readonly vcs: "git";
  readonly createdAt: string;
  readonly streamVersion: number;
  readonly updatedAt: string;
}
export type CodingTaskStatusV2 = "active" | "waiting_approval" | "completed" | "needs_human_decision" | "needs_reconciliation" | "failed" | "cancelled";
export interface CodingTaskV2 {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly title: string;
  readonly request: string;
  readonly stage: "discover" | "specify" | "impact" | "implement" | "verify" | "approve" | "learn";
  readonly status: CodingTaskStatusV2;
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CodingTaskSummaryV2 {
  readonly id: string;
  readonly title: string;
  readonly repository: string;
  readonly status: CodingTaskStatusV2;
  readonly diffSummary?: string;
  readonly diff?: string;
  readonly checks: readonly { readonly name: string; readonly status: "pass" | "fail" | "pending" }[];
  readonly approval?: string;
  readonly nextAction: string;
  readonly advanced?: { readonly harnessDigest: string; readonly candidateCount: number; readonly remainingBudget: string };
}
export interface CodingCandidateV2 {
  readonly id: string;
  readonly taskId: string;
  readonly runnerId: string;
  readonly sequence: number;
  readonly baseRevision: string;
  readonly diffDigest: string;
  readonly summary: string;
  readonly sandbox: { readonly enforced: boolean; readonly fallbackUsed: boolean; readonly evidenceDigest?: string };
}
export interface CodingGateV2 {
  readonly candidateId: string;
  readonly status: "passed" | "failed";
  readonly authoritative: boolean;
  readonly evidenceDigest?: string;
  readonly checks: readonly { readonly id: string; readonly status: "passed" | "failed" | "error" | "missing"; readonly summary: string }[];
  readonly reason?: string;
}
export interface CodingControlPlaneV2 {
  readonly protocol: "coding-v2";
  readonly specDigest: string;
  readonly governanceDigest: string;
  readonly harnessDigest: string;
  readonly sandboxDigest: string;
  readonly repositoryIndexDigest: string;
}
export type CodeEvidenceV2 = Omit<CodingControlPlaneV2, "protocol"> & {
  readonly taskId: string;
  readonly candidateId: string;
  readonly runnerId: string;
  readonly gateEvidenceDigest: string;
  readonly diffDigest: string;
  readonly digest: string;
};
export interface CodingResultV2 {
  readonly task: CodingTaskV2;
  readonly runnerId: string;
  readonly status: Exclude<CodingTaskStatusV2, "active">;
  readonly candidates: readonly CodingCandidateV2[];
  readonly gates: readonly CodingGateV2[];
  readonly evidence?: CodeEvidenceV2;
  readonly approval?: "approved_once" | "denied" | "pending";
  readonly deliverable?: { readonly kind: "code_change"; readonly title: string; readonly summary: string; readonly diffDigest: string; readonly nextStep: string };
  readonly nextStep: string;
  readonly limits: { readonly maxRepairAttempts: number; readonly maxDurationMs: number };
  readonly controlPlane: CodingControlPlaneV2;
}
export interface CodingReconciliationResultV2 {
  readonly decision: CodingReconciliationDecisionV2;
  readonly status: "settled" | "verification_pending";
  readonly execution: Execution;
  readonly codingExecution: { readonly executionId: string; readonly status: CodingResultV2["status"]; readonly streamVersion: number; readonly result: CodingResultV2 };
  readonly task: CodingTaskV2;
  readonly cleanupJobId?: string;
  readonly verificationJobId?: string;
  readonly newExecution?: Execution;
}
export type CodingRunnerViewV2 =
  | { readonly runnerId: "builtin"; readonly external: false; readonly status: "ready" }
  | { readonly runnerId: "claude-cli" | "codex-cli"; readonly external: true; readonly status: "not_configured" }
  | (CodingRunnerConfigurationV1 & { readonly external: true });

/** JSON extension points are explicit; every fixed Host operation has a concrete DTO. */
export interface ApiOutputsV2 {
  readonly createBusinessAction: BusinessActionV1;
  readonly getBusinessAction: BusinessActionV1;
  readonly reconcileBusinessAction: BusinessActionV1;
  readonly getBusinessExecutionAuthority: { readonly allowed: true; readonly actionDigest: string; readonly expiresAt: string; readonly leaseExpiresAt: string; readonly actionId: string; readonly operationKey: string };
  readonly createBusinessCandidate: BusinessCandidateV1;
  readonly getBusinessCandidate: BusinessCandidateV1;
  readonly getBusinessCandidateContent: BusinessCandidateContentV1;
  readonly runPluginCommand: JsonValue;
  readonly getPluginSurfaces: readonly WorkspacePluginSurfaceV1[];
  readonly listPluginCatalog: readonly PluginCatalogItemV2[];
  readonly getOpenApi: JsonObject;
  readonly getHealth: HostHealthV2;
  readonly getReadiness: ReadinessV2;
  readonly setup: { readonly tenantId: string; readonly principalId: string };
  readonly listWorkspaces: readonly Workspace[];
  readonly createWorkspace: Workspace;
  readonly getWorkspace: Workspace;
  readonly updateWorkspace: Workspace;
  readonly listWorkspaceMembers: readonly WorkspaceMembership[];
  readonly setWorkspaceMember: WorkspaceMembership;
  readonly removeWorkspaceMember: WorkspaceMembership;
  readonly getWorkspaceAgentCatalog: AgentCatalogV2;
  readonly getWorkspaceHome: HomeV2;
  readonly listThreads: readonly Thread[];
  readonly createThread: Thread;
  readonly listThreadTurns: ThreadTurnsView;
  readonly createTurn: Execution;
  readonly streamWorkspaceEvents: string;
  readonly commandExecution: Execution;
  readonly listInbox: readonly InboxItemV2[];
  readonly retryKeyRevocation: { readonly id: string; readonly status: "pending" | "running" | "needs_reconciliation" | "completed"; readonly streamVersion: number };
  readonly listActivity: readonly ActivityV2[];
  readonly decideApproval: Approval;
  readonly listDeliverables: readonly DeliverableSummaryV2[];
  readonly createAssets: readonly Asset[];
  readonly getAsset: Asset;
  readonly downloadAsset: ArrayBuffer;
  readonly deleteAsset: AssetTombstone;
  readonly listMemories: readonly MemorySummaryV2[];
  readonly proposeMemory: MemoryViewV2;
  readonly reviseMemoryProposal: MemoryViewV2;
  readonly deleteMemory: MemoryTombstone;
  readonly decideMemory: MemoryViewV2;
  readonly listShareGrants: readonly ShareGrant[];
  readonly createShareGrant: ShareGrant;
  readonly revokeShareGrant: ShareGrant;
  readonly listModelPresets: readonly ModelPresetV2[];
  readonly listModelConnections: readonly ModelConnectionV2[];
  readonly createModelConnection: ModelConnectionV2;
  readonly probeModelConnection: ModelConnectionV2;
  readonly installPlugin: PluginInstallation;
  readonly listPluginInstallations: readonly (OfficialPluginV2 | PluginInstallation)[];
  readonly updatePlugin: PluginInstallation;
  readonly disablePlugin: PluginInstallation;
  readonly purgePlugin: PluginPurgeResult;
  readonly activatePlugin: Workspace;
  readonly deactivatePlugin: Workspace;
  readonly listOpcOpportunities: readonly OpportunitySummaryV2[];
  readonly createOpcOpportunity: OpportunityAggregate;
  readonly getOpcOpportunity: OpportunityViewV2;
  readonly commandOpcOpportunity: OpportunityViewV2;
  readonly previewOpcDeliverables: readonly OpcDeliverableV2[];
  readonly exportOpcDeliverables: readonly StoredOpcDeliverableV2[];
  readonly runOpcReadOnlySample: ReadOnlySampleV2;
  readonly createCodingRepository: CodingRepositoryV2;
  readonly listCodingRepositories: readonly CodingRepositoryV2[];
  readonly listCodingTasks: readonly CodingTaskSummaryV2[];
  readonly createCodingTask: CodingTaskV2;
  readonly runCodingReadOnlySample: ReadOnlySampleV2;
  readonly listCodingRunners: readonly CodingRunnerViewV2[];
  readonly inspectCodingRunner: RunnerBinaryInspectionV1;
  readonly confirmCodingRunner: CodingRunnerConfigurationV1;
  readonly getCodingReconciliation: CodingReconciliationViewV2;
  readonly decideCodingReconciliation: CodingReconciliationResultV2;
}
