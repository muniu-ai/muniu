// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import { digestJson } from "./canonical.js";
import {
  assertEffectCommitmentV1,
  deriveToolEffectKindV1,
  type EffectCommitmentV1
} from "./effect-commitment.js";
import { deepFreeze } from "./freeze.js";
import type { CallId, Digest, EventId, MessageId } from "./ids.js";
import type {
  AssistantMessage,
  ToolResultMessage,
  TokenUsage,
  UserMessage
} from "./model.js";
import {
  PROTECTION_POLICY_DIGEST_V1,
  createProtectedTextV1,
  createProtectedJsonViewV1,
  isProtectedJsonViewV1,
  type ProtectedJsonNodeV1,
  type ProtectedJsonViewV1
} from "./protection.js";
import {
  assertSafePublicControlIdV1,
  assertSafePublicControlStringV1
} from "./public-control.js";
import { snapshotBoundedJsonValue } from "./strict-json.js";

export const AGENT_SESSION_PROTECTION_PROFILE_V1 = "muniu-agent-session-protected-payload-v1";
export const UNBOUND_PROTECTED_TOOL_CALL_V1 = "unbound-protected-v1";

export interface AgentToolApprovalBindingV1 {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly scope: string;
  readonly risk: "read-only" | "side-effecting";
  readonly callId: CallId;
  readonly name: string;
  readonly commitment: EffectCommitmentV1;
}

export type AgentApprovalResolutionV1 = "decided" | "cancelled" | "closed" | "interrupted";
export type AgentApprovalDecisionV1 = "approve_once" | "approve_session_scope" | "deny";

export interface AgentSessionRawPayloadMapV1 {
  "session/created": { cwd?: string; labels?: Record<string, string> };
  "turn/start": { turn: number };
  "user/message": { turn: number; message: UserMessage };
  "step/start": { turn: number; step: number };
  "assistant/message": { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage };
  "tool/call": {
    turn: number;
    step: number;
    callId: CallId;
    name: string;
    arguments: string;
    commitment: EffectCommitmentV1;
  };
  "approval/requested": { binding: AgentToolApprovalBindingV1 };
  "approval/resolved": {
    binding: AgentToolApprovalBindingV1;
    requestEventId: EventId;
    requestDigest: Digest;
    decision: AgentApprovalDecisionV1;
    resolution: AgentApprovalResolutionV1;
  };
  "tool/result": {
    turn: number;
    step: number;
    message: ToolResultMessage;
    status: "completed" | "interrupted";
    error?: { name: string; code: string };
  };
  "step/end": {
    turn: number;
    step: number;
    status: "completed" | "cancelled" | "budget-exceeded" | "interrupted" | "error";
  };
  "turn/end": {
    turn: number;
    reason: "completed" | "cancelled" | "budget-exceeded" | "interrupted" | "error";
    error?: { code: string; message: string };
  };
}

export type AgentSessionProtectedEventTypeV1 = keyof AgentSessionRawPayloadMapV1;

export type ProtectedMessageBlockControlV1 =
  | { readonly type: "text" }
  | { readonly type: "thinking" }
  | {
    readonly type: "tool-call";
    readonly id: CallId;
    readonly name: string;
    readonly binding: typeof UNBOUND_PROTECTED_TOOL_CALL_V1;
  };

export interface AgentSessionPublicControlsMapV1 {
  "session/created": Record<string, never>;
  "turn/start": { readonly turn: number };
  "user/message": {
    readonly turn: number;
    readonly message: {
      readonly id: MessageId;
      readonly role: "user";
      readonly source: { readonly kind: "user" };
      readonly content: readonly ({ readonly type: "text" } | { readonly type: "thinking" })[];
    };
  };
  "step/start": { readonly turn: number; readonly step: number };
  "assistant/message": {
    readonly turn: number;
    readonly step: number;
    readonly message: {
      readonly id: MessageId;
      readonly role: "assistant";
      readonly source: {
        readonly kind: "model";
        readonly provider: string;
        readonly model: string;
      };
      readonly content: readonly ProtectedMessageBlockControlV1[];
    };
    readonly usage?: TokenUsage;
  };
  "tool/call": {
    readonly turn: number;
    readonly step: number;
    readonly callId: CallId;
    readonly name: string;
    readonly binding: EffectCommitmentV1;
  };
  "approval/requested": { readonly binding: AgentToolApprovalBindingV1 };
  "approval/resolved": {
    readonly binding: AgentToolApprovalBindingV1;
    readonly requestEventId: EventId;
    readonly requestDigest: Digest;
    readonly decision: AgentApprovalDecisionV1;
    readonly resolution: AgentApprovalResolutionV1;
  };
  "tool/result": {
    readonly turn: number;
    readonly step: number;
    readonly message: {
      readonly id: MessageId;
      readonly role: "user";
      readonly source: { readonly kind: "tool"; readonly callId: CallId };
      readonly content: readonly [{
        readonly type: "tool-result";
        readonly toolCallId: CallId;
        readonly content: readonly ({ readonly type: "text" } | { readonly type: "thinking" })[];
        readonly isError?: boolean;
      }];
    };
    readonly status: "completed" | "interrupted";
    readonly error?: { readonly name: string; readonly code: string };
  };
  "step/end": {
    readonly turn: number;
    readonly step: number;
    readonly status: "completed" | "cancelled" | "budget-exceeded" | "interrupted" | "error";
  };
  "turn/end": {
    readonly turn: number;
    readonly reason: "completed" | "cancelled" | "budget-exceeded" | "interrupted" | "error";
    readonly error?: { readonly code: string };
  };
}

declare const protectedPayloadBrand: unique symbol;

export interface AgentSessionProtectedPayloadV1<
  T extends AgentSessionProtectedEventTypeV1 = AgentSessionProtectedEventTypeV1
> {
  readonly schemaVersion: 1;
  readonly kind: "agent-session-protected-payload";
  readonly eventType: T;
  readonly protectionProfile: typeof AGENT_SESSION_PROTECTION_PROFILE_V1;
  readonly protectionPolicyDigest: Digest;
  readonly publicControls: AgentSessionPublicControlsMapV1[T];
  readonly protectedContent: ProtectedJsonViewV1;
  readonly digest: Digest;
  readonly [protectedPayloadBrand]: T;
}

const AGENT_SESSION_EVENT_TYPES_V1 = new Set<string>([
  "session/created",
  "turn/start",
  "user/message",
  "step/start",
  "assistant/message",
  "tool/call",
  "approval/requested",
  "approval/resolved",
  "tool/result",
  "step/end",
  "turn/end"
]);
const PUBLIC_CONTROL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const STEP_END_STATUSES = new Set(["completed", "cancelled", "budget-exceeded", "interrupted", "error"]);
const TURN_END_REASONS = new Set(["completed", "cancelled", "budget-exceeded", "interrupted", "error"]);
const APPROVAL_DECISIONS = new Set<AgentApprovalDecisionV1>([
  "approve_once",
  "approve_session_scope",
  "deny"
]);
const APPROVAL_RESOLUTIONS = new Set<AgentApprovalResolutionV1>([
  "decided",
  "cancelled",
  "closed",
  "interrupted"
]);

function exactDataRecord(value: unknown, exactKeys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== exactKeys.length || keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const key of exactKeys) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertSafeName(value: unknown, label: string): asserts value is string {
  assertSafePublicControlStringV1(value, label, PUBLIC_CONTROL_NAME_PATTERN, 256);
}

function isTextLikeBlock(value: unknown): value is { type: "text" | "thinking"; text: string } {
  return hasExactKeys(value, ["type", "text"])
    && (value.type === "text" || value.type === "thinking")
    && typeof value.text === "string";
}

function assertToolCallBlock(value: unknown): asserts value is {
  type: "tool-call";
  id: CallId;
  name: string;
  arguments: string;
} {
  if (!hasExactKeys(value, ["type", "id", "name", "arguments"]) || value.type !== "tool-call") {
    throw new TypeError("assistant tool-call block does not match the event-specific schema");
  }
  assertSafePublicControlIdV1(value.id, "tool call identifier");
  assertSafeName(value.name, "tool name");
  if (typeof value.arguments !== "string") {
    throw new TypeError("assistant tool-call arguments must be a string");
  }
}

function assertToolResultBlock(value: unknown): asserts value is {
  type: "tool-result";
  toolCallId: CallId;
  content: { type: "text" | "thinking"; text: string }[];
  isError?: boolean;
} {
  if (!hasExactKeys(value, ["type", "toolCallId", "content"], ["isError"])
    || value.type !== "tool-result") {
    throw new TypeError("tool-result block does not match the event-specific schema");
  }
  assertSafePublicControlIdV1(value.toolCallId, "tool result call identifier");
  if (!Array.isArray(value.content)
    || !value.content.every(isTextLikeBlock)
    || (value.isError !== undefined && typeof value.isError !== "boolean")) {
    throw new TypeError("tool-result block content does not match the event-specific schema");
  }
}

function assertMessage(value: unknown, expected: "user" | "assistant" | "tool-result"): void {
  if (!hasExactKeys(value, ["id", "role", "content", "source"]) || !Array.isArray(value.content)) {
    throw new TypeError("message does not match the event-specific schema");
  }
  assertSafePublicControlIdV1(value.id, "message identifier");
  const source = value.source;

  if (expected === "user") {
    if (value.role !== "user" || !hasExactKeys(source, ["kind"]) || source.kind !== "user"
      || !value.content.every(isTextLikeBlock)) {
      throw new TypeError("user message content or source does not match the event-specific schema");
    }
    return;
  }

  if (expected === "assistant") {
    if (value.role !== "assistant"
      || !hasExactKeys(source, ["kind", "provider", "model"])
      || source.kind !== "model") {
      throw new TypeError("assistant message source does not match the event-specific schema");
    }
    assertSafeName(source.provider, "model provider");
    assertSafeName(source.model, "model identifier");
    const callIds = new Set<string>();
    for (const block of value.content) {
      if (isTextLikeBlock(block)) continue;
      assertToolCallBlock(block);
      if (callIds.has(block.id)) throw new TypeError("assistant message contains a duplicate tool call identifier");
      callIds.add(block.id);
    }
    return;
  }

  if (value.role !== "user"
    || !hasExactKeys(source, ["kind", "callId"])
    || source.kind !== "tool"
    || value.content.length !== 1) {
    throw new TypeError("tool-result message source does not match the event-specific schema");
  }
  assertSafePublicControlIdV1(source.callId, "tool message call identifier");
  const block = value.content[0];
  assertToolResultBlock(block);
  if (block.toolCallId !== source.callId) {
    throw new TypeError("tool-result message call identifiers do not match");
  }
}

function isTokenUsage(value: unknown): value is TokenUsage {
  return hasExactKeys(
    value,
    ["inputTokens", "outputTokens"],
    ["cacheReadTokens", "cacheWriteTokens", "thinkingTokens"]
  ) && Object.values(value).every(isNonNegativeSafeInteger);
}

function isLabels(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((label) => typeof label === "string");
}

function assertApprovalBinding(value: unknown): asserts value is AgentToolApprovalBindingV1 {
  if (!hasExactKeys(
    value,
    ["schemaVersion", "approvalId", "scope", "risk", "callId", "name", "commitment"]
  ) || value.schemaVersion !== 1) {
    throw new TypeError("approval binding does not match the exact v1 schema");
  }
  assertSafePublicControlIdV1(value.approvalId, "approval identifier");
  assertSafePublicControlIdV1(value.callId, "approval call identifier");
  assertSafeName(value.name, "approval tool name");
  if (value.risk !== "read-only" && value.risk !== "side-effecting") {
    throw new TypeError("approval binding risk is invalid");
  }
  assertEffectCommitmentV1(value.commitment);
  if (value.commitment.rawKind !== "text"
    || value.commitment.internalEffectId !== value.callId
    || value.commitment.effectKind !== value.scope
    || value.commitment.effectKind !== deriveToolEffectKindV1(value.name)) {
    throw new TypeError("approval binding does not match its exact tool effect commitment");
  }
}

export function inspectAgentToolApprovalBindingV1(
  value: unknown
): AgentToolApprovalBindingV1 | undefined {
  try {
    const snapshot = snapshotBoundedJsonValue(value);
    assertApprovalBinding(snapshot);
    return deepFreeze(snapshot as unknown as AgentToolApprovalBindingV1);
  } catch {
    return undefined;
  }
}

export function assertAgentToolApprovalBindingV1(value: unknown): AgentToolApprovalBindingV1 {
  const inspected = inspectAgentToolApprovalBindingV1(value);
  if (inspected === undefined) {
    throw new TypeError("value does not match the exact tool approval binding v1 schema");
  }
  return inspected;
}

function assertApprovalResolution(
  decision: unknown,
  resolution: unknown
): asserts decision is AgentApprovalDecisionV1 {
  if (typeof decision !== "string" || !APPROVAL_DECISIONS.has(decision as AgentApprovalDecisionV1)
    || typeof resolution !== "string"
    || !APPROVAL_RESOLUTIONS.has(resolution as AgentApprovalResolutionV1)
    || (resolution !== "decided" && decision !== "deny")) {
    throw new TypeError("approval resolution must use the closed decision and resolution vocabulary");
  }
}

function assertRawPayload(eventType: AgentSessionProtectedEventTypeV1, value: unknown): void {
  if (!isRecord(value)) throw new TypeError(`event ${eventType} raw payload does not match the event-specific schema`);
  switch (eventType) {
    case "session/created":
      if (hasExactKeys(value, [], ["cwd", "labels"])
        && (value.cwd === undefined || typeof value.cwd === "string")
        && (value.labels === undefined || isLabels(value.labels))) return;
      break;
    case "turn/start":
      if (hasExactKeys(value, ["turn"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        return;
      }
      break;
    case "user/message":
      if (hasExactKeys(value, ["turn", "message"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        assertMessage(value.message, "user");
        return;
      }
      break;
    case "step/start":
      if (hasExactKeys(value, ["turn", "step"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        assertPositiveSafeInteger(value.step, "event step");
        return;
      }
      break;
    case "assistant/message":
      if (hasExactKeys(value, ["turn", "step", "message"], ["usage"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        assertPositiveSafeInteger(value.step, "event step");
        assertMessage(value.message, "assistant");
        if (value.usage === undefined || isTokenUsage(value.usage)) return;
      }
      break;
    case "tool/call":
      if (hasExactKeys(value, ["turn", "step", "callId", "name", "arguments", "commitment"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        assertPositiveSafeInteger(value.step, "event step");
        assertSafePublicControlIdV1(value.callId, "tool call identifier");
        assertSafeName(value.name, "tool name");
        assertEffectCommitmentV1(value.commitment);
        if (typeof value.arguments === "string") return;
      }
      break;
    case "approval/requested":
      if (hasExactKeys(value, ["binding"])) {
        assertApprovalBinding(value.binding);
        return;
      }
      break;
    case "approval/resolved":
      if (hasExactKeys(value, ["binding", "requestEventId", "requestDigest", "decision", "resolution"])) {
        assertApprovalBinding(value.binding);
        assertSafePublicControlIdV1(value.requestEventId, "approval request event identifier");
        if (typeof value.requestDigest !== "string" || !DIGEST_PATTERN.test(value.requestDigest)) {
          throw new TypeError("approval request digest must be a sha256 digest");
        }
        assertApprovalResolution(value.decision, value.resolution);
        return;
      }
      break;
    case "tool/result":
      if (hasExactKeys(value, ["turn", "step", "message", "status"], ["error"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        assertPositiveSafeInteger(value.step, "event step");
        assertMessage(value.message, "tool-result");
        const error = value.error;
        if (error !== undefined) {
          if (!hasExactKeys(error, ["name", "code"])) break;
          assertSafeName(error.name, "tool error name");
          assertSafeName(error.code, "tool error code");
        }
        if (value.status === "completed" || value.status === "interrupted") return;
      }
      break;
    case "step/end":
      if (hasExactKeys(value, ["turn", "step", "status"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        assertPositiveSafeInteger(value.step, "event step");
        if (typeof value.status === "string" && STEP_END_STATUSES.has(value.status)) return;
      }
      break;
    case "turn/end":
      if (hasExactKeys(value, ["turn", "reason"], ["error"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        const error = value.error;
        if (error !== undefined) {
          if (!hasExactKeys(error, ["code", "message"]) || typeof error.message !== "string") break;
          assertSafeName(error.code, "turn error code");
        }
        if (typeof value.reason === "string" && TURN_END_REASONS.has(value.reason)) return;
      }
      break;
  }
  throw new TypeError(`event ${eventType} raw payload does not match the event-specific schema`);
}

interface ProfileParts<T extends AgentSessionProtectedEventTypeV1> {
  readonly publicControls: AgentSessionPublicControlsMapV1[T];
  readonly protectedContentInput: unknown;
}

function buildProfileParts<T extends AgentSessionProtectedEventTypeV1>(
  eventType: T,
  raw: AgentSessionRawPayloadMapV1[T]
): ProfileParts<T> {
  let parts: ProfileParts<AgentSessionProtectedEventTypeV1>;
  switch (eventType) {
    case "session/created": {
      const payload = raw as AgentSessionRawPayloadMapV1["session/created"];
      parts = { publicControls: {}, protectedContentInput: payload };
      break;
    }
    case "turn/start": {
      const payload = raw as AgentSessionRawPayloadMapV1["turn/start"];
      parts = { publicControls: { turn: payload.turn }, protectedContentInput: null };
      break;
    }
    case "user/message": {
      const payload = raw as AgentSessionRawPayloadMapV1["user/message"];
      const blocks = payload.message.content as readonly { type: "text" | "thinking"; text: string }[];
      parts = {
        publicControls: {
          turn: payload.turn,
          message: {
            id: payload.message.id,
            role: "user",
            source: { kind: "user" },
            content: blocks.map((block) => ({ type: block.type }))
          }
        },
        protectedContentInput: { blocks: blocks.map((block) => block.text) }
      };
      break;
    }
    case "step/start": {
      const payload = raw as AgentSessionRawPayloadMapV1["step/start"];
      parts = {
        publicControls: { turn: payload.turn, step: payload.step },
        protectedContentInput: null
      };
      break;
    }
    case "assistant/message": {
      const payload = raw as AgentSessionRawPayloadMapV1["assistant/message"];
      const controls: ProtectedMessageBlockControlV1[] = [];
      const content: string[] = [];
      for (const block of payload.message.content) {
        if (block.type === "text" || block.type === "thinking") {
          controls.push({ type: block.type });
          content.push(block.text);
        } else {
          const toolCall = block as {
            readonly type: "tool-call";
            readonly id: CallId;
            readonly name: string;
            readonly arguments: string;
          };
          controls.push({
            type: "tool-call",
            id: toolCall.id,
            name: toolCall.name,
            binding: UNBOUND_PROTECTED_TOOL_CALL_V1
          });
          content.push(toolCall.arguments);
        }
      }
      parts = {
        publicControls: {
          turn: payload.turn,
          step: payload.step,
          message: {
            id: payload.message.id,
            role: "assistant",
            source: { ...payload.message.source },
            content: controls
          },
          ...(payload.usage === undefined ? {} : { usage: { ...payload.usage } })
        },
        protectedContentInput: { blocks: content }
      };
      break;
    }
    case "tool/call": {
      const payload = raw as AgentSessionRawPayloadMapV1["tool/call"];
      const protectedArguments = createProtectedTextV1(payload.arguments);
      if (payload.commitment.rawKind !== "text"
        || payload.commitment.turn !== payload.turn
        || payload.commitment.step !== payload.step
        || payload.commitment.internalEffectId !== payload.callId
        || payload.commitment.effectKind !== deriveToolEffectKindV1(payload.name)
        || payload.commitment.protectedInputDigest !== protectedArguments.digest
        || payload.commitment.protectionPolicyDigest !== protectedArguments.policyDigest) {
        throw new TypeError("tool call effect commitment does not match the protected invocation");
      }
      parts = {
        publicControls: {
          turn: payload.turn,
          step: payload.step,
          callId: payload.callId,
          name: payload.name,
          binding: payload.commitment
        },
        protectedContentInput: { protectedArguments: payload.arguments }
      };
      break;
    }
    case "approval/requested": {
      const payload = raw as AgentSessionRawPayloadMapV1["approval/requested"];
      parts = {
        publicControls: { binding: payload.binding },
        protectedContentInput: null
      };
      break;
    }
    case "approval/resolved": {
      const payload = raw as AgentSessionRawPayloadMapV1["approval/resolved"];
      parts = {
        publicControls: {
          binding: payload.binding,
          requestEventId: payload.requestEventId,
          requestDigest: payload.requestDigest,
          decision: payload.decision,
          resolution: payload.resolution
        },
        protectedContentInput: null
      };
      break;
    }
    case "tool/result": {
      const payload = raw as AgentSessionRawPayloadMapV1["tool/result"];
      const block = payload.message.content[0];
      parts = {
        publicControls: {
          turn: payload.turn,
          step: payload.step,
          message: {
            id: payload.message.id,
            role: "user",
            source: { ...payload.message.source },
            content: [{
              type: "tool-result",
              toolCallId: block.toolCallId,
              content: block.content.map((item) => ({ type: item.type })),
              ...(block.isError === undefined ? {} : { isError: block.isError })
            }]
          },
          status: payload.status,
          ...(payload.error === undefined ? {} : { error: { ...payload.error } })
        },
        protectedContentInput: { content: block.content.map((item) => item.text) }
      };
      break;
    }
    case "step/end": {
      const payload = raw as AgentSessionRawPayloadMapV1["step/end"];
      parts = { publicControls: { ...payload }, protectedContentInput: null };
      break;
    }
    case "turn/end": {
      const payload = raw as AgentSessionRawPayloadMapV1["turn/end"];
      parts = {
        publicControls: {
          turn: payload.turn,
          reason: payload.reason,
          ...(payload.error === undefined ? {} : { error: { code: payload.error.code } })
        },
        protectedContentInput: payload.error === undefined ? null : { message: payload.error.message }
      };
      break;
    }
    default:
      throw new TypeError("agent session event type is invalid");
  }
  return parts as ProfileParts<T>;
}

function protectedObjectFields(
  node: ProtectedJsonNodeV1,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, ProtectedJsonNodeV1> | undefined {
  if (node.type !== "object") return undefined;
  const allowed = new Set([...required, ...optional]);
  const output: Record<string, ProtectedJsonNodeV1> = {};
  for (const entry of node.entries) {
    const key = entry.key.text;
    if (!allowed.has(key) || Object.hasOwn(output, key)) return undefined;
    Object.defineProperty(output, key, {
      value: entry.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return required.every((key) => Object.hasOwn(output, key)) ? output : undefined;
}

function isProtectedString(node: ProtectedJsonNodeV1 | undefined): boolean {
  return node?.type === "string";
}

function isProtectedStringArray(node: ProtectedJsonNodeV1 | undefined, expectedLength: number): boolean {
  return node?.type === "array"
    && node.items.length === expectedLength
    && node.items.every((item) => item.type === "string");
}

function validateProtectedContent(
  eventType: AgentSessionProtectedEventTypeV1,
  controls: AgentSessionPublicControlsMapV1[AgentSessionProtectedEventTypeV1],
  root: ProtectedJsonNodeV1
): boolean {
  if (eventType === "turn/start" || eventType === "step/start" || eventType === "step/end") {
    return root.type === "null";
  }
  if (eventType === "approval/requested" || eventType === "approval/resolved") {
    return root.type === "null";
  }
  if (eventType === "session/created") {
    const fields = protectedObjectFields(root, [], ["cwd", "labels"]);
    if (fields === undefined || (fields.cwd !== undefined && !isProtectedString(fields.cwd))) return false;
    const labels = fields.labels;
    return labels === undefined
      || labels.type === "object" && labels.entries.every((entry) => entry.value.type === "string");
  }
  if (eventType === "user/message" || eventType === "assistant/message") {
    const fields = protectedObjectFields(root, ["blocks"]);
    const messageControls = (controls as AgentSessionPublicControlsMapV1["user/message"]
      | AgentSessionPublicControlsMapV1["assistant/message"]).message;
    return fields !== undefined && isProtectedStringArray(fields.blocks, messageControls.content.length);
  }
  if (eventType === "tool/call") {
    const fields = protectedObjectFields(root, ["protectedArguments"]);
    const toolControls = controls as AgentSessionPublicControlsMapV1["tool/call"];
    const protectedArguments = fields?.protectedArguments;
    return fields !== undefined
      && protectedArguments?.type === "string"
      && toolControls.binding.protectedInputDigest === protectedArguments.value.digest
      && toolControls.binding.protectionPolicyDigest === protectedArguments.value.policyDigest;
  }
  if (eventType === "tool/result") {
    const fields = protectedObjectFields(root, ["content"]);
    const toolControls = controls as AgentSessionPublicControlsMapV1["tool/result"];
    return fields !== undefined
      && isProtectedStringArray(fields.content, toolControls.message.content[0].content.length);
  }
  const turnControls = controls as AgentSessionPublicControlsMapV1["turn/end"];
  if (turnControls.error === undefined) return root.type === "null";
  const fields = protectedObjectFields(root, ["message"]);
  return fields !== undefined && isProtectedString(fields.message);
}

function assertPublicControls(eventType: AgentSessionProtectedEventTypeV1, value: unknown): void {
  switch (eventType) {
    case "session/created":
      if (hasExactKeys(value, [])) return;
      break;
    case "turn/start":
      if (hasExactKeys(value, ["turn"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        return;
      }
      break;
    case "user/message":
      if (hasExactKeys(value, ["turn", "message"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        const message = value.message;
        if (hasExactKeys(message, ["id", "role", "source", "content"])
          && message.role === "user"
          && hasExactKeys(message.source, ["kind"])
          && message.source.kind === "user"
          && Array.isArray(message.content)
          && message.content.every((block) => hasExactKeys(block, ["type"])
            && (block.type === "text" || block.type === "thinking"))) {
          assertSafePublicControlIdV1(message.id, "message identifier");
          return;
        }
      }
      break;
    case "step/start":
      if (hasExactKeys(value, ["turn", "step"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        assertPositiveSafeInteger(value.step, "event step");
        return;
      }
      break;
    case "assistant/message":
      if (hasExactKeys(value, ["turn", "step", "message"], ["usage"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        assertPositiveSafeInteger(value.step, "event step");
        const message = value.message;
        if (!hasExactKeys(message, ["id", "role", "source", "content"])
          || message.role !== "assistant"
          || !hasExactKeys(message.source, ["kind", "provider", "model"])
          || message.source.kind !== "model"
          || !Array.isArray(message.content)) break;
        assertSafePublicControlIdV1(message.id, "message identifier");
        assertSafeName(message.source.provider, "model provider");
        assertSafeName(message.source.model, "model identifier");
        const callIds = new Set<string>();
        for (const block of message.content) {
          if (hasExactKeys(block, ["type"]) && (block.type === "text" || block.type === "thinking")) continue;
          if (!hasExactKeys(block, ["type", "id", "name", "binding"])
            || block.type !== "tool-call"
            || block.binding !== UNBOUND_PROTECTED_TOOL_CALL_V1) break;
          assertSafePublicControlIdV1(block.id, "tool call identifier");
          assertSafeName(block.name, "tool name");
          if (callIds.has(block.id)) throw new TypeError("assistant controls contain a duplicate tool call identifier");
          callIds.add(block.id);
        }
        if (message.content.every((block) => hasExactKeys(block, ["type"])
          && (block.type === "text" || block.type === "thinking")
          || hasExactKeys(block, ["type", "id", "name", "binding"])
            && block.type === "tool-call"
            && block.binding === UNBOUND_PROTECTED_TOOL_CALL_V1)
          && (value.usage === undefined || isTokenUsage(value.usage))) return;
      }
      break;
    case "tool/call":
      if (hasExactKeys(value, ["turn", "step", "callId", "name", "binding"])
        && value.binding !== UNBOUND_PROTECTED_TOOL_CALL_V1) {
        assertPositiveSafeInteger(value.turn, "event turn");
        assertPositiveSafeInteger(value.step, "event step");
        assertSafePublicControlIdV1(value.callId, "tool call identifier");
        assertSafeName(value.name, "tool name");
        assertEffectCommitmentV1(value.binding);
        if (value.binding.rawKind !== "text"
          || value.binding.turn !== value.turn
          || value.binding.step !== value.step
          || value.binding.internalEffectId !== value.callId
          || value.binding.effectKind !== deriveToolEffectKindV1(value.name)) break;
        return;
      }
      break;
    case "approval/requested":
      if (hasExactKeys(value, ["binding"])) {
        assertApprovalBinding(value.binding);
        return;
      }
      break;
    case "approval/resolved":
      if (hasExactKeys(value, ["binding", "requestEventId", "requestDigest", "decision", "resolution"])) {
        assertApprovalBinding(value.binding);
        assertSafePublicControlIdV1(value.requestEventId, "approval request event identifier");
        if (typeof value.requestDigest !== "string" || !DIGEST_PATTERN.test(value.requestDigest)) {
          throw new TypeError("approval request digest must be a sha256 digest");
        }
        assertApprovalResolution(value.decision, value.resolution);
        return;
      }
      break;
    case "tool/result":
      if (hasExactKeys(value, ["turn", "step", "message", "status"], ["error"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        assertPositiveSafeInteger(value.step, "event step");
        const message = value.message;
        if (!hasExactKeys(message, ["id", "role", "source", "content"])
          || message.role !== "user"
          || !hasExactKeys(message.source, ["kind", "callId"])
          || message.source.kind !== "tool"
          || !Array.isArray(message.content)
          || message.content.length !== 1) break;
        assertSafePublicControlIdV1(message.id, "message identifier");
        assertSafePublicControlIdV1(message.source.callId, "tool message call identifier");
        const block = message.content[0];
        if (!hasExactKeys(block, ["type", "toolCallId", "content"], ["isError"])
          || block.type !== "tool-result"
          || !Array.isArray(block.content)
          || !block.content.every((item) => hasExactKeys(item, ["type"])
            && (item.type === "text" || item.type === "thinking"))
          || (block.isError !== undefined && typeof block.isError !== "boolean")) break;
        assertSafePublicControlIdV1(block.toolCallId, "tool result call identifier");
        if (block.toolCallId !== message.source.callId) break;
        if (value.error !== undefined) {
          if (!hasExactKeys(value.error, ["name", "code"])) break;
          assertSafeName(value.error.name, "tool error name");
          assertSafeName(value.error.code, "tool error code");
        }
        if (value.status === "completed" || value.status === "interrupted") return;
      }
      break;
    case "step/end":
      if (hasExactKeys(value, ["turn", "step", "status"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        assertPositiveSafeInteger(value.step, "event step");
        if (typeof value.status === "string" && STEP_END_STATUSES.has(value.status)) return;
      }
      break;
    case "turn/end":
      if (hasExactKeys(value, ["turn", "reason"], ["error"])) {
        assertPositiveSafeInteger(value.turn, "event turn");
        if (value.error !== undefined) {
          if (!hasExactKeys(value.error, ["code"])) break;
          assertSafeName(value.error.code, "turn error code");
        }
        if (typeof value.reason === "string" && TURN_END_REASONS.has(value.reason)) return;
      }
      break;
  }
  throw new TypeError(`event ${eventType} public controls do not match the protected payload profile`);
}

export function protectAgentSessionPayloadV1<T extends AgentSessionProtectedEventTypeV1>(
  eventType: T,
  raw: AgentSessionRawPayloadMapV1[T]
): AgentSessionProtectedPayloadV1<T> {
  if (typeof eventType !== "string" || !AGENT_SESSION_EVENT_TYPES_V1.has(eventType)) {
    throw new TypeError("agent session event type is invalid");
  }
  const snapshot = snapshotBoundedJsonValue(raw);
  assertRawPayload(eventType, snapshot);
  const parts = buildProfileParts(eventType, snapshot as unknown as AgentSessionRawPayloadMapV1[T]);
  const protectedContent = createProtectedJsonViewV1(parts.protectedContentInput);
  snapshotBoundedJsonValue({
    publicControls: parts.publicControls,
    protectedContent
  });
  const envelope = {
    schemaVersion: 1 as const,
    kind: "agent-session-protected-payload" as const,
    eventType,
    protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V1,
    protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1,
    publicControls: parts.publicControls,
    protectedContent
  };
  return deepFreeze({ ...envelope, digest: digestJson(envelope) }) as AgentSessionProtectedPayloadV1<T>;
}

export function inspectAgentSessionProtectedPayloadV1<T extends AgentSessionProtectedEventTypeV1>(
  eventType: T,
  value: unknown
): AgentSessionProtectedPayloadV1<T> | undefined {
  try {
    if (typeof eventType !== "string" || !AGENT_SESSION_EVENT_TYPES_V1.has(eventType)) return undefined;
    const record = exactDataRecord(value, [
      "schemaVersion",
      "kind",
      "eventType",
      "protectionProfile",
      "protectionPolicyDigest",
      "publicControls",
      "protectedContent",
      "digest"
    ]);
    if (record === undefined
      || record.schemaVersion !== 1
      || record.kind !== "agent-session-protected-payload"
      || record.eventType !== eventType
      || record.protectionProfile !== AGENT_SESSION_PROTECTION_PROFILE_V1
      || record.protectionPolicyDigest !== PROTECTION_POLICY_DIGEST_V1
      || typeof record.digest !== "string"
      || !DIGEST_PATTERN.test(record.digest)) return undefined;

    const boundedParts = snapshotBoundedJsonValue({
      publicControls: record.publicControls,
      protectedContent: record.protectedContent
    });
    if (boundedParts === null || typeof boundedParts !== "object" || Array.isArray(boundedParts)) return undefined;
    const publicControls = boundedParts.publicControls;
    const protectedContent = boundedParts.protectedContent;
    assertPublicControls(eventType, publicControls);
    if (!isProtectedJsonViewV1(protectedContent)
      || protectedContent.policyDigest !== record.protectionPolicyDigest
      || !validateProtectedContent(
        eventType,
        publicControls as unknown as AgentSessionPublicControlsMapV1[AgentSessionProtectedEventTypeV1],
        protectedContent.root
      )) return undefined;

    const envelope = {
      schemaVersion: 1 as const,
      kind: "agent-session-protected-payload" as const,
      eventType,
      protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V1,
      protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1,
      publicControls,
      protectedContent
    };
    if (digestJson(envelope) !== record.digest) return undefined;
    return deepFreeze({ ...envelope, digest: record.digest }) as unknown as AgentSessionProtectedPayloadV1<T>;
  } catch {
    return undefined;
  }
}

export function isAgentSessionProtectedPayloadV1<T extends AgentSessionProtectedEventTypeV1>(
  eventType: T,
  value: unknown
): boolean {
  return inspectAgentSessionProtectedPayloadV1(eventType, value) !== undefined;
}

export function assertAgentSessionProtectedPayloadV1<T extends AgentSessionProtectedEventTypeV1>(
  eventType: T,
  value: unknown
): AgentSessionProtectedPayloadV1<T> {
  const inspected = inspectAgentSessionProtectedPayloadV1(eventType, value);
  if (inspected === undefined) {
    throw new TypeError("value does not match the event-specific protected session payload schema");
  }
  return inspected;
}
