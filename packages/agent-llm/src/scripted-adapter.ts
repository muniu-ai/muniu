// SPDX-License-Identifier: Apache-2.0

import type { LlmRequest, StreamChunk } from "@mn/agent-protocol";

import type { LlmAdapter } from "./runtime.js";

export class ScriptedLlmAdapter implements LlmAdapter {
  private readonly scripts: StreamChunk[][];

  constructor(readonly id: string, scripts: readonly (readonly StreamChunk[])[]) {
    this.scripts = scripts.map((script) => [...script]);
  }

  enqueue(script: readonly StreamChunk[]): void {
    this.scripts.push([...script]);
  }

  async *stream(_request: LlmRequest): AsyncIterable<StreamChunk> {
    const script = this.scripts.shift();
    if (script === undefined) throw new Error(`scripted adapter "${this.id}" has no response`);
    for (const chunk of script) yield structuredClone(chunk);
  }
}
