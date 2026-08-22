import type { AgentProvider } from "@mn/core";

export type ManagedAgentApp = AgentProvider;
export type ProviderConsumerId = ManagedAgentApp | "agent";
export type ProviderAppScope = ProviderConsumerId | "unified";

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

export type CodexWireApi = "responses" | "chat";

export type CodexProviderMode =
  | "official"
  | "third_party_preserve_auth"
  | "api_key_auth_file"
  | "local_route";

export interface ProviderSecretRef {
  type: "env" | "local_encrypted" | "keychain";
  ref: string;
  maskedValue?: string;
}

export interface ProviderModel {
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

/**
 * Enterprise-only provider guarantees. These capabilities are intentionally
 * separate from the free-form provider config: naming an idempotency header
 * does not prove that the provider implements strong idempotency semantics.
 */
export interface ProviderEnterpriseCapabilities {
  readonly idempotency?: Readonly<{
    readonly strength: "strong";
    readonly headerName: string;
  }>;
  /** Explicit contract that retryable HTTP failure responses are not billed. */
  readonly retryableFailureResponsesUnbilled?: true;
}

export interface ProviderRecord {
  id: string;
  app: ProviderAppScope;
  name: string;
  kind: ProviderKind;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  defaultModel: string;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high";
  wireCompatibility?: ProviderWireCompatibilityV1;
  disableResponseStorage?: boolean;
  wireApi?: CodexWireApi;
  apiKeyRef?: ProviderSecretRef;
  modelCatalog: ProviderModel[];
  enterpriseCapabilities?: ProviderEnterpriseCapabilities;
  config: Record<string, unknown>;
  enabled: boolean;
  enabledConsumers?: ProviderConsumerId[];
  /** @deprecated Read-only compatibility for v0.1 records. */
  enabledApps?: ManagedAgentApp[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderPreset {
  id: string;
  app: ProviderAppScope;
  name: string;
  kind: ProviderKind;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  defaultModel: string;
  wireCompatibility?: ProviderWireCompatibilityV1;
  wireApi?: CodexWireApi;
  modelCatalog: ProviderModel[];
  enterpriseCapabilities?: ProviderEnterpriseCapabilities;
  config?: Record<string, unknown>;
}

export interface ProviderAppProjection {
  id: string;
  providerId: string;
  app: ManagedAgentApp;
  purpose?: "provider" | "proxy_takeover";
  targetPath?: string;
  liveConfigHash: string;
  backupPath?: string;
  files?: Array<{
    targetPath: string;
    liveConfigHash: string;
    backupPath?: string;
  }>;
  projectedAt: string;
  mode?: CodexProviderMode;
}

export interface ProxyConfig {
  status: "stopped" | "running";
  port: number;
  takenOverApps: ManagedAgentApp[];
}

/**
 * Server-verified association for enterprise provider usage. The raw receipt
 * is deliberately never persisted: only its digest and immutable claim
 * bindings cross the proxy/storage boundary.
 */
export interface TrustedProxyUsageAssociation {
  schemaVersion: 1;
  issuer: "mn-api";
  tenantId: string;
  runId: string;
  candidateId: string;
  workerId: string;
  claimDigest: string;
  receiptDigest: string;
  /** API/ledger reservation created before the upstream provider call. */
  reservationId?: string;
  issuedAt: string;
  expiresAt: string;
  verifiedAt: string;
  /** Signed immutable provider selection for this exact governed claim. */
  providerPlan?: Readonly<{
    schemaVersion: 1;
    projectId: string;
    app: ManagedAgentApp;
    providerIds: readonly string[];
    digest: string;
  }>;
}

export interface ProxyRequestLog {
  id: string;
  app: ManagedAgentApp;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
  /**
   * Server-authoritative cost used when provider or invoice evidence supplies
   * an exact amount, or when enterprise reconciliation charges a previously
   * reserved conservative hold. Pricing-catalog estimation remains the
   * backward-compatible fallback when this field is absent.
   */
  authoritativeCostUsd?: number;
  statusCode: number;
  latencyMs: number;
  runId?: string;
  candidateId?: string;
  trustedAssociation?: TrustedProxyUsageAssociation;
  replayed?: boolean;
  containsToolCall?: boolean;
  toolCalls?: ProxyReplayToolCall[];
  /** Append-only machine/human resolution provenance for enterprise usage. */
  usageResolution?: ProxyUsageResolution;
  createdAt: string;
}

export interface ProxyUsageResolution {
  readonly kind: "pre_dispatch_zero" | "exact" | "conservative";
  readonly evidenceUri?: string;
  readonly evidenceSha256?: string;
  readonly evidenceKind?: "provider" | "invoice" | "machine";
  readonly reason?: string;
  readonly ticket?: string;
  readonly basisDigest: string;
  /** Conservative resolutions force the governed budget to stop at its hold. */
  readonly requiresBudgetStop?: boolean;
}

export type ProxyToolReplayEffect = "readonly" | "idempotent" | "side_effect" | "unknown";

export interface ProxyReplayToolCall {
  name: string;
  effect: ProxyToolReplayEffect;
  replaySafe: boolean;
}

export interface ProxyReplayRecord {
  key: string;
  app: ManagedAgentApp;
  providerId: string;
  model: string;
  method: string;
  targetUrl: string;
  requestHash: string;
  statusCode: number;
  headers: Record<string, string>;
  bodyBase64: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
  containsToolCall?: boolean;
  toolCalls?: ProxyReplayToolCall[];
  runId: string;
  candidateId: string;
  createdAt: string;
  lastReplayedAt?: string;
  replayCount: number;
}

export type ProviderHealthState = "healthy" | "degraded" | "circuit_open";

export interface ProviderHealthRecord {
  providerId: string;
  app: ManagedAgentApp;
  state: ProviderHealthState;
  consecutiveFailures: number;
  lastStatusCode?: number;
  lastLatencyMs?: number;
  lastError?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  circuitOpenedAt?: string;
  circuitOpenUntil?: string;
  updatedAt: string;
}

export interface ProviderHealthEvent {
  providerId: string;
  app: ManagedAgentApp;
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
  retryable?: boolean;
  occurredAt?: string;
  failureThreshold?: number;
  circuitOpenMs?: number;
}

export interface ProviderCreateInput {
  app: ProviderAppScope;
  name: string;
  kind: ProviderKind;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  defaultModel: string;
  modelReasoningEffort?: ProviderRecord["modelReasoningEffort"];
  wireCompatibility?: ProviderWireCompatibilityV1;
  disableResponseStorage?: boolean;
  wireApi?: CodexWireApi;
  apiKeyRef?: ProviderSecretRef;
  modelCatalog?: ProviderModel[];
  enterpriseCapabilities?: ProviderEnterpriseCapabilities;
  config?: Record<string, unknown>;
  enabled?: boolean;
  sortOrder?: number;
}

export interface ProviderUpdateInput {
  name?: string;
  baseUrl?: string;
  defaultModel?: string;
  modelReasoningEffort?: ProviderRecord["modelReasoningEffort"];
  wireCompatibility?: ProviderWireCompatibilityV1;
  disableResponseStorage?: boolean;
  wireApi?: CodexWireApi;
  apiKeyRef?: ProviderSecretRef;
  modelCatalog?: ProviderModel[];
  enterpriseCapabilities?: ProviderEnterpriseCapabilities;
  config?: Record<string, unknown>;
  enabled?: boolean;
  sortOrder?: number;
}
