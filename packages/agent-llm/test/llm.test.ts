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

test("assembler rejects block conflicts, incomplete tool calls, and chunks after finish", () => {
  const conflict = new BlockAssembler();
  conflict.push({ type: "text-delta", index: 0, text: "text" });
  assert.throws(() => conflict.push({ type: "thinking-delta", index: 0, text: "thinking" }), /block type conflict/i);

  const incomplete = new BlockAssembler();
  incomplete.push({ type: "tool-call-delta", index: 0, id: CallId("call-1"), argumentsDelta: "{}" });
  assert.throws(() => incomplete.blocks(), /tool call.*name/i);
  const invalidEnd = new BlockAssembler();
  invalidEnd.push({
    type: "block-end",
    index: 0,
    block: { type: "tool-call", id: CallId(""), name: "", arguments: "{}" }
  });
  assert.throws(() => invalidEnd.blocks(), /tool call.*(?:id|name)/i);

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
