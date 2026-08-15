// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  EventId,
  createAgentSessionEvent,
  deepFreeze,
  verifyAgentSessionEventChain,
  type AgentSessionEventPayloadMapV1,
  type AgentSessionEventTypeV1,
  type AgentSessionEventV1
} from "@mn/agent-protocol";

import { snapshotAgentSessionEvent } from "./event-snapshot.js";
import type { AgentEventMetadata, AgentSessionHeaderV1, EventPersistence } from "./types.js";

export class DurableAgentSession {
  private readonly log: AgentSessionEventV1[];
  private tail: Promise<void> = Promise.resolve();
  private eventsSnapshot: readonly AgentSessionEventV1[] | undefined;

  constructor(
    readonly header: AgentSessionHeaderV1,
    seed: readonly AgentSessionEventV1[],
    private readonly persistence: EventPersistence
  ) {
    this.log = seed.map((event) => snapshotAgentSessionEvent(event));
    verifyAgentSessionEventChain(this.log);
    if (this.log.some((event) => event.sessionId !== header.sessionId)) {
      throw new Error("session event id does not match the header");
    }
    deepFreeze(this.header);
  }

  get events(): readonly AgentSessionEventV1[] {
    this.eventsSnapshot ??= Object.freeze([...this.log]);
    return this.eventsSnapshot;
  }

  append<T extends AgentSessionEventTypeV1>(
    type: T,
    payload: AgentSessionEventPayloadMapV1[T],
    metadata: AgentEventMetadata = {}
  ): Promise<AgentSessionEventV1<T>> {
    let resolveResult!: (event: AgentSessionEventV1<T>) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<AgentSessionEventV1<T>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const operation = this.tail.then(async () => {
      const previous = this.log.at(-1);
      const event = createAgentSessionEvent({
        eventId: EventId(randomUUID()),
        sessionId: this.header.sessionId,
        seq: this.log.length,
        occurredAt: new Date().toISOString(),
        type,
        payload,
        ...(metadata.runId === undefined ? {} : { runId: metadata.runId }),
        ...(metadata.candidateId === undefined ? {} : { candidateId: metadata.candidateId }),
        ...(previous === undefined ? {} : { previousDigest: previous.digest })
      });
      await this.persistence.append(event);
      this.log.push(event);
      this.eventsSnapshot = undefined;
      resolveResult(event);
    }).catch((error: unknown) => {
      rejectResult(error);
    });
    this.tail = operation;
    return result;
  }

  async flush(): Promise<void> {
    await this.tail;
    await this.persistence.flush();
  }
}
