// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MuniuClient, WebSocketRpcChannel } from "@mn/sdk";
import Fastify from "fastify";

import {
  createFastifyControlDispatcher,
  startLocalAppServerRuntime
} from "../src/localAppServerRuntime.js";

test("local app-server runs thread and control transcripts through the SDK", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-local-app-server-"));
  const connectionFile = path.join(root, "app-server.json");
  const app = Fastify({ logger: false });
  const internalErrors: unknown[] = [];
  app.get("/v1/capabilities", async () => ({ schemaVersion: 1, source: "internal-control" }));
  const runtime = await startLocalAppServerRuntime({
    app,
    rootDir: root,
    host: "127.0.0.1",
    port: 0,
    connectionFile,
    onInternalError: (error) => internalErrors.push(error),
    execute: async (input) => ({
      status: "completed",
      summary: `reply: ${input.prompt}`,
      ...(input.outputSchema === undefined ? {} : { structuredOutput: { accepted: true } }),
      ...(input.input.some((item) => item.type === "image") ? {
        attachments: [{ name: "test.png", mimeType: "image/png", uri: "attachment://test", digest: "a".repeat(64) }]
      } : {})
    })
  });
  assert.deepEqual(await createFastifyControlDispatcher(app).invoke({
    operationId: "get__v1_capabilities",
    method: "muniu/config/capabilities/get",
    verb: "get",
    pathTemplate: "/v1/capabilities",
    params: {},
    context: { clientInfo: { name: "test", version: "0.2.0" }, signal: new AbortController().signal }
  }), { schemaVersion: 1, source: "internal-control" });
  t.after(async () => {
    await runtime.close();
    await app.close();
  });

  assert.equal((await stat(connectionFile)).mode & 0o777, 0o600);
  const channel = await WebSocketRpcChannel.connect(runtime.url, runtime.token);
  const client = new MuniuClient({
    channel,
    clientInfo: { name: "api-test", version: "0.2.0" }
  });
  await client.connect();
  const thread = await client.startThread({
    cwd: root,
    modelProvider: "mock",
    model: "local-mock"
  });
  let turn;
  try {
    turn = await thread.run({ input: [{ type: "text", text: "hello" }] });
  } catch (error) {
    assert.fail(`${String(error)}: ${internalErrors.map(String).join("; ")}`);
  }
  assert.equal(turn.status, "completed");
  assert.equal(turn.items.at(-1)?.type, "agentMessage");
  const structuredTurn = await thread.run({
    input: [
      { type: "text", text: "inspect" },
      { type: "image", url: "data:image/png;base64,AA==" }
    ],
    outputSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] }
  });
  assert.equal(structuredTurn.status, "completed");
  assert.ok(structuredTurn.items.some((item) => item.type === "attachment"));
  try {
    assert.deepEqual(await client.config.call("muniu/config/capabilities/get"), {
      schemaVersion: 1,
      source: "internal-control"
    });
  } catch (error) {
    assert.fail(`${String(error)}: ${internalErrors.map(String).join("; ")}`);
  }
  await client.close();
});

test("local app-server rejects a connection descriptor below a symlinked directory and releases its port", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-local-app-server-symlink-"));
  const realDirectory = path.join(root, "real");
  const linkedDirectory = path.join(root, "linked");
  await mkdir(realDirectory);
  await symlink(realDirectory, linkedDirectory);
  const portServer = createServer();
  await new Promise<void>((resolve, reject) => {
    portServer.once("error", reject);
    portServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = portServer.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));

  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await assert.rejects(startLocalAppServerRuntime({
    app,
    rootDir: root,
    host: "127.0.0.1",
    port,
    connectionFile: path.join(linkedDirectory, "app-server.json"),
    execute: async () => ({ status: "completed", summary: "unused" })
  }), /directory is unsafe/iu);

  const replacement = createServer();
  await new Promise<void>((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(port, "127.0.0.1", () => resolve());
  });
  await new Promise<void>((resolve, reject) => replacement.close((error) => error ? reject(error) : resolve()));
});
