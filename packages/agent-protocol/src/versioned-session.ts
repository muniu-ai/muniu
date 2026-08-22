// SPDX-License-Identifier: Apache-2.0

import type {
  AgentSessionEventTypeV1,
  AgentSessionEventV1
} from "./events.js";
import type {
  AgentSessionEventPayloadMapV2,
  AgentSessionEventTypeV2,
  AgentSessionEventV2
} from "./events-v2.js";
import type { AgentSessionProtectedPayloadV1 } from "./session-payload.js";
import type { AgentSessionProtectedPayloadV2 } from "./session-payload-v2.js";

export type AgentSessionSchemaVersion = 1 | 2;
export type AgentSessionEventType = AgentSessionEventTypeV2;
export type AgentSessionEventPayloadMap = AgentSessionEventPayloadMapV2;
export type AgentSessionEvent<T extends AgentSessionEventType = AgentSessionEventType> =
  T extends AgentSessionEventTypeV1
    ? AgentSessionEventV1<T> | AgentSessionEventV2<T>
    : T extends AgentSessionEventTypeV2
      ? AgentSessionEventV2<T>
      : never;
export type AgentSessionProtectedPayload<T extends AgentSessionEventType = AgentSessionEventType> =
  T extends AgentSessionEventTypeV1
    ? AgentSessionProtectedPayloadV1<T> | AgentSessionProtectedPayloadV2<T>
    : T extends AgentSessionEventTypeV2
      ? AgentSessionProtectedPayloadV2<T>
      : never;
