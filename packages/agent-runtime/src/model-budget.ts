// SPDX-License-Identifier: Apache-2.0
import { ExecutionBudgetExceededError } from "./budget.js";
import { createHash, randomUUID } from "node:crypto";
import type { ModelRateCard } from "@mn/contracts";
export type { ModelRateCard } from "@mn/contracts";
import type { ExecutionBudget, JsonObject, ModelRequest, ModelResponse, ModelUsage, RuntimeRecord, RuntimeStore } from "./types.js";

export type ModelBudgetLimits = Pick<ExecutionBudget, "maxTokens" | "maxCostMinorUnits" | "currency">;

export interface ModelBudgetReservation {
  readonly id: string;
  readonly requestDigest: string;
  readonly inputTokenLimit: number;
  readonly inputTokenLimitBasis?: "provider_count" | "conservative_utf8_estimate";
  readonly maxOutputTokens: number;
  readonly rates: ModelRateCard;
}

export interface ModelBudgetSnapshot {
  readonly knownTokens: number;
  readonly knownCostNanoMinorUnits: string;
  readonly allocatedTokens: number;
  readonly allocatedCostNanoMinorUnits: string;
  readonly pendingRequests: number;
  readonly overrun: boolean;
  readonly limits: ModelBudgetLimits;
}

const NANOS_PER_MINOR = 1_000_000_000n;

/** The caller must persist model-visible context before requesting a quote or invoking this function. */
export async function completeWithModelBudget(options: {
  readonly store: RuntimeStore;
  readonly limits: ModelBudgetLimits;
  readonly modelKey: string;
  readonly request: ModelRequest;
  readonly quote: Omit<ModelBudgetReservation, "id" | "requestDigest">;
  readonly signal: AbortSignal;
  readonly complete: (request: ModelRequest, signal: AbortSignal) => Promise<ModelResponse>;
}): Promise<ModelResponse> {
  if (!options.modelKey.trim()) throw new TypeError("模型计费身份不能为空");
  options.signal.throwIfAborted();
  const quote = structuredClone(options.quote);
  const request = structuredClone({ ...options.request, maxOutputTokens: quote.maxOutputTokens });
  request.messages.forEach(Object.freeze);
  Object.freeze(request.messages);
  Object.freeze(request.availableToolIds);
  Object.freeze(request);
  const budget = new PersistentModelBudget({ store: options.store, executionId: request.executionId, limits: options.limits });
  const id = `model-${randomUUID()}`;
  await budget.reserve({ ...quote, id, requestDigest: createHash("sha256")
    .update(JSON.stringify({ modelKey: options.modelKey, request, quote })).digest("hex") });
  let response: ModelResponse;
  try {
    options.signal.throwIfAborted();
    response = structuredClone(await withCancellation(() => options.complete(request, options.signal), options.signal));
    options.signal.throwIfAborted();
    if (!response.usage) throw new ExecutionBudgetExceededError("model_unknown");
    validateModelUsage(response.usage);
  } catch {
    throw new ExecutionBudgetExceededError("model_unknown");
  }
  await budget.settle(id, response.usage);
  return response;
}

async function withCancellation<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work(), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export class PersistentModelBudget {
  readonly #limits: ModelBudgetLimits;
  constructor(readonly options: {
    readonly store: RuntimeStore;
    readonly executionId: string;
    readonly limits: ModelBudgetLimits;
  }) {
    this.#limits = structuredClone(options.limits);
    validateLimits(this.#limits);
  }

  async snapshot(): Promise<ModelBudgetSnapshot> {
    return reduceModelBudget(await this.options.store.readExecution(this.options.executionId), this.#limits);
  }

  async reserve(input: ModelBudgetReservation): Promise<void> {
    const reservation = structuredClone(input);
    validateReservation(reservation);
    const { store, executionId } = this.options;
    for (;;) {
      const records = await store.readExecution(executionId);
      const state = reduceModelBudget(records, this.#limits);
      if (records.some(record => record.type === "model/reserved" && record.payload.id === reservation.id)) {
        throw new Error("模型请求标识重复，禁止自动重放");
      }
      if (state.overrun) throw new ExecutionBudgetExceededError("model_overrun");
      if (state.pendingRequests) throw new ExecutionBudgetExceededError("model_unknown");
      if (reservation.rates.currency !== state.limits.currency) throw new Error("模型价格与执行预算的币种不一致");
      assertAllocation(state, reservation.inputTokenLimit + reservation.maxOutputTokens, costOf(reservation, {
        inputTokens: reservation.inputTokenLimit, cachedInputTokens: 0, outputTokens: reservation.maxOutputTokens,
      }));
      const saved = await store.commit(executionId, records.at(-1)?.sequence ?? 0, [
        ...records.some(record => record.type === "model/budget") ? [] : [{ executionId,
          type: "model/budget" as const, payload: { ...state.limits } }],
        { executionId, type: "model/reserved", payload: reservation as unknown as JsonObject },
      ]);
      if (saved) return;
    }
  }

  async settle(id: string, input: ModelUsage): Promise<void> {
    const usage = structuredClone(input);
    validateModelUsage(usage);
    const { store, executionId } = this.options;
    for (;;) {
      const records = await store.readExecution(executionId);
      const row = records.find(record => record.type === "model/reserved" && record.payload.id === id);
      if (!row) throw new Error("模型请求未预留预算，拒绝结算");
      const reservation = row.payload as unknown as ModelBudgetReservation;
      validateReservation(reservation);
      const previous = records.find(record => record.type === "model/settled" && record.payload.id === id);
      const overrun = usage.inputTokens > reservation.inputTokenLimit || usage.outputTokens > reservation.maxOutputTokens;
      if (previous) {
        const saved = previous.payload.usage as unknown as ModelUsage;
        if (saved.inputTokens !== usage.inputTokens || saved.cachedInputTokens !== usage.cachedInputTokens
          || saved.outputTokens !== usage.outputTokens) throw new Error("模型请求的结算用量已固定");
        if (overrun) throw new ExecutionBudgetExceededError("model_overrun");
        return;
      }
      const saved = await store.commit(executionId, records.at(-1)?.sequence ?? 0, [{ executionId,
        type: "model/settled", payload: { id, usage: { ...usage },
          costNanoMinorUnits: costOf(reservation, usage).toString(), overrun } }]);
      if (!saved) continue;
      if (overrun) throw new ExecutionBudgetExceededError("model_overrun");
      return;
    }
  }
}

export function assertSubagentBudgetAvailable(
  records: readonly RuntimeRecord[], limits: ModelBudgetLimits, child: ModelBudgetLimits,
): void {
  validateLimits(child);
  const state = reduceModelBudget(records, limits);
  if (state.limits.currency !== child.currency) throw new Error("子 Agent 预算币种不一致");
  if (state.overrun) throw new ExecutionBudgetExceededError("model_overrun");
  assertAllocation(state, child.maxTokens, BigInt(child.maxCostMinorUnits) * NANOS_PER_MINOR);
}

export function reduceModelBudget(records: readonly RuntimeRecord[], limits: ModelBudgetLimits): ModelBudgetSnapshot {
  validateLimits(limits);
  const frozen = records.find(record => record.type === "model/budget")?.payload as ModelBudgetLimits | undefined;
  if (frozen) validateLimits(frozen);
  if (frozen && frozen.currency !== limits.currency) throw new Error("持久化模型预算币种不可更改");
  const effectiveLimits = { currency: limits.currency, maxTokens: Math.min(limits.maxTokens, frozen?.maxTokens ?? limits.maxTokens),
    maxCostMinorUnits: minBigInt(BigInt(limits.maxCostMinorUnits), BigInt(frozen?.maxCostMinorUnits ?? limits.maxCostMinorUnits)).toString() };
  let knownTokens = 0;
  let knownCost = 0n;
  let allocatedTokens = 0;
  let allocatedCost = 0n;
  let pendingRequests = 0;
  let overrun = false;
  const reservations = new Set<string>();
  for (const row of records) {
    if (row.type === "subagent/reserved") {
      const child = (row.payload.authority as unknown as { budget: ModelBudgetLimits })?.budget;
      validateLimits(child);
      if (child.currency !== effectiveLimits.currency) throw new Error("持久化子 Agent 预算币种不一致");
      allocatedTokens += child.maxTokens;
      allocatedCost += BigInt(child.maxCostMinorUnits) * NANOS_PER_MINOR;
    }
    if (row.type !== "model/reserved") continue;
    const reservation = row.payload as unknown as ModelBudgetReservation;
    validateReservation(reservation);
    if (reservations.has(reservation.id) || reservation.rates.currency !== effectiveLimits.currency) {
      throw new Error("持久化模型预算预留无效");
    }
    reservations.add(reservation.id);
    const settlements = records.filter(record => record.type === "model/settled" && record.payload.id === reservation.id);
    if (settlements.length > 1) throw new Error("持久化模型预算包含重复结算");
    const settlement = settlements[0];
    if (settlement) {
      const usage = settlement.payload.usage as unknown as ModelUsage;
      validateModelUsage(usage);
      const cost = costOf(reservation, usage);
      const exceeded = usage.inputTokens > reservation.inputTokenLimit || usage.outputTokens > reservation.maxOutputTokens;
      if (settlement.sequence <= row.sequence || cost.toString() !== settlement.payload.costNanoMinorUnits
        || exceeded !== settlement.payload.overrun) throw new Error("持久化模型结算校验失败");
      overrun ||= exceeded;
      knownTokens += usage.inputTokens + usage.outputTokens;
      knownCost += cost;
      allocatedTokens += usage.inputTokens + usage.outputTokens;
      allocatedCost += cost;
    } else {
      pendingRequests += 1;
      allocatedTokens += reservation.inputTokenLimit + reservation.maxOutputTokens;
      allocatedCost += costOf(reservation, { inputTokens: reservation.inputTokenLimit, cachedInputTokens: 0,
        outputTokens: reservation.maxOutputTokens });
    }
  }
  if (records.some(row => row.type === "model/settled" && !reservations.has(String(row.payload.id)))) {
    throw new Error("持久化模型结算缺少预留记录");
  }
  if (!Number.isSafeInteger(allocatedTokens)) throw new Error("累计模型用量无效");
  return { knownTokens, knownCostNanoMinorUnits: knownCost.toString(), allocatedTokens,
    allocatedCostNanoMinorUnits: allocatedCost.toString(), pendingRequests, overrun, limits: effectiveLimits };
}

export function validateModelUsage(usage: ModelUsage): void {
  if (!usage || ![usage.inputTokens, usage.cachedInputTokens, usage.outputTokens,
    usage.inputTokens + usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)
    || usage.cachedInputTokens > usage.inputTokens) throw new TypeError("模型用量无效");
}

function assertAllocation(state: ModelBudgetSnapshot, tokens: number, cost: bigint): void {
  if (!Number.isSafeInteger(tokens) || state.allocatedTokens + tokens > state.limits.maxTokens) {
    throw new ExecutionBudgetExceededError("tokens");
  }
  if (BigInt(state.allocatedCostNanoMinorUnits) + cost > BigInt(state.limits.maxCostMinorUnits) * NANOS_PER_MINOR) {
    throw new ExecutionBudgetExceededError("cost");
  }
}

function costOf(reservation: ModelBudgetReservation, usage: ModelUsage): bigint {
  return BigInt(usage.inputTokens - usage.cachedInputTokens) * BigInt(reservation.rates.inputNanoMinorUnitsPerToken)
    + BigInt(usage.cachedInputTokens) * BigInt(reservation.rates.cachedInputNanoMinorUnitsPerToken)
    + BigInt(usage.outputTokens) * BigInt(reservation.rates.outputNanoMinorUnitsPerToken);
}

function validateLimits(limits: ModelBudgetLimits): void {
  if (!limits || !Number.isSafeInteger(limits.maxTokens) || limits.maxTokens < 0
    || !integerString(limits.maxCostMinorUnits) || !/^[A-Z]{3}$/u.test(limits.currency)) throw new TypeError("模型预算无效");
}

function validateReservation(reservation: ModelBudgetReservation): void {
  if (!reservation || typeof reservation.id !== "string" || !reservation.id || reservation.id.length > 512
    || !/^[0-9a-f]{64}$/u.test(reservation.requestDigest)
    || !Number.isSafeInteger(reservation.inputTokenLimit) || reservation.inputTokenLimit < 0
    || !Number.isSafeInteger(reservation.maxOutputTokens) || reservation.maxOutputTokens < 1) {
    throw new TypeError("模型预算预留无效");
  }
  if (reservation.inputTokenLimitBasis !== undefined
    && !["provider_count", "conservative_utf8_estimate"].includes(reservation.inputTokenLimitBasis)) {
    throw new TypeError("模型输入用量预留依据无效");
  }
  const rates = reservation.rates;
  if (!rates || typeof rates.id !== "string" || !rates.id || rates.id.length > 512 || !/^[A-Z]{3}$/u.test(rates.currency)
    || ![rates.inputNanoMinorUnitsPerToken, rates.cachedInputNanoMinorUnitsPerToken,
      rates.outputNanoMinorUnitsPerToken].every(integerString)
    || BigInt(rates.cachedInputNanoMinorUnitsPerToken) > BigInt(rates.inputNanoMinorUnitsPerToken)) {
    throw new TypeError("模型价格无效");
  }
}

function integerString(value: unknown): value is string { return typeof value === "string" && /^(0|[1-9][0-9]{0,30})$/u.test(value); }
function minBigInt(left: bigint, right: bigint): bigint { return left < right ? left : right; }
