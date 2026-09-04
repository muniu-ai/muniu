import type {
  EventAppendRequest,
  EventPage,
  JsonObject,
  KernelEventV1,
} from "@mn/contracts";
import { computeEventDigest, computeEventHmac } from "@mn/contracts";
import { StreamVersionConflictError } from "./errors.js";

export interface IdempotencyRecord {
  readonly tenantId: string;
  readonly scope: string;
  readonly key: string;
  readonly requestDigest: string;
  readonly response: unknown;
  readonly createdAt: string;
}

export interface KernelJobWrite {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId?: string;
  readonly kind: string;
  readonly payload: JsonObject;
  readonly availableAt: string;
  readonly idempotencyKey: string;
}

export interface KernelOutboxWrite {
  readonly id: string;
  readonly tenantId: string;
  readonly topic: string;
  readonly payload: JsonObject;
  readonly availableAt?: string;
}

export interface KernelJobLeaseAssertion {
  readonly jobId: string;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly occurredAt: string;
}

export interface KernelTransaction {
  appendEvent(request: EventAppendRequest): KernelEventV1;
  getProjection<T>(namespace: string, id: string): T | undefined;
  listProjections<T>(namespace: string): readonly T[];
  putProjection<T>(namespace: string, id: string, value: T): void;
  deleteProjection(namespace: string, id: string): void;
  getIdempotency(scope: string, key: string): IdempotencyRecord | undefined;
  putIdempotency(record: IdempotencyRecord): void;
  putJob(job: KernelJobWrite): void;
  putOutbox(message: KernelOutboxWrite): void;
  /**
   * Storage-backed implementations validate the physical lease and its query
   * projection inside this same transaction. Worker business writes must fail
   * closed when the capability is unavailable.
   */
  assertJobLease?(input: KernelJobLeaseAssertion): void;
}

export interface KernelStore {
  transact<T>(tenantId: string, work: (transaction: KernelTransaction) => T): Promise<T>;
  readEvents(tenantId: string, afterPosition: number, limit: number): Promise<EventPage>;
  /** 企业 Host 用于启动时逐租户恢复并校验插件 lock。 */
  listTenantIds?(): Promise<readonly string[]>;
}

interface MemoryState {
  events: KernelEventV1[];
  projections: Map<string, unknown>;
  idempotency: Map<string, IdempotencyRecord>;
  positions: Map<string, number>;
  streamVersions: Map<string, number>;
  jobs: Map<string, KernelJobWrite>;
  outbox: Map<string, KernelOutboxWrite>;
}

function cloneState(state: MemoryState): MemoryState {
  return {
    events: [...state.events],
    projections: new Map(state.projections),
    idempotency: new Map(state.idempotency),
    positions: new Map(state.positions),
    streamVersions: new Map(state.streamVersions),
    jobs: new Map(state.jobs),
    outbox: new Map(state.outbox),
  };
}

export class InMemoryKernelStore implements KernelStore {
  private state: MemoryState = {
    events: [],
    projections: new Map(),
    idempotency: new Map(),
    positions: new Map(),
    streamVersions: new Map(),
    jobs: new Map(),
    outbox: new Map(),
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
        const digest = computeEventDigest(body);
        const event: KernelEventV1 = { ...body, digest, hmac: computeEventHmac(digest, this.hmacKey) };
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
      putJob: (job) => {
        if (job.tenantId !== tenantId) throw new Error("事务不能跨租户写入 Job");
        const key = `${tenantId}:${job.id}`;
        if (staged.jobs.has(key)) throw new Error(`Job ${job.id} 已存在`);
        staged.jobs.set(key, job);
      },
      putOutbox: (message) => {
        if (message.tenantId !== tenantId) throw new Error("事务不能跨租户写入 outbox");
        const key = `${tenantId}:${message.id}`;
        if (staged.outbox.has(key)) throw new Error(`Outbox ${message.id} 已存在`);
        staged.outbox.set(key, message);
      },
      assertJobLease: (input) => {
        const value = staged.projections.get(`${tenantId}:job:${input.jobId}`);
        const job = typeof value === "object" && value !== null
          ? value as Record<string, unknown>
          : undefined;
        if (!job
          || job.status !== "leased"
          || job.leaseOwner !== input.workerId
          || job.fencingToken !== input.fencingToken
          || typeof job.leaseExpiresAt !== "string"
          || Date.parse(job.leaseExpiresAt) <= Date.parse(input.occurredAt)) {
          const error = new Error(`Worker no longer owns job ${input.jobId}`) as Error & { code: string };
          error.code = "STALE_FENCING_TOKEN";
          throw error;
        }
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

  async listTenantIds(): Promise<readonly string[]> {
    return [...new Set(this.state.events.map((event) => event.tenantId))].sort();
  }

  readJobs(tenantId: string): readonly KernelJobWrite[] {
    return [...this.state.jobs.entries()]
      .filter(([key]) => key.startsWith(`${tenantId}:`))
      .map(([, job]) => job);
  }

  readOutbox(tenantId: string): readonly KernelOutboxWrite[] {
    return [...this.state.outbox.entries()]
      .filter(([key]) => key.startsWith(`${tenantId}:`))
      .map(([, message]) => message);
  }
}
