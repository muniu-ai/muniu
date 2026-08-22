/*
 * Adapted from DeepSeek Harness at fixed commit
 * 141eb6fef83422698aef7a981029e843e8161534.
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
  createSafeRandomPublicControlIdV1,
  deepFreeze,
  snapshotJsonValue,
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

function snapshotBoundary<T>(value: T, label: string): T {
  const snapshot = snapshotJsonValue(value);
  if (snapshot === undefined) throw new Error(`assembler ${label} must be lossless JSON`);
  return deepFreeze(snapshot);
}

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
        if (chunk.id.length === 0) throw new Error(`tool call at index ${chunk.index} is missing an id`);
        const partial = this.ensure(chunk.index, "tool-call");
        if (partial.block !== undefined) throw new Error(`tool call at index ${chunk.index} already ended`);
        if (partial.toolCallId !== undefined && partial.toolCallId !== chunk.id) {
          throw new Error(`tool call id conflict at index ${chunk.index}`);
        }
        partial.toolCallId = chunk.id;
        if (chunk.name !== undefined) {
          if (chunk.name.length === 0) throw new Error(`tool call at index ${chunk.index} is missing a name`);
          if (partial.toolCallName !== undefined && partial.toolCallName !== chunk.name) {
            throw new Error(`tool call name conflict at index ${chunk.index}`);
          }
          partial.toolCallName = chunk.name;
        }
        partial.toolCallArguments += chunk.argumentsDelta;
        return;
      }
      case "block-end": {
        const block = snapshotBoundary(chunk.block, "block");
        const partial = this.ensure(chunk.index, block.type);
        this.finishBlock(partial, block, chunk.index);
        return;
      }
      case "usage":
        this.currentUsage = snapshotBoundary(chunk.usage, "usage");
        return;
      case "error":
        this.currentError = snapshotBoundary(chunk.error, "error");
        return;
      case "finish":
        this.currentFinish = chunk.reason;
        return;
    }
  }

  private finishBlock(partial: PartialBlock, block: ContentBlock, index: number): void {
    if (block.type === "tool-call" && (block.id.length === 0 || block.name.length === 0)) {
      throw new Error(`tool call at index ${index} is missing an id or name`);
    }
    if (partial.block !== undefined) {
      if (JSON.stringify(partial.block) !== JSON.stringify(block)) throw new Error(`block end conflict at index ${index}`);
      return;
    }
    if ((block.type === "text" || block.type === "thinking") && partial.text.length > 0 && partial.text !== block.text) {
      throw new Error(`block end conflict at index ${index}`);
    }
    if (block.type === "tool-call") {
      if (partial.toolCallId !== undefined && partial.toolCallId !== block.id) throw new Error(`block end id conflict at index ${index}`);
      if (partial.toolCallName !== undefined && partial.toolCallName !== block.name) throw new Error(`block end name conflict at index ${index}`);
      if (partial.toolCallArguments.length > 0 && partial.toolCallArguments !== block.arguments) {
        throw new Error(`block end arguments conflict at index ${index}`);
      }
    }
    partial.block = block;
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

  blocks(): readonly ContentBlock[] {
    const blocks = this.order.map((index) => {
      const partial = this.partials.get(index);
      if (partial === undefined) throw new Error(`assembler invariant violated at index ${index}`);
      return this.assemble(partial, index);
    });
    const visible = this.finish === "max-tokens" ? blocks.filter((block) => block.type !== "tool-call") : blocks;
    return snapshotBoundary(visible, "blocks");
  }

  interruptedBlocks(): readonly ContentBlock[] {
    const blocks = this.order.flatMap((index): ContentBlock[] => {
      const partial = this.partials.get(index);
      if (partial === undefined) throw new Error(`assembler invariant violated at index ${index}`);
      if (partial.blockType !== "text" && partial.blockType !== "thinking") return [];
      const block = this.assemble(partial, index);
      return block.type === "text" || block.type === "thinking"
        ? block.text.trim().length === 0 ? [] : [block]
        : [];
    });
    return snapshotBoundary(blocks, "interrupted blocks");
  }

  get usage(): TokenUsage | undefined { return this.currentUsage; }
  get finish(): "stop" | "tool-calls" | "max-tokens" | "cancelled" | "error" { return this.currentFinish ?? "stop"; }
  get error(): LlmFailure | undefined { return this.currentError; }

  message(
    source: ModelMessageSource,
    id: MessageIdType = MessageId(createSafeRandomPublicControlIdV1("assistant"))
  ): AssistantMessage {
    return createAssistantMessage({ id, content: this.blocks(), source });
  }
}
