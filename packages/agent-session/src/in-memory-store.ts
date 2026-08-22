// SPDX-License-Identifier: Apache-2.0

import { SessionId, type AgentSessionEvent } from "@mn/agent-protocol";

import { snapshotCreateAgentSessionOptions, type CreateAgentSessionOptionsSnapshot } from "./create-options.js";
import { createInitialAgentSessionState } from "./initial-state.js";
import { DurableAgentSession } from "./session.js";
import type { CreateAgentSessionOptions, EventPersistence } from "./types.js";

const memoryPersistence: EventPersistence = {
  commitDurable: async (_event: AgentSessionEvent): Promise<void> => {},
  flush: async (): Promise<void> => {}
};

export class InMemoryAgentSessionStore {
  private readonly sessions = new Map<SessionId, DurableAgentSession>();

  create(options: CreateAgentSessionOptions = {}): Promise<DurableAgentSession> {
    const snapshot = snapshotCreateAgentSessionOptions(options);
    return this.createSnapshot(snapshot);
  }

  private async createSnapshot(options: CreateAgentSessionOptionsSnapshot): Promise<DurableAgentSession> {
    const { sessionId } = options;
    if (this.sessions.has(sessionId)) throw new Error(`session "${sessionId}" already exists`);
    const initial = createInitialAgentSessionState(options);
    const session = new DurableAgentSession(initial.header, [initial.event], memoryPersistence, options.cwd);
    // Publish only a complete in-memory session, so a failed initial snapshot
    // cannot leave a provisional entry that blocks a retry.
    this.sessions.set(sessionId, session);
    return session;
  }

  async open(sessionId: SessionId): Promise<DurableAgentSession> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`session "${sessionId}" not found`);
    return session;
  }

  async listSessionIds(): Promise<readonly SessionId[]> {
    return Object.freeze([...this.sessions.keys()].sort());
  }
}
