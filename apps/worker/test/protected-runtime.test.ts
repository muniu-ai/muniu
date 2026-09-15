// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { InMemoryKernelStore } from "@mn/kernel";
import { InMemoryKeyProvider, type ContentAddressedStorage } from "@mn/storage";
import { createProtectedRuntimeStore } from "../src/runtime-store.js";

test("运行上下文加密后原子写入事件与投影，并能在重建投影后恢复", async () => {
  const store = new InMemoryKernelStore();
  const objects = new Map<string, Buffer>();
  const cas: ContentAddressedStorage = {
    async put(bytes) {
      const digest = createHash("sha256").update(bytes).digest("hex");
      objects.set(digest, Buffer.from(bytes));
      return { digest, byteLength: bytes.byteLength, created: true };
    },
    async get(digest) { return objects.get(digest)!; },
    async has(digest) { return objects.has(digest); },
    async gcOrphans() { return []; },
  };
  const options = { tenantId: "local", workspaceId: "workspace", store, cas,
    keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 9)) };
  const runtime = createProtectedRuntimeStore(options);
  const input = { executionId: "execution", type: "model/request" as const,
    payload: { generation: 1, messages: [{ role: "system", content: "受保护客户资料" }] } };
  const saved = await runtime.append(input);
  assert.deepEqual(saved.payload, input.payload);
  const persisted = await store.transact("local", (tx) => tx.getProjection("agent-runtime", "execution"));
  assert.equal(JSON.stringify(persisted).includes("受保护客户资料"), false);
  const events = (await store.readEvents("local", 0, 100)).events;
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes("受保护客户资料"), false);
  assert.ok(events[0]?.protectedPayloadRef);
  assert.equal([...objects.values()].some((value) => value.includes(Buffer.from("受保护客户资料"))), false);
  await store.transact("local", (tx) => tx.deleteProjection("agent-runtime", "execution"));
  const recovered = createProtectedRuntimeStore(options);
  assert.deepEqual(await recovered.readExecution("execution"), [saved]);
  const next = await recovered.append({ ...input, type: "model/response", payload: { text: "结果" } });
  assert.equal(next.sequence, 2);
  const batch = [
    { ...input, type: "inbox/consumed" as const, payload: { itemId: "follow-up" } },
    { ...input, type: "turn/started" as const, payload: { itemId: "follow-up" } },
  ];
  const commits = await Promise.all([recovered.commit("execution", 2, batch), recovered.commit("execution", 2, batch)]);
  assert.equal(commits.filter(Boolean).length, 1);
  const records = await recovered.readExecution("execution");
  assert.deepEqual(records.slice(-2).map(record => record.type), ["inbox/consumed", "turn/started"]);
  assert.equal((await store.readEvents("local", 0, 100)).events.length, 4);
  await store.transact("local", (tx) => tx.deleteProjection("agent-runtime", "execution"));
  store.readEventHistory = store.readEvents.bind(store);
  store.readEvents = async () => { throw new Error("EVENT_CURSOR_EXPIRED"); };
  assert.deepEqual(await createProtectedRuntimeStore(options).readExecution("execution"), records);
});
