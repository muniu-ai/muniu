import type { GovernanceSnapshot, ResolvedPolicyRuleSet } from "@mn/governance";
import type { SpecRevision } from "@mn/specs";

export type SandboxEnforcement =
  | "advisory"
  | "postcheck"
  | "isolated"
  | "enforced";

export interface ContextFragmentInput {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly content: string;
  readonly priority: number;
  readonly required?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ContextCollectionRequest {
  readonly taskId: string;
  readonly projectRoot: string;
  readonly selectedServices: readonly string[];
  readonly languageByService: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ContextSource {
  readonly id: string;
  collect(
    request: ContextCollectionRequest
  ): readonly ContextFragmentInput[] | Promise<readonly ContextFragmentInput[]>;
}

export interface GateEvidenceArtifact {
  readonly kind: string;
  readonly uri?: string;
  readonly digest?: string;
}

export interface GateRunnerResult {
  readonly id: string;
  readonly status: "pass" | "fail" | "error" | "skipped" | "unsupported";
  readonly summary: string;
  readonly evidence: readonly GateEvidenceArtifact[];
}

export interface GateRunRequest {
  readonly gateId: string;
  readonly workspacePath: string;
  readonly services: readonly string[];
  readonly signal?: AbortSignal;
}

export interface GateRunner {
  readonly id: string;
  readonly version: string;
  readonly languages: readonly string[];
  run(request: GateRunRequest): Promise<GateRunnerResult>;
}

export interface SandboxPreparationRequest {
  readonly projectRoot: string;
  readonly taskId: string;
  readonly networkAllowlist?: readonly string[];
  readonly commandAllowlist?: readonly string[];
}

export interface SandboxPreparation {
  readonly backendId: string;
  readonly workspacePath: string;
  readonly leaseId?: string;
}

export interface SandboxLeaseMountPolicy {
  readonly source: "project" | "scratch";
  readonly target: string;
  readonly readOnly: boolean;
}

/** Content-addressed runtime selected by the trusted control plane. A tag is
 * display/pull metadata only; `digest` is the trust anchor verified against
 * Docker's actual image content ID. */
export interface SandboxRuntimeImage {
  readonly reference: string;
  readonly digest: string;
}

export interface SandboxLeasePolicy {
  readonly mounts: readonly SandboxLeaseMountPolicy[];
  readonly network: Readonly<{
    mode: "deny" | "allowlist";
    allowlist: readonly string[];
  }>;
  readonly resources: Readonly<{
    cpu: number;
    memoryMb: number;
    pids: number;
    timeoutSeconds: number;
  }>;
  /** Secret identifiers only; values are never part of the attestation. */
  readonly secretNames: readonly string[];
  readonly allowedTools: readonly string[];
  readonly readOnlyRootFilesystem: true;
  /** Optional only for historical/local snapshots. New enterprise leases
   * require this field and fail closed when it is absent. */
  readonly runtimeImage?: SandboxRuntimeImage;
}

/** API-issued, HMAC-authenticated authorization for one active enterprise
 * queue claim. Heartbeats preserve the claim binding, while release, expiry,
 * or reclaim must produce a new claimDigest and therefore a new lease. */
export interface SandboxLeaseAttestation {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly issuer: "mn-api";
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly workerId: string;
  readonly harnessDigest: string;
  readonly requirementsDigest: string;
  readonly workerCapabilityDigest: string;
  /** Digest of the server-owned claim epoch/token; never reusable by a reclaim. */
  readonly claimDigest: string;
  readonly backend: Readonly<{ id: string; version: string }>;
  readonly policy: SandboxLeasePolicy;
  readonly policyDigest: string;
  /** SHA-256 over every preceding semantic field. */
  readonly digest: string;
  /** HMAC-SHA-256 over digest, using API-owned key material. */
  readonly signature: string;
}

/** API-issued proof that a trusted authority inspected one concrete runtime. */
export interface SandboxRuntimeProof {
  readonly schemaVersion: 1;
  readonly issuer: "mn-api";
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly claimDigest: string;
  readonly attestationDigest: string;
  readonly runtimeId: string;
  readonly runtimeDigest: string;
  /** Actual content-addressed Docker image ID observed by the API authority. */
  readonly imageDigest?: string;
  /** SHA-256 over every preceding semantic field. */
  readonly digest: string;
  /** Domain-separated HMAC-SHA-256 over digest using API-owned key material. */
  readonly signature: string;
}

/** Evidence captured after a trusted authority has inspected the runtime. */
export interface SandboxExecutionEvidence {
  readonly backendId: string;
  readonly backendVersion: string;
  readonly leaseId: string;
  readonly attestationDigest: string;
  readonly runtimeId: string;
  readonly runtimeDigest: string;
  readonly imageDigest?: string;
  readonly runtimeProof: SandboxRuntimeProof;
}

export interface SandboxBackend {
  readonly id: string;
  readonly version: string;
  readonly enforcement: SandboxEnforcement;
  readonly capabilities: readonly string[];
  readonly runtimeImage?: SandboxRuntimeImage;
  prepare(request: SandboxPreparationRequest): Promise<SandboxPreparation>;
}

export interface HarnessProfile {
  readonly id: string;
  readonly version: string;
  /** SHA-256 over the normalized declarative profile, excluding this field. */
  readonly digest?: string;
  readonly sandboxBackendId: string;
  readonly minimumSandboxEnforcement: SandboxEnforcement;
  readonly requiredSandboxCapabilities?: readonly string[];
  readonly maxContextBytes: number;
  readonly maxContextTokens: number;
  readonly contextSourceTimeoutMs?: number;
  readonly requiredContextSourceIds?: readonly string[];
  readonly requiredContextFragmentIds?: readonly string[];
  readonly failOnMissingRequiredGates: boolean;
  readonly redactSensitiveContext: boolean;
  readonly outputSchema: string;
}

export interface HarnessCompileContext extends ContextCollectionRequest {}

export interface HarnessCompileInput {
  spec: SpecRevision;
  governance: GovernanceSnapshot;
  registry: CapabilityRegistryLike;
  context: HarnessCompileContext;
  profile: HarnessProfile;
  now?: Date | string;
  signal?: AbortSignal;
}

/** Structural interface keeps compile inputs easy to fake in deterministic tests. */
export interface CapabilityRegistryLike {
  registerGateRunner(runner: GateRunner): void;
  registerSandboxBackend(backend: SandboxBackend): void;
  registerContextSource(source: ContextSource): void;
  getGateRunner(id: string): GateRunner | undefined;
  getSandboxBackend(id: string): SandboxBackend | undefined;
  listContextSources(): readonly ContextSource[];
}

export interface HarnessContextFragment {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly sourceId: string;
  readonly content: string;
  readonly priority: number;
  readonly required: boolean;
  /** UTF-8 bytes of the complete canonical persisted fragment, not content alone. */
  readonly byteLength: number;
  /** Conservative byte upper bound for the complete canonical fragment. */
  readonly tokenEstimate: number;
  readonly contentDigest: string;
  readonly digest: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OmittedContextFragment {
  readonly id: string;
  readonly sourceId: string;
  readonly reason: "byte_budget" | "token_budget";
  readonly byteLength: number;
  readonly tokenEstimate: number;
  readonly contentDigest: string;
  readonly digest: string;
}

export interface HarnessContextManifest {
  readonly fragments: readonly HarnessContextFragment[];
  readonly omitted: readonly OmittedContextFragment[];
  /** UTF-8 bytes of the canonical selected-fragment array, including structure. */
  readonly usedBytes: number;
  /** Conservative token upper bound for the canonical selected-fragment array. */
  readonly usedTokens: number;
  readonly maxBytes: number;
  readonly maxTokens: number;
  readonly tokenEstimator: Readonly<{
    id: "utf8-byte-upper-bound";
    version: "1";
  }>;
  readonly digest: string;
}

export interface HarnessGatePlanItem {
  readonly id: string;
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly languages: readonly string[];
  readonly required: true;
}

export interface HarnessSandboxPlan {
  readonly backendId: string;
  readonly backendVersion: string;
  readonly enforcement: SandboxEnforcement;
  readonly capabilities: readonly string[];
  readonly runtimeImage?: SandboxRuntimeImage;
}

export interface HarnessExecutionPolicy {
  readonly allowedProviders?: readonly string[];
  readonly commandAllowlist?: readonly string[];
  readonly networkAllowlist?: readonly string[];
  readonly deny: readonly string[];
  readonly protectedPaths: readonly string[];
}

export interface HarnessStopConditions {
  readonly maxCandidates?: number;
  readonly maxDurationSeconds?: number;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  readonly maxRepairAttempts?: number;
  readonly maxChangedFiles?: number;
  readonly maxChangedLines?: number;
}

export interface HarnessManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly profile: Readonly<{ id: string; version: string; digest: string }>;
  readonly task: Readonly<{ taskId: string; projectRoot: string }>;
  readonly specRef: Readonly<{
    specSetId: string;
    revision: number;
    digest: string;
  }>;
  readonly governanceDigest: string;
  readonly workflowRef?: GovernanceSnapshot["workflowRef"];
  readonly harnessProfileRef?: GovernanceSnapshot["harnessProfileRef"];
  readonly selectedServices: readonly string[];
  readonly languageByService: Readonly<Record<string, string>>;
  readonly policy: ResolvedPolicyRuleSet;
  readonly executionPolicy: HarnessExecutionPolicy;
  readonly context: HarnessContextManifest;
  readonly gatePlan: readonly HarnessGatePlanItem[];
  readonly sandbox: HarnessSandboxPlan;
  readonly stopConditions: HarnessStopConditions;
  readonly outputSchema: string;
  readonly digest: string;
}

export type HarnessCompilationIssueCode =
  | "INVALID_GENERATED_AT"
  | "INVALID_PROFILE"
  | "PROFILE_REF_MISMATCH"
  | "GOVERNANCE_DIGEST_MISMATCH"
  | "INVALID_GOVERNANCE"
  | "INVALID_CAPABILITY_REGISTRY"
  | "SPEC_INVALID"
  | "SPEC_NOT_APPROVED"
  | "SPEC_REF_MISMATCH"
  | "MISSING_REQUIRED_GATE"
  | "MISSING_SANDBOX"
  | "INVALID_SANDBOX"
  | "INSUFFICIENT_SANDBOX"
  | "MISSING_SANDBOX_CAPABILITY"
  | "CONTEXT_SOURCE_FAILED"
  | "CONTEXT_SOURCE_TIMEOUT"
  | "COMPILATION_CANCELLED"
  | "INVALID_CONTEXT"
  | "DUPLICATE_CONTEXT"
  | "MISSING_REQUIRED_CONTEXT_SOURCE"
  | "MISSING_REQUIRED_CONTEXT_FRAGMENT"
  | "REQUIRED_CONTEXT_BUDGET";

export interface HarnessCompilationIssue {
  readonly code: HarnessCompilationIssueCode;
  readonly message: string;
  readonly field?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
