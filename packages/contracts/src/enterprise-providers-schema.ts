// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' };
const timestamp = { type: 'string', format: 'date-time' }, version = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)), additionalProperties: false });
const reference = { oneOf: [ref('BusinessObjectRef'), ref('ExternalObjectRef')] };
const base = { tenantId: text, workspaceId: text, operationKey: text, providerBindingVersion: version, target: reference, expiresAt: timestamp };
const actions = (shared: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ oneOf: [
  object({ ...shared, action: { const: 'create_followup_task' }, input: object({ title: text, dueAt: timestamp, description: { type: 'string', maxLength: 2000 } }, ['description']) }, optional),
  object({ ...shared, action: { const: 'update_followup_date' }, input: object({ nextFollowupAt: timestamp }) }, optional),
  object({ ...shared, action: { const: 'issue_quote_package' }, businessApprovalRef: text, input: object({ format: { type: 'string', enum: ['docx', 'pdf', 'xlsx'] } }) }, optional),
] });
export const ENTERPRISE_PROVIDER_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  EnterpriseProviderObjectReference: reference,
  EnterpriseProviderChangesQuery: object({ cursor: { oneOf: [{ type: 'string', minLength: 1, maxLength: 4096 }, { type: 'null' }] } }),
  EnterpriseProviderContentQuery: object({ reference: text }),
  EnterpriseProviderInitialization: object({ expectedStreamVersion: { ...version, minimum: 0 } }),
  EnterpriseProviderActionCreate: actions({ target: reference, responsibilityId: text, expiresAt: timestamp, policyId: text }, ['policyId']),
  EnterpriseProviderActionPreparation: actions(base),
  EnterpriseProviderQuoteFile: object({ protectedContentRef: text, digest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, mediaType: { type: 'string', enum: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] } }),
  EnterpriseProviderReceiptEvidence: object({ receipt: ref('ActionReceipt'), target: reference, result: reference }, ['result']),
  EnterpriseProviderActionPreview: object({ request: ref('EnterpriseProviderActionPreparation'), inputDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, document: ref('EnterpriseProviderQuoteFile') }, ['document']),
  EnterpriseProviderPackageContent: object({ reference: text, source: reference, mediaType: text, digest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, bytesBase64: { type: 'string', minLength: 1 }, official: { type: 'boolean' } }),
  EnterpriseProviderPreparedAction: object({ preparedInputRef: text, inputDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, target: reference, expiresAt: timestamp }),
  EnterpriseProviderSnapshot: object({ objectRef: reference, protectedContentRef: text, observedAt: timestamp }),
  EnterpriseProviderChanges: object({ changes: { type: 'array', maxItems: 500, items: object({ sourceEventId: text, sourceEventType: text, sourceOccurredAt: timestamp, snapshot: ref('EnterpriseProviderSnapshot'), origin: { type: 'string', enum: ['external', 'muniu'] }, causedByOperationKey: text, causedByGoalId: text }, ['origin', 'causedByOperationKey', 'causedByGoalId']) }, nextCursor: { type: 'string', minLength: 1, maxLength: 4096 } }),
};
