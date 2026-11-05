// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' };
const fields = { type: 'array', maxItems: 200, uniqueItems: true, items: text };
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false });
export const ENTERPRISE_BUSINESS_CAPABILITY_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  EnterpriseLoginDirectory: object({ organizations: { type: 'array', maxItems: 1000, items: object({ id: text, name: text }) } }),
  EnterpriseBusinessCapabilities: object({ reference: { $ref: '#/components/schemas/BusinessObjectRef' }, readableFields: fields, writableFields: fields, businessApprovalFields: fields, canRecordEvidence: { type: 'boolean' },
    people: { type: 'array', maxItems: 7, uniqueItems: true, items: object({ principalId: text, displayName: text }) } }),
  EnterpriseBusinessCommandCheck: object({ allowedNow: { type: 'boolean' }, reasonCode: text }, ['reasonCode']),
  EnterpriseCustomerCreationDepartments: object({ departments: { type: 'array', items: object({ id: text, name: text }) }, allowUnassigned: { type: 'boolean' } }),
};
