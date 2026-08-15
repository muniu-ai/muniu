import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CallId, CandidateId, RunId, SessionId, verifyAgentSessionEventChain } from "@mn/agent-protocol";
import { JsonlAgentSessionStore, projectSession } from "@mn/agent-session";
import { ScriptedLlmAdapter, type LlmAdapter } from "@mn/agent-llm";
import { StaticSystemPrompt } from "@mn/agent-kernel";
import { defineTool } from "@mn/agent-tools";
import { createAgentHost } from "../src/index.js";

const echoParameters = {
  type: "object" as const,
  properties: { text: { type: "string" as const } },
  required: ["text"],
  additionalProperties: false
};

test("host rolls back partially registered components in LIFO order", async () => {
  const disposed: string[] = [];
  const adapter = (id: string): LlmAdapter => ({
    id,
    async *stream() { yield { type: "finish" as const, reason: "stop" as const }; },
    dispose: () => { disposed.push(id); }
  });
  const tool = defineTool({ name: "duplicate", description: "Duplicate", risk: "read-only", parameters: echoParameters, execute: async () => null });
  await assert.rejects(() => createAgentHost({
    adapters: [adapter("first"), adapter("second")],
    tools: [tool, tool],
    authorizer: { authorize: async () => ({ decision: "approve" }) }
  }), /already registered/i);
  assert.deepEqual(disposed, ["second", "first"]);
});

test("PATH-empty host completes a durable two-step tool turn and reloads it after restart", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const root = await mkdtemp(path.join(os.tmpdir(), "muniu-host-"));
    const store = new JsonlAgentSessionStore(root);
    const sessionId = SessionId("host-session");
    let durableCallObserved = false;
    const eventsPath = path.join(root, "sessions", sessionId, "events.jsonl");
    const host = await createAgentHost({
      sessionStore: store,
      adapters: [new ScriptedLlmAdapter("mock", [
        [
          { type: "tool-call-delta", index: 0, id: CallId("call-echo"), name: "echo", argumentsDelta: '{"text":"hello"}' },
          { type: "finish", reason: "tool-calls" }
        ],
        [
          { type: "text-delta", index: 0, text: "done" },
          { type: "usage", usage: { inputTokens: 4, outputTokens: 1 } },
          { type: "finish", reason: "stop" }
        ]
      ])],
      tools: [defineTool({
        name: "echo",
        description: "Echo text",
        risk: "read-only",
        parameters: echoParameters,
        execute: async (args) => {
          const rows = (await readFile(eventsPath, "utf8")).trimEnd().split("\n").map((row) => JSON.parse(row) as { type: string });
          durableCallObserved = rows.at(-1)?.type === "tool/call";
          return { echoed: String(args.text) };
        }
      })],
      authorizer: { authorize: async () => ({ decision: "approve" }) }
    });
    const runId = RunId("run-host");
    const candidateId = CandidateId("candidate-host");
    const outcome = await host.run({ sessionId, prompt: "echo hello", provider: "mock", model: "scripted", runId, candidateId });
    assert.equal(outcome.reason, "completed");
    assert.equal(durableCallObserved, true);
    assert.deepEqual(outcome.session.events.map((event) => event.type), [
      "session/created",
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "tool/call",
      "tool/result",
      "step/end",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end"
    ]);
    assert.equal(outcome.session.events.slice(1).every((event) => event.runId === runId && event.candidateId === candidateId), true);
    await host.dispose();

    const reopened = await new JsonlAgentSessionStore(root).open(sessionId);
    assert.doesNotThrow(() => verifyAgentSessionEventChain(reopened.events));
    assert.equal(projectSession(reopened.events).status, "completed");
    const finalMessage = projectSession(reopened.events).messages.at(-1);
    assert.equal(finalMessage?.role, "assistant");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("host forwards optional run bindings, defaults storage, and disposes once", async () => {
  const disposed: string[] = [];
  let observedSystem: string | undefined;
  let observedAborted: boolean | undefined;
  const adapter: LlmAdapter = {
    id: "capture",
    async *stream(request) {
      observedSystem = request.system;
      observedAborted = request.signal?.aborted;
      yield { type: "text-delta", index: 0, text: "ok" };
      yield { type: "finish", reason: "stop" };
    },
    dispose: () => { disposed.push("capture"); }
  };
  const host = await createAgentHost({
    adapters: [adapter],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) },
    systemPrompt: new StaticSystemPrompt([{ name: "fixed", order: 0, text: "bound" }])
  });
  const controller = new AbortController();
  const outcome = await host.run({
    sessionId: SessionId("optional-bindings"),
    cwd: "/workspace",
    labels: { source: "test" },
    prompt: "hello",
    provider: "capture",
    model: "scripted",
    signal: controller.signal,
    maxSteps: 2,
    maxToolCalls: 0
  });
  assert.equal(outcome.reason, "completed");
  assert.equal(outcome.session.header.cwd, "/workspace");
  assert.equal(observedSystem, "bound");
  assert.equal(observedAborted, false);
  await host.dispose();
  await host.dispose();
  assert.deepEqual(disposed, ["capture"]);
  await assert.rejects(() => host.run({ prompt: "late", provider: "capture", model: "scripted" }), /disposed/i);
});

test("host preserves initialization cause when rollback also fails", async () => {
  const adapter: LlmAdapter = {
    id: "rollback-failure",
    async *stream() { yield { type: "finish", reason: "stop" }; },
    dispose: () => { throw new Error("rollback failed"); }
  };
  const tool = defineTool({
    name: "duplicateRollback",
    description: "Duplicate",
    risk: "read-only",
    parameters: echoParameters,
    execute: async () => null
  });
  await assert.rejects(
    () => createAgentHost({
      adapters: [adapter],
      tools: [tool, tool],
      authorizer: { authorize: async () => ({ decision: "approve" }) }
    }),
    (error: unknown) => error instanceof AggregateError
      && /already registered/i.test(error.message)
      && error.errors.length === 2
  );
});
