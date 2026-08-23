// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  HttpMcpServerConfig,
  McpConnection,
  McpConnectionInput,
  McpTransportFactory,
  StdioMcpServerConfig
} from "./types.js";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function response(value: unknown, expectedId: number): JsonRpcResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP transport returned an invalid JSON-RPC response");
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || record.id !== expectedId
    || record.result === undefined && record.error === undefined) {
    throw new Error("MCP transport returned an invalid JSON-RPC response");
  }
  return record as unknown as JsonRpcResponse;
}

function validatedHttpUrl(input: string): URL {
  const url = new URL(input);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MCP Streamable HTTP requires HTTPS or loopback HTTP");
  }
  if (url.username || url.password || url.hash) throw new Error("MCP Streamable HTTP URL contains forbidden credentials or fragment");
  return url;
}

class StdioConnection implements McpConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout;
  }>();
  #nextId = 0;
  #buffer = Buffer.alloc(0);
  #closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    child.stderr.on("data", () => undefined);
    child.once("close", () => this.#failPending(new Error("MCP stdio connection closed")));
    child.once("error", () => this.#failPending(new Error("MCP stdio connection failed")));
  }

  static connect(config: StdioMcpServerConfig, environment: Readonly<Record<string, string>>): Promise<StdioConnection> {
    const child = spawn(config.command, [...config.args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env, ...environment }
    });
    const connection = new StdioConnection(child);
    return new Promise((resolvePromise, reject) => {
      const spawned = () => {
        child.off("error", failed);
        resolvePromise(connection);
      };
      const failed = () => {
        child.off("spawn", spawned);
        reject(new Error("MCP stdio server failed to start"));
      };
      child.once("spawn", spawned);
      child.once("error", failed);
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("MCP stdio connection is closed"));
    const id = ++this.#nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("MCP stdio request timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolvePromise, reject, timer });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error: unknown) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.#closed) throw new Error("MCP stdio connection is closed");
    this.#write({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending(new Error("MCP stdio connection closed"));
    this.#child.kill("SIGTERM");
  }

  #write(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new Error("MCP stdio request exceeds frame limit");
    this.#child.stdin.write(line, "utf8");
  }

  #receive(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.byteLength > MAX_FRAME_BYTES) {
      this.#closed = true;
      this.#child.kill("SIGTERM");
      this.#failPending(new Error("MCP stdio response exceeds frame limit"));
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line.toString("utf8"));
      } catch {
        this.#failPending(new Error("MCP stdio returned invalid JSON"));
        continue;
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const id = (value as Record<string, unknown>).id;
      if (typeof id !== "number") continue;
      const pending = this.#pending.get(id);
      if (!pending) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      try {
        const message = response(value, id);
        if (message.error !== undefined) pending.reject(new Error("MCP stdio request failed"));
        else pending.resolve(message.result);
      } catch (error: unknown) {
        pending.reject(error);
      }
    }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

class HttpConnection implements McpConnection {
  readonly #url: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #oauthToken?: string;
  #nextId = 0;
  #sessionId?: string;
  #closed = false;

  constructor(config: HttpMcpServerConfig, fetchImplementation: typeof globalThis.fetch, oauthToken?: string) {
    this.#url = validatedHttpUrl(config.url);
    this.#fetch = fetchImplementation;
    this.#oauthToken = oauthToken;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new Error("MCP HTTP connection is closed");
    const id = ++this.#nextId;
    const value = await this.#post({ jsonrpc: "2.0", id, method, params });
    const message = response(value, id);
    if (message.error !== undefined) throw new Error("MCP HTTP request failed");
    return message.result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.#closed) throw new Error("MCP HTTP connection is closed");
    await this.#post({ jsonrpc: "2.0", method, params }, true);
  }

  async close(): Promise<void> { this.#closed = true; }

  async #post(message: unknown, notification = false): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let reply: Response;
    try {
      reply = await this.#fetch(this.#url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.#oauthToken === undefined ? {} : { authorization: `Bearer ${this.#oauthToken}` }),
          ...(this.#sessionId === undefined ? {} : { "mcp-session-id": this.#sessionId })
        },
        body: JSON.stringify(message)
      });
    } finally {
      clearTimeout(timer);
    }
    if (reply.status < 200 || reply.status >= 300) throw new Error("MCP HTTP request failed");
    const sessionId = reply.headers.get("mcp-session-id");
    if (sessionId !== null) this.#sessionId = sessionId;
    if (notification && reply.status === 202) return {};
    const length = Number(reply.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_FRAME_BYTES) throw new Error("MCP HTTP response exceeds frame limit");
    const bytes = Buffer.from(await reply.arrayBuffer());
    if (bytes.byteLength > MAX_FRAME_BYTES) throw new Error("MCP HTTP response exceeds frame limit");
    const contentType = reply.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const data = bytes.toString("utf8").split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .find((line) => line.length > 0);
      if (data === undefined) throw new Error("MCP HTTP event stream has no response");
      return JSON.parse(data) as unknown;
    }
    return JSON.parse(bytes.toString("utf8")) as unknown;
  }
}

export class DefaultMcpTransportFactory implements McpTransportFactory {
  readonly #allowedStdioCommands: ReadonlySet<string>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: {
    readonly allowedStdioCommands: readonly string[];
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.#allowedStdioCommands = new Set(options.allowedStdioCommands);
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new Error("MCP HTTP transport requires fetch");
  }

  async connect(input: McpConnectionInput): Promise<McpConnection> {
    if (input.config.transport === "stdio") {
      if (!this.#allowedStdioCommands.has(input.config.command)) {
        throw new Error("MCP stdio command is not allowlisted");
      }
      return StdioConnection.connect(input.config, input.secretEnv);
    }
    return new HttpConnection(input.config, this.#fetch, input.oauthToken);
  }
}
