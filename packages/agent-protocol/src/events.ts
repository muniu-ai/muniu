/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/core/session/src/types.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: replaced Session v0 with the closed, versioned Muniu event
 * envelope and digest-chain fields; removed plugin event merging and Cordis.
 */

import { digestJson } from "./canonical.js";
import { deepFreeze } from "./freeze.js";
import type { CallId, CandidateId, Digest, EventId, RunId, SessionId } from "./ids.js";
import type { AssistantMessage, ToolResultMessage, TokenUsage, UserMessage } from "./model.js";
import { snapshotJsonValue, type JsonValue } from "./json.js";

export type StepEndStatus = "completed" | "cancelled" | "budget-exceeded" | "interrupted" | "error";
export type TurnEndReason = "completed" | "cancelled" | "budget-exceeded" | "interrupted" | "error";

export interface AgentSessionEventPayloadMapV1 {
  "session/created": { cwd?: string; labels?: Record<string, string> };
  "turn/start": { turn: number };
  "user/message": { turn: number; message: UserMessage };
  "step/start": { turn: number; step: number };
  "assistant/message": { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage };
  "tool/call": { turn: number; step: number; callId: CallId; name: string; arguments: string };
  "tool/result": {
    turn: number;
    step: number;
    message: ToolResultMessage;
    status: "completed" | "interrupted";
    error?: { name: string; code: string };
  };
  "step/end": { turn: number; step: number; status: StepEndStatus };
  "turn/end": { turn: number; reason: TurnEndReason; error?: { code: string; message: string } };
}

export type AgentSessionEventTypeV1 = keyof AgentSessionEventPayloadMapV1;

const AGENT_SESSION_EVENT_TYPES_V1 = new Set<string>([
  "session/created",
  "turn/start",
  "user/message",
  "step/start",
  "assistant/message",
  "tool/call",
  "tool/result",
  "step/end",
  "turn/end"
]);

export type AgentSessionEventV1<T extends AgentSessionEventTypeV1 = AgentSessionEventTypeV1> = {
  [K in AgentSessionEventTypeV1]: {
    readonly schemaVersion: 1;
    readonly eventId: EventId;
    readonly sessionId: SessionId;
    readonly seq: number;
    readonly occurredAt: string;
    readonly type: K;
    readonly runId?: RunId;
    readonly candidateId?: CandidateId;
    readonly payload: AgentSessionEventPayloadMapV1[K];
    readonly payloadDigest: Digest;
    readonly previousDigest?: Digest;
    readonly digest: Digest;
  }
}[T];

export type NewAgentSessionEventV1<T extends AgentSessionEventTypeV1> = {
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly occurredAt: string;
  readonly type: T;
  readonly runId?: RunId;
  readonly candidateId?: CandidateId;
  readonly payload: AgentSessionEventPayloadMapV1[T];
  readonly previousDigest?: Digest;
};

function digestEnvelope(event: Omit<AgentSessionEventV1, "payload" | "digest">): Digest {
  return digestJson(event);
}

export function createAgentSessionEvent<T extends AgentSessionEventTypeV1>(input: NewAgentSessionEventV1<T>): AgentSessionEventV1<T> {
  if (!Number.isSafeInteger(input.seq) || input.seq < 0) throw new Error("event seq must be a non-negative safe integer");
  if (Number.isNaN(Date.parse(input.occurredAt))) throw new Error("event occurredAt must be an ISO date-time string");
  const payload = snapshotJsonValue(input.payload);
  if (payload === undefined) throw new Error(`event ${input.type} payload is not losslessly JSON-serializable`);
  const payloadDigest = digestJson(payload);
  const envelope = {
    schemaVersion: 1 as const,
    eventId: input.eventId,
    sessionId: input.sessionId,
    seq: input.seq,
    occurredAt: input.occurredAt,
    type: input.type,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
    payload: payload as AgentSessionEventPayloadMapV1[T],
    payloadDigest,
    ...(input.previousDigest === undefined ? {} : { previousDigest: input.previousDigest })
  };
  const { payload: _payload, ...digestFields } = envelope;
  const digest = digestEnvelope(digestFields as unknown as Omit<AgentSessionEventV1, "payload" | "digest">);
  return deepFreeze({ ...envelope, digest }) as AgentSessionEventV1<T>;
}

export function verifyAgentSessionEventChain(events: readonly AgentSessionEventV1[]): void {
  let previous: AgentSessionEventV1 | undefined;
  for (const [index, event] of events.entries()) {
    if (event.schemaVersion !== 1) throw new Error(`unsupported event schema at seq ${event.seq}`);
    if (event.seq !== index) throw new Error(`event seq ${event.seq} is not contiguous; expected ${index}`);
    if (previous !== undefined && event.sessionId !== previous.sessionId) throw new Error("event chain crosses session ids");
    if (event.previousDigest !== previous?.digest) throw new Error(`event previous digest mismatch at seq ${event.seq}`);
    const payloadDigest = digestJson(event.payload);
    if (payloadDigest !== event.payloadDigest) throw new Error(`event payload digest mismatch at seq ${event.seq}`);
    const { payload: _payload, digest: _digest, ...envelope } = event;
    if (digestEnvelope(envelope) !== event.digest) throw new Error(`event digest mismatch at seq ${event.seq}`);
    previous = event;
  }
}

export function isAgentSessionEventV1(value: unknown): value is AgentSessionEventV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.schemaVersion === 1
    && typeof event.eventId === "string"
    && typeof event.sessionId === "string"
    && typeof event.seq === "number"
    && typeof event.occurredAt === "string"
    && typeof event.type === "string"
    && AGENT_SESSION_EVENT_TYPES_V1.has(event.type)
    && event.payload !== undefined
    && typeof event.payloadDigest === "string"
    && typeof event.digest === "string";
}

export function eventAsJson(event: AgentSessionEventV1): JsonValue {
  return event as unknown as JsonValue;
}
