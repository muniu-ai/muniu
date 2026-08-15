// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  EventId,
  createAgentSessionEvent,
  deepFreeze,
  snapshotJsonValue,
  verifyAgentSessionEventChain,
  type AgentSessionEventPayloadMapV1,
  type AgentSessionEventTypeV1,
  type AgentSessionEventV1
} from "@mn/agent-protocol";

import { snapshotAgentSessionEvent } from "./event-snapshot.js";
import type { AgentEventMetadata, AgentSessionExclusiveView, AgentSessionHeaderV1, EventPersistence } from "./types.js";

export class DurableAgentSession {
  private readonly log: AgentSessionEventV1[];
  private tail: Promise<void> = Promise.resolve();
  private eventsSnapshot: readonly AgentSessionEventV1[] | undefined;
  private persistencePoisoned = false;
  private persistenceFailure: unknown;
  private readonly exclusiveView: AgentSessionExclusiveView;

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
    const owner = this;
    this.exclusiveView = Object.freeze({
      header: this.header,
      get events(): readonly AgentSessionEventV1[] { return owner.events; },
      append<T extends AgentSessionEventTypeV1>(
        type: T,
        payload: AgentSessionEventPayloadMapV1[T],
        metadata: AgentEventMetadata = {}
      ): Promise<AgentSessionEventV1<T>> {
        const prepared = owner.prepareAppend(type, payload, metadata);
        return owner.appendPrepared(prepared);
      },
      flush(): Promise<void> { return owner.flushPersistence(); }
    });
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
    const prepared = this.prepareAppend(type, payload, metadata);
    return this.enqueue(() => this.appendPrepared(prepared));
  }

  withExclusive<T>(operation: (session: AgentSessionExclusiveView) => Promise<T>): Promise<T> {
    return this.enqueue(() => operation(this.exclusiveView));
  }

  flush(): Promise<void> {
    return this.enqueue(() => this.flushPersistence());
  }

  private prepareAppend<T extends AgentSessionEventTypeV1>(
    type: T,
    payload: AgentSessionEventPayloadMapV1[T],
    metadata: AgentEventMetadata
  ): {
    type: T;
    payload: AgentSessionEventPayloadMapV1[T];
    metadata: AgentEventMetadata;
  } {
    const payloadSnapshot = snapshotJsonValue(payload);
    if (payloadSnapshot === undefined) {
      throw new Error(`event ${type} payload is not losslessly JSON-serializable`);
    }
    deepFreeze(payloadSnapshot);
    const runId = metadata.runId;
    const candidateId = metadata.candidateId;
    return {
      type,
      payload: payloadSnapshot,
      metadata: {
        ...(runId === undefined ? {} : { runId }),
        ...(candidateId === undefined ? {} : { candidateId })
      }
    };
  }

  private async appendPrepared<T extends AgentSessionEventTypeV1>(prepared: {
    type: T;
    payload: AgentSessionEventPayloadMapV1[T];
    metadata: AgentEventMetadata;
  }): Promise<AgentSessionEventV1<T>> {
    this.assertPersistenceHealthy();
    const previous = this.log.at(-1);
    const event = createAgentSessionEvent({
      eventId: EventId(randomUUID()),
      sessionId: this.header.sessionId,
      seq: this.log.length,
      occurredAt: new Date().toISOString(),
      type: prepared.type,
      payload: prepared.payload,
      ...(prepared.metadata.runId === undefined ? {} : { runId: prepared.metadata.runId }),
      ...(prepared.metadata.candidateId === undefined ? {} : { candidateId: prepared.metadata.candidateId }),
      ...(previous === undefined ? {} : { previousDigest: previous.digest })
    });
    try {
      await this.persistence.append(event);
    } catch (error: unknown) {
      this.poisonPersistence(error);
      throw error;
    }
    this.log.push(event);
    this.eventsSnapshot = undefined;
    return event;
  }

  private async flushPersistence(): Promise<void> {
    this.assertPersistenceHealthy();
    try {
      await this.persistence.flush();
    } catch (error: unknown) {
      this.poisonPersistence(error);
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private poisonPersistence(error: unknown): void {
    if (this.persistencePoisoned) return;
    this.persistencePoisoned = true;
    this.persistenceFailure = error;
  }

  private assertPersistenceHealthy(): void {
    if (!this.persistencePoisoned) return;
    throw new Error("session is poisoned by a previous persistence failure", {
      cause: this.persistenceFailure
    });
  }
}
