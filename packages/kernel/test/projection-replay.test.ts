// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionAuthority, JsonObject } from "@mn/contracts";
import { AgentOsKernel, InMemoryKernelStore, replayCoreProjections } from "../src/index.js";

test("core events contain complete projection facts without protected data keys", async () => {
  const hmacKey = Buffer.alloc(32, 7);
  const store = new InMemoryKernelStore(hmacKey);
  const kernel = new AgentOsKernel(store);
  await kernel.bootstrapLocal("bootstrap");
  const workspace = await kernel.createWorkspace("local", "local-owner", "workspace", {
    name: "Research", viewMode: "business", pluginIds: ["opc"],
  });
  const thread = await kernel.createThread("local", "local-owner", "thread", {
    workspaceId: workspace.id, pluginId: "opc", subject: "Research",
  });
  const authority: Omit<ExecutionAuthority, "id" | "tenantId" | "executionId" | "commitment" | "streamVersion" | "createdAt" | "updatedAt"> = {
    workspaceId: workspace.id, principalId: "agent", toolIds: [], dataScopes: [],
    autoAllowedEffects: [], budget: { maxSubagentDepth: 0, maxSubagents: 0, maxTokens: 100,
      maxCostMinorUnits: "100", currency: "CNY", maxDurationMs: 60_000 },
  };
  const execution = await kernel.submitTurn("local", "local-owner", "turn", {
    workspaceId: workspace.id, threadId: thread.id, expectedStreamVersion: 1,
    message: "sensitive original", agentDefinitionId: "opc.validator", modelBindingId: "model",
    executionPrincipalId: "agent", authority, preparedMessage: {
      protectedPayloadRef: "protected-turn", keyRecord: { wrappedKey: "never-in-events" },
    },
  });
  await kernel.commandExecution("local", "local-owner", "start", execution.id, 1, "start");
  const proposed = await kernel.proposeMemory("local", "local-owner", "memory", {
    workspaceId: workspace.id, scopeType: "workspace", namespace: "opc", resourceId: workspace.id,
    sourceEventId: "evidence", confidence: 0.7, preparedPayload: {
      memoryId: "memory", protectedPayloadRef: "protected-memory", plaintextDigest: "digest",
      keyRecord: { wrappedKey: "never-in-events" },
    },
  });
  await kernel.decideMemory("local", "local-owner", "accept", proposed.id, 1, "accept");
  await kernel.deleteMemory("local", "local-owner", "delete", proposed.id, 2, "user request");
  const events = (await store.readEvents("local", 0, 100)).events;
  const replay = new Map<string, JsonObject>();
  for (const event of events) {
    const facts = event.publicPayload.projectionFacts as unknown as {
      version: number; changes: { namespace: string; id: string; value: JsonObject | null }[];
    } | undefined;
    assert.equal(facts?.version, 1, `${event.type} must record complete facts`);
    for (const change of facts!.changes) {
      const key = `${change.namespace}:${change.id}`;
      if (change.value === null) replay.delete(key); else replay.set(key, change.value);
    }
  }
  for (const namespace of ["tenant", "principal", "workspace", "membership", "thread",
    "execution", "authority", "session-log-entry", "job", "memory", "memoryTombstone"]) {
    const values = await store.transact("local", tx => tx.listProjections<JsonObject>(namespace));
    for (const value of values) assert.deepEqual(replay.get(`${namespace}:${value.id}`),
      JSON.parse(JSON.stringify(value)), namespace);
  }
  assert.equal(replay.has(`memory:${proposed.id}`), false);
  assert.doesNotMatch(JSON.stringify(events), /never-in-events|sensitive original/);
  const snapshot = replayCoreProjections(events, "local", hmacKey);
  const namespaces = [...new Set(snapshot.records.map(record => record.namespace))];
  await store.transact("local", transaction => {
    for (const namespace of namespaces) {
      for (const value of transaction.listProjections<JsonObject>(namespace)) {
        transaction.deleteProjection(namespace, String(value.id));
      }
    }
    for (const record of snapshot.records) transaction.putProjection(record.namespace, record.id, record.value);
  });
  assert.deepEqual(await kernel.listWorkspaces("local"), [workspace]);
  assert.deepEqual(await store.readEvents("local", 0, 100), { events, nextPosition: events.at(-1)!.position, retentionFloor: 0 });
  assert.throws(() => replayCoreProjections(events.slice(1), "local", hmacKey), /incomplete or unauthenticated/);
  assert.throws(() => replayCoreProjections(events, "another-tenant", hmacKey), /incomplete or unauthenticated/);
  assert.throws(() => replayCoreProjections(events, "local", Buffer.alloc(32, 8)), /incomplete or unauthenticated/);
  assert.throws(() => replayCoreProjections([{ ...events[0]!, publicPayload: {} }, ...events.slice(1)], "local", hmacKey), /incomplete or unauthenticated/);
});
