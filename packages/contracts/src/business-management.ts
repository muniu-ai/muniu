// SPDX-License-Identifier: Apache-2.0

/** M1 uses CNY integer minor units; decimal currency amounts are never accepted. */
export type BusinessMoneyV1 = string;
export interface BusinessPeriodV1 { readonly start: string; readonly end: string }
export interface BusinessAuditV1 { readonly recordedBy: string; readonly recordedAt: string }
export interface BusinessPlanV1 extends BusinessAuditV1 {
  readonly id: string; readonly revision: number; readonly title: string;
  readonly period: BusinessPeriodV1; readonly targetCustomer: string; readonly valueProposition: string;
  readonly focus: readonly string[]; readonly resources: string; readonly reviewOn: string;
}
export interface BusinessCustomerV1 extends BusinessAuditV1 {
  readonly id: string; readonly version: number; readonly name: string; readonly source: string;
  readonly need: string; readonly contact?: string; readonly followUpOn?: string;
}
export interface BusinessServiceV1 extends BusinessAuditV1 {
  readonly id: string; readonly version: number; readonly title: string; readonly currency: "CNY";
  readonly priceMinor: BusinessMoneyV1; readonly inScope: readonly string[];
  readonly outOfScope: readonly string[]; readonly acceptanceCriteria: readonly string[];
}
export interface BusinessQuoteV1 extends BusinessAuditV1 {
  readonly id: string; readonly customerId: string; readonly customerVersion: number;
  readonly serviceId: string; readonly serviceVersion: number; readonly quantity: number;
  readonly discountMinor: BusinessMoneyV1; readonly totalMinor: BusinessMoneyV1;
  readonly validUntil: string; readonly dueOn: string; readonly notes?: string;
}
export interface BusinessQuoteConfirmationV1 extends BusinessAuditV1 {
  readonly id: string; readonly quoteId: string; readonly confirmedOn: string; readonly sourceRef: string;
}
export interface BusinessOrderV1 extends BusinessAuditV1 {
  readonly id: string; readonly customerId: string; readonly customerVersion: number;
  readonly serviceId: string; readonly serviceVersion: number; readonly quantity: number;
  readonly agreedAmountMinor: BusinessMoneyV1; readonly contractedOn: string; readonly dueOn: string;
  readonly sourceRef: string; readonly quoteId?: string; readonly quoteConfirmationId?: string; readonly opening?: BusinessOpeningV1;
}
export interface BusinessOpeningV1 {
  readonly asOf: string; readonly receivedMinor: BusinessMoneyV1;
  readonly deliveredPercent: number; readonly accepted: boolean; readonly sourceRef: string;
}
export interface BusinessOrderAdjustmentV1 extends BusinessAuditV1 {
  readonly id: string; readonly orderId: string; readonly amountDeltaMinor: BusinessMoneyV1;
  readonly effectiveOn: string; readonly dueOn?: string; readonly reason: string; readonly sourceRef: string;
}
export interface BusinessDeliveryV1 extends BusinessAuditV1 {
  readonly id: string; readonly orderId: string; readonly title: string; readonly deliveredOn: string;
  readonly artifactRef: string; readonly progressPercent: number; readonly notes?: string;
}
export interface BusinessAcceptanceV1 extends BusinessAuditV1 {
  readonly id: string; readonly orderId: string; readonly deliveryIds: readonly string[];
  readonly acceptedOn: string; readonly customerConfirmationRef: string; readonly complete: boolean;
}
export interface BusinessPaymentV1 extends BusinessAuditV1 {
  readonly id: string; readonly orderId: string; readonly amountMinor: BusinessMoneyV1;
  readonly receivedOn: string; readonly sourceRef: string;
}
export interface BusinessPaymentReversalV1 extends BusinessAuditV1 {
  readonly id: string; readonly paymentId: string; readonly reversedOn: string;
  readonly reason: string; readonly sourceRef: string;
}
export interface BusinessRefundV1 extends BusinessAuditV1 {
  readonly id: string; readonly orderId: string; readonly paymentId?: string; readonly amountMinor: BusinessMoneyV1;
  readonly refundedOn: string; readonly reason: string; readonly sourceRef: string;
}
export interface BusinessExpenseV1 extends BusinessAuditV1 {
  readonly id: string; readonly orderId?: string; readonly category: string; readonly description: string;
  readonly amountMinor: BusinessMoneyV1; readonly paidOn: string; readonly sourceRef: string;
}
export interface BusinessOrderBalanceV1 {
  readonly orderId: string; readonly agreedAmountMinor: BusinessMoneyV1;
  readonly receivedMinor: BusinessMoneyV1; readonly refundedMinor: BusinessMoneyV1;
  readonly netReceivedMinor: BusinessMoneyV1; readonly outstandingMinor: BusinessMoneyV1;
  readonly dueOn: string; readonly overdue: boolean; readonly delivered: boolean; readonly deliveredPercent: number; readonly accepted: boolean;
}
export interface BusinessSummaryV1 {
  readonly currency: "CNY"; readonly period?: BusinessPeriodV1; readonly sourceStreamVersion: number;
  readonly cashReceivedMinor: BusinessMoneyV1; readonly cashRefundedMinor: BusinessMoneyV1;
  readonly cashExpensesMinor: BusinessMoneyV1; readonly netCashFlowMinor: BusinessMoneyV1;
  readonly contractedMinor: BusinessMoneyV1; readonly outstandingMinor: BusinessMoneyV1;
  readonly overdueMinor: BusinessMoneyV1; readonly orders: readonly BusinessOrderBalanceV1[];
}
export interface BusinessReviewV1 extends BusinessAuditV1 {
  readonly id: string; readonly period: BusinessPeriodV1; readonly sourceStreamVersion: number;
  readonly summary: BusinessSummaryV1; readonly explanation: string; readonly nextDecisions: readonly string[];
}
export interface BusinessStateV1 {
  readonly schemaVersion: 1; readonly workspaceId: string; readonly currency: "CNY"; readonly streamVersion: number;
  readonly plans: readonly BusinessPlanV1[]; readonly customers: readonly BusinessCustomerV1[];
  readonly services: readonly BusinessServiceV1[]; readonly quotes: readonly BusinessQuoteV1[];
  readonly quoteConfirmations?: readonly BusinessQuoteConfirmationV1[]; readonly orders: readonly BusinessOrderV1[]; readonly adjustments: readonly BusinessOrderAdjustmentV1[];
  readonly deliveries: readonly BusinessDeliveryV1[]; readonly acceptances: readonly BusinessAcceptanceV1[];
  readonly payments: readonly BusinessPaymentV1[]; readonly paymentReversals: readonly BusinessPaymentReversalV1[];
  readonly refunds: readonly BusinessRefundV1[]; readonly expenses: readonly BusinessExpenseV1[];
  readonly reviews: readonly BusinessReviewV1[];
}
export interface BusinessManagementViewV1 { readonly state: BusinessStateV1; readonly summary: BusinessSummaryV1 }

export type BusinessCommandV1 =
  | { readonly type: "plan.record"; readonly planId: string; readonly title: string; readonly period: BusinessPeriodV1;
      readonly targetCustomer: string; readonly valueProposition: string; readonly focus: readonly string[];
      readonly resources: string; readonly reviewOn: string }
  | { readonly type: "customer.record"; readonly customerId: string; readonly name: string; readonly source: string;
      readonly need: string; readonly contact?: string; readonly followUpOn?: string }
  | { readonly type: "service.record"; readonly serviceId: string; readonly title: string; readonly currency: "CNY";
      readonly priceMinor: BusinessMoneyV1; readonly inScope: readonly string[]; readonly outOfScope: readonly string[];
      readonly acceptanceCriteria: readonly string[] }
  | { readonly type: "quote.create"; readonly quoteId: string; readonly customerId: string; readonly serviceId: string;
      readonly serviceVersion: number; readonly quantity: number; readonly discountMinor: BusinessMoneyV1;
      readonly validUntil: string; readonly dueOn: string; readonly notes?: string }
  | { readonly type: "quote.confirm"; readonly quoteId: string; readonly confirmationId: string;
      readonly confirmedOn: string; readonly sourceRef: string }
  | { readonly type: "order.activate"; readonly orderId: string; readonly quoteConfirmationId: string;
      readonly contractedOn: string; readonly sourceRef: string }
  | { readonly type: "order.record"; readonly orderId: string; readonly customerId: string; readonly serviceId: string;
      readonly serviceVersion: number; readonly quantity: number; readonly agreedAmountMinor: BusinessMoneyV1;
      readonly contractedOn: string; readonly dueOn: string; readonly sourceRef: string; readonly opening: BusinessOpeningV1 }
  | { readonly type: "order.adjust"; readonly adjustmentId: string; readonly orderId: string;
      readonly amountDeltaMinor: BusinessMoneyV1; readonly effectiveOn: string; readonly dueOn?: string;
      readonly reason: string; readonly sourceRef: string }
  | { readonly type: "delivery.record"; readonly deliveryId: string; readonly orderId: string;
      readonly title: string; readonly deliveredOn: string; readonly artifactRef: string; readonly progressPercent: number; readonly notes?: string }
  | { readonly type: "acceptance.record"; readonly acceptanceId: string; readonly orderId: string;
      readonly deliveryIds: readonly string[]; readonly acceptedOn: string; readonly customerConfirmationRef: string;
      readonly complete: boolean }
  | { readonly type: "payment.record"; readonly paymentId: string; readonly orderId: string;
      readonly amountMinor: BusinessMoneyV1; readonly receivedOn: string; readonly sourceRef: string }
  | { readonly type: "payment.reverse"; readonly reversalId: string; readonly paymentId: string;
      readonly reversedOn: string; readonly reason: string; readonly sourceRef: string }
  | { readonly type: "refund.record"; readonly refundId: string; readonly paymentId?: string; readonly openingOrderId?: string;
      readonly amountMinor: BusinessMoneyV1; readonly refundedOn: string; readonly reason: string; readonly sourceRef: string }
  | { readonly type: "expense.record"; readonly expenseId: string; readonly orderId?: string;
      readonly category: string; readonly description: string; readonly amountMinor: BusinessMoneyV1;
      readonly paidOn: string; readonly sourceRef: string }
  | { readonly type: "review.record"; readonly reviewId: string; readonly period: BusinessPeriodV1;
      readonly explanation: string; readonly nextDecisions: readonly string[] };

export class BusinessManagementError extends TypeError {
  readonly action = "核对经营记录、日期和金额后重试";
  constructor(readonly code: string, message: string) { super(message); this.name = "BusinessManagementError"; }
}
type Rule = { readonly validate: (value: unknown) => void; readonly optional?: boolean };
function invalid(): never { throw new BusinessManagementError("BUSINESS_INPUT_INVALID", "经营命令字段、日期或金额无效"); }
function textRule(maximum: number): Rule { return { validate: value => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) invalid();
} }; }
const identifier: Rule = { validate: value => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(value)) invalid();
} };
const day: Rule = { validate: value => {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/u.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
} };
const flag: Rule = { validate: value => { if (typeof value !== "boolean") invalid(); } };
function integerRule(minimum: number, maximum: number): Rule { return { validate: value => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) invalid();
} }; }
function moneyRule(positive = false, signed = false): Rule { return { validate: value => {
  if (typeof value !== "string" || !(signed ? /^(0|-?[1-9][0-9]{0,23})$/u : /^(0|[1-9][0-9]{0,23})$/u).test(value)
    || (positive && BigInt(value) <= 0n)) invalid();
} }; }
function listRule(item: Rule, minimum = 1, maximum = 50): Rule { return { validate: value => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid();
  for (const entry of value) item.validate(entry);
  if (new Set(value).size !== value.length) invalid();
} }; }
const optional = (rule: Rule): Rule => ({ ...rule, optional: true });
function shape(value: unknown, fields: Readonly<Record<string, Rule>>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) invalid();
  const item = value as Record<string, unknown>;
  if (Object.getOwnPropertyNames(item).some(field => !Object.hasOwn(fields, field))) invalid();
  for (const [field, rule] of Object.entries(fields)) {
    if (!Object.hasOwn(item, field) && rule.optional) continue;
    rule.validate(item[field]);
  }
  return item;
}
const periodRule: Rule = { validate: value => {
  const period = shape(value, { start: day, end: day });
  if (String(period.start) > String(period.end)) invalid();
} };
export function parseBusinessPeriod(value: unknown): BusinessPeriodV1 {
  periodRule.validate(value); return structuredClone(value) as BusinessPeriodV1;
}
const openingRule: Rule = { validate: value => {
  const opening = shape(value, { asOf: day, receivedMinor: moneyRule(), deliveredPercent: integerRule(0, 100), accepted: flag, sourceRef: textRule(2000) });
  if (opening.accepted && opening.deliveredPercent !== 100) invalid();
} };
const text = textRule(4000), title = textRule(200), source = textRule(2000), lines = listRule(textRule(2000));
const commandRules: Readonly<Record<BusinessCommandV1["type"], Readonly<Record<string, Rule>>>> = {
  "plan.record": { planId: identifier, title, period: periodRule, targetCustomer: text, valueProposition: text, focus: lines, resources: text, reviewOn: day },
  "customer.record": { customerId: identifier, name: title, source, need: text, contact: optional(textRule(500)), followUpOn: optional(day) },
  "service.record": { serviceId: identifier, title, currency: { validate: value => { if (value !== "CNY") invalid(); } }, priceMinor: moneyRule(),
    inScope: lines, outOfScope: listRule(textRule(2000), 0), acceptanceCriteria: lines },
  "quote.create": { quoteId: identifier, customerId: identifier, serviceId: identifier, serviceVersion: integerRule(1, 1_000_000),
    quantity: integerRule(1, 10_000), discountMinor: moneyRule(), validUntil: day, dueOn: day, notes: optional(text) },
  "quote.confirm": { quoteId: identifier, confirmationId: identifier, confirmedOn: day, sourceRef: source },
  "order.activate": { orderId: identifier, quoteConfirmationId: identifier, contractedOn: day, sourceRef: source },
  "order.record": { orderId: identifier, customerId: identifier, serviceId: identifier, serviceVersion: integerRule(1, 1_000_000),
    quantity: integerRule(1, 10_000), agreedAmountMinor: moneyRule(), contractedOn: day, dueOn: day, sourceRef: source, opening: openingRule },
  "order.adjust": { adjustmentId: identifier, orderId: identifier, amountDeltaMinor: moneyRule(false, true), effectiveOn: day, dueOn: optional(day), reason: text, sourceRef: source },
  "delivery.record": { deliveryId: identifier, orderId: identifier, title, deliveredOn: day, artifactRef: source, progressPercent: integerRule(1, 100), notes: optional(text) },
  "acceptance.record": { acceptanceId: identifier, orderId: identifier, deliveryIds: listRule(identifier, 0, 100), acceptedOn: day, customerConfirmationRef: source, complete: flag },
  "payment.record": { paymentId: identifier, orderId: identifier, amountMinor: moneyRule(true), receivedOn: day, sourceRef: source },
  "payment.reverse": { reversalId: identifier, paymentId: identifier, reversedOn: day, reason: text, sourceRef: source },
  "refund.record": { refundId: identifier, paymentId: optional(identifier), openingOrderId: optional(identifier), amountMinor: moneyRule(true), refundedOn: day, reason: text, sourceRef: source },
  "expense.record": { expenseId: identifier, orderId: optional(identifier), category: title, description: text, amountMinor: moneyRule(true), paidOn: day, sourceRef: source },
  "review.record": { reviewId: identifier, period: periodRule, explanation: text, nextDecisions: lines },
};
export function parseBusinessCommand(value: unknown): BusinessCommandV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const type = (value as Record<string, unknown>).type;
  if (typeof type !== "string" || !Object.hasOwn(commandRules, type)) invalid();
  const item = shape(value, { type: { validate: () => {} }, ...commandRules[type as BusinessCommandV1["type"]] });
  if (type === "refund.record" && Boolean(item.paymentId) === Boolean(item.openingOrderId)) invalid();
  if (JSON.stringify(item).length > 128 * 1024) invalid();
  return structuredClone(value) as BusinessCommandV1;
}
