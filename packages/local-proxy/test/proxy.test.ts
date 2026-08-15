import { createHash } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProviderHealthEvent,
  ProviderRecord,
  ProxyReplayRecord,
  ProxyRequestLog,
  TrustedProxyUsageAssociation
} from "@mn/provider-catalog";
import {
  summarizeProxyRequestLogs,
  usageModels
} from "@mn/usage";
import {
  LocalProxyServer,
  providerUsageAttemptLogId,
  type ProviderUsageAttemptLog,
  type ProviderUsageDispatchIntent,
  type ProviderUsageUnknownIntent
} from "../src/index.js";

test("local proxy forwards requests to the active provider and logs them", async (t) => {
  const upstream = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer sk-proxy-test");
    assert.equal(request.headers["x-mn-run-id"], undefined);
    assert.equal(request.headers["x-mn-candidate-id"], undefined);
    assert.equal(request.url, "/v1/responses");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        model: "test-model",
        ok: true,
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          input_tokens_details: {
            cached_tokens: 5
          },
          output_tokens_details: {
            reasoning_tokens: 2
          }
        }
      }));
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-1",
    app: "codex",
    name: "Test",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    defaultModel: "test-model",
    disableResponseStorage: true,
    wireApi: "responses",
    modelCatalog: [{ id: "test-model", displayName: "Test model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-proxy-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const response = await fetch(`http://${status.host}:${status.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex",
      "x-mn-run-id": "run-1",
      "x-mn-candidate-id": "claude-1"
    },
    body: JSON.stringify({ model: "test-model", input: "hello" })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    model: "test-model",
    ok: true,
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      input_tokens_details: {
        cached_tokens: 5
      },
      output_tokens_details: {
        reasoning_tokens: 2
      }
    }
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.providerId, "provider-1");
  assert.equal(logs[0]?.statusCode, 200);
  assert.equal(logs[0]?.inputTokens, 12);
  assert.equal(logs[0]?.outputTokens, 4);
  assert.equal(logs[0]?.cachedInputTokens, 5);
  assert.equal(logs[0]?.reasoningOutputTokens, 2);
  assert.equal(logs[0]?.runId, "run-1");
  assert.equal(logs[0]?.candidateId, "claude-1");
});

test("local proxy reads run association from path prefix without forwarding it", async (t) => {
  const upstream = createServer((request, response) => {
    assert.equal(request.headers["x-mn-run-id"], undefined);
    assert.equal(request.headers["x-mn-candidate-id"], undefined);
    assert.equal(request.url, "/v1/responses");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        model: "test-model",
        usage: {
          input_tokens: 7,
          output_tokens: 3
        }
      }));
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-prefixed",
    app: "codex",
    name: "Prefixed",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    defaultModel: "test-model",
    disableResponseStorage: true,
    wireApi: "responses",
    modelCatalog: [{ id: "test-model", displayName: "Test model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-prefixed-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const response = await fetch(
    `http://${status.host}:${status.port}/mn/runs/run-1/candidates/codex-1/v1/responses`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "test-model", input: "hello" })
    }
  );

  assert.equal(response.status, 200);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.providerId, "provider-prefixed");
  assert.equal(logs[0]?.inputTokens, 7);
  assert.equal(logs[0]?.outputTokens, 3);
  assert.equal(logs[0]?.runId, "run-1");
  assert.equal(logs[0]?.candidateId, "codex-1");
});

test("local proxy injects configured idempotency header for associated requests", async (t) => {
  const upstreamKeys: Array<string | undefined> = [];
  const upstream = createServer((request, response) => {
    upstreamKeys.push(request.headers["idempotency-key"] as string | undefined);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        model: "test-model",
        usage: {
          input_tokens: 3,
          output_tokens: 1
        }
      }));
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const provider: ProviderRecord = {
    id: "provider-idempotency",
    app: "codex",
    name: "Idempotency",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    defaultModel: "test-model",
    wireApi: "responses",
    modelCatalog: [{ id: "test-model", displayName: "Test model" }],
    config: { idempotencyHeaderName: "Idempotency-Key" },
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-idempotency-test"
    }),
    appendLog: async () => {}
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const associatedUrl = `http://${status.host}:${status.port}/mn/runs/run-idempotency/candidates/codex-1/v1/responses`;
  const requestBody = JSON.stringify({ model: "test-model", input: "same" });
  const first = await fetch(associatedUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody
  });
  const second = await fetch(associatedUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "caller-key"
    },
    body: requestBody
  });
  const third = await fetch(`http://${status.host}:${status.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody
  });
  const fourth = await fetch(associatedUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.equal(fourth.status, 200);
  assert.match(upstreamKeys[0] ?? "", /^mn-[0-9a-f]{64}$/);
  assert.equal(upstreamKeys[1], "caller-key");
  assert.equal(upstreamKeys[2], undefined);
  assert.match(upstreamKeys[3] ?? "", /^mn-[0-9a-f]{64}$/);
  assert.notEqual(upstreamKeys[3], upstreamKeys[0]);
});

test("local proxy replays duplicate associated non-streaming provider requests", async (t) => {
  let upstreamCalls = 0;
  const upstream = createServer((request, response) => {
    upstreamCalls += 1;
    assert.equal(request.url, "/v1/responses");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        model: "test-model",
        output_text: `upstream-${upstreamCalls}`,
        usage: {
          input_tokens: 9,
          output_tokens: 5,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 2,
          input_tokens_details: {
            cached_tokens: 3
          },
          output_tokens_details: {
            reasoning_tokens: 1
          }
        }
      }));
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const replayRecords = new Map<string, ProxyReplayRecord>();
  const provider: ProviderRecord = {
    id: "provider-replay",
    app: "codex",
    name: "Replay",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    defaultModel: "test-model",
    disableResponseStorage: true,
    wireApi: "responses",
    modelCatalog: [{ id: "test-model", displayName: "Test model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-replay-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    },
    getReplay: async (key) => replayRecords.get(key),
    saveReplay: async (record) => {
      replayRecords.set(record.key, record);
    },
    markReplayUsed: async (key) => {
      const current = replayRecords.get(key);
      if (current) {
        replayRecords.set(key, {
          ...current,
          replayCount: current.replayCount + 1,
          lastReplayedAt: new Date().toISOString()
        });
      }
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const url = `http://${status.host}:${status.port}/mn/runs/run-replay/candidates/codex-1/v1/responses`;
  const body = JSON.stringify({ model: "test-model", input: "hello" });
  const first = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  const second = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), {
    model: "test-model",
    output_text: "upstream-1",
    usage: {
      input_tokens: 9,
      output_tokens: 5,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 2,
      input_tokens_details: {
        cached_tokens: 3
      },
      output_tokens_details: {
        reasoning_tokens: 1
      }
    }
  });
  assert.deepEqual(await second.json(), {
    model: "test-model",
    output_text: "upstream-1",
    usage: {
      input_tokens: 9,
      output_tokens: 5,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 2,
      input_tokens_details: {
        cached_tokens: 3
      },
      output_tokens_details: {
        reasoning_tokens: 1
      }
    }
  });
  assert.equal(second.headers.get("x-mn-proxy-replay"), "hit");
  assert.equal(upstreamCalls, 1);
  assert.equal(replayRecords.size, 1);
  assert.equal([...replayRecords.values()][0]?.replayCount, 1);
  assert.equal(logs.length, 2);
  assert.equal(logs[0]?.replayed, undefined);
  assert.equal(logs[1]?.replayed, true);
  assert.deepEqual(
    logs.map((log) => ({
      replayed: log.replayed,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      cachedInputTokens: log.cachedInputTokens,
      cacheCreationInputTokens: log.cacheCreationInputTokens,
      cacheReadInputTokens: log.cacheReadInputTokens,
      reasoningOutputTokens: log.reasoningOutputTokens
    })),
    [
      {
        replayed: undefined,
        inputTokens: 9,
        outputTokens: 5,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 4,
        cacheReadInputTokens: 2,
        reasoningOutputTokens: 1
      },
      {
        replayed: true,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        reasoningOutputTokens: 0
      }
    ]
  );
  const pricing = [{
    providerId: provider.id,
    model: "test-model",
    inputTokenUsdPerMillion: 1,
    outputTokenUsdPerMillion: 3,
    cachedInputTokenUsdPerMillion: 0.5,
    cacheCreationInputTokenUsdPerMillion: 2,
    cacheReadInputTokenUsdPerMillion: 0.25,
    reasoningOutputTokenUsdPerMillion: 4
  }];
  const summary = summarizeProxyRequestLogs(logs, { pricing });
  assert.deepEqual({
    requestCount: summary.requestCount,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    totalTokens: summary.totalTokens,
    cachedInputTokens: summary.cachedInputTokens,
    cacheCreationInputTokens: summary.cacheCreationInputTokens,
    cacheReadInputTokens: summary.cacheReadInputTokens,
    reasoningOutputTokens: summary.reasoningOutputTokens,
    estimatedCostUsd: summary.estimatedCostUsd
  }, {
    requestCount: 2,
    inputTokens: 9,
    outputTokens: 5,
    totalTokens: 20,
    cachedInputTokens: 3,
    cacheCreationInputTokens: 4,
    cacheReadInputTokens: 2,
    reasoningOutputTokens: 1,
    estimatedCostUsd: 0.000032
  });
  assert.deepEqual(usageModels(logs, { pricing }), [
    {
      key: "codex:provider-replay:test-model",
      app: "codex",
      providerId: "provider-replay",
      model: "test-model",
      requestCount: 2,
      inputTokens: 9,
      outputTokens: 5,
      totalTokens: 20,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 2,
      reasoningOutputTokens: 1,
      estimatedCostUsd: 0.000032
    }
  ]);
});

test("local proxy replays duplicate associated streaming provider requests", async (t) => {
  let upstreamCalls = 0;
  const upstream = createServer(async (request, response) => {
    upstreamCalls += 1;
    assert.equal(request.url, "/v1/chat/completions");
    const body = JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>;
    assert.equal(body.stream, true);
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSseData(response, {
      id: "chatcmpl-stream-replay-1",
      created: 123,
      model: "chat-model",
      choices: [{ delta: { content: "he" } }]
    });
    writeSseData(response, {
      id: "chatcmpl-stream-replay-1",
      created: 123,
      model: "chat-model",
      choices: [{ delta: { content: "llo" }, finish_reason: "stop" }]
    });
    writeSseData(response, {
      id: "chatcmpl-stream-replay-1",
      created: 123,
      model: "chat-model",
      choices: [],
      usage: {
        prompt_tokens: 6,
        completion_tokens: 2,
        total_tokens: 8
      }
    });
    response.end("data: [DONE]\n\n");
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const replayRecords = new Map<string, ProxyReplayRecord>();
  const provider: ProviderRecord = {
    id: "provider-stream-replay",
    app: "codex",
    name: "Stream Replay",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    disableResponseStorage: true,
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-stream-replay-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    },
    getReplay: async (key) => replayRecords.get(key),
    saveReplay: async (record) => {
      replayRecords.set(record.key, record);
    },
    markReplayUsed: async (key) => {
      const current = replayRecords.get(key);
      if (current) replayRecords.set(key, { ...current, replayCount: current.replayCount + 1 });
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const url = `http://${status.host}:${status.port}/mn/runs/run-stream-replay/candidates/codex-1/v1/responses`;
  const body = JSON.stringify({ model: "chat-model", input: "hello", stream: true });
  const first = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  const firstBody = await first.text();
  const second = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  const secondBody = await second.text();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-mn-proxy-replay"), "hit");
  assert.equal(firstBody, secondBody);
  assert.match(firstBody, /event: response\.output_text\.delta/);
  assert.match(firstBody, /"delta":"he"/);
  assert.match(firstBody, /"delta":"llo"/);
  assert.match(firstBody, /event: response\.completed/);
  assert.equal(upstreamCalls, 1);
  assert.equal(replayRecords.size, 1);
  const replayRecord = [...replayRecords.values()][0];
  assert.equal(replayRecord?.replayCount, 1);
  assert.equal(Buffer.from(replayRecord?.bodyBase64 ?? "", "base64").toString("utf8"), firstBody);
  assert.equal(logs.length, 2);
  assert.equal(logs[0]?.replayed, undefined);
  assert.equal(logs[1]?.replayed, true);
  assert.equal(logs[1]?.inputTokens, 0);
  assert.equal(logs[1]?.outputTokens, 0);
  assert.equal(logs[1]?.cachedInputTokens, 0);
  assert.equal(logs[1]?.cacheCreationInputTokens, 0);
  assert.equal(logs[1]?.cacheReadInputTokens, 0);
  assert.equal(logs[1]?.reasoningOutputTokens, 0);
});

test("local proxy keeps tool-call replay behind provider opt-in", async (t) => {
  let upstreamCalls = 0;
  const upstream = createServer(async (request, response) => {
    upstreamCalls += 1;
    assert.equal(request.url, "/v1/chat/completions");
    const body = JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>;
    assert.equal(body.stream, true);
    const includeWriteFileTool = JSON.stringify(body).includes("weather and write?");
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSseData(response, {
      id: "chatcmpl-stream-tool-replay-1",
      created: 123,
      model: "chat-model",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_weather",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: "{\"city\""
                }
              },
              ...(includeWriteFileTool
                ? [
                    {
                      index: 1,
                      id: "call_write_file",
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: "{\"path\""
                      }
                    }
                  ]
                : [])
            ]
          }
        }
      ]
    });
    writeSseData(response, {
      id: "chatcmpl-stream-tool-replay-1",
      created: 123,
      model: "chat-model",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: ":\"Hangzhou\"}"
                }
              },
              ...(includeWriteFileTool
                ? [
                    {
                      index: 1,
                      function: {
                        arguments: ":\"/tmp/out\"}"
                      }
                    }
                  ]
                : [])
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    });
    writeSseData(response, {
      id: "chatcmpl-stream-tool-replay-1",
      created: 123,
      model: "chat-model",
      choices: [],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 4,
        total_tokens: 13
      }
    });
    response.end("data: [DONE]\n\n");
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const replayRecords = new Map<string, ProxyReplayRecord>();
  const provider: ProviderRecord = {
    id: "provider-stream-tool-replay",
    app: "codex",
    name: "Stream Tool Replay",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-stream-tool-replay-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    },
    getReplay: async (key) => replayRecords.get(key),
    saveReplay: async (record) => {
      replayRecords.set(record.key, record);
    },
    markReplayUsed: async (key) => {
      const current = replayRecords.get(key);
      if (current) replayRecords.set(key, { ...current, replayCount: current.replayCount + 1 });
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const url = `http://${status.host}:${status.port}/mn/runs/run-stream-tool-replay/candidates/codex-1/v1/responses`;
  const body = JSON.stringify({
    model: "chat-model",
    input: "weather?",
    stream: true,
    tools: [
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object", properties: { city: { type: "string" } } }
      }
    ]
  });
  const first = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  const firstBody = await first.text();
  const second = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  const secondBody = await second.text();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-mn-proxy-replay"), null);
  assert.equal(firstBody, secondBody);
  const events = parseSseEvents(secondBody);
  const argumentDeltas = events
    .filter((event) => event.event === "response.function_call_arguments.delta")
    .map((event) => String((event.data as Record<string, unknown>).delta ?? ""))
    .join("");
  assert.equal(argumentDeltas, "{\"city\":\"Hangzhou\"}");
  assert.ok(events.some((event) => event.event === "response.function_call_arguments.done"));
  assert.equal(upstreamCalls, 2);
  assert.equal(replayRecords.size, 0);
  assert.equal(logs.length, 2);
  assert.equal(logs[0]?.replayed, undefined);
  assert.equal(logs[1]?.replayed, undefined);
  assert.equal(logs[0]?.containsToolCall, true);
  assert.deepEqual(logs[0]?.toolCalls, [
    { name: "get_weather", effect: "unknown", replaySafe: false }
  ]);
  assert.deepEqual(logs[1]?.toolCalls, logs[0]?.toolCalls);
  assert.equal(logs[1]?.inputTokens, 9);
  assert.equal(logs[1]?.outputTokens, 4);

  provider.config = {
    toolReplayPolicy: {
      tools: {
        get_weather: "readonly"
      }
    }
  };
  const policyUrl = `http://${status.host}:${status.port}/mn/runs/run-stream-tool-replay-policy/candidates/codex-1/v1/responses`;
  const policyFirst = await fetch(policyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  const policyFirstBody = await policyFirst.text();
  const policySecond = await fetch(policyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  const policySecondBody = await policySecond.text();

  assert.equal(policyFirst.status, 200);
  assert.equal(policySecond.status, 200);
  assert.equal(policySecond.headers.get("x-mn-proxy-replay"), "hit");
  assert.equal(policyFirstBody, policySecondBody);
  assert.equal(upstreamCalls, 3);
  assert.equal(replayRecords.size, 1);
  const policyRecord = [...replayRecords.values()].find(
    (record) => record.runId === "run-stream-tool-replay-policy"
  );
  assert.ok(policyRecord);
  assert.equal(policyRecord.containsToolCall, true);
  assert.deepEqual(policyRecord.toolCalls, [
    { name: "get_weather", effect: "readonly", replaySafe: true }
  ]);
  assert.equal(logs.length, 4);
  assert.equal(logs[2]?.replayed, undefined);
  assert.equal(logs[3]?.replayed, true);
  assert.deepEqual(logs[2]?.toolCalls, [
    { name: "get_weather", effect: "readonly", replaySafe: true }
  ]);
  assert.deepEqual(logs[3]?.toolCalls, logs[2]?.toolCalls);

  provider.config = {
    toolReplayPolicy: {
      tools: {
        get_weather: "readonly",
        write_file: "side_effect"
      }
    }
  };
  const blockedPolicyUrl = `http://${status.host}:${status.port}/mn/runs/run-stream-tool-replay-side-effect/candidates/codex-1/v1/responses`;
  const blockedPolicyBody = JSON.stringify({
    model: "chat-model",
    input: "weather and write?",
    stream: true,
    tools: [
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object", properties: { city: { type: "string" } } }
      },
      {
        type: "function",
        name: "write_file",
        parameters: { type: "object", properties: { path: { type: "string" } } }
      }
    ]
  });
  const blockedPolicyFirst = await fetch(blockedPolicyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: blockedPolicyBody
  });
  await blockedPolicyFirst.text();
  const blockedPolicySecond = await fetch(blockedPolicyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: blockedPolicyBody
  });
  await blockedPolicySecond.text();

  assert.equal(blockedPolicyFirst.status, 200);
  assert.equal(blockedPolicySecond.status, 200);
  assert.equal(blockedPolicySecond.headers.get("x-mn-proxy-replay"), null);
  assert.equal(upstreamCalls, 5);
  assert.equal(replayRecords.size, 1);
  assert.equal(logs.length, 6);
  assert.equal(logs[4]?.replayed, undefined);
  assert.equal(logs[5]?.replayed, undefined);
  assert.deepEqual(logs[4]?.toolCalls, [
    { name: "get_weather", effect: "readonly", replaySafe: true },
    { name: "write_file", effect: "side_effect", replaySafe: false }
  ]);
  assert.deepEqual(logs[5]?.toolCalls, logs[4]?.toolCalls);

  provider.config = { replayToolCalls: true };
  const optInUrl = `http://${status.host}:${status.port}/mn/runs/run-stream-tool-replay-opt-in/candidates/codex-1/v1/responses`;
  const optInFirst = await fetch(optInUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  const optInFirstBody = await optInFirst.text();
  const optInSecond = await fetch(optInUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  const optInSecondBody = await optInSecond.text();

  assert.equal(optInFirst.status, 200);
  assert.equal(optInSecond.status, 200);
  assert.equal(optInSecond.headers.get("x-mn-proxy-replay"), "hit");
  assert.equal(optInFirstBody, optInSecondBody);
  assert.equal(upstreamCalls, 6);
  assert.equal(replayRecords.size, 2);
  const legacyRecord = [...replayRecords.values()].find(
    (record) => record.runId === "run-stream-tool-replay-opt-in"
  );
  assert.ok(legacyRecord);
  assert.equal(legacyRecord.containsToolCall, true);
  assert.deepEqual(legacyRecord.toolCalls, [
    { name: "get_weather", effect: "unknown", replaySafe: true }
  ]);
  assert.equal(logs.length, 8);
  assert.equal(logs[6]?.replayed, undefined);
  assert.equal(logs[7]?.replayed, true);
  assert.deepEqual(logs[6]?.toolCalls, [
    { name: "get_weather", effect: "unknown", replaySafe: true }
  ]);
  assert.deepEqual(logs[7]?.toolCalls, logs[6]?.toolCalls);

  provider.config = {};
  const oldRecordIgnored = await fetch(optInUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  await oldRecordIgnored.text();

  assert.equal(oldRecordIgnored.status, 200);
  assert.equal(oldRecordIgnored.headers.get("x-mn-proxy-replay"), null);
  assert.equal(upstreamCalls, 7);
  assert.equal(logs.length, 9);
  assert.equal(logs[8]?.replayed, undefined);
  assert.deepEqual(logs[8]?.toolCalls, [
    { name: "get_weather", effect: "unknown", replaySafe: false }
  ]);
});

test("local proxy converts Codex Responses requests for OpenAI Chat providers", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "chatcmpl-1",
        created: 123,
        model: "chat-model",
        choices: [
          {
            message: {
              role: "assistant",
              content: "hi there"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
          prompt_tokens_details: {
            cached_tokens: 1
          },
          completion_tokens_details: {
            reasoning_tokens: 1
          }
        }
      }));
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-chat",
    app: "codex",
    name: "Chat",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    disableResponseStorage: true,
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-chat-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const response = await fetch(`http://${status.host}:${status.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex"
    },
    body: JSON.stringify({
      model: "chat-model",
      instructions: "Be brief.",
      input: "hello",
      max_output_tokens: 32
    })
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.deepEqual(upstreamRequest?.body.messages, [
    { role: "system", content: "Be brief." },
    { role: "user", content: "hello" }
  ]);
  assert.equal(upstreamRequest?.body.model, "chat-model");
  assert.equal(upstreamRequest?.body.max_tokens, 32);
  assert.equal(upstreamRequest?.body.stream, false);

  const responseBody = await response.json() as Record<string, unknown>;
  assert.equal(responseBody.object, "response");
  assert.equal(responseBody.model, "chat-model");
  assert.equal(responseBody.output_text, "hi there");
  assert.deepEqual(responseBody.usage, {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
    input_tokens_details: {
      cached_tokens: 1
    },
    output_tokens_details: {
      reasoning_tokens: 1
    }
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.providerId, "provider-chat");
  assert.equal(logs[0]?.model, "chat-model");
  assert.equal(logs[0]?.inputTokens, 3);
  assert.equal(logs[0]?.outputTokens, 2);
  assert.equal(logs[0]?.cachedInputTokens, 1);
  assert.equal(logs[0]?.reasoningOutputTokens, 1);
});

test("local proxy converts Claude Messages requests for OpenAI Chat providers", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "chatcmpl-claude-1",
        created: 123,
        model: "chat-model",
        choices: [
          {
            message: {
              role: "assistant",
              content: "hello from chat"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 4,
          total_tokens: 13
        }
      }));
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-claude-chat",
    app: "claude",
    name: "Claude Chat",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "claude",
      provider,
      bearerToken: "sk-claude-chat-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const response = await fetch(`http://${status.host}:${status.port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "claude"
    },
    body: JSON.stringify({
      model: "claude-model",
      system: [{ type: "text", text: "Be brief." }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }]
        }
      ],
      max_tokens: 64,
      temperature: 0.2
    })
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.equal(upstreamRequest?.body.model, "chat-model");
  assert.deepEqual(upstreamRequest?.body.messages, [
    { role: "system", content: "Be brief." },
    { role: "user", content: "hello" }
  ]);
  assert.equal(upstreamRequest?.body.max_tokens, 64);
  assert.equal(upstreamRequest?.body.temperature, 0.2);
  assert.equal(upstreamRequest?.body.stream, false);

  const responseBody = await response.json() as Record<string, unknown>;
  assert.equal(responseBody.type, "message");
  assert.equal(responseBody.role, "assistant");
  assert.equal(responseBody.model, "chat-model");
  assert.equal(responseBody.stop_reason, "end_turn");
  assert.deepEqual(responseBody.content, [
    { type: "text", text: "hello from chat" }
  ]);
  assert.deepEqual(responseBody.usage, {
    input_tokens: 9,
    output_tokens: 4
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.app, "claude");
  assert.equal(logs[0]?.providerId, "provider-claude-chat");
  assert.equal(logs[0]?.model, "claude-model");
  assert.equal(logs[0]?.inputTokens, 9);
  assert.equal(logs[0]?.outputTokens, 4);
});

test("local proxy converts Claude Messages requests for OpenAI Responses providers", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "resp-claude-1",
        model: "responses-model",
        output_text: "hello from responses",
        stop_reason: "stop",
        usage: {
          input_tokens: 13,
          output_tokens: 5,
          total_tokens: 18
        }
      }));
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-claude-responses",
    app: "claude",
    name: "Claude Responses",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "responses-model",
    wireApi: "responses",
    modelCatalog: [{ id: "responses-model", displayName: "Responses model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "claude",
      provider,
      bearerToken: "sk-claude-responses-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const response = await fetch(`http://${status.host}:${status.port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "claude"
    },
    body: JSON.stringify({
      model: "claude-model",
      system: "Be brief.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }]
        }
      ],
      max_tokens: 48,
      temperature: 0.1
    })
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamRequest?.url, "/v1/responses");
  assert.equal(upstreamRequest?.body.model, "responses-model");
  assert.equal(upstreamRequest?.body.instructions, "Be brief.");
  assert.deepEqual(upstreamRequest?.body.input, [
    { role: "user", content: "hello" }
  ]);
  assert.equal(upstreamRequest?.body.max_output_tokens, 48);
  assert.equal(upstreamRequest?.body.temperature, 0.1);
  assert.equal(upstreamRequest?.body.stream, false);

  const responseBody = await response.json() as Record<string, unknown>;
  assert.equal(responseBody.type, "message");
  assert.equal(responseBody.role, "assistant");
  assert.equal(responseBody.model, "responses-model");
  assert.equal(responseBody.stop_reason, "end_turn");
  assert.deepEqual(responseBody.content, [
    { type: "text", text: "hello from responses" }
  ]);
  assert.deepEqual(responseBody.usage, {
    input_tokens: 13,
    output_tokens: 5
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.app, "claude");
  assert.equal(logs[0]?.providerId, "provider-claude-responses");
  assert.equal(logs[0]?.inputTokens, 13);
  assert.equal(logs[0]?.outputTokens, 5);
});

test("local proxy maps Codex Responses tools through OpenAI Chat providers", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "chatcmpl-tool-1",
        created: 123,
        model: "chat-model",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_weather",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: "{\"city\":\"Hangzhou\"}"
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 6,
          total_tokens: 21
        }
      }));
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-chat-tools",
    app: "codex",
    name: "Chat Tools",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    disableResponseStorage: true,
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-chat-tools-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const response = await fetch(`http://${status.host}:${status.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex"
    },
    body: JSON.stringify({
      model: "chat-model",
      input: [
        { role: "user", content: "weather?" },
        { type: "function_call_output", call_id: "call_previous", output: "sunny" }
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather.",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string" }
            },
            required: ["city"]
          }
        }
      ],
      tool_choice: { type: "function", name: "get_weather" }
    })
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.deepEqual(upstreamRequest?.body.messages, [
    { role: "user", content: "weather?" },
    { role: "tool", tool_call_id: "call_previous", content: "sunny" }
  ]);
  assert.deepEqual(upstreamRequest?.body.tools, [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather.",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" }
          },
          required: ["city"]
        }
      }
    }
  ]);
  assert.deepEqual(upstreamRequest?.body.tool_choice, {
    type: "function",
    function: { name: "get_weather" }
  });

  const responseBody = await response.json() as Record<string, unknown>;
  assert.equal(responseBody.object, "response");
  assert.equal(responseBody.output_text, "");
  assert.deepEqual(responseBody.output, [
    {
      id: "call_weather",
      type: "function_call",
      status: "completed",
      call_id: "call_weather",
      name: "get_weather",
      arguments: "{\"city\":\"Hangzhou\"}"
    }
  ]);
  assert.equal(logs[0]?.inputTokens, 15);
  assert.equal(logs[0]?.outputTokens, 6);
});

test("local proxy maps Claude tools through OpenAI Chat providers", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "chatcmpl-claude-tool-1",
        created: 123,
        model: "chat-model",
        choices: [
          {
            message: {
              role: "assistant",
              content: "I will check.",
              tool_calls: [
                {
                  id: "toolu_weather",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: "{\"city\":\"Hangzhou\"}"
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: {
          prompt_tokens: 18,
          completion_tokens: 8,
          total_tokens: 26
        }
      }));
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-claude-chat-tools",
    app: "claude",
    name: "Claude Chat Tools",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "claude",
      provider,
      bearerToken: "sk-claude-chat-tools-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const response = await fetch(`http://${status.host}:${status.port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "claude"
    },
    body: JSON.stringify({
      model: "claude-model",
      messages: [
        {
          role: "user",
          content: "weather?"
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_previous",
              name: "get_weather",
              input: { city: "Hangzhou" }
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_previous",
              content: "sunny"
            }
          ]
        }
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get weather.",
          input_schema: {
            type: "object",
            properties: {
              city: { type: "string" }
            }
          }
        }
      ],
      tool_choice: { type: "tool", name: "get_weather" },
      max_tokens: 64
    })
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.deepEqual(upstreamRequest?.body.messages, [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "toolu_previous",
          type: "function",
          function: {
            name: "get_weather",
            arguments: "{\"city\":\"Hangzhou\"}"
          }
        }
      ]
    },
    { role: "tool", tool_call_id: "toolu_previous", content: "sunny" }
  ]);
  assert.deepEqual(upstreamRequest?.body.tools, [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather.",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" }
          }
        }
      }
    }
  ]);
  assert.deepEqual(upstreamRequest?.body.tool_choice, {
    type: "function",
    function: { name: "get_weather" }
  });

  const responseBody = await response.json() as Record<string, unknown>;
  assert.equal(responseBody.stop_reason, "tool_use");
  assert.deepEqual(responseBody.content, [
    { type: "text", text: "I will check." },
    {
      type: "tool_use",
      id: "toolu_weather",
      name: "get_weather",
      input: { city: "Hangzhou" }
    }
  ]);
  assert.equal(logs[0]?.inputTokens, 18);
  assert.equal(logs[0]?.outputTokens, 8);
});

test("local proxy maps Claude tools through OpenAI Responses providers", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "resp-claude-tool-1",
        model: "responses-model",
        output: [
          {
            type: "function_call",
            call_id: "toolu_weather",
            name: "get_weather",
            arguments: "{\"city\":\"Hangzhou\"}",
            status: "completed"
          }
        ],
        usage: {
          input_tokens: 17,
          output_tokens: 7,
          total_tokens: 24
        }
      }));
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-claude-responses-tools",
    app: "claude",
    name: "Claude Responses Tools",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "responses-model",
    wireApi: "responses",
    modelCatalog: [{ id: "responses-model", displayName: "Responses model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "claude",
      provider,
      bearerToken: "sk-claude-responses-tools-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const response = await fetch(`http://${status.host}:${status.port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "claude"
    },
    body: JSON.stringify({
      model: "claude-model",
      messages: [
        {
          role: "user",
          content: "weather?"
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_previous",
              name: "get_weather",
              input: { city: "Hangzhou" }
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_previous",
              content: "sunny"
            }
          ]
        }
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get weather.",
          input_schema: {
            type: "object",
            properties: {
              city: { type: "string" }
            }
          }
        }
      ],
      tool_choice: { type: "any" },
      max_tokens: 64
    })
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamRequest?.url, "/v1/responses");
  assert.deepEqual(upstreamRequest?.body.input, [
    { role: "user", content: "weather?" },
    {
      type: "function_call",
      call_id: "toolu_previous",
      name: "get_weather",
      arguments: "{\"city\":\"Hangzhou\"}"
    },
    {
      type: "function_call_output",
      call_id: "toolu_previous",
      output: "sunny"
    }
  ]);
  assert.deepEqual(upstreamRequest?.body.tools, [
    {
      type: "function",
      name: "get_weather",
      description: "Get weather.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" }
        }
      }
    }
  ]);
  assert.equal(upstreamRequest?.body.tool_choice, "required");

  const responseBody = await response.json() as Record<string, unknown>;
  assert.equal(responseBody.stop_reason, "tool_use");
  assert.deepEqual(responseBody.content, [
    {
      type: "tool_use",
      id: "toolu_weather",
      name: "get_weather",
      input: { city: "Hangzhou" }
    }
  ]);
  assert.equal(logs[0]?.inputTokens, 17);
  assert.equal(logs[0]?.outputTokens, 7);
});

test("local proxy converts streaming Chat Completions SSE to Responses SSE", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    writeSseData(response, {
      id: "chatcmpl-stream-1",
      created: 123,
      model: "chat-model",
      choices: [{ delta: { role: "assistant" } }]
    });
    writeSseData(response, {
      id: "chatcmpl-stream-1",
      created: 123,
      model: "chat-model",
      choices: [{ delta: { content: "hel" } }]
    });
    setTimeout(() => {
      writeSseData(response, {
        id: "chatcmpl-stream-1",
        created: 123,
        model: "chat-model",
        choices: [{ delta: { content: "lo" }, finish_reason: "stop" }]
      });
      writeSseData(response, {
        id: "chatcmpl-stream-1",
        created: 123,
        model: "chat-model",
        choices: [],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 3,
          total_tokens: 10,
          prompt_tokens_details: {
            cached_tokens: 2
          },
          completion_tokens_details: {
            reasoning_tokens: 1
          }
        }
      });
      response.end("data: [DONE]\n\n");
    }, 200);
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-chat-sse",
    app: "codex",
    name: "Chat SSE",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    disableResponseStorage: true,
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-chat-sse-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const stream = await readStreamingResponse(
    `http://${status.host}:${status.port}/v1/responses`,
    JSON.stringify({ model: "chat-model", input: "hello", stream: true })
  );

  assert.equal(stream.statusCode, 200);
  assert.match(stream.contentType, /text\/event-stream/);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.equal(upstreamRequest?.body.stream, true);
  assert.match(stream.body, /event: response\.output_text\.delta/);
  assert.match(stream.body, /"delta":"hel"/);
  assert.match(stream.body, /"delta":"lo"/);
  assert.match(stream.body, /event: response\.completed/);
  assert.match(stream.body, /"output_text":"hello"/);
  assert.match(stream.body, /"input_tokens":7/);
  assert.match(stream.body, /"cached_tokens":2/);
  assert.match(stream.body, /"reasoning_tokens":1/);
  assert.ok(
    stream.firstChunkAtMs < stream.endAtMs - 100,
    `expected first converted SSE chunk before response end; first=${stream.firstChunkAtMs}ms end=${stream.endAtMs}ms`
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.providerId, "provider-chat-sse");
  assert.equal(logs[0]?.model, "chat-model");
  assert.equal(logs[0]?.inputTokens, 7);
  assert.equal(logs[0]?.outputTokens, 3);
  assert.equal(logs[0]?.cachedInputTokens, 2);
  assert.equal(logs[0]?.reasoningOutputTokens, 1);
});

test("local proxy converts streaming Chat Completions tool call deltas to Responses SSE", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    writeSseData(response, {
      id: "chatcmpl-stream-tool-1",
      created: 123,
      model: "chat-model",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_weather",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: "{\"city\""
                }
              }
            ]
          }
        }
      ]
    });
    setTimeout(() => {
      writeSseData(response, {
        id: "chatcmpl-stream-tool-1",
        created: 123,
        model: "chat-model",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: ":\"Hangzhou\"}"
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ]
      });
      writeSseData(response, {
        id: "chatcmpl-stream-tool-1",
        created: 123,
        model: "chat-model",
        choices: [],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 4,
          total_tokens: 13
        }
      });
      response.end("data: [DONE]\n\n");
    }, 200);
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-chat-sse-tools",
    app: "codex",
    name: "Chat SSE Tools",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-chat-sse-tools-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const stream = await readStreamingResponse(
    `http://${status.host}:${status.port}/v1/responses`,
    JSON.stringify({
      model: "chat-model",
      input: "weather?",
      stream: true,
      tools: [
        {
          type: "function",
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      ]
    })
  );

  assert.equal(stream.statusCode, 200);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.equal(upstreamRequest?.body.stream, true);
  const events = parseSseEvents(stream.body);
  assert.ok(events.some((event) => event.event === "response.output_item.added"));
  const argumentDeltas = events
    .filter((event) => event.event === "response.function_call_arguments.delta")
    .map((event) => String((event.data as Record<string, unknown>).delta ?? ""))
    .join("");
  assert.equal(argumentDeltas, "{\"city\":\"Hangzhou\"}");
  assert.ok(events.some((event) => event.event === "response.function_call_arguments.done"));
  const completed = events.find((event) => event.event === "response.completed")?.data as Record<string, unknown>;
  const completedResponse = completed.response as Record<string, unknown>;
  assert.deepEqual(completedResponse.output, [
    {
      id: "call_weather",
      type: "function_call",
      status: "completed",
      call_id: "call_weather",
      name: "get_weather",
      arguments: "{\"city\":\"Hangzhou\"}"
    }
  ]);
  assert.equal(completedResponse.stop_reason, "tool_calls");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.providerId, "provider-chat-sse-tools");
  assert.equal(logs[0]?.inputTokens, 9);
  assert.equal(logs[0]?.outputTokens, 4);
});

test("local proxy keeps interleaved streaming Chat tool calls separate in Responses SSE", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    writeSseData(response, {
      id: "chatcmpl-stream-multi-tool-1",
      created: 123,
      model: "chat-model",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_weather",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: "{\"city\""
                }
              },
              {
                index: 1,
                id: "call_search",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: "{\"query\""
                }
              }
            ]
          }
        }
      ]
    });
    setTimeout(() => {
      writeSseData(response, {
        id: "chatcmpl-stream-multi-tool-1",
        created: 123,
        model: "chat-model",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  function: {
                    arguments: ":\"latest ai\"}"
                  }
                },
                {
                  index: 0,
                  function: {
                    arguments: ":\"Hangzhou\"}"
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ]
      });
      writeSseData(response, {
        id: "chatcmpl-stream-multi-tool-1",
        created: 123,
        model: "chat-model",
        choices: [],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 7,
          total_tokens: 22
        }
      });
      response.end("data: [DONE]\n\n");
    }, 200);
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-chat-sse-multi-tools",
    app: "codex",
    name: "Chat SSE Multi Tools",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-chat-sse-multi-tools-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const stream = await readStreamingResponse(
    `http://${status.host}:${status.port}/v1/responses`,
    JSON.stringify({
      model: "chat-model",
      input: "weather and search?",
      stream: true,
      tools: [
        {
          type: "function",
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        },
        {
          type: "function",
          name: "web_search",
          parameters: { type: "object", properties: { query: { type: "string" } } }
        }
      ]
    })
  );

  assert.equal(stream.statusCode, 200);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.equal(upstreamRequest?.body.stream, true);
  const events = parseSseEvents(stream.body);
  const addedItems = events
    .filter((event) => event.event === "response.output_item.added")
    .map((event) => (event.data as Record<string, unknown>).item as Record<string, unknown>);
  assert.deepEqual(
    addedItems.map((item) => [item.id, item.call_id, item.name]),
    [
      ["call_weather", "call_weather", "get_weather"],
      ["call_search", "call_search", "web_search"]
    ]
  );
  const argumentDeltas = new Map<string, string>();
  for (const event of events.filter((candidate) => candidate.event === "response.function_call_arguments.delta")) {
    const data = event.data as Record<string, unknown>;
    const itemId = String(data.item_id);
    argumentDeltas.set(itemId, `${argumentDeltas.get(itemId) ?? ""}${String(data.delta ?? "")}`);
  }
  assert.equal(argumentDeltas.get("call_weather"), "{\"city\":\"Hangzhou\"}");
  assert.equal(argumentDeltas.get("call_search"), "{\"query\":\"latest ai\"}");
  const completed = events.find((event) => event.event === "response.completed")?.data as Record<string, unknown>;
  const completedResponse = completed.response as Record<string, unknown>;
  assert.deepEqual(completedResponse.output, [
    {
      id: "call_weather",
      type: "function_call",
      status: "completed",
      call_id: "call_weather",
      name: "get_weather",
      arguments: "{\"city\":\"Hangzhou\"}"
    },
    {
      id: "call_search",
      type: "function_call",
      status: "completed",
      call_id: "call_search",
      name: "web_search",
      arguments: "{\"query\":\"latest ai\"}"
    }
  ]);
  assert.equal(completedResponse.stop_reason, "tool_calls");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.providerId, "provider-chat-sse-multi-tools");
  assert.equal(logs[0]?.inputTokens, 15);
  assert.equal(logs[0]?.outputTokens, 7);
});

test("local proxy estimates streaming token usage when SSE omits final usage", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    writeSseData(response, {
      id: "chatcmpl-stream-estimate-1",
      created: 123,
      model: "chat-model",
      choices: [{ delta: { content: "he" } }]
    });
    setTimeout(() => {
      writeSseData(response, {
        id: "chatcmpl-stream-estimate-1",
        created: 123,
        model: "chat-model",
        choices: [{ delta: { content: "llo" }, finish_reason: "stop" }]
      });
      response.end("data: [DONE]\n\n");
    }, 200);
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-chat-sse-estimate",
    app: "codex",
    name: "Chat SSE Estimate",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-chat-sse-estimate-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const stream = await readStreamingResponse(
    `http://${status.host}:${status.port}/v1/responses`,
    JSON.stringify({ model: "chat-model", input: "hello world", stream: true })
  );

  assert.equal(stream.statusCode, 200);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.match(stream.body, /event: response\.output_text\.delta/);
  assert.match(stream.body, /"delta":"he"/);
  assert.match(stream.body, /"delta":"llo"/);
  assert.match(stream.body, /event: response\.completed/);
  assert.match(stream.body, /"input_tokens":3/);
  assert.match(stream.body, /"output_tokens":2/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.providerId, "provider-chat-sse-estimate");
  assert.equal(logs[0]?.inputTokens, 3);
  assert.equal(logs[0]?.outputTokens, 2);
});

test("local proxy converts streaming Claude Messages through Chat SSE", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    writeSseData(response, {
      id: "chatcmpl-claude-stream-1",
      created: 123,
      model: "chat-model",
      choices: [{ delta: { content: "he" } }]
    });
    setTimeout(() => {
      writeSseData(response, {
        id: "chatcmpl-claude-stream-1",
        created: 123,
        model: "chat-model",
        choices: [{ delta: { content: "llo" }, finish_reason: "stop" }]
      });
      response.end("data: [DONE]\n\n");
    }, 200);
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-claude-chat-sse",
    app: "claude",
    name: "Claude Chat SSE",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "claude",
      provider,
      bearerToken: "sk-claude-chat-sse-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const stream = await readStreamingResponse(
    `http://${status.host}:${status.port}/v1/messages`,
    JSON.stringify({
      model: "claude-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 64,
      stream: true
    }),
    "claude"
  );

  assert.equal(stream.statusCode, 200);
  assert.match(stream.contentType, /text\/event-stream/);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.equal(upstreamRequest?.body.model, "chat-model");
  assert.equal(upstreamRequest?.body.stream, true);
  assert.match(stream.body, /event: message_start/);
  assert.match(stream.body, /event: content_block_delta/);
  assert.match(stream.body, /"text":"he"/);
  assert.match(stream.body, /"text":"llo"/);
  assert.match(stream.body, /"input_tokens":2/);
  assert.match(stream.body, /"output_tokens":2/);
  assert.match(stream.body, /event: message_stop/);
  assert.ok(
    stream.firstChunkAtMs < stream.endAtMs - 100,
    `expected first converted Claude SSE chunk before response end; first=${stream.firstChunkAtMs}ms end=${stream.endAtMs}ms`
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.app, "claude");
  assert.equal(logs[0]?.providerId, "provider-claude-chat-sse");
  assert.equal(logs[0]?.inputTokens, 2);
  assert.equal(logs[0]?.outputTokens, 2);
});

test("local proxy converts streaming Claude Messages through Chat tool call SSE", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    writeSseData(response, {
      id: "chatcmpl-claude-stream-tool-1",
      created: 123,
      model: "chat-model",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "toolu_weather",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: "{\"city\""
                }
              }
            ]
          }
        }
      ]
    });
    setTimeout(() => {
      writeSseData(response, {
        id: "chatcmpl-claude-stream-tool-1",
        created: 123,
        model: "chat-model",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: ":\"Hangzhou\"}"
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
          total_tokens: 17
        }
      });
      response.end("data: [DONE]\n\n");
    }, 200);
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-claude-chat-sse-tools",
    app: "claude",
    name: "Claude Chat SSE Tools",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "claude",
      provider,
      bearerToken: "sk-claude-chat-sse-tools-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const stream = await readStreamingResponse(
    `http://${status.host}:${status.port}/v1/messages`,
    JSON.stringify({
      model: "claude-model",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          name: "get_weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } }
        }
      ],
      max_tokens: 64,
      stream: true
    }),
    "claude"
  );

  assert.equal(stream.statusCode, 200);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.equal(upstreamRequest?.body.stream, true);
  const events = parseSseEvents(stream.body);
  const toolStart = events
    .filter((event) => event.event === "content_block_start")
    .map((event) => event.data as Record<string, unknown>)
    .find((event) => (event.content_block as Record<string, unknown>).type === "tool_use");
  assert.deepEqual(toolStart?.content_block, {
    type: "tool_use",
    id: "toolu_weather",
    name: "get_weather",
    input: {}
  });
  const argumentDeltas = events
    .filter((event) => event.event === "content_block_delta")
    .map((event) => event.data as Record<string, unknown>)
    .filter((event) => (event.delta as Record<string, unknown>).type === "input_json_delta")
    .map((event) => String((event.delta as Record<string, unknown>).partial_json ?? ""))
    .join("");
  assert.equal(argumentDeltas, "{\"city\":\"Hangzhou\"}");
  const messageDelta = events.find((event) => event.event === "message_delta")?.data as Record<string, unknown>;
  assert.deepEqual(messageDelta.delta, { stop_reason: "tool_use", stop_sequence: null });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.app, "claude");
  assert.equal(logs[0]?.providerId, "provider-claude-chat-sse-tools");
  assert.equal(logs[0]?.inputTokens, 12);
  assert.equal(logs[0]?.outputTokens, 5);
});

test("local proxy keeps interleaved streaming Chat tool calls separate in Anthropic SSE", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    writeSseData(response, {
      id: "chatcmpl-claude-stream-multi-tool-1",
      created: 123,
      model: "chat-model",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "toolu_weather",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: "{\"city\""
                }
              },
              {
                index: 1,
                id: "toolu_search",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: "{\"query\""
                }
              }
            ]
          }
        }
      ]
    });
    setTimeout(() => {
      writeSseData(response, {
        id: "chatcmpl-claude-stream-multi-tool-1",
        created: 123,
        model: "chat-model",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  function: {
                    arguments: ":\"latest ai\"}"
                  }
                },
                {
                  index: 0,
                  function: {
                    arguments: ":\"Hangzhou\"}"
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: {
          prompt_tokens: 16,
          completion_tokens: 8,
          total_tokens: 24
        }
      });
      response.end("data: [DONE]\n\n");
    }, 200);
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-claude-chat-sse-multi-tools",
    app: "claude",
    name: "Claude Chat SSE Multi Tools",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "chat-model",
    wireApi: "chat",
    modelCatalog: [{ id: "chat-model", displayName: "Chat model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "claude",
      provider,
      bearerToken: "sk-claude-chat-sse-multi-tools-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const stream = await readStreamingResponse(
    `http://${status.host}:${status.port}/v1/messages`,
    JSON.stringify({
      model: "claude-model",
      messages: [{ role: "user", content: "weather and search?" }],
      tools: [
        {
          name: "get_weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } }
        },
        {
          name: "web_search",
          input_schema: { type: "object", properties: { query: { type: "string" } } }
        }
      ],
      max_tokens: 64,
      stream: true
    }),
    "claude"
  );

  assert.equal(stream.statusCode, 200);
  assert.equal(upstreamRequest?.url, "/v1/chat/completions");
  assert.equal(upstreamRequest?.body.stream, true);
  const events = parseSseEvents(stream.body);
  const toolStarts = events
    .filter((event) => event.event === "content_block_start")
    .map((event) => event.data as Record<string, unknown>)
    .filter((event) => (event.content_block as Record<string, unknown>).type === "tool_use");
  assert.deepEqual(
    toolStarts.map((event) => [event.index, (event.content_block as Record<string, unknown>).id, (event.content_block as Record<string, unknown>).name]),
    [
      [0, "toolu_weather", "get_weather"],
      [1, "toolu_search", "web_search"]
    ]
  );
  const argumentDeltas = new Map<number, string>();
  for (const event of events.filter((candidate) => candidate.event === "content_block_delta")) {
    const data = event.data as Record<string, unknown>;
    const delta = data.delta as Record<string, unknown>;
    if (delta.type !== "input_json_delta") continue;
    const index = Number(data.index);
    argumentDeltas.set(index, `${argumentDeltas.get(index) ?? ""}${String(delta.partial_json ?? "")}`);
  }
  assert.equal(argumentDeltas.get(0), "{\"city\":\"Hangzhou\"}");
  assert.equal(argumentDeltas.get(1), "{\"query\":\"latest ai\"}");
  const messageDelta = events.find((event) => event.event === "message_delta")?.data as Record<string, unknown>;
  assert.deepEqual(messageDelta.delta, { stop_reason: "tool_use", stop_sequence: null });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.app, "claude");
  assert.equal(logs[0]?.providerId, "provider-claude-chat-sse-multi-tools");
  assert.equal(logs[0]?.inputTokens, 16);
  assert.equal(logs[0]?.outputTokens, 8);
});

test("local proxy converts streaming Claude Messages through Responses SSE", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    writeSseData(response, {
      type: "response.created",
      response: {
        id: "resp-claude-responses-stream-1",
        model: "responses-model",
        output: []
      }
    });
    writeSseData(response, {
      type: "response.output_text.delta",
      response_id: "resp-claude-responses-stream-1",
      delta: "he"
    });
    setTimeout(() => {
      writeSseData(response, {
        type: "response.output_text.delta",
        response_id: "resp-claude-responses-stream-1",
        delta: "llo"
      });
      writeSseData(response, {
        type: "response.completed",
        response: {
          id: "resp-claude-responses-stream-1",
          model: "responses-model",
          output_text: "hello",
          stop_reason: "stop",
          usage: {
            input_tokens: 14,
            output_tokens: 5,
            total_tokens: 19
          }
        }
      });
      response.end("data: [DONE]\n\n");
    }, 200);
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-claude-responses-sse",
    app: "claude",
    name: "Claude Responses SSE",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "responses-model",
    wireApi: "responses",
    modelCatalog: [{ id: "responses-model", displayName: "Responses model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "claude",
      provider,
      bearerToken: "sk-claude-responses-sse-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const stream = await readStreamingResponse(
    `http://${status.host}:${status.port}/v1/messages`,
    JSON.stringify({
      model: "claude-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 64,
      stream: true
    }),
    "claude"
  );

  assert.equal(stream.statusCode, 200);
  assert.match(stream.contentType, /text\/event-stream/);
  assert.equal(upstreamRequest?.url, "/v1/responses");
  assert.equal(upstreamRequest?.body.model, "responses-model");
  assert.equal(upstreamRequest?.body.stream, true);
  assert.match(stream.body, /event: message_start/);
  assert.match(stream.body, /event: content_block_delta/);
  assert.match(stream.body, /"text":"he"/);
  assert.match(stream.body, /"text":"llo"/);
  assert.match(stream.body, /event: message_stop/);
  assert.ok(
    stream.firstChunkAtMs < stream.endAtMs - 100,
    `expected first converted Claude Responses SSE chunk before response end; first=${stream.firstChunkAtMs}ms end=${stream.endAtMs}ms`
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.app, "claude");
  assert.equal(logs[0]?.providerId, "provider-claude-responses-sse");
  assert.equal(logs[0]?.model, "responses-model");
  assert.equal(logs[0]?.inputTokens, 14);
  assert.equal(logs[0]?.outputTokens, 5);
});

test("local proxy converts streaming Claude Messages through Responses tool call SSE", async (t) => {
  let upstreamRequest:
    | { url: string; body: Record<string, unknown> }
    | undefined;
  const upstream = createServer(async (request, response) => {
    upstreamRequest = {
      url: request.url ?? "",
      body: JSON.parse((await readIncomingRequestBody(request)).toString("utf8")) as Record<string, unknown>
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    writeSseData(response, {
      type: "response.created",
      response: {
        id: "resp-claude-responses-stream-tool-1",
        model: "responses-model",
        output: []
      }
    });
    writeSseData(response, {
      type: "response.output_item.added",
      response_id: "resp-claude-responses-stream-tool-1",
      output_index: 0,
      item: {
        id: "fc_weather",
        type: "function_call",
        status: "in_progress",
        call_id: "toolu_weather",
        name: "get_weather",
        arguments: ""
      }
    });
    writeSseData(response, {
      type: "response.function_call_arguments.delta",
      response_id: "resp-claude-responses-stream-tool-1",
      item_id: "fc_weather",
      output_index: 0,
      delta: "{\"city\""
    });
    setTimeout(() => {
      writeSseData(response, {
        type: "response.function_call_arguments.delta",
        response_id: "resp-claude-responses-stream-tool-1",
        item_id: "fc_weather",
        output_index: 0,
        delta: ":\"Hangzhou\"}"
      });
      writeSseData(response, {
        type: "response.output_item.done",
        response_id: "resp-claude-responses-stream-tool-1",
        output_index: 0,
        item: {
          id: "fc_weather",
          type: "function_call",
          status: "completed",
          call_id: "toolu_weather",
          name: "get_weather",
          arguments: "{\"city\":\"Hangzhou\"}"
        }
      });
      writeSseData(response, {
        type: "response.completed",
        response: {
          id: "resp-claude-responses-stream-tool-1",
          model: "responses-model",
          output: [
            {
              id: "fc_weather",
              type: "function_call",
              status: "completed",
              call_id: "toolu_weather",
              name: "get_weather",
              arguments: "{\"city\":\"Hangzhou\"}"
            }
          ],
          stop_reason: "tool_calls",
          usage: {
            input_tokens: 13,
            output_tokens: 6,
            total_tokens: 19
          }
        }
      });
      response.end("data: [DONE]\n\n");
    }, 200);
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-claude-responses-sse-tools",
    app: "claude",
    name: "Claude Responses SSE Tools",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    defaultModel: "responses-model",
    wireApi: "responses",
    modelCatalog: [{ id: "responses-model", displayName: "Responses model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "claude",
      provider,
      bearerToken: "sk-claude-responses-sse-tools-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const stream = await readStreamingResponse(
    `http://${status.host}:${status.port}/v1/messages`,
    JSON.stringify({
      model: "claude-model",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          name: "get_weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } }
        }
      ],
      max_tokens: 64,
      stream: true
    }),
    "claude"
  );

  assert.equal(stream.statusCode, 200);
  assert.equal(upstreamRequest?.url, "/v1/responses");
  assert.equal(upstreamRequest?.body.stream, true);
  const events = parseSseEvents(stream.body);
  const toolStart = events
    .filter((event) => event.event === "content_block_start")
    .map((event) => event.data as Record<string, unknown>)
    .find((event) => (event.content_block as Record<string, unknown>).type === "tool_use");
  assert.deepEqual(toolStart?.content_block, {
    type: "tool_use",
    id: "toolu_weather",
    name: "get_weather",
    input: {}
  });
  const argumentDeltas = events
    .filter((event) => event.event === "content_block_delta")
    .map((event) => event.data as Record<string, unknown>)
    .filter((event) => (event.delta as Record<string, unknown>).type === "input_json_delta")
    .map((event) => String((event.delta as Record<string, unknown>).partial_json ?? ""))
    .join("");
  assert.equal(argumentDeltas, "{\"city\":\"Hangzhou\"}");
  const messageDelta = events.find((event) => event.event === "message_delta")?.data as Record<string, unknown>;
  assert.deepEqual(messageDelta.delta, { stop_reason: "tool_use", stop_sequence: null });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.app, "claude");
  assert.equal(logs[0]?.providerId, "provider-claude-responses-sse-tools");
  assert.equal(logs[0]?.model, "responses-model");
  assert.equal(logs[0]?.inputTokens, 13);
  assert.equal(logs[0]?.outputTokens, 6);
});

test("local proxy streams SSE responses without buffering until completion", async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    response.write("data: first\n\n");
    setTimeout(() => {
      response.end("data: second\n\n");
    }, 200);
  });
  await listen(upstream);
  t.after(() => {
    upstream.close();
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const logs: ProxyRequestLog[] = [];
  const provider: ProviderRecord = {
    id: "provider-sse",
    app: "codex",
    name: "SSE",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    defaultModel: "stream-model",
    disableResponseStorage: true,
    wireApi: "responses",
    modelCatalog: [{ id: "stream-model", displayName: "Stream model" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "sk-sse-test"
    }),
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const stream = await readStreamingResponse(
    `http://${status.host}:${status.port}/v1/responses`,
    JSON.stringify({ model: "stream-model", stream: true })
  );

  assert.equal(stream.statusCode, 200);
  assert.equal(stream.body, "data: first\n\ndata: second\n\n");
  assert.ok(
    stream.firstChunkAtMs < stream.endAtMs - 100,
    `expected first SSE chunk before response end; first=${stream.firstChunkAtMs}ms end=${stream.endAtMs}ms`
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.statusCode, 200);
});

test("local proxy fails over to the next provider on retryable status", async (t) => {
  const primaryUpstream = createServer((_request, response) => {
    response
      .writeHead(500, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "primary failed" }));
  });
  const fallbackUpstream = createServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ model: "fallback-model", ok: true }));
  });
  await listen(primaryUpstream);
  await listen(fallbackUpstream);
  t.after(() => {
    primaryUpstream.close();
    fallbackUpstream.close();
  });
  const primaryAddress = primaryUpstream.address() as AddressInfo;
  const fallbackAddress = fallbackUpstream.address() as AddressInfo;
  const primary = makeProvider("provider-primary", `http://127.0.0.1:${primaryAddress.port}`);
  const fallback = makeProvider("provider-fallback", `http://127.0.0.1:${fallbackAddress.port}`);
  const logs: ProviderUsageAttemptLog[] = [];
  const healthEvents: ProviderHealthEvent[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({
      app: "codex",
      provider: primary
    }),
    resolveProviders: async () => [
      { app: "codex", provider: primary },
      { app: "codex", provider: fallback }
    ],
    appendLog: async (log) => {
      logs.push(log);
    },
    recordProviderHealth: async (event) => {
      healthEvents.push(event);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const response = await fetch(`http://${status.host}:${status.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex"
    },
    body: JSON.stringify({ model: "fallback-model", input: "hello" })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { model: "fallback-model", ok: true });
  assert.equal(logs.length, 2);
  assert.deepEqual(
    logs.map((log) => [log.providerId, log.statusCode]),
    [
      ["provider-primary", 500],
      ["provider-fallback", 200]
    ]
  );
  assert.equal(logs[0]?.usageAttempt.logicalRequestId,
    logs[1]?.usageAttempt.logicalRequestId);
  assert.deepEqual(
    logs.map((log) => log.usageAttempt),
    [
      {
        schemaVersion: 1,
        logicalRequestId: logs[0]!.usageAttempt.logicalRequestId,
        index: 1,
        terminal: false,
        outcome: "failed",
        retryable: true
      },
      {
        schemaVersion: 1,
        logicalRequestId: logs[0]!.usageAttempt.logicalRequestId,
        index: 2,
        terminal: true,
        outcome: "succeeded",
        retryable: false
      }
    ]
  );
  assert.deepEqual(
    healthEvents.map((event) => [event.providerId, event.ok, event.statusCode]),
    [
      ["provider-primary", false, 500],
      ["provider-fallback", true, 200]
    ]
  );
});

test("local proxy settles an all-failed logical request only on its last attempt", async (t) => {
  const firstUpstream = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "application/json" }).end("{}");
  });
  const lastUpstream = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" }).end("{}");
  });
  await listen(firstUpstream);
  await listen(lastUpstream);
  t.after(() => {
    firstUpstream.close();
    lastUpstream.close();
  });
  const first = makeProvider(
    "provider-primary",
    `http://127.0.0.1:${(firstUpstream.address() as AddressInfo).port}`
  );
  const last = makeProvider(
    "provider-last-failure",
    `http://127.0.0.1:${(lastUpstream.address() as AddressInfo).port}`
  );
  const logs: ProviderUsageAttemptLog[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({ app: "codex", provider: first }),
    resolveProviders: async () => [
      { app: "codex", provider: first },
      { app: "codex", provider: last }
    ],
    appendLog: async (log) => { logs.push(log); }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());

  const response = await fetch(`http://${status.host}:${status.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mn-app": "codex" },
    body: JSON.stringify({ model: "fallback-model", input: "fail" })
  });

  assert.equal(response.status, 503);
  assert.deepEqual(logs.map((log) => ({
    statusCode: log.statusCode,
    index: log.usageAttempt.index,
    terminal: log.usageAttempt.terminal,
    outcome: log.usageAttempt.outcome
  })), [
    { statusCode: 500, index: 1, terminal: false, outcome: "failed" },
    { statusCode: 503, index: 2, terminal: true, outcome: "failed" }
  ]);
});

test("local proxy fails over to the next provider on upstream timeout", async (t) => {
  const primaryUpstream = createServer((_request, _response) => {
    // Keep the request open until the proxy aborts it.
  });
  const fallbackUpstream = createServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ model: "fallback-model", ok: true }));
  });
  await listen(primaryUpstream);
  await listen(fallbackUpstream);
  t.after(() => {
    primaryUpstream.close();
    fallbackUpstream.close();
  });
  const primaryAddress = primaryUpstream.address() as AddressInfo;
  const fallbackAddress = fallbackUpstream.address() as AddressInfo;
  const primary = makeProvider("provider-timeout", `http://127.0.0.1:${primaryAddress.port}`);
  const fallback = makeProvider("provider-timeout-fallback", `http://127.0.0.1:${fallbackAddress.port}`);
  const logs: ProxyRequestLog[] = [];
  const healthEvents: ProviderHealthEvent[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    upstreamTimeoutMs: 50,
    resolveProvider: async () => ({
      app: "codex",
      provider: primary
    }),
    resolveProviders: async () => [
      { app: "codex", provider: primary },
      { app: "codex", provider: fallback }
    ],
    appendLog: async (log) => {
      logs.push(log);
    },
    recordProviderHealth: async (event) => {
      healthEvents.push(event);
    }
  });
  const status = await proxy.start();
  t.after(async () => {
    await proxy.stop();
  });

  const response = await fetch(`http://${status.host}:${status.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex"
    },
    body: JSON.stringify({ model: "fallback-model", input: "hello" })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { model: "fallback-model", ok: true });
  assert.equal(logs.length, 2);
  assert.deepEqual(
    logs.map((log) => [log.providerId, log.statusCode]),
    [
      ["provider-timeout", 504],
      ["provider-timeout-fallback", 200]
    ]
  );
  assert.deepEqual(
    healthEvents.map((event) => [event.providerId, event.ok, event.statusCode]),
    [
      ["provider-timeout", false, 504],
      ["provider-timeout-fallback", true, 200]
    ]
  );
});

test("trusted receipt with no eligible provider never creates a reservation", async (t) => {
  const association = makeTrustedAssociation();
  let verifyCount = 0;
  let reserveCount = 0;
  const logs: ProviderUsageAttemptLog[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    semanticDigestKey: "test-semantic-key-stable-identity",
    resolveProvider: async () => undefined,
    // This is also the shape returned by the API after every provider has
    // been removed by the circuit-open filter.
    resolveProviders: async () => [],
    verifyUsageAssociationReceipt: async (receipt) => {
      assert.equal(receipt, "same-trusted-receipt");
      verifyCount += 1;
      return association;
    },
    reserveTrustedUsageAssociation: async (verified) => {
      reserveCount += 1;
      return { ...verified, reservationId: `reservation-${reserveCount}` };
    },
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());

  const responses = [];
  for (let index = 0; index < 2; index += 1) {
    responses.push(await fetch(
      `http://${status.host}:${status.port}/mn/usage-receipts/same-trusted-receipt/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-mn-app": "codex" },
        body: JSON.stringify({ model: "no-provider-model", input: `request-${index}` })
      }
    ));
  }

  assert.deepEqual(responses.map((response) => response.status), [503, 503]);
  assert.equal(verifyCount, 2);
  assert.equal(reserveCount, 0);
  assert.equal(logs.length, 0);
});

test("trusted provider resolution failure happens before reservation", async (t) => {
  const association = makeTrustedAssociation();
  const events: string[] = [];
  let reserveCount = 0;
  const logs: ProviderUsageAttemptLog[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => undefined,
    resolveProviders: async () => {
      events.push("resolve");
      throw new Error("catalog unavailable");
    },
    verifyUsageAssociationReceipt: async () => {
      events.push("verify");
      return association;
    },
    reserveTrustedUsageAssociation: async (verified) => {
      reserveCount += 1;
      return { ...verified, reservationId: "unexpected-reservation" };
    },
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());

  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/resolution-failure/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "unresolved-model", input: "hello" })
    }
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "provider resolution is unavailable for codex"
  });
  assert.deepEqual(events, ["verify", "resolve"]);
  assert.equal(reserveCount, 0);
  assert.equal(logs.length, 0);
});

test("aborted trusted request body never creates a reservation", async (t) => {
  const association = makeTrustedAssociation();
  const provider = makeProvider("provider-aborted-body", "http://127.0.0.1:1");
  const events: string[] = [];
  let reserveCount = 0;
  const logs: ProviderUsageAttemptLog[] = [];
  let providerResolved!: () => void;
  const providerResolution = new Promise<void>((resolve) => {
    providerResolved = resolve;
  });
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider }),
    resolveProviders: async () => {
      events.push("resolve");
      providerResolved();
      return [{ app: "codex", provider }];
    },
    verifyUsageAssociationReceipt: async () => {
      events.push("verify");
      return association;
    },
    reserveTrustedUsageAssociation: async (verified) => {
      events.push("reserve");
      reserveCount += 1;
      return { ...verified, reservationId: "unexpected-reservation" };
    },
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());

  const clientRequest = httpRequest({
    host: status.host,
    port: status.port,
    path: "/mn/usage-receipts/aborted-body/v1/responses",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "1024",
      "x-mn-app": "codex"
    }
  });
  clientRequest.on("error", () => {
    // Expected when the client deliberately aborts an incomplete body.
  });
  clientRequest.write('{"model":"partial"');
  await providerResolution;
  clientRequest.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(events, ["verify", "resolve"]);
  assert.equal(reserveCount, 0);
  assert.equal(logs.length, 0);
});

test("trusted request preparation failure happens before reservation", async (t) => {
  const association = makeTrustedAssociation();
  const provider = makeProvider("provider-invalid-token", "http://127.0.0.1:1");
  let reserveCount = 0;
  let logCount = 0;
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({
      app: "codex",
      provider,
      bearerToken: "invalid\ncredential"
    }),
    resolveProviders: async () => [{
      app: "codex",
      provider,
      bearerToken: "invalid\ncredential"
    }],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified) => {
      reserveCount += 1;
      return { ...verified, reservationId: "unexpected-reservation" };
    },
    appendLog: async () => {
      logCount += 1;
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());

  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/preparation-failure/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "invalid-token", input: "hello" })
    }
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "provider request preparation is unavailable"
  });
  assert.equal(reserveCount, 0);
  assert.equal(logCount, 0);
});

test("trusted provider request reserves exactly once immediately before upstream", async (t) => {
  const events: string[] = [];
  const association = makeTrustedAssociation();
  const upstream = createServer((_request, response) => {
    events.push("upstream");
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        model: "trusted-model",
        usage: { input_tokens: 4, output_tokens: 2 }
      })
    );
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider = makeProvider(
    "provider-trusted-order",
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  );
  const logs: ProviderUsageAttemptLog[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider }),
    resolveProviders: async () => {
      events.push("resolve");
      return [{ app: "codex", provider }];
    },
    verifyUsageAssociationReceipt: async (receipt) => {
      assert.equal(receipt, "ordered-receipt");
      events.push("verify");
      return association;
    },
    reserveTrustedUsageAssociation: async (verified) => {
      events.push("reserve");
      return { ...verified, reservationId: "reservation-ordered" };
    },
    appendLog: async (log) => {
      events.push("terminal-log");
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());

  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/ordered-receipt/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "trusted-model", input: "hello" })
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(events, [
    "verify",
    "resolve",
    "reserve",
    "upstream",
    "terminal-log"
  ]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.trustedAssociation?.reservationId, "reservation-ordered");
  assert.deepEqual(logs[0]!.usageAttempt, {
    schemaVersion: 1,
    logicalRequestId: "reservation-ordered",
    index: 1,
    terminal: true,
    outcome: "succeeded",
    retryable: false
  });
});

test("trusted replay records a zero-cost terminal attempt for each receipt", async (t) => {
  const association = makeTrustedAssociation();
  let upstreamCount = 0;
  let verifyCount = 0;
  let reserveCount = 0;
  const upstream = createServer((_request, response) => {
    upstreamCount += 1;
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        model: "trusted-replay-model",
        output_text: "cached delivery",
        usage: { input_tokens: 4, output_tokens: 2 }
      })
    );
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider = makeProvider(
    "provider-trusted-replay",
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  );
  const logs: ProviderUsageAttemptLog[] = [];
  const replayRecords = new Map<string, ProxyReplayRecord>();
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider }),
    resolveProviders: async () => [{ app: "codex", provider }],
    verifyUsageAssociationReceipt: async () => {
      verifyCount += 1;
      return association;
    },
    reserveTrustedUsageAssociation: async (verified) => {
      reserveCount += 1;
      return { ...verified, reservationId: `reservation-replay-${reserveCount}` };
    },
    appendLog: async (log) => {
      logs.push(log);
    },
    getReplay: async (key) => replayRecords.get(key),
    saveReplay: async (record) => {
      replayRecords.set(record.key, record);
    },
    markReplayUsed: async (key) => {
      const current = replayRecords.get(key);
      if (current) replayRecords.set(key, { ...current, replayCount: current.replayCount + 1 });
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());

  const request = async (receipt: string) => fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/${receipt}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "trusted-replay-model", input: "same" })
    }
  );
  const first = await request("receipt-one");
  const second = await request("receipt-two");

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-mn-proxy-replay"), "hit");
  assert.deepEqual(await second.json(), {
    model: "trusted-replay-model",
    output_text: "cached delivery",
    usage: { input_tokens: 4, output_tokens: 2 }
  });
  assert.equal(upstreamCount, 1);
  assert.equal(verifyCount, 2);
  assert.equal(reserveCount, 2);
  assert.deepEqual(logs.map((log) => ({
    replayed: log.replayed,
    inputTokens: log.inputTokens,
    outputTokens: log.outputTokens,
    logicalRequestId: log.usageAttempt.logicalRequestId,
    terminal: log.usageAttempt.terminal
  })), [
    {
      replayed: undefined,
      inputTokens: 4,
      outputTokens: 2,
      logicalRequestId: "reservation-replay-1",
      terminal: true
    },
    {
      replayed: true,
      inputTokens: 0,
      outputTokens: 0,
      logicalRequestId: "reservation-replay-2",
      terminal: true
    }
  ]);
});

test("trusted reservation must preserve bindings and return an identity before upstream", async (t) => {
  const association = makeTrustedAssociation();
  let upstreamCount = 0;
  const upstream = createServer((_request, response) => {
    upstreamCount += 1;
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider = makeProvider(
    "provider-invalid-reservation",
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  );
  let logCount = 0;
  const invalidReservations: TrustedProxyUsageAssociation[] = [
    { ...association },
    { ...association, runId: "mutated-run", reservationId: "reservation-mutated" }
  ];

  for (const [index, invalidReservation] of invalidReservations.entries()) {
    const proxy = new LocalProxyServer({
      port: 0,
      requireTrustedUsageAssociation: true,
      resolveProvider: async () => ({ app: "codex", provider }),
      resolveProviders: async () => [{ app: "codex", provider }],
      verifyUsageAssociationReceipt: async () => association,
      reserveTrustedUsageAssociation: async () => invalidReservation,
      appendLog: async () => {
        logCount += 1;
      }
    });
    const status = await proxy.start();
    t.after(() => proxy.stop());
    const response = await fetch(
      `http://${status.host}:${status.port}/mn/usage-receipts/invalid-${index}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-mn-app": "codex" },
        body: JSON.stringify({ model: "invalid-reservation", input: "hello" })
      }
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "provider usage accounting is unavailable"
    });
    await proxy.stop();
  }

  assert.equal(upstreamCount, 0);
  assert.equal(logCount, 0);
});

test("trusted v2 request commits dispatch before upstream with request-unique stable identities", async (t) => {
  const association = makeTrustedAssociation();
  const events: string[] = [];
  const upstreamKeys: string[] = [];
  const upstream = createServer((request, response) => {
    events.push("upstream");
    upstreamKeys.push(String(request.headers["idempotency-key"]));
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ model: "stable-model", usage: { input_tokens: 2, output_tokens: 1 } })
    );
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider = {
    ...makeProvider(
      "provider-stable-identity",
      `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    ),
    enterpriseCapabilities: {
      idempotency: {
        strength: "strong" as const,
        headerName: "Idempotency-Key"
      }
    },
    config: {
      idempotencyHeaderName: "Idempotency-Key",
      providerAccountId: "account-stable"
    }
  };
  const logicalRequestIds: string[] = [];
  const logs: ProviderUsageAttemptLog[] = [];
  const dispatches: ProviderUsageDispatchIntent[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    semanticDigestKey: "test-semantic-key-stable-identity",
    resolveProvider: async () => ({ app: "codex", provider }),
    resolveProviders: async () => [{ app: "codex", provider }],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified, intent) => {
      assert.ok(intent);
      events.push("prepared");
      logicalRequestIds.push(intent.logicalRequestId);
      return { ...verified, reservationId: intent.logicalRequestId };
    },
    markProviderUsageAttemptDispatchStarted: async (reserved, intent) => {
      assert.equal(reserved.reservationId, intent.logicalRequestId);
      dispatches.push(intent);
      events.push("dispatch");
    },
    appendLog: async (log) => {
      events.push("terminal");
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const url = `http://${status.host}:${status.port}/mn/usage-receipts/reusable/v1/responses`;
  const init = (callerKey: string) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex",
      "Idempotency-Key": callerKey
    },
    body: JSON.stringify({ model: "stable-model", input: "identical" })
  });
  assert.equal((await fetch(url, init("caller-one"))).status, 200);
  assert.equal((await fetch(url, init("caller-two"))).status, 200);
  assert.deepEqual(events, [
    "prepared", "dispatch", "upstream", "terminal",
    "prepared", "dispatch", "upstream", "terminal"
  ]);
  assert.equal(new Set(logicalRequestIds).size, 2);
  assert.equal(new Set(upstreamKeys).size, 2);
  assert.ok(upstreamKeys.every((key) => /^mn-[0-9a-f]{64}$/u.test(key)));
  assert.ok(!upstreamKeys.includes("caller-one"));
  assert.ok(!upstreamKeys.includes("caller-two"));
  assert.deepEqual(dispatches.map((intent) => ({
    account: intent.providerAccountId,
    strength: intent.providerIdempotencyStrength,
    header: intent.outboundIdempotencyHeaderName,
    digest: intent.outboundIdempotencyKeyDigest,
    canonicalDigest: intent.outboundRequestKeyDigest
  })), upstreamKeys.map((key) => ({
    account: "account-stable",
    strength: "strong",
    header: "idempotency-key",
    digest: createHash("sha256").update(key).digest("hex"),
    canonicalDigest: createHash("sha256").update(key).digest("hex")
  })));
  assert.deepEqual(logs.map((log) => log.id), logicalRequestIds.map((id) =>
    providerUsageAttemptLogId(id, 1)
  ));
});

test("enterprise timeout records unknown and never dispatches fallback", async (t) => {
  const association = makeTrustedAssociation();
  let primaryCount = 0;
  let fallbackCount = 0;
  const primaryUpstream = createServer(() => {
    primaryCount += 1;
    // The provider may already have accepted the request; keep the result unknown.
  });
  const fallbackUpstream = createServer((_request, response) => {
    fallbackCount += 1;
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ model: "fallback", usage: { input_tokens: 1, output_tokens: 1 } })
    );
  });
  await listen(primaryUpstream);
  await listen(fallbackUpstream);
  t.after(() => {
    primaryUpstream.closeAllConnections();
    primaryUpstream.close();
    fallbackUpstream.close();
  });
  const primary = makeProvider(
    "provider-enterprise-timeout",
    `http://127.0.0.1:${(primaryUpstream.address() as AddressInfo).port}`
  );
  const fallback = makeProvider(
    "provider-enterprise-timeout-fallback",
    `http://127.0.0.1:${(fallbackUpstream.address() as AddressInfo).port}`
  );
  const unknowns: ProviderUsageUnknownIntent[] = [];
  const logs: ProviderUsageAttemptLog[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    upstreamTimeoutMs: 40,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider: primary }),
    resolveProviders: async () => [
      { app: "codex", provider: primary },
      { app: "codex", provider: fallback }
    ],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified, intent) => ({
      ...verified,
      reservationId: intent!.logicalRequestId
    }),
    markProviderUsageAttemptDispatchStarted: async () => {},
    markProviderUsageAttemptUnknown: async (_reserved, intent) => {
      unknowns.push(intent);
    },
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/timeout/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "unknown-model", input: "charge-me" })
    }
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "provider result is unavailable" });
  assert.equal(primaryCount, 1);
  assert.equal(fallbackCount, 0);
  assert.equal(logs.length, 0);
  assert.equal(unknowns.length, 1);
  assert.equal(unknowns[0]?.reason, "timeout");
  assert.equal(unknowns[0]?.statusCode, undefined);
  assert.equal(unknowns[0]?.attemptIndex, 1);
});

test("enterprise unverified HTTP failure stays unknown instead of falling back", async (t) => {
  const association = makeTrustedAssociation();
  let fallbackCount = 0;
  const primaryUpstream = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "application/json" }).end(
      JSON.stringify({ error: "provider did not return authoritative usage" })
    );
  });
  const fallbackUpstream = createServer((_request, response) => {
    fallbackCount += 1;
    response.writeHead(200).end("{}");
  });
  await listen(primaryUpstream);
  await listen(fallbackUpstream);
  t.after(() => {
    primaryUpstream.close();
    fallbackUpstream.close();
  });
  const primary = makeProvider(
    "provider-enterprise-unverified-failure",
    `http://127.0.0.1:${(primaryUpstream.address() as AddressInfo).port}`
  );
  const fallback = makeProvider(
    "provider-enterprise-unverified-fallback",
    `http://127.0.0.1:${(fallbackUpstream.address() as AddressInfo).port}`
  );
  const unknowns: ProviderUsageUnknownIntent[] = [];
  let appendCount = 0;
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider: primary }),
    resolveProviders: async () => [
      { app: "codex", provider: primary },
      { app: "codex", provider: fallback }
    ],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified, intent) => ({
      ...verified,
      reservationId: intent!.logicalRequestId
    }),
    markProviderUsageAttemptDispatchStarted: async () => {},
    markProviderUsageAttemptUnknown: async (_reserved, intent) => {
      unknowns.push(intent);
    },
    appendLog: async () => {
      appendCount += 1;
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/http-failure/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "unknown-model", input: "hello" })
    }
  );
  assert.equal(response.status, 503);
  assert.equal(fallbackCount, 0);
  assert.equal(appendCount, 0);
  assert.equal(unknowns.length, 1);
  assert.equal(unknowns[0]?.reason, "unverified_failure_response");
  assert.equal(unknowns[0]?.statusCode, 500);
});

test("enterprise 2xx missing or partial usage never settles authoritative zero", async (t) => {
  const cases = [
    { name: "missing", body: { model: "usage-model", output_text: "ok" }, reason: "unverified_success_response" },
    { name: "total-only", body: { model: "usage-model", usage: { total_tokens: 99 } }, reason: "partial_usage" },
    { name: "input-only", body: { model: "usage-model", usage: { input_tokens: 9 } }, reason: "partial_usage" }
  ] as const;
  for (const item of cases) {
    const association = makeTrustedAssociation();
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(item.body));
    });
    await listen(upstream);
    t.after(() => upstream.close());
    const provider = makeProvider(
      `provider-enterprise-${item.name}`,
      `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    );
    const unknowns: ProviderUsageUnknownIntent[] = [];
    let appendCount = 0;
    const proxy = new LocalProxyServer({
      port: 0,
      requireTrustedUsageAssociation: true,
      resolveProvider: async () => ({ app: "codex", provider }),
      resolveProviders: async () => [{ app: "codex", provider }],
      verifyUsageAssociationReceipt: async () => association,
      reserveTrustedUsageAssociation: async (verified, intent) => ({
        ...verified,
        reservationId: intent!.logicalRequestId
      }),
      markProviderUsageAttemptDispatchStarted: async () => {},
      markProviderUsageAttemptUnknown: async (_reserved, intent) => {
        unknowns.push(intent);
      },
      appendLog: async () => { appendCount += 1; }
    });
    const status = await proxy.start();
    const result = await fetch(
      `http://${status.host}:${status.port}/mn/usage-receipts/${item.name}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-mn-app": "codex" },
        body: JSON.stringify({ model: "usage-model", input: "bill-me" })
      }
    );
    assert.equal(result.status, 503, item.name);
    assert.equal(appendCount, 0, item.name);
    assert.equal(unknowns[0]?.reason, item.reason, item.name);
    await proxy.stop();
  }
});

test("enterprise SSE is not client-visible until terminal accounting is durable", async (t) => {
  const association = makeTrustedAssociation();
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({
        model: "governed-stream-model",
        usage: { input_tokens: 7, output_tokens: 3 }
      })}\n\n`,
      "data: [DONE]\n\n"
    ].join(""));
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider = makeProvider(
    "provider-enterprise-accounted-stream",
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  );
  let releaseAccounting!: () => void;
  const accountingGate = new Promise<void>((resolve) => {
    releaseAccounting = resolve;
  });
  let accountingStarted!: () => void;
  const accountingStartedPromise = new Promise<void>((resolve) => {
    accountingStarted = resolve;
  });
  const logs: ProviderUsageAttemptLog[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider }),
    resolveProviders: async () => [{ app: "codex", provider }],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified, intent) => ({
      ...verified,
      reservationId: intent!.logicalRequestId
    }),
    markProviderUsageAttemptDispatchStarted: async () => {},
    markProviderUsageAttemptUnknown: async () => {
      assert.fail("complete authoritative SSE usage must not become unknown");
    },
    appendLog: async (log) => {
      logs.push(log);
      accountingStarted();
      await accountingGate;
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());

  let clientVisible = false;
  const clientResponse = fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/accounted-stream/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "governed-stream-model", input: "bill-me" })
    }
  ).then((result) => {
    clientVisible = true;
    return result;
  });

  await accountingStartedPromise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(clientVisible, false, "headers/body escaped before durable accounting");

  releaseAccounting();
  const result = await clientResponse;
  assert.equal(result.status, 200);
  assert.match(await result.text(), /governed-stream-model/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.inputTokens, 7);
  assert.equal(logs[0]?.outputTokens, 3);
});

test("enterprise SSE requires a protocol terminal marker even when usage is complete", async (t) => {
  const association = makeTrustedAssociation();
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }).end(
      `data: ${JSON.stringify({
        model: "truncated-stream",
        usage: { input_tokens: 7, output_tokens: 3 }
      })}\n\n`
    );
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider = makeProvider(
    "provider-enterprise-truncated-stream",
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  );
  const unknowns: ProviderUsageUnknownIntent[] = [];
  let appendCount = 0;
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider }),
    resolveProviders: async () => [{ app: "codex", provider }],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified, intent) => ({
      ...verified,
      reservationId: intent!.logicalRequestId
    }),
    markProviderUsageAttemptDispatchStarted: async () => {},
    markProviderUsageAttemptUnknown: async (_reserved, intent) => {
      unknowns.push(intent);
    },
    appendLog: async () => { appendCount += 1; }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const result = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/truncated-stream/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "truncated-stream", input: "bill-me" })
    }
  );
  assert.equal(result.status, 503);
  assert.equal(appendCount, 0);
  assert.equal(unknowns[0]?.reason, "partial_usage");
});

test("enterprise SSE recognizes OpenAI, Responses, and Anthropic terminal markers", async (t) => {
  const cases = [
    {
      name: "openai-done",
      frames: [
        { usage: { input_tokens: 7, output_tokens: 3 } },
        "[DONE]"
      ]
    },
    {
      name: "responses-completed",
      frames: [{
        type: "response.completed",
        response: { usage: { input_tokens: 7, output_tokens: 3 } }
      }]
    },
    {
      name: "anthropic-message-stop",
      frames: [
        { type: "message_delta", usage: { input_tokens: 7, output_tokens: 3 } },
        { type: "message_stop" }
      ]
    }
  ] as const;
  for (const item of cases) {
    const association = makeTrustedAssociation();
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" }).end(
        item.frames.map((frame) =>
          `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`
        ).join("")
      );
    });
    await listen(upstream);
    const provider = makeProvider(
      `provider-enterprise-${item.name}`,
      `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    );
    const logs: ProviderUsageAttemptLog[] = [];
    const proxy = new LocalProxyServer({
      port: 0,
      requireTrustedUsageAssociation: true,
      resolveProvider: async () => ({ app: "codex", provider }),
      resolveProviders: async () => [{ app: "codex", provider }],
      verifyUsageAssociationReceipt: async () => association,
      reserveTrustedUsageAssociation: async (verified, intent) => ({
        ...verified,
        reservationId: intent!.logicalRequestId
      }),
      markProviderUsageAttemptDispatchStarted: async () => {},
      markProviderUsageAttemptUnknown: async () => assert.fail(`${item.name} became unknown`),
      appendLog: async (log) => { logs.push(log); }
    });
    const status = await proxy.start();
    const result = await fetch(
      `http://${status.host}:${status.port}/mn/usage-receipts/${item.name}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-mn-app": "codex" },
        body: JSON.stringify({ model: item.name, input: "bill-me" })
      }
    );
    assert.equal(result.status, 200, item.name);
    assert.equal(logs[0]?.inputTokens, 7, item.name);
    assert.equal(logs[0]?.outputTokens, 3, item.name);
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("enterprise failure with explicit usage may record and enter fallback", async (t) => {
  const association = makeTrustedAssociation();
  const primaryUpstream = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "application/json" }).end(
      JSON.stringify({
        model: "known-failure",
        error: "retryable",
        usage: { input_tokens: 3, output_tokens: 1 }
      })
    );
  });
  const fallbackUpstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        model: "known-success",
        output_text: "ok",
        usage: { input_tokens: 2, output_tokens: 1 }
      })
    );
  });
  await listen(primaryUpstream);
  await listen(fallbackUpstream);
  t.after(() => {
    primaryUpstream.close();
    fallbackUpstream.close();
  });
  const primary = makeProvider(
    "provider-enterprise-known-failure",
    `http://127.0.0.1:${(primaryUpstream.address() as AddressInfo).port}`
  );
  const fallback = makeProvider(
    "provider-enterprise-known-fallback",
    `http://127.0.0.1:${(fallbackUpstream.address() as AddressInfo).port}`
  );
  const dispatches: ProviderUsageDispatchIntent[] = [];
  const logs: ProviderUsageAttemptLog[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider: primary }),
    resolveProviders: async () => [
      { app: "codex", provider: primary },
      { app: "codex", provider: fallback }
    ],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified, intent) => ({
      ...verified,
      reservationId: intent!.logicalRequestId
    }),
    markProviderUsageAttemptDispatchStarted: async (_reserved, intent) => {
      dispatches.push(intent);
    },
    markProviderUsageAttemptUnknown: async () => {
      assert.fail("explicit usage must not become unknown");
    },
    appendLog: async (log) => {
      logs.push(log);
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/known-failure/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "known-model", input: "hello" })
    }
  );
  assert.equal(response.status, 200);
  assert.equal(dispatches.length, 2);
  assert.deepEqual(logs.map((log) => ({
    providerId: log.providerId,
    inputTokens: log.inputTokens,
    outputTokens: log.outputTokens,
    terminal: log.usageAttempt.terminal
  })), [
    {
      providerId: "provider-enterprise-known-failure",
      inputTokens: 3,
      outputTokens: 1,
      terminal: false
    },
    {
      providerId: "provider-enterprise-known-fallback",
      inputTokens: 2,
      outputTokens: 1,
      terminal: true
    }
  ]);
});

test("enterprise response conversion failure records unknown without zero usage", async (t) => {
  const association = makeTrustedAssociation();
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end("not-json");
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider: ProviderRecord = {
    ...makeProvider(
      "provider-enterprise-conversion",
      `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    ),
    apiFormat: "openai_chat",
    wireApi: "chat"
  };
  const unknowns: ProviderUsageUnknownIntent[] = [];
  let appendCount = 0;
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider }),
    resolveProviders: async () => [{ app: "codex", provider }],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified, intent) => ({
      ...verified,
      reservationId: intent!.logicalRequestId
    }),
    markProviderUsageAttemptDispatchStarted: async () => {},
    markProviderUsageAttemptUnknown: async (_reserved, intent) => {
      unknowns.push(intent);
    },
    appendLog: async () => {
      appendCount += 1;
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/conversion/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "conversion-model", input: "hello" })
    }
  );
  assert.equal(response.status, 503);
  assert.equal(appendCount, 0);
  assert.equal(unknowns.length, 1);
  assert.equal(unknowns[0]?.reason, "response_conversion_error");
  assert.equal(unknowns[0]?.statusCode, 200);
});

test("enterprise connection reset records unknown and returns a generic error", async (t) => {
  const association = makeTrustedAssociation();
  const upstream = createServer((request) => {
    request.socket.destroy();
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider = makeProvider(
    "provider-enterprise-reset",
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  );
  const unknowns: ProviderUsageUnknownIntent[] = [];
  let appendCount = 0;
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider }),
    resolveProviders: async () => [{ app: "codex", provider }],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified, intent) => ({
      ...verified,
      reservationId: intent!.logicalRequestId
    }),
    markProviderUsageAttemptDispatchStarted: async () => {},
    markProviderUsageAttemptUnknown: async (_reserved, intent) => {
      unknowns.push(intent);
    },
    appendLog: async () => {
      appendCount += 1;
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/reset/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "reset-model", input: "hello" })
    }
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "provider result is unavailable" });
  assert.equal(appendCount, 0);
  assert.equal(unknowns.length, 1);
  assert.equal(unknowns[0]?.reason, "connection_error");
  assert.equal(unknowns[0]?.statusCode, undefined);
});

test("enterprise interrupted SSE records unknown before exposing partial client bytes", async (t) => {
  const association = makeTrustedAssociation();
  const upstream = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n");
    setTimeout(() => response.destroy(), 5);
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider = makeProvider(
    "provider-enterprise-sse-reset",
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  );
  const unknowns: ProviderUsageUnknownIntent[] = [];
  let appendCount = 0;
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider }),
    resolveProviders: async () => [{ app: "codex", provider }],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified, intent) => ({
      ...verified,
      reservationId: intent!.logicalRequestId
    }),
    markProviderUsageAttemptDispatchStarted: async () => {},
    markProviderUsageAttemptUnknown: async (_reserved, intent) => {
      unknowns.push(intent);
    },
    appendLog: async () => {
      appendCount += 1;
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/sse-reset/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "sse-model", input: "hello", stream: true })
    }
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "provider result is unavailable" });
  await waitFor(() => unknowns.length === 1);
  assert.equal(appendCount, 0);
  assert.equal(unknowns[0]?.reason, "stream_interrupted");
  assert.equal(unknowns[0]?.statusCode, 200);
});

test("enterprise caller key deduplicates concurrent and restarted-style retries with CAS", async (t) => {
  const association = makeTrustedAssociation();
  let upstreamCount = 0;
  let releaseUpstream!: () => void;
  let upstreamStarted!: () => void;
  const upstreamGate = new Promise<void>((resolve) => {
    releaseUpstream = resolve;
  });
  const started = new Promise<void>((resolve) => {
    upstreamStarted = resolve;
  });
  const upstreamHeaders: Array<string | undefined> = [];
  const upstream = createServer(async (request, response) => {
    upstreamCount += 1;
    upstreamHeaders.push(request.headers["idempotency-key"] as string | undefined);
    upstreamStarted();
    await upstreamGate;
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        model: "keyed-model",
        output_text: "once",
        usage: { input_tokens: 2, output_tokens: 1 }
      })
    );
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider = {
    ...makeProvider(
      "provider-enterprise-keyed",
      `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    ),
    config: { idempotencyHeaderName: "Idempotency-Key" }
  };
  let operation:
    | {
        callerDigest: string;
        requestDigest: string;
        logicalRequestId: string;
        status: "pending" | "finalized";
      }
    | undefined;
  let createdReservations = 0;
  let dispatchCount = 0;
  const logs: ProviderUsageAttemptLog[] = [];
  const replayRecords = new Map<string, ProxyReplayRecord>();
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    semanticDigestKey: "test-semantic-key-caller-cas",
    resolveProvider: async () => ({ app: "codex", provider }),
    resolveProviders: async () => [{ app: "codex", provider }],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified, intent) => {
      assert.ok(intent?.callerIdempotencyKeyDigest);
      if (!operation) {
        createdReservations += 1;
        operation = {
          callerDigest: intent.callerIdempotencyKeyDigest,
          requestDigest: intent.requestDigest,
          logicalRequestId: intent.logicalRequestId,
          status: "pending"
        };
        return { ...verified, reservationId: intent.logicalRequestId };
      }
      if (
        operation.callerDigest !== intent.callerIdempotencyKeyDigest ||
        operation.requestDigest !== intent.requestDigest
      ) {
        return { kind: "conflict", logicalRequestId: operation.logicalRequestId };
      }
      return {
        kind: operation.status === "pending"
          ? "duplicate_pending"
          : "duplicate_finalized",
        logicalRequestId: operation.logicalRequestId
      };
    },
    markProviderUsageAttemptDispatchStarted: async () => {
      dispatchCount += 1;
    },
    markProviderUsageAttemptUnknown: async () => {
      assert.fail("keyed success must not become unknown");
    },
    appendLog: async (log) => {
      logs.push(log);
      operation!.status = "finalized";
    },
    getReplay: async (key) => replayRecords.get(key),
    saveReplay: async (record) => {
      replayRecords.set(record.key, record);
    },
    markReplayUsed: async () => {}
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const url = `http://${status.host}:${status.port}/mn/usage-receipts/keyed/v1/responses`;
  const request = (input: string) => fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex",
      "Idempotency-Key": "caller-stable-key"
    },
    body: JSON.stringify({ model: "keyed-model", input })
  });
  const firstPromise = request("same");
  await started;
  const concurrent = await request("same");
  assert.equal(concurrent.status, 409);
  assert.deepEqual(await concurrent.json(), {
    error: "provider request with this idempotency key is still pending"
  });
  releaseUpstream();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  const duplicate = await request("same");
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.headers.get("x-mn-proxy-replay"), "hit");
  const headerConflict = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mn-app": "codex",
      "Idempotency-Key": "caller-stable-key",
      "authorization": "Bearer account-b",
      "x-provider-beta": "beta-b"
    },
    body: JSON.stringify({ model: "keyed-model", input: "same" })
  });
  assert.equal(headerConflict.status, 409);
  assert.deepEqual(await headerConflict.json(), {
    error: "provider request idempotency key conflicts with different semantics"
  });
  const conflict = await request("different");
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: "provider request idempotency key conflicts with different semantics"
  });
  assert.equal(createdReservations, 1);
  assert.equal(dispatchCount, 1);
  assert.equal(upstreamCount, 1);
  assert.deepEqual(upstreamHeaders, [undefined]);
  assert.equal(logs.length, 1);
});

test("trusted dispatch-start failure prevents upstream and terminal accounting", async (t) => {
  const association = makeTrustedAssociation();
  let upstreamCount = 0;
  let appendCount = 0;
  const upstream = createServer((_request, response) => {
    upstreamCount += 1;
    response.writeHead(200).end();
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider = makeProvider(
    "provider-dispatch-start-failure",
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  );
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => ({ app: "codex", provider }),
    resolveProviders: async () => [{ app: "codex", provider }],
    verifyUsageAssociationReceipt: async () => association,
    reserveTrustedUsageAssociation: async (verified, intent) => ({
      ...verified,
      reservationId: intent!.logicalRequestId
    }),
    markProviderUsageAttemptDispatchStarted: async () => {
      throw new Error("ledger unavailable");
    },
    appendLog: async () => {
      appendCount += 1;
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/start-failure/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-mn-app": "codex" },
      body: JSON.stringify({ model: "dispatch-start-model", input: "hello" })
    }
  );
  assert.equal(response.status, 503);
  assert.equal(upstreamCount, 0);
  assert.equal(appendCount, 0);
});

test("terminal accounting retries a stable callback identity before responding", async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ model: "retry-model", usage: { input_tokens: 1, output_tokens: 1 } })
    );
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const provider = makeProvider(
    "provider-append-retry",
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  );
  const seenIds: string[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({ app: "codex", provider }),
    appendLog: async (log) => {
      seenIds.push(log.id);
      if (seenIds.length < 3) throw new Error("temporary ledger outage");
    }
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const response = await fetch(
    `http://${status.host}:${status.port}/mn/runs/retry-run/candidates/retry-candidate/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "retry-model", input: "hello" })
    }
  );
  assert.equal(response.status, 200);
  assert.equal(seenIds.length, 3);
  assert.equal(new Set(seenIds).size, 1);
});

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not observed before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function readIncomingRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeSseData(response: ServerResponse, data: unknown): void {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseSseEvents(body: string): Array<{ event?: string; data: unknown }> {
  const events: Array<{ event?: string; data: unknown }> = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    if (!frame.trim()) continue;
    let event: string | undefined;
    const dataParts: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataParts.push(line.slice(5).trimStart());
    }
    const rawData = dataParts.join("\n");
    if (!rawData) continue;
    try {
      events.push({ event, data: JSON.parse(rawData) });
    } catch {
      events.push({ event, data: rawData });
    }
  }
  return events;
}

async function readStreamingResponse(
  url: string,
  body: string,
  app: "claude" | "codex" = "codex"
): Promise<{
  statusCode: number;
  body: string;
  contentType: string;
  firstChunkAtMs: number;
  endAtMs: number;
}> {
  const startedAt = Date.now();
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-mn-app": app
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      let firstChunkAtMs = -1;
      response.on("data", (chunk: Buffer) => {
        if (firstChunkAtMs === -1) firstChunkAtMs = Date.now() - startedAt;
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          contentType: String(response.headers["content-type"] ?? ""),
          firstChunkAtMs,
          endAtMs: Date.now() - startedAt
        });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

function makeProvider(id: string, baseUrl: string): ProviderRecord {
  return {
    id,
    app: "codex",
    name: id,
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl,
    defaultModel: "fallback-model",
    disableResponseStorage: true,
    wireApi: "responses",
    modelCatalog: [{ id: "fallback-model", displayName: "Fallback model" }],
    config: {},
    enabled: id === "provider-primary" || id === "provider-timeout",
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function makeTrustedAssociation(): TrustedProxyUsageAssociation {
  return {
    schemaVersion: 1,
    issuer: "mn-api",
    tenantId: "tenant-trusted",
    runId: "run-trusted",
    candidateId: "codex-trusted",
    workerId: "worker-trusted",
    claimDigest: "a".repeat(64),
    receiptDigest: "b".repeat(64),
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-12T01:00:00.000Z",
    verifiedAt: "2026-07-12T00:00:01.000Z"
  };
}
