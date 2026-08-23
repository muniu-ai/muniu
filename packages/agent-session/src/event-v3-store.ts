// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
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

import {
  assertSafePublicControlIdV1,
  createAgentEventV3,
  SessionId,
  verifyAgentEventV3Chain,
  type AgentEventV3,
  type NewAgentEventV3
} from "@mn/agent-protocol";

import type { AgentEventV3ContinuationInput } from "./migration-v3.js";
import { appendAgentEventV3Jsonl, readAgentEventV3Jsonl } from "./migration-v3.js";
import { projectThreadV3, type ThreadProjectionV3 } from "./thread-v3.js";
import { acquireOsWriterLock } from "./writer-lock.js";

const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface AgentEventV3Store {
  create(initial: NewAgentEventV3): Promise<ThreadProjectionV3>;
  append(threadId: SessionId, input: AgentEventV3ContinuationInput): Promise<AgentEventV3>;
  read(threadId: SessionId): Promise<readonly AgentEventV3[]>;
  list(): Promise<readonly ThreadProjectionV3[]>;
}

export class AgentThreadV3NotFoundError extends Error {
  constructor() {
    super("V3 thread was not found");
    this.name = "AgentThreadV3NotFoundError";
  }
}

export class InMemoryAgentEventV3Store implements AgentEventV3Store {
  readonly #events = new Map<SessionId, readonly AgentEventV3[]>();
  readonly #tails = new Map<SessionId, Promise<void>>();

  async create(initial: NewAgentEventV3): Promise<ThreadProjectionV3> {
    const event = createAgentEventV3(initial);
    if (event.sequence !== 0 || event.type !== "thread/created") {
      throw new TypeError("V3 thread creation requires the initial creation event");
    }
    if (this.#events.has(event.threadId)) throw new Error("V3 thread already exists");
    const events = Object.freeze([event]);
    const projection = projectThreadV3(events);
    this.#events.set(event.threadId, events);
    return projection;
  }

  append(threadId: SessionId, input: AgentEventV3ContinuationInput): Promise<AgentEventV3> {
    const previous = this.#tails.get(threadId) ?? Promise.resolve();
    const operation = previous.then(() => this.#appendSerial(threadId, input));
    const tail = operation.then(() => undefined, () => undefined);
    this.#tails.set(threadId, tail);
    void tail.then(() => {
      if (this.#tails.get(threadId) === tail) this.#tails.delete(threadId);
    });
    return operation;
  }

  async read(threadId: SessionId): Promise<readonly AgentEventV3[]> {
    await this.#tails.get(threadId);
    const events = this.#events.get(threadId);
    if (!events) throw new AgentThreadV3NotFoundError();
    verifyAgentEventV3Chain(events);
    return events;
  }

  async list(): Promise<readonly ThreadProjectionV3[]> {
    await Promise.all(this.#tails.values());
    return Object.freeze([...this.#events.values()]
      .map((events) => projectThreadV3(events))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  #appendSerial(threadId: SessionId, input: AgentEventV3ContinuationInput): AgentEventV3 {
    const current = this.#events.get(threadId);
    if (!current) throw new AgentThreadV3NotFoundError();
    const previous = current.at(-1) as AgentEventV3;
    const event = createAgentEventV3({
      ...input,
      threadId,
      sequence: previous.sequence + 1,
      causationId: previous.eventId,
      previousDigest: previous.digest
    });
    const events = Object.freeze([...current, event]);
    projectThreadV3(events);
    this.#events.set(threadId, events);
    return event;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return lstat(filePath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function assertThreadId(threadId: SessionId): void {
  assertSafePublicControlIdV1(threadId, "V3 thread identifier");
  if (!THREAD_ID_PATTERN.test(threadId)) throw new TypeError("V3 thread identifier is unsafe for storage");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class JsonlAgentEventV3Store implements AgentEventV3Store {
  readonly #root: string;
  readonly #tails = new Map<SessionId, Promise<void>>();

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async create(initial: NewAgentEventV3): Promise<ThreadProjectionV3> {
    const event = createAgentEventV3(initial);
    if (event.sequence !== 0 || event.type !== "thread/created") {
      throw new TypeError("V3 thread creation requires the initial creation event");
    }
    assertThreadId(event.threadId);
    const threadsRoot = await this.#ensureRoot();
    const target = path.join(threadsRoot, event.threadId);
    const lease = await acquireOsWriterLock(`v3-thread-path:${target}`);
    const staging = path.join(threadsRoot, `.${event.threadId}.create-${randomUUID()}`);
    let failure: unknown;
    let projection: ThreadProjectionV3 | undefined;
    try {
      if (await pathExists(target)) throw new Error("V3 thread already exists");
      await mkdir(staging, { mode: 0o700 });
      projection = projectThreadV3([event]);
      await Promise.all([
        writeFile(path.join(staging, "header.json"), `${JSON.stringify({
          schemaVersion: 3,
          kind: "agent-thread-header",
          threadId: event.threadId,
          createdAt: event.occurredAt
        })}\n`, { mode: 0o600, flag: "wx" }),
        writeFile(path.join(staging, "events.jsonl"), `${JSON.stringify(event)}\n`, {
          mode: 0o600,
          flag: "wx"
        }),
        writeFile(path.join(staging, "projection.json"), `${JSON.stringify(projection)}\n`, {
          mode: 0o600,
          flag: "wx"
        })
      ]);
      await syncDirectory(staging);
      await rename(staging, target);
      await syncDirectory(threadsRoot);
    } catch (error: unknown) {
      failure = error;
    }
    const cleanup = await Promise.allSettled([
      rm(staging, { recursive: true, force: true }),
      lease.release()
    ]);
    const cleanupErrors = cleanup.flatMap((entry) => entry.status === "rejected" ? [entry.reason] : []);
    if (failure !== undefined && cleanupErrors.length > 0) {
      throw new AggregateError([failure, ...cleanupErrors], "V3 thread creation and cleanup failed", {
        cause: failure
      });
    }
    if (failure !== undefined) throw failure;
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "V3 thread creation cleanup failed");
    return projection as ThreadProjectionV3;
  }

  append(threadId: SessionId, input: AgentEventV3ContinuationInput): Promise<AgentEventV3> {
    const previous = this.#tails.get(threadId) ?? Promise.resolve();
    const operation = previous.then(() => this.#appendSerial(threadId, input));
    const tail = operation.then(() => undefined, () => undefined);
    this.#tails.set(threadId, tail);
    void tail.then(() => {
      if (this.#tails.get(threadId) === tail) this.#tails.delete(threadId);
    });
    return operation;
  }

  async #appendSerial(threadId: SessionId, input: AgentEventV3ContinuationInput): Promise<AgentEventV3> {
    assertThreadId(threadId);
    const threadsRoot = await this.#ensureRoot();
    const directory = await this.#threadDirectory(threadsRoot, threadId);
    const lease = await acquireOsWriterLock(`v3-thread-path:${directory}`);
    let event: AgentEventV3 | undefined;
    let failure: unknown;
    try {
      event = await appendAgentEventV3Jsonl(path.join(directory, "events.jsonl"), input);
      const projection = projectThreadV3(await readAgentEventV3Jsonl(path.join(directory, "events.jsonl")));
      await this.#writeProjection(directory, projection);
    } catch (error: unknown) {
      failure = error;
    }
    try {
      await lease.release();
    } catch (releaseError: unknown) {
      if (failure !== undefined) {
        throw new AggregateError([failure, releaseError], "V3 append and lock release failed", { cause: failure });
      }
      throw releaseError;
    }
    if (failure !== undefined) throw failure;
    return event as AgentEventV3;
  }

  read(threadId: SessionId): Promise<readonly AgentEventV3[]> {
    assertThreadId(threadId);
    const previous = this.#tails.get(threadId) ?? Promise.resolve();
    const operation = previous.then(() => this.#readSerial(threadId));
    const tail = operation.then(() => undefined, () => undefined);
    this.#tails.set(threadId, tail);
    void tail.then(() => {
      if (this.#tails.get(threadId) === tail) this.#tails.delete(threadId);
    });
    return operation;
  }

  async #readSerial(threadId: SessionId): Promise<readonly AgentEventV3[]> {
    const threadsRoot = await this.#ensureRoot();
    const directory = await this.#threadDirectory(threadsRoot, threadId);
    const lease = await acquireOsWriterLock(`v3-thread-path:${directory}`);
    let result: readonly AgentEventV3[] | undefined;
    let failure: unknown;
    try {
      result = await readAgentEventV3Jsonl(path.join(directory, "events.jsonl"));
    } catch (error: unknown) {
      failure = error;
    }
    try {
      await lease.release();
    } catch (releaseError: unknown) {
      if (failure !== undefined) {
        throw new AggregateError([failure, releaseError], "V3 read and lock release failed", { cause: failure });
      }
      throw releaseError;
    }
    if (failure !== undefined) throw failure;
    return result as readonly AgentEventV3[];
  }

  async list(): Promise<readonly ThreadProjectionV3[]> {
    const threadsRoot = await this.#ensureRoot();
    const entries = (await readdir(threadsRoot, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));
    const projections: ThreadProjectionV3[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("V3 thread root contains an invalid entry");
      projections.push(projectThreadV3(await this.read(SessionId(entry.name))));
    }
    return Object.freeze(projections);
  }

  async #ensureRoot(): Promise<string> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    const root = await realpath(this.#root);
    const threads = path.join(root, "threads");
    await mkdir(threads, { recursive: true, mode: 0o700 });
    await chmod(threads, 0o700);
    const canonicalThreads = await realpath(threads);
    if (path.dirname(canonicalThreads) !== root) throw new Error("V3 threads root escapes the store root");
    return canonicalThreads;
  }

  async #threadDirectory(threadsRoot: string, threadId: SessionId): Promise<string> {
    const directory = path.join(threadsRoot, threadId);
    let canonical: string;
    try {
      canonical = await realpath(directory);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AgentThreadV3NotFoundError();
      throw error;
    }
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()
      || path.dirname(canonical) !== threadsRoot || path.basename(canonical) !== threadId) {
      throw new Error("V3 thread directory is invalid or escapes the store root");
    }
    return canonical;
  }

  async #writeProjection(directory: string, projection: ThreadProjectionV3): Promise<void> {
    const temporary = path.join(directory, `.projection-${randomUUID()}.json`);
    await writeFile(temporary, `${JSON.stringify(projection)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path.join(directory, "projection.json"));
    await syncDirectory(directory);
  }
}
