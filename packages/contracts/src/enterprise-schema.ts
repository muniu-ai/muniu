// SPDX-License-Identifier: Apache-2.0
import { ENTERPRISE_PROVIDER_SCHEMAS } from './enterprise-providers-schema.js';
import { ENTERPRISE_WORKFLOW_SCHEMAS } from './enterprise-workflows-schema.js';
import { ENTERPRISE_ARTIFACT_SCHEMAS } from './enterprise-artifacts-schema.js';
import { ENTERPRISE_KNOWLEDGE_SCHEMAS } from './enterprise-knowledge-schema.js';
import { ENTERPRISE_GOAL_SCHEMAS } from './enterprise-goals-schema.js';
import { ENTERPRISE_OPERATING_SCHEMAS } from './enterprise-operating-schema.js';
import type { JsonObject } from './json.js';
import { ENTERPRISE_BUSINESS_SCHEMAS } from './enterprise-business-schema.js';
import { ENTERPRISE_OBJECT_TYPES } from './enterprise-object-types.js';
export { ENTERPRISE_OBJECT_TYPES } from './enterprise-object-types.js';
import { ENTERPRISE_EXECUTION_SCHEMAS } from './enterprise-execution-schema.js';
import { ENTERPRISE_ACCESS_SCHEMAS } from './enterprise-access-schema.js';
import { ENTERPRISE_IDENTITY_SCHEMAS } from './enterprise-identity-schema.js';
const text = { type: 'string', minLength: 1 };
const digest = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const version = { ...integer, minimum: 1 };
const timestamp = { type: 'string', format: 'date-time' };
const date = { type: 'string', format: 'date' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const list = (items: JsonObject, minItems = 0): JsonObject => ({ type: 'array', items, minItems });
const enumeration = (...values: string[]) => ({ type: 'string', enum: values });
const object = (properties: Record<string, JsonObject>, optional: string[] = []): JsonObject => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties).filter(key => !optional.includes(key)),
});
const scope = { tenantId: text, workspaceId: text };
const aggregate = { ...scope, id: text, streamVersion: version };

export const ENTERPRISE_PROVIDER_PORTS = ['readSnapshot', 'listChanges', 'prepareAction', 'executeAction', 'getReceipt'] as const;
export const ENTERPRISE_GOAL_STATES = ['draft', 'awaiting_authorization', 'running', 'waiting_person', 'waiting_external',
  'awaiting_acceptance', 'needs_reconciliation', 'completed', 'failed', 'cancelled'] as const;
const actionKind = enumeration('create_followup_task', 'update_followup_date', 'issue_quote_package');
const receiptBase = { ...scope, id: text, operationKey: text, actionDigest: digest, provider: text, receivedAt: timestamp };

/** E0 design contracts; publishing a schema does not mount a Host route or grant authority. */
export const ENTERPRISE_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  ...ENTERPRISE_IDENTITY_SCHEMAS,
  ...ENTERPRISE_BUSINESS_SCHEMAS,
  ...ENTERPRISE_ACCESS_SCHEMAS,
  ...ENTERPRISE_EXECUTION_SCHEMAS,
  ...ENTERPRISE_OPERATING_SCHEMAS,
  ...ENTERPRISE_GOAL_SCHEMAS,
  ...ENTERPRISE_KNOWLEDGE_SCHEMAS,
  ...ENTERPRISE_ARTIFACT_SCHEMAS,
  ...ENTERPRISE_WORKFLOW_SCHEMAS,
  ...ENTERPRISE_PROVIDER_SCHEMAS,
  EnterpriseGoalStatus: { type: 'string', enum: [...ENTERPRISE_GOAL_STATES] },
  BusinessObjectRef: object({ ...scope, objectType: enumeration(...ENTERPRISE_OBJECT_TYPES), objectId: text, streamVersion: version, digest }),
  ExternalObjectRef: object({ ...scope, provider: text, objectType: enumeration(...ENTERPRISE_OBJECT_TYPES), objectId: text,
    sourceVersion: text, digest, observedAt: timestamp, permissionRef: text }),
  ProviderBinding: object({ ...aggregate, mode: enumeration('builtin', 'sales'), bindings: list(object({
    objectType: enumeration(...ENTERPRISE_OBJECT_TYPES), provider: text, allowedActions: list(actionKind),
    supportedPorts: { ...list(enumeration(...ENTERPRISE_PROVIDER_PORTS)), uniqueItems: true },
  }), 1) }),
  OperatingObjective: object({ ...aggregate, periodStart: date, periodEnd: date, metricDefinition: ref('BusinessObjectRef'),
    targetValue: { type: 'number' }, responsiblePrincipalId: text, sourceRefs: list(ref('BusinessObjectRef')) }),
  OperatingPolicy: object({ ...aggregate, responsiblePrincipalId: text, authorityRevisionId: text,
    mode: enumeration('observe', 'execute'), status: enumeration('active', 'paused', 'closed'),
    sourceScopes: list(text, 1), triggerTypes: list(text, 1), objectRefs: list(ref('BusinessObjectRef')),
    validUntil: timestamp, budget: ref('EnterpriseExecutionBudget'), evaluationBudget: ref('EvaluationBudget'), notificationPolicyVersion: text }),
  SourceTrigger: object({ ...aggregate, source: enumeration('web', 'cli', 'wecom', 'business', 'sales', 'timer'), sourceInstanceId: text,
    sourceEventId: text, sourceEventType: text, deduplicationKey: text, senderPrincipalId: text,
    sourceOccurredAt: timestamp, receivedAt: timestamp, protectedPayloadRef: text,
    status: enumeration('received', 'quarantined', 'unevaluated', 'evaluated'), policyId: text }, ['senderPrincipalId', 'policyId']),
  AuthorityRevision: object({ ...scope, id: text, authorityId: text, revision: version, responsiblePrincipalId: text,
    objectRefs: list(ref('BusinessObjectRef')), capabilityIds: list(text, 1), modelBindingIds: list(text),
    allowedFields: list(text), allowedDestinations: list(text), policyVersion: text, budget: ref('EnterpriseExecutionBudget'),
    validUntil: timestamp, commitmentDigest: digest }),
  PlanRevision: object({ ...scope, id: text, goalId: text, revision: version, authorityRevisionId: text, reason: text,
    nodes: list(ref('TaskNode'), 1), inputRefs: list(ref('BusinessObjectRef')), budget: ref('EnterpriseExecutionBudget'),
    acceptanceCriteria: list(text, 1), createdAt: timestamp }),
  TaskNode: object({ id: text, dependsOn: { ...list(text), uniqueItems: true }, capabilityId: text, capabilityVersion: text,
    modelBindingId: text, inputRefs: list(ref('BusinessObjectRef')), budget: ref('EnterpriseExecutionBudget'), acceptanceCriteria: list(text, 1),
    effect: enumeration('read', 'draft', 'internal_write', 'formal_action') }, ['modelBindingId']),
  ActionIntent: object({ ...aggregate, operationKey: text, goalId: text, nodeId: text, attemptId: text, generation: integer,
    provider: text, action: actionKind, target: { oneOf: [ref('BusinessObjectRef'), ref('ExternalObjectRef')] },
    authorityRevisionId: text, providerBindingVersion: version, preparedInputRef: text, inputDigest: digest,
    businessApprovalRef: text, executionApprovalRef: text, reservationId: text, expiresAt: timestamp,
    status: enumeration('prepared', 'awaiting_approval', 'committed', 'needs_reconciliation', 'settled') }, ['businessApprovalRef', 'executionApprovalRef']),
  ActionReceipt: { oneOf: [
    object({ ...receiptBase, status: { const: 'succeeded' }, evidenceRefs: list(ref('EvidenceRef'), 1), completedAt: timestamp }),
    object({ ...receiptBase, status: enumeration('pending', 'unknown') }),
    object({ ...receiptBase, status: { const: 'not_executed' }, reasonCode: text }),
  ] },
  AttentionItem: object({ ...aggregate, kind: enumeration('approval', 'question', 'conflict', 'reconciliation'),
    subjectRef: text, subjectVersion: version, assignedPrincipalIds: list(text, 1), status: enumeration('open', 'resolved'), createdAt: timestamp }),
  EvidenceRef: object({ ...scope, id: text, sourceKind: enumeration('raw_material', 'business_fact', 'human_decision', 'candidate_experience'),
    protectedContentRef: text, sourceVersion: text, digest, permissionRef: text,
    locator: { oneOf: [object({ page: version }), object({ paragraph: text }), object({ sheet: text, cell: text })] } }),
  EnterpriseExecutionBudget: object({ maxTokens: integer, maxCostMinor: integer, currency: { const: 'CNY' }, deadline: timestamp }),
  EvaluationBudget: object({ dailyCostMinor: integer, perAttemptCostMinor: integer, maxTokensPerAttempt: integer }),
  EnterpriseMember: object({ ...aggregate, principalId: text, issuer: text, subject: text,
    status: enumeration('invited', 'active', 'disabled', 'removed'), departmentIds: list(text) }),
  ObjectGrant: object({ ...aggregate, principalId: text, objectRef: ref('BusinessObjectRef'),
    actions: list(enumeration('read', 'draft', 'write', 'business_approve', 'execution_approve', 'audit'), 1),
    readableFields: list(text), writableFields: list(text), validUntil: timestamp }),
  BusinessApproval: object({ ...aggregate, subjectRef: ref('BusinessObjectRef'), actionDigest: digest,
    preparedByPrincipalId: text, approvedByPrincipalId: text, decision: enumeration('approve', 'reject'), decidedAt: timestamp }),
  ExecutionApproval: object({ ...aggregate, authorityRevisionId: text, actionIntentId: text, actionDigest: digest,
    approvedByPrincipalId: text, decision: enumeration('approve_once', 'deny'), validUntil: timestamp }),
  EnterpriseGoal: object({ ...aggregate, responsiblePrincipalId: text, status: enumeration(...ENTERPRISE_GOAL_STATES),
    objectiveRef: ref('BusinessObjectRef'), activePlanRevisionId: text, authorityRevisionId: text, requiredArtifactIds: list(text),
    acceptanceCriteria: list(text, 1), budget: ref('EnterpriseExecutionBudget') }, ['objectiveRef', 'activePlanRevisionId', 'authorityRevisionId']),
};

export const ENTERPRISE_DEFAULT_LIMITS = Object.freeze({ parallelNodesPerGoal: 6, totalNodesPerGoal: 32, attemptsPerGoal: 64,
  automaticReplansPerGoal: 3, runningNodesPerTenant: 20, salesPollSeconds: 300, timerPollSeconds: 60, stalledProgressSeconds: 900 });

const route = (path: string, owner: string, kind: 'query' | 'business_mutation' | 'auth_protocol', versioned = false) => ({
  path, owner, kind, availability: 'planned' as const, idempotencyRequired: kind === 'business_mutation', expectedStreamVersionRequired: versioned,
});
export const ENTERPRISE_API_CATALOG = [
  route('/v2/auth/*', 'E1.1', 'auth_protocol'),
  route('/v2/organizations', 'E1.1', 'business_mutation'),
  route('/v2/workspaces', 'E1.1', 'business_mutation'),
  route('/v2/workspaces/{workspaceId}/business/{collection}', 'E2', 'business_mutation'),
  route('/v2/workspaces/{workspaceId}/business/{collection}/{objectId}/commands', 'E2', 'business_mutation', true),
  route('/v2/workspaces/{workspaceId}/objectives', 'E2', 'business_mutation'),
  route('/v2/workspaces/{workspaceId}/reviews', 'E2', 'business_mutation'),
  route('/v2/workspaces/{workspaceId}/goals', 'E4', 'business_mutation'),
  route('/v2/goals/{goalId}/plan-revisions', 'E4', 'business_mutation', true),
  route('/v2/goals/{goalId}/commands', 'E4', 'business_mutation', true),
  route('/v2/workspaces/{workspaceId}/operating-policies', 'E4', 'business_mutation'),
  route('/v2/workspaces/{workspaceId}/triggers', 'E4', 'query'),
  route('/v2/workspaces/{workspaceId}/attention', 'E4', 'query'),
  route('/v2/approvals/{approvalId}/decisions', 'E3', 'business_mutation', true),
  route('/v2/workspaces/{workspaceId}/connections', 'E5', 'business_mutation'),
  route('/v2/actions/{actionId}', 'E3', 'query'),
  route('/v2/actions/{actionId}/reconciliation', 'E3', 'business_mutation', true),
  route('/v2/workspaces/{workspaceId}/artifacts', 'E4', 'query'),
  route('/v2/workspaces/{workspaceId}/knowledge', 'E4', 'query'),
  route('/v2/events', 'E1', 'query'),
] as const;
