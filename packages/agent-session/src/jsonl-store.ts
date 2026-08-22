// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";

import {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  AGENT_SESSION_PROTECTION_PROFILE_V2,
  PROTECTION_POLICY_DIGEST_V1,
  SessionId,
  assertSafePublicControlIdV1,
  createProtectedTextV1,
  digestJson,
  deepFreeze,
  inspectAgentModelBindingV1,
  isAgentSessionEventV1,
  isAgentSessionEventV2,
  isCanonicalRfc3339,
  isProtectedTextV1,
  protectAgentSessionPayloadV1,
  protectAgentSessionPayloadV2,
  verifyAgentSessionEventChain,
  verifyAgentSessionEventChainV2,
  type AgentSessionEvent,
  type ProtectedJsonNodeV1,
  type ProtectedTextV1
} from "@mn/agent-protocol";
import {
  CREDENTIAL_MARKER,
  PHONE_MARKER,
  PRC_ID_MARKER,
  PRIVATE_KEY_MARKER,
  UNSAFE_MARKER
} from "@mn/data-policy";

import { snapshotAgentSessionEvent } from "./event-snapshot.js";
import { snapshotCreateAgentSessionOptions, type CreateAgentSessionOptionsSnapshot } from "./create-options.js";
import { createInitialAgentSessionState } from "./initial-state.js";
import { DurableAgentSession } from "./session.js";
import type { AgentSessionHeader, CreateAgentSessionOptions, EventPersistence } from "./types.js";
import {
  acquireEventWriterLock,
  acquireOsWriterLock,
  type EventWriterLock,
  type OsWriterLock
} from "./writer-lock.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const STAGING_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROCESS_SESSION_LEASES = new Map<string, WriterLease>();
const ACTIVE_SESSION_HOOK = new AsyncLocalStorage<SessionHookContext>();

interface SessionHookContext {
  readonly store: JsonlAgentSessionStore;
  active: boolean;
}

interface WriterLease {
  readonly owner: JsonlAgentSessionStore;
  readonly keys: Set<string>;
  readonly osLocks: Map<string, OsWriterLock>;
  directoryHandle?: FileHandle;
  directoryStat?: Stats;
  eventWriter?: EventWriterLock;
  eventStat?: Stats;
}

export interface JsonlAgentSessionStoreOptions {
  readonly beforeAppend?: (event: AgentSessionEvent) => void | Promise<void>;
  readonly afterPublish?: (
    phase: "renamed" | "committed",
    sessionId: SessionId
  ) => void | Promise<void>;
}

export type SessionCreateOutcome = "uncertain" | "committed";

export class LegacyUnprotectedSessionError extends Error {
  readonly code = "LEGACY_UNPROTECTED_SESSION";

  constructor() {
    super("legacy unprotected agent session requires an explicit migration before it can be opened");
    this.name = "LegacyUnprotectedSessionError";
  }
}

export class AgentSessionNotFoundError extends Error {
  readonly code = "AGENT_SESSION_NOT_FOUND";

  constructor() {
    super("agent session was not found");
    this.name = "AgentSessionNotFoundError";
  }
}

export class SessionCreateOutcomeError extends Error {
  readonly cleanupErrors: readonly unknown[];

  constructor(
    readonly sessionId: SessionId,
    readonly outcome: SessionCreateOutcome,
    cause: unknown,
    cleanupErrors: readonly unknown[] = []
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const combinedCause = cleanupErrors.length === 0
      ? cause
      : new AggregateError([cause, ...cleanupErrors], "session creation and cleanup both failed", { cause });
    super(`session "${sessionId}" creation ${outcome}: ${detail}`, { cause: combinedCause });
    this.name = "SessionCreateOutcomeError";
    this.cleanupErrors = Object.freeze([...cleanupErrors]);
  }
}

function assertSessionId(sessionId: SessionId): void {
  try {
    assertSafePublicControlIdV1(sessionId, "session identifier");
  } catch {
    throw new Error("session id is not safe for durable storage");
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("session id is not safe for durable storage");
}

function validateHeader(value: unknown, expectedId: SessionId): AgentSessionHeader {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session header");
  const header = value as Record<string, unknown>;
  if (header.schemaVersion === 1
    && (Object.hasOwn(header, "cwd") || !Object.hasOwn(header, "protectionProfile"))) {
    throw new LegacyUnprotectedSessionError();
  }
  const required = [
    "schemaVersion",
    "sessionId",
    "createdAt",
    "protectionProfile",
    "protectionPolicyDigest"
  ];
  const allowed = new Set([...required, "protectedCwd", "modelBinding"]);
  if (!required.every((key) => Object.hasOwn(header, key))
    || !Object.keys(header).every((key) => allowed.has(key))
    || header.schemaVersion !== 1 && header.schemaVersion !== 2
    || header.sessionId !== expectedId
    || !isCanonicalRfc3339(header.createdAt)
    || header.protectionProfile !== (header.schemaVersion === 1
      ? AGENT_SESSION_PROTECTION_PROFILE_V1
      : AGENT_SESSION_PROTECTION_PROFILE_V2)
    || header.protectionPolicyDigest !== PROTECTION_POLICY_DIGEST_V1) {
    throw new Error("invalid session header");
  }
  if (header.protectedCwd !== undefined && !isProtectedTextV1(header.protectedCwd)) {
    throw new Error("invalid protected session header cwd");
  }
  if (header.modelBinding !== undefined && inspectAgentModelBindingV1(header.modelBinding) === undefined) {
    throw new Error("invalid session header model binding");
  }
  return deepFreeze(header as unknown as AgentSessionHeader);
}

function creationSnapshotDigest(options: CreateAgentSessionOptionsSnapshot): string {
  const raw = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.labels === undefined ? {} : { labels: options.labels }),
    ...(options.modelBinding === undefined ? {} : { modelBinding: options.modelBinding })
  };
  const payload = options.schemaVersion === 1
    ? protectAgentSessionPayloadV1("session/created", raw)
    : protectAgentSessionPayloadV2("session/created", raw);
  return digestJson({
    sessionId: options.sessionId,
    ...(options.modelBinding === undefined ? {} : { modelBinding: options.modelBinding }),
    ...(options.cwd === undefined ? {} : { protectedCwdDigest: createProtectedTextV1(options.cwd).digest }),
    payloadDigest: payload.digest
  });
}

const PROTECTED_MARKERS = new Set([
  CREDENTIAL_MARKER,
  PHONE_MARKER,
  PRC_ID_MARKER,
  PRIVATE_KEY_MARKER,
  UNSAFE_MARKER
]);

function protectedTextContainsMarker(text: string): boolean {
  return [...PROTECTED_MARKERS].some((marker) => text.includes(marker));
}

function protectedNodeContainsMarker(
  node: ProtectedJsonNodeV1
): boolean {
  if (node.type === "string") return protectedTextContainsMarker(node.value.text);
  if (node.type === "array") return node.items.some(protectedNodeContainsMarker);
  if (node.type === "object") {
    return node.entries.some((entry) => protectedTextContainsMarker(entry.key.text)
      || protectedNodeContainsMarker(entry.value));
  }
  return false;
}

function creationSnapshotIsAmbiguous(options: CreateAgentSessionOptionsSnapshot): boolean {
  const raw = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.labels === undefined ? {} : { labels: options.labels }),
    ...(options.modelBinding === undefined ? {} : { modelBinding: options.modelBinding })
  };
  const payload = options.schemaVersion === 1
    ? protectAgentSessionPayloadV1("session/created", raw)
    : protectAgentSessionPayloadV2("session/created", raw);
  return protectedNodeContainsMarker(payload.protectedContent.root);
}

function persistedCreationSnapshotDigest(
  header: AgentSessionHeader,
  created: AgentSessionEvent<"session/created">
): string {
  return digestJson({
    sessionId: header.sessionId,
    ...(header.modelBinding === undefined ? {} : { modelBinding: header.modelBinding }),
    ...(header.protectedCwd === undefined ? {} : { protectedCwdDigest: header.protectedCwd.digest }),
    payloadDigest: created.payload.digest
  });
}

function protectedCreatedCwd(event: AgentSessionEvent<"session/created">): ProtectedTextV1 | undefined {
  const root = event.payload.protectedContent.root;
  if (root.type !== "object") throw new Error("protected creation payload must be an object");
  const cwd = root.entries.find((entry) => entry.key.text === "cwd")?.value;
  if (cwd === undefined) return undefined;
  if (cwd.type !== "string") throw new Error("protected creation cwd must be a string");
  return cwd.value;
}

function isLegacyUnprotectedEvent(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).schemaVersion === 1
    && Object.hasOwn(value, "payload")
    && ((value as Record<string, unknown>).payload === null
      || typeof (value as Record<string, unknown>).payload !== "object"
      || (value as { payload: Record<string, unknown> }).payload.kind !== "agent-session-protected-payload");
}

class SymbolicLinkError extends Error {}

function symbolicLinkError(target: string): SymbolicLinkError {
  return new SymbolicLinkError(`refusing symbolic link in durable session path: ${target}`);
}

async function openRegularNoFollow(filePath: string, flags: number, mode = 0o600) {
  let handle;
  try {
    handle = await open(filePath, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw symbolicLinkError(filePath);
    throw error;
  }
  let fileStat: Stats;
  try {
    fileStat = await handle.stat();
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
  if (!fileStat.isFile()) {
    await handle.close();
    throw new Error(`durable session path is not a regular file: ${filePath}`);
  }
  return { handle, fileStat };
}

async function openDirectoryNoFollow(directoryPath: string) {
  let handle;
  try {
    handle = await open(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw symbolicLinkError(directoryPath);
    throw error;
  }
  let directoryStat: Stats;
  try {
    directoryStat = await handle.stat();
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
  if (!directoryStat.isDirectory()) {
    await handle.close();
    throw new Error(`durable session path is not a directory: ${directoryPath}`);
  }
  return { handle, directoryStat };
}

async function writeExclusive(filePath: string, content: string): Promise<void> {
  const { handle } = await openRegularNoFollow(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const { handle } = await openDirectoryNoFollow(directoryPath);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadEvents(
  handle: FileHandle,
  repairTail: (committedLength: number) => Promise<void>,
  verifyIdentity?: (fileStat: Stats) => void
): Promise<AgentSessionEvent[]> {
  const fileStat = await handle.stat();
  let buffer: Buffer;
  verifyIdentity?.(fileStat);
  buffer = await handle.readFile();
  if (buffer.length > 0 && buffer.at(-1) !== 0x0a) {
    const lastNewline = buffer.lastIndexOf(0x0a);
    const committedLength = lastNewline < 0 ? 0 : lastNewline + 1;
    const uncommittedTail = buffer.subarray(committedLength).toString("utf8");
    try {
      const parsedTail: unknown = JSON.parse(uncommittedTail);
      if (isLegacyUnprotectedEvent(parsedTail)) throw new LegacyUnprotectedSessionError();
    } catch (error: unknown) {
      if (error instanceof LegacyUnprotectedSessionError) throw error;
      // A malformed final record is a torn append and is repaired below.
    }
    await repairTail(committedLength);
    buffer = buffer.subarray(0, committedLength);
  }

  const events: AgentSessionEvent[] = [];
  const lines = buffer.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [index, line] of lines.entries()) {
    if (line === "") throw new Error(`corrupt session event at line ${index + 1}: empty record`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`corrupt session event at line ${index + 1}: invalid JSON`);
    }
    if (!isAgentSessionEventV1(parsed) && !isAgentSessionEventV2(parsed)) {
      if (isLegacyUnprotectedEvent(parsed)) throw new LegacyUnprotectedSessionError();
      throw new Error(`corrupt session event at line ${index + 1}: invalid envelope`);
    }
    events.push(snapshotAgentSessionEvent(parsed));
  }
  try {
    if (events[0]?.schemaVersion === 2) {
      if (events.some((event) => event.schemaVersion !== 2)) throw new Error("event chain mixes schema versions");
      verifyAgentSessionEventChainV2(events as Parameters<typeof verifyAgentSessionEventChainV2>[0]);
    } else {
      if (events.some((event) => event.schemaVersion !== 1)) throw new Error("event chain mixes schema versions");
      verifyAgentSessionEventChain(events as Parameters<typeof verifyAgentSessionEventChain>[0]);
    }
  } catch (error: unknown) {
    throw new Error(`corrupt session event chain: ${error instanceof Error ? error.message : "invalid event"}`);
  }
  return events;
}

export class JsonlAgentSessionStore {
  private readonly sessions = new Map<SessionId, DurableAgentSession>();
  private readonly inFlight = new Map<SessionId, Promise<DurableAgentSession>>();
  private readonly activeIo = new Set<Promise<void>>();
  private readonly leases = new Set<WriterLease>();
  private readonly root: string;
  private readonly sessionsRoot: string;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(root: string, private readonly options: JsonlAgentSessionStoreOptions = {}) {
    this.root = path.resolve(root);
    this.sessionsRoot = path.join(this.root, "sessions");
  }

  private async ensureRoot(): Promise<string> {
    this.assertOpen();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(this.root);
    const rootDirectory = await openDirectoryNoFollow(canonicalRoot);
    try {
      await rootDirectory.handle.chmod(0o700);
    } finally {
      await rootDirectory.handle.close();
    }
    await mkdir(this.sessionsRoot, { recursive: true, mode: 0o700 });
    const sessionsDirectory = await openDirectoryNoFollow(this.sessionsRoot);
    try {
      await sessionsDirectory.handle.chmod(0o700);
    } finally {
      await sessionsDirectory.handle.close();
    }
    const canonicalSessionsRoot = await realpath(this.sessionsRoot);
    if (path.dirname(canonicalSessionsRoot) !== canonicalRoot) {
      throw new Error("durable sessions directory escapes the configured root");
    }
    return canonicalSessionsRoot;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("JSONL session store is disposed");
  }

  private paths(sessionId: SessionId): { dir: string; header: string; events: string } {
    const dir = path.join(this.sessionsRoot, sessionId);
    return { dir, header: path.join(dir, "header.json"), events: path.join(dir, "events.jsonl") };
  }

  private async validateSessionDirectory(
    directoryPath: string,
    canonicalSessionsRoot: string,
    sessionId: SessionId
  ): Promise<string> {
    const directory = await this.openValidatedSessionDirectory(directoryPath, canonicalSessionsRoot, sessionId);
    try {
      return directory.canonicalPath;
    } finally {
      await directory.handle.close();
    }
  }

  private async openValidatedSessionDirectory(
    directoryPath: string,
    canonicalSessionsRoot: string,
    sessionId: SessionId
  ): Promise<{ handle: FileHandle; stat: Stats; canonicalPath: string }> {
    const linkStat = await lstat(directoryPath);
    if (linkStat.isSymbolicLink()) throw symbolicLinkError(directoryPath);
    const directory = await openDirectoryNoFollow(directoryPath);
    try {
      await directory.handle.chmod(0o700);
      const canonicalDirectory = await realpath(directoryPath);
      if (path.dirname(canonicalDirectory) !== canonicalSessionsRoot || path.basename(canonicalDirectory) !== sessionId) {
        throw new Error(`session "${sessionId}" directory escapes durable storage`);
      }
      return { handle: directory.handle, stat: directory.directoryStat, canonicalPath: canonicalDirectory };
    } catch (error: unknown) {
      await directory.handle.close();
      throw error;
    }
  }

  private async assertDirectoryIdentity(directoryPath: string, expected: Stats): Promise<void> {
    const current = await openDirectoryNoFollow(directoryPath);
    try {
      if (current.directoryStat.dev !== expected.dev || current.directoryStat.ino !== expected.ino) {
        throw new Error("durable session directory identity changed while files were being bound");
      }
    } finally {
      await current.handle.close();
    }
  }

  create(options: CreateAgentSessionOptions = {}): Promise<DurableAgentSession> {
    this.assertOpen();
    const snapshot = snapshotCreateAgentSessionOptions(options);
    const { sessionId } = snapshot;
    assertSessionId(sessionId);
    if (this.sessions.has(sessionId) || this.inFlight.has(sessionId)) {
      return Promise.reject(new Error(`session "${sessionId}" already exists or is opening`));
    }
    return this.track(sessionId, this.createInternal(sessionId, snapshot));
  }

  private async createInternal(sessionId: SessionId, options: CreateAgentSessionOptionsSnapshot): Promise<DurableAgentSession> {
    const canonicalSessionsRoot = await this.ensureRoot();
    const paths = this.paths(sessionId);
    const stagingDir = path.join(this.sessionsRoot, `.${sessionId}.create-${randomUUID()}`);
    let lease: WriterLease | undefined;
    let stagingCreated = false;
    let outcome: "unpublished" | SessionCreateOutcome = "unpublished";
    let completed = false;
    let result: DurableAgentSession | undefined;
    let failure: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      lease = await this.acquireLease(`path:${path.join(canonicalSessionsRoot, sessionId)}`, sessionId);
      this.assertLeaseHeld(lease);
      await this.clearStaleStaging(sessionId);
      this.assertLeaseHeld(lease);
      let finalExists = true;
      try {
        await lstat(paths.dir);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") finalExists = false;
        else throw error;
      }

      if (finalExists) {
        result = await this.loadSessionWithLease(sessionId, canonicalSessionsRoot, lease, options);
        completed = true;
      } else {
        await mkdir(stagingDir, { mode: 0o700 });
        stagingCreated = true;
        const stagingDirectory = await openDirectoryNoFollow(stagingDir);
        try {
          await stagingDirectory.handle.chmod(0o700);
        } finally {
          await stagingDirectory.handle.close();
        }
        const initial = createInitialAgentSessionState(options);
        await this.runHook(() => this.options.beforeAppend?.(initial.event));
        this.assertLease(lease);
        await writeExclusive(path.join(stagingDir, "header.json"), `${JSON.stringify(initial.header)}\n`);
        await writeExclusive(path.join(stagingDir, "events.jsonl"), `${JSON.stringify(initial.event)}\n`);
        await syncDirectory(stagingDir);
        this.assertLease(lease);
        await rename(stagingDir, paths.dir);
        stagingCreated = false;
        outcome = "uncertain";
        await this.runHook(() => this.options.afterPublish?.("renamed", sessionId));
        this.assertLease(lease);
        await syncDirectory(this.sessionsRoot);
        outcome = "committed";
        await this.runHook(() => this.options.afterPublish?.("committed", sessionId));
        this.assertLease(lease);
        result = await this.loadSessionWithLease(sessionId, canonicalSessionsRoot, lease, options, true);
        completed = true;
      }
    } catch (error: unknown) {
      failure = error;
    } finally {
      if (!completed) {
        this.sessions.delete(sessionId);
        if (stagingCreated) {
          try {
            await rm(stagingDir, { recursive: true, force: true });
          } catch (error: unknown) {
            cleanupErrors.push(error);
          }
          try {
            await syncDirectory(this.sessionsRoot);
          } catch (error: unknown) {
            cleanupErrors.push(error);
          }
        }
        if (lease !== undefined) {
          try {
            await this.releaseLease(lease);
          } catch (error: unknown) {
            cleanupErrors.push(error);
          }
        }
      }
    }

    if (completed) return result as DurableAgentSession;
    if (outcome !== "unpublished") {
      throw new SessionCreateOutcomeError(sessionId, outcome, failure, cleanupErrors);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([failure, ...cleanupErrors], `session "${sessionId}" creation and cleanup failed`, {
        cause: failure
      });
    }
    throw failure;
  }

  private async clearStaleStaging(sessionId: SessionId): Promise<void> {
    const prefix = `.${sessionId}.create-`;
    const names = await readdir(this.sessionsRoot);
    const staleNames = names.filter((name) => name.startsWith(prefix) && STAGING_NONCE_PATTERN.test(name.slice(prefix.length)));
    for (const name of staleNames) {
      await rm(path.join(this.sessionsRoot, name), { recursive: true, force: true });
    }
    if (staleNames.length > 0) await syncDirectory(this.sessionsRoot);
  }

  private async loadSessionWithLease(
    sessionId: SessionId,
    canonicalSessionsRoot: string,
    lease: WriterLease,
    expectedCreation?: CreateAgentSessionOptionsSnapshot,
    allowAmbiguousCreation = false
  ): Promise<DurableAgentSession> {
    const paths = this.paths(sessionId);
    if (lease.directoryHandle !== undefined || lease.eventWriter !== undefined) {
      throw new Error("session file descriptors are already bound to this writer lease");
    }
    const directory = await this.openValidatedSessionDirectory(paths.dir, canonicalSessionsRoot, sessionId);
    lease.directoryHandle = directory.handle;
    lease.directoryStat = directory.stat;
    let parsedHeader: unknown;
    try {
      const { handle } = await openRegularNoFollow(paths.header, constants.O_RDONLY);
      try {
        await handle.chmod(0o600);
        parsedHeader = JSON.parse(await handle.readFile("utf8"));
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if (error instanceof SymbolicLinkError || error instanceof LegacyUnprotectedSessionError) throw error;
      throw new Error(`session "${sessionId}" has a corrupt header`, { cause: error });
    }
    const header = validateHeader(parsedHeader, sessionId);
    const eventReader = await openRegularNoFollow(paths.events, constants.O_RDONLY);
    let eventWriteHandle: Awaited<ReturnType<typeof openRegularNoFollow>> | undefined;
    let writeHandleClosed = false;
    let events: AgentSessionEvent[] | undefined;
    let eventFailure: unknown;
    try {
      eventWriteHandle = await openRegularNoFollow(paths.events, constants.O_RDWR | constants.O_APPEND);
      if (eventReader.fileStat.dev !== eventWriteHandle.fileStat.dev
        || eventReader.fileStat.ino !== eventWriteHandle.fileStat.ino) {
        throw new Error("durable event file identity changed while descriptors were being bound");
      }
      lease.eventStat = eventReader.fileStat;
      await eventWriteHandle.handle.chmod(0o600);
      await this.addFileIdentityLease(lease, eventReader.fileStat, sessionId, eventWriteHandle.handle);
      await eventWriteHandle.handle.close();
      writeHandleClosed = true;
      this.assertLeaseHeld(lease);
      await this.assertDirectoryIdentity(paths.dir, directory.stat);
      events = await loadEvents(
        eventReader.handle,
        (committedLength) => this.eventWriter(lease).truncate(committedLength),
        (fileStat) => this.assertFileIdentity(lease, fileStat)
      );
    } catch (error: unknown) {
      eventFailure = error;
    } finally {
      const closed = await Promise.allSettled([
        eventReader.handle.close(),
        ...(eventWriteHandle === undefined || writeHandleClosed ? [] : [eventWriteHandle.handle.close()])
      ]);
      const closeErrors = closed.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (closeErrors.length > 0) {
        eventFailure = eventFailure === undefined
          ? new AggregateError(closeErrors, "event file descriptors could not be closed")
          : new AggregateError(
            [eventFailure, ...closeErrors],
            "event file binding and descriptor cleanup failed",
            { cause: eventFailure }
          );
      }
    }
    if (eventFailure !== undefined) throw eventFailure;
    const loadedEvents = events as AgentSessionEvent[];
    if (loadedEvents.length === 0) throw new Error(`session "${sessionId}" has an empty event log`);
    const created = loadedEvents[0];
    if (created?.type !== "session/created") {
      throw new Error(`session "${sessionId}" first event must be session/created`);
    }
    if (loadedEvents.some((event) => event.sessionId !== header.sessionId)) {
      throw new Error(`session "${sessionId}" event session id does not match header`);
    }
    const createdCwd = protectedCreatedCwd(created);
    if (header.protectedCwd?.digest !== createdCwd?.digest) {
      throw new Error(`session "${sessionId}" header cwd does not match the creation event`);
    }
    const createdModelBinding = created.payload.publicControls.modelBinding;
    if ((header.modelBinding === undefined) !== (createdModelBinding === undefined)
      || (header.modelBinding !== undefined && createdModelBinding !== undefined
        && digestJson(header.modelBinding) !== digestJson(createdModelBinding))) {
      throw new Error(`session "${sessionId}" header model binding does not match the creation event`);
    }
    if (header.createdAt !== created.occurredAt) {
      throw new Error(`session "${sessionId}" header creation time does not match the creation event`);
    }
    if (expectedCreation !== undefined) {
      if (!allowAmbiguousCreation && creationSnapshotIsAmbiguous(expectedCreation)) {
        throw new Error(`session "${sessionId}" cannot compare an ambiguous protected creation snapshot`);
      }
      if (persistedCreationSnapshotDigest(header, created) !== creationSnapshotDigest(expectedCreation)) {
        throw new Error(`session "${sessionId}" already exists with a different creation snapshot`);
      }
    }
    this.assertLease(lease);
    const session = new DurableAgentSession(
      header,
      loadedEvents,
      this.persistence(lease),
      expectedCreation?.cwd
    );
    this.sessions.set(sessionId, session);
    return session;
  }

  open(sessionId: SessionId): Promise<DurableAgentSession> {
    this.assertOpen();
    assertSessionId(sessionId);
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return Promise.resolve(live);
    const pending = this.inFlight.get(sessionId);
    if (pending !== undefined) return pending;
    return this.track(sessionId, this.openInternal(sessionId));
  }

  private async openInternal(sessionId: SessionId): Promise<DurableAgentSession> {
    const canonicalSessionsRoot = await this.ensureRoot();
    const paths = this.paths(sessionId);
    let lease: WriterLease | undefined;
    try {
      let canonicalDirectory: string;
      try {
        canonicalDirectory = await this.validateSessionDirectory(paths.dir, canonicalSessionsRoot, sessionId);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new AgentSessionNotFoundError();
        }
        throw error;
      }
      lease = await this.acquireLease(`path:${canonicalDirectory}`, sessionId);
      return await this.loadSessionWithLease(sessionId, canonicalSessionsRoot, lease);
    } catch (error: unknown) {
      if (lease !== undefined) {
        const [released] = await Promise.allSettled([this.releaseLease(lease)]);
        if (released?.status === "rejected") {
          throw new AggregateError([error, released.reason], `session "${sessionId}" open and cleanup failed`, {
            cause: error
          });
        }
      }
      throw error;
    }
  }

  dispose(): Promise<void> {
    const activeContext = ACTIVE_SESSION_HOOK.getStore();
    if (activeContext?.store === this && activeContext.active) {
      return Promise.reject(new Error("cannot dispose a JSONL session store reentrantly from its I/O hook"));
    }
    if (this.disposal !== undefined) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      await Promise.allSettled([...this.inFlight.values(), ...this.activeIo]);
      this.sessions.clear();
      const released = await Promise.allSettled([...this.leases].map((lease) => this.releaseLease(lease)));
      const errors = released.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, "failed to dispose session writer leases");
    })();
    return this.disposal;
  }

  private track(sessionId: SessionId, operation: Promise<DurableAgentSession>): Promise<DurableAgentSession> {
    const tracked = operation.then(
      (session) => {
        if (this.inFlight.get(sessionId) === tracked) this.inFlight.delete(sessionId);
        return session;
      },
      (error: unknown) => {
        if (this.inFlight.get(sessionId) === tracked) this.inFlight.delete(sessionId);
        throw error;
      }
    );
    this.inFlight.set(sessionId, tracked);
    return tracked;
  }

  private async acquireLease(initialKey: string, sessionId: SessionId): Promise<WriterLease> {
    this.assertOpen();
    const owner = PROCESS_SESSION_LEASES.get(initialKey);
    if (owner !== undefined) {
      throw new Error(`session "${sessionId}" already has an active writer lease`);
    }
    const lease: WriterLease = { owner: this, keys: new Set([initialKey]), osLocks: new Map() };
    PROCESS_SESSION_LEASES.set(initialKey, lease);
    this.leases.add(lease);
    try {
      lease.osLocks.set(initialKey, await acquireOsWriterLock(initialKey));
      return lease;
    } catch (error: unknown) {
      if (PROCESS_SESSION_LEASES.get(initialKey) === lease) PROCESS_SESSION_LEASES.delete(initialKey);
      lease.keys.clear();
      this.leases.delete(lease);
      throw error;
    }
  }

  private async addFileIdentityLease(
    lease: WriterLease,
    fileStat: Stats,
    sessionId: SessionId,
    eventHandle: FileHandle
  ): Promise<void> {
    this.assertLeaseHeld(lease);
    const identityKey = `inode:${fileStat.dev}:${fileStat.ino}`;
    const owner = PROCESS_SESSION_LEASES.get(identityKey);
    if (owner !== undefined && owner !== lease) {
      throw new Error(`session "${sessionId}" aliases an active writer lease`);
    }
    PROCESS_SESSION_LEASES.set(identityKey, lease);
    lease.keys.add(identityKey);
    try {
      const eventWriter = await acquireEventWriterLock(identityKey, eventHandle);
      lease.eventWriter = eventWriter;
      lease.osLocks.set(identityKey, eventWriter);
    } catch (error: unknown) {
      if (PROCESS_SESSION_LEASES.get(identityKey) === lease) PROCESS_SESSION_LEASES.delete(identityKey);
      lease.keys.delete(identityKey);
      throw error;
    }
  }

  private async releaseLease(lease: WriterLease): Promise<void> {
    const cleanup = [
      ...(lease.directoryHandle === undefined ? [] : [lease.directoryHandle.close()]),
      ...[...lease.osLocks.values()].reverse().map((lock) => lock.release())
    ];
    lease.eventWriter = undefined;
    lease.eventStat = undefined;
    lease.directoryHandle = undefined;
    lease.directoryStat = undefined;
    const settled = await Promise.allSettled(cleanup);
    lease.osLocks.clear();
    for (const key of lease.keys) {
      if (PROCESS_SESSION_LEASES.get(key) === lease) PROCESS_SESSION_LEASES.delete(key);
    }
    lease.keys.clear();
    this.leases.delete(lease);
    const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, "failed to release session writer lease");
  }

  private assertLease(lease: WriterLease): void {
    this.assertOpen();
    this.assertLeaseHeld(lease);
  }

  private assertLeaseHeld(lease: WriterLease): void {
    if (lease.owner !== this || lease.keys.size === 0
      || lease.osLocks.size !== lease.keys.size
      || [...lease.keys].some((key) => PROCESS_SESSION_LEASES.get(key) !== lease || lease.osLocks.get(key)?.released !== false)) {
      throw new Error("session writer lease is not held");
    }
  }

  private assertFileIdentity(lease: WriterLease, fileStat: Stats): void {
    const identityKey = `inode:${fileStat.dev}:${fileStat.ino}`;
    if (!lease.keys.has(identityKey) || PROCESS_SESSION_LEASES.get(identityKey) !== lease) {
      throw new Error("durable event file identity no longer matches its writer lease");
    }
  }

  private eventWriter(lease: WriterLease): EventWriterLock {
    const writer = lease.eventWriter;
    if (writer === undefined || lease.eventStat === undefined) {
      throw new Error("durable event writer is not bound to its writer lease");
    }
    return writer;
  }

  private persistence(lease: WriterLease): EventPersistence {
    return {
      commitDurable: (event) => this.runIo(lease, async () => {
        await this.runHook(() => this.options.beforeAppend?.(event));
        this.assertLeaseHeld(lease);
        await this.eventWriter(lease).append(`${JSON.stringify(event)}\n`);
        this.assertLeaseHeld(lease);
      }),
      flush: () => this.runIo(lease, async () => {
        this.assertLeaseHeld(lease);
        await this.eventWriter(lease).flush();
        this.assertLeaseHeld(lease);
      })
    };
  }

  private runIo(lease: WriterLease, operation: () => Promise<void>): Promise<void> {
    this.assertLease(lease);
    let start!: () => void;
    const startGate = new Promise<void>((resolve) => { start = resolve; });
    const active = startGate.then(operation);
    this.activeIo.add(active);
    void active.then(
      () => { this.activeIo.delete(active); },
      () => { this.activeIo.delete(active); }
    );
    start();
    return active;
  }

  private async runHook<T>(operation: () => T | Promise<T>): Promise<T> {
    const context: SessionHookContext = { store: this, active: true };
    try {
      return await ACTIVE_SESSION_HOOK.run(context, operation);
    } finally {
      context.active = false;
    }
  }
}
