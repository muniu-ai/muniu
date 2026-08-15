// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  stat
} from "node:fs/promises";
import path from "node:path";

import {
  SessionId,
  deepFreeze,
  isAgentSessionEventV1,
  verifyAgentSessionEventChain,
  type AgentSessionEventV1
} from "@mn/agent-protocol";

import { snapshotAgentSessionEvent } from "./event-snapshot.js";
import { DurableAgentSession } from "./session.js";
import type { AgentSessionHeaderV1, CreateAgentSessionOptions, EventPersistence } from "./types.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function assertSessionId(sessionId: SessionId): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("session id is not safe for durable storage");
}

function validateHeader(value: unknown, expectedId: SessionId): AgentSessionHeaderV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session header");
  const header = value as Record<string, unknown>;
  if (header.schemaVersion !== 1 || header.sessionId !== expectedId || typeof header.createdAt !== "string") {
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
  private readonly sessionsRoot: string;

  constructor(private readonly root: string) {
    this.sessionsRoot = path.join(path.resolve(root), "sessions");
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await mkdir(this.sessionsRoot, { recursive: true, mode: 0o700 });
    await chmod(this.sessionsRoot, 0o700);
  }

  private paths(sessionId: SessionId): { dir: string; header: string; events: string } {
    assertSessionId(sessionId);
    const dir = path.join(this.sessionsRoot, sessionId);
    return { dir, header: path.join(dir, "header.json"), events: path.join(dir, "events.jsonl") };
  }

  async create(options: CreateAgentSessionOptions = {}): Promise<DurableAgentSession> {
    await this.ensureRoot();
    const sessionId = options.sessionId ?? SessionId(`session-${randomUUID()}`);
    if (this.sessions.has(sessionId)) throw new Error(`session "${sessionId}" already exists`);
    const paths = this.paths(sessionId);
    await mkdir(paths.dir, { mode: 0o700 });
    await chmod(paths.dir, 0o700);
    const header: AgentSessionHeaderV1 = deepFreeze({
      schemaVersion: 1,
      sessionId,
      createdAt: new Date().toISOString(),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd })
    });
    await writeExclusive(paths.header, `${JSON.stringify(header)}\n`);
    await writeExclusive(paths.events, "");
    const persistence = this.persistence(paths.events);
    const session = new DurableAgentSession(header, [], persistence);
    this.sessions.set(sessionId, session);
    await session.append("session/created", {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.labels === undefined ? {} : { labels: options.labels })
    });
    return session;
  }

  async open(sessionId: SessionId): Promise<DurableAgentSession> {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;
    await this.ensureRoot();
    const paths = this.paths(sessionId);
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
    const session = new DurableAgentSession(header, events, this.persistence(paths.events));
    this.sessions.set(sessionId, session);
    return session;
  }

  private persistence(eventsPath: string): EventPersistence {
    return {
      append: async (event) => appendEvent(eventsPath, event),
      flush: async () => {}
    };
  }
}
