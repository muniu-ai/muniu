// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ProxyReplayRecord, ProxyRequestLog } from "@mn/provider-catalog";

import { SqliteLocalStore } from "../src/index.js";

function legacyDatabase(path: string, value: unknown): void {
  const database = new DatabaseSync(path);
  database.exec("create table local_state (key text primary key, value text not null)");
  database.prepare("insert into local_state (key, value) values ('data', ?)").run(JSON.stringify(value));
  database.close();
}

function log(id: string): ProxyRequestLog {
  return {
    id,
    app: "claude",
    providerId: "provider-one",
    model: "model-one",
    inputTokens: 1,
    outputTokens: 2,
    statusCode: 200,
    latencyMs: 3,
    runId: "run-one",
    candidateId: "candidate-one",
    createdAt: `2026-08-21T00:00:0${id.at(-1) ?? "0"}.000Z`
  };
}

function replay(key: string): ProxyReplayRecord {
  return {
    key,
    app: "claude",
    providerId: "provider-one",
    model: "model-one",
    method: "POST",
    targetUrl: "https://provider.invalid/v1",
    requestHash: "a".repeat(64),
    statusCode: 200,
    headers: {},
    bodyBase64: "e30=",
    inputTokens: 1,
    outputTokens: 2,
    runId: "run-one",
    candidateId: "candidate-one",
    createdAt: "2026-08-21T00:00:00.000Z",
    replayCount: 0
  };
}

test("SQLite v2 establishes strict normalized tables and verified safety pragmas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-sqlite-v2-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SqliteLocalStore({ rootDir: root });
  await store.read();
  store.close();

  assert.equal((await stat(join(root, "mniu.db"))).mode & 0o777, 0o600);
  const database = new DatabaseSync(join(root, "mniu.db"));
  assert.equal((database.prepare("pragma user_version").get() as { user_version: number }).user_version, 2);
  assert.equal((database.prepare("pragma journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  const tables = database.prepare("pragma table_list").all() as Array<{ name: string; strict: number }>;
  for (const name of [
    "providers",
    "provider_health",
    "proxy_request_logs",
    "proxy_replay_records",
    "extension_records"
  ]) {
    assert.equal(tables.find((entry) => entry.name === name)?.strict, 1, name);
  }
  database.close();
});

test("SQLite migration rolls back duplicate legacy rows and leaves the old blob recoverable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-sqlite-v2-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "mniu.db");
  const provider = {
    id: "duplicate-provider",
    app: "agent",
    name: "duplicate",
    kind: "relay",
    apiFormat: "openai_chat",
    baseUrl: "https://provider.invalid/v1",
    defaultModel: "model",
    modelCatalog: [],
    config: {},
    enabled: true,
    enabledConsumers: ["agent"],
    enabledApps: ["agent"],
    sortOrder: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z"
  };
  legacyDatabase(path, { version: 1, providers: [provider, provider] });
  await chmod(path, 0o600);
  const store = new SqliteLocalStore({ rootDir: root });
  await assert.rejects(store.read(), /unique|constraint/iu);
  assert.ok(store.legacyBackupFile);

  const database = new DatabaseSync(path, { readOnly: true });
  assert.equal((database.prepare("pragma user_version").get() as { user_version: number }).user_version, 0);
  assert.equal((database.prepare(`
    select count(*) as count from sqlite_schema where type = 'table' and name = 'local_state'
  `).get() as { count: number }).count, 1);
  assert.equal((database.prepare(`
    select count(*) as count from sqlite_schema where type = 'table' and name = 'providers'
  `).get() as { count: number }).count, 0);
  database.close();
});

test("SQLite v2 rejects broad permissions, symlink files, and unknown schemas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-sqlite-v2-security-"));
  const outside = await mkdtemp(join(tmpdir(), "mn-sqlite-v2-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));

  const broadPath = join(root, "broad.db");
  new DatabaseSync(broadPath).close();
  await chmod(broadPath, 0o644);
  await assert.rejects(
    new SqliteLocalStore({ rootDir: root, databaseFile: broadPath }).read(),
    /permissions/iu
  );

  const outsidePath = join(outside, "outside.db");
  new DatabaseSync(outsidePath).close();
  await symlink(outsidePath, join(root, "link.db"));
  await assert.rejects(
    new SqliteLocalStore({ rootDir: root, databaseFile: join(root, "link.db") }).read(),
    /regular|symbolic|file/iu
  );

  const badPath = join(root, "bad.db");
  const bad = new DatabaseSync(badPath);
  bad.exec("create table unexpected (id text)");
  bad.close();
  await chmod(badPath, 0o600);
  await assert.rejects(
    new SqliteLocalStore({ rootDir: root, databaseFile: badPath }).read(),
    /schema/iu
  );
});

test("SQLite v2 serializes concurrent writers and updates log/replay rows without full-state rewrites", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-sqlite-v2-writers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new SqliteLocalStore({ rootDir: root });
  const second = new SqliteLocalStore({ rootDir: root });
  await first.read();
  await second.read();
  await Promise.all([
    first.appendProxyRequestLog(log("log-1")),
    second.appendProxyRequestLog(log("log-2"))
  ]);
  await Promise.all([
    first.saveProxyReplayRecord(replay("replay-1")),
    second.saveProxyReplayRecord(replay("replay-2"))
  ]);
  assert.deepEqual((await first.listProxyRequestLogs()).map((entry) => entry.id), ["log-2", "log-1"]);
  assert.equal((await second.getProxyReplayRecord("replay-1"))?.key, "replay-1");
  assert.equal((await first.markProxyReplayRecordReplayed("replay-2"))?.replayCount, 1);

  const database = new DatabaseSync(join(root, "mniu.db"), { readOnly: true });
  assert.equal((database.prepare("select count(*) as count from proxy_request_logs").get() as { count: number }).count, 2);
  assert.equal((database.prepare("select count(*) as count from proxy_replay_records").get() as { count: number }).count, 2);
  database.close();
  first.close();
  second.close();
});
