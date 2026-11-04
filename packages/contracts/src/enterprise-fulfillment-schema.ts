// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' }, detail = { type: 'string', minLength: 1, maxLength: 4000, pattern: '\\S' };
const identifier = { ...text, pattern: '^(?!\\.{1,2}$)(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' };
const n = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...n, minimum: 1 };
const date = { type: 'string', format: 'date' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', properties, additionalProperties: false, required: Object.keys(properties).filter(key => !optional.includes(key)) });
const list = (items: JsonObject, minItems = 0) => ({ type: 'array', items, minItems, maxItems: 100 });
const command = (type: string, properties: Record<string, JsonObject>, optional: string[] = []) => object({ type: { const: type }, id: identifier, ...properties }, optional);
const update = { expectedStreamVersion: positive }, proof = { ...update, evidence: ref('EvidenceRef') };
const unit=object({lineId:text,quantity:positive});
const units = list(unit, 1);
const allocation = list(object({ schedule: ref('BusinessObjectRef'), amountMinor: positive }));
export const ENTERPRISE_FULFILLMENT_COMMANDS: readonly JsonObject[] = [
    command('project.create', { order: ref('BusinessObjectRef'), title: text }),
    command('milestone.create', { project: ref('BusinessObjectRef'), title: text, dueDate: date, lines: units }),
    command('delivery.report', { milestone: ref('BusinessObjectRef'), summary: detail, lines: units }),
    command('delivery.receive', update),
    command('acceptance.prepare', { delivery: ref('BusinessObjectRef'), lines: units }),
    command('acceptance.confirm', proof),
    command('payment_schedule.create', { order: ref('BusinessObjectRef'), amountMinor: positive, dueDate: date }),
    command('payment_schedule.confirm', proof),
    command('receipt.prepare', { order: ref('BusinessObjectRef'), amountMinor: positive, businessDate: date, allocations: allocation }),
    command('receipt.confirm', proof), command('receipt.cancel', update),
    command('refund.prepare', { receipt: ref('BusinessObjectRef'), amountMinor: positive, businessDate: date, releasedAllocations: allocation }),
    command('refund.confirm', proof), command('refund.cancel', update),
    command('adjustment.prepare', { kind: { const: 'write_off' }, order: ref('BusinessObjectRef'), schedule: ref('BusinessObjectRef'), amountMinor: positive, businessDate: date, reason: detail }),
    command('adjustment.prepare', { kind: { const: 'receipt_reversal' }, receipt: ref('BusinessObjectRef'), amountMinor: positive, businessDate: date, reason: detail, releasedAllocations: allocation }),
    command('adjustment.prepare', { kind: { const: 'schedule_revision' }, schedule: ref('BusinessObjectRef'), proposedAmountMinor: positive, proposedDueDate: date, businessDate: date, reason: detail }),
    command('adjustment.prepare', {kind:{const:'receipt_allocation'},receipt:ref('BusinessObjectRef'),schedule:ref('BusinessObjectRef'),amountMinor:positive,businessDate:date,reason:detail}),
    command('adjustment.confirm', proof), command('adjustment.cancel', update),
    command('expense.prepare', { project: ref('BusinessObjectRef'), amountMinor: positive, businessDate: date, description: detail }),
    command('expense.confirm', proof), command('expense.cancel', update),
    command('project.costs.confirm', { ...proof, expenseRefs: list(ref('BusinessObjectRef')), zeroCost: { type: 'boolean' } }),
    command('metric.publish', { metric: { type: 'string', enum: ['net_received', 'outstanding', 'confirmed_cost'] }, title: text }),
    command('objective.create', { order: ref('BusinessObjectRef'), metric: ref('BusinessObjectRef'), periodStart: date, periodEnd: date, targetMinor: n }),
    command('business_review.snapshot', { order: ref('BusinessObjectRef'), periodStart: date, periodEnd: date, includeCosts: { type: 'boolean' }, objective: ref('BusinessObjectRef') }, ['objective']),
    command('change_request.prepare', { project: ref('BusinessObjectRef'), description: detail }),
    command('change_request.price', { ...update, lines: list({ oneOf: [object({ service: ref('BusinessObjectRef'), quantity: positive }), object({ orderLineId: text, quantity: positive })] }, 1) }),
    command('change_request.approve', proof), command('change_request.cancel', update),
    command('change_request.project_confirm', { ...update, milestones: list(object({ milestone: ref('BusinessObjectRef'), expectedStreamVersion: positive, lines: list(unit) })) }),
];
