// SPDX-License-Identifier: Apache-2.0

import { validateModelUsage, completeWithModelBudget, PersistentModelBudget, ExecutionBudgetExceededError,
  type ModelMessage, type ModelRequest, type ModelResponse, type ModelToolCall,
  type ModelUsage, type ModelBudgetReservation, type ModelBudgetLimits, type RuntimeStore } from "@mn/agent-runtime";
import type { JsonObject } from "@mn/contracts";
import { findModelPrice } from "@mn/kernel";

export type ByokProviderId = "openai" | "deepseek" | "anthropic";

export interface ByokModelInvocation {
  readonly presetId: ByokProviderId;
  readonly model: string;
  readonly apiKey: string;
  readonly request: ModelRequest;
  readonly signal: AbortSignal;
}

export type ByokModelInvoker = (input: ByokModelInvocation) => Promise<ModelResponse>;
export type ByokModelQuote = Omit<ModelBudgetReservation, "id" | "requestDigest">;
export type ByokModelQuoter = (input: ByokModelInvocation) => Promise<ByokModelQuote>;

export async function invokeBudgetedByokModel(options: {
  readonly input: ByokModelInvocation;
  readonly store: RuntimeStore;
  readonly limits: ModelBudgetLimits;
  readonly invoke: ByokModelInvoker;
  readonly quote: ByokModelQuoter;
}): Promise<ModelResponse> {
  const request = structuredClone(options.input.request);
  request.messages.forEach(Object.freeze);
  Object.freeze(request.messages);
  Object.freeze(request.availableToolIds);
  Object.freeze(request);
  const input = Object.freeze({ ...options.input, request });
  const state = await new PersistentModelBudget({ store: options.store, executionId: request.executionId, limits: options.limits }).snapshot();
  if (state.overrun) throw new ExecutionBudgetExceededError("model_overrun");
  if (state.pendingRequests) throw new ExecutionBudgetExceededError("model_unknown");
  if (state.allocatedTokens >= state.limits.maxTokens) throw new ExecutionBudgetExceededError("tokens");
  let quote: ByokModelQuote;
  try { quote = await options.quote(input); }
  catch (error) {
    if (error instanceof ModelTransportError || error instanceof ExecutionBudgetExceededError) throw error;
    throw new ModelTransportError("无法预检模型预算，已停止调用");
  }
  return completeWithModelBudget({ store: options.store, limits: options.limits, modelKey: `${input.presetId}:${input.model}`,
    request, quote, signal: input.signal, complete: (limitedRequest, signal) => options.invoke({ ...input, request: limitedRequest, signal }) });
}

export type ModelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ByokModelInvokerOptions {
  readonly fetch?: ModelFetch;
  readonly timeoutMs?: number;
}

export class ModelTransportError extends Error {
  readonly code = "MODEL_TRANSPORT_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "ModelTransportError";
  }
}

const PROVIDER_ENDPOINTS: Readonly<Record<ByokProviderId, string>> = {
  openai: "https://api.openai.com/v1/responses",
  deepseek: "https://api.deepseek.com/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
};

export function createByokModelQuoter(options: ByokModelInvokerOptions = {}): ByokModelQuoter {
  const fetchModel = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("模型计数超时无效");
  return async input => {
    assertInvocation(input);
    input.signal.throwIfAborted();
    const price = findModelPrice(input.presetId, input.model);
    if (!price) throw new ModelTransportError("该模型缺少已核对的参考价格，已拒绝调用");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
    const init = requestOptions(input, signal, toolDescriptors(input.request.availableToolIds));
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    delete body.max_output_tokens;
    delete body.max_tokens;
    delete body.store;
    delete body.stream;
    let inputTokenLimit: number;
    let inputTokenLimitBasis: ByokModelQuote["inputTokenLimitBasis"];
    if (input.presetId === "deepseek") {
      // No documented count endpoint. This is an estimate, not a tokenizer guarantee.
      inputTokenLimit = Buffer.byteLength(JSON.stringify(body), "utf8") * 2 + 4096;
      inputTokenLimitBasis = "conservative_utf8_estimate";
    } else {
      const endpoint = input.presetId === "openai" ? "https://api.openai.com/v1/responses/input_tokens"
        : "https://api.anthropic.com/v1/messages/count_tokens";
      try {
        inputTokenLimit = await raceModelCancellation(async () => {
          const response = await fetchModel(endpoint, { ...init, body: JSON.stringify(body), redirect: "error" });
          if (!response.ok) throw new Error();
          const result: unknown = await readModelJson(response, signal);
          if (!isObject(result)) throw new Error();
          return tokenNumber(result.input_tokens);
        }, signal);
      } catch { throw new ModelTransportError("无法核对模型输入 token 数，已停止调用"); }
      inputTokenLimitBasis = "provider_count";
    }
    if (inputTokenLimit > price.maxInputTokens) throw new ModelTransportError("模型输入超过参考价格适用范围，请缩短上下文");
    return { inputTokenLimit, inputTokenLimitBasis, maxOutputTokens: input.request.maxOutputTokens ?? 4096, rates: price.rates };
  };
}

async function raceModelCancellation<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new ModelTransportError("模型请求已取消或超时"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work(), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function createByokModelInvoker(options: ByokModelInvokerOptions = {}): ByokModelInvoker {
  const fetchModel = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("模型调用超时时间必须是正整数毫秒");
  }
  return async (input) => {
    assertInvocation(input);
    if (input.signal.aborted) throw new ModelTransportError("模型调用已取消");
    const tools = toolDescriptors(input.request.availableToolIds);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort("模型调用超时"), timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout.signal]);
    try {
      let response: Response;
      try {
        response = await raceModelCancellation(() => fetchModel(PROVIDER_ENDPOINTS[input.presetId], requestOptions(input, signal, tools)), signal);
      } catch {
        if (input.signal.aborted) throw new ModelTransportError("模型调用已取消");
        if (timeout.signal.aborted) throw new ModelTransportError("模型调用超时");
        throw new ModelTransportError("无法连接模型厂商");
      }
      if (!response.ok) {
        throw new ModelTransportError(`模型厂商返回 HTTP ${response.status}`);
      }
      let payload: unknown;
      try {
        payload = await readModelJson(response, signal);
      } catch {
        throw new ModelTransportError("模型厂商返回了无效响应");
      }
      const result = extractResponse(input.presetId, payload, tools);
      if (!result.text && result.toolCalls.length === 0) {
        throw new ModelTransportError("模型厂商未返回文本或工具调用");
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
}

interface ProviderToolDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

function requestOptions(
  input: ByokModelInvocation,
  signal: AbortSignal,
  tools: readonly ProviderToolDescriptor[],
): RequestInit {
  const common = {
    method: "POST",
    redirect: "error",
    signal,
    headers: { "content-type": "application/json" },
  } satisfies RequestInit;
  if (input.presetId === "openai") {
    return {
      ...common,
      headers: { ...common.headers, authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.model,
        input: providerMessages(input.request.messages),
        store: false,
        max_output_tokens: input.request.maxOutputTokens ?? 4096,
        ...(tools.length > 0 ? {
          tools: tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: genericObjectSchema(),
            strict: false,
          })),
        } : {}),
      }),
    };
  }
  if (input.presetId === "deepseek") {
    return {
      ...common,
      headers: { ...common.headers, authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.model,
        messages: providerMessages(input.request.messages),
        stream: false,
        max_tokens: input.request.maxOutputTokens ?? 4096,
        ...(tools.length > 0 ? {
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: genericObjectSchema(),
            },
          })),
        } : {}),
      }),
    };
  }
  const normalizedMessages = providerMessages(input.request.messages);
  const system = normalizedMessages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages = normalizedMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: message.content }));
  return {
    ...common,
    headers: {
      ...common.headers,
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.request.maxOutputTokens ?? 4096,
      ...(system ? { system } : {}),
      messages,
      ...(tools.length > 0 ? {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: genericObjectSchema(),
        })),
      } : {}),
    }),
  };
}

function extractResponse(
  provider: ByokProviderId,
  payload: unknown,
  tools: readonly ProviderToolDescriptor[],
): ModelResponse {
  const usage = extractUsage(provider, payload);
  return {
    text: extractText(provider, payload),
    toolCalls: extractToolCalls(provider, payload, tools),
    ...(usage ? { usage } : {}),
  };
}

function extractUsage(provider: ByokProviderId, payload: unknown): ModelUsage | undefined {
  if (!isObject(payload) || payload.usage === undefined || payload.usage === null) return undefined;
  try {
    if (!isObject(payload.usage)) throw new TypeError();
    const raw = payload.usage;
    let usage: ModelUsage;
    if (provider === "anthropic") {
      const cached = tokenNumber(raw.cache_read_input_tokens ?? 0);
      if (tokenNumber(raw.cache_creation_input_tokens ?? 0) !== 0) {
        throw new ModelTransportError("模型返回了未启用的缓存写入用量，费用需要人工核对");
      }
      usage = { inputTokens: tokenNumber(raw.input_tokens) + cached, cachedInputTokens: cached,
        outputTokens: tokenNumber(raw.output_tokens) };
    } else if (provider === "openai") {
      if (raw.input_tokens_details !== undefined && !isObject(raw.input_tokens_details)) throw new TypeError();
      usage = { inputTokens: tokenNumber(raw.input_tokens), outputTokens: tokenNumber(raw.output_tokens),
        cachedInputTokens: tokenNumber(isObject(raw.input_tokens_details) ? raw.input_tokens_details.cached_tokens ?? 0 : 0) };
    } else {
      usage = { inputTokens: tokenNumber(raw.prompt_tokens), cachedInputTokens: tokenNumber(raw.prompt_cache_hit_tokens ?? 0),
        outputTokens: tokenNumber(raw.completion_tokens) };
      if (raw.prompt_cache_miss_tokens !== undefined
        && tokenNumber(raw.prompt_cache_miss_tokens) + usage.cachedInputTokens !== usage.inputTokens) throw new TypeError();
    }
    validateModelUsage(usage);
    if (raw.total_tokens !== undefined && tokenNumber(raw.total_tokens) !== usage.inputTokens + usage.outputTokens) throw new TypeError();
    return usage;
  } catch (error) {
    if (error instanceof ModelTransportError) throw error;
    throw new ModelTransportError("模型厂商返回了无效用量，费用需要人工核对");
  }
}

function tokenNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError();
  return value;
}

function extractText(provider: ByokProviderId, payload: unknown): string {
  if (!isObject(payload)) return "";
  if (provider === "openai") {
    if (typeof payload.output_text === "string") return payload.output_text;
    if (!Array.isArray(payload.output)) return "";
    return payload.output.flatMap((output) => {
      if (!isObject(output) || !Array.isArray(output.content)) return [];
      return output.content.flatMap((content) =>
        isObject(content) && content.type === "output_text" && typeof content.text === "string"
          ? [content.text]
          : []);
    }).join("");
  }
  if (provider === "deepseek") {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    return isObject(choice) && isObject(choice.message) && typeof choice.message.content === "string"
      ? choice.message.content
      : "";
  }
  if (!Array.isArray(payload.content)) return "";
  return payload.content.flatMap((content) =>
    isObject(content) && content.type === "text" && typeof content.text === "string"
      ? [content.text]
      : []).join("");
}

function extractToolCalls(
  provider: ByokProviderId,
  payload: unknown,
  tools: readonly ProviderToolDescriptor[],
): readonly ModelToolCall[] {
  if (!isObject(payload)) return [];
  const byName = new Map(tools.map((tool) => [tool.name, tool.id]));
  let calls: readonly unknown[] = [];
  if (provider === "openai") {
    calls = Array.isArray(payload.output)
      ? payload.output.filter((item) => isObject(item) && item.type === "function_call")
      : [];
  } else if (provider === "deepseek") {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const message = isObject(choice) && isObject(choice.message) ? choice.message : undefined;
    calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  } else {
    calls = Array.isArray(payload.content)
      ? payload.content.filter((item) => isObject(item) && item.type === "tool_use")
      : [];
  }
  const parsed = calls.map((value, index): ModelToolCall => {
    if (!isObject(value)) throw new ModelTransportError("模型厂商返回了无效工具调用");
    if (provider === "deepseek") {
      if (!isObject(value.function)) throw new ModelTransportError("模型厂商返回了无效工具调用");
      return toolCall(
        requiredText(value.id, `tool-${index + 1}`),
        requiredText(value.function.name),
        parseToolArguments(value.function.arguments),
        byName,
      );
    }
    if (provider === "anthropic") {
      return toolCall(
        requiredText(value.id, `tool-${index + 1}`),
        requiredText(value.name),
        jsonObject(value.input),
        byName,
      );
    }
    return toolCall(
      requiredText(value.call_id ?? value.id, `tool-${index + 1}`),
      requiredText(value.name),
      parseToolArguments(value.arguments),
      byName,
    );
  });
  if (new Set(parsed.map((call) => call.id)).size !== parsed.length) {
    throw new ModelTransportError("模型厂商返回了重复的工具调用 id");
  }
  return parsed;
}

function toolDescriptors(ids: readonly string[]): readonly ProviderToolDescriptor[] {
  return [...new Set(ids)].map((id, index) => ({
    id,
    name: `mn_tool_${index + 1}`,
    description: `木牛受控工具：${id}`,
  }));
}

function toolCall(
  id: string,
  providerName: string,
  arguments_: JsonObject,
  byName: ReadonlyMap<string, string>,
): ModelToolCall {
  return {
    id,
    toolId: byName.get(providerName) ?? providerName,
    arguments: arguments_,
  };
}

function providerMessages(messages: readonly ModelMessage[]): readonly {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}[] {
  return messages.map((message) => message.role === "tool"
    ? {
        role: "user" as const,
        content: `[工具 ${message.name ?? "unknown"} 的结果]\n${message.content}`,
      }
    : { role: message.role, content: message.content });
}

function genericObjectSchema(): JsonObject {
  return { type: "object", additionalProperties: true };
}

function parseToolArguments(value: unknown): JsonObject {
  if (isObject(value)) return structuredClone(value) as JsonObject;
  if (typeof value !== "string") throw new ModelTransportError("工具调用参数不是 JSON 对象");
  try {
    return jsonObject(JSON.parse(value));
  } catch (error) {
    if (error instanceof ModelTransportError) throw error;
    throw new ModelTransportError("工具调用参数不是有效 JSON");
  }
}

function jsonObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new ModelTransportError("工具调用参数不是 JSON 对象");
  return structuredClone(value) as JsonObject;
}

function requiredText(value: unknown, fallback?: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (fallback !== undefined) return fallback;
  throw new ModelTransportError("模型厂商返回了无效工具调用");
}

function assertInvocation(input: ByokModelInvocation): void {
  if (!Object.hasOwn(PROVIDER_ENDPOINTS, input.presetId)) {
    throw new ModelTransportError("模型厂商预设不受支持");
  }
  if (!input.model.trim()) throw new ModelTransportError("模型名称不能为空");
  if (!input.apiKey.trim()) throw new ModelTransportError("模型凭据为空");
  if (input.request.maxOutputTokens !== undefined
    && (!Number.isSafeInteger(input.request.maxOutputTokens) || input.request.maxOutputTokens < 1)) {
    throw new ModelTransportError("模型输出 token 上限无效");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readModelJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const maximumBytes = 8 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new ModelTransportError("模型厂商返回空响应");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  try {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > maximumBytes)) {
      throw new ModelTransportError("模型响应超过允许大小");
    }
    for (;;) {
      const chunk = await raceModelCancellation(() => reader.read(), signal);
      if (chunk.done) { done = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new ModelTransportError("模型响应超过允许大小");
      chunks.push(chunk.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } finally {
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
