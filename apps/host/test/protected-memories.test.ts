// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { InMemoryKernelStore } from "@mn/kernel";
import {
  InMemoryKeyProvider,
  type ContentAddressedStorage,
} from "@mn/storage";

import {
  createAgentOsHost,
  type ModelSecretStore,
} from "../src/index.js";

const secrets: ModelSecretStore = {
  async save(connectionId) { return `keychain://muniu.v2/${connectionId}`; },
  async read() { return "test-key"; },
};

function request(path: string, body: unknown, key: string, method = "POST") {
  return new Request(`http://host.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}

async function data(response: Response): Promise<any> {
  const body = await response.json() as any;
  assert.equal(response.ok, true, JSON.stringify(body));
  return body.data;
}

function memoryCas(options: { readonly rejectWrites?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  let writes = 0;
  const cas: ContentAddressedStorage = {
    async put(bytes) {
      writes += 1;
      if (options.rejectWrites) throw new Error("CAS write rejected");
      const copy = Buffer.from(bytes);
      const digest = createHash("sha256").update(copy).digest("hex");
      const created = !objects.has(digest);
      objects.set(digest, copy);
      return { digest, byteLength: copy.byteLength, created };
    },
    async get(digest) {
      const value = objects.get(digest);
      if (!value) throw new Error("CAS object missing");
      return Buffer.from(value);
    },
    async has(digest) { return objects.has(digest); },
    async gcOrphans(referencedDigests) {
      const removed: string[] = [];
      for (const digest of objects.keys()) {
        if (referencedDigests.has(digest)) continue;
        objects.delete(digest);
        removed.push(digest);
      }
      return removed;
    },
  };
  return { cas, objects, writes: () => writes };
}

async function fixture(options: { readonly rejectWrites?: boolean } = {}) {
  const store = new InMemoryKernelStore();
  const memoryObjects = memoryCas(options);
  const host = await createAgentOsHost({
    store,
    cas: memoryObjects.cas,
    protectedPayloadKeyProvider: new InMemoryKeyProvider(randomBytes(32)),
    secretStore: secrets,
  });
  const workspace = await data(await host.dispatch(request("/v2/workspaces", {
    name: "受保护记忆",
    viewMode: "business",
    pluginIds: ["opc", "coding"],
  }, "workspace")));
  return { host, store, workspace, ...memoryObjects };
}

test("Memory 明文只在授权响应中出现，事件、投影和 CAS 均不保存明文", async (t) => {
  const context = await fixture();
  t.after(() => context.host.close());

  const secret = "客户要求 7 天内完成可恢复交付";
  const proposed = await data(await context.host.dispatch(request("/v2/memories", {
    workspaceId: context.workspace.id,
    scopeType: "resource",
    namespace: "opc",
    resourceId: "opportunity-1",
    sourceEventId: "event-interview-1",
    confidence: 0.7,
    value: { summary: secret, preference: "不要自动外联" },
  }, "memory-create")));
  assert.equal(proposed.value.summary, secret);
  assert.equal("protectedPayloadRef" in proposed, false);

  const persisted = await context.store.transact("local", (transaction) => {
    const memory = transaction.getProjection<any>("memory", proposed.id);
    return {
      memory,
      key: transaction.getProjection<any>("protectedPayloadKey", memory.protectedPayloadRef),
    };
  });
  assert.equal(persisted.memory.value, undefined);
  assert.equal(typeof persisted.memory.protectedPayloadRef, "string");
  assert.equal(persisted.key.ownerType, "memory");
  assert.equal(persisted.key.ownerId, proposed.id);
  assert.equal(persisted.key.workspaceId, context.workspace.id);
  assert.equal(context.objects.has(persisted.key.ciphertextDigest), true);
  assert.equal(context.objects.get(persisted.key.ciphertextDigest)!.includes(Buffer.from(secret)), false);

  const memoryEvents = (await context.store.readEvents("local", 0, 100)).events
    .filter((event) => event.aggregateType === "memory" && event.aggregateId === proposed.id);
  assert.equal(JSON.stringify(memoryEvents).includes(secret), false);
  assert.equal(memoryEvents[0]?.protectedPayloadRef, persisted.memory.protectedPayloadRef);

  const listed = await data(await context.host.dispatch(new Request(
    `http://host.test/v2/memories?workspaceId=${encodeURIComponent(context.workspace.id)}`,
  )));
  assert.equal(listed.find((memory: any) => memory.id === proposed.id).summary, secret);
});

test("修正 Memory 原子替换 DEK 记录，删除后只留下 tombstone", async (t) => {
  const context = await fixture();
  t.after(() => context.host.close());
  const proposed = await data(await context.host.dispatch(request("/v2/memories", {
    workspaceId: context.workspace.id,
    scopeType: "workspace",
    namespace: "opc",
    resourceId: context.workspace.id,
    sourceEventId: "event-memory-proposal",
    confidence: 0.5,
    value: { summary: "旧内容不可继续解密" },
  }, "memory-create")));
  const before = await context.store.transact("local", (transaction) => {
    const memory = transaction.getProjection<any>("memory", proposed.id);
    return {
      ref: memory.protectedPayloadRef as string,
      key: transaction.getProjection<any>("protectedPayloadKey", memory.protectedPayloadRef),
    };
  });

  const revised = await data(await context.host.dispatch(request(`/v2/memories/${proposed.id}`, {
    expectedStreamVersion: proposed.streamVersion,
    confidence: 0.95,
    value: { summary: "新内容已由用户确认" },
  }, "memory-revise", "PATCH")));
  assert.equal(revised.value.summary, "新内容已由用户确认");
  const after = await context.store.transact("local", (transaction) => {
    const memory = transaction.getProjection<any>("memory", proposed.id);
    return {
      ref: memory.protectedPayloadRef as string,
      oldKey: transaction.getProjection("protectedPayloadKey", before.ref),
      key: transaction.getProjection<any>("protectedPayloadKey", memory.protectedPayloadRef),
    };
  });
  assert.notEqual(after.ref, before.ref);
  assert.equal(after.oldKey, undefined);
  assert.equal(after.key.ownerId, proposed.id);
  assert.notEqual(after.key.ciphertextDigest, before.key.ciphertextDigest);

  const deleted = await data(await context.host.dispatch(request(`/v2/memories/${proposed.id}`, {
    expectedStreamVersion: revised.streamVersion,
    reason: "用户要求删除",
  }, "memory-delete", "DELETE")));
  assert.equal(deleted.status, "deleted");
  const final = await context.store.transact("local", (transaction) => ({
    memory: transaction.getProjection("memory", proposed.id),
    key: transaction.getProjection("protectedPayloadKey", after.ref),
    tombstone: transaction.getProjection<any>("memoryTombstone", proposed.id),
  }));
  assert.equal(final.memory, undefined);
  assert.equal(final.key, undefined);
  assert.equal(final.tombstone.status, "deleted");
  assert.equal(final.tombstone.reason, "用户要求删除");
  assert.equal("protectedPayloadRef" in final.tombstone, false);
});

test("Memory 加密或 CAS 失败时不提交事件、投影与 DEK 记录", async (t) => {
  const context = await fixture({ rejectWrites: true });
  t.after(() => context.host.close());
  const response = await context.host.dispatch(request("/v2/memories", {
    workspaceId: context.workspace.id,
    scopeType: "workspace",
    namespace: "opc",
    resourceId: context.workspace.id,
    sourceEventId: "event-failure",
    confidence: 0.4,
    value: { summary: "不能进入事实存储" },
  }, "memory-cas-failure"));
  assert.equal(response.status, 500);
  assert.equal(context.writes(), 1);
  assert.deepEqual(await context.store.transact("local", (transaction) => ({
    memories: transaction.listProjections("memory"),
    keys: transaction.listProjections("protectedPayloadKey"),
  })), { memories: [], keys: [] });
  assert.equal((await context.store.readEvents("local", 0, 100)).events
    .some((event) => event.type.startsWith("memory.")), false);
});

test("Memory PATCH 也拒绝客户端指定 protectedPayloadRef", async (t) => {
  const context = await fixture();
  t.after(() => context.host.close());
  const proposed = await data(await context.host.dispatch(request("/v2/memories", {
    workspaceId: context.workspace.id,
    scopeType: "workspace",
    namespace: "opc",
    resourceId: context.workspace.id,
    sourceEventId: "event-protected-ref",
    confidence: 0.4,
    value: { summary: "初始内容" },
  }, "memory-create")));
  const response = await context.host.dispatch(request(`/v2/memories/${proposed.id}`, {
    expectedStreamVersion: proposed.streamVersion,
    confidence: 0.6,
    value: { summary: "篡改" },
    protectedPayloadRef: "vault://attacker/key",
  }, "memory-forged-ref", "PATCH"));
  assert.equal(response.status, 422);
  assert.equal((await response.json() as any).code, "PROTECTED_PAYLOAD_REF_FORBIDDEN");
});
