/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/llm/llm/src/message.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: reduced constructors to the closed v0.1 message/source union.
 */

import { deepFreeze } from "./freeze.js";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "./model.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function snapshotMessage<T>(message: T): T {
  return deepFreeze(structuredClone(message));
}

export function createUserMessage(input: Omit<Mutable<UserMessage>, "role">): UserMessage {
  return snapshotMessage({ ...input, role: "user" });
}

export function createAssistantMessage(input: Omit<Mutable<AssistantMessage>, "role">): AssistantMessage {
  return snapshotMessage({ ...input, role: "assistant" });
}

export function createToolResultMessage(input: Omit<Mutable<ToolResultMessage>, "role">): ToolResultMessage {
  return snapshotMessage({ ...input, role: "user" });
}

export function snapshotMessageValue<T extends UserMessage | AssistantMessage | ToolResultMessage>(message: T): T {
  return snapshotMessage(message);
}
