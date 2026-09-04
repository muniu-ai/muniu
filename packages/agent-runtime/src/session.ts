// SPDX-License-Identifier: Apache-2.0

import type {
  JsonObject,
  ModelMessage,
  RuntimeRecord,
  RuntimeStore,
  SessionCompaction,
  SessionLogEntry,
  SessionLogEntryInput,
  SessionLogSnapshot,
  SessionSurface,
} from "./types.js";

export class DefaultSessionSurface implements SessionSurface {
  constructor(private readonly maxEntries = Number.POSITIVE_INFINITY) {
    if (maxEntries <= 0) throw new Error("Surface 条目上限必须大于 0");
  }

  project(snapshot: SessionLogSnapshot): readonly ModelMessage[] {
    const compaction = snapshot.compactions.at(-1);
    const visibleEntries = snapshot.entries.filter(
      (entry) => entry.modelVisible && (compaction === undefined || entry.sequence > compaction.throughSequence),
    );
    const projected: ModelMessage[] = [
      ...(compaction === undefined ? [] : [{ role: "system" as const, content: compaction.summary }]),
      ...visibleEntries.map(toModelMessage),
    ];
    return projected.slice(-this.maxEntries);
  }
}

export class PersistentSessionLog {
  constructor(
    private readonly store: RuntimeStore,
    private readonly executionId: string,
  ) {}

  async append(input: SessionLogEntryInput): Promise<SessionLogEntry> {
    if (input.content.length === 0) throw new Error("Session Log 内容不能为空");
    const payload: JsonObject = {
      role: input.role,
      content: input.content,
      turn: input.turn,
      modelVisible: input.modelVisible ?? true,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    };
    const record = await this.store.append({
      executionId: this.executionId,
      type: "session/entry",
      payload,
    });
    return parseEntry(record);
  }

  async compact(input: { readonly throughSequence: number; readonly summary: string }): Promise<SessionCompaction> {
    if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 1) {
      throw new Error("Compaction 截止序号无效");
    }
    if (input.summary.length === 0) throw new Error("Compaction 摘要不能为空");
    const entries = await this.entries();
    if (!entries.some((entry) => entry.sequence === input.throughSequence)) {
      throw new Error("Compaction 只能引用 Session Log 条目");
    }
    const record = await this.store.append({
      executionId: this.executionId,
      type: "session/compaction",
      payload: { throughSequence: input.throughSequence, summary: input.summary },
    });
    return parseCompaction(record);
  }

  async entries(): Promise<readonly SessionLogEntry[]> {
    return (await this.store.readExecution(this.executionId))
      .filter((record) => record.type === "session/entry")
      .map(parseEntry);
  }

  async snapshot(): Promise<SessionLogSnapshot> {
    const records = await this.store.readExecution(this.executionId);
    return {
      entries: records.filter((record) => record.type === "session/entry").map(parseEntry),
      compactions: records.filter((record) => record.type === "session/compaction").map(parseCompaction),
    };
  }

  async modelView(surface: SessionSurface): Promise<readonly ModelMessage[]> {
    return surface.project(await this.snapshot());
  }
}

function parseEntry(record: RuntimeRecord): SessionLogEntry {
  const role = requiredString(record.payload, "role");
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    throw new Error("Session Log 角色无效");
  }
  const turn = record.payload.turn;
  const modelVisible = record.payload.modelVisible;
  if (!Number.isSafeInteger(turn) || typeof modelVisible !== "boolean") {
    throw new Error("Session Log 记录无效");
  }
  const name = optionalString(record.payload, "name");
  const toolCallId = optionalString(record.payload, "toolCallId");
  return {
    id: record.id,
    sequence: record.sequence,
    role,
    content: requiredString(record.payload, "content"),
    turn: turn as number,
    modelVisible,
    ...(name === undefined ? {} : { name }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

function parseCompaction(record: RuntimeRecord): SessionCompaction {
  const throughSequence = record.payload.throughSequence;
  if (!Number.isSafeInteger(throughSequence)) throw new Error("Compaction 记录无效");
  return {
    sequence: record.sequence,
    throughSequence: throughSequence as number,
    summary: requiredString(record.payload, "summary"),
  };
}

function toModelMessage(entry: SessionLogEntry): ModelMessage {
  return {
    role: entry.role,
    content: entry.content,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
  };
}

function requiredString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`持久化字段 ${key} 无效`);
  return value;
}

function optionalString(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`持久化字段 ${key} 无效`);
  return value;
}
