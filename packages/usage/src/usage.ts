import type { ManagedAgentApp, ProviderModel, ProviderRecord, ProxyRequestLog } from "@mn/provider-catalog";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
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
  byApp: UsageBucket[];
  byProvider: UsageBucket[];
  byModel: UsageBucket[];
  byRun: UsageBucket[];
  byCandidate: UsageBucket[];
}

export interface UsageBucket {
  key: string;
  app?: ManagedAgentApp;
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

export interface UsagePricingCatalogEntry {
  providerId: string;
  model: string;
  inputTokenUsdPerMillion?: number;
  outputTokenUsdPerMillion?: number;
  cachedInputTokenUsdPerMillion?: number;
  cacheCreationInputTokenUsdPerMillion?: number;
  cacheReadInputTokenUsdPerMillion?: number;
  reasoningOutputTokenUsdPerMillion?: number;
}

export interface UsageSummaryOptions {
  pricing?: UsagePricingCatalogEntry[];
}

export function normalizeUsageFromResponseBody(
  body: Buffer | Uint8Array | string
): TokenUsage {
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  if (!text.trim()) return emptyUsage();
  try {
    return normalizeUsageFromJson(JSON.parse(text));
  } catch {
    return emptyUsage();
  }
}

export function normalizeUsageFromJson(value: unknown): TokenUsage {
  if (!isRecord(value)) return emptyUsage();
  const usage = isRecord(value.usage) ? value.usage : value;
  const inputDetails = firstRecord(
    usage.input_tokens_details,
    usage.prompt_tokens_details,
    usage.inputTokenDetails
  );
  const outputDetails = firstRecord(
    usage.output_tokens_details,
    usage.completion_tokens_details,
    usage.outputTokenDetails
  );
  const inputTokens =
    readNumber(usage.input_tokens) ??
    readNumber(usage.prompt_tokens) ??
    readNumber(usage.inputTokens) ??
    0;
  const outputTokens =
    readNumber(usage.output_tokens) ??
    readNumber(usage.completion_tokens) ??
    readNumber(usage.outputTokens) ??
    0;
  const cachedInputTokens =
    readNumber(inputDetails?.cached_tokens) ??
    readNumber(inputDetails?.cachedTokens) ??
    readNumber(usage.cached_input_tokens) ??
    readNumber(usage.cachedInputTokens);
  const cacheCreationInputTokens =
    readNumber(usage.cache_creation_input_tokens) ??
    readNumber(usage.cacheCreationInputTokens);
  const cacheReadInputTokens =
    readNumber(usage.cache_read_input_tokens) ??
    readNumber(usage.cacheReadInputTokens);
  const reasoningOutputTokens =
    readNumber(outputDetails?.reasoning_tokens) ??
    readNumber(outputDetails?.reasoningTokens) ??
    readNumber(usage.reasoning_output_tokens) ??
    readNumber(usage.reasoningOutputTokens);
  const explicitTotal =
    readNumber(usage.total_tokens) ??
    readNumber(usage.totalTokens);
  const normalized = compactUsage({
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal ??
      inputTokens +
        outputTokens +
        (cacheCreationInputTokens ?? 0) +
        (cacheReadInputTokens ?? 0),
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    reasoningOutputTokens
  });
  return normalized;
}

export function summarizeProxyRequestLogs(
  logs: ProxyRequestLog[],
  options: UsageSummaryOptions = {}
): UsageSummary {
  const pricing = buildPricingLookup(options.pricing);
  return {
    ...sumLogs(logs, pricing),
    byApp: groupLogs(logs, pricing, (log) => ({
      key: log.app,
      app: log.app
    })),
    byProvider: groupLogs(logs, pricing, (log) => ({
      key: log.providerId,
      providerId: log.providerId
    })),
    byModel: groupLogs(logs, pricing, (log) => ({
      key: `${log.app}:${log.providerId}:${log.model}`,
      app: log.app,
      providerId: log.providerId,
      model: log.model
    })),
    byRun: groupLogs(logs.filter((log) => log.runId), pricing, (log) => ({
      key: log.runId!,
      runId: log.runId
    })),
    byCandidate: groupLogs(
      logs.filter((log) => log.runId && log.candidateId),
      pricing,
      (log) => ({
        key: `${log.runId}:${log.candidateId}`,
        runId: log.runId,
        candidateId: log.candidateId,
        app: log.app,
        providerId: log.providerId,
        model: log.model
      })
    )
  };
}

export function usageModels(
  logs: ProxyRequestLog[],
  options: UsageSummaryOptions = {}
): UsageBucket[] {
  return summarizeProxyRequestLogs(logs, options).byModel;
}

export function pricingCatalogFromProviders(
  providers: Array<Pick<ProviderRecord, "id" | "modelCatalog">>
): UsagePricingCatalogEntry[] {
  const entries: UsagePricingCatalogEntry[] = [];
  for (const provider of providers) {
    for (const model of provider.modelCatalog) {
      const pricing = pricingCatalogEntryFromModel(provider.id, model);
      if (pricing) entries.push(pricing);
    }
  }
  return entries;
}

function groupLogs(
  logs: ProxyRequestLog[],
  pricing: Map<string, UsagePricingCatalogEntry>,
  keyFor: (
    log: ProxyRequestLog
  ) => Pick<
    UsageBucket,
    "key" | "app" | "providerId" | "model" | "runId" | "candidateId"
  >
): UsageBucket[] {
  const groups = new Map<string, UsageBucket>();
  for (const log of logs) {
    const key = keyFor(log);
    const current = groups.get(key.key) ?? {
      ...key,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
      estimatedCostUsd: 0
    };
    const cost = estimateProxyRequestLogCostUsd(log, pricing);
    current.requestCount += 1;
    current.inputTokens += log.inputTokens;
    current.outputTokens += log.outputTokens;
    current.totalTokens += totalTokensForLog(log);
    current.cachedInputTokens = (current.cachedInputTokens ?? 0) + (log.cachedInputTokens ?? 0);
    current.cacheCreationInputTokens =
      (current.cacheCreationInputTokens ?? 0) + (log.cacheCreationInputTokens ?? 0);
    current.cacheReadInputTokens =
      (current.cacheReadInputTokens ?? 0) + (log.cacheReadInputTokens ?? 0);
    current.reasoningOutputTokens =
      (current.reasoningOutputTokens ?? 0) + (log.reasoningOutputTokens ?? 0);
    current.estimatedCostUsd = (current.estimatedCostUsd ?? 0) + (cost ?? 0);
    groups.set(key.key, current);
  }
  return [...groups.values()]
    .map(finalizeCost)
    .sort((a, b) => b.totalTokens - a.totalTokens || a.key.localeCompare(b.key));
}

function sumLogs(
  logs: ProxyRequestLog[],
  pricing: Map<string, UsagePricingCatalogEntry>
): Pick<
  UsageSummary,
  | "requestCount"
  | "inputTokens"
  | "outputTokens"
  | "totalTokens"
  | "cachedInputTokens"
  | "cacheCreationInputTokens"
  | "cacheReadInputTokens"
  | "reasoningOutputTokens"
  | "estimatedCostUsd"
> {
  const summary = logs.reduce(
    (current, log) => {
      const cost = estimateProxyRequestLogCostUsd(log, pricing);
      return {
        requestCount: current.requestCount + 1,
        inputTokens: current.inputTokens + log.inputTokens,
        outputTokens: current.outputTokens + log.outputTokens,
        totalTokens: current.totalTokens + totalTokensForLog(log),
        cachedInputTokens: current.cachedInputTokens + (log.cachedInputTokens ?? 0),
        cacheCreationInputTokens:
          current.cacheCreationInputTokens + (log.cacheCreationInputTokens ?? 0),
        cacheReadInputTokens: current.cacheReadInputTokens + (log.cacheReadInputTokens ?? 0),
        reasoningOutputTokens: current.reasoningOutputTokens + (log.reasoningOutputTokens ?? 0),
        estimatedCostUsd: (current.estimatedCostUsd ?? 0) + (cost ?? 0)
      };
    },
    {
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
      estimatedCostUsd: 0
    }
  );
  return finalizeCost(summary);
}

function pricingCatalogEntryFromModel(
  providerId: string,
  model: ProviderModel
): UsagePricingCatalogEntry | undefined {
  if (
    model.inputTokenUsdPerMillion === undefined &&
    model.outputTokenUsdPerMillion === undefined &&
    model.cachedInputTokenUsdPerMillion === undefined &&
    model.cacheCreationInputTokenUsdPerMillion === undefined &&
    model.cacheReadInputTokenUsdPerMillion === undefined &&
    model.reasoningOutputTokenUsdPerMillion === undefined
  ) {
    return undefined;
  }
  return {
    providerId,
    model: model.id,
    inputTokenUsdPerMillion: model.inputTokenUsdPerMillion,
    outputTokenUsdPerMillion: model.outputTokenUsdPerMillion,
    cachedInputTokenUsdPerMillion: model.cachedInputTokenUsdPerMillion,
    cacheCreationInputTokenUsdPerMillion: model.cacheCreationInputTokenUsdPerMillion,
    cacheReadInputTokenUsdPerMillion: model.cacheReadInputTokenUsdPerMillion,
    reasoningOutputTokenUsdPerMillion: model.reasoningOutputTokenUsdPerMillion
  };
}

function buildPricingLookup(
  entries: UsagePricingCatalogEntry[] | undefined
): Map<string, UsagePricingCatalogEntry> {
  const lookup = new Map<string, UsagePricingCatalogEntry>();
  for (const entry of entries ?? []) {
    lookup.set(pricingKey(entry.providerId, entry.model), entry);
  }
  return lookup;
}

export function estimateProxyRequestLogCostUsd(
  log: ProxyRequestLog,
  pricing:
    | ReadonlyMap<string, UsagePricingCatalogEntry>
    | readonly UsagePricingCatalogEntry[]
): number | undefined {
  if (log.authoritativeCostUsd !== undefined) {
    if (!Number.isFinite(log.authoritativeCostUsd) || log.authoritativeCostUsd < 0) {
      throw new TypeError("authoritativeCostUsd must be a non-negative finite number");
    }
    return log.authoritativeCostUsd;
  }
  const lookup: ReadonlyMap<string, UsagePricingCatalogEntry> = "get" in pricing
    ? pricing
    : buildPricingLookup([...pricing]);
  const entry = lookup.get(pricingKey(log.providerId, log.model));
  if (!entry) return undefined;
  const cachedInputTokens = Math.min(log.cachedInputTokens ?? 0, log.inputTokens);
  const uncachedInputTokens =
    entry.cachedInputTokenUsdPerMillion === undefined
      ? log.inputTokens
      : Math.max(0, log.inputTokens - cachedInputTokens);
  const reasoningOutputTokens = Math.min(log.reasoningOutputTokens ?? 0, log.outputTokens);
  const nonReasoningOutputTokens =
    entry.reasoningOutputTokenUsdPerMillion === undefined
      ? log.outputTokens
      : Math.max(0, log.outputTokens - reasoningOutputTokens);
  const inputCost =
    ((entry.inputTokenUsdPerMillion ?? 0) * uncachedInputTokens) / 1_000_000;
  const cachedInputCost =
    ((entry.cachedInputTokenUsdPerMillion ?? 0) * cachedInputTokens) / 1_000_000;
  const cacheCreationCost =
    ((entry.cacheCreationInputTokenUsdPerMillion ?? 0) *
      (log.cacheCreationInputTokens ?? 0)) /
    1_000_000;
  const cacheReadCost =
    ((entry.cacheReadInputTokenUsdPerMillion ?? 0) * (log.cacheReadInputTokens ?? 0)) /
    1_000_000;
  const outputCost =
    ((entry.outputTokenUsdPerMillion ?? 0) * nonReasoningOutputTokens) / 1_000_000;
  const reasoningOutputCost =
    ((entry.reasoningOutputTokenUsdPerMillion ?? 0) * reasoningOutputTokens) / 1_000_000;
  return inputCost +
    cachedInputCost +
    cacheCreationCost +
    cacheReadCost +
    outputCost +
    reasoningOutputCost;
}

function totalTokensForLog(log: ProxyRequestLog): number {
  return log.inputTokens +
    log.outputTokens +
    (log.cacheCreationInputTokens ?? 0) +
    (log.cacheReadInputTokens ?? 0);
}

function pricingKey(providerId: string, model: string): string {
  return `${providerId}\0${model}`;
}

function roundCost(value: number): number {
  return Number(value.toFixed(8));
}

function finalizeCost<T extends {
  estimatedCostUsd?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
}>(value: T): T {
  const compacted = compactTokenBreakdown(value);
  if (compacted.estimatedCostUsd === undefined) return compacted;
  const estimatedCostUsd = roundCost(compacted.estimatedCostUsd);
  if (estimatedCostUsd === 0) {
    const { estimatedCostUsd: _estimatedCostUsd, ...rest } = compacted;
    return rest as T;
  }
  return {
    ...compacted,
    estimatedCostUsd
  };
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord);
}

function compactUsage(usage: TokenUsage): TokenUsage {
  return compactTokenBreakdown(usage);
}

function compactTokenBreakdown<T extends {
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
}>(value: T): T {
  const result = { ...value };
  for (const key of [
    "cachedInputTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "reasoningOutputTokens"
  ] as const) {
    if ((result[key] ?? 0) <= 0) delete result[key];
  }
  return result;
}
