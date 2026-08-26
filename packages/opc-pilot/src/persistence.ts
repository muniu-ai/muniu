// SPDX-License-Identifier: Apache-2.0

import {
  appendOperationEvent,
  type AttentionItemV1,
  type ActionIntentV1,
  type OperationEventV1
} from "@mn/operations";
import type { OpcAppendInput, OpcAppendStore, OpcStoredEntry } from "@mn/opc-store";
import { sha256Digest, type SpecJsonValue } from "@mn/specs";

import { identifier, safeInteger, timestamp } from "./shared.js";
import type { CompiledVisitWritebackV1, VisitRecordV1 } from "./types.js";

type TypedEntry<T> = Omit<OpcStoredEntry, "value"> & { readonly value: T };

export interface PersistedVisitWritebackV1 {
  readonly record: TypedEntry<VisitRecordV1>;
  readonly event: TypedEntry<OperationEventV1>;
  readonly actions: readonly TypedEntry<ActionIntentV1>[];
  readonly attentionItems: readonly TypedEntry<AttentionItemV1>[];
}

export async function persistCompiledVisitWriteback(
  store: OpcAppendStore,
  compiled: CompiledVisitWritebackV1,
  input: {
    readonly requestId: string;
    readonly expectedVisitRevision: number;
    readonly expectedOperationEventRevision: number;
    readonly createdAt: string;
  }
): Promise<PersistedVisitWritebackV1> {
  const bindings = assertCompiledBindings(compiled);
  const requestId = identifier(input.requestId, "requestId");
  const expectedVisitRevision = safeInteger(input.expectedVisitRevision, "expectedVisitRevision");
  const expectedEventRevision = safeInteger(
    input.expectedOperationEventRevision,
    "expectedOperationEventRevision"
  );
  const createdAt = timestamp(input.createdAt, "createdAt");
  if (createdAt !== compiled.visit.createdAt) {
    throw new Error("persistence time must match the compiled visit revision");
  }
  const eventHistory = await store.history<SpecJsonValue>(
    compiled.visit.tenantId,
    "operation_event",
    bindings.runId
  );
  if (eventHistory.length < expectedEventRevision) {
    throw new Error("operation event history is shorter than expectedRevision");
  }
  const previous = expectedEventRevision === 0
    ? undefined
    : eventHistory[expectedEventRevision - 1]!.value as unknown as OperationEventV1;
  const eventSeed = sha256Digest({ requestId, visitDigest: compiled.visit.digest, actionIds: bindings.actionIds });
  const event = appendOperationEvent(previous, {
    id: `operationEvent.${eventSeed}`,
    tenantId: compiled.visit.tenantId,
    runId: bindings.runId,
    kind: "artifact",
    actor: "operation.compiler",
    sourceRefs: [compiled.visit.digest],
    payloadRef: `writeback:${eventSeed}`,
    createdAt
  });
  const appendInputs: OpcAppendInput[] = [
    {
      tenantId: compiled.visit.tenantId,
      kind: "record",
      id: compiled.visit.id,
      expectedRevision: expectedVisitRevision,
      requestId: derivedRequestId(requestId, "record", compiled.visit.id),
      value: compiled.visit as unknown as SpecJsonValue,
      createdAt
    },
    {
      tenantId: compiled.visit.tenantId,
      kind: "operation_event",
      id: bindings.runId,
      expectedRevision: expectedEventRevision,
      requestId: derivedRequestId(requestId, "event", event.id),
      value: event as unknown as SpecJsonValue,
      createdAt
    },
    ...compiled.actions.map((action): OpcAppendInput => ({
      tenantId: compiled.visit.tenantId,
      kind: "action_intent",
      id: action.id,
      expectedRevision: 0,
      requestId: derivedRequestId(requestId, "action", action.id),
      value: action as unknown as SpecJsonValue,
      createdAt
    })),
    ...compiled.attentionItems.map((item): OpcAppendInput => ({
      tenantId: compiled.visit.tenantId,
      kind: "attention_item",
      id: item.id,
      expectedRevision: 0,
      requestId: derivedRequestId(requestId, "attention", item.id),
      value: item as unknown as SpecJsonValue,
      createdAt
    }))
  ];
  const stored = await store.appendBatch(appendInputs);
  const actionEnd = 2 + compiled.actions.length;
  return Object.freeze({
    record: stored[0]! as unknown as TypedEntry<VisitRecordV1>,
    event: stored[1]! as unknown as TypedEntry<OperationEventV1>,
    actions: Object.freeze(stored.slice(2, actionEnd) as unknown as TypedEntry<ActionIntentV1>[]),
    attentionItems: Object.freeze(stored.slice(actionEnd) as unknown as TypedEntry<AttentionItemV1>[])
  });
}

function assertCompiledBindings(compiled: CompiledVisitWritebackV1): {
  readonly runId: string;
  readonly actionIds: readonly string[];
} {
  if (compiled.visit.payload.state !== "writeback_pending" || compiled.actions.length < 1
    || compiled.actions.length !== compiled.attentionItems.length) {
    throw new Error("compiled visit writeback is incomplete");
  }
  const tenantId = compiled.visit.tenantId;
  const runId = identifier(compiled.actions[0]!.runId, "actions[0].runId");
  const actionIds = compiled.actions.map((action, index) => {
    if (action.tenantId !== tenantId || action.runId !== runId || action.createdAt !== compiled.visit.createdAt) {
      throw new Error(`actions[${index}] is not bound to the compiled visit`);
    }
    const attention = compiled.attentionItems[index]!;
    if (attention.tenantId !== tenantId || attention.sourceKind !== "approval"
      || attention.sourceId !== action.id || attention.inputDigest !== action.inputDigest
      || attention.status !== "pending" || attention.createdAt !== action.createdAt) {
      throw new Error(`attentionItems[${index}] is not bound to its action intent`);
    }
    return identifier(action.id, `actions[${index}].id`);
  });
  if (new Set(actionIds).size !== actionIds.length) throw new Error("compiled action ids must be unique");
  return { runId, actionIds: Object.freeze(actionIds) };
}

function derivedRequestId(requestId: string, kind: string, id: string): string {
  return `opcPersist.${sha256Digest({ requestId, kind, id })}`;
}
