import { OpcDomainError } from "./errors.js";
import type { OpcEvent, StoredOpcEvent } from "./events.js";
import type { OpportunityAggregate } from "./model.js";
import { reduceOpcEvents } from "./reducer.js";

export interface OpcAppendRequest {
  readonly workspaceId: string;
  readonly opportunityId: string;
  readonly expectedStreamVersion: number;
  readonly events: readonly OpcEvent[];
  /** 由持久化实现与领域事件在同一事务记录，保证命令重放返回首次结果。 */
  readonly idempotency?: {
    readonly key: string;
    readonly scope: string;
    readonly request: unknown;
  };
}

export interface OpcRepository {
  load(workspaceId: string, opportunityId: string): Promise<OpportunityAggregate | undefined>;
  append(request: OpcAppendRequest): Promise<OpportunityAggregate>;
  events(workspaceId: string, opportunityId: string): Promise<readonly StoredOpcEvent[]>;
}

export class InMemoryOpcRepository implements OpcRepository {
  readonly #streams = new Map<string, StoredOpcEvent[]>();
  readonly #idempotency = new Map<string, { readonly request: string; readonly response: OpportunityAggregate }>();
  #fallbackEventId = 0;

  async load(workspaceId: string, opportunityId: string): Promise<OpportunityAggregate | undefined> {
    const aggregate = reduceOpcEvents(workspaceId, opportunityId, this.#streams.get(key(workspaceId, opportunityId)) ?? []);
    return aggregate ? structuredClone(aggregate) : undefined;
  }

  async append(request: OpcAppendRequest): Promise<OpportunityAggregate> {
    const idempotencyKey = request.idempotency
      ? `${key(request.workspaceId, request.opportunityId)}:${request.idempotency.scope}:${request.idempotency.key}`
      : undefined;
    if (idempotencyKey && request.idempotency) {
      const previous = this.#idempotency.get(idempotencyKey);
      const normalized = canonicalJson(request.idempotency.request);
      if (previous) {
        if (previous.request !== normalized) {
          throw new OpcDomainError("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求", "使用新的 Idempotency-Key");
        }
        return structuredClone(previous.response);
      }
    }
    if (request.events.length === 0) {
      throw new OpcDomainError("INVALID_INPUT", "事件列表不能为空", "至少提交一个领域事件");
    }
    const streamKey = key(request.workspaceId, request.opportunityId);
    const current = this.#streams.get(streamKey) ?? [];
    if (request.expectedStreamVersion !== current.length) {
      throw new OpcDomainError(
        "STREAM_VERSION_CONFLICT",
        `预期版本 ${request.expectedStreamVersion}，实际版本 ${current.length}`,
        "重新读取机会后重试",
      );
    }
    const appended = request.events.map((event, index): StoredOpcEvent => ({
      ...structuredClone(event),
      eventId: event.eventId ?? `opc-event-${++this.#fallbackEventId}`,
      streamVersion: current.length + index + 1,
    })) as StoredOpcEvent[];
    const eventIds = new Set(current.map((event) => event.eventId));
    for (const event of appended) {
      if (eventIds.has(event.eventId)) {
        throw new OpcDomainError("DUPLICATE_ID", "领域事件 ID 已存在", "生成新的事件 ID 后重试");
      }
      eventIds.add(event.eventId);
    }
    const next = [...current, ...appended];
    const aggregate = reduceOpcEvents(request.workspaceId, request.opportunityId, next);
    if (!aggregate) {
      throw new OpcDomainError("INVALID_INPUT", "事件未生成机会", "先提交机会捕获事件");
    }
    this.#streams.set(streamKey, next);
    if (idempotencyKey && request.idempotency) {
      this.#idempotency.set(idempotencyKey, {
        request: canonicalJson(request.idempotency.request),
        response: structuredClone(aggregate),
      });
    }
    return structuredClone(aggregate);
  }

  async events(workspaceId: string, opportunityId: string): Promise<readonly StoredOpcEvent[]> {
    return structuredClone(this.#streams.get(key(workspaceId, opportunityId)) ?? []);
  }
}

function key(workspaceId: string, opportunityId: string): string {
  return `${workspaceId.length}:${workspaceId}${opportunityId}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((name) => `${JSON.stringify(name)}:${canonicalJson(record[name])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
