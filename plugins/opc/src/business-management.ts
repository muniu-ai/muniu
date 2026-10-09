// SPDX-License-Identifier: Apache-2.0
import { BusinessManagementError, businessDateAt, parseBusinessCommand, parseBusinessPeriod,
  type BusinessCommandV1, type BusinessOrderBalanceV1, type BusinessOrderV1,
  type BusinessPeriodV1, type BusinessStateV1, type BusinessSummaryV1 } from "@mn/contracts";

export interface BusinessCommandContext { readonly principalId: string; readonly occurredAt: string }
type Collection = Exclude<keyof BusinessStateV1, "schemaVersion" | "workspaceId" | "currency" | "streamVersion">;
function fail(code: string, message: string): never { throw new BusinessManagementError(code, message); }
function sum(values: readonly string[]): bigint { return values.reduce((total, value) => total + BigInt(value), 0n); }
function unique(items: readonly { readonly id: string }[], id: string): void {
  if (items.some(item => item.id === id)) fail("BUSINESS_CONFLICT", "记录标识已存在，历史记录不能覆盖");
}
function requireOne<T extends { readonly id: string }>(items: readonly T[], id: string): T {
  const found = items.find(item => item.id === id);
  if (!found) fail("BUSINESS_NOT_FOUND", "关联经营记录不存在");
  return found;
}
function add<K extends Collection>(state: BusinessStateV1, field: K, record: BusinessStateV1[K][number]): BusinessStateV1 {
  if (state[field].length >= 10_000) fail("BUSINESS_LIMIT_EXCEEDED", "首版账本已达到记录上限");
  return { ...state, [field]: [...state[field], record] };
}
function dateBetween(day: string, minimum: string, maximum: string): void {
  if (day < minimum || day > maximum) fail("BUSINESS_DATE_INVALID", "发生日期必须位于订单或期初截止日之后，且不能晚于今天");
}
function orderFloor(order: BusinessOrderV1): string { return order.opening?.asOf ?? order.contractedOn; }
function newFactFloor(order: BusinessOrderV1): string {
  return order.opening ? new Date(Date.parse(`${order.opening.asOf}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10) : order.contractedOn;
}
function orderBalance(state: BusinessStateV1, order: BusinessOrderV1, asOf: string, evaluateOverdue: boolean): BusinessOrderBalanceV1 {
  if (order.opening && order.opening.asOf > asOf) fail("BUSINESS_HISTORY_UNAVAILABLE", "期初截止日之前的历史余额无法从当前记录还原");
  const adjustments = state.adjustments.filter(item => item.orderId === order.id && item.effectiveOn <= asOf);
  const reversals = new Set(state.paymentReversals.map(item => item.paymentId));
  const payments = state.payments.filter(item => item.orderId === order.id && item.receivedOn <= asOf && !reversals.has(item.id));
  const refunds = state.refunds.filter(item => item.orderId === order.id && item.refundedOn <= asOf);
  const amount = BigInt(order.agreedAmountMinor) + sum(adjustments.map(item => item.amountDeltaMinor));
  const received = BigInt(order.opening?.receivedMinor ?? "0") + sum(payments.map(item => item.amountMinor));
  const refunded = sum(refunds.map(item => item.amountMinor)), net = received - refunded;
  const deliveries = state.deliveries.filter(item => item.orderId === order.id && item.deliveredOn <= asOf);
  const deliveredPercent = (order.opening?.deliveredPercent ?? 0) + deliveries.reduce((total, item) => total + item.progressPercent, 0);
  if (amount < 0n || net < 0n || net > amount || deliveredPercent > 100) fail("BUSINESS_BALANCE_INVALID", "订单金额、资金余额或累计交付比例越界");
  const dueOn = adjustments.filter(item => item.dueOn).sort((left, right) => left.effectiveOn.localeCompare(right.effectiveOn)).at(-1)?.dueOn ?? order.dueOn;
  const accepted = Boolean(order.opening?.accepted) || state.acceptances.some(item => item.orderId === order.id
    && item.complete && item.acceptedOn <= asOf && deliveries.every(delivery => item.deliveryIds.includes(delivery.id)));
  return { orderId: order.id, agreedAmountMinor: String(amount), receivedMinor: String(received), refundedMinor: String(refunded),
    netReceivedMinor: String(net), outstandingMinor: String(amount - net), dueOn,
    overdue: evaluateOverdue && asOf > dueOn && amount > net, delivered: deliveredPercent === 100, deliveredPercent, accepted };
}
function assertOrderHistory(state: BusinessStateV1, order: BusinessOrderV1): void {
  const dates = new Set([orderFloor(order), ...state.adjustments.filter(item => item.orderId === order.id).map(item => item.effectiveOn),
    ...state.payments.filter(item => item.orderId === order.id).map(item => item.receivedOn),
    ...state.refunds.filter(item => item.orderId === order.id).map(item => item.refundedOn),
    ...state.deliveries.filter(item => item.orderId === order.id).map(item => item.deliveredOn)]);
  for (const day of dates) orderBalance(state, order, day, false);
}

export function createEmptyBusiness(workspaceId: string): BusinessStateV1 {
  if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId.length > 200) fail("BUSINESS_INPUT_INVALID", "工作区标识无效");
  return { schemaVersion: 1, workspaceId, currency: "CNY", streamVersion: 0, plans: [], customers: [], services: [],
    quotes: [], orders: [], adjustments: [], deliveries: [], acceptances: [], payments: [], paymentReversals: [], refunds: [], expenses: [], reviews: [] };
}

/** Cash uses occurrence dates; opening receipts are stock, never period cash. */
export function calculateBusinessSummary(state: BusinessStateV1, requestedPeriod?: BusinessPeriodV1): BusinessSummaryV1 {
  const period = requestedPeriod ? parseBusinessPeriod(requestedPeriod) : undefined;
  const asOf = period?.end ?? "9999-12-31";
  const inPeriod = (day: string) => !period || (day >= period.start && day <= period.end);
  const reversals = new Set(state.paymentReversals.map(item => item.paymentId));
  const received = sum(state.payments.filter(item => !reversals.has(item.id) && inPeriod(item.receivedOn)).map(item => item.amountMinor));
  const refunded = sum(state.refunds.filter(item => inPeriod(item.refundedOn)).map(item => item.amountMinor));
  const expenses = sum(state.expenses.filter(item => inPeriod(item.paidOn)).map(item => item.amountMinor));
  const orders = state.orders.filter(item => item.contractedOn <= asOf).map(order => orderBalance(state, order, asOf, Boolean(period)));
  return { currency: "CNY", ...(period ? { period } : {}), sourceStreamVersion: state.streamVersion,
    cashReceivedMinor: String(received), cashRefundedMinor: String(refunded), cashExpensesMinor: String(expenses), netCashFlowMinor: String(received - refunded - expenses),
    contractedMinor: String(sum(state.orders.filter(item => inPeriod(item.contractedOn)).map(item => item.agreedAmountMinor))
      + sum(state.adjustments.filter(item => inPeriod(item.effectiveOn)).map(item => item.amountDeltaMinor))),
    outstandingMinor: String(sum(orders.map(item => item.outstandingMinor))),
    overdueMinor: String(sum(orders.filter(item => item.overdue).map(item => item.outstandingMinor))), orders };
}

export function applyBusinessCommand(current: BusinessStateV1, input: BusinessCommandV1, context: BusinessCommandContext): BusinessStateV1 {
  const command = parseBusinessCommand(input);
  if (!context || typeof context.principalId !== "string" || !context.principalId.trim() || context.principalId.length > 200
    || typeof context.occurredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(context.occurredAt)
    || !Number.isFinite(Date.parse(context.occurredAt)) || new Date(context.occurredAt).toISOString() !== context.occurredAt)
    fail("BUSINESS_INPUT_INVALID", "经营审计上下文无效");
  const today = businessDateAt(context.occurredAt), audit = { recordedBy: context.principalId, recordedAt: context.occurredAt };
  const order = (id: string) => requireOne(current.orders, id);
  const customer = (id: string) => {
    const found = current.customers.filter(item => item.id === id).at(-1);
    if (!found) fail("BUSINESS_NOT_FOUND", "客户不存在"); return found;
  };
  const service = (id: string, version: number) => {
    const found = current.services.find(item => item.id === id && item.version === version);
    if (!found) fail("BUSINESS_NOT_FOUND", "产品服务版本不存在"); return found;
  };
  let next = current;
  switch (command.type) {
    case "plan.record": {
      if (command.reviewOn < command.period.start) fail("BUSINESS_DATE_INVALID", "复盘日期不能早于经营周期");
      const { type: _type, planId, ...fields } = command;
      next = add(current, "plans", { id: planId, revision: current.plans.filter(item => item.id === planId).length + 1, ...fields, ...audit }); break;
    }
    case "customer.record": {
      const { type: _type, customerId, ...fields } = command;
      next = add(current, "customers", { id: customerId, version: current.customers.filter(item => item.id === customerId).length + 1, ...fields, ...audit }); break;
    }
    case "service.record": {
      const { type: _type, serviceId, ...fields } = command;
      next = add(current, "services", { id: serviceId, version: current.services.filter(item => item.id === serviceId).length + 1, ...fields, ...audit }); break;
    }
    case "quote.create": {
      unique(current.quotes, command.quoteId); const buyer = customer(command.customerId), product = service(command.serviceId, command.serviceVersion);
      if (command.validUntil < today || command.dueOn < today) fail("BUSINESS_DATE_INVALID", "新报价的有效期与付款期限不能早于今天");
      const total = BigInt(product.priceMinor) * BigInt(command.quantity) - BigInt(command.discountMinor);
      if (total < 0n) fail("BUSINESS_BALANCE_INVALID", "报价折扣不能超过原价");
      const { type: _type, quoteId, ...fields } = command;
      next = add(current, "quotes", { id: quoteId, customerVersion: buyer.version, totalMinor: String(total), ...fields, ...audit }); break;
    }
    case "quote.confirm": {
      unique(current.orders, command.orderId); const quote = requireOne(current.quotes, command.quoteId);
      if (current.orders.some(item => item.quoteId === quote.id)) fail("BUSINESS_CONFLICT", "此报价已生成订单");
      dateBetween(command.confirmedOn, businessDateAt(quote.recordedAt), today);
      if (command.confirmedOn > quote.validUntil || command.confirmedOn > quote.dueOn) fail("BUSINESS_DATE_INVALID", "报价已过有效期或付款期限");
      next = add(current, "orders", { id: command.orderId, quoteId: quote.id, customerId: quote.customerId, customerVersion: quote.customerVersion,
        serviceId: quote.serviceId, serviceVersion: quote.serviceVersion, quantity: quote.quantity, agreedAmountMinor: quote.totalMinor,
        contractedOn: command.confirmedOn, dueOn: quote.dueOn, sourceRef: command.sourceRef, ...audit }); break;
    }
    case "order.record": {
      unique(current.orders, command.orderId); const buyer = customer(command.customerId); service(command.serviceId, command.serviceVersion);
      dateBetween(command.contractedOn, "0001-01-01", today); dateBetween(command.opening.asOf, command.contractedOn, today);
      if (command.dueOn < command.contractedOn) fail("BUSINESS_DATE_INVALID", "付款期限不能早于合同日期");
      const { type: _type, orderId, ...fields } = command;
      next = add(current, "orders", { id: orderId, customerVersion: buyer.version, ...fields, ...audit }); break;
    }
    case "order.adjust": {
      unique(current.adjustments, command.adjustmentId); const target = order(command.orderId);
      dateBetween(command.effectiveOn, newFactFloor(target), today);
      if ((command.dueOn && command.dueOn < target.contractedOn) || (command.amountDeltaMinor === "0" && !command.dueOn)) fail("BUSINESS_INPUT_INVALID", "订单调整须变更金额或提供有效付款期限");
      const { type: _type, adjustmentId, ...fields } = command;
      next = add(current, "adjustments", { id: adjustmentId, ...fields, ...audit }); break;
    }
    case "delivery.record": {
      unique(current.deliveries, command.deliveryId); const target = order(command.orderId);
      dateBetween(command.deliveredOn, newFactFloor(target), today);
      const { type: _type, deliveryId, ...fields } = command;
      next = add(current, "deliveries", { id: deliveryId, ...fields, ...audit }); break;
    }
    case "acceptance.record": {
      unique(current.acceptances, command.acceptanceId); const target = order(command.orderId);
      dateBetween(command.acceptedOn, newFactFloor(target), today);
      const delivered = current.deliveries.filter(item => item.orderId === target.id);
      for (const id of command.deliveryIds) {
        const item = requireOne(current.deliveries, id);
        if (item.orderId !== target.id || item.deliveredOn > command.acceptedOn) fail("BUSINESS_ACCEPTANCE_INVALID", "客户验收只能引用本订单已经交付的成果");
      }
      if ((!command.deliveryIds.length && !(target.opening?.deliveredPercent))
        || (command.complete && (orderBalance(current, target, command.acceptedOn, false).deliveredPercent !== 100
          || delivered.some(item => !command.deliveryIds.includes(item.id))))) fail("BUSINESS_ACCEPTANCE_INVALID", "全部验收需要完成全部交付并确认每项成果");
      const { type: _type, acceptanceId, ...fields } = command;
      next = add(current, "acceptances", { id: acceptanceId, ...fields, ...audit }); break;
    }
    case "payment.record": {
      unique(current.payments, command.paymentId); dateBetween(command.receivedOn, newFactFloor(order(command.orderId)), today);
      const { type: _type, paymentId, ...fields } = command;
      next = add(current, "payments", { id: paymentId, ...fields, ...audit }); break;
    }
    case "payment.reverse": {
      unique(current.paymentReversals, command.reversalId); const payment = requireOne(current.payments, command.paymentId);
      dateBetween(command.reversedOn, payment.receivedOn, today);
      if (current.paymentReversals.some(item => item.paymentId === payment.id) || current.refunds.some(item => item.paymentId === payment.id)) fail("BUSINESS_BALANCE_INVALID", "已冲销或已退款的收款不能再次冲销");
      const { type: _type, reversalId, ...fields } = command;
      next = add(current, "paymentReversals", { id: reversalId, ...fields, ...audit }); break;
    }
    case "refund.record": {
      unique(current.refunds, command.refundId);
      const payment = command.paymentId ? requireOne(current.payments, command.paymentId) : undefined;
      const target = order(payment?.orderId ?? command.openingOrderId!);
      if (!payment && !target.opening) fail("BUSINESS_NOT_FOUND", "订单没有可退还的期初收款");
      dateBetween(command.refundedOn, payment?.receivedOn ?? newFactFloor(target), today);
      const previous = current.refunds.filter(item => payment ? item.paymentId === payment.id : item.orderId === target.id && !item.paymentId);
      if ((payment && current.paymentReversals.some(item => item.paymentId === payment.id))
        || BigInt(command.amountMinor) + sum(previous.map(item => item.amountMinor)) > BigInt(payment?.amountMinor ?? target.opening!.receivedMinor))
        fail("BUSINESS_BALANCE_INVALID", "退款不能超过该笔有效收款的剩余金额");
      next = add(current, "refunds", { id: command.refundId, orderId: target.id, ...(payment ? { paymentId: payment.id } : {}),
        amountMinor: command.amountMinor, refundedOn: command.refundedOn, reason: command.reason, sourceRef: command.sourceRef, ...audit }); break;
    }
    case "expense.record": {
      unique(current.expenses, command.expenseId);
      dateBetween(command.paidOn, command.orderId ? newFactFloor(order(command.orderId)) : "0001-01-01", today);
      const { type: _type, expenseId, ...fields } = command;
      next = add(current, "expenses", { id: expenseId, ...fields, ...audit }); break;
    }
    case "review.record": {
      unique(current.reviews, command.reviewId);
      if (command.period.end > today) fail("BUSINESS_DATE_INVALID", "经营复盘不能把未来期间记为已发生");
      next = add(current, "reviews", { id: command.reviewId, period: command.period, sourceStreamVersion: current.streamVersion,
        summary: calculateBusinessSummary(current, command.period), explanation: command.explanation, nextDecisions: command.nextDecisions, ...audit }); break;
    }
  }
  for (const target of next.orders) assertOrderHistory(next, target);
  return { ...next, streamVersion: current.streamVersion + 1 };
}
