// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import {
  HttpModelAdapter,
  type LlmAdapter,
  type LlmAdapterLease,
  type LlmAdapterResolutionRequest,
  type ModelProviderRoute,
  type ModelSecretRef
} from "@mn/agent-llm";
import {
  assertAgentModelBindingV1,
  assertSafePublicControlIdV1,
  createModelPricingSnapshotV1,
  digestJson,
  snapshotBoundedJsonValue,
  type AgentModelBindingV1,
  type JsonValue
} from "@mn/agent-protocol";
import type { ProviderApiFormat, ProviderRecord } from "@mn/provider-catalog";

export type AgentRuntimeResolutionErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_RECORD_INVALID"
  | "PROVIDER_DISABLED"
  | "PROVIDER_CONSUMER_UNAVAILABLE"
  | "MODEL_NOT_FOUND"
  | "PROVIDER_ROUTE_INVALID";

export class AgentRuntimeResolutionError extends Error {
  constructor(readonly code: AgentRuntimeResolutionErrorCode) {
    super("agent model provider configuration is unavailable");
    this.name = "AgentRuntimeResolutionError";
  }
}

export interface AgentProviderRecordSource {
  getProvider(providerId: string): Promise<unknown>;
}

export interface ProductionAgentRuntimeFactoryOptions {
  readonly providerSource: AgentProviderRecordSource;
  readonly resolveStoredSecret: (reference: ModelSecretRef) => Promise<string | undefined>;
  readonly resolveEnvironmentSecret?: (name: string) => string | undefined;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ProductionAgentRuntimeFactory {
  resolveAdapter(binding: AgentModelBindingV1): Promise<LlmAdapter>;
  resolveAdapterLease(request: LlmAdapterResolutionRequest): Promise<LlmAdapterLease>;
}

type JsonRecord = Record<string, JsonValue>;

const PROVIDER_KEYS = new Set([
  "id",
  "app",
  "name",
  "kind",
  "apiFormat",
  "baseUrl",
  "defaultModel",
  "modelReasoningEffort",
  "disableResponseStorage",
  "wireApi",
  "apiKeyRef",
  "modelCatalog",
  "enterpriseCapabilities",
  "config",
  "enabled",
  "enabledConsumers",
  "enabledApps",
  "sortOrder",
  "createdAt",
  "updatedAt"
]);
const REQUIRED_PROVIDER_KEYS = [
  "id",
  "app",
  "name",
  "kind",
  "apiFormat",
  "baseUrl",
  "defaultModel",
  "modelCatalog",
  "config",
  "enabled",
  "sortOrder",
  "createdAt",
  "updatedAt"
];
const MODEL_KEYS = new Set([
  "id",
  "displayName",
  "contextWindow",
  "inputTokenUsdPerMillion",
  "outputTokenUsdPerMillion",
  "cachedInputTokenUsdPerMillion",
  "cacheCreationInputTokenUsdPerMillion",
  "cacheReadInputTokenUsdPerMillion",
  "reasoningOutputTokenUsdPerMillion"
]);
const MODEL_PRICE_KEYS = [
  "inputTokenUsdPerMillion",
  "outputTokenUsdPerMillion",
  "cachedInputTokenUsdPerMillion",
  "cacheCreationInputTokenUsdPerMillion",
  "cacheReadInputTokenUsdPerMillion",
  "reasoningOutputTokenUsdPerMillion"
] as const;
const API_FORMATS = new Set<ProviderApiFormat>([
  "openai_chat",
  "openai_responses",
  "anthropic_messages"
]);
const SECRET_TYPES = new Set<ModelSecretRef["type"]>([
  "env",
  "local_encrypted",
  "keychain"
]);
const AGENT_ENV_SECRET_ALLOWLIST = new Set([
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY"
]);

function record(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function exactKeys(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  required: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function safeControl(value: JsonValue | undefined): value is string {
  try {
    assertSafePublicControlIdV1(value, "provider control value");
    return true;
  } catch {
    return false;
  }
}

function validOptionalPrice(value: JsonValue | undefined): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function canonicalPrice(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)
    || value < 0 || value >= 1_000_000_000_000) {
    throw new AgentRuntimeResolutionError("PROVIDER_RECORD_INVALID");
  }
  const fixed = value.toFixed(9);
  if (Number(fixed) !== value) {
    throw new AgentRuntimeResolutionError("PROVIDER_RECORD_INVALID");
  }
  return fixed.replace(/(?:\.0+|(?<fraction>\.[0-9]*?[1-9])0+)$/u, "$<fraction>");
}

function findModel(source: JsonRecord, modelId: string): JsonRecord | undefined {
  if (!Array.isArray(source.modelCatalog)) return undefined;
  let selected: JsonRecord | undefined;
  for (const value of source.modelCatalog) {
    const model = record(value);
    if (model === undefined
      || !exactKeys(model, MODEL_KEYS, ["id", "displayName"])
      || !safeControl(model.id)
      || typeof model.displayName !== "string"
      || model.displayName.length === 0
      || model.displayName.length > 512
      || (model.contextWindow !== undefined
        && (typeof model.contextWindow !== "number"
          || !Number.isSafeInteger(model.contextWindow)
          || model.contextWindow <= 0))
      || MODEL_PRICE_KEYS.some((key) => !validOptionalPrice(model[key]))) {
      throw new AgentRuntimeResolutionError("PROVIDER_RECORD_INVALID");
    }
    if (model.id === modelId) selected = model;
  }
  return selected;
}

function snapshotSecretRef(value: JsonValue | undefined): ModelSecretRef {
  const source = record(value);
  if (source === undefined
    || !exactKeys(source, new Set(["type", "ref", "maskedValue"]), ["type", "ref"])
    || typeof source.type !== "string"
    || !SECRET_TYPES.has(source.type as ModelSecretRef["type"])
    || !safeControl(source.ref)
    || (source.maskedValue !== undefined && typeof source.maskedValue !== "string")) {
    throw new AgentRuntimeResolutionError("PROVIDER_ROUTE_INVALID");
  }
  if (source.type === "env" && !AGENT_ENV_SECRET_ALLOWLIST.has(source.ref as string)) {
    throw new AgentRuntimeResolutionError("PROVIDER_ROUTE_INVALID");
  }
  return Object.freeze({
    type: source.type as ModelSecretRef["type"],
    ref: source.ref
  });
}

function snapshotProviderRoute(
  value: unknown,
  binding: AgentModelBindingV1
): Readonly<{ route: ModelProviderRoute; configDigest: string }> {
  let snapshot: JsonValue;
  try {
    snapshot = snapshotBoundedJsonValue(value);
  } catch {
    throw new AgentRuntimeResolutionError("PROVIDER_RECORD_INVALID");
  }
  const source = record(snapshot);
  if (source === undefined
    || !exactKeys(source, PROVIDER_KEYS, REQUIRED_PROVIDER_KEYS)
    || !safeControl(source.id)
    || source.id !== binding.providerId
    || typeof source.app !== "string"
    || typeof source.enabled !== "boolean"
    || typeof source.apiFormat !== "string"
    || !API_FORMATS.has(source.apiFormat as ProviderApiFormat)
    || typeof source.baseUrl !== "string"
    || !safeControl(source.defaultModel)
    || typeof source.name !== "string"
    || typeof source.kind !== "string"
    || typeof source.sortOrder !== "number"
    || !Number.isSafeInteger(source.sortOrder)
    || typeof source.createdAt !== "string"
    || typeof source.updatedAt !== "string"
    || record(source.config) === undefined) {
    throw new AgentRuntimeResolutionError("PROVIDER_RECORD_INVALID");
  }
  if (!source.enabled) {
    throw new AgentRuntimeResolutionError("PROVIDER_DISABLED");
  }
  const supportedScope = source.app === "agent" || source.app === "unified";
  const enabledConsumers = source.enabledConsumers;
  const enabledForAgent = Array.isArray(enabledConsumers)
    && enabledConsumers.every((consumer) => typeof consumer === "string")
    && enabledConsumers.includes("agent");
  if (!supportedScope || !enabledForAgent) {
    throw new AgentRuntimeResolutionError("PROVIDER_CONSUMER_UNAVAILABLE");
  }
  const model = findModel(source, binding.modelId);
  if (model === undefined) {
    throw new AgentRuntimeResolutionError("MODEL_NOT_FOUND");
  }
  const apiKeyRef = source.apiKeyRef === undefined
    ? undefined
    : snapshotSecretRef(source.apiKeyRef);
  const inputPrice = canonicalPrice(model.inputTokenUsdPerMillion);
  const outputPrice = canonicalPrice(model.outputTokenUsdPerMillion);
  const cacheReadPrice = canonicalPrice(
    model.cacheReadInputTokenUsdPerMillion ?? model.cachedInputTokenUsdPerMillion
  );
  const cacheWritePrice = canonicalPrice(model.cacheCreationInputTokenUsdPerMillion);
  const thinkingPrice = canonicalPrice(model.reasoningOutputTokenUsdPerMillion);
  const route: ModelProviderRoute = {
    providerId: binding.providerId,
    apiFormat: source.apiFormat as ProviderApiFormat,
    baseUrl: source.baseUrl,
    ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
    pricing: createModelPricingSnapshotV1({
      ...(inputPrice === undefined ? {} : { inputUsdPerMillion: inputPrice }),
      ...(outputPrice === undefined ? {} : { outputUsdPerMillion: outputPrice }),
      ...(cacheReadPrice === undefined ? {} : { cacheReadUsdPerMillion: cacheReadPrice }),
      ...(cacheWritePrice === undefined ? {} : { cacheWriteUsdPerMillion: cacheWritePrice }),
      ...(thinkingPrice === undefined ? {} : { thinkingUsdPerMillion: thinkingPrice })
    })
  };
  try {
    return Object.freeze({
      route: Object.freeze(route),
      configDigest: digestJson({
        ...source,
        ...(apiKeyRef === undefined ? {} : { apiKeyRef })
      })
    });
  } catch {
    throw new AgentRuntimeResolutionError("PROVIDER_ROUTE_INVALID");
  }
}

function stableOptions(value: ProductionAgentRuntimeFactoryOptions): Readonly<{
  getProvider: AgentProviderRecordSource["getProvider"];
  resolveStoredSecret: ProductionAgentRuntimeFactoryOptions["resolveStoredSecret"];
  resolveEnvironmentSecret: NonNullable<ProductionAgentRuntimeFactoryOptions["resolveEnvironmentSecret"]>;
  fetch: typeof globalThis.fetch | undefined;
}> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    throw new TypeError("agent runtime factory options must be an exact data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["providerSource", "resolveStoredSecret", "resolveEnvironmentSecret", "fetch"]);
  if (!Object.hasOwn(descriptors, "providerSource")
    || !Object.hasOwn(descriptors, "resolveStoredSecret")
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("agent runtime factory options must be an exact data object");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("agent runtime factory options must be an exact data object");
    }
  }
  const providerSource = descriptors.providerSource?.value as unknown;
  if (providerSource === null || typeof providerSource !== "object" || utilTypes.isProxy(providerSource)) {
    throw new TypeError("agent provider source must be an exact data object");
  }
  const getProviderDescriptor = Object.getOwnPropertyDescriptor(providerSource, "getProvider");
  const getProvider = getProviderDescriptor && "value" in getProviderDescriptor
    ? getProviderDescriptor.value
    : undefined;
  const resolveStoredSecret = descriptors.resolveStoredSecret?.value;
  const resolveEnvironmentSecret = descriptors.resolveEnvironmentSecret?.value
    ?? ((name: string) => process.env[name]);
  const fetch = descriptors.fetch?.value;
  if (typeof getProvider !== "function"
    || utilTypes.isProxy(getProvider)
    || typeof resolveStoredSecret !== "function"
    || utilTypes.isProxy(resolveStoredSecret)
    || typeof resolveEnvironmentSecret !== "function"
    || utilTypes.isProxy(resolveEnvironmentSecret)
    || (fetch !== undefined && (typeof fetch !== "function" || utilTypes.isProxy(fetch)))) {
    throw new TypeError("agent runtime factory callbacks must be functions");
  }
  return Object.freeze({
    getProvider: getProvider.bind(providerSource) as AgentProviderRecordSource["getProvider"],
    resolveStoredSecret: resolveStoredSecret as ProductionAgentRuntimeFactoryOptions["resolveStoredSecret"],
    resolveEnvironmentSecret: resolveEnvironmentSecret as NonNullable<ProductionAgentRuntimeFactoryOptions["resolveEnvironmentSecret"]>,
    fetch: fetch as typeof globalThis.fetch | undefined
  });
}

export function createProductionAgentRuntimeFactory(
  options: ProductionAgentRuntimeFactoryOptions
): ProductionAgentRuntimeFactory {
  const stable = stableOptions(options);
  const adapters = new Map<string, LlmAdapter>();
  const maxCachedConfigurations = 64;

  const resolveConfiguration = async (
    input: AgentModelBindingV1
  ): Promise<Readonly<{ adapter: LlmAdapter; configDigest: string }>> => {
    const binding = assertAgentModelBindingV1(input);
    let provider: unknown;
    try {
      provider = await stable.getProvider(binding.providerId);
    } catch {
      throw new AgentRuntimeResolutionError("PROVIDER_UNAVAILABLE");
    }
    if (provider === undefined) {
      throw new AgentRuntimeResolutionError("PROVIDER_NOT_FOUND");
    }
    const configuration = snapshotProviderRoute(provider, binding);
    const key = digestJson({
      schemaVersion: 1,
      binding,
      providerConfigDigest: configuration.configDigest
    });
    const cached = adapters.get(key);
    if (cached !== undefined) {
      adapters.delete(key);
      adapters.set(key, cached);
      return Object.freeze({ adapter: cached, configDigest: configuration.configDigest });
    }
    let adapter: HttpModelAdapter;
    try {
      adapter = new HttpModelAdapter({
        id: binding.providerId,
        routes: [configuration.route],
        resolveSecret: async (reference) => {
          if (reference.type === "env") return stable.resolveEnvironmentSecret(reference.ref);
          return stable.resolveStoredSecret(reference);
        },
        ...(stable.fetch === undefined ? {} : { fetch: stable.fetch })
      });
    } catch {
      throw new AgentRuntimeResolutionError("PROVIDER_ROUTE_INVALID");
    }
    const frozen = Object.freeze(adapter);
    adapters.set(key, frozen);
    while (adapters.size > maxCachedConfigurations) {
      const oldest = adapters.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      adapters.delete(oldest);
    }
    return Object.freeze({ adapter: frozen, configDigest: configuration.configDigest });
  };

  const resolveAdapter = async (input: AgentModelBindingV1): Promise<LlmAdapter> =>
    (await resolveConfiguration(input)).adapter;

  const resolveAdapterLease = async (
    input: LlmAdapterResolutionRequest
  ): Promise<LlmAdapterLease> => {
    if (input === null || typeof input !== "object" || utilTypes.isProxy(input) || Array.isArray(input)) {
      throw new AgentRuntimeResolutionError("PROVIDER_RECORD_INVALID");
    }
    const keys = Reflect.ownKeys(input);
    if (!keys.includes("providerId") || !keys.includes("modelId")
      || keys.some((key) => key !== "providerId" && key !== "modelId" && key !== "signal")) {
      throw new AgentRuntimeResolutionError("PROVIDER_RECORD_INVALID");
    }
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== "string" || descriptor === undefined
        || !("value" in descriptor) || !descriptor.enumerable) {
        throw new AgentRuntimeResolutionError("PROVIDER_RECORD_INVALID");
      }
      values[key] = descriptor.value;
    }
    const binding = assertAgentModelBindingV1({
      schemaVersion: 1,
      kind: "agent-model-binding",
      providerId: values.providerId,
      modelId: values.modelId
    });
    const configuration = await resolveConfiguration(binding);
    return Object.freeze({
      adapter: configuration.adapter,
      resolution: Object.freeze({
        schemaVersion: 1 as const,
        kind: "llm-adapter-resolution" as const,
        providerId: binding.providerId,
        modelId: binding.modelId,
        configDigest: configuration.configDigest
      }),
      release: async () => undefined
    });
  };

  return Object.freeze({ resolveAdapter, resolveAdapterLease });
}
