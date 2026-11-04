// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...count, minimum: 1 };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)), additionalProperties: false });
const list = (items: JsonObject, minItems = 0): JsonObject => ({ type: 'array', items, minItems, maxItems: 100, uniqueItems: true });
const timestamp = { type: 'string', format: 'date-time' };
const amount = object({ tokens: positive, costMinorUnits: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' }, currency: { const: 'CNY' } });
const sources = list(object({ reference: ref('BusinessObjectRef'), fields: list(text, 1) }), 1);
const policy = { id: text, responsiblePrincipalId: text, sourceIds: list(text, 1), eventTypes: list(text, 1), sources, mode: { type: 'string', enum: ['observe', 'execute'] }, validUntil: timestamp, evaluation: amount, notification: { type: 'string', enum: ['none', 'source'] }, intervalMinutes: { type: 'integer', minimum: 1, maximum: 525600 } };
export const ENTERPRISE_OPERATING_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  EnterpriseOperatingPolicyWrite: object({ expectedStreamVersion: count, ...policy }, ['intervalMinutes']),
  EnterpriseOperatingPolicyView: object({ tenantId: text, workspaceId: text, streamVersion: positive, ...policy, status: { type: 'string', enum: ['awaiting_acceptance', 'active', 'paused', 'closed'] }, reasonCode: text }, ['intervalMinutes', 'reasonCode']),
  EnterpriseOperatingPolicyControl: object({ expectedStreamVersion: positive, command: { type: 'string', enum: ['accept', 'pause', 'close'] } }),
  EnterpriseEvaluationView: object({ id: text, tenantId: text, workspaceId: text, streamVersion: positive, batchId: text, mode: { type: 'string', enum: ['observe', 'execute'] }, status: { type: 'string', enum: ['queued', 'running', 'committed', 'completed', 'failed', 'cancelled', 'needs_reconciliation'] },
    costStatus: { type: 'string', enum: ['pending', 'known', 'unknown'] }, costNanoMinorUnits: { type: 'string', pattern: '^(0|[1-9][0-9]{0,29})$' }, reasonCode: text,
    result: object({ candidate: { type: 'boolean' }, summary: { type: 'string', minLength: 1, maxLength: 4000 }, citations: list(object({ triggerId: text })) }) }, ['costNanoMinorUnits', 'reasonCode', 'result']),
  EnterpriseOperatingBatchRef: object({ batchId: text, streamVersion: positive }),
  EnterpriseOperatingBatchControl: object({ expectedStreamVersion: positive }),
  EnterpriseOperatingBatchResult: object({ batchId: text, streamVersion: positive, status: { type: 'string', enum: ['pending', 'evaluating', 'evaluated', 'blocked', 'cancelled', 'needs_reconciliation'] } }),
  EnterpriseOperatingSubscriptionRef: object({ subscriptionId: text }),
  EnterpriseOperatingUpdates: object({ triggerIds: { type: 'array', items: text, maxItems: 10000, uniqueItems: true } }),
  EnterpriseOperatingState: object({ sources: list(object({ id: text, tenantId: text, workspaceId: text, kind: { type: 'string', enum: ['web', 'internal', 'sales', 'wecom', 'timer'] } })), policies: list(ref('EnterpriseOperatingPolicyView')), triggers: list(object({ id: text, sourceEventId: text, status: { type: 'string', enum: ['received', 'quarantined', 'loop_filtered', 'unauthorized'] } })),
    batches: list(object({ id: text, streamVersion: positive, status: { type: 'string', enum: ['pending', 'evaluating', 'evaluated', 'blocked', 'cancelled', 'needs_reconciliation'] }, triggerIds: { type: 'array', items: text, maxItems: 10000 }, reasonCode: text }, ['reasonCode'])), hasMore: { type: 'boolean' } }),
  EnterpriseOperatingRequest: object({ sources, message: { type: 'string', minLength: 1, maxLength: 12000 }, evaluation: amount, validUntil: timestamp }),
};
