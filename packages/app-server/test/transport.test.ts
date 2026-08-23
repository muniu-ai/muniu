// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { WebSocket } from "ws";
import { CLIENT_METHODS, type JsonRpcMessage } from "@mn/app-server-protocol";

import {
  InMemoryNotificationLog,
  FrameTooLargeError,
  JsonlFrameDecoder,
  connectStdio,
  createAppServerConnectionFactory,
  createLocalWebSocketServer,
  createUnixSocketServer,
  type AppServerHandlers
} from "../src/index.js";

function noOpHandlers(): AppServerHandlers {
  return Object.fromEntries(
    CLIENT_METHODS
      .filter((method) => method !== "initialize")
      .map((method) => [method, async () => ({})])
  ) as unknown as AppServerHandlers;
}

test("decodes fragmented JSONL and rejects frames over 16 MiB", () => {
  const decoder = new JsonlFrameDecoder();
  assert.deepEqual(decoder.push('{"id":1'), []);
  assert.deepEqual(decoder.push('}\n{"id":2}\r\n'), ['{"id":1}', '{"id":2}']);
  assert.throws(() => decoder.push("x".repeat(16 * 1024 * 1024 + 1)), FrameTooLargeError);
});

test("runs the initialize transcript over stdio JSONL", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = "";
  const response = new Promise<JsonRpcMessage>((resolve) => {
    output.on("data", (chunk: Buffer) => {
      captured += chunk.toString("utf8");
      const newline = captured.indexOf("\n");
      if (newline !== -1) resolve(JSON.parse(captured.slice(0, newline)) as JsonRpcMessage);
    });
  });
  const transport = connectStdio({
    stdin: input,
    stdout: output,
    createConnection: createAppServerConnectionFactory({
      serverInfo: { name: "muniu", version: "0.2.0" },
      instructionSources: [],
      handlers: noOpHandlers(),
      notificationLog: new InMemoryNotificationLog()
    })
  });

  input.write('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"0.2.0"}}}\n');
  const message = await response;
  transport.close();

  const result = "result" in message && message.result !== null && !Array.isArray(message.result)
    && typeof message.result === "object" ? message.result : undefined;
  assert.equal(result?.protocolVersion, "2");
});

test("creates Unix sockets with owner-only permissions", async (t) => {
  if (process.platform === "win32") return t.skip("Unix sockets are unavailable on Windows");
  const directory = await mkdtemp(path.join(os.tmpdir(), "muniu-app-server-"));
  const socketPath = path.join(directory, "app-server.sock");
  const server = await createUnixSocketServer({
    socketPath,
    createConnection: ({ send }) => ({
      receiveText: async (text) => send(JSON.parse(text)),
      closed: () => undefined
    })
  });
  t.after(async () => server.close());

  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  const reply = await new Promise<string>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.once("error", reject);
    client.once("data", (data) => resolve(data.toString("utf8")));
    client.write('{"id":1}\n');
  });
  assert.equal(reply, '{"id":1}\n');
});

test("requires a bearer token on a loopback-only WebSocket listener", async (t) => {
  const server = await createLocalWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    createConnection: ({ send }) => ({
      receiveText: async (text) => send(JSON.parse(text)),
      closed: () => undefined
    })
  });
  t.after(async () => server.close());

  await assert.rejects(
    () => new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(server.url);
      socket.once("open", () => resolve());
      socket.once("error", reject);
    })
  );
  const echoed = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(server.url, {
      headers: { authorization: `Bearer ${server.token}` }
    });
    socket.once("error", reject);
    socket.once("open", () => socket.send('{"id":1}'));
    socket.once("message", (data) => resolve(data.toString()));
  });
  assert.equal(echoed, '{"id":1}');

  await assert.rejects(() => createLocalWebSocketServer({
    host: "0.0.0.0",
    port: 0,
    createConnection: () => ({ receiveText: async () => undefined, closed: () => undefined })
  }), /loopback/u);
});
