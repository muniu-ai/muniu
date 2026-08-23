// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { ThreadManager } from "@mn/agent-kernel";
import { InMemoryAgentEventV3Store } from "@mn/agent-session";
import {
  AppServerConnection,
  InMemoryNotificationLog,
  createCoreAppServerHandlers,
  createMuniuControlHandler
} from "@mn/app-server";
import type { JsonRpcMessage } from "@mn/app-server-protocol";

import { MuniuClient, type RpcChannel } from "../src/index.js";

class LoopbackChannel implements RpcChannel {
  readonly #listeners = new Set<(message: unknown) => void>();
  server: AppServerConnection | undefined;

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.server) throw new Error("server is unavailable");
    await this.server.receive(message);
  }

  subscribe(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  deliver(message: JsonRpcMessage): void {
    for (const listener of this.#listeners) listener(message);
  }

  close(): void {
    this.server?.close();
  }
}

function identifiers() {
  let next = 0;
  return (kind: "thread" | "turn" | "item" | "event") => `${kind}-sdk-${++next}`;
}

test("SDK drives thread lifecycle, streamed items, control services and approvals", async () => {
  const channel = new LoopbackChannel();
  const threads = new ThreadManager({
    store: new InMemoryAgentEventV3Store(),
    id: identifiers(),
    executor: {
      async execute(input) {
        await input.recordItem({ kind: "agentMessage", content: { text: "done" } });
        return { status: "completed", tokenUsage: { inputTokens: 2, outputTokens: 1 } };
      }
    }
  });
  let server!: AppServerConnection;
  const controlCalls: string[] = [];
  const handlers = createCoreAppServerHandlers({
    threads,
    defaults: {
      cwd: "/workspace",
      providerId: "openai",
      modelId: "gpt-5",
      permissionProfile: "workspace-write",
      sandbox: { mode: "workspace-write", network: false }
    },
    notify: (method, params) => server.notify(method, params)
  });
  server = new AppServerConnection({
    serverInfo: { name: "muniu", version: "0.2.0" },
    instructionSources: ["/workspace/AGENTS.md"],
    handlers,
    controlHandler: createMuniuControlHandler({
      invoke(invocation) {
        controlCalls.push(invocation.operationId);
        return { accepted: true };
      }
    }),
    notificationLog: new InMemoryNotificationLog(),
    write: async (message) => { channel.deliver(message); },
    close: () => undefined
  });
  channel.server = server;
  const client = new MuniuClient({
    channel,
    clientInfo: { name: "sdk-test", version: "0.2.0" },
    approvalHandler: async () => ({ decision: "accept" })
  });
  const initialized = await client.connect();
  assert.ok(initialized.capabilities.methods.includes("muniu/task/tasks/post"));

  const thread = await client.startThread({ cwd: "/repo" });
  await thread.setGoal({ objective: "complete", status: "active", tokenBudget: 50 });
  const turn = await thread.run({ input: [{ type: "text", text: "go" }] });
  assert.equal(turn.status, "completed");
  assert.equal(turn.items.at(-1)?.type, "agentMessage");
  assert.equal((await thread.read()).muniu.goal?.tokensUsed, 3);

  assert.deepEqual(await client.tasks.call("muniu/task/tasks/post", { body: { title: "upgrade" } }), {
    accepted: true
  });
  assert.deepEqual(controlCalls, ["post__v1_tasks"]);

  const approval = server.requestClient("item/commandExecution/requestApproval", {
    threadId: thread.id,
    turnId: turn.id,
    itemId: "item-approval",
    startedAtMs: Date.now(),
    command: "npm test",
    muniu: { effectCommitment: "a".repeat(64) }
  });
  await server.idle();
  assert.deepEqual(await approval, { decision: "accept" });
  await client.close();
});

test("SDK rejects cross-domain control calls before sending them", async () => {
  const channel = new LoopbackChannel();
  const client = new MuniuClient({ channel, clientInfo: { name: "sdk-test", version: "0.2.0" } });
  await assert.rejects(
    () => client.tasks.call("muniu/run/runs/byId/get" as never, { path: { id: "run-1" } }),
    /does not belong/iu
  );
});
