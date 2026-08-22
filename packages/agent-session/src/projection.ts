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
  digestJson,
  type AgentToolApprovalBindingV1,
  type AgentSessionEvent,
  type AgentSessionProtectedPayload,
  type CallId,
  type CandidateId,
  type Digest,
  type EffectCommitmentV1,
  type EventId,
  type Message,
  type ModelAttemptStartedV1,
  type RunId
} from "@mn/agent-protocol";

import type { AgentSessionLike } from "./types.js";

interface PendingToolCallBase {
  readonly callId: CallId;
  readonly turn: number;
  readonly step: number;
  readonly name: string;
  readonly replayAllowed: false;
  readonly runId?: RunId;
  readonly candidateId?: CandidateId;
}

export type PendingToolCall = PendingToolCallBase & (
  | {
    readonly binding: typeof UNBOUND_PROTECTED_TOOL_CALL_V1;
    readonly started: false;
  }
  | {
    readonly binding: EffectCommitmentV1;
    readonly started: true;
  }
);

export type ProjectedProtectedMessage = AgentSessionProtectedPayload<
  "user/message" | "assistant/message" | "tool/result"
>;

export interface PendingToolApproval {
  readonly state: "requested" | "approved";
  readonly binding: AgentToolApprovalBindingV1;
  readonly requestEventId: EventId;
  readonly requestDigest: Digest;
  readonly requestedSeq: number;
}

export interface PendingModelAttempt {
  readonly startedEventId: EventId;
  readonly startedDigest: Digest;
  readonly started: ModelAttemptStartedV1;
  readonly turn: number;
  readonly step: number;
  readonly runId: RunId;
  readonly candidateId: CandidateId;
}

export interface AgentSessionProjection {
  readonly status: "idle" | "active" | "waiting-approval" | "completed" | "cancelled" | "budget-exceeded" | "interrupted" | "error";
  readonly openTurn?: number;
  readonly openStep?: number;
  readonly openTurnRunId?: RunId;
  readonly openTurnCandidateId?: CandidateId;
  readonly messages: readonly ProjectedProtectedMessage[];
  readonly pendingToolCalls: readonly PendingToolCall[];
  readonly pendingApprovals: readonly PendingToolApproval[];
  readonly pendingModelAttempts: readonly PendingModelAttempt[];
}

function sameApprovalBinding(left: AgentToolApprovalBindingV1, right: AgentToolApprovalBindingV1): boolean {
  return digestJson(left) === digestJson(right);
}

/**
 * Returns the current process-only model history. Reopened durable sessions do
 * not contain an execution overlay and fail closed rather than materializing
 * protected persistence records back into executable messages.
 */
export function projectRuntimeMessages(session: AgentSessionLike): readonly Message[] {
  return session.runtimeMessages();
}

export function projectSession(events: readonly AgentSessionEvent[]): AgentSessionProjection {
  const messages: ProjectedProtectedMessage[] = [];
  const pending = new Map<CallId, PendingToolCall>();
  const approvals = new Map<string, PendingToolApproval>();
  const approvalByCall = new Map<CallId, string>();
  const modelAttempts = new Map<EventId, PendingModelAttempt>();
  let status: AgentSessionProjection["status"] = "idle";
  let openTurn: number | undefined;
  let openStep: number | undefined;
  let openTurnRunId: RunId | undefined;
  let openTurnCandidateId: CandidateId | undefined;

  for (const event of events) {
    switch (event.type) {
      case "attachment/stored":
        break;
      case "turn/start":
        if (modelAttempts.size !== 0) {
          throw new TypeError("a new turn cannot bypass a pending model attempt audit");
        }
        openTurn = event.payload.publicControls.turn;
        openStep = undefined;
        openTurnRunId = event.runId;
        openTurnCandidateId = event.candidateId;
        pending.clear();
        approvals.clear();
        approvalByCall.clear();
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
      case "model/attempt-started": {
        const controls = event.payload.publicControls;
        if (openTurn !== controls.turn || openStep !== controls.step
          || event.runId === undefined || event.candidateId === undefined
          || event.runId !== openTurnRunId || event.candidateId !== openTurnCandidateId
          || modelAttempts.size !== 0) {
          throw new TypeError("durable model attempt start does not match one open step");
        }
        modelAttempts.set(event.eventId, {
          startedEventId: event.eventId,
          startedDigest: event.digest,
          started: controls.attempt,
          turn: controls.turn,
          step: controls.step,
          runId: event.runId,
          candidateId: event.candidateId
        });
        break;
      }
      case "model/audit": {
        const controls = event.payload.publicControls;
        const pendingAttempt = modelAttempts.get(controls.startedEventId);
        const terminal = controls.terminal;
        const started = pendingAttempt?.started;
        if (pendingAttempt === undefined || started === undefined
          || controls.startedDigest !== pendingAttempt.startedDigest
          || controls.turn !== pendingAttempt.turn || controls.step !== pendingAttempt.step
          || event.runId !== pendingAttempt.runId || event.candidateId !== pendingAttempt.candidateId
          || terminal.providerId !== started.providerId || terminal.modelId !== started.modelId
          || terminal.apiFormat !== started.apiFormat || terminal.attempt !== started.attempt
          || terminal.protectedRequestDigest !== started.protectedRequestDigest
          || terminal.routeDigest !== started.routeDigest
          || terminal.pricingDigest !== started.pricingDigest) {
          throw new TypeError("durable model audit does not match its explicit attempt start fact");
        }
        modelAttempts.delete(controls.startedEventId);
        break;
      }
      case "approval/requested": {
        const binding = event.payload.publicControls.binding;
        const call = pending.get(binding.callId);
        if (call === undefined || call.started || call.name !== binding.name
          || call.turn !== binding.commitment.turn || call.step !== binding.commitment.step
          || call.runId === undefined || call.runId !== binding.commitment.runId
          || call.candidateId === undefined || call.candidateId !== binding.commitment.candidateId
          || approvals.has(binding.approvalId) || approvalByCall.has(binding.callId)) {
          throw new TypeError("durable approval request does not match one unstarted tool proposal");
        }
        approvals.set(binding.approvalId, {
          state: "requested",
          binding,
          requestEventId: event.eventId,
          requestDigest: event.digest,
          requestedSeq: event.seq
        });
        approvalByCall.set(binding.callId, binding.approvalId);
        status = "waiting-approval";
        break;
      }
      case "approval/resolved": {
        const controls = event.payload.publicControls;
        const approval = approvals.get(controls.binding.approvalId);
        if (approval === undefined || approval.state !== "requested"
          || controls.requestEventId !== approval.requestEventId
          || controls.requestDigest !== approval.requestDigest
          || !sameApprovalBinding(controls.binding, approval.binding)) {
          throw new TypeError("durable approval resolution does not match its explicit request fact");
        }
        if (controls.decision === "approve_once" || controls.decision === "approve_session_scope") {
          approvals.set(controls.binding.approvalId, { ...approval, state: "approved" });
        } else {
          approvals.delete(controls.binding.approvalId);
          approvalByCall.delete(controls.binding.callId);
        }
        status = [...approvals.values()].some((candidate) => candidate.state === "requested")
          ? "waiting-approval"
          : "active";
        break;
      }
      case "tool/call": {
        const controls = event.payload.publicControls;
        const existing = pending.get(controls.callId);
        const approvalId = approvalByCall.get(controls.callId);
        const approval = approvalId === undefined ? undefined : approvals.get(approvalId);
        if (existing === undefined || existing.started || approval === undefined || approval.state !== "approved"
          || existing.name !== controls.name
          || !sameApprovalBinding(approval.binding, {
            ...approval.binding,
            commitment: controls.binding
          })) {
          throw new TypeError("durable tool call does not match one approved tool proposal");
        }
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
        approvals.delete(approval.binding.approvalId);
        approvalByCall.delete(controls.callId);
        break;
      }
      case "tool/result": {
        const callId = event.payload.publicControls.message.source.callId;
        const approvalId = approvalByCall.get(callId);
        const approval = approvalId === undefined ? undefined : approvals.get(approvalId);
        if (approval?.state === "requested") {
          throw new TypeError("durable tool result cannot bypass a pending approval resolution");
        }
        messages.push(event.payload);
        pending.delete(callId);
        if (approvalId !== undefined) approvals.delete(approvalId);
        approvalByCall.delete(callId);
        break;
      }
      case "step/end":
        if (modelAttempts.size !== 0) {
          throw new TypeError("step end cannot bypass a pending model attempt audit");
        }
        openStep = undefined;
        break;
      case "turn/end":
        if (modelAttempts.size !== 0) {
          throw new TypeError("turn end cannot bypass a pending model attempt audit");
        }
        openTurn = undefined;
        openStep = undefined;
        openTurnRunId = undefined;
        openTurnCandidateId = undefined;
        pending.clear();
        approvals.clear();
        approvalByCall.clear();
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
    pendingToolCalls: Object.freeze([...pending.values()]),
    pendingApprovals: Object.freeze([...approvals.values()]),
    pendingModelAttempts: Object.freeze([...modelAttempts.values()])
  };
}
