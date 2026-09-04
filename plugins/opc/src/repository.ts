import { OpcDomainError } from "./errors.js";
import type { OpcEvent, StoredOpcEvent } from "./events.js";
import type { OpportunityAggregate } from "./model.js";
import { reduceOpcEvents } from "./reducer.js";

export interface OpcAppendRequest {
  readonly workspaceId: string;
  readonly opportunityId: string;
  readonly expectedStreamVersion: number;
  readonly events: readonly OpcEvent[];
}

export interface OpcRepository {
  load(workspaceId: string, opportunityId: string): Promise<OpportunityAggregate | undefined>;
  append(request: OpcAppendRequest): Promise<OpportunityAggregate>;
  events(workspaceId: string, opportunityId: string): Promise<readonly StoredOpcEvent[]>;
}

export class InMemoryOpcRepository implements OpcRepository {
  readonly #streams = new Map<string, StoredOpcEvent[]>();
  #fallbackEventId = 0;

  async load(workspaceId: string, opportunityId: string): Promise<OpportunityAggregate | undefined> {
    const aggregate = reduceOpcEvents(workspaceId, opportunityId, this.#streams.get(key(workspaceId, opportunityId)) ?? []);
    return aggregate ? structuredClone(aggregate) : undefined;
  }

  async append(request: OpcAppendRequest): Promise<OpportunityAggregate> {
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
    return structuredClone(aggregate);
  }

  async events(workspaceId: string, opportunityId: string): Promise<readonly StoredOpcEvent[]> {
    return structuredClone(this.#streams.get(key(workspaceId, opportunityId)) ?? []);
  }
}

function key(workspaceId: string, opportunityId: string): string {
  return `${workspaceId.length}:${workspaceId}${opportunityId}`;
}
