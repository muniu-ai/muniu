// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserSocketFactory } from "../src/browser.js";
import { BrowserWebSocketRpcChannel } from "../src/browser.js";

class FakeBrowserSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test("browser channel authenticates with a WebSocket subprotocol and exchanges JSON-RPC", async () => {
  const socket = new FakeBrowserSocket();
  let protocols: readonly string[] = [];
  const factory: BrowserSocketFactory = (_url, requested) => {
    protocols = requested;
    queueMicrotask(() => {
      socket.readyState = 1;
      socket.emit("open");
    });
    return socket;
  };
  const channel = await BrowserWebSocketRpcChannel.connect({
    url: "ws://127.0.0.1:7320",
    token: "a".repeat(32),
    socketFactory: factory
  });
  assert.deepEqual(protocols, ["muniu.v2", `muniu.bearer.${"a".repeat(32)}`]);
  const received: unknown[] = [];
  channel.subscribe((message) => received.push(message));
  socket.emit("message", { data: '{"id":1,"result":{}}' });
  await channel.send({ id: 2, method: "thread/list", params: {} });
  assert.deepEqual(received, [{ id: 1, result: {} }]);
  assert.deepEqual(socket.sent, ['{"id":2,"method":"thread/list","params":{}}']);
  channel.close();
});
