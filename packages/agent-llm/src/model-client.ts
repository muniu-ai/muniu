// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import {
  CallId,
  assertSafePublicControlIdV1,
  createModelAttemptStartedV1,
  createModelAttemptTerminalV1,
  createModelPricingSnapshotV1,
  createProtectedJsonViewV1,
  deepFreeze,
  digestJson,
  inspectModelPricingSnapshotV1,
  snapshotBoundedJsonValue,
  type FinishReason,
  type JsonValue,
  type LlmRequest,
  type Message,
  type ModelAttemptStartedV1,
  type ModelPricingSnapshotV1,
  type StreamChunk,
  type TokenUsage
} from "@mn/agent-protocol";

import { ModelOutcomePersistenceError } from "./errors.js";
import {
  classifyHttpUsageV1,
  dispatchHttpRequest,
  type HttpDispatchResult,
  type HttpResponseSnapshot
} from "./http-transport.js";
import { parseSse, type SseEvent } from "./sse.js";
import type { LlmAttemptAuditSink, LlmStreamExecutionContext } from "./runtime.js";

export type ModelApiFormat = "openai_chat" | "openai_responses" | "anthropic_messages";

export interface ModelSecretRef {
  readonly type: "env" | "local_encrypted" | "keychain";
  readonly ref: string;
}

export interface ModelProviderRoute {
  readonly providerId: string;
  readonly apiFormat: ModelApiFormat;
  readonly baseUrl: string;
  readonly apiKeyRef?: ModelSecretRef;
  readonly pricing?: ModelPricingSnapshotV1;
}

export interface ModelPartialUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly thinkingTokens?: number;
}

export interface ModelClientReceipt {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly model: string;
  readonly apiFormat: ModelApiFormat;
  readonly attempt: number;
  readonly dispatched: boolean;
  readonly outcome: "completed" | "failed" | "interrupted";
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly fallbackAllowed: boolean;
  readonly failureCode?: "secret_unavailable" | "request_invalid" | "transport_error" | "http_error" | "stream_error" | "stream_interrupted" | "cancelled";
  readonly usageState: "complete" | "partial" | "missing";
  readonly usage?: ModelPartialUsage;
}

export interface HttpModelAdapterOptions {
  readonly id: string;
  readonly routes: readonly ModelProviderRoute[];
  readonly resolveSecret: (reference: ModelSecretRef) => Promise<string | undefined>;
  readonly fetch?: typeof globalThis.fetch;
  readonly onReceipt?: (receipt: ModelClientReceipt) => void | Promise<void>;
}

type JsonRecord = Record<string, JsonValue>;

interface MutableUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;
}

interface DecodeState {
  readonly usage: MutableUsage;
  readonly chatCalls: Map<number, { id: string; name?: string }>;
  readonly responseCalls: Map<number, { id: string; name?: string }>;
  finishEmitted: boolean;
  pendingFinish?: FinishReason;
}

const ABORTED = Symbol("model-operation-aborted");

class ModelReceiptObserverError extends Error {}

const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

type UnknownRecord = Record<string, unknown>;

function exactDataRecord(value: unknown, allowedKeys: readonly string[], label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    throw new TypeError(`${label} must be an exact data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be an exact data object`);
  }
  const allowed = new Set(allowedKeys);
  const output: UnknownRecord = Object.create(null) as UnknownRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${label} must be an exact data object`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must be an exact data object`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exactDataArray(value: unknown, label: string): readonly unknown[] {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !Array.isArray(value)) {
    throw new TypeError(`${label} must be an exact data array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new TypeError(`${label} must be an exact data array`);
  }
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must be an exact data array`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function snapshotSecretRef(value: unknown): ModelSecretRef {
  const source = exactDataRecord(value, ["type", "ref"], "model secret reference");
  if (source.type !== "env" && source.type !== "local_encrypted" && source.type !== "keychain") {
    throw new TypeError("model secret reference type is invalid");
  }
  assertSafePublicControlIdV1(source.ref, "model secret reference");
  return Object.freeze({ type: source.type, ref: source.ref });
}

function snapshotRoute(value: unknown): ModelProviderRoute {
  const source = exactDataRecord(value, ["providerId", "apiFormat", "baseUrl", "apiKeyRef", "pricing"], "model provider route");
  assertSafePublicControlIdV1(source.providerId, "model provider identifier");
  if (source.apiFormat !== "openai_chat" && source.apiFormat !== "openai_responses" && source.apiFormat !== "anthropic_messages") {
    throw new TypeError("model provider API format is invalid");
  }
  if (typeof source.baseUrl !== "string" || source.baseUrl.length === 0 || source.baseUrl.length > 2_048) {
    throw new TypeError("model provider base URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(source.baseUrl);
  } catch {
    throw new TypeError("model provider base URL is invalid");
  }
  const loopbackHttp = parsed.protocol === "http:" && (
    parsed.hostname === "localhost"
    || parsed.hostname.endsWith(".localhost")
    || parsed.hostname === "[::1]"
    || /^127(?:\.[0-9]{1,3}){3}$/u.test(parsed.hostname)
  );
  if ((parsed.protocol !== "https:" && !loopbackHttp)
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.hash.length > 0
    || parsed.search.length > 0) {
    throw new TypeError("model provider base URL is invalid");
  }
  const apiKeyRef = source.apiKeyRef === undefined ? undefined : snapshotSecretRef(source.apiKeyRef);
  const pricing = source.pricing === undefined
    ? createModelPricingSnapshotV1({})
    : inspectModelPricingSnapshotV1(source.pricing);
  if (pricing === undefined) throw new TypeError("model provider pricing is invalid");
  return Object.freeze({
    providerId: source.providerId,
    apiFormat: source.apiFormat,
    baseUrl: parsed.toString(),
    ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
    pricing
  });
}

function snapshotAttemptAudit(value: LlmStreamExecutionContext | undefined): LlmAttemptAuditSink | undefined {
  if (value === undefined) return undefined;
  const context = exactDataRecord(value, ["attemptAudit"], "model execution context");
  const sink = exactDataRecord(context.attemptAudit, ["started", "terminal"], "model attempt audit sink");
  if (typeof sink.started !== "function" || utilTypes.isProxy(sink.started)
    || typeof sink.terminal !== "function" || utilTypes.isProxy(sink.terminal)) {
    throw new TypeError("model attempt audit sink is invalid");
  }
  const target = context.attemptAudit as object;
  return Object.freeze({
    started: (sink.started as LlmAttemptAuditSink["started"]).bind(target),
    terminal: (sink.terminal as LlmAttemptAuditSink["terminal"]).bind(target)
  });
}

function createAttemptStarted(
  route: ModelProviderRoute,
  request: LlmRequest,
  attempt: number
): ModelAttemptStartedV1 {
  const protectedRequest = createProtectedJsonViewV1({
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.tools === undefined ? {} : { tools: request.tools })
  });
  return createModelAttemptStartedV1({
    providerId: route.providerId,
    modelId: request.model,
    apiFormat: route.apiFormat,
    attempt,
    protectedRequestDigest: protectedRequest.digest,
    routeDigest: digestJson({
      providerId: route.providerId,
      apiFormat: route.apiFormat,
      baseUrl: route.baseUrl,
      ...(route.apiKeyRef === undefined ? {} : { apiKeyRef: route.apiKeyRef })
    }),
    pricing: route.pricing ?? createModelPricingSnapshotV1({})
  });
}

function snapshotRequest(value: unknown): LlmRequest {
  const source = exactDataRecord(value, ["provider", "model", "messages", "system", "tools", "signal"], "model request");
  assertSafePublicControlIdV1(source.provider, "model request provider");
  assertSafePublicControlIdV1(source.model, "model request model");
  if (source.system !== undefined && typeof source.system !== "string") {
    throw new TypeError("model request system prompt must be a string");
  }
  const signal = source.signal;
  if (signal !== undefined && (typeof signal !== "object" || signal === null || utilTypes.isProxy(signal) || !(signal instanceof AbortSignal))) {
    throw new TypeError("model request signal must be an AbortSignal");
  }
  if (signal !== undefined && abortSignalAbortedGetter === undefined) {
    throw new TypeError("model request signal must be an AbortSignal");
  }
  if (signal !== undefined) {
    try {
      Reflect.apply(abortSignalAbortedGetter as (this: AbortSignal) => boolean, signal, []);
    } catch {
      throw new TypeError("model request signal must be an AbortSignal");
    }
  }
  const messages = snapshotBoundedJsonValue(source.messages);
  if (!Array.isArray(messages)) throw new TypeError("model request messages must be an array");
  const requestTools = source.tools === undefined ? undefined : snapshotBoundedJsonValue(source.tools);
  if (requestTools !== undefined && !Array.isArray(requestTools)) {
    throw new TypeError("model request tools must be an array");
  }
  return deepFreeze({
    provider: source.provider,
    model: source.model,
    messages: messages as unknown as Message[],
    ...(source.system === undefined ? {} : { system: source.system }),
    ...(requestTools === undefined ? {} : { tools: requestTools as unknown as LlmRequest["tools"] }),
    ...(signal === undefined ? {} : { signal })
  });
}

function cancelledChunks(): readonly StreamChunk[] {
  return [
    {
      type: "error",
      error: { code: "LLM_CANCELLED", message: "Model request cancelled", retryable: false }
    },
    { type: "finish", reason: "cancelled" }
  ];
}

function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined || abortSignalAbortedGetter === undefined) return signal !== undefined;
  try {
    return Reflect.apply(abortSignalAbortedGetter, signal, []) === true;
  } catch {
    return true;
  }
}

async function awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  void operation.catch(() => undefined);
  if (signal === undefined) return operation;
  if (isAborted(signal)) return ABORTED;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    abortListener = () => { resolve(ABORTED); };
    EventTarget.prototype.addEventListener.call(signal, "abort", abortListener, { once: true });
  });
  try {
    if (isAborted(signal)) return ABORTED;
    return await Promise.race([operation, aborted]);
  } finally {
    if (abortListener !== undefined) {
      EventTarget.prototype.removeEventListener.call(signal, "abort", abortListener);
    }
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function array(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function string(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function tokenCount(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseEvent(event: SseEvent): JsonRecord | undefined {
  if (event.data === "[DONE]") return undefined;
  try {
    return record(JSON.parse(event.data));
  } catch {
    throw new Error("MODEL_STREAM_INVALID_JSON");
  }
}

function endpoint(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const basePath = url.pathname.replace(/\/$/u, "");
  url.pathname = `${basePath}${suffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function textContent(message: Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" || block.type === "thinking") parts.push(block.text);
    if (block.type === "tool-result") {
      for (const content of block.content) parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function blockText(message: Message, type: "text" | "thinking"): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if ((block.type === "text" || block.type === "thinking") && block.type === type) parts.push(block.text);
  }
  return parts.join("\n");
}

function openAiMessages(request: LlmRequest): JsonValue[] {
  const messages: JsonValue[] = [];
  if (request.system !== undefined) messages.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    if (message.source.kind === "tool") {
      messages.push({ role: "tool", tool_call_id: message.source.callId, content: textContent(message) });
      continue;
    }
    const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: block.arguments }
    }));
    messages.push({
      role: message.role,
      content: blockText(message, "text"),
      ...(message.role === "assistant" && blockText(message, "thinking").length > 0
        ? { reasoning_content: blockText(message, "thinking") }
        : {}),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls })
    });
  }
  return messages;
}

function openAiResponsesInput(request: LlmRequest): JsonValue[] {
  const input: JsonValue[] = [];
  for (const message of request.messages) {
    if (message.source.kind === "tool") {
      input.push({ type: "function_call_output", call_id: message.source.callId, output: textContent(message) });
      continue;
    }
    const content = blockText(message, "text");
    if (content.length > 0) input.push({ type: "message", role: message.role, content });
    for (const block of message.content) {
      if (block.type === "tool-call") {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: block.arguments
        });
      }
    }
  }
  return input;
}

function parseToolInput(value: string): JsonRecord {
  try {
    const parsed = record(JSON.parse(value));
    if (parsed !== undefined) return parsed;
  } catch {
    // The fixed error below is intentionally independent of tool arguments.
  }
  throw new TypeError("model tool arguments must contain a JSON object");
}

function anthropicMessages(request: LlmRequest): JsonValue[] {
  return request.messages.map((message) => {
    if (message.source.kind === "tool") {
      const result = message.content[0];
      if (result?.type !== "tool-result") throw new TypeError("model tool result message is invalid");
      return {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.source.callId,
          content: result.content.map((block) => ({ type: "text", text: block.text })),
          ...(result.isError === undefined ? {} : { is_error: result.isError })
        }]
      };
    }
    const content: JsonValue[] = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      if (block.type === "tool-call") {
        if (message.role !== "assistant") throw new TypeError("model user message cannot contain a tool call");
        content.push({ type: "tool_use", id: block.id, name: block.name, input: parseToolInput(block.arguments) });
      }
    }
    return { role: message.role, content };
  });
}

function tools(request: LlmRequest): JsonValue[] | undefined {
  return request.tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }));
}

function requestBody(route: ModelProviderRoute, request: LlmRequest): JsonValue {
  const requestTools = tools(request);
  if (route.apiFormat === "openai_chat") {
    return {
      model: request.model,
      messages: openAiMessages(request),
      stream: true,
      stream_options: { include_usage: true },
      ...(requestTools === undefined ? {} : { tools: requestTools })
    };
  }
  if (route.apiFormat === "openai_responses") {
    return {
      model: request.model,
      input: openAiResponsesInput(request),
      stream: true,
      ...(request.system === undefined ? {} : { instructions: request.system }),
      ...(requestTools === undefined ? {} : {
        tools: request.tools?.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }))
      })
    };
  }
  return {
    model: request.model,
    messages: anthropicMessages(request),
    stream: true,
    max_tokens: 4096,
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.tools === undefined ? {} : {
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
      }))
    })
  };
}

function usageSnapshot(usage: MutableUsage): {
  state: ModelClientReceipt["usageState"];
  partial?: ModelPartialUsage;
  complete?: TokenUsage;
} {
  const partial = Object.freeze({ ...usage });
  const classified = classifyHttpUsageV1({
    observed: Object.keys(partial).length > 0,
    ...(partial.inputTokens === undefined ? {} : { inputTokens: partial.inputTokens }),
    ...(partial.outputTokens === undefined ? {} : { outputTokens: partial.outputTokens })
  });
  if (classified.state === "missing") return { state: "missing" };
  if (classified.state === "partial") {
    return { state: "partial", partial };
  }
  return {
    state: "complete",
    partial,
    complete: partial as TokenUsage
  };
}

function finishReason(value: string | undefined): FinishReason {
  if (value === "tool_calls" || value === "tool_use") return "tool-calls";
  if (value === "length" || value === "max_tokens") return "max-tokens";
  return "stop";
}

function applyOpenAiUsage(value: JsonValue | undefined, usage: MutableUsage): void {
  const source = record(value);
  if (source === undefined) return;
  const inputTokens = tokenCount(source.prompt_tokens ?? source.input_tokens);
  const outputTokens = tokenCount(source.completion_tokens ?? source.output_tokens);
  const promptDetails = record(source.prompt_tokens_details ?? source.input_tokens_details);
  const completionDetails = record(source.completion_tokens_details ?? source.output_tokens_details);
  const cacheReadTokens = tokenCount(
    source.cache_read_input_tokens
      ?? source.prompt_cache_hit_tokens
      ?? promptDetails?.cached_tokens
  );
  const cacheWriteTokens = tokenCount(source.cache_creation_input_tokens);
  const thinkingTokens = tokenCount(completionDetails?.reasoning_tokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens;
  if (thinkingTokens !== undefined) usage.thinkingTokens = thinkingTokens;
}

function* providerDeclaredError(state: DecodeState): Iterable<StreamChunk> {
  state.finishEmitted = true;
  yield {
    type: "error",
    error: { code: "LLM_PROVIDER_ERROR", message: "Model provider returned an error", retryable: false }
  };
  yield { type: "finish", reason: "error" };
}

function* decodeOpenAiChat(event: SseEvent, state: DecodeState): Iterable<StreamChunk> {
  const value = parseEvent(event);
  if (value === undefined) return;
  if (value.error !== undefined) {
    yield* providerDeclaredError(state);
    return;
  }
  const choices = array(value.choices);
  const choice = record(choices?.[0]);
  const delta = record(choice?.delta);
  const content = string(delta?.content);
  if (content !== undefined && content.length > 0) yield { type: "text-delta", index: 0, text: content };
  const thinking = string(delta?.reasoning_content ?? delta?.reasoning);
  if (thinking !== undefined && thinking.length > 0) yield { type: "thinking-delta", index: 1, text: thinking };
  for (const item of array(delta?.tool_calls) ?? []) {
    const call = record(item);
    const providerIndex = tokenCount(call?.index);
    if (providerIndex === undefined) continue;
    const functionCall = record(call?.function);
    const previous = state.chatCalls.get(providerIndex);
    const id = string(call?.id) ?? previous?.id;
    const name = string(functionCall?.name) ?? previous?.name;
    if (id === undefined) throw new Error("MODEL_STREAM_TOOL_CALL_INVALID");
    state.chatCalls.set(providerIndex, { id, ...(name === undefined ? {} : { name }) });
    yield {
      type: "tool-call-delta",
      index: providerIndex + 2,
      id: CallId(id),
      ...(name === undefined || previous?.name === name ? {} : { name }),
      argumentsDelta: string(functionCall?.arguments) ?? ""
    };
  }
  applyOpenAiUsage(value.usage, state.usage);
  const completeUsage = usageSnapshot(state.usage).complete;
  if (value.usage !== undefined && completeUsage !== undefined) yield { type: "usage", usage: completeUsage };
  const finish = string(choice?.finish_reason);
  if (finish !== undefined) {
    state.pendingFinish = finishReason(finish);
  }
}

function* decodeOpenAiResponses(event: SseEvent, state: DecodeState): Iterable<StreamChunk> {
  const value = parseEvent(event);
  if (value === undefined) return;
  const type = string(value.type) ?? event.event;
  if (type === "error" || type === "response.failed" || type === "response.error" || value.error !== undefined) {
    yield* providerDeclaredError(state);
    return;
  }
  const index = tokenCount(value.output_index) ?? 0;
  if (type === "response.output_text.delta") {
    yield { type: "text-delta", index, text: string(value.delta) ?? "" };
    return;
  }
  if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
    yield { type: "thinking-delta", index, text: string(value.delta) ?? "" };
    return;
  }
  if (type === "response.output_item.added") {
    const item = record(value.item);
    if (string(item?.type) !== "function_call") return;
    const id = string(item?.call_id ?? item?.id);
    const name = string(item?.name);
    if (id === undefined) throw new Error("MODEL_STREAM_TOOL_CALL_INVALID");
    state.responseCalls.set(index, { id, ...(name === undefined ? {} : { name }) });
    yield { type: "tool-call-delta", index, id: CallId(id), ...(name === undefined ? {} : { name }), argumentsDelta: "" };
    return;
  }
  if (type === "response.function_call_arguments.delta") {
    const call = state.responseCalls.get(index);
    if (call === undefined) throw new Error("MODEL_STREAM_TOOL_CALL_INVALID");
    yield { type: "tool-call-delta", index, id: CallId(call.id), argumentsDelta: string(value.delta) ?? "" };
    return;
  }
  if (type === "response.completed" || type === "response.incomplete") {
    const response = record(value.response);
    applyOpenAiUsage(response?.usage, state.usage);
    const completeUsage = usageSnapshot(state.usage).complete;
    if (completeUsage !== undefined) yield { type: "usage", usage: completeUsage };
    state.finishEmitted = true;
    yield {
      type: "finish",
      reason: type === "response.incomplete" ? "max-tokens" : "stop"
    };
  }
}

function* decodeAnthropic(event: SseEvent, state: DecodeState): Iterable<StreamChunk> {
  const value = parseEvent(event);
  if (value === undefined) return;
  const type = string(value.type) ?? event.event;
  if (type === "error" || value.error !== undefined) {
    yield* providerDeclaredError(state);
    return;
  }
  const index = tokenCount(value.index) ?? 0;
  if (type === "message_start") {
    applyOpenAiUsage(record(value.message)?.usage, state.usage);
    return;
  }
  if (type === "content_block_start") {
    const block = record(value.content_block);
    if (string(block?.type) !== "tool_use") return;
    const id = string(block?.id);
    const name = string(block?.name);
    if (id === undefined) throw new Error("MODEL_STREAM_TOOL_CALL_INVALID");
    state.responseCalls.set(index, { id, ...(name === undefined ? {} : { name }) });
    yield { type: "tool-call-delta", index, id: CallId(id), ...(name === undefined ? {} : { name }), argumentsDelta: "" };
    return;
  }
  if (type === "content_block_delta") {
    const delta = record(value.delta);
    const deltaType = string(delta?.type);
    if (deltaType === "text_delta") yield { type: "text-delta", index, text: string(delta?.text) ?? "" };
    if (deltaType === "thinking_delta") yield { type: "thinking-delta", index, text: string(delta?.thinking) ?? "" };
    if (deltaType === "input_json_delta") {
      const call = state.responseCalls.get(index);
      if (call === undefined) throw new Error("MODEL_STREAM_TOOL_CALL_INVALID");
      yield { type: "tool-call-delta", index, id: CallId(call.id), argumentsDelta: string(delta?.partial_json) ?? "" };
    }
    return;
  }
  if (type === "message_delta") {
    const delta = record(value.delta);
    const providerUsage = record(value.usage);
    const output = tokenCount(providerUsage?.output_tokens);
    if (output !== undefined) state.usage.outputTokens = output;
    const completeUsage = usageSnapshot(state.usage).complete;
    if (completeUsage !== undefined) yield { type: "usage", usage: completeUsage };
    const stop = string(delta?.stop_reason);
    if (stop !== undefined) {
      state.finishEmitted = true;
      yield { type: "finish", reason: finishReason(stop) };
    }
    return;
  }
  if (type === "message_stop" && !state.finishEmitted) {
    state.finishEmitted = true;
    yield { type: "finish", reason: "stop" };
  }
}

function requestHeaders(route: ModelProviderRoute, secret: string | undefined): Headers {
  const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" });
  if (secret !== undefined) {
    if (route.apiFormat === "anthropic_messages") {
      headers.set("x-api-key", secret);
      headers.set("anthropic-version", "2023-06-01");
    } else {
      headers.set("authorization", `Bearer ${secret}`);
    }
  }
  return headers;
}

function routeEndpoint(route: ModelProviderRoute): string {
  if (route.apiFormat === "openai_chat") return endpoint(route.baseUrl, "/chat/completions");
  if (route.apiFormat === "openai_responses") return endpoint(route.baseUrl, "/responses");
  const basePath = new URL(route.baseUrl).pathname.replace(/\/$/u, "");
  return endpoint(route.baseUrl, basePath.endsWith("/v1") ? "/messages" : "/v1/messages");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export class HttpModelAdapter {
  readonly id: string;
  private readonly routes: readonly ModelProviderRoute[];
  private readonly resolveSecret: HttpModelAdapterOptions["resolveSecret"];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly onReceipt: HttpModelAdapterOptions["onReceipt"];

  constructor(options: HttpModelAdapterOptions) {
    const source = exactDataRecord(options, ["id", "routes", "resolveSecret", "fetch", "onReceipt"], "model adapter options");
    assertSafePublicControlIdV1(source.id, "model adapter identifier");
    const routeValues = exactDataArray(source.routes, "model provider routes");
    if (routeValues.length === 0) throw new TypeError("model adapter requires at least one route");
    if (typeof source.resolveSecret !== "function") throw new TypeError("model secret resolver must be a function");
    if (source.fetch !== undefined && typeof source.fetch !== "function") throw new TypeError("model fetch implementation must be a function");
    if (source.onReceipt !== undefined && typeof source.onReceipt !== "function") {
      throw new TypeError("model receipt observer must be a function");
    }
    this.id = source.id;
    this.routes = Object.freeze(routeValues.map(snapshotRoute));
    this.resolveSecret = source.resolveSecret as HttpModelAdapterOptions["resolveSecret"];
    this.fetchImpl = (source.fetch ?? globalThis.fetch) as typeof globalThis.fetch;
    this.onReceipt = source.onReceipt as HttpModelAdapterOptions["onReceipt"];
  }

  async *stream(request: LlmRequest, execution?: LlmStreamExecutionContext): AsyncIterable<StreamChunk> {
    const stableRequest = snapshotRequest(request);
    const attemptAudit = snapshotAttemptAudit(execution);
    if (stableRequest.provider !== this.id) throw new TypeError("model request provider does not match the adapter");
    const firstRoute = this.routes[0] as ModelProviderRoute;
    if (isAborted(stableRequest.signal)) {
      await this.publishReceipt({
        schemaVersion: 1,
        providerId: firstRoute.providerId,
        model: stableRequest.model,
        apiFormat: firstRoute.apiFormat,
        attempt: 1,
        dispatched: false,
        outcome: "interrupted",
        retryable: false,
        fallbackAllowed: false,
        failureCode: "cancelled",
        usageState: "missing"
      }, stableRequest.signal);
      for (const chunk of cancelledChunks()) yield chunk;
      return;
    }

    for (let routeIndex = 0; routeIndex < this.routes.length; routeIndex += 1) {
      const route = this.routes[routeIndex] as ModelProviderRoute;
      const attempt = routeIndex + 1;
      const hasFallback = attempt < this.routes.length;
      const started = createAttemptStarted(route, stableRequest, attempt);
      if (attemptAudit !== undefined) {
        try {
          await attemptAudit.started(started);
        } catch {
          throw new ModelOutcomePersistenceError();
        }
      }
      const publishAttemptReceipt = (receipt: ModelClientReceipt): Promise<void> => this.publishReceipt(
        receipt,
        stableRequest.signal,
        attemptAudit,
        started
      );
      if (isAborted(stableRequest.signal)) {
        await publishAttemptReceipt({
          schemaVersion: 1,
          providerId: route.providerId,
          model: stableRequest.model,
          apiFormat: route.apiFormat,
          attempt,
          dispatched: false,
          outcome: "interrupted",
          retryable: false,
          fallbackAllowed: false,
          failureCode: "cancelled",
          usageState: "missing"
        });
        for (const chunk of cancelledChunks()) yield chunk;
        return;
      }
      let secretValue: string | undefined;
      if (route.apiKeyRef !== undefined) {
        try {
          const resolved = await awaitAbortable(this.resolveSecret(route.apiKeyRef), stableRequest.signal);
          if (resolved === ABORTED) {
            await publishAttemptReceipt({
              schemaVersion: 1,
              providerId: route.providerId,
              model: stableRequest.model,
              apiFormat: route.apiFormat,
              attempt,
              dispatched: false,
              outcome: "interrupted",
              retryable: false,
              fallbackAllowed: false,
              failureCode: "cancelled",
              usageState: "missing"
            });
            for (const chunk of cancelledChunks()) yield chunk;
            return;
          }
          secretValue = resolved;
        } catch {
          secretValue = undefined;
        }
        if (isAborted(stableRequest.signal)) {
          await publishAttemptReceipt({
            schemaVersion: 1,
            providerId: route.providerId,
            model: stableRequest.model,
            apiFormat: route.apiFormat,
            attempt,
            dispatched: false,
            outcome: "interrupted",
            retryable: false,
            fallbackAllowed: false,
            failureCode: "cancelled",
            usageState: "missing"
          });
          for (const chunk of cancelledChunks()) yield chunk;
          return;
        }
        if (typeof secretValue !== "string" || secretValue.length === 0) {
          await publishAttemptReceipt({
            schemaVersion: 1,
            providerId: route.providerId,
            model: stableRequest.model,
            apiFormat: route.apiFormat,
            attempt,
            dispatched: false,
            outcome: "failed",
            retryable: false,
            fallbackAllowed: hasFallback,
            failureCode: "secret_unavailable",
            usageState: "missing"
          });
          if (hasFallback) continue;
          yield {
            type: "error",
            error: { code: "LLM_SECRET_UNAVAILABLE", message: "Model provider credential is unavailable", retryable: false }
          };
          yield { type: "finish", reason: "error" };
          return;
        }
      }

      if (isAborted(stableRequest.signal)) {
        await publishAttemptReceipt({
          schemaVersion: 1,
          providerId: route.providerId,
          model: stableRequest.model,
          apiFormat: route.apiFormat,
          attempt,
          dispatched: false,
          outcome: "interrupted",
          retryable: false,
          fallbackAllowed: false,
          failureCode: "cancelled",
          usageState: "missing"
        });
        for (const chunk of cancelledChunks()) yield chunk;
        return;
      }

      let outbound: Request;
      try {
        outbound = new Request(routeEndpoint(route), {
          method: "POST",
          headers: requestHeaders(route, secretValue),
          body: JSON.stringify(requestBody(route, stableRequest))
        });
      } catch {
        await publishAttemptReceipt({
          schemaVersion: 1,
          providerId: route.providerId,
          model: stableRequest.model,
          apiFormat: route.apiFormat,
          attempt,
          dispatched: false,
          outcome: "failed",
          retryable: false,
          fallbackAllowed: false,
          failureCode: "request_invalid",
          usageState: "missing"
        });
        yield {
          type: "error",
          error: { code: "LLM_REQUEST_INVALID", message: "Model request is invalid", retryable: false }
        };
        yield { type: "finish", reason: "error" };
        return;
      }

      let dispatch: HttpDispatchResult | undefined;
      let response: HttpResponseSnapshot;
      try {
        dispatch = await dispatchHttpRequest({
          request: outbound,
          ...(stableRequest.signal === undefined ? {} : { signal: stableRequest.signal }),
          fetch: this.fetchImpl
        });
        response = dispatch.response;
      } catch {
        const cancelled = isAborted(stableRequest.signal);
        await publishAttemptReceipt({
          schemaVersion: 1,
          providerId: route.providerId,
          model: stableRequest.model,
          apiFormat: route.apiFormat,
          attempt,
          dispatched: true,
          outcome: cancelled ? "interrupted" : "failed",
          retryable: !cancelled,
          fallbackAllowed: false,
          failureCode: cancelled ? "cancelled" : "transport_error",
          usageState: "missing"
        });
        if (cancelled) {
          for (const chunk of cancelledChunks()) yield chunk;
        } else {
          yield {
            type: "error",
            error: { code: "LLM_TRANSPORT_ERROR", message: "Model provider transport failed", retryable: true }
          };
          yield { type: "finish", reason: "error" };
        }
        return;
      }

      const state: DecodeState = {
        usage: {},
        chatCalls: new Map(),
        responseCalls: new Map(),
        finishEmitted: false,
        pendingFinish: undefined
      };
      let outcome: ModelClientReceipt["outcome"] = "failed";
      let retryable = false;
      let failureCode: ModelClientReceipt["failureCode"];
      let receiptPublished = false;
      const publishCurrentReceipt = async (): Promise<void> => {
        if (receiptPublished) return;
        receiptPublished = true;
        const usage = usageSnapshot(state.usage);
        await publishAttemptReceipt({
          schemaVersion: 1,
          providerId: route.providerId,
          model: stableRequest.model,
          apiFormat: route.apiFormat,
          attempt,
          dispatched: true,
          outcome,
          statusCode: response.status,
          retryable,
          fallbackAllowed: false,
          ...(failureCode === undefined ? {} : { failureCode }),
          usageState: usage.state,
          ...(usage.partial === undefined ? {} : { usage: usage.partial })
        });
      };
      try {
        if (!response.ok || response.body === null) {
          retryable = isRetryableStatus(response.status);
          failureCode = "http_error";
          await publishCurrentReceipt();
          yield {
            type: "error",
            error: {
              code: "LLM_PROVIDER_ERROR",
              message: "Model provider returned an error",
              status: response.status,
              retryable
            }
          };
          state.finishEmitted = true;
          yield { type: "finish", reason: "error" };
          return;
        }
        try {
          for await (const event of parseSse(response.body as unknown as AsyncIterable<Uint8Array>, {
            ...(dispatch?.signal === undefined ? {} : { signal: dispatch.signal })
          })) {
            const chunks = route.apiFormat === "openai_chat"
              ? decodeOpenAiChat(event, state)
              : route.apiFormat === "openai_responses"
                ? decodeOpenAiResponses(event, state)
                : decodeAnthropic(event, state);
            for (const chunk of chunks) {
              if (isAborted(stableRequest.signal)) throw new Error("MODEL_STREAM_CANCELLED");
              if (chunk.type === "error") {
                outcome = "failed";
                failureCode = "stream_error";
                retryable = chunk.error.retryable === true;
                await publishCurrentReceipt();
              }
              if (chunk.type === "finish" && failureCode === undefined) {
                outcome = "completed";
                await publishCurrentReceipt();
              }
              yield chunk;
              if (chunk.type === "finish") return;
            }
          }
        } catch (error) {
          if (error instanceof ModelOutcomePersistenceError) throw error;
          if (error instanceof ModelReceiptObserverError) throw error;
          if (isAborted(stableRequest.signal)) {
            outcome = "interrupted";
            failureCode = "cancelled";
            await publishCurrentReceipt();
            for (const chunk of cancelledChunks()) yield chunk;
          } else {
            failureCode = "stream_error";
            retryable = true;
            await publishCurrentReceipt();
            yield {
              type: "error",
              error: { code: "LLM_STREAM_ERROR", message: "Model provider stream failed", retryable: true }
            };
            yield { type: "finish", reason: "error" };
          }
          return;
        }
        outcome = isAborted(stableRequest.signal) ? "interrupted" : "completed";
        if (outcome === "interrupted") {
          failureCode = "cancelled";
          await publishCurrentReceipt();
          for (const chunk of cancelledChunks()) yield chunk;
        } else if (!state.finishEmitted) {
          state.finishEmitted = true;
          await publishCurrentReceipt();
          yield { type: "finish", reason: state.pendingFinish ?? "stop" };
        }
        return;
      } finally {
        dispatch?.dispose();
        if (failureCode === undefined && outcome === "failed") {
          outcome = "interrupted";
          failureCode = isAborted(stableRequest.signal) ? "cancelled" : "stream_interrupted";
        }
        await publishCurrentReceipt();
      }
    }
  }

  private async publishReceipt(
    receipt: ModelClientReceipt,
    signal?: AbortSignal,
    attemptAudit?: LlmAttemptAuditSink,
    started?: ModelAttemptStartedV1
  ): Promise<void> {
    if (attemptAudit !== undefined && started !== undefined) {
      try {
        await attemptAudit.terminal(createModelAttemptTerminalV1({
          started,
          dispatchState: receipt.dispatched ? "dispatched" : "not-dispatched",
          outcome: receipt.outcome,
          ...(receipt.statusCode === undefined ? {} : { statusCode: receipt.statusCode }),
          retryable: receipt.retryable,
          fallbackAllowed: receipt.fallbackAllowed,
          ...(receipt.failureCode === undefined ? {} : { failureCode: receipt.failureCode }),
          usageState: receipt.usageState,
          ...(receipt.usage === undefined ? {} : { usage: receipt.usage })
        }));
      } catch {
        throw new ModelOutcomePersistenceError();
      }
    }
    if (this.onReceipt === undefined) return;
    try {
      const observation = this.onReceipt(Object.freeze(receipt));
      if (observation === undefined) return;
      const observed = await awaitAbortable(Promise.resolve(observation), signal);
      if (observed === ABORTED) throw new Error("MODEL_RECEIPT_OBSERVER_CANCELLED");
    } catch {
      throw new ModelReceiptObserverError("MODEL_RECEIPT_OBSERVER_FAILED");
    }
  }
}
