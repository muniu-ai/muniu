// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import {
  assertAgentModelBindingV1,
  createAgentSessionEvent,
  deepFreeze,
  digestJson,
  protectAgentSessionPayloadV1,
  snapshotJsonValue,
  verifyAgentSessionEventChain,
  type AgentSessionEventPayloadMapV1,
  type AgentSessionEventTypeV1,
  type AgentSessionEventV1,
  type AgentSessionProtectedPayloadV1,
  type Message
} from "@mn/agent-protocol";
import { protectJsonValue } from "@mn/data-policy";

import { snapshotAgentSessionEvent } from "./event-snapshot.js";
import { createSafeRandomEventId } from "./event-id.js";
import type { AgentEventMetadata, AgentSessionExclusiveView, AgentSessionHeaderV1, EventPersistence } from "./types.js";

export class RuntimeOverlayRequiredError extends Error {
  readonly code = "RUNTIME_OVERLAY_REQUIRED";

  constructor() {
    super("RUNTIME_OVERLAY_REQUIRED: protected session history has no process-local runtime overlay");
    this.name = "RuntimeOverlayRequiredError";
  }
}

function snapshotMetadata(metadata: AgentEventMetadata): AgentEventMetadata {
  if (metadata === null || typeof metadata !== "object" || utilTypes.isProxy(metadata) || Array.isArray(metadata)) {
    throw new TypeError("event metadata must be an exact data-property record");
  }
  const prototype = Object.getPrototypeOf(metadata);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("event metadata must be an exact data-property record");
  }
  const keys = Reflect.ownKeys(metadata);
  if (keys.some((key) => typeof key !== "string" || (key !== "runId" && key !== "candidateId"))) {
    throw new TypeError("event metadata must be an exact data-property record");
  }
  const snapshot: { runId?: AgentEventMetadata["runId"]; candidateId?: AgentEventMetadata["candidateId"] } = {};
  for (const key of keys as ("runId" | "candidateId")[]) {
    const descriptor = Object.getOwnPropertyDescriptor(metadata, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("event metadata must contain only enumerable data properties");
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return Object.freeze(snapshot);
}

export class DurableAgentSession {
  private readonly log: AgentSessionEventV1[];
  private readonly runtimePayloads = new Map<number, AgentSessionEventPayloadMapV1[AgentSessionEventTypeV1]>();
  private tail: Promise<void> = Promise.resolve();
  private eventsSnapshot: readonly AgentSessionEventV1[] | undefined;
  private persistencePoisoned = false;
  private persistenceFailure: unknown;

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
    const created = this.log[0];
    if (created?.type === "session/created") {
      const headerBinding = header.modelBinding === undefined
        ? undefined
        : assertAgentModelBindingV1(header.modelBinding);
      const createdBinding = created.payload.publicControls.modelBinding;
      if ((headerBinding === undefined) !== (createdBinding === undefined)
        || (headerBinding !== undefined && createdBinding !== undefined
          && digestJson(headerBinding) !== digestJson(createdBinding))) {
        throw new Error("session header model binding does not match the creation event");
      }
    }
    deepFreeze(this.header);
  }

  get events(): readonly AgentSessionEventV1[] {
    this.eventsSnapshot ??= Object.freeze([...this.log]);
    return this.eventsSnapshot;
  }

  runtimeMessages(): readonly Message[] {
    const messages: Message[] = [];
    for (const event of this.log) {
      if (event.type !== "user/message"
        && event.type !== "assistant/message"
        && event.type !== "tool/result") continue;
      const runtime = this.runtimePayloads.get(event.seq) as
        | AgentSessionEventPayloadMapV1["user/message"]
        | AgentSessionEventPayloadMapV1["assistant/message"]
        | AgentSessionEventPayloadMapV1["tool/result"]
        | undefined;
      if (runtime === undefined) throw new RuntimeOverlayRequiredError();
      const protectedMessage = protectJsonValue(runtime.message, { businessRedaction: false });
      if (protectedMessage === null || typeof protectedMessage !== "object" || Array.isArray(protectedMessage)) {
        throw new Error("runtime message could not be protected for model use");
      }
      messages.push(deepFreeze(protectedMessage as unknown as Message));
    }
    return Object.freeze(messages);
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
    return this.enqueue(async () => {
      let accepting = true;
      let scopeTail: Promise<void> = Promise.resolve();
      let scopeFailed = false;
      let scopeFailure: unknown;
      const assertActive = (): void => {
        if (!accepting) throw new Error("exclusive session view has expired");
      };
      const scopeEnqueue = <Result>(inner: () => Promise<Result>): Promise<Result> => {
        assertActive();
        const result = scopeTail.then(inner);
        void result.catch((error: unknown) => {
          if (!scopeFailed) {
            scopeFailed = true;
            scopeFailure = error;
          }
        });
        scopeTail = result.then(() => undefined, () => undefined);
        return result;
      };
      const owner = this;
      const view: AgentSessionExclusiveView = Object.freeze({
        get header(): AgentSessionHeaderV1 { assertActive(); return owner.header; },
        get events(): readonly AgentSessionEventV1[] { assertActive(); return owner.events; },
        append<EventType extends AgentSessionEventTypeV1>(
          type: EventType,
          payload: AgentSessionEventPayloadMapV1[EventType],
          metadata: AgentEventMetadata = {}
        ): Promise<AgentSessionEventV1<EventType>> {
          assertActive();
          const prepared = owner.prepareAppend(type, payload, metadata);
          return scopeEnqueue(() => owner.appendPrepared(prepared));
        },
        flush(): Promise<void> {
          return scopeEnqueue(() => owner.flushPersistence());
        }
      });

      const outcome = await Promise.resolve().then(() => operation(view)).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
      accepting = false;
      await scopeTail;
      if (!outcome.ok) throw outcome.error;
      if (scopeFailed) throw scopeFailure;
      return outcome.value;
    });
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
    protectedPayload: AgentSessionProtectedPayloadV1<T>;
    metadata: AgentEventMetadata;
  } {
    // The profile builder performs the strict, trap-free exact-data validation
    // before the legacy snapshot helper is allowed to inspect the input.
    const protectedPayload = protectAgentSessionPayloadV1(type, payload);
    const payloadSnapshot = snapshotJsonValue(payload);
    if (payloadSnapshot === undefined) {
      throw new Error(`event ${type} payload is not losslessly JSON-serializable`);
    }
    deepFreeze(payloadSnapshot);
    const metadataSnapshot = snapshotMetadata(metadata);
    return {
      type,
      payload: payloadSnapshot,
      protectedPayload,
      metadata: metadataSnapshot
    };
  }

  private async appendPrepared<T extends AgentSessionEventTypeV1>(prepared: {
    type: T;
    payload: AgentSessionEventPayloadMapV1[T];
    protectedPayload: AgentSessionProtectedPayloadV1<T>;
    metadata: AgentEventMetadata;
  }): Promise<AgentSessionEventV1<T>> {
    this.assertPersistenceHealthy();
    const previous = this.log.at(-1);
    const event = createAgentSessionEvent({
      eventId: createSafeRandomEventId(),
      sessionId: this.header.sessionId,
      seq: this.log.length,
      occurredAt: new Date().toISOString(),
      type: prepared.type,
      payload: prepared.protectedPayload,
      ...(prepared.metadata.runId === undefined ? {} : { runId: prepared.metadata.runId }),
      ...(prepared.metadata.candidateId === undefined ? {} : { candidateId: prepared.metadata.candidateId }),
      ...(previous === undefined ? {} : { previousDigest: previous.digest })
    });
    try {
      await this.persistence.commitDurable(event);
    } catch (error: unknown) {
      this.poisonPersistence(error);
      throw error;
    }
    this.log.push(event);
    this.runtimePayloads.set(event.seq, prepared.payload);
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
