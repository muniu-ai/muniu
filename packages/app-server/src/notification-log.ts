// SPDX-License-Identifier: Apache-2.0

import type {
  ServerNotificationMethod,
  ServerNotificationParams
} from "@mn/app-server-protocol";
import { SERVER_NOTIFICATION_SCHEMAS } from "@mn/app-server-protocol";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

export interface PersistedNotification<M extends ServerNotificationMethod = ServerNotificationMethod> {
  method: M;
  params: ServerNotificationParams<M>;
}

export interface NotificationLog {
  append(notification: PersistedNotification): Promise<{ cursor: string }>;
  readAfter?(cursor?: string):
    | readonly { readonly cursor: string; readonly notification: PersistedNotification }[]
    | Promise<readonly { readonly cursor: string; readonly notification: PersistedNotification }[]>;
  subscribeAfter?(
    cursor: string | undefined,
    listener: (entry: { readonly cursor: string; readonly notification: PersistedNotification }) => void
  ): void | (() => void) | Promise<void | (() => void)>;
}

export class InMemoryNotificationLog implements NotificationLog {
  readonly #entries: Array<{ cursor: string; notification: PersistedNotification }> = [];
  readonly #subscribers = new Set<(entry: { cursor: string; notification: PersistedNotification }) => void>();

  async append(notification: PersistedNotification): Promise<{ cursor: string }> {
    const cursor = String(this.#entries.length + 1);
    const entry = { cursor, notification };
    this.#entries.push(entry);
    for (const subscriber of this.#subscribers) subscriber(entry);
    return { cursor };
  }

  readAfter(cursor?: string): ReadonlyArray<{ cursor: string; notification: PersistedNotification }> {
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    return this.#entries.slice(Number.isSafeInteger(offset) && offset >= 0 ? offset : 0);
  }

  subscribeAfter(
    cursor: string | undefined,
    listener: (entry: { readonly cursor: string; readonly notification: PersistedNotification }) => void
  ): () => void {
    if (cursor !== undefined) {
      for (const entry of this.readAfter(cursor)) listener(entry);
    }
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }
}

interface NotificationLogEntry {
  readonly cursor: string;
  readonly notification: PersistedNotification;
}

export class JsonlNotificationLog implements NotificationLog {
  readonly #filePath: string;
  readonly #entries: NotificationLogEntry[] = [];
  readonly #subscribers = new Set<(entry: NotificationLogEntry) => void>();
  readonly #ready: Promise<void>;
  #tail = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
    this.#ready = this.#load();
  }

  append(notification: PersistedNotification): Promise<{ cursor: string }> {
    const operation = this.#tail.then(async () => {
      await this.#ready;
      const parsed = parseNotification(notification);
      const entry = {
        cursor: String(this.#entries.length + 1),
        notification: parsed
      };
      const handle = await open(this.#filePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#entries.push(entry);
      for (const subscriber of this.#subscribers) subscriber(entry);
      return { cursor: entry.cursor };
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async readAfter(cursor?: string): Promise<readonly NotificationLogEntry[]> {
    await this.#tail;
    await this.#ready;
    const offset = parseCursor(cursor, this.#entries.length);
    return this.#entries.slice(offset);
  }

  async subscribeAfter(
    cursor: string | undefined,
    listener: (entry: NotificationLogEntry) => void
  ): Promise<() => void> {
    const operation = this.#tail.then(async () => {
      await this.#ready;
      const offset = parseCursor(cursor, this.#entries.length);
      for (const entry of this.#entries.slice(offset)) listener(entry);
      this.#subscribers.add(listener);
      return () => this.#subscribers.delete(listener);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #load(): Promise<void> {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error("Notification log directory is unsafe");
    }
    await chmod(directory, 0o700);
    let contents: string;
    let handle;
    try {
      handle = await open(this.#filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      contents = await handle.readFile("utf8");
      await handle.chmod(0o600);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    } finally {
      await handle?.close();
    }
    if (contents.length > 0 && !contents.endsWith("\n")) {
      throw new Error("Notification log has a torn final record");
    }
    const lines = contents.split("\n").filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      const value = JSON.parse(lines[index]!) as unknown;
      const entry = parseEntry(value, index + 1);
      this.#entries.push(entry);
    }
  }
}

function parseCursor(cursor: string | undefined, maximum: number): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9]\d*)$/u.test(cursor)) throw new TypeError("Notification cursor is invalid");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum) {
    throw new RangeError("Notification cursor is outside the retained log");
  }
  return offset;
}

function parseEntry(value: unknown, expectedCursor: number): NotificationLogEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Notification log entry must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.cursor !== String(expectedCursor)) {
    throw new Error("Notification log cursor sequence is invalid");
  }
  return {
    cursor: record.cursor,
    notification: parseNotification(record.notification)
  };
}

function parseNotification(value: unknown): PersistedNotification {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Notification must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.method !== "string" || !Object.hasOwn(SERVER_NOTIFICATION_SCHEMAS, record.method)) {
    throw new TypeError("Notification method is invalid");
  }
  const method = record.method as ServerNotificationMethod;
  return {
    method,
    params: SERVER_NOTIFICATION_SCHEMAS[method].parse(record.params)
  } as PersistedNotification;
}
