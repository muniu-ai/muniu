// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import { digestJson } from "./canonical.js";
import { deepFreeze } from "./freeze.js";
import type { Digest } from "./ids.js";
import type {
  AgentAttachmentDescriptorV1,
  ImageBlock,
  UserMessage
} from "./model.js";
import {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  inspectAgentSessionProtectedPayloadV1,
  protectAgentSessionPayloadV1,
  type AgentSessionProtectedEventTypeV1,
  type AgentSessionPublicControlsMapV1,
  type AgentSessionRawPayloadMapV1
} from "./session-payload.js";
import {
  PROTECTION_POLICY_DIGEST_V1,
  createProtectedJsonViewV1,
  isProtectedJsonViewV1,
  type ProtectedJsonViewV1
} from "./protection.js";
import { assertSafePublicControlIdV1 } from "./public-control.js";
import { snapshotBoundedJsonValue } from "./strict-json.js";

export const AGENT_SESSION_PROTECTION_PROFILE_V2 = "muniu-agent-session-protected-payload-v2";

export type AgentSessionRawPayloadMapV2 = {
  [K in AgentSessionProtectedEventTypeV1]: K extends "user/message"
    ? { readonly turn: number; readonly message: UserMessage }
    : AgentSessionRawPayloadMapV1[K]
} & {
  readonly "attachment/stored": { readonly descriptor: AgentAttachmentDescriptorV1 };
};

export type AgentSessionProtectedEventTypeV2 = keyof AgentSessionRawPayloadMapV2;

export type ProtectedUserBlockControlV2 =
  | { readonly type: "text" }
  | { readonly type: "thinking" }
  | ImageBlock;

export type AgentSessionPublicControlsMapV2 = {
  [K in AgentSessionProtectedEventTypeV1]: K extends "user/message"
    ? {
      readonly turn: number;
      readonly message: {
        readonly id: string;
        readonly role: "user";
        readonly source: { readonly kind: "user" };
        readonly content: readonly ProtectedUserBlockControlV2[];
      };
    }
    : AgentSessionPublicControlsMapV1[K]
} & {
  readonly "attachment/stored": { readonly descriptor: AgentAttachmentDescriptorV1 };
};

declare const protectedPayloadV2Brand: unique symbol;

export interface AgentSessionProtectedPayloadV2<
  T extends AgentSessionProtectedEventTypeV2 = AgentSessionProtectedEventTypeV2
> {
  readonly schemaVersion: 2;
  readonly kind: "agent-session-protected-payload";
  readonly eventType: T;
  readonly protectionProfile: typeof AGENT_SESSION_PROTECTION_PROFILE_V2;
  readonly protectionPolicyDigest: Digest;
  readonly publicControls: AgentSessionPublicControlsMapV2[T];
  readonly protectedContent: ProtectedJsonViewV1;
  readonly digest: Digest;
  readonly [protectedPayloadV2Brand]: T;
}

const EVENT_TYPES_V2 = new Set<string>([
  "session/created",
  "turn/start",
  "user/message",
  "step/start",
  "assistant/message",
  "model/attempt-started",
  "model/audit",
  "tool/call",
  "approval/requested",
  "approval/resolved",
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

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function inspectAgentAttachmentDescriptorV1(
  value: unknown
): AgentAttachmentDescriptorV1 | undefined {
  try {
    const source = exactDataRecord(value, [
      "schemaVersion",
      "kind",
      "attachmentId",
      "sessionId",
      "sha256",
      "byteLength",
      "contentType",
      "width",
      "height"
    ], ["tenantBinding"]);
    if (source === undefined || source.schemaVersion !== 1
      || source.kind !== "agent-attachment-descriptor") return undefined;
    assertSafePublicControlIdV1(source.attachmentId, "attachment identifier");
    assertSafePublicControlIdV1(source.sessionId, "attachment session identifier");
    if (typeof source.sha256 !== "string" || !DIGEST_PATTERN.test(source.sha256)
      || !positiveInteger(source.byteLength)
      || !positiveInteger(source.width)
      || !positiveInteger(source.height)
      || source.contentType !== "image/png"
        && source.contentType !== "image/jpeg"
        && source.contentType !== "image/webp"
      || source.tenantBinding !== undefined
        && (typeof source.tenantBinding !== "string" || !DIGEST_PATTERN.test(source.tenantBinding))) {
      return undefined;
    }
    return deepFreeze(snapshotBoundedJsonValue(source) as unknown as AgentAttachmentDescriptorV1);
  } catch {
    return undefined;
  }
}

function inspectImageBlock(value: unknown): ImageBlock | undefined {
  const source = exactDataRecord(value, [
    "type", "attachmentId", "contentType", "sha256", "byteLength", "width", "height"
  ]);
  if (source === undefined || source.type !== "image") return undefined;
  const descriptor = inspectAgentAttachmentDescriptorV1({
    schemaVersion: 1,
    kind: "agent-attachment-descriptor",
    attachmentId: source.attachmentId,
    sessionId: "descriptor-validation",
    sha256: source.sha256,
    byteLength: source.byteLength,
    contentType: source.contentType,
    width: source.width,
    height: source.height
  });
  if (descriptor === undefined) return undefined;
  const { schemaVersion: _schemaVersion, kind: _kind, sessionId: _sessionId, ...block } = descriptor;
  return deepFreeze({ type: "image", ...block });
}

function inspectUserRaw(value: unknown): AgentSessionRawPayloadMapV2["user/message"] | undefined {
  try {
    const source = exactDataRecord(value, ["turn", "message"]);
    const message = exactDataRecord(source?.message, ["id", "role", "content", "source"]);
    const messageSource = exactDataRecord(message?.source, ["kind"]);
    if (source === undefined || !positiveInteger(source.turn)
      || message === undefined || message.role !== "user"
      || messageSource === undefined || messageSource.kind !== "user"
      || !Array.isArray(message.content)) return undefined;
    assertSafePublicControlIdV1(message.id, "message identifier");
    for (const block of message.content) {
      const text = exactDataRecord(block, ["type", "text"]);
      if (text !== undefined && (text.type === "text" || text.type === "thinking")
        && typeof text.text === "string") continue;
      if (inspectImageBlock(block) === undefined) return undefined;
    }
    return deepFreeze(snapshotBoundedJsonValue(source) as unknown as AgentSessionRawPayloadMapV2["user/message"]);
  } catch {
    return undefined;
  }
}

function createEnvelope<T extends AgentSessionProtectedEventTypeV2>(
  eventType: T,
  publicControls: AgentSessionPublicControlsMapV2[T],
  protectedContent: ProtectedJsonViewV1
): AgentSessionProtectedPayloadV2<T> {
  const envelope = {
    schemaVersion: 2 as const,
    kind: "agent-session-protected-payload" as const,
    eventType,
    protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V2,
    protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1,
    publicControls,
    protectedContent
  };
  return deepFreeze({ ...envelope, digest: digestJson(envelope) }) as AgentSessionProtectedPayloadV2<T>;
}

export function protectAgentSessionPayloadV2<T extends AgentSessionProtectedEventTypeV2>(
  eventType: T,
  raw: AgentSessionRawPayloadMapV2[T]
): AgentSessionProtectedPayloadV2<T> {
  if (!EVENT_TYPES_V2.has(eventType)) throw new TypeError("agent session v2 event type is invalid");
  if (eventType === "user/message") {
    const payload = inspectUserRaw(raw);
    if (payload === undefined) throw new TypeError("agent session v2 user message is invalid");
    const controls: AgentSessionPublicControlsMapV2["user/message"] = {
      turn: payload.turn,
      message: {
        id: payload.message.id,
        role: "user",
        source: { kind: "user" },
        content: payload.message.content.map((block): ProtectedUserBlockControlV2 => block.type === "image"
          ? inspectImageBlock(block) as ImageBlock
          : { type: block.type as "text" | "thinking" })
      }
    };
    const protectedContent = createProtectedJsonViewV1({
      blocks: payload.message.content.flatMap((block) => block.type === "text" || block.type === "thinking"
        ? [block.text]
        : [])
    });
    return createEnvelope(eventType, controls as AgentSessionPublicControlsMapV2[T], protectedContent);
  }
  if (eventType === "attachment/stored") {
    const source = exactDataRecord(raw, ["descriptor"]);
    const descriptor = inspectAgentAttachmentDescriptorV1(source?.descriptor);
    if (descriptor === undefined) throw new TypeError("agent attachment event descriptor is invalid");
    return createEnvelope(
      eventType,
      { descriptor } as AgentSessionPublicControlsMapV2[T],
      createProtectedJsonViewV1(null)
    );
  }
  const v1 = protectAgentSessionPayloadV1(
    eventType as AgentSessionProtectedEventTypeV1,
    raw as AgentSessionRawPayloadMapV1[AgentSessionProtectedEventTypeV1]
  );
  return createEnvelope(
    eventType,
    v1.publicControls as AgentSessionPublicControlsMapV2[T],
    v1.protectedContent
  );
}

function isProtectedTextBlockArray(value: ProtectedJsonViewV1, expected: number): boolean {
  const root = value.root;
  if (root.type !== "object" || root.entries.length !== 1 || root.entries[0]?.key.text !== "blocks") return false;
  const blocks = root.entries[0].value;
  return blocks.type === "array" && blocks.items.length === expected
    && blocks.items.every((item) => item.type === "string");
}

export function inspectAgentSessionProtectedPayloadV2<T extends AgentSessionProtectedEventTypeV2>(
  eventType: T,
  value: unknown
): AgentSessionProtectedPayloadV2<T> | undefined {
  try {
    if (!EVENT_TYPES_V2.has(eventType)) return undefined;
    const source = exactDataRecord(value, [
      "schemaVersion",
      "kind",
      "eventType",
      "protectionProfile",
      "protectionPolicyDigest",
      "publicControls",
      "protectedContent",
      "digest"
    ]);
    if (source === undefined || source.schemaVersion !== 2
      || source.kind !== "agent-session-protected-payload"
      || source.eventType !== eventType
      || source.protectionProfile !== AGENT_SESSION_PROTECTION_PROFILE_V2
      || source.protectionPolicyDigest !== PROTECTION_POLICY_DIGEST_V1
      || typeof source.digest !== "string" || !DIGEST_PATTERN.test(source.digest)
      || !isProtectedJsonViewV1(source.protectedContent)) return undefined;
    let controls: AgentSessionPublicControlsMapV2[T];
    if (eventType === "user/message") {
      const publicSource = exactDataRecord(source.publicControls, ["turn", "message"]);
      const message = exactDataRecord(publicSource?.message, ["id", "role", "source", "content"]);
      const messageSource = exactDataRecord(message?.source, ["kind"]);
      if (publicSource === undefined || !positiveInteger(publicSource.turn)
        || message === undefined || message.role !== "user"
        || messageSource === undefined || messageSource.kind !== "user"
        || !Array.isArray(message.content)) return undefined;
      assertSafePublicControlIdV1(message.id, "message identifier");
      let protectedCount = 0;
      for (const block of message.content) {
        const text = exactDataRecord(block, ["type"]);
        if (text !== undefined && (text.type === "text" || text.type === "thinking")) {
          protectedCount += 1;
          continue;
        }
        if (inspectImageBlock(block) === undefined) return undefined;
      }
      if (!isProtectedTextBlockArray(source.protectedContent, protectedCount)) return undefined;
      controls = snapshotBoundedJsonValue(source.publicControls) as unknown as AgentSessionPublicControlsMapV2[T];
    } else if (eventType === "attachment/stored") {
      const publicSource = exactDataRecord(source.publicControls, ["descriptor"]);
      if (publicSource === undefined
        || inspectAgentAttachmentDescriptorV1(publicSource.descriptor) === undefined
        || source.protectedContent.root.type !== "null") return undefined;
      controls = snapshotBoundedJsonValue(source.publicControls) as unknown as AgentSessionPublicControlsMapV2[T];
    } else {
      const v1Envelope = {
        schemaVersion: 1 as const,
        kind: "agent-session-protected-payload" as const,
        eventType,
        protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V1,
        protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1,
        publicControls: source.publicControls,
        protectedContent: source.protectedContent
      };
      const v1 = inspectAgentSessionProtectedPayloadV1(
        eventType as AgentSessionProtectedEventTypeV1,
        { ...v1Envelope, digest: digestJson(v1Envelope) }
      );
      if (v1 === undefined) return undefined;
      controls = v1.publicControls as AgentSessionPublicControlsMapV2[T];
    }
    const envelope = {
      schemaVersion: 2 as const,
      kind: "agent-session-protected-payload" as const,
      eventType,
      protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V2,
      protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1,
      publicControls: controls,
      protectedContent: source.protectedContent
    };
    if (digestJson(envelope) !== source.digest) return undefined;
    return deepFreeze({ ...envelope, digest: source.digest }) as AgentSessionProtectedPayloadV2<T>;
  } catch {
    return undefined;
  }
}

export function assertAgentSessionProtectedPayloadV2<T extends AgentSessionProtectedEventTypeV2>(
  eventType: T,
  value: unknown
): AgentSessionProtectedPayloadV2<T> {
  const inspected = inspectAgentSessionProtectedPayloadV2(eventType, value);
  if (inspected === undefined) {
    throw new TypeError("value does not match the event-specific protected session payload v2 schema");
  }
  return inspected;
}
