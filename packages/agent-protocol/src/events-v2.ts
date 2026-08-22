// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import { digestJson } from "./canonical.js";
import { isCanonicalRfc3339 } from "./events.js";
import { deepFreeze } from "./freeze.js";
import type { CandidateId, Digest, EventId, RunId, SessionId } from "./ids.js";
import { PROTECTION_POLICY_DIGEST_V1 } from "./protection.js";
import { assertSafePublicControlIdV1 } from "./public-control.js";
import {
  AGENT_SESSION_PROTECTION_PROFILE_V2,
  assertAgentSessionProtectedPayloadV2,
  inspectAgentSessionProtectedPayloadV2,
  type AgentSessionProtectedEventTypeV2,
  type AgentSessionProtectedPayloadV2,
  type AgentSessionRawPayloadMapV2
} from "./session-payload-v2.js";

export type StepEndStatusV2 = AgentSessionRawPayloadMapV2["step/end"]["status"];
export type TurnEndReasonV2 = AgentSessionRawPayloadMapV2["turn/end"]["reason"];
export type AgentSessionEventPayloadMapV2 = AgentSessionRawPayloadMapV2;
export type AgentSessionEventTypeV2 = AgentSessionProtectedEventTypeV2;

const EVENT_TYPES_V2 = new Set<string>([
  "session/created",
  "turn/start",
  "user/message",
  "step/start",
  "assistant/message",
  "model/attempt-started",
  "model/audit",
  "approval/requested",
  "approval/resolved",
  "tool/call",
  "tool/result",
  "step/end",
  "turn/end",
  "attachment/stored"
]);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

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
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    output[key] = descriptor.value;
  }
  return output;
}

function digest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function effectBinding(payload: AgentSessionProtectedPayloadV2): {
  readonly sessionId: string;
  readonly runId: string;
  readonly candidateId: string;
} | undefined {
  if (payload.eventType === "tool/call") {
    return (payload as AgentSessionProtectedPayloadV2<"tool/call">).publicControls.binding;
  }
  if (payload.eventType === "approval/requested" || payload.eventType === "approval/resolved") {
    return (payload as AgentSessionProtectedPayloadV2<"approval/requested" | "approval/resolved">)
      .publicControls.binding.commitment;
  }
  return undefined;
}

export type AgentSessionEventV2<T extends AgentSessionEventTypeV2 = AgentSessionEventTypeV2> = {
  [K in AgentSessionEventTypeV2]: {
    readonly schemaVersion: 2;
    readonly eventId: EventId;
    readonly sessionId: SessionId;
    readonly seq: number;
    readonly occurredAt: string;
    readonly type: K;
    readonly runId?: RunId;
    readonly candidateId?: CandidateId;
    readonly protectionProfile: typeof AGENT_SESSION_PROTECTION_PROFILE_V2;
    readonly protectionPolicyDigest: Digest;
    readonly payload: AgentSessionProtectedPayloadV2<K>;
    readonly payloadDigest: Digest;
    readonly previousDigest?: Digest;
    readonly digest: Digest;
  }
}[T];

export type NewAgentSessionEventV2<T extends AgentSessionEventTypeV2> = {
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly occurredAt: string;
  readonly type: T;
  readonly runId?: RunId;
  readonly candidateId?: CandidateId;
  readonly payload: AgentSessionProtectedPayloadV2<T>;
  readonly previousDigest?: Digest;
};

export function createAgentSessionEventV2<T extends AgentSessionEventTypeV2>(
  input: NewAgentSessionEventV2<T>
): AgentSessionEventV2<T> {
  const source = exactDataRecord(input, [
    "eventId", "sessionId", "seq", "occurredAt", "type", "payload"
  ], ["runId", "candidateId", "previousDigest"]);
  if (source === undefined || typeof source.type !== "string" || !EVENT_TYPES_V2.has(source.type)) {
    throw new TypeError("agent session v2 event input is invalid");
  }
  if (typeof source.seq !== "number" || !Number.isSafeInteger(source.seq) || source.seq < 0) {
    throw new TypeError("agent session v2 event sequence is invalid");
  }
  if (!isCanonicalRfc3339(source.occurredAt)) {
    throw new TypeError("agent session v2 event time is invalid");
  }
  assertSafePublicControlIdV1(source.eventId, "event identifier");
  assertSafePublicControlIdV1(source.sessionId, "session identifier");
  if (source.runId !== undefined) assertSafePublicControlIdV1(source.runId, "run identifier");
  if (source.candidateId !== undefined) assertSafePublicControlIdV1(source.candidateId, "candidate identifier");
  if ((source.type === "model/attempt-started" || source.type === "model/audit")
    && (source.runId === undefined || source.candidateId === undefined)) {
    throw new TypeError("model attempt events require run and candidate bindings");
  }
  if (source.seq === 0) {
    if (source.previousDigest !== undefined) throw new TypeError("first event must not have a previous digest");
  } else if (!digest(source.previousDigest)) {
    throw new TypeError("non-initial event must have a previous digest");
  }
  const payload = assertAgentSessionProtectedPayloadV2(source.type as T, source.payload);
  const binding = effectBinding(payload);
  if (binding !== undefined
    && (binding.sessionId !== source.sessionId
      || binding.runId !== source.runId
      || binding.candidateId !== source.candidateId)) {
    throw new TypeError("tool effect commitment does not match the durable v2 envelope");
  }
  const envelope = {
    schemaVersion: 2 as const,
    eventId: source.eventId as EventId,
    sessionId: source.sessionId as SessionId,
    seq: source.seq,
    occurredAt: source.occurredAt,
    type: source.type as T,
    ...(source.runId === undefined ? {} : { runId: source.runId as RunId }),
    ...(source.candidateId === undefined ? {} : { candidateId: source.candidateId as CandidateId }),
    protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V2,
    protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1,
    payload,
    payloadDigest: payload.digest,
    ...(source.previousDigest === undefined ? {} : { previousDigest: source.previousDigest as Digest })
  };
  const event = { ...envelope, digest: digestJson(envelope) };
  if (!isAgentSessionEventV2(event)) throw new TypeError("created event does not match v2 schema");
  return deepFreeze(event) as AgentSessionEventV2<T>;
}

export function isAgentSessionEventV2(value: unknown): value is AgentSessionEventV2 {
  try {
    const source = exactDataRecord(value, [
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
    if (source === undefined || source.schemaVersion !== 2
      || typeof source.type !== "string" || !EVENT_TYPES_V2.has(source.type)
      || typeof source.seq !== "number" || !Number.isSafeInteger(source.seq) || source.seq < 0
      || !isCanonicalRfc3339(source.occurredAt)
      || source.protectionProfile !== AGENT_SESSION_PROTECTION_PROFILE_V2
      || source.protectionPolicyDigest !== PROTECTION_POLICY_DIGEST_V1
      || !digest(source.payloadDigest) || !digest(source.digest)
      || source.seq === 0 && source.previousDigest !== undefined
      || source.seq > 0 && !digest(source.previousDigest)) return false;
    assertSafePublicControlIdV1(source.eventId, "event identifier");
    assertSafePublicControlIdV1(source.sessionId, "session identifier");
    if (source.runId !== undefined) assertSafePublicControlIdV1(source.runId, "run identifier");
    if (source.candidateId !== undefined) assertSafePublicControlIdV1(source.candidateId, "candidate identifier");
    if ((source.type === "model/attempt-started" || source.type === "model/audit")
      && (source.runId === undefined || source.candidateId === undefined)) return false;
    const payload = inspectAgentSessionProtectedPayloadV2(
      source.type as AgentSessionEventTypeV2,
      source.payload
    );
    if (payload === undefined || payload.digest !== source.payloadDigest) return false;
    const binding = effectBinding(payload);
    if (binding !== undefined
      && (binding.sessionId !== source.sessionId
        || binding.runId !== source.runId
        || binding.candidateId !== source.candidateId)) return false;
    const { digest: _digest, ...envelope } = source;
    return digestJson(envelope) === source.digest;
  } catch {
    return false;
  }
}

export function verifyAgentSessionEventChainV2(events: readonly AgentSessionEventV2[]): void {
  let previous: AgentSessionEventV2 | undefined;
  for (const [index, event] of events.entries()) {
    if (!isAgentSessionEventV2(event)) throw new TypeError(`invalid v2 event schema at index ${index}`);
    if (event.seq !== index) throw new TypeError(`event seq ${event.seq} is not contiguous; expected ${index}`);
    if (previous !== undefined && previous.sessionId !== event.sessionId) {
      throw new TypeError("event chain crosses session ids");
    }
    if (event.previousDigest !== previous?.digest) {
      throw new TypeError(`event previous digest mismatch at seq ${event.seq}`);
    }
    previous = event;
  }
}
