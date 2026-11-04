// SPDX-License-Identifier: Apache-2.0
import type { EnterpriseContractTypes } from '@mn/contracts';
import { sha256 } from '@mn/kernel';
import { EnterpriseError, type EnterpriseActor } from '@mn/enterprise-services';
import { EnterpriseGoalService, ENTERPRISE_PLAN } from './enterprise-goals.js';
import { EnterpriseKnowledgeService } from './enterprise-knowledge.js';
type Artifact = EnterpriseContractTypes['EnterpriseArtifactView'];
export const ENTERPRISE_ARTIFACT = 'enterprise-artifact.version';
export class EnterpriseArtifactService {
  readonly goals: EnterpriseGoalService; readonly knowledge: EnterpriseKnowledgeService;
  constructor(readonly options: { goals: EnterpriseGoalService; knowledge: EnterpriseKnowledgeService }) { this.goals = options.goals; this.knowledge = options.knowledge; }
  async freeze(actor: EnterpriseActor, goalId: string, attemptId: string, key: string): Promise<Artifact> {
    if (!key.trim() || key.length > 200) throw new EnterpriseError('IDEMPOTENCY_KEY_REQUIRED', 400);
    const receiptId = sha256([actor.principalId, key]), requestDigest = sha256(['freeze', goalId, attemptId]);
    await this.goals.operating.bridge.store.transact(actor.tenantId, tx => {
      const previous = tx.getProjection<{ requestDigest: string; artifactId?: string }>('enterprise-artifact.command', receiptId);
      if (previous) {
        const old = previous.artifactId && tx.getProjection<Artifact>(ENTERPRISE_ARTIFACT, previous.artifactId);
        if (old) this.goals.sourceManifest(tx, actor, old.goalId, old.attemptId);
        if (previous.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
      }
    });
    const result = await this.goals.result(actor, goalId, attemptId);
    if (result.kind !== 'task' || result.content.status !== 'complete') throw new EnterpriseError('REPORT_NOT_ACCEPTABLE', 409);
    const manifest = await this.goals.operating.bridge.store.transact(actor.tenantId, tx => this.goals.sourceManifest(tx, actor, goalId, attemptId));
    const report = result.content, parts = [report.summary], citationLabels = new Map<string, string>();
    const objectLabels: Readonly<Record<string, string>> = { customer: '客户', contact: '联系人', opportunity: '商机', service_version: '服务版本', quote_version: '报价', contract: '合同', order: '订单', project: '项目', milestone: '里程碑', delivery_version: '交付成果', customer_acceptance: '客户验收', change_request: '变更', payment_schedule: '付款计划', receipt: '收款', refund: '退款', expense: '费用', adjustment: '调整', operating_objective: '经营目标', metric_definition: '指标', business_review: '经营复盘' };
    for (const finding of report.findings) {
      parts.push(finding.text);
      if (finding.citations?.length) for (const citation of finding.citations) {
        const digest = sha256(citation);
        if (!citationLabels.has(digest)) {
          const source = await this.knowledge.cite(actor, citation), locator = citation.locator;
          const location = 'page' in locator ? '第' + locator.page + '页' : 'paragraph' in locator ? '第' + locator.paragraph + '段' : locator.sheet + '，单元格 ' + locator.cell;
          citationLabels.set(digest, source.title + '（版本 ' + citation.sourceVersion + '，' + location + '）');
        }
        parts.push('引用：' + citationLabels.get(digest)!);
      } else for (const source of finding.sources) parts.push('业务来源：' + (objectLabels[source.objectType] ?? '业务对象') + '（编号 ' + source.objectId + '，版本 ' + source.streamVersion + '）');
    }
    const judgments = { satisfied: '认为满足', missing: '缺少资料', unknown: '尚不确定' };
    parts.push(...report.acceptance.map(a => '模型自检：' + a.criterion + '（' + judgments[a.status] + '）'), ...report.unknown.map(value => '未知事项：' + value));
    const body = parts.join('\n\n');
    const material = await this.knowledge.createDerived(actor, manifest.workspaceId, 'artifact:' + sha256([goalId, attemptId]), { documentId: 'artifact:' + attemptId, title: manifest.title, text: body, bindings: manifest.bindings, objectType: 'artifact_version', sourceKind: 'candidate_experience' });
    return this.goals.operating.bridge.store.transact(actor.tenantId, tx => {
      const check = () => { this.goals.sourceManifest(tx, actor, goalId, attemptId); }; check(); tx.beforeCommit!(check);
      const goal = this.goals.require(tx, goalId), id = 'artifact:' + sha256([goalId, attemptId]), existing = tx.getProjection<Artifact>(ENTERPRISE_ARTIFACT, id);
      const prior = tx.getProjection<{ requestDigest: string }>('enterprise-artifact.command', receiptId);
      if (prior && prior.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409);
      if (!prior) this.goals.operating.record(tx, 'enterprise-artifact.command', { id: receiptId, tenantId: actor.tenantId, workspaceId: goal.workspaceId, streamVersion: 1, requestDigest, artifactId: id }, actor.principalId, 'artifact.command_recorded');
      if (existing) return existing;
      return this.goals.operating.record(tx, ENTERPRISE_ARTIFACT, { id, tenantId: actor.tenantId, workspaceId: goal.workspaceId, streamVersion: 1, goalId, attemptId, reference: material.reference, title: material.title, status: 'candidate' as const, createdAt: this.goals.operating.now() }, actor.principalId, 'artifact.candidate_frozen');
    });
  }
  async decision(actor: EnterpriseActor, id: string, key: string): Promise<EnterpriseContractTypes['EnterpriseKnowledgeView']> {
    const artifact = await this.get(actor, id);
    if (artifact.status !== 'accepted' || !artifact.decisionId) throw new EnterpriseError('ACCEPTED_ARTIFACT_REQUIRED', 409);
    const decision = await this.goals.operating.bridge.store.transact(actor.tenantId, tx => tx.getProjection<{ principalId: string; createdAt: string; criteria: readonly string[]; attestation: string }>('enterprise-artifact.decision', artifact.decisionId!));
    if (!decision) throw new EnterpriseError('ARTIFACT_DECISION_UNAVAILABLE', 410);
    return this.knowledge.createDerived(actor, artifact.workspaceId, key, { documentId: artifact.decisionId, title: '成果验收决定', text: ['验收人：' + decision.principalId, '验收时间：' + decision.createdAt, '已核对条件：' + decision.criteria.join('；'), '确认说明：' + decision.attestation, '成果内容版本：' + artifact.reference.streamVersion].join('\n\n'), bindings: [{ reference: artifact.reference, fields: ['text'] }], objectType: 'decision_record', sourceKind: 'human_decision' });
  }
  async get(actor: EnterpriseActor, id: string): Promise<Artifact> {
    const artifact = await this.goals.operating.bridge.store.transact(actor.tenantId, tx => { const value = tx.getProjection<Artifact>(ENTERPRISE_ARTIFACT, id); if (!value) throw new EnterpriseError('ARTIFACT_NOT_FOUND', 404); this.goals.sourceManifest(tx, actor, value.goalId, value.attemptId); return value; });
    await this.knowledge.get(actor, artifact.reference); return artifact;
  }
  async accept(actor: EnterpriseActor, id: string, expected: number, expectedGoalVersion: number, criteria: readonly string[], attestation: string, key: string): Promise<Artifact> {
    const artifact = await this.get(actor, id);
    if (!attestation.trim() || attestation.length > 2000 || !key.trim() || key.length > 200) throw new EnterpriseError('INVALID_BODY', 400);
    return this.goals.operating.bridge.store.transact(actor.tenantId, tx => {
      const current = tx.getProjection<Artifact>(ENTERPRISE_ARTIFACT, id)!, goal = this.goals.require(tx, artifact.goalId);
      const check = () => { this.goals.sourceManifest(tx, actor, goal.id, artifact.attemptId); this.goals.operating.sources(tx, actor, goal.workspaceId, [{ reference: current.reference, fields: ['text'] }]); };
      check(); tx.beforeCommit!(check);
      const receiptId = sha256([actor.principalId, key]), requestDigest = sha256([id, expected, expectedGoalVersion, criteria, attestation]), prior = tx.getProjection<{ requestDigest: string }>('enterprise-artifact.command', receiptId);
      if (prior) { if (prior.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return current; }
      if (current.streamVersion !== expected || goal.streamVersion !== expectedGoalVersion) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
      if (goal.status !== 'awaiting_acceptance' || this.goals.attempts(tx, goal.id).some(a => ['queued', 'running', 'needs_reconciliation'].includes(a.status))) throw new EnterpriseError('GOAL_NOT_READY_FOR_ACCEPTANCE', 409);
      if (sha256([...criteria].sort()) !== sha256([...goal.spec.acceptanceCriteria].sort())) throw new EnterpriseError('ACCEPTANCE_CRITERIA_REQUIRED', 409);
      const plan = tx.getProjection<{ nodes: readonly { id: string; dependsOn: readonly string[] }[] }>(ENTERPRISE_PLAN, goal.planId!)!, attempt = this.goals.attempts(tx, goal.id).find(a => a.id === artifact.attemptId)!;
      const terminals = plan.nodes.filter(n => !plan.nodes.some(other => other.dependsOn.includes(n.id)));
      if (!terminals.some(n => n.id === attempt.node.id) || attempt.scopeId !== goal.scopeId) throw new EnterpriseError('ARTIFACT_NOT_FINAL_RESULT', 409);
      const decisionId = 'decision:' + sha256([id, key]);
      this.goals.operating.record(tx, 'enterprise-artifact.decision', { id: decisionId, tenantId: actor.tenantId, workspaceId: goal.workspaceId, streamVersion: 1, artifactId: id, artifactReference: artifact.reference, goalId: goal.id, goalVersion: goal.streamVersion, principalId: actor.principalId, criteria, attestation, createdAt: this.goals.operating.now() }, actor.principalId, 'artifact.acceptance_recorded');
      const accepted = this.goals.operating.record(tx, ENTERPRISE_ARTIFACT, { ...current, streamVersion: current.streamVersion + 1, status: 'accepted' as const, decisionId }, actor.principalId, 'artifact.accepted');
      const acceptedArtifacts = tx.listProjections<Artifact>(ENTERPRISE_ARTIFACT).filter(a => a.goalId === goal.id && a.status === 'accepted');
      for (const value of acceptedArtifacts) { this.goals.sourceManifest(tx, actor, goal.id, value.attemptId); this.knowledge.requireReadable(tx, actor, value.reference); }
      const acceptedAttempts = new Set(acceptedArtifacts.map(a => a.attemptId));
      if (terminals.every(n => this.goals.attempts(tx, goal.id).some(a => a.scopeId === goal.scopeId && a.node.id === n.id && a.status === 'completed' && acceptedAttempts.has(a.id)))) this.goals.record(tx, goal, { status: 'completed' }, 'work.goal_accepted');
      this.goals.operating.record(tx, 'enterprise-artifact.command', { id: receiptId, tenantId: actor.tenantId, workspaceId: goal.workspaceId, streamVersion: 1, requestDigest }, actor.principalId, 'artifact.command_recorded');
      return accepted;
    });
  }
}
