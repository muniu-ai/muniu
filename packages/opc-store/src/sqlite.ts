// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalFrozenClone, canonicalJson, type SpecJsonValue } from "@mn/specs";

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
  identifier,
  normalizeAppendBatch,
  requestDigest
} from "./shared.js";

interface EntryRow {
  tenant_id: string;
  aggregate_kind: OpcAggregateKind;
  aggregate_id: string;
  revision: number;
  request_id: string;
  value_json: string;
  value_digest: string;
  previous_digest: string | null;
  digest: string;
  created_at: string;
}

function fromRow<T extends SpecJsonValue>(row: EntryRow): OpcStoredEntry<T> {
  return canonicalFrozenClone({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    kind: row.aggregate_kind,
    id: row.aggregate_id,
    revision: Number(row.revision),
    requestId: row.request_id,
    value: JSON.parse(row.value_json) as T,
    valueDigest: row.value_digest,
    ...(row.previous_digest === null ? {} : { previousDigest: row.previous_digest }),
    digest: row.digest,
    createdAt: row.created_at
  });
}

export class SqliteOpcStore implements OpcAppendStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(readonly databaseFile: string) {
    const resolved = path.resolve(databaseFile);
    const directory = path.dirname(resolved);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryDescriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      if (!fstatSync(directoryDescriptor).isDirectory()) {
        throw new Error("SQLite OPC directory must be a private non-symlink directory");
      }
      fchmodSync(directoryDescriptor, 0o700);
    } finally {
      closeSync(directoryDescriptor);
    }
    const descriptor = openSync(
      resolved,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    );
    try {
      if (!fstatSync(descriptor).isFile()) throw new Error("SQLite OPC path must be a regular file");
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
    this.#database = new DatabaseSync(resolved);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS opc_entries (
        tenant_id TEXT NOT NULL,
        aggregate_kind TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        request_id TEXT NOT NULL,
        value_json TEXT NOT NULL,
        value_digest TEXT NOT NULL CHECK (length(value_digest) = 64),
        previous_digest TEXT,
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, aggregate_kind, aggregate_id, revision)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS opc_entries_tenant_kind_created_idx
        ON opc_entries (tenant_id, aggregate_kind, created_at, aggregate_id, revision);
      CREATE TABLE IF NOT EXISTS opc_requests (
        tenant_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
        aggregate_kind TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, request_id),
        FOREIGN KEY (tenant_id, aggregate_kind, aggregate_id, revision)
          REFERENCES opc_entries (tenant_id, aggregate_kind, aggregate_id, revision)
      ) STRICT;
    `);
  }

  async append<T extends SpecJsonValue>(inputValue: OpcAppendInput<T>): Promise<OpcStoredEntry<T>> {
    return (await this.appendBatch([inputValue]))[0]! as OpcStoredEntry<T>;
  }

  async appendBatch(inputValues: readonly OpcAppendInput[]): Promise<readonly OpcStoredEntry[]> {
    this.assertOpen();
    const inputs = normalizeAppendBatch(inputValues);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const entries = inputs.map((input) => this.appendWithinTransaction(input));
      this.#database.exec("COMMIT");
      return Object.freeze(entries);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async read<T extends SpecJsonValue = SpecJsonValue>(
    tenantValue: string,
    kind: OpcAggregateKind,
    idValue: string
  ): Promise<OpcStoredEntry<T> | undefined> {
    this.assertOpen();
    return this.latest(identifier(tenantValue, "tenantId"), aggregateKind(kind), identifier(idValue, "id")) as OpcStoredEntry<T> | undefined;
  }

  async history<T extends SpecJsonValue = SpecJsonValue>(
    tenantValue: string,
    kind: OpcAggregateKind,
    idValue: string
  ): Promise<readonly OpcStoredEntry<T>[]> {
    this.assertOpen();
    const rows = this.#database.prepare(`
      SELECT * FROM opc_entries
      WHERE tenant_id = ? AND aggregate_kind = ? AND aggregate_id = ?
      ORDER BY revision
    `).all(identifier(tenantValue, "tenantId"), aggregateKind(kind), identifier(idValue, "id")) as unknown as EntryRow[];
    return Object.freeze(rows.map((row) => fromRow<T>(row)));
  }

  async list<T extends SpecJsonValue = SpecJsonValue>(
    tenantValue: string,
    kind: OpcAggregateKind
  ): Promise<readonly OpcStoredEntry<T>[]> {
    this.assertOpen();
    const rows = this.#database.prepare(`
      SELECT entry.* FROM opc_entries entry
      JOIN (
        SELECT tenant_id, aggregate_kind, aggregate_id, max(revision) AS revision
        FROM opc_entries WHERE tenant_id = ? AND aggregate_kind = ?
        GROUP BY tenant_id, aggregate_kind, aggregate_id
      ) latest
      ON latest.tenant_id = entry.tenant_id
        AND latest.aggregate_kind = entry.aggregate_kind
        AND latest.aggregate_id = entry.aggregate_id
        AND latest.revision = entry.revision
      ORDER BY entry.created_at, entry.aggregate_id
    `).all(identifier(tenantValue, "tenantId"), aggregateKind(kind)) as unknown as EntryRow[];
    return Object.freeze(rows.map((row) => fromRow<T>(row)));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  private latest(tenantId: string, kind: OpcAggregateKind, id: string): OpcStoredEntry | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM opc_entries
      WHERE tenant_id = ? AND aggregate_kind = ? AND aggregate_id = ?
      ORDER BY revision DESC LIMIT 1
    `).get(tenantId, kind, id) as unknown as EntryRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  private appendWithinTransaction<T extends SpecJsonValue>(
    input: OpcAppendInput<T>
  ): OpcStoredEntry<T> {
    const semanticDigest = requestDigest(input);
    const request = this.#database.prepare(`
      SELECT request_digest, aggregate_kind, aggregate_id, revision
      FROM opc_requests WHERE tenant_id = ? AND request_id = ?
    `).get(input.tenantId, input.requestId) as {
      request_digest: string;
      aggregate_kind: OpcAggregateKind;
      aggregate_id: string;
      revision: number;
    } | undefined;
    if (request !== undefined) {
      if (request.request_digest !== semanticDigest) {
        throw new OpcIdempotencyConflictError(input.requestId);
      }
      const replay = this.entryAt(
        input.tenantId,
        request.aggregate_kind,
        request.aggregate_id,
        Number(request.revision)
      );
      if (replay === undefined) throw new Error("OPC idempotency entry is missing");
      return replay as OpcStoredEntry<T>;
    }
    const previous = this.latest(input.tenantId, input.kind, input.id);
    const actualRevision = previous?.revision ?? 0;
    if (actualRevision !== input.expectedRevision) {
      throw new OpcRevisionConflictError(input.expectedRevision, actualRevision);
    }
    if (previous !== undefined && Date.parse(input.createdAt) < Date.parse(previous.createdAt)) {
      throw new TypeError("createdAt must not precede the current revision");
    }
    const entry = createEntry(input, actualRevision + 1, previous);
    this.#database.prepare(`
      INSERT INTO opc_entries
        (tenant_id, aggregate_kind, aggregate_id, revision, request_id, value_json,
         value_digest, previous_digest, digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.tenantId,
      entry.kind,
      entry.id,
      entry.revision,
      entry.requestId,
      canonicalJson(entry.value),
      entry.valueDigest,
      entry.previousDigest ?? null,
      entry.digest,
      entry.createdAt
    );
    this.#database.prepare(`
      INSERT INTO opc_requests
        (tenant_id, request_id, request_digest, aggregate_kind, aggregate_id, revision)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entry.tenantId, entry.requestId, semanticDigest, entry.kind, entry.id, entry.revision);
    return entry;
  }

  private entryAt(
    tenantId: string,
    kind: OpcAggregateKind,
    id: string,
    revision: number
  ): OpcStoredEntry | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM opc_entries
      WHERE tenant_id = ? AND aggregate_kind = ? AND aggregate_id = ? AND revision = ?
    `).get(tenantId, kind, id, revision) as unknown as EntryRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("SQLite OPC store is closed");
  }
}
