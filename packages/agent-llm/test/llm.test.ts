import assert from "node:assert/strict";
import test from "node:test";

import { CallId, MessageId, type LlmRequest, type StreamChunk } from "@mn/agent-protocol";
import { BlockAssembler, LlmRuntime, ScriptedLlmAdapter } from "../src/index.js";

const request: LlmRequest = { provider: "mock", model: "scripted", messages: [] };

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
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
