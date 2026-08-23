// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  digestJson,
  isAgentSessionEventV1,
  isAgentSessionEventV2,
  isCanonicalRfc3339,
  migrateAgentSessionEventToV3,
  verifyAgentEventV3Chain,
  verifyAgentSessionEventChain,
  verifyAgentSessionEventChainV2,
  type AgentEventV3,
  type AgentSessionEvent,
  type AgentSessionEventV1,
  type AgentSessionEventV2,
  type JsonValue
} from "@mn/agent-protocol";

import type { S3CompatibleArtifactStore } from "./artifactRemoteStore.js";
import { storeEnterpriseAgentEventV3Object } from "./enterpriseAgentV3ObjectStore.js";

export interface EnterpriseLegacyThreadV3 {
  readonly tenantId: string;
  readonly threadId: string;
  readonly header: Readonly<Record<string, unknown>>;
  readonly events: readonly AgentSessionEvent[];
}

export interface EnterpriseStoredEventV3 {
  readonly tenantId: string;
  readonly threadId: string;
  readonly event: AgentEventV3;
  readonly objectKey?: string;
  readonly objectSha256?: string;
  readonly objectBytes?: number;
}

export interface EnterpriseAgentV3MigrationThread {
  readonly tenantId: string;
  readonly threadId: string;
  readonly sourceSchemaVersion: 1 | 2;
  readonly sourceHeaderDigest: string;
  readonly oldChainDigest: string;
  readonly newChainDigest: string;
  readonly eventCount: number;
}

export interface EnterpriseAgentV3MigrationActivation {
  readonly schemaVersion: 3;
  readonly kind: "enterprise-app-server-v3-migration";
  readonly migrationId: string;
  readonly toolVersion: "0.2.0";
  readonly oldRootDigest: string;
  readonly newRootDigest: string;
  readonly threadCount: number;
  readonly eventCount: number;
  readonly threads: readonly EnterpriseAgentV3MigrationThread[];
  readonly events: readonly EnterpriseStoredEventV3[];
}

export interface EnterpriseAgentV3MigrationBackend {
  loadLegacyThreads(): Promise<readonly EnterpriseLegacyThreadV3[]>;
  storeEvent(event: EnterpriseStoredEventV3): Promise<EnterpriseStoredEventV3>;
  activate(input: EnterpriseAgentV3MigrationActivation): Promise<void>;
  rollback(): Promise<EnterpriseAgentV3MigrationActivation>;
}

export interface EnterpriseAgentV3MigrationInspection
  extends Omit<EnterpriseAgentV3MigrationActivation, "events"> {
  readonly mode: "dry-run";
}

export interface EnterpriseAgentV3MigrationApplied
  extends Omit<EnterpriseAgentV3MigrationActivation, "events"> {
  readonly mode: "applied";
}

export interface EnterpriseAgentV3MigrationRolledBack {
  readonly schemaVersion: 3;
  readonly kind: "enterprise-app-server-v3-migration";
  readonly mode: "rolled-back";
  readonly migrationId: string;
  readonly oldRootDigest: string;
  readonly newRootDigest: string;
}

interface PreparedEnterpriseMigration {
  readonly activation: EnterpriseAgentV3MigrationActivation;
  readonly events: readonly EnterpriseStoredEventV3[];
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function headerDigest(header: Readonly<Record<string, unknown>>): string {
  return digestJson(header as unknown as JsonValue);
}

function verifyLegacyThread(thread: EnterpriseLegacyThreadV3): 1 | 2 {
  if (!thread.tenantId.trim() || !thread.threadId.trim() || thread.events.length === 0) {
    throw new Error("enterprise legacy thread identity or event count is invalid");
  }
  const version = thread.header.schemaVersion;
  const created = thread.events[0];
  if (version !== 1 && version !== 2
    || thread.header.sessionId !== thread.threadId
    || !isCanonicalRfc3339(thread.header.createdAt)
    || created?.type !== "session/created"
    || created.sessionId !== thread.threadId
    || created.schemaVersion !== version
    || created.occurredAt !== thread.header.createdAt) {
    throw new Error("enterprise legacy thread header binding is invalid");
  }
  if (version === 1) {
    if (thread.events.some((event) => event.schemaVersion !== 1)) {
      throw new Error("enterprise legacy thread mixes event schemas");
    }
    verifyAgentSessionEventChain(thread.events as readonly AgentSessionEventV1[]);
  } else {
    if (thread.events.some((event) => event.schemaVersion !== 2)) {
      throw new Error("enterprise legacy thread mixes event schemas");
    }
    verifyAgentSessionEventChainV2(thread.events as readonly AgentSessionEventV2[]);
  }
  return version;
}

function prepareEnterpriseMigration(source: readonly EnterpriseLegacyThreadV3[]): PreparedEnterpriseMigration {
  const ordered = [...source].sort((left, right) =>
    left.tenantId.localeCompare(right.tenantId) || left.threadId.localeCompare(right.threadId)
  );
  const seen = new Set<string>();
  const summaries: EnterpriseAgentV3MigrationThread[] = [];
  const events: EnterpriseStoredEventV3[] = [];
  for (const thread of ordered) {
    const key = `${thread.tenantId}\u0000${thread.threadId}`;
    if (seen.has(key)) throw new Error("enterprise legacy thread identity is duplicated");
    seen.add(key);
    const sourceSchemaVersion = verifyLegacyThread(thread);
    const converted: AgentEventV3[] = [];
    for (const event of thread.events) {
      converted.push(migrateAgentSessionEventToV3(event, converted.at(-1)));
    }
    verifyAgentEventV3Chain(converted);
    summaries.push(Object.freeze({
      tenantId: thread.tenantId,
      threadId: thread.threadId,
      sourceSchemaVersion,
      sourceHeaderDigest: headerDigest(thread.header),
      oldChainDigest: thread.events.at(-1)?.digest as string,
      newChainDigest: converted.at(-1)?.digest as string,
      eventCount: converted.length
    }));
    for (const event of converted) events.push({ tenantId: thread.tenantId, threadId: thread.threadId, event });
  }
  const oldRootDigest = digestJson({
    threads: summaries.map((thread) => ({
      tenantId: thread.tenantId,
      threadId: thread.threadId,
      sourceSchemaVersion: thread.sourceSchemaVersion,
      sourceHeaderDigest: thread.sourceHeaderDigest,
      oldChainDigest: thread.oldChainDigest,
      eventCount: thread.eventCount
    }))
  } as unknown as JsonValue);
  const newRootDigest = digestJson({
    threads: summaries.map((thread) => ({
      tenantId: thread.tenantId,
      threadId: thread.threadId,
      newChainDigest: thread.newChainDigest,
      eventCount: thread.eventCount
    }))
  } as unknown as JsonValue);
  const activation: EnterpriseAgentV3MigrationActivation = Object.freeze({
    schemaVersion: 3,
    kind: "enterprise-app-server-v3-migration",
    migrationId: `migration-${newRootDigest.slice(0, 32)}`,
    toolVersion: "0.2.0",
    oldRootDigest,
    newRootDigest,
    threadCount: summaries.length,
    eventCount: events.length,
    threads: Object.freeze(summaries),
    events: Object.freeze([])
  });
  return { activation, events: Object.freeze(events) };
}

function publicResult(
  activation: EnterpriseAgentV3MigrationActivation,
  mode: "dry-run"
): EnterpriseAgentV3MigrationInspection;
function publicResult(
  activation: EnterpriseAgentV3MigrationActivation,
  mode: "applied"
): EnterpriseAgentV3MigrationApplied;
function publicResult(
  activation: EnterpriseAgentV3MigrationActivation,
  mode: "dry-run" | "applied"
): EnterpriseAgentV3MigrationInspection | EnterpriseAgentV3MigrationApplied {
  const { events: _events, ...summary } = activation;
  return Object.freeze({ ...summary, mode });
}

export class EnterpriseAgentV3MigrationJob {
  constructor(private readonly backend: EnterpriseAgentV3MigrationBackend) {}

  async inspect(): Promise<EnterpriseAgentV3MigrationInspection> {
    const prepared = prepareEnterpriseMigration(await this.backend.loadLegacyThreads());
    return publicResult(prepared.activation, "dry-run");
  }

  async apply(): Promise<EnterpriseAgentV3MigrationApplied> {
    const prepared = prepareEnterpriseMigration(await this.backend.loadLegacyThreads());
    const stored: EnterpriseStoredEventV3[] = [];
    for (const event of prepared.events) stored.push(await this.backend.storeEvent(event));
    const activation = Object.freeze({ ...prepared.activation, events: Object.freeze(stored) });
    await this.backend.activate(activation);
    return publicResult(activation, "applied");
  }

  async rollback(): Promise<EnterpriseAgentV3MigrationRolledBack> {
    const activation = await this.backend.rollback();
    return Object.freeze({
      schemaVersion: 3,
      kind: "enterprise-app-server-v3-migration",
      mode: "rolled-back",
      migrationId: activation.migrationId,
      oldRootDigest: activation.oldRootDigest,
      newRootDigest: activation.newRootDigest
    });
  }
}

interface PostgresS3BackendOptions {
  readonly pool: Pool;
  readonly objectStore: S3CompatibleArtifactStore;
  readonly objectPrefix?: string;
  readonly kmsKeyId?: string;
}

interface LegacyEnvelope {
  readonly schemaVersion: 1;
  readonly event: AgentSessionEvent;
  readonly runtimePayload: unknown;
}

export class PostgresS3AgentV3MigrationBackend implements EnterpriseAgentV3MigrationBackend {
  private readonly prefix: string;

  constructor(private readonly options: PostgresS3BackendOptions) {
    this.prefix = (options.objectPrefix ?? "").replace(/^\/+|\/+$/gu, "");
  }

  async loadLegacyThreads(): Promise<readonly EnterpriseLegacyThreadV3[]> {
    const relations = await this.options.pool.query<{
      sessions: string | null;
      events: string | null;
    }>(`
      SELECT
        to_regclass('mn_agent_sessions')::text AS sessions,
        to_regclass('mn_agent_session_events')::text AS events
    `);
    const relation = relations.rows[0];
    if (!relation?.sessions && !relation?.events) return Object.freeze([]);
    if (!relation.sessions || !relation.events) {
      throw new Error("enterprise legacy Agent session schema is incomplete");
    }
    const sessions = await this.options.pool.query<{
      tenant_id: string;
      session_id: string;
      header: Record<string, unknown>;
      last_seq: string;
      last_digest: string;
    }>(`
      SELECT tenant_id,session_id,header,last_seq::text,last_digest
      FROM mn_agent_sessions
      ORDER BY tenant_id,session_id
    `);
    const refs = await this.options.pool.query<{
      tenant_id: string;
      session_id: string;
      seq: string;
      event_digest: string;
      object_key: string;
      object_sha256: string;
      object_bytes: string;
    }>(`
      SELECT tenant_id,session_id,seq::text,event_digest,object_key,object_sha256,object_bytes::text
      FROM mn_agent_session_events
      ORDER BY tenant_id,session_id,seq
    `);
    const byThread = new Map<string, typeof refs.rows>();
    for (const ref of refs.rows) {
      const key = `${ref.tenant_id}\u0000${ref.session_id}`;
      const group = byThread.get(key) ?? [];
      group.push(ref);
      byThread.set(key, group);
    }
    const output: EnterpriseLegacyThreadV3[] = [];
    for (const session of sessions.rows) {
      const key = `${session.tenant_id}\u0000${session.session_id}`;
      const threadRefs = byThread.get(key) ?? [];
      byThread.delete(key);
      if (threadRefs.length !== Number(session.last_seq) + 1 || threadRefs.length > 100_000) {
        throw new Error("enterprise legacy event index count is invalid");
      }
      const events: AgentSessionEvent[] = [];
      for (const ref of threadRefs) {
        const bytes = await this.options.objectStore.getObject(ref.object_key);
        if (!bytes || bytes.byteLength !== Number(ref.object_bytes) || sha256(bytes) !== ref.object_sha256) {
          throw new Error("enterprise legacy S3 event is missing or has a mismatched digest");
        }
        let envelope: LegacyEnvelope;
        try {
          envelope = JSON.parse(bytes.toString("utf8")) as LegacyEnvelope;
        } catch {
          throw new Error("enterprise legacy S3 event contains invalid JSON");
        }
        if (envelope.schemaVersion !== 1
          || !isAgentSessionEventV1(envelope.event) && !isAgentSessionEventV2(envelope.event)
          || envelope.event.sessionId !== session.session_id
          || envelope.event.seq !== Number(ref.seq)
          || envelope.event.digest !== ref.event_digest) {
          throw new Error("enterprise legacy S3 event does not match its PostgreSQL index");
        }
        events.push(envelope.event);
      }
      if (events.at(-1)?.digest !== session.last_digest) {
        throw new Error("enterprise legacy session tail digest is invalid");
      }
      output.push(Object.freeze({
        tenantId: session.tenant_id,
        threadId: session.session_id,
        header: session.header,
        events: Object.freeze(events)
      }));
    }
    if (byThread.size > 0) {
      throw new Error("enterprise legacy event index contains an orphan thread");
    }
    return Object.freeze(output);
  }

  async storeEvent(input: EnterpriseStoredEventV3): Promise<EnterpriseStoredEventV3> {
    const stored = await storeEnterpriseAgentEventV3Object({
      store: this.options.objectStore,
      input,
      prefix: this.prefix,
      ...(this.options.kmsKeyId === undefined ? {} : { kmsKeyId: this.options.kmsKeyId })
    });
    return Object.freeze({ ...input, ...stored });
  }

  async activate(input: EnterpriseAgentV3MigrationActivation): Promise<void> {
    await this.createSchema();
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      const relations = await client.query<{
        sessions: string | null;
        events: string | null;
      }>(`
        SELECT
          to_regclass('mn_agent_sessions')::text AS sessions,
          to_regclass('mn_agent_session_events')::text AS events
      `);
      const relation = relations.rows[0];
      if (relation?.sessions && relation.events) {
        await client.query("LOCK TABLE mn_agent_sessions IN ACCESS EXCLUSIVE MODE");
        await client.query("LOCK TABLE mn_agent_session_events IN ACCESS EXCLUSIVE MODE");
        await this.verifyLegacyRelationalSnapshot(client, input);
      } else if (relation?.sessions || relation?.events) {
        throw new Error("enterprise legacy Agent session schema is incomplete");
      } else if (input.threadCount !== 0 || input.eventCount !== 0) {
        throw new Error("enterprise legacy Agent session schema changed during migration preflight");
      }
      const existing = await client.query<{ manifest: EnterpriseAgentV3MigrationActivation; status: string }>(`
        SELECT manifest,status FROM mn_agent_migrations_v3 WHERE migration_id=$1
      `, [input.migrationId]);
      if (existing.rows[0]) {
        if (existing.rows[0].status !== "applied"
          || existing.rows[0].manifest.newRootDigest !== input.newRootDigest) {
          throw new Error("enterprise V3 migration identifier conflicts with existing state");
        }
        await client.query("COMMIT");
        return;
      }
      await client.query(`
        INSERT INTO mn_agent_migrations_v3(migration_id,status,manifest,created_at,updated_at)
        VALUES ($1,'applying',$2::jsonb,now(),now())
      `, [input.migrationId, JSON.stringify({ ...input, events: [] })]);
      for (const thread of input.threads) {
        await client.query(`
          INSERT INTO mn_agent_threads_v3
            (tenant_id,thread_id,migration_id,last_sequence,last_digest,source_header_digest,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,now(),now())
        `, [
          thread.tenantId,
          thread.threadId,
          input.migrationId,
          thread.eventCount - 1,
          thread.newChainDigest,
          thread.sourceHeaderDigest
        ]);
      }
      for (const event of input.events) {
        if (!event.objectKey || !event.objectSha256 || event.objectBytes === undefined) {
          throw new Error("enterprise V3 migration event has no immutable object receipt");
        }
        await client.query(`
          INSERT INTO mn_agent_events_v3
            (tenant_id,thread_id,sequence,event_id,event_digest,source_event_digest,
             object_key,object_sha256,object_bytes,migration_id,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)
        `, [
          event.tenantId,
          event.threadId,
          event.event.sequence,
          event.event.eventId,
          event.event.digest,
          event.event.source?.eventDigest ?? null,
          event.objectKey,
          event.objectSha256,
          event.objectBytes,
          input.migrationId,
          event.event.occurredAt
        ]);
      }
      await client.query(`
        UPDATE mn_agent_migrations_v3 SET status='applied',updated_at=now() WHERE migration_id=$1
      `, [input.migrationId]);
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async rollback(): Promise<EnterpriseAgentV3MigrationActivation> {
    await this.createSchema();
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE mn_agent_threads_v3 IN ACCESS EXCLUSIVE MODE");
      await client.query("LOCK TABLE mn_agent_events_v3 IN ACCESS EXCLUSIVE MODE");
      const active = await client.query<{ migration_id: string; manifest: EnterpriseAgentV3MigrationActivation }>(`
        SELECT migration_id,manifest
        FROM mn_agent_migrations_v3
        WHERE status='applied'
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `);
      const row = active.rows[0];
      if (!row) throw new Error("no applied enterprise V3 migration is available for rollback");
      const count = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM mn_agent_events_v3
      `);
      if (Number(count.rows[0]?.count) !== row.manifest.eventCount) {
        throw new Error("rollback refused because an enterprise V3 write changed the event count");
      }
      for (const thread of row.manifest.threads) {
        const current = await client.query<{ last_sequence: string; last_digest: string }>(`
          SELECT last_sequence::text,last_digest
          FROM mn_agent_threads_v3
          WHERE tenant_id=$1 AND thread_id=$2
        `, [thread.tenantId, thread.threadId]);
        if (Number(current.rows[0]?.last_sequence) !== thread.eventCount - 1
          || current.rows[0]?.last_digest !== thread.newChainDigest) {
          throw new Error("rollback refused because an enterprise V3 write changed a thread digest");
        }
      }
      await client.query(`
        UPDATE mn_agent_migrations_v3 SET status='rolled_back',updated_at=now() WHERE migration_id=$1
      `, [row.migration_id]);
      await client.query("COMMIT");
      return row.manifest;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async createSchema(): Promise<void> {
    await this.options.pool.query(`
      CREATE TABLE IF NOT EXISTS mn_agent_migrations_v3 (
        migration_id text PRIMARY KEY,
        status text NOT NULL CHECK (status IN ('applying','applied','rolled_back')),
        manifest jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mn_agent_migrations_v3_one_active
        ON mn_agent_migrations_v3 ((true))
        WHERE status IN ('applying','applied');
      CREATE TABLE IF NOT EXISTS mn_agent_threads_v3 (
        tenant_id text NOT NULL,
        thread_id text NOT NULL,
        owner_subject text,
        migration_id text REFERENCES mn_agent_migrations_v3(migration_id) ON DELETE RESTRICT,
        last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
        last_digest char(64) NOT NULL,
        source_header_digest char(64),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id,thread_id)
      );
      CREATE TABLE IF NOT EXISTS mn_agent_events_v3 (
        tenant_id text NOT NULL,
        thread_id text NOT NULL,
        sequence bigint NOT NULL CHECK (sequence >= 0),
        event_id text NOT NULL,
        event_digest char(64) NOT NULL,
        source_event_digest char(64),
        object_key text NOT NULL,
        object_sha256 char(64) NOT NULL,
        object_bytes bigint NOT NULL CHECK (object_bytes > 0),
        migration_id text REFERENCES mn_agent_migrations_v3(migration_id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id,thread_id,sequence),
        UNIQUE (tenant_id,thread_id,event_id),
        FOREIGN KEY (tenant_id,thread_id)
          REFERENCES mn_agent_threads_v3(tenant_id,thread_id) ON DELETE RESTRICT
      );
    `);
  }

  private async verifyLegacyRelationalSnapshot(
    client: PoolClient,
    input: EnterpriseAgentV3MigrationActivation
  ): Promise<void> {
    const summaries: EnterpriseAgentV3MigrationThread[] = [];
    for (const expected of input.threads) {
      const current = await client.query<{
        header: Record<string, unknown>;
        last_seq: string;
        last_digest: string;
      }>(`
        SELECT header,last_seq::text,last_digest
        FROM mn_agent_sessions
        WHERE tenant_id=$1 AND session_id=$2
      `, [expected.tenantId, expected.threadId]);
      const row = current.rows[0];
      if (!row || Number(row.last_seq) !== expected.eventCount - 1
        || row.last_digest !== expected.oldChainDigest
        || headerDigest(row.header) !== expected.sourceHeaderDigest) {
        throw new Error("enterprise legacy state changed during migration preflight");
      }
      summaries.push(expected);
    }
    const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM mn_agent_sessions");
    if (Number(count.rows[0]?.count) !== input.threadCount) {
      throw new Error("enterprise legacy thread count changed during migration preflight");
    }
    const eventRefs = await client.query<{
      tenant_id: string;
      session_id: string;
      seq: string;
      event_digest: string;
      object_key: string;
      object_sha256: string;
      object_bytes: string;
    }>(`
      SELECT tenant_id,session_id,seq::text,event_digest,object_key,object_sha256,object_bytes::text
      FROM mn_agent_session_events
      ORDER BY tenant_id,session_id,seq
    `);
    if (eventRefs.rows.length !== input.eventCount || input.events.length !== input.eventCount) {
      throw new Error("enterprise legacy event count changed during migration preflight");
    }
    for (const [index, ref] of eventRefs.rows.entries()) {
      const expected = input.events[index];
      if (!expected?.event.source
        || ref.tenant_id !== expected.tenantId
        || ref.session_id !== expected.threadId
        || Number(ref.seq) !== expected.event.sequence
        || ref.event_digest !== expected.event.source.eventDigest) {
        throw new Error("enterprise legacy event index changed during migration preflight");
      }
      const bytes = await this.options.objectStore.getObject(ref.object_key);
      if (!bytes || bytes.byteLength !== Number(ref.object_bytes) || sha256(bytes) !== ref.object_sha256) {
        throw new Error("enterprise legacy S3 event changed during migration preflight");
      }
      let envelope: LegacyEnvelope;
      try {
        envelope = JSON.parse(bytes.toString("utf8")) as LegacyEnvelope;
      } catch {
        throw new Error("enterprise legacy S3 event changed during migration preflight");
      }
      if (envelope.event?.digest !== expected.event.source.eventDigest) {
        throw new Error("enterprise legacy S3 event changed during migration preflight");
      }
    }
    const oldRootDigest = digestJson({
      threads: summaries.map((thread) => ({
        tenantId: thread.tenantId,
        threadId: thread.threadId,
        sourceSchemaVersion: thread.sourceSchemaVersion,
        sourceHeaderDigest: thread.sourceHeaderDigest,
        oldChainDigest: thread.oldChainDigest,
        eventCount: thread.eventCount
      }))
    } as unknown as JsonValue);
    if (oldRootDigest !== input.oldRootDigest) {
      throw new Error("enterprise legacy root digest changed during migration preflight");
    }
  }
}
