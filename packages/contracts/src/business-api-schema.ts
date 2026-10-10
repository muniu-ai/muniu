// SPDX-License-Identifier: Apache-2.0
import type { BusinessCommandV1 } from "./business-management.js";
import type { JsonObject } from "./json.js";

export function businessMutationSchema(): JsonObject {
  const text: JsonObject = { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" };
  const title: JsonObject = { ...text, maxLength: 200 };
  const source: JsonObject = { ...text, maxLength: 2000 };
  const identifier: JsonObject = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$" };
  const date: JsonObject = { type: "string", format: "date", pattern: "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$" };
  const money: JsonObject = { type: "string", pattern: "^(0|[1-9][0-9]{0,23})$" };
  const positiveMoney: JsonObject = { type: "string", pattern: "^[1-9][0-9]{0,23}$" };
  const list: JsonObject = { type: "array", items: source, minItems: 1, maxItems: 50, uniqueItems: true };
  const serviceVersion: JsonObject = { type: "integer", minimum: 1, maximum: 1_000_000 };
  const quantity: JsonObject = { type: "integer", minimum: 1, maximum: 10_000 };
  const object = (properties: JsonObject, optional: readonly string[] = []): JsonObject => ({ type: "object", additionalProperties: false,
    required: Object.keys(properties).filter(key => !optional.includes(key)), properties });
  const period = object({ start: date, end: date });
  const opening = object({ asOf: date, receivedMinor: money, deliveredPercent: { type: "integer", minimum: 0, maximum: 100 }, accepted: { type: "boolean" }, sourceRef: source });
  const variant = (type: BusinessCommandV1["type"], properties: JsonObject, optional: readonly string[] = []) => object({ type: { const: type }, ...properties }, optional);
  const variants: Record<BusinessCommandV1["type"], JsonObject> = {
    "plan.record": variant("plan.record", { planId: identifier, title, period, targetCustomer: text, valueProposition: text, focus: list, resources: text, reviewOn: date }),
    "customer.record": variant("customer.record", { customerId: identifier, name: title, source, need: text, contact: { ...text, maxLength: 500 }, followUpOn: date }, ["contact", "followUpOn"]),
    "service.record": variant("service.record", { serviceId: identifier, title, currency: { const: "CNY" }, priceMinor: money, inScope: list, outOfScope: { ...list, minItems: 0 }, acceptanceCriteria: list }),
    "quote.create": variant("quote.create", { quoteId: identifier, customerId: identifier, serviceId: identifier, serviceVersion, quantity, discountMinor: money, validUntil: date, dueOn: date, notes: text }, ["notes"]),
    "quote.confirm": variant("quote.confirm", { quoteId: identifier, confirmationId: identifier, confirmedOn: date, sourceRef: source }),
    "order.activate": variant("order.activate", { orderId: identifier, quoteConfirmationId: identifier, contractedOn: date, sourceRef: source }),
    "order.record": variant("order.record", { orderId: identifier, customerId: identifier, serviceId: identifier, serviceVersion, quantity, agreedAmountMinor: money, contractedOn: date, dueOn: date, sourceRef: source, opening }),
    "order.adjust": variant("order.adjust", { adjustmentId: identifier, orderId: identifier, amountDeltaMinor: { type: "string", pattern: "^(0|-?[1-9][0-9]{0,23})$" }, effectiveOn: date, dueOn: date, reason: text, sourceRef: source }, ["dueOn"]),
    "delivery.record": variant("delivery.record", { deliveryId: identifier, orderId: identifier, title, deliveredOn: date, artifactRef: source, progressPercent: { type: "integer", minimum: 1, maximum: 100 }, notes: text }, ["notes"]),
    "acceptance.record": variant("acceptance.record", { acceptanceId: identifier, orderId: identifier, deliveryIds: { ...list, items: identifier, minItems: 0, maxItems: 100 }, acceptedOn: date, customerConfirmationRef: source, complete: { type: "boolean" } }),
    "payment.record": variant("payment.record", { paymentId: identifier, orderId: identifier, amountMinor: positiveMoney, receivedOn: date, sourceRef: source }),
    "payment.reverse": variant("payment.reverse", { reversalId: identifier, paymentId: identifier, reversedOn: date, reason: text, sourceRef: source }),
    "refund.record": variant("refund.record", { refundId: identifier, paymentId: identifier, openingOrderId: identifier, amountMinor: positiveMoney, refundedOn: date, reason: text, sourceRef: source }, ["paymentId", "openingOrderId"]),
    "expense.record": variant("expense.record", { expenseId: identifier, orderId: identifier, category: title, description: text, amountMinor: positiveMoney, paidOn: date, sourceRef: source }, ["orderId"]),
    "review.record": variant("review.record", { reviewId: identifier, period, explanation: text, nextDecisions: list }),
  };
  return object({ workspaceId: text, expectedStreamVersion: { type: "integer", minimum: 0 }, command: { oneOf: Object.values(variants) } });
}

export function opcBusinessCandidateCommandSchema(): JsonObject {
  const properties = businessMutationSchema().properties as JsonObject;
  const variants = (properties.command as JsonObject).oneOf as JsonObject[];
  return { oneOf: variants.filter(variant => {
    const command = ((variant.properties as JsonObject).type as JsonObject).const;
    return command === "quote.create" || command === "delivery.record" || command === "review.record";
  }) };
}
