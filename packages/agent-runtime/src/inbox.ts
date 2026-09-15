// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import type { InboxItem, JsonObject, RuntimeRecord, RuntimeRecordInput, RuntimeStore } from "./types.js";

export class PersistentInbox {
  constructor(
    private readonly store: RuntimeStore,
    private readonly executionId: string,
  ) {}

  async enqueue(kind: InboxItem["kind"], text: string): Promise<InboxItem> {
    if (text.trim().length === 0) throw new Error("消息不能为空");
    const id = `${kind}-${randomUUID()}`;
    const record = await this.store.append({
      executionId: this.executionId,
      type: "inbox/enqueued",
      payload: { id, kind, text },
    });
    return { id, sequence: record.sequence, kind, text };
  }

  async enqueueInitial(text: string): Promise<void> {
    if (!text.trim()) throw new Error("首次输入不能为空");
    for (;;) {
      const records = await this.store.readExecution(this.executionId);
      const existing = records.find(record => record.type === "inbox/enqueued" && record.payload.initial === true);
      if (existing) {
        if (existing.payload.text !== text) throw new Error("首次输入已固定，不能替换");
        return;
      }
      if (records.some(record => record.type === "turn/started")) return;
      if (await this.store.commit(this.executionId, records.at(-1)?.sequence ?? 0, [{
        executionId: this.executionId, type: "inbox/enqueued",
        payload: { id: `${this.executionId}:initial`, kind: "follow_up", text, initial: true },
      }])) return;
    }
  }

  async takeFollowUp(): Promise<(InboxItem & { readonly kind: "follow_up" | "resume" }) | undefined> {
    const item = (await this.#pending("resume"))[0] ?? (await this.#pending("follow_up"))[0];
    if (item === undefined) return undefined;
    await this.#consume(item);
    return item as InboxItem & { readonly kind: "follow_up" | "resume" };
  }

  async takeSteersAtModelBoundary(): Promise<readonly InboxItem[]> {
    const items = await this.#pending("steer");
    for (const item of items) await this.#consume(item);
    return items;
  }

  async hasFollowUps(): Promise<boolean> {
    return (await this.#pending("resume")).length > 0 || (await this.#pending("follow_up")).length > 0;
  }

  async hasResume(): Promise<boolean> { return (await this.#pending("resume")).length > 0; }

  async hasSteers(): Promise<boolean> { return (await this.#pending("steer")).length > 0; }

  async beginTurn(generation: number): Promise<{ readonly item: InboxItem & { readonly kind: "follow_up" | "resume" }; readonly turn: number } | undefined> {
    for (;;) {
      const records = await this.store.readExecution(this.executionId);
      const item = pendingItems(records, "resume")[0] ?? pendingItems(records, "follow_up")[0];
      if (!item) return undefined;
      const turn = records.filter(record => record.type === "turn/started").length + 1;
      const committed = await this.store.commit(this.executionId, records.at(-1)?.sequence ?? 0, [
        { executionId: this.executionId, type: "inbox/consumed", payload: { itemId: item.id, kind: item.kind } },
        { executionId: this.executionId, type: "turn/started", payload: { turn, generation, itemId: item.id } },
        { executionId: this.executionId, type: "session/entry", payload: {
          role: item.kind === "resume" ? "system" : "user",
          content: item.kind === "resume" ? `[resume] ${item.text}` : item.text, turn, modelVisible: true,
        } },
      ]);
      if (committed) return { item: item as InboxItem & { readonly kind: "follow_up" | "resume" }, turn };
    }
  }

  async completeIfEmpty(): Promise<"completed" | "paused" | undefined> {
    const records = await this.store.readExecution(this.executionId);
    if (pendingItems(records, "resume").length || pendingItems(records, "follow_up").length) return undefined;
    const status = [...records].reverse().find(record => record.type === "execution/status")?.payload.status;
    if (status !== "running") return status === "completed" || status === "paused" ? status : undefined;
    const next = pendingItems(records, "steer").length ? "paused" : "completed";
    const committed = await this.store.commit(this.executionId, records.at(-1)?.sequence ?? 0, [{
      executionId: this.executionId, type: "execution/status",
      payload: { previous: "running", status: next, reason: next === "paused"
        ? "本轮已结束，调整方向尚未应用；请恢复执行或取消" : "收件箱已处理完成" },
    }]);
    return committed ? next : undefined;
  }

  async applySteersAtModelBoundary(turn: number): Promise<void> {
    for (;;) {
      const records = await this.store.readExecution(this.executionId);
      const items = pendingItems(records, "steer");
      if (!items.length) return;
      const committed = await this.store.commit(this.executionId, records.at(-1)?.sequence ?? 0,
        items.flatMap((item): RuntimeRecordInput[] => [
          { executionId: this.executionId, type: "inbox/consumed" as const, payload: { itemId: item.id, kind: item.kind } },
          { executionId: this.executionId, type: "session/entry" as const, payload: { role: "system", content: `[steer] ${item.text}`, turn, modelVisible: true } },
        ]));
      if (committed) return;
    }
  }

  async #pending(kind: InboxItem["kind"]): Promise<InboxItem[]> {
    const records = await this.store.readExecution(this.executionId);
    return pendingItems(records, kind);
  }

  async #consume(item: InboxItem): Promise<void> {
    await this.store.append({
      executionId: this.executionId,
      type: "inbox/consumed",
      payload: { itemId: item.id, kind: item.kind },
    });
  }
}

function pendingItems(records: readonly RuntimeRecord[], kind: InboxItem["kind"]): InboxItem[] {
  const consumed = new Set(records.filter(record => record.type === "inbox/consumed")
    .map(record => requiredString(record.payload, "itemId")));
  return records.filter(record => record.type === "inbox/enqueued").map(parseInboxItem)
    .filter(item => item.kind === kind && !consumed.has(item.id))
    .sort((left, right) => Number(right.initial === true) - Number(left.initial === true) || left.sequence - right.sequence);
}

function parseInboxItem(record: RuntimeRecord): InboxItem {
  const kind = requiredString(record.payload, "kind");
  if (kind !== "follow_up" && kind !== "steer" && kind !== "resume") {
    throw new Error("Inbox 记录类型无效");
  }
  return {
    id: requiredString(record.payload, "id"),
    sequence: record.sequence,
    kind,
    text: requiredString(record.payload, "text"),
    ...(record.payload.initial === true ? { initial: true } : {}),
  };
}

function requiredString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`持久化字段 ${key} 无效`);
  return value;
}
