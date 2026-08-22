// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import {
  assertAgentModelBindingV1,
  createAgentSessionEvent,
  createAgentSessionEventV2,
  deepFreeze,
  digestJson,
  protectAgentSessionPayloadV1,
  protectAgentSessionPayloadV2,
  snapshotJsonValue,
  verifyAgentSessionEventChain,
  verifyAgentSessionEventChainV2,
  type AgentSessionEventPayloadMap,
  type AgentSessionEventType,
  type AgentSessionEvent,
  type AgentSessionProtectedPayload,
  type Message
} from "@mn/agent-protocol";
import { protectJsonValue } from "@mn/data-policy";

import { snapshotAgentSessionEvent } from "./event-snapshot.js";
import { createSafeRandomEventId } from "./event-id.js";
import { inspectInternalRuntimeOverlaySeed } from "./runtime-overlay-internal.js";
import type { AgentEventMetadata, AgentSessionExclusiveView, AgentSessionHeader, EventPersistence } from "./types.js";

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
  private readonly log: AgentSessionEvent[];
  private readonly runtimePayloads = new Map<number, AgentSessionEventPayloadMap[AgentSessionEventType]>();
  private tail: Promise<void> = Promise.resolve();
  private eventsSnapshot: readonly AgentSessionEvent[] | undefined;
  private persistencePoisoned = false;
  private persistenceFailure: unknown;

  constructor(
    readonly header: AgentSessionHeader,
    seed: readonly AgentSessionEvent[],
    private readonly persistence: EventPersistence,
    private readonly cwd?: string,
    runtimeOverlaySeed?: unknown
  ) {
    this.log = seed.map((event) => snapshotAgentSessionEvent(event));
    if (this.log.some((event) => event.schemaVersion !== header.schemaVersion)) {
      throw new Error("session event chain mixes schema versions");
    }
    if (header.schemaVersion === 1) {
      verifyAgentSessionEventChain(this.log as Parameters<typeof verifyAgentSessionEventChain>[0]);
    } else {
      verifyAgentSessionEventChainV2(this.log as Parameters<typeof verifyAgentSessionEventChainV2>[0]);
    }
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
    const runtimePayloads = inspectInternalRuntimeOverlaySeed(runtimeOverlaySeed)?.payloads ?? new Map();
    for (const [seq, payload] of runtimePayloads) {
      const event = this.log[seq];
      const protectedPayload = event?.schemaVersion === 1
        ? protectAgentSessionPayloadV1(event.type, payload as never)
        : event?.schemaVersion === 2
          ? protectAgentSessionPayloadV2(event.type, payload)
          : undefined;
      if (protectedPayload?.digest !== event?.payload.digest) {
        throw new Error("runtime session overlay does not match its protected event");
      }
      this.runtimePayloads.set(seq, deepFreeze(payload));
    }
  }

  get events(): readonly AgentSessionEvent[] {
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
        | AgentSessionEventPayloadMap["user/message"]
        | AgentSessionEventPayloadMap["assistant/message"]
        | AgentSessionEventPayloadMap["tool/result"]
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

  runtimeCwd(): string | undefined {
    return this.cwd;
  }

  append<T extends AgentSessionEventType>(
    type: T,
    payload: AgentSessionEventPayloadMap[T],
    metadata: AgentEventMetadata = {}
  ): Promise<AgentSessionEvent<T>> {
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
        get header(): AgentSessionHeader { assertActive(); return owner.header; },
        get events(): readonly AgentSessionEvent[] { assertActive(); return owner.events; },
        append<EventType extends AgentSessionEventType>(
          type: EventType,
          payload: AgentSessionEventPayloadMap[EventType],
          metadata: AgentEventMetadata = {}
        ): Promise<AgentSessionEvent<EventType>> {
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

  private prepareAppend<T extends AgentSessionEventType>(
    type: T,
    payload: AgentSessionEventPayloadMap[T],
    metadata: AgentEventMetadata
  ): {
    type: T;
    payload: AgentSessionEventPayloadMap[T];
    protectedPayload: AgentSessionProtectedPayload<T>;
    metadata: AgentEventMetadata;
  } {
    // The profile builder performs the strict, trap-free exact-data validation
    // before the legacy snapshot helper is allowed to inspect the input.
    if (this.header.schemaVersion === 1 && type === "attachment/stored") {
      throw new TypeError("v1 sessions cannot append attachment events");
    }
    const protectedPayload = this.header.schemaVersion === 1
      ? protectAgentSessionPayloadV1(
        type as Exclude<AgentSessionEventType, "attachment/stored">,
        payload as never
      )
      : protectAgentSessionPayloadV2(type, payload);
    const payloadSnapshot = snapshotJsonValue(payload);
    if (payloadSnapshot === undefined) {
      throw new Error(`event ${type} payload is not losslessly JSON-serializable`);
    }
    deepFreeze(payloadSnapshot);
    const metadataSnapshot = snapshotMetadata(metadata);
    return {
      type,
      payload: payloadSnapshot,
      protectedPayload: protectedPayload as AgentSessionProtectedPayload<T>,
      metadata: metadataSnapshot
    };
  }

  private async appendPrepared<T extends AgentSessionEventType>(prepared: {
    type: T;
    payload: AgentSessionEventPayloadMap[T];
    protectedPayload: AgentSessionProtectedPayload<T>;
    metadata: AgentEventMetadata;
  }): Promise<AgentSessionEvent<T>> {
    this.assertPersistenceHealthy();
    const previous = this.log.at(-1);
    const common = {
      eventId: createSafeRandomEventId(),
      sessionId: this.header.sessionId,
      seq: this.log.length,
      occurredAt: new Date().toISOString(),
      type: prepared.type,
      ...(prepared.metadata.runId === undefined ? {} : { runId: prepared.metadata.runId }),
      ...(prepared.metadata.candidateId === undefined ? {} : { candidateId: prepared.metadata.candidateId }),
      ...(previous === undefined ? {} : { previousDigest: previous.digest })
    };
    const event: AgentSessionEvent<T> = this.header.schemaVersion === 1
      ? createAgentSessionEvent({
        ...common,
        type: prepared.type as Exclude<AgentSessionEventType, "attachment/stored">,
        payload: prepared.protectedPayload as never
      }) as AgentSessionEvent<T>
      : createAgentSessionEventV2({
        ...common,
        payload: prepared.protectedPayload as never
      }) as AgentSessionEvent<T>;
    try {
      await this.persistence.commitDurable(event, prepared.payload);
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
