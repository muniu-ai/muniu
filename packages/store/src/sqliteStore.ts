// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  ManagedAgentApp,
  ProviderHealthEvent,
  ProviderHealthRecord,
  ProxyReplayRecord,
  ProxyRequestLog
} from "@mn/provider-catalog";

import {
  FileLocalStore,
  emptyStoreData,
  effectiveProviderHealth,
  nextProviderHealth,
  normalizeProviderActivationRecord,
  normalizeSkillRegistryTrustProfileRecord
} from "./fileStore.js";
import type { LocalStoreData } from "./types.js";

export interface SqliteLocalStoreOptions {
  rootDir: string;
  databaseFile?: string;
}

type JsonRow = { json: string };
type CountRow = { count: number };

const SCHEMA_VERSION = 2;
const REQUIRED_TABLES = new Set([
  "store_meta",
  "proxy_state",
  "providers",
  "projections",
  "proxy_request_logs",
  "proxy_replay_records",
  "provider_health",
  "extension_records"
]);
const EXTENSION_COLLECTIONS = [
  "mcpServers",
  "promptPresets",
  "promptActivations",
  "skills",
  "skillInstallations",
  "skillRegistryTrustProfiles"
] as const;
type ExtensionCollection = typeof EXTENSION_COLLECTIONS[number];

function normalizeData(parsed: Partial<LocalStoreData> | undefined): LocalStoreData {
  const empty = emptyStoreData();
  return {
    version: 1,
    providers: (parsed?.providers ?? []).map(normalizeProviderActivationRecord),
    projections: parsed?.projections ?? [],
    proxy: parsed?.proxy ?? empty.proxy,
    proxyRequestLogs: parsed?.proxyRequestLogs ?? [],
    proxyReplayRecords: parsed?.proxyReplayRecords ?? [],
    providerHealth: parsed?.providerHealth ?? [],
    mcpServers: parsed?.mcpServers ?? [],
    promptPresets: parsed?.promptPresets ?? [],
    promptActivations: parsed?.promptActivations ?? [],
    skills: parsed?.skills ?? [],
    skillInstallations: parsed?.skillInstallations ?? [],
    skillRegistryTrustProfiles: (parsed?.skillRegistryTrustProfiles ?? []).map(
      normalizeSkillRegistryTrustProfileRecord
    )
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPrivatePath(path: string, kind: "directory" | "file"): void {
  const status = lstatSync(path);
  if (status.isSymbolicLink()
    || kind === "directory" && !status.isDirectory()
    || kind === "file" && (!status.isFile() || status.nlink !== 1)) {
    throw new Error(`SQLite ${kind} path must be a regular private ${kind}`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && status.uid !== uid) {
    throw new Error(`SQLite ${kind} path must be owned by the current user`);
  }
  if ((status.mode & 0o077) !== 0) {
    throw new Error(`SQLite ${kind} path permissions are too broad`);
  }
}

function syncDirectory(path: string): void {
  const handle = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function tableNames(database: DatabaseSync): Set<string> {
  const rows = database.prepare(`
    select name
    from sqlite_schema
    where type = 'table' and name not like 'sqlite_%'
  `).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function createSchemaV2(database: DatabaseSync): void {
  database.exec(`
    create table if not exists store_meta (
      key text primary key,
      value text not null
    ) strict, without rowid;

    create table if not exists proxy_state (
      singleton integer primary key check (singleton = 1),
      json text not null check (json_valid(json))
    ) strict;

    create table if not exists providers (
      entity_key text primary key,
      ordinal integer not null check (ordinal >= 0),
      json text not null check (json_valid(json))
    ) strict, without rowid;

    create table if not exists projections (
      entity_key text primary key,
      ordinal integer not null check (ordinal >= 0),
      json text not null check (json_valid(json))
    ) strict, without rowid;

    create table if not exists proxy_request_logs (
      entity_key text primary key,
      ordinal integer not null check (ordinal >= 0),
      created_at text not null,
      app text not null,
      provider_id text not null,
      run_id text,
      candidate_id text,
      json text not null check (json_valid(json))
    ) strict, without rowid;
    create index if not exists proxy_request_logs_created
      on proxy_request_logs(created_at desc, ordinal desc);

    create table if not exists proxy_replay_records (
      entity_key text primary key,
      ordinal integer not null check (ordinal >= 0),
      json text not null check (json_valid(json))
    ) strict, without rowid;

    create table if not exists provider_health (
      entity_key text primary key,
      ordinal integer not null check (ordinal >= 0),
      json text not null check (json_valid(json))
    ) strict, without rowid;

    create table if not exists extension_records (
      collection text not null check (collection in (
        'mcpServers',
        'promptPresets',
        'promptActivations',
        'skills',
        'skillInstallations',
        'skillRegistryTrustProfiles'
      )),
      entity_key text not null,
      ordinal integer not null check (ordinal >= 0),
      json text not null check (json_valid(json)),
      primary key (collection, entity_key)
    ) strict, without rowid;
  `);
}

function insertRows(
  statement: StatementSync,
  values: readonly unknown[],
  key: (value: any, index: number) => string
): void {
  for (const [index, value] of values.entries()) {
    statement.run(key(value, index), index, JSON.stringify(value));
  }
}

function replaceData(database: DatabaseSync, data: LocalStoreData): void {
  database.prepare(`
    insert into proxy_state (singleton, json) values (1, ?)
    on conflict(singleton) do update set json = excluded.json
  `).run(JSON.stringify(data.proxy));

  const simple: Array<{
    readonly deleteSql: string;
    readonly insertSql: string;
    readonly values: readonly unknown[];
    readonly key: (value: any, index: number) => string;
  }> = [
    {
      deleteSql: "delete from providers",
      insertSql: "insert into providers (entity_key, ordinal, json) values (?, ?, ?)",
      values: data.providers,
      key: (value) => value.id
    },
    {
      deleteSql: "delete from projections",
      insertSql: "insert into projections (entity_key, ordinal, json) values (?, ?, ?)",
      values: data.projections,
      key: (value) => value.id
    },
    {
      deleteSql: "delete from proxy_replay_records",
      insertSql: "insert into proxy_replay_records (entity_key, ordinal, json) values (?, ?, ?)",
      values: data.proxyReplayRecords,
      key: (value) => value.key
    },
    {
      deleteSql: "delete from provider_health",
      insertSql: "insert into provider_health (entity_key, ordinal, json) values (?, ?, ?)",
      values: data.providerHealth,
      key: (value) => `${value.providerId}\0${value.app}`
    }
  ];
  for (const collection of simple) {
    database.exec(collection.deleteSql);
    insertRows(database.prepare(collection.insertSql), collection.values, collection.key);
  }

  database.exec("delete from proxy_request_logs");
  const insertLog = database.prepare(`
    insert into proxy_request_logs (
      entity_key, ordinal, created_at, app, provider_id, run_id, candidate_id, json
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [index, log] of data.proxyRequestLogs.entries()) {
    insertLog.run(
      log.id,
      index,
      log.createdAt,
      log.app,
      log.providerId,
      log.runId ?? null,
      log.candidateId ?? null,
      JSON.stringify(log)
    );
  }

  database.exec("delete from extension_records");
  const insertExtension = database.prepare(`
    insert into extension_records (collection, entity_key, ordinal, json)
    values (?, ?, ?, ?)
  `);
  for (const collection of EXTENSION_COLLECTIONS) {
    for (const [index, value] of data[collection].entries()) {
      insertExtension.run(collection, (value as { id: string }).id, index, JSON.stringify(value));
    }
  }

  database.prepare(`
    insert into store_meta (key, value) values ('last_full_digest', ?)
    on conflict(key) do update set value = excluded.value
  `).run(sha256(JSON.stringify(data)));
}

function rows<T>(database: DatabaseSync, sql: string, ...params: string[]): T[] {
  return (database.prepare(sql).all(...params) as JsonRow[]).map((row) => JSON.parse(row.json) as T);
}

function readData(database: DatabaseSync): LocalStoreData {
  const proxy = database.prepare("select json from proxy_state where singleton = 1").get() as JsonRow | undefined;
  const extensions = <T>(collection: ExtensionCollection): T[] => rows<T>(database, `
    select json from extension_records where collection = ? order by ordinal
  `, collection);
  return normalizeData({
    version: 1,
    providers: rows(database, "select json from providers order by ordinal"),
    projections: rows(database, "select json from projections order by ordinal"),
    proxy: proxy === undefined ? undefined : JSON.parse(proxy.json),
    proxyRequestLogs: rows(database, "select json from proxy_request_logs order by ordinal"),
    proxyReplayRecords: rows(database, "select json from proxy_replay_records order by ordinal"),
    providerHealth: rows(database, "select json from provider_health order by ordinal"),
    mcpServers: extensions("mcpServers"),
    promptPresets: extensions("promptPresets"),
    promptActivations: extensions("promptActivations"),
    skills: extensions("skills"),
    skillInstallations: extensions("skillInstallations"),
    skillRegistryTrustProfiles: extensions("skillRegistryTrustProfiles")
  });
}

function assertCounts(database: DatabaseSync, expected: LocalStoreData): void {
  const checks: Array<[string, number]> = [
    ["select count(*) as count from providers", expected.providers.length],
    ["select count(*) as count from projections", expected.projections.length],
    ["select count(*) as count from proxy_request_logs", expected.proxyRequestLogs.length],
    ["select count(*) as count from proxy_replay_records", expected.proxyReplayRecords.length],
    ["select count(*) as count from provider_health", expected.providerHealth.length],
    ["select count(*) as count from extension_records", EXTENSION_COLLECTIONS.reduce(
      (total, collection) => total + expected[collection].length,
      0
    )]
  ];
  for (const [sql, count] of checks) {
    const actual = database.prepare(sql).get() as CountRow;
    if (actual.count !== count) throw new Error("SQLite migration row count verification failed");
  }
}

export class SqliteLocalStore extends FileLocalStore {
  readonly databaseFile: string;
  private databaseHandle?: DatabaseSync;
  private backupFile?: string;

  constructor(options: SqliteLocalStoreOptions) {
    if (!options.rootDir || options.rootDir.includes("\0")) throw new TypeError("SQLite root is invalid");
    const rootDir = resolve(options.rootDir);
    const databaseFile = resolve(options.databaseFile ?? join(rootDir, "mniu.db"));
    const boundary = relative(rootDir, databaseFile);
    if (!boundary || boundary.startsWith("..") || isAbsolute(boundary) || dirname(databaseFile) !== rootDir) {
      throw new TypeError("SQLite database file must be a direct child of its private root");
    }
    super({ rootDir, dataFile: join(rootDir, ".unused.json") });
    this.databaseFile = databaseFile;
  }

  get legacyBackupFile(): string | undefined {
    return this.backupFile;
  }

  override async read(): Promise<LocalStoreData> {
    const database = this.database();
    database.exec("begin");
    try {
      const data = readData(database);
      database.exec("commit");
      return data;
    } catch (error: unknown) {
      try { database.exec("rollback"); } catch {}
      throw error;
    }
  }

  override async write(data: LocalStoreData): Promise<void> {
    const database = this.database();
    database.exec("begin immediate");
    try {
      replaceData(database, normalizeData(data));
      database.exec("commit");
    } catch (error: unknown) {
      try { database.exec("rollback"); } catch {}
      throw error;
    }
  }

  override async appendProxyRequestLog(log: ProxyRequestLog): Promise<void> {
    const database = this.database();
    database.exec("begin immediate");
    try {
      const ordinal = (database.prepare(`
        select coalesce(max(ordinal), -1) + 1 as count from proxy_request_logs
      `).get() as CountRow).count;
      database.prepare(`
        insert into proxy_request_logs (
          entity_key, ordinal, created_at, app, provider_id, run_id, candidate_id, json
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        log.id,
        ordinal,
        log.createdAt,
        log.app,
        log.providerId,
        log.runId ?? null,
        log.candidateId ?? null,
        JSON.stringify(log)
      );
      database.exec("commit");
    } catch (error: unknown) {
      try { database.exec("rollback"); } catch {}
      throw error;
    }
  }

  override async listProxyRequestLogs(options: {
    app?: ManagedAgentApp;
    providerId?: string;
    runId?: string;
    candidateId?: string;
    limit?: number;
  } = {}): Promise<ProxyRequestLog[]> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("proxy log limit is invalid");
    const result = this.database().prepare(`
      select json
      from proxy_request_logs
      where (? is null or app = ?)
        and (? is null or provider_id = ?)
        and (? is null or run_id = ?)
        and (? is null or candidate_id = ?)
      order by created_at desc, ordinal desc
      limit ?
    `).all(
      options.app ?? null,
      options.app ?? null,
      options.providerId ?? null,
      options.providerId ?? null,
      options.runId ?? null,
      options.runId ?? null,
      options.candidateId ?? null,
      options.candidateId ?? null,
      limit
    ) as JsonRow[];
    return result.map((row) => JSON.parse(row.json) as ProxyRequestLog);
  }

  override async listProviderHealth(options: {
    app?: ManagedAgentApp;
    providerId?: string;
  } = {}): Promise<ProviderHealthRecord[]> {
    return rows<ProviderHealthRecord>(
      this.database(),
      "select json from provider_health order by ordinal"
    )
      .filter((health) => options.app === undefined || health.app === options.app)
      .filter((health) => options.providerId === undefined || health.providerId === options.providerId)
      .map((health) => effectiveProviderHealth(health))
      .sort((left, right) => left.app.localeCompare(right.app)
        || left.providerId.localeCompare(right.providerId));
  }

  override async getProviderHealth(
    providerId: string,
    app?: ManagedAgentApp
  ): Promise<ProviderHealthRecord | undefined> {
    return (await this.listProviderHealth({ providerId, ...(app === undefined ? {} : { app }) }))[0];
  }

  override async resetProviderHealth(options: {
    providerId: string;
    app?: ManagedAgentApp;
  }): Promise<ProviderHealthRecord[]> {
    const database = this.database();
    database.exec("begin immediate");
    try {
      const current = rows<ProviderHealthRecord>(
        database,
        options.app === undefined
          ? "select json from provider_health where json_extract(json, '$.providerId') = ? order by ordinal"
          : "select json from provider_health where json_extract(json, '$.providerId') = ? and json_extract(json, '$.app') = ? order by ordinal",
        options.providerId,
        ...(options.app === undefined ? [] : [options.app])
      );
      if (options.app === undefined) {
        database.prepare(`
          delete from provider_health where json_extract(json, '$.providerId') = ?
        `).run(options.providerId);
      } else {
        database.prepare("delete from provider_health where entity_key = ?")
          .run(`${options.providerId}\0${options.app}`);
      }
      database.exec("commit");
      return current.map((health) => effectiveProviderHealth(health))
        .sort((left, right) => left.app.localeCompare(right.app));
    } catch (error: unknown) {
      try { database.exec("rollback"); } catch {}
      throw error;
    }
  }

  override async recordProviderHealthEvent(event: ProviderHealthEvent): Promise<ProviderHealthRecord> {
    const database = this.database();
    const key = `${event.providerId}\0${event.app}`;
    database.exec("begin immediate");
    try {
      const row = database.prepare("select ordinal, json from provider_health where entity_key = ?")
        .get(key) as { ordinal: number; json: string } | undefined;
      const current = row === undefined ? undefined : JSON.parse(row.json) as ProviderHealthRecord;
      const updated = nextProviderHealth(current, event);
      const ordinal = row?.ordinal ?? (database.prepare(`
        select coalesce(max(ordinal), -1) + 1 as count from provider_health
      `).get() as CountRow).count;
      database.prepare(`
        insert into provider_health (entity_key, ordinal, json) values (?, ?, ?)
        on conflict(entity_key) do update set json = excluded.json
      `).run(key, ordinal, JSON.stringify(updated));
      database.exec("commit");
      return effectiveProviderHealth(updated);
    } catch (error: unknown) {
      try { database.exec("rollback"); } catch {}
      throw error;
    }
  }

  override async getProxyReplayRecord(key: string): Promise<ProxyReplayRecord | undefined> {
    const row = this.database().prepare(`
      select json from proxy_replay_records where entity_key = ?
    `).get(key) as JsonRow | undefined;
    return row === undefined ? undefined : JSON.parse(row.json) as ProxyReplayRecord;
  }

  override async saveProxyReplayRecord(record: ProxyReplayRecord): Promise<ProxyReplayRecord> {
    const database = this.database();
    database.exec("begin immediate");
    try {
      const existing = database.prepare(`
        select ordinal as count from proxy_replay_records where entity_key = ?
      `).get(record.key) as CountRow | undefined;
      const ordinal = existing?.count ?? (database.prepare(`
        select coalesce(max(ordinal), -1) + 1 as count from proxy_replay_records
      `).get() as CountRow).count;
      database.prepare(`
        insert into proxy_replay_records (entity_key, ordinal, json) values (?, ?, ?)
        on conflict(entity_key) do update set json = excluded.json
      `).run(record.key, ordinal, JSON.stringify(record));
      database.exec("commit");
      return record;
    } catch (error: unknown) {
      try { database.exec("rollback"); } catch {}
      throw error;
    }
  }

  override async markProxyReplayRecordReplayed(
    key: string,
    now = new Date().toISOString()
  ): Promise<ProxyReplayRecord | undefined> {
    const current = await this.getProxyReplayRecord(key);
    if (current === undefined) return undefined;
    const updated = { ...current, lastReplayedAt: now, replayCount: current.replayCount + 1 };
    return this.saveProxyReplayRecord(updated);
  }

  close(): void {
    this.databaseHandle?.close();
    this.databaseHandle = undefined;
  }

  private database(): DatabaseSync {
    if (this.databaseHandle) return this.databaseHandle;
    this.prepareRoot();
    const classification = this.classifyExistingDatabase();
    if (classification.kind === "legacy") this.backupLegacyDatabase();

    const database = new DatabaseSync(this.databaseFile);
    try {
      chmodSync(this.databaseFile, 0o600);
      this.configure(database);
      if (classification.kind === "new") {
        database.exec("begin immediate");
        try {
          createSchemaV2(database);
          replaceData(database, emptyStoreData());
          database.exec(`pragma user_version = ${SCHEMA_VERSION}`);
          database.exec("commit");
        } catch (error: unknown) {
          try { database.exec("rollback"); } catch {}
          throw error;
        }
      } else if (classification.kind === "legacy") {
        this.migrateLegacy(database, classification.raw);
      }
      this.verifySchema(database);
      this.databaseHandle = database;
      return database;
    } catch (error: unknown) {
      database.close();
      throw error;
    }
  }

  private prepareRoot(): void {
    if (!existsSync(this.rootDir)) mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    assertPrivatePath(this.rootDir, "directory");
    chmodSync(this.rootDir, 0o700);
    realpathSync(this.rootDir);
    if (existsSync(this.databaseFile)) assertPrivatePath(this.databaseFile, "file");
  }

  private classifyExistingDatabase():
    | { readonly kind: "new" }
    | { readonly kind: "v2" }
    | { readonly kind: "legacy"; readonly raw: string } {
    if (!existsSync(this.databaseFile)) return { kind: "new" };
    const probe = new DatabaseSync(this.databaseFile, { readOnly: true });
    try {
      const version = (probe.prepare("pragma user_version").get() as { user_version: number }).user_version;
      const tables = tableNames(probe);
      if (version === SCHEMA_VERSION && [...REQUIRED_TABLES].every((table) => tables.has(table))) {
        return { kind: "v2" };
      }
      if (version === 0 && tables.size === 0) return { kind: "new" };
      if (version === 0 && tables.size === 1 && tables.has("local_state")) {
        const row = probe.prepare("select value from local_state where key = ?").get("data") as { value: string } | undefined;
        return { kind: "legacy", raw: row?.value ?? JSON.stringify(emptyStoreData()) };
      }
      throw new Error("SQLite store schema is unknown or incomplete");
    } finally {
      probe.close();
    }
  }

  private backupLegacyDatabase(): void {
    const fileDigest = sha256(readFileSync(this.databaseFile));
    const backup = join(
      this.rootDir,
      `${basename(this.databaseFile)}.v1-backup-${fileDigest.slice(0, 16)}`
    );
    if (existsSync(backup)) {
      assertPrivatePath(backup, "file");
      if (sha256(readFileSync(backup)) !== fileDigest) {
        throw new Error("SQLite legacy backup path contains different data");
      }
    } else {
      copyFileSync(this.databaseFile, backup, constants.COPYFILE_EXCL);
      chmodSync(backup, 0o600);
      const handle = openSync(backup, constants.O_RDONLY);
      try { fsyncSync(handle); } finally { closeSync(handle); }
      syncDirectory(this.rootDir);
    }
    this.backupFile = backup;
  }

  private migrateLegacy(database: DatabaseSync, raw: string): void {
    let parsed: Partial<LocalStoreData>;
    try {
      parsed = JSON.parse(raw) as Partial<LocalStoreData>;
    } catch {
      throw new Error("SQLite legacy state contains invalid JSON");
    }
    const normalized = normalizeData(parsed);
    database.exec("begin immediate");
    try {
      createSchemaV2(database);
      replaceData(database, normalized);
      assertCounts(database, normalized);
      if (sha256(JSON.stringify(readData(database))) !== sha256(JSON.stringify(normalized))) {
        throw new Error("SQLite migration digest verification failed");
      }
      database.prepare(`
        insert into store_meta (key, value) values ('legacy_blob_sha256', ?)
        on conflict(key) do update set value = excluded.value
      `).run(sha256(raw));
      database.exec("drop table local_state");
      database.exec(`pragma user_version = ${SCHEMA_VERSION}`);
      database.exec("commit");
    } catch (error: unknown) {
      try { database.exec("rollback"); } catch {}
      throw error;
    }
  }

  private configure(database: DatabaseSync): void {
    const journal = database.prepare("pragma journal_mode = wal").get() as { journal_mode: string };
    database.exec(`
      pragma synchronous = full;
      pragma foreign_keys = on;
      pragma trusted_schema = off;
      pragma busy_timeout = 5000;
    `);
    const synchronous = (database.prepare("pragma synchronous").get() as { synchronous: number }).synchronous;
    const foreignKeys = (database.prepare("pragma foreign_keys").get() as { foreign_keys: number }).foreign_keys;
    const trustedSchema = (database.prepare("pragma trusted_schema").get() as { trusted_schema: number }).trusted_schema;
    if (journal.journal_mode.toLowerCase() !== "wal"
      || synchronous !== 2
      || foreignKeys !== 1
      || trustedSchema !== 0) {
      throw new Error("SQLite safety pragmas could not be established");
    }
  }

  private verifySchema(database: DatabaseSync): void {
    const version = (database.prepare("pragma user_version").get() as { user_version: number }).user_version;
    const tables = tableNames(database);
    if (version !== SCHEMA_VERSION
      || [...REQUIRED_TABLES].some((table) => !tables.has(table))
      || tables.has("local_state")) {
      throw new Error("SQLite v2 schema verification failed");
    }
    const integrity = database.prepare("pragma quick_check").get() as { quick_check: string };
    if (integrity.quick_check !== "ok") throw new Error("SQLite integrity verification failed");
    const tableList = database.prepare("pragma table_list").all() as Array<{ name: string; strict: number }>;
    for (const table of REQUIRED_TABLES) {
      if (tableList.find((entry) => entry.name === table)?.strict !== 1) {
        throw new Error("SQLite v2 tables must be STRICT");
      }
    }
    assertPrivatePath(this.databaseFile, "file");
    if (dirname(realpathSync(this.databaseFile)) !== realpathSync(this.rootDir)) {
      throw new Error("SQLite database escapes its private root");
    }
    const current = statSync(this.databaseFile);
    if (!current.isFile()) throw new Error("SQLite database identity is invalid");
  }
}
