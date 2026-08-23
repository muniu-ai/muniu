// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_METHODS,
  MUNIU_METHODS,
  SERVER_NOTIFICATION_METHODS,
  SERVER_REQUEST_METHODS,
  type JsonRpcMessage
} from "@mn/app-server-protocol";

import {
  AppServerConnection,
  InMemoryNotificationLog,
  type AppServerHandlers
} from "../src/index.js";

function handlers(overrides: Partial<AppServerHandlers> = {}): AppServerHandlers {
  return Object.fromEntries(
    CLIENT_METHODS
      .filter((method) => method !== "initialize")
      .map((method) => [method, async () => ({})])
  ) as unknown as AppServerHandlers & typeof overrides;
}

function connection(overrides: Partial<AppServerHandlers> = {}) {
  const messages: JsonRpcMessage[] = [];
  const closed: Array<{ reason: string; cursor?: string }> = [];
  const log = new InMemoryNotificationLog();
  const server = new AppServerConnection({
    serverInfo: { name: "muniu", title: "Muniu", version: "0.2.0" },
    instructionSources: ["/workspace/AGENTS.md"],
    handlers: { ...handlers(), ...overrides },
    notificationLog: log,
    write: async (message) => {
      messages.push(message);
    },
    close: (reason) => {
      closed.push(reason);
    }
  });
  return { server, messages, closed, log };
}

async function initialize(server: AppServerConnection) {
  await server.receive({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "test", version: "0.2.0" } }
  });
  await server.receive({ method: "initialized" });
  await server.idle();
}

test("requires initialize followed by initialized before ordinary requests", async () => {
  const { server, messages } = connection();
  await server.receive({ id: 1, method: "thread/archive", params: { threadId: "thread-1" } });
  await server.receive({
    id: 2,
    method: "initialize",
    params: { clientInfo: { name: "test", version: "0.2.0" } }
  });
  await server.receive({ id: 3, method: "thread/archive", params: { threadId: "thread-1" } });
  await server.receive({ method: "initialized" });
  await server.receive({ id: 4, method: "thread/archive", params: { threadId: "thread-1" } });
  await server.idle();

  assert.deepEqual(messages[0], {
    id: 1,
    error: { code: -32002, message: "Server not initialized" }
  });
  assert.deepEqual(messages[2], {
    id: 3,
    error: { code: -32002, message: "Server not initialized" }
  });
  assert.deepEqual(messages[3], { id: 4, result: {} });
  assert.deepEqual(messages[1], {
    id: 2,
    result: {
      serverInfo: { name: "muniu", title: "Muniu", version: "0.2.0" },
      protocolVersion: "2",
      capabilities: {
        methods: [...CLIENT_METHODS],
        notifications: [...SERVER_NOTIFICATION_METHODS],
        serverRequests: [...SERVER_REQUEST_METHODS]
      },
      instructionSources: ["/workspace/AGENTS.md"],
      muniu: {
        compatibility: {
          protocol: "app-server-v2",
          baselineCommit: "99660ab3c7b861c916e467581fa9b8723504d66b",
          methodSet: "core-stable-subset"
        }
      }
    }
  });
});

test("returns stable JSON-RPC errors for unknown methods and invalid params", async () => {
  const { server, messages } = connection();
  await initialize(server);
  await server.receive({ id: "unknown", method: "thread/rollback", params: {} });
  await server.receive({ id: "invalid", method: "thread/read", params: { threadId: 7 } });
  await server.idle();

  assert.deepEqual(messages.at(-2), {
    id: "unknown",
    error: { code: -32601, message: "Method not found" }
  });
  assert.deepEqual(messages.at(-1), {
    id: "invalid",
    error: { code: -32602, message: "Invalid params" }
  });
});

test("advertises and dispatches the complete namespaced control surface when installed", async () => {
  const calls: unknown[] = [];
  const messages: JsonRpcMessage[] = [];
  const server = new AppServerConnection({
    serverInfo: { name: "muniu", version: "0.2.0" },
    instructionSources: [],
    handlers: handlers(),
    controlHandler: async (method, params) => {
      calls.push({ method, params });
      return { accepted: true };
    },
    notificationLog: new InMemoryNotificationLog(),
    write: async (message) => { messages.push(message); },
    close: () => undefined
  });
  await initialize(server);
  await server.receive({
    id: "control-1",
    method: "muniu/task/tasks/post",
    params: { body: { title: "upgrade" }, idempotencyKey: "task-1" }
  });
  await server.idle();

  const initialized = messages[0] as unknown as { result: { capabilities: { methods: string[] } } };
  assert.deepEqual(initialized.result.capabilities.methods, [...CLIENT_METHODS, ...MUNIU_METHODS]);
  assert.deepEqual(calls, [{
    method: "muniu/task/tasks/post",
    params: { body: { title: "upgrade" }, idempotencyKey: "task-1" }
  }]);
  assert.deepEqual(messages.at(-1), { id: "control-1", result: { accepted: true } });
});

test("returns parse and invalid-request errors without exposing parser details", async () => {
  const { server, messages } = connection();
  await server.receiveText("{");
  await server.receive({ id: {}, method: "initialize", params: {} });
  await server.idle();

  assert.deepEqual(messages, [
    { id: null, error: { code: -32700, message: "Parse error" } },
    { id: null, error: { code: -32600, message: "Invalid request" } }
  ]);
});

test("persists a notification before it becomes writable", async () => {
  const order: string[] = [];
  const server = new AppServerConnection({
    serverInfo: { name: "muniu", version: "0.2.0" },
    instructionSources: [],
    handlers: handlers(),
    notificationLog: {
      append: async () => {
        order.push("persisted");
        return { cursor: "cursor-1" };
      }
    },
    write: async () => {
      order.push("written");
    },
    close: () => undefined
  });
  await initialize(server);
  order.length = 0;

  await server.notify("warning", { message: "Policy changed." });
  await server.idle();

  assert.deepEqual(order, ["persisted", "written"]);
});

test("round-trips typed server requests to client handlers", async () => {
  const { server, messages } = connection();
  await initialize(server);
  const response = server.requestClient("item/tool/call", {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    tool: "pick",
    arguments: { value: 1 }
  });
  await server.idle();
  const request = messages.at(-1);
  assert.equal(request && "method" in request ? request.method : undefined, "item/tool/call");
  const id = request && "id" in request ? request.id : undefined;
  await server.receive({ id: id!, result: { success: true, contentItems: [] } });

  assert.deepEqual(await response, { success: true, contentItems: [] });
});

test("binds authenticated identity, enforces method authorization and replays from a cursor", async () => {
  const messages: JsonRpcMessage[] = [];
  const contexts: unknown[] = [];
  const log = new InMemoryNotificationLog();
  await log.append({ method: "warning", params: { message: "old" } });
  await log.append({ method: "warning", params: { message: "resume" } });
  const server = new AppServerConnection({
    serverInfo: { name: "muniu", version: "0.2.0" },
    instructionSources: [],
    handlers: { ...handlers(),
      "thread/read": async (_params, context) => {
        contexts.push(context.identity);
        return { thread: {} as never };
      }
    },
    identity: {
      tenantId: "tenant-a",
      subject: "user-a",
      roles: ["auditor"],
      permissionProfile: "read-only",
      sandbox: { mode: "read-only" }
    },
    authorizeRequest: (method) => method === "thread/read",
    resumeCursor: "1",
    notificationLog: log,
    write: async (message) => { messages.push(message); },
    close: () => undefined
  });
  await initialize(server);
  await server.receive({ id: 2, method: "thread/archive", params: { threadId: "thread-1" } });
  await server.receive({ id: 3, method: "thread/read", params: { threadId: "thread-1" } });
  await server.idle();

  assert.equal(messages.some((message) => "method" in message && message.method === "warning"), true);
  assert.deepEqual(messages.find((message) => "id" in message && message.id === 2), {
    id: 2,
    error: { code: -32003, message: "Request is not authorized" }
  });
  assert.deepEqual(contexts, [{
    tenantId: "tenant-a",
    subject: "user-a",
    roles: ["auditor"],
    permissionProfile: "read-only",
    sandbox: { mode: "read-only" }
  }]);
});

test("a connection without a resume cursor receives only live notifications", async () => {
  const messages: JsonRpcMessage[] = [];
  const log = new InMemoryNotificationLog();
  await log.append({ method: "warning", params: { message: "historical" } });
  const server = new AppServerConnection({
    serverInfo: { name: "muniu", version: "0.2.0" },
    instructionSources: [],
    handlers: handlers(),
    notificationLog: log,
    write: async (message) => { messages.push(message); },
    close: () => undefined
  });
  await initialize(server);
  await log.append({ method: "warning", params: { message: "live" } });
  await server.idle();
  assert.deepEqual(messages.filter((message) => "method" in message && message.method === "warning"), [{
    method: "warning",
    params: { message: "live" }
  }]);
});
