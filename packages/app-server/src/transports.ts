// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual, randomBytes } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import type { Readable, Writable } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import {
  AppServerConnection,
  type AppServerConnectionOptions
} from "./connection.js";
import { FrameTooLargeError, JsonlFrameDecoder, encodeJsonLine } from "./framing.js";
import { MAX_FRAME_BYTES } from "./outbound-queue.js";

export interface TransportConnection {
  receiveText(text: string): Promise<void>;
  closed(reason?: Error): void;
}

export interface TransportPeer {
  send(value: unknown): Promise<void>;
  close(): void;
}

export type TransportConnectionFactory = (peer: TransportPeer) => TransportConnection;

export function createAppServerConnectionFactory(
  options: Omit<AppServerConnectionOptions, "write" | "close">
): TransportConnectionFactory {
  return (peer) => {
    const connection = new AppServerConnection({
      ...options,
      write: (message) => peer.send(message),
      close: () => peer.close()
    });
    return {
      receiveText: (text) => connection.receiveText(text),
      closed: () => connection.close()
    };
  };
}

function writeStream(stream: Writable, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (error) => error ? reject(error) : resolve());
  });
}

export function connectJsonlStreams(options: {
  readable: Readable;
  writable: Writable;
  createConnection: TransportConnectionFactory;
  closeStreams?: boolean;
}): { close(): void } {
  const decoder = new JsonlFrameDecoder();
  let chain = Promise.resolve();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (options.closeStreams) {
      options.readable.destroy();
      options.writable.destroy();
    }
  };
  const connection = options.createConnection({
    send: (value) => writeStream(options.writable, encodeJsonLine(value)),
    close
  });
  options.readable.on("data", (chunk: Buffer | string) => {
    if (closed) return;
    try {
      for (const frame of decoder.push(chunk)) {
        chain = chain.then(() => connection.receiveText(frame)).catch((error: unknown) => {
          connection.closed(error instanceof Error ? error : new Error(String(error)));
          close();
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      connection.closed(reason);
      close();
    }
  });
  options.readable.once("end", () => {
    void chain.finally(() => connection.closed());
  });
  options.readable.once("error", (error) => connection.closed(error));
  return { close };
}

export function connectStdio(options: {
  createConnection: TransportConnectionFactory;
  stdin?: Readable;
  stdout?: Writable;
}): { close(): void } {
  return connectJsonlStreams({
    readable: options.stdin ?? process.stdin,
    writable: options.stdout ?? process.stdout,
    createConnection: options.createConnection,
    closeStreams: false
  });
}

export async function createUnixSocketServer(options: {
  socketPath: string;
  createConnection: TransportConnectionFactory;
}): Promise<{ socketPath: string; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    connectJsonlStreams({
      readable: socket,
      writable: socket,
      createConnection: options.createConnection,
      closeStreams: true
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(options.socketPath, 0o600);
  return {
    socketPath: options.socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function protocolBearerMatches(header: string | undefined, token: string): boolean {
  const supplied = header?.split(",").map((value) => value.trim())
    .find((value) => value.startsWith("muniu.bearer."))
    ?.slice("muniu.bearer.".length);
  if (supplied === undefined) return false;
  return bearerMatches(`Bearer ${supplied}`, token);
}

function websocketSend(socket: WebSocket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, "utf8") > MAX_FRAME_BYTES) {
      reject(new FrameTooLargeError(MAX_FRAME_BYTES));
      return;
    }
    socket.send(json, (error) => error ? reject(error) : resolve());
  });
}

export async function createLocalWebSocketServer(options: {
  host: string;
  port: number;
  token?: string;
  createConnection: TransportConnectionFactory;
}): Promise<{ url: string; token: string; close(): Promise<void> }> {
  if (!isLoopbackHost(options.host)) throw new Error("Local WebSocket host must be loopback-only");
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{32,512}$/u.test(token)) {
    throw new Error("Local WebSocket bearer token must be 32-512 base64url characters");
  }
  const httpServer = http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const clients = new Set<WebSocket>();
  httpServer.on("upgrade", (request, socket, head) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)
      || (!bearerMatches(request.headers.authorization, token)
        && !protocolBearerMatches(request.headers["sec-websocket-protocol"], token))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });
  websocketServer.on("connection", (socket) => {
    clients.add(socket);
    let chain = Promise.resolve();
    const connection = options.createConnection({
      send: (value) => websocketSend(socket, value),
      close: () => socket.close()
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Text frames required");
        return;
      }
      chain = chain.then(() => connection.receiveText(data.toString())).catch((error: unknown) => {
        connection.closed(error instanceof Error ? error : new Error(String(error)));
        socket.close(1011, "Request failed");
      });
    });
    socket.once("error", (error) => connection.closed(error));
    socket.once("close", () => {
      clients.delete(socket);
      void chain.finally(() => connection.closed());
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  const formattedHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `ws://${formattedHost}:${address.port}`,
    token,
    close: async () => {
      for (const client of clients) client.terminate();
      websocketServer.close();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  };
}
