// SPDX-License-Identifier: Apache-2.0

import {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  PROTECTION_POLICY_DIGEST_V1,
  createProtectedTextV1,
  createAgentSessionEvent,
  deepFreeze,
  protectAgentSessionPayloadV1,
  type AgentSessionEventPayloadMapV1,
  type AgentSessionEventV1
} from "@mn/agent-protocol";

import type { CreateAgentSessionOptionsSnapshot } from "./create-options.js";
import { createSafeRandomEventId } from "./event-id.js";
import type { AgentSessionHeaderV1 } from "./types.js";

export interface InitialAgentSessionState {
  readonly header: AgentSessionHeaderV1;
  readonly event: AgentSessionEventV1<"session/created">;
}

export function createInitialAgentSessionState(
  options: CreateAgentSessionOptionsSnapshot,
  occurredAt = new Date().toISOString()
): InitialAgentSessionState {
  const header: AgentSessionHeaderV1 = deepFreeze({
    schemaVersion: 1,
    sessionId: options.sessionId,
    createdAt: occurredAt,
    protectionProfile: AGENT_SESSION_PROTECTION_PROFILE_V1,
    protectionPolicyDigest: PROTECTION_POLICY_DIGEST_V1,
    ...(options.cwd === undefined ? {} : { protectedCwd: createProtectedTextV1(options.cwd) }),
    ...(options.modelBinding === undefined ? {} : { modelBinding: options.modelBinding })
  });
  const runtimePayload: AgentSessionEventPayloadMapV1["session/created"] = deepFreeze({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.labels === undefined ? {} : { labels: options.labels }),
    ...(options.modelBinding === undefined ? {} : { modelBinding: options.modelBinding })
  });
  const event = createAgentSessionEvent({
    eventId: createSafeRandomEventId(),
    sessionId: options.sessionId,
    seq: 0,
    occurredAt,
    type: "session/created",
    payload: protectAgentSessionPayloadV1("session/created", runtimePayload)
  });
  return deepFreeze({ header, event });
}
