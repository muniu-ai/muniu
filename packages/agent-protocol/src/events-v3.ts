// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import { digestJson } from "./canonical.js";
import { assertEffectCommitmentV1, type EffectCommitmentV1 } from "./effect-commitment.js";
import type { Digest, EventId, SessionId } from "./ids.js";
import { EventId as EventIdValue } from "./ids.js";
import type { JsonValue } from "./json.js";
import { deepFreeze } from "./freeze.js";
import type { AgentSessionEventV1 } from "./events.js";
import type { AgentSessionEventV2 } from "./events-v2.js";
import {
  isProtectedJsonViewV1,
  isProtectedTextV1,
  type ProtectedJsonViewV1,
  type ProtectedTextV1
} from "./protection.js";
import {
  assertSafePublicControlIdV1,
  createSafeDeterministicPublicControlIdV1,
  isSafePublicControlIdV1
} from "./public-control.js";
import { snapshotBoundedJsonValue } from "./strict-json.js";
import { isCanonicalRfc3339 } from "./events.js";

export const AGENT_EVENT_V3_TYPES = Object.freeze([
  "thread/created",
  "thread/updated",
  "thread/forked",
  "thread/archived",
  "thread/unarchived",
  "thread/tombstoned",
  "thread/goal-updated",
  "thread/goal-cleared",
  "turn/started",
  "turn/steered",
  "turn/progress",
  "turn/completed",
  "turn/interrupted",
  "turn/failed",
  "item/started",
  "item/delta",
  "item/completed",
  "item/recorded",
  "approval/requested",
  "approval/resolved",
  "context/compacted",
  "evidence/checkpoint"
] as const);

export type AgentEventV3Type = (typeof AGENT_EVENT_V3_TYPES)[number];

export interface AgentEventV3Source {
  readonly schemaVersion: 1 | 2;
  readonly sessionId: SessionId;
  readonly eventId: EventId;
  readonly payloadDigest: Digest;
  readonly eventDigest: Digest;
}

export interface AgentEventV3 {
  readonly schemaVersion: 3;
  readonly eventId: EventId;
  readonly threadId: SessionId;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: AgentEventV3Type;
  readonly causationId?: string;
  readonly correlationId: string;
  readonly publicControls: Readonly<Record<string, JsonValue>>;
  readonly protectedContent: ProtectedJsonViewV1;
  readonly effectCommitment?: EffectCommitmentV1;
  readonly previousSummary?: ProtectedTextV1;
  readonly currentSummary?: ProtectedTextV1;
  readonly source?: AgentEventV3Source;
  readonly previousDigest?: Digest;
  readonly digest: Digest;
}

export type NewAgentEventV3 = Omit<AgentEventV3, "schemaVersion" | "digest">;

const EVENT_TYPES = new Set<string>(AGENT_EVENT_V3_TYPES);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const FORBIDDEN_REASONING_KEYS = new Set([
  "chainOfThought",
  "hiddenReasoning",
  "rawReasoning"
]);

function exactRecord(
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

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function snapshotPublicControls(value: unknown): Readonly<Record<string, JsonValue>> {
  const snapshot = snapshotBoundedJsonValue(value);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("V3 public controls must be a JSON object");
  }
  const pending: JsonValue[] = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        if (FORBIDDEN_REASONING_KEYS.has(key)) {
          throw new TypeError("raw hidden reasoning must not be persisted in V3 public controls");
        }
        pending.push(child);
      }
    }
  }
  return deepFreeze(snapshot);
}

function snapshotProtectedContent(value: unknown): ProtectedJsonViewV1 {
  const snapshot = snapshotBoundedJsonValue(value);
  if (!isProtectedJsonViewV1(snapshot)) throw new TypeError("V3 protected content is invalid");
  return deepFreeze(snapshot);
}

function snapshotProtectedSummary(value: unknown, label: string): ProtectedTextV1 {
  const snapshot = snapshotBoundedJsonValue(value);
  if (!isProtectedTextV1(snapshot)) throw new TypeError(`${label} is invalid`);
  return deepFreeze(snapshot);
}

function snapshotSource(value: unknown, threadId: SessionId): AgentEventV3Source {
  const source = exactRecord(value, [
    "schemaVersion", "sessionId", "eventId", "payloadDigest", "eventDigest"
  ]);
  if (source === undefined || source.schemaVersion !== 1 && source.schemaVersion !== 2
    || source.sessionId !== threadId
    || !isSafePublicControlIdV1(source.sessionId)
    || !isSafePublicControlIdV1(source.eventId)
    || !isDigest(source.payloadDigest)
    || !isDigest(source.eventDigest)) {
    throw new TypeError("V3 source evidence is invalid");
  }
  return deepFreeze({
    schemaVersion: source.schemaVersion,
    sessionId: source.sessionId as SessionId,
    eventId: source.eventId as EventId,
    payloadDigest: source.payloadDigest,
    eventDigest: source.eventDigest
  });
}

export function createAgentEventV3(input: NewAgentEventV3): AgentEventV3 {
  const source = exactRecord(input, [
    "eventId",
    "threadId",
    "sequence",
    "occurredAt",
    "type",
    "correlationId",
    "publicControls",
    "protectedContent"
  ], [
    "turnId",
    "itemId",
    "causationId",
    "effectCommitment",
    "previousSummary",
    "currentSummary",
    "source",
    "previousDigest"
  ]);
  if (source === undefined || typeof source.type !== "string" || !EVENT_TYPES.has(source.type)) {
    throw new TypeError("V3 event input is invalid");
  }
  assertSafePublicControlIdV1(source.eventId, "V3 event identifier");
  assertSafePublicControlIdV1(source.threadId, "V3 thread identifier");
  assertSafePublicControlIdV1(source.correlationId, "V3 correlation identifier");
  if (source.turnId !== undefined) assertSafePublicControlIdV1(source.turnId, "V3 turn identifier");
  if (source.itemId !== undefined) assertSafePublicControlIdV1(source.itemId, "V3 item identifier");
  if (source.causationId !== undefined) assertSafePublicControlIdV1(source.causationId, "V3 causation identifier");
  if (typeof source.sequence !== "number" || !Number.isSafeInteger(source.sequence) || source.sequence < 0) {
    throw new TypeError("V3 event sequence is invalid");
  }
  if (!isCanonicalRfc3339(source.occurredAt)) throw new TypeError("V3 event time is invalid");
  if (source.sequence === 0) {
    if (source.previousDigest !== undefined) throw new TypeError("first V3 event must not have a previous digest");
  } else if (!isDigest(source.previousDigest)) {
    throw new TypeError("non-initial V3 event must have a previous digest");
  }
  const threadId = source.threadId as SessionId;
  const publicControls = snapshotPublicControls(source.publicControls);
  const protectedContent = snapshotProtectedContent(source.protectedContent);
  let effectCommitment: EffectCommitmentV1 | undefined;
  if (source.effectCommitment !== undefined) {
    const snapshot = snapshotBoundedJsonValue(source.effectCommitment);
    assertEffectCommitmentV1(snapshot);
    if (snapshot.sessionId !== threadId) {
      throw new TypeError("V3 effect commitment does not match the thread identifier");
    }
    effectCommitment = snapshot;
  }
  const envelope = {
    schemaVersion: 3 as const,
    eventId: source.eventId as EventId,
    threadId,
    ...(source.turnId === undefined ? {} : { turnId: source.turnId }),
    ...(source.itemId === undefined ? {} : { itemId: source.itemId }),
    sequence: source.sequence,
    occurredAt: source.occurredAt,
    type: source.type as AgentEventV3Type,
    ...(source.causationId === undefined ? {} : { causationId: source.causationId }),
    correlationId: source.correlationId,
    publicControls,
    protectedContent,
    ...(effectCommitment === undefined ? {} : { effectCommitment }),
    ...(source.previousSummary === undefined
      ? {}
      : { previousSummary: snapshotProtectedSummary(source.previousSummary, "V3 previous summary") }),
    ...(source.currentSummary === undefined
      ? {}
      : { currentSummary: snapshotProtectedSummary(source.currentSummary, "V3 current summary") }),
    ...(source.source === undefined ? {} : { source: snapshotSource(source.source, threadId) }),
    ...(source.previousDigest === undefined ? {} : { previousDigest: source.previousDigest as Digest })
  };
  return deepFreeze({ ...envelope, digest: digestJson(envelope) });
}

export function isAgentEventV3(value: unknown): value is AgentEventV3 {
  try {
    const source = exactRecord(value, [
      "schemaVersion",
      "eventId",
      "threadId",
      "sequence",
      "occurredAt",
      "type",
      "correlationId",
      "publicControls",
      "protectedContent",
      "digest"
    ], [
      "turnId",
      "itemId",
      "causationId",
      "effectCommitment",
      "previousSummary",
      "currentSummary",
      "source",
      "previousDigest"
    ]);
    if (source === undefined || source.schemaVersion !== 3 || !isDigest(source.digest)) return false;
    const { schemaVersion: _schemaVersion, digest, ...input } = source;
    const created = createAgentEventV3(input as NewAgentEventV3);
    return created.digest === digest;
  } catch {
    return false;
  }
}

export function verifyAgentEventV3Chain(events: readonly unknown[]): void {
  let previous: AgentEventV3 | undefined;
  const eventIds = new Set<string>();
  for (const [index, candidate] of events.entries()) {
    if (!isAgentEventV3(candidate)) throw new TypeError(`invalid V3 event schema at index ${index}`);
    if (candidate.sequence !== index) {
      throw new TypeError(`V3 event sequence ${candidate.sequence} is not contiguous; expected ${index}`);
    }
    if (previous !== undefined && candidate.threadId !== previous.threadId) {
      throw new TypeError("V3 event chain crosses thread identifiers");
    }
    if (candidate.previousDigest !== previous?.digest) {
      throw new TypeError(`V3 event previous digest mismatch at sequence ${candidate.sequence}`);
    }
    if (eventIds.has(candidate.eventId)) throw new TypeError("V3 event identifier is duplicated");
    eventIds.add(candidate.eventId);
    previous = candidate;
  }
}

type LegacyEvent = AgentSessionEventV1 | AgentSessionEventV2;

function legacyControls(event: LegacyEvent): Record<string, JsonValue> {
  return snapshotPublicControls(event.payload.publicControls) as Record<string, JsonValue>;
}

function legacyTurn(controls: Record<string, JsonValue>): number | undefined {
  if (typeof controls.turn === "number" && Number.isSafeInteger(controls.turn) && controls.turn > 0) {
    return controls.turn;
  }
  const binding = controls.binding;
  if (binding !== null && typeof binding === "object" && !Array.isArray(binding)) {
    const commitment = binding.commitment;
    if (commitment !== null && typeof commitment === "object" && !Array.isArray(commitment)
      && typeof commitment.turn === "number" && Number.isSafeInteger(commitment.turn)
      && commitment.turn > 0) return commitment.turn;
  }
  return undefined;
}

function migratedEventType(event: LegacyEvent): AgentEventV3Type {
  if (event.type === "session/created") return "thread/created";
  if (event.type === "turn/start") return "turn/started";
  if (event.type === "turn/end") {
    const reason = event.payload.publicControls.reason;
    if (reason === "completed") return "turn/completed";
    if (reason === "interrupted" || reason === "cancelled" || reason === "budget-exceeded") {
      return "turn/interrupted";
    }
    return "turn/failed";
  }
  if (event.type === "step/start" || event.type === "step/end") return "turn/progress";
  if (event.type === "approval/requested") return "approval/requested";
  if (event.type === "approval/resolved") return "approval/resolved";
  return "item/recorded";
}

function migratedItemKind(event: LegacyEvent): string | undefined {
  switch (event.type) {
    case "user/message": return "userMessage";
    case "assistant/message": return "agentMessage";
    case "model/attempt-started":
    case "model/audit": return "reasoning";
    case "tool/call":
    case "tool/result": return "dynamicToolCall";
    case "approval/requested":
    case "approval/resolved": return "approval";
    case "attachment/stored": return "attachment";
    default: return undefined;
  }
}

function legacyItemMaterial(event: LegacyEvent, controls: Record<string, JsonValue>): string {
  if (event.type === "tool/call" && typeof controls.callId === "string") return controls.callId;
  if (event.type === "tool/result") {
    const message = controls.message;
    if (message !== null && typeof message === "object" && !Array.isArray(message)) {
      const messageSource = message.source;
      if (messageSource !== null && typeof messageSource === "object" && !Array.isArray(messageSource)
        && typeof messageSource.callId === "string") return messageSource.callId;
    }
  }
  if (event.type === "approval/requested" || event.type === "approval/resolved") {
    const binding = controls.binding;
    if (binding !== null && typeof binding === "object" && !Array.isArray(binding)
      && typeof binding.approvalId === "string") return binding.approvalId;
  }
  if (event.type === "attachment/stored") {
    const descriptor = controls.descriptor;
    if (descriptor !== null && typeof descriptor === "object" && !Array.isArray(descriptor)
      && typeof descriptor.attachmentId === "string") return descriptor.attachmentId;
  }
  if (event.type === "model/audit" && typeof controls.startedEventId === "string") {
    return controls.startedEventId;
  }
  const message = controls.message;
  if (message !== null && typeof message === "object" && !Array.isArray(message)
    && typeof message.id === "string") return message.id;
  return event.eventId;
}

function legacyEffectCommitment(event: LegacyEvent): EffectCommitmentV1 | undefined {
  if (event.type === "tool/call") return event.payload.publicControls.binding;
  if (event.type === "approval/requested" || event.type === "approval/resolved") {
    return event.payload.publicControls.binding.commitment;
  }
  return undefined;
}

function migratedControls(
  event: LegacyEvent,
  controls: Record<string, JsonValue>,
  itemKind: string | undefined
): Record<string, JsonValue> {
  if (event.type === "session/created") {
    const binding = event.payload.publicControls.modelBinding;
    return {
      legacyType: event.type,
      source: "unknown",
      providerId: binding?.providerId ?? "unbound",
      modelId: binding?.modelId ?? "unbound",
      permissionProfile: "migrated-v0.1",
      sandbox: { mode: "legacy-import" },
      associations: {
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        ...(event.candidateId === undefined ? {} : { candidateId: event.candidateId })
      },
      legacyPublicControls: controls
    };
  }
  if (event.type === "turn/start") {
    return { legacyType: event.type, ordinal: controls.turn as JsonValue };
  }
  if (event.type === "turn/end") {
    return {
      legacyType: event.type,
      status: event.payload.publicControls.reason,
      legacyPublicControls: controls
    };
  }
  return {
    legacyType: event.type,
    ...(itemKind === undefined ? {} : { itemKind }),
    status: event.type === "approval/requested" ? "pending" : "completed",
    legacyPublicControls: controls
  };
}

export function migrateAgentSessionEventToV3(
  event: LegacyEvent,
  previous?: AgentEventV3
): AgentEventV3 {
  if (event.seq !== (previous?.sequence ?? -1) + 1
    || previous !== undefined && previous.threadId !== event.sessionId) {
    throw new TypeError("legacy event does not continue the V3 migration chain");
  }
  const controls = legacyControls(event);
  const turn = legacyTurn(controls);
  const itemKind = migratedItemKind(event);
  const eventType = migratedEventType(event);
  const hasItem = itemKind !== undefined;
  return createAgentEventV3({
    eventId: EventIdValue(createSafeDeterministicPublicControlIdV1("eventv", event.digest)),
    threadId: event.sessionId,
    ...(turn === undefined
      ? {}
      : { turnId: createSafeDeterministicPublicControlIdV1("turn", `${event.sessionId}:${turn}`) }),
    ...(hasItem
      ? { itemId: createSafeDeterministicPublicControlIdV1("item", legacyItemMaterial(event, controls)) }
      : {}),
    sequence: event.seq,
    occurredAt: event.occurredAt,
    type: eventType,
    ...(previous === undefined ? {} : { causationId: previous.eventId }),
    correlationId: event.sessionId,
    publicControls: migratedControls(event, controls, itemKind),
    protectedContent: event.payload.protectedContent,
    ...(legacyEffectCommitment(event) === undefined
      ? {}
      : { effectCommitment: legacyEffectCommitment(event) as EffectCommitmentV1 }),
    source: {
      schemaVersion: event.schemaVersion,
      sessionId: event.sessionId,
      eventId: event.eventId,
      payloadDigest: event.payloadDigest,
      eventDigest: event.digest
    },
    ...(previous === undefined ? {} : { previousDigest: previous.digest })
  });
}
