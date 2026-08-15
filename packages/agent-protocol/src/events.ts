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

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const RFC3339_UTC_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isCanonicalRfc3339(value: unknown): value is string {
  if (typeof value !== "string" || !RFC3339_UTC_PATTERN.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isTextLikeBlock(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["type", "text"])) return false;
  return (value.type === "text" || value.type === "thinking") && typeof value.text === "string";
}

function isContentBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text" || value.type === "thinking") return isTextLikeBlock(value);
  if (value.type === "tool-call") {
    return hasExactKeys(value, ["type", "id", "name", "arguments"])
      && isNonEmptyString(value.id)
      && isNonEmptyString(value.name)
      && typeof value.arguments === "string";
  }
  if (value.type === "tool-result") {
    return hasExactKeys(value, ["type", "toolCallId", "content"], ["isError"])
      && isNonEmptyString(value.toolCallId)
      && Array.isArray(value.content)
      && value.content.every(isTextLikeBlock)
      && (value.isError === undefined || typeof value.isError === "boolean");
  }
  return false;
}

function isSource(value: unknown, expected: "user" | "model" | "tool"): boolean {
  if (!isRecord(value) || value.kind !== expected) return false;
  if (expected === "user") return hasExactKeys(value, ["kind"]);
  if (expected === "model") {
    return hasExactKeys(value, ["kind", "provider", "model"])
      && isNonEmptyString(value.provider)
      && isNonEmptyString(value.model);
  }
  return hasExactKeys(value, ["kind", "callId"]) && isNonEmptyString(value.callId);
}

function isMessage(value: unknown, expected: "user" | "assistant" | "tool-result"): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "role", "content", "source"])) return false;
  if (!isNonEmptyString(value.id) || !Array.isArray(value.content) || !value.content.every(isContentBlock)) return false;
  if (expected === "assistant") {
    return value.role === "assistant" && isSource(value.source, "model");
  }
  if (value.role !== "user") return false;
  if (expected === "user") return isSource(value.source, "user");
  if (!isSource(value.source, "tool") || value.content.length !== 1) return false;
  const block = value.content[0];
  return isRecord(block)
    && block.type === "tool-result"
    && isRecord(value.source)
    && block.toolCallId === value.source.callId;
}

function isTokenUsage(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["inputTokens", "outputTokens"],
    ["cacheReadTokens", "cacheWriteTokens", "thinkingTokens"]
  )) return false;
  return Object.entries(value).every(([, count]) => isNonNegativeSafeInteger(count));
}

function isLabels(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((label) => typeof label === "string");
}

function isToolError(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["name", "code"])
    && isNonEmptyString(value.name)
    && isNonEmptyString(value.code);
}

function isTurnError(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["code", "message"])
    && isNonEmptyString(value.code)
    && typeof value.message === "string";
}

function isEventPayload(type: AgentSessionEventTypeV1, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (type) {
    case "session/created":
      return hasExactKeys(value, [], ["cwd", "labels"])
        && (value.cwd === undefined || typeof value.cwd === "string")
        && (value.labels === undefined || isLabels(value.labels));
    case "turn/start":
      return hasExactKeys(value, ["turn"]) && isPositiveSafeInteger(value.turn);
    case "user/message":
      return hasExactKeys(value, ["turn", "message"])
        && isPositiveSafeInteger(value.turn)
        && isMessage(value.message, "user");
    case "step/start":
      return hasExactKeys(value, ["turn", "step"])
        && isPositiveSafeInteger(value.turn)
        && isPositiveSafeInteger(value.step);
    case "assistant/message":
      return hasExactKeys(value, ["turn", "step", "message"], ["usage"])
        && isPositiveSafeInteger(value.turn)
        && isPositiveSafeInteger(value.step)
        && isMessage(value.message, "assistant")
        && (value.usage === undefined || isTokenUsage(value.usage));
    case "tool/call":
      return hasExactKeys(value, ["turn", "step", "callId", "name", "arguments"])
        && isPositiveSafeInteger(value.turn)
        && isPositiveSafeInteger(value.step)
        && isNonEmptyString(value.callId)
        && isNonEmptyString(value.name)
        && typeof value.arguments === "string";
    case "tool/result":
      return hasExactKeys(value, ["turn", "step", "message", "status"], ["error"])
        && isPositiveSafeInteger(value.turn)
        && isPositiveSafeInteger(value.step)
        && isMessage(value.message, "tool-result")
        && (value.status === "completed" || value.status === "interrupted")
        && (value.error === undefined || isToolError(value.error));
    case "step/end":
      return hasExactKeys(value, ["turn", "step", "status"])
        && isPositiveSafeInteger(value.turn)
        && isPositiveSafeInteger(value.step)
        && ["completed", "cancelled", "budget-exceeded", "interrupted", "error"].includes(String(value.status));
    case "turn/end":
      return hasExactKeys(value, ["turn", "reason"], ["error"])
        && isPositiveSafeInteger(value.turn)
        && ["completed", "cancelled", "budget-exceeded", "interrupted", "error"].includes(String(value.reason))
        && (value.error === undefined || isTurnError(value.error));
  }
}

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
  if (!isCanonicalRfc3339(input.occurredAt)) throw new Error("event occurredAt must be canonical RFC3339 UTC");
  const payload = snapshotJsonValue(input.payload);
  if (payload === undefined) throw new Error(`event ${input.type} payload is not losslessly JSON-serializable`);
  if (!isEventPayload(input.type, payload)) throw new Error(`event ${input.type} payload does not match the closed v1 schema`);
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
  const event = { ...envelope, digest };
  if (!isAgentSessionEventV1(event)) throw new Error("event envelope does not match the closed v1 schema");
  return deepFreeze(event) as AgentSessionEventV1<T>;
}

export function verifyAgentSessionEventChain(events: readonly AgentSessionEventV1[]): void {
  let previous: AgentSessionEventV1 | undefined;
  for (const [index, event] of events.entries()) {
    if (!isAgentSessionEventV1(event)) throw new Error(`invalid event schema at index ${index}`);
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
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["schemaVersion", "eventId", "sessionId", "seq", "occurredAt", "type", "payload", "payloadDigest", "digest"],
    ["runId", "candidateId", "previousDigest"]
  )) return false;
  if (value.schemaVersion !== 1
    || !isNonEmptyString(value.eventId)
    || !isNonEmptyString(value.sessionId)
    || !isNonNegativeSafeInteger(value.seq)
    || !isCanonicalRfc3339(value.occurredAt)
    || typeof value.type !== "string"
    || !AGENT_SESSION_EVENT_TYPES_V1.has(value.type)
    || !DIGEST_PATTERN.test(String(value.payloadDigest))
    || !DIGEST_PATTERN.test(String(value.digest))
    || (value.runId !== undefined && !isNonEmptyString(value.runId))
    || (value.candidateId !== undefined && !isNonEmptyString(value.candidateId))) return false;
  if (value.seq === 0 ? value.previousDigest !== undefined : !DIGEST_PATTERN.test(String(value.previousDigest))) return false;
  return isEventPayload(value.type as AgentSessionEventTypeV1, value.payload);
}

export function eventAsJson(event: AgentSessionEventV1): JsonValue {
  return event as unknown as JsonValue;
}
