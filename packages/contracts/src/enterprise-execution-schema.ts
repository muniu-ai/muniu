// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '^(?!\\.{1,2}$)(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...count, minimum: 1 };
const timestamp = { type: 'string', format: 'date-time' }, ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false });
const list = (items: JsonObject, minItems = 0): JsonObject => ({ type: 'array', items, minItems, maxItems: 100, uniqueItems: true });
const capability = { type: 'string', enum: ['create_followup_task', 'update_followup_date', 'issue_quote_package'] };
const responsibilities = list(object({ id: text, capabilities: list(capability), fieldClasses: list({ type: 'string', enum: ['public', 'price', 'cost', 'contact'] }, 1) }));
const scope = { tenantId: text, workspaceId: text }, version = { ...scope, streamVersion: positive };
const policyFields = { id: text, responsiblePrincipalId: text, responsibilityId: text, action: { type: 'string', enum: ['create_followup_task', 'update_followup_date'] }, target: ref('BusinessObjectRef'), maxActions: { ...positive, maximum: 10000 }, validUntil: timestamp };
export const ENTERPRISE_EXECUTION_SCHEMAS: Readonly<Record<string, JsonObject>> = {
    EnterpriseExecutionApprovalDecision: object({ expectedStreamVersion: positive, actionDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, decision: { type: 'string', enum: ['approve_once', 'deny'] } }),
    EnterpriseExecutionApprovalView: object({ ...scope, id: text, streamVersion: positive, actionId: text, actionDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, authorityRevisionId: text, status: { type: 'string', enum: ['pending', 'approved_once', 'denied', 'expired'] }, initiatedByPrincipalId: text, approvedByPrincipalId: text, origin: { type: 'string', enum: ['manual', 'policy'] }, policyId: text, policyVersion: positive, validUntil: timestamp, canDecide: { type: 'boolean' } }, ['approvedByPrincipalId', 'policyId', 'policyVersion']),
    EnterpriseActionView: object({ action: ref('ActionIntent'), executionId: text, executionStatus: { type: 'string' }, approval: ref('EnterpriseExecutionApprovalView'), receipt: ref('ActionReceipt'), cancelRequested: { type: 'boolean' }, localOutcome: { const: 'cancelled' } }, ['approval', 'receipt', 'localOutcome']),
    EnterpriseActionControl: object({ expectedStreamVersion: positive }),
    EnterpriseActionControlResult: object({ actionId: text, streamVersion: positive, status: { type: 'string', enum: ['prepared', 'awaiting_approval', 'committed', 'needs_reconciliation', 'settled'] }, cancelRequested: { type: 'boolean' }, localOutcome: { const: 'cancelled' } }, ['localOutcome']),
    EnterpriseExecutionSettingsWrite: object({ expectedStreamVersion: count, responsibilities }),
    EnterpriseExecutionSettings: object({ ...version, responsibilities }),
    EnterpriseExecutionPolicyWrite: object({ expectedStreamVersion: count, ...policyFields }),
    EnterpriseExecutionPolicyView: object({ ...version, ...policyFields, providerId: text, providerBindingVersion: positive, status: { type: 'string', enum: ['awaiting_acceptance', 'active', 'revoked'] }, acceptedAt: timestamp }, ['acceptedAt']),
    EnterpriseExecutionPolicyCommand: object({ expectedStreamVersion: positive }),
    EnterpriseExecutionConfiguration: object({ settings: ref('EnterpriseExecutionSettings'), binding: ref('ProviderBinding'), policies: list(ref('EnterpriseExecutionPolicyView')) }, ['settings', 'binding']),
};
