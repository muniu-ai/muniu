// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import {
  assertSafePublicControlIdV1,
  type LlmFailure,
  type LlmRequest,
  type ModelAttemptStartedV1,
  type ModelAttemptTerminalV1,
  type StreamChunk
} from "@mn/agent-protocol";

import { ModelOutcomePersistenceError } from "./errors.js";

export interface LlmAttemptAuditSink {
  readonly started: (attempt: ModelAttemptStartedV1) => void | Promise<void>;
  readonly terminal: (terminal: ModelAttemptTerminalV1) => void | Promise<void>;
}

export interface LlmStreamExecutionContext {
  readonly attemptAudit: LlmAttemptAuditSink;
}

const ABORT_SIGNAL_ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

export interface LlmAdapter {
  readonly id: string;
  stream(request: LlmRequest, execution?: LlmStreamExecutionContext): AsyncIterable<StreamChunk>;
  dispose?(): void | Promise<void>;
}

export interface LlmRuntimeOptions {
  readonly resolveAdapterLease?: (
    request: LlmAdapterResolutionRequest
  ) => Promise<LlmAdapterLease>;
}

export interface LlmAdapterResolutionRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly signal?: AbortSignal;
}

export interface LlmAdapterResolutionV1 {
  readonly schemaVersion: 1;
  readonly kind: "llm-adapter-resolution";
  readonly providerId: string;
  readonly modelId: string;
  readonly configDigest: string;
}

export interface LlmAdapterLease {
  readonly adapter: LlmAdapter;
  readonly resolution: LlmAdapterResolutionV1;
  readonly release: () => void | Promise<void>;
}

const RESOLUTION_ABORTED = Symbol("llm-adapter-resolution-aborted");

function safeProviderFailure(failure: LlmFailure): LlmFailure {
  const status = Number.isSafeInteger(failure.status) && (failure.status as number) >= 100 && (failure.status as number) <= 599
    ? failure.status
    : undefined;
  return {
    code: "LLM_PROVIDER_ERROR",
    message: "Model provider returned an error",
    ...(status === undefined ? {} : { status }),
    ...(typeof failure.retryable === "boolean" ? { retryable: failure.retryable } : {})
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (ABORT_SIGNAL_ABORTED === undefined) return true;
  try {
    return Reflect.apply(ABORT_SIGNAL_ABORTED, signal, []) === true;
  } catch {
    return true;
  }
}

function snapshotRequestHeader(value: unknown): Readonly<{
  provider: string;
  model: string;
  signal: AbortSignal | undefined;
}> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError("LLM request header is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("LLM request header is invalid");
  }
  const provider = Object.getOwnPropertyDescriptor(value, "provider");
  const model = Object.getOwnPropertyDescriptor(value, "model");
  const signal = Object.getOwnPropertyDescriptor(value, "signal");
  if (provider === undefined || !("value" in provider) || !provider.enumerable || typeof provider.value !== "string") {
    throw new TypeError("LLM request header is invalid");
  }
  if (model === undefined || !("value" in model) || !model.enumerable || typeof model.value !== "string") {
    throw new TypeError("LLM request header is invalid");
  }
  if (signal !== undefined && (!("value" in signal) || !signal.enumerable)) {
    throw new TypeError("LLM request header is invalid");
  }
  assertSafePublicControlIdV1(provider.value, "LLM request provider");
  assertSafePublicControlIdV1(model.value, "LLM request model");
  const signalValue = signal === undefined ? undefined : signal.value;
  if (signalValue !== undefined) {
    if (signalValue === null || typeof signalValue !== "object" || utilTypes.isProxy(signalValue)
      || ABORT_SIGNAL_ABORTED === undefined) {
      throw new TypeError("LLM request header is invalid");
    }
    try {
      Reflect.apply(ABORT_SIGNAL_ABORTED, signalValue, []);
    } catch {
      throw new TypeError("LLM request header is invalid");
    }
  }
  return Object.freeze({
    provider: provider.value,
    model: model.value,
    signal: signalValue as AbortSignal | undefined
  });
}

function snapshotRuntimeOptions(value: LlmRuntimeOptions): LlmRuntimeOptions {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    throw new TypeError("LLM runtime options must be an exact data object");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== "resolveAdapterLease")) {
    throw new TypeError("LLM runtime options must be an exact data object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "resolveAdapterLease");
  if (descriptor === undefined) return Object.freeze({});
  if (!("value" in descriptor) || !descriptor.enumerable
    || typeof descriptor.value !== "function" || utilTypes.isProxy(descriptor.value)) {
    throw new TypeError("LLM adapter resolver must be a function");
  }
  return Object.freeze({ resolveAdapterLease: descriptor.value });
}

function findDataMethod(value: object, key: string): Function | undefined {
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    if (utilTypes.isProxy(current)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function"
        || utilTypes.isProxy(descriptor.value)) return undefined;
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function snapshotBorrowedAdapter(value: unknown, providerId: string): LlmAdapter {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new Error("LLM adapter resolution failed");
  }
  const id = Object.getOwnPropertyDescriptor(value, "id");
  const stream = findDataMethod(value, "stream");
  if (id === undefined || !("value" in id) || !id.enumerable
    || id.value !== providerId || stream === undefined) {
    throw new Error("LLM adapter resolution failed");
  }
  return Object.freeze({
    id: providerId,
    stream: stream.bind(value) as LlmAdapter["stream"]
  });
}

interface StableAdapterLease {
  readonly adapter: LlmAdapter;
  readonly release: () => Promise<void>;
}

function releaseBorrowedAdapter(lease: StableAdapterLease | undefined): void {
  if (lease === undefined) return;
  void lease.release().catch(() => {
    // Borrowed-resource cleanup cannot replace a durable model outcome or
    // delay cancellation. The lease snapshot still guarantees one invocation.
  });
}

function exactDataObject(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    return undefined;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return undefined;
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    output[key] = descriptor.value;
  }
  return output;
}

function snapshotExecutionContext(value: LlmStreamExecutionContext | undefined): LlmStreamExecutionContext | undefined {
  if (value === undefined) return undefined;
  const context = exactDataObject(value, ["attemptAudit"]);
  const sink = context === undefined ? undefined : exactDataObject(context.attemptAudit, ["started", "terminal"]);
  if (context === undefined || sink === undefined
    || typeof sink.started !== "function" || utilTypes.isProxy(sink.started)
    || typeof sink.terminal !== "function" || utilTypes.isProxy(sink.terminal)) {
    throw new TypeError("LLM stream execution context is invalid");
  }
  const target = context.attemptAudit as object;
  return Object.freeze({
    attemptAudit: Object.freeze({
      started: (sink.started as LlmAttemptAuditSink["started"]).bind(target),
      terminal: (sink.terminal as LlmAttemptAuditSink["terminal"]).bind(target)
    })
  });
}

function snapshotAdapterLease(
  value: unknown,
  providerId: string,
  modelId: string
): StableAdapterLease {
  const lease = exactDataObject(value, ["adapter", "resolution", "release"]);
  const resolution = lease === undefined
    ? undefined
    : exactDataObject(lease.resolution, [
        "schemaVersion",
        "kind",
        "providerId",
        "modelId",
        "configDigest"
      ]);
  if (lease === undefined || resolution === undefined
    || resolution.schemaVersion !== 1
    || resolution.kind !== "llm-adapter-resolution"
    || resolution.providerId !== providerId
    || resolution.modelId !== modelId
    || typeof resolution.configDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test(resolution.configDigest)
    || typeof lease.release !== "function"
    || utilTypes.isProxy(lease.release)) {
    throw new Error("LLM adapter resolution failed");
  }
  const adapter = snapshotBorrowedAdapter(lease.adapter, providerId);
  const releaseMethod = lease.release as () => void | Promise<void>;
  let active = true;
  return Object.freeze({
    adapter,
    release: async () => {
      if (!active) return;
      active = false;
      try {
        await Reflect.apply(releaseMethod, value, []);
      } catch {
        throw new Error("LLM adapter lease release failed");
      }
    }
  });
}

async function awaitResolution(
  operation: Promise<LlmAdapterLease>,
  signal: AbortSignal | undefined,
  providerId: string,
  modelId: string
): Promise<StableAdapterLease | typeof RESOLUTION_ABORTED> {
  void operation.catch(() => undefined);
  if (signal === undefined) {
    return snapshotAdapterLease(await operation, providerId, modelId);
  }
  if (isAborted(signal)) return RESOLUTION_ABORTED;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof RESOLUTION_ABORTED>((resolve) => {
    onAbort = () => { resolve(RESOLUTION_ABORTED); };
    EventTarget.prototype.addEventListener.call(signal, "abort", onAbort, { once: true });
  });
  try {
    if (isAborted(signal)) return RESOLUTION_ABORTED;
    const result = await Promise.race([operation, aborted]);
    if (result === RESOLUTION_ABORTED) {
      void operation.then(async (late) => {
        try {
          await snapshotAdapterLease(late, providerId, modelId).release();
        } catch {
          // Late untrusted failures cannot replace the primary cancellation.
        }
      }, () => undefined);
      return RESOLUTION_ABORTED;
    }
    return snapshotAdapterLease(result, providerId, modelId);
  } finally {
    if (onAbort !== undefined) {
      EventTarget.prototype.removeEventListener.call(signal, "abort", onAbort);
    }
  }
}

export class LlmRuntime {
  private readonly adapters = new Map<string, LlmAdapter>();
  private readonly resolveAdapterLease: LlmRuntimeOptions["resolveAdapterLease"];
  private sealed = false;

  constructor(options: LlmRuntimeOptions = {}) {
    this.resolveAdapterLease = snapshotRuntimeOptions(options).resolveAdapterLease;
  }

  register(adapter: LlmAdapter): () => Promise<void> {
    if (this.sealed) throw new Error("LLM runtime is sealed");
    const id = adapter.id;
    const streamMethod = adapter.stream;
    const disposeMethod = adapter.dispose;
    if (id.length === 0) throw new Error("LLM adapter id must not be empty");
    if (typeof streamMethod !== "function") throw new Error("LLM adapter stream must be a function");
    if (disposeMethod !== undefined && typeof disposeMethod !== "function") throw new Error("LLM adapter dispose must be a function");
    const stream = streamMethod.bind(adapter);
    const dispose = disposeMethod?.bind(adapter);
    const stable: LlmAdapter = Object.freeze({ id, stream });
    if (this.adapters.has(id)) throw new Error(`LLM adapter "${id}" is already registered`);
    this.adapters.set(id, stable);
    let active = true;
    return async (): Promise<void> => {
      if (!active) return;
      active = false;
      if (this.adapters.get(id) === stable) this.adapters.delete(id);
      await dispose?.();
    };
  }

  seal(): void {
    this.sealed = true;
  }

  async *stream(request: LlmRequest, execution?: LlmStreamExecutionContext): AsyncIterable<StreamChunk> {
    const stableExecution = snapshotExecutionContext(execution);
    const header = snapshotRequestHeader(request);
    const signal = header.signal;
    let terminalEmitted = false;
    if (isAborted(signal)) {
      terminalEmitted = true;
      yield {
        type: "error",
        error: { code: "LLM_CANCELLED", message: "Model stream cancelled" }
      };
      yield { type: "finish", reason: "cancelled" };
      return;
    }
    let adapter = this.adapters.get(header.provider);
    let borrowed: StableAdapterLease | undefined;
    if (adapter === undefined && this.resolveAdapterLease !== undefined) {
      let resolved: StableAdapterLease | typeof RESOLUTION_ABORTED;
      try {
        resolved = await awaitResolution(
          Promise.resolve(this.resolveAdapterLease(Object.freeze({
            providerId: header.provider,
            modelId: header.model,
            ...(signal === undefined ? {} : { signal })
          }))),
          signal,
          header.provider,
          header.model
        );
      } catch {
        throw new Error("LLM adapter resolution failed");
      }
      if (resolved !== RESOLUTION_ABORTED) borrowed = resolved;
      if (resolved === RESOLUTION_ABORTED || isAborted(signal)) {
        releaseBorrowedAdapter(borrowed);
        yield {
          type: "error",
          error: { code: "LLM_CANCELLED", message: "Model stream cancelled" }
        };
        yield { type: "finish", reason: "cancelled" };
        return;
      }
      adapter = resolved.adapter;
    }
    if (adapter === undefined) throw new Error("LLM adapter is not registered");
    try {
      for await (const chunk of adapter.stream(request, stableExecution)) {
        if (isAborted(signal)) {
          terminalEmitted = true;
          yield {
            type: "error",
            error: { code: "LLM_CANCELLED", message: "Model stream cancelled" }
          };
          yield { type: "finish", reason: "cancelled" };
          return;
        }
        if (chunk.type === "error") {
          yield { type: "error", error: safeProviderFailure(chunk.error) };
          terminalEmitted = true;
          yield { type: "finish", reason: "error" };
          return;
        }
        if (chunk.type === "finish") terminalEmitted = true;
        yield chunk;
        if (chunk.type === "finish") return;
      }
      if (isAborted(signal)) {
        yield {
          type: "error",
          error: { code: "LLM_CANCELLED", message: "Model stream cancelled" }
        };
        terminalEmitted = true;
        yield { type: "finish", reason: "cancelled" };
        return;
      }
      terminalEmitted = true;
      yield { type: "finish", reason: "stop" };
    } catch (error) {
      if (error instanceof ModelOutcomePersistenceError) throw error;
      if (terminalEmitted) return;
      const cancelled = isAborted(signal);
      yield {
        type: "error",
        error: {
          code: cancelled ? "LLM_CANCELLED" : "LLM_STREAM_FAILED",
          message: cancelled ? "Model stream cancelled" : "Model stream failed"
        }
      };
      terminalEmitted = true;
      yield { type: "finish", reason: cancelled ? "cancelled" : "error" };
    } finally {
      releaseBorrowedAdapter(borrowed);
    }
  }
}
