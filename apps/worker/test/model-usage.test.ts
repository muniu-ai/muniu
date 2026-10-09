// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRuntimeStore } from "@mn/agent-runtime";
import { createByokModelInvoker, createByokModelQuoter, invokeBudgetedByokModel, type ByokProviderId } from "../src/model-invoker.js";

const request = { executionId: "execution", agentId: "agent", generation: 1,
  messages: [{ role: "user" as const, content: "hello" }], availableToolIds: [], maxOutputTokens: 128 };
const input = { model: "fixture", apiKey: "fixture-key", request, signal: new AbortController().signal };
const payloads = {
  openai: { output_text: "hello", usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20,
    input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 5 } } },
  deepseek: { choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 12, completion_tokens: 8,
    total_tokens: 20, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 10 } },
  anthropic: { content: [{ type: "text", text: "hello" }], usage: { input_tokens: 10, output_tokens: 8,
    cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } },
};

for (const presetId of Object.keys(payloads) as (keyof typeof payloads)[]) {
  test(`${presetId} preserves provider token accounting and applies the output limit`, async () => {
    const invoke = createByokModelInvoker({ async fetch(_url, init) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body[presetId === "openai" ? "max_output_tokens" : "max_tokens"], 128);
      return Response.json(payloads[presetId]);
    } });
    assert.deepEqual((await invoke({ ...input, presetId })).usage,
      { inputTokens: 12, cachedInputTokens: 2, outputTokens: 8 });
  });
}

test("malformed and inconsistent token usage is rejected without leaking the provider response", async () => {
  for (const usage of [
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: "12", output_tokens: 1 },
    { input_tokens: 12, output_tokens: 1, total_tokens: 99 },
    { input_tokens: 12, output_tokens: 1, input_tokens_details: { cached_tokens: 20 } },
  ]) {
    const invoke = createByokModelInvoker({ fetch: async () => Response.json({ output_text: "SECRET", usage }) });
    await assert.rejects(invoke({ ...input, presetId: "openai" }), error => {
      assert.match(String(error), /用量/u);
      assert.doesNotMatch(String(error), /SECRET/u);
      return true;
    });
  }
});

test("missing usage is unknown instead of fabricated zero; cancelled requests never reach fetch", async () => {
  let calls = 0;
  const invoke = createByokModelInvoker({ async fetch() { calls += 1; return Response.json({ output_text: "hello" }); } });
  assert.equal((await invoke({ ...input, presetId: "openai" })).usage, undefined);
  await assert.rejects(invoke({ ...input, presetId: "openai", signal: AbortSignal.abort() }));
  assert.equal(calls, 1);
});

test("model quotes count the same normalized prompt and never call a completion endpoint", async () => {
  for (const presetId of ["openai", "anthropic"] as const) {
    const quote = createByokModelQuoter({ async fetch(url, init) {
      assert.equal(String(url), presetId === "openai" ? "https://api.openai.com/v1/responses/input_tokens"
        : "https://api.anthropic.com/v1/messages/count_tokens");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_output_tokens, undefined);
      assert.equal(body.max_tokens, undefined);
      assert.equal(body.store, undefined);
      assert.equal(body.tools[0].name, "mn_tool_1");
      assert.deepEqual(body[presetId === "openai" ? "input" : "messages"], request.messages);
      return Response.json({ input_tokens: 50 });
    } });
    const result = await quote({ ...input, presetId, model: presetId === "openai" ? "gpt-5" : "claude-sonnet-4-5",
      request: { ...request, availableToolIds: ["tool"] } });
    assert.equal(result.inputTokenLimit, 50);
    assert.equal(result.inputTokenLimitBasis, "provider_count");
    assert.equal(result.maxOutputTokens, 128);
    assert.equal(result.rates.currency, "USD");
  }
});

test("DeepSeek uses a disclosed conservative text estimate; unknown price models fail before network", async () => {
  const quote = createByokModelQuoter({ fetch: async () => { throw new Error("network must not be used"); } });
  const result = await quote({ ...input, presetId: "deepseek", model: "deepseek-v4-flash" });
  assert.equal(result.inputTokenLimitBasis, "conservative_utf8_estimate");
  assert.ok(result.inputTokenLimit > Buffer.byteLength(JSON.stringify(request.messages)));
  assert.equal(result.rates.currency, "CNY");
  await assert.rejects(quote({ ...input, presetId: "openai", model: "unknown" }), /价格/u);
});

test("model transport refuses redirects, oversized bodies and uncooperative response streams", async () => {
  const invoke = createByokModelInvoker({ async fetch(_url, init) {
    assert.equal(init?.redirect, "error");
    return Response.json(payloads.openai);
  } });
  await invoke({ ...input, presetId: "openai" });
  let cancelled = 0;
  const oversized = createByokModelInvoker({ fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(9 * 1024 * 1024)); },
    cancel() { cancelled += 1; },
  })) });
  await assert.rejects(oversized({ ...input, presetId: "openai" }), /响应/u);
  assert.equal(cancelled, 1);
  const hanging = createByokModelInvoker({ timeoutMs: 10, fetch: async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() { cancelled += 1; },
  })) });
  await assert.rejects(hanging({ ...input, presetId: "openai" }), /超时|响应/u);
  assert.equal(cancelled, 2);
});

test("the BYOK budget boundary persists usage and prevents another billed call after unknown completion", async () => {
  const store = new InMemoryRuntimeStore();
  const limits = { maxTokens: 1000, maxCostMinorUnits: "100", currency: "USD" };
  const quote = async () => ({ inputTokenLimit: 100, maxOutputTokens: 100, inputTokenLimitBasis: "provider_count" as const,
    rates: { id: "fixture", currency: "USD", inputNanoMinorUnitsPerToken: "1000000",
      cachedInputNanoMinorUnitsPerToken: "100000", outputNanoMinorUnitsPerToken: "2000000" } });
  let calls = 0;
  const invoke = async () => {
    calls += 1;
    return { text: "result", toolCalls: [], ...(calls === 1 ? { usage: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 20 } } : {}) };
  };
  const options = { input: { ...input, presetId: "openai" as const }, store, limits, quote, invoke };
  await invokeBudgetedByokModel(options);
  assert.equal((await store.readExecution("execution")).filter(record => record.type === "model/settled").length, 1);
  await assert.rejects(invokeBudgetedByokModel(options), /未结算/u);
  await assert.rejects(invokeBudgetedByokModel(options), /未结算/u);
  assert.equal(calls, 2);
});


test("Kimi and Qwen send actual chat completions with bounded non-thinking tool requests", async () => {
  for (const provider of ["moonshot", "qwen"]) {
    const invoke = createByokModelInvoker({ async fetch(url, init) {
      assert.equal(String(url), provider === "moonshot" ? "https://api.moonshot.cn/v1/chat/completions"
        : "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.stream, false);
      assert.equal(body.max_tokens, 128);
      assert.deepEqual(body.messages, request.messages);
      assert.equal(body.tools[0].function.name, "mn_tool_1");
      if (provider === "moonshot") assert.deepEqual(body.thinking, { type: "disabled" });
      else assert.equal(body.enable_thinking, false);
      return Response.json({ choices: [{ message: { content: "结果", tool_calls: [
        { id: "tool-call", type: "function", function: { name: "mn_tool_1", arguments: '{"id":"record"}' } },
      ] } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20,
        ...(provider === "moonshot" ? { cached_tokens: 2 } : { prompt_tokens_details: { cached_tokens: 2 } }) } });
    } });
    const response = await invoke({ ...input, presetId: provider as ByokProviderId,
      model: provider === "moonshot" ? "kimi-k2.6" : "qwen-plus", request: { ...request, availableToolIds: ["fixture.read"] } });
    assert.equal(response.text, "结果");
    assert.deepEqual(response.toolCalls, [{ id: "tool-call", toolId: "fixture.read", arguments: { id: "record" } }]);
    assert.deepEqual(response.usage, { inputTokens: 12, cachedInputTokens: 2, outputTokens: 8 });
  }
});

test("Qwen quoting stays conservative and refuses unpriced models before any network request", async () => {
  const quote = createByokModelQuoter({ fetch: async () => { throw new Error("must not send a paid probe"); } });
  const result = await quote({ ...input, presetId: "qwen" as ByokProviderId, model: "qwen-plus" });
  assert.equal(result.inputTokenLimitBasis, "conservative_utf8_estimate");
  assert.ok(result.inputTokenLimit > 4096);
  assert.equal(result.rates.currency, "CNY");
  await assert.rejects(quote({ ...input, presetId: "qwen" as ByokProviderId, model: "qwen-unpriced" }), /价格/u);
  await assert.rejects(quote({ ...input, presetId: "moonshot" as ByokProviderId, model: "kimi-k3" }), /价格/u);
});

test("new compatible providers reject unexpected cache writes and malformed cache counts", async () => {
  for (const provider of ["moonshot", "qwen"]) for (const cache of [
    { prompt_tokens_details: { cached_tokens: 20 } },
    { prompt_tokens_details: "SECRET" },
    { prompt_tokens_details: { cached_tokens: 2, cache_creation_input_tokens: 3 } },
    { prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 } },
    { cached_tokens: -1 },
  ]) {
    const invoke = createByokModelInvoker({ fetch: async () => Response.json({
      choices: [{ message: { content: "SECRET" } }], usage: { prompt_tokens: 12, completion_tokens: 8, ...cache },
    }) });
    await assert.rejects(invoke({ ...input, presetId: provider as ByokProviderId }), error => {
      assert.doesNotMatch(String(error), /SECRET/u);
      return true;
    });
  }
});
