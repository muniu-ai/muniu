// SPDX-License-Identifier: Apache-2.0

import {
  SessionId,
  type AgentSessionEvent,
  type AgentSessionEventPayloadMap,
  type AgentSessionEventType
} from "@mn/agent-protocol";
import { snapshotCreateAgentSessionOptions } from "./create-options.js";
import { createInitialAgentSessionState } from "./initial-state.js";
import { DurableAgentSession } from "./session.js";
import { createInternalRuntimeOverlaySeed } from "./runtime-overlay-internal.js";
import type {
  AgentSessionHeader,
  CreateAgentSessionOptions,
  EventPersistence
} from "./types.js";

export interface RemoteAgentSessionSnapshot {
  readonly header: AgentSessionHeader;
  readonly events: readonly AgentSessionEvent[];
  readonly runtimePayloads: ReadonlyMap<
    number,
    AgentSessionEventPayloadMap[AgentSessionEventType]
  >;
}

export interface RemoteAgentSessionBackend {
  create(input: {
    readonly header: AgentSessionHeader;
    readonly event: AgentSessionEvent<"session/created">;
    readonly runtimePayload: AgentSessionEventPayloadMap["session/created"];
  }): Promise<void>;
  load(sessionId: SessionId): Promise<RemoteAgentSessionSnapshot>;
  append(
    event: AgentSessionEvent,
    runtimePayload?: AgentSessionEventPayloadMap[AgentSessionEventType]
  ): Promise<void>;
  listSessionIds(): Promise<readonly SessionId[]>;
  dispose?(): void | Promise<void>;
}

export class RemoteAgentSessionStore {
  constructor(private readonly backend: RemoteAgentSessionBackend) {}

  async create(options: CreateAgentSessionOptions = {}): Promise<DurableAgentSession> {
    const snapshot = snapshotCreateAgentSessionOptions(options);
    const initial = createInitialAgentSessionState(snapshot);
    const runtimePayload = {
      ...(snapshot.cwd === undefined ? {} : { cwd: snapshot.cwd }),
      ...(snapshot.labels === undefined ? {} : { labels: snapshot.labels }),
      ...(snapshot.modelBinding === undefined ? {} : { modelBinding: snapshot.modelBinding })
    };
    await this.backend.create({
      header: initial.header,
      event: initial.event,
      runtimePayload
    });
    return new DurableAgentSession(
      initial.header,
      [initial.event],
      this.persistence(initial.header.sessionId),
      snapshot.cwd,
      createInternalRuntimeOverlaySeed(new Map([[0, runtimePayload]]))
    );
  }

  async open(sessionId: SessionId): Promise<DurableAgentSession> {
    const snapshot = await this.backend.load(sessionId);
    const runtimePayloads = new Map(snapshot.runtimePayloads);
    const createdRuntime = runtimePayloads.get(0) as
      | AgentSessionEventPayloadMap["session/created"]
      | undefined;
    return new DurableAgentSession(
      snapshot.header,
      snapshot.events,
      this.persistence(sessionId),
      createdRuntime?.cwd,
      createInternalRuntimeOverlaySeed(runtimePayloads)
    );
  }

  listSessionIds(): Promise<readonly SessionId[]> {
    return this.backend.listSessionIds();
  }

  dispose(): void | Promise<void> {
    return this.backend.dispose?.();
  }

  private persistence(sessionId: SessionId): EventPersistence {
    return {
      commitDurable: async (event, runtimePayload) => {
        if (event.sessionId !== sessionId) throw new Error("remote session event id mismatch");
        await this.backend.append(event, runtimePayload);
      },
      flush: async () => {}
    };
  }
}
