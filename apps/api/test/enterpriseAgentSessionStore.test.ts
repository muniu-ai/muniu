// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";
import {
  MessageId,
  SessionId,
  createUserMessage
} from "@mn/agent-protocol";
import type { S3CompatibleArtifactStore, S3PutArtifactOptions } from "../src/artifactRemoteStore.js";
import { createEnterpriseAgentSessionStore } from "../src/enterpriseAgentSessionStore.js";

interface SessionRow {
  header: unknown;
  lastSeq: number;
  lastDigest: string;
  updatedAt: string;
}

interface EventRow {
  seq: number;
  eventDigest: string;
  objectKey: string;
  objectSha256: string;
  objectBytes: number;
}

class MemoryPg {
  readonly sessions = new Map<string, SessionRow>();
  readonly events = new Map<string, EventRow[]>();
  readonly statements: string[] = [];

  readonly pool = {
    query: (text: string, values?: unknown[]) => this.query(text, values),
    connect: async () => ({
      query: (text: string, values?: unknown[]) => this.query(text, values),
      release() {}
    } as unknown as PoolClient)
  } as unknown as Pool;

  private key(tenant: unknown, session: unknown): string {
    return `${String(tenant)}\u0000${String(session)}`;
  }

  private async query(text: string, values: unknown[] = []): Promise<QueryResult> {
    const sql = text.replace(/\s+/gu, " ").trim();
    this.statements.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("CREATE TABLE")) {
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }
    if (sql.startsWith("INSERT INTO mn_agent_sessions")) {
      const key = this.key(values[0], values[1]);
      if (this.sessions.has(key)) throw new Error("duplicate session");
      this.sessions.set(key, {
        header: JSON.parse(String(values[2])),
        lastSeq: 0,
        lastDigest: String(values[3]),
        updatedAt: String(values[4])
      });
      return { rows: [], rowCount: 1 } as unknown as QueryResult;
    }
    if (sql.startsWith("INSERT INTO mn_agent_session_events")) {
      const key = this.key(values[0], values[1]);
      const rows = this.events.get(key) ?? [];
      const seq = Number(values[2]);
      if (rows.some((row) => row.seq === seq)) throw new Error("duplicate event");
      rows.push({
        seq,
        eventDigest: String(values[3]),
        objectKey: String(values[4]),
        objectSha256: String(values[5]),
        objectBytes: Number(values[6])
      });
      this.events.set(key, rows);
      return { rows: [], rowCount: 1 } as unknown as QueryResult;
    }
    if (sql.includes("SELECT last_seq::text,last_digest") && sql.includes("FOR UPDATE")) {
      const row = this.sessions.get(this.key(values[0], values[1]));
      return {
        rows: row ? [{ last_seq: String(row.lastSeq), last_digest: row.lastDigest }] : [],
        rowCount: row ? 1 : 0
      } as unknown as QueryResult;
    }
    if (sql.startsWith("UPDATE mn_agent_sessions")) {
      const key = this.key(values[0], values[1]);
      const row = this.sessions.get(key);
      if (!row) throw new Error("missing session");
      row.lastSeq = Number(values[2]);
      row.lastDigest = String(values[3]);
      row.updatedAt = String(values[4]);
      return { rows: [], rowCount: 1 } as unknown as QueryResult;
    }
    if (sql.includes("SELECT header,last_seq::text")) {
      const row = this.sessions.get(this.key(values[0], values[1]));
      return {
        rows: row ? [{ header: structuredClone(row.header), last_seq: String(row.lastSeq) }] : [],
        rowCount: row ? 1 : 0
      } as unknown as QueryResult;
    }
    if (sql.includes("SELECT events.seq::text,events.event_digest")
      && sql.includes("FROM mn_agent_session_events AS events")) {
      const rows = (this.events.get(this.key(values[0], values[1])) ?? [])
        .slice()
        // PostgreSQL resolves an unqualified ORDER BY name to the output
        // alias. `SELECT seq::text ... ORDER BY seq` therefore sorts text as
        // 0,1,10,...,2. Preserve that behavior in the fake so the test guards
        // the qualified bigint ordering used by the production query.
        .sort(sql.includes("ORDER BY events.seq")
          ? (left, right) => left.seq - right.seq
          : (left, right) => String(left.seq).localeCompare(String(right.seq)))
        .map((row) => ({
          seq: String(row.seq),
          event_digest: row.eventDigest,
          object_key: row.objectKey,
          object_sha256: row.objectSha256,
          object_bytes: String(row.objectBytes)
        }));
      return { rows, rowCount: rows.length } as unknown as QueryResult;
    }
    if (sql.includes("SELECT session_id")) {
      const tenant = String(values[0]);
      const rows = [...this.sessions]
        .filter(([key]) => key.startsWith(`${tenant}\u0000`))
        .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
        .map(([key]) => ({ session_id: key.slice(key.indexOf("\u0000") + 1) }));
      return { rows, rowCount: rows.length } as unknown as QueryResult;
    }
    throw new Error(`unexpected SQL in test backend: ${sql}`);
  }
}

class MemoryObjects {
  readonly objects = new Map<string, Buffer>();
  readonly puts: Array<{ key: string; options: S3PutArtifactOptions }> = [];

  readonly store = {
    putObject: async (key: string, value: Buffer | Uint8Array | string, options: S3PutArtifactOptions = {}) => {
      if (options.ifNoneMatch === "*" && this.objects.has(key)) throw new Error("object already exists");
      const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value);
      this.objects.set(key, bytes);
      this.puts.push({ key, options });
      return {
        key,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex")
      };
    },
    getObject: async (key: string) => {
      const bytes = this.objects.get(key);
      return bytes === undefined ? undefined : Buffer.from(bytes);
    }
  } as unknown as S3CompatibleArtifactStore;
}

test("enterprise Agent sessions restore from PostgreSQL/S3 with CAS and KMS bindings", async () => {
  const database = new MemoryPg();
  const objects = new MemoryObjects();
  const options = {
    tenantId: "tenant-a",
    pool: database.pool,
    objectStore: objects.store,
    objectPrefix: "control-plane",
    kmsKeyId: "kms-ci"
  };
  const sessionId = SessionId("enterprise-session-a");
  const session = await createEnterpriseAgentSessionStore(options).create({
    sessionId,
    cwd: "/workspace/tenant-a"
  });
  await session.append("user/message", {
    turn: 1,
    message: createUserMessage({
      id: MessageId("enterprise-message-a"),
      source: { kind: "user" },
      content: [{ type: "text", text: "repair the failing gate" }]
    })
  });

  const restarted = createEnterpriseAgentSessionStore(options);
  const reopened = await restarted.open(sessionId);
  assert.equal(reopened.runtimeCwd(), "/workspace/tenant-a");
  assert.equal(reopened.events.length, 2);
  assert.deepEqual(await restarted.listSessionIds(), [sessionId]);
  assert.ok(database.statements.some((statement) => statement.includes("FOR UPDATE")));
  assert.equal(objects.puts.length, 2);
  assert.ok(objects.puts.every(({ options: put }) =>
    put.ifNoneMatch === "*"
    && put.serverSideEncryption === "aws:kms"
    && put.kmsKeyId === "kms-ci"
  ));
});

test("enterprise Agent session restart orders multi-digit event sequences numerically", async () => {
  const database = new MemoryPg();
  const objects = new MemoryObjects();
  const options = {
    tenantId: "tenant-sequence",
    pool: database.pool,
    objectStore: objects.store
  };
  const sessionId = SessionId("enterprise-session-sequence");
  const session = await createEnterpriseAgentSessionStore(options).create({
    sessionId,
    cwd: "/workspace/sequence"
  });
  for (let index = 1; index <= 12; index += 1) {
    await session.append("user/message", {
      turn: 1,
      message: createUserMessage({
        id: MessageId(`enterprise-sequence-${index}`),
        source: { kind: "user" },
        content: [{ type: "text", text: `event ${index}` }]
      })
    });
  }

  const reopened = await createEnterpriseAgentSessionStore(options).open(sessionId);
  assert.deepEqual(
    reopened.events.map((event) => event.seq),
    Array.from({ length: 13 }, (_, index) => index)
  );
  assert.ok(database.statements.some((statement) => statement.includes("ORDER BY events.seq")));
});

test("enterprise Agent sessions fail closed when an indexed S3 object is tampered", async () => {
  const database = new MemoryPg();
  const objects = new MemoryObjects();
  const options = {
    tenantId: "tenant-b",
    pool: database.pool,
    objectStore: objects.store
  };
  const sessionId = SessionId("enterprise-session-b");
  await createEnterpriseAgentSessionStore(options).create({ sessionId, cwd: "/workspace/b" });
  const firstKey = objects.puts[0]?.key;
  assert.ok(firstKey);
  objects.objects.set(firstKey, Buffer.from("tampered"));

  await assert.rejects(
    () => createEnterpriseAgentSessionStore(options).open(sessionId),
    /missing or has been tampered/u
  );
});
