// SPDX-License-Identifier: Apache-2.0
import { ENTERPRISE_BUSINESS_QUERY_SCHEMAS } from './enterprise-business-query-schema.js';
import { ENTERPRISE_FULFILLMENT_COMMANDS } from './enterprise-fulfillment-schema.js';
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' };
const identifier = { ...text, pattern: '^(?!\\.{1,2}$)(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' };
const detail = { type: 'string', minLength: 1, maxLength: 4000 };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positive = { ...integer, minimum: 1 };
const timestamp = { type: 'string', format: 'date-time' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', additionalProperties: false,
  properties, required: Object.keys(properties).filter(key => !optional.includes(key)) });
const command = (type: string, properties: Record<string, JsonObject>, optional: string[] = []) => object({ type: { const: type }, id: identifier, ...properties }, optional);
const update = { expectedStreamVersion: positive };
const lines = (items: JsonObject) => ({ type: 'array', items, minItems: 1, maxItems: 100 });
export const ENTERPRISE_BUSINESS_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  ...ENTERPRISE_BUSINESS_QUERY_SCHEMAS,
  EnterpriseBusinessEvidenceWithdraw: object({ expectedStreamVersion: positive }),
  EnterpriseBusinessEvidenceWithdrawn: object({ id: text, streamVersion: positive }),
  EnterpriseBusinessEvidenceCreate: object({ subject: ref('BusinessObjectRef'), attestation: detail,
    additionalFieldClasses: { type: 'array', uniqueItems: true, maxItems: 4, items: { type: 'string', enum: ['public', 'price', 'cost', 'contact'] } } }),
  EnterpriseBusinessEvidenceView: object({ reference: ref('EvidenceRef'), subject: ref('BusinessObjectRef'), attestation: detail,
    requiredClasses: { type: 'array', items: { type: 'string', enum: ['public', 'price', 'cost', 'contact'] } }, recordedBy: text, recordedAt: timestamp, streamVersion: positive }),
  EnterpriseBusinessCommand: { oneOf: [
    ...ENTERPRISE_FULFILLMENT_COMMANDS,
    command('customer.create', { name: text, departmentId: text }, ['departmentId']),
    command('customer.rename', { ...update, name: text }),
    command('contact.create', { customer: ref('BusinessObjectRef'), name: text, email: text, phone: text }, ['email', 'phone']),
    command('contact.update', { ...update, name: text, email: text, phone: text }, ['email', 'phone']),
    command('opportunity.create', { customer: ref('BusinessObjectRef'), title: text }),
    command('opportunity.update', { ...update, customer: ref('BusinessObjectRef'), title: text }),
    command('service.publish', { serviceCode: text, title: text, unit: text, unitPriceMinor: positive, scope: detail,
      acceptanceCriteria: lines(detail), validFrom: timestamp, validUntil: timestamp,
      supersedes: object({ id: text, expectedStreamVersion: positive }) }, ['supersedes']),
    command('quote.prepare', { opportunity: ref('BusinessObjectRef'), lines: lines(object({ service: ref('BusinessObjectRef'), quantity: positive })), validUntil: timestamp }),
    command('quote.approve', update),
    command('quote.record_acceptance', { ...update, evidence: ref('EvidenceRef') }),
    command('contract.create', { quote: ref('BusinessObjectRef'), title: text }),
    command('contract.activate', { ...update, evidence: ref('EvidenceRef') }),
    command('order.create', { contract: ref('BusinessObjectRef'), lines: lines(object({ quoteLineId: text, quantity: positive })) }),
    command('order.activate', update),
  ] },
  EnterpriseBusinessObjectView: object({ reference: ref('BusinessObjectRef'), values: { type: 'object', additionalProperties: true } }),
  EnterpriseBusinessObjectList: { type: 'array', items: ref('EnterpriseBusinessObjectView') },
};
