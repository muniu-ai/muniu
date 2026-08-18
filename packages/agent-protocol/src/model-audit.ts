// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import { digestJson } from "./canonical.js";
import { deepFreeze } from "./freeze.js";
import type { Digest } from "./ids.js";
import { assertSafePublicControlIdV1 } from "./public-control.js";

export type ModelAuditApiFormatV1 = "openai_chat" | "openai_responses" | "anthropic_messages";
export type ModelAuditUsageStateV1 = "complete" | "partial" | "missing";
export type ModelAuditOutcomeV1 = "completed" | "failed" | "interrupted";
export type ModelAuditDispatchStateV1 = "not-dispatched" | "dispatched" | "unknown";
export type ModelAuditFailureCodeV1 =
  | "secret_unavailable"
  | "request_invalid"
  | "transport_error"
  | "http_error"
  | "stream_error"
  | "stream_interrupted"
  | "cancelled";

export interface ModelAuditUsageV1 {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly thinkingTokens?: number;
}

export interface ModelPricingInputV1 {
  readonly inputUsdPerMillion?: string;
  readonly outputUsdPerMillion?: string;
  readonly cacheReadUsdPerMillion?: string;
  readonly cacheWriteUsdPerMillion?: string;
  readonly thinkingUsdPerMillion?: string;
}

export interface ModelPricingSnapshotV1 extends ModelPricingInputV1 {
  readonly schemaVersion: 1;
  readonly kind: "model-pricing-snapshot";
  readonly digest: Digest;
}

export interface ModelCostEstimateV1 {
  readonly schemaVersion: 1;
  readonly kind: "model-cost-estimate";
  readonly status: "estimated" | "partial" | "unpriced";
  readonly pricingDigest: Digest;
  readonly estimatedCostPicoUsd?: string;
}

export interface ModelAttemptStartedV1 {
  readonly schemaVersion: 1;
  readonly kind: "model-attempt-started";
  readonly providerId: string;
  readonly modelId: string;
  readonly apiFormat: ModelAuditApiFormatV1;
  readonly attempt: number;
  readonly protectedRequestDigest: Digest;
  readonly routeDigest: Digest;
  readonly pricing: ModelPricingSnapshotV1;
  readonly pricingDigest: Digest;
}

export interface ModelAttemptTerminalV1 {
  readonly schemaVersion: 1;
  readonly kind: "model-attempt-terminal";
  readonly providerId: string;
  readonly modelId: string;
  readonly apiFormat: ModelAuditApiFormatV1;
  readonly attempt: number;
  readonly protectedRequestDigest: Digest;
  readonly routeDigest: Digest;
  readonly pricing: ModelPricingSnapshotV1;
  readonly pricingDigest: Digest;
  readonly dispatchState: ModelAuditDispatchStateV1;
  readonly outcome: ModelAuditOutcomeV1;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly fallbackAllowed: boolean;
  readonly failureCode?: ModelAuditFailureCodeV1;
  readonly usageState: ModelAuditUsageStateV1;
  readonly usage?: ModelAuditUsageV1;
  readonly cost: ModelCostEstimateV1;
}

export interface CreateModelAttemptStartedV1Input {
  readonly providerId: string;
  readonly modelId: string;
  readonly apiFormat: ModelAuditApiFormatV1;
  readonly attempt: number;
  readonly protectedRequestDigest: string;
  readonly routeDigest: string;
  readonly pricing: ModelPricingSnapshotV1;
}

export interface CreateModelAttemptTerminalV1Input {
  readonly started: ModelAttemptStartedV1;
  readonly dispatchState: ModelAuditDispatchStateV1;
  readonly outcome: ModelAuditOutcomeV1;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly fallbackAllowed: boolean;
  readonly failureCode?: ModelAuditFailureCodeV1;
  readonly usageState: ModelAuditUsageStateV1;
  readonly usage?: ModelAuditUsageV1;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{0,8}[1-9])?$/u;
const INTEGER_STRING_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const PRICING_FIELDS = [
  "inputUsdPerMillion",
  "outputUsdPerMillion",
  "cacheReadUsdPerMillion",
  "cacheWriteUsdPerMillion",
  "thinkingUsdPerMillion"
] as const;
const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "thinkingTokens"
] as const;
const API_FORMATS = new Set<ModelAuditApiFormatV1>([
  "openai_chat",
  "openai_responses",
  "anthropic_messages"
]);
const OUTCOMES = new Set<ModelAuditOutcomeV1>(["completed", "failed", "interrupted"]);
const FAILURE_CODES = new Set<ModelAuditFailureCodeV1>([
  "secret_unavailable",
  "request_invalid",
  "transport_error",
  "http_error",
  "stream_error",
  "stream_interrupted",
  "cancelled"
]);

function exactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => keys.includes(key))
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    output[key] = descriptor.value;
  }
  return output;
}

function assertDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
}

function snapshotUsage(value: unknown): ModelAuditUsageV1 {
  const source = exactDataRecord(value, [], USAGE_FIELDS);
  if (source === undefined) throw new TypeError("model usage must be an exact data object");
  const usage: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const field of USAGE_FIELDS) {
    const count = source[field];
    if (count === undefined) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("model usage counters must be non-negative safe integers");
    }
    usage[field] = count;
  }
  return deepFreeze(usage) as ModelAuditUsageV1;
}

function assertUsageState(state: unknown, usage: ModelAuditUsageV1 | undefined): asserts state is ModelAuditUsageStateV1 {
  if (state === "missing") {
    if (usage !== undefined) throw new TypeError("missing model usage must not include counters");
    return;
  }
  if (state === "partial") {
    if (usage === undefined || (usage.inputTokens !== undefined && usage.outputTokens !== undefined)) {
      throw new TypeError("partial model usage must omit an aggregate counter");
    }
    return;
  }
  if (state === "complete") {
    if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
      throw new TypeError("complete model usage requires input and output counters");
    }
    return;
  }
  throw new TypeError("model usage state is invalid");
}

function decimalNano(value: string): bigint {
  const [integer, fraction = ""] = value.split(".");
  return BigInt(integer as string) * 1_000_000_000n
    + BigInt((fraction + "000000000").slice(0, 9));
}

function roundedPicoUsd(numerator: bigint): string {
  return ((numerator + 500n) / 1_000n).toString();
}

export function createModelPricingSnapshotV1(input: ModelPricingInputV1): ModelPricingSnapshotV1 {
  const source = exactDataRecord(input, [], PRICING_FIELDS);
  if (source === undefined) throw new TypeError("model pricing must be an exact data object");
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of PRICING_FIELDS) {
    const price = source[field];
    if (price === undefined) continue;
    if (typeof price !== "string" || !DECIMAL_PATTERN.test(price)) {
      throw new TypeError("model pricing values must be canonical non-negative decimal strings");
    }
    values[field] = price;
  }
  const envelope = {
    schemaVersion: 1 as const,
    kind: "model-pricing-snapshot" as const,
    ...values
  };
  return deepFreeze({ ...envelope, digest: digestJson(envelope) }) as ModelPricingSnapshotV1;
}

export function inspectModelPricingSnapshotV1(value: unknown): ModelPricingSnapshotV1 | undefined {
  try {
    const record = exactDataRecord(value, ["schemaVersion", "kind", "digest"], PRICING_FIELDS);
    if (record === undefined || record.schemaVersion !== 1 || record.kind !== "model-pricing-snapshot") return undefined;
    assertDigest(record.digest, "model pricing digest");
    const input: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const field of PRICING_FIELDS) {
      const price = record[field];
      if (price !== undefined) input[field] = price as string;
    }
    const rebuilt = createModelPricingSnapshotV1(input);
    return rebuilt.digest === record.digest ? rebuilt : undefined;
  } catch {
    return undefined;
  }
}

export function estimateModelCostV1(
  usageState: ModelAuditUsageStateV1,
  input: ModelAuditUsageV1 | undefined,
  pricingInput: ModelPricingSnapshotV1
): ModelCostEstimateV1 {
  const pricing = inspectModelPricingSnapshotV1(pricingInput);
  if (pricing === undefined) throw new TypeError("model pricing snapshot is invalid");
  const usage = input === undefined ? undefined : snapshotUsage(input);
  assertUsageState(usageState, usage);
  const base = {
    schemaVersion: 1 as const,
    kind: "model-cost-estimate" as const,
    pricingDigest: pricing.digest
  };
  if (usageState !== "complete" || usage === undefined) {
    return deepFreeze({ ...base, status: "partial" as const });
  }
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const thinking = usage.thinkingTokens ?? 0;
  if (cacheRead + cacheWrite > (usage.inputTokens as number)
    || thinking > (usage.outputTokens as number)) {
    throw new TypeError("model usage counters are internally inconsistent");
  }
  const components: readonly [number, string | undefined][] = [
    [(usage.inputTokens as number) - cacheRead - cacheWrite, pricing.inputUsdPerMillion],
    [cacheRead, pricing.cacheReadUsdPerMillion],
    [cacheWrite, pricing.cacheWriteUsdPerMillion],
    [(usage.outputTokens as number) - thinking, pricing.outputUsdPerMillion],
    [thinking, pricing.thinkingUsdPerMillion]
  ];
  if (components.some(([tokens, price]) => tokens > 0 && price === undefined)) {
    return deepFreeze({ ...base, status: "unpriced" as const });
  }
  let numerator = 0n;
  for (const [tokens, price] of components) {
    if (tokens === 0 || price === undefined) continue;
    numerator += BigInt(tokens) * decimalNano(price);
  }
  return deepFreeze({
    ...base,
    status: "estimated" as const,
    estimatedCostPicoUsd: roundedPicoUsd(numerator)
  });
}

export function createModelAttemptStartedV1(
  input: CreateModelAttemptStartedV1Input
): ModelAttemptStartedV1 {
  const source = exactDataRecord(input, [
    "providerId",
    "modelId",
    "apiFormat",
    "attempt",
    "protectedRequestDigest",
    "routeDigest",
    "pricing"
  ]);
  if (source === undefined) throw new TypeError("model attempt start must be an exact data object");
  assertSafePublicControlIdV1(source.providerId, "model audit provider identifier");
  assertSafePublicControlIdV1(source.modelId, "model audit model identifier");
  if (typeof source.apiFormat !== "string" || !API_FORMATS.has(source.apiFormat as ModelAuditApiFormatV1)) {
    throw new TypeError("model audit API format is invalid");
  }
  if (typeof source.attempt !== "number" || !Number.isSafeInteger(source.attempt) || source.attempt < 1) {
    throw new TypeError("model audit attempt must be a positive safe integer");
  }
  assertDigest(source.protectedRequestDigest, "protected model request digest");
  assertDigest(source.routeDigest, "model route digest");
  const pricing = inspectModelPricingSnapshotV1(source.pricing);
  if (pricing === undefined) throw new TypeError("model pricing snapshot is invalid");
  return deepFreeze({
    schemaVersion: 1,
    kind: "model-attempt-started",
    providerId: source.providerId,
    modelId: source.modelId,
    apiFormat: source.apiFormat,
    attempt: source.attempt,
    protectedRequestDigest: source.protectedRequestDigest,
    routeDigest: source.routeDigest,
    pricing,
    pricingDigest: pricing.digest
  }) as ModelAttemptStartedV1;
}

export function inspectModelAttemptStartedV1(value: unknown): ModelAttemptStartedV1 | undefined {
  try {
    const record = exactDataRecord(value, [
      "schemaVersion",
      "kind",
      "providerId",
      "modelId",
      "apiFormat",
      "attempt",
      "protectedRequestDigest",
      "routeDigest",
      "pricing",
      "pricingDigest"
    ]);
    if (record === undefined || record.schemaVersion !== 1 || record.kind !== "model-attempt-started") return undefined;
    const rebuilt = createModelAttemptStartedV1({
      providerId: record.providerId as string,
      modelId: record.modelId as string,
      apiFormat: record.apiFormat as ModelAuditApiFormatV1,
      attempt: record.attempt as number,
      protectedRequestDigest: record.protectedRequestDigest as string,
      routeDigest: record.routeDigest as string,
      pricing: record.pricing as ModelPricingSnapshotV1
    });
    return rebuilt.pricingDigest === record.pricingDigest ? rebuilt : undefined;
  } catch {
    return undefined;
  }
}

function snapshotCost(value: unknown, usageState: ModelAuditUsageStateV1, usage: ModelAuditUsageV1 | undefined, pricing: ModelPricingSnapshotV1): ModelCostEstimateV1 | undefined {
  const record = exactDataRecord(value, ["schemaVersion", "kind", "status", "pricingDigest"], ["estimatedCostPicoUsd"]);
  if (record === undefined || record.schemaVersion !== 1 || record.kind !== "model-cost-estimate"
    || record.pricingDigest !== pricing.digest
    || (record.status !== "estimated" && record.status !== "partial" && record.status !== "unpriced")
    || (record.estimatedCostPicoUsd !== undefined
      && (typeof record.estimatedCostPicoUsd !== "string" || !INTEGER_STRING_PATTERN.test(record.estimatedCostPicoUsd)))) return undefined;
  const expected = estimateModelCostV1(usageState, usage, pricing);
  return digestJson(record as never) === digestJson(expected as never) ? expected : undefined;
}

function assertTerminalConsistency(
  source: Record<string, unknown>,
  usageState: ModelAuditUsageStateV1
): void {
  const dispatchState = source.dispatchState as ModelAuditDispatchStateV1;
  const outcome = source.outcome as ModelAuditOutcomeV1;
  const failureCode = source.failureCode as ModelAuditFailureCodeV1 | undefined;
  const statusCode = source.statusCode as number | undefined;
  const retryable = source.retryable as boolean;
  const fallbackAllowed = source.fallbackAllowed as boolean;

  if (dispatchState !== "dispatched" && (statusCode !== undefined || usageState !== "missing")) {
    throw new TypeError("model terminal dispatch facts are inconsistent");
  }
  if (outcome === "completed") {
    if (dispatchState !== "dispatched" || failureCode !== undefined || retryable || fallbackAllowed
      || (statusCode !== undefined && (statusCode < 200 || statusCode > 299))) {
      throw new TypeError("completed model terminal facts are inconsistent");
    }
    return;
  }
  if (outcome === "failed") {
    if (dispatchState === "unknown" || failureCode === undefined) {
      throw new TypeError("failed model terminal facts are inconsistent");
    }
    if (dispatchState === "not-dispatched") {
      if (retryable
        || (failureCode !== "secret_unavailable" && failureCode !== "request_invalid")
        || (fallbackAllowed && failureCode !== "secret_unavailable")) {
        throw new TypeError("pre-dispatch model failure facts are inconsistent");
      }
    } else if (failureCode !== "transport_error"
      && failureCode !== "http_error"
      && failureCode !== "stream_error") {
      throw new TypeError("dispatched model failure facts are inconsistent");
    }
    return;
  }
  if (failureCode !== "cancelled" && failureCode !== "stream_interrupted") {
    throw new TypeError("interrupted model terminal facts are inconsistent");
  }
  if (retryable || fallbackAllowed
    || (dispatchState === "unknown" && failureCode !== "stream_interrupted")
    || (dispatchState === "not-dispatched" && failureCode !== "cancelled")) {
    throw new TypeError("interrupted model dispatch facts are inconsistent");
  }
}

export function createModelAttemptTerminalV1(
  input: CreateModelAttemptTerminalV1Input
): ModelAttemptTerminalV1 {
  const source = exactDataRecord(input, [
    "started",
    "dispatchState",
    "outcome",
    "retryable",
    "fallbackAllowed",
    "usageState"
  ], ["statusCode", "failureCode", "usage"]);
  if (source === undefined) throw new TypeError("model attempt terminal must be an exact data object");
  const started = inspectModelAttemptStartedV1(source.started);
  if (started === undefined) throw new TypeError("model attempt start is invalid");
  if ((source.dispatchState !== "not-dispatched" && source.dispatchState !== "dispatched"
      && source.dispatchState !== "unknown") || typeof source.retryable !== "boolean"
    || typeof source.fallbackAllowed !== "boolean"
    || typeof source.outcome !== "string" || !OUTCOMES.has(source.outcome as ModelAuditOutcomeV1)
    || (source.statusCode !== undefined
      && (typeof source.statusCode !== "number" || !Number.isSafeInteger(source.statusCode)
        || source.statusCode < 100 || source.statusCode > 599))
    || (source.failureCode !== undefined
      && (typeof source.failureCode !== "string" || !FAILURE_CODES.has(source.failureCode as ModelAuditFailureCodeV1)))) {
    throw new TypeError("model attempt terminal fields are invalid");
  }
  const usage = source.usage === undefined ? undefined : snapshotUsage(source.usage);
  assertUsageState(source.usageState, usage);
  assertTerminalConsistency(source, source.usageState);
  const cost = estimateModelCostV1(source.usageState, usage, started.pricing);
  return deepFreeze({
    schemaVersion: 1,
    kind: "model-attempt-terminal",
    providerId: started.providerId,
    modelId: started.modelId,
    apiFormat: started.apiFormat,
    attempt: started.attempt,
    protectedRequestDigest: started.protectedRequestDigest,
    routeDigest: started.routeDigest,
    pricing: started.pricing,
    pricingDigest: started.pricingDigest,
    dispatchState: source.dispatchState,
    outcome: source.outcome,
    ...(source.statusCode === undefined ? {} : { statusCode: source.statusCode }),
    retryable: source.retryable,
    fallbackAllowed: source.fallbackAllowed,
    ...(source.failureCode === undefined ? {} : { failureCode: source.failureCode }),
    usageState: source.usageState,
    ...(usage === undefined ? {} : { usage }),
    cost
  }) as ModelAttemptTerminalV1;
}

export function inspectModelAttemptTerminalV1(value: unknown): ModelAttemptTerminalV1 | undefined {
  try {
    const record = exactDataRecord(value, [
      "schemaVersion",
      "kind",
      "providerId",
      "modelId",
      "apiFormat",
      "attempt",
      "protectedRequestDigest",
      "routeDigest",
      "pricing",
      "pricingDigest",
      "dispatchState",
      "outcome",
      "retryable",
      "fallbackAllowed",
      "usageState",
      "cost"
    ], ["statusCode", "failureCode", "usage"]);
    if (record === undefined || record.schemaVersion !== 1 || record.kind !== "model-attempt-terminal") return undefined;
    const started = createModelAttemptStartedV1({
      providerId: record.providerId as string,
      modelId: record.modelId as string,
      apiFormat: record.apiFormat as ModelAuditApiFormatV1,
      attempt: record.attempt as number,
      protectedRequestDigest: record.protectedRequestDigest as string,
      routeDigest: record.routeDigest as string,
      pricing: record.pricing as ModelPricingSnapshotV1
    });
    if (record.pricingDigest !== started.pricingDigest) return undefined;
    const rebuilt = createModelAttemptTerminalV1({
      started,
      dispatchState: record.dispatchState as ModelAuditDispatchStateV1,
      outcome: record.outcome as ModelAuditOutcomeV1,
      ...(record.statusCode === undefined ? {} : { statusCode: record.statusCode as number }),
      retryable: record.retryable as boolean,
      fallbackAllowed: record.fallbackAllowed as boolean,
      ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode as ModelAuditFailureCodeV1 }),
      usageState: record.usageState as ModelAuditUsageStateV1,
      ...(record.usage === undefined ? {} : { usage: record.usage as ModelAuditUsageV1 })
    });
    const cost = snapshotCost(record.cost, rebuilt.usageState, rebuilt.usage, rebuilt.pricing);
    return cost === undefined ? undefined : rebuilt;
  } catch {
    return undefined;
  }
}
