/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/llm/llm/src/types.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: removed Cordis augmentation, attachments, provider discovery,
 * and merge-extensible plugin unions; retained a closed v0.1 stream vocabulary.
 */

import type { CallId, MessageId } from "./ids.js";
import type { JsonValue } from "./json.js";

export interface LlmFailure {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  readonly retryable?: boolean;
}

export interface TextBlock { readonly type: "text"; readonly text: string }
export interface ThinkingBlock { readonly type: "thinking"; readonly text: string }
export interface ToolCallBlock {
  readonly type: "tool-call";
  readonly id: CallId;
  readonly name: string;
  readonly arguments: string;
}
export interface ToolResultBlock {
  readonly type: "tool-result";
  readonly toolCallId: CallId;
  readonly content: readonly (TextBlock | ThinkingBlock)[];
  readonly isError?: boolean;
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock;
export type ContentBlockType = ContentBlock["type"];

export interface UserMessageSource { readonly kind: "user" }
export interface ModelMessageSource {
  readonly kind: "model";
  readonly provider: string;
  readonly model: string;
}
export interface ToolMessageSource { readonly kind: "tool"; readonly callId: CallId }
export type MessageSource = UserMessageSource | ModelMessageSource | ToolMessageSource;

export interface Message {
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly content: readonly ContentBlock[];
  readonly source: MessageSource;
}
export interface UserMessage extends Message {
  readonly role: "user";
  readonly source: UserMessageSource;
}
export interface AssistantMessage extends Message {
  readonly role: "assistant";
  readonly source: ModelMessageSource;
}
export interface ToolResultMessage extends Message {
  readonly role: "user";
  readonly source: ToolMessageSource;
  readonly content: readonly [ToolResultBlock];
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly thinkingTokens?: number;
}

export type FinishReason = "stop" | "tool-calls" | "max-tokens" | "cancelled" | "error";
export type StreamChunk =
  | { readonly type: "block-start"; readonly index: number; readonly blockType: ContentBlockType }
  | { readonly type: "text-delta"; readonly index: number; readonly text: string }
  | { readonly type: "thinking-delta"; readonly index: number; readonly text: string }
  | { readonly type: "tool-call-delta"; readonly index: number; readonly id: CallId; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: "block-end"; readonly index: number; readonly block: ContentBlock }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "error"; readonly error: LlmFailure }
  | { readonly type: "finish"; readonly reason: FinishReason };

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonValue;
}

export interface LlmRequest {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly Message[];
  readonly system?: string;
  readonly tools?: readonly ToolSchema[];
  readonly signal?: AbortSignal;
}
