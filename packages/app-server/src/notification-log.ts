// SPDX-License-Identifier: Apache-2.0

import type {
  ServerNotificationMethod,
  ServerNotificationParams
} from "@mn/app-server-protocol";

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
