// SPDX-License-Identifier: Apache-2.0

import net from "node:net";
import type { Readable, Writable } from "node:stream";

import type { JsonRpcMessage } from "@mn/app-server-protocol";
import WebSocket from "ws";

import type { RpcChannel } from "./channel.js";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

class SubscriptionHub {
  readonly #listeners = new Set<(message: unknown) => void>();

  subscribe(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(message: unknown): void {
    for (const listener of this.#listeners) listener(message);
  }
}

export class JsonlRpcChannel implements RpcChannel {
  readonly #readable: Readable;
  readonly #writable: Writable;
  readonly #hub = new SubscriptionHub();
  #buffer = Buffer.alloc(0);
  #closed = false;

  constructor(readable: Readable, writable: Writable) {
    this.#readable = readable;
    this.#writable = writable;
    readable.on("data", (chunk: Buffer | string) => this.#consume(chunk));
    readable.once("close", () => { this.#closed = true; });
    readable.once("error", () => { this.#closed = true; });
  }

  subscribe(listener: (message: unknown) => void): () => void {
    return this.#hub.subscribe(listener);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#closed) throw new Error("RPC channel is closed");
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) throw new RangeError("RPC frame exceeds 16 MiB");
    await new Promise<void>((resolve, reject) => this.#writable.write(frame, (error) => error ? reject(error) : resolve()));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#readable.destroy();
    this.#writable.destroy();
  }

  #consume(chunk: Buffer | string): void {
    if (this.#closed) return;
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.#buffer = Buffer.concat([this.#buffer, incoming]);
    if (this.#buffer.byteLength > MAX_FRAME_BYTES) {
      this.close();
      return;
    }
    let newline = this.#buffer.indexOf(0x0a);
    while (newline >= 0) {
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (frame.byteLength > 0) this.#hub.publish(JSON.parse(frame.toString("utf8")));
      newline = this.#buffer.indexOf(0x0a);
    }
  }
}

export async function connectUnixSocket(socketPath: string): Promise<JsonlRpcChannel> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return new JsonlRpcChannel(socket, socket);
}

export class WebSocketRpcChannel implements RpcChannel {
  readonly #socket: WebSocket;
  readonly #hub = new SubscriptionHub();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Text frames required");
        return;
      }
      const text = data.toString();
      if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
        socket.close(1009, "Frame too large");
        return;
      }
      this.#hub.publish(JSON.parse(text));
    });
  }

  static async connect(url: string, token?: string): Promise<WebSocketRpcChannel> {
    const socket = new WebSocket(url, {
      ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
      maxPayload: MAX_FRAME_BYTES
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new WebSocketRpcChannel(socket);
  }

  subscribe(listener: (message: unknown) => void): () => void {
    return this.#hub.subscribe(listener);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) throw new RangeError("RPC frame exceeds 16 MiB");
    await new Promise<void>((resolve, reject) => this.#socket.send(text, (error) => error ? reject(error) : resolve()));
  }

  close(): void {
    this.#socket.close();
  }
}
