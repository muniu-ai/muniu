// SPDX-License-Identifier: Apache-2.0
import type { EventAppendRequest } from "./events.js";
import type { JsonObject } from "./json.js";

export const CORE_PROJECTION_NAMESPACES = [
  "tenant", "principal", "workspace", "membership", "thread", "execution", "authority",
  "approval", "inbox", "toolIntent", "job", "session-log-entry", "memory", "memoryTombstone",
  "shareGrant", "modelConnection", "asset", "assetTombstone",
] as const;

export type CoreProjectionNamespace = typeof CORE_PROJECTION_NAMESPACES[number];
export interface ProjectionFactV1 {
  readonly namespace: CoreProjectionNamespace;
  readonly id: string;
  readonly value: JsonObject | null;
}

export function createProjectionFacts(changes: readonly ProjectionFactV1[]): JsonObject {
  return { version: 1, changes: JSON.parse(JSON.stringify(changes)) };
}

/** Facts are part of the authenticated event; wrapping keys are never facts. */
export function withProjectionFacts<T extends EventAppendRequest>(request: T, changes: readonly ProjectionFactV1[]): T {
  if (!changes.length) return request;
  return { ...request, publicPayload: { ...request.publicPayload,
    projectionFacts: createProjectionFacts(changes),
  } };
}
