// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import type { InboxItem, JsonObject, RuntimeRecord, RuntimeStore } from "./types.js";

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

  async #pending(kind: InboxItem["kind"]): Promise<InboxItem[]> {
    const records = await this.store.readExecution(this.executionId);
    const consumed = new Set(
      records
        .filter((record) => record.type === "inbox/consumed")
        .map((record) => requiredString(record.payload, "itemId")),
    );
    return records
      .filter((record) => record.type === "inbox/enqueued")
      .map(parseInboxItem)
      .filter((item) => item.kind === kind && !consumed.has(item.id))
      .sort((left, right) => left.sequence - right.sequence);
  }

  async #consume(item: InboxItem): Promise<void> {
    await this.store.append({
      executionId: this.executionId,
      type: "inbox/consumed",
      payload: { itemId: item.id, kind: item.kind },
    });
  }
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
  };
}

function requiredString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`持久化字段 ${key} 无效`);
  return value;
}
