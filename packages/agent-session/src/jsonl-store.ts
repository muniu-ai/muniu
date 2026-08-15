// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  stat
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
import { DurableAgentSession } from "./session.js";
import type { AgentSessionHeaderV1, CreateAgentSessionOptions, EventPersistence } from "./types.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROCESS_SESSION_LEASES = new Map<string, JsonlAgentSessionStore>();

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

async function writeExclusive(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendEvent(filePath: string, event: AgentSessionEventV1): Promise<void> {
  const handle = await open(filePath, constants.O_APPEND | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadEvents(filePath: string): Promise<AgentSessionEventV1[]> {
  const handle = await open(filePath, constants.O_RDWR);
  let buffer: Buffer;
  try {
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
  private readonly leaseKeys = new Set<string>();
  private readonly root: string;
  private readonly sessionsRoot: string;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(root: string, private readonly options: JsonlAgentSessionStoreOptions = {}) {
    this.root = path.resolve(root);
    this.sessionsRoot = path.join(this.root, "sessions");
  }

  private async ensureRoot(): Promise<void> {
    this.assertOpen();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await mkdir(this.sessionsRoot, { recursive: true, mode: 0o700 });
    await chmod(this.sessionsRoot, 0o700);
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("JSONL session store is disposed");
  }

  private paths(sessionId: SessionId): { dir: string; header: string; events: string } {
    assertSessionId(sessionId);
    const dir = path.join(this.sessionsRoot, sessionId);
    return { dir, header: path.join(dir, "header.json"), events: path.join(dir, "events.jsonl") };
  }

  create(options: CreateAgentSessionOptions = {}): Promise<DurableAgentSession> {
    this.assertOpen();
    const sessionId = options.sessionId ?? SessionId(`session-${randomUUID()}`);
    if (this.sessions.has(sessionId) || this.inFlight.has(sessionId)) {
      return Promise.reject(new Error(`session "${sessionId}" already exists or is opening`));
    }
    return this.track(sessionId, this.createInternal(sessionId, options));
  }

  private async createInternal(sessionId: SessionId, options: CreateAgentSessionOptions): Promise<DurableAgentSession> {
    await this.ensureRoot();
    const leaseKey = await this.acquireLease(sessionId);
    const paths = this.paths(sessionId);
    try {
      await mkdir(paths.dir, { mode: 0o700 });
      await chmod(paths.dir, 0o700);
      await syncDirectory(this.sessionsRoot);
      const header: AgentSessionHeaderV1 = deepFreeze({
        schemaVersion: 1,
        sessionId,
        createdAt: new Date().toISOString(),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd })
      });
      await writeExclusive(paths.header, `${JSON.stringify(header)}\n`);
      await writeExclusive(paths.events, "");
      await syncDirectory(paths.dir);
      const session = new DurableAgentSession(header, [], this.persistence(paths.events, leaseKey));
      this.sessions.set(sessionId, session);
      await session.append("session/created", {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.labels === undefined ? {} : { labels: options.labels })
      });
      this.assertOpen();
      return session;
    } catch (error: unknown) {
      this.sessions.delete(sessionId);
      this.releaseLease(leaseKey);
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
    await this.ensureRoot();
    const leaseKey = await this.acquireLease(sessionId);
    const paths = this.paths(sessionId);
    try {
      await stat(paths.dir);
      await chmod(paths.dir, 0o700);
      await chmod(paths.header, 0o600);
      await chmod(paths.events, 0o600);
      let parsedHeader: unknown;
      try {
        parsedHeader = JSON.parse(await readFile(paths.header, "utf8"));
      } catch {
        throw new Error(`session "${sessionId}" has a corrupt header`);
      }
      const header = validateHeader(parsedHeader, sessionId);
      const events = await loadEvents(paths.events);
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
      this.assertOpen();
      const session = new DurableAgentSession(header, events, this.persistence(paths.events, leaseKey));
      this.sessions.set(sessionId, session);
      return session;
    } catch (error: unknown) {
      this.releaseLease(leaseKey);
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      await Promise.allSettled([...this.inFlight.values(), ...this.activeIo]);
      this.sessions.clear();
      for (const leaseKey of [...this.leaseKeys]) this.releaseLease(leaseKey);
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

  private async acquireLease(sessionId: SessionId): Promise<string> {
    this.assertOpen();
    const canonicalSessionsRoot = await realpath(this.sessionsRoot);
    this.assertOpen();
    const leaseKey = path.join(canonicalSessionsRoot, sessionId);
    const owner = PROCESS_SESSION_LEASES.get(leaseKey);
    if (owner !== undefined && owner !== this) {
      throw new Error(`session "${sessionId}" already has an active writer lease`);
    }
    PROCESS_SESSION_LEASES.set(leaseKey, this);
    this.leaseKeys.add(leaseKey);
    return leaseKey;
  }

  private releaseLease(leaseKey: string): void {
    if (PROCESS_SESSION_LEASES.get(leaseKey) === this) PROCESS_SESSION_LEASES.delete(leaseKey);
    this.leaseKeys.delete(leaseKey);
  }

  private assertLease(leaseKey: string): void {
    this.assertOpen();
    if (PROCESS_SESSION_LEASES.get(leaseKey) !== this) throw new Error("session writer lease is not held");
  }

  private persistence(eventsPath: string, leaseKey: string): EventPersistence {
    return {
      append: (event) => this.runIo(leaseKey, async () => {
        await this.options.beforeAppend?.(event);
        await appendEvent(eventsPath, event);
      }),
      flush: async () => { this.assertLease(leaseKey); }
    };
  }

  private runIo(leaseKey: string, operation: () => Promise<void>): Promise<void> {
    this.assertLease(leaseKey);
    const active = operation();
    this.activeIo.add(active);
    void active.then(
      () => { this.activeIo.delete(active); },
      () => { this.activeIo.delete(active); }
    );
    return active;
  }
}
