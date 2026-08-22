// SPDX-License-Identifier: Apache-2.0

import type {
  AgentSessionEventPayloadMap,
  AgentSessionEventType
} from "@mn/agent-protocol";

const RUNTIME_OVERLAY_TOKEN = Object.freeze({ kind: "agent-session-runtime-overlay" });

export interface InternalRuntimeOverlaySeed {
  readonly token: typeof RUNTIME_OVERLAY_TOKEN;
  readonly payloads: ReadonlyMap<
    number,
    AgentSessionEventPayloadMap[AgentSessionEventType]
  >;
}

export function createInternalRuntimeOverlaySeed(
  payloads: InternalRuntimeOverlaySeed["payloads"]
): InternalRuntimeOverlaySeed {
  return Object.freeze({ token: RUNTIME_OVERLAY_TOKEN, payloads });
}

export function inspectInternalRuntimeOverlaySeed(
  value: unknown
): InternalRuntimeOverlaySeed | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<InternalRuntimeOverlaySeed>;
  return candidate.token === RUNTIME_OVERLAY_TOKEN && candidate.payloads instanceof Map
    ? candidate as InternalRuntimeOverlaySeed
    : undefined;
}
