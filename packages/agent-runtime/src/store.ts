// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, RuntimeRecord, RuntimeRecordInput, RuntimeStore } from "./types.js";

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

function cloneRecord(record: RuntimeRecord): RuntimeRecord {
  return {
    ...record,
    payload: cloneJsonObject(record.payload),
  };
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return structuredClone(value) as JsonObject;
}
