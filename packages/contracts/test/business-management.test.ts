// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../src/business-management.js";

const parse = (value: unknown) => (contracts as any).parseBusinessCommand(value);
const customer = { type: "customer.record", customerId: "customer-1", name: "客户", source: "转介绍", need: "项目交付", followUpOn: "2026-10-20" };
test("经营命令严格拒绝未知字段、非法金额、无效日期与非法对象", () => {
  assert.equal(typeof (contracts as any).parseBusinessCommand, "function");
  assert.deepEqual(parse(customer), customer);
  for (const value of [null, [], { ...customer, principalId: "forged" }, { ...customer, followUpOn: "2026-02-30" },
    { ...customer, name: " " }, { ...customer, name: "长".repeat(201) }, { ...customer, type: "customer.delete" },
    { type: "payment.record", paymentId: "p", orderId: "o", receivedOn: "2026-10-09", sourceRef: "bank", amountMinor: NaN },
    { type: "payment.record", paymentId: "p", orderId: "o", receivedOn: "2026-10-09", sourceRef: "bank", amountMinor: "1.1" },
    { type: "payment.record", paymentId: "p", orderId: "o", receivedOn: "2026-10-09", sourceRef: "bank", amountMinor: "01" },
    { type: "payment.record", paymentId: "p", orderId: "o", receivedOn: "2026-10-09", sourceRef: "bank", amountMinor: "0" },
    { type: "refund.record", refundId: "r", paymentId: "p", openingOrderId: "o", amountMinor: "1", refundedOn: "2026-10-09", reason: "退款", sourceRef: "bank" }]) {
    assert.throws(() => parse(value), { code: "BUSINESS_INPUT_INVALID" });
  }
});

test("报价确认和订单生效使用互斥严格字段，旧自动建单输入不可再创建事实", () => {
  const confirm = { type: "quote.confirm", confirmationId: "qc", quoteId: "q", confirmedOn: "2026-10-09", sourceRef: "customer" };
  const activate = { type: "order.activate", orderId: "o", quoteConfirmationId: "qc", contractedOn: "2026-10-09", sourceRef: "contract" };
  assert.deepEqual(parse(confirm), confirm);
  assert.deepEqual(parse(activate), activate);
  assert.throws(() => parse({ ...confirm, orderId: "o" }), { code: "BUSINESS_INPUT_INVALID" });
  assert.throws(() => parse({ type: "quote.confirm", quoteId: "q", orderId: "o", confirmedOn: "2026-10-09", sourceRef: "customer" }), { code: "BUSINESS_INPUT_INVALID" });
  assert.throws(() => parse({ ...activate, agreedAmountMinor: "1" }), { code: "BUSINESS_INPUT_INVALID" });
});
