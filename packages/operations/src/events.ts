// SPDX-License-Identifier: Apache-2.0

import type { OperationEventKindV1, OperationEventV1 } from "./types.js";
import {
  canonicalFrozenClone,
  requireIdentifier,
  requireTimestamp,
  requireUniqueIdentifiers,
  sha256Digest
} from "./shared.js";

const EVENT_KINDS = new Set<OperationEventKindV1>([
  "source_captured",
  "model_attempt",
  "tool_call",
  "gate",
  "approval",
  "artifact",
  "external_receipt",
  "metric"
]);

export type AppendOperationEventInput = Omit<
  OperationEventV1,
  "schemaVersion" | "sequence" | "previousDigest" | "digest"
>;

function unsignedEvent(event: OperationEventV1): Omit<OperationEventV1, "digest"> {
  const { digest: _digest, ...unsigned } = event;
  return unsigned;
}

export function appendOperationEvent(
  previous: OperationEventV1 | undefined,
  input: AppendOperationEventInput
): OperationEventV1 {
  if (!EVENT_KINDS.has(input.kind)) throw new TypeError("operation event kind is invalid");
  const tenantId = requireIdentifier(input.tenantId, "tenantId");
  const runId = requireIdentifier(input.runId, "runId");
  if (previous !== undefined && (previous.tenantId !== tenantId || previous.runId !== runId)) {
    throw new Error("operation event tenant and run must match the previous event");
  }
  const base = {
    schemaVersion: 1 as const,
    id: requireIdentifier(input.id, "id"),
    tenantId,
    runId,
    sequence: (previous?.sequence ?? 0) + 1,
    kind: input.kind,
    actor: requireIdentifier(input.actor, "actor"),
    sourceRefs: requireUniqueIdentifiers(input.sourceRefs, "sourceRefs"),
    payloadRef: requireIdentifier(input.payloadRef, "payloadRef"),
    ...(previous === undefined ? {} : { previousDigest: previous.digest }),
    createdAt: requireTimestamp(input.createdAt, "createdAt")
  };
  if (previous !== undefined && Date.parse(base.createdAt) < Date.parse(previous.createdAt)) {
    throw new TypeError("operation event createdAt must not precede the previous event");
  }
  return canonicalFrozenClone({ ...base, digest: sha256Digest(base) });
}

export function verifyOperationEventChain(events: readonly OperationEventV1[]): boolean {
  if (events.length === 0) return true;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const previous = events[index - 1];
    if (event.schemaVersion !== 1 || event.sequence !== index + 1) return false;
    if (index === 0 && event.previousDigest !== undefined) return false;
    if (previous !== undefined && (
      event.previousDigest !== previous.digest
      || event.tenantId !== previous.tenantId
      || event.runId !== previous.runId
      || Date.parse(event.createdAt) < Date.parse(previous.createdAt)
    )) return false;
    if (sha256Digest(unsignedEvent(event)) !== event.digest) return false;
  }
  return true;
}
