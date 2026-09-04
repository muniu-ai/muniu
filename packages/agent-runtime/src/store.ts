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
    const sequence = ++this.#sequence;
    const record: RuntimeRecord = {
      sequence,
      id: `runtime-${String(sequence)}`,
      executionId: input.executionId,
      type: input.type,
      occurredAt: new Date().toISOString(),
      payload: cloneJsonObject(input.payload),
    };
    this.#records.push(record);
    return cloneRecord(record);
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

  constructor(options: KernelProjectionRuntimeStoreOptions) {
    if (!options.tenantId.trim()) throw new TypeError("tenant id 不能为空");
    this.#tenantId = options.tenantId;
    this.#store = options.store;
    this.#namespace = options.namespace ?? DEFAULT_RUNTIME_NAMESPACE;
    if (!this.#namespace.trim()) throw new TypeError("runtime projection namespace 不能为空");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? ((sequence) => `runtime-${sequence}`);
  }

  async append(input: RuntimeRecordInput): Promise<RuntimeRecord> {
    assertExecutionId(input.executionId);
    return this.#store.transact(this.#tenantId, (transaction) => {
      const current = transaction.getProjection<RuntimeProjection>(
        this.#namespace,
        input.executionId,
      ) ?? emptyProjection(input.executionId);
      assertProjection(current, input.executionId);
      const sequence = current.nextSequence;
      const record: RuntimeRecord = {
        sequence,
        id: this.#id(sequence),
        executionId: input.executionId,
        type: input.type,
        occurredAt: this.#now(),
        payload: cloneJsonObject(input.payload),
      };
      transaction.putProjection<RuntimeProjection>(this.#namespace, input.executionId, {
        executionId: input.executionId,
        streamVersion: current.streamVersion + 1,
        nextSequence: sequence + 1,
        records: [...current.records.map(cloneRecord), cloneRecord(record)],
      });
      return cloneRecord(record);
    });
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
