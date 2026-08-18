import assert from "node:assert/strict";
import test from "node:test";

import { CallId, MessageId, type LlmRequest, type StreamChunk } from "@mn/agent-protocol";
import {
  BlockAssembler,
  LlmRuntime,
  ScriptedLlmAdapter,
  type LlmAdapterLease
} from "../src/index.js";

const request: LlmRequest = { provider: "mock", model: "scripted", messages: [] };

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function adapterLease(
  providerId: string,
  modelId: string,
  stream: LlmAdapterLease["adapter"]["stream"],
  release: () => void = () => undefined
): LlmAdapterLease {
  return {
    adapter: { id: providerId, stream },
    resolution: {
      schemaVersion: 1,
      kind: "llm-adapter-resolution",
      providerId,
      modelId,
      configDigest: "a".repeat(64)
    },
    release
  };
}

test("assembler combines text, thinking, tool calls, usage, and terminal state", () => {
  const assembler = new BlockAssembler();
  assembler.push({ type: "text-delta", index: 0, text: "hel" });
  assembler.push({ type: "text-delta", index: 0, text: "lo" });
  assembler.push({ type: "thinking-delta", index: 1, text: "plan" });
  assembler.push({ type: "tool-call-delta", index: 2, id: CallId("call-1"), name: "read", argumentsDelta: "{\"path\":" });
  assembler.push({ type: "tool-call-delta", index: 2, id: CallId("call-1"), argumentsDelta: "\"a\"}" });
  assembler.push({ type: "usage", usage: { inputTokens: 2, outputTokens: 4, thinkingTokens: 1 } });
  assembler.push({ type: "finish", reason: "tool-calls" });

  assert.deepEqual(assembler.blocks(), [
    { type: "text", text: "hello" },
    { type: "thinking", text: "plan" },
    { type: "tool-call", id: "call-1", name: "read", arguments: "{\"path\":\"a\"}" }
  ]);
  assert.deepEqual(assembler.usage, { inputTokens: 2, outputTokens: 4, thinkingTokens: 1 });
  assert.equal(assembler.finish, "tool-calls");
  const message = assembler.message({ kind: "model", provider: "mock", model: "scripted" }, MessageId("assistant-1"));
  assert.equal(Object.isFrozen(message.content), true);
});

test("assembler default message IDs cannot resemble protected numeric material", () => {
  const assembler = new BlockAssembler();
  assembler.push({ type: "text-delta", index: 0, text: "safe" });
  assembler.push({ type: "finish", reason: "stop" });
  for (let index = 0; index < 1_000; index += 1) {
    const message = assembler.message({ kind: "model", provider: "mock", model: "scripted" });
    assert.match(message.id, /^assistant-[wxyz]{64}$/u);
  }
});

test("assembler records errors and drops an incomplete tool call at max tokens", () => {
  const assembler = new BlockAssembler();
  assembler.push({ type: "tool-call-delta", index: 0, id: CallId("call-1"), name: "write", argumentsDelta: "{" });
  assembler.push({ type: "error", error: { code: "UPSTREAM", message: "provider stopped" } });
  assembler.push({ type: "finish", reason: "max-tokens" });
  assert.deepEqual(assembler.blocks(), []);
  assert.deepEqual(assembler.error, { code: "UPSTREAM", message: "provider stopped" });
});

test("assembler snapshots and freezes block, usage, and error push boundaries", () => {
  const assembler = new BlockAssembler();
  const block = { type: "text" as const, text: "stable" };
  const usage = { inputTokens: 2, outputTokens: 3, thinkingTokens: 1 };
  const error = { code: "UPSTREAM", message: "stable error", retryable: true };
  assembler.push({ type: "block-end", index: 0, block });
  assembler.push({ type: "usage", usage });
  assembler.push({ type: "error", error });

  block.text = "mutated";
  usage.outputTokens = 99;
  error.message = "mutated error";
  const blocks = assembler.blocks();
  assert.deepEqual(blocks, [{ type: "text", text: "stable" }]);
  assert.deepEqual(assembler.usage, { inputTokens: 2, outputTokens: 3, thinkingTokens: 1 });
  assert.deepEqual(assembler.error, { code: "UPSTREAM", message: "stable error", retryable: true });
  assert.equal(Object.isFrozen(blocks), true);
  assert.equal(Object.isFrozen(blocks[0]), true);
  assert.equal(Object.isFrozen(assembler.usage), true);
  assert.equal(Object.isFrozen(assembler.error), true);
  assert.throws(() => { (blocks[0] as { text: string }).text = "caller mutation"; }, TypeError);
});

test("assembler rejects non-lossless block, usage, and error boundary values", () => {
  assert.throws(() => new BlockAssembler().push({
    type: "block-end",
    index: 0,
    block: { type: "text", text: "x", invalid: undefined }
  } as never), /block.*lossless|lossless.*block/i);
  assert.throws(() => new BlockAssembler().push({
    type: "usage",
    usage: { inputTokens: 1, outputTokens: 1, invalid: 1n }
  } as never), /usage.*lossless|lossless.*usage/i);
  assert.throws(() => new BlockAssembler().push({
    type: "error",
    error: { code: "UPSTREAM", message: "x", invalid: undefined }
  } as never), /error.*lossless|lossless.*error/i);
});

test("assembler rejects block conflicts, incomplete tool calls, and chunks after finish", () => {
  const conflict = new BlockAssembler();
  conflict.push({ type: "text-delta", index: 0, text: "text" });
  assert.throws(() => conflict.push({ type: "thinking-delta", index: 0, text: "thinking" }), /block type conflict/i);

  const incomplete = new BlockAssembler();
  incomplete.push({ type: "tool-call-delta", index: 0, id: CallId("call-1"), argumentsDelta: "{}" });
  assert.throws(() => incomplete.blocks(), /tool call.*name/i);
  const invalidEnd = new BlockAssembler();
  assert.throws(() => invalidEnd.push({
    type: "block-end",
    index: 0,
    block: { type: "tool-call", id: CallId(""), name: "", arguments: "{}" }
  }), /tool call.*(?:id|name)/i);

  const conflictingId = new BlockAssembler();
  conflictingId.push({ type: "tool-call-delta", index: 0, id: CallId("call-1"), name: "read", argumentsDelta: "{" });
  assert.throws(
    () => conflictingId.push({ type: "tool-call-delta", index: 0, id: CallId("call-2"), name: "read", argumentsDelta: "}" }),
    /tool call.*id.*conflict/i
  );
  const conflictingName = new BlockAssembler();
  conflictingName.push({ type: "tool-call-delta", index: 0, id: CallId("call-1"), name: "read", argumentsDelta: "{}" });
  assert.throws(
    () => conflictingName.push({ type: "tool-call-delta", index: 0, id: CallId("call-1"), name: "write", argumentsDelta: "" }),
    /tool call.*name.*conflict/i
  );
  const emptyId = new BlockAssembler();
  assert.throws(
    () => emptyId.push({ type: "tool-call-delta", index: 0, id: CallId(""), name: "read", argumentsDelta: "{}" }),
    /tool call.*id/i
  );
  const conflictingEnd = new BlockAssembler();
  conflictingEnd.push({ type: "tool-call-delta", index: 0, id: CallId("call-1"), name: "read", argumentsDelta: "{" });
  assert.throws(() => conflictingEnd.push({
    type: "block-end",
    index: 0,
    block: { type: "tool-call", id: CallId("call-1"), name: "read", arguments: "{}" }
  }), /block end.*conflict/i);

  const terminal = new BlockAssembler();
  terminal.push({ type: "finish", reason: "stop" });
  assert.throws(() => terminal.push({ type: "text-delta", index: 0, text: "late" }), /after finish/i);
});

test("LLM runtime is static, sealed, and normalizes adapter failures", async () => {
  const runtime = new LlmRuntime();
  const adapter = new ScriptedLlmAdapter("mock", [[
    { type: "text-delta", index: 0, text: "ok" },
    { type: "finish", reason: "stop" }
  ]]);
  const dispose = runtime.register(adapter);
  assert.throws(() => runtime.register(adapter), /already registered/i);
  runtime.seal();
  assert.throws(() => runtime.register(new ScriptedLlmAdapter("late", [[]])), /sealed/i);
  assert.deepEqual(await collect(runtime.stream(request)), [
    { type: "text-delta", index: 0, text: "ok" },
    { type: "finish", reason: "stop" }
  ]);
  dispose();
  await assert.rejects(async () => collect(runtime.stream(request)), /not registered/i);

  const broken = new LlmRuntime();
  broken.register({
    id: "broken",
    async *stream(): AsyncIterable<StreamChunk> {
      throw new Error("secret-provider-credential");
    }
  });
  const failed = await collect(broken.stream({ ...request, provider: "broken" }));
  assert.deepEqual(failed, [
    { type: "error", error: { code: "LLM_STREAM_FAILED", message: "Model stream failed" } },
    { type: "finish", reason: "error" }
  ]);
  assert.equal(JSON.stringify(failed).includes("secret-provider-credential"), false);
});

test("LLM runtime resolves one borrowed exact adapter for every stream", async () => {
  const calls: string[] = [];
  let releases = 0;
  const runtime = new LlmRuntime({
    resolveAdapterLease: async (input) => {
      calls.push(`${input.providerId}:${input.modelId}`);
      return adapterLease(
        input.providerId,
        input.modelId,
        async function* (): AsyncIterable<StreamChunk> {
          yield { type: "text-delta", index: 0, text: input.providerId };
          yield { type: "finish", reason: "stop" };
        },
        () => { releases += 1; }
      );
    }
  });
  runtime.seal();

  const [first, duplicate, second] = await Promise.all([
    collect(runtime.stream({ ...request, provider: "provider-first" })),
    collect(runtime.stream({ ...request, provider: "provider-first" })),
    collect(runtime.stream({ ...request, provider: "provider-second" }))
  ]);
  assert.equal(first[0]?.type === "text-delta" ? first[0].text : undefined, "provider-first");
  assert.deepEqual(duplicate, first);
  assert.equal(second[0]?.type === "text-delta" ? second[0].text : undefined, "provider-second");
  assert.deepEqual(calls.sort(), [
    "provider-first:scripted",
    "provider-first:scripted",
    "provider-second:scripted"
  ]);
  assert.equal(releases, 3);
});

test("LLM runtime releases a borrowed adapter without replacing its completed terminal", async () => {
  let releases = 0;
  const runtime = new LlmRuntime({
    resolveAdapterLease: async (input) => adapterLease(
      input.providerId,
      input.modelId,
      async function* (): AsyncIterable<StreamChunk> {
        yield { type: "text-delta", index: 0, text: "complete" };
        yield { type: "finish", reason: "stop" };
      },
      () => {
        releases += 1;
        throw new Error("RAW-LEASE-RELEASE-SECRET");
      }
    )
  });

  assert.deepEqual(await collect(runtime.stream({ ...request, provider: "provider-release" })), [
    { type: "text-delta", index: 0, text: "complete" },
    { type: "finish", reason: "stop" }
  ]);
  assert.equal(releases, 1);
});

test("LLM runtime rejects mismatched and hostile resolved adapters without invoking accessors", async () => {
  let idReads = 0;
  const accessor = Object.defineProperty({
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "finish", reason: "stop" };
    }
  }, "id", {
    enumerable: true,
    get() {
      idReads += 1;
      throw new Error("RAW-ADAPTER-SECRET");
    }
  });
  const values: unknown[] = [
    { id: "different-provider", async *stream() { yield { type: "finish" as const, reason: "stop" as const }; } },
    accessor,
    new Proxy({ id: "provider-hostile", async *stream() { yield { type: "finish" as const, reason: "stop" as const }; } }, {
      getOwnPropertyDescriptor() {
        throw new Error("RAW-PROXY-SECRET");
      }
    })
  ];
  for (const value of values) {
    const runtime = new LlmRuntime({
      resolveAdapterLease: async () => ({
        adapter: value as never,
        resolution: {
          schemaVersion: 1,
          kind: "llm-adapter-resolution",
          providerId: "provider-hostile",
          modelId: "scripted",
          configDigest: "a".repeat(64)
        },
        release: () => undefined
      })
    });
    await assert.rejects(
      collect(runtime.stream({ ...request, provider: "provider-hostile" })),
      (error: unknown) => error instanceof Error
        && error.message === "LLM adapter resolution failed"
        && !error.message.includes("RAW-")
    );
  }
  assert.equal(idReads, 0);
});

test("LLM runtime never resolves an adapter for a pre-aborted request", async () => {
  const controller = new AbortController();
  controller.abort();
  let resolutions = 0;
  const runtime = new LlmRuntime({
    resolveAdapterLease: async () => {
      resolutions += 1;
      throw new Error("must not resolve");
    }
  });
  assert.deepEqual(await collect(runtime.stream({
    ...request,
    provider: "provider-aborted",
    signal: controller.signal
  })), [
    { type: "error", error: { code: "LLM_CANCELLED", message: "Model stream cancelled" } },
    { type: "finish", reason: "cancelled" }
  ]);
  assert.equal(resolutions, 0);
});

test("LLM runtime cancels during adapter resolution and absorbs a late resolver rejection", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const resolutionStarted = new Promise<void>((resolve) => { started = resolve; });
  let rejectLate!: (error: Error) => void;
  const late = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
  const runtime = new LlmRuntime({
    resolveAdapterLease: async () => {
      started();
      return late;
    }
  });
  const operation = collect(runtime.stream({
    ...request,
    provider: "provider-cancelling",
    signal: controller.signal
  }));
  await resolutionStarted;
  controller.abort();
  assert.deepEqual(await operation, [
    { type: "error", error: { code: "LLM_CANCELLED", message: "Model stream cancelled" } },
    { type: "finish", reason: "cancelled" }
  ]);
  rejectLate(new Error("RAW-LATE-RESOLVER-SECRET"));
  await new Promise<void>((resolve) => { setImmediate(resolve); });
});

test("LLM runtime emits one safe terminal for provider errors and post-finish throws", async () => {
  const afterFinish = new LlmRuntime();
  afterFinish.register({
    id: "after-finish",
    async *stream(): AsyncIterable<StreamChunk> {
      try {
        yield { type: "finish", reason: "stop" };
      } finally {
        throw new Error("iterator close failure must never add another terminal");
      }
    }
  });
  assert.deepEqual(await collect(afterFinish.stream({ ...request, provider: "after-finish" })), [
    { type: "finish", reason: "stop" }
  ]);

  const providerError = new LlmRuntime();
  providerError.register({
    id: "provider-error",
    async *stream(): AsyncIterable<StreamChunk> {
      yield {
        type: "error",
        error: {
          code: "SECRET_INTERNAL_CODE",
          message: "api_key=provider-secret",
          status: 429,
          retryable: true
        }
      };
      yield { type: "finish", reason: "stop" };
    }
  });
  const chunks = await collect(providerError.stream({ ...request, provider: "provider-error" }));
  assert.deepEqual(chunks, [
    {
      type: "error",
      error: {
        code: "LLM_PROVIDER_ERROR",
        message: "Model provider returned an error",
        status: 429,
        retryable: true
      }
    },
    { type: "finish", reason: "error" }
  ]);
  assert.equal(JSON.stringify(chunks).includes("provider-secret"), false);
  assert.equal(chunks.filter((chunk) => chunk.type === "finish").length, 1);
});

test("LLM runtime emits one cancelled terminal when an aborted stream exhausts normally", async () => {
  const controller = new AbortController();
  const runtime = new LlmRuntime();
  runtime.register({
    id: "normal-abort",
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "text-delta", index: 0, text: "partial" };
      controller.abort();
    }
  });

  const chunks = await collect(runtime.stream({
    ...request,
    provider: "normal-abort",
    signal: controller.signal
  }));
  assert.deepEqual(chunks, [
    { type: "text-delta", index: 0, text: "partial" },
    { type: "error", error: { code: "LLM_CANCELLED", message: "Model stream cancelled" } },
    { type: "finish", reason: "cancelled" }
  ]);
  assert.equal(chunks.filter((chunk) => chunk.type === "finish").length, 1);
});

test("LLM runtime does not dispatch a pre-aborted request", async () => {
  const controller = new AbortController();
  controller.abort();
  let dispatches = 0;
  const runtime = new LlmRuntime();
  runtime.register({
    id: "pre-abort",
    stream(): AsyncIterable<StreamChunk> {
      dispatches += 1;
      throw new Error("pre-aborted adapter must not be called");
    }
  });

  const chunks = await collect(runtime.stream({
    ...request,
    provider: "pre-abort",
    signal: controller.signal
  }));
  assert.equal(dispatches, 0);
  assert.deepEqual(chunks, [
    { type: "error", error: { code: "LLM_CANCELLED", message: "Model stream cancelled" } },
    { type: "finish", reason: "cancelled" }
  ]);
});

test("LLM runtime reads AbortSignal state without invoking a hostile instance accessor", async () => {
  const controller = new AbortController();
  let getterReads = 0;
  Object.defineProperty(controller.signal, "aborted", {
    configurable: true,
    get() {
      getterReads += 1;
      throw new Error("hostile AbortSignal accessor must not run");
    }
  });
  const runtime = new LlmRuntime();
  runtime.register({
    id: "safe-signal",
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "finish", reason: "stop" };
    }
  });

  assert.deepEqual(await collect(runtime.stream({
    ...request,
    provider: "safe-signal",
    signal: controller.signal
  })), [{ type: "finish", reason: "stop" }]);
  assert.equal(getterReads, 0);
});

test("LLM runtime routes without invoking request accessors or Proxy traps", async () => {
  const runtime = new LlmRuntime();
  runtime.register({
    id: "safe-provider",
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "finish", reason: "stop" };
    }
  });
  let providerGetterReads = 0;
  const accessorRequest = Object.defineProperty({
    model: "scripted",
    messages: []
  }, "provider", {
    enumerable: true,
    get() {
      providerGetterReads += 1;
      throw new Error("request getter upstream-secret");
    }
  });
  const revoked = Proxy.revocable({ ...request, provider: "safe-provider" }, {});
  revoked.revoke();

  for (const hostile of [accessorRequest, revoked.proxy]) {
    await assert.rejects(
      collect(runtime.stream(hostile as LlmRequest)),
      (error: unknown) => error instanceof TypeError
        && error.message === "LLM request header is invalid"
        && !error.message.includes("upstream-secret")
    );
  }
  assert.equal(providerGetterReads, 0);
});

test("LLM runtime rejects protected provider material and non-native signals before routing", async () => {
  const runtime = new LlmRuntime();
  runtime.register({
    id: "safe-provider",
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "finish", reason: "stop" };
    }
  });
  const protectedProvider = "sk-synthetic-credential-material";

  await assert.rejects(
    collect(runtime.stream({ ...request, provider: protectedProvider })),
    (error: unknown) => error instanceof TypeError
      && !error.message.includes(protectedProvider)
  );
  await assert.rejects(
    collect(runtime.stream({ ...request, provider: "safe-provider", signal: {} as AbortSignal })),
    (error: unknown) => error instanceof TypeError
      && error.message === "LLM request header is invalid"
  );
});

test("LLM runtime drops a chunk completed after mid-stream abort and closes the adapter iterator", async () => {
  const controller = new AbortController();
  let secondNextStarted!: () => void;
  const secondNext = new Promise<void>((resolve) => { secondNextStarted = resolve; });
  let releaseSecondNext!: () => void;
  const secondNextGate = new Promise<void>((resolve) => { releaseSecondNext = resolve; });
  let nextCalls = 0;
  let closeCalls = 0;
  const runtime = new LlmRuntime();
  runtime.register({
    id: "mid-abort",
    stream(): AsyncIterable<StreamChunk> {
      const iterator: AsyncIterableIterator<StreamChunk> = {
        async next() {
          nextCalls += 1;
          if (nextCalls === 1) {
            return { done: false, value: { type: "text-delta", index: 0, text: "accepted" } };
          }
          if (nextCalls === 2) {
            secondNextStarted();
            await secondNextGate;
            return { done: false, value: { type: "text-delta", index: 0, text: "must-drop" } };
          }
          return { done: false, value: { type: "finish", reason: "stop" } };
        },
        async return() {
          closeCalls += 1;
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() { return this; }
      };
      return iterator;
    }
  });

  const collecting = collect(runtime.stream({
    ...request,
    provider: "mid-abort",
    signal: controller.signal
  }));
  await secondNext;
  controller.abort();
  releaseSecondNext();
  const chunks = await collecting;

  assert.deepEqual(chunks, [
    { type: "text-delta", index: 0, text: "accepted" },
    { type: "error", error: { code: "LLM_CANCELLED", message: "Model stream cancelled" } },
    { type: "finish", reason: "cancelled" }
  ]);
  assert.equal(nextCalls, 2);
  assert.equal(closeCalls, 1);
  assert.equal(chunks.filter((chunk) => chunk.type === "finish").length, 1);
});

test("LLM runtime seals a stable adapter facade and its original disposer", async () => {
  let streamed = "none";
  let disposed = "none";
  const mutable = {
    id: "mutable",
    async *stream(): AsyncIterable<StreamChunk> {
      streamed = "original";
      yield { type: "finish", reason: "stop" };
    },
    dispose: () => { disposed = "original"; }
  };
  const runtime = new LlmRuntime();
  const dispose = runtime.register(mutable);
  runtime.seal();
  mutable.id = "renamed";
  mutable.stream = async function *mutated(): AsyncIterable<StreamChunk> {
    streamed = "mutated";
    yield { type: "finish", reason: "stop" };
  };
  mutable.dispose = () => { disposed = "mutated"; };
  await collect(runtime.stream({ ...request, provider: "mutable" }));
  assert.equal(streamed, "original");
  await dispose();
  assert.equal(disposed, "original");
  await assert.rejects(async () => collect(runtime.stream({ ...request, provider: "mutable" })), /not registered/i);
});
