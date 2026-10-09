// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { BusinessCommandV1, BusinessStateV1 } from "@mn/contracts";
import * as opc from "../src/index.js";

const context = { principalId: "owner", occurredAt: "2026-10-09T12:00:00.000Z" };
const period = { start: "2026-10-01", end: "2026-10-09" };
const apply = (state: BusinessStateV1, command: BusinessCommandV1) => (opc as any).applyBusinessCommand(state, command, context) as BusinessStateV1;
const summary = (state: BusinessStateV1, range = period) => (opc as any).calculateBusinessSummary(state, range);
function fixture() {
  let state = (opc as any).createEmptyBusiness("workspace") as BusinessStateV1;
  state = apply(state, { type: "customer.record", customerId: "customer", name: "客户", source: "介绍", need: "项目服务" });
  return apply(state, { type: "service.record", serviceId: "service", title: "服务", currency: "CNY", priceMinor: "100000", inScope: ["成果"], outOfScope: [], acceptanceCriteria: ["客户确认"] });
}
function historical(state = fixture()): BusinessStateV1 {
  return apply(state, { type: "order.record", orderId: "order", customerId: "customer", serviceId: "service", serviceVersion: 1,
    quantity: 1, agreedAmountMinor: "100000", contractedOn: "2026-09-01", dueOn: "2026-10-05", sourceRef: "contract-1",
    opening: { asOf: "2026-09-30", receivedMinor: "40000", deliveredPercent: 50, accepted: false, sourceRef: "opening-proof" } });
}
const receipt = (paymentId: string, amountMinor: string, receivedOn = "2026-10-02"): BusinessCommandV1 => ({ type: "payment.record", paymentId, orderId: "order", amountMinor, receivedOn, sourceRef: `bank-${paymentId}` });

test("历史订单只形成期初余额，部分收款、退款与减免分别计算并冻结复盘", () => {
  const original = historical(); let state = apply(original, receipt("payment", "30000"));
  state = apply(state, { type: "refund.record", refundId: "refund", paymentId: "payment", amountMinor: "10000", refundedOn: "2026-10-03", reason: "真实退款", sourceRef: "bank-refund" });
  assert.equal(summary(state).outstandingMinor, "40000");
  state = apply(state, { type: "order.adjust", adjustmentId: "adjust", orderId: "order", amountDeltaMinor: "-10000", effectiveOn: "2026-10-04", reason: "范围减免", sourceRef: "amendment" });
  state = apply(state, { type: "expense.record", expenseId: "expense", orderId: "order", amountMinor: "5000", category: "外包", description: "交付成本", paidOn: "2026-10-04", sourceRef: "expense-proof" });
  const calculated = summary(state);
  assert.equal(calculated.cashReceivedMinor, "30000"); assert.equal(calculated.netCashFlowMinor, "15000");
  assert.equal(calculated.outstandingMinor, "30000"); assert.equal(calculated.overdueMinor, "30000");
  assert.equal(calculated.orders[0].deliveredPercent, 50); assert.equal(calculated.orders[0].delivered, false);
  const version = state.streamVersion;
  state = apply(state, { type: "review.record", reviewId: "review", period, explanation: "本期收款与交付复盘", nextDecisions: ["核实下期交付"] });
  const frozen = structuredClone(state.reviews[0]);
  state = apply(state, receipt("late-record", "10000", "2026-10-02"));
  assert.equal(summary(state).outstandingMinor, "20000");
  assert.deepEqual(state.reviews[0], frozen); assert.equal(frozen!.sourceStreamVersion, version);
  assert.equal(original.payments.length, 0); assert.equal(original.orders[0]!.agreedAmountMinor, "100000");
});

test("报价绑定不可变客户与产品版本，确认只能创建一次订单", () => {
  let state = fixture();
  state = apply(state, { type: "quote.create", quoteId: "quote", customerId: "customer", serviceId: "service", serviceVersion: 1, quantity: 2, discountMinor: "10000", validUntil: "2026-10-20", dueOn: "2026-10-30" });
  state = apply(state, { type: "service.record", serviceId: "service", title: "新版服务", currency: "CNY", priceMinor: "200000", inScope: ["新范围"], outOfScope: [], acceptanceCriteria: ["新标准"] });
  state = apply(state, { type: "customer.record", customerId: "customer", name: "新客户名称", source: "转介绍", need: "新需求" });
  state = apply(state, { type: "quote.confirm", quoteId: "quote", orderId: "order", confirmedOn: "2026-10-09", sourceRef: "customer-confirmation" });
  assert.equal(state.orders[0]!.agreedAmountMinor, "190000");
  assert.equal(state.orders[0]!.serviceVersion, 1); assert.equal(state.orders[0]!.customerVersion, 1);
  assert.equal(state.services[0]!.priceMinor, "100000");
  assert.throws(() => apply(state, { type: "quote.confirm", quoteId: "quote", orderId: "other", confirmedOn: "2026-10-09", sourceRef: "again" }), { code: "BUSINESS_CONFLICT" });
});

test("部分交付与客户验收独立，累计超额和提前全部验收被拒绝", () => {
  let state = historical();
  state = apply(state, { type: "delivery.record", deliveryId: "part", orderId: "order", title: "阶段成果", deliveredOn: "2026-10-03", artifactRef: "file-1", progressPercent: 25 });
  assert.equal(summary(state).orders[0].deliveredPercent, 75);
  const accept = { type: "acceptance.record", acceptanceId: "accept", orderId: "order", deliveryIds: ["part"], acceptedOn: "2026-10-04", customerConfirmationRef: "customer-proof", complete: true } as const;
  assert.throws(() => apply(state, accept), { code: "BUSINESS_ACCEPTANCE_INVALID" });
  assert.throws(() => apply(state, { type: "delivery.record", deliveryId: "too-much", orderId: "order", title: "超额", deliveredOn: "2026-10-04", artifactRef: "file", progressPercent: 26 }), { code: "BUSINESS_BALANCE_INVALID" });
  state = apply(state, { type: "delivery.record", deliveryId: "final", orderId: "order", title: "最终成果", deliveredOn: "2026-10-04", artifactRef: "file-2", progressPercent: 25 });
  assert.equal(summary(state).orders[0].delivered, true); assert.equal(summary(state).orders[0].accepted, false);
  assert.throws(() => apply(state, accept), { code: "BUSINESS_ACCEPTANCE_INVALID" });
  state = apply(state, { ...accept, deliveryIds: ["part", "final"] });
  assert.equal(summary(state).orders[0].accepted, true);
});

test("冲销纠正原收款，退款不能被冲销或超过有效资金，期初退款支持独立核对", () => {
  let state = historical(); state = apply(state, receipt("payment", "30000"));
  state = apply(state, { type: "payment.reverse", reversalId: "reversal", paymentId: "payment", reversedOn: "2026-10-05", reason: "录错", sourceRef: "correction" });
  assert.equal(summary(state).cashReceivedMinor, "0"); assert.equal(summary(state).cashRefundedMinor, "0");
  assert.equal(summary(state).outstandingMinor, "60000");
  assert.throws(() => apply(state, { type: "refund.record", refundId: "bad", paymentId: "payment", amountMinor: "1", refundedOn: "2026-10-06", reason: "退款", sourceRef: "bank" }), { code: "BUSINESS_BALANCE_INVALID" });
  state = apply(state, { type: "refund.record", refundId: "opening-refund", openingOrderId: "order", amountMinor: "10000", refundedOn: "2026-10-06", reason: "退旧款", sourceRef: "bank" });
  assert.equal(summary(state).netCashFlowMinor, "-10000"); assert.equal(summary(state).outstandingMinor, "70000");
  assert.throws(() => apply(state, receipt("excess", "70001")), { code: "BUSINESS_BALANCE_INVALID" });
});

test("期末应收排除之后订单、调整、收款，未来实发生与倒签透支被拒绝", () => {
  let state = historical(); state = apply(state, receipt("payment", "30000", "2026-10-06"));
  state = apply(state, { type: "order.adjust", adjustmentId: "adjust", orderId: "order", amountDeltaMinor: "10000", effectiveOn: "2026-10-07", reason: "增项", sourceRef: "amendment" });
  state = apply(state, { type: "order.record", orderId: "later-order", customerId: "customer", serviceId: "service", serviceVersion: 1,
    quantity: 1, agreedAmountMinor: "999999", contractedOn: "2026-10-06", dueOn: "2026-10-20", sourceRef: "later-contract",
    opening: { asOf: "2026-10-06", receivedMinor: "0", deliveredPercent: 0, accepted: false, sourceRef: "later-opening" } });
  const prior = summary(state, { start: "2026-10-01", end: "2026-10-05" });
  assert.equal(prior.cashReceivedMinor, "0"); assert.equal(prior.outstandingMinor, "60000");
  assert.equal(prior.orders.length, 1);
  assert.throws(() => apply(state, receipt("future", "1", "2026-10-10")), { code: "BUSINESS_DATE_INVALID" });
  assert.throws(() => summary(state, { start: "2026-09-01", end: "2026-09-15" }), { code: "BUSINESS_HISTORY_UNAVAILABLE" });
});

test("经营计划追加版本，身份时间只取Host上下文且命令不能覆盖审计字段", () => {
  let state = fixture();
  const plan = { type: "plan.record", planId: "plan-1", title: "本月经营计划", period, targetCustomer: "客户", valueProposition: "完成服务", focus: ["交付"], resources: "本人每周20小时", reviewOn: "2026-10-09" } as const;
  state = apply(state, plan); state = apply(state, { ...plan, focus: ["回款"] });
  assert.equal(state.plans[0]!.revision, 1); assert.equal(state.plans[1]!.revision, 2);
  assert.deepEqual(state.plans[0]!.focus, ["交付"]);
  state = apply(state, { ...plan, planId: "plan-other" }); assert.equal(state.plans[2]!.revision, 1);
  assert.equal(state.plans[1]!.recordedBy, "owner"); assert.equal(state.plans[1]!.recordedAt, context.occurredAt);
  assert.throws(() => apply(state, { ...plan, planId: "plan-3", recordedBy: "forged" } as any), { code: "BUSINESS_INPUT_INVALID" });
});

test("期初截止日已经包含当日事实，新资金、交付和调整必须在截止日之后", () => {
  const state = historical();
  const commands: BusinessCommandV1[] = [receipt("overlap", "1", "2026-09-30"),
    { type: "refund.record", refundId: "overlap", openingOrderId: "order", amountMinor: "1", refundedOn: "2026-09-30", reason: "退款", sourceRef: "bank" },
    { type: "expense.record", expenseId: "overlap", orderId: "order", amountMinor: "1", paidOn: "2026-09-30", category: "费用", description: "已支付", sourceRef: "bank" },
    { type: "delivery.record", deliveryId: "overlap", orderId: "order", deliveredOn: "2026-09-30", progressPercent: 10, title: "交付", artifactRef: "file" },
    { type: "order.adjust", adjustmentId: "overlap", orderId: "order", effectiveOn: "2026-09-30", amountDeltaMinor: "1", reason: "增项", sourceRef: "amendment" }];
  for (const command of commands) assert.throws(() => apply(state, command), { code: "BUSINESS_DATE_INVALID" });
});

test("不能靠补录后来的退款使倒签减免在历史上形成负应收", () => {
  let state = historical(); state = apply(state, receipt("payment", "60000", "2026-10-02"));
  state = apply(state, { type: "refund.record", refundId: "refund", paymentId: "payment", amountMinor: "10000", refundedOn: "2026-10-06", reason: "退款", sourceRef: "bank" });
  assert.throws(() => apply(state, { type: "order.adjust", adjustmentId: "backdated", orderId: "order", amountDeltaMinor: "-10000", effectiveOn: "2026-10-03", reason: "倒签减免", sourceRef: "amendment" }), { code: "BUSINESS_BALANCE_INVALID" });
  const corrected = apply(state, { type: "order.adjust", adjustmentId: "valid", orderId: "order", amountDeltaMinor: "-10000", effectiveOn: "2026-10-06", reason: "当日减免", sourceRef: "amendment" });
  assert.equal(summary(corrected).outstandingMinor, "0");
});

test("收款冲销更正原发生期间，不把旧收款制造为本期现金流出", () => {
  let state = apply(fixture(), { type: "order.record", orderId: "order", customerId: "customer", serviceId: "service", serviceVersion: 1,
    quantity: 1, agreedAmountMinor: "100000", contractedOn: "2026-08-01", dueOn: "2026-10-20", sourceRef: "contract",
    opening: { asOf: "2026-08-31", receivedMinor: "0", deliveredPercent: 0, accepted: false, sourceRef: "opening" } });
  state = apply(state, receipt("old-payment", "30000", "2026-09-15"));
  const september = { start: "2026-09-01", end: "2026-09-30" };
  state = apply(state, { type: "review.record", reviewId: "old-review", period: september, explanation: "原复盘", nextDecisions: ["检查收款"] });
  state = apply(state, { type: "payment.reverse", reversalId: "reverse", paymentId: "old-payment", reversedOn: "2026-10-08", reason: "重复录入", sourceRef: "correction" });
  assert.equal(summary(state).netCashFlowMinor, "0"); assert.equal(summary(state, september).cashReceivedMinor, "0");
  assert.equal(state.reviews[0]!.summary.cashReceivedMinor, "30000");
});

test("未知引用、超额退款、负合同金额、未来费用退款验收均拒绝", () => {
  const state = historical();
  const invalid: [BusinessCommandV1, string][] = [
    [{ ...receipt("missing", "1"), orderId: "missing-order" } as BusinessCommandV1, "BUSINESS_NOT_FOUND"],
    [{ type: "refund.record", refundId: "excess", openingOrderId: "order", amountMinor: "40001", refundedOn: "2026-10-05", reason: "退款", sourceRef: "bank" }, "BUSINESS_BALANCE_INVALID"],
    [{ type: "order.adjust", adjustmentId: "negative", orderId: "order", amountDeltaMinor: "-100001", effectiveOn: "2026-10-05", reason: "错误减免", sourceRef: "amendment" }, "BUSINESS_BALANCE_INVALID"],
    [{ type: "expense.record", expenseId: "future", category: "费用", description: "尚未发生", amountMinor: "1", paidOn: "2026-10-10", sourceRef: "bank" }, "BUSINESS_DATE_INVALID"],
    [{ type: "refund.record", refundId: "future", openingOrderId: "order", amountMinor: "1", refundedOn: "2026-10-10", reason: "尚未发生", sourceRef: "bank" }, "BUSINESS_DATE_INVALID"],
    [{ type: "acceptance.record", acceptanceId: "future", orderId: "order", deliveryIds: [], acceptedOn: "2026-10-10", customerConfirmationRef: "customer", complete: false }, "BUSINESS_DATE_INVALID"],
  ];
  for (const [command, code] of invalid) assert.throws(() => apply(state, command), { code });
});

test("上海午夜后的实际收款使用本地业务日，报价确认不能倒签至此前业务日", () => {
  const midnight = { principalId: "owner", occurredAt: "2026-10-09T16:30:00.000Z" };
  const received = (opc as any).applyBusinessCommand(historical(), receipt("midnight", "1", "2026-10-10"), midnight) as BusinessStateV1;
  assert.equal(received.payments[0]!.receivedOn, "2026-10-10");
  const quoted = (opc as any).applyBusinessCommand(fixture(), { type: "quote.create", quoteId: "midnight-quote", customerId: "customer", serviceId: "service", serviceVersion: 1,
    quantity: 1, discountMinor: "0", validUntil: "2026-10-20", dueOn: "2026-10-20" }, midnight) as BusinessStateV1;
  assert.throws(() => (opc as any).applyBusinessCommand(quoted, { type: "quote.confirm", quoteId: "midnight-quote", orderId: "midnight-order", confirmedOn: "2026-10-09", sourceRef: "customer" }, midnight), { code: "BUSINESS_DATE_INVALID" });
});
