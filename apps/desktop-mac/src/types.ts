export type AgentAppId = "claude" | "codex";
export type ProviderAppScope = AgentAppId | "unified";
export type ProviderKind =
  | "official"
  | "openai_compatible"
  | "anthropic_compatible"
  | "relay"
  | "custom";
export type ProviderApiFormat =
  | "anthropic_messages"
  | "openai_responses"
  | "openai_chat";
export type ProviderWireApi = "responses" | "chat";
export type TaskIntent = "analyze" | "design" | "implement" | "review" | "repair";
/** Gate registry identity. Built-in values remain valid for classic runs. */
export type GateType = string;

export type RuntimeCapabilityKind =
  | "provider"
  | "gate"
  | "workflow"
  | "harness_profile";

export type RuntimeCapabilityStatus = "available" | "unavailable" | "declared";

export interface RuntimeCapabilityDescriptor {
  kind: RuntimeCapabilityKind;
  id: string;
  version: string;
  displayName: string;
  status: RuntimeCapabilityStatus;
  description?: string;
  runnerId?: string;
  capabilities?: string[];
  languages?: string[];
  evidenceFormats?: string[];
  reason?: string;
  digest: string;
}

export interface CapabilitiesDocument {
  schemaVersion: 1;
  generatedAt: string;
  digest: string;
  providers: RuntimeCapabilityDescriptor[];
  gates: RuntimeCapabilityDescriptor[];
  workflows: RuntimeCapabilityDescriptor[];
  harnessProfiles: RuntimeCapabilityDescriptor[];
}

export interface WorkflowsDocument {
  schemaVersion: 1;
  generatedAt: string;
  digest: string;
  workflows: RuntimeCapabilityDescriptor[];
}

export interface HarnessProfilesDocument {
  schemaVersion: 1;
  generatedAt: string;
  digest: string;
  harnessProfiles: RuntimeCapabilityDescriptor[];
}

export interface VersionedGovernanceRef {
  id: string;
  version: string;
  digest: string;
}

export interface SpecRefSummary {
  specSetId: string;
  revision: number;
  digest: string;
}

export interface BinaryProbe {
  ok: boolean;
  binary: string;
  detail: string;
}

export interface ManagedAgentApp {
  id: AgentAppId;
  name: string;
  shortName: string;
  binary: BinaryProbe;
  currentProvider: string;
  configPath: string;
  promptPath: string;
  skillPath: string;
  restartRequired: boolean;
}

export interface ProviderSummary {
  id: string;
  app: ProviderAppScope;
  name: string;
  kind: ProviderKind;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  defaultModel: string;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high";
  wireCompatibility?: ProviderWireCompatibilityV1;
  wireApi?: ProviderWireApi;
  modelCatalog?: ProviderModelSummary[];
  apiKeyRef?: {
    type: "env" | "local_encrypted" | "keychain";
    ref: string;
    maskedValue?: string;
  };
  config?: Record<string, unknown>;
  enabled: boolean;
  updatedAt: string;
}

export interface ProviderModelSummary {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: Array<"text" | "image">;
  inputTokenUsdPerMillion?: number;
  outputTokenUsdPerMillion?: number;
  cachedInputTokenUsdPerMillion?: number;
  cacheCreationInputTokenUsdPerMillion?: number;
  cacheReadInputTokenUsdPerMillion?: number;
  reasoningOutputTokenUsdPerMillion?: number;
}

export interface ProviderWireCompatibilityV1 {
  systemRole?: "system" | "developer";
  streamUsage?: "include" | "omit";
  outputTokenField?: "omit" | "max_tokens" | "max_completion_tokens" | "max_output_tokens";
  reasoningEncoding?: "omit" | "openai_effort" | "deepseek_thinking";
  assistantReasoningField?: "omit" | "reasoning_content" | "reasoning";
}

export interface ProviderInput {
  app: ProviderAppScope;
  name: string;
  kind: ProviderKind;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  defaultModel: string;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high";
  wireCompatibility?: ProviderWireCompatibilityV1;
  wireApi?: ProviderWireApi;
  apiKey?: string;
  apiKeyEnv?: string;
  modelCatalog?: ProviderModelSummary[];
  config?: Record<string, unknown>;
}

export interface ProviderPatchInput {
  name?: string;
  baseUrl?: string;
  defaultModel?: string;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high";
  wireCompatibility?: ProviderWireCompatibilityV1;
  wireApi?: ProviderWireApi;
  apiKey?: string;
  apiKeyEnv?: string;
  modelCatalog?: ProviderModelSummary[];
  config?: Record<string, unknown>;
}

export interface ProviderProbeSummary {
  providerId: string;
  ok: boolean;
  mode: "live_http_probe";
  apiFormat: string;
  baseUrl: string;
  targetUrl: string;
  model: string;
  checkedAt: string;
  latencyMs: number;
  retryable: boolean;
  statusCode?: number;
  error?: string;
}

export interface ProviderExportItem {
  app: ProviderAppScope;
  name: string;
  kind: ProviderKind;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  defaultModel: string;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high";
  wireCompatibility?: ProviderWireCompatibilityV1;
  wireApi?: ProviderWireApi;
  apiKeyEnv?: string;
  secretOmitted?: boolean;
  modelCatalog?: Array<{
    id: string;
    displayName: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    inputModalities?: Array<"text" | "image">;
    inputTokenUsdPerMillion?: number;
    outputTokenUsdPerMillion?: number;
    cachedInputTokenUsdPerMillion?: number;
    cacheCreationInputTokenUsdPerMillion?: number;
    cacheReadInputTokenUsdPerMillion?: number;
    reasoningOutputTokenUsdPerMillion?: number;
  }>;
  config?: Record<string, unknown>;
  enabled?: boolean;
  sortOrder?: number;
}

export interface ProviderExportDocument {
  version: number;
  exportedAt?: string;
  secretPolicy?: "env_refs_only" | string;
  providers: ProviderExportItem[];
}

export interface ProviderImportResult {
  dryRun: boolean;
  importedCount: number;
  wouldImportCount: number;
  skippedCount: number;
  results: Array<{
    index: number;
    app: ProviderAppScope;
    name: string;
    status: "would_import" | "imported" | "skipped";
    providerId?: string;
    reason?: string;
  }>;
}

export interface DeepLinkImportSummary {
  dryRun: boolean;
  importedCount: number;
  wouldImportCount: number;
  skippedCount: number;
  results: Array<{
    index: number;
    app?: ProviderAppScope;
    name: string;
    status: "would_import" | "imported" | "skipped";
    providerId?: string;
    itemId?: string;
    reason?: string;
  }>;
}

export interface DeepLinkImportResult {
  scheme: "muniu" | "mniu";
  action: "import";
  kind: "providers" | "mcp_servers" | "prompts";
  trusted: boolean;
  requiresConfirmation: boolean;
  dryRun: boolean;
  result: DeepLinkImportSummary;
}

export interface UsageBucketSummary {
  key: string;
  app?: AgentAppId;
  providerId?: string;
  model?: string;
  runId?: string;
  candidateId?: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
  estimatedCostUsd?: number;
}

export interface UsageSummary {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
  estimatedCostUsd?: number;
  byApp: UsageBucketSummary[];
  byProvider: UsageBucketSummary[];
  byModel: UsageBucketSummary[];
  byRun: UsageBucketSummary[];
  byCandidate: UsageBucketSummary[];
}

export interface ProxyRequestLogSummary {
  id: string;
  app: AgentAppId;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
  statusCode: number;
  latencyMs: number;
  runId?: string;
  candidateId?: string;
  containsToolCall?: boolean;
  toolCalls?: ProxyReplayToolCallSummary[];
  createdAt: string;
}

export type ProxyToolReplayEffect = "readonly" | "idempotent" | "side_effect" | "unknown";

export interface ProxyReplayToolCallSummary {
  name: string;
  effect: ProxyToolReplayEffect;
  replaySafe: boolean;
}

export type ProviderHealthState = "unknown" | "healthy" | "degraded" | "circuit_open";

export interface ProviderHealthSummary {
  providerId: string;
  providerName: string;
  app: AgentAppId;
  state: ProviderHealthState;
  consecutiveFailures: number;
  lastStatusCode?: number;
  lastLatencyMs?: number;
  lastError?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  circuitOpenedAt?: string;
  circuitOpenUntil?: string;
  updatedAt?: string;
}

export interface SessionSummary {
  id: string;
  app: AgentAppId;
  sourcePath: string;
  sourceRoot: string;
  title: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount: number;
  model?: string;
  providerId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SessionPaginationSummary {
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
}

export interface SessionListSummary {
  sessions: SessionSummary[];
  pagination: SessionPaginationSummary;
}

export interface SessionMessageSummary {
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  text?: string;
  timestamp?: string;
  model?: string;
  toolName?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  rawType?: string;
}

export interface SessionDetailSummary extends SessionSummary {
  messages: SessionMessageSummary[];
}

export interface SessionExportDocument {
  version: 1;
  kind: "mniu.session.export";
  exportedAt: string;
  redacted: boolean;
  session: SessionDetailSummary;
}

export interface ObservabilitySummary {
  usage: UsageSummary;
  providerHealth: ProviderHealthSummary[];
  proxyLogs: ProxyRequestLogSummary[];
  sessions: SessionSummary[];
  sessionPagination: SessionPaginationSummary;
}

export interface ServiceSummary {
  id: string;
  name: string;
  path: string;
  owners: string[];
  language: string;
  contracts: Array<{
    type: string;
    path: string;
    serviceName?: string;
  }>;
}

export type SpecStatusSummary =
  | "draft"
  | "in_review"
  | "approved"
  | "rejected"
  | "superseded";

export interface AcceptanceCaseSummary {
  id: string;
  kind: "positive" | "negative" | "boundary";
  title: string;
  given: string[];
  when: string;
  then: string[];
  targetService?: string;
}

export interface SpecRevisionSummary {
  specSetId: string;
  revision: number;
  status: SpecStatusSummary;
  source: "native" | "legacy" | "spec-kit";
  title: string;
  hypothesis: string;
  outcomes: string[];
  nonGoals: string[];
  targetServices: string[];
  contracts: Record<string, Record<string, unknown>>;
  acceptanceCases: AcceptanceCaseSummary[];
  risks: Array<Record<string, unknown>>;
  unknowns: Array<Record<string, unknown>>;
  createdAt: string;
  createdBy: string;
  approvedAt?: string;
  approvedBy?: string;
  digest?: string;
}

export interface SpecSetSummary {
  id: string;
  title: string;
  description?: string;
  latestRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SpecRepositoryRecordSummary {
  specSet: SpecSetSummary;
  revisions: SpecRevisionSummary[];
}

export interface GovernanceBudgetSummary {
  maxCandidates?: number;
  maxDurationSeconds?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxRepairAttempts?: number;
  maxChangedFiles?: number;
  maxChangedLines?: number;
}

export interface GovernanceDecisionSummary {
  field: string;
  strategy: "union" | "intersection" | "minimum" | "strictest";
  effectiveValue: unknown;
  sourceIds: string[];
  waiverIds?: string[];
  summary: string;
}

export interface GovernanceLayerSummary {
  scope: "builtin" | "organization" | "team" | "project" | "service" | "task";
  scopeId: string;
  source: {
    id: string;
    version: string;
    digest: string;
  };
  policyDigest: string;
}

export interface AppliedWaiverSummary {
  id: string;
  target: { field: string; value: string };
  scope: { level: string; id: string };
  reason: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  sourceIds: string[];
}

export interface GovernanceSnapshotSummary {
  schemaVersion: 1;
  resolvedAt: string;
  layers: GovernanceLayerSummary[];
  policy: {
    requiredGates: string[];
    deny: string[];
    protectedPaths: string[];
    allowedProviders?: AgentAppId[];
    commandAllowlist?: string[];
    networkAllowlist?: string[];
    budgets: GovernanceBudgetSummary;
    approvalMode: "never" | "on-risk" | "before-merge";
  };
  appliedWaivers: AppliedWaiverSummary[];
  decisions: GovernanceDecisionSummary[];
  specRef?: SpecRefSummary;
  workflowRef?: VersionedGovernanceRef;
  harnessProfileRef?: VersionedGovernanceRef;
  digest: string;
}

export interface EffectiveGovernanceSummary {
  notFound: false;
  snapshot: GovernanceSnapshotSummary;
  bindings: Partial<Record<GovernanceLayerSummary["scope"], string>>;
  ignoredWaiverIds: string[];
}

export interface PolicyExplainSummary {
  snapshotDigest: string;
  bindings: EffectiveGovernanceSummary["bindings"];
  ignoredWaiverIds: string[];
  explanation: {
    digest: string;
    summary: string;
    sources: GovernanceLayerSummary[];
    decisions: GovernanceDecisionSummary[];
    appliedWaivers: AppliedWaiverSummary[];
  };
}

export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  services: ServiceSummary[];
  policyId: string;
}

export interface AgentTaskSummary {
  id: string;
  projectId: string;
  title: string;
  intent: TaskIntent;
  targetServices: string[];
  prompt: string;
  acceptanceCriteria: string[];
  strategy: {
    providers: AgentAppId[];
    candidates: number;
    sandbox: "read-only" | "workspace-write" | "isolated-worktree";
    requiredGates: GateType[];
    humanApproval: "never" | "on-risk" | "before-merge";
    timeoutSeconds: number;
  };
  createdAt: string;
  specRef?: SpecRefSummary;
  workflowRef?: VersionedGovernanceRef;
  harnessProfileRef?: VersionedGovernanceRef;
}

export interface GateResultSummary {
  gate: GateType;
  status: "pass" | "fail" | "warn" | "skipped";
  summary: string;
  evidence: Array<{
    id: string;
    kind: string;
    path: string;
    sha256?: string;
    contentType?: string;
  }>;
}

export interface CandidateRecordSummary {
  id: string;
  runId: string;
  provider: AgentAppId;
  worktreePath: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result?: {
    provider: AgentAppId;
    candidateId: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    exitCode: number | null;
    stdout: string;
    stderr: string;
    summary: string;
    startedAt: string;
    finishedAt: string;
  };
  gates: GateResultSummary[];
}

export interface GateResultV2Summary {
  schemaVersion: 2;
  id: string;
  runId: string;
  candidateId: string;
  gateId: string;
  runnerId: string;
  runnerVersion: string;
  required: boolean;
  status: "pass" | "fail" | "error" | "skipped" | "unsupported" | "cancelled";
  summary: string;
  specClauseIds: string[];
  command?: {
    executable: string;
    args: string[];
    display: string;
  };
  tool?: { id: string; version: string };
  workingDirectory: string;
  exitCode: number | null;
  inputDigest: string;
  outputDigest: string;
  artifacts: Array<{
    id: string;
    kind: "log" | "sarif" | "junit" | "coverage" | "contract" | "other";
    contentType: string;
    digest: string;
    byteLength: number;
    path?: string;
  }>;
  startedAt: string;
  finishedAt: string;
  freshUntil: string;
}

export interface RunBudgetUsageSummary {
  durationSeconds: number;
  tokens: number;
  costUsd: number;
  repairAttempts: number;
  changedFiles: number;
  changedLines: number;
}

export interface RunStageAttemptSummary {
  id: string;
  runId: string;
  stage:
    | "discovery"
    | "specification"
    | "impact_architecture"
    | "implementation"
    | "verification"
    | "approval_demo"
    | "learning";
  attempt: number;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "waiting_approval"
    | "cancelled";
  inputArtifacts: Array<{ id: string; kind: string; path: string; sha256?: string }>;
  outputArtifacts: Array<{ id: string; kind: string; path: string; sha256?: string }>;
  inputDigest: string;
  outputDigest?: string;
  budgetUsage: RunBudgetUsageSummary;
  failure?: { kind: string; message?: string; signature?: string };
  startedAt?: string;
  finishedAt?: string;
}

export interface HarnessManifestSummary {
  schemaVersion: 1;
  generatedAt: string;
  profile: VersionedGovernanceRef;
  specRef: SpecRefSummary;
  governanceDigest: string;
  selectedServices: string[];
  gatePlan: Array<{
    id: string;
    runnerId: string;
    runnerVersion: string;
    languages: string[];
    required: true;
  }>;
  sandbox: {
    backendId: string;
    backendVersion: string;
    enforcement: "advisory" | "postcheck" | "isolated" | "enforced";
    capabilities: string[];
  };
  context: {
    usedBytes: number;
    usedTokens: number;
    maxBytes: number;
    maxTokens: number;
    digest: string;
    fragments: Array<{ id: string; source: string; digest: string }>;
    omitted: Array<{ id: string; reason: string }>;
  };
  stopConditions: GovernanceBudgetSummary;
  outputSchema: string;
  digest: string;
}

export interface RunRecordSummary {
  id: string;
  taskId: string;
  projectId: string;
  status:
    | "queued"
    | "preparing"
    | "running"
    | "verifying"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "cancelled";
  candidates: CandidateRecordSummary[];
  gates: GateResultSummary[];
  gateResultsV2?: GateResultV2Summary[];
  verificationEvidence?: Array<{
    stageAttemptId: string;
    gateResultIds: string[];
  }>;
  winnerCandidateId?: string;
  createdAt: string;
  updatedAt: string;
  workflowRef?: VersionedGovernanceRef;
  governanceSnapshot?: GovernanceSnapshotSummary;
  harnessManifest?: HarnessManifestSummary;
  stages?: RunStageAttemptSummary[];
  budgetUsage?: RunBudgetUsageSummary;
  trace?: {
    traceId: string;
    specDigest?: string;
    governanceDigest?: string;
    harnessDigest?: string;
    evidenceIds: string[];
  };
  tenantId?: string;
}

export interface RunResumeSummary {
  resumedFromRunId: string;
  run: RunRecordSummary;
}

export interface RunEventSummary {
  runId: string;
  candidateId?: string;
  type: "status" | "stdout" | "stderr" | "gate" | "artifact" | "approval" | "error";
  message: string;
  timestamp: string;
  data?: unknown;
}

export type RunJobWorkerState = "idle" | "running" | "stale";
export type RunJobWorkerStatus = "idle" | "running";

export interface RunJobWorkerSummary {
  version: 1;
  ownerId: string;
  status: RunJobWorkerStatus;
  state: RunJobWorkerState;
  stale: boolean;
  startedAt: string;
  updatedAt: string;
  lastSeenAt: string;
  heartbeatExpiresAt: string;
  activeRunId?: string;
  activeRunIds?: string[];
  capacity?: number;
  activeRunCount?: number;
  availableSlots?: number;
  lastClaimedAt?: string;
  lastReleasedAt?: string;
  lastFinishedAt?: string;
  lastError?: string;
  completedRunCount: number;
  failedRunCount: number;
  cancelledRunCount: number;
  releasedRunCount: number;
}

export interface RunJobWorkerListSummary {
  workers: RunJobWorkerSummary[];
  summary: {
    total: number;
    idle: number;
    running: number;
    stale: number;
    capacity?: number;
    activeRunCount?: number;
    availableSlots?: number;
  };
}

export interface RunArtifactSummary {
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
  candidateId?: string;
  provider?: AgentAppId;
  gate?: string;
  source?: string;
  label?: string;
  summary?: string;
  inlineText?: string;
  bytes?: number;
  truncated?: boolean;
  persisted?: boolean;
}

export interface RunArtifactFilters {
  candidateId?: string;
  kind?: RunArtifactSummary["kind"];
  persisted?: "true" | "false";
}

export interface RunArtifactDownloadSummary {
  artifactId: string;
  filename: string;
  contentType: string;
  bytes: number;
  text?: string;
  blob: Blob;
}

export interface ArtifactStoreRunSummary {
  runId: string;
  artifactCount: number;
  bytes: number;
  updatedAt?: string;
  latestPersistedAt?: string;
}

export interface ArtifactStoreRemoteSummary {
  type: "filesystem" | "s3" | "gcs";
  rootDir: string;
  bucket?: string;
  prefix?: string;
  endpointUrl?: string;
  uriPrefix?: string;
  totalRuns: number;
  totalArtifacts: number;
  totalBytes: number;
  runs: ArtifactStoreRunSummary[];
}

export interface ArtifactStoreCleanupPolicySnapshot {
  maxAgeDays?: number;
  keepLatestRuns?: number;
  maxBytes?: number;
  scope: "local" | "remote" | "both";
}

export interface ArtifactStoreCleanupScopeAuditSummary {
  totalRuns: number;
  candidateRuns: number;
  candidateBytes: number;
  deletedRuns: number;
  deletedBytes: number;
}

export interface ArtifactStoreCleanupAuditRecord {
  version: 1;
  id: string;
  at: string;
  trigger: "manual" | "quota";
  dryRun: boolean;
  scope: "local" | "remote" | "both";
  policy: ArtifactStoreCleanupPolicySnapshot;
  totalRuns: number;
  candidateRuns: number;
  candidateBytes: number;
  deletedRuns: number;
  deletedBytes: number;
  candidates: ArtifactStoreCleanupRunSummary[];
  deleted: ArtifactStoreCleanupRunSummary[];
  local?: ArtifactStoreCleanupScopeAuditSummary;
  remote?: ArtifactStoreCleanupScopeAuditSummary & {
    type: "filesystem" | "s3" | "gcs";
    rootDir: string;
    bucket?: string;
    prefix?: string;
    endpointUrl?: string;
    uriPrefix?: string;
  };
}

export interface ArtifactStoreCleanupAuditSummary {
  totalRecords: number;
  recent: ArtifactStoreCleanupAuditRecord[];
  latest?: ArtifactStoreCleanupAuditRecord;
  policy?: {
    version: 1;
    updatedAt: string;
    dryRun: boolean;
    policy: ArtifactStoreCleanupPolicySnapshot;
  };
}

export interface ArtifactStoreSummary {
  totalRuns: number;
  totalArtifacts: number;
  totalBytes: number;
  runs: ArtifactStoreRunSummary[];
  remote?: ArtifactStoreRemoteSummary;
  cleanup?: ArtifactStoreCleanupAuditSummary;
}

export interface ArtifactStoreCleanupRunSummary extends ArtifactStoreRunSummary {
  scope?: "local" | "remote";
  reasons: string[];
}

export interface ArtifactStoreCleanupScopeSummary {
  totalRuns: number;
  candidateRuns: number;
  candidateBytes: number;
  candidates: ArtifactStoreCleanupRunSummary[];
  deleted: ArtifactStoreCleanupRunSummary[];
}

export interface ArtifactStoreRemoteCleanupScopeSummary
  extends ArtifactStoreCleanupScopeSummary {
  type: "filesystem" | "s3" | "gcs";
  rootDir: string;
  bucket?: string;
  prefix?: string;
  endpointUrl?: string;
  uriPrefix?: string;
}

export interface ArtifactStoreCleanupSummary {
  dryRun: boolean;
  scope?: "local" | "remote" | "both";
  policy: {
    maxAgeDays?: number;
    keepLatestRuns?: number;
    maxBytes?: number;
    scope?: "local" | "remote" | "both";
  };
  totalRuns: number;
  candidateRuns: number;
  candidateBytes: number;
  candidates: ArtifactStoreCleanupRunSummary[];
  deleted: ArtifactStoreCleanupRunSummary[];
  local?: ArtifactStoreCleanupScopeSummary;
  remote?: ArtifactStoreRemoteCleanupScopeSummary;
  audit?: {
    id: string;
    at: string;
    trigger: "manual" | "quota";
  };
}

export interface WorkspaceCleanupItemSummary {
  candidateId: string;
  path: string;
  status: "deleted" | "skipped";
  reason?: string;
  cleanupMethod?: "git_worktree_remove" | "rm";
}

export interface WorkspaceCleanupSummary {
  runId: string;
  workspaceRoot: string;
  results: WorkspaceCleanupItemSummary[];
}

export interface TraceGraphRecordSummary {
  tenantId: string;
  projectId: string;
  id: string;
  graph: {
    schemaVersion: 1;
    nodes: Array<{
      id: string;
      kind:
        | "business_hypothesis"
        | "spec_clause"
        | "design_contract"
        | "diff"
        | "test_gate"
        | "approval"
        | "observation";
      ref: string;
      digest: string;
      serviceIds: string[];
      metadata?: Record<string, unknown>;
    }>;
    edges: Array<{
      from: string;
      to: string;
      kind: "derives" | "designs" | "implements" | "verifies" | "approves" | "observes";
    }>;
    digest: string;
  };
  analysis?: {
    requiredSpecClauseIds: string[];
    coveredSpecClauseIds: string[];
    missingSpecClauseIds: string[];
    traceabilityRate: number;
    orphanDiffNodeIds: string[];
    orphanEvidenceNodeIds: string[];
    contractDriftRefs: string[];
    contextDrift: boolean;
    complete: boolean;
    digest: string;
  };
  createdAt: string;
  createdBy: string;
}

export interface LearningProposalSummary {
  schemaVersion: 1;
  id: string;
  revision: number;
  kind: "standard_pack" | "spec_template" | "eval_asset" | "harness_profile";
  status:
    | "draft"
    | "in_review"
    | "approved"
    | "canary_passed"
    | "rejected"
    | "promoted"
    | "rolled_back";
  title: string;
  rationale: string;
  sourceRunId: string;
  sourceEvidenceIds: string[];
  targetRef: string;
  changeDigest: string;
  createdAt: string;
  createdBy: string;
  digest: string;
}

export interface GovernedProjectViewSummary {
  projectId: string;
  spec?: SpecRevisionSummary;
  governance?: EffectiveGovernanceSummary;
  policyExplain?: PolicyExplainSummary;
  traceGraphs: TraceGraphRecordSummary[];
  learningProposals: LearningProposalSummary[];
}

export interface TaskRunFormValues {
  projectName: string;
  rootPath: string;
  title: string;
  prompt: string;
  acceptanceText: string;
  targetService: string;
  workflowId: string;
  harnessProfileId: string;
  specSetId: string;
  specRevision: string;
  specDigest: string;
  candidates: string;
}

export interface McpServerSummary {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  apps: AgentAppId[];
  enabled: boolean;
  updatedAt: string;
}

export interface McpServerInput {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  apps: AgentAppId[];
  enabled: boolean;
}

export type McpServerPatchInput = Omit<McpServerInput, "env"> & {
  env?: Record<string, string>;
};

export interface PromptPresetSummary {
  id: string;
  name: string;
  content: string;
  apps: AgentAppId[];
  updatedAt: string;
}

export interface PromptPresetInput {
  name: string;
  content: string;
  apps: AgentAppId[];
}

export type SkillSyncMode = "copy" | "symlink";

export interface SkillSummary {
  id: string;
  name: string;
  sourcePath: string;
  description?: string;
  version?: string;
  apps: AgentAppId[];
  enabled: boolean;
  updatedAt: string;
}

export interface SkillInput {
  name: string;
  sourcePath: string;
  description?: string;
  version?: string;
  apps: AgentAppId[];
  enabled: boolean;
}

export interface SkillSourceCandidate {
  name: string;
  sourcePath: string;
  sourceRoot: "mniu" | "agents";
  description?: string;
  version?: string;
}

export interface SkillRegistrySyncInput {
  registryUrl: string;
  requireSignature: boolean;
  requireReleaseMetadata: boolean;
  publicKey?: string;
  trustedPublicKeys?: Array<{
    id: string;
    publicKey: string;
  }>;
  revokedPublicKeyIds?: string[];
}

export interface SkillRegistryTrustProfileSummary extends SkillRegistrySyncInput {
  id: string;
  name: string;
  trustedPublicKeys: Array<{
    id: string;
    publicKey: string;
    status?: "active" | "retired" | "revoked";
  }>;
  revokedPublicKeyIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type SkillRegistrySyncStatus =
  | "new"
  | "update"
  | "refresh"
  | "current"
  | "downgrade";

export interface SkillRegistrySyncItem {
  name: string;
  version: string;
  sourcePath: string;
  status: SkillRegistrySyncStatus;
  changed: boolean;
  applied: boolean;
  signatureVerified: boolean;
  publicKeyId?: string;
  existingVersion?: string;
  backupPath?: string;
}

export interface SkillRegistrySyncResult {
  registryUrl: string;
  dryRun: boolean;
  releaseMetadata?: {
    sequence: number;
    issuedAt: string;
    expiresAt?: string;
    registrySha256: string;
    signatureVerified: boolean;
    publicKeyId?: string;
  };
  skills: SkillRegistrySyncItem[];
  savedSkills?: SkillSummary[];
}

export interface ExtensionSummary {
  mcpServers: McpServerSummary[];
  promptPresets: PromptPresetSummary[];
  skills: SkillSummary[];
  discoveredSkills: SkillSourceCandidate[];
  skillRegistryProfiles: SkillRegistryTrustProfileSummary[];
}

export interface DryRunActionResult {
  changed?: boolean;
  targetPath?: string;
  label: string;
  diffs?: Array<{
    targetPath: string;
    before: string;
    after: string;
  }>;
}

export type ManagedEnvName =
  | "ANTHROPIC_API_KEY"
  | "ANTHROPIC_BASE_URL"
  | "OPENAI_API_KEY";
export type EnvCleanupSource = "shell_profile" | "launch_agent" | "ide_settings";

export interface EnvConflictSummary {
  name: ManagedEnvName;
  maskedValue: string;
  source: "process.env" | "shell_profile" | "launch_agent" | "ide_settings";
  sourcePath?: string;
  line?: number;
}

export interface EnvCleanupRemovedLineSummary {
  name: ManagedEnvName;
  maskedValue: string;
  source: EnvCleanupSource;
  sourcePath: string;
  line: number;
}

export interface EnvCleanupChangedFileSummary {
  path: string;
  backupPath?: string;
  removed: EnvCleanupRemovedLineSummary[];
}

export interface EnvCleanupManualActionSummary {
  name: ManagedEnvName;
  maskedValue: string;
  source: "process.env";
  command: string;
  note: string;
}

export interface EnvCleanupSummary {
  dryRun: boolean;
  scannedFiles: string[];
  changedFiles: EnvCleanupChangedFileSummary[];
  removed: EnvCleanupRemovedLineSummary[];
  manualActions?: EnvCleanupManualActionSummary[];
}

export interface DiagnosticLogFileSummary {
  relativePath: string;
  bytes: number;
  modifiedAt: string;
  truncated: boolean;
  tail: string;
}

export interface DiagnosticLogCollectionSummary {
  root: string;
  maxFiles: number;
  maxTailBytes: number;
  files: DiagnosticLogFileSummary[];
  omittedFiles: number;
}

export interface SystemDoctorSummary {
  generatedAt: string;
  api: {
    ok: boolean;
    service: string;
    executorMode: "mock" | "real";
    workspaceRoot: string;
    mniuRoot: string;
  };
  binaries: {
    claude: BinaryProbe;
    codex: BinaryProbe;
  };
  configDirectories: Array<{
    app: AgentAppId;
    configDir: string;
    exists: boolean;
    primaryConfigPath: string;
    primaryConfigExists: boolean;
  }>;
  envConflicts: EnvConflictSummary[];
}

export interface SystemDiagnosticsSummary {
  kind: "mniu.diagnostics";
  version: number;
  generatedAt: string;
  doctor: SystemDoctorSummary;
  logs: DiagnosticLogCollectionSummary;
  crashReports: DiagnosticLogCollectionSummary;
  appLogs: DiagnosticLogCollectionSummary;
}

export interface ProxyStatus {
  status: "stopped" | "running";
  port: number;
  takenOverApps: AgentAppId[];
}

export interface RecentRun {
  id: string;
  taskId: string;
  status: string;
  candidates: number;
  updatedAt: string;
}

export interface DesktopStatus {
  generatedAt: string;
  api: {
    ok: boolean;
    service: string;
    executorMode: "mock" | "real";
    workspaceRoot: string;
  };
  apps: ManagedAgentApp[];
  proxy: ProxyStatus;
  recentRuns: RecentRun[];
}

export interface RuntimeStatus {
  runtime: string;
  platform: string;
  tray: boolean;
  windowLabel: string;
}

export interface DesktopSettings {
  theme: "system" | "light" | "dark";
  closeBehavior: "quit" | "tray" | "lightweight";
  launchAtLogin: boolean;
  lightweightMode: boolean;
  apiUrl: string;
}
