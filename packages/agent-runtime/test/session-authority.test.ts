// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  DefaultSessionSurface,
  assertToolAuthority,
  InMemoryRuntimeStore,
  PersistentInbox,
  PersistentSessionLog,
  SubagentAuthorityAllocator,
  type RuntimeAuthority,
} from "../src/index.js";

test("资源通配授权可限定 namespace，不放宽到其他数据域", () => {
  const authority: RuntimeAuthority = {
    commitment: "wildcard",
    toolIds: ["opc.public-web.read"],
    dataScopes: [{ namespace: "web", resourceId: "*" }],
    effectClasses: ["external_read"],
    budget: {
      maxSubagentDepth: 0, maxSubagents: 0, maxTokens: 1_000,
      maxCostMinorUnits: "0", currency: "CNY", maxDurationMs: 10_000,
    },
  };
  assert.doesNotThrow(() => assertToolAuthority(
    authority,
    "opc.public-web.read",
    "external_read",
    [{ namespace: "web", resourceId: "https://example.com/research" }],
  ));
  assert.throws(() => assertToolAuthority(
    authority,
    "opc.public-web.read",
    "external_read",
    [{ namespace: "repository", resourceId: "*" }],
  ), /数据范围/u);
});

test("持久 Inbox 按 FIFO 恢复 follow_up，并在模型边界一次消费 steer", async () => {
  const store = new InMemoryRuntimeStore();
  const first = new PersistentInbox(store, "execution-a");
  await first.enqueue("follow_up", "第一步");
  await first.enqueue("follow_up", "第二步");
  await first.enqueue("steer", "改为检查反证");

  assert.equal((await first.takeFollowUp())?.text, "第一步");

  const recovered = new PersistentInbox(store, "execution-a");
  assert.equal((await recovered.takeFollowUp())?.text, "第二步");
  assert.deepEqual((await recovered.takeSteersAtModelBoundary()).map((item) => item.text), ["改为检查反证"]);
  assert.equal(await recovered.takeFollowUp(), undefined);
  assert.deepEqual(await recovered.takeSteersAtModelBoundary(), []);
});

test("Compaction 和 Surface 只改变模型视图，不覆盖 Session Log", async () => {
  const store = new InMemoryRuntimeStore();
  const log = new PersistentSessionLog(store, "execution-a");
  const first = await log.append({ role: "user", content: "很长的原始事实", turn: 1 });
  await log.append({ role: "assistant", content: "原始分析", turn: 1 });
  await log.compact({ throughSequence: first.sequence + 1, summary: "第一轮摘要" });
  await log.append({ role: "user", content: "新的事实", turn: 2 });

  const raw = await log.entries();
  const view = await log.modelView(new DefaultSessionSurface());

  assert.deepEqual(raw.map((entry) => entry.content), ["很长的原始事实", "原始分析", "新的事实"]);
  assert.deepEqual(view.map((message) => message.content), ["第一轮摘要", "新的事实"]);
  assert.ok((await store.readExecution("execution-a")).some((record) => record.type === "session/compaction"));
});

const parentAuthority: RuntimeAuthority = {
  commitment: "parent",
  toolIds: ["web.read", "file.read"],
  dataScopes: [
    { namespace: "opc", resourceId: "opportunity-a" },
    { namespace: "web", resourceId: "public" },
  ],
  effectClasses: ["local_read", "external_read"],
  budget: {
    maxSubagentDepth: 3,
    maxSubagents: 2,
    maxTokens: 1_000,
    maxCostMinorUnits: "500",
    currency: "CNY",
    maxDurationMs: 60_000,
  },
};

test("子 Agent 只能获得父权限、工具、数据与预算的子集", () => {
  const allocator = new SubagentAuthorityAllocator(parentAuthority);
  const child = allocator.allocate({
    toolIds: ["web.read"],
    dataScopes: [{ namespace: "web", resourceId: "public" }],
    effectClasses: ["external_read"],
    budget: {
      maxSubagentDepth: 2,
      maxSubagents: 1,
      maxTokens: 400,
      maxCostMinorUnits: "200",
      currency: "CNY",
      maxDurationMs: 30_000,
    },
  });

  assert.deepEqual(child.toolIds, ["web.read"]);
  assert.notEqual(child.commitment, parentAuthority.commitment);
  assert.throws(() => allocator.allocate({
    ...child,
    toolIds: ["shell.write"],
    commitment: undefined,
  }), /工具权限/u);

  const fresh = () => new SubagentAuthorityAllocator(parentAuthority);
  assert.throws(() => fresh().allocate({ ...child, dataScopes: [{ namespace: "opc", resourceId: "other" }], commitment: undefined }), /数据范围/u);
  assert.throws(() => fresh().allocate({ ...child, effectClasses: ["financial"], commitment: undefined }), /副作用权限/u);
  assert.throws(() => fresh().allocate({ ...child, budget: { ...child.budget, maxSubagentDepth: 3 }, commitment: undefined }), /深度/u);
  assert.throws(() => fresh().allocate({ ...child, budget: { ...child.budget, maxSubagents: 2 }, commitment: undefined }), /数量/u);
  assert.throws(() => fresh().allocate({ ...child, budget: { ...child.budget, maxTokens: 1_001 }, commitment: undefined }), /token/u);
  assert.throws(() => fresh().allocate({ ...child, budget: { ...child.budget, maxCostMinorUnits: "501" }, commitment: undefined }), /费用/u);
  assert.throws(() => fresh().allocate({ ...child, budget: { ...child.budget, maxDurationMs: 60_001 }, commitment: undefined }), /时间/u);
});

test("子 Agent 的累计数量、token 与费用不得突破父预算", () => {
  const allocator = new SubagentAuthorityAllocator(parentAuthority);
  const request = {
    toolIds: ["web.read"],
    dataScopes: [{ namespace: "web", resourceId: "public" }],
    effectClasses: ["external_read" as const],
    budget: {
      maxSubagentDepth: 1,
      maxSubagents: 0,
      maxTokens: 600,
      maxCostMinorUnits: "300",
      currency: "CNY",
      maxDurationMs: 30_000,
    },
  };
  allocator.allocate(request);
  assert.throws(() => allocator.allocate(request), /累计 token|累计费用/u);
});
