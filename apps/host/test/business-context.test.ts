// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { BusinessCommandV1, BusinessContextTargetV2, BusinessStateV1, Workspace, WorkspaceMembership } from "@mn/contracts";
import { InMemoryKernelStore } from "@mn/kernel";
import { applyBusinessCommand, createEmptyBusiness } from "@mn/plugin-opc";
import { assertBusinessContextRef, isBusinessContextRef, readBusinessContext } from "../src/business-context.js";
import { createAgentOsHost } from "../src/index.js";
import { recordBusinessSnapshots } from "../src/business-snapshots.js";

async function fixture(t: test.TestContext) {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({ store, secretStore: { async save() { throw new Error("unused"); }, async read() { throw new Error("unused"); } } });
  t.after(() => host.close());
  const workspace = await host.kernel.createWorkspace("local", "local-owner", "business-context", { name: "业务资料", viewMode: "business", pluginIds: ["opc"] });
  const scope = { tenantId: "local", workspaceId: workspace.id, principalId: "local-owner" };
  let state = createEmptyBusiness(workspace.id);
  const commands: BusinessCommandV1[] = [
    { type: "customer.record", customerId: "customer", name: "青禾", source: "客户面谈", need: "品牌设计", contact: "private-contact" },
    { type: "customer.record", customerId: "unrelated", name: "其他客户", source: "其他", need: "未获选需求" },
    { type: "service.record", serviceId: "service", title: "设计服务", currency: "CNY", priceMinor: "100000", inScope: ["标志"], outOfScope: ["印刷"], acceptanceCriteria: ["源文件"] },
    { type: "quote.create", quoteId: "quote", customerId: "customer", serviceId: "service", serviceVersion: 1, quantity: 1, discountMinor: "0", validUntil: "2026-10-20", dueOn: "2026-10-30" },
    { type: "order.record", orderId: "order", customerId: "customer", serviceId: "service", serviceVersion: 1, quantity: 1, agreedAmountMinor: "100000", contractedOn: "2026-10-01", dueOn: "2026-10-30", sourceRef: "合同", opening: { asOf: "2026-10-01", receivedMinor: "0", deliveredPercent: 0, accepted: false, sourceRef: "期初" } },
    { type: "delivery.record", deliveryId: "delivery", orderId: "order", title: "标志初稿", deliveredOn: "2026-10-02", artifactRef: "原文件", progressPercent: 50 },
    { type: "review.record", reviewId: "review", period: { start: "2026-10-01", end: "2026-10-10" }, explanation: "尚未验收", nextDecisions: ["完善交付"] },
  ];
  for (const command of commands) state = applyBusinessCommand(state, command, { principalId: "local-owner", occurredAt: "2026-10-10T00:00:00.000Z" });
  await store.transact("local", tx => tx.putProjection("opc.business", workspace.id, state));
  return { store, host, workspace, scope, state,
    read: (kind: BusinessContextTargetV2["kind"], resourceId: string) => store.transact("local", tx => readBusinessContext(tx, scope, { kind, resourceId })),
  };
}

test("业务对象委派只读取选中对象及必要关联，保留原始金额与独立验收状态", async t => {
  const f = await fixture(t);
  const before = await f.store.readEvents("local", 0, 1000);
  for (const [kind, id] of [["customer", "customer"], ["order", "order"], ["delivery", "delivery"], ["review", "review"]] as const) {
    const context = await f.read(kind, id);
    assert.equal(context.sourceRef.namespace, `opc.business.${kind}`);
    assert.equal(context.sourceRef.streamVersion, f.state.streamVersion);
    assert.match(context.sourceRef.digest!, /^[a-f0-9]{64}$/u);
    assert.equal(context.content.includes("其他客户"), false);
    assert.equal(context.content.includes("private-contact"), false);
    assert.doesNotThrow(() => JSON.parse(context.content));
    await f.store.transact("local", tx => assertBusinessContextRef(tx, f.scope, context.sourceRef));
  }
  const order = JSON.parse((await f.read("order", "order")).content);
  assert.equal(order.order.agreedAmountMinor, "100000");
  assert.equal(order.balance.deliveredPercent, 50);
  assert.equal(order.balance.accepted, false);
  assert.deepEqual(order.payments, []);
  assert.deepEqual(await f.store.readEvents("local", 0, 1000), before);
  assert.deepEqual(await f.store.transact("local", tx => tx.getProjection("opc.business", f.workspace.id)), f.state);
});

test("业务历史来源仍按当前权限读取，新工作和候选应用必须使用当前事实", async t => {
  const f = await fixture(t), source = await f.read("customer", "customer");
  await f.store.transact("local", tx => {
    const before = tx.getProjection<BusinessStateV1>("opc.business", f.workspace.id)!;
    const next = applyBusinessCommand(before, { type: "customer.record", customerId: "customer", name: "青禾", source: "需求变更", need: "新版需求" },
      { principalId: "local-owner", occurredAt: "2026-10-10T01:00:00.000Z" });
    recordBusinessSnapshots(tx, f.scope, before, next);
    tx.putProjection("opc.business", f.workspace.id, next);
  });
  await assert.rejects(f.store.transact("local", tx => readBusinessContext(tx, f.scope, source.sourceRef)), /版本已变化/u);
  assert.deepEqual(await f.store.transact("local", tx => readBusinessContext(tx, f.scope, source.sourceRef, "historical")), source);
  await assert.rejects(f.store.transact("local", tx => readBusinessContext(tx, { ...f.scope, workspaceId: "other" }, source.sourceRef, "historical")), /不存在/u);
  await f.store.transact("local", tx => {
    const member = tx.getProjection<WorkspaceMembership>("membership", `${f.workspace.id}:local-owner`)!;
    tx.putProjection("membership", member.id, { ...member, removedAt: "2026-10-10T02:00:00.000Z" });
  });
  await assert.rejects(f.store.transact("local", tx => readBusinessContext(tx, f.scope, source.sourceRef, "historical")), /无权/u);
});

test("历史业务快照不可覆盖，篡改后拒绝回源", async t => {
  const f = await fixture(t), source = await f.read("customer", "customer"), before = f.state;
  const next = { ...before, streamVersion: before.streamVersion + 1 };
  await f.store.transact("local", tx => {
    recordBusinessSnapshots(tx, f.scope, before, next);
    tx.putProjection("opc.business", f.workspace.id, next);
  });
  await assert.rejects(f.store.transact("local", tx => recordBusinessSnapshots(tx, f.scope,
    { ...before, customers: [] }, next)), /历史版本不可用/u);
  await f.store.transact("local", tx => {
    const id = `${f.workspace.id}:${before.streamVersion}`, value = tx.getProjection<object>("opc.businessSnapshot", id)!;
    tx.putProjection("opc.businessSnapshot", id, { ...value, digest: "0".repeat(64) });
  });
  await assert.rejects(f.store.transact("local", tx => readBusinessContext(tx, f.scope, source.sourceRef, "historical")), /历史版本不可用/u);
});

test("报价研究显式选择产品或报价版本，不隐式授权整个台账", async t => {
  const f = await fixture(t), service = await f.read("service", "service"), quote = await f.read("quote", "quote");
  assert.equal(JSON.parse(service.content).service.priceMinor, "100000");
  assert.equal(JSON.parse(quote.content).quote.serviceVersion, 1);
  assert.equal(service.content.includes("青禾"), false);
  assert.equal(quote.content.includes("其他客户"), false);
  assert.equal(quote.content.includes("private-contact"), false);
  assert.equal((await f.read("customer", "customer")).content.includes("设计服务"), false);
});

test("新业务事实使旧引用过期，篡改摘要或对象不能应用", async t => {
  const f = await fixture(t), context = await f.read("customer", "customer");
  await assert.rejects(f.store.transact("local", tx => assertBusinessContextRef(tx, f.scope, { ...context.sourceRef, digest: "0".repeat(64) })), /版本已变化/u);
  await assert.rejects(f.read("customer", "missing"), /不存在/u);
  await f.store.transact("local", tx => {
    const current = tx.getProjection<BusinessStateV1>("opc.business", f.workspace.id)!;
    tx.putProjection("opc.business", f.workspace.id, applyBusinessCommand(current, { type: "customer.record", customerId: "customer", name: "青禾", source: "变更记录", need: "新需求" }, { principalId: "local-owner", occurredAt: "2026-10-10T01:00:00.000Z" }));
  });
  await assert.rejects(f.store.transact("local", tx => assertBusinessContextRef(tx, f.scope, context.sourceRef)), /版本已变化/u);
  assert.equal(JSON.parse((await f.read("customer", "customer")).content).customer.need, "新需求");
  assert.equal(isBusinessContextRef({ namespace: "opc.business.unknown" }), false);
});

test("业务来源重查成员、租户、工作区和插件授权", async t => {
  const f = await fixture(t), context = await f.read("customer", "customer");
  await assert.rejects(f.store.transact("local", tx => readBusinessContext(tx, { ...f.scope, tenantId: "other" }, { kind: "customer", resourceId: "customer" })), /不存在/u);
  await f.store.transact("local", tx => {
    const member = tx.getProjection<WorkspaceMembership>("membership", `${f.workspace.id}:local-owner`)!;
    tx.putProjection("membership", member.id, { ...member, removedAt: "2026-10-10T01:00:00.000Z" });
  });
  await assert.rejects(f.store.transact("local", tx => assertBusinessContextRef(tx, f.scope, context.sourceRef)), /无权/u);
  await f.store.transact("local", tx => {
    const member = tx.getProjection<WorkspaceMembership>("membership", `${f.workspace.id}:local-owner`)!;
    tx.putProjection("membership", member.id, { ...member, removedAt: undefined });
    const workspace = tx.getProjection<Workspace>("workspace", f.workspace.id)!;
    tx.putProjection("workspace", workspace.id, { ...workspace, activePluginIds: [] });
  });
  await assert.rejects(f.store.transact("local", tx => assertBusinessContextRef(tx, f.scope, context.sourceRef)), /尚未启用/u);
});
