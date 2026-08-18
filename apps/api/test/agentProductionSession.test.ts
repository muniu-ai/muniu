import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProviderRecord } from "@mn/provider-catalog";

import { createProductionAgentRuntimeFactory } from "../src/agentRuntimeFactory.js";
import { LocalMockAgentSessionService } from "../src/agentSessionService.js";

function provider(): ProviderRecord {
  return {
    id: "provider-production",
    app: "agent",
    name: "Production test provider",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: "https://provider.invalid/v1",
    defaultModel: "model-production",
    apiKeyRef: { type: "local_encrypted", ref: "secret-production" },
    modelCatalog: [{
      id: "model-production",
      displayName: "Production model",
      inputTokenUsdPerMillion: 1,
      outputTokenUsdPerMillion: 2
    }],
    config: {},
    enabled: true,
    enabledConsumers: ["agent"],
    sortOrder: 1,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z"
  };
}

test("production Agent service validates and runs the durable provider/model binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-agent-production-"));
  let fetches = 0;
  const factory = createProductionAgentRuntimeFactory({
    providerSource: { getProvider: async () => provider() },
    resolveStoredSecret: async () => "synthetic-secret",
    fetch: async () => {
      fetches += 1;
      return new Response([
        'data: {"choices":[{"delta":{"content":"production answer"},"finish_reason":"stop"}]}',
        "",
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
        "",
        "data: [DONE]",
        ""
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
  });
  const service = new LocalMockAgentSessionService(root, {
    mode: "production",
    runtimeFactory: factory
  });
  try {
    const created = await service.create({
      schemaVersion: 1,
      kind: "agent-session-create-request",
      clientRequestId: "create-production",
      modelBinding: {
        schemaVersion: 1,
        kind: "agent-model-binding",
        providerId: "provider-production",
        modelId: "model-production"
      }
    });
    assert.equal(created.statusCode, 201);
    const sessionId = (created.body as { sessionId: string }).sessionId;
    const completed = await service.message(sessionId, {
      schemaVersion: 1,
      kind: "agent-message-request",
      clientRequestId: "message-production",
      prompt: "ordinary name Alice, email alice@example.com and /workspace/path"
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(fetches, 1);
    assert.deepEqual((await service.get(sessionId)).modelBinding, {
      schemaVersion: 1,
      kind: "agent-model-binding",
      providerId: "provider-production",
      modelId: "model-production"
    });
    const durableLines = (await readFile(
      path.join(root, "sessions", sessionId, "events.jsonl"),
      "utf8"
    )).trim().split("\n").map((line) => JSON.parse(line) as {
      type: string;
      payload?: { publicControls?: { terminal?: { cost?: { estimatedCostPicoUsd?: string } } } };
    });
    assert.deepEqual(durableLines.map((event) => event.type).slice(-5), [
      "model/attempt-started",
      "model/audit",
      "assistant/message",
      "step/end",
      "turn/end"
    ]);
    assert.equal(
      durableLines.find((event) => event.type === "model/audit")
        ?.payload?.publicControls?.terminal?.cost?.estimatedCostPicoUsd,
      "7000000"
    );
  } finally {
    await service.dispose();
  }
});
