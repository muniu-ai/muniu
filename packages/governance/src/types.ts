export const GOVERNANCE_SCOPE_ORDER = [
  "builtin",
  "organization",
  "team",
  "project",
  "service",
  "task"
] as const;

export type GovernanceScope = (typeof GOVERNANCE_SCOPE_ORDER)[number];

/** Governed execution runtime. `builtin` resolves its model provider separately. */
export type GovernanceProvider = "builtin" | "claude" | "codex";

export const APPROVAL_MODE_ORDER = [
  "never",
  "on-risk",
  "before-merge"
] as const;

export type ApprovalMode = (typeof APPROVAL_MODE_ORDER)[number];

export interface GovernanceBudget {
  readonly maxCandidates?: number;
  readonly maxDurationSeconds?: number;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  readonly maxRepairAttempts?: number;
  readonly maxChangedFiles?: number;
  readonly maxChangedLines?: number;
}

export type GovernanceBudgetField = keyof GovernanceBudget;

export type WaivablePolicyField =
  | "requiredGates"
  | "deny"
  | "protectedPaths";

export interface PolicyRuleTarget {
  readonly field: WaivablePolicyField;
  readonly value: string;
}

/**
 * A policy layer only grants waiver eligibility for a rule that appears in the
 * same layer and is named in waivableRules. Rules are non-waivable by default.
 */
export interface PolicyRuleSet {
  readonly requiredGates?: readonly string[];
  readonly deny?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly allowedProviders?: readonly GovernanceProvider[];
  readonly commandAllowlist?: readonly string[];
  readonly networkAllowlist?: readonly string[];
  readonly budgets?: Readonly<GovernanceBudget>;
  readonly approvalMode?: ApprovalMode;
  readonly waivableRules?: readonly PolicyRuleTarget[];
}

export interface StandardPackReleaseMetadata {
  readonly sequence: number;
  readonly publishedAt: string;
  readonly expiresAt?: string;
  readonly previousDigest?: string;
  readonly changelog?: string;
}

export interface StandardPackSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

/** A declarative standard pack. It cannot carry executable TypeScript. */
export interface StandardPackManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly rules: PolicyRuleSet;
  readonly specTemplates?: readonly string[];
  readonly architectureRules?: readonly string[];
  readonly harnessProfiles?: readonly string[];
  readonly workflows?: readonly string[];
  readonly release?: StandardPackReleaseMetadata;
  readonly signature?: StandardPackSignature;
}

export interface PackLockEntry {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  /**
   * Monotonic release sequence copied from StandardPackReleaseMetadata.
   * Optional only for v1 locks created before release sequence persistence was
   * introduced.
   */
  readonly sequence?: number;
  readonly scope: GovernanceScope;
  readonly scopeId: string;
  readonly source?: string;
}

export interface PackLock {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly packs: readonly PackLockEntry[];
  readonly digest: string;
}

export interface GovernanceSourceRef {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface ScopedGovernanceLayer {
  readonly scope: GovernanceScope;
  readonly scopeId: string;
  readonly source: GovernanceSourceRef;
  readonly policy: PolicyRuleSet;
}

export interface WaiverScope {
  readonly level: GovernanceScope;
  readonly id: string;
}

export interface Waiver {
  readonly id: string;
  readonly target: PolicyRuleTarget;
  readonly scope: WaiverScope;
  readonly reason: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface AppliedWaiver extends Waiver {
  readonly sourceIds: readonly string[];
}

/** Structurally compatible with @mn/specs SpecRef without importing that package. */
export interface GovernanceSpecRef {
  readonly specSetId: string;
  readonly revision: number;
  readonly digest: string;
}

export interface VersionedGovernanceRef {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface GovernanceLayerSnapshot {
  readonly scope: GovernanceScope;
  readonly scopeId: string;
  readonly source: GovernanceSourceRef;
  readonly policyDigest: string;
}

export interface ResolvedPolicyRuleSet {
  readonly requiredGates: readonly string[];
  readonly deny: readonly string[];
  readonly protectedPaths: readonly string[];
  /** undefined means no layer constrained this allowlist; an empty list is invalid. */
  readonly allowedProviders?: readonly GovernanceProvider[];
  /** undefined means no layer constrained this allowlist; an empty list is invalid. */
  readonly commandAllowlist?: readonly string[];
  /** undefined means no layer constrained this allowlist; an empty list is invalid. */
  readonly networkAllowlist?: readonly string[];
  readonly budgets: Readonly<GovernanceBudget>;
  readonly approvalMode: ApprovalMode;
}

export type GovernanceDecisionField =
  | "requiredGates"
  | "deny"
  | "protectedPaths"
  | "allowedProviders"
  | "commandAllowlist"
  | "networkAllowlist"
  | `budgets.${GovernanceBudgetField}`
  | "approvalMode";

export type GovernanceMergeStrategy =
  | "union"
  | "intersection"
  | "minimum"
  | "strictest";

export interface GovernanceDecision {
  readonly field: GovernanceDecisionField;
  readonly strategy: GovernanceMergeStrategy;
  readonly effectiveValue: unknown;
  readonly sourceIds: readonly string[];
  readonly waiverIds?: readonly string[];
  readonly summary: string;
}

export interface GovernanceSnapshot {
  readonly schemaVersion: 1;
  readonly resolvedAt: string;
  readonly layers: readonly GovernanceLayerSnapshot[];
  readonly policy: ResolvedPolicyRuleSet;
  readonly appliedWaivers: readonly AppliedWaiver[];
  readonly decisions: readonly GovernanceDecision[];
  readonly specRef?: GovernanceSpecRef;
  readonly workflowRef?: VersionedGovernanceRef;
  readonly harnessProfileRef?: VersionedGovernanceRef;
  /** Lowercase hexadecimal SHA-256 over canonical semantic snapshot content. */
  readonly digest: string;
}

export interface ResolveGovernanceOptions {
  readonly now?: Date | string;
  readonly waivers?: readonly Waiver[];
  readonly scopeBindings?: Readonly<Partial<Record<GovernanceScope, string>>>;
  readonly specRef?: GovernanceSpecRef;
  readonly workflowRef?: VersionedGovernanceRef;
  readonly harnessProfileRef?: VersionedGovernanceRef;
}

export type GovernanceIssueCode =
  | "INVALID_LAYER"
  | "INVALID_BUDGET"
  | "INVALID_RESOLUTION_TIME"
  | "INVALID_REFERENCE"
  | "SCOPE_CONFLICT"
  | "SCOPE_BINDING_MISMATCH"
  | "DUPLICATE_LAYER_SOURCE"
  | "DUPLICATE_WAIVER_ID"
  | "EMPTY_ALLOWLIST"
  | "WAIVER_INVALID"
  | "WAIVER_EXPIRED"
  | "WAIVER_SCOPE_MISMATCH"
  | "WAIVER_TARGET_NOT_FOUND"
  | "WAIVER_TARGET_NON_WAIVABLE";

export interface GovernanceIssue {
  readonly code: GovernanceIssueCode;
  readonly message: string;
  readonly field?: string;
  readonly sourceId?: string;
  readonly waiverId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface GovernanceExplanation {
  readonly digest: string;
  readonly summary: string;
  readonly sources: readonly GovernanceLayerSnapshot[];
  readonly decisions: readonly GovernanceDecision[];
  readonly appliedWaivers: readonly AppliedWaiver[];
}
