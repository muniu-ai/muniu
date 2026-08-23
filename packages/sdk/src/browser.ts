// SPDX-License-Identifier: Apache-2.0

import type { JsonRpcMessage } from "@mn/app-server-protocol";

import type { RpcChannel } from "./channel.js";
export { MuniuClient, ThreadHandle, ControlService } from "./client.js";
export type { MuniuClientOptions } from "./client.js";
export type { RpcChannel } from "./channel.js";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface BrowserSocketEvent {
  readonly data?: unknown;
}

interface BrowserSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "error" | "message" | "close",
    listener: (event: BrowserSocketEvent) => void,
    options?: { readonly once?: boolean }
  ): void;
}

export type BrowserSocketFactory = (url: string, protocols: readonly string[]) => BrowserSocket;

class BrowserSubscriptionHub {
  readonly #listeners = new Set<(message: unknown) => void>();

  subscribe(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(message: unknown): void {
    for (const listener of this.#listeners) listener(message);
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function defaultSocketFactory(url: string, protocols: readonly string[]): BrowserSocket {
  const constructor = (globalThis as unknown as {
    WebSocket?: new (url: string, protocols?: string | string[]) => BrowserSocket;
  }).WebSocket;
  if (!constructor) throw new Error("Browser WebSocket is unavailable");
  return new constructor(url, [...protocols]);
}

export class BrowserWebSocketRpcChannel implements RpcChannel {
  readonly #socket: BrowserSocket;
  readonly #hub = new BrowserSubscriptionHub();
  #closed = false;

  private constructor(socket: BrowserSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (this.#closed || typeof event.data !== "string") {
        socket.close(1003, "Text frames required");
        return;
      }
      if (byteLength(event.data) > MAX_FRAME_BYTES) {
        socket.close(1009, "Frame too large");
        return;
      }
      try {
        this.#hub.publish(JSON.parse(event.data) as unknown);
      } catch {
        socket.close(1007, "Invalid JSON");
      }
    });
    socket.addEventListener("close", () => { this.#closed = true; });
    socket.addEventListener("error", () => { this.#closed = true; });
  }

  static async connect(options: {
    readonly url: string;
    readonly token?: string;
    readonly socketFactory?: BrowserSocketFactory;
  }): Promise<BrowserWebSocketRpcChannel> {
    const protocols = [
      "muniu.v2",
      ...(options.token === undefined ? [] : [`muniu.bearer.${options.token}`])
    ];
    const socket = (options.socketFactory ?? defaultSocketFactory)(options.url, protocols);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
    });
    return new BrowserWebSocketRpcChannel(socket);
  }

  subscribe(listener: (message: unknown) => void): () => void {
    return this.#hub.subscribe(listener);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#closed || this.#socket.readyState !== 1) throw new Error("RPC channel is closed");
    const text = JSON.stringify(message);
    if (byteLength(text) > MAX_FRAME_BYTES) throw new RangeError("RPC frame exceeds 16 MiB");
    this.#socket.send(text);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close();
  }
}
