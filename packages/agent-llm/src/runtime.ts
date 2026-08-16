// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import { assertSafePublicControlIdV1, type LlmFailure, type LlmRequest, type StreamChunk } from "@mn/agent-protocol";

const ABORT_SIGNAL_ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

export interface LlmAdapter {
  readonly id: string;
  stream(request: LlmRequest): AsyncIterable<StreamChunk>;
  dispose?(): void | Promise<void>;
}

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
  const signal = Object.getOwnPropertyDescriptor(value, "signal");
  if (provider === undefined || !("value" in provider) || !provider.enumerable || typeof provider.value !== "string") {
    throw new TypeError("LLM request header is invalid");
  }
  if (signal !== undefined && (!("value" in signal) || !signal.enumerable)) {
    throw new TypeError("LLM request header is invalid");
  }
  assertSafePublicControlIdV1(provider.value, "LLM request provider");
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
    signal: signalValue as AbortSignal | undefined
  });
}

export class LlmRuntime {
  private readonly adapters = new Map<string, LlmAdapter>();
  private sealed = false;

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

  async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    const header = snapshotRequestHeader(request);
    const adapter = this.adapters.get(header.provider);
    if (adapter === undefined) throw new Error("LLM adapter is not registered");
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
    try {
      for await (const chunk of adapter.stream(request)) {
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
    } catch {
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
    }
  }
}
