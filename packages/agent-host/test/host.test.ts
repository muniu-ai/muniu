import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CallId,
  CandidateId,
  Digest,
  RunId,
  SessionId,
  verifyAgentSessionEventChain,
  type EffectPolicyBindingV1
} from "@mn/agent-protocol";
import {
  InMemoryAgentSessionStore,
  JsonlAgentSessionStore,
  projectSession,
  type AgentSessionStore
} from "@mn/agent-session";
import { ScriptedLlmAdapter, type LlmAdapter } from "@mn/agent-llm";
import { StaticSystemPrompt } from "@mn/agent-kernel";
import { defineTool } from "@mn/agent-tools";
import { createAgentHost, type AgentHostRunInput } from "../src/index.js";

const echoParameters = {
  type: "object" as const,
  properties: { text: { type: "string" as const } },
  required: ["text"],
  additionalProperties: false
};
const effectPolicyBinding: EffectPolicyBindingV1 = Object.freeze({
  governanceDigest: Digest("a".repeat(64)),
  harnessDigest: Digest("b".repeat(64))
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

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
    const mutablePolicyBinding = {
      governanceDigest: Digest("a".repeat(64)),
      harnessDigest: Digest("b".repeat(64))
    };
    try {
      const run = host.run({
        sessionId,
        prompt: "echo hello",
        provider: "mock",
        model: "scripted",
        effectPolicyBinding: mutablePolicyBinding,
        runId,
        candidateId
      });
      mutablePolicyBinding.governanceDigest = Digest("invalid-after-run-returned");
      mutablePolicyBinding.harnessDigest = Digest("invalid-after-run-returned");
      const outcome = await run;
      assert.equal(outcome.reason, "completed");
      assert.equal(durableCallObserved, true);
      assert.deepEqual(outcome.session.events.map((event) => event.type), [
        "session/created",
        "turn/start",
        "user/message",
        "step/start",
        "assistant/message",
        "approval/requested",
        "approval/resolved",
        "tool/call",
        "tool/result",
        "step/end",
        "step/start",
        "assistant/message",
        "step/end",
        "turn/end"
      ]);
      assert.equal(outcome.session.events.slice(1).every((event) => event.runId === runId && event.candidateId === candidateId), true);
    } finally {
      await host.dispose();
    }

    const reopenStore = new JsonlAgentSessionStore(root);
    try {
      const reopened = await reopenStore.open(sessionId);
      assert.doesNotThrow(() => verifyAgentSessionEventChain(reopened.events));
      assert.equal(projectSession(reopened.events).status, "completed");
      const finalMessage = projectSession(reopened.events).messages.at(-1);
      assert.equal(finalMessage?.publicControls.message.role, "assistant");
    } finally {
      await reopenStore.dispose();
    }
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
  assert.equal(outcome.session.header.protectedCwd?.text, "/workspace");
  assert.equal(observedSystem, "bound");
  assert.equal(observedAborted, false);
  await host.dispose();
  await host.dispose();
  assert.deepEqual(disposed, ["capture"]);
  await assert.rejects(() => host.run({ prompt: "late", provider: "capture", model: "scripted" }), /disposed/i);
});

test("host resolves a production adapter per run without taking ownership of it", async () => {
  let resolutions = 0;
  let borrowedDisposals = 0;
  const host = await createAgentHost({
    adapters: [],
    resolveAdapterLease: async ({ providerId, modelId }) => {
      resolutions += 1;
      return {
        adapter: {
          id: providerId,
          async *stream() {
            yield { type: "text-delta" as const, index: 0, text: "resolved" };
            yield { type: "finish" as const, reason: "stop" as const };
          },
          dispose: () => { borrowedDisposals += 100; }
        },
        resolution: {
          schemaVersion: 1 as const,
          kind: "llm-adapter-resolution" as const,
          providerId,
          modelId,
          configDigest: "a".repeat(64)
        },
        release: () => { borrowedDisposals += 1; }
      };
    },
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });
  try {
    const outcome = await host.run({
      sessionId: SessionId("resolved-host-session"),
      prompt: "hello",
      provider: "provider-runtime",
      model: "model-runtime"
    });
    assert.equal(outcome.reason, "completed");
    assert.equal(resolutions, 1);
  } finally {
    await host.dispose();
  }
  assert.equal(borrowedDisposals, 1);
});

test("host resume opens the existing session and appends a second turn", async () => {
  const store = new InMemoryAgentSessionStore();
  const adapter = new ScriptedLlmAdapter("resume-mock", [
    [
      { type: "text-delta", index: 0, text: "first" },
      { type: "finish", reason: "stop" }
    ],
    [
      { type: "text-delta", index: 0, text: "second" },
      { type: "finish", reason: "stop" }
    ]
  ]);
  const sessionId = SessionId("host-resume-session");
  const host = await createAgentHost({
    sessionStore: store,
    adapters: [adapter],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });
  try {
    const first = await host.run({
      sessionId,
      prompt: "one",
      provider: "resume-mock",
      model: "scripted"
    });
    const second = await host.resume({
      sessionId,
      prompt: "two",
      provider: "resume-mock",
      model: "scripted"
    });
    assert.equal(first.session, second.session);
    assert.deepEqual(
      second.session.events
        .filter((event) => event.type === "turn/start")
        .map((event) => event.payload.publicControls.turn),
      [1, 2]
    );
  } finally {
    await host.dispose();
  }
});

test("host resume rejects accessor and proxy inputs without invoking caller code", async () => {
  const host = await createAgentHost({
    adapters: [],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });
  let reads = 0;
  const accessor = Object.defineProperty({}, "sessionId", {
    enumerable: true,
    get() {
      reads += 1;
      return SessionId("unsafe-accessor");
    }
  });
  try {
    await assert.rejects(
      () => host.resume(accessor as never),
      /exact data object/i
    );
    await assert.rejects(
      () => host.resume(new Proxy({}, {}) as never),
      /exact data object/i
    );
    assert.equal(reads, 0);
  } finally {
    await host.dispose();
  }
});

test("host resume uses AbortSignal intrinsics without touching hostile own properties", async () => {
  const store = new InMemoryAgentSessionStore();
  const sessionId = SessionId("host-resume-native-signal");
  await store.create({ sessionId });
  const controller = new AbortController();
  let reads = 0;
  const secret = "RAW-NESTED-SIGNAL-SECRET";
  for (const key of ["aborted", "reason", "addEventListener", "removeEventListener"] as const) {
    Object.defineProperty(controller.signal, key, {
      configurable: true,
      get() {
        reads += 1;
        throw new Error(secret);
      }
    });
  }
  controller.abort(new Error(secret));
  const host = await createAgentHost({
    sessionStore: store,
    adapters: [new ScriptedLlmAdapter("native-signal", [[{ type: "finish", reason: "stop" }]])],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });
  try {
    const outcome = await host.resume({
      sessionId,
      prompt: "cancelled",
      provider: "native-signal",
      model: "test",
      signal: controller.signal
    });
    assert.equal(outcome.reason, "cancelled");
    assert.equal(reads, 0);
    assert.doesNotMatch(JSON.stringify(outcome), new RegExp(secret, "u"));
    const revoked = Proxy.revocable(new AbortController().signal, {});
    revoked.revoke();
    await assert.rejects(
      () => host.resume({
        sessionId,
        prompt: "revoked",
        provider: "native-signal",
        model: "test",
        signal: revoked.proxy
      }),
      (error: unknown) => error instanceof TypeError
        && /native AbortSignal/u.test(error.message)
        && !error.message.includes(secret)
    );
  } finally {
    await host.dispose();
  }
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

test("host aborts an active durable run and retains its writer until the run settles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-host-drain-"));
  const sessionId = SessionId("host-drain-session");
  const entered = deferred();
  const release = deferred();
  let observedSignal: AbortSignal | undefined;
  const adapter: LlmAdapter = {
    id: "gated",
    async *stream(request) {
      observedSignal = request.signal;
      entered.resolve();
      await release.promise;
      yield { type: "finish", reason: "stop" };
    }
  };
  const host = await createAgentHost({
    sessionStore: new JsonlAgentSessionStore(root),
    adapters: [adapter],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });
  const run = host.run({ sessionId, prompt: "wait", provider: "gated", model: "test" });
  await entered.promise;

  let disposeSettled = false;
  const disposal = host.dispose().then(() => { disposeSettled = true; });
  assert.equal(observedSignal?.aborted, true);
  await nextTurn();
  assert.equal(disposeSettled, false);

  const contender = new JsonlAgentSessionStore(root);
  await assert.rejects(() => contender.open(sessionId), /lease|writer/i);
  release.resolve();
  const outcome = await run;
  assert.equal(outcome.reason, "cancelled");
  assert.equal(projectSession(outcome.session.events).status, "cancelled");
  await disposal;

  const transferred = await contender.open(sessionId);
  assert.equal(projectSession(transferred.events).status, "cancelled");
  await contender.dispose();
});

test("host disposal aborts and drains active runs in every session", async () => {
  const entered = [deferred(), deferred()];
  const release = [deferred(), deferred()];
  const signals: Array<AbortSignal | undefined> = [];
  let invocation = 0;
  const host = await createAgentHost({
    adapters: [{
      id: "multi-gated",
      async *stream(request) {
        const index = invocation;
        invocation += 1;
        signals[index] = request.signal;
        entered[index]?.resolve();
        await release[index]?.promise;
        yield { type: "finish", reason: "stop" };
      }
    }],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });
  const runs = [
    host.run({ sessionId: SessionId("host-drain-a"), prompt: "a", provider: "multi-gated", model: "test" }),
    host.run({ sessionId: SessionId("host-drain-b"), prompt: "b", provider: "multi-gated", model: "test" })
  ];
  await Promise.all(entered.map((gate) => gate.promise));

  let disposeSettled = false;
  const disposal = host.dispose().then(() => { disposeSettled = true; });
  assert.deepEqual(signals.map((signal) => signal?.aborted), [true, true]);
  await nextTurn();
  assert.equal(disposeSettled, false);
  release.forEach((gate) => { gate.resolve(); });
  const outcomes = await Promise.all(runs);
  assert.deepEqual(outcomes.map((outcome) => outcome.reason), ["cancelled", "cancelled"]);
  await disposal;
});

test("host registers a run before signal access can reenter disposal", async () => {
  for (const trigger of ["getter", "listener"] as const) {
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    const delegate = new InMemoryAgentSessionStore();
    const store: AgentSessionStore = {
      create: async (options) => {
        entered.resolve();
        await release.promise;
        return delegate.create(options);
      },
      open: delegate.open.bind(delegate),
      dispose: () => { order.push("store"); }
    };
    const host = await createAgentHost({
      sessionStore: store,
      adapters: [{
        id: `signal-${trigger}`,
        async *stream() { throw new Error("a pre-aborted run must not dispatch the adapter"); },
        dispose: () => { order.push("adapter"); }
      }],
      tools: [],
      authorizer: { authorize: async () => ({ decision: "deny" }) }
    });
    const nativeSignal = new AbortController().signal;
    let disposal: Promise<void> | undefined;
    const signal = trigger === "getter"
      ? nativeSignal
      : {
          get aborted() { return nativeSignal.aborted; },
          get reason() { return nativeSignal.reason; },
          addEventListener() { disposal = host.dispose(); },
          removeEventListener() {}
        } as unknown as AbortSignal;
    const input = {
      prompt: "dispose during signal binding",
      provider: `signal-${trigger}`,
      model: "test"
    } as AgentHostRunInput;
    if (trigger === "getter") {
      Object.defineProperty(input, "signal", {
        enumerable: true,
        get() {
          disposal = host.dispose();
          return signal;
        }
      });
    } else {
      Object.defineProperty(input, "signal", { enumerable: true, value: signal });
    }

    const run = host.run(input);
    await entered.promise;
    assert.ok(disposal);
    let disposeSettled = false;
    void disposal.then(() => { disposeSettled = true; });
    await nextTurn();
    assert.equal(disposeSettled, false);
    assert.deepEqual(order, []);

    release.resolve();
    assert.equal((await run).reason, "cancelled");
    await disposal;
    assert.deepEqual(order, ["adapter", "store"]);
    await assert.rejects(
      () => host.run({ prompt: "late", provider: `signal-${trigger}`, model: "test" }),
      /disposed/i
    );
  }
});

test("host synchronously snapshots every run input getter and nested labels", async () => {
  const reads = {
    sessionId: 0,
    cwd: 0,
    labels: 0,
    label: 0,
    prompt: 0,
    provider: 0,
    model: 0,
    signal: 0,
    maxSteps: 0,
    maxToolCalls: 0,
    runId: 0,
    candidateId: 0,
    effectPolicyBinding: 0
  };
  let sessionId = SessionId("snapshotted-host-input");
  let cwd = "/original";
  let label = "original";
  const labels = Object.defineProperty({}, "source", {
    enumerable: true,
    get() { reads.label += 1; return label; }
  }) as Record<string, string>;
  let prompt = "original prompt";
  let provider = "snapshot-input";
  let model = "original-model";
  let signal: AbortSignal = new AbortController().signal;
  let maxSteps = 2;
  let maxToolCalls = 0;
  let runId = RunId("original-run");
  let candidateId = CandidateId("original-candidate");
  let policyBinding: EffectPolicyBindingV1 = effectPolicyBinding;
  let observedModel: string | undefined;
  const host = await createAgentHost({
    adapters: [{
      id: provider,
      async *stream(request) {
        observedModel = request.model;
        yield { type: "finish", reason: "stop" };
      }
    }],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });
  const input = {
    get sessionId() { reads.sessionId += 1; return sessionId; },
    get cwd() { reads.cwd += 1; return cwd; },
    get labels() { reads.labels += 1; return labels; },
    get prompt() { reads.prompt += 1; return prompt; },
    get provider() { reads.provider += 1; return provider; },
    get model() { reads.model += 1; return model; },
    get signal() { reads.signal += 1; return signal; },
    get maxSteps() { reads.maxSteps += 1; return maxSteps; },
    get maxToolCalls() { reads.maxToolCalls += 1; return maxToolCalls; },
    get runId() { reads.runId += 1; return runId; },
    get candidateId() { reads.candidateId += 1; return candidateId; },
    get effectPolicyBinding() { reads.effectPolicyBinding += 1; return policyBinding; }
  } satisfies AgentHostRunInput;

  const run = host.run(input);
  const readsWhenRunReturned = { ...reads };
  sessionId = SessionId("mutated-session");
  cwd = "/mutated";
  label = "mutated";
  prompt = "mutated prompt";
  provider = "mutated-provider";
  model = "mutated-model";
  signal = AbortSignal.abort();
  maxSteps = 99;
  maxToolCalls = 99;
  runId = RunId("mutated-run");
  candidateId = CandidateId("mutated-candidate");
  policyBinding = {
    governanceDigest: Digest("invalid"),
    harnessDigest: Digest("invalid")
  };

  const outcome = await run;
  assert.deepEqual(readsWhenRunReturned, {
    sessionId: 1,
    cwd: 1,
    labels: 1,
    label: 1,
    prompt: 1,
    provider: 1,
    model: 1,
    signal: 1,
    maxSteps: 1,
    maxToolCalls: 1,
    runId: 1,
    candidateId: 1,
    effectPolicyBinding: 1
  });
  assert.deepEqual(reads, readsWhenRunReturned);
  assert.equal(outcome.reason, "completed");
  assert.equal(outcome.session.header.sessionId, SessionId("snapshotted-host-input"));
  assert.equal(outcome.session.header.protectedCwd?.text, "/original");
  assert.equal(outcome.session.events[0]?.type === "session/created"
    ? JSON.stringify(outcome.session.events[0].payload).includes("original")
    : false, true);
  assert.deepEqual(outcome.session.runtimeMessages()[0]?.content, [
    { type: "text", text: "original prompt" }
  ]);
  assert.equal(observedModel, "original-model");
  assert.equal(outcome.session.events.slice(1).every((event) => {
    return event.runId === RunId("original-run") && event.candidateId === CandidateId("original-candidate");
  }), true);
  await host.dispose();
});

test("host rejects reentrant disposal from its active run without self-deadlocking", async () => {
  let host: Awaited<ReturnType<typeof createAgentHost>>;
  let reentrantOutcome: "rejected" | "resolved" | "timed-out" | undefined;
  host = await createAgentHost({
    adapters: [{
      id: "reentrant",
      async *stream() {
        reentrantOutcome = await Promise.race([
          host.dispose().then(() => "resolved" as const, (error: unknown) => {
            assert.match(error instanceof Error ? error.message : String(error), /reentrant|active host run/i);
            return "rejected" as const;
          }),
          new Promise<"timed-out">((resolve) => { setTimeout(() => { resolve("timed-out"); }, 250); })
        ]);
        yield { type: "finish", reason: "stop" };
      }
    }],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });

  const outcome = await host.run({ prompt: "dispose", provider: "reentrant", model: "test" });
  assert.equal(outcome.reason, "completed");
  assert.equal(reentrantOutcome, "rejected");
  await host.dispose();
});

test("abort listeners reject nested disposal while external callers share one coordinator", async () => {
  const entered = deferred();
  const releaseRun = deferred();
  const order: string[] = [];
  const delegate = new InMemoryAgentSessionStore();
  let reportNested!: (outcome: "rejected" | "resolved") => void;
  const nestedOutcome = new Promise<"rejected" | "resolved">((resolve) => {
    reportNested = resolve;
  });
  let nestedDisposal: Promise<void> | undefined;
  let host: Awaited<ReturnType<typeof createAgentHost>>;
  host = await createAgentHost({
    sessionStore: {
      create: delegate.create.bind(delegate),
      open: delegate.open.bind(delegate),
      dispose: () => { order.push("store"); }
    },
    adapters: [{
      id: "abort-reentrant",
      async *stream(request) {
        request.signal?.addEventListener("abort", async () => {
          nestedDisposal = host.dispose();
          const outcome = await nestedDisposal.then(
            () => "resolved" as const,
            (error: unknown) => {
              assert.match(error instanceof Error ? error.message : String(error), /reentrant|active host run/i);
              return "rejected" as const;
            }
          );
          reportNested(outcome);
          releaseRun.resolve();
        }, { once: true });
        entered.resolve();
        await releaseRun.promise;
        yield { type: "finish", reason: "stop" };
      },
      dispose: () => { order.push("adapter"); }
    }],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });

  const run = host.run({ prompt: "nested dispose", provider: "abort-reentrant", model: "test" });
  await entered.promise;
  const externalDisposal = host.dispose();
  assert.equal(host.dispose(), externalDisposal);
  const observed = await Promise.race([
    nestedOutcome,
    new Promise<"timed-out">((resolve) => {
      setTimeout(() => { resolve("timed-out"); }, 100);
    })
  ]);
  if (observed === "timed-out") releaseRun.resolve();
  const [runResult, disposalResult] = await Promise.allSettled([run, externalDisposal]);

  assert.equal(observed, "rejected");
  assert.ok(nestedDisposal);
  assert.notEqual(nestedDisposal, externalDisposal);
  assert.equal(runResult.status, "fulfilled");
  if (runResult.status === "fulfilled") assert.equal(runResult.value.reason, "cancelled");
  assert.equal(disposalResult.status, "fulfilled");
  assert.deepEqual(order, ["adapter", "store"]);
});

test("abort callback failures release the drain gate and reject the stable disposal coordinator", async () => {
  const entered = deferred();
  const releaseRun = deferred();
  const order: string[] = [];
  const abortFailure = new Error("abort callback failed");
  const delegate = new InMemoryAgentSessionStore();
  const host = await createAgentHost({
    sessionStore: {
      create: delegate.create.bind(delegate),
      open: delegate.open.bind(delegate),
      dispose: () => { order.push("store"); }
    },
    adapters: [{
      id: "throwing-abort",
      async *stream() {
        entered.resolve();
        await releaseRun.promise;
        yield { type: "finish", reason: "stop" };
      },
      dispose: () => { order.push("adapter"); }
    }],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });

  const run = host.run({ prompt: "abort failure", provider: "throwing-abort", model: "test" });
  await entered.promise;
  const active = [...(host as unknown as {
    activeRuns: ReadonlySet<{ readonly controller: AbortController }>;
  }).activeRuns][0];
  assert.ok(active);
  const originalAbort = active.controller.abort.bind(active.controller);
  Object.defineProperty(active.controller, "abort", {
    configurable: true,
    value: () => {
      originalAbort();
      throw abortFailure;
    }
  });

  let synchronousFailure: unknown;
  let disposal: Promise<void> | undefined;
  try {
    disposal = host.dispose();
  } catch (error: unknown) {
    synchronousFailure = error;
  } finally {
    delete (active.controller as { abort?: () => void }).abort;
  }
  const cachedDisposal = host.dispose();
  releaseRun.resolve();
  const [runResult, disposalResult] = await Promise.allSettled([run, cachedDisposal]);

  assert.equal(synchronousFailure, undefined);
  assert.ok(disposal);
  assert.equal(cachedDisposal, disposal);
  assert.equal(runResult.status, "fulfilled");
  assert.equal(disposalResult.status, "rejected");
  if (disposalResult.status === "rejected") assert.equal(disposalResult.reason, abortFailure);
  assert.deepEqual(order, ["adapter", "store"]);
});

test("host snapshots and binds every session store method exactly once", async () => {
  const delegate = new InMemoryAgentSessionStore();
  const reads = { create: 0, open: 0, dispose: 0 };
  const calls = { create: 0, open: 0, dispose: 0 };
  let generation = 0;
  let source!: AgentSessionStore;
  source = {
    get create() {
      reads.create += 1;
      const snapshot = generation;
      return async function create(
        this: AgentSessionStore,
        options: Parameters<AgentSessionStore["create"]>[0]
      ) {
        assert.equal(this, source);
        assert.equal(snapshot, 0, "host reread a mutated create method");
        calls.create += 1;
        return delegate.create(options);
      };
    },
    get open() {
      reads.open += 1;
      const snapshot = generation;
      return async function open(
        this: AgentSessionStore,
        sessionId: Parameters<AgentSessionStore["open"]>[0]
      ) {
        assert.equal(this, source);
        assert.equal(snapshot, 0, "host reread a mutated open method");
        calls.open += 1;
        return delegate.open(sessionId);
      };
    },
    get dispose() {
      reads.dispose += 1;
      const snapshot = generation;
      return function dispose(this: AgentSessionStore) {
        assert.equal(this, source);
        assert.equal(snapshot, 0, "host reread a mutated dispose method");
        calls.dispose += 1;
      };
    }
  };

  const host = await createAgentHost({
    sessionStore: source,
    adapters: [new ScriptedLlmAdapter("stable-store", [[{ type: "finish", reason: "stop" }]])],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });
  assert.deepEqual(reads, { create: 1, open: 1, dispose: 1 });
  generation = 1;
  const outcome = await host.run({ prompt: "stable", provider: "stable-store", model: "test" });
  assert.equal(outcome.reason, "completed");
  await host.dispose();
  await host.dispose();
  assert.deepEqual(reads, { create: 1, open: 1, dispose: 1 });
  assert.deepEqual(calls, { create: 1, open: 0, dispose: 1 });
});

test("host bridges external cancellation and removes its listener after settlement", async () => {
  const entered = deferred();
  const release = deferred();
  const externalController = new AbortController();
  const nativeSignal = externalController.signal;
  let listenersAdded = 0;
  let listenersRemoved = 0;
  const externalSignal = {
    get aborted() { return nativeSignal.aborted; },
    get reason() { return nativeSignal.reason; },
    addEventListener(
      type: "abort",
      listener: (this: AbortSignal, event: Event) => unknown,
      options?: boolean | AddEventListenerOptions
    ) {
      listenersAdded += 1;
      nativeSignal.addEventListener(type, listener, options);
    },
    removeEventListener(
      type: "abort",
      listener: (this: AbortSignal, event: Event) => unknown,
      options?: boolean | EventListenerOptions
    ) {
      listenersRemoved += 1;
      nativeSignal.removeEventListener(type, listener, options);
    }
  } as unknown as AbortSignal;
  let internalSignal: AbortSignal | undefined;
  const host = await createAgentHost({
    adapters: [{
      id: "external-abort",
      async *stream(request) {
        internalSignal = request.signal;
        entered.resolve();
        await release.promise;
        yield { type: "finish", reason: "stop" };
      }
    }],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });
  const run = host.run({
    prompt: "cancel",
    provider: "external-abort",
    model: "test",
    signal: externalSignal
  });
  await entered.promise;
  externalController.abort();
  assert.equal(internalSignal?.aborted, true);
  release.resolve();
  assert.equal((await run).reason, "cancelled");
  assert.equal(listenersAdded, 1);
  assert.equal(listenersRemoved, 1);
  await host.dispose();
});

test("host removes a partially registered external abort listener while preserving the registration error", async () => {
  const primary = new Error("listener registration failed");
  const nativeController = new AbortController();
  let listenersAdded = 0;
  let listenersRemoved = 0;
  const externalSignal = {
    get aborted() { return nativeController.signal.aborted; },
    get reason() { return nativeController.signal.reason; },
    addEventListener(
      type: "abort",
      listener: (this: AbortSignal, event: Event) => unknown,
      options?: boolean | AddEventListenerOptions
    ) {
      listenersAdded += 1;
      nativeController.signal.addEventListener(type, listener, options);
      throw primary;
    },
    removeEventListener(
      type: "abort",
      listener: (this: AbortSignal, event: Event) => unknown,
      options?: boolean | EventListenerOptions
    ) {
      listenersRemoved += 1;
      nativeController.signal.removeEventListener(type, listener, options);
    }
  } as unknown as AbortSignal;
  const host = await createAgentHost({
    adapters: [],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });

  let failure: unknown;
  try {
    await host.run({ prompt: "register", provider: "unused", model: "test", signal: externalSignal });
  } catch (error: unknown) {
    failure = error;
  }
  assert.equal(failure, primary);
  assert.equal(listenersAdded, 1);
  assert.equal(listenersRemoved, 1);
  nativeController.abort();
  const firstDisposal = host.dispose();
  assert.equal(host.dispose(), firstDisposal);
  await firstDisposal;
});

test("host retains a primary run failure when external listener cleanup also fails", async () => {
  const primary = new Error("primary session creation failed");
  const cleanup = new Error("listener cleanup failed");
  let storeDisposals = 0;
  const host = await createAgentHost({
    sessionStore: {
      create: async () => { throw primary; },
      open: async () => { throw new Error("unused"); },
      dispose: () => { storeDisposals += 1; }
    },
    adapters: [],
    tools: [],
    authorizer: { authorize: async () => ({ decision: "deny" }) }
  });
  const externalSignal = {
    aborted: false,
    reason: undefined,
    addEventListener() {},
    removeEventListener() { throw cleanup; }
  } as unknown as AbortSignal;

  let failure: unknown;
  try {
    await host.run({ prompt: "fail", provider: "unused", model: "test", signal: externalSignal });
  } catch (error: unknown) {
    failure = error;
  }
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [primary, cleanup]);
  assert.equal(failure.cause, primary);
  assert.equal(
    (host as unknown as { activeRuns: ReadonlySet<unknown> }).activeRuns.size,
    0
  );

  const firstDisposal = host.dispose();
  assert.equal(host.dispose(), firstDisposal);
  await firstDisposal;
  assert.equal(storeDisposals, 1);
});

test("host validates stable session store methods and aggregates rollback failures", async () => {
  const cleanupFailure = new Error("store cleanup failed");
  let disposeCalls = 0;
  const invalidCreate = {
    create: 1,
    open: async () => { throw new Error("unused"); },
    dispose: () => {
      disposeCalls += 1;
      throw cleanupFailure;
    }
  } as unknown as AgentSessionStore;
  await assert.rejects(
    () => createAgentHost({
      sessionStore: invalidCreate,
      adapters: [],
      tools: [],
      authorizer: { authorize: async () => ({ decision: "deny" }) }
    }),
    (error: unknown) => error instanceof AggregateError
      && error.errors.length === 2
      && error.cause === error.errors[0]
      && error.errors[0] instanceof TypeError
      && /store create/i.test(error.errors[0].message)
      && error.errors[1] === cleanupFailure
  );
  assert.equal(disposeCalls, 1);

  await assert.rejects(
    () => createAgentHost({
      sessionStore: {
        create: async () => { throw new Error("unused"); },
        open: 1
      } as unknown as AgentSessionStore,
      adapters: [],
      tools: [],
      authorizer: { authorize: async () => ({ decision: "deny" }) }
    }),
    /store open.*function/i
  );
  await assert.rejects(
    () => createAgentHost({
      sessionStore: {
        create: async () => { throw new Error("unused"); },
        open: async () => { throw new Error("unused"); },
        dispose: 1
      } as unknown as AgentSessionStore,
      adapters: [],
      tools: [],
      authorizer: { authorize: async () => ({ decision: "deny" }) }
    }),
    /store dispose.*function/i
  );
});
