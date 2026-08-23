// SPDX-License-Identifier: Apache-2.0

import {
  snapshotBoundedJsonValue,
  type JsonValue
} from "@mn/agent-protocol";

import { DefaultMcpTransportFactory } from "./transports.js";
import type {
  McpConnection,
  McpConnectionInput,
  McpRuntimeOptions,
  McpServerConfig,
  McpServerStatus
} from "./types.js";

interface ServerState {
  readonly config: McpServerConfig;
  state: McpServerStatus["state"];
  connection?: McpConnection;
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  errorCode?: McpServerStatus["errorCode"];
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SECRET_ENV_PATTERN = /(authorization|credential|password|private.?key|secret|token)/iu;

function plainObject(value: unknown, label: string): Record<string, JsonValue> {
  const snapshot = snapshotBoundedJsonValue(value);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError(`${label} must be a bounded JSON object`);
  }
  return snapshot;
}

function snapshotConfig(config: McpServerConfig): McpServerConfig {
  const snapshot = snapshotBoundedJsonValue(config);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("MCP server config must be a bounded JSON object");
  }
  const record = snapshot as Record<string, JsonValue>;
  if (typeof record.name !== "string" || !NAME_PATTERN.test(record.name)
    || typeof record.required !== "boolean"
    || record.enabled !== undefined && typeof record.enabled !== "boolean") {
    throw new TypeError("MCP server config identity is invalid");
  }
  if (record.transport === "stdio") {
    const allowed = new Set(["name", "transport", "command", "args", "required", "enabled", "env", "secretEnv"]);
    if (Object.keys(record).some((key) => !allowed.has(key))
      || typeof record.command !== "string" || !record.command || record.command.includes("\0")
      || !Array.isArray(record.args)
      || record.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
      throw new TypeError("MCP stdio command or arguments are invalid");
    }
    const env = stringRecord(record.env, "MCP stdio environment");
    const secretEnv = stringRecord(record.secretEnv, "MCP stdio secret environment");
    if (Object.keys(env).some((name) => SECRET_ENV_PATTERN.test(name))) {
      throw new TypeError("MCP stdio secrets must use secretEnv vault references");
    }
    return Object.freeze({
      name: record.name,
      transport: "stdio",
      command: record.command,
      args: Object.freeze([...(record.args as string[])]),
      required: record.required,
      enabled: record.enabled ?? true,
      env,
      secretEnv
    });
  }
  const allowed = new Set(["name", "transport", "url", "required", "enabled", "oauthTokenRef"]);
  if (record.transport !== "streamableHttp" || Object.keys(record).some((key) => !allowed.has(key))
    || typeof record.url !== "string" || !record.url
    || record.oauthTokenRef !== undefined && (typeof record.oauthTokenRef !== "string" || !record.oauthTokenRef)) {
    throw new TypeError("MCP HTTP config is invalid");
  }
  const url = new URL(record.url);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)
    || url.username || url.password || url.hash) {
    throw new TypeError("MCP Streamable HTTP requires HTTPS or loopback HTTP without URL credentials");
  }
  return Object.freeze({
    name: record.name,
    transport: "streamableHttp",
    url: record.url,
    required: record.required,
    enabled: record.enabled ?? true,
    ...(record.oauthTokenRef === undefined ? {} : { oauthTokenRef: record.oauthTokenRef })
  });
}

function stringRecord(value: JsonValue | undefined, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} must map strings to strings`);
  }
  return Object.freeze({ ...(value as Record<string, string>) });
}

function initializeResult(value: unknown): {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
} {
  const result = plainObject(value, "MCP initialize result");
  const serverInfo = result.serverInfo;
  if (typeof result.protocolVersion !== "string"
    || serverInfo === null || typeof serverInfo !== "object" || Array.isArray(serverInfo)
    || typeof serverInfo.name !== "string" || typeof serverInfo.version !== "string") {
    throw new TypeError("MCP initialize result is invalid");
  }
  return {
    protocolVersion: result.protocolVersion,
    serverInfo: { name: serverInfo.name, version: serverInfo.version }
  };
}

export class McpRuntime {
  readonly #states: Map<string, ServerState>;
  readonly #vault: McpRuntimeOptions["vault"];
  readonly #effectGate: McpRuntimeOptions["effectGate"];
  readonly #transportFactory: NonNullable<McpRuntimeOptions["transportFactory"]>;
  #start?: Promise<void>;
  #disposed = false;

  constructor(options: McpRuntimeOptions) {
    this.#vault = options.vault;
    this.#effectGate = options.effectGate;
    this.#transportFactory = options.transportFactory ?? new DefaultMcpTransportFactory({
      allowedStdioCommands: options.allowedStdioCommands ?? [],
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
    this.#states = new Map();
    for (const input of options.servers) {
      const config = snapshotConfig(input);
      if (this.#states.has(config.name)) throw new Error(`MCP server ${config.name} is configured more than once`);
      this.#states.set(config.name, { config, state: "stopped" });
    }
  }

  start(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("MCP runtime is disposed"));
    this.#start ??= this.#startServers().catch((error: unknown) => {
      this.#start = undefined;
      throw error;
    });
    return this.#start;
  }

  async reload(): Promise<void> {
    await this.#closeConnections();
    for (const state of this.#states.values()) {
      state.state = "stopped";
      state.protocolVersion = undefined;
      state.serverInfo = undefined;
      state.errorCode = undefined;
    }
    this.#start = undefined;
    await this.start();
  }

  listStatus(): readonly McpServerStatus[] {
    return Object.freeze([...this.#states.values()].map((entry) => Object.freeze({
      name: entry.config.name,
      transport: entry.config.transport,
      required: entry.config.required,
      state: entry.state,
      ...(entry.protocolVersion === undefined ? {} : { protocolVersion: entry.protocolVersion }),
      ...(entry.serverInfo === undefined ? {} : { serverInfo: Object.freeze({ ...entry.serverInfo }) }),
      ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode })
    })));
  }

  async listTools(server: string): Promise<readonly Readonly<Record<string, JsonValue>>[]> {
    const result = plainObject(await this.#ready(server).request("tools/list", {}), "MCP tools result");
    if (!Array.isArray(result.tools)) throw new TypeError("MCP tool schema list is invalid");
    return Object.freeze(result.tools.map((value) => {
      const tool = plainObject(value, "MCP tool schema");
      if (typeof tool.name !== "string" || !NAME_PATTERN.test(tool.name)
        || tool.inputSchema === null || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
        throw new TypeError("MCP tool schema is invalid");
      }
      return Object.freeze(tool);
    }));
  }

  async readResource(threadId: string, server: string, uri: string): Promise<JsonValue> {
    await this.#authorize(threadId, server, "resource.read", { uri });
    return snapshotBoundedJsonValue(await this.#ready(server).request("resources/read", { uri }));
  }

  async callTool(threadId: string, server: string, tool: string, args: JsonValue): Promise<JsonValue> {
    if (!NAME_PATTERN.test(tool)) throw new TypeError("MCP tool name is invalid");
    const argumentsSnapshot = snapshotBoundedJsonValue(args);
    await this.#authorize(threadId, server, "tool.call", { tool, arguments: argumentsSnapshot });
    return snapshotBoundedJsonValue(await this.#ready(server).request("tools/call", {
      name: tool,
      arguments: argumentsSnapshot
    }));
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#closeConnections();
  }

  async #startServers(): Promise<void> {
    const started: ServerState[] = [];
    for (const state of this.#states.values()) {
      if (state.config.enabled === false) continue;
      state.state = "starting";
      try {
        const input = await this.#connectionInput(state.config);
        const connection = await this.#transportFactory.connect(input);
        state.connection = connection;
        const initialized = initializeResult(await connection.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "muniu", version: "0.2.0" }
        }));
        await connection.notify("notifications/initialized", {});
        state.protocolVersion = initialized.protocolVersion;
        state.serverInfo = initialized.serverInfo;
        state.state = "ready";
        started.push(state);
      } catch {
        await state.connection?.close().catch(() => undefined);
        state.connection = undefined;
        state.state = "failed";
        state.errorCode = "START_FAILED";
        if (!state.config.required) continue;
        await Promise.allSettled(started.map(async (entry) => {
          await entry.connection?.close();
          entry.connection = undefined;
          entry.state = "stopped";
          entry.protocolVersion = undefined;
          entry.serverInfo = undefined;
        }));
        throw new Error(`required MCP server failed to start: ${state.config.name}`);
      }
    }
  }

  async #connectionInput(config: McpServerConfig): Promise<McpConnectionInput> {
    if (config.transport === "stdio") {
      const secretEnv: Record<string, string> = {};
      for (const [name, reference] of Object.entries(config.secretEnv ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || !reference) {
          throw new TypeError("MCP stdio secret environment mapping is invalid");
        }
        secretEnv[name] = await this.#vault.read(reference);
      }
      return Object.freeze({ config, secretEnv: Object.freeze(secretEnv) });
    }
    const oauthToken = config.oauthTokenRef === undefined
      ? undefined
      : await this.#vault.read(config.oauthTokenRef);
    return Object.freeze({
      config,
      secretEnv: Object.freeze({}),
      ...(oauthToken === undefined ? {} : { oauthToken })
    });
  }

  async #authorize(
    threadId: string,
    server: string,
    operation: "resource.read" | "tool.call",
    args: JsonValue
  ): Promise<void> {
    if (!threadId) throw new TypeError("MCP effect requires a thread identifier");
    const approved = await this.#effectGate.authorize({
      threadId,
      server,
      operation,
      arguments: snapshotBoundedJsonValue(args)
    });
    if (!approved) throw new Error("MCP effect was denied by policy");
  }

  #ready(server: string): McpConnection {
    const state = this.#states.get(server);
    if (!state || state.state !== "ready" || state.connection === undefined) {
      throw new Error("MCP server is not ready");
    }
    return state.connection;
  }

  async #closeConnections(): Promise<void> {
    const states = [...this.#states.values()];
    await Promise.allSettled(states.map(async (state) => {
      await state.connection?.close();
      state.connection = undefined;
      if (state.state === "ready" || state.state === "starting") state.state = "stopped";
    }));
  }
}
