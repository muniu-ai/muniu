// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { appendKernelEvent, sha256 } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { createAgentOsHost } from "../src/index.js";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mn-business-management-"));
  const databaseFile = join(root, "state.sqlite3");
  const store = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 61) });
  let identity = { tenantId: "local", principalId: "local-owner" };
  let timestamp = "2026-10-09T12:00:00.000Z";
  const host = await createAgentOsHost({ store, cas: new FileCas({ rootDir: join(root, "cas") }),
    protectedPayloadKeyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 62)), identityResolver: async () => identity,
    now: () => timestamp,
    secretStore: { async save() { throw new Error("No model required"); }, async read() { throw new Error("No model required"); } } });
  t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace("local", "local-owner", "workspace", { name: "经营回归", viewMode: "business", pluginIds: ["opc"] });
  const send = async (path: string, input?: unknown, key: string = randomUUID()) => {
    const response = await host.dispatch(new Request(`http://host.test${path}`, input === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(input),
    }));
    return { status: response.status, body: await response.json() as any };
  };
  const read = (workspaceId = workspace.id) => send(`/v2/plugins/opc/business?workspaceId=${workspaceId}`);
  const command = (command: unknown, expectedStreamVersion: number, key: string = randomUUID(), workspaceId = workspace.id) =>
    send("/v2/plugins/opc/business/commands", { workspaceId, expectedStreamVersion, command }, key);
  return { root, databaseFile, store, host, workspace, send, read, command,
    time(value: string) { timestamp = value; },
    identity(value: typeof identity) { identity = value; },
    async alter(namespace: string, id: string, change: (current: any) => unknown) {
      await store.transact("local", tx => {
        tx.putProjection(namespace, id, change(tx.getProjection(namespace, id)));
        appendKernelEvent(tx, { tenantId: "local", aggregateType: "test", aggregateId: randomUUID(), expectedStreamVersion: 0,
          type: "fixture.changed", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} });
      });
    },
  };
}

test("经营台账无需模型即可读取空工作区，且独立于机会验证", async t => {
  const f = await fixture(t);
  const result = await f.read();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.state.workspaceId, f.workspace.id);
  assert.equal(result.body.data.state.streamVersion, 0);
  assert.ok(result.body.data.summary);
  assert.deepEqual(await f.store.transact("local", tx => tx.listProjections("opc.opportunity")), []);
});

const customer = { type: "customer.record", customerId: "customer-1", name: "private-business-customer-731", source: "线下转介", need: "品牌设计" };
const service = { type: "service.record", serviceId: "service-1", title: "品牌设计", currency: "CNY", priceMinor: "100000",
  inScope: ["标志设计"], outOfScope: ["印刷"], acceptanceCriteria: ["交付源文件"] };

test("经营事实完整交易、重放与受保护重建保持金额和身份一致", async t => {
  const f = await fixture(t);
  f.time("2026-10-01T12:00:00.000Z");
  let version = 0;
  const run = async (command: unknown, key?: string) => {
    const result = await f.command(command, version, key);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    version = result.body.data.state.streamVersion;
    return result.body.data;
  };
  await run({ type: "plan.record", planId: "plan-1", title: "本期经营计划", period: { start: "2026-10-01", end: "2026-10-31" },
    targetCustomer: "独立设计师", valueProposition: "提供品牌设计", focus: ["完成首单"], resources: "每周两天", reviewOn: "2026-10-31" });
  const captured = await run(customer, "customer-command");
  assert.equal(captured.state.customers[0].recordedBy, "local-owner");
  await run(service);
  assert.deepEqual((await f.command(customer, 1, "customer-command")).body.data, captured);
  assert.equal((await f.command({ ...customer, name: "changed" }, 1, "customer-command")).status, 409);
  await run({ type: "quote.create", quoteId: "quote-1", customerId: "customer-1", serviceId: "service-1", serviceVersion: 1,
    quantity: 1, discountMinor: "0", validUntil: "2026-10-31", dueOn: "2026-10-08" });
  f.time("2026-10-09T12:00:00.000Z");
  const confirmed = await run({ type: "quote.confirm", quoteId: "quote-1", confirmationId: "confirmation-1", confirmedOn: "2026-10-02", sourceRef: "客户确认函-1" }, "confirmation");
  assert.equal(confirmed.state.orders.length, 0);
  assert.equal(confirmed.summary.outstandingMinor, "0");
  const sold = await run({ type: "order.activate", quoteConfirmationId: "confirmation-1", orderId: "order-1", contractedOn: "2026-10-02", sourceRef: "生效合同-1" }, "sale");
  assert.equal(sold.summary.outstandingMinor, "100000");
  const partial = await run({ type: "payment.record", paymentId: "payment-1", orderId: "order-1", amountMinor: "30000", receivedOn: "2026-10-03", sourceRef: "收款凭据-1" });
  assert.equal(partial.summary.outstandingMinor, "70000");
  assert.equal(partial.summary.cashReceivedMinor, "30000");
  const firstDelivery = await run({ type: "delivery.record", deliveryId: "delivery-1", orderId: "order-1", title: "初稿", deliveredOn: "2026-10-04", artifactRef: "文件-1", progressPercent: 40 });
  assert.equal(firstDelivery.summary.orders[0].deliveredPercent, 40);
  assert.equal(firstDelivery.summary.orders[0].accepted, false);
  await run({ type: "delivery.record", deliveryId: "delivery-2", orderId: "order-1", title: "终稿", deliveredOn: "2026-10-05", artifactRef: "文件-2", progressPercent: 60 });
  await run({ type: "acceptance.record", acceptanceId: "acceptance-1", orderId: "order-1", deliveryIds: ["delivery-1", "delivery-2"], acceptedOn: "2026-10-06", customerConfirmationRef: "客户验收函-1", complete: true });
  await run({ type: "payment.record", paymentId: "payment-2", orderId: "order-1", amountMinor: "70000", receivedOn: "2026-10-07", sourceRef: "收款凭据-2" });
  await run({ type: "expense.record", expenseId: "expense-1", orderId: "order-1", category: "外包", description: "设计协作", amountMinor: "20000", paidOn: "2026-10-07", sourceRef: "支出凭据-1" });
  const completed = await run({ type: "review.record", reviewId: "review-1", period: { start: "2026-10-01", end: "2026-10-09" }, explanation: "完成首单，成本可追溯", nextDecisions: ["保留服务范围"] });
  assert.equal(completed.summary.netCashFlowMinor, "80000");
  assert.equal(completed.summary.outstandingMinor, "0");
  assert.equal(completed.summary.orders[0].accepted, true);
  assert.equal(completed.state.reviews[0].summary.netCashFlowMinor, "80000");
  assert.equal(completed.state.reviews[0].sourceStreamVersion, version - 1);
  const raw = new DatabaseSync(f.databaseFile);
  try {
    for (const table of ["events", "projections", "idempotency", "outbox"])
      assert.equal(JSON.stringify(raw.prepare(`select * from ${table}`).all()).includes(customer.name), false, table);
    const events = (await f.store.readEvents("local", 0, 1000)).events.filter(event => event.aggregateType === "opc.business");
    assert.equal(events.length, version);
    for (const event of events) assert.deepEqual(Object.keys(event.publicPayload).sort(), ["command", "workspaceId"]);
    raw.exec("delete from projections; delete from idempotency");
    await f.store.rebuildProjections("local");
    assert.deepEqual((await f.read()).body.data, completed);
    assert.deepEqual((await f.command(customer, 1, "customer-command")).body.data, captured);
  } finally { raw.close(); }
});

test("经营写入拒绝未知字段、非法金额和并发旧版本，不留下部分事实", async t => {
  const f = await fixture(t);
  for (const command of [{ ...customer, principalId: "agent" }, { ...service, priceMinor: "1.25" }, { type: "unregistered" }])
    assert.equal((await f.command(command, 0)).status, 422);
  assert.equal((await f.send("/v2/plugins/opc/business/commands", { workspaceId: f.workspace.id, expectedStreamVersion: 0, command: customer, actor: "human" })).status, 422);
  const results = await Promise.all([f.command(customer, 0, "concurrent-1"), f.command({ ...customer, customerId: "customer-2" }, 0, "concurrent-2")]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const sameKey = await Promise.all([f.command(service, 1, "same-key"), f.command(service, 1, "same-key")]);
  assert.equal(sameKey[0]!.status, 200);
  assert.deepEqual(sameKey[0]!.body.data, sameKey[1]!.body.data);
  assert.equal((await f.read()).body.data.state.streamVersion, 2);
  assert.equal((await f.read()).body.data.state.services.length, 1);
});

test("经营读取及旧回执重放仍重查成员、人员身份和插件启用", async t => {
  const f = await fixture(t);
  assert.equal((await f.command(customer, 0, "create")).status, 200);
  const memberId = `${f.workspace.id}:local-owner`;
  await f.alter("membership", memberId, current => ({ ...current, workspaceRole: "viewer" }));
  assert.equal((await f.read()).status, 200);
  assert.equal((await f.command(customer, 0, "create")).status, 403);
  await f.alter("membership", memberId, current => ({ ...current, workspaceRole: "owner" }));
  await f.alter("principal", "local-owner", current => ({ ...current, kind: "agent" }));
  assert.equal((await f.command(customer, 0, "create")).status, 403);
  await f.alter("principal", "local-owner", current => ({ ...current, kind: "human" }));
  await f.alter("workspace", f.workspace.id, current => ({ ...current, activePluginIds: [] }));
  assert.equal((await f.command(customer, 0, "create")).status, 422);
  await f.alter("workspace", f.workspace.id, current => ({ ...current, activePluginIds: ["opc"] }));
  await f.alter("membership", memberId, current => ({ ...current, removedAt: "2026-10-09T12:00:00.000Z" }));
  assert.equal((await f.read()).status, 403);
  assert.equal((await f.command(customer, 0, "create")).status, 403);
  f.identity({ tenantId: "other", principalId: "local-owner" });
  assert.equal((await f.read()).status, 404);
});

test("经营引用不能穿过工作区，期间参数必须完整有效", async t => {
  const f = await fixture(t);
  await f.command(customer, 0);
  await f.command(service, 1);
  const other = await f.host.kernel.createWorkspace("local", "local-owner", "other", { name: "其他业务", viewMode: "business", pluginIds: ["opc"] });
  const crossed = await f.command({ type: "quote.create", quoteId: "quote-x", customerId: "customer-1", serviceId: "service-1", serviceVersion: 1, quantity: 1, discountMinor: "0", validUntil: "2026-10-31", dueOn: "2026-10-09" }, 0, "crossed", other.id);
  assert.equal(crossed.status, 422);
  assert.equal((await f.read(other.id)).body.data.state.streamVersion, 0);
  for (const query of ["periodStart=2026-10-01", "periodStart=2026-02-30&periodEnd=2026-10-09", "periodStart=2026-10-09&periodEnd=2026-10-01", "periodStart=2026-10-01&periodEnd=2026-10-10"])
    assert.equal((await f.send(`/v2/plugins/opc/business?workspaceId=${f.workspace.id}&${query}`)).status, 422);
});

test("经营接口拒绝重复、未知查询参数和超过限制的命令正文", async t => {
  const f = await fixture(t);
  for (const query of ["extra=1", `workspaceId=${f.workspace.id}`, "periodStart=2026-10-01&periodStart=2026-10-01&periodEnd=2026-10-09"])
    assert.equal((await f.send(`/v2/plugins/opc/business?workspaceId=${f.workspace.id}&${query}`)).status, 422);
  assert.equal((await f.send("/v2/plugins/opc/business/commands?extra=1", {
    workspaceId: f.workspace.id, expectedStreamVersion: 0, command: customer,
  })).status, 422);
  const oversized = await f.command({ ...customer, need: "a".repeat(128 * 1024) }, 0);
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, "REQUEST_BODY_TOO_LARGE");
  assert.equal((await f.read()).body.data.state.streamVersion, 0);
  f.time("2026-10-09T16:01:00.000Z");
  assert.equal((await f.read()).body.data.summary.period.end, "2026-10-10");
  assert.equal((await f.send(`/v2/plugins/opc/business?workspaceId=${f.workspace.id}&periodStart=2026-10-10&periodEnd=2026-10-10`)).status, 200);
});

test("存量订单保持期初与本期现金分离，金额违规原子回滚并允许修正后重试", async t => {
  const f = await fixture(t);
  let version = 0;
  const run = async (command: unknown, key?: string) => {
    const result = await f.command(command, version, key);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    version = result.body.data.state.streamVersion;
    return result.body.data;
  };
  await run(customer); await run(service);
  const opening = await run({ type: "order.record", orderId: "existing-order", customerId: "customer-1", serviceId: "service-1", serviceVersion: 1,
    quantity: 1, agreedAmountMinor: "100000", contractedOn: "2026-09-01", dueOn: "2026-10-08", sourceRef: "原合同",
    opening: { asOf: "2026-09-30", receivedMinor: "40000", deliveredPercent: 20, accepted: false, sourceRef: "期初核对单" } });
  assert.equal(opening.summary.cashReceivedMinor, "0");
  assert.equal(opening.summary.outstandingMinor, "60000");
  await run({ type: "payment.record", paymentId: "pay-1", orderId: "existing-order", amountMinor: "30000", receivedOn: "2026-10-01", sourceRef: "收款凭据" });
  await run({ type: "refund.record", refundId: "refund-1", paymentId: "pay-1", amountMinor: "10000", refundedOn: "2026-10-02", reason: "范围调整", sourceRef: "退款凭据" });
  await run({ type: "order.adjust", adjustmentId: "adjust-1", orderId: "existing-order", amountDeltaMinor: "-10000", effectiveOn: "2026-10-03", reason: "减少范围", sourceRef: "变更确认" });
  const beforeInvalid = await f.read();
  const tooMuch = await f.command({ type: "payment.record", paymentId: "pay-2", orderId: "existing-order", amountMinor: "30001", receivedOn: "2026-10-04", sourceRef: "收款凭据" }, version, "retry-valid");
  assert.equal(tooMuch.status, 422);
  assert.deepEqual((await f.read()).body.data, beforeInvalid.body.data);
  await run({ type: "payment.record", paymentId: "pay-2", orderId: "existing-order", amountMinor: "30000", receivedOn: "2026-10-04", sourceRef: "收款凭据" }, "retry-valid");
  const reversed = await run({ type: "payment.reverse", reversalId: "reverse-2", paymentId: "pay-2", reversedOn: "2026-10-05", reason: "误记", sourceRef: "核对单" });
  assert.equal(reversed.summary.outstandingMinor, "30000");
  assert.equal(reversed.summary.cashReceivedMinor, "30000");
  assert.equal(reversed.summary.cashRefundedMinor, "10000");
  assert.equal(reversed.summary.netCashFlowMinor, "20000");
  const period = await f.send(`/v2/plugins/opc/business?workspaceId=${f.workspace.id}&periodStart=2026-10-01&periodEnd=2026-10-09`);
  assert.equal(period.status, 200);
  assert.equal(period.body.data.summary.cashReceivedMinor, "30000");
  assert.equal(period.body.data.state.payments.length, 2);
  assert.equal(period.body.data.state.paymentReversals.length, 1);
  assert.equal((await f.command({ type: "payment.reverse", reversalId: "reverse-refunded", paymentId: "pay-1", reversedOn: "2026-10-05", reason: "误记", sourceRef: "核对单" }, version)).status, 422);
});

test("报价确认旧成功回执可重放，但旧请求不能再次建立事实", async t => {
  const f = await fixture(t);
  const command = { type: "quote.confirm", quoteId: "old-quote", orderId: "old-order", confirmedOn: "2026-10-09", sourceRef: "historical-confirmation" };
  const frozen = (await f.read()).body.data;
  delete frozen.state.quoteConfirmations;
  await f.store.transact("local", tx => {
    tx.putIdempotency({ tenantId: "local", scope: `opc.business:${f.workspace.id}`, key: "old-confirmation", createdAt: "2026-10-09T12:00:00.000Z",
      requestDigest: sha256({ workspaceId: f.workspace.id, principalId: "local-owner", expectedStreamVersion: 0, command }), response: frozen });
    appendKernelEvent(tx, { tenantId: "local", aggregateType: "test", aggregateId: "old-receipt", expectedStreamVersion: 0,
      type: "fixture.old_receipt", actorId: "local-owner", generation: 0, correlationId: "old-receipt", publicPayload: {} });
  });
  assert.deepEqual((await f.command(command, 0, "old-confirmation")).body.data, frozen);
  assert.equal((await f.command(command, 0, "new-key")).status, 422);
  assert.equal((await f.read()).body.data.state.streamVersion, 0);
});

test("已有0.2台账缺少新确认集合时仍可读取，后续命令不补造历史确认", async t => {
  const f = await fixture(t);
  await f.command(customer, 0);
  await f.alter("opc.business", f.workspace.id, current => { const { quoteConfirmations: _newField, ...original } = current; return original; });
  await f.store.transact("local", tx => {
    tx.deleteProjection("opc.businessSnapshot", `${f.workspace.id}:1`);
    appendKernelEvent(tx, { tenantId: "local", aggregateType: "test", aggregateId: "old-business-state", expectedStreamVersion: 0,
      type: "fixture.old_state", actorId: "local-owner", generation: 0, correlationId: "old-business-state", publicPayload: {} });
  });
  const read = await f.read();
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.data.state.quoteConfirmations, []);
  assert.equal(read.body.data.state.customers.length, 1);
  const next = await f.command(service, 1);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.deepEqual(next.body.data.state.quoteConfirmations, []);
});
