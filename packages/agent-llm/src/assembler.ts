/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/llm/llm/src/assembler.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: uses the closed Muniu thinking/error stream vocabulary and
 * immutable assistant-message constructor without plugin sources.
 */

import {
  MessageId,
  createAssistantMessage,
  type AssistantMessage,
  type CallId,
  type ContentBlock,
  type ContentBlockType,
  type LlmFailure,
  type MessageId as MessageIdType,
  type ModelMessageSource,
  type StreamChunk,
  type TokenUsage
} from "@mn/agent-protocol";

interface PartialBlock {
  blockType: ContentBlockType;
  text: string;
  toolCallId?: CallId;
  toolCallName?: string;
  toolCallArguments: string;
  block?: ContentBlock;
}

export class BlockAssembler {
  private readonly partials = new Map<number, PartialBlock>();
  private readonly order: number[] = [];
  private currentUsage: TokenUsage | undefined;
  private currentFinish: "stop" | "tool-calls" | "max-tokens" | "cancelled" | "error" | undefined;
  private currentError: LlmFailure | undefined;

  push(chunk: StreamChunk): void {
    if (this.currentFinish !== undefined) throw new Error("assembler cannot accept chunks after finish");
    switch (chunk.type) {
      case "block-start":
        this.ensure(chunk.index, chunk.blockType);
        return;
      case "text-delta": {
        const partial = this.ensure(chunk.index, "text");
        if (partial.block === undefined) partial.text += chunk.text;
        return;
      }
      case "thinking-delta": {
        const partial = this.ensure(chunk.index, "thinking");
        if (partial.block === undefined) partial.text += chunk.text;
        return;
      }
      case "tool-call-delta": {
        const partial = this.ensure(chunk.index, "tool-call");
        if (partial.block !== undefined) return;
        partial.toolCallId = chunk.id;
        if (chunk.name !== undefined) partial.toolCallName = chunk.name;
        partial.toolCallArguments += chunk.argumentsDelta;
        return;
      }
      case "block-end": {
        const partial = this.ensure(chunk.index, chunk.block.type);
        if (partial.block === undefined) partial.block = chunk.block;
        return;
      }
      case "usage":
        this.currentUsage = chunk.usage;
        return;
      case "error":
        this.currentError = chunk.error;
        return;
      case "finish":
        this.currentFinish = chunk.reason;
        return;
    }
  }

  private ensure(index: number, blockType: ContentBlockType): PartialBlock {
    let partial = this.partials.get(index);
    if (partial === undefined) {
      partial = { blockType, text: "", toolCallArguments: "" };
      this.partials.set(index, partial);
      this.order.push(index);
    } else if (partial.blockType !== blockType) {
      throw new Error(`assembler block type conflict at index ${index}: ${partial.blockType} vs ${blockType}`);
    }
    return partial;
  }

  private assemble(partial: PartialBlock, index: number): ContentBlock {
    if (partial.block !== undefined) {
      if (partial.block.type === "tool-call"
        && (partial.block.id.length === 0 || partial.block.name.length === 0)) {
        throw new Error(`tool call at index ${index} is missing an id or name`);
      }
      return partial.block;
    }
    if (partial.blockType === "text") return { type: "text", text: partial.text };
    if (partial.blockType === "thinking") return { type: "thinking", text: partial.text };
    if (partial.blockType === "tool-call") {
      if (partial.toolCallId === undefined) throw new Error(`tool call at index ${index} is missing an id`);
      if (partial.toolCallName === undefined || partial.toolCallName.length === 0) {
        throw new Error(`tool call at index ${index} is missing a name`);
      }
      return {
        type: "tool-call",
        id: partial.toolCallId,
        name: partial.toolCallName,
        arguments: partial.toolCallArguments
      };
    }
    throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`);
  }

  blocks(): ContentBlock[] {
    const blocks = this.order.map((index) => {
      const partial = this.partials.get(index);
      if (partial === undefined) throw new Error(`assembler invariant violated at index ${index}`);
      return this.assemble(partial, index);
    });
    return this.finish === "max-tokens" ? blocks.filter((block) => block.type !== "tool-call") : blocks;
  }

  get usage(): TokenUsage | undefined { return this.currentUsage; }
  get finish(): "stop" | "tool-calls" | "max-tokens" | "cancelled" | "error" { return this.currentFinish ?? "stop"; }
  get error(): LlmFailure | undefined { return this.currentError; }

  message(source: ModelMessageSource, id: MessageIdType = MessageId(crypto.randomUUID())): AssistantMessage {
    return createAssistantMessage({ id, content: this.blocks(), source });
  }
}
