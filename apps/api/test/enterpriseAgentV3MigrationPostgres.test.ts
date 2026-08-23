// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

import {
  EventId,
  SessionId,
  createAgentSessionEventV2,
  protectAgentSessionPayloadV2
} from "@mn/agent-protocol";

import type {
  S3CompatibleArtifactStore,
  S3PutArtifactOptions
} from "../src/artifactRemoteStore.js";
import {
  EnterpriseAgentV3MigrationJob,
  PostgresS3AgentV3MigrationBackend
} from "../src/enterpriseAgentV3Migration.js";

const connectionString = process.env.MN_TEST_POSTGRES_URL;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class MemoryObjectStore {
  readonly objects = new Map<string, Buffer>();

  async getObject(key: string): Promise<Buffer | undefined> {
    const value = this.objects.get(key);
    return value === undefined ? undefined : Buffer.from(value);
  }

  async putObject(key: string, content: Buffer, options: S3PutArtifactOptions = {}) {
    if (options.ifNoneMatch === "*" && this.objects.has(key)) {
      throw new Error("unexpected create-only conflict in PostgreSQL migration test");
    }
    const bytes = Buffer.from(content);
    this.objects.set(key, bytes);
    return { key, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
}

test(
  "PostgreSQL migration initializes V3 tables when no legacy Agent tables exist",
  { skip: !connectionString },
  async (t) => {
    const admin = new Pool({ connectionString, max: 1 });
    const schema = `mn_v3_empty_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString, max: 1, options: `-c search_path=${schema}` });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });

    const job = new EnterpriseAgentV3MigrationJob(new PostgresS3AgentV3MigrationBackend({
      pool,
      objectStore: new MemoryObjectStore() as unknown as S3CompatibleArtifactStore,
      objectPrefix: "migration-empty-test"
    }));
    const applied = await job.apply();
    assert.equal(applied.threadCount, 0);
    assert.equal(applied.eventCount, 0);
    const counts = await pool.query<{ migrations: string; events: string; threads: string }>(`
      SELECT
        (SELECT count(*)::text FROM mn_agent_migrations_v3) AS migrations,
        (SELECT count(*)::text FROM mn_agent_events_v3) AS events,
        (SELECT count(*)::text FROM mn_agent_threads_v3) AS threads
    `);
    assert.deepEqual(counts.rows, [{ migrations: "1", events: "0", threads: "0" }]);
  }
);

test(
  "PostgreSQL and S3 migration atomically activates V3 indexes and keeps rollback facts",
  { skip: !connectionString },
  async (t) => {
    const admin = new Pool({ connectionString, max: 1 });
    const schema = `mn_v3_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString, max: 1, options: `-c search_path=${schema}` });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    await pool.query(`
      CREATE TABLE mn_agent_sessions (
        tenant_id text NOT NULL,
        session_id text NOT NULL,
        header jsonb NOT NULL,
        last_seq bigint NOT NULL,
        last_digest char(64) NOT NULL,
        PRIMARY KEY (tenant_id,session_id)
      );
      CREATE TABLE mn_agent_session_events (
        tenant_id text NOT NULL,
        session_id text NOT NULL,
        seq bigint NOT NULL,
        event_digest char(64) NOT NULL,
        object_key text NOT NULL,
        object_sha256 char(64) NOT NULL,
        object_bytes bigint NOT NULL,
        PRIMARY KEY (tenant_id,session_id,seq)
      );
    `);

    const sessionId = SessionId("session-enterprise-postgres-v3");
    const created = createAgentSessionEventV2({
      eventId: EventId("event-enterprise-postgres-created"),
      sessionId,
      seq: 0,
      occurredAt: "2026-08-23T00:00:00.000Z",
      type: "session/created",
      payload: protectAgentSessionPayloadV2("session/created", {
        cwd: "/workspace/project",
        modelBinding: {
          schemaVersion: 1,
          kind: "agent-model-binding",
          providerId: "openai",
          modelId: "gpt-5"
        }
      })
    });
    const turn = createAgentSessionEventV2({
      eventId: EventId("event-enterprise-postgres-turn"),
      sessionId,
      seq: 1,
      occurredAt: "2026-08-23T00:00:01.000Z",
      type: "turn/start",
      payload: protectAgentSessionPayloadV2("turn/start", { turn: 1 }),
      previousDigest: created.digest
    });
    const store = new MemoryObjectStore();
    for (const event of [created, turn]) {
      const key = `legacy/${event.seq}.json`;
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, event, runtimePayload: null }));
      store.objects.set(key, bytes);
      await pool.query(`
        INSERT INTO mn_agent_session_events
          (tenant_id,session_id,seq,event_digest,object_key,object_sha256,object_bytes)
        VALUES ('tenant-v3',$1,$2,$3,$4,$5,$6)
      `, [sessionId, event.seq, event.digest, key, sha256(bytes), bytes.byteLength]);
    }
    await pool.query(`
      INSERT INTO mn_agent_sessions(tenant_id,session_id,header,last_seq,last_digest)
      VALUES ('tenant-v3',$1,$2::jsonb,1,$3)
    `, [sessionId, JSON.stringify({
      schemaVersion: 2,
      sessionId,
      createdAt: created.occurredAt
    }), turn.digest]);

    const job = new EnterpriseAgentV3MigrationJob(new PostgresS3AgentV3MigrationBackend({
      pool,
      objectStore: store as unknown as S3CompatibleArtifactStore,
      objectPrefix: "migration-test"
    }));
    const dryRun = await job.inspect();
    assert.equal(dryRun.eventCount, 2);
    const applied = await job.apply();
    assert.equal(applied.newRootDigest, dryRun.newRootDigest);
    const counts = await pool.query<{ events: string; threads: string }>(`
      SELECT
        (SELECT count(*)::text FROM mn_agent_events_v3) AS events,
        (SELECT count(*)::text FROM mn_agent_threads_v3) AS threads
    `);
    assert.deepEqual(counts.rows, [{ events: "2", threads: "1" }]);
    const migration = await pool.query<{ status: string; event_receipts: number }>(`
      SELECT status,jsonb_array_length(manifest->'events') AS event_receipts
      FROM mn_agent_migrations_v3
    `);
    assert.deepEqual(migration.rows, [{ status: "applied", event_receipts: 0 }]);

    assert.equal((await job.rollback()).mode, "rolled-back");
    const retained = await pool.query<{ migrations: string; events: string }>(`
      SELECT
        (SELECT count(*)::text FROM mn_agent_migrations_v3) AS migrations,
        (SELECT count(*)::text FROM mn_agent_events_v3) AS events
    `);
    assert.deepEqual(retained.rows, [{ migrations: "1", events: "2" }]);
  }
);
