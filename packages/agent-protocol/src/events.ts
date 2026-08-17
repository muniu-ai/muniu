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

import { types as utilTypes } from "node:util";

import { digestJson } from "./canonical.js";
import { deepFreeze } from "./freeze.js";
import type { CandidateId, Digest, EventId, RunId, SessionId } from "./ids.js";
import type { JsonValue } from "./json.js";
import {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  assertAgentSessionProtectedPayloadV1,
  inspectAgentSessionProtectedPayloadV1,
  type AgentSessionProtectedEventTypeV1,
  type AgentSessionProtectedPayloadV1,
  type AgentSessionRawPayloadMapV1
} from "./session-payload.js";
import {
  assertSafePublicControlIdV1,
  isSafePublicControlIdV1
} from "./public-control.js";
import { PROTECTION_POLICY_DIGEST_V1 } from "./protection.js";

export type StepEndStatus = AgentSessionRawPayloadMapV1["step/end"]["status"];
export type TurnEndReason = AgentSessionRawPayloadMapV1["turn/end"]["reason"];

/** Raw, process-local append inputs. Durable events never contain this map. */
export type AgentSessionEventPayloadMapV1 = AgentSessionRawPayloadMapV1;
export type AgentSessionEventTypeV1 = AgentSessionProtectedEventTypeV1;

const AGENT_SESSION_EVENT_TYPES_V1 = new Set<string>([
  "session/created",
  "turn/start",
  "user/message",
  "step/start",
  "assistant/message",
  "approval/requested",
  "approval/resolved",
  "tool/call",
  "tool/result",
  "step/end",
  "turn/end"
]);

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const RFC3339_UTC_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

function exactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (!required.every((key) => keys.includes(key))
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
  const output: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return output;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function effectCommitmentMatchesEnvelope(
  type: AgentSessionEventTypeV1,
  payload: AgentSessionProtectedPayloadV1,
  sessionId: unknown,
  runId: unknown,
  candidateId: unknown
): boolean {
  const binding = type === "tool/call"
    ? (payload as AgentSessionProtectedPayloadV1<"tool/call">).publicControls.binding
    : type === "approval/requested"
      ? (payload as AgentSessionProtectedPayloadV1<"approval/requested">)
        .publicControls.binding.commitment
      : type === "approval/resolved"
        ? (payload as AgentSessionProtectedPayloadV1<"approval/resolved">)
          .publicControls.binding.commitment
        : undefined;
  if (binding === undefined) return true;
  return runId !== undefined
    && candidateId !== undefined
    && binding.sessionId === sessionId
    && binding.runId === runId
    && binding.candidateId === candidateId;
}

export function isCanonicalRfc3339(value: unknown): value is string {
  if (typeof value !== "string" || !RFC3339_UTC_PATTERN.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
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
    readonly protectionProfile: typeof AGENT_SESSION_PROTECTION_PROFILE_V1;
    readonly protectionPolicyDigest: Digest;
    readonly payload: AgentSessionProtectedPayloadV1<K>;
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
  readonly payload: AgentSessionProtectedPayloadV1<T>;
  readonly previousDigest?: Digest;
};

export function createAgentSessionEvent<T extends AgentSessionEventTypeV1>(
  input: NewAgentSessionEventV1<T>
): AgentSessionEventV1<T> {
  const record = exactDataRecord(input, [
    "eventId",
    "sessionId",
    "seq",
    "occurredAt",
    "type",
    "payload"
  ], ["runId", "candidateId", "previousDigest"]);
  if (record === undefined) throw new TypeError("event input must contain only enumerable data properties");
  if (typeof record.type !== "string" || !AGENT_SESSION_EVENT_TYPES_V1.has(record.type)) {
    throw new TypeError("event input type is invalid");
  }
  const type = record.type as T;
  const seq = record.seq;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) {
    throw new Error("event seq must be a non-negative safe integer");
  }
  const occurredAt = record.occurredAt;
  if (!isCanonicalRfc3339(occurredAt)) {
    throw new Error("event occurredAt must be canonical RFC3339 UTC");
  }
  const eventId = record.eventId;
  const sessionId = record.sessionId;
  const runId = record.runId;
  const candidateId = record.candidateId;
  const previousDigest = record.previousDigest;
  assertSafePublicControlIdV1(eventId, "event identifier");
  assertSafePublicControlIdV1(sessionId, "session identifier");
  if (runId !== undefined) assertSafePublicControlIdV1(runId, "run identifier");
  if (candidateId !== undefined) {
    assertSafePublicControlIdV1(candidateId, "candidate identifier");
  }
  if (seq === 0) {
    if (previousDigest !== undefined) throw new Error("first event must not have a previous digest");
  } else if (!isDigest(previousDigest)) {
    throw new Error("non-initial event must have a previous digest");
  }

  const payload = assertAgentSessionProtectedPayloadV1(type, record.payload);
  if (!effectCommitmentMatchesEnvelope(type, payload, sessionId, runId, candidateId)) {
    throw new TypeError("tool or approval effect commitment does not match the durable event envelope");
  }
  const envelope = {
    schemaVersion: 1 as const,
    eventId: eventId as EventId,
    sessionId: sessionId as SessionId,
    seq: seq as number,
    occurredAt,
    type,
    ...(runId === undefined ? {} : { runId: runId as RunId }),
    ...(candidateId === undefined ? {} : { candidateId: candidateId as CandidateId }),
    protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V1,
    protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1,
    payload,
    payloadDigest: payload.digest,
    ...(previousDigest === undefined ? {} : { previousDigest: previousDigest as Digest })
  };
  const event = { ...envelope, digest: digestJson(envelope) };
  if (!isAgentSessionEventV1(event)) {
    throw new Error("event envelope does not match the closed protected v1 schema");
  }
  return deepFreeze(event) as AgentSessionEventV1<T>;
}

export function verifyAgentSessionEventChain(events: readonly AgentSessionEventV1[]): void {
  let previous: AgentSessionEventV1 | undefined;
  for (const [index, event] of events.entries()) {
    if (!isAgentSessionEventV1(event)) throw new Error(`invalid event schema at index ${index}`);
    if (event.seq !== index) throw new Error(`event seq ${event.seq} is not contiguous; expected ${index}`);
    if (previous !== undefined && event.sessionId !== previous.sessionId) {
      throw new Error("event chain crosses session ids");
    }
    if (event.previousDigest !== previous?.digest) {
      throw new Error(`event previous digest mismatch at seq ${event.seq}`);
    }
    if (event.payload.digest !== event.payloadDigest) {
      throw new Error(`event payload digest mismatch at seq ${event.seq}`);
    }
    const { digest: _digest, ...envelope } = event;
    if (digestJson(envelope) !== event.digest) {
      throw new Error(`event digest mismatch at seq ${event.seq}`);
    }
    previous = event;
  }
}

export function isAgentSessionEventV1(value: unknown): value is AgentSessionEventV1 {
  try {
    const event = exactDataRecord(value, [
      "schemaVersion",
      "eventId",
      "sessionId",
      "seq",
      "occurredAt",
      "type",
      "protectionProfile",
      "protectionPolicyDigest",
      "payload",
      "payloadDigest",
      "digest"
    ], ["runId", "candidateId", "previousDigest"]);
    if (event === undefined
      || event.schemaVersion !== 1
      || !isSafePublicControlIdV1(event.eventId)
      || !isSafePublicControlIdV1(event.sessionId)
      || !isNonNegativeSafeInteger(event.seq)
      || !isCanonicalRfc3339(event.occurredAt)
      || typeof event.type !== "string"
      || !AGENT_SESSION_EVENT_TYPES_V1.has(event.type)
      || event.protectionProfile !== AGENT_SESSION_PROTECTION_PROFILE_V1
      || event.protectionPolicyDigest !== PROTECTION_POLICY_DIGEST_V1
      || !isDigest(event.payloadDigest)
      || !isDigest(event.digest)
      || (event.runId !== undefined && !isSafePublicControlIdV1(event.runId))
      || (event.candidateId !== undefined && !isSafePublicControlIdV1(event.candidateId))) return false;
    if (event.seq === 0
      ? event.previousDigest !== undefined
      : !isDigest(event.previousDigest)) return false;

    const payload = inspectAgentSessionProtectedPayloadV1(
      event.type as AgentSessionEventTypeV1,
      event.payload
    );
    if (payload === undefined
      || payload.digest !== event.payloadDigest
      || payload.protectionProfile !== event.protectionProfile
      || payload.protectionPolicyDigest !== event.protectionPolicyDigest) return false;
    if (!effectCommitmentMatchesEnvelope(
      event.type as AgentSessionEventTypeV1,
      payload,
      event.sessionId,
      event.runId,
      event.candidateId
    )) return false;

    const digestInput: Record<string, unknown> = { ...event, payload };
    delete digestInput.digest;
    return digestJson(digestInput as JsonValue) === event.digest;
  } catch {
    return false;
  }
}

export function eventAsJson(event: AgentSessionEventV1): JsonValue {
  return event as unknown as JsonValue;
}
