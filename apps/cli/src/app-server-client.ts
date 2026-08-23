// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  controlRequestForHttp,
  type MuniuControlParams,
  type MuniuMethod
} from "@mn/app-server-protocol";
import { MuniuClient, WebSocketRpcChannel, connectUnixSocket } from "@mn/sdk";

interface ConnectionDescriptor {
  readonly schemaVersion: 1;
  readonly url: string;
  readonly token: string;
}

let clientPromise: Promise<MuniuClient> | undefined;
let injectedControlTransport: ((request: {
  readonly method: MuniuMethod;
  readonly params: MuniuControlParams;
}) => Promise<unknown>) | undefined;

export function installCliControlTransportForTest(
  transport: (request: { readonly method: MuniuMethod; readonly params: MuniuControlParams }) => Promise<unknown>
): void {
  if (process.env.NODE_ENV !== "test") throw new Error("CLI control transport injection is test-only");
  injectedControlTransport = transport;
}

function connectionFilePath(): string {
  return path.resolve(
    process.env.MN_APP_SERVER_CONNECTION_FILE
      ?? path.join(process.env.MN_MNIU_ROOT ?? path.join(homedir(), ".muniu"), "app-server.json")
  );
}

function assertToken(token: string): string {
  if (!token || /[\r\n]/u.test(token)) throw new Error("App-server token is invalid");
  return token;
}

function assertUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "wss:") return parsed.toString();
  if (parsed.protocol !== "ws:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]" && parsed.hostname !== "localhost")) {
    throw new Error("Plaintext app-server connections must use loopback");
  }
  return parsed.toString();
}

async function readDescriptor(): Promise<ConnectionDescriptor> {
  const filePath = connectionFilePath();
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error(`App-server connection file is unsafe: ${filePath}`);
  }
  if (typeof process.geteuid === "function" && stats.uid !== process.geteuid()) {
    throw new Error(`App-server connection file owner is invalid: ${filePath}`);
  }
  const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  if (value.schemaVersion !== 1 || typeof value.url !== "string" || typeof value.token !== "string") {
    throw new Error(`App-server connection file is invalid: ${filePath}`);
  }
  return { schemaVersion: 1, url: assertUrl(value.url), token: assertToken(value.token) };
}

async function connectClient(): Promise<MuniuClient> {
  const socketPath = process.env.MN_APP_SERVER_SOCKET?.trim();
  const channel = socketPath
    ? await connectUnixSocket(path.resolve(socketPath))
    : await (async () => {
        const configuredUrl = process.env.MN_APP_SERVER_URL?.trim();
        const descriptor = configuredUrl
          ? { url: assertUrl(configuredUrl), token: assertToken(process.env.MN_APP_SERVER_TOKEN ?? "") }
          : await readDescriptor();
        return WebSocketRpcChannel.connect(descriptor.url, descriptor.token);
      })();
  const client = new MuniuClient({
    channel,
    clientInfo: { name: "mn-cli", version: "0.2.0" },
    approvalHandler: async () => ({ decision: "decline" })
  });
  await client.connect();
  return client;
}

export function cliAppServerClient(): Promise<MuniuClient> {
  clientPromise ??= connectClient().catch((error: unknown) => {
    clientPromise = undefined;
    throw error;
  });
  return clientPromise;
}

export async function requestControlJson<T>(
  requestPath: string,
  options: {
    readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly body?: unknown;
    readonly idempotencyKey?: string;
  } = {}
): Promise<T> {
  const request = controlRequestForHttp(
    options.method ?? "GET",
    requestPath,
    options.body,
    options.idempotencyKey
  );
  if (injectedControlTransport) return await injectedControlTransport(request) as T;
  const client = await cliAppServerClient();
  return await client.callControl(request.method, request.params) as T;
}

export async function closeCliAppServerClient(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  if (pending) await (await pending).close();
}
