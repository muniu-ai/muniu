import type {
  ManagedAgentApp,
  ProviderHealthEvent,
  ProviderRecord,
  ProxyReplayRecord,
  ProxyRequestLog,
  TrustedProxyUsageAssociation
} from "@mn/provider-catalog";

/**
 * Append-only accounting metadata for one upstream attempt within a logical
 * proxy request. A reservation is settled only by an attempt marked terminal;
 * retry/fallback attempts remain durable without hiding unresolved usage.
 */
export interface ProviderUsageAttempt {
  readonly schemaVersion: 1;
  readonly logicalRequestId: string;
  readonly index: number;
  readonly terminal: boolean;
  readonly outcome: "succeeded" | "failed";
  readonly retryable: boolean;
}

export interface ProviderUsageAttemptLog extends ProxyRequestLog {
  readonly usageAttempt: ProviderUsageAttempt;
}

export interface ProviderUsageConservativeHold {
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  readonly basisDigest: string;
}

/**
 * Request-unique durable intent written before an enterprise provider side
 * effect. The proxy supplies request semantics; the API adds the immutable
 * Harness-derived conservative hold before persistence.
 */
export interface ProviderUsagePreparationIntent {
  readonly schemaVersion: 1;
  readonly logicalRequestId: string;
  readonly app: ManagedAgentApp;
  readonly model: string;
  readonly requestDigest: string;
  readonly providerPlanDigest: string;
  /** Scoped digest of the caller-supplied Idempotency-Key; raw bytes are never persisted. */
  readonly callerIdempotencyKeyDigest?: string;
  readonly providerIdempotencyStrength?: "none" | "strong";
  readonly firstOutboundIdempotencyHeaderName?: string;
  readonly firstOutboundIdempotencyKeyDigest?: string;
  readonly preparedAt: string;
  readonly conservativeHold?: ProviderUsageConservativeHold;
}

export interface PreparedProviderUsageIntent
  extends ProviderUsagePreparationIntent {
  readonly conservativeHold: ProviderUsageConservativeHold;
}

export interface ProviderUsageDispatchIntent {
  readonly schemaVersion: 1;
  readonly logicalRequestId: string;
  readonly attemptIndex: number;
  readonly providerId: string;
  /** Stable billing/account scope; defaults to providerId for legacy records. */
  readonly providerAccountId?: string;
  readonly model: string;
  readonly requestDigest: string;
  readonly providerIdempotencyStrength?: "none" | "strong";
  readonly outboundIdempotencyHeaderName?: string;
  /** Canonical digest of the exact idempotency key value sent on the wire. */
  readonly outboundRequestKeyDigest?: string;
  /** @deprecated Legacy alias retained for persisted pre-T038 events. */
  readonly outboundIdempotencyKeyDigest?: string;
  readonly startedAt: string;
}

export type ProviderUsageUnknownReason =
  | "timeout"
  | "connection_error"
  | "response_read_error"
  | "response_conversion_error"
  | "stream_interrupted"
  | "unverified_failure_response"
  | "unverified_success_response"
  | "partial_usage";

/** Durable evidence that a committed dispatch has no authoritative result. */
export interface ProviderUsageUnknownIntent extends ProviderUsageDispatchIntent {
  readonly reason: ProviderUsageUnknownReason;
  readonly observedAt: string;
  readonly statusCode?: number;
}

/**
 * A keyed acquire may resolve to an existing durable operation. Only the first
 * caller receives a TrustedProxyUsageAssociation and may dispatch upstream.
 */
export interface ProviderUsageReservationDecision {
  readonly kind: "duplicate_pending" | "duplicate_finalized" | "conflict";
  readonly logicalRequestId: string;
}

export type ProviderUsageReservationResult =
  | TrustedProxyUsageAssociation
  | ProviderUsageReservationDecision;

export interface ResolvedProxyProvider {
  app: ManagedAgentApp;
  provider: ProviderRecord;
  bearerToken?: string;
}

export interface LocalProxyOptions {
  host?: string;
  port: number;
  resolveProvider: (
    app: ManagedAgentApp,
    association?: TrustedProxyUsageAssociation
  ) => Promise<ResolvedProxyProvider | undefined>;
  resolveProviders?: (
    app: ManagedAgentApp,
    association?: TrustedProxyUsageAssociation
  ) => Promise<ResolvedProxyProvider[]>;
  appendLog: (log: ProviderUsageAttemptLog) => Promise<void>;
  recordProviderHealth?: (event: ProviderHealthEvent) => Promise<void>;
  getReplay?: (key: string) => Promise<ProxyReplayRecord | undefined>;
  saveReplay?: (record: ProxyReplayRecord) => Promise<void>;
  markReplayUsed?: (key: string) => Promise<void>;
  /** Resolve an opaque API-issued receipt to immutable enterprise bindings. */
  verifyUsageAssociationReceipt?: (
    receipt: string
  ) => Promise<TrustedProxyUsageAssociation>;
  /** Atomically pre-authorize accounting before any upstream side effect. */
  reserveTrustedUsageAssociation?: (
    association: TrustedProxyUsageAssociation,
    intent?: ProviderUsagePreparationIntent
  ) => Promise<ProviderUsageReservationResult>;
  /** Commit dispatch truth before the corresponding provider fetch. */
  markProviderUsageAttemptDispatchStarted?: (
    association: TrustedProxyUsageAssociation,
    intent: ProviderUsageDispatchIntent
  ) => Promise<void>;
  /** Append an unresolved post-dispatch fact without inventing zero usage. */
  markProviderUsageAttemptUnknown?: (
    association: TrustedProxyUsageAssociation,
    intent: ProviderUsageUnknownIntent
  ) => Promise<void>;
  /** Fail closed before contacting a provider when no valid receipt exists. */
  requireTrustedUsageAssociation?: boolean;
  /**
   * Secret used to bind caller/provider routing headers into the enterprise
   * idempotency CAS without persisting credentials or other header values.
   */
  semanticDigestKey?: string | Buffer;
  upstreamTimeoutMs?: number;
}

export interface LocalProxyStatus {
  running: boolean;
  host: string;
  port: number;
}
