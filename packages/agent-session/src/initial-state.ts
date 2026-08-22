// SPDX-License-Identifier: Apache-2.0

import {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  AGENT_SESSION_PROTECTION_PROFILE_V2,
  PROTECTION_POLICY_DIGEST_V1,
  createProtectedTextV1,
  createAgentSessionEvent,
  createAgentSessionEventV2,
  deepFreeze,
  protectAgentSessionPayloadV1,
  protectAgentSessionPayloadV2,
  type AgentSessionEvent,
  type AgentSessionEventPayloadMap
} from "@mn/agent-protocol";

import type { CreateAgentSessionOptionsSnapshot } from "./create-options.js";
import { createSafeRandomEventId } from "./event-id.js";
import type { AgentSessionHeader } from "./types.js";

export interface InitialAgentSessionState {
  readonly header: AgentSessionHeader;
  readonly event: AgentSessionEvent<"session/created">;
}

export function createInitialAgentSessionState(
  options: CreateAgentSessionOptionsSnapshot,
  occurredAt = new Date().toISOString()
): InitialAgentSessionState {
  const commonHeader = {
    sessionId: options.sessionId,
    createdAt: occurredAt,
    protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1,
    ...(options.cwd === undefined ? {} : { protectedCwd: createProtectedTextV1(options.cwd) }),
    ...(options.modelBinding === undefined ? {} : { modelBinding: options.modelBinding })
  };
  const header: AgentSessionHeader = options.schemaVersion === 1
    ? deepFreeze({
      ...commonHeader,
      schemaVersion: 1,
      protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V1
    })
    : deepFreeze({
      ...commonHeader,
      schemaVersion: 2,
      protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V2
    });
  const runtimePayload: AgentSessionEventPayloadMap["session/created"] = deepFreeze({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.labels === undefined ? {} : { labels: options.labels }),
    ...(options.modelBinding === undefined ? {} : { modelBinding: options.modelBinding })
  });
  const common = {
    eventId: createSafeRandomEventId(),
    sessionId: options.sessionId,
    seq: 0,
    occurredAt,
    type: "session/created" as const
  };
  const event: AgentSessionEvent<"session/created"> = options.schemaVersion === 1
    ? createAgentSessionEvent({
      ...common,
      payload: protectAgentSessionPayloadV1("session/created", runtimePayload)
    })
    : createAgentSessionEventV2({
      ...common,
      payload: protectAgentSessionPayloadV2("session/created", runtimePayload)
    });
  return deepFreeze({ header, event });
}
