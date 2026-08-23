// SPDX-License-Identifier: Apache-2.0

import type { JsonRpcMessage } from "@mn/app-server-protocol";

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_PENDING_MESSAGES = 1_024;
export const MAX_PENDING_BYTES = 16 * 1024 * 1024;

export interface QueueCloseReason {
  reason: "backpressure" | "frameTooLarge" | "transportError" | "closed";
  cursor?: string;
}

interface QueueEntry {
  message: JsonRpcMessage;
  bytes: number;
  cursor?: string;
}

export interface OutboundQueueOptions {
  write(message: JsonRpcMessage): Promise<void>;
  close(reason: QueueCloseReason): void;
  maxFrameBytes?: number;
  maxPendingMessages?: number;
  maxPendingBytes?: number;
}

export class BoundedOutboundQueue {
  readonly #entries: QueueEntry[] = [];
  readonly #write: OutboundQueueOptions["write"];
  readonly #closeTransport: OutboundQueueOptions["close"];
  readonly #maxFrameBytes: number;
  readonly #maxPendingMessages: number;
  readonly #maxPendingBytes: number;
  readonly #idleWaiters = new Set<() => void>();
  #pendingMessages = 0;
  #pendingBytes = 0;
  #draining = false;
  #closed = false;
  #lastDeliveredCursor: string | undefined;

  constructor(options: OutboundQueueOptions) {
    this.#write = options.write;
    this.#closeTransport = options.close;
    this.#maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.#maxPendingMessages = options.maxPendingMessages ?? MAX_PENDING_MESSAGES;
    this.#maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_BYTES;
  }

  enqueue(message: JsonRpcMessage, cursor?: string): boolean {
    if (this.#closed) return false;
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (bytes > this.#maxFrameBytes) {
      this.#shutdown({ reason: "frameTooLarge", cursor: this.#lastDeliveredCursor });
      return false;
    }
    if (
      this.#pendingMessages + 1 > this.#maxPendingMessages ||
      this.#pendingBytes + bytes > this.#maxPendingBytes
    ) {
      this.#shutdown({ reason: "backpressure", cursor: this.#lastDeliveredCursor });
      return false;
    }
    this.#entries.push({ message, bytes, cursor });
    this.#pendingMessages += 1;
    this.#pendingBytes += bytes;
    void this.#drain();
    return true;
  }

  close(): void {
    this.#shutdown({ reason: "closed", cursor: this.#lastDeliveredCursor });
  }

  async idle(): Promise<void> {
    if (this.#pendingMessages === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  async #drain(): Promise<void> {
    if (this.#draining || this.#closed) return;
    this.#draining = true;
    while (!this.#closed) {
      const entry = this.#entries.shift();
      if (!entry) break;
      try {
        await this.#write(entry.message);
        if (entry.cursor !== undefined) this.#lastDeliveredCursor = entry.cursor;
      } catch {
        this.#shutdown({ reason: "transportError", cursor: this.#lastDeliveredCursor });
        break;
      } finally {
        this.#pendingMessages = Math.max(0, this.#pendingMessages - 1);
        this.#pendingBytes = Math.max(0, this.#pendingBytes - entry.bytes);
        if (this.#pendingMessages === 0) this.#resolveIdle();
      }
    }
    this.#draining = false;
  }

  #shutdown(reason: QueueCloseReason): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#entries.length = 0;
    this.#pendingMessages = 0;
    this.#pendingBytes = 0;
    this.#resolveIdle();
    this.#closeTransport(reason);
  }

  #resolveIdle(): void {
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
