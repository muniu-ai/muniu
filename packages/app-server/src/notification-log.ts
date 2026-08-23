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
}

export class InMemoryNotificationLog implements NotificationLog {
  readonly #entries: Array<{ cursor: string; notification: PersistedNotification }> = [];

  async append(notification: PersistedNotification): Promise<{ cursor: string }> {
    const cursor = String(this.#entries.length + 1);
    this.#entries.push({ cursor, notification });
    return { cursor };
  }

  readAfter(cursor?: string): ReadonlyArray<{ cursor: string; notification: PersistedNotification }> {
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    return this.#entries.slice(Number.isSafeInteger(offset) && offset >= 0 ? offset : 0);
  }
}
