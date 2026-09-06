// SPDX-License-Identifier: Apache-2.0
import {
  CORE_PROJECTION_NAMESPACES, withProjectionFacts, verifyEventIntegrity,
  type CoreProjectionNamespace, type EventAppendRequest, type JsonObject,
  type KernelEventV1, type ProjectionFactV1,
} from "@mn/contracts";
import type { KernelTransaction } from "./store.js";

/** Captures only core metadata. Ciphertext descriptors and key material stay outside this log. */
export function appendKernelEvent(transaction: KernelTransaction, request: EventAppendRequest): KernelEventV1 {
  const changes: ProjectionFactV1[] = [];
  const add = (namespace: CoreProjectionNamespace, id: unknown) => {
    if (typeof id !== "string") return;
    const value = transaction.getProjection<JsonObject>(namespace, id);
    if (!value) return;
    changes.push({ namespace, id, value });
  };
  const namespace = request.aggregateType === "workspaceMembership" ? "membership" : request.aggregateType;
  if (CORE_PROJECTION_NAMESPACES.includes(namespace as CoreProjectionNamespace)) {
    add(namespace as CoreProjectionNamespace, request.aggregateId);
  }
  if (request.type === "tenant.bootstrapped") add("principal", request.publicPayload.principalId);
  if (request.type === "workspace.created") add("membership", `${request.aggregateId}:${request.actorId}`);
  if (request.type === "execution.queued") {
    add("authority", request.publicPayload.authorityId);
  }
  if (request.type === "thread.turn_submitted") add("session-log-entry", request.publicPayload.turnId);
  if (request.type === "tool.intent_recorded") add("toolIntent", request.publicPayload.toolCallId);
  if (request.aggregateType === "approval") {
    add("inbox", `approval:${request.aggregateId}`);
  }
  if (request.executionId) {
    if (request.aggregateType !== "execution") add("execution", request.executionId);
    for (const inbox of transaction.listProjections<JsonObject>("inbox")) {
      if (inbox.executionId === request.executionId) add("inbox", inbox.id);
    }
  }
  if (request.type === "memory.deleted") {
    changes.push({ namespace: "memory", id: request.aggregateId, value: null });
    add("memoryTombstone", request.aggregateId);
  }
  if (request.type === "asset.deleted") {
    changes.push({ namespace: "asset", id: request.aggregateId, value: null });
    add("assetTombstone", request.aggregateId);
  }
  return transaction.appendEvent(withProjectionFacts(request, changes));
}

export interface CoreProjectionSnapshot {
  readonly tenantId: string;
  readonly position: number;
  readonly records: readonly ProjectionFactV1[];
}

/** Rebuild offline into a fresh namespace; never claim or replay physical Jobs here. */
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
