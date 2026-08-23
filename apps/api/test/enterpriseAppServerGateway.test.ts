// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  EventId,
  SessionId,
  createProtectedJsonViewV1
} from "@mn/agent-protocol";
import { controlMethodForOperation } from "@mn/app-server-protocol";
import type { Pool } from "pg";

import type { S3CompatibleArtifactStore } from "../src/artifactRemoteStore.js";
import {
  PostgresConnectionLeaseStore,
  PostgresAgentEventV3Store,
  PostgresNotificationLog,
  connectionIdentity,
  enterpriseRpcMethodAllows
} from "../src/enterpriseAppServerGateway.js";
import type { RequestContext } from "@mn/core";
import { buildServer } from "../src/server.js";

test("enterprise app-server refuses an API listener without TLS", () => {
  assert.throws(() => buildServer({
    runtimeProfile: "enterprise",
    auth: {
      issuer: "https://issuer.example",
      audience: "muniu",
      jwksUrl: "https://issuer.example/jwks"
    },
    corsAllowlist: ["https://desktop.example"],
    enterprisePostgres: false,
    telemetry: false,
    standardPackTrustProfile: false,
    enterpriseProjectRoots: false,
    sandboxAttestationKey: false,
    enterpriseAppServer: {}
  }), /TLS API listener/iu);
});

test("enterprise RPC authorization reuses tenant principal and method-level RBAC", () => {
  const reviewer = connectionIdentity({
    tenantId: "tenant-a",
    actorId: "reviewer-a",
    roles: ["reviewer"],
    projectIds: ["project-a"],
    principalType: "human",
    scopes: [],
    authentication: "oidc",
    traceId: "trace-a"
  });
  assert.equal(reviewer.permissionProfile, "read-only");
  assert.equal(enterpriseRpcMethodAllows(reviewer, "thread/read"), true);
  assert.equal(enterpriseRpcMethodAllows(reviewer, "turn/start"), false);
  assert.equal(enterpriseRpcMethodAllows(reviewer, controlMethodForOperation("post__v1_runs_id_approve")), true);

  const worker = connectionIdentity({
    tenantId: "tenant-a",
    actorId: "worker-a",
    roles: [],
    projectIds: [],
    principalType: "worker",
    scopes: ["run_jobs:claim"],
    authentication: "oidc",
    traceId: "trace-b"
  });
  assert.equal(enterpriseRpcMethodAllows(worker, controlMethodForOperation("post__v1_run_jobs_queue_claim")), true);
  assert.equal(enterpriseRpcMethodAllows(worker, "thread/read"), false);

  const administrator = connectionIdentity({
    tenantId: "tenant-a",
    actorId: "admin-a",
    roles: ["org_admin"],
    projectIds: [],
    principalType: "human",
    scopes: [],
    authentication: "oidc",
    traceId: "trace-c"
  } satisfies RequestContext);
  assert.equal(enterpriseRpcMethodAllows(administrator, "skills/list"), false);
});

test("PostgreSQL lease and notification stores retain tenant-scoped recovery state", async () => {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("count(*)")) return { rows: [{ count: "0" }], rowCount: 1 };
      if (sql.includes("RETURNING lease_id")) return { rows: [{ lease_id: "lease-a" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  let notificationSequence = 0;
  const pool = {
    async connect() { return client; },
    async query(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("RETURNING sequence::text")) {
        notificationSequence += 1;
        return { rows: [{ sequence: String(notificationSequence) }], rowCount: 1 };
      }
      if (sql.includes("SELECT sequence::text,notification")) {
        return {
          rows: [{
            sequence: "2",
            notification: { method: "warning", params: { message: "remote" } }
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    }
  } as unknown as Pool;
  const leases = new PostgresConnectionLeaseStore(pool, 1);
  assert.equal(await leases.acquire({
    leaseId: "00000000-0000-4000-8000-000000000001",
    tenantId: "tenant-a",
    subject: "user-a",
    expiresAt: Date.now() + 60_000
  }), true);
  assert.equal(await leases.renew("00000000-0000-4000-8000-000000000001", Date.now() + 60_000), true);
  await leases.release("00000000-0000-4000-8000-000000000001");

  const log = new PostgresNotificationLog("tenant-a", "user-a", pool, { pollIntervalMs: 25 });
  assert.deepEqual(await log.append({ method: "warning", params: { message: "local" } }), { cursor: "1" });
  assert.deepEqual(await log.readAfter("1"), [{
    cursor: "2",
    notification: { method: "warning", params: { message: "remote" } }
  }]);
  assert.ok(calls.some((call) => call.params?.includes("tenant-a")));
  assert.ok(calls.some((call) => call.params?.includes("user-a")));
});

test("PostgreSQL notification polling reports transient failures without rejecting in the background", async () => {
  const pool = {
    async query(sql: string) {
      if (sql.includes("SELECT sequence::text,notification")) throw new Error("database unavailable");
      if (sql.includes("max(sequence)")) return { rows: [{ sequence: "0" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  } as unknown as Pool;
  let report!: (error: unknown) => void;
  const reported = new Promise<unknown>((resolve) => { report = resolve; });
  const log = new PostgresNotificationLog("tenant-a", "user-a", pool, {
    pollIntervalMs: 25,
    onPollError: report
  });
  const unsubscribe = await log.subscribeAfter(undefined, () => undefined);
  assert.match(String(await reported), /database unavailable/iu);
  unsubscribe();
});

test("PostgreSQL notification replay is scoped to the authenticated subject", async () => {
  const rows: Array<{
    sequence: string;
    tenant: string;
    subject: string;
    notification: unknown;
  }> = [];
  const pool = {
    async query(sql: string, params?: readonly unknown[]) {
      if (sql.includes("INSERT INTO mn_app_server_notifications")) {
        const row = {
          sequence: String(rows.length + 1),
          tenant: String(params?.[0]),
          subject: String(params?.[1]),
          notification: JSON.parse(String(params?.[2])) as unknown
        };
        rows.push(row);
        return { rows: [{ sequence: row.sequence }], rowCount: 1 };
      }
      if (sql.includes("SELECT sequence::text,notification")) {
        const selected = rows.filter((row) => row.tenant === params?.[0]
          && row.subject === params?.[1]
          && Number(row.sequence) > Number(params?.[2]));
        return {
          rows: selected.map((row) => ({ sequence: row.sequence, notification: row.notification })),
          rowCount: selected.length
        };
      }
      return { rows: [], rowCount: 0 };
    }
  } as unknown as Pool;
  const first = new PostgresNotificationLog("tenant-a", "user-a", pool);
  const second = new PostgresNotificationLog("tenant-a", "user-b", pool);
  await first.append({ method: "warning", params: { message: "private" } });
  assert.equal((await first.readAfter("0")).length, 1);
  assert.equal((await second.readAfter("0")).length, 0);
});

test("PostgreSQL V3 facts serialize one chain and isolate tenant and subject ownership", async () => {
  const threads = new Map<string, { owner: string | null; lastSequence: number; lastDigest: string }>();
  const events = new Map<string, Array<{
    thread_id: string;
    sequence: string;
    event_digest: string;
    object_key: string;
    object_sha256: string;
    object_bytes: string;
  }>>();
  const objects = new Map<string, Buffer>();
  const objectStore = {
    async putObject(key: string, value: Buffer | Uint8Array | string) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (objects.has(key)) throw new Error("duplicate object");
      objects.set(key, bytes);
      return {
        key,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex")
      };
    },
    async getObject(key: string) { return objects.get(key); }
  } as unknown as S3CompatibleArtifactStore;
  const client = {
    async query(sql: string, params?: readonly unknown[]) {
      if (sql.includes("INSERT INTO mn_agent_threads_v3")) {
        const key = `${String(params?.[0])}:${String(params?.[1])}`;
        if (threads.has(key)) return { rows: [], rowCount: 0 };
        threads.set(key, {
          owner: String(params?.[2]),
          lastSequence: 0,
          lastDigest: String(params?.[3])
        });
        return { rows: [{ thread_id: params?.[1] }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO mn_agent_events_v3")) {
        const key = `${String(params?.[0])}:${String(params?.[1])}`;
        const rows = events.get(key) ?? [];
        const sequence = Number(params?.[2]);
        if (rows[sequence] !== undefined) return { rows: [], rowCount: 0 };
        rows[sequence] = {
          thread_id: String(params?.[1]),
          sequence: String(sequence),
          event_digest: String(params?.[4]),
          object_key: String(params?.[6]),
          object_sha256: String(params?.[7]),
          object_bytes: String(params?.[8])
        };
        events.set(key, rows);
        return { rows: [{ sequence: String(sequence) }], rowCount: 1 };
      }
      if (sql.includes("SELECT last_sequence::text,last_digest FROM mn_agent_threads_v3")) {
        const key = `${String(params?.[0])}:${String(params?.[1])}`;
        const thread = threads.get(key);
        return thread && (thread.owner === null || thread.owner === params?.[2])
          ? { rows: [{ last_sequence: String(thread.lastSequence), last_digest: thread.lastDigest }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.trimStart().startsWith("SELECT 1 FROM mn_agent_threads_v3")) {
        const key = `${String(params?.[0])}:${String(params?.[1])}`;
        const thread = threads.get(key);
        const allowed = thread && (thread.owner === null || thread.owner === params?.[2]);
        return { rows: allowed ? [{ "?column?": 1 }] : [], rowCount: allowed ? 1 : 0 };
      }
      if (sql.includes("UPDATE mn_agent_threads_v3")) {
        const key = `${String(params?.[0])}:${String(params?.[1])}`;
        const thread = threads.get(key);
        if (!thread || thread.lastSequence !== Number(params?.[5]) || thread.lastDigest !== params?.[6]) {
          return { rows: [], rowCount: 0 };
        }
        threads.set(key, { ...thread, lastSequence: Number(params?.[2]), lastDigest: String(params?.[3]) });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM mn_agent_events_v3") && sql.includes("thread_id=$2")) {
        const key = `${String(params?.[0])}:${String(params?.[1])}`;
        const rows = events.get(key) ?? [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("FROM mn_agent_events_v3")) {
        const tenant = String(params?.[0]);
        const rows = [...events.entries()].flatMap(([key, references]) => {
          if (!key.startsWith(`${tenant}:`)) return [];
          const thread = threads.get(key);
          if (!thread || thread.owner !== null && thread.owner !== params?.[1]) return [];
          return references;
        });
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  const pool = {
    async connect() { return client; },
    query: client.query.bind(client)
  } as unknown as Pool;
  const threadId = SessionId("thread-enterprise-a");
  const store = new PostgresAgentEventV3Store({
    tenantId: "tenant-a",
    subject: "user-a",
    pool,
    objectStore
  });
  await store.create({
    eventId: EventId("event-enterprise-a"),
    threadId,
    sequence: 0,
    occurredAt: "2026-08-23T00:00:00.000Z",
    type: "thread/created",
    correlationId: threadId,
    publicControls: {
      source: "appServer",
      providerId: "provider-a",
      modelId: "model-a",
      permissionProfile: "read-only",
      sandbox: { mode: "read-only" },
      associations: {}
    },
    protectedContent: createProtectedJsonViewV1({ cwd: "/workspace" })
  });
  await store.append(threadId, {
    eventId: EventId("event-enterprise-b"),
    occurredAt: "2026-08-23T00:00:01.000Z",
    type: "thread/updated",
    correlationId: threadId,
    publicControls: { name: "tenant A" },
    protectedContent: createProtectedJsonViewV1({})
  });
  assert.equal((await store.read(threadId)).length, 2);
  assert.equal((await store.list())[0]?.name, "tenant A");

  const otherSubject = new PostgresAgentEventV3Store({
    tenantId: "tenant-a",
    subject: "user-b",
    pool,
    objectStore
  });
  await assert.rejects(otherSubject.read(threadId), /not found/iu);

  const isolated = new PostgresAgentEventV3Store({
    tenantId: "tenant-b",
    subject: "user-a",
    pool,
    objectStore
  });
  await assert.rejects(isolated.read(threadId), /not found/iu);
});
