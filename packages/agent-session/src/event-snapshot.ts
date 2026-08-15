/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/core/session/src/index.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: retained the adopt/snapshot immutable persistence boundary for
 * the versioned AgentSessionEventV1 envelope without Cordis session state.
 */

import {
  deepFreeze,
  isAgentSessionEventV1,
  snapshotJsonValue,
  type AgentSessionEventV1
} from "@mn/agent-protocol";

export function adoptAgentSessionEvent<T extends AgentSessionEventV1>(event: T): T {
  if (!isAgentSessionEventV1(event)) throw new Error("invalid agent session event envelope");
  return deepFreeze(event);
}

export function snapshotAgentSessionEvent<T extends AgentSessionEventV1>(event: T): T {
  const snapshot = snapshotJsonValue(event);
  if (snapshot === undefined || !isAgentSessionEventV1(snapshot)) {
    throw new Error("agent session event is not losslessly JSON-serializable");
  }
  return adoptAgentSessionEvent(snapshot as T);
}
