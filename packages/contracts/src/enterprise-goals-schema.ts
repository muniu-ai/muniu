// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' };
const longText = { type: 'string', minLength: 1, maxLength: 12000 };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...count, minimum: 1 };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({ type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)), additionalProperties: false });
const list = (items: JsonObject, minItems = 0): JsonObject => ({ type: 'array', items, minItems, uniqueItems: true });
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' }, timestamp = { type: 'string', format: 'date-time' };
const spec = { title: text, message: longText, sources: list(ref('EnterpriseSourceScope'), 1), acceptanceCriteria: list(text, 1), budget: ref('EnterpriseExecutionBudget'), capabilityIds: list(text, 1), modelBindingIds: list(text, 1) };
export const ENTERPRISE_GOAL_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  EnterpriseInitialEvaluation: object({ id: text, tokens: count, costMinorUnits: { type: 'string', pattern: '^(0|[1-9][0-9]{0,29})$' }, costNanoMinorUnits: { type: 'string', pattern: '^(0|[1-9][0-9]{0,29})$' } }),
  EnterpriseGoalAdopt: object({ evaluationId: text, ...spec }),
  EnterpriseGoalList: object({ goals: { type: 'array', items: ref('EnterpriseGoalView'), maxItems: 100 }, hasMore: { type: 'boolean' } }),
  EnterpriseWorkModelView: object({ id: text, version: positive, providerId: text, modelId: text, mode: { type: 'string', enum: ['live', 'test_fixture'] }, available: { type: 'boolean' } }),
  EnterpriseGoalConfiguration: object({ capabilities: list(object({ id: text, version: text, effect: { type: 'string', enum: ['read', 'draft', 'internal_write', 'formal_action'] }, modelRequired: { type: 'boolean' } })), models: list(ref('EnterpriseWorkModelView')) }),
  EnterpriseGoalReportView: { oneOf: ['task', 'planning', 'diagnostic'].map(kind => object({ id: text, goalId: text, kind: { const: kind }, candidate: { const: true }, createdAt: timestamp, model: ref('EnterpriseWorkModelView'), content: ref(kind === 'task' ? 'EnterpriseTaskReport' : kind === 'planning' ? 'EnterprisePlanSuggestion' : 'EnterpriseDiagnosticReport') })) },
  EnterpriseDiagnosticReport: object({ summary: { type: 'string', minLength: 1, maxLength: 4000 }, recommendation: { type: 'string', enum: ['continue_waiting', 'request_replan', 'request_review'] }, progressDigest: digest }),
  EnterprisePlanSuggestion: object({ reason: text, nodes: list(object({ id: text, dependsOn: list(text), capabilityId: text, capabilityVersion: text, modelBindingId: text, sourceIds: list({ type: 'string', pattern: '^s[0-9]+$' }), budget: ref('EnterpriseExecutionBudget'), acceptanceCriteria: list(text, 1), effect: { type: 'string', enum: ['read', 'draft', 'internal_write', 'formal_action'] } }, ['modelBindingId'])) }),
  EnterpriseGoalPlanningRequest: object({ expectedStreamVersion: positive, modelBindingId: text }, ['modelBindingId']),
  EnterpriseTaskReport: object({ status: { type: 'string', enum: ['complete', 'needs_information', 'blocked'] }, summary: { type: 'string', minLength: 1, maxLength: 4000 },
    findings: list(object({ text: { type: 'string', minLength: 1, maxLength: 4000 }, sources: list(ref('BusinessObjectRef'), 1) })),
    acceptance: list(object({ criterion: text, status: { type: 'string', enum: ['satisfied', 'missing', 'unknown'] }, sources: list(ref('BusinessObjectRef')) })), unknown: list(text), decomposition: ref('EnterprisePlanSuggestion') }, ['decomposition']),
  EnterpriseGoalSpec: object(spec),
  EnterpriseGoalRevise: object({ expectedStreamVersion: positive, ...spec }),
  EnterpriseGoalCreate: object(spec),
  EnterpriseGoalAuthorize: object({ expectedStreamVersion: positive, scopeDigest: digest }),
  EnterpriseGoalPlanWrite: object({ expectedStreamVersion: positive, reason: text, nodes: list(ref('TaskNode'), 1) }),
  EnterpriseGoalControlResult: object({ goalId: text, streamVersion: positive, status: ref('EnterpriseGoalStatus'), paused: { type: 'boolean' }, cancelRequested: { type: 'boolean' } }),
  EnterpriseGoalControl: object({ expectedStreamVersion: positive, command: { type: 'string', enum: ['pause', 'resume', 'cancel'] } }),
  EnterpriseGoalAttemptView: object({ id: text, kind: { type: 'string', enum: ['task', 'planning', 'diagnostic'] }, nodeId: text, ordinal: positive, executionId: text, planRevision: positive, status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'needs_reconciliation'] }, reasonCode: text, tokens: count, costNanoMinorUnits: { type: 'string', pattern: '^(0|[1-9][0-9]{0,29})$' }, updatedAt: timestamp }, ['reasonCode', 'tokens', 'costNanoMinorUnits']),
  EnterpriseGoalView: object({ id: text, tenantId: text, workspaceId: text, streamVersion: positive, ownerPrincipalId: text, status: ref('EnterpriseGoalStatus'), paused: { type: 'boolean' }, cancelRequested: { type: 'boolean' }, scopeDigest: digest, spec: ref('EnterpriseGoalSpec'), initialEvaluation: ref('EnterpriseInitialEvaluation'), policyOrigin: object({ id: text, version: positive }), plan: ref('PlanRevision'), attempts: list(ref('EnterpriseGoalAttemptView')), attention: object({ code: text, proposalDigest: digest }, ['proposalDigest']), authorityRevisionId: text, createdAt: timestamp, updatedAt: timestamp }, ['initialEvaluation', 'policyOrigin', 'plan', 'attention', 'authorityRevisionId']),
};
