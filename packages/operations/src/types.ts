// SPDX-License-Identifier: Apache-2.0

export type OperationRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "needs_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface VersionedDigestRefV1 {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface SubjectRefV1 {
  readonly kind: string;
  readonly id: string;
  readonly digest: string;
}

export interface OperationRunV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly tenantId: string;
  readonly domainId: string;
  readonly subjectRefs: readonly SubjectRefV1[];
  readonly specRef: VersionedDigestRefV1;
  readonly governanceDigest: string;
  readonly harnessDigest: string;
  readonly domainModuleRef: VersionedDigestRefV1;
  readonly workflowRef: VersionedDigestRefV1;
  readonly generation: number;
  readonly status: OperationRunStatus;
  readonly currentStage: string;
  readonly budgetUsage: Readonly<Record<string, number>>;
  readonly evidenceHeadDigest?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OperationBindingExpectationV1 {
  readonly specDigest: string;
  readonly governanceDigest: string;
  readonly harnessDigest: string;
  readonly domainModuleDigest: string;
  readonly workflowDigest: string;
}

export type OperationEventKindV1 =
  | "source_captured"
  | "model_attempt"
  | "tool_call"
  | "gate"
  | "approval"
  | "artifact"
  | "external_receipt"
  | "metric";

export interface OperationEventV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly kind: OperationEventKindV1;
  readonly actor: string;
  readonly sourceRefs: readonly string[];
  readonly payloadRef: string;
  readonly previousDigest?: string;
  readonly digest: string;
  readonly createdAt: string;
}

export type ConsequenceTierV1 = "low" | "medium" | "high" | "critical";

export type AttentionStatusV1 = "pending" | "in_progress" | "resolved" | "cancelled";

export interface AttentionItemV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly tenantId: string;
  readonly sourceKind: "approval" | "exception" | "commitment_conflict" | "evidence_gap" | "deadline";
  readonly sourceId: string;
  readonly consequenceTier: ConsequenceTierV1;
  readonly dueAt: string;
  readonly earliestCommitmentDueAt?: string;
  readonly blockedCommitmentIds: readonly string[];
  readonly estimatedHumanMinutes: number;
  readonly eligibleRoles: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly inputDigest: string;
  readonly status: AttentionStatusV1;
  readonly createdAt: string;
}

export type ActionReversibilityV1 = "reversible" | "compensating" | "irreversible";

export interface ActionIntentV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly generation: number;
  readonly effectId: string;
  readonly targetRef: string;
  readonly inputDigest: string;
  readonly governanceDigest: string;
  readonly consequenceTier: ConsequenceTierV1;
  readonly reversibility: ActionReversibilityV1;
  readonly compensationRef?: string;
  readonly idempotencyKey: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export type AuthorityDecisionKindV1 = "approve" | "reject" | "request_changes" | "defer";

export interface AuthorityDecisionV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly generation: number;
  readonly inputDigest: string;
  readonly governanceDigest: string;
  readonly idempotencyKey: string;
  readonly decision: AuthorityDecisionKindV1;
  readonly actor: string;
  readonly actorRole: string;
  readonly decidedAt: string;
  readonly deferUntil?: string;
}
