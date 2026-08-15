// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { SessionId, deepFreeze, type AgentSessionEventV1 } from "@mn/agent-protocol";

import { DurableAgentSession } from "./session.js";
import type { AgentSessionHeaderV1, CreateAgentSessionOptions, EventPersistence } from "./types.js";

const memoryPersistence: EventPersistence = {
  append: async (_event: AgentSessionEventV1): Promise<void> => {},
  flush: async (): Promise<void> => {}
};

export class InMemoryAgentSessionStore {
  private readonly sessions = new Map<SessionId, DurableAgentSession>();

  async create(options: CreateAgentSessionOptions = {}): Promise<DurableAgentSession> {
    const sessionId = options.sessionId ?? SessionId(`session-${randomUUID()}`);
    if (this.sessions.has(sessionId)) throw new Error(`session "${sessionId}" already exists`);
    const header: AgentSessionHeaderV1 = deepFreeze({
      schemaVersion: 1,
      sessionId,
      createdAt: new Date().toISOString(),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd })
    });
    const session = new DurableAgentSession(header, [], memoryPersistence);
    this.sessions.set(sessionId, session);
    await session.append("session/created", {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.labels === undefined ? {} : { labels: options.labels })
    });
    return session;
  }

  async open(sessionId: SessionId): Promise<DurableAgentSession> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`session "${sessionId}" not found`);
    return session;
  }
}
