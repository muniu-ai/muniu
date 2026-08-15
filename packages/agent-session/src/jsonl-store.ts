// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";

import {
  SessionId,
  deepFreeze,
  isAgentSessionEventV1,
  isCanonicalRfc3339,
  verifyAgentSessionEventChain,
  type AgentSessionEventV1
} from "@mn/agent-protocol";

import { snapshotAgentSessionEvent } from "./event-snapshot.js";
import { snapshotCreateAgentSessionOptions, type CreateAgentSessionOptionsSnapshot } from "./create-options.js";
import { createInitialAgentSessionState } from "./initial-state.js";
import { DurableAgentSession } from "./session.js";
import type { AgentSessionHeaderV1, CreateAgentSessionOptions, EventPersistence } from "./types.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROCESS_SESSION_LEASES = new Map<string, WriterLease>();

interface WriterLease {
  readonly owner: JsonlAgentSessionStore;
  readonly keys: Set<string>;
}

export interface JsonlAgentSessionStoreOptions {
  readonly beforeAppend?: (event: AgentSessionEventV1) => void | Promise<void>;
}

function assertSessionId(sessionId: SessionId): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("session id is not safe for durable storage");
}

function validateHeader(value: unknown, expectedId: SessionId): AgentSessionHeaderV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session header");
  const header = value as Record<string, unknown>;
  const required = ["schemaVersion", "sessionId", "createdAt"];
  const allowed = new Set([...required, "cwd"]);
  if (!required.every((key) => Object.hasOwn(header, key))
    || !Object.keys(header).every((key) => allowed.has(key))
    || header.schemaVersion !== 1
    || header.sessionId !== expectedId
    || !isCanonicalRfc3339(header.createdAt)) {
    throw new Error("invalid session header");
  }
  if (header.cwd !== undefined && typeof header.cwd !== "string") throw new Error("invalid session header cwd");
  return deepFreeze(header as unknown as AgentSessionHeaderV1);
}

class SymbolicLinkError extends Error {}

function symbolicLinkError(target: string): SymbolicLinkError {
  return new SymbolicLinkError(`refusing symbolic link in durable session path: ${target}`);
}

async function openRegularNoFollow(filePath: string, flags: number, mode = 0o600) {
  let handle;
  try {
    handle = await open(filePath, flags | constants.O_NOFOLLOW, mode);
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
    handle = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
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

async function appendEvent(
  filePath: string,
  event: AgentSessionEventV1,
  verifyIdentity: (fileStat: Stats) => void
): Promise<void> {
  const { handle, fileStat } = await openRegularNoFollow(filePath, constants.O_APPEND | constants.O_WRONLY, 0o600);
  try {
    verifyIdentity(fileStat);
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadEvents(filePath: string, verifyIdentity?: (fileStat: Stats) => void): Promise<AgentSessionEventV1[]> {
  const { handle, fileStat } = await openRegularNoFollow(filePath, constants.O_RDWR);
  let buffer: Buffer;
  try {
    verifyIdentity?.(fileStat);
    buffer = await handle.readFile();
    if (buffer.length > 0 && buffer.at(-1) !== 0x0a) {
      const lastNewline = buffer.lastIndexOf(0x0a);
      const committedLength = lastNewline < 0 ? 0 : lastNewline + 1;
      await handle.truncate(committedLength);
      await handle.sync();
      buffer = buffer.subarray(0, committedLength);
    }
  } finally {
    await handle.close();
  }

  const events: AgentSessionEventV1[] = [];
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
    if (!isAgentSessionEventV1(parsed)) {
      throw new Error(`corrupt session event at line ${index + 1}: invalid envelope`);
    }
    events.push(snapshotAgentSessionEvent(parsed));
  }
  try {
    verifyAgentSessionEventChain(events);
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
    const linkStat = await lstat(directoryPath);
    if (linkStat.isSymbolicLink()) throw symbolicLinkError(directoryPath);
    const directory = await openDirectoryNoFollow(directoryPath);
    try {
      await directory.handle.chmod(0o700);
    } finally {
      await directory.handle.close();
    }
    const canonicalDirectory = await realpath(directoryPath);
    if (path.dirname(canonicalDirectory) !== canonicalSessionsRoot || path.basename(canonicalDirectory) !== sessionId) {
      throw new Error(`session "${sessionId}" directory escapes durable storage`);
    }
    return canonicalDirectory;
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
    const lease = this.acquireLease(`path:${path.join(canonicalSessionsRoot, sessionId)}`, sessionId);
    const paths = this.paths(sessionId);
    const stagingDir = path.join(this.sessionsRoot, `.${sessionId}.create-${randomUUID()}`);
    let published = false;
    try {
      try {
        await lstat(paths.dir);
        throw new Error(`session "${sessionId}" already exists`);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(stagingDir, { mode: 0o700 });
      const stagingDirectory = await openDirectoryNoFollow(stagingDir);
      try {
        await stagingDirectory.handle.chmod(0o700);
      } finally {
        await stagingDirectory.handle.close();
      }
      const initial = createInitialAgentSessionState(options);
      await this.options.beforeAppend?.(initial.event);
      this.assertOpen();
      await writeExclusive(path.join(stagingDir, "header.json"), `${JSON.stringify(initial.header)}\n`);
      await writeExclusive(path.join(stagingDir, "events.jsonl"), `${JSON.stringify(initial.event)}\n`);
      await syncDirectory(stagingDir);
      await rename(stagingDir, paths.dir);
      published = true;
      await syncDirectory(this.sessionsRoot);
      await this.addFileIdentityLease(lease, paths.events, sessionId);
      const session = new DurableAgentSession(initial.header, [initial.event], this.persistence(paths.events, lease));
      this.sessions.set(sessionId, session);
      this.assertOpen();
      return session;
    } catch (error: unknown) {
      this.sessions.delete(sessionId);
      if (!published) {
        await rm(stagingDir, { recursive: true, force: true });
        await syncDirectory(this.sessionsRoot).catch(() => {});
      }
      this.releaseLease(lease);
      throw error;
    }
  }

  open(sessionId: SessionId): Promise<DurableAgentSession> {
    this.assertOpen();
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
      const canonicalDirectory = await this.validateSessionDirectory(paths.dir, canonicalSessionsRoot, sessionId);
      lease = this.acquireLease(`path:${canonicalDirectory}`, sessionId);
      const activeLease = lease;
      await this.addFileIdentityLease(activeLease, paths.events, sessionId);
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
        if (error instanceof SymbolicLinkError) throw error;
        throw new Error(`session "${sessionId}" has a corrupt header`);
      }
      const header = validateHeader(parsedHeader, sessionId);
      const events = await loadEvents(paths.events, (fileStat) => this.assertFileIdentity(activeLease, fileStat));
      if (events.length === 0) throw new Error(`session "${sessionId}" has an empty event log`);
      const created = events[0];
      if (created?.type !== "session/created") {
        throw new Error(`session "${sessionId}" first event must be session/created`);
      }
      if (events.some((event) => event.sessionId !== header.sessionId)) {
        throw new Error(`session "${sessionId}" event session id does not match header`);
      }
      if (header.cwd !== created.payload.cwd) {
        throw new Error(`session "${sessionId}" header cwd does not match the creation event`);
      }
      if (header.createdAt !== created.occurredAt) {
        throw new Error(`session "${sessionId}" header creation time does not match the creation event`);
      }
      this.assertOpen();
      const session = new DurableAgentSession(header, events, this.persistence(paths.events, activeLease));
      this.sessions.set(sessionId, session);
      return session;
    } catch (error: unknown) {
      if (lease !== undefined) this.releaseLease(lease);
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      await Promise.allSettled([...this.inFlight.values(), ...this.activeIo]);
      this.sessions.clear();
      for (const lease of [...this.leases]) this.releaseLease(lease);
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

  private acquireLease(initialKey: string, sessionId: SessionId): WriterLease {
    this.assertOpen();
    const owner = PROCESS_SESSION_LEASES.get(initialKey);
    if (owner !== undefined) {
      throw new Error(`session "${sessionId}" already has an active writer lease`);
    }
    const lease: WriterLease = { owner: this, keys: new Set([initialKey]) };
    PROCESS_SESSION_LEASES.set(initialKey, lease);
    this.leases.add(lease);
    return lease;
  }

  private async addFileIdentityLease(lease: WriterLease, filePath: string, sessionId: SessionId): Promise<void> {
    const { handle, fileStat } = await openRegularNoFollow(filePath, constants.O_RDONLY);
    try {
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    const identityKey = `inode:${fileStat.dev}:${fileStat.ino}`;
    const owner = PROCESS_SESSION_LEASES.get(identityKey);
    if (owner !== undefined && owner !== lease) {
      throw new Error(`session "${sessionId}" aliases an active writer lease`);
    }
    PROCESS_SESSION_LEASES.set(identityKey, lease);
    lease.keys.add(identityKey);
  }

  private releaseLease(lease: WriterLease): void {
    for (const key of lease.keys) {
      if (PROCESS_SESSION_LEASES.get(key) === lease) PROCESS_SESSION_LEASES.delete(key);
    }
    lease.keys.clear();
    this.leases.delete(lease);
  }

  private assertLease(lease: WriterLease): void {
    this.assertOpen();
    if (lease.owner !== this || lease.keys.size === 0
      || [...lease.keys].some((key) => PROCESS_SESSION_LEASES.get(key) !== lease)) {
      throw new Error("session writer lease is not held");
    }
  }

  private assertFileIdentity(lease: WriterLease, fileStat: Stats): void {
    const identityKey = `inode:${fileStat.dev}:${fileStat.ino}`;
    if (!lease.keys.has(identityKey) || PROCESS_SESSION_LEASES.get(identityKey) !== lease) {
      throw new Error("durable event file identity no longer matches its writer lease");
    }
  }

  private persistence(eventsPath: string, lease: WriterLease): EventPersistence {
    return {
      append: (event) => this.runIo(lease, async () => {
        await this.options.beforeAppend?.(event);
        await appendEvent(eventsPath, event, (fileStat) => this.assertFileIdentity(lease, fileStat));
      }),
      flush: async () => { this.assertLease(lease); }
    };
  }

  private runIo(lease: WriterLease, operation: () => Promise<void>): Promise<void> {
    this.assertLease(lease);
    const active = operation();
    this.activeIo.add(active);
    void active.then(
      () => { this.activeIo.delete(active); },
      () => { this.activeIo.delete(active); }
    );
    return active;
  }
}
