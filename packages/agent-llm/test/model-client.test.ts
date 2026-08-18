import assert from "node:assert/strict";
import test from "node:test";

import {
  CallId,
  MessageId,
  createModelPricingSnapshotV1,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type LlmRequest,
  type StreamChunk
} from "@mn/agent-protocol";
import {
  HttpModelAdapter,
  LlmRuntime,
  ModelOutcomePersistenceError,
  type LlmStreamExecutionContext,
  type ModelClientReceipt,
  type ModelProviderRoute
} from "../src/index.js";

const encoder = new TextEncoder();
const secret = "synthetic-runtime-secret";

function sse(events: readonly (string | { readonly event?: string; readonly data: unknown })[]): Response {
  const body = events.map((item) => {
    if (typeof item === "string") return `data: ${item}\n\n`;
    const event = item.event === undefined ? "" : `event: ${item.event}\n`;
    return `${event}data: ${JSON.stringify(item.data)}\n\n`;
  }).join("");
  return new Response(encoder.encode(body), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function request(provider: string): LlmRequest {
  return {
    provider,
    model: "test-model",
    messages: [createUserMessage({
      id: MessageId("user-contract"),
      source: { kind: "user" },
      content: [{ type: "text", text: "hello" }]
    })],
    system: "system contract",
    tools: [{
      name: "read_file",
      description: "Read one file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }]
  };
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function route(apiFormat: ModelProviderRoute["apiFormat"], overrides: Partial<ModelProviderRoute> = {}): ModelProviderRoute {
  return {
    providerId: `provider-${apiFormat}`,
    apiFormat,
    baseUrl: "https://provider.invalid/v1",
    apiKeyRef: { type: "env", ref: "MODEL_API_KEY" },
    ...overrides
  };
}

test("OpenAI Chat streams text, thinking, tool calls and complete usage without leaking secrets", async () => {
  const receipts: ModelClientReceipt[] = [];
  let captured: Request | undefined;
  const provider = route("openai_chat");
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async (input) => {
      captured = input instanceof Request ? input : new Request(input);
      return sse([
        { data: { choices: [{ delta: { content: "hello" } }] } },
        { data: { choices: [{ delta: { reasoning_content: "plan" } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-safe", function: { name: "read_file", arguments: '{"path":' } }] } }] } },
        {
          data: {
            choices: [{
              delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] },
              finish_reason: "tool_calls"
            }]
          }
        },
        {
          data: {
            choices: [],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
              prompt_tokens_details: { cached_tokens: 3 },
              completion_tokens_details: { reasoning_tokens: 2 }
            }
          }
        },
        "[DONE]"
      ]);
    },
    onReceipt: (receipt) => { receipts.push(receipt); }
  });

  const chunks = await collect(adapter.stream(request(provider.providerId)));
  assert.deepEqual(chunks, [
    { type: "text-delta", index: 0, text: "hello" },
    { type: "thinking-delta", index: 1, text: "plan" },
    { type: "tool-call-delta", index: 2, id: "call-safe", name: "read_file", argumentsDelta: '{"path":' },
    { type: "tool-call-delta", index: 2, id: "call-safe", argumentsDelta: '"README.md"}' },
    { type: "usage", usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, thinkingTokens: 2 } },
    { type: "finish", reason: "tool-calls" }
  ]);
  assert.equal(captured?.url, "https://provider.invalid/v1/chat/completions");
  assert.equal(captured?.headers.get("authorization"), `Bearer ${secret}`);
  assert.equal(JSON.parse(await captured!.clone().text()).stream, true);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.usageState, "complete");
  assert.deepEqual(receipts[0]?.usage, { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, thinkingTokens: 2 });
  assert.equal(JSON.stringify(receipts).includes(secret), false);
  assert.equal(JSON.stringify(receipts).includes("README.md"), false);
});

test("OpenAI Responses streams output, reasoning, function arguments and partial usage", async () => {
  const receipts: ModelClientReceipt[] = [];
  const provider = route("openai_responses");
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async () => sse([
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 0, delta: "answer" } },
      { event: "response.reasoning_summary_text.delta", data: { type: "response.reasoning_summary_text.delta", output_index: 1, delta: "think" } },
      { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 2, item: { type: "function_call", call_id: "response-call", name: "read_file" } } },
      { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", output_index: 2, delta: "{}" } },
      { event: "response.completed", data: { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5 } } } }
    ]),
    onReceipt: (receipt) => { receipts.push(receipt); }
  });

  assert.deepEqual(await collect(adapter.stream(request(provider.providerId))), [
    { type: "text-delta", index: 0, text: "answer" },
    { type: "thinking-delta", index: 1, text: "think" },
    { type: "tool-call-delta", index: 2, id: "response-call", name: "read_file", argumentsDelta: "" },
    { type: "tool-call-delta", index: 2, id: "response-call", argumentsDelta: "{}" },
    { type: "finish", reason: "stop" }
  ]);
  assert.equal(receipts[0]?.usageState, "partial");
  assert.deepEqual(receipts[0]?.usage, { inputTokens: 5 });
});

test("Anthropic Messages streams blocks and reports missing usage instead of inventing zero", async () => {
  const receipts: ModelClientReceipt[] = [];
  let captured: Request | undefined;
  const provider = route("anthropic_messages", { baseUrl: "https://provider.invalid" });
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async (input) => {
      captured = input instanceof Request ? input : new Request(input);
      return sse([
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "anthropic-call", name: "read_file", input: {} } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" } } },
        { event: "message_stop", data: { type: "message_stop" } }
      ]);
    },
    onReceipt: (receipt) => { receipts.push(receipt); }
  });

  assert.deepEqual(await collect(adapter.stream(request(provider.providerId))), [
    { type: "thinking-delta", index: 0, text: "plan" },
    { type: "text-delta", index: 1, text: "answer" },
    { type: "tool-call-delta", index: 2, id: "anthropic-call", name: "read_file", argumentsDelta: "" },
    { type: "tool-call-delta", index: 2, id: "anthropic-call", argumentsDelta: '{"path":"README.md"}' },
    { type: "finish", reason: "tool-calls" }
  ]);
  assert.equal(captured?.url, "https://provider.invalid/v1/messages");
  assert.equal(captured?.headers.get("x-api-key"), secret);
  assert.equal(captured?.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(receipts[0]?.usageState, "missing");
  assert.equal(receipts[0]?.usage, undefined);
});

test("Anthropic Messages records cache read and cache creation usage without discarding partial counters", async () => {
  const receipts: ModelClientReceipt[] = [];
  const provider = route("anthropic_messages");
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async () => sse([
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 13,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 2
            }
          }
        }
      },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 4 }
        }
      }
    ]),
    onReceipt: (receipt) => { receipts.push(receipt); }
  });

  assert.deepEqual(await collect(adapter.stream(request(provider.providerId))), [
    {
      type: "usage",
      usage: { inputTokens: 13, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 2 }
    },
    { type: "finish", reason: "stop" }
  ]);
  assert.equal(receipts[0]?.usageState, "complete");
  assert.deepEqual(receipts[0]?.usage, {
    inputTokens: 13,
    outputTokens: 4,
    cacheReadTokens: 5,
    cacheWriteTokens: 2
  });
});

test("falls back only when a route fails before HTTP dispatch and records every safe attempt", async () => {
  const receipts: ModelClientReceipt[] = [];
  const fetchProviders: string[] = [];
  const first = route("openai_chat", {
    providerId: "first-provider",
    apiKeyRef: { type: "env", ref: "MISSING_FIRST_KEY" }
  });
  const second = route("openai_chat", {
    providerId: "second-provider",
    apiKeyRef: { type: "keychain", ref: "second-key-ref" }
  });
  const adapter = new HttpModelAdapter({
    id: "fallback-contract",
    routes: [first, second],
    resolveSecret: async (reference) => reference.ref === "MISSING_FIRST_KEY" ? undefined : secret,
    fetch: async (input) => {
      const sent = input instanceof Request ? input : new Request(input);
      fetchProviders.push(new URL(sent.url).host);
      return sse(["[DONE]"]);
    },
    onReceipt: (receipt) => { receipts.push(receipt); }
  });

  assert.deepEqual(await collect(adapter.stream(request("fallback-contract"))), [
    { type: "finish", reason: "stop" }
  ]);
  assert.deepEqual(fetchProviders, ["provider.invalid"]);
  assert.deepEqual(receipts.map((receipt) => ({
    providerId: receipt.providerId,
    attempt: receipt.attempt,
    dispatched: receipt.dispatched,
    outcome: receipt.outcome,
    fallbackAllowed: receipt.fallbackAllowed,
    failureCode: receipt.failureCode
  })), [
    {
      providerId: "first-provider",
      attempt: 1,
      dispatched: false,
      outcome: "failed",
      fallbackAllowed: true,
      failureCode: "secret_unavailable"
    },
    {
      providerId: "second-provider",
      attempt: 2,
      dispatched: true,
      outcome: "completed",
      fallbackAllowed: false,
      failureCode: undefined
    }
  ]);
  assert.equal(JSON.stringify(receipts).includes("MISSING_FIRST_KEY"), false);
  assert.equal(JSON.stringify(receipts).includes("second-key-ref"), false);
  assert.equal(JSON.stringify(receipts).includes(secret), false);
});

test("does not replay a retryable HTTP response after dispatch", async () => {
  const receipts: ModelClientReceipt[] = [];
  let fetches = 0;
  const adapter = new HttpModelAdapter({
    id: "no-replay-http",
    routes: [
      route("openai_chat", { providerId: "rate-limited" }),
      route("openai_chat", { providerId: "must-not-run", baseUrl: "https://second.invalid/v1" })
    ],
    resolveSecret: async () => secret,
    fetch: async () => {
      fetches += 1;
      return new Response("Authorization: Bearer upstream-secret", { status: 503 });
    },
    onReceipt: (receipt) => { receipts.push(receipt); }
  });

  const chunks = await collect(adapter.stream(request("no-replay-http")));
  assert.equal(fetches, 1);
  assert.deepEqual(chunks, [
    {
      type: "error",
      error: {
        code: "LLM_PROVIDER_ERROR",
        message: "Model provider returned an error",
        status: 503,
        retryable: true
      }
    },
    { type: "finish", reason: "error" }
  ]);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.retryable, true);
  assert.equal(receipts[0]?.fallbackAllowed, false);
  assert.equal(receipts[0]?.failureCode, "http_error");
  assert.equal(JSON.stringify(receipts).includes("upstream-secret"), false);
});

test("normalizes a post-dispatch transport failure without leaking or falling back", async () => {
  const receipts: ModelClientReceipt[] = [];
  let fetches = 0;
  const adapter = new HttpModelAdapter({
    id: "transport-boundary",
    routes: [
      route("anthropic_messages", { providerId: "transport-failure" }),
      route("anthropic_messages", { providerId: "must-not-run", baseUrl: "https://second.invalid/v1" })
    ],
    resolveSecret: async () => secret,
    fetch: async () => {
      fetches += 1;
      throw new Error(`socket failed with ${secret}`);
    },
    onReceipt: (receipt) => { receipts.push(receipt); }
  });

  assert.deepEqual(await collect(adapter.stream(request("transport-boundary"))), [
    {
      type: "error",
      error: {
        code: "LLM_TRANSPORT_ERROR",
        message: "Model provider transport failed",
        retryable: true
      }
    },
    { type: "finish", reason: "error" }
  ]);
  assert.equal(fetches, 1);
  assert.equal(receipts.length, 1);
  assert.deepEqual({
    dispatched: receipts[0]?.dispatched,
    outcome: receipts[0]?.outcome,
    fallbackAllowed: receipts[0]?.fallbackAllowed,
    failureCode: receipts[0]?.failureCode
  }, {
    dispatched: true,
    outcome: "failed",
    fallbackAllowed: false,
    failureCode: "transport_error"
  });
  assert.equal(JSON.stringify(receipts).includes(secret), false);
});

test("pre-abort resolves no secret, dispatches no HTTP request and emits one safe terminal", async () => {
  const receipts: ModelClientReceipt[] = [];
  let resolverCalls = 0;
  let fetches = 0;
  const controller = new AbortController();
  controller.abort(new Error(`cancel ${secret}`));
  const adapter = new HttpModelAdapter({
    id: "pre-abort",
    routes: [route("openai_responses")],
    resolveSecret: async () => {
      resolverCalls += 1;
      return secret;
    },
    fetch: async () => {
      fetches += 1;
      return sse(["[DONE]"]);
    },
    onReceipt: (receipt) => { receipts.push(receipt); }
  });

  assert.deepEqual(await collect(adapter.stream({ ...request("pre-abort"), signal: controller.signal })), [
    {
      type: "error",
      error: { code: "LLM_CANCELLED", message: "Model request cancelled", retryable: false }
    },
    { type: "finish", reason: "cancelled" }
  ]);
  assert.equal(resolverCalls, 0);
  assert.equal(fetches, 0);
  assert.deepEqual(receipts.map((receipt) => ({
    dispatched: receipt.dispatched,
    outcome: receipt.outcome,
    failureCode: receipt.failureCode
  })), [{ dispatched: false, outcome: "interrupted", failureCode: "cancelled" }]);
  assert.equal(JSON.stringify(receipts).includes(secret), false);
});

test("abort does not wait for or trust a secret resolver or fetch implementation that settles late", async () => {
  for (const boundary of ["resolver", "resolver-reject", "fetch"] as const) {
    const receipts: ModelClientReceipt[] = [];
    const controller = new AbortController();
    let resolverCalls = 0;
    let fetches = 0;
    const provider = route("openai_chat");
    const adapter = new HttpModelAdapter({
      id: provider.providerId,
      routes: [provider],
      resolveSecret: async () => {
        resolverCalls += 1;
        if (boundary === "resolver") return await new Promise<string>(() => undefined);
        if (boundary === "resolver-reject") {
          return await new Promise<string>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => {
              reject(new Error(`resolver rejected with ${secret}`));
            }, { once: true });
          });
        }
        return secret;
      },
      fetch: async () => {
        fetches += 1;
        return await new Promise<Response>(() => undefined);
      },
      onReceipt: (receipt) => { receipts.push(receipt); }
    });

    const collected = collect(adapter.stream({ ...request(provider.providerId), signal: controller.signal }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error(`cancel ${secret}`));
    const chunks = await Promise.race([
      collected,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${boundary} abort timed out`)), 250))
    ]);
    assert.deepEqual(chunks, [
      {
        type: "error",
        error: { code: "LLM_CANCELLED", message: "Model request cancelled", retryable: false }
      },
      { type: "finish", reason: "cancelled" }
    ], boundary);
    assert.equal(resolverCalls, 1);
    assert.equal(fetches, boundary === "fetch" ? 1 : 0);
    assert.deepEqual(receipts.map((receipt) => ({
      dispatched: receipt.dispatched,
      outcome: receipt.outcome,
      failureCode: receipt.failureCode
    })), [{
      dispatched: boundary === "fetch",
      outcome: "interrupted",
      failureCode: "cancelled"
    }]);
  }
});

test("rejects accessor and Proxy configuration without executing user traps", () => {
  let idGetterReads = 0;
  const accessorOptions = Object.defineProperty({}, "id", {
    enumerable: true,
    get() {
      idGetterReads += 1;
      return "unsafe";
    }
  });
  assert.throws(
    () => new HttpModelAdapter(accessorOptions as never),
    /model adapter options must be an exact data object/u
  );
  assert.equal(idGetterReads, 0);

  let routeTrapReads = 0;
  const proxiedRoute = new Proxy(route("openai_chat"), {
    get(target, key, receiver) {
      routeTrapReads += 1;
      return Reflect.get(target, key, receiver);
    }
  });
  assert.throws(
    () => new HttpModelAdapter({
      id: "proxy-route",
      routes: [proxiedRoute],
      resolveSecret: async () => secret
    }),
    /model provider route must be an exact data object/u
  );
  assert.equal(routeTrapReads, 0);

  assert.throws(
    () => new HttpModelAdapter({
      id: "cleartext-route",
      routes: [route("openai_chat", { baseUrl: "http://provider.invalid/v1" })],
      resolveSecret: async () => secret
    }),
    /model provider base URL is invalid/u
  );
  assert.doesNotThrow(() => new HttpModelAdapter({
    id: "loopback-route",
    routes: [route("openai_chat", { baseUrl: "http://127.0.0.1:43123/v1" })],
    resolveSecret: async () => secret
  }));
});

test("serializes multi-turn tool history using each provider's native wire vocabulary", async () => {
  const callId = CallId("call-history");
  const messages: LlmRequest["messages"] = [
    createUserMessage({
      id: MessageId("history-user"),
      source: { kind: "user" },
      content: [{ type: "text", text: "read it" }]
    }),
    createAssistantMessage({
      id: MessageId("history-assistant"),
      source: { kind: "model", provider: "logical-provider", model: "test-model" },
      content: [
        { type: "thinking", text: "inspect" },
        { type: "text", text: "I will read it" },
        { type: "tool-call", id: callId, name: "read_file", arguments: '{"path":"README.md"}' }
      ]
    }),
    createToolResultMessage({
      id: MessageId("history-result"),
      source: { kind: "tool", callId },
      content: [{
        type: "tool-result",
        toolCallId: callId,
        content: [{ type: "text", text: "contents" }]
      }]
    })
  ];

  const bodies = new Map<ModelProviderRoute["apiFormat"], Record<string, unknown>>();
  for (const apiFormat of ["openai_chat", "openai_responses", "anthropic_messages"] as const) {
    const provider = route(apiFormat);
    const adapter = new HttpModelAdapter({
      id: provider.providerId,
      routes: [provider],
      resolveSecret: async () => secret,
      fetch: async (input) => {
        const sent = input instanceof Request ? input : new Request(input);
        bodies.set(apiFormat, JSON.parse(await sent.clone().text()) as Record<string, unknown>);
        return sse(["[DONE]"]);
      }
    });
    await collect(adapter.stream({ ...request(provider.providerId), messages }));
  }

  const chat = bodies.get("openai_chat") as {
    messages: Array<Record<string, unknown>>;
  };
  assert.deepEqual(chat.messages.slice(1), [
    { role: "user", content: "read it" },
    {
      role: "assistant",
      content: "I will read it",
      reasoning_content: "inspect",
      tool_calls: [{
        id: "call-history",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' }
      }]
    },
    { role: "tool", tool_call_id: "call-history", content: "contents" }
  ]);

  const responses = bodies.get("openai_responses") as {
    input: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>>;
  };
  assert.deepEqual(responses.input, [
    { type: "message", role: "user", content: "read it" },
    { type: "message", role: "assistant", content: "I will read it" },
    {
      type: "function_call",
      call_id: "call-history",
      name: "read_file",
      arguments: '{"path":"README.md"}'
    },
    { type: "function_call_output", call_id: "call-history", output: "contents" }
  ]);
  assert.deepEqual(responses.tools[0], {
    type: "function",
    name: "read_file",
    description: "Read one file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  });

  const anthropic = bodies.get("anthropic_messages") as {
    messages: Array<Record<string, unknown>>;
  };
  assert.deepEqual(anthropic.messages, [
    { role: "user", content: [{ type: "text", text: "read it" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will read it" },
        { type: "tool_use", id: "call-history", name: "read_file", input: { path: "README.md" } }
      ]
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call-history",
        content: [{ type: "text", text: "contents" }]
      }]
    }
  ]);
});

test("normalizes provider-declared stream errors for all three wire protocols", async () => {
  const cases: readonly {
    apiFormat: ModelProviderRoute["apiFormat"];
    event: { readonly event?: string; readonly data: unknown };
  }[] = [
    { apiFormat: "openai_chat", event: { data: { error: { message: `chat ${secret}` } } } },
    {
      apiFormat: "openai_responses",
      event: { event: "response.failed", data: { type: "response.failed", response: { error: { message: `responses ${secret}` } } } }
    },
    {
      apiFormat: "anthropic_messages",
      event: { event: "error", data: { type: "error", error: { message: `anthropic ${secret}` } } }
    }
  ];

  for (const entry of cases) {
    const provider = route(entry.apiFormat);
    const adapter = new HttpModelAdapter({
      id: provider.providerId,
      routes: [provider],
      resolveSecret: async () => secret,
      fetch: async () => sse([entry.event])
    });
    const chunks = await collect(adapter.stream(request(provider.providerId)));
    assert.deepEqual(chunks, [
      {
        type: "error",
        error: { code: "LLM_PROVIDER_ERROR", message: "Model provider returned an error", retryable: false }
      },
      { type: "finish", reason: "error" }
    ], entry.apiFormat);
    assert.equal(JSON.stringify(chunks).includes(secret), false);
  }
});

test("treats the OpenAI Responses top-level error event as a failed audited stream", async () => {
  const receipts: ModelClientReceipt[] = [];
  const provider = route("openai_responses");
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async () => sse([{
      event: "error",
      data: {
        type: "error",
        code: "server_error",
        message: `responses ${secret}`,
        param: null
      }
    }]),
    onReceipt: (receipt) => { receipts.push(receipt); }
  });

  const chunks = await collect(adapter.stream(request(provider.providerId)));
  assert.deepEqual(chunks, [
    {
      type: "error",
      error: { code: "LLM_PROVIDER_ERROR", message: "Model provider returned an error", retryable: false }
    },
    { type: "finish", reason: "error" }
  ]);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0], {
    schemaVersion: 1,
    providerId: provider.providerId,
    model: "test-model",
    apiFormat: "openai_responses",
    attempt: 1,
    dispatched: true,
    outcome: "failed",
    statusCode: 200,
    retryable: false,
    fallbackAllowed: false,
    failureCode: "stream_error",
    usageState: "missing"
  });
  assert.equal(JSON.stringify({ chunks, receipts }).includes(secret), false);
});

test("records consumer interruption and rejects request accessors without executing them", async () => {
  const receipts: ModelClientReceipt[] = [];
  const provider = route("openai_chat");
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async () => sse([
      { data: { choices: [{ delta: { content: "first" } }] } },
      { data: { choices: [{ delta: { content: "second" } }] } }
    ]),
    onReceipt: (receipt) => { receipts.push(receipt); }
  });
  const iterator = adapter.stream(request(provider.providerId))[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: { type: "text-delta", index: 0, text: "first" } });
  await iterator.return?.();
  assert.deepEqual(receipts.map((receipt) => ({ outcome: receipt.outcome, failureCode: receipt.failureCode })), [
    { outcome: "interrupted", failureCode: "stream_interrupted" }
  ]);

  let providerGetterReads = 0;
  const hostile = Object.defineProperty({}, "provider", {
    enumerable: true,
    get() {
      providerGetterReads += 1;
      return provider.providerId;
    }
  });
  await assert.rejects(
    collect(adapter.stream(hostile as never)),
    /model request must be an exact data object/u
  );
  assert.equal(providerGetterReads, 0);
});

test("publishes the audit receipt before a terminal chunk and fails closed when the observer rejects", async () => {
  const provider = route("openai_chat");
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async () => sse([{
      data: { choices: [{ delta: { content: "partial" }, finish_reason: "stop" }] }
    }]),
    onReceipt: () => { throw new Error(`receipt failed with ${secret}`); }
  });
  const runtime = new LlmRuntime();
  runtime.register(adapter);
  runtime.seal();

  const chunks = await collect(runtime.stream(request(provider.providerId)));
  assert.deepEqual(chunks, [
    { type: "text-delta", index: 0, text: "partial" },
    {
      type: "error",
      error: { code: "LLM_STREAM_FAILED", message: "Model stream failed" }
    },
    { type: "finish", reason: "error" }
  ]);
  assert.equal(JSON.stringify(chunks).includes(secret), false);
});

test("cancellation does not wait forever for a pending receipt observer", async () => {
  const provider = route("openai_chat");
  const controller = new AbortController();
  let observerCalls = 0;
  let observerStarted!: () => void;
  const started = new Promise<void>((resolve) => { observerStarted = resolve; });
  let rejectObserver!: (reason: unknown) => void;
  const pendingObserver = new Promise<void>((_resolve, reject) => { rejectObserver = reject; });
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async () => sse([{
      data: { choices: [{ delta: { content: "partial" }, finish_reason: "stop" }] }
    }]),
    onReceipt: () => {
      observerCalls += 1;
      observerStarted();
      return pendingObserver;
    }
  });
  const runtime = new LlmRuntime();
  runtime.register(adapter);
  runtime.seal();

  const collecting = collect(runtime.stream({
    ...request(provider.providerId),
    signal: controller.signal
  }));
  await started;
  controller.abort();
  const chunks = await Promise.race([
    collecting,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("pending receipt cancellation timed out")), 250);
    })
  ]);
  assert.deepEqual(chunks, [
    { type: "text-delta", index: 0, text: "partial" },
    { type: "error", error: { code: "LLM_CANCELLED", message: "Model stream cancelled" } },
    { type: "finish", reason: "cancelled" }
  ]);
  assert.equal(observerCalls, 1);
  rejectObserver(new Error(`late receipt rejection ${secret}`));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(chunks).includes(secret), false);
});

test("durable model audit starts before dispatch and commits terminal cost before finish", async () => {
  const order: string[] = [];
  const starts: unknown[] = [];
  const terminals: unknown[] = [];
  const provider = route("openai_chat", {
    pricing: createModelPricingSnapshotV1({
      inputUsdPerMillion: "1",
      outputUsdPerMillion: "2"
    })
  });
  const execution: LlmStreamExecutionContext = {
    attemptAudit: {
      started: async (attempt) => {
        order.push("started");
        starts.push(attempt);
      },
      terminal: async (terminal) => {
        order.push("terminal");
        terminals.push(terminal);
      }
    }
  };
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async () => {
      order.push("fetch");
      return sse([{
        data: {
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 }
        }
      }]);
    }
  });
  const chunks = await collect(adapter.stream(request(provider.providerId), execution));
  assert.deepEqual(order, ["started", "fetch", "terminal"]);
  assert.equal(starts.length, 1);
  assert.equal(terminals.length, 1);
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: "stop" });
  assert.equal((terminals[0] as { dispatchState: string }).dispatchState, "dispatched");
  assert.equal((terminals[0] as { cost: { status: string } }).cost.status, "estimated");
  assert.equal(JSON.stringify({ starts, terminals }).includes(secret), false);
});

test("terminal audit persistence failure escapes the runtime and never emits a false finish", async () => {
  const provider = route("openai_responses", {
    pricing: createModelPricingSnapshotV1({})
  });
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async () => sse([{
      event: "response.completed",
      data: { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }
    }])
  });
  const runtime = new LlmRuntime();
  runtime.register(adapter);
  runtime.seal();
  const execution: LlmStreamExecutionContext = {
    attemptAudit: {
      started: async () => undefined,
      terminal: async () => { throw new Error(`disk failed ${secret}`); }
    }
  };
  await assert.rejects(
    collect(runtime.stream(request(provider.providerId), execution)),
    (error: unknown) => error instanceof ModelOutcomePersistenceError
      && !String(error).includes(secret)
  );
});

test("reads native Response state without invoking hostile instance accessors", async () => {
  const provider = route("openai_chat");
  let responseGetterReads = 0;
  const response = sse(["[DONE]"]);
  for (const key of ["ok", "status", "body"] as const) {
    Object.defineProperty(response, key, {
      configurable: true,
      get() {
        responseGetterReads += 1;
        throw new Error(`hostile Response ${key} ${secret}`);
      }
    });
  }
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async () => response
  });

  assert.deepEqual(await collect(adapter.stream(request(provider.providerId))), [
    { type: "finish", reason: "stop" }
  ]);
  assert.equal(responseGetterReads, 0);
});

test("reads AbortSignal state without invoking a hostile instance accessor", async () => {
  const provider = route("openai_chat");
  const controller = new AbortController();
  let abortedGetterReads = 0;
  Object.defineProperty(controller.signal, "aborted", {
    configurable: true,
    get() {
      abortedGetterReads += 1;
      throw new Error(`hostile signal ${secret}`);
    }
  });
  const adapter = new HttpModelAdapter({
    id: provider.providerId,
    routes: [provider],
    resolveSecret: async () => secret,
    fetch: async () => sse(["[DONE]"])
  });

  assert.deepEqual(await collect(adapter.stream({
    ...request(provider.providerId),
    signal: controller.signal
  })), [{ type: "finish", reason: "stop" }]);
  assert.equal(abortedGetterReads, 0);
});
