// SPDX-License-Identifier: Apache-2.0
import {
  CORE_PROJECTION_NAMESPACES, withProjectionFacts,
  type CoreProjectionNamespace, type EventAppendRequest, type JsonObject,
  type KernelEventV1, type ProjectionFactV1,
} from "@mn/contracts";
import type { KernelTransaction } from "./store.js";

/** Captures core facts; storage journals protect classified records before event authentication. */
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

export { replayCoreProjections, type CoreProjectionSnapshot } from "@mn/contracts";
