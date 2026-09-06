// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import type {
  ExecutionAuthority,
  JsonObject,
  MemoryRecord,
  ShareGrant,
  Thread,
} from "@mn/contracts";
import { InMemoryKernelStore, PROTECTED_PAYLOAD_KEY_NAMESPACE } from "@mn/kernel";
import {
  InMemoryKeyProvider,
  storeProtectedJson,
  type ContentAddressedStorage,
} from "@mn/storage";

import {
  buildAgentMemoryPrompt,
  createEncryptedMemoryReader,
} from "../src/index.js";

const NOW = "2026-09-04T00:00:00.000Z";

function memoryCas() {
  const objects = new Map<string, Buffer>();
  const cas: ContentAddressedStorage = {
    async put(bytes) {
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
    async gcOrphans() { return []; },
  };
  return { cas, objects };
}

function thread(pluginId = "coding"): Thread {
  return {
    id: "thread-1",
    tenantId: "local",
    workspaceId: "workspace-1",
    subject: "验证记忆授权",
    pluginId,
    resourceRef: { namespace: "opc.opportunity", resourceId: "opportunity-1" },
    streamVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function authority(): ExecutionAuthority {
  return {
    id: "authority-1",
    tenantId: "local",
    workspaceId: "workspace-1",
    executionId: "execution-1",
    principalId: "agent:coding",
    toolIds: [],
    dataScopes: [
      { namespace: "opc.opportunity", resourceId: "opportunity-1" },
      { namespace: "coding", resourceId: "repository-1" },
    ],
    autoAllowedEffects: [],
    budget: {
      maxSubagentDepth: 0,
      maxSubagents: 0,
      maxTokens: 1_000,
      maxCostMinorUnits: "0",
      currency: "CNY",
      maxDurationMs: 60_000,
    },
    commitment: "authority",
    streamVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function seedMemory(input: {
  readonly store: InMemoryKernelStore;
  readonly cas: ContentAddressedStorage;
  readonly keys: InMemoryKeyProvider;
  readonly id: string;
  readonly namespace: string;
  readonly scopeType: MemoryRecord["scopeType"];
  readonly resourceId: string;
  readonly summary: string;
  readonly expiresAt?: string;
}): Promise<MemoryRecord> {
  const ref = `protected-${input.id}`;
  const encrypted = await storeProtectedJson({
    tenantId: "local",
    workspaceId: "workspace-1",
    ownerType: "memory",
    ownerId: input.id,
    protectedPayloadRef: ref,
    value: { summary: input.summary },
    cas: input.cas,
    keyProvider: input.keys,
    createdAt: NOW,
  });
  const memory: MemoryRecord = {
    id: input.id,
    tenantId: "local",
    workspaceId: "workspace-1",
    namespace: input.namespace,
    scopeType: input.scopeType,
    resourceId: input.resourceId,
    sourceEventId: `event-${input.id}`,
    status: "accepted",
    confidence: 0.9,
    protectedPayloadRef: ref,
    confirmedAt: NOW,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    shareGrantIds: [],
    streamVersion: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await input.store.transact("local", (transaction) => {
    transaction.putProjection("memory", memory.id, memory);
    transaction.putProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, ref, encrypted.keyRecord);
  });
  return memory;
}

function prompt(input: {
  readonly store: InMemoryKernelStore;
  readonly reader: ReturnType<typeof createEncryptedMemoryReader>;
  readonly namespace?: string;
  readonly currentThread?: Thread;
}) {
  return buildAgentMemoryPrompt({
    tenantId: "local",
    workspaceId: "workspace-1",
    thread: input.currentThread ?? thread(),
    authority: authority(),
    requestingNamespace: input.namespace ?? "coding",
    executionPrincipalId: "agent:coding",
    store: input.store,
    reader: input.reader,
    now: () => NOW,
  });
}

test("跨插件 Memory 只有在 ShareGrant 有效时进入下一 turn，上游撤销立即生效", async () => {
  const store = new InMemoryKernelStore();
  const { cas, objects } = memoryCas();
  const keys = new InMemoryKeyProvider(randomBytes(32));
  const source = await seedMemory({
    store,
    cas,
    keys,
    id: "memory-opc",
    namespace: "opc",
    scopeType: "resource",
    resourceId: "opportunity-1",
    summary: "客户明确要求离线恢复",
  });
  const reader = createEncryptedMemoryReader({ store, cas, keyProvider: keys });

  assert.equal((await prompt({ store, reader })).includes("离线恢复"), false);
  const grant: ShareGrant = {
    id: "grant-1",
    tenantId: "local",
    workspaceId: "workspace-1",
    memoryId: source.id,
    fromNamespace: "opc",
    toNamespace: "coding",
    grantedBy: "local-owner",
    grantedAt: NOW,
    streamVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.transact("local", (transaction) =>
    transaction.putProjection("shareGrant", grant.id, grant));
  assert.equal((await prompt({ store, reader })).includes("离线恢复"), true);

  await store.transact("local", (transaction) =>
    transaction.putProjection("shareGrant", grant.id, {
      ...grant,
      revokedAt: "2026-09-04T00:00:01.000Z",
      streamVersion: 2,
    }));
  assert.equal((await prompt({ store, reader })).includes("离线恢复"), false);
  assert.equal([...objects.values()].some((value) => value.includes(Buffer.from("离线恢复"))), false);
});

test("Memory prompt 同时约束 workspace、scope、resource、namespace 和有效期", async () => {
  const store = new InMemoryKernelStore();
  const { cas } = memoryCas();
  const keys = new InMemoryKeyProvider(randomBytes(32));
  const reader = createEncryptedMemoryReader({ store, cas, keyProvider: keys });
  const records = [
    ["workspace", "workspace", "workspace-1", "工作区可见"],
    ["thread", "thread", "thread-1", "线程可见"],
    ["resource", "resource", "repository-1", "资源可见"],
    ["principal", "principal", "agent:coding", "主体可见"],
    ["wrong-resource", "resource", "opportunity-2", "错误资源"],
  ] as const;
  for (const [id, scopeType, resourceId, summary] of records) {
    await seedMemory({ store, cas, keys, id, namespace: "coding", scopeType, resourceId, summary });
  }
  await seedMemory({
    store,
    cas,
    keys,
    id: "expired",
    namespace: "coding",
    scopeType: "workspace",
    resourceId: "workspace-1",
    summary: "已经过期",
    expiresAt: "2026-09-03T23:59:59.000Z",
  });
  await seedMemory({
    store,
    cas,
    keys,
    id: "wrong-namespace",
    namespace: "opc",
    scopeType: "workspace",
    resourceId: "workspace-1",
    summary: "未授权 namespace",
  });

  const result = await prompt({ store, reader });
  for (const expected of ["工作区可见", "线程可见", "资源可见", "主体可见"]) {
    assert.equal(result.includes(expected), true, expected);
  }
  for (const rejected of ["错误资源", "已经过期", "未授权 namespace"]) {
    assert.equal(result.includes(rejected), false, rejected);
  }
});

test("相同资源 ID 不会跨 namespace 授权记忆", async () => {
  const store = new InMemoryKernelStore();
  const { cas } = memoryCas();
  const keys = new InMemoryKeyProvider(randomBytes(32));
  await seedMemory({ store, cas, keys, id: "collision", namespace: "coding",
    scopeType: "resource", resourceId: "opportunity-1", summary: "未经授权的仓库资料" });
  const result = await prompt({ store, reader: createEncryptedMemoryReader({ store, cas, keyProvider: keys }) });
  assert.equal(result.includes("未经授权"), false);
});

test("解密等待期间撤销 ShareGrant 后，不再返回记忆内容", async () => {
  const store = new InMemoryKernelStore();
  const { cas } = memoryCas();
  const keys = new InMemoryKeyProvider(randomBytes(32));
  const memory = await seedMemory({ store, cas, keys, id: "race", namespace: "opc",
    scopeType: "resource", resourceId: "opportunity-1", summary: "撤销后的秘密" });
  const grant = { id: "grant", tenantId: "local", workspaceId: "workspace-1", memoryId: memory.id,
    fromNamespace: "opc", toNamespace: "coding", grantedBy: "local-owner", grantedAt: NOW,
    streamVersion: 1, createdAt: NOW, updatedAt: NOW };
  await store.transact("local", (transaction) => transaction.putProjection("shareGrant", grant.id, grant));
  const encrypted = createEncryptedMemoryReader({ store, cas, keyProvider: keys });
  const result = await prompt({ store, reader: {
    async read(tenantId, value) {
      const decoded = await encrypted.read(tenantId, value);
      await store.transact("local", (transaction) => transaction.putProjection("shareGrant", grant.id,
        { ...grant, revokedAt: NOW, streamVersion: 2 }));
      return decoded;
    },
  } });
  assert.equal(result.includes("撤销后的秘密"), false);
});
