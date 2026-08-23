// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { controlMethodForOperation } from "@mn/app-server-protocol";
import type { Pool } from "pg";

import {
  PostgresConnectionLeaseStore,
  PostgresNotificationLog,
  connectionIdentity,
  enterpriseRpcMethodAllows
} from "../src/enterpriseAppServerGateway.js";
import type { RequestContext } from "@mn/core";

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

  const log = new PostgresNotificationLog("tenant-a", pool, { pollIntervalMs: 25 });
  assert.deepEqual(await log.append({ method: "warning", params: { message: "local" } }), { cursor: "1" });
  assert.deepEqual(await log.readAfter("1"), [{
    cursor: "2",
    notification: { method: "warning", params: { message: "remote" } }
  }]);
  assert.ok(calls.some((call) => call.params?.includes("tenant-a")));
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
  const log = new PostgresNotificationLog("tenant-a", pool, {
    pollIntervalMs: 25,
    onPollError: report
  });
  const unsubscribe = await log.subscribeAfter(undefined, () => undefined);
  assert.match(String(await reported), /database unavailable/iu);
  unsubscribe();
});
