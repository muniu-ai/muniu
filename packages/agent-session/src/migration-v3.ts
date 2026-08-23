// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  digestJson,
  createAgentEventV3,
  isAgentEventV3,
  isAgentSessionEventV1,
  isAgentSessionEventV2,
  isCanonicalRfc3339,
  migrateAgentSessionEventToV3,
  verifyAgentEventV3Chain,
  verifyAgentSessionEventChain,
  verifyAgentSessionEventChainV2,
  type AgentEventV3,
  type NewAgentEventV3,
  type AgentSessionEvent,
  type AgentSessionEventV1,
  type AgentSessionEventV2,
  type JsonValue
} from "@mn/agent-protocol";

import { projectThreadV3 } from "./thread-v3.js";
import {
  acquireEventWriterLock,
  acquireOsWriterLock,
  type EventWriterLock,
  type OsWriterLock
} from "./writer-lock.js";

const MANIFEST_NAME = "app-server-v3-migration.json";
const TARGET_THREADS = "threads";
const TARGET_PROJECTION = "thread-projection-v3.db";
const SOURCE_ASSETS = Object.freeze([
  "sessions",
  "projection.db",
  "projection.db-shm",
  "projection.db-wal",
  "mutations.jsonl",
  "attachments"
]);
const MAX_EVENT_LOG_BYTES = 256 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS_PER_THREAD = 100_000;
const V3_APPEND_QUEUES = new Map<string, Promise<void>>();

export interface LocalMigrationArtifactV3 {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly byteLength: number;
  readonly digest: string;
}

export interface LocalMigrationThreadV3 {
  readonly threadId: string;
  readonly sourceSchemaVersion: 1 | 2;
  readonly eventCount: number;
  readonly sourceHeaderDigest: string;
  readonly oldChainDigest: string;
  readonly newChainDigest: string;
  readonly mappingDigest: string;
}

export interface LocalAppServerV3MigrationInspection {
  readonly schemaVersion: 3;
  readonly kind: "app-server-v3-migration";
  readonly mode: "dry-run";
  readonly migrationId: string;
  readonly toolVersion: "0.2.0";
  readonly oldRootDigest: string;
  readonly newRootDigest: string;
  readonly sessionCount: number;
  readonly eventCount: number;
  readonly sourceArtifacts: readonly LocalMigrationArtifactV3[];
  readonly threads: readonly LocalMigrationThreadV3[];
}

export interface LocalAppServerV3MigrationManifest
  extends Omit<LocalAppServerV3MigrationInspection, "mode"> {
  readonly mode: "applied";
  readonly appliedAt: string;
  readonly archivePath: string;
}

export interface LocalAppServerV3RollbackResult {
  readonly schemaVersion: 3;
  readonly kind: "app-server-v3-migration";
  readonly mode: "rolled-back";
  readonly migrationId: string;
  readonly archivePath: string;
}

interface LoadedLegacyThread {
  readonly threadId: string;
  readonly sourceSchemaVersion: 1 | 2;
  readonly header: Record<string, unknown>;
  readonly headerDigest: string;
  readonly oldEvents: readonly AgentSessionEvent[];
  readonly newEvents: readonly AgentEventV3[];
  readonly mappingLines: readonly string[];
  readonly summary: LocalMigrationThreadV3;
}

interface PreparedMigration {
  readonly inspection: LocalAppServerV3MigrationInspection;
  readonly threads: readonly LoadedLegacyThread[];
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  return lstat(filePath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function readRegularFile(filePath: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`migration refuses symbolic link: ${path.basename(filePath)}`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > maxBytes) {
      throw new Error(`migration input is not a bounded regular file: ${path.basename(filePath)}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseJsonRecord(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseAgentEventV3Jsonl(bytes: Buffer): readonly AgentEventV3[] {
  if (bytes.byteLength > 0 && bytes.at(-1) !== 0x0a) throw new Error("V3 event log has a torn final line");
  const lines = bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > MAX_EVENTS_PER_THREAD) {
    throw new Error("V3 event log count is invalid");
  }
  const events = lines.map((line, index) => {
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
      throw new Error(`V3 event line ${index + 1} exceeds its bound`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`V3 event line ${index + 1} contains invalid JSON`);
    }
    if (!isAgentEventV3(value)) throw new Error(`V3 event line ${index + 1} has an invalid envelope`);
    return value;
  });
  verifyAgentEventV3Chain(events);
  return Object.freeze(events);
}

export async function readAgentEventV3Jsonl(filePath: string): Promise<readonly AgentEventV3[]> {
  return parseAgentEventV3Jsonl(await readRegularFile(filePath, MAX_EVENT_LOG_BYTES));
}

export type AgentEventV3ContinuationInput = Omit<
  NewAgentEventV3,
  "threadId" | "sequence" | "causationId" | "previousDigest"
>;

async function appendAgentEventV3AtCanonicalPath(
  canonicalPath: string,
  input: AgentEventV3ContinuationInput
): Promise<AgentEventV3> {
  const pathLease = await acquireOsWriterLock(`v3-event-path:${canonicalPath}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let eventLease: EventWriterLock | undefined;
  let result: AgentEventV3 | undefined;
  let failure: unknown;
  try {
    handle = await open(
      canonicalPath,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const [fileStat, currentPathStat] = await Promise.all([handle.stat(), lstat(canonicalPath)]);
    const uid = process.getuid?.();
    if (!fileStat.isFile() || fileStat.nlink !== 1
      || currentPathStat.isSymbolicLink()
      || fileStat.dev !== currentPathStat.dev || fileStat.ino !== currentPathStat.ino
      || uid !== undefined && fileStat.uid !== uid
      || (fileStat.mode & 0o077) !== 0
      || fileStat.size > MAX_EVENT_LOG_BYTES) {
      throw new Error("V3 event log has unsafe type, ownership, permissions, links, or size");
    }
    const events = parseAgentEventV3Jsonl(await handle.readFile());
    const previous = events.at(-1) as AgentEventV3;
    if (events.some((event) => event.eventId === input.eventId)) {
      throw new Error("V3 event identifier is already present in the thread");
    }
    const event = createAgentEventV3({
      ...input,
      threadId: previous.threadId,
      sequence: previous.sequence + 1,
      causationId: previous.eventId,
      previousDigest: previous.digest
    });
    projectThreadV3([...events, event]);
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
      throw new Error("V3 event exceeds the durable append bound");
    }
    eventLease = await acquireEventWriterLock(`inode:${fileStat.dev}:${fileStat.ino}`, handle);
    await eventLease.append(line);
    result = event;
  } catch (error: unknown) {
    failure = error;
  }
  const cleanup = await Promise.allSettled([
    ...(eventLease === undefined ? [] : [eventLease.release()]),
    ...(handle === undefined ? [] : [handle.close()]),
    pathLease.release()
  ]);
  const cleanupFailures = cleanup.flatMap((entry) => entry.status === "rejected" ? [entry.reason] : []);
  if (failure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError([failure, ...cleanupFailures], "V3 append and cleanup failed", { cause: failure });
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "V3 append cleanup failed after a durable write");
  }
  return result as AgentEventV3;
}

export async function appendAgentEventV3Jsonl(
  filePath: string,
  input: AgentEventV3ContinuationInput
): Promise<AgentEventV3> {
  const resolved = path.resolve(filePath);
  const canonicalParent = await realpath(path.dirname(resolved));
  const canonicalPath = path.join(canonicalParent, path.basename(resolved));
  const previous = V3_APPEND_QUEUES.get(canonicalPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  V3_APPEND_QUEUES.set(canonicalPath, current);
  await previous;
  try {
    return await appendAgentEventV3AtCanonicalPath(canonicalPath, input);
  } finally {
    release();
    if (V3_APPEND_QUEUES.get(canonicalPath) === current) V3_APPEND_QUEUES.delete(canonicalPath);
  }
}

async function readLegacyEvents(filePath: string): Promise<readonly AgentSessionEvent[]> {
  const bytes = await readRegularFile(filePath, MAX_EVENT_LOG_BYTES);
  if (bytes.byteLength > 0 && bytes.at(-1) !== 0x0a) throw new Error("legacy event log has a torn final line");
  const lines = bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > MAX_EVENTS_PER_THREAD) {
    throw new Error("legacy event log count is invalid");
  }
  const events = lines.map((line, index): AgentSessionEvent => {
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
      throw new Error(`legacy event line ${index + 1} exceeds its bound`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`legacy event line ${index + 1} contains invalid JSON`);
    }
    if (!isAgentSessionEventV1(value) && !isAgentSessionEventV2(value)) {
      throw new Error(`legacy event line ${index + 1} has an invalid or unknown envelope`);
    }
    return value;
  });
  if (events[0]?.schemaVersion === 1) {
    if (events.some((event) => event.schemaVersion !== 1)) throw new Error("legacy event chain mixes schemas");
    verifyAgentSessionEventChain(events as readonly AgentSessionEventV1[]);
  } else {
    if (events.some((event) => event.schemaVersion !== 2)) throw new Error("legacy event chain mixes schemas");
    verifyAgentSessionEventChainV2(events as readonly AgentSessionEventV2[]);
  }
  return Object.freeze(events);
}

function validateLegacyHeader(
  value: Record<string, unknown>,
  threadId: string,
  events: readonly AgentSessionEvent[]
): 1 | 2 {
  const schemaVersion = value.schemaVersion;
  const created = events[0];
  if (schemaVersion !== 1 && schemaVersion !== 2
    || value.sessionId !== threadId
    || !isCanonicalRfc3339(value.createdAt)
    || created?.type !== "session/created"
    || created.sessionId !== threadId
    || created.schemaVersion !== schemaVersion
    || created.occurredAt !== value.createdAt) {
    throw new Error(`legacy session ${threadId} has an invalid header binding`);
  }
  return schemaVersion;
}

function mappingLine(oldEvent: AgentSessionEvent, newEvent: AgentEventV3): string {
  return JSON.stringify({
    schemaVersion: 1,
    source: {
      schemaVersion: oldEvent.schemaVersion,
      sessionId: oldEvent.sessionId,
      eventId: oldEvent.eventId,
      sequence: oldEvent.seq,
      payloadDigest: oldEvent.payloadDigest,
      eventDigest: oldEvent.digest
    },
    target: {
      schemaVersion: 3,
      threadId: newEvent.threadId,
      eventId: newEvent.eventId,
      sequence: newEvent.sequence,
      eventDigest: newEvent.digest
    }
  });
}

async function loadLegacyThread(sessionsRoot: string, entry: Dirent): Promise<LoadedLegacyThread> {
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`legacy sessions contains an unsupported entry: ${entry.name}`);
  }
  const directory = path.join(sessionsRoot, entry.name);
  const canonical = await realpath(directory);
  if (path.dirname(canonical) !== sessionsRoot || path.basename(canonical) !== entry.name) {
    throw new Error("legacy session directory escapes the migration root");
  }
  const headerBytes = await readRegularFile(path.join(directory, "header.json"), 1024 * 1024);
  const header = parseJsonRecord(headerBytes, `legacy session ${entry.name} header`);
  const oldEvents = await readLegacyEvents(path.join(directory, "events.jsonl"));
  const sourceSchemaVersion = validateLegacyHeader(header, entry.name, oldEvents);
  const newEvents: AgentEventV3[] = [];
  for (const oldEvent of oldEvents) {
    newEvents.push(migrateAgentSessionEventToV3(oldEvent, newEvents.at(-1)));
  }
  verifyAgentEventV3Chain(newEvents);
  projectThreadV3(newEvents);
  const lines = oldEvents.map((event, index) => mappingLine(event, newEvents[index] as AgentEventV3));
  const summary: LocalMigrationThreadV3 = Object.freeze({
    threadId: entry.name,
    sourceSchemaVersion,
    eventCount: oldEvents.length,
    sourceHeaderDigest: sha256(headerBytes),
    oldChainDigest: oldEvents.at(-1)?.digest as string,
    newChainDigest: newEvents.at(-1)?.digest as string,
    mappingDigest: sha256(`${lines.join("\n")}\n`)
  });
  return {
    threadId: entry.name,
    sourceSchemaVersion,
    header,
    headerDigest: summary.sourceHeaderDigest,
    oldEvents,
    newEvents: Object.freeze(newEvents),
    mappingLines: Object.freeze(lines),
    summary
  };
}

async function artifactDigest(root: string, relativePath: string): Promise<LocalMigrationArtifactV3> {
  const target = path.join(root, relativePath);
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink()) throw new Error(`migration refuses symbolic link: ${relativePath}`);
  if (targetStat.isFile()) {
    const bytes = await readRegularFile(target, MAX_EVENT_LOG_BYTES);
    return Object.freeze({
      path: relativePath,
      kind: "file",
      byteLength: bytes.byteLength,
      digest: sha256(bytes)
    });
  }
  if (!targetStat.isDirectory()) throw new Error(`migration artifact has an unsupported type: ${relativePath}`);
  const entries = (await readdir(target, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const children: LocalMigrationArtifactV3[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`migration refuses symbolic link: ${relativePath}/${entry.name}`);
    children.push(await artifactDigest(root, path.join(relativePath, entry.name)));
  }
  const byteLength = children.reduce((total, child) => total + child.byteLength, 0);
  return Object.freeze({
    path: relativePath,
    kind: "directory",
    byteLength,
    digest: digestJson(children.map((child) => ({
      path: child.path,
      kind: child.kind,
      byteLength: child.byteLength,
      digest: child.digest
    })) as JsonValue)
  });
}

async function prepareMigration(root: string): Promise<PreparedMigration> {
  const sessionsRoot = path.join(root, "sessions");
  const sessionsStat = await lstat(sessionsRoot);
  if (!sessionsStat.isDirectory() || sessionsStat.isSymbolicLink()) {
    throw new Error("legacy sessions root is not a directory");
  }
  const entries = (await readdir(sessionsRoot, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) throw new Error("legacy sessions root is empty");
  const threads: LoadedLegacyThread[] = [];
  for (const entry of entries) threads.push(await loadLegacyThread(sessionsRoot, entry));
  const sourceArtifacts: LocalMigrationArtifactV3[] = [];
  for (const relativePath of SOURCE_ASSETS) {
    if (await exists(path.join(root, relativePath))) {
      sourceArtifacts.push(await artifactDigest(root, relativePath));
    }
  }
  const oldRootDigest = digestJson({
    threads: threads.map((thread) => ({
      threadId: thread.threadId,
      sourceSchemaVersion: thread.sourceSchemaVersion,
      eventCount: thread.summary.eventCount,
      sourceHeaderDigest: thread.summary.sourceHeaderDigest,
      oldChainDigest: thread.summary.oldChainDigest
    })),
    sourceArtifacts
  } as unknown as JsonValue);
  const newRootDigest = digestJson({
    threads: threads.map((thread) => ({
      threadId: thread.threadId,
      eventCount: thread.summary.eventCount,
      newChainDigest: thread.summary.newChainDigest,
      mappingDigest: thread.summary.mappingDigest
    }))
  } as unknown as JsonValue);
  const migrationId = `migration-${newRootDigest.slice(0, 32)}`;
  const inspection: LocalAppServerV3MigrationInspection = Object.freeze({
    schemaVersion: 3,
    kind: "app-server-v3-migration",
    mode: "dry-run",
    migrationId,
    toolVersion: "0.2.0",
    oldRootDigest,
    newRootDigest,
    sessionCount: threads.length,
    eventCount: threads.reduce((total, thread) => total + thread.oldEvents.length, 0),
    sourceArtifacts: Object.freeze(sourceArtifacts),
    threads: Object.freeze(threads.map((thread) => thread.summary))
  });
  return { inspection, threads: Object.freeze(threads) };
}

async function canonicalMigrationRoot(inputRoot: string): Promise<string> {
  const root = path.resolve(inputRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("migration root is not a directory");
  return realpath(root);
}

async function withMigrationLocks<T>(inputRoot: string, operation: (root: string) => Promise<T>): Promise<T> {
  const root = await canonicalMigrationRoot(inputRoot);
  const leases: OsWriterLock[] = [];
  let operationFailed = false;
  let operationError: unknown;
  let result!: T;
  try {
    leases.push(await acquireOsWriterLock(`migration:${root}`));
    const sessionsRoot = path.join(root, "sessions");
    if (await exists(sessionsRoot)) {
      const canonicalSessionsRoot = await realpath(sessionsRoot);
      const names = (await readdir(canonicalSessionsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();
      for (const name of names) {
        leases.push(await acquireOsWriterLock(`path:${path.join(canonicalSessionsRoot, name)}`));
      }
    }
    result = await operation(root);
  } catch (error: unknown) {
    operationFailed = true;
    operationError = error;
  }
  const released = await Promise.allSettled(leases.reverse().map((lease) => lease.release()));
  const releaseFailures = released.flatMap((entry) => entry.status === "rejected" ? [entry.reason] : []);
  if (operationFailed && releaseFailures.length > 0) {
    throw new AggregateError(
      [operationError, ...releaseFailures],
      "migration failed and its locks could not be released"
    );
  }
  if (operationFailed) throw operationError;
  if (releaseFailures.length > 0) {
    throw new AggregateError(releaseFailures, "migration locks could not be released");
  }
  return result;
}

async function writeThread(stagingThreads: string, thread: LoadedLegacyThread): Promise<void> {
  const directory = path.join(stagingThreads, thread.threadId);
  await mkdir(directory, { mode: 0o700 });
  const header = {
    schemaVersion: 3,
    kind: "agent-thread-header",
    threadId: thread.threadId,
    createdAt: thread.oldEvents[0]?.occurredAt,
    source: {
      schemaVersion: thread.sourceSchemaVersion,
      headerDigest: thread.headerDigest,
      oldChainDigest: thread.summary.oldChainDigest
    }
  };
  const events = `${thread.newEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const mapping = `${thread.mappingLines.join("\n")}\n`;
  const projection = projectThreadV3(thread.newEvents);
  await Promise.all([
    writeFile(path.join(directory, "header.json"), `${JSON.stringify(header)}\n`, { mode: 0o600, flag: "wx" }),
    writeFile(path.join(directory, "events.jsonl"), events, { mode: 0o600, flag: "wx" }),
    writeFile(path.join(directory, "mapping.jsonl"), mapping, { mode: 0o600, flag: "wx" }),
    writeFile(path.join(directory, "projection.json"), `${JSON.stringify(projection)}\n`, { mode: 0o600, flag: "wx" })
  ]);
}

function writeProjectionDatabase(filePath: string, threads: readonly LoadedLegacyThread[]): void {
  const database = new DatabaseSync(filePath);
  try {
    database.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE mn_threads_v3 (
        thread_id text PRIMARY KEY,
        last_sequence integer NOT NULL,
        last_digest text NOT NULL,
        projection_json text NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE mn_agent_events_v3 (
        thread_id text NOT NULL,
        sequence integer NOT NULL,
        event_id text NOT NULL,
        event_digest text NOT NULL,
        source_event_digest text,
        PRIMARY KEY (thread_id, sequence),
        UNIQUE (thread_id, event_id)
      ) WITHOUT ROWID;
    `);
    const insertThread = database.prepare(`
      INSERT INTO mn_threads_v3(thread_id,last_sequence,last_digest,projection_json)
      VALUES (?,?,?,?)
    `);
    const insertEvent = database.prepare(`
      INSERT INTO mn_agent_events_v3(thread_id,sequence,event_id,event_digest,source_event_digest)
      VALUES (?,?,?,?,?)
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const thread of threads) {
        const projection = projectThreadV3(thread.newEvents);
        insertThread.run(
          thread.threadId,
          projection.lastSequence,
          projection.lastDigest,
          JSON.stringify(projection)
        );
        for (const event of thread.newEvents) {
          insertEvent.run(
            thread.threadId,
            event.sequence,
            event.eventId,
            event.digest,
            event.source?.eventDigest ?? null
          );
        }
      }
      database.exec("COMMIT");
    } catch (error: unknown) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

async function verifyStaging(stagingRoot: string, prepared: PreparedMigration): Promise<void> {
  const summaries: Array<{ threadId: string; eventCount: number; newChainDigest: string; mappingDigest: string }> = [];
  for (const thread of prepared.threads) {
    const directory = path.join(stagingRoot, TARGET_THREADS, thread.threadId);
    const events = await readAgentEventV3Jsonl(path.join(directory, "events.jsonl"));
    const mapping = await readRegularFile(path.join(directory, "mapping.jsonl"), MAX_EVENT_LOG_BYTES);
    projectThreadV3(events);
    summaries.push({
      threadId: thread.threadId,
      eventCount: events.length,
      newChainDigest: events.at(-1)?.digest as string,
      mappingDigest: sha256(mapping)
    });
  }
  const digest = digestJson({ threads: summaries } as unknown as JsonValue);
  if (digest !== prepared.inspection.newRootDigest) {
    throw new Error("generated V3 root digest verification failed");
  }
  const database = new DatabaseSync(path.join(stagingRoot, TARGET_PROJECTION), { readOnly: true });
  try {
    const row = database.prepare("SELECT count(*) AS count FROM mn_agent_events_v3").get() as { count: number };
    if (Number(row.count) !== prepared.inspection.eventCount) {
      throw new Error("generated V3 SQLite projection count verification failed");
    }
  } finally {
    database.close();
  }
}

async function chmodTree(target: string, directoryMode: number, fileMode: number): Promise<void> {
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink()) throw new Error("migration archive contains a symbolic link");
  if (targetStat.isDirectory()) {
    await chmod(target, directoryMode);
    for (const entry of await readdir(target)) {
      await chmodTree(path.join(target, entry), directoryMode, fileMode);
    }
  } else if (targetStat.isFile()) {
    await chmod(target, fileMode);
  } else {
    throw new Error("migration archive contains an unsupported file type");
  }
}

async function currentV3SemanticRoot(root: string): Promise<{
  readonly digest: string;
  readonly sessionCount: number;
  readonly eventCount: number;
}> {
  const threadsRoot = path.join(root, TARGET_THREADS);
  const entries = (await readdir(threadsRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const summaries: Array<{ threadId: string; eventCount: number; newChainDigest: string; mappingDigest: string }> = [];
  let eventCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("V3 thread root contains an invalid entry");
    const directory = path.join(threadsRoot, entry.name);
    const events = await readAgentEventV3Jsonl(path.join(directory, "events.jsonl"));
    const mapping = await readRegularFile(path.join(directory, "mapping.jsonl"), MAX_EVENT_LOG_BYTES);
    eventCount += events.length;
    summaries.push({
      threadId: entry.name,
      eventCount: events.length,
      newChainDigest: events.at(-1)?.digest as string,
      mappingDigest: sha256(mapping)
    });
  }
  return {
    digest: digestJson({ threads: summaries } as unknown as JsonValue),
    sessionCount: entries.length,
    eventCount
  };
}

async function readManifest(root: string): Promise<LocalAppServerV3MigrationManifest> {
  const record = parseJsonRecord(
    await readRegularFile(path.join(root, MANIFEST_NAME), 4 * 1024 * 1024),
    "V3 migration manifest"
  );
  const digestPattern = /^[a-f0-9]{64}$/u;
  const migrationPattern = /^migration-[a-f0-9]{32}$/u;
  if (record.schemaVersion !== 3 || record.kind !== "app-server-v3-migration"
    || record.mode !== "applied" || record.toolVersion !== "0.2.0"
    || typeof record.migrationId !== "string" || !migrationPattern.test(record.migrationId)
    || typeof record.oldRootDigest !== "string" || !digestPattern.test(record.oldRootDigest)
    || typeof record.newRootDigest !== "string" || !digestPattern.test(record.newRootDigest)
    || typeof record.archivePath !== "string"
    || record.archivePath !== path.join("archive", `app-server-v1-v2-${record.migrationId}`)
    || !isCanonicalRfc3339(record.appliedAt)
    || typeof record.sessionCount !== "number"
    || !Number.isSafeInteger(record.sessionCount) || record.sessionCount < 1
    || typeof record.eventCount !== "number"
    || !Number.isSafeInteger(record.eventCount) || record.eventCount < record.sessionCount
    || !Array.isArray(record.sourceArtifacts) || !Array.isArray(record.threads)) {
    throw new Error("V3 migration manifest is invalid");
  }
  return record as unknown as LocalAppServerV3MigrationManifest;
}

export function inspectLocalAppServerV3Migration(options: {
  readonly root: string;
}): Promise<LocalAppServerV3MigrationInspection> {
  return withMigrationLocks(options.root, async (root) => {
    if (await exists(path.join(root, TARGET_THREADS)) || await exists(path.join(root, MANIFEST_NAME))) {
      throw new Error("V3 target already exists");
    }
    return (await prepareMigration(root)).inspection;
  });
}

export function applyLocalAppServerV3Migration(options: {
  readonly root: string;
}): Promise<LocalAppServerV3MigrationManifest> {
  return withMigrationLocks(options.root, async (root) => {
    if (await exists(path.join(root, TARGET_THREADS))
      || await exists(path.join(root, TARGET_PROJECTION))
      || await exists(path.join(root, MANIFEST_NAME))) {
      throw new Error("V3 target already exists");
    }
    const prepared = await prepareMigration(root);
    const archiveRelative = path.join("archive", `app-server-v1-v2-${prepared.inspection.migrationId}`);
    const archiveRoot = path.join(root, archiveRelative);
    if (await exists(archiveRoot)) throw new Error("V3 migration archive already exists");
    const stagingRoot = path.join(root, `.app-server-v3-staging-${randomUUID()}`);
    await mkdir(stagingRoot, { mode: 0o700 });
    const stagingThreads = path.join(stagingRoot, TARGET_THREADS);
    await mkdir(stagingThreads, { mode: 0o700 });
    try {
      for (const thread of prepared.threads) await writeThread(stagingThreads, thread);
      writeProjectionDatabase(path.join(stagingRoot, TARGET_PROJECTION), prepared.threads);
      await chmod(path.join(stagingRoot, TARGET_PROJECTION), 0o600);
      await verifyStaging(stagingRoot, prepared);
      const repeated = await prepareMigration(root);
      if (repeated.inspection.oldRootDigest !== prepared.inspection.oldRootDigest) {
        throw new Error("legacy state changed during migration preflight");
      }
      await mkdir(path.dirname(archiveRoot), { recursive: true, mode: 0o700 });
      await mkdir(archiveRoot, { mode: 0o700 });
      const moved: string[] = [];
      let threadsPublished = false;
      let projectionPublished = false;
      try {
        for (const asset of SOURCE_ASSETS) {
          if (!await exists(path.join(root, asset))) continue;
          await rename(path.join(root, asset), path.join(archiveRoot, asset));
          moved.push(asset);
        }
        await chmodTree(archiveRoot, 0o500, 0o400);
        await rename(stagingThreads, path.join(root, TARGET_THREADS));
        threadsPublished = true;
        await rename(path.join(stagingRoot, TARGET_PROJECTION), path.join(root, TARGET_PROJECTION));
        projectionPublished = true;
        const manifest: LocalAppServerV3MigrationManifest = Object.freeze({
          ...prepared.inspection,
          mode: "applied",
          appliedAt: new Date().toISOString(),
          archivePath: archiveRelative
        });
        await writeFile(path.join(stagingRoot, MANIFEST_NAME), `${JSON.stringify(manifest)}\n`, {
          mode: 0o600,
          flag: "wx"
        });
        await rename(path.join(stagingRoot, MANIFEST_NAME), path.join(root, MANIFEST_NAME));
        await rm(stagingRoot, { recursive: true, force: true });
        return manifest;
      } catch (error: unknown) {
        if (threadsPublished && await exists(path.join(root, TARGET_THREADS))) {
          await rename(path.join(root, TARGET_THREADS), stagingThreads).catch(() => undefined);
        }
        if (projectionPublished && await exists(path.join(root, TARGET_PROJECTION))) {
          await rename(
            path.join(root, TARGET_PROJECTION),
            path.join(stagingRoot, TARGET_PROJECTION)
          ).catch(() => undefined);
        }
        if (await exists(archiveRoot)) {
          await chmodTree(archiveRoot, 0o700, 0o600).catch(() => undefined);
          for (const asset of moved.reverse()) {
            if (await exists(path.join(archiveRoot, asset))) {
              await rename(path.join(archiveRoot, asset), path.join(root, asset)).catch(() => undefined);
            }
          }
        }
        throw error;
      }
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

export function rollbackLocalAppServerV3Migration(options: {
  readonly root: string;
}): Promise<LocalAppServerV3RollbackResult> {
  return withMigrationLocks(options.root, async (root) => {
    const manifest = await readManifest(root);
    const current = await currentV3SemanticRoot(root);
    if (current.digest !== manifest.newRootDigest
      || current.sessionCount !== manifest.sessionCount
      || current.eventCount !== manifest.eventCount) {
      throw new Error("rollback refused because the V3 fact chain has a new write, count, or digest");
    }
    const oldArchive = path.join(root, manifest.archivePath);
    if (!await exists(oldArchive)) throw new Error("rollback source archive is missing");
    const oldArchiveStat = await lstat(oldArchive);
    if (!oldArchiveStat.isDirectory() || oldArchiveStat.isSymbolicLink()) {
      throw new Error("rollback source archive is invalid");
    }
    const oldPrepared = await prepareMigration(oldArchive);
    if (oldPrepared.inspection.oldRootDigest !== manifest.oldRootDigest
      || oldPrepared.inspection.sessionCount !== manifest.sessionCount
      || oldPrepared.inspection.eventCount !== manifest.eventCount) {
      throw new Error("rollback source archive no longer matches the migration manifest");
    }
    for (const asset of SOURCE_ASSETS) {
      if (await exists(path.join(oldArchive, asset)) && await exists(path.join(root, asset))) {
        throw new Error(`rollback target already exists: ${asset}`);
      }
    }
    const rollbackRelative = path.join("archive", `app-server-v3-rolled-back-${manifest.migrationId}`);
    const rollbackArchive = path.join(root, rollbackRelative);
    if (await exists(rollbackArchive)) throw new Error("rollback V3 archive already exists");
    await mkdir(rollbackArchive, { mode: 0o700 });
    const movedV3: string[] = [];
    const restoredLegacy: string[] = [];
    try {
      await rename(path.join(root, TARGET_THREADS), path.join(rollbackArchive, TARGET_THREADS));
      movedV3.push(TARGET_THREADS);
      if (await exists(path.join(root, TARGET_PROJECTION))) {
        await rename(path.join(root, TARGET_PROJECTION), path.join(rollbackArchive, TARGET_PROJECTION));
        movedV3.push(TARGET_PROJECTION);
      }
      await rename(path.join(root, MANIFEST_NAME), path.join(rollbackArchive, MANIFEST_NAME));
      movedV3.push(MANIFEST_NAME);
      await chmodTree(oldArchive, 0o700, 0o600);
      for (const asset of SOURCE_ASSETS) {
        if (await exists(path.join(oldArchive, asset))) {
          await rename(path.join(oldArchive, asset), path.join(root, asset));
          restoredLegacy.push(asset);
        }
      }
      await chmodTree(rollbackArchive, 0o500, 0o400);
    } catch (error: unknown) {
      const recoveryFailures: unknown[] = [];
      for (const asset of restoredLegacy.reverse()) {
        try {
          await rename(path.join(root, asset), path.join(oldArchive, asset));
        } catch (recoveryError: unknown) {
          recoveryFailures.push(recoveryError);
        }
      }
      for (const asset of movedV3.reverse()) {
        try {
          await rename(path.join(rollbackArchive, asset), path.join(root, asset));
        } catch (recoveryError: unknown) {
          recoveryFailures.push(recoveryError);
        }
      }
      await chmodTree(oldArchive, 0o500, 0o400).catch((recoveryError: unknown) => {
        recoveryFailures.push(recoveryError);
      });
      if (recoveryFailures.length === 0) {
        await rm(rollbackArchive).catch((recoveryError: unknown) => {
          recoveryFailures.push(recoveryError);
        });
      }
      if (recoveryFailures.length > 0) {
        throw new AggregateError([error, ...recoveryFailures], "rollback failed and recovery was incomplete");
      }
      throw error;
    }
    return Object.freeze({
      schemaVersion: 3,
      kind: "app-server-v3-migration",
      mode: "rolled-back",
      migrationId: manifest.migrationId,
      archivePath: rollbackRelative
    });
  });
}
