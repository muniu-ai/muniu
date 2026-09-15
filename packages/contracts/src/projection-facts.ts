// SPDX-License-Identifier: Apache-2.0
import type { EventAppendRequest, KernelEventV1 } from "./events.js";
import type { JsonObject } from "./json.js";
import { verifyEventIntegrity } from "./integrity.js";

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

export interface CoreProjectionSnapshot {
  readonly tenantId: string;
  readonly position: number;
  readonly records: readonly ProjectionFactV1[];
}

export function replayCoreProjections(events: readonly KernelEventV1[], tenantId: string, hmacKey: Uint8Array): CoreProjectionSnapshot {
  const records = new Map<string, ProjectionFactV1>();
  let position = 0;
  let previousDigest: string | undefined;
  for (const event of events) {
    if (event.tenantId !== tenantId || event.position !== position + 1
      || event.previousDigest !== previousDigest || !verifyEventIntegrity(event, hmacKey)) {
      throw new Error("Cannot rebuild projections from incomplete or unauthenticated events");
    }
    const facts = event.publicPayload.projectionFacts;
    const namespace = event.aggregateType === "workspaceMembership" ? "membership" : event.aggregateType;
    if (facts === undefined && CORE_PROJECTION_NAMESPACES.includes(namespace as CoreProjectionNamespace)) {
      throw new Error(`Core event ${event.type} does not contain reconstructable facts`);
    }
    if (facts !== undefined) {
      if (typeof facts !== "object" || facts === null || Array.isArray(facts)) throw new Error("Invalid projection facts");
      const envelope = facts as JsonObject;
      if (envelope.version !== 1 || !Array.isArray(envelope.changes)) throw new Error("Unsupported projection facts");
      for (const raw of envelope.changes) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid projection fact");
        const change = raw as unknown as ProjectionFactV1;
        if (!CORE_PROJECTION_NAMESPACES.includes(change.namespace) || typeof change.id !== "string"
          || (change.value !== null && (typeof change.value !== "object" || Array.isArray(change.value)
            || change.value.tenantId !== tenantId))) throw new Error("Invalid projection fact scope");
        const key = `${change.namespace}:${change.id}`;
        if (change.value === null) records.delete(key); else records.set(key, change);
      }
    }
    position = event.position;
    previousDigest = event.digest;
  }
  return { tenantId, position, records: [...records.values()] };
}
