// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const scope = { tenantId: 'tenant-example', workspaceId: 'workspace-example' };
const aggregate = { ...scope, id: 'object-example', streamVersion: 1 };
const now = '2026-11-02T01:00:00.000Z';
const digest = 'a'.repeat(64);
const budget = { maxTokens: 10000, maxCostMinor: 1000, currency: 'CNY', deadline: '2026-11-03T01:00:00.000Z' };
const objectRef = { ...scope, objectType: 'order', objectId: 'order-example', streamVersion: 1, digest };
const externalRef = { ...scope, provider: 'sales', objectType: 'order', objectId: 'order-example', sourceVersion: 'sales-revision-7',
  digest, observedAt: now, permissionRef: 'protected-permission-example' };
const evidence = { ...scope, id: 'evidence-example', sourceKind: 'business_fact', protectedContentRef: 'protected-evidence-example',
  sourceVersion: 'sales-revision-7', digest, permissionRef: 'protected-permission-example', locator: { paragraph: 'receipt' } };
const node = { id: 'node-example', dependsOn: [], capabilityId: 'receivable-analysis', capabilityVersion: '1', modelBindingId: 'model-example',
  inputRefs: [objectRef], budget, acceptanceCriteria: ['引用订单与付款期，区分提醒与到账'], effect: 'read' };
const action = { ...aggregate, operationKey: 'operation-example', goalId: 'goal-example', nodeId: 'node-example', attemptId: 'attempt-example',
  generation: 0, provider: 'sales', action: 'create_followup_task', target: externalRef, authorityRevisionId: 'authority-revision-example',
  providerBindingVersion: 1, preparedInputRef: 'protected-input-example', inputDigest: digest, reservationId: 'reservation-example',
  expiresAt: '2026-11-03T01:00:00.000Z', status: 'prepared' };

interface ContractExample {
  readonly valid: JsonObject;
  readonly eventType: string;
  readonly ownerPackage: string;
  readonly revoked: { readonly mutation: string; readonly expectedCode: 'ACCESS_REVOKED'; readonly assertion: string };
  readonly stale: { readonly mutation: string; readonly expectedCode: 'STREAM_VERSION_CONFLICT'; readonly assertion: string };
}
function example(valid: JsonObject, eventType: string, ownerPackage: string, revokedMutation: string, staleMutation: string): ContractExample {
  return { valid, eventType, ownerPackage,
    revoked: { mutation: revokedMutation, expectedCode: 'ACCESS_REVOKED', assertion: '重新读取当前授权，拒绝后续受控读取、派发和写入；未知结果继续内部核对' },
    stale: { mutation: staleMutation, expectedCode: 'STREAM_VERSION_CONFLICT', assertion: '拒绝陈旧引用或批准，保留原事实，不静默覆盖或重新生成操作标识' } };
}
/** Executable shape examples plus acceptance specifications, not simulated authorization results. */
export const ENTERPRISE_CONTRACT_EXAMPLES: Readonly<Record<string, ContractExample>> = {
  BusinessObjectRef: example(objectRef, 'enterprise.business.object_changed', 'E1.2/E2', '撤销 order-example 的读取权限', '订单版本从 1 更新到 2'),
  ExternalObjectRef: example(externalRef, 'enterprise.provider.snapshot_observed', 'E5', 'Sales 撤销当前人员的订单权限', 'Sales 原始版本从 sales-revision-7 更新到 sales-revision-8'),
  ProviderBinding: example({ ...aggregate, mode: 'sales', bindings: [{ objectType: 'order', provider: 'sales', allowedActions: [],
    supportedPorts: ['readSnapshot', 'listChanges'] }] }, 'enterprise.provider.binding_published', 'E1.2/E5', '停用连接器授权', '提供方绑定从版本 1 更新到 2'),
  OperatingObjective: example({ ...aggregate, periodStart: '2026-11-01', periodEnd: '2026-11-30',
    metricDefinition: { ...objectRef, objectType: 'metric_definition', objectId: 'metric-example' }, targetValue: 100000,
    responsiblePrincipalId: 'person-example', sourceRefs: [objectRef] }, 'enterprise.objective.created', 'E2', '撤销目标负责人权限', '指标定义发布新版本'),
  OperatingPolicy: example({ ...aggregate, responsiblePrincipalId: 'person-example', authorityRevisionId: 'authority-revision-example',
    mode: 'observe', status: 'active', sourceScopes: ['orders-example'], triggerTypes: ['order.changed'], objectRefs: [objectRef],
    validUntil: budget.deadline, budget, evaluationBudget: { dailyCostMinor: 1000, perAttemptCostMinor: 100, maxTokensPerAttempt: 1000 },
    notificationPolicyVersion: '1' }, 'enterprise.policy.published', 'E4.1', '负责人被移除；规则暂停', '规则版本从 1 更新到 2'),
  SourceTrigger: example({ ...aggregate, source: 'sales', sourceInstanceId: 'sales-example', sourceEventId: 'source-event-example',
    sourceEventType: 'order.changed', deduplicationKey: 'tenant-example:sales-example:source-event-example:order.changed',
    sourceOccurredAt: now, receivedAt: now, protectedPayloadRef: 'protected-trigger-example', status: 'unevaluated', policyId: 'policy-example' },
    'enterprise.trigger.received', 'E4.1', '禁用关联规则负责人', '规则授权在评估后、接单前改变'),
  AuthorityRevision: example({ ...scope, id: 'authority-revision-example', authorityId: 'authority-example', revision: 1,
    responsiblePrincipalId: 'person-example', objectRefs: [objectRef], capabilityIds: ['receivable-analysis'], modelBindingIds: ['model-example'],
    allowedFields: [], allowedDestinations: [], policyVersion: '1', budget, validUntil: budget.deadline, commitmentDigest: digest },
    'enterprise.authority.revision_published', 'E3.2', '当前成员的对象权限被撤销', '当前授权版本从 1 更新到 2'),
  PlanRevision: example({ ...scope, id: 'plan-example', goalId: 'goal-example', revision: 1, authorityRevisionId: 'authority-revision-example',
    reason: '检查到期回款', nodes: [node], inputRefs: [objectRef], budget, acceptanceCriteria: ['列出可追溯的应收余额与下一步'], createdAt: now },
    'enterprise.plan.committed', 'E4.2', '计划提交前撤销负责人授权', '已准备计划使用的订单版本改变'),
  TaskNode: example(node, 'enterprise.plan.committed', 'E4.2', '就绪节点派发前撤销模型资料权限', '节点输入引用的订单版本改变'),
  ActionIntent: example(action, 'enterprise.action.committed', 'E3/E5', '动作准备后撤销人员当前业务权限', 'Sales 在动作提交事务中发现旧 sourceVersion'),
  ActionReceipt: example({ ...scope, id: 'receipt-example', operationKey: action.operationKey, actionDigest: digest, provider: 'sales', receivedAt: now,
    status: 'succeeded', evidenceRefs: [evidence], completedAt: now }, 'enterprise.action.receipt_recorded', 'E3/E5',
    '人员失权后仅允许可信服务内部核对，不返回业务内容', '迟到回执关联旧 generation，不能结算新尝试'),
  AttentionItem: example({ ...aggregate, kind: 'reconciliation', subjectRef: 'operation-example', subjectVersion: 1,
    assignedPrincipalIds: ['reviewer-example'], status: 'open', createdAt: now }, 'enterprise.action.reconciliation_required', 'E3/E4',
    '打开待办后撤销审批人权限', '旧链接引用的动作摘要或版本已改变'),
  EvidenceRef: example(evidence, 'enterprise.artifact.evidence_attached', 'E4.3', '撤回原始资料授权', '验收引用的成果版本已改变'),
};
