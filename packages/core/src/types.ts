export type AgentProvider = "claude" | "codex";
export type AgentRuntimeId = "builtin" | AgentProvider;

import type {
  GovernanceSnapshot,
  VersionedGovernanceRef
} from "@mn/governance";
import type {
  HarnessManifest,
  SandboxExecutionEvidence,
  SandboxLeaseAttestation
} from "@mn/harness";
import type { SpecRef } from "@mn/specs";

export type TaskIntent =
  | "analyze"
  | "design"
  | "implement"
  | "review"
  | "repair";

export type BuiltinGateId =
  | "unit_test"
  | "lint"
  | "typecheck"
  | "contract"
  | "migration_safety"
  | "security"
  | "llm_verifier"
  | "human_approval";

/** @deprecated Use GateId on wire; BuiltinGateId remains for source compatibility. */
export type GateType = BuiltinGateId;

/** Registry identity. Existing GateType literals remain valid IDs. */
export type GateId = string;

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "verifying"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type CandidateStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ContractRef {
  type: "openapi" | "protobuf" | "graphql" | "asyncapi" | "other";
  path: string;
  serviceName?: string;
}

export interface ArtifactRef {
  id: string;
  kind:
    | "log"
    | "diff"
    | "summary"
    | "test-report"
    | "trace"
    | "security-report"
    | "verifier-report";
  path: string;
  sha256?: string;
  contentType?: string;
}

export interface Service {
  id: string;
  name: string;
  path: string;
  owners: string[];
  language: string;
  contracts: ContractRef[];
}

export interface Project {
  id: string;
  tenantId?: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  services: Service[];
  policyId: string;
}

export type SandboxPolicy = "read-only" | "workspace-write" | "isolated-worktree";
export type ApprovalPolicy = "never" | "on-risk" | "before-merge";

export interface ExecutionStrategyV1 {
  readonly schemaVersion?: 1;
  providers: Exclude<AgentRuntimeId, "builtin">[];
  candidates: number;
  sandbox: SandboxPolicy;
  requiredGates: GateId[];
  humanApproval: ApprovalPolicy;
  timeoutSeconds: number;
}

export interface ExecutionTargetV2 {
  runtimeId: AgentRuntimeId;
  providerId?: string;
  modelId?: string;
  candidates: number;
}

export interface ExecutionStrategyV2 {
  readonly schemaVersion: 2;
  targets: ExecutionTargetV2[];
  sandbox: SandboxPolicy;
  requiredGates: GateId[];
  humanApproval: ApprovalPolicy;
  timeoutSeconds: number;
}

export type ExecutionStrategy = ExecutionStrategyV1 | ExecutionStrategyV2;

export interface AgentExecutionBindingV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly candidateId: string;
  readonly sessionId: string;
  readonly runtimeId: AgentRuntimeId;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly harnessDigest: string;
  readonly governanceDigest: string;
  readonly effectPolicyDigest: string;
  readonly sandboxCapabilityId: string;
}

export type EnterpriseBuiltinJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly EnterpriseBuiltinJsonValue[]
  | { readonly [key: string]: EnterpriseBuiltinJsonValue };

export type EnterpriseBuiltinWorkspaceToolName =
  | "read_file"
  | "list_files"
  | "search_text"
  | "write_file"
  | "apply_patch"
  | "run_command";

export interface EnterpriseBuiltinExecutionStartV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly runId: string;
  readonly candidateId: string;
  /** Absolute path inside the inspected candidate runtime, never an API-host path. */
  readonly workspacePath: string;
  readonly prompt: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly timeoutSeconds: number;
  readonly executionBinding: AgentExecutionBindingV1;
  readonly sandboxAttestation: SandboxLeaseAttestation;
  readonly sandboxExecution: SandboxExecutionEvidence;
}

export interface EnterpriseBuiltinExecutionOutputV1 {
  readonly reason: "completed" | "cancelled" | "budget-exceeded" | "error" | string;
  readonly summary: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly executionBinding: AgentExecutionBindingV1;
}

export interface EnterpriseBuiltinToolCallV1 {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly name: EnterpriseBuiltinWorkspaceToolName;
  readonly risk: "read-only" | "side-effecting";
  readonly args: Readonly<Record<string, EnterpriseBuiltinJsonValue>>;
  readonly workspacePath: string;
  readonly createdAt: string;
}

export interface EnterpriseBuiltinExecutionViewV1 {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly state: "running" | "completed" | "failed" | "cancelled";
  readonly revision: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly executionBinding: AgentExecutionBindingV1;
  readonly toolCall?: EnterpriseBuiltinToolCallV1;
  readonly output?: EnterpriseBuiltinExecutionOutputV1;
  readonly error?: string;
}

export interface EnterpriseBuiltinToolResultV1 {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly ok: boolean;
  readonly result?: EnterpriseBuiltinJsonValue;
  readonly error?: string;
}

export interface AgentTask {
  id: string;
  tenantId?: string;
  projectId: string;
  title: string;
  intent: TaskIntent;
  targetServices: string[];
  prompt: string;
  acceptanceCriteria: string[];
  strategy: ExecutionStrategy;
  createdAt: string;
  /** Exact approved Spec revision for governed runs; absent for legacy tasks. */
  specRef?: SpecRef;
  /** Defaults to classic-v1 for legacy tasks and governed-increment-v1 with specRef. */
  workflowRef?: VersionedGovernanceRef;
  /** Optional task override; effective governance remains authoritative. */
  harnessProfileRef?: VersionedGovernanceRef;
}

export interface Policy {
  id: string;
  name: string;
  allowedProviders: AgentRuntimeId[];
  defaultRequiredGates: GateId[];
  commandAllowlist: string[];
  protectedPaths: string[];
  requireHumanApprovalForCrossService: boolean;
  maxCandidates: number;
  maxTimeoutSeconds: number;
}

export interface GateResult {
  gate: GateId;
  status: "pass" | "fail" | "warn" | "skipped";
  summary: string;
  evidence: ArtifactRef[];
}

export type GateResultV2Status =
  | "pass"
  | "fail"
  | "error"
  | "skipped"
  | "unsupported"
  | "cancelled";

export interface GateCommandV2 {
  executable: string;
  args: string[];
  display: string;
}

export interface GateToolV2 {
  id: string;
  version: string;
  /** Optional on classic/local wire payloads. Enterprise governed command
   * Gates require the complete container-executable-v1 identity. */
  identitySchema?: "container-executable-v1";
  resolvedExecutable?: string;
  contentDigest?: string;
  imageDigest?: string;
}

export interface GateArtifactV2 {
  id: string;
  kind: "log" | "sarif" | "junit" | "coverage" | "contract" | "other";
  contentType: string;
  digest: string;
  byteLength: number;
  /** Opaque API-managed CAS handle. Optional on the wire for classic/local
   * compatibility; enterprise checkpoints require and verify it. */
  handle?: string;
  path?: string;
}

export interface GateResultV2 {
  schemaVersion: 2;
  id: string;
  runId: string;
  candidateId: string;
  gateId: GateId;
  runnerId: string;
  runnerVersion: string;
  required: boolean;
  status: GateResultV2Status;
  summary: string;
  specClauseIds: string[];
  command?: GateCommandV2;
  tool?: GateToolV2;
  workingDirectory: string;
  exitCode: number | null;
  inputDigest: string;
  outputDigest: string;
  artifacts: GateArtifactV2[];
  startedAt: string;
  finishedAt: string;
  freshUntil: string;
  /** Required by the enterprise governed-run boundary. Local/classic Gate
   * results keep this absent for wire compatibility. */
  sandboxExecution?: SandboxExecutionEvidence;
}

export interface VerificationEvidenceBinding {
  stageAttemptId: string;
  gateResultIds: string[];
}

export interface SandboxRunEvidenceBinding {
  attestation: SandboxLeaseAttestation;
  execution: SandboxExecutionEvidence;
  /** Gate evidence produced by this exact inspected runtime. */
  gateResultIds: string[];
  /** Loop attempts performed while this lease was active. */
  stageAttemptIds: string[];
}

export interface RunContext {
  project: Project;
  task: AgentTask;
  selectedServices: Service[];
  architectureBrief?: string;
  previousFailures: string[];
  compactSummary?: string;
}

export interface AgentRunInput {
  runId: string;
  candidateId: string;
  provider: AgentRuntimeId;
  runtimeId?: AgentRuntimeId;
  providerId?: string;
  modelId?: string;
  sessionId?: string;
  executionBinding?: AgentExecutionBindingV1;
  cwd: string;
  prompt: string;
  context: RunContext;
  timeoutSeconds: number;
  model?: string;
  env?: Record<string, string>;
  outputCheckpoint?: CandidateOutputCheckpoint;
  onEvent?: (event: RunEvent) => void;
  abortSignal?: AbortSignal;
}

export interface AgentRunResult {
  provider: AgentRuntimeId;
  runtimeId?: AgentRuntimeId;
  providerId?: string;
  modelId?: string;
  sessionId?: string;
  executionBinding?: AgentExecutionBindingV1;
  candidateId: string;
  status: CandidateStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  summary: string;
  artifacts: ArtifactRef[];
  startedAt: string;
  finishedAt: string;
}

export interface CandidateRecord {
  id: string;
  runId: string;
  provider: AgentRuntimeId;
  runtimeId?: AgentRuntimeId;
  providerId?: string;
  modelId?: string;
  executionBinding?: AgentExecutionBindingV1;
  worktreePath: string;
  status: CandidateStatus;
  result?: AgentRunResult;
  outputCheckpoint?: CandidateOutputCheckpoint;
  gates: GateResult[];
}

export interface CandidateOutputCheckpoint {
  stdoutPath: string;
  stderrPath: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  projectId: string;
  status: RunStatus;
  candidates: CandidateRecord[];
  gates: GateResult[];
  /** Immutable, command-level verification evidence for governed runs. The
   * legacy `gates` projection remains populated for v1 clients. */
  gateResultsV2?: GateResultV2[];
  /** Deterministic index from each verification attempt to its GateResultV2
   * evidence, including an empty list for fail-closed pre-execution errors. */
  verificationEvidence?: VerificationEvidenceBinding[];
  winnerCandidateId?: string;
  createdAt: string;
  updatedAt: string;
  workflowRef?: VersionedGovernanceRef;
  governanceSnapshot?: GovernanceSnapshot;
  harnessManifest?: HarnessManifest;
  /** API-issued lease plus inspected runtime evidence for enterprise workers. */
  sandboxAttestation?: SandboxLeaseAttestation;
  sandboxExecution?: SandboxExecutionEvidence;
  /** Append-only history allows crash/reclaim to use a new worker/runtime
   * without rewriting evidence produced by earlier leases. */
  sandboxEvidenceHistory?: SandboxRunEvidenceBinding[];
  stages?: RunStageAttempt[];
  budgetUsage?: RunBudgetUsage;
  trace?: RunTraceInfo;
  tenantId?: string;
}

export type RunStageName =
  | "discovery"
  | "specification"
  | "impact_architecture"
  | "implementation"
  | "verification"
  | "approval_demo"
  | "learning";

export type RunStageAttemptStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "waiting_approval"
  | "cancelled";

export interface RunBudgetUsage {
  durationSeconds: number;
  tokens: number;
  costUsd: number;
  repairAttempts: number;
  changedFiles: number;
  changedLines: number;
}

export interface RunStageAttempt {
  id: string;
  runId: string;
  stage: RunStageName;
  attempt: number;
  status: RunStageAttemptStatus;
  inputArtifacts: ArtifactRef[];
  outputArtifacts: ArtifactRef[];
  inputDigest: string;
  outputDigest?: string;
  budgetUsage: RunBudgetUsage;
  failure?: FailureClassification;
  startedAt?: string;
  finishedAt?: string;
}

export interface RunTraceInfo {
  traceId: string;
  specDigest?: string;
  governanceDigest?: string;
  harnessDigest?: string;
  evidenceIds: string[];
}

export interface EvidenceV2 {
  id: string;
  runId: string;
  gateId: string;
  specClauseIds: string[];
  command?: string;
  toolVersion?: string;
  workingDirectory?: string;
  exitCode?: number | null;
  inputDigest: string;
  outputDigest: string;
  artifacts: ArtifactRef[];
  startedAt: string;
  finishedAt: string;
  freshUntil?: string;
}

export interface RequestContext {
  tenantId: string;
  actorId: string;
  roles: Array<
    | "org_admin"
    | "governance_admin"
    | "project_owner"
    | "developer"
    | "reviewer"
    | "auditor"
  >;
  projectIds: string[];
  principalType: "human" | "worker";
  scopes: Array<
    | "run_jobs:claim"
    | "run_jobs:heartbeat"
    | "run_jobs:checkpoint"
    | "run_jobs:finish"
    | "run_jobs:events"
    | "run_jobs:release"
  >;
  authentication: "local" | "oidc" | "jwt";
  traceId: string;
}

export interface RunEvent {
  runId: string;
  candidateId?: string;
  type:
    | "status"
    | "stdout"
    | "stderr"
    | "gate"
    | "artifact"
    | "approval"
    | "error";
  message: string;
  timestamp: string;
  data?: unknown;
}

export interface FailureClassification {
  kind:
    | "timeout"
    | "command_denied"
    | "test_failure"
    | "type_error"
    | "model_refusal"
    | "context_exhausted"
    | "unknown";
  retryable: boolean;
  reason: string;
}
