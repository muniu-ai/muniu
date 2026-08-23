// SPDX-License-Identifier: Apache-2.0

import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { ThreadManager, type TurnExecutionResult } from "@mn/agent-kernel";
import { JsonlAgentEventV3Store, type AgentEventV3Store } from "@mn/agent-session";
import {
  AppServerConnection,
  JsonlNotificationLog,
  RpcFault,
  createCoreAppServerHandlers,
  createLocalWebSocketServer,
  createMuniuControlHandler,
  connectStdio,
  createUnixSocketServer,
  type ControlOperationDispatcher,
  type TransportConnection,
  type TransportConnectionFactory
} from "@mn/app-server";
import type { JsonValue } from "@mn/app-server-protocol";
import type { FastifyInstance } from "fastify";

export interface LocalAppServerExecutionInput {
  readonly threadId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly input: readonly {
    readonly type: string;
    readonly text?: string;
    readonly path?: string;
    readonly url?: string;
    readonly name?: string;
  }[];
  readonly outputSchema?: JsonValue;
  readonly signal: AbortSignal;
}

export interface LocalAppServerRuntimeOptions {
  readonly app: FastifyInstance;
  readonly rootDir: string;
  readonly host: string;
  readonly port: number;
  readonly token?: string;
  readonly connectionFile?: string;
  readonly execute: (input: LocalAppServerExecutionInput) => Promise<{
    readonly status: TurnExecutionResult["status"];
    readonly summary: string;
    readonly tokenUsage?: TurnExecutionResult["tokenUsage"];
    readonly structuredOutput?: JsonValue;
    readonly attachments?: readonly {
      readonly name: string;
      readonly mimeType: string;
      readonly uri: string;
      readonly digest: string;
    }[];
  }>;
  readonly onInternalError?: (error: unknown, method: string) => void;
  readonly controlDispatcher?: ControlOperationDispatcher;
}

export type EmbeddedAppServerRuntimeOptions = Omit<
  LocalAppServerRuntimeOptions,
  "host" | "port" | "token" | "connectionFile"
>;

export interface PreparedFastifyControlInvocation {
  readonly headers?: Readonly<Record<string, string>>;
  release(): void | Promise<void>;
}

export function createFastifyControlDispatcher(
  app: FastifyInstance,
  options: {
    readonly prepare?: () => PreparedFastifyControlInvocation | Promise<PreparedFastifyControlInvocation>;
  } = {}
): ControlOperationDispatcher {
  return {
    async invoke(invocation) {
      const method = invocation.verb.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      const hasBody = invocation.params.body !== undefined;
      const prepared = await options.prepare?.();
      let response;
      try {
        response = await app.inject({
          method,
          url: requestUrl(invocation.pathTemplate, invocation.params.path, invocation.params.query),
          ...(hasBody ? { payload: JSON.stringify(invocation.params.body) } : {}),
          headers: {
            ...prepared?.headers,
            ...(hasBody ? { "content-type": "application/json" } : {}),
            ...(invocation.params.idempotencyKey === undefined
              ? {}
              : { "idempotency-key": invocation.params.idempotencyKey })
          }
        });
      } finally {
        await prepared?.release();
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        let body: JsonValue = response.body;
        try {
          body = JSON.parse(response.body) as JsonValue;
        } catch {
          // Preserve bounded text errors when an internal route does not return JSON.
        }
        const message = body !== null && typeof body === "object" && !Array.isArray(body)
          && typeof body.error === "string"
          ? body.error
          : `Control operation failed (${response.statusCode})`;
        throw new RpcFault(-32000, message, {
          httpStatus: response.statusCode,
          body
        });
      }
      if (!response.body) return null;
      try {
        return JSON.parse(response.body) as JsonValue;
      } catch {
        throw new RpcFault(-32603, "Control operation returned a non-JSON response");
      }
    }
  };
}

export function promptFromAppServerInput(input: readonly {
  readonly type: string;
  readonly text?: string;
  readonly path?: string;
  readonly url?: string;
  readonly name?: string;
}[]): string {
  const parts = input.map((item) => {
    if (item.type === "text" && item.text?.trim()) {
      return item.text;
    }
    if ((item.type === "mention" || item.type === "skill") && item.path?.trim()) {
      return `[${item.type}: ${item.name ?? "context"} @ ${item.path}]`;
    }
    if ((item.type === "image" || item.type === "audio") && item.url?.trim()) {
      return `[${item.type} attachment]`;
    }
    throw new RpcFault(-32602, `Unsupported local app-server input type: ${item.type}`);
  });
  const prompt = parts.join("\n").trim();
  if (!prompt) throw new RpcFault(-32602, "Turn input must contain text");
  return prompt;
}

export function createAppServerThreadManager(options: {
  readonly store: AgentEventV3Store;
  readonly execute: LocalAppServerRuntimeOptions["execute"];
}): ThreadManager {
  let threads!: ThreadManager;
  threads = new ThreadManager({
    store: options.store,
    executor: {
      async execute(input) {
        const thread = await threads.readThread(input.threadId);
        const result = await options.execute({
          threadId: input.threadId,
          turnId: input.turnId,
          cwd: thread.cwd,
          providerId: thread.providerId,
          modelId: thread.modelId,
          prompt: promptFromAppServerInput(input.input),
          input: input.input,
          ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema as JsonValue }),
          signal: input.signal
        });
        for (const attachment of result.attachments ?? []) {
          await input.recordItem({
            kind: "attachment",
            content: attachment,
            publicControls: attachment
          });
        }
        await input.recordItem({
          kind: "agentMessage",
          status: result.status === "failed" ? "failed" : "completed",
          content: { text: result.summary }
        });
        return {
          status: result.status,
          ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }),
          ...(result.structuredOutput === undefined ? {} : { structuredOutput: result.structuredOutput }),
          ...(result.status === "failed" ? { error: result.summary } : {})
        };
      }
    }
  });
  return threads;
}

function requestUrl(
  template: string,
  pathValues: Readonly<Record<string, JsonValue>> | undefined,
  queryValues: Readonly<Record<string, JsonValue>> | undefined
): string {
  const pathname = template.replace(/\{([^{}]+)\}/gu, (_match, key: string) => {
    const value = pathValues?.[key];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new RpcFault(-32602, `Control path parameter is missing: ${key}`);
    }
    return encodeURIComponent(String(value));
  });
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(queryValues ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === null || typeof item === "object") {
        throw new RpcFault(-32602, `Control query parameter is invalid: ${key}`);
      }
      query.append(key, String(item));
    }
  }
  const suffix = query.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

async function writeConnectionFile(filePath: string, value: { readonly url: string; readonly token: string }): Promise<void> {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  await ensureOwnerOnlyDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, ...value, pid: process.pid })}\n`, {
    mode: 0o600,
    flag: "wx"
  });
  try {
    await rename(temporary, target);
    await lstat(target).then((stats) => {
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("app-server connection file is unsafe");
    });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensureOwnerOnlyDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("app-server directory is unsafe");
  if (typeof process.geteuid === "function" && stats.uid !== process.geteuid()) {
    throw new Error("app-server directory owner is invalid");
  }
  await chmod(directory, 0o700);
}

async function removeOwnedConnectionFile(filePath: string, token: string): Promise<void> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as { token?: unknown; pid?: unknown };
    if (value.token === token && value.pid === process.pid) await rm(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function createRuntimeConnectionFactory(options: EmbeddedAppServerRuntimeOptions): TransportConnectionFactory {
  const threads = createAppServerThreadManager({
    store: new JsonlAgentEventV3Store(path.join(options.rootDir, "threads-v3")),
    execute: options.execute
  });
  const notifications = new JsonlNotificationLog(path.join(options.rootDir, "notifications.jsonl"));
  return (peer): TransportConnection => {
    let connection!: AppServerConnection;
    const handlers = createCoreAppServerHandlers({
      threads,
      defaults: {
        cwd: process.cwd(),
        providerId: "mock",
        modelId: "local-mock",
        permissionProfile: "on-request",
        sandbox: { mode: "workspace-write", network: false }
      },
      notify: (method, params) => connection.notify(method, params)
    });
    connection = new AppServerConnection({
      serverInfo: { name: "muniu", version: "0.2.0" },
      instructionSources: ["AGENTS.md"],
      handlers,
      controlHandler: createMuniuControlHandler(
        options.controlDispatcher ?? createFastifyControlDispatcher(options.app)
      ),
      notificationLog: notifications,
      write: (message) => peer.send(message),
      close: () => peer.close(),
      ...(options.onInternalError === undefined ? {} : { onInternalError: options.onInternalError })
    });
    return {
      receiveText: (text) => connection.receiveText(text),
      closed: () => connection.close()
    };
  };
}

export function startStdioAppServerRuntime(options: EmbeddedAppServerRuntimeOptions & {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}): { close(): Promise<void> } {
  const transport = connectStdio({
    createConnection: createRuntimeConnectionFactory(options),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.stdout === undefined ? {} : { stdout: options.stdout })
  });
  return { close: async () => transport.close() };
}

export async function startUnixAppServerRuntime(options: EmbeddedAppServerRuntimeOptions & {
  readonly socketPath: string;
}): Promise<{ readonly socketPath: string; close(): Promise<void> }> {
  await ensureOwnerOnlyDirectory(path.dirname(options.socketPath));
  return createUnixSocketServer({
    socketPath: options.socketPath,
    createConnection: createRuntimeConnectionFactory(options)
  });
}

export async function startLocalAppServerRuntime(options: LocalAppServerRuntimeOptions): Promise<{
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}> {
  const listener = await createLocalWebSocketServer({
    host: options.host,
    port: options.port,
    ...(options.token === undefined ? {} : { token: options.token }),
    createConnection: createRuntimeConnectionFactory(options)
  });
  try {
    if (options.connectionFile) {
      await writeConnectionFile(options.connectionFile, { url: listener.url, token: listener.token });
    }
  } catch (error) {
    await listener.close();
    throw error;
  }
  return {
    url: listener.url,
    token: listener.token,
    close: async () => {
      await listener.close();
      if (options.connectionFile) await removeOwnedConnectionFile(options.connectionFile, listener.token);
    }
  };
}
