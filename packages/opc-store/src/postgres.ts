// SPDX-License-Identifier: Apache-2.0

import type { Pool, PoolClient } from "pg";
import { canonicalFrozenClone, type SpecJsonValue } from "@mn/specs";

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
  normalizeAppendInput,
  requestDigest
} from "./shared.js";

const TABLE_BY_KIND: Readonly<Record<OpcAggregateKind, string>> = Object.freeze({
  record: "domain_record_revisions",
  operation_run: "operation_runs",
  operation_event: "operation_events",
  attention_item: "attention_items",
  action_intent: "action_intents",
  authority_decision: "authority_decisions",
  effect_receipt: "effect_receipts",
  settlement_record: "settlement_records",
  publication_outbox: "publication_outbox",
  publication_receipt: "publication_receipts",
  business_pack_binding: "business_pack_bindings"
});

const TABLES = Object.values(TABLE_BY_KIND);

function tableMigration(table: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      tenant_id text NOT NULL,
      aggregate_id text NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      request_id text NOT NULL,
      value_digest char(64) NOT NULL,
      previous_digest char(64),
      digest char(64) NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, aggregate_id, revision)
    );
    CREATE INDEX IF NOT EXISTS ${table}_tenant_created_idx
      ON ${table} (tenant_id, created_at, aggregate_id, revision);
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS ${table}_tenant_policy ON ${table};
    CREATE POLICY ${table}_tenant_policy ON ${table}
      USING (tenant_id = current_setting('mn.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('mn.tenant_id', true));
  `;
}

export const POSTGRES_OPC_MIGRATION_V1 = `
  ${TABLES.map(tableMigration).join("\n")}
  CREATE TABLE IF NOT EXISTS opc_idempotency_requests (
    tenant_id text NOT NULL,
    request_id text NOT NULL,
    request_digest char(64) NOT NULL,
    aggregate_kind text NOT NULL,
    aggregate_id text NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS opc_idempotency_requests_tenant_created_idx
    ON opc_idempotency_requests (tenant_id, created_at, request_id);
  ALTER TABLE opc_idempotency_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE opc_idempotency_requests FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS opc_idempotency_requests_tenant_policy ON opc_idempotency_requests;
  CREATE POLICY opc_idempotency_requests_tenant_policy ON opc_idempotency_requests
    USING (tenant_id = current_setting('mn.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('mn.tenant_id', true));
`;

interface EntryRow {
  tenant_id: string;
  aggregate_id: string;
  revision: string | number;
  request_id: string;
  value_digest: string;
  previous_digest: string | null;
  digest: string;
  payload: SpecJsonValue;
  created_at: string | Date;
}

function fromRow<T extends SpecJsonValue>(kind: OpcAggregateKind, row: EntryRow): OpcStoredEntry<T> {
  return canonicalFrozenClone({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    kind,
    id: row.aggregate_id,
    revision: Number(row.revision),
    requestId: row.request_id,
    value: row.payload as T,
    valueDigest: row.value_digest,
    ...(row.previous_digest === null ? {} : { previousDigest: row.previous_digest }),
    digest: row.digest,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  });
}

export class PostgresOpcStore implements OpcAppendStore {
  constructor(readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(POSTGRES_OPC_MIGRATION_V1);
  }

  async append<T extends SpecJsonValue>(inputValue: OpcAppendInput<T>): Promise<OpcStoredEntry<T>> {
    const input = normalizeAppendInput(inputValue);
    const table = TABLE_BY_KIND[input.kind];
    const semanticDigest = requestDigest(input);
    return this.transaction(input.tenantId, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${input.tenantId}\0${input.kind}\0${input.id}`]
      );
      const replayRequest = await client.query<{
        request_digest: string;
        aggregate_kind: OpcAggregateKind;
        aggregate_id: string;
        revision: string;
      }>(`
        SELECT request_digest, aggregate_kind, aggregate_id, revision
        FROM opc_idempotency_requests
        WHERE tenant_id = $1 AND request_id = $2
      `, [input.tenantId, input.requestId]);
      const replay = replayRequest.rows[0];
      if (replay !== undefined) {
        if (replay.request_digest !== semanticDigest) {
          throw new OpcIdempotencyConflictError(input.requestId);
        }
        const replayKind = replay.aggregate_kind;
        const replayTable = TABLE_BY_KIND[replayKind];
        if (replayTable === undefined) throw new Error("OPC idempotency aggregate kind is invalid");
        const stored = await client.query<EntryRow>(`
          SELECT * FROM ${replayTable}
          WHERE tenant_id = $1 AND aggregate_id = $2 AND revision = $3
        `, [input.tenantId, replay.aggregate_id, replay.revision]);
        if (stored.rows[0] === undefined) throw new Error("OPC idempotency entry is missing");
        return fromRow<T>(replayKind, stored.rows[0]);
      }
      const currentResult = await client.query<EntryRow>(`
        SELECT * FROM ${table}
        WHERE tenant_id = $1 AND aggregate_id = $2
        ORDER BY revision DESC LIMIT 1 FOR UPDATE
      `, [input.tenantId, input.id]);
      const previous = currentResult.rows[0] === undefined
        ? undefined
        : fromRow(input.kind, currentResult.rows[0]);
      const actualRevision = previous?.revision ?? 0;
      if (actualRevision !== input.expectedRevision) {
        throw new OpcRevisionConflictError(input.expectedRevision, actualRevision);
      }
      if (previous !== undefined && Date.parse(input.createdAt) < Date.parse(previous.createdAt)) {
        throw new TypeError("createdAt must not precede the current revision");
      }
      const entry = createEntry(input, actualRevision + 1, previous);
      await client.query(`
        INSERT INTO ${table}
          (tenant_id, aggregate_id, revision, request_id, value_digest,
           previous_digest, digest, payload, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      `, [
        entry.tenantId,
        entry.id,
        entry.revision,
        entry.requestId,
        entry.valueDigest,
        entry.previousDigest ?? null,
        entry.digest,
        JSON.stringify(entry.value),
        entry.createdAt
      ]);
      await client.query(`
        INSERT INTO opc_idempotency_requests
          (tenant_id, request_id, request_digest, aggregate_kind, aggregate_id, revision, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        entry.tenantId,
        entry.requestId,
        semanticDigest,
        entry.kind,
        entry.id,
        entry.revision,
        entry.createdAt
      ]);
      return entry;
    });
  }

  async read<T extends SpecJsonValue = SpecJsonValue>(
    tenantValue: string,
    kind: OpcAggregateKind,
    idValue: string
  ): Promise<OpcStoredEntry<T> | undefined> {
    const tenantId = identifier(tenantValue, "tenantId");
    const id = identifier(idValue, "id");
    kind = aggregateKind(kind);
    return this.transaction(tenantId, async (client) => {
      const result = await client.query<EntryRow>(`
        SELECT * FROM ${TABLE_BY_KIND[kind]}
        WHERE tenant_id = $1 AND aggregate_id = $2
        ORDER BY revision DESC LIMIT 1
      `, [tenantId, id]);
      return result.rows[0] === undefined ? undefined : fromRow<T>(kind, result.rows[0]);
    });
  }

  async history<T extends SpecJsonValue = SpecJsonValue>(
    tenantValue: string,
    kind: OpcAggregateKind,
    idValue: string
  ): Promise<readonly OpcStoredEntry<T>[]> {
    const tenantId = identifier(tenantValue, "tenantId");
    const id = identifier(idValue, "id");
    kind = aggregateKind(kind);
    return this.transaction(tenantId, async (client) => {
      const result = await client.query<EntryRow>(`
        SELECT * FROM ${TABLE_BY_KIND[kind]}
        WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY revision
      `, [tenantId, id]);
      return Object.freeze(result.rows.map((row) => fromRow<T>(kind, row)));
    });
  }

  async list<T extends SpecJsonValue = SpecJsonValue>(
    tenantValue: string,
    kind: OpcAggregateKind
  ): Promise<readonly OpcStoredEntry<T>[]> {
    const tenantId = identifier(tenantValue, "tenantId");
    kind = aggregateKind(kind);
    return this.transaction(tenantId, async (client) => {
      const result = await client.query<EntryRow>(`
        SELECT DISTINCT ON (tenant_id, aggregate_id) *
        FROM ${TABLE_BY_KIND[kind]}
        WHERE tenant_id = $1
        ORDER BY tenant_id, aggregate_id, revision DESC
      `, [tenantId]);
      return Object.freeze(result.rows
        .map((row) => fromRow<T>(kind, row))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
    });
  }

  async close(): Promise<void> {}

  private async transaction<T>(tenantId: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('mn.tenant_id', $1, true)", [tenantId]);
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
