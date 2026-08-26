// SPDX-License-Identifier: Apache-2.0

import type { SpecJsonValue } from "@mn/specs";

import {
  OpcIdempotencyConflictError,
  OpcRevisionConflictError,
  type OpcAggregateKind,
  type OpcAppendInput,
  type OpcAppendStore,
  type OpcStoredEntry
} from "./types.js";
import {
  aggregateKind,
  createEntry,
  entryKey,
  identifier,
  normalizeAppendBatch,
  requestDigest,
  requestKey
} from "./shared.js";

interface RequestRecord {
  readonly digest: string;
  readonly entry: OpcStoredEntry;
}

export class MemoryOpcStore implements OpcAppendStore {
  #entries = new Map<string, OpcStoredEntry[]>();
  #requests = new Map<string, RequestRecord>();

  async append<T extends SpecJsonValue>(inputValue: OpcAppendInput<T>): Promise<OpcStoredEntry<T>> {
    return (await this.appendBatch([inputValue]))[0]! as OpcStoredEntry<T>;
  }

  async appendBatch(inputValues: readonly OpcAppendInput[]): Promise<readonly OpcStoredEntry[]> {
    const inputs = normalizeAppendBatch(inputValues);
    const entries = new Map(this.#entries);
    const requests = new Map(this.#requests);
    const result: OpcStoredEntry[] = [];
    for (const input of inputs) {
      const request = requestKey(input.tenantId, input.requestId);
      const digest = requestDigest(input);
      const replay = requests.get(request);
      if (replay !== undefined) {
        if (replay.digest !== digest) throw new OpcIdempotencyConflictError(input.requestId);
        result.push(replay.entry);
        continue;
      }
      const key = entryKey(input.tenantId, input.kind, input.id);
      const history = entries.get(key) ?? [];
      if (history.length !== input.expectedRevision) {
        throw new OpcRevisionConflictError(input.expectedRevision, history.length);
      }
      const previous = history.at(-1);
      if (previous !== undefined && Date.parse(input.createdAt) < Date.parse(previous.createdAt)) {
        throw new TypeError("createdAt must not precede the current revision");
      }
      const entry = createEntry(input, history.length + 1, previous);
      entries.set(key, [...history, entry]);
      requests.set(request, { digest, entry });
      result.push(entry);
    }
    this.#entries = entries;
    this.#requests = requests;
    return Object.freeze(result);
  }

  async read<T extends SpecJsonValue = SpecJsonValue>(
    tenantValue: string,
    kind: OpcAggregateKind,
    idValue: string
  ): Promise<OpcStoredEntry<T> | undefined> {
    const key = entryKey(identifier(tenantValue, "tenantId"), aggregateKind(kind), identifier(idValue, "id"));
    return this.#entries.get(key)?.at(-1) as OpcStoredEntry<T> | undefined;
  }

  async history<T extends SpecJsonValue = SpecJsonValue>(
    tenantValue: string,
    kind: OpcAggregateKind,
    idValue: string
  ): Promise<readonly OpcStoredEntry<T>[]> {
    const key = entryKey(identifier(tenantValue, "tenantId"), aggregateKind(kind), identifier(idValue, "id"));
    return Object.freeze([...(this.#entries.get(key) ?? [])]) as readonly OpcStoredEntry<T>[];
  }

  async list<T extends SpecJsonValue = SpecJsonValue>(
    tenantValue: string,
    kind: OpcAggregateKind
  ): Promise<readonly OpcStoredEntry<T>[]> {
    const tenantId = identifier(tenantValue, "tenantId");
    kind = aggregateKind(kind);
    const result: OpcStoredEntry[] = [];
    for (const history of this.#entries.values()) {
      const current = history.at(-1);
      if (current?.tenantId === tenantId && current.kind === kind) result.push(current);
    }
    result.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return Object.freeze(result) as readonly OpcStoredEntry<T>[];
  }

  async close(): Promise<void> {}
}
