import assert from "node:assert/strict";
import test from "node:test";

import { CallId, CandidateId, MessageId, RunId, SessionId, verifyAgentSessionEventChain } from "@mn/agent-protocol";
import { DurableAgentSession, InMemoryAgentSessionStore } from "@mn/agent-session";
import { LlmRuntime, ScriptedLlmAdapter, type LlmAdapter } from "@mn/agent-llm";
import { ToolExecutionError, ToolRegistry, defineTool } from "@mn/agent-tools";
import {
  AgentKernel,
  AgentRegistry,
  LifecycleScope,
  StaticSystemPrompt,
  createBuiltinAgentKernel,
  runToolStep
} from "../src/index.js";

const noArgs = { type: "object" as const, properties: {}, additionalProperties: false };

test("lifecycle scope disposes children LIFO, continues after failures, and is idempotent", async () => {
  const order: string[] = [];
  const scope = new LifecycleScope();
  scope.defer(() => { order.push("parent-first"); });
  const child = scope.child();
  child.defer(() => { order.push("child-first"); });
  child.defer(() => { order.push("child-second"); throw new Error("child failure"); });
  scope.defer(() => { order.push("parent-last"); });

  const first = scope.dispose();
  const second = scope.dispose();
  await assert.rejects(() => first, AggregateError);
  await assert.rejects(() => second, AggregateError);
  assert.deepEqual(order, ["parent-last", "child-second", "child-first", "parent-first"]);
  assert.throws(() => scope.defer(() => {}), /closed/i);
});

test("agent registry seals a stable executor and static prompt renders deterministically", async () => {
  const registry = new AgentRegistry();
  let ran = "none";
  const executor = { run: async () => { ran = "original"; return { reason: "completed" as const, steps: 0, toolCalls: 0 }; } };
  registry.register("builtin", executor);
  assert.throws(() => registry.register("builtin", executor), /already registered/i);
  executor.run = async () => { ran = "mutated"; return { reason: "completed" as const, steps: 0, toolCalls: 0 }; };
  registry.seal();
  assert.throws(() => registry.register("late", executor), /sealed/i);
  const stable = registry.require("builtin");
  assert.notEqual(stable, executor);
  await stable.run({} as never);
  assert.equal(ran, "original");

  const prompt = new StaticSystemPrompt([
    { name: "persona", order: 0, text: "Hello {{name}}" },
    { name: "identity", order: -100, text: "Muniu" },
    { name: "empty", order: 1, text: "" }
  ], { name: "Agent" });
  assert.equal(prompt.render(), "Muniu\n\nHello Agent");
  assert.throws(() => new StaticSystemPrompt([{ name: "bad", order: 0, text: "{{missing}}" }]).render(), /unknown prompt variable/i);
});

test("builtin kernel closes cancellation and step/tool budget boundaries", async () => {
  const create = async (scripts: ConstructorParameters<typeof ScriptedLlmAdapter>[1], execute = async () => null) => {
    const llm = new LlmRuntime();
    llm.register(new ScriptedLlmAdapter("mock", scripts));
    llm.seal();
    const tools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
    tools.register(defineTool({ name: "act", description: "Act", risk: "side-effecting", parameters: noArgs, execute }));
    tools.seal();
    return { kernel: createBuiltinAgentKernel({ llm, tools, systemPrompt: new StaticSystemPrompt([]) }), store: new InMemoryAgentSessionStore() };
  };

  const cancelledController = new AbortController();
  const cancelledLlm = new LlmRuntime();
  cancelledLlm.register({
    id: "cancel",
    async *stream() {
      cancelledController.abort();
      yield { type: "text-delta" as const, index: 0, text: "late" };
    }
  });
  cancelledLlm.seal();
  const cancelledTools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  cancelledTools.seal();
  const cancelledSession = await new InMemoryAgentSessionStore().create({ sessionId: SessionId("cancelled") });
  const cancelled = await createBuiltinAgentKernel({ llm: cancelledLlm, tools: cancelledTools, systemPrompt: new StaticSystemPrompt([]) }).run({
    session: cancelledSession,
    prompt: "stop",
    provider: "cancel",
    model: "scripted",
    signal: cancelledController.signal
  });
  assert.equal(cancelled.reason, "cancelled");
  assert.deepEqual(cancelledSession.events.slice(-2).map((event) => event.type), ["step/end", "turn/end"]);

  let stepCalls = 0;
  const stepBound = await create([[
    { type: "tool-call-delta", index: 0, id: CallId("call-step"), name: "act", argumentsDelta: "{}" },
    { type: "finish", reason: "tool-calls" }
  ]], async () => { stepCalls += 1; return null; });
  const stepSession = await stepBound.store.create({ sessionId: SessionId("step-budget") });
  const stepResult = await stepBound.kernel.run({ session: stepSession, prompt: "go", provider: "mock", model: "scripted", maxSteps: 1 });
  assert.equal(stepResult.reason, "budget-exceeded");
  assert.equal(stepCalls, 1);

  let toolCalls = 0;
  const toolBound = await create([[
    { type: "tool-call-delta", index: 0, id: CallId("call-tool"), name: "act", argumentsDelta: "{}" },
    { type: "finish", reason: "tool-calls" }
  ]], async () => { toolCalls += 1; return null; });
  const toolSession = await toolBound.store.create({ sessionId: SessionId("tool-budget") });
  const toolResult = await toolBound.kernel.run({ session: toolSession, prompt: "go", provider: "mock", model: "scripted", maxToolCalls: 0 });
  assert.equal(toolResult.reason, "budget-exceeded");
  assert.equal(toolCalls, 0);
  assert.equal(toolSession.events.some((event) => event.type === "tool/result"), true);
});

test("AgentKernel routes only registered static executors", async () => {
  const registry = new AgentRegistry();
  registry.seal();
  const kernel = new AgentKernel(registry);
  await assert.rejects(
    kernel.run({ agentId: "missing" } as never),
    /not registered/i
  );
});

test("AgentKernel fails closed for concurrent runs on one session while allowing different sessions", async () => {
  let starts = 0;
  let active = 0;
  let maximumActive = 0;
  let firstStarted!: () => void;
  const firstStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const registry = new AgentRegistry();
  registry.register("builtin", {
    run: async (runInput) => {
      starts += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await runInput.session.append("turn/start", { turn: 1 });
      if (starts === 1) firstStarted();
      await gate;
      active -= 1;
      return { reason: "completed", steps: 0, toolCalls: 0 };
    }
  });
  registry.seal();
  const kernel = new AgentKernel(registry);
  const store = new InMemoryAgentSessionStore();
  const firstSession = await store.create({ sessionId: SessionId("kernel-active-first") });
  const secondSession = await store.create({ sessionId: SessionId("kernel-active-second") });
  const input = { agentId: "builtin", prompt: "run", provider: "mock", model: "scripted" };

  const first = kernel.run({ ...input, session: firstSession });
  await firstStart;
  const duplicate = kernel.run({ ...input, session: firstSession });
  void duplicate.catch(() => {});
  const independent = kernel.run({ ...input, session: secondSession });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const startsBeforeRelease = starts;
  release();
  const outcomes = await Promise.allSettled([first, duplicate, independent]);

  assert.equal(startsBeforeRelease, 2);
  assert.equal(maximumActive, 2);
  assert.equal(outcomes[0]?.status, "fulfilled");
  assert.equal(outcomes[1]?.status, "rejected");
  assert.match(String(outcomes[1]?.status === "rejected" ? outcomes[1].reason : ""), /active|already.*run/i);
  assert.equal(outcomes[2]?.status, "fulfilled");
  assert.equal(firstSession.events.filter((event) => event.type === "turn/start").length, 1);
});

test("direct builtin drivers share a process-wide session run lease while different sessions remain concurrent", async () => {
  let dispatches = 0;
  let firstDispatched!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstDispatched = resolve; });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const llm = new LlmRuntime();
  llm.register({
    id: "shared-driver-lease",
    async *stream() {
      dispatches += 1;
      if (dispatches === 1) {
        firstDispatched();
        await firstGate;
      }
      yield { type: "finish" as const, reason: "stop" as const };
    }
  });
  llm.seal();
  const tools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  tools.seal();
  const createDriver = () => createBuiltinAgentKernel({ llm, tools, systemPrompt: new StaticSystemPrompt([]) });
  const firstDriver = createDriver();
  const contenderDriver = createDriver();
  const store = new InMemoryAgentSessionStore();
  const sharedSession = await store.create({ sessionId: SessionId("shared-direct-driver") });
  const independentSession = await store.create({ sessionId: SessionId("independent-direct-driver") });
  const input = { prompt: "run", provider: "shared-driver-lease", model: "scripted" };

  const first = firstDriver.run({ ...input, session: sharedSession });
  await firstStarted;
  const duplicate = contenderDriver.run({ ...input, session: sharedSession });
  void duplicate.catch(() => {});
  const independent = contenderDriver.run({ ...input, session: independentSession });
  await independent;
  const dispatchesBeforeRelease = dispatches;
  releaseFirst();
  const outcomes = await Promise.allSettled([first, duplicate]);

  assert.equal(dispatchesBeforeRelease, 2);
  assert.equal(outcomes[0]?.status, "fulfilled");
  assert.equal(outcomes[1]?.status, "rejected");
  assert.match(String(outcomes[1]?.status === "rejected" ? outcomes[1].reason : ""), /active|already.*run/i);
  assert.equal(sharedSession.events.filter((event) => event.type === "turn/start").length, 1);
});

test("separate AgentKernel instances share the run lease and can reenter a builtin driver once", async () => {
  let starts = 0;
  let firstStarted!: () => void;
  const firstStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const registry = new AgentRegistry();
  registry.register("gated", {
    run: async () => {
      starts += 1;
      if (starts === 1) {
        firstStarted();
        await firstGate;
      }
      return { reason: "completed", steps: 0, toolCalls: 0 };
    }
  });
  registry.seal();
  const firstKernel = new AgentKernel(registry);
  const contenderKernel = new AgentKernel(registry);
  const store = new InMemoryAgentSessionStore();
  const sharedSession = await store.create({ sessionId: SessionId("shared-kernel-instance") });
  const independentSession = await store.create({ sessionId: SessionId("independent-kernel-instance") });
  const input = { agentId: "gated", prompt: "run", provider: "mock", model: "scripted" };

  const first = firstKernel.run({ ...input, session: sharedSession });
  await firstStart;
  const duplicate = contenderKernel.run({ ...input, session: sharedSession });
  void duplicate.catch(() => {});
  await contenderKernel.run({ ...input, session: independentSession });
  const startsBeforeRelease = starts;
  releaseFirst();
  const outcomes = await Promise.allSettled([first, duplicate]);

  assert.equal(startsBeforeRelease, 2);
  assert.equal(outcomes[0]?.status, "fulfilled");
  assert.equal(outcomes[1]?.status, "rejected");

  const llm = new LlmRuntime();
  llm.register(new ScriptedLlmAdapter("nested-driver", [[{ type: "finish", reason: "stop" }]]));
  llm.seal();
  const tools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  tools.seal();
  const nestedRegistry = new AgentRegistry();
  nestedRegistry.register("builtin", createBuiltinAgentKernel({ llm, tools, systemPrompt: new StaticSystemPrompt([]) }));
  nestedRegistry.seal();
  const nestedSession = await store.create({ sessionId: SessionId("kernel-driver-reentry") });
  const nested = await new AgentKernel(nestedRegistry).run({
    agentId: "builtin",
    session: nestedSession,
    prompt: "run",
    provider: "nested-driver",
    model: "scripted"
  });
  assert.equal(nested.reason, "completed");
});

test("kernel delegation admits one driver only across concurrent and sequential handoffs", async () => {
  let dispatches = 0;
  const llm = new LlmRuntime();
  llm.register({
    id: "single-delegation",
    async *stream() {
      dispatches += 1;
      yield { type: "finish" as const, reason: "stop" as const };
    }
  });
  llm.seal();
  const tools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  tools.seal();
  const firstDriver = createBuiltinAgentKernel({ llm, tools, systemPrompt: new StaticSystemPrompt([]) });
  const secondDriver = createBuiltinAgentKernel({ llm, tools, systemPrompt: new StaticSystemPrompt([]) });
  let concurrentOutcomes: PromiseSettledResult<Awaited<ReturnType<typeof firstDriver.run>>>[] = [];
  let sequentialOutcome: PromiseSettledResult<Awaited<ReturnType<typeof firstDriver.run>>> | undefined;
  const registry = new AgentRegistry();
  registry.register("delegating", {
    run: async (input) => {
      concurrentOutcomes = await Promise.allSettled([
        firstDriver.run(input),
        secondDriver.run(input)
      ]);
      [sequentialOutcome] = await Promise.allSettled([firstDriver.run(input)]);
      return { reason: "completed", steps: 0, toolCalls: 0 };
    }
  });
  registry.seal();
  const session = await new InMemoryAgentSessionStore().create({ sessionId: SessionId("single-driver-delegation") });

  const result = await new AgentKernel(registry).run({
    agentId: "delegating",
    session,
    prompt: "run",
    provider: "single-delegation",
    model: "scripted"
  });

  assert.equal(result.reason, "completed");
  assert.equal(concurrentOutcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(concurrentOutcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal(sequentialOutcome?.status, "rejected");
  assert.equal(dispatches, 1);
  assert.equal(session.events.filter((event) => event.type === "turn/start").length, 1);
  assert.doesNotThrow(() => verifyAgentSessionEventChain(session.events));
});

test("kernel lease waits for a detached delegated driver before rejecting an external contender", async () => {
  let dispatches = 0;
  let childEntered!: () => void;
  const childStarted = new Promise<void>((resolve) => { childEntered = resolve; });
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
  const llm = new LlmRuntime();
  llm.register({
    id: "detached-delegation",
    async *stream() {
      dispatches += 1;
      if (dispatches === 1) {
        childEntered();
        await childGate;
      }
      yield { type: "finish" as const, reason: "stop" as const };
    }
  });
  llm.seal();
  const tools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  tools.seal();
  const detachedDriver = createBuiltinAgentKernel({ llm, tools, systemPrompt: new StaticSystemPrompt([]) });
  const contenderDriver = createBuiltinAgentKernel({ llm, tools, systemPrompt: new StaticSystemPrompt([]) });
  let detached!: ReturnType<typeof detachedDriver.run>;
  const registry = new AgentRegistry();
  registry.register("detached", {
    run: async (input) => {
      detached = detachedDriver.run(input);
      void detached.catch(() => {});
      return { reason: "completed", steps: 0, toolCalls: 0 };
    }
  });
  registry.seal();
  const session = await new InMemoryAgentSessionStore().create({ sessionId: SessionId("detached-driver-delegation") });
  let routedSettled = false;
  const routed = new AgentKernel(registry).run({
    agentId: "detached",
    session,
    prompt: "run",
    provider: "detached-delegation",
    model: "scripted"
  }).then((value) => { routedSettled = true; return value; });

  await childStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const routedSettledBeforeChild = routedSettled;
  const [contenderOutcome] = await Promise.allSettled([contenderDriver.run({
    session,
    prompt: "contend",
    provider: "detached-delegation",
    model: "scripted"
  })]);
  releaseChild();
  const [routedOutcome, detachedOutcome] = await Promise.allSettled([routed, detached]);

  assert.equal(routedSettledBeforeChild, false);
  assert.equal(contenderOutcome?.status, "rejected");
  assert.equal(routedOutcome.status, "fulfilled");
  assert.equal(detachedOutcome.status, "fulfilled");
  const after = await contenderDriver.run({
    session,
    prompt: "after",
    provider: "detached-delegation",
    model: "scripted"
  });
  assert.equal(after.reason, "completed");
  assert.equal(dispatches, 2);
});

test("driver start inherited after kernel closure cannot become a standalone run", async () => {
  let dispatches = 0;
  const llm = new LlmRuntime();
  llm.register({
    id: "late-delegation",
    async *stream() {
      dispatches += 1;
      yield { type: "finish" as const, reason: "stop" as const };
    }
  });
  llm.seal();
  const tools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  tools.seal();
  const driver = createBuiltinAgentKernel({ llm, tools, systemPrompt: new StaticSystemPrompt([]) });
  let delayed!: ReturnType<typeof driver.run>;
  const registry = new AgentRegistry();
  registry.register("late", {
    run: async (input) => {
      delayed = new Promise((resolve, reject) => {
        setImmediate(() => { driver.run(input).then(resolve, reject); });
      });
      void delayed.catch(() => {});
      return { reason: "completed", steps: 0, toolCalls: 0 };
    }
  });
  registry.seal();
  const session = await new InMemoryAgentSessionStore().create({ sessionId: SessionId("late-driver-delegation") });

  const routed = await new AgentKernel(registry).run({
    agentId: "late",
    session,
    prompt: "run",
    provider: "late-delegation",
    model: "scripted"
  });
  const [delayedOutcome] = await Promise.allSettled([delayed]);

  assert.equal(routed.reason, "completed");
  assert.equal(delayedOutcome?.status, "rejected");
  assert.equal(dispatches, 0);
  assert.equal(session.events.some((event) => event.type === "turn/start"), false);
});

test("kernel retains the primary executor error while draining a failed delegated driver", async () => {
  const llm = new LlmRuntime();
  llm.register(new ScriptedLlmAdapter("aggregate-delegation", [[{ type: "finish", reason: "stop" }]]));
  llm.seal();
  const tools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  tools.seal();
  const driver = createBuiltinAgentKernel({ llm, tools, systemPrompt: new StaticSystemPrompt([]) });
  const primary = new Error("primary executor failure");
  const registry = new AgentRegistry();
  registry.register("aggregate", {
    run: async (input) => {
      const delegated = driver.run({ ...input, prompt: "" });
      void delegated.catch(() => {});
      throw primary;
    }
  });
  registry.seal();
  const session = await new InMemoryAgentSessionStore().create({ sessionId: SessionId("aggregate-driver-delegation") });

  let failure: unknown;
  try {
    await new AgentKernel(registry).run({
      agentId: "aggregate",
      session,
      prompt: "run",
      provider: "aggregate-delegation",
      model: "scripted"
    });
  } catch (error: unknown) {
    failure = error;
  }

  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.errors[0], primary);
  assert.ok(failure.errors.some((error) => /prompt.*empty|must not be empty/i.test(String(error))));
  assert.equal(failure.cause, primary);
});

test("ReactDriver maps max-tokens finish to budget-exceeded", async () => {
  const llm = new LlmRuntime();
  llm.register(new ScriptedLlmAdapter("max-tokens", [[
    { type: "text-delta", index: 0, text: "partial" },
    { type: "finish", reason: "max-tokens" }
  ]]));
  llm.seal();
  const tools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  tools.seal();
  const session = await new InMemoryAgentSessionStore().create({ sessionId: SessionId("max-tokens-session") });
  const result = await createBuiltinAgentKernel({
    llm,
    tools,
    systemPrompt: new StaticSystemPrompt([])
  }).run({ session, prompt: "continue", provider: "max-tokens", model: "scripted" });

  assert.equal(result.reason, "budget-exceeded");
  const turnEnd = session.events.at(-1);
  assert.equal(turnEnd?.type === "turn/end" ? turnEnd.payload.publicControls.reason : undefined, "budget-exceeded");
});

test("ReactDriver uses the process-local credential-safe overlay instead of durable protected messages", async () => {
  const mobile = "13800138000";
  const identity = "11010519491231002X";
  const credential = "sk-runtime-only-credential-material";
  let observed = "";
  const llm = new LlmRuntime();
  llm.register({
    id: "overlay-capture",
    async *stream(request) {
      const message = request.messages.at(-1);
      const block = message?.content[0];
      observed = block?.type === "text" ? block.text : "";
      yield { type: "text-delta", index: 0, text: "ok" };
      yield { type: "finish", reason: "stop" };
    }
  });
  llm.seal();
  const tools = new ToolRegistry({ authorize: async () => ({ decision: "deny" }) });
  tools.seal();
  const session = await new InMemoryAgentSessionStore().create({ sessionId: SessionId("overlay-capture") });
  await createBuiltinAgentKernel({
    llm,
    tools,
    systemPrompt: new StaticSystemPrompt([])
  }).run({
    session,
    prompt: `Alice alice@example.com phone=${mobile} id=${identity} token=${credential}`,
    provider: "overlay-capture",
    model: "scripted"
  });

  assert.equal(observed.includes(mobile), true);
  assert.equal(observed.includes(identity), true);
  assert.equal(observed.includes("alice@example.com"), true);
  assert.equal(observed.includes(credential), false);
  const durable = JSON.stringify(session.events);
  assert.equal(durable.includes(mobile), false);
  assert.equal(durable.includes(identity), false);
  assert.equal(durable.includes(credential), false);
  assert.equal(durable.includes("alice@example.com"), true);
});

test("ReactDriver refuses reopened protected history before appending or dispatching", async () => {
  const original = await new InMemoryAgentSessionStore().create({ sessionId: SessionId("overlay-required") });
  await original.append("user/message", {
    turn: 1,
    message: {
      id: MessageId("overlay-prior-user"),
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "prior durable message" }]
    }
  });
  const reopened = new DurableAgentSession(original.header, original.events, {
    commitDurable: async () => {},
    flush: async () => {}
  });
  let streamCalls = 0;
  const llm = new LlmRuntime();
  llm.register({
    id: "overlay-required-provider",
    async *stream() {
      streamCalls += 1;
      yield { type: "finish", reason: "stop" };
    }
  });
  llm.seal();
  const tools = new ToolRegistry({ authorize: async () => ({ decision: "deny" }) });
  tools.seal();
  const durableLength = reopened.events.length;
  await assert.rejects(() => createBuiltinAgentKernel({
    llm,
    tools,
    systemPrompt: new StaticSystemPrompt([])
  }).run({
    session: reopened,
    prompt: "resume",
    provider: "overlay-required-provider",
    model: "scripted"
  }), /RUNTIME_OVERLAY_REQUIRED/);
  assert.equal(reopened.events.length, durableLength);
  assert.equal(streamCalls, 0);
});

test("ReactDriver closes every remaining model tool call symmetrically after cancellation", async () => {
  const controller = new AbortController();
  const llm = new LlmRuntime();
  llm.register(new ScriptedLlmAdapter("multi-cancel", [[
    { type: "tool-call-delta", index: 0, id: CallId("cancel-call-1"), name: "act", argumentsDelta: "{}" },
    { type: "tool-call-delta", index: 1, id: CallId("cancel-call-2"), name: "act", argumentsDelta: "{}" },
    { type: "tool-call-delta", index: 2, id: CallId("cancel-call-3"), name: "act", argumentsDelta: "{}" },
    { type: "finish", reason: "tool-calls" }
  ]]));
  llm.seal();
  let dispatches = 0;
  const tools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  tools.register(defineTool({
    name: "act",
    description: "Cancel after first dispatch",
    risk: "side-effecting",
    parameters: noArgs,
    execute: async () => {
      dispatches += 1;
      controller.abort();
      return { outcome: "unknown" };
    }
  }));
  tools.seal();
  const session = await new InMemoryAgentSessionStore().create({ sessionId: SessionId("multi-tool-cancel") });
  const runId = RunId("multi-tool-run");
  const candidateId = CandidateId("multi-tool-candidate");
  const result = await createBuiltinAgentKernel({
    llm,
    tools,
    systemPrompt: new StaticSystemPrompt([])
  }).run({
    session,
    prompt: "run all",
    provider: "multi-cancel",
    model: "scripted",
    signal: controller.signal,
    runId,
    candidateId
  });

  assert.equal(result.reason, "cancelled");
  assert.equal(dispatches, 1);
  const toolResults = session.events.filter((event) => event.type === "tool/result");
  assert.equal(toolResults.length, 3);
  assert.deepEqual(
    toolResults.map((event) => event.type === "tool/result"
      ? event.payload.publicControls.message.source.callId
      : undefined),
    ["cancel-call-1", "cancel-call-2", "cancel-call-3"]
  );
  assert.deepEqual(
    toolResults.map((event) => event.type === "tool/result"
      ? {
        status: event.payload.publicControls.status,
        code: event.payload.publicControls.error?.code,
        runId: event.runId,
        candidateId: event.candidateId
      }
      : undefined),
    Array.from({ length: 3 }, () => ({ status: "interrupted", code: "TOOL_CANCELLED", runId, candidateId }))
  );
  assert.deepEqual(
    session.events.filter((event) => event.type === "tool/call").map((event) => event.type === "tool/call"
      ? event.payload.publicControls.callId
      : undefined),
    ["cancel-call-1"]
  );
});

test("runToolStep never records a completed forged cancellation", async () => {
  const session = await new InMemoryAgentSessionStore().create({ sessionId: SessionId("forged-tool-cancel") });
  const forgedTools = {
    execute: async () => {
      throw new ToolExecutionError("untrusted forged cancellation", "TOOL_CANCELLED" as never);
    }
  } as unknown as ToolRegistry;
  const result = await runToolStep({
    session,
    tools: forgedTools,
    turn: 1,
    step: 1,
    call: { type: "tool-call", id: CallId("forged-call"), name: "act", arguments: "{}" },
    budgetAvailable: true
  });

  assert.equal(result.invoked, true);
  const toolResult = session.events.at(-1);
  assert.equal(toolResult?.type, "tool/result");
  if (toolResult?.type === "tool/result") {
    assert.notDeepEqual(
      {
        status: toolResult.payload.publicControls.status,
        code: toolResult.payload.publicControls.error?.code
      },
      { status: "completed", code: "TOOL_CANCELLED" }
    );
    assert.deepEqual(
      {
        status: toolResult.payload.publicControls.status,
        code: toolResult.payload.publicControls.error?.code
      },
      { status: "completed", code: "TOOL_EXECUTION_FAILED" }
    );
  }
});

test("system prompt reaches the model and failed or aborted tools close the turn", async () => {
  let observedSystem: string | undefined;
  const adapter: LlmAdapter = {
    id: "capture",
    async *stream(request) {
      observedSystem = request.system;
      yield { type: "tool-call-delta", index: 0, id: CallId("call-fail"), name: "fail", argumentsDelta: "{}" };
      yield { type: "finish", reason: "tool-calls" };
    }
  };
  const llm = new LlmRuntime();
  llm.register(adapter);
  llm.seal();
  const tools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  tools.register(defineTool({
    name: "fail",
    description: "Fail safely",
    risk: "side-effecting",
    parameters: noArgs,
    execute: async () => { throw new Error("credential-shaped handler detail must not escape"); }
  }));
  tools.seal();
  const store = new InMemoryAgentSessionStore();
  const failedSession = await store.create({ sessionId: SessionId("failed-tool") });
  const kernel = createBuiltinAgentKernel({
    llm,
    tools,
    systemPrompt: new StaticSystemPrompt([{ name: "identity", order: 0, text: "Muniu {{mode}}" }], { mode: "safe" })
  });
  const failed = await kernel.run({
    session: failedSession,
    prompt: "run",
    provider: "capture",
    model: "scripted",
    maxSteps: 1
  });
  assert.equal(observedSystem, "Muniu safe");
  assert.equal(failed.reason, "budget-exceeded");
  const result = failedSession.events.find((event) => event.type === "tool/result");
  assert.equal(result?.type, "tool/result");
  if (result?.type === "tool/result") {
    assert.equal(result.payload.publicControls.error?.code, "TOOL_EXECUTION_FAILED");
    assert.equal(JSON.stringify(result.payload).includes("credential-shaped"), false);
  }
  assert.deepEqual(failedSession.events.slice(-2).map((event) => event.type), ["step/end", "turn/end"]);

  const controller = new AbortController();
  const abortLlm = new LlmRuntime();
  abortLlm.register(new ScriptedLlmAdapter("abort-tool", [[
    { type: "tool-call-delta", index: 0, id: CallId("call-abort"), name: "abort", argumentsDelta: "{}" },
    { type: "finish", reason: "tool-calls" }
  ]]));
  abortLlm.seal();
  const abortTools = new ToolRegistry({ authorize: async () => ({ decision: "approve" }) });
  abortTools.register(defineTool({
    name: "abort",
    description: "Abort",
    risk: "side-effecting",
    parameters: noArgs,
    execute: async () => { controller.abort(); return null; }
  }));
  abortTools.seal();
  const abortedSession = await store.create({ sessionId: SessionId("aborted-tool") });
  const aborted = await createBuiltinAgentKernel({ llm: abortLlm, tools: abortTools, systemPrompt: new StaticSystemPrompt([]) }).run({
    session: abortedSession,
    prompt: "abort",
    provider: "abort-tool",
    model: "scripted",
    signal: controller.signal
  });
  assert.equal(aborted.reason, "cancelled");
  const abortedResult = abortedSession.events.find((event) => event.type === "tool/result");
  assert.equal(abortedResult?.type, "tool/result");
  if (abortedResult?.type === "tool/result") {
    assert.equal(abortedResult.payload.publicControls.status, "interrupted");
    assert.equal(abortedResult.payload.publicControls.error?.code, "TOOL_CANCELLED");
  }
  assert.equal(abortedSession.events.at(-1)?.type, "turn/end");
});
