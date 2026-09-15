// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { assertRuntimeBatch, type RuntimeRecord, type RuntimeRecordInput, type RuntimeStore } from "@mn/agent-runtime";
import type { Execution, JsonObject } from "@mn/contracts";
import { PROTECTED_PAYLOAD_KEY_NAMESPACE, type KernelStore, type KernelTransaction } from "@mn/kernel";
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
  readonly onCommit?: (transaction: KernelTransaction, records: readonly RuntimeRecord[]) => void | (() => void);
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
      const readHistory = options.store.readEventHistory ?? options.store.readEvents;
      const page = await readHistory.call(options.store, options.tenantId, position, 500);
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

  async function appendBatch(executionId: string, batch: readonly RuntimeRecordInput[], expectedLastSequence?: number): Promise<readonly RuntimeRecord[] | undefined> {
      assertRuntimeBatch(executionId, expectedLastSequence ?? 0, batch);
      const inputs = structuredClone(batch);
      const snapshot = await restore(executionId);
      const timestamp = now();
      const prepared = await Promise.all(inputs.map(async input => {
        const protectedPayloadRef = `runtime-payload-${randomUUID()}`;
        const stored = await storeProtectedJson({ ...options,
          ownerType: "runtime", ownerId: executionId, protectedPayloadRef,
          value: input.payload, createdAt: timestamp });
        return { ...stored, protectedPayloadRef };
      }));
      const committed = await options.store.transact(options.tenantId, (tx) => {
        const current = tx.getProjection<RuntimeProjection>("agent-runtime", executionId) ?? snapshot;
        if (expectedLastSequence !== undefined && (current.records.at(-1)?.sequence ?? 0) !== expectedLastSequence) return undefined;
        const execution = tx.getProjection<Execution>("execution", executionId);
        const values = inputs.map((input, index): StoredRecord => ({
          id: `runtime-${randomUUID()}`, executionId,
          sequence: current.nextSequence + index, type: input.type, occurredAt: timestamp,
          payload: {}, protectedPayloadRef: prepared[index]!.protectedPayloadRef,
        }));
        for (const [index, value] of values.entries()) {
        const protectedPayloadRef = value.protectedPayloadRef!;
        tx.putProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, protectedPayloadRef, prepared[index]!.keyRecord);
        const { payload: _payload, protectedPayloadRef: _ref, ...metadata } = value;
        const event = tx.appendEvent({
          tenantId: options.tenantId, aggregateType: "runtimeRecord", aggregateId: value.id,
          expectedStreamVersion: 0, type: "agent.runtime_recorded",
          actorId: execution?.executionPrincipalId ?? "system:runtime",
          executionId, generation: execution?.generation ?? 0,
          correlationId: executionId,
          publicPayload: { workspaceId: options.workspaceId, record: metadata as unknown as JsonObject },
          protectedPayloadRef,
        });
        tx.putOutbox({ id: `runtime-outbox-${value.id}`, tenantId: options.tenantId,
          topic: "agent.runtime_recorded", payload: { eventId: event.id,
            executionId, position: event.position }, availableAt: timestamp });
        }
        tx.putProjection<RuntimeProjection>("agent-runtime", executionId, {
          executionId, streamVersion: current.streamVersion + values.length,
          nextSequence: current.nextSequence + values.length, records: [...current.records, ...values],
        });
        const records = values.map((record, index) => {
          const { protectedPayloadRef: _ref, ...metadata } = record;
          return { ...metadata, payload: inputs[index]!.payload };
        });
        return { records, afterCommit: options.onCommit?.(tx, records) };
      });
      committed?.afterCommit?.();
      return committed?.records;
  }

  return {
    async append(input) {
      return (await appendBatch(input.executionId, [input]))![0]!;
    },
    commit: (executionId, expectedLastSequence, batch) => appendBatch(executionId, batch, expectedLastSequence),
    async readExecution(executionId) {
      const projection = await restore(executionId);
      return Promise.all(projection.records.map(decode));
    },
  };
}
