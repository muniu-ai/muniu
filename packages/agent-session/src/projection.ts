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
  CandidateId,
  RunId,
  Message
} from "@mn/agent-protocol";

export interface PendingToolCall {
  readonly callId: CallId;
  readonly turn: number;
  readonly step: number;
  readonly name: string;
  readonly arguments: string;
  readonly started: boolean;
  readonly runId?: RunId;
  readonly candidateId?: CandidateId;
}

export interface AgentSessionProjection {
  readonly status: "idle" | "active" | "completed" | "cancelled" | "budget-exceeded" | "interrupted" | "error";
  readonly openTurn?: number;
  readonly openStep?: number;
  readonly openTurnRunId?: RunId;
  readonly openTurnCandidateId?: CandidateId;
  readonly messages: readonly Message[];
  readonly pendingToolCalls: readonly PendingToolCall[];
}

export function projectSession(events: readonly AgentSessionEventV1[]): AgentSessionProjection {
  const messages: Message[] = [];
  const pending = new Map<CallId, PendingToolCall>();
  let status: AgentSessionProjection["status"] = "idle";
  let openTurn: number | undefined;
  let openStep: number | undefined;
  let openTurnRunId: RunId | undefined;
  let openTurnCandidateId: CandidateId | undefined;

  for (const event of events) {
    switch (event.type) {
      case "turn/start":
        openTurn = event.payload.turn;
        openStep = undefined;
        openTurnRunId = event.runId;
        openTurnCandidateId = event.candidateId;
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
            const runId = event.runId ?? openTurnRunId;
            const candidateId = event.candidateId ?? openTurnCandidateId;
            pending.set(block.id, {
              callId: block.id,
              turn: event.payload.turn,
              step: event.payload.step,
              name: block.name,
              arguments: block.arguments,
              started: false,
              ...(runId === undefined ? {} : { runId }),
              ...(candidateId === undefined ? {} : { candidateId })
            });
          }
        }
        break;
      case "tool/call": {
        const existing = pending.get(event.payload.callId);
        const runId = event.runId ?? existing?.runId ?? openTurnRunId;
        const candidateId = event.candidateId ?? existing?.candidateId ?? openTurnCandidateId;
        pending.set(event.payload.callId, {
          callId: event.payload.callId,
          turn: event.payload.turn,
          step: event.payload.step,
          name: event.payload.name,
          arguments: event.payload.arguments,
          started: true,
          ...(runId === undefined ? {} : { runId }),
          ...(candidateId === undefined ? {} : { candidateId })
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
        openTurnRunId = undefined;
        openTurnCandidateId = undefined;
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
    ...(openTurnRunId === undefined ? {} : { openTurnRunId }),
    ...(openTurnCandidateId === undefined ? {} : { openTurnCandidateId }),
    messages: Object.freeze([...messages]),
    pendingToolCalls: Object.freeze([...pending.values()])
  };
}
