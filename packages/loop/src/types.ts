import type {
  AgentTask,
  RunBudgetUsage,
  RunRecord,
  RunStageAttempt,
  RunStageName
} from "@mn/core";

export type GovernedSpecRef = NonNullable<AgentTask["specRef"]>;
export type GovernedGovernanceSnapshot = NonNullable<RunRecord["governanceSnapshot"]>;
export type GovernedHarnessManifest = NonNullable<RunRecord["harnessManifest"]>;

export interface LoopDefinition {
  readonly id: "governed-increment-v1";
  readonly version: "1";
  readonly stages: readonly RunStageName[];
  readonly repair: Readonly<{
    from: "verification";
    to: "implementation";
    defaultMaximumAttempts: 3;
    noProgressConsecutiveRounds: 2;
  }>;
  readonly approval: Readonly<{
    stage: "approval_demo";
    explicitDecisionRequired: true;
  }>;
  readonly learning: Readonly<{
    stage: "learning";
    outputKind: "learning_proposal";
    automaticActivationAllowed: false;
  }>;
  readonly digest: string;
}

export interface GovernedWorkflowRef {
  readonly id: "governed-increment-v1";
  readonly version: "1";
  readonly digest: string;
}

export type LoopArtifactKind =
  | "discovery"
  | "specification"
  | "impact_report"
  | "architecture_decision"
  | "diff"
  | "verification_evidence"
  | "approval_material"
  | "learning_proposal"
  | "other";

export interface LoopArtifact {
  readonly id: string;
  readonly kind: LoopArtifactKind;
  readonly path: string;
  readonly digest: string;
  readonly contentType?: string;
}

export interface LoopBudgetLimits {
  readonly maxDurationSeconds?: number;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  readonly maxRepairAttempts: number;
  readonly maxChangedFiles?: number;
  readonly maxChangedLines?: number;
}

export type LoopBudgetDelta = Omit<RunBudgetUsage, "repairAttempts">;

export interface LoopBudgetDiffArtifactBinding {
  readonly id: string;
  readonly uri: string;
  readonly digest: string;
  readonly byteLength: number;
  /** API-attested source domain for the bytes in this CAS object. */
  readonly candidateId: string;
  readonly workspaceUri: string;
  readonly leaseId: string;
  readonly runtimeId: string;
  readonly runtimeProofDigest: string;
  readonly projectSnapshotDigest: string;
  readonly candidateSnapshotDigest: string;
}

/**
 * API-issued measurement for one stage attempt. The Loop engine validates the
 * canonical digest and ledger binding; an enterprise control plane must also
 * verify the domain-separated HMAC signature before accepting a checkpoint.
 */
export interface LoopBudgetMeasurementProof {
  readonly schemaVersion: 1;
  readonly issuer: "mn-api";
  readonly tenantId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly claimDigest: string;
  readonly stageAttemptId: string;
  readonly stage: RunStageName;
  readonly attempt: number;
  readonly previousMeasurementDigest?: string;
  readonly intervalStartedAt: string;
  readonly measuredAt: string;
  readonly usageRequestIds: readonly string[];
  readonly usageDigest: string;
  readonly diffArtifact?: LoopBudgetDiffArtifactBinding;
  readonly delta: Readonly<LoopBudgetDelta>;
  readonly cumulative: Readonly<LoopBudgetDelta>;
  /** SHA-256 over every preceding semantic field. */
  readonly digest: string;
  /** Domain-separated HMAC-SHA-256 over digest using API-owned key material. */
  readonly signature: string;
}

export interface LoopBudgetMeasurementRequest {
  readonly runId: string;
  readonly stageAttemptId: string;
  readonly stage: RunStageName;
  readonly attempt: number;
  readonly resultStatus: StageHandlerResult["status"] | "handler_error" | "invalid_handler_result";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly artifacts: readonly LoopArtifact[];
  readonly proposedDelta: Readonly<LoopBudgetDelta>;
  /** Opaque winner workspace selected by the orchestrator. Enterprise callers
   * submit this only as a lease-bound sandbox URI; source bytes and counts are
   * always derived by the API authority. */
  readonly workspaceUri?: string;
  readonly candidateId?: string;
  readonly previousMeasurement?: LoopBudgetMeasurementProof;
}

export interface AuthoritativeLoopBudgetMeasurement {
  readonly delta: Readonly<LoopBudgetDelta>;
  readonly proof: LoopBudgetMeasurementProof;
}

export type LoopBudgetMeasurer = (
  request: LoopBudgetMeasurementRequest
) => AuthoritativeLoopBudgetMeasurement | Promise<AuthoritativeLoopBudgetMeasurement>;

export type LoopFailureKind =
  | "stage_failure"
  | "handler_error"
  | "invalid_handler_result"
  | "budget_exhausted"
  | "no_progress"
  | "approval_rejected"
  | "cancelled"
  | "interrupted";

export interface LoopFailureClassification {
  readonly kind: LoopFailureKind;
  readonly retryable: boolean;
  readonly reason: string;
  readonly failureSignature?: string;
  readonly diffDigest?: string;
}

export type LoopStageAttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "waiting_approval"
  | "cancelled";

/** Governed, digest-complete specialization of the core RunStageAttempt. */
export interface LoopStageAttempt
  extends Omit<
    RunStageAttempt,
    | "status"
    | "inputArtifacts"
    | "outputArtifacts"
    | "budgetUsage"
    | "failure"
  > {
  readonly id: string;
  readonly runId: string;
  readonly stage: RunStageName;
  readonly attempt: number;
  readonly status: LoopStageAttemptStatus;
  readonly inputArtifacts: readonly LoopArtifact[];
  readonly outputArtifacts: readonly LoopArtifact[];
  readonly inputDigest: string;
  readonly outputDigest?: string;
  readonly budgetUsage: Readonly<RunBudgetUsage>;
  readonly budgetDelta: Readonly<LoopBudgetDelta>;
  readonly budgetMeasurement?: LoopBudgetMeasurementProof;
  readonly failure?: LoopFailureClassification;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export type GovernedRunStageAttempt = LoopStageAttempt;

export interface RepairObservation {
  readonly verificationAttemptId: string;
  readonly failureSignature: string;
  readonly diffDigest: string;
}

export type ApprovalDecisionValue = "approve" | "reject";

export interface ApprovalDecision {
  readonly runId: string;
  readonly stageAttemptId: string;
  readonly decision: ApprovalDecisionValue;
  readonly actorId: string;
  readonly decidedAt: string;
  readonly digest: string;
}

export type LoopRunStatus =
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_human";

export interface GovernedRunBindings {
  readonly specRef: GovernedSpecRef;
  readonly governanceDigest: string;
  readonly harnessDigest: string;
}

export interface GovernedRunState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly workflowRef: GovernedWorkflowRef;
  readonly bindings: GovernedRunBindings;
  readonly limits: LoopBudgetLimits;
  readonly status: LoopRunStatus;
  readonly currentStage?: RunStageName;
  readonly nextInputArtifacts: readonly LoopArtifact[];
  readonly attempts: readonly LoopStageAttempt[];
  readonly budgetUsage: Readonly<RunBudgetUsage>;
  readonly repairHistory: readonly RepairObservation[];
  readonly approval?: ApprovalDecision;
  readonly failure?: LoopFailureClassification;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly digest: string;
}

export interface StageHandlerContext {
  readonly runId: string;
  readonly workflowRef: GovernedWorkflowRef;
  readonly bindings: GovernedRunBindings;
  readonly stage: RunStageName;
  readonly attempt: number;
  readonly isRepair: boolean;
  readonly inputArtifacts: readonly LoopArtifact[];
  readonly inputDigest: string;
  readonly budgetUsage: Readonly<RunBudgetUsage>;
  readonly limits: LoopBudgetLimits;
  readonly signal?: AbortSignal;
}

export interface CompletedStageResult {
  readonly status: "completed";
  readonly artifacts: readonly LoopArtifact[];
  readonly budgetDelta?: Partial<LoopBudgetDelta>;
  readonly diffDigest?: string;
}

export interface FailedStageResult {
  readonly status: "failed";
  readonly artifacts: readonly LoopArtifact[];
  readonly budgetDelta?: Partial<LoopBudgetDelta>;
  readonly failure: Readonly<{
    kind: "stage_failure";
    retryable: boolean;
    reason: string;
  }>;
  readonly failureSignature?: string;
  readonly diffDigest?: string;
}

export interface WaitingApprovalStageResult {
  readonly status: "waiting_approval";
  readonly artifacts: readonly LoopArtifact[];
  readonly budgetDelta?: Partial<LoopBudgetDelta>;
}

export interface CancelledStageResult {
  readonly status: "cancelled";
  readonly artifacts: readonly LoopArtifact[];
  readonly budgetDelta?: Partial<LoopBudgetDelta>;
  readonly reason: string;
}

export type StageHandlerResult =
  | CompletedStageResult
  | FailedStageResult
  | WaitingApprovalStageResult
  | CancelledStageResult;

export type StageHandler = (
  context: StageHandlerContext
) => StageHandlerResult | Promise<StageHandlerResult>;

export type GovernedStageHandlers = Readonly<Record<RunStageName, StageHandler>>;

export interface ExecuteGovernedRunInput {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly specRef: GovernedSpecRef;
  readonly governanceSnapshot: GovernedGovernanceSnapshot;
  readonly harnessManifest: GovernedHarnessManifest;
  readonly handlers: GovernedStageHandlers;
  readonly onCheckpoint: (state: GovernedRunState) => void | Promise<void>;
  /** Optional for local/classic compatibility; mandatory at the enterprise
   * external-worker acceptance boundary. */
  readonly measureBudgetDelta?: LoopBudgetMeasurer;
  readonly initialArtifacts?: readonly LoopArtifact[];
  readonly limits?: Partial<LoopBudgetLimits>;
  readonly resumeFrom?: GovernedRunState;
  readonly approvalDecision?: ApprovalDecision;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}

export class GovernedLoopInputError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "GovernedLoopInputError";
  }
}

export class LoopPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoopPersistenceError";
  }
}

export class LoopMeasurementError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoopMeasurementError";
  }
}

/**
 * The active handler lost infrastructure ownership before its outcome became
 * durable. The engine must leave the running checkpoint intact so another
 * worker can recover it instead of recording a terminal stage failure.
 */
export class GovernedLoopInterruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GovernedLoopInterruptionError";
  }
}
