// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, RuntimeRecord, RuntimeRecordInput, RuntimeStore } from "./types.js";

export interface RuntimeProjectionTransaction {
  getProjection<T>(namespace: string, id: string): T | undefined;
  putProjection<T>(namespace: string, id: string, value: T): void;
}

/** Structural subset of KernelStore, kept here to preserve package layering. */
export interface RuntimeProjectionStore {
  transact<T>(
    tenantId: string,
    work: (transaction: RuntimeProjectionTransaction) => T,
  ): Promise<T>;
}

export interface KernelProjectionRuntimeStoreOptions {
  readonly tenantId: string;
  readonly store: RuntimeProjectionStore;
  readonly namespace?: string;
  readonly now?: () => string;
  readonly id?: (sequence: number) => string;
  readonly onCommit?: (transaction: RuntimeProjectionTransaction, records: readonly RuntimeRecord[]) => void | (() => void);
}

interface RuntimeProjection {
  readonly executionId: string;
  readonly streamVersion: number;
  readonly nextSequence: number;
  readonly records: readonly RuntimeRecord[];
}

const DEFAULT_RUNTIME_NAMESPACE = "agent-runtime";

export class InMemoryRuntimeStore implements RuntimeStore {
  readonly #records: RuntimeRecord[] = [];
  #sequence = 0;

  async append(input: RuntimeRecordInput): Promise<RuntimeRecord> {
    return this.#appendBatch([input])[0]!;
  }

  async commit(executionId: string, expectedLastSequence: number, inputs: readonly RuntimeRecordInput[]): Promise<readonly RuntimeRecord[] | undefined> {
    assertRuntimeBatch(executionId, expectedLastSequence, inputs);
    if ((this.#records.filter(record => record.executionId === executionId).at(-1)?.sequence ?? 0) !== expectedLastSequence) return undefined;
    return this.#appendBatch(inputs);
  }

  #appendBatch(inputs: readonly RuntimeRecordInput[]): readonly RuntimeRecord[] {
    const records = inputs.map((input, index): RuntimeRecord => ({
      sequence: this.#sequence + index + 1, id: `runtime-${this.#sequence + index + 1}`,
      executionId: input.executionId, type: input.type, occurredAt: new Date().toISOString(), payload: cloneJsonObject(input.payload),
    }));
    this.#records.push(...records);
    this.#sequence += records.length;
    return records.map(cloneRecord);
  }

  async readExecution(executionId: string): Promise<readonly RuntimeRecord[]> {
    return this.#records
      .filter((record) => record.executionId === executionId)
      .map(cloneRecord);
  }
}

/**
 * A durable RuntimeStore backed by the same transactional projection store as
 * the kernel. A single execution is one projection, so sequence allocation and
 * append are atomic across worker processes.
 */
export class KernelProjectionRuntimeStore implements RuntimeStore {
  readonly #tenantId: string;
  readonly #store: RuntimeProjectionStore;
  readonly #namespace: string;
  readonly #now: () => string;
  readonly #id: (sequence: number) => string;
  readonly #onCommit: KernelProjectionRuntimeStoreOptions["onCommit"];

  constructor(options: KernelProjectionRuntimeStoreOptions) {
    if (!options.tenantId.trim()) throw new TypeError("tenant id 不能为空");
    this.#tenantId = options.tenantId;
    this.#store = options.store;
    this.#namespace = options.namespace ?? DEFAULT_RUNTIME_NAMESPACE;
    if (!this.#namespace.trim()) throw new TypeError("runtime projection namespace 不能为空");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? ((sequence) => `runtime-${sequence}`);
    this.#onCommit = options.onCommit;
  }

  async append(input: RuntimeRecordInput): Promise<RuntimeRecord> {
    assertExecutionId(input.executionId);
    const records = await this.#appendBatch(input.executionId, [input]);
    return records![0]!;
  }

  async commit(executionId: string, expectedLastSequence: number, inputs: readonly RuntimeRecordInput[]): Promise<readonly RuntimeRecord[] | undefined> {
    assertRuntimeBatch(executionId, expectedLastSequence, inputs);
    return this.#appendBatch(executionId, inputs, expectedLastSequence);
  }

  async #appendBatch(executionId: string, inputs: readonly RuntimeRecordInput[], expectedLastSequence?: number): Promise<readonly RuntimeRecord[] | undefined> {
    const committed = await this.#store.transact(this.#tenantId, (transaction) => {
      const current = transaction.getProjection<RuntimeProjection>(
        this.#namespace,
        executionId,
      ) ?? emptyProjection(executionId);
      assertProjection(current, executionId);
      if (expectedLastSequence !== undefined && (current.records.at(-1)?.sequence ?? 0) !== expectedLastSequence) return undefined;
      const records = inputs.map((input, index): RuntimeRecord => ({
        sequence: current.nextSequence + index, id: this.#id(current.nextSequence + index), executionId,
        type: input.type, occurredAt: this.#now(), payload: cloneJsonObject(input.payload),
      }));
      transaction.putProjection<RuntimeProjection>(this.#namespace, executionId, {
        executionId,
        streamVersion: current.streamVersion + records.length,
        nextSequence: current.nextSequence + records.length,
        records: [...current.records.map(cloneRecord), ...records.map(cloneRecord)],
      });
      return { records: records.map(cloneRecord), afterCommit: this.#onCommit?.(transaction, records.map(cloneRecord)) };
    });
    committed?.afterCommit?.();
    return committed?.records;
  }

  async readExecution(executionId: string): Promise<readonly RuntimeRecord[]> {
    assertExecutionId(executionId);
    return this.#store.transact(this.#tenantId, (transaction) => {
      const projection = transaction.getProjection<RuntimeProjection>(this.#namespace, executionId);
      if (projection === undefined) return [];
      assertProjection(projection, executionId);
      return projection.records.map(cloneRecord);
    });
  }
}

export function assertRuntimeBatch(executionId: string, expectedLastSequence: number, inputs: readonly RuntimeRecordInput[]): void {
  assertExecutionId(executionId);
  if (!Number.isSafeInteger(expectedLastSequence) || expectedLastSequence < 0) throw new TypeError("Runtime 序号无效");
  if (inputs.length === 0 || inputs.some(input => input.executionId !== executionId)) throw new TypeError("Runtime 批次必须属于同一 execution 且非空");
}

function emptyProjection(executionId: string): RuntimeProjection {
  return { executionId, streamVersion: 0, nextSequence: 1, records: [] };
}

function assertExecutionId(executionId: string): void {
  if (!executionId.trim()) throw new TypeError("execution id 不能为空");
}

function assertProjection(value: RuntimeProjection, executionId: string): void {
  if (value.executionId !== executionId
    || !Number.isSafeInteger(value.streamVersion) || value.streamVersion < 0
    || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1
    || !Array.isArray(value.records)) {
    throw new TypeError("runtime projection 无效");
  }
}

function cloneRecord(record: RuntimeRecord): RuntimeRecord {
  return {
    ...record,
    payload: cloneJsonObject(record.payload),
  };
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return structuredClone(value) as JsonObject;
}
