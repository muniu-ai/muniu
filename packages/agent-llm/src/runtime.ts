// SPDX-License-Identifier: Apache-2.0

import type { LlmRequest, StreamChunk } from "@mn/agent-protocol";

export interface LlmAdapter {
  readonly id: string;
  stream(request: LlmRequest): AsyncIterable<StreamChunk>;
  dispose?(): void | Promise<void>;
}

export class LlmRuntime {
  private readonly adapters = new Map<string, LlmAdapter>();
  private sealed = false;

  register(adapter: LlmAdapter): () => Promise<void> {
    if (this.sealed) throw new Error("LLM runtime is sealed");
    if (adapter.id.length === 0) throw new Error("LLM adapter id must not be empty");
    if (this.adapters.has(adapter.id)) throw new Error(`LLM adapter "${adapter.id}" is already registered`);
    this.adapters.set(adapter.id, adapter);
    let active = true;
    return async (): Promise<void> => {
      if (!active) return;
      active = false;
      if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id);
      await adapter.dispose?.();
    };
  }

  seal(): void {
    this.sealed = true;
  }

  async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    const adapter = this.adapters.get(request.provider);
    if (adapter === undefined) throw new Error(`LLM adapter "${request.provider}" is not registered`);
    let terminal = false;
    let failed = false;
    try {
      for await (const chunk of adapter.stream(request)) {
        if (terminal) break;
        yield chunk;
        if (chunk.type === "error") failed = true;
        if (chunk.type === "finish") terminal = true;
      }
      if (!terminal) yield { type: "finish", reason: failed ? "error" : "stop" };
    } catch {
      const cancelled = request.signal?.aborted === true;
      yield {
        type: "error",
        error: {
          code: cancelled ? "LLM_CANCELLED" : "LLM_STREAM_FAILED",
          message: cancelled ? "Model stream cancelled" : "Model stream failed"
        }
      };
      yield { type: "finish", reason: cancelled ? "cancelled" : "error" };
    }
  }
}
