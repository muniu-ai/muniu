/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/core/session/src/surface.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: replaced the plugin-extensible surface fold with a closed v0.1
 * projection of protected messages, turn/step state, and pending tool effects.
 */

import {
  UNBOUND_PROTECTED_TOOL_CALL_V1,
  type AgentSessionEventV1,
  type AgentSessionProtectedPayloadV1,
  type CallId,
  type CandidateId,
  type Message,
  type RunId
} from "@mn/agent-protocol";

import type { AgentSessionLike } from "./types.js";

export interface PendingToolCall {
  readonly callId: CallId;
  readonly turn: number;
  readonly step: number;
  readonly name: string;
  readonly binding: typeof UNBOUND_PROTECTED_TOOL_CALL_V1;
  readonly started: boolean;
  readonly replayAllowed: false;
  readonly runId?: RunId;
  readonly candidateId?: CandidateId;
}

export type ProjectedProtectedMessage = AgentSessionProtectedPayloadV1<
  "user/message" | "assistant/message" | "tool/result"
>;

export interface AgentSessionProjection {
  readonly status: "idle" | "active" | "completed" | "cancelled" | "budget-exceeded" | "interrupted" | "error";
  readonly openTurn?: number;
  readonly openStep?: number;
  readonly openTurnRunId?: RunId;
  readonly openTurnCandidateId?: CandidateId;
  readonly messages: readonly ProjectedProtectedMessage[];
  readonly pendingToolCalls: readonly PendingToolCall[];
}

/**
 * Returns the current process-only model history. Reopened durable sessions do
 * not contain an execution overlay and fail closed rather than materializing
 * protected persistence records back into executable messages.
 */
export function projectRuntimeMessages(session: AgentSessionLike): readonly Message[] {
  return session.runtimeMessages();
}

export function projectSession(events: readonly AgentSessionEventV1[]): AgentSessionProjection {
  const messages: ProjectedProtectedMessage[] = [];
  const pending = new Map<CallId, PendingToolCall>();
  let status: AgentSessionProjection["status"] = "idle";
  let openTurn: number | undefined;
  let openStep: number | undefined;
  let openTurnRunId: RunId | undefined;
  let openTurnCandidateId: CandidateId | undefined;

  for (const event of events) {
    switch (event.type) {
      case "turn/start":
        openTurn = event.payload.publicControls.turn;
        openStep = undefined;
        openTurnRunId = event.runId;
        openTurnCandidateId = event.candidateId;
        pending.clear();
        status = "active";
        break;
      case "user/message":
        messages.push(event.payload);
        break;
      case "step/start":
        openStep = event.payload.publicControls.step;
        break;
      case "assistant/message": {
        messages.push(event.payload);
        const controls = event.payload.publicControls;
        for (const block of controls.message.content) {
          if (block.type !== "tool-call") continue;
          const runId = event.runId ?? openTurnRunId;
          const candidateId = event.candidateId ?? openTurnCandidateId;
          pending.set(block.id, {
            callId: block.id,
            turn: controls.turn,
            step: controls.step,
            name: block.name,
            binding: block.binding,
            started: false,
            replayAllowed: false,
            ...(runId === undefined ? {} : { runId }),
            ...(candidateId === undefined ? {} : { candidateId })
          });
        }
        break;
      }
      case "tool/call": {
        const controls = event.payload.publicControls;
        const existing = pending.get(controls.callId);
        const runId = event.runId ?? existing?.runId ?? openTurnRunId;
        const candidateId = event.candidateId ?? existing?.candidateId ?? openTurnCandidateId;
        pending.set(controls.callId, {
          callId: controls.callId,
          turn: controls.turn,
          step: controls.step,
          name: controls.name,
          binding: controls.binding,
          started: true,
          replayAllowed: false,
          ...(runId === undefined ? {} : { runId }),
          ...(candidateId === undefined ? {} : { candidateId })
        });
        break;
      }
      case "tool/result":
        messages.push(event.payload);
        pending.delete(event.payload.publicControls.message.source.callId);
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
        status = event.payload.publicControls.reason;
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
