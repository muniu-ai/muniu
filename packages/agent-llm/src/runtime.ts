// SPDX-License-Identifier: Apache-2.0

import type { LlmFailure, LlmRequest, StreamChunk } from "@mn/agent-protocol";

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
    const adapter = this.adapters.get(request.provider);
    if (adapter === undefined) throw new Error(`LLM adapter "${request.provider}" is not registered`);
    let terminalEmitted = false;
    try {
      for await (const chunk of adapter.stream(request)) {
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
      terminalEmitted = true;
      yield { type: "finish", reason: "stop" };
    } catch {
      if (terminalEmitted) return;
      const cancelled = request.signal?.aborted === true;
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
