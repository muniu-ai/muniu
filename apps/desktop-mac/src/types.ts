export type ViewMode = "business" | "professional";
export type ProductPluginId = "opc" | "coding";

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly viewMode: ViewMode;
  readonly activePluginIds: readonly ProductPluginId[];
  readonly streamVersion: number;
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
  readonly pluginId: ProductPluginId;
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
