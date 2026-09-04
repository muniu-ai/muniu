import type {
  EventAppendRequest,
  EventPage,
  KernelEventV1,
} from "@mn/contracts";
import { hmacSha256, sha256 } from "./canonical.js";
import { StreamVersionConflictError } from "./errors.js";

export interface IdempotencyRecord {
  readonly tenantId: string;
  readonly scope: string;
  readonly key: string;
  readonly requestDigest: string;
  readonly response: unknown;
  readonly createdAt: string;
}

export interface KernelTransaction {
  appendEvent(request: EventAppendRequest): KernelEventV1;
  getProjection<T>(namespace: string, id: string): T | undefined;
  listProjections<T>(namespace: string): readonly T[];
  putProjection<T>(namespace: string, id: string, value: T): void;
  deleteProjection(namespace: string, id: string): void;
  getIdempotency(scope: string, key: string): IdempotencyRecord | undefined;
  putIdempotency(record: IdempotencyRecord): void;
}

export interface KernelStore {
  transact<T>(tenantId: string, work: (transaction: KernelTransaction) => T): Promise<T>;
  readEvents(tenantId: string, afterPosition: number, limit: number): Promise<EventPage>;
}

interface MemoryState {
  events: KernelEventV1[];
  projections: Map<string, unknown>;
  idempotency: Map<string, IdempotencyRecord>;
  positions: Map<string, number>;
  streamVersions: Map<string, number>;
}

function cloneState(state: MemoryState): MemoryState {
  return {
    events: [...state.events],
    projections: new Map(state.projections),
    idempotency: new Map(state.idempotency),
    positions: new Map(state.positions),
    streamVersions: new Map(state.streamVersions),
  };
}

export class InMemoryKernelStore implements KernelStore {
  private state: MemoryState = {
    events: [],
    projections: new Map(),
    idempotency: new Map(),
    positions: new Map(),
    streamVersions: new Map(),
  };

  constructor(
    private readonly hmacKey: Uint8Array = Buffer.from("development-only-kernel-hmac-key"),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async transact<T>(tenantId: string, work: (transaction: KernelTransaction) => T): Promise<T> {
    const staged = cloneState(this.state);
    let ordinal = 0;
    const transaction: KernelTransaction = {
      appendEvent: (request) => {
        if (request.tenantId !== tenantId) throw new Error("事务不能跨租户写入");
        const streamKey = `${tenantId}:${request.aggregateType}:${request.aggregateId}`;
        const actual = staged.streamVersions.get(streamKey) ?? 0;
        if (actual !== request.expectedStreamVersion) {
          throw new StreamVersionConflictError(request.expectedStreamVersion, actual);
        }
        const position = (staged.positions.get(tenantId) ?? 0) + 1;
        const previous = [...staged.events]
          .reverse()
          .find((event) => event.tenantId === tenantId);
        const body = {
          schemaVersion: 1 as const,
          id: `event-${tenantId}-${position}-${++ordinal}`,
          tenantId,
          position,
          aggregateType: request.aggregateType,
          aggregateId: request.aggregateId,
          streamVersion: actual + 1,
          type: request.type,
          occurredAt: this.now(),
          actorId: request.actorId,
          executionId: request.executionId,
          generation: request.generation,
          causationId: request.causationId,
          correlationId: request.correlationId,
          publicPayload: request.publicPayload,
          protectedPayloadRef: request.protectedPayloadRef,
          previousDigest: previous?.digest,
        };
        const digest = sha256(body);
        const event: KernelEventV1 = { ...body, digest, hmac: hmacSha256(this.hmacKey, digest) };
        staged.events.push(event);
        staged.positions.set(tenantId, position);
        staged.streamVersions.set(streamKey, actual + 1);
        return event;
      },
      getProjection: <T>(namespace: string, id: string) =>
        staged.projections.get(`${tenantId}:${namespace}:${id}`) as T | undefined,
      listProjections: <T>(namespace: string) => {
        const prefix = `${tenantId}:${namespace}:`;
        return [...staged.projections.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, value]) => value as T);
      },
      putProjection: <T>(namespace: string, id: string, value: T) => {
        staged.projections.set(`${tenantId}:${namespace}:${id}`, value);
      },
      deleteProjection: (namespace: string, id: string) => {
        staged.projections.delete(`${tenantId}:${namespace}:${id}`);
      },
      getIdempotency: (scope: string, key: string) =>
        staged.idempotency.get(`${tenantId}:${scope}:${key}`),
      putIdempotency: (record: IdempotencyRecord) => {
        staged.idempotency.set(`${tenantId}:${record.scope}:${record.key}`, record);
      },
    };
    const result = work(transaction);
    this.state = staged;
    return result;
  }

  async readEvents(tenantId: string, afterPosition: number, limit: number): Promise<EventPage> {
    const floor = 0;
    const events = this.state.events
      .filter((event) => event.tenantId === tenantId && event.position > afterPosition)
      .slice(0, limit);
    return {
      events,
      nextPosition: events.at(-1)?.position ?? afterPosition,
      retentionFloor: floor,
    };
  }
}
