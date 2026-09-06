// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { RuntimeRecord, RuntimeStore } from "@mn/agent-runtime";
import type { Execution, JsonObject } from "@mn/contracts";
import { PROTECTED_PAYLOAD_KEY_NAMESPACE, type KernelStore } from "@mn/kernel";
import {
  readProtectedJson, storeProtectedJson,
  type ContentAddressedStorage, type KeyProvider, type ProtectedJsonKeyRecordV1,
} from "@mn/storage";

export interface RuntimeProtection {
  readonly cas: ContentAddressedStorage;
  readonly keyProvider: KeyProvider;
}

export interface ProtectedRuntimeOptions extends RuntimeProtection {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly store: KernelStore;
  readonly now?: () => string;
}

interface StoredRecord extends RuntimeRecord {
  readonly protectedPayloadRef?: string;
}

export async function readProtectedRuntimePayload(options: ProtectedRuntimeOptions & {
  readonly ownerType: string;
  readonly ownerId: string;
  readonly protectedPayloadRef: string;
}): Promise<JsonObject> {
  const keyRecord = await options.store.transact(options.tenantId, (tx) =>
    tx.getProjection<ProtectedJsonKeyRecordV1>(PROTECTED_PAYLOAD_KEY_NAMESPACE, options.protectedPayloadRef));
  if (!keyRecord) throw new Error("运行记录的数据密钥已销毁");
  return readProtectedJson({ ...options, keyRecord });
}

export async function readExecutionInput(options: {
  readonly store: KernelStore;
  readonly execution: Execution;
  readonly payload: JsonObject;
  readonly protection?: RuntimeProtection;
}): Promise<string> {
  const { execution, store } = options;
  const entries = await store.transact(execution.tenantId, tx => tx.listProjections<JsonObject>("session-log-entry")
    .filter(entry => entry.tenantId === execution.tenantId && entry.workspaceId === execution.workspaceId
      && entry.threadId === execution.threadId && entry.executionId === execution.id));
  if (entries.length > 1) throw new Error("执行包含重复的初始会话记录");
  const source = entries[0] ?? options.payload;
  let value = source;
  if (typeof source.protectedPayloadRef === "string") {
    if (!options.protection) throw new Error("执行上下文缺少解密配置");
    value = await readProtectedRuntimePayload({ ...options.protection, store,
      tenantId: execution.tenantId, workspaceId: execution.workspaceId,
      ownerType: "thread", ownerId: execution.threadId,
      protectedPayloadRef: source.protectedPayloadRef });
  }
  if (typeof value.message !== "string" || !value.message.trim()) throw new Error("执行缺少持久化的本轮输入");
  return value.message;
}

interface RuntimeProjection {
  readonly executionId: string;
  readonly streamVersion: number;
  readonly nextSequence: number;
  readonly records: readonly StoredRecord[];
}

export function createProtectedRuntimeStore(options: ProtectedRuntimeOptions): RuntimeStore {
  const now = options.now ?? (() => new Date().toISOString());

  async function restore(executionId: string): Promise<RuntimeProjection> {
    const current = await options.store.transact(options.tenantId, (tx) =>
      tx.getProjection<RuntimeProjection>("agent-runtime", executionId));
    if (current) return current;
    const records: StoredRecord[] = [];
    let position = 0;
    for (;;) {
      const page = await options.store.readEvents(options.tenantId, position, 500);
      for (const event of page.events) {
        if (event.type !== "agent.runtime_recorded" || event.executionId !== executionId) continue;
        const record = event.publicPayload.record as unknown as StoredRecord;
        if (!record || record.executionId !== executionId) throw new Error("运行事件记录无效");
        records.push({ ...record, payload: {}, protectedPayloadRef: event.protectedPayloadRef });
      }
      if (page.events.length === 0) break;
      position = page.events.at(-1)!.position;
      if (page.events.length < 500) break;
    }
    records.sort((left, right) => left.sequence - right.sequence);
    const nextSequence = (records.at(-1)?.sequence ?? 0) + 1;
    return { executionId, streamVersion: records.length, nextSequence, records };
  }

  async function decode(record: StoredRecord): Promise<RuntimeRecord> {
    const { protectedPayloadRef, ...metadata } = record;
    if (!protectedPayloadRef) return metadata;
    const keyRecord = await options.store.transact(options.tenantId, (tx) =>
      tx.getProjection<ProtectedJsonKeyRecordV1>(PROTECTED_PAYLOAD_KEY_NAMESPACE, protectedPayloadRef));
    if (!keyRecord) throw new Error("运行记录的数据密钥已销毁");
    return { ...metadata, payload: await readProtectedJson({ ...options,
      ownerType: "runtime", ownerId: record.executionId, protectedPayloadRef, keyRecord }) };
  }

  return {
    async append(input) {
      const snapshot = await restore(input.executionId);
      const protectedPayloadRef = `runtime-payload-${randomUUID()}`;
      const timestamp = now();
      const prepared = await storeProtectedJson({ ...options,
        ownerType: "runtime", ownerId: input.executionId, protectedPayloadRef,
        value: input.payload, createdAt: timestamp });
      const record = await options.store.transact(options.tenantId, (tx) => {
        const current = tx.getProjection<RuntimeProjection>("agent-runtime", input.executionId) ?? snapshot;
        const execution = tx.getProjection<Execution>("execution", input.executionId);
        const value: StoredRecord = {
          id: `runtime-${randomUUID()}`, executionId: input.executionId,
          sequence: current.nextSequence, type: input.type, occurredAt: timestamp,
          payload: {}, protectedPayloadRef,
        };
        tx.putProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, protectedPayloadRef, prepared.keyRecord);
        tx.putProjection<RuntimeProjection>("agent-runtime", input.executionId, {
          executionId: input.executionId, streamVersion: current.streamVersion + 1,
          nextSequence: value.sequence + 1, records: [...current.records, value],
        });
        const { payload: _payload, protectedPayloadRef: _ref, ...metadata } = value;
        const event = tx.appendEvent({
          tenantId: options.tenantId, aggregateType: "runtimeRecord", aggregateId: value.id,
          expectedStreamVersion: 0, type: "agent.runtime_recorded",
          actorId: execution?.executionPrincipalId ?? "system:runtime",
          executionId: input.executionId, generation: execution?.generation ?? 0,
          correlationId: input.executionId,
          publicPayload: { workspaceId: options.workspaceId, record: metadata as unknown as JsonObject },
          protectedPayloadRef,
        });
        tx.putOutbox({ id: `runtime-outbox-${value.id}`, tenantId: options.tenantId,
          topic: "agent.runtime_recorded", payload: { eventId: event.id,
            executionId: input.executionId, position: event.position }, availableAt: timestamp });
        return value;
      });
      const { protectedPayloadRef: _ref, ...metadata } = record;
      return { ...metadata, payload: structuredClone(input.payload) };
    },
    async readExecution(executionId) {
      const projection = await restore(executionId);
      return Promise.all(projection.records.map(decode));
    },
  };
}
