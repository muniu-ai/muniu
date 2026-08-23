// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { ThreadManager } from "@mn/agent-kernel";
import { InMemoryAgentEventV3Store } from "@mn/agent-session";
import {
  AppServerConnection,
  InMemoryNotificationLog,
  createCoreAppServerHandlers,
  createLocalWebSocketServer,
  createMuniuControlHandler,
  type TransportConnection
} from "@mn/app-server";

const execFileAsync = promisify(execFile);

test("CLI uses the SDK for thread and namespaced control operations", async (t) => {
  const threads = new ThreadManager({
    store: new InMemoryAgentEventV3Store(),
    executor: {
      async execute(input) {
        await input.recordItem({ kind: "agentMessage", content: { text: "completed by app-server" } });
        return { status: "completed" };
      }
    }
  });
  const controlCalls: string[] = [];
  const notifications = new InMemoryNotificationLog();
  const listener = await createLocalWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    createConnection: (peer): TransportConnection => {
      let connection!: AppServerConnection;
      connection = new AppServerConnection({
        serverInfo: { name: "muniu-test", version: "0.2.0" },
        instructionSources: [],
        handlers: createCoreAppServerHandlers({
          threads,
          defaults: {
            cwd: process.cwd(),
            providerId: "mock",
            modelId: "mock-model",
            permissionProfile: "on-request",
            sandbox: { mode: "workspace-write", network: false }
          },
          notify: (method, params) => connection.notify(method, params)
        }),
        controlHandler: createMuniuControlHandler({
          invoke(invocation) {
            controlCalls.push(invocation.operationId);
            return { providers: [] };
          }
        }),
        notificationLog: notifications,
        write: (message) => peer.send(message),
        close: () => peer.close()
      });
      return {
        receiveText: (text) => connection.receiveText(text),
        closed: () => connection.close()
      };
    }
  });
  t.after(() => listener.close());

  const entry = path.join(process.cwd(), "dist-test", "src", "index.js");
  const env = {
    ...process.env,
    MN_APP_SERVER_URL: listener.url,
    MN_APP_SERVER_TOKEN: listener.token
  };
  const run = await execFileAsync(process.execPath, [entry, "agent", "run", "--provider", "mock", "--model", "mock-model", "--prompt", "go"], {
    env,
    timeout: 10_000
  });
  assert.match(run.stdout, /completed by app-server/u);
  assert.doesNotMatch(run.stdout, /agent-session-view/u);

  const providers = await execFileAsync(process.execPath, [entry, "provider", "list"], {
    env,
    timeout: 10_000
  });
  assert.match(providers.stdout, /"providers": \[\]/u);
  assert.deepEqual(controlCalls, ["get__v1_providers"]);
});
