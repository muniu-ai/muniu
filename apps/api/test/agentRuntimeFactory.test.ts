import assert from "node:assert/strict";
import test from "node:test";

import type { AgentModelBindingV1 } from "@mn/agent-protocol";
import type { StreamChunk } from "@mn/agent-protocol";
import type { ProviderRecord } from "@mn/provider-catalog";

import {
  AgentRuntimeResolutionError,
  createProductionAgentRuntimeFactory
} from "../src/agentRuntimeFactory.js";

const binding: AgentModelBindingV1 = {
  schemaVersion: 1,
  kind: "agent-model-binding",
  providerId: "provider-agent",
  modelId: "model-safe"
};

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: "provider-agent",
    app: "agent",
    name: "Agent provider",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: "https://provider.invalid/v1",
    defaultModel: "model-safe",
    apiKeyRef: { type: "local_encrypted", ref: "secret-safe" },
    modelCatalog: [{ id: "model-safe", displayName: "Safe model" }],
    config: {},
    enabled: true,
    enabledConsumers: ["agent"],
    sortOrder: 1,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides
  };
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("production factory resolves an immutable adapter only from an enabled agent catalog binding", async () => {
  let record = provider();
  let reads = 0;
  const factory = createProductionAgentRuntimeFactory({
    providerSource: { getProvider: async () => { reads += 1; return record; } },
    resolveStoredSecret: async () => "synthetic-secret",
    fetch: async () => new Response("", { status: 503 })
  });

  const adapter = await factory.resolveAdapter(binding);
  const sameConfiguration = await factory.resolveAdapter(binding);
  assert.equal(adapter.id, binding.providerId);
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(sameConfiguration, adapter);
  assert.equal(reads, 2);

  record = provider({ enabled: false, enabledConsumers: [] });
  await assert.rejects(
    factory.resolveAdapter(binding),
    (error: unknown) => error instanceof AgentRuntimeResolutionError
      && error.code === "PROVIDER_DISABLED"
  );
  assert.equal(reads, 3);
});

test("production factory fails closed for disabled, wrong-consumer and missing-model records", async () => {
  const missingConsumers = provider();
  delete missingConsumers.enabledConsumers;
  const cases = [
    [provider({ enabled: false, enabledConsumers: [] }), "PROVIDER_DISABLED"],
    [provider({ app: "codex", enabledConsumers: ["codex"] }), "PROVIDER_CONSUMER_UNAVAILABLE"],
    [missingConsumers, "PROVIDER_CONSUMER_UNAVAILABLE"],
    [provider({ modelCatalog: [] }), "MODEL_NOT_FOUND"],
    [provider({ apiKeyRef: { type: "env", ref: "ARBITRARY_PROCESS_SECRET" } }), "PROVIDER_ROUTE_INVALID"],
    [provider({
      modelCatalog: [{ id: "model-safe", displayName: "Unsafe price", inputTokenUsdPerMillion: -0 }]
    }), "PROVIDER_RECORD_INVALID"],
    [provider({
      modelCatalog: [{ id: "model-safe", displayName: "Over-precise price", inputTokenUsdPerMillion: 0.0000000001 }]
    }), "PROVIDER_RECORD_INVALID"]
  ] as const;

  for (const [record, code] of cases) {
    const factory = createProductionAgentRuntimeFactory({
      providerSource: { getProvider: async () => record },
      resolveStoredSecret: async () => undefined
    });
    await assert.rejects(
      factory.resolveAdapter(binding),
      (error: unknown) => error instanceof AgentRuntimeResolutionError && error.code === code
    );
  }
});

test("production factory rejects Proxy and accessor ProviderRecords without traps or value disclosure", async () => {
  let accessorCalls = 0;
  const accessor = provider();
  Object.defineProperty(accessor, "baseUrl", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "https://raw-provider-secret.invalid/v1";
    }
  });
  const revoked = Proxy.revocable(provider(), {});
  revoked.revoke();
  const hostileValues: unknown[] = [
    accessor,
    new Proxy(provider(), {
      ownKeys() {
        throw new Error("RAW-PROXY-PROVIDER-SECRET");
      }
    }),
    revoked.proxy
  ];

  for (const value of hostileValues) {
    const factory = createProductionAgentRuntimeFactory({
      providerSource: { getProvider: async () => value },
      resolveStoredSecret: async () => undefined
    });
    await assert.rejects(factory.resolveAdapter(binding), (error: unknown) => {
      assert.equal(error instanceof AgentRuntimeResolutionError, true);
      assert.equal(String(error).includes("RAW-"), false);
      assert.equal(String(error).includes("raw-provider-secret"), false);
      return true;
    });
  }
  assert.equal(accessorCalls, 0);
});

test("production factory returns config-bound leases while resolving credentials per stream", async () => {
  let current = provider({
    apiKeyRef: {
      type: "local_encrypted",
      ref: "secret-safe",
      maskedValue: "RAW-MASK-ONE"
    }
  });
  let secretReads = 0;
  const authorizations: string[] = [];
  const factory = createProductionAgentRuntimeFactory({
    providerSource: { getProvider: async () => current },
    resolveStoredSecret: async () => {
      secretReads += 1;
      return `synthetic-secret-${secretReads}`;
    },
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      authorizations.push(request.headers.get("authorization") ?? "");
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
  });
  const first = await factory.resolveAdapterLease({
    providerId: binding.providerId,
    modelId: binding.modelId
  });
  await collect(first.adapter.stream({
    provider: binding.providerId,
    model: binding.modelId,
    messages: []
  }));
  await collect(first.adapter.stream({
    provider: binding.providerId,
    model: binding.modelId,
    messages: []
  }));
  await first.release();
  await first.release();
  assert.equal(secretReads, 2);
  assert.deepEqual(authorizations, [
    "Bearer synthetic-secret-1",
    "Bearer synthetic-secret-2"
  ]);
  assert.equal(JSON.stringify(first.resolution).includes("RAW-MASK"), false);

  current = provider({
    apiKeyRef: {
      type: "local_encrypted",
      ref: "secret-safe",
      maskedValue: "RAW-MASK-TWO"
    }
  });
  const maskedOnlyUpdate = await factory.resolveAdapterLease({
    providerId: binding.providerId,
    modelId: binding.modelId
  });
  assert.equal(maskedOnlyUpdate.resolution.configDigest, first.resolution.configDigest);
  assert.equal(maskedOnlyUpdate.adapter, first.adapter);

  current = provider({ apiKeyRef: { type: "local_encrypted", ref: "secret-rotated" } });
  const rotated = await factory.resolveAdapterLease({
    providerId: binding.providerId,
    modelId: binding.modelId
  });
  assert.notEqual(rotated.resolution.configDigest, first.resolution.configDigest);
  assert.notEqual(rotated.adapter, first.adapter);
});

test("production factory supports an explicitly credential-free provider route", async () => {
  const publicProvider = provider({ baseUrl: "http://127.0.0.1:11434/v1" });
  delete publicProvider.apiKeyRef;
  let authorization: string | null | undefined;
  const factory = createProductionAgentRuntimeFactory({
    providerSource: { getProvider: async () => publicProvider },
    resolveStoredSecret: async () => {
      throw new Error("credential-free routes must not resolve a secret");
    },
    fetch: async (input) => {
      const outgoing = input instanceof Request ? input : new Request(input);
      authorization = outgoing.headers.get("authorization");
      return new Response("data: [DONE]\n\n", { status: 200 });
    }
  });
  const lease = await factory.resolveAdapterLease({
    providerId: binding.providerId,
    modelId: binding.modelId
  });
  assert.deepEqual(await collect(lease.adapter.stream({
    provider: binding.providerId,
    model: binding.modelId,
    messages: []
  })), [{ type: "finish", reason: "stop" }]);
  assert.equal(authorization, null);
  await lease.release();
});
