// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import { deepFreeze } from "./freeze.js";
import { inspectAgentModelBindingV1, type AgentModelBindingV1 } from "./model-binding.js";
import { isSafePublicControlIdV1 } from "./public-control.js";
import type { AgentApprovalDecisionV1 } from "./session-payload.js";

export const AGENT_SESSION_TRANSPORT_VERSION_V1 = 1 as const;

export type AgentSessionViewStateV1 =
  | "idle"
  | "active"
  | "waiting-approval"
  | "completed"
  | "cancelled"
  | "budget-exceeded"
  | "interrupted"
  | "error"
  | "closed";

export interface AgentSessionCreateRequestV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent-session-create-request";
  readonly clientRequestId: string;
  readonly modelBinding: AgentModelBindingV1;
  readonly cwd?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface AgentMessageRequestV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent-message-request";
  readonly clientRequestId: string;
  readonly prompt: string;
}

export interface AgentSessionControlRequestV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent-session-control-request";
  readonly clientRequestId: string;
}

export interface AgentApprovalDecisionRequestV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent-approval-decision-request";
  readonly clientRequestId: string;
  readonly decision: AgentApprovalDecisionV1;
}

export interface AgentSessionViewV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent-session-view";
  readonly sessionId: string;
  readonly state: AgentSessionViewStateV1;
  readonly modelBinding: AgentModelBindingV1;
  readonly eventCursor: {
    readonly lastSeq: number;
    readonly lastDigest: string;
  };
}

export interface AgentErrorResponseV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent-error-response";
  readonly error: string;
}

export interface AgentApprovalResponseV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent-approval-response";
  readonly sessionId: string;
  readonly approvalId: string;
  readonly decision: AgentApprovalDecisionV1;
  readonly status: "resolved";
}

export type AgentSessionControlResponseV1 =
  | {
    readonly schemaVersion: 1;
    readonly kind: "agent-session-control-response";
    readonly sessionId: string;
    readonly action: "cancel";
    readonly cancelled: boolean;
  }
  | {
    readonly schemaVersion: 1;
    readonly kind: "agent-session-control-response";
    readonly sessionId: string;
    readonly action: "close";
    readonly state: "closed";
  };

const APPROVAL_DECISIONS = new Set<AgentApprovalDecisionV1>([
  "approve_once",
  "approve_session_scope",
  "deny"
]);
const VIEW_STATES = new Set<AgentSessionViewStateV1>([
  "idle",
  "active",
  "waiting-approval",
  "completed",
  "cancelled",
  "budget-exceeded",
  "interrupted",
  "error",
  "closed"
]);
const MAX_CWD_LENGTH = 16_384;
const MAX_LABELS = 256;
const MAX_LABEL_KEY_LENGTH = 256;
const MAX_LABEL_VALUE_LENGTH = 16_384;
const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_TRANSPORT_CODE_UNITS = 1_048_576;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function exactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    if (keys.length < required.length
      || !required.every((key) => keys.includes(key))
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
  } catch {
    return undefined;
  }
}

function inspectLabels(value: unknown): Readonly<Record<string, string>> | undefined {
  try {
    if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_LABELS || keys.some((key) => typeof key !== "string")) return undefined;
    const labels: Record<string, string> = {};
    for (const key of keys as string[]) {
      if (key.length === 0 || key.length > MAX_LABEL_KEY_LENGTH
        || key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable
        || typeof descriptor.value !== "string"
        || descriptor.value.length > MAX_LABEL_VALUE_LENGTH) return undefined;
      Object.defineProperty(labels, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return deepFreeze(labels);
  } catch {
    return undefined;
  }
}

function inspectClientRequestId(value: unknown): value is string {
  return isSafePublicControlIdV1(value);
}

export function inspectAgentSessionCreateRequestV1(value: unknown): AgentSessionCreateRequestV1 | undefined {
  const record = exactDataRecord(
    value,
    ["schemaVersion", "kind", "clientRequestId", "modelBinding"],
    ["cwd", "labels"]
  );
  if (record === undefined || record.schemaVersion !== AGENT_SESSION_TRANSPORT_VERSION_V1
    || record.kind !== "agent-session-create-request"
    || !inspectClientRequestId(record.clientRequestId)) return undefined;
  const modelBinding = inspectAgentModelBindingV1(record.modelBinding);
  if (modelBinding === undefined
    || (record.cwd !== undefined
      && (typeof record.cwd !== "string" || record.cwd.length > MAX_CWD_LENGTH))) return undefined;
  const labels = record.labels === undefined ? undefined : inspectLabels(record.labels);
  if (record.labels !== undefined && labels === undefined) return undefined;
  let codeUnits = (record.cwd as string | undefined)?.length ?? 0;
  if (labels !== undefined) {
    for (const [key, label] of Object.entries(labels)) codeUnits += key.length + label.length;
  }
  if (codeUnits > MAX_TRANSPORT_CODE_UNITS) return undefined;
  return deepFreeze({
    schemaVersion: 1,
    kind: "agent-session-create-request",
    clientRequestId: record.clientRequestId,
    modelBinding,
    ...(record.cwd === undefined ? {} : { cwd: record.cwd as string }),
    ...(labels === undefined ? {} : { labels })
  });
}

export function inspectAgentMessageRequestV1(value: unknown): AgentMessageRequestV1 | undefined {
  const record = exactDataRecord(value, ["schemaVersion", "kind", "clientRequestId", "prompt"]);
  if (record === undefined || record.schemaVersion !== AGENT_SESSION_TRANSPORT_VERSION_V1
    || record.kind !== "agent-message-request"
    || !inspectClientRequestId(record.clientRequestId)
    || typeof record.prompt !== "string"
    || record.prompt.length === 0
    || record.prompt.length > MAX_PROMPT_LENGTH) return undefined;
  return deepFreeze({
    schemaVersion: 1,
    kind: "agent-message-request",
    clientRequestId: record.clientRequestId,
    prompt: record.prompt
  });
}

export function inspectAgentSessionControlRequestV1(value: unknown): AgentSessionControlRequestV1 | undefined {
  const record = exactDataRecord(value, ["schemaVersion", "kind", "clientRequestId"]);
  if (record === undefined || record.schemaVersion !== AGENT_SESSION_TRANSPORT_VERSION_V1
    || record.kind !== "agent-session-control-request"
    || !inspectClientRequestId(record.clientRequestId)) return undefined;
  return deepFreeze({
    schemaVersion: 1,
    kind: "agent-session-control-request",
    clientRequestId: record.clientRequestId
  });
}

export function inspectAgentApprovalDecisionRequestV1(
  value: unknown
): AgentApprovalDecisionRequestV1 | undefined {
  const record = exactDataRecord(value, ["schemaVersion", "kind", "clientRequestId", "decision"]);
  if (record === undefined || record.schemaVersion !== AGENT_SESSION_TRANSPORT_VERSION_V1
    || record.kind !== "agent-approval-decision-request"
    || !inspectClientRequestId(record.clientRequestId)
    || typeof record.decision !== "string"
    || !APPROVAL_DECISIONS.has(record.decision as AgentApprovalDecisionV1)) return undefined;
  return deepFreeze({
    schemaVersion: 1,
    kind: "agent-approval-decision-request",
    clientRequestId: record.clientRequestId,
    decision: record.decision as AgentApprovalDecisionV1
  });
}

export function inspectAgentSessionViewV1(value: unknown): AgentSessionViewV1 | undefined {
  const record = exactDataRecord(
    value,
    ["schemaVersion", "kind", "sessionId", "state", "modelBinding", "eventCursor"]
  );
  if (record === undefined || record.schemaVersion !== AGENT_SESSION_TRANSPORT_VERSION_V1
    || record.kind !== "agent-session-view"
    || !isSafePublicControlIdV1(record.sessionId)
    || typeof record.state !== "string"
    || !VIEW_STATES.has(record.state as AgentSessionViewStateV1)) return undefined;
  const modelBinding = inspectAgentModelBindingV1(record.modelBinding);
  if (modelBinding === undefined) return undefined;
  const cursor = exactDataRecord(record.eventCursor, ["lastSeq", "lastDigest"]);
  if (cursor === undefined || typeof cursor.lastSeq !== "number"
    || !Number.isSafeInteger(cursor.lastSeq) || cursor.lastSeq < 0
    || typeof cursor.lastDigest !== "string" || !DIGEST_PATTERN.test(cursor.lastDigest)) return undefined;
  return deepFreeze({
    schemaVersion: 1,
    kind: "agent-session-view",
    sessionId: record.sessionId,
    state: record.state as AgentSessionViewStateV1,
    modelBinding,
    eventCursor: { lastSeq: cursor.lastSeq, lastDigest: cursor.lastDigest }
  });
}

export function inspectAgentErrorResponseV1(value: unknown): AgentErrorResponseV1 | undefined {
  const record = exactDataRecord(value, ["schemaVersion", "kind", "error"]);
  if (record === undefined || record.schemaVersion !== AGENT_SESSION_TRANSPORT_VERSION_V1
    || record.kind !== "agent-error-response"
    || !isSafePublicControlIdV1(record.error)) return undefined;
  return deepFreeze({ schemaVersion: 1, kind: "agent-error-response", error: record.error });
}

export function inspectAgentApprovalResponseV1(value: unknown): AgentApprovalResponseV1 | undefined {
  const record = exactDataRecord(
    value,
    ["schemaVersion", "kind", "sessionId", "approvalId", "decision", "status"]
  );
  if (record === undefined || record.schemaVersion !== AGENT_SESSION_TRANSPORT_VERSION_V1
    || record.kind !== "agent-approval-response"
    || !isSafePublicControlIdV1(record.sessionId)
    || !isSafePublicControlIdV1(record.approvalId)
    || typeof record.decision !== "string"
    || !APPROVAL_DECISIONS.has(record.decision as AgentApprovalDecisionV1)
    || record.status !== "resolved") return undefined;
  return deepFreeze({
    schemaVersion: 1,
    kind: "agent-approval-response",
    sessionId: record.sessionId,
    approvalId: record.approvalId,
    decision: record.decision as AgentApprovalDecisionV1,
    status: "resolved"
  });
}

export function inspectAgentSessionControlResponseV1(
  value: unknown
): AgentSessionControlResponseV1 | undefined {
  const common = exactDataRecord(
    value,
    ["schemaVersion", "kind", "sessionId", "action"],
    ["cancelled", "state"]
  );
  if (common === undefined || common.schemaVersion !== AGENT_SESSION_TRANSPORT_VERSION_V1
    || common.kind !== "agent-session-control-response"
    || !isSafePublicControlIdV1(common.sessionId)) return undefined;
  if (common.action === "cancel") {
    const exact = exactDataRecord(value, ["schemaVersion", "kind", "sessionId", "action", "cancelled"]);
    if (exact === undefined || typeof exact.cancelled !== "boolean") return undefined;
    return deepFreeze({
      schemaVersion: 1,
      kind: "agent-session-control-response",
      sessionId: common.sessionId,
      action: "cancel",
      cancelled: exact.cancelled
    });
  }
  if (common.action === "close") {
    const exact = exactDataRecord(value, ["schemaVersion", "kind", "sessionId", "action", "state"]);
    if (exact === undefined || exact.state !== "closed") return undefined;
    return deepFreeze({
      schemaVersion: 1,
      kind: "agent-session-control-response",
      sessionId: common.sessionId,
      action: "close",
      state: "closed"
    });
  }
  return undefined;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new TypeError(`${label} must be an exact transport v1 DTO`);
  return value;
}

export function assertAgentSessionCreateRequestV1(value: unknown): AgentSessionCreateRequestV1 {
  return required(inspectAgentSessionCreateRequestV1(value), "agent session create request");
}

export function assertAgentMessageRequestV1(value: unknown): AgentMessageRequestV1 {
  return required(inspectAgentMessageRequestV1(value), "agent message request");
}

export function assertAgentSessionControlRequestV1(value: unknown): AgentSessionControlRequestV1 {
  return required(inspectAgentSessionControlRequestV1(value), "agent session control request");
}

export function assertAgentApprovalDecisionRequestV1(value: unknown): AgentApprovalDecisionRequestV1 {
  return required(inspectAgentApprovalDecisionRequestV1(value), "agent approval decision request");
}

export function assertAgentSessionViewV1(value: unknown): AgentSessionViewV1 {
  return required(inspectAgentSessionViewV1(value), "agent session view");
}

export function assertAgentErrorResponseV1(value: unknown): AgentErrorResponseV1 {
  return required(inspectAgentErrorResponseV1(value), "agent error response");
}

export function assertAgentApprovalResponseV1(value: unknown): AgentApprovalResponseV1 {
  return required(inspectAgentApprovalResponseV1(value), "agent approval response");
}

export function assertAgentSessionControlResponseV1(value: unknown): AgentSessionControlResponseV1 {
  return required(inspectAgentSessionControlResponseV1(value), "agent session control response");
}
