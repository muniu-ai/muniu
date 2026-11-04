// SPDX-License-Identifier: Apache-2.0
import { checkedEnterpriseModel } from './enterprise-models.js';
import { randomBytes } from 'node:crypto';
import { resolveEnterpriseWorkflow } from './enterprise-workflows.js';
import { parseEnterpriseContract, type BudgetAccountV1, type BudgetReservationV1, type Job, type Approval, type EnterpriseContractTypes, type Execution, type ExecutionAuthority, type PlanRevision, type TaskNode } from '@mn/contracts';
import { AgentOsKernel, appendKernelEvent, releaseBudget, assertAuthorityAttenuation, computeExecutionAuthorityCommitment, amendBudgetAccount, createBudgetAccount, reserveBudget, sha256, type KernelJobLeaseAssertion, type KernelTransaction } from '@mn/kernel';
import { EnterpriseError, assertModelQuota, type EnterpriseActor } from '@mn/enterprise-services';
import { EnterprisePlanError, validateEnterprisePlan, readyEnterpriseNodes, type EnterpriseNodeAttempt, type EnterprisePlanContext } from '@mn/task-orchestration';
import { EnterpriseOperatingService } from './enterprise-operating.js';
import { executionBusinessObject, executionPermissionDigest, executionRelationDigest } from './enterprise-execution-config.js';
import { enterpriseBudgetPrincipal, ENTERPRISE_AGENT_PREFIX } from './enterprise-kernel-bridge.js';
import { OPERATING, type OperatingBatch, type OperatingPolicy, type OperatingSubscription, type OperatingTrigger } from './enterprise-operating.js';
import type { EvaluationAttempt, EvaluationModel } from './enterprise-evaluation.js';
export const ENTERPRISE_GOAL = 'enterprise-work.goal', ENTERPRISE_GOAL_SCOPE = 'enterprise-work.scope', ENTERPRISE_PLAN = 'enterprise-work.plan', ENTERPRISE_ATTEMPT = 'enterprise-work.attempt';
type Spec = EnterpriseContractTypes['EnterpriseGoalSpec'];
type View = EnterpriseContractTypes['EnterpriseGoalView'];
export interface EnterpriseGoalRecord {
  readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly streamVersion: number;
  readonly policyOrigin?: { readonly id: string; readonly version: number }; readonly initialEvaluation?: EnterpriseContractTypes['EnterpriseInitialEvaluation']; readonly owner: EnterpriseActor; readonly spec: Spec; readonly scopeDigest: string; readonly salt: string; readonly models: readonly EvaluationModel[];
  readonly status: View['status']; readonly paused: boolean; readonly createdAt: string; readonly updatedAt: string;
  readonly authorityRevisionId?: string; readonly scopeId?: string; readonly accountId?: string; readonly workspaceAccountId?: string;
  readonly replannedSources?: readonly string[]; readonly diagnosticExecutions?: readonly string[]; readonly planningAttemptId?: string; readonly planId?: string; readonly planRevision: number; readonly automaticReplans: number;
  readonly attention?: View['attention']; readonly cancelRequested?: boolean;
}
interface GoalScope { readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly streamVersion: number; readonly goalId: string; readonly authorityId: string; readonly commitment: string; readonly template: { readonly policyOrigin?: { readonly id: string; readonly version: number }; readonly initialEvaluation?: EnterpriseContractTypes['EnterpriseInitialEvaluation']; readonly owner: EnterpriseActor; readonly spec: Spec; readonly models: readonly EvaluationModel[]; readonly salt: string; readonly permissionDigest: string; readonly relations: readonly string[] }; readonly digest: string; }
export interface EnterpriseTaskAttempt extends EnterpriseNodeAttempt {
  readonly kind: 'task' | 'planning' | 'diagnostic'; readonly diagnosticFor?: string; readonly progressDigest?: string;
  readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly streamVersion: number; readonly goalId: string;
  readonly jobId: string; readonly ordinal: number; readonly planRevision: number; readonly authorityId: string; readonly commitment: string;
  readonly scopeId: string; readonly templateDigest: string; readonly reservationId: string; readonly model: EvaluationModel;
  readonly createdAt: string; readonly updatedAt: string; readonly reasonCode?: string; readonly tokens?: number; readonly costNanoMinorUnits?: string;
}
export interface EnterpriseCapability { readonly id: string; readonly version: string; readonly effect: TaskNode['effect']; readonly modelRequired: boolean; readonly instructions: string; }
export const ENTERPRISE_READ_CAPABILITIES: readonly EnterpriseCapability[] = [
  { id: 'business.analyze', version: '1', effect: 'read', modelRequired: true, instructions: '分析给定获准事实，区分事实、建议和未知事项，明确引用来源。' },
  { id: 'business.review', version: '1', effect: 'read', modelRequired: true, instructions: '独立复核给定候选、引用和验收条件，指出缺口。你的判断不构成人员业务批准。' },
  { id: 'business.summarize', version: '1', effect: 'draft', modelRequired: true, instructions: '按给定验收条件汇总结果与来源，保留失败、未知事项和人员决定。' },
];
const nodeNamespace = (goalId: string) => 'enterprise-work.task.' + goalId;
const amount = (budget: Spec['budget']) => ({ tokens: budget.maxTokens, costMinorUnits: String(budget.maxCostMinor), currency: 'CNY' });
export class EnterpriseGoalService {
  readonly operating: EnterpriseOperatingService; readonly kernel: AgentOsKernel; readonly capabilities: readonly EnterpriseCapability[];
  constructor(readonly options: { operating: EnterpriseOperatingService; modelsFor: (tenantId: string, workspaceId: string) => readonly EvaluationModel[]; capabilities?: readonly EnterpriseCapability[] }) {
    this.operating = options.operating; this.kernel = new AgentOsKernel(this.operating.bridge.store, { now: this.operating.now });
    this.capabilities = options.capabilities ?? ENTERPRISE_READ_CAPABILITIES;
  }
  private now(): string { return this.operating.now(); }
  require(tx: KernelTransaction, id: string): EnterpriseGoalRecord { const goal = tx.getProjection<EnterpriseGoalRecord>(ENTERPRISE_GOAL, id); if (!goal) throw new EnterpriseError('GOAL_NOT_FOUND', 404); return goal; }
  attempts(tx: KernelTransaction, goalId: string): readonly EnterpriseTaskAttempt[] { return tx.listProjections<EnterpriseTaskAttempt>(ENTERPRISE_ATTEMPT).filter(a => a.goalId === goalId).sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id)); }
  private read(tx: KernelTransaction, goal: EnterpriseGoalRecord, actor: EnterpriseActor): void {
    if (actor.principalId !== goal.owner.principalId || actor.tenantId !== goal.tenantId) throw new EnterpriseError('GOAL_NOT_FOUND', 404);
    this.operating.sources(tx, actor, goal.workspaceId, goal.spec.sources);
  }
  private guard(tx: KernelTransaction, check: () => void): void { check(); tx.beforeCommit!(() => { check(); }); }
  record(tx: KernelTransaction, goal: EnterpriseGoalRecord, changes: Partial<EnterpriseGoalRecord>, type: string, actorId = goal.owner.principalId): EnterpriseGoalRecord {
    const value = Object.fromEntries(Object.entries({ ...goal, ...changes, streamVersion: goal.streamVersion + 1, updatedAt: this.now() }).filter(([, value]) => value !== undefined)) as unknown as EnterpriseGoalRecord;
    return this.operating.record(tx, ENTERPRISE_GOAL, value, actorId, type);
  }
  private view(tx: KernelTransaction, goal: EnterpriseGoalRecord): View {
    const stored = goal.planId ? tx.getProjection<PlanRevision & { streamVersion: number }>(ENTERPRISE_PLAN, goal.planId) : undefined;
    const plan = stored ? (({ streamVersion: _version, ...value }) => value)(stored) : undefined;
    return { id: goal.id, tenantId: goal.tenantId, workspaceId: goal.workspaceId, streamVersion: goal.streamVersion, ownerPrincipalId: goal.owner.principalId, spec: goal.spec, status: goal.status, paused: goal.paused, cancelRequested: !!goal.cancelRequested, scopeDigest: goal.scopeDigest,
      ...(goal.initialEvaluation ? { initialEvaluation: goal.initialEvaluation } : {}), ...(goal.policyOrigin ? { policyOrigin: goal.policyOrigin } : {}), createdAt: goal.createdAt, updatedAt: goal.updatedAt, ...(goal.authorityRevisionId ? { authorityRevisionId: goal.authorityRevisionId } : {}), ...(goal.attention ? { attention: goal.attention } : {}), ...(plan ? { plan } : {}),
      attempts: this.attempts(tx, goal.id).map(a => ({ id: a.id, kind: a.kind, nodeId: this.attemptReadable(tx, a, goal.owner) ? a.node.id : 'restricted', ordinal: a.ordinal, executionId: a.executionId, planRevision: a.planRevision, status: a.status, updatedAt: a.updatedAt,
        ...(a.reasonCode ? { reasonCode: a.reasonCode } : {}), ...(a.tokens === undefined ? {} : { tokens: a.tokens }), ...(a.costNanoMinorUnits === undefined ? {} : { costNanoMinorUnits: a.costNanoMinorUnits }) })) };
  }
  attemptReadable(tx: KernelTransaction, attempt: EnterpriseTaskAttempt, actor: EnterpriseActor): boolean {
    const scope = tx.getProjection<GoalScope>(ENTERPRISE_GOAL_SCOPE, attempt.scopeId);
    if (!scope) return false;
    try { this.operating.sources(tx, actor, attempt.workspaceId, scope.template.spec.sources); return true; } catch { return false; }
  }
  async get(actor: EnterpriseActor, id: string): Promise<View> { return this.operating.bridge.store.transact(actor.tenantId, tx => { const goal = this.require(tx, id); this.guard(tx, () => this.read(tx, goal, actor)); return this.view(tx, goal); }); }
  async list(actor: EnterpriseActor, workspaceId: string): Promise<EnterpriseContractTypes['EnterpriseGoalList']> {
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      this.guard(tx, () => { this.operating.actor(tx, actor, workspaceId); });
      const goals = tx.listProjections<EnterpriseGoalRecord>(ENTERPRISE_GOAL).filter(g => g.workspaceId === workspaceId && g.owner.principalId === actor.principalId).filter(g => { try { this.read(tx, g, actor); return true; } catch { return false; } });
      const page = goals.slice(-100); this.guard(tx, () => { for (const goal of page) this.read(tx, goal, actor); });
      return { goals: page.map(g => this.view(tx, g)), hasMore: goals.length > 100 };
    });
  }
  async configuration(actor: EnterpriseActor, workspaceId: string): Promise<EnterpriseContractTypes['EnterpriseGoalConfiguration']> {
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      this.guard(tx, () => { this.operating.actor(tx, actor, workspaceId); });
      return { capabilities: this.capabilities.map(({ instructions: _instructions, ...view }) => view), models: this.options.modelsFor(actor.tenantId, workspaceId).map(model => this.modelView(model)) };
    });
  }
  private modelView(model: EvaluationModel): EnterpriseContractTypes['EnterpriseWorkModelView'] {
    let available = false; try { checkedEnterpriseModel(model); available = true; } catch { /* Unmetered models cannot be selected. */ }
    const { secretRef: _secret, ...view } = model; return { ...view, available };
  }
  sourceManifest(tx: KernelTransaction, actor: EnterpriseActor, goalId: string, attemptId: string): { title: string; workspaceId: string; bindings: Spec['sources'] } {
    const goal = this.require(tx, goalId), attempt = tx.getProjection<EnterpriseTaskAttempt>(ENTERPRISE_ATTEMPT, attemptId);
    if (!attempt || attempt.goalId !== goalId || goal.owner.principalId !== actor.principalId || attempt.status !== 'completed' || attempt.kind !== 'task') throw new EnterpriseError('REPORT_NOT_ACCEPTABLE', 409);
    const scope = tx.getProjection<GoalScope>(ENTERPRISE_GOAL_SCOPE, attempt.scopeId);
    if (!scope || !this.attemptReadable(tx, attempt, actor)) throw new EnterpriseError('OBJECT_ACCESS_DENIED');
    return { title: scope.template.spec.title, workspaceId: goal.workspaceId, bindings: scope.template.spec.sources.map(source => ({ ...source, reference: attempt.node.inputRefs.find(ref => ref.objectType === source.reference.objectType && ref.objectId === source.reference.objectId) ?? source.reference })) };
  }
  async result(actor: EnterpriseActor, goalId: string, attemptId: string): Promise<EnterpriseContractTypes['EnterpriseGoalReportView']> {
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      const goal = this.require(tx, goalId), attempt = tx.getProjection<EnterpriseTaskAttempt>(ENTERPRISE_ATTEMPT, attemptId), result = tx.getProjection<{ createdAt: string; report?: unknown; suggestion?: unknown; diagnostic?: unknown }>('enterprise-work.result', attemptId);
      if (!attempt || attempt.goalId !== goalId || !result || goal.owner.principalId !== actor.principalId) throw new EnterpriseError('REPORT_NOT_FOUND', 404);
      this.guard(tx, () => { this.operating.actor(tx, actor, goal.workspaceId); if (!this.attemptReadable(tx, attempt, actor)) throw new EnterpriseError('FIELD_ACCESS_DENIED'); });
      return parseEnterpriseContract('EnterpriseGoalReportView', { id: attempt.id, goalId, kind: attempt.kind, candidate: true, createdAt: result.createdAt, model: this.modelView(attempt.model), content: attempt.kind === 'task' ? result.report : attempt.kind === 'planning' ? result.suggestion : result.diagnostic });
    });
  }
  private change(tx: KernelTransaction, actor: EnterpriseActor, workspaceId: string, key: string, request: unknown, work: () => EnterpriseGoalRecord, readReplay = true): View {
    if (typeof key !== 'string' || !key.trim() || key.length > 200) throw new EnterpriseError('IDEMPOTENCY_KEY_REQUIRED', 400);
    const id = sha256([actor.principalId, workspaceId, key]), digest = sha256(request), previous = tx.getProjection<{ goalId: string; digest: string }>('enterprise-work.command', id);
    if (previous) { if (previous.digest !== digest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); const goal = this.require(tx, previous.goalId); if (readReplay) this.guard(tx, () => this.read(tx, goal, actor)); return this.view(tx, goal); }
    const goal = work(); this.operating.record(tx, 'enterprise-work.command', { id, tenantId: actor.tenantId, workspaceId, streamVersion: 1, goalId: goal.id, digest }, actor.principalId, 'work.command_recorded');
    return this.view(tx, goal);
  }
  async create(actor: EnterpriseActor, workspaceId: string, key: string, raw: EnterpriseContractTypes['EnterpriseGoalCreate']): Promise<View> {
    const spec = parseEnterpriseContract('EnterpriseGoalCreate', raw), salt = randomBytes(32).toString('hex');
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      this.guard(tx, () => { this.operating.sources(tx, actor, workspaceId, spec.sources); });
      return this.change(tx, actor, workspaceId, key, ['create', spec], () => {
        return this.createRecord(tx, actor, workspaceId, key, spec, salt);
      });
    });
  }
  async adopt(actor: EnterpriseActor, evaluationId: string, key: string, raw: Spec): Promise<View> {
    const spec = parseEnterpriseContract('EnterpriseGoalSpec', raw), salt = randomBytes(32).toString('hex');
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      const evaluation = tx.getProjection<EvaluationAttempt>('operating.evaluation', evaluationId);
      if (!evaluation || evaluation.status !== 'completed' || !evaluation.result?.candidate) throw new EnterpriseError('EVALUATION_NOT_ACCEPTABLE', 409);
      const batch = tx.getProjection<OperatingBatch>(OPERATING.batch, evaluation.batchId)!;
      if (batch.owner.principalId !== actor.principalId) throw new EnterpriseError('EVALUATION_NOT_FOUND', 404);
      this.guard(tx, () => { this.operating.sources(tx, actor, batch.workspaceId, evaluation.template.sources); this.operating.sources(tx, actor, batch.workspaceId, spec.sources); });
      return this.change(tx, actor, batch.workspaceId, key, ['adopt', evaluationId, spec], () => {
        if (evaluation.goalId) { const existing = this.require(tx, evaluation.goalId); if (sha256(existing.spec) !== sha256(spec)) throw new EnterpriseError('EVALUATION_ALREADY_ADOPTED', 409); return existing; }
        this.guard(tx, () => { this.operating.sources(tx, actor, batch.workspaceId, evaluation.template.sources, true); });
        const reservation = tx.getProjection<BudgetReservationV1>('budget.reservation', evaluation.reservationId);
        if (reservation?.status !== 'settled' || !reservation.usage || evaluation.costNanoMinorUnits === undefined) throw new EnterpriseError('EVALUATION_ACCOUNTING_REQUIRED', 409);
        const initialEvaluation = { id: evaluation.id, tokens: reservation.usage.tokens, costMinorUnits: reservation.usage.costMinorUnits, costNanoMinorUnits: evaluation.costNanoMinorUnits };
        if (spec.budget.maxTokens <= initialEvaluation.tokens || BigInt(spec.budget.maxCostMinor) <= BigInt(initialEvaluation.costMinorUnits)) throw new EnterpriseError('GOAL_BUDGET_EXCEEDED', 409);
        const goal = this.createRecord(tx, actor, batch.workspaceId, 'evaluation:' + evaluation.id, spec, salt, initialEvaluation);
        this.operating.record(tx, 'operating.evaluation', { ...evaluation, goalId: goal.id, streamVersion: evaluation.streamVersion + 1 }, actor.principalId, 'operating.evaluation_adopted');
        return goal;
      });
    });
  }
  private createRecord(tx: KernelTransaction, actor: EnterpriseActor, workspaceId: string, key: string, spec: Spec, salt: string, initialEvaluation?: EnterpriseContractTypes['EnterpriseInitialEvaluation']): EnterpriseGoalRecord {
        this.guard(tx, () => { this.operating.sources(tx, actor, workspaceId, spec.sources, true); resolveEnterpriseWorkflow(tx, workspaceId, spec, true); if (Date.parse(spec.budget.deadline) <= Date.parse(this.now())) throw new EnterpriseError('GOAL_EXPIRED', 409); });
        if (spec.capabilityIds.some(id => !this.capabilities.some(c => c.id === id))) throw new EnterpriseError('CAPABILITY_UNAVAILABLE', 409);
        const models = structuredClone(this.options.modelsFor(actor.tenantId, workspaceId).filter(m => spec.modelBindingIds.includes(m.id)));
        const owner = { tenantId: actor.tenantId, principalId: actor.principalId, sessionEpoch: actor.sessionEpoch }, id = 'goal:' + sha256([actor.tenantId, actor.principalId, workspaceId, key]);
        const goal: EnterpriseGoalRecord = { ...(initialEvaluation ? { initialEvaluation } : {}), id, tenantId: actor.tenantId, workspaceId, streamVersion: 1, owner, spec, salt, models, scopeDigest: sha256({ spec, models, salt, owner: owner.principalId, initialEvaluation: initialEvaluation ?? null }), status: 'awaiting_authorization', paused: false, planRevision: 0, automaticReplans: 0, createdAt: this.now(), updatedAt: this.now() };
        return this.operating.record(tx, ENTERPRISE_GOAL, goal, actor.principalId, 'work.goal_created');
  }
  private quota(tx: KernelTransaction, goal: EnterpriseGoalRecord) {
    return assertModelQuota(this.operating.bridge.snapshot(tx).records, goal.owner, goal.workspaceId, { tokens: goal.spec.budget.maxTokens, costMinorUnits: String(goal.spec.budget.maxCostMinor), expiresAt: goal.spec.budget.deadline, purpose: 'goal' }, this.now());
  }
  assertCurrent(tx: KernelTransaction, goal: EnterpriseGoalRecord, allowPaused = false): GoalScope {
    if (!goal.authorityRevisionId || !goal.scopeId) throw new EnterpriseError('GOAL_AUTHORIZATION_REQUIRED', 409);
    if (!(goal.status === 'running' || (allowPaused && ['awaiting_authorization', 'waiting_person', 'waiting_external', 'awaiting_acceptance'].includes(goal.status))) || (!allowPaused && goal.paused) || goal.cancelRequested) throw new EnterpriseError('GOAL_INACTIVE', 409);
    const scope = tx.getProjection<GoalScope>(ENTERPRISE_GOAL_SCOPE, goal.scopeId), authority = tx.getProjection<ExecutionAuthority>('authority', goal.authorityRevisionId);
    if (!scope || scope.goalId !== goal.id || scope.tenantId !== goal.tenantId || scope.workspaceId !== goal.workspaceId || scope.authorityId !== goal.authorityRevisionId || sha256(goal.spec) !== sha256(scope.template.spec) || sha256(goal.models) !== sha256(scope.template.models) || sha256(goal.owner) !== sha256(scope.template.owner) || sha256(goal.initialEvaluation ?? null) !== sha256(scope.template.initialEvaluation ?? null) || sha256(goal.policyOrigin ?? null) !== sha256(scope.template.policyOrigin ?? null) || !authority || authority.commitment !== scope.commitment || computeExecutionAuthorityCommitment(authority) !== scope.commitment || sha256(scope.template) !== scope.digest
      || !authority.dataScopes.some(r => r.namespace === ENTERPRISE_GOAL_SCOPE && r.resourceId === scope.id && r.digest === scope.digest)) throw new EnterpriseError('GOAL_AUTHORITY_INVALID', 503);
    this.operating.sources(tx, scope.template.owner, goal.workspaceId, scope.template.spec.sources);
    const records = this.operating.bridge.snapshot(tx).records;
    if (scope.template.permissionDigest !== executionPermissionDigest(records, goal.owner.principalId, goal.workspaceId)
      || scope.template.spec.sources.some((s, i) => this.operating.sourceRelation(tx, s.reference, scope.template.salt) !== scope.template.relations[i])) throw new EnterpriseError('GOAL_AUTHORIZATION_CHANGED', 409);
    this.quota(tx, goal); return scope;
  }
  async revise(actor: EnterpriseActor, id: string, expected: number, key: string, raw: Spec): Promise<View> {
    const spec = parseEnterpriseContract('EnterpriseGoalSpec', raw), salt = randomBytes(32).toString('hex');
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      const goal = this.require(tx, id);
      if (goal.owner.principalId !== actor.principalId) throw new EnterpriseError('GOAL_NOT_FOUND', 404);
      this.guard(tx, () => { this.operating.actor(tx, actor, goal.workspaceId); this.operating.sources(tx, actor, goal.workspaceId, spec.sources, true); resolveEnterpriseWorkflow(tx, goal.workspaceId, spec, true); });
      return this.change(tx, actor, goal.workspaceId, key, ['revise', id, expected, spec], () => {
        if (goal.streamVersion !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
        const attempts = this.attempts(tx, id);
        if (attempts.some(a => a.status === 'needs_reconciliation')) throw new EnterpriseError('GOAL_RECONCILIATION_REQUIRED', 409);
        if (attempts.some(a => a.status === 'running')) throw new EnterpriseError('GOAL_EXECUTIONS_RUNNING', 409);
        if (['completed', 'cancelled'].includes(goal.status)) throw new EnterpriseError('GOAL_FINISHED', 409);
        if (spec.capabilityIds.some(id => !this.capabilities.some(c => c.id === id))) throw new EnterpriseError('CAPABILITY_UNAVAILABLE', 409);
        for (const attempt of attempts) if (attempt.status === 'queued') this.cancelQueued(tx, goal, attempt, 'GOAL_SCOPE_REVISED');
        const models = structuredClone(this.options.modelsFor(actor.tenantId, goal.workspaceId).filter(m => spec.modelBindingIds.includes(m.id)));
        return this.record(tx, goal, { spec, models, salt, scopeDigest: sha256({ spec, models, salt, owner: actor.principalId, initialEvaluation: goal.initialEvaluation ?? null }), status: 'awaiting_authorization', authorityRevisionId: undefined, scopeId: undefined, planId: undefined, planningAttemptId: undefined, policyOrigin: undefined, attention: undefined, paused: false }, 'work.scope_revised');
      }, false);
    });
  }
  async authorize(actor: EnterpriseActor, id: string, expected: number, digest: string, key: string): Promise<View> {
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      const goal = this.require(tx, id); this.guard(tx, () => this.read(tx, goal, actor));
      return this.change(tx, actor, goal.workspaceId, key, ['authorize', id, expected, digest], () => {
        if (goal.streamVersion !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
        return this.authorizeRecord(tx, goal, actor, digest);
      });
    });
  }
  private authorizeRecord(tx: KernelTransaction, goal: EnterpriseGoalRecord, actor: EnterpriseActor, digest: string): EnterpriseGoalRecord {
        if (goal.scopeDigest !== digest) throw new EnterpriseError('GOAL_SCOPE_CONFLICT', 409);
        if (goal.status !== 'awaiting_authorization' || goal.authorityRevisionId) throw new EnterpriseError('GOAL_ALREADY_AUTHORIZED', 409);
        const owner = { tenantId: actor.tenantId, principalId: actor.principalId, sessionEpoch: actor.sessionEpoch };
        const check = () => { resolveEnterpriseWorkflow(tx, goal.workspaceId, goal.spec, true); this.operating.sources(tx, actor, goal.workspaceId, goal.spec.sources, true); this.quota(tx, { ...goal, owner }); const current = this.options.modelsFor(actor.tenantId, goal.workspaceId);
          goal.models.forEach(checkedEnterpriseModel);
          if (goal.models.length !== goal.spec.modelBindingIds.length || goal.models.some(m => !current.some(n => sha256(n) === sha256(m)))) throw new EnterpriseError('MODEL_BINDING_CHANGED', 409); };
        this.guard(tx, check);
        const records = this.operating.bridge.snapshot(tx).records, template = { ...(goal.policyOrigin ? { policyOrigin: goal.policyOrigin } : {}), ...(goal.initialEvaluation ? { initialEvaluation: goal.initialEvaluation } : {}), owner, spec: goal.spec, models: goal.models, salt: goal.salt, permissionDigest: executionPermissionDigest(records, actor.principalId, goal.workspaceId), relations: goal.spec.sources.map(s => this.operating.sourceRelation(tx, s.reference, goal.salt)) };
        const scopeId = 'goal-scope:' + sha256([goal.id, goal.streamVersion]), scopeDigest = sha256(template);
        const context = { tenantId: actor.tenantId, workspaceId: goal.workspaceId, occurredAt: this.now() };
        const root = createBudgetAccount(tx, { ...context, principalId: enterpriseBudgetPrincipal(goal.workspaceId), scope: { namespace: 'enterprise.workspace_budget', resourceId: goal.workspaceId }, limit: { tokens: Number.MAX_SAFE_INTEGER, costMinorUnits: '9'.repeat(30), currency: 'CNY' }, expiresAt: '9999-12-31T23:59:59.999Z' });
        const net = { tokens: goal.spec.budget.maxTokens - (goal.initialEvaluation?.tokens ?? 0), costMinorUnits: (BigInt(goal.spec.budget.maxCostMinor) - BigInt(goal.initialEvaluation?.costMinorUnits ?? '0')).toString(), currency: 'CNY' };
        if (net.tokens < 1 || BigInt(net.costMinorUnits) < 1n) throw new EnterpriseError('GOAL_BUDGET_EXCEEDED', 409);
        const existing = goal.accountId ? tx.getProjection<BudgetAccountV1>('budget.account', goal.accountId) : undefined;
        if (goal.accountId && (!existing || existing.scope.namespace !== 'goal' || existing.scope.resourceId !== goal.id || existing.parentAccountId !== root.id)) throw new EnterpriseError('GOAL_AUTHORITY_INVALID', 503);
        const account = existing ? amendBudgetAccount(tx, { ...context, principalId: owner.principalId, accountId: existing.id, expectedStreamVersion: existing.streamVersion, limit: net, expiresAt: goal.spec.budget.deadline }) : createBudgetAccount(tx, { ...context, principalId: owner.principalId, scope: { namespace: 'goal', resourceId: goal.id }, parentAccountId: root.id, limit: net, expiresAt: goal.spec.budget.deadline });
        const thread = this.kernel.createThreadInTransaction(tx, actor.tenantId, actor.principalId, 'goal-authority:' + goal.id, { workspaceId: goal.workspaceId, pluginId: 'business', subject: '工作授权' });
        const execution = this.kernel.createExecutionInTransaction(tx, actor.tenantId, actor.principalId, 'goal-authority:' + scopeId, { workspaceId: goal.workspaceId, threadId: thread.id, pluginId: 'business', agentDefinitionId: 'business.goal-authority', modelBindingId: 'none', executionPrincipalId: ENTERPRISE_AGENT_PREFIX + goal.id,
          authority: { workspaceId: goal.workspaceId, principalId: ENTERPRISE_AGENT_PREFIX + goal.id, toolIds: [], dataScopes: [{ namespace: ENTERPRISE_GOAL_SCOPE, resourceId: scopeId, digest: scopeDigest }, { namespace: nodeNamespace(goal.id), resourceId: '*' }], autoAllowedEffects: [], budget: { maxTokens: goal.spec.budget.maxTokens, maxCostMinorUnits: String(goal.spec.budget.maxCostMinor), currency: 'CNY', maxDurationMs: Date.parse(goal.spec.budget.deadline) - Date.parse(this.now()), maxSubagents: this.quota(tx, goal).totalNodes, maxSubagentDepth: 1 } } });
        const started = this.kernel.commandExecutionInTransaction(tx, actor.tenantId, actor.principalId, scopeId + ':start', execution.id, execution.streamVersion, 'start');
        this.kernel.commandExecutionInTransaction(tx, actor.tenantId, actor.principalId, scopeId + ':complete', execution.id, started.streamVersion, 'complete');
        const authority = tx.getProjection<ExecutionAuthority>('authority', execution.authorityId)!;
        this.operating.record(tx, ENTERPRISE_GOAL_SCOPE, { id: scopeId, tenantId: actor.tenantId, workspaceId: goal.workspaceId, streamVersion: 1, goalId: goal.id, authorityId: authority.id, commitment: authority.commitment, template, digest: scopeDigest }, actor.principalId, 'work.authority_bound');
        const authorized = this.record(tx, goal, { owner, status: 'running', scopeId, authorityRevisionId: authority.id, accountId: account.id, workspaceAccountId: root.id }, 'work.goal_authorized');
        if (goal.initialEvaluation) { const evaluation = tx.getProjection<EvaluationAttempt>('operating.evaluation', goal.initialEvaluation.id), batch = evaluation && tx.getProjection<OperatingBatch>(OPERATING.batch, evaluation.batchId); if (batch) this.bindSubscriptionRecord(tx, authorized, batch); }
        return authorized;
  }
  availableModels(goal: EnterpriseGoalRecord): readonly EvaluationModel[] {
    const current = this.options.modelsFor(goal.tenantId, goal.workspaceId);
    return goal.models.flatMap(model => {
      if (!current.some(m => m.id === model.id && sha256(m) === sha256(model))) return [];
      try { return [checkedEnterpriseModel(model)]; } catch { return []; }
    });
  }
  private context(tx: KernelTransaction, goal: EnterpriseGoalRecord, automatic: boolean): EnterprisePlanContext {
    const quota = this.quota(tx, goal), account = tx.getProjection<BudgetAccountV1>('budget.account', goal.accountId!)!, records = this.operating.bridge.snapshot(tx).records;
    const controls = this.attempts(tx, goal.id).filter(a => a.kind !== 'task'), held = controls.map(a => tx.getProjection<BudgetReservationV1>('budget.reservation', a.reservationId)!).filter(r => ['reserved', 'committed', 'unknown'].includes(r.status));
    return { tenantId: goal.tenantId, workspaceId: goal.workspaceId, goalId: goal.id, authorityRevisionId: goal.authorityRevisionId!, inputRefs: goal.spec.sources.map(s => this.operating.sourceReference(tx, s.reference)), budget: goal.spec.budget, acceptanceCriteria: goal.spec.acceptanceCriteria,
      capabilities: this.capabilities.filter(c => goal.spec.capabilityIds.includes(c.id)), modelBindingIds: this.availableModels(goal).map(m => m.id), now: this.now(), limits: quota,
      history: tx.listProjections<PlanRevision>(ENTERPRISE_PLAN).filter(p => p.goalId === goal.id), attempts: this.attempts(tx, goal.id).filter(a => a.kind === 'task').map(a => ({ ...a, activeScope: a.scopeId === goal.scopeId })), otherAttempts: controls.length, otherNodes: new Set(controls.map(a => a.node.id)).size, automaticReplans: Math.max(0, goal.automaticReplans - (automatic && goal.planningAttemptId && goal.planRevision > 0 ? 1 : 0)), spent: { tokens: account.spentTokens + (goal.initialEvaluation?.tokens ?? 0) + held.reduce((sum, r) => sum + r.amount.tokens, 0), costMinorUnits: (BigInt(account.spentCostMinorUnits) + BigInt(goal.initialEvaluation?.costMinorUnits ?? '0') + held.reduce((sum, r) => sum + BigInt(r.amount.costMinorUnits), 0n)).toString() }, automatic };
  }
  async plan(actor: EnterpriseActor, id: string, expected: number, key: string, raw: Omit<EnterpriseContractTypes['EnterpriseGoalPlanWrite'], 'expectedStreamVersion'>): Promise<View> {
    const input = parseEnterpriseContract('EnterpriseGoalPlanWrite', { ...raw, expectedStreamVersion: expected });
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      const goal = this.require(tx, id); this.guard(tx, () => this.read(tx, goal, actor));
      return this.change(tx, actor, goal.workspaceId, key, ['plan', id, input], () => {
        if (goal.streamVersion !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
        return this.commitPlan(tx, goal, input, false);
      });
    });
  }
  validatePlan(tx: KernelTransaction, goal: EnterpriseGoalRecord, input: { reason: string; nodes: readonly TaskNode[] }, automatic: boolean): PlanRevision {
        const plan: PlanRevision = { tenantId: goal.tenantId, workspaceId: goal.workspaceId, id: 'plan:' + goal.id + ':' + (goal.planRevision + 1), goalId: goal.id, revision: goal.planRevision + 1, authorityRevisionId: goal.authorityRevisionId!, reason: input.reason, nodes: input.nodes,
          inputRefs: this.context(tx, goal, automatic && goal.planRevision > 0).inputRefs, budget: goal.spec.budget, acceptanceCriteria: goal.spec.acceptanceCriteria, createdAt: this.now() };

    validateEnterprisePlan(plan, this.context(tx, goal, automatic && goal.planRevision > 0)); return plan;
  }
  commitPlan(tx: KernelTransaction, goal: EnterpriseGoalRecord, input: { reason: string; nodes: readonly TaskNode[] }, automatic: boolean): EnterpriseGoalRecord {
        this.guard(tx, () => { this.assertCurrent(tx, goal, true); });
        let plan: PlanRevision;
        try { plan = this.validatePlan(tx, goal, input, automatic); }
        catch (error) { if (!(error instanceof EnterprisePlanError) || error.code !== 'PLAN_AUTHORITY_EXPANSION') throw error;
          const proposalDigest = sha256(input); this.operating.record(tx, 'enterprise-work.proposal', { id: proposalDigest, tenantId: goal.tenantId, workspaceId: goal.workspaceId, streamVersion: 1, proposal: input }, goal.owner.principalId, 'work.scope_change_proposed');
          return this.record(tx, goal, { status: 'awaiting_authorization', attention: { code: error.code, proposalDigest } }, 'work.authorization_required'); }
        if (!automatic) for (const attempt of this.attempts(tx, goal.id)) if (attempt.kind === 'planning' && attempt.status === 'queued') this.cancelQueued(tx, goal, attempt, 'PLAN_SUPERSEDED');
        for (const attempt of this.attempts(tx, goal.id)) if (attempt.kind === 'task' && attempt.status === 'queued' && sha256(plan.nodes.find(n => n.id === attempt.node.id) ?? null) !== sha256(attempt.node)) this.cancelQueued(tx, goal, attempt, 'PLAN_REPLACED');
        this.operating.record(tx, ENTERPRISE_PLAN, { ...plan, streamVersion: 1 }, goal.owner.principalId, 'work.plan_committed');
        const updated = this.record(tx, goal, { status: 'running', attention: undefined, planId: plan.id, planRevision: plan.revision, automaticReplans: goal.automaticReplans, planningAttemptId: undefined }, 'work.plan_activated');
        if (!updated.paused) this.dispatchInTransaction(tx, updated, plan);
        return this.require(tx, goal.id);
  }
  cancelQueued(tx: KernelTransaction, goal: EnterpriseGoalRecord, attempt: EnterpriseTaskAttempt, code: string): void {
    const reservation = tx.getProjection<BudgetReservationV1>('budget.reservation', attempt.reservationId), execution = tx.getProjection<Execution>('execution', attempt.executionId), job = tx.getProjection<Job>('job', attempt.jobId);
    if (attempt.status !== 'queued' || reservation?.status !== 'reserved' || execution?.status !== 'queued' || !job) throw new EnterpriseError('TASK_ALREADY_STARTED', 409);
    if (job.status === 'available' || job.status === 'leased') {
      if (!tx.invalidateJob) throw new EnterpriseError('TASK_INVALIDATION_UNAVAILABLE', 503);
      const invalidated = tx.invalidateJob({ jobId: job.id, reason: { code }, occurredAt: this.now() });
      const { leaseOwner: _owner, leaseExpiresAt: _expiry, ...metadata } = job;
      tx.putProjection('job', job.id, { ...metadata, status: 'failed', fencingToken: invalidated.fencingToken, streamVersion: job.streamVersion + 1, updatedAt: this.now() });
      appendKernelEvent(tx, { tenantId: goal.tenantId, aggregateType: 'job', aggregateId: job.id, expectedStreamVersion: job.streamVersion, type: 'job.failed', actorId: goal.owner.principalId, executionId: execution.id, generation: execution.generation, correlationId: attempt.id, publicPayload: { code, workspaceId: goal.workspaceId } });
    }
    releaseBudget(tx, { tenantId: goal.tenantId, workspaceId: goal.workspaceId, principalId: goal.owner.principalId, reservationId: attempt.reservationId, operationKey: attempt.id, occurredAt: this.now() });
    this.kernel.commandExecutionInTransaction(tx, goal.tenantId, goal.owner.principalId, attempt.id + ':' + code, execution.id, execution.streamVersion, 'cancel');
    this.operating.record(tx, ENTERPRISE_ATTEMPT, { ...attempt, status: 'cancelled', streamVersion: attempt.streamVersion + 1, reasonCode: code, updatedAt: this.now() }, goal.owner.principalId, 'work.node_cancelled');
  }
  dispatchInTransaction(tx: KernelTransaction, goal: EnterpriseGoalRecord, plan: PlanRevision): void {
    const scope = this.assertCurrent(tx, goal), attempts = this.attempts(tx, goal.id), quota = this.quota(tx, goal);
    let running = attempts.filter(a => ['queued', 'running'].includes(a.status)).length;
    let tenantRunning = tx.listProjections<Execution>('execution').filter(e => ['queued', 'running'].includes(e.status)).length;
    const parent = tx.getProjection<ExecutionAuthority>('authority', goal.authorityRevisionId!)!;
    for (const nodeId of readyEnterpriseNodes(plan, attempts.filter(a => a.kind === 'task' && a.scopeId === goal.scopeId))) {
      if (running >= quota.parallelNodes || tenantRunning >= quota.tenantRunningNodes) break;
      const node = plan.nodes.find(n => n.id === nodeId)!, model = scope.template.models.find(m => m.id === node.modelBindingId);
      if (!model) throw new EnterpriseError('MODEL_BINDING_CHANGED', 409);
      const ordinal = this.attempts(tx, goal.id).length + 1; if (ordinal > quota.totalAttempts) throw new EnterpriseError('PLAN_ATTEMPT_LIMIT', 409);
      const id = 'attempt:' + sha256([goal.id, node.id, ordinal]), jobId = 'job:' + id, occurredAt = this.now();
      const root = tx.getProjection<BudgetAccountV1>('budget.account', goal.workspaceAccountId!)!;
      if (BigInt(root.spentTokens) + BigInt(root.heldTokens) + BigInt(node.budget.maxTokens) > BigInt(quota.tokens) || BigInt(root.spentCostMinorUnits) + BigInt(root.heldCostMinorUnits) + BigInt(node.budget.maxCostMinor) > BigInt(quota.costMinorUnits)) {
        const current = this.require(tx, goal.id), status = running > 0 ? 'running' : 'waiting_external';
        if (current.status !== status || current.attention?.code !== 'WORKSPACE_BUDGET_EXCEEDED') this.record(tx, current, { status, attention: { code: 'WORKSPACE_BUDGET_EXCEEDED' } }, 'work.waiting_budget');
        return;
      }
      this.queueAttempt(tx, goal, node, 'task', plan.revision); running++; tenantRunning++;
    }
  }
  private queueAttempt(tx: KernelTransaction, goal: EnterpriseGoalRecord, node: TaskNode, kind: EnterpriseTaskAttempt['kind'], planRevision: number, diagnostic?: { executionId: string; digest: string }): EnterpriseTaskAttempt {
    const scope = this.assertCurrent(tx, goal), quota = this.quota(tx, goal), parent = tx.getProjection<ExecutionAuthority>('authority', goal.authorityRevisionId!)!;
    const model = this.availableModels(goal).find(m => m.id === node.modelBindingId);
    if (!model) throw new EnterpriseError('MODEL_BINDING_CHANGED', 409);
    const ordinal = this.attempts(tx, goal.id).length + 1; if (ordinal > quota.totalAttempts) throw new EnterpriseError('PLAN_ATTEMPT_LIMIT', 409);
    const id = 'attempt:' + sha256([goal.id, node.id, ordinal]), jobId = 'job:' + id, occurredAt = this.now();
    const root = tx.getProjection<BudgetAccountV1>('budget.account', goal.workspaceAccountId!)!;
    if (root.spentTokens + root.heldTokens + node.budget.maxTokens > quota.tokens || BigInt(root.spentCostMinorUnits) + BigInt(root.heldCostMinorUnits) + BigInt(node.budget.maxCostMinor) > BigInt(quota.costMinorUnits)) throw new EnterpriseError('WORKSPACE_BUDGET_EXCEEDED', 409);
      const budgetContext = { tenantId: goal.tenantId, workspaceId: goal.workspaceId, principalId: goal.owner.principalId, occurredAt };
      const account = createBudgetAccount(tx, { ...budgetContext, scope: { namespace: ENTERPRISE_ATTEMPT, resourceId: id }, parentAccountId: goal.accountId!, limit: amount(node.budget), expiresAt: node.budget.deadline });
      const reservation = reserveBudget(tx, { ...budgetContext, accountId: account.id, operationKey: id, amount: amount(node.budget) });
      const templateDigest = sha256({ goalId: goal.id, scopeId: scope.id, node, model, kind, ...(diagnostic ? { diagnostic } : {}) }), thread = this.kernel.createThreadInTransaction(tx, goal.tenantId, goal.owner.principalId, id, { workspaceId: goal.workspaceId, pluginId: 'business', subject: '工作节点' });
      const execution = this.kernel.createExecutionInTransaction(tx, goal.tenantId, goal.owner.principalId, id, { workspaceId: goal.workspaceId, threadId: thread.id, pluginId: 'business', agentDefinitionId: node.capabilityId, modelBindingId: model.id, executionPrincipalId: ENTERPRISE_AGENT_PREFIX + id,
        authority: { workspaceId: goal.workspaceId, principalId: ENTERPRISE_AGENT_PREFIX + id, parentAuthorityId: parent.id, toolIds: [], autoAllowedEffects: [], dataScopes: [{ namespace: ENTERPRISE_GOAL_SCOPE, resourceId: scope.id, digest: scope.digest }, { namespace: nodeNamespace(goal.id), resourceId: id, digest: templateDigest }], budget: { maxTokens: node.budget.maxTokens, maxCostMinorUnits: String(node.budget.maxCostMinor), currency: 'CNY', maxDurationMs: Date.parse(node.budget.deadline) - Date.parse(occurredAt), maxSubagents: 0, maxSubagentDepth: 0 } } });
      const authority = tx.getProjection<ExecutionAuthority>('authority', execution.authorityId)!; assertAuthorityAttenuation(parent, authority);
      const attempt: EnterpriseTaskAttempt = { ...(diagnostic ? { diagnosticFor: diagnostic.executionId, progressDigest: diagnostic.digest } : {}), id, tenantId: goal.tenantId, workspaceId: goal.workspaceId, streamVersion: 1, goalId: goal.id, node, ordinal, executionId: execution.id, jobId, kind, planRevision, authorityId: authority.id, commitment: authority.commitment, scopeId: scope.id, templateDigest, reservationId: reservation.id, model, status: 'queued', createdAt: occurredAt, updatedAt: occurredAt };
      this.operating.record(tx, ENTERPRISE_ATTEMPT, attempt, goal.owner.principalId, 'work.node_queued');
      const job = { id: jobId, tenantId: goal.tenantId, workspaceId: goal.workspaceId, kind: 'enterprise.task', payload: { attemptId: id, executionId: execution.id, generation: execution.generation }, availableAt: occurredAt, idempotencyKey: id };
      tx.putJob(job); this.operating.record(tx, 'job', { ...job, status: 'available', attempts: 0, fencingToken: 0, streamVersion: 1, createdAt: occurredAt, updatedAt: occurredAt }, goal.owner.principalId, 'job.queued');
      tx.beforeCommit!(() => { this.assertTask(tx, attempt); });
      return attempt;
  }
  assertTask(tx: KernelTransaction, attempt: EnterpriseTaskAttempt, phase: 'dispatch' | 'result' = 'dispatch'): EnterpriseGoalRecord {
    const goal = this.require(tx, attempt.goalId), scope = this.assertCurrent(tx, goal, phase === 'result'), authority = tx.getProjection<ExecutionAuthority>('authority', attempt.authorityId), plan = goal.planId ? tx.getProjection<PlanRevision>(ENTERPRISE_PLAN, goal.planId) : undefined;
    const supersededPlan = attempt.kind === 'planning' && goal.planningAttemptId !== attempt.id && goal.planRevision >= attempt.planRevision;
    if (supersededPlan && phase === 'dispatch') throw new EnterpriseError('PLAN_SUPERSEDED', 409);
    if ((attempt.kind === 'task' && (!plan || sha256(plan.nodes.find(n => n.id === attempt.node.id) ?? null) !== sha256(attempt.node)))
      || (attempt.kind === 'planning' && !supersededPlan && (goal.planningAttemptId !== attempt.id || goal.planRevision + 1 !== attempt.planRevision))
      || scope.id !== attempt.scopeId || sha256({ goalId: goal.id, scopeId: scope.id, node: attempt.node, model: attempt.model, kind: attempt.kind, ...(attempt.diagnosticFor ? { diagnostic: { executionId: attempt.diagnosticFor, digest: attempt.progressDigest } } : {}) }) !== attempt.templateDigest
      || !authority || authority.commitment !== attempt.commitment || computeExecutionAuthorityCommitment(authority) !== attempt.commitment || !authority.dataScopes.some(s => s.namespace === nodeNamespace(goal.id) && s.resourceId === attempt.id && s.digest === attempt.templateDigest)) throw new EnterpriseError('TASK_SCOPE_CHANGED', 409);
    if (attempt.kind === 'diagnostic' && phase === 'dispatch') { const target = this.attempts(tx, goal.id).find(a => a.executionId === attempt.diagnosticFor); if (!target || sha256(this.progress(tx, goal, target)) !== attempt.progressDigest) throw new EnterpriseError('DIAGNOSTIC_SUPERSEDED', 409); }
    if (attempt.kind === 'diagnostic' && (!attempt.diagnosticFor || !goal.diagnosticExecutions?.includes(attempt.diagnosticFor))) throw new EnterpriseError('DIAGNOSTIC_SCOPE_INVALID', 409);
    assertAuthorityAttenuation(tx.getProjection<ExecutionAuthority>('authority', goal.authorityRevisionId!)!, authority);
    if (phase === 'dispatch' && !this.availableModels(goal).some(m => sha256(m) === sha256(attempt.model))) throw new EnterpriseError('MODEL_BINDING_CHANGED', 409);
    const sources = attempt.node.inputRefs.map(reference => ({ reference, fields: goal.spec.sources.find(s => s.reference.objectType === reference.objectType && s.reference.objectId === reference.objectId)!.fields }));
    this.operating.sources(tx, goal.owner, goal.workspaceId, sources, true);
    if (Date.parse(attempt.node.budget.deadline) <= Date.parse(this.now())) throw new EnterpriseError('TASK_EXPIRED', 409);
    return goal;
  }
  private bindSubscriptionRecord(tx: KernelTransaction, goal: EnterpriseGoalRecord, batch: OperatingBatch): void {
    if (!goal.scopeId || batch.owner.principalId !== goal.owner.principalId || batch.workspaceId !== goal.workspaceId) throw new EnterpriseError('SUBSCRIPTION_SCOPE_INVALID', 409);
    const id = 'subscription:' + batch.id, prior = tx.getProjection<OperatingSubscription>(OPERATING.subscription, id);
    if (prior?.goalId === goal.id && prior.goalScopeId === goal.scopeId) return;
    if (prior?.goalId && prior.goalId !== goal.id) throw new EnterpriseError('SUBSCRIPTION_SCOPE_INVALID', 409);
    const sourceIds = [...new Set(batch.triggerIds.map(id => tx.getProjection<OperatingTrigger>(OPERATING.trigger, id)!.sourceId))];
    this.operating.record(tx, OPERATING.subscription, { id, tenantId: goal.tenantId, workspaceId: goal.workspaceId, streamVersion: (prior?.streamVersion ?? 0) + 1, batchId: batch.id, goalId: goal.id, goalScopeId: goal.scopeId, owner: goal.owner, sources: goal.spec.sources, sourceIds,
      permissionDigest: executionPermissionDigest(this.operating.bridge.snapshot(tx).records, goal.owner.principalId, goal.workspaceId), triggerIds: prior?.triggerIds ?? [], validUntil: goal.spec.budget.deadline, status: 'active' }, goal.owner.principalId, 'work.subscription_bound');
  }
  async bindSubscription(actor: EnterpriseActor, id: string, batchId: string, expectedBatchVersion: number, key: string): Promise<void> {
    await this.operating.bridge.store.transact(actor.tenantId, tx => {
      const goal = this.require(tx, id); this.guard(tx, () => { this.read(tx, goal, actor); this.assertCurrent(tx, goal); });
      this.change(tx, actor, goal.workspaceId, key, ['bind-subscription', id, batchId, expectedBatchVersion], () => {
        const batch = tx.getProjection<OperatingBatch>(OPERATING.batch, batchId);
        if (!batch || batch.streamVersion !== expectedBatchVersion) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
        this.bindSubscriptionRecord(tx, goal, batch); return goal;
      });
    });
  }
  async adoptPolicies(tenantId: string): Promise<void> {
    const ids = await this.operating.bridge.store.transact(tenantId, tx => tx.listProjections<EvaluationAttempt>('operating.evaluation').filter(e => e.status === 'completed' && e.result?.candidate && !e.goalId).map(e => e.id));
    for (const id of ids) {
      try { await this.operating.bridge.store.transact(tenantId, tx => {
      const evaluation = tx.getProjection<EvaluationAttempt>('operating.evaluation', id);
      if (!evaluation || evaluation.goalId || evaluation.status !== 'completed' || !evaluation.result?.candidate) return;
      const batch = tx.getProjection<OperatingBatch>(OPERATING.batch, evaluation.batchId)!;
      if (batch.mode !== 'execute' || !batch.policyId) return;
      const policy = tx.listProjections<OperatingPolicy>(OPERATING.policy).find(p => p.workspaceId === batch.workspaceId && p.id === batch.policyId);
      if (!policy?.work || policy.streamVersion !== batch.policyVersion || policy.status !== 'active') return;
      let actor: EnterpriseActor;
      try { actor = this.operating.currentPolicy(tx, policy); } catch (error) { if (error instanceof EnterpriseError) return; throw error; }
      const validate = () => { this.operating.currentPolicy(tx, policy); this.operating.sources(tx, actor, batch.workspaceId, evaluation.template.sources, true); };
      this.guard(tx, validate);
      const reservation = tx.getProjection<BudgetReservationV1>('budget.reservation', evaluation.reservationId);
      if (reservation?.status !== 'settled' || !reservation.usage || evaluation.costNanoMinorUnits === undefined) return;
      const spec = parseEnterpriseContract('EnterpriseGoalSpec', { ...policy.work, sources: evaluation.template.sources });
      const initialEvaluation = { id, tokens: reservation.usage.tokens, costMinorUnits: reservation.usage.costMinorUnits, costNanoMinorUnits: evaluation.costNanoMinorUnits };
      const created = this.createRecord(tx, actor, batch.workspaceId, 'evaluation:' + id, spec, randomBytes(32).toString('hex'), initialEvaluation);
      const goal = this.record(tx, created, { policyOrigin: { id: policy.id, version: policy.streamVersion } }, 'work.policy_applied');
      const authorized = this.authorizeRecord(tx, goal, actor, goal.scopeDigest);
      this.bindSubscriptionRecord(tx, authorized, batch);
      this.operating.record(tx, 'operating.evaluation', { ...evaluation, goalId: goal.id, streamVersion: evaluation.streamVersion + 1 }, actor.principalId, 'operating.evaluation_adopted');
      }); } catch (error) {
        if (!(error instanceof EnterpriseError) || error.status >= 500) throw error;
        await this.operating.bridge.store.transact(tenantId, tx => {
          const current = tx.getProjection<EvaluationAttempt>('operating.evaluation', id);
          if (current && !current.goalId && current.reasonCode !== error.code) this.operating.record(tx, 'operating.evaluation', { ...current, streamVersion: current.streamVersion + 1, reasonCode: error.code }, 'enterprise-system:goals', 'operating.adoption_deferred');
        });
      }
    }
  }
  async runTenant(tenantId: string): Promise<void> {
    await this.adoptPolicies(tenantId);
    const goals = await this.operating.bridge.store.transact(tenantId, tx => tx.listProjections<EnterpriseGoalRecord>(ENTERPRISE_GOAL).filter(g => !g.paused && !g.cancelRequested && ['running', 'waiting_external', 'waiting_person'].includes(g.status)));
    for (const value of goals) {
      try {
        const source = await this.operating.bridge.store.transact(tenantId, tx => {
          const current = this.require(tx, value.id), attempts = this.attempts(tx, value.id);
          if (attempts.some(a => a.kind === 'planning' && ['queued', 'running', 'needs_reconciliation'].includes(a.status))) return undefined;
          const request = tx.listProjections<{ id: string; goalId: string; scopeId: string }>('enterprise-work.decomposition').find(r => r.goalId === current.id && r.scopeId === current.scopeId && !current.replannedSources?.includes('decomposition:' + r.id));
          if (request) return 'decomposition:' + request.id;
          const latest = new Map(attempts.filter(a => a.kind === 'task' && a.scopeId === current.scopeId).map(a => [a.node.id, a]));
          const failed = [...latest.values()].find(a => a.status === 'failed' && a.retryable && ['TASK_FAILED', 'TASK_OUTPUT_INVALID', 'MODEL_BINDING_CHANGED', 'SOURCE_VERSION_CONFLICT'].includes(a.reasonCode ?? '') && !current.replannedSources?.includes('failure:' + a.id));
          return failed ? 'failure:' + failed.id : undefined;
        });
        if (source) { await this.requestPlan(value.owner, value.id, value.streamVersion, source, undefined, source); continue; }
        if (!value.planId && !value.planningAttemptId && value.authorityRevisionId) await this.requestPlan(value.owner, value.id, value.streamVersion, 'initial-plan:' + value.scopeId);
        else if (value.planId && value.status !== 'waiting_person') { await this.advance(tenantId, value.id); await this.supervise(tenantId, value.id); }
      } catch (error) {
        if (!(error instanceof EnterpriseError) && !(error instanceof EnterprisePlanError)) throw error;
        if (['STREAM_VERSION_CONFLICT', 'PLAN_ALREADY_PENDING'].includes(error.code)) continue;
        await this.operating.bridge.store.transact(tenantId, tx => {
          const current = this.require(tx, value.id);
          if (current.status === 'running' && current.attention?.code !== error.code) this.record(tx, current, { status: 'waiting_person', attention: { code: error.code } }, 'work.dispatch_blocked');
        });
      }
    }
  }
  async advance(tenantId: string, id: string): Promise<void> {
    await this.operating.bridge.store.transact(tenantId, tx => {
      let goal = this.require(tx, id);
      if (goal.paused || goal.cancelRequested || !goal.planId || !['running', 'waiting_external'].includes(goal.status)) return;
      this.assertCurrent(tx, goal, true);
      const plan = tx.getProjection<PlanRevision>(ENTERPRISE_PLAN, goal.planId)!, attempts = this.attempts(tx, id), quota = this.quota(tx, goal);
      const ready = readyEnterpriseNodes(plan, attempts.filter(a => a.kind === 'task' && a.scopeId === goal.scopeId));
      if (!ready.length) return;
      const next = plan.nodes.find(n => n.id === ready[0])!, root = tx.getProjection<BudgetAccountV1>('budget.account', goal.workspaceAccountId!)!;
      if (root.spentTokens + root.heldTokens + next.budget.maxTokens > quota.tokens || BigInt(root.spentCostMinorUnits) + BigInt(root.heldCostMinorUnits) + BigInt(next.budget.maxCostMinor) > BigInt(quota.costMinorUnits)
        || attempts.filter(a => ['queued', 'running'].includes(a.status)).length >= quota.parallelNodes || tx.listProjections<Execution>('execution').filter(e => ['queued', 'running'].includes(e.status)).length >= quota.tenantRunningNodes) return;
      if (goal.status === 'waiting_external' || goal.attention?.code === 'WORKSPACE_BUDGET_EXCEEDED') goal = this.record(tx, goal, { status: 'running', attention: undefined }, 'work.budget_available');
      this.dispatchInTransaction(tx, goal, plan);
    });
  }
  progress(tx: KernelTransaction, goal: EnterpriseGoalRecord, target: EnterpriseTaskAttempt) {
    const job = tx.getProjection<Job>('job', target.jobId), runtime = tx.getProjection<{ records: readonly { type: string; occurredAt: string }[] }>('agent-runtime', target.executionId);
    const progressTypes = new Set(['model/request', 'model/response', 'tool/started', 'tool/result', 'turn/completed']);
    const lastProgressAt = [target.updatedAt, ...(runtime?.records ?? []).filter(r => progressTypes.has(r.type)).map(r => r.occurredAt)].sort().at(-1)!;
    const waitingApproval = tx.listProjections<Approval>('approval').some(a => a.executionId === target.executionId && a.status === 'pending');
    const receipts = tx.listProjections<{ executionId: string; goalId: string; nodeId: string; status: string; streamVersion: number }>('provider.action').filter(a => a.executionId === target.executionId || (a.goalId === goal.id && a.nodeId === target.node.id));
    return { executionId: target.executionId, nodeId: target.node.id, status: target.status, lastProgressAt,
      leaseActive: job?.status === 'leased' && Date.parse(job.leaseExpiresAt ?? '') > Date.parse(this.now()), waitingApproval,
      waitingReceipt: receipts.some(r => ['committed', 'needs_reconciliation'].includes(r.status)), receiptVersions: receipts.map(r => r.streamVersion),
      resultPresent: !!tx.getProjection('enterprise-work.result', target.id) };
  }
  async supervise(tenantId: string, id: string): Promise<EnterpriseTaskAttempt | undefined> {
    return this.operating.bridge.store.transact(tenantId, tx => {
      const goal = this.require(tx, id); if (goal.status !== 'running' || goal.paused) return undefined;
      this.assertCurrent(tx, goal); const attempts = this.attempts(tx, id), quota = this.quota(tx, goal);
      if (attempts.filter(a => ['queued', 'running'].includes(a.status)).length >= quota.parallelNodes || tx.listProjections<Execution>('execution').filter(e => ['queued', 'running'].includes(e.status)).length >= quota.tenantRunningNodes) return undefined;
      for (const target of attempts.filter(a => a.kind === 'task' && a.status === 'running' && !goal.diagnosticExecutions?.includes(a.executionId))) {
        const progress = this.progress(tx, goal, target);
        if (!progress.leaseActive || progress.waitingApproval || progress.waitingReceipt || progress.resultPresent || Date.parse(this.now()) - Date.parse(progress.lastProgressAt) < 900_000) continue;
        const model = this.availableModels(goal)[0], account = tx.getProjection<BudgetAccountV1>('budget.account', goal.accountId!)!;
        const maxTokens = Math.min(1024, Math.floor((account.limit.tokens - account.spentTokens - account.heldTokens) / 4)), maxCostMinor = Number((BigInt(account.limit.costMinorUnits) - BigInt(account.spentCostMinorUnits) - BigInt(account.heldCostMinorUnits)) / 4n);
        if (!model || maxTokens < 1 || maxCostMinor < 1) return undefined;
        const definition: TaskNode = { id: '__diagnostic:' + target.executionId, dependsOn: [], capabilityId: 'enterprise.diagnose', capabilityVersion: '1', modelBindingId: model.id, inputRefs: this.context(tx, goal, false).inputRefs, budget: { maxTokens, maxCostMinor: Math.min(20, maxCostMinor), currency: 'CNY', deadline: goal.spec.budget.deadline }, acceptanceCriteria: ['只读检查无进展原因，不修改计划或重放动作'], effect: 'read' };
        const attempt = this.queueAttempt(tx, goal, definition, 'diagnostic', Math.max(1, goal.planRevision), { executionId: target.executionId, digest: sha256(progress) });
        this.record(tx, goal, { diagnosticExecutions: [...goal.diagnosticExecutions ?? [], target.executionId] }, 'work.diagnostic_queued');
        return attempt;
      }
      return undefined;
    });
  }
  async requestPlan(actor: EnterpriseActor, id: string, expected: number, key: string, modelBindingId?: string, replanSource?: string): Promise<View> {
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      let goal = this.require(tx, id); this.guard(tx, () => this.read(tx, goal, actor));
      return this.change(tx, actor, goal.workspaceId, key, ['request-plan', id, expected, modelBindingId ?? null, replanSource ?? null], () => {
        if (goal.streamVersion !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
        this.assertCurrent(tx, goal, true); if (goal.paused || goal.status === 'awaiting_authorization') throw new EnterpriseError('GOAL_INACTIVE', 409);
        if (goal.planningAttemptId && this.attempts(tx, goal.id).some(a => a.id === goal.planningAttemptId && ['queued', 'running', 'needs_reconciliation'].includes(a.status))) throw new EnterpriseError('PLAN_ALREADY_PENDING', 409);
        const quota = this.quota(tx, goal);
        if (goal.planRevision > 0 && goal.automaticReplans >= quota.automaticReplans) throw new EnterpriseError('PLAN_REPLAN_LIMIT', 409);
        const model = this.availableModels(goal).find(m => !modelBindingId || m.id === modelBindingId);
        if (!model) throw new EnterpriseError('MODEL_CONNECTION_UNCONFIGURED', 409);
        const account = tx.getProjection<BudgetAccountV1>('budget.account', goal.accountId!)!;
        const tokens = Math.min(32000, Math.floor((account.limit.tokens - account.spentTokens - account.heldTokens) / 2)), cost = Number((BigInt(account.limit.costMinorUnits) - BigInt(account.spentCostMinorUnits) - BigInt(account.heldCostMinorUnits)) / 4n);
        if (tokens < 1 || cost < 1) throw new EnterpriseError('GOAL_BUDGET_EXCEEDED', 409);
        if (this.attempts(tx, goal.id).filter(a => ['queued', 'running'].includes(a.status)).length >= quota.parallelNodes || tx.listProjections<Execution>('execution').filter(e => ['queued', 'running'].includes(e.status)).length >= quota.tenantRunningNodes) throw new EnterpriseError('TENANT_RUNNING_LIMIT', 409);
        if (replanSource && goal.replannedSources?.includes(replanSource)) throw new EnterpriseError('REPLAN_SOURCE_ALREADY_HANDLED', 409);
        goal = this.record(tx, goal, { ...(replanSource ? { replannedSources: [...goal.replannedSources ?? [], replanSource] } : {}), status: 'running', attention: undefined, automaticReplans: goal.automaticReplans + (goal.planRevision > 0 ? 1 : 0) }, 'work.planning_requested');
        const node: TaskNode = { id: '__planner', dependsOn: [], capabilityId: 'enterprise.plan', capabilityVersion: '1', modelBindingId: model.id, inputRefs: this.context(tx, goal, false).inputRefs, budget: { maxTokens: tokens, maxCostMinor: Math.min(500, cost), currency: 'CNY', deadline: goal.spec.budget.deadline }, acceptanceCriteria: ['计划满足当前授权和验收条件'], effect: 'read' };
        const attempt = this.queueAttempt(tx, goal, node, 'planning', goal.planRevision + 1);
        return this.record(tx, goal, { planningAttemptId: attempt.id }, 'work.planning_queued');
      });
    });
  }
  async control(actor: EnterpriseActor, id: string, expected: number, command: 'pause' | 'resume' | 'cancel', key: string): Promise<EnterpriseContractTypes['EnterpriseGoalControlResult']> {
    if (!['pause', 'resume', 'cancel'].includes(command)) throw new EnterpriseError('INVALID_COMMAND', 400);
    const value = await this.operating.bridge.store.transact(actor.tenantId, tx => {
      const goal = this.require(tx, id);
      if (goal.owner.principalId !== actor.principalId) throw new EnterpriseError('GOAL_NOT_FOUND', 404);
      this.guard(tx, () => { this.operating.actor(tx, actor, goal.workspaceId); if (command !== 'cancel') this.read(tx, goal, actor); });
      return this.change(tx, actor, goal.workspaceId, key, ['control', id, expected, command], () => {
        if (goal.streamVersion !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
        if (['completed', 'cancelled'].includes(goal.status)) throw new EnterpriseError('GOAL_FINISHED', 409);
        if (command === 'resume') { this.guard(tx, () => { this.assertCurrent(tx, goal, true); }); const resumed = this.record(tx, goal, { paused: false }, 'work.goal_resumed');
          if (resumed.planId) this.dispatchInTransaction(tx, resumed, tx.getProjection<PlanRevision>(ENTERPRISE_PLAN, resumed.planId)!); return this.require(tx, id); }
        if (command === 'pause') { for (const attempt of this.attempts(tx, goal.id)) if (attempt.status === 'queued') this.cancelQueued(tx, goal, attempt, 'GOAL_PAUSED'); return this.record(tx, goal, { paused: true }, 'work.goal_paused'); }
        for (const attempt of this.attempts(tx, goal.id)) if (attempt.status === 'queued') this.cancelQueued(tx, goal, attempt, 'GOAL_CANCELLED');
        const unresolved = this.attempts(tx, goal.id).some(a => a.status === 'running' || a.status === 'needs_reconciliation');
        return this.record(tx, goal, { cancelRequested: true, status: unresolved ? 'needs_reconciliation' : 'cancelled' }, 'work.goal_cancel_requested');
      }, command !== 'cancel');
    });
    return { goalId: value.id, streamVersion: value.streamVersion, status: value.status, paused: value.paused, cancelRequested: value.cancelRequested };
  }
  async controlState(actor: EnterpriseActor, id: string): Promise<EnterpriseContractTypes['EnterpriseGoalControlResult']> {
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      const goal = this.require(tx, id);
      if (goal.owner.principalId !== actor.principalId) throw new EnterpriseError('GOAL_NOT_FOUND', 404);
      this.guard(tx, () => { this.operating.actor(tx, actor, goal.workspaceId); });
      return { goalId: goal.id, streamVersion: goal.streamVersion, status: goal.status, paused: goal.paused, cancelRequested: !!goal.cancelRequested };
    });
  }
  async begin(tenantId: string, attemptId: string, lease: KernelJobLeaseAssertion): Promise<EnterpriseTaskAttempt> {
    return this.operating.bridge.store.transact(tenantId, tx => {
      const attempt = tx.getProjection<EnterpriseTaskAttempt>(ENTERPRISE_ATTEMPT, attemptId);
      if (!attempt || attempt.jobId !== lease.jobId || !tx.assertJobLease) throw new EnterpriseError('TASK_LEASE_REQUIRED', 409);
      this.guard(tx, () => { tx.assertJobLease!({ ...lease, occurredAt: this.now() }); this.assertTask(tx, attempt); });
      if (attempt.status !== 'queued') return attempt;
      const execution = tx.getProjection<Execution>('execution', attempt.executionId)!;
      this.kernel.commandExecutionInTransaction(tx, tenantId, 'enterprise-system:task', attempt.id + ':start', execution.id, execution.streamVersion, 'start');
      return this.operating.record(tx, ENTERPRISE_ATTEMPT, { ...attempt, status: 'running', streamVersion: attempt.streamVersion + 1, updatedAt: this.now() }, 'enterprise-system:task', 'work.node_started');
    });
  }
}
