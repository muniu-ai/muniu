/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/core/session/src/surface.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: replaced the plugin-extensible surface fold with a closed v0.1
 * projection of messages, turn/step state, and pending tool effects.
 */

import type {
  AgentSessionEventV1,
  CallId,
  Message
} from "@mn/agent-protocol";

export interface PendingToolCall {
  readonly callId: CallId;
  readonly turn: number;
  readonly step: number;
  readonly name: string;
  readonly arguments: string;
  readonly started: boolean;
}

export interface AgentSessionProjection {
  readonly status: "idle" | "active" | "completed" | "cancelled" | "budget-exceeded" | "interrupted" | "error";
  readonly openTurn?: number;
  readonly openStep?: number;
  readonly messages: readonly Message[];
  readonly pendingToolCalls: readonly PendingToolCall[];
}

export function projectSession(events: readonly AgentSessionEventV1[]): AgentSessionProjection {
  const messages: Message[] = [];
  const pending = new Map<CallId, PendingToolCall>();
  let status: AgentSessionProjection["status"] = "idle";
  let openTurn: number | undefined;
  let openStep: number | undefined;

  for (const event of events) {
    switch (event.type) {
      case "turn/start":
        openTurn = event.payload.turn;
        openStep = undefined;
        pending.clear();
        status = "active";
        break;
      case "user/message":
        messages.push(event.payload.message);
        break;
      case "step/start":
        openStep = event.payload.step;
        break;
      case "assistant/message":
        messages.push(event.payload.message);
        for (const block of event.payload.message.content) {
          if (block.type === "tool-call") {
            pending.set(block.id, {
              callId: block.id,
              turn: event.payload.turn,
              step: event.payload.step,
              name: block.name,
              arguments: block.arguments,
              started: false
            });
          }
        }
        break;
      case "tool/call": {
        pending.set(event.payload.callId, {
          callId: event.payload.callId,
          turn: event.payload.turn,
          step: event.payload.step,
          name: event.payload.name,
          arguments: event.payload.arguments,
          started: true
        });
        break;
      }
      case "tool/result":
        messages.push(event.payload.message);
        pending.delete(event.payload.message.source.callId);
        break;
      case "step/end":
        openStep = undefined;
        break;
      case "turn/end":
        openTurn = undefined;
        openStep = undefined;
        pending.clear();
        status = event.payload.reason;
        break;
      case "session/created":
        break;
    }
  }
  return {
    status,
    ...(openTurn === undefined ? {} : { openTurn }),
    ...(openStep === undefined ? {} : { openStep }),
    messages: Object.freeze([...messages]),
    pendingToolCalls: Object.freeze([...pending.values()])
  };
}
