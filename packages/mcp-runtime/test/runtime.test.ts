// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  McpRuntime,
  type McpConnection,
  type McpConnectionInput,
  type McpTransportFactory
} from "../src/index.js";

class FakeConnection implements McpConnection {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  closed = false;

  constructor(readonly failInitialize = false) {}

  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "initialize") {
      if (this.failInitialize) throw new Error("offline token=secret");
      return { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } };
    }
    if (method === "tools/list") {
      return { tools: [{ name: "weather", description: "Weather", inputSchema: { type: "object" } }] };
    }
    if (method === "resources/read") return { contents: [{ uri: "memo://one", text: "hello" }] };
    if (method === "tools/call") return { content: [{ type: "text", text: "sunny" }] };
    return {};
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.calls.push({ method, params });
  }

  async close(): Promise<void> { this.closed = true; }
}

class FakeFactory implements McpTransportFactory {
  readonly inputs: McpConnectionInput[] = [];
  readonly connections = new Map<string, FakeConnection>();
  readonly failures = new Set<string>();

  async connect(input: McpConnectionInput): Promise<McpConnection> {
    this.inputs.push(input);
    const connection = new FakeConnection(this.failures.has(input.config.name));
    this.connections.set(input.config.name, connection);
    return connection;
  }
}

test("required MCP startup is atomic while optional failures remain visible", async () => {
  const factory = new FakeFactory();
  factory.failures.add("required-broken");
  const runtime = new McpRuntime({
    servers: [
      { name: "required-ok", transport: "stdio", command: "ok", args: [], required: true },
      { name: "required-broken", transport: "stdio", command: "broken", args: [], required: true }
    ],
    transportFactory: factory,
    vault: { async read() { throw new Error("unexpected vault access"); } },
    effectGate: { async authorize() { return true; } }
  });
  await assert.rejects(() => runtime.start(), /required MCP server failed/iu);
  assert.equal(factory.connections.get("required-ok")?.closed, true);
  assert.equal(factory.connections.get("required-broken")?.closed, true);
  assert.equal(runtime.listStatus().every((status) => status.state !== "ready"), true);

  const optionalFactory = new FakeFactory();
  optionalFactory.failures.add("optional-broken");
  const optional = new McpRuntime({
    servers: [{
      name: "optional-broken",
      transport: "streamableHttp",
      url: "https://mcp.example.test/rpc",
      required: false
    }],
    transportFactory: optionalFactory,
    vault: { async read() { throw new Error("unexpected vault access"); } },
    effectGate: { async authorize() { return true; } }
  });
  await optional.start();
  assert.equal(optional.listStatus()[0]?.state, "failed");
});

test("MCP resolves secret references from vault and gates resources and tools", async () => {
  const factory = new FakeFactory();
  const vaultReads: string[] = [];
  const effects: string[] = [];
  const runtime = new McpRuntime({
    servers: [
      {
        name: "stdio-server",
        transport: "stdio",
        command: "server",
        args: [],
        required: true,
        secretEnv: { API_TOKEN: "vault://mcp/api" }
      },
      {
        name: "http-server",
        transport: "streamableHttp",
        url: "https://mcp.example.test/rpc",
        required: true,
        oauthTokenRef: "vault://mcp/oauth"
      }
    ],
    transportFactory: factory,
    vault: {
      async read(reference) {
        vaultReads.push(reference);
        return reference.endsWith("oauth") ? "oauth-secret" : "stdio-secret";
      }
    },
    effectGate: {
      async authorize(effect) {
        effects.push(`${effect.operation}:${effect.server}:${effect.threadId}`);
        return true;
      }
    }
  });
  await runtime.start();
  assert.deepEqual(vaultReads, ["vault://mcp/api", "vault://mcp/oauth"]);
  assert.deepEqual(factory.inputs[0]?.secretEnv, { API_TOKEN: "stdio-secret" });
  assert.equal(factory.inputs[1]?.oauthToken, "oauth-secret");
  assert.equal(JSON.stringify(runtime.listStatus()).includes("secret"), false);

  assert.deepEqual(await runtime.readResource("thread-one", "http-server", "memo://one"), {
    contents: [{ uri: "memo://one", text: "hello" }]
  });
  assert.deepEqual(await runtime.callTool("thread-one", "stdio-server", "weather", { city: "Shanghai" }), {
    content: [{ type: "text", text: "sunny" }]
  });
  assert.deepEqual(effects, [
    "resource.read:http-server:thread-one",
    "tool.call:stdio-server:thread-one"
  ]);
});

test("MCP rejects denied effects and malicious tool schemas", async () => {
  const factory: McpTransportFactory = {
    async connect() {
      return {
        async request(method) {
          if (method === "initialize") {
            return { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } };
          }
          if (method === "tools/list") {
            return { tools: [{ name: "bad tool name", inputSchema: { type: "object" } }] };
          }
          return {};
        },
        async notify() {},
        async close() {}
      };
    }
  };
  const runtime = new McpRuntime({
    servers: [{ name: "server", transport: "stdio", command: "server", args: [], required: true }],
    transportFactory: factory,
    vault: { async read() { throw new Error("unexpected vault access"); } },
    effectGate: { async authorize() { return false; } }
  });
  await runtime.start();
  await assert.rejects(() => runtime.listTools("server"), /schema/iu);
  await assert.rejects(
    () => runtime.callTool("thread-one", "server", "weather", {}),
    /denied/iu
  );
  assert.throws(() => new McpRuntime({
    servers: [{
      name: "raw-secret",
      transport: "stdio",
      command: "server",
      args: [],
      required: true,
      env: { API_TOKEN: "raw-secret" }
    }],
    transportFactory: factory,
    vault: { async read() { return "unused"; } },
    effectGate: { async authorize() { return true; } }
  }), /secretEnv|vault/iu);
});

test("default stdio transport completes initialize and tool call without a shell", async () => {
  const server = [
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    "  buffer += chunk;",
    "  while (buffer.includes('\\n')) {",
    "    const index = buffer.indexOf('\\n');",
    "    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);",
    "    if (!line) continue;",
    "    const request = JSON.parse(line);",
    "    if (request.id === undefined) continue;",
    "    const result = request.method === 'initialize'",
    "      ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stdio', version: '1' } }",
    "      : { content: [{ type: 'text', text: request.params.arguments.city }] };",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
    "  }",
    "});"
  ].join("\n");
  const runtime = new McpRuntime({
    servers: [{
      name: "stdio-live",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", server],
      required: true
    }],
    allowedStdioCommands: [process.execPath],
    vault: { async read() { throw new Error("unexpected vault access"); } },
    effectGate: { async authorize() { return true; } }
  });
  await runtime.start();
  assert.deepEqual(await runtime.callTool("thread-live", "stdio-live", "weather", { city: "Shanghai" }), {
    content: [{ type: "text", text: "Shanghai" }]
  });
  await runtime.dispose();
});

test("default Streamable HTTP transport accepts SSE and sends vault OAuth only in memory", async (t) => {
  const authorizations: Array<string | undefined> = [];
  const server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      authorizations.push(request.headers.authorization);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method: string;
      };
      if (message.id === undefined) {
        reply.writeHead(202).end();
        return;
      }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "http", version: "1" } }
        : { contents: [{ uri: "memo://live", text: "live" }] };
      const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      if (message.method === "initialize") {
        reply.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "session-http" });
        reply.end(`event: message\ndata: ${body}\n\n`);
      } else {
        reply.writeHead(200, { "content-type": "application/json" });
        reply.end(body);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test HTTP server has no TCP address");
  const runtime = new McpRuntime({
    servers: [{
      name: "http-live",
      transport: "streamableHttp",
      url: `http://127.0.0.1:${address.port}/mcp`,
      required: true,
      oauthTokenRef: "vault://oauth/live"
    }],
    vault: { async read() { return "live-token"; } },
    effectGate: { async authorize() { return true; } }
  });
  await runtime.start();
  assert.deepEqual(await runtime.readResource("thread-http", "http-live", "memo://live"), {
    contents: [{ uri: "memo://live", text: "live" }]
  });
  assert.deepEqual(authorizations, ["Bearer live-token", "Bearer live-token", "Bearer live-token"]);
  await runtime.dispose();
});
