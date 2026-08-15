// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  EventId,
  createAgentSessionEvent,
  deepFreeze,
  type AgentSessionEventV1
} from "@mn/agent-protocol";

import type { CreateAgentSessionOptionsSnapshot } from "./create-options.js";
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
    ...(options.cwd === undefined ? {} : { cwd: options.cwd })
  });
  const event = createAgentSessionEvent({
    eventId: EventId(randomUUID()),
    sessionId: options.sessionId,
    seq: 0,
    occurredAt,
    type: "session/created",
    payload: {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.labels === undefined ? {} : { labels: options.labels })
    }
  });
  return deepFreeze({ header, event });
}
