import type {
  CodingTaskAggregate,
  RepositoryAggregate,
  ServiceAggregate,
} from "./domain.ts";
import { immutable } from "./domain.ts";
import { CodingDomainError } from "./errors.ts";
import type {
  CodingEvent,
  CodingTaskEvent,
  RepositoryEvent,
  ServiceEvent,
  StoredCodingEvent,
  StoredCodingTaskEvent,
  StoredRepositoryEvent,
  StoredServiceEvent,
} from "./events.ts";
import {
  reduceCodingTaskEvents,
  reduceRepositoryEvents,
  reduceServiceEvents,
} from "./reducer.ts";

export type CodingAggregateType = "repository" | "service" | "task";

export interface CodingStreamReference {
  readonly workspaceId: string;
  readonly aggregateType: CodingAggregateType;
  readonly aggregateId: string;
}

export interface CodingIdempotencyRecord {
  readonly key: string;
  readonly request: unknown;
}

export interface CodingAppendRequest<TEvent extends CodingEvent> {
  readonly workspaceId: string;
  readonly aggregateId: string;
  readonly expectedStreamVersion: number;
  readonly events: readonly TEvent[];
  readonly idempotency: CodingIdempotencyRecord;
}

export interface CodingRepository {
  loadRepository(workspaceId: string, repositoryId: string): Promise<RepositoryAggregate | undefined>;
  loadService(workspaceId: string, serviceId: string): Promise<ServiceAggregate | undefined>;
  loadTask(workspaceId: string, taskId: string): Promise<CodingTaskAggregate | undefined>;
  appendRepository(request: CodingAppendRequest<RepositoryEvent>): Promise<RepositoryAggregate>;
  appendService(request: CodingAppendRequest<ServiceEvent>): Promise<ServiceAggregate>;
  appendTask(request: CodingAppendRequest<CodingTaskEvent>): Promise<CodingTaskAggregate>;
  events(reference: CodingStreamReference): Promise<readonly StoredCodingEvent[]>;
}

type CodingAggregate = RepositoryAggregate | ServiceAggregate | CodingTaskAggregate;

export class InMemoryCodingRepository implements CodingRepository {
  readonly #streams = new Map<string, StoredCodingEvent[]>();
  readonly #idempotency = new Map<string, {
    readonly request: string;
    readonly response: CodingAggregate;
  }>();
  readonly #eventIds = new Set<string>();
  #fallbackEventId = 0;

  async loadRepository(
    workspaceId: string,
    repositoryId: string,
  ): Promise<RepositoryAggregate | undefined> {
    const events = this.#stream<StoredRepositoryEvent>({
      workspaceId,
      aggregateType: "repository",
      aggregateId: repositoryId,
    });
    return cloneOptional(reduceRepositoryEvents(workspaceId, repositoryId, events));
  }

  async loadService(workspaceId: string, serviceId: string): Promise<ServiceAggregate | undefined> {
    const events = this.#stream<StoredServiceEvent>({
      workspaceId,
      aggregateType: "service",
      aggregateId: serviceId,
    });
    return cloneOptional(reduceServiceEvents(serviceId, events));
  }

  async loadTask(workspaceId: string, taskId: string): Promise<CodingTaskAggregate | undefined> {
    const events = this.#stream<StoredCodingTaskEvent>({
      workspaceId,
      aggregateType: "task",
      aggregateId: taskId,
    });
    return cloneOptional(reduceCodingTaskEvents(workspaceId, taskId, events));
  }

  async appendRepository(
    request: CodingAppendRequest<RepositoryEvent>,
  ): Promise<RepositoryAggregate> {
    return this.#append(
      "repository",
      request,
      (events) => reduceRepositoryEvents(
        request.workspaceId,
        request.aggregateId,
        events as readonly StoredRepositoryEvent[],
      ),
    );
  }

  async appendService(request: CodingAppendRequest<ServiceEvent>): Promise<ServiceAggregate> {
    return this.#append(
      "service",
      request,
      (events) => reduceServiceEvents(
        request.aggregateId,
        events as readonly StoredServiceEvent[],
      ),
    );
  }

  async appendTask(request: CodingAppendRequest<CodingTaskEvent>): Promise<CodingTaskAggregate> {
    return this.#append(
      "task",
      request,
      (events) => reduceCodingTaskEvents(
        request.workspaceId,
        request.aggregateId,
        events as readonly StoredCodingTaskEvent[],
      ),
    );
  }

  async events(reference: CodingStreamReference): Promise<readonly StoredCodingEvent[]> {
    return freezeClone(this.#streams.get(streamKey(reference)) ?? []);
  }

  #stream<TEvent extends StoredCodingEvent>(reference: CodingStreamReference): readonly TEvent[] {
    return (this.#streams.get(streamKey(reference)) ?? []) as unknown as readonly TEvent[];
  }

  #append<TEvent extends CodingEvent, TAggregate extends CodingAggregate>(
    aggregateType: CodingAggregateType,
    request: CodingAppendRequest<TEvent>,
    reduce: (events: readonly StoredCodingEvent[]) => TAggregate | undefined,
  ): TAggregate {
    if (!request.workspaceId.trim() || !request.aggregateId.trim()) {
      throw new CodingDomainError(
        "INVALID_INPUT",
        "工作区 ID 和聚合 ID 不能为空",
        "填写完整标识后重试",
      );
    }
    if (!Number.isSafeInteger(request.expectedStreamVersion)
      || request.expectedStreamVersion < 0) {
      throw new CodingDomainError(
        "INVALID_INPUT",
        "expectedStreamVersion 必须是非负整数",
        "重新读取聚合版本后重试",
        "expectedStreamVersion",
      );
    }
    if (!request.idempotency.key.trim()) {
      throw new CodingDomainError(
        "INVALID_INPUT",
        "Idempotency-Key 不能为空",
        "为 mutation 提供非空 Idempotency-Key",
        "idempotencyKey",
      );
    }
    const reference: CodingStreamReference = {
      workspaceId: request.workspaceId,
      aggregateType,
      aggregateId: request.aggregateId,
    };
    const key = streamKey(reference);
    const idempotencyKey = `${key}:idempotency:${request.idempotency.key}`;
    const normalizedRequest = canonicalJson(request.idempotency.request);
    const previous = this.#idempotency.get(idempotencyKey);
    if (previous) {
      if (previous.request !== normalizedRequest) {
        throw new CodingDomainError(
          "IDEMPOTENCY_KEY_REUSED",
          "幂等键已用于不同请求",
          "使用新的 Idempotency-Key",
          "idempotencyKey",
        );
      }
      return freezeClone(previous.response) as TAggregate;
    }
    if (request.events.length === 0) {
      throw new CodingDomainError("INVALID_INPUT", "事件列表不能为空", "至少提交一个领域事件");
    }
    const current = this.#streams.get(key) ?? [];
    if (request.expectedStreamVersion !== current.length) {
      throw new CodingDomainError(
        "STREAM_VERSION_CONFLICT",
        `预期版本 ${request.expectedStreamVersion}，实际版本 ${current.length}`,
        "重新读取聚合后使用新 Idempotency-Key 重试",
        "expectedStreamVersion",
      );
    }

    const batchIds = new Set<string>();
    const appended = request.events.map((event, index): StoredCodingEvent => {
      const eventId = event.eventId ?? `coding-event-${++this.#fallbackEventId}`;
      if (!eventId.trim() || this.#eventIds.has(eventId) || batchIds.has(eventId)) {
        throw new CodingDomainError(
          "DUPLICATE_ID",
          `领域事件 ID ${eventId || "<empty>"} 已存在或无效`,
          "生成新的事件 ID 后重试",
        );
      }
      batchIds.add(eventId);
      return {
        ...structuredClone(event),
        eventId,
        streamVersion: current.length + index + 1,
      } as StoredCodingEvent;
    });
    const next = [...current, ...appended];
    const aggregate = reduce(next);
    if (!aggregate) {
      throw new CodingDomainError(
        "INVALID_INPUT",
        "事件没有创建领域聚合",
        "先提交对应的创建事件",
      );
    }

    this.#streams.set(key, next);
    for (const eventId of batchIds) this.#eventIds.add(eventId);
    this.#idempotency.set(idempotencyKey, {
      request: normalizedRequest,
      response: structuredClone(aggregate),
    });
    return freezeClone(aggregate);
  }
}

function streamKey(reference: CodingStreamReference): string {
  return [reference.workspaceId, reference.aggregateType, reference.aggregateId]
    .map((part) => `${part.length}:${part}`)
    .join("");
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : freezeClone(value);
}

function freezeClone<T>(value: T): T {
  return immutable(structuredClone(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((name) => record[name] !== undefined)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonicalJson(record[name])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
