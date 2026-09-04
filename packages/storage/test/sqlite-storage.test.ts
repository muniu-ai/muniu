// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import type { EventAppendRequest } from "@mn/contracts";

import {
  CursorExpiredError,
  SqliteStorage,
  StaleFencingTokenError,
  StreamVersionConflictError,
  canonicalJson,
  computeEventDigest,
  verifyEventIntegrity
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function temporaryPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "mn-storage-"));
  temporaryDirectories.push(root);
  return join(root, name);
}

function appendRequest(overrides: Partial<EventAppendRequest> = {}): EventAppendRequest {
  return {
    tenantId: "tenant-a",
    aggregateType: "workspace",
    aggregateId: "workspace-1",
    expectedStreamVersion: 0,
    type: "workspace.created",
    actorId: "local-owner",
    generation: 1,
    correlationId: "correlation-1",
    publicPayload: { z: 1, nested: { beta: true, alpha: "first" } },
    ...overrides
  };
}

test("SQLite uses WAL/FULL and appends a canonical HMAC chained event", async () => {
  const databaseFile = temporaryPath("state.sqlite");
  const hmacKey = randomBytes(32);
  const storage = new SqliteStorage({ databaseFile, hmacKey });

  try {
    const result = await storage.commit({ event: appendRequest() });
    assert.equal(result.event?.position, 1);
    assert.equal(result.event?.streamVersion, 1);
    assert.equal(result.event?.previousDigest, undefined);
    assert.equal(verifyEventIntegrity(result.event!, hmacKey), true);
    assert.equal(verifyEventIntegrity({ ...result.event!, actorId: "attacker" }, hmacKey), false);
    assert.equal(
      result.event?.hmac,
      createHmac("sha256", hmacKey).update(result.event!.digest).digest("hex")
    );
    assert.equal(result.event?.digest, computeEventDigest(result.event!));
    assert.equal(
      canonicalJson({ z: 1, nested: { beta: true, alpha: "first" } }),
      '{"nested":{"alpha":"first","beta":true},"z":1}'
    );
  } finally {
    await storage.close();
  }

  const observer = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    assert.equal(String(observer.prepare("pragma journal_mode").get()!.journal_mode).toLowerCase(), "wal");
    assert.equal(Number(observer.prepare("pragma synchronous").get()!.synchronous), 2);
  } finally {
    observer.close();
  }
});

test("expected stream version conflicts and a failing batch rolls back every write", async () => {
  const storage = new SqliteStorage({
    databaseFile: temporaryPath("state.sqlite"),
    hmacKey: randomBytes(32)
  });
  try {
    await storage.commit({ event: appendRequest() });
    await assert.rejects(
      storage.commit({ event: appendRequest({ type: "workspace.renamed" }) }),
      (error: unknown) => error instanceof StreamVersionConflictError
        && error.expected === 0
        && error.actual === 1
    );

    await assert.rejects(storage.commit({
      event: appendRequest({
        aggregateId: "workspace-2",
        correlationId: "correlation-rollback"
      }),
      outbox: [
        { id: "duplicate", tenantId: "tenant-a", topic: "one", payload: {} },
        { id: "duplicate", tenantId: "tenant-a", topic: "two", payload: {} }
      ]
    }));

    const page = await storage.readEvents("tenant-a", { afterPosition: 0, limit: 20 });
    assert.deepEqual(page.events.map((event) => event.aggregateId), ["workspace-1"]);
    assert.equal((await storage.listOutbox("tenant-a", 20)).length, 0);

    await assert.rejects(storage.commit({
      event: appendRequest({ expectedStreamVersion: 1 }),
      outbox: [{ id: "cross-tenant", tenantId: "tenant-b", topic: "events", payload: {} }]
    }), /cross tenants/);
    assert.equal((await storage.readEvents("tenant-a", { afterPosition: 0, limit: 20 })).events.length, 1);
  } finally {
    await storage.close();
  }
});

test("event positions are monotonic per tenant while stream versions are per aggregate", async () => {
  const storage = new SqliteStorage({
    databaseFile: temporaryPath("state.sqlite"),
    hmacKey: randomBytes(32)
  });
  try {
    const firstA = await storage.commit({ event: appendRequest() });
    const firstB = await storage.commit({ event: appendRequest({
      tenantId: "tenant-b",
      aggregateId: "workspace-b"
    }) });
    const secondAggregateA = await storage.commit({ event: appendRequest({
      aggregateId: "workspace-2",
      type: "workspace.created"
    }) });
    assert.equal(firstA.event?.position, 1);
    assert.equal(firstB.event?.position, 1);
    assert.equal(secondAggregateA.event?.position, 2);
    assert.equal(secondAggregateA.event?.streamVersion, 1);
    assert.equal(secondAggregateA.event?.previousDigest, firstA.event?.digest);
  } finally {
    await storage.close();
  }
});

test("a batch atomically stores projection, job, outbox, approval, and idempotency", async () => {
  const storage = new SqliteStorage({
    databaseFile: temporaryPath("state.sqlite"),
    hmacKey: randomBytes(32)
  });
  const now = "2026-09-04T00:00:00.000Z";
  try {
    const input = {
      event: appendRequest(),
      projections: [{
        tenantId: "tenant-a",
        namespace: "core",
        key: "workspace-1",
        value: { name: "First workspace" },
        streamVersion: 1
      }],
      jobs: [{
        id: "job-1",
        tenantId: "tenant-a",
        workspaceId: "workspace-1",
        kind: "projection.rebuild",
        payload: { target: "opc" },
        availableAt: now,
        idempotencyKey: "job-idempotency-1"
      }],
      outbox: [{ id: "outbox-1", tenantId: "tenant-a", topic: "events", payload: { id: 1 } }],
      approvals: [{
        tenantId: "tenant-a",
        id: "approval-1",
        executionId: "execution-1",
        status: "pending",
        value: { intent: "Write a local file" }
      }],
      idempotency: {
        tenantId: "tenant-a",
        key: "mutation-1",
        requestHash: "sha256:request"
      }
    } as const;

    const first = await storage.commit(input);
    const replay = await storage.commit(input);

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.event, first.event);
    assert.deepEqual(await storage.getProjection("tenant-a", "core", "workspace-1"), {
      name: "First workspace"
    });
    assert.equal((await storage.listOutbox("tenant-a", 20)).length, 1);
    assert.equal((await storage.getApproval("tenant-a", "approval-1"))?.status, "pending");
  } finally {
    await storage.close();
  }
});

test("event pagination enforces the tenant retention floor", async () => {
  const storage = new SqliteStorage({
    databaseFile: temporaryPath("state.sqlite"),
    hmacKey: randomBytes(32)
  });
  try {
    await storage.commit({ event: appendRequest() });
    await storage.commit({ event: appendRequest({ expectedStreamVersion: 1, type: "workspace.renamed" }) });
    const beforeRetention = await storage.readEvents("tenant-a", { afterPosition: 0, limit: 20 });
    assert.equal(beforeRetention.events[1]?.previousDigest, beforeRetention.events[0]?.digest);
    await storage.advanceRetentionFloor("tenant-a", 2);

    await assert.rejects(
      storage.readEvents("tenant-a", { afterPosition: 0, limit: 20 }),
      (error: unknown) => error instanceof CursorExpiredError && error.retentionFloor === 2
    );
    const page = await storage.readEvents("tenant-a", { afterPosition: 1, limit: 20 });
    assert.deepEqual(page.events.map((event) => event.position), [2]);
    assert.equal(page.retentionFloor, 2);
  } finally {
    await storage.close();
  }
});

test("job leases last thirty seconds and fencing rejects a stale worker", async () => {
  const storage = new SqliteStorage({
    databaseFile: temporaryPath("state.sqlite"),
    hmacKey: randomBytes(32)
  });
  try {
    await storage.commit({ jobs: [{
      id: "job-1",
      tenantId: "tenant-a",
      kind: "tool.execute",
      payload: {},
      availableAt: "2026-09-04T00:00:00.000Z",
      idempotencyKey: "tool-call-1"
    }] });

    const first = await storage.claimJob("worker-a", "2026-09-04T00:00:00.000Z");
    assert.equal(first?.fencingToken, 1);
    assert.equal(first?.leaseExpiresAt, "2026-09-04T00:00:30.000Z");
    assert.equal(await storage.claimJob("worker-b", "2026-09-04T00:00:29.999Z"), undefined);

    const second = await storage.claimJob("worker-b", "2026-09-04T00:00:30.000Z");
    assert.equal(second?.fencingToken, 2);
    await assert.rejects(
      storage.completeJob("job-1", "worker-a", 1, { ignored: true }, "2026-09-04T00:00:31.000Z"),
      StaleFencingTokenError
    );
    await storage.completeJob("job-1", "worker-b", 2, { ok: true }, "2026-09-04T00:00:31.000Z");
    assert.equal((await storage.getJob("job-1"))?.status, "completed");
  } finally {
    await storage.close();
  }
});

test("续租与未知副作用核对均受 fencing 保护并原子终止 Job", async () => {
  const storage = new SqliteStorage({
    databaseFile: temporaryPath("state.sqlite"),
    hmacKey: randomBytes(32),
    now: () => new Date("2026-09-04T00:00:20.000Z")
  });
  const execution = {
    id: "execution-1", tenantId: "tenant-a", workspaceId: "workspace-1", threadId: "thread-1",
    pluginId: "coding", agentDefinitionId: "coding.builtin", modelBindingId: "model-1",
    initiatedBy: "owner", executionPrincipalId: "agent:coding", generation: 1,
    status: "running", authorityId: "authority-1", streamVersion: 1,
    createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z"
  } as const;
  try {
    await storage.transact("tenant-a", (transaction) => {
      transaction.putProjection("execution", execution.id, execution);
      transaction.appendEvent({
        tenantId: "tenant-a", aggregateType: "execution", aggregateId: execution.id,
        expectedStreamVersion: 0, type: "execution.running", actorId: "agent:coding",
        executionId: execution.id, generation: 1, correlationId: "execution-start",
        publicPayload: { workspaceId: execution.workspaceId, status: "running" }
      });
    });
    await storage.commit({ jobs: [{
      id: "job-1", tenantId: "tenant-a", workspaceId: "workspace-1", kind: "agent.turn",
      payload: { executionId: execution.id, message: "实现修复" },
      availableAt: "2026-09-04T00:00:00.000Z", idempotencyKey: "turn-1"
    }] });
    const claimed = await storage.claimJob("worker-a", "2026-09-04T00:00:00.000Z");
    assert.equal(claimed?.fencingToken, 1);
    await storage.renewJobLease("job-1", "worker-a", 1, "2026-09-04T00:00:20.000Z");
    assert.equal((await storage.getJob("job-1"))?.leaseExpiresAt, "2026-09-04T00:00:50.000Z");
    assert.equal(await storage.claimJob("worker-b", "2026-09-04T00:00:30.000Z"), undefined);

    await storage.markNeedsReconciliation(execution.id, {
      jobId: "job-1", workerId: "worker-a", fencingToken: 1,
      occurredAt: "2026-09-04T00:00:21.000Z"
    });
    assert.equal((await storage.getJob("job-1"))?.status, "failed");
    const updated = await storage.getProjection("tenant-a", "execution", execution.id);
    assert.equal(updated?.status, "needs_reconciliation");
    assert.equal(updated?.streamVersion, 2);
    const inbox = await storage.getProjection("tenant-a", "inbox", "reconciliation:execution-1:job-1");
    assert.equal(inbox?.kind, "reconciliation");
    assert.equal(inbox?.status, "open");
    const events = await storage.readEvents("tenant-a", { afterPosition: 0, limit: 20 });
    assert.equal(events.events.at(-1)?.type, "execution.needs_reconciliation");
    await assert.rejects(
      storage.completeJob("job-1", "worker-a", 1, { replayed: true }, "2026-09-04T00:00:22.000Z"),
      StaleFencingTokenError
    );
  } finally {
    await storage.close();
  }
});

test("未知副作用核对遇到版本冲突时回滚 Job、Inbox 和 Execution", async () => {
  const storage = new SqliteStorage({
    databaseFile: temporaryPath("state.sqlite"),
    hmacKey: randomBytes(32)
  });
  const execution = {
    id: "execution-conflict", tenantId: "tenant-a", workspaceId: "workspace-1",
    generation: 1, status: "running", streamVersion: 2,
    updatedAt: "2026-09-04T00:00:00.000Z"
  } as const;
  try {
    await storage.transact("tenant-a", (transaction) => {
      transaction.putProjection("execution", execution.id, execution);
      transaction.appendEvent({
        tenantId: "tenant-a", aggregateType: "execution", aggregateId: execution.id,
        expectedStreamVersion: 0, type: "execution.running", actorId: "agent:coding",
        executionId: execution.id, generation: 1, correlationId: "execution-start",
        publicPayload: { workspaceId: execution.workspaceId, status: "running" }
      });
    });
    await storage.commit({ jobs: [{
      id: "job-conflict", tenantId: "tenant-a", workspaceId: "workspace-1", kind: "agent.turn",
      payload: { executionId: execution.id, message: "实现修复" },
      availableAt: "2026-09-04T00:00:00.000Z", idempotencyKey: "turn-conflict"
    }] });
    await storage.claimJob("worker-a", "2026-09-04T00:00:00.000Z");

    await assert.rejects(storage.markNeedsReconciliation(execution.id, {
      jobId: "job-conflict", workerId: "worker-a", fencingToken: 1,
      occurredAt: "2026-09-04T00:00:01.000Z"
    }), StreamVersionConflictError);
    assert.equal((await storage.getJob("job-conflict"))?.status, "leased");
    assert.equal((await storage.getProjection("tenant-a", "execution", execution.id))?.status, "running");
    assert.equal(
      await storage.getProjection(
        "tenant-a", "inbox", `reconciliation:${execution.id}:job-conflict`
      ),
      undefined
    );
    assert.equal((await storage.readEvents("tenant-a", { afterPosition: 0, limit: 20 })).events.length, 1);
  } finally {
    await storage.close();
  }
});

test("SQLite is structurally compatible with KernelStore transactions", async () => {
  const storage = new SqliteStorage({
    databaseFile: temporaryPath("state.sqlite"),
    hmacKey: randomBytes(32),
    now: () => new Date("2026-09-04T00:00:00.000Z")
  });
  try {
    const value = await storage.transact("tenant-a", (transaction) => {
      transaction.putProjection("workspace", "one", { id: "one", streamVersion: 1 });
      transaction.appendEvent(appendRequest());
      transaction.appendEvent(appendRequest({
        aggregateType: "principal",
        aggregateId: "owner",
        type: "principal.created"
      }));
      transaction.putIdempotency({
        tenantId: "tenant-a",
        scope: "workspace.create",
        key: "request-1",
        requestDigest: "digest-1",
        response: { id: "one" },
        createdAt: "2026-09-04T00:00:00.000Z"
      });
      assert.equal(transaction.listProjections<{ id: string }>("workspace")[0]?.id, "one");
      return transaction.getIdempotency("workspace.create", "request-1")?.response;
    });
    assert.deepEqual(value, { id: "one" });
    assert.equal((await storage.readEvents("tenant-a", 0, 20)).events.length, 2);

    await assert.rejects(storage.transact("tenant-a", (transaction) => {
      transaction.putProjection("workspace", "rolled-back", { id: "rolled-back" });
      throw new Error("stop");
    }), /stop/);
    assert.equal(await storage.getProjection("tenant-a", "workspace", "rolled-back"), undefined);
  } finally {
    await storage.close();
  }
});
