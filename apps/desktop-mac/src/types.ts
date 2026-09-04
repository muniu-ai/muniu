export type ViewMode = "business" | "professional";
export type ProductPluginId = "opc" | "coding";

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly viewMode: ViewMode;
  readonly activePluginIds: readonly string[];
  readonly streamVersion: number;
}

export interface WorkspaceMemberSummary {
  readonly id: string;
  readonly principalId: string;
  readonly workspaceRole: "owner" | "operator" | "reviewer" | "viewer";
  readonly streamVersion: number;
}

export interface AgentCatalog {
  readonly agents: readonly AgentCatalogAgent[];
  readonly skills: readonly AgentCatalogSkill[];
}

export interface AgentCatalogAgent {
  readonly pluginId: string;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
}

export interface AgentCatalogSkill {
  readonly pluginId: string;
  readonly id: string;
  readonly title: string;
  readonly expectedOutcome: string;
  readonly exampleInput?: string;
  readonly source: string;
  readonly license: string;
  readonly version: string;
  readonly permissionIds: readonly string[];
  readonly installation: "active";
}

export interface HomeSummary {
  readonly todayActions: readonly SummaryItem[];
  readonly blockers: readonly SummaryItem[];
  readonly approvals: readonly ApprovalSummary[];
  readonly recentDeliverables: readonly DeliverableSummary[];
}

export interface SummaryItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly pluginId?: ProductPluginId;
}

export interface ApprovalSummary {
  readonly id: string;
  readonly title: string;
  readonly intent: string;
  readonly resourceSummary: string;
  readonly risk: string;
  readonly expiresAt: string;
  readonly streamVersion: number;
}

export interface DeliverableSummary {
  readonly id: string;
  readonly pluginId: ProductPluginId;
  readonly title: string;
  readonly outcome: string;
  readonly decision?: string;
  readonly nextAction?: string;
  readonly createdAt: string;
}

export interface ActivitySummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly cost: string;
  readonly occurredAt: string;
}

export interface MemorySummary {
  readonly id: string;
  readonly namespace: string;
  readonly resourceId: string;
  readonly summary: string;
  readonly source: string;
  readonly confidence: number;
  readonly status: "proposed" | "accepted" | "rejected" | "invalidated";
  readonly streamVersion: number;
}

export interface OpportunitySummary {
  readonly id: string;
  readonly title: string;
  readonly targetCustomer: string;
  readonly problem: string;
  readonly falsifiableHypothesis: string;
  readonly status: string;
  readonly evidenceLevel: "none" | "interest" | "commitment" | "paid";
  readonly evidence: readonly EvidenceSummary[];
  readonly gaps: readonly string[];
  readonly nextAction: string;
  readonly streamVersion: number;
}

export type OpportunityState =
  | "captured"
  | "framed"
  | "researching"
  | "interviewing"
  | "evaluating"
  | "offer_ready"
  | "decided"
  | "paused"
  | "abandoned";

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

export interface OpportunityDetail {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly rawCapture: string;
  readonly state: OpportunityState;
  readonly evidenceLevel: OpportunitySummary["evidenceLevel"];
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly hypotheses: readonly OpportunityHypothesis[];
  readonly signals: readonly OpportunitySignal[];
  readonly interviews: readonly OpportunityInterview[];
  readonly experiments: readonly OpportunityExperiment[];
  readonly commitmentEvidence: readonly OpportunityCommitmentEvidence[];
  readonly minimumPaidOffer?: OpportunityOffer;
  readonly decision?: OpportunityDecision;
}

export interface OpportunityHypothesis {
  readonly id: string;
  readonly targetCustomer: string;
  readonly problem: string;
  readonly statement: string;
  readonly createdAt: string;
}

export interface OpportunitySignal {
  readonly id: string;
  readonly sourceKind: "public_web" | "pasted" | "file" | "manual";
  readonly sourceUrl?: string;
  readonly sourceAssetId?: string;
  readonly observedAt: string;
  readonly excerpt?: string;
  readonly summary: string;
  readonly relationship: "support" | "oppose" | "neutral";
  readonly evidenceKind: "context" | "interest";
}

export interface OpportunityInterview {
  readonly id: string;
  readonly participantRef: string;
  readonly occurredAt: string;
  readonly rawRecordAssetId: string;
  readonly rawRecord: string;
  readonly annotations: readonly { readonly id: string; readonly text: string }[];
}

export interface AssetSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly protected: boolean;
  readonly streamVersion: number;
}

export interface OpportunityExperiment {
  readonly id: string;
  readonly question: string;
  readonly method: string;
  readonly successCriterion: string;
  readonly outcome?: string;
  readonly status: "planned" | "completed";
}

export interface OpportunityCommitmentEvidence {
  readonly id: string;
  readonly level: "commitment" | "paid";
  readonly description: string;
  readonly sourceRef: string;
  readonly status: "proposed" | "confirmed";
  readonly confirmedAt?: string;
}

export interface OpportunityOffer {
  readonly id: string;
  readonly targetCustomer: string;
  readonly promisedOutcome: string;
  readonly inScope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly price: {
    readonly amountMinor: string;
    readonly currency: string;
    readonly assumption: string;
  };
  readonly deliveryFormat: string;
  readonly duration: string;
  readonly acceptanceMethod: string;
  readonly nextCustomerAction: string;
  readonly risks: readonly string[];
}

export interface OpportunityDecision {
  readonly id: string;
  readonly choice: "pursue" | "revise" | "stop";
  readonly rationale: string;
  readonly decidedAt: string;
}

export interface OpcDeliverablePreview {
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly validationStatus: string;
  readonly nextAction: string;
  readonly content: Readonly<Record<string, unknown>>;
}

export interface EvidenceSummary {
  readonly id: string;
  readonly stance: "supporting" | "opposing" | "neutral";
  readonly summary: string;
  readonly source: string;
  readonly capturedAt: string;
  readonly humanConfirmed?: boolean;
}

export interface CodingTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly repository: string;
  readonly status: string;
  readonly diffSummary?: string;
  readonly checks: readonly { readonly name: string; readonly status: "pass" | "fail" | "pending" }[];
  readonly approval?: string;
  readonly nextAction: string;
  readonly advanced?: {
    readonly harnessDigest: string;
    readonly candidateCount: number;
    readonly remainingBudget: string;
  };
}

export interface PluginHealth {
  readonly pluginId: string;
  readonly status: "healthy" | "degraded";
  readonly message?: string;
}

export interface ApiFailure {
  readonly code: string;
  readonly message: string;
  readonly action: string;
  readonly traceId: string;
  readonly retryable: boolean;
  readonly fieldIssues?: readonly { readonly field: string; readonly message: string }[];
}
