// SPDX-License-Identifier: Apache-2.0
import type { ActionIntent, ActionReceipt, Approval, BudgetAccountV1, BudgetAmountV1, BudgetReservationV1, Execution, ExecutionAuthority, Job, JsonObject, Principal, ToolCallIntent } from '@mn/contracts';
import { actionIntentView, computeActionIntentDigest, computeActionReceiptDigest, parseEnterpriseContract } from '@mn/contracts';
import { assertApprovalUsable, assertCurrentApprovalAuthorization, assertCurrentExecutionAuthorization, authorityAllowsIntent,
  appendKernelEvent, assertBudgetReservationReady, commitBudgetReservation, expireExecutionApprovals, KernelError, markBudgetUnknown, recordToolAdmission,
  releaseBudget, reserveBudget, settleBudget, sha256, type AgentOsKernel, type KernelJobLeaseAssertion,
  type KernelJobSettlementReceipt, type KernelStore, type KernelTransaction } from '@mn/kernel';
export const PROVIDER_ACTION_AGENT_ID = 'business.provider-action';
export const PROVIDER_ACTION_JOB_KIND = 'provider.action.execute';
export const PROVIDER_ACTION_NAMESPACE = 'provider.action';
export interface CoordinatedAction extends ActionIntent {
  readonly executionId: string; readonly toolId: string; readonly toolVersion: string; readonly actionDigest: string;
  readonly requestDigest: string; readonly resourceKey: string; readonly jobId?: string; readonly receipt?: ActionReceipt;
  readonly cancelRequestedAt?: string; readonly cancelRequestedBy?: string;
  readonly localOutcome?: 'cancelled'; readonly createdAt: string; readonly updatedAt: string;
}
export interface ActionPolicyContext {
  readonly action: ActionIntent; readonly execution: Execution; readonly actorId: string;
  readonly phase: 'prepare' | 'read' | 'queue' | 'dispatch' | 'cancel' | 'reconcile' | 'inflight';
  readonly lease?: KernelJobLeaseAssertion;
}
type PreparedActionInput = Omit<ActionIntent, 'streamVersion' | 'status' | 'reservationId' | 'executionApprovalRef'>;
interface PreparationOptions {
  readonly executionId: string; readonly accountId: string; readonly actorId: string; readonly idempotencyKey: string;
  readonly toolId: string; readonly toolVersion: string; readonly amount: BudgetAmountV1;
}
function fail(code: string): never { throw new KernelError(code, '动作尚未满足授权、版本或回执条件', '核对原操作、当前授权和业务系统回执'); }

/** A meter is a synchronous trusted reader; rejected promises cannot escape the accounting boundary. */
export function verifiedActionUsage(meter:(receipt:ActionReceipt,action:CoordinatedAction)=>BudgetAmountV1,receipt:ActionReceipt,action:CoordinatedAction):BudgetAmountV1 {
  const value:unknown=meter(receipt,action);
  if(value&&typeof (value as {then?:unknown}).then==='function'){
    void Promise.resolve(value).catch(()=>{});fail('ACTION_USAGE_UNVERIFIED');
  }
  const usage=value as BudgetAmountV1|undefined;
  if(!usage||!Number.isSafeInteger(usage.tokens)||usage.tokens<0||!/^(0|[1-9]\d{0,29})$/u.test(usage.costMinorUnits)||!/^[A-Z]{3}$/u.test(usage.currency))fail('ACTION_USAGE_UNVERIFIED');
  return usage!;
}

/** One provider-action Execution owns one effect. All state uses the existing Kernel transaction and Job store. */
export class ActionCoordinator {
  private readonly now: () => string;
  constructor(readonly options: { store: KernelStore; kernel: AgentOsKernel; now?: () => string;
    assertCurrent: (tx: KernelTransaction, context: ActionPolicyContext) => void }) {
    if (typeof options.assertCurrent !== 'function') throw new Error('ACTION_POLICY_REQUIRED');
    if (options.assertCurrent.constructor.name === 'AsyncFunction') fail('ACTION_POLICY_MUST_BE_SYNCHRONOUS');
    this.now = options.now ?? (() => new Date().toISOString());
  }
  get(tenantId: string, id: string): Promise<CoordinatedAction | undefined> {
    return this.options.store.transact(tenantId, tx => tx.getProjection<CoordinatedAction>(PROVIDER_ACTION_NAMESPACE, id));
  }
  private require(tx: KernelTransaction, tenantId: string, id: string): CoordinatedAction {
    const action = tx.getProjection<CoordinatedAction>(PROVIDER_ACTION_NAMESPACE, id);
    if (!action || action.tenantId !== tenantId) fail('ACTION_NOT_FOUND');
    if (computeActionIntentDigest(action!) !== action!.actionDigest) fail('ACTION_CHANGED');
    return action!;
  }
  private execution(tx: KernelTransaction, action: ActionIntent & { executionId: string }): Execution {
    const execution = tx.getProjection<Execution>('execution', action.executionId);
    if (!execution || execution.tenantId !== action.tenantId || execution.workspaceId !== action.workspaceId
      || execution.agentDefinitionId !== PROVIDER_ACTION_AGENT_ID || execution.generation !== action.generation || execution.authorityId !== action.authorityRevisionId) fail('ACTION_EXECUTION_MISMATCH');
    return execution!;
  }
  private check(tx: KernelTransaction, action: CoordinatedAction, phase: ActionPolicyContext['phase'], actorId?: string, lease?: KernelJobLeaseAssertion): Execution {
    const execution = this.execution(tx, action);
    if (['prepare', 'queue', 'dispatch'].includes(phase)) {
      assertCurrentExecutionAuthorization(tx, execution);
      if (!['queued', 'running', 'waiting_approval'].includes(execution.status) || Date.parse(action.expiresAt) <= Date.parse(this.now())) fail('ACTION_AUTHORITY_EXPIRED');
    }
    const result: unknown = this.options.assertCurrent(tx, { action: actionIntentView(action), execution, actorId: actorId ?? execution.initiatedBy, phase, ...(lease ? { lease } : {}) });
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => {});
      fail('ACTION_POLICY_INVALID_RESULT');
    }
    return execution;
  }
  private write(tx: KernelTransaction, current: CoordinatedAction, patch: Partial<CoordinatedAction>, type: string, actorId: string): CoordinatedAction {
    const value = { ...current, ...patch, streamVersion: current.streamVersion + 1, updatedAt: this.now() };
    tx.putProjection(PROVIDER_ACTION_NAMESPACE, value.id, value);
    appendKernelEvent(tx, { tenantId: value.tenantId, aggregateType: PROVIDER_ACTION_NAMESPACE, aggregateId: value.id,
      expectedStreamVersion: current.streamVersion, type, actorId, executionId: value.executionId, generation: value.generation,
      correlationId: value.operationKey, publicPayload: { workspaceId: value.workspaceId, operationKey: value.operationKey, status: value.status } });
    return value;
  }
  private toolIntent(tx: KernelTransaction, action: CoordinatedAction): ToolCallIntent {
    const execution = this.execution(tx, action), authority = tx.getProjection<ExecutionAuthority>('authority', execution.authorityId);
    if (!authority || authority.tenantId !== action.tenantId || authority.workspaceId !== action.workspaceId || authority.executionId !== execution.id) fail('ACTION_AUTHORITY_INVALID');
    const { status: _status, streamVersion: _version, executionApprovalRef: _approval, ...arguments_ } = actionIntentView(action);
    const resources = [{ namespace: `provider.${action.provider}.${action.target.objectType}`, resourceId: action.target.objectId, digest: action.target.digest }];
    return { id: `${action.id}:execute`, executionId: execution.id, generation: action.generation, toolId: action.toolId, toolVersion: action.toolVersion,
      effectClass: 'external_side_effect', intent: '执行已准备的业务动作', normalizedArguments: arguments_ as unknown as JsonObject,
      argumentsDigest: action.actionDigest, resourceRefs: resources, resourcesDigest: sha256(resources), authorityCommitment: authority!.commitment, expiresAt: action.expiresAt };
  }
  async prepare(input: PreparedActionInput, options: PreparationOptions): Promise<CoordinatedAction> {
    return this.options.store.transact(input.tenantId, tx => this.prepareInTransaction(tx,input,options));
  }
  prepareInTransaction(tx: KernelTransaction,input: PreparedActionInput,options: PreparationOptions): CoordinatedAction {
    parseEnterpriseContract('ActionIntent', { ...input, reservationId: 'pending', status: 'prepared', streamVersion: 1 });
    if (!options.idempotencyKey || !options.toolId || !options.toolVersion || input.target.tenantId !== input.tenantId || input.target.workspaceId !== input.workspaceId
      || ('provider' in input.target && input.target.provider !== input.provider) || (input.action === 'issue_quote_package' && !input.businessApprovalRef)) fail('ACTION_INPUT_INVALID');
    const { id: _id, ...semantic } = input;
    const { idempotencyKey: _key, ...executionContext } = options;
    const requestDigest = sha256({ semantic, executionContext });
    const resourceKey = sha256([input.tenantId, input.workspaceId, input.provider, input.target.objectType, input.target.objectId]);
      const execution = this.execution(tx, { ...input, status: 'prepared', streamVersion: 1, reservationId: 'pending', executionId: options.executionId });
      if (execution.initiatedBy !== options.actorId) fail('ACTION_ACTOR_MISMATCH');
      assertCurrentExecutionAuthorization(tx, execution);
      const records = tx.listProjections<CoordinatedAction>(PROVIDER_ACTION_NAMESPACE);
      const cached = tx.getIdempotency(`action.prepare:${options.actorId}`, options.idempotencyKey);
      const duplicate = cached ? this.require(tx, input.tenantId, (cached.response as { id: string }).id) : records.find(item => item.operationKey === input.operationKey);
      if (duplicate) {
        if (duplicate.requestDigest !== requestDigest || (cached && cached.requestDigest !== requestDigest)) fail('ACTION_OPERATION_CONFLICT');
        this.check(tx, duplicate, 'read', options.actorId);
        if (!cached) {
          appendKernelEvent(tx, { tenantId:input.tenantId,aggregateType:'action.command',aggregateId:sha256([options.actorId,options.idempotencyKey]),
            expectedStreamVersion:0,type:'action.prepare_resolved',actorId:options.actorId,generation:duplicate.generation,
            executionId:duplicate.executionId,correlationId:duplicate.operationKey,publicPayload:{workspaceId:duplicate.workspaceId,actionId:duplicate.id} });
          tx.putIdempotency({ tenantId: input.tenantId, scope: `action.prepare:${options.actorId}`, key: options.idempotencyKey,
            requestDigest, response: { id: duplicate.id }, createdAt: this.now() });
        }
        return duplicate;
      }
      if (records.some(item => item.resourceKey === resourceKey && ['committed', 'needs_reconciliation'].includes(item.status))) fail('ACTION_RECONCILIATION_REQUIRED');
      if (records.some(item => item.executionId === execution.id) || tx.getProjection(PROVIDER_ACTION_NAMESPACE, input.id)) fail('ACTION_EXECUTION_ALREADY_BOUND');
      if (!['queued', 'running'].includes(execution.status)) fail('ACTION_EXECUTION_INACTIVE');
      const authority = tx.getProjection<ExecutionAuthority>('authority', execution.authorityId);
      const account = tx.getProjection<BudgetAccountV1>('budget.account', options.accountId);
      if (!authority || !account || account.scope.namespace !== 'goal' || account.scope.resourceId !== input.goalId
        || options.amount.currency !== authority.budget.currency || options.amount.tokens > authority.budget.maxTokens
        || !/^(0|[1-9]\d{0,29})$/u.test(options.amount.costMinorUnits)
        || BigInt(options.amount.costMinorUnits) > BigInt(authority.budget.maxCostMinorUnits)) fail('ACTION_BUDGET_EXCEEDED');
      if (Date.parse(input.expiresAt) > Date.parse(account.expiresAt)
        || Date.parse(input.expiresAt) > Date.parse(execution.createdAt) + authority.budget.maxDurationMs) fail('ACTION_AUTHORITY_EXPIRED');
      const reservation = reserveBudget(tx, { tenantId: input.tenantId, workspaceId: input.workspaceId, principalId: options.actorId, occurredAt: this.now(),
        accountId: options.accountId, operationKey: input.operationKey, amount: options.amount });
      if (reservation.status !== 'reserved') fail('ACTION_BUDGET_ALREADY_USED');
      const value: CoordinatedAction = { ...input, reservationId: reservation.id, status: 'prepared', streamVersion: 1, executionId: execution.id,
        toolId: options.toolId, toolVersion: options.toolVersion, actionDigest: '', requestDigest, resourceKey, createdAt: this.now(), updatedAt: this.now() };
      const action = { ...value, actionDigest: computeActionIntentDigest(value) };
      this.check(tx, action, 'prepare', options.actorId);
      authorityAllowsIntent(tx.getProjection<ExecutionAuthority>('authority', execution.authorityId)!, this.toolIntent(tx, action));
      if (execution.status === 'queued') this.options.kernel.commandExecutionInTransaction(tx, input.tenantId, options.actorId, `action:${input.id}:start`, execution.id, execution.streamVersion, 'start');
      tx.putProjection(PROVIDER_ACTION_NAMESPACE, input.id, action);
      appendKernelEvent(tx, { tenantId: input.tenantId, aggregateType: PROVIDER_ACTION_NAMESPACE, aggregateId: input.id, expectedStreamVersion: 0,
        type: 'action.prepared', actorId: options.actorId, executionId: execution.id, generation: input.generation, correlationId: input.operationKey,
        publicPayload: { workspaceId: input.workspaceId, operationKey: input.operationKey, status: 'prepared' } });
      tx.putOutbox({ id: `action-prepared:${input.id}`, tenantId: input.tenantId, topic: 'action.prepared', payload: { actionId: input.id, executionId: execution.id }, availableAt: this.now() });
      tx.putIdempotency({ tenantId: input.tenantId, scope: `action.prepare:${options.actorId}`, key: options.idempotencyKey, requestDigest, response: { id: input.id }, createdAt: this.now() });
      return action;

  }
  async requestApproval(tenantId: string,id: string): Promise<Approval> {
    return this.options.store.transact(tenantId,tx=>this.requestApprovalInTransaction(tx,tenantId,id));
  }
  requestApprovalInTransaction(tx: KernelTransaction,tenantId: string,id: string): Approval {
    const action=this.require(tx,tenantId,id),execution=this.check(tx,action,'prepare');
    if(!['prepared','awaiting_approval'].includes(action.status))fail('ACTION_STATE_CONFLICT');
    const result=this.options.kernel.requestToolApprovalInTransaction(tx,tenantId,execution.initiatedBy,`action:${id}:approval`,this.toolIntent(tx,action));
    if(result.mode!=='approval')fail('ACTION_EXACT_APPROVAL_REQUIRED');
    const approvalId=result.approval.id;
    if(action.executionApprovalRef&&action.executionApprovalRef!==approvalId)fail('ACTION_APPROVAL_CONFLICT');
    if(!action.executionApprovalRef)this.write(tx,action,{status:'awaiting_approval',executionApprovalRef:approvalId},'action.approval_requested',execution.initiatedBy);
    return tx.getProjection<Approval>('approval',approvalId)!;
  }
  private approval(tx: KernelTransaction, action: CoordinatedAction): ToolCallIntent {
    const intent = this.toolIntent(tx, action), execution = this.execution(tx, action);
    const authority = tx.getProjection<ExecutionAuthority>('authority', execution.authorityId)!;
    const approval = action.executionApprovalRef ? tx.getProjection<Approval>('approval', action.executionApprovalRef) : undefined;
    const stored = tx.getProjection<Omit<ToolCallIntent, 'normalizedArguments'>>('toolIntent', intent.id);
    if (!approval || !stored) fail('APPROVAL_REQUIRED');
    if (approval!.tenantId !== action.tenantId || approval!.workspaceId !== action.workspaceId) fail('ACTION_APPROVAL_SCOPE_MISMATCH');
    authorityAllowsIntent(authority, intent);
    assertApprovalUsable(approval!, { ...stored!, normalizedArguments: intent.normalizedArguments }, intent, this.now());
    assertCurrentApprovalAuthorization(tx, approval!);
    if (tx.getProjection<Principal>('principal', approval!.decidedBy!)?.kind !== 'human') fail('ACTION_HUMAN_APPROVAL_REQUIRED');
    return intent;
  }
  async enqueue(tenantId: string,id: string): Promise<CoordinatedAction> {
    return this.options.store.transact(tenantId,tx=>this.enqueueInTransaction(tx,tenantId,id));
  }
  enqueueInTransaction(tx: KernelTransaction,tenantId: string,id: string): CoordinatedAction {
      const action = this.require(tx, tenantId, id), execution = this.check(tx, action, 'queue'); this.approval(tx, action);
      if (action.jobId) return action;
      if (!['prepared', 'awaiting_approval'].includes(action.status) || execution.status !== 'running') fail('ACTION_STATE_CONFLICT');
      assertBudgetReservationReady(tx, { tenantId, workspaceId: action.workspaceId, principalId: execution.initiatedBy,
        occurredAt: this.now(), reservationId: action.reservationId, operationKey: action.operationKey });
      const jobId = `action-job:${sha256([tenantId, id])}`;
      const job = { id: jobId, tenantId, workspaceId: action.workspaceId, kind: PROVIDER_ACTION_JOB_KIND,
        payload: { actionId: id, executionId: execution.id, generation: action.generation }, availableAt: this.now(), idempotencyKey: action.operationKey };
      tx.putJob(job);
      tx.putProjection('job', jobId, { ...job, status: 'available', attempts: 0, fencingToken: 0, streamVersion: 1, createdAt: this.now(), updatedAt: this.now() });
      appendKernelEvent(tx, { tenantId, aggregateType: 'job', aggregateId: jobId, expectedStreamVersion: 0, type: 'job.queued', actorId: execution.initiatedBy,
        executionId: execution.id, generation: action.generation, correlationId: action.operationKey, publicPayload: { workspaceId: action.workspaceId, kind: PROVIDER_ACTION_JOB_KIND } });
      tx.putOutbox({ id: `action-queued:${id}`, tenantId, topic: 'action.queued', payload: { actionId: id, executionId: execution.id, jobId }, availableAt: this.now() });
      return this.write(tx, action, { jobId, status: 'prepared' }, 'action.queued', execution.initiatedBy);

  }
  private lease(tx: KernelTransaction, action: CoordinatedAction, lease: KernelJobLeaseAssertion): KernelJobLeaseAssertion {
    if (!tx.assertJobLease || action.jobId !== lease.jobId) fail('ACTION_LEASE_REQUIRED');
    const actual = { ...lease, occurredAt: this.now() }; tx.assertJobLease!(actual);
    const job = tx.getProjection<Job>('job', lease.jobId);
    if (!job || job.tenantId !== action.tenantId || job.kind !== PROVIDER_ACTION_JOB_KIND || job.payload.actionId !== action.id
      || job.payload.executionId !== action.executionId || job.payload.generation !== action.generation) fail('ACTION_JOB_MISMATCH');
    return actual;
  }
  async begin(tenantId: string, id: string, lease: KernelJobLeaseAssertion): Promise<CoordinatedAction> {
    return this.options.store.transact(tenantId, tx => {
      const action = this.require(tx, tenantId, id); const currentLease = this.lease(tx, action, lease);
      if (['committed', 'needs_reconciliation'].includes(action.status)) fail('ACTION_RECONCILIATION_REQUIRED');
      if (action.status !== 'prepared') fail('ACTION_STATE_CONFLICT');
      const execution = this.check(tx, action, 'dispatch', undefined, currentLease);
      if (execution.status !== 'running') fail('ACTION_EXECUTION_INACTIVE');
      const intent = this.approval(tx, action);
      if (tx.listProjections<CoordinatedAction>(PROVIDER_ACTION_NAMESPACE).some(other => other.id !== action.id && other.resourceKey === action.resourceKey
        && ['committed', 'needs_reconciliation'].includes(other.status))) fail('ACTION_RECONCILIATION_REQUIRED');
      commitBudgetReservation(tx, { tenantId, workspaceId: action.workspaceId, principalId: execution.initiatedBy, occurredAt: this.now(), reservationId: action.reservationId, operationKey: action.operationKey });
      recordToolAdmission(tx, execution, intent.id, 'started', this.now());
      return this.write(tx, action, { status: 'committed' }, 'action.dispatch_committed', execution.initiatedBy);
    });
  }
  private receipt(action: CoordinatedAction, input: ActionReceipt): ActionReceipt {
    const receipt = parseEnterpriseContract('ActionReceipt', input);
    if (receipt.tenantId !== action.tenantId || receipt.workspaceId !== action.workspaceId || receipt.operationKey !== action.operationKey
      || receipt.provider !== action.provider || receipt.actionDigest !== action.actionDigest) fail('ACTION_RECEIPT_MISMATCH');
    if (receipt.status === 'succeeded' && (receipt.evidenceRefs.some(ref => ref.tenantId !== action.tenantId || ref.workspaceId !== action.workspaceId)
      || !receipt.evidenceRefs.some(ref => ['business_fact', 'human_decision'].includes(ref.sourceKind)))) fail('ACTION_RECEIPT_MISMATCH');
    return receipt;
  }
  private executionState(tx: KernelTransaction, execution: Execution, status: Execution['status'], actorId: string): void {
    if (execution.status === status) return;
    tx.putProjection('execution', execution.id, { ...execution, status, streamVersion: execution.streamVersion + 1, updatedAt: this.now() });
    appendKernelEvent(tx, { tenantId: execution.tenantId, aggregateType: 'execution', aggregateId: execution.id, expectedStreamVersion: execution.streamVersion,
      type: `execution.${status}`, actorId, executionId: execution.id, generation: execution.generation, correlationId: execution.id, publicPayload: { status } });
  }
  private invalidate(tx: KernelTransaction, action: CoordinatedAction, job: Job, actorId: string, code: string): void {
    if (!tx.invalidateJob) fail('ACTION_INVALIDATION_UNAVAILABLE');
    const receipt = tx.invalidateJob({ jobId: job.id, reason: { code }, occurredAt: this.now() });
    const { leaseOwner: _owner, leaseExpiresAt: _expires, ...withoutLease } = job;
    tx.putProjection('job', job.id, { ...withoutLease, status: 'failed', fencingToken: receipt.fencingToken,
      streamVersion: job.streamVersion + 1, updatedAt: this.now() });
    appendKernelEvent(tx, { tenantId: action.tenantId, aggregateType: 'job', aggregateId: job.id, expectedStreamVersion: job.streamVersion,
      type: 'job.failed', actorId, executionId: action.executionId, generation: action.generation,
      correlationId: action.operationKey, publicPayload: { code, status: 'failed' } });
  }
  async markUnknown(tenantId: string, id: string, lease: KernelJobLeaseAssertion): Promise<CoordinatedAction> {
    return this.options.store.transact(tenantId, tx => {
      const action = this.require(tx, tenantId, id); this.lease(tx, action, lease);
      if (action.status === 'needs_reconciliation') return action;
      if (action.status !== 'committed') fail('ACTION_STATE_CONFLICT');
      const execution = this.execution(tx, action);
      markBudgetUnknown(tx, { tenantId, workspaceId: action.workspaceId, principalId: execution.initiatedBy, occurredAt: this.now(), reservationId: action.reservationId, operationKey: action.operationKey });
      this.executionState(tx, execution, 'needs_reconciliation', execution.initiatedBy);
      return this.write(tx, action, { status: 'needs_reconciliation' }, 'action.reconciliation_required', execution.initiatedBy);
    });
  }
  private settle(tx: KernelTransaction, action: CoordinatedAction, receipt: ActionReceipt, usage: BudgetAmountV1, actorId: string): CoordinatedAction {
    if (!['succeeded', 'not_executed'].includes(receipt.status)) fail('ACTION_RECEIPT_PENDING');
    const execution = this.execution(tx, action);
    settleBudget(tx, { tenantId: action.tenantId, workspaceId: action.workspaceId, principalId: actorId, occurredAt: this.now(),
      reservationId: action.reservationId, operationKey: action.operationKey, usage, evidenceDigest: computeActionReceiptDigest(receipt) });
    recordToolAdmission(tx, execution, `${action.id}:execute`, 'settled', this.now());
    this.executionState(tx, execution, receipt.status === 'succeeded' ? 'completed' : 'failed', actorId);
    const next = this.write(tx, action, { status: 'settled', receipt }, 'action.receipt_recorded', actorId);
    tx.putOutbox({ id: `action-result:${action.id}`, tenantId: action.tenantId, topic: 'action.result_available', payload: { actionId: action.id, executionId: action.executionId }, availableAt: this.now() });
    return next;
  }
  async complete(tenantId: string, id: string, input: ActionReceipt, usage: BudgetAmountV1, lease: KernelJobLeaseAssertion): Promise<KernelJobSettlementReceipt> {
    return this.options.store.transact(tenantId, tx => {
      const action = this.require(tx, tenantId, id); const currentLease = this.lease(tx, action, lease);
      if (!['committed', 'needs_reconciliation'].includes(action.status)) fail('ACTION_STATE_CONFLICT');
      const receipt = this.receipt(action, input);
      this.settle(tx, action, receipt, usage, `worker:${lease.workerId}`);
      if (!tx.settleJob) fail('ACTION_SETTLEMENT_UNAVAILABLE');
      return tx.settleJob!({ ...currentLease, outcome: receipt.status === 'succeeded' ? 'completed' : 'failed', value: { actionId: id, operationKey: action.operationKey }, occurredAt: this.now() });
    });
  }
  async reconcile(tenantId: string, id: string, expectedStreamVersion: number, actorId: string, input: ActionReceipt, usage: BudgetAmountV1): Promise<CoordinatedAction> {
    return this.options.store.transact(tenantId,tx=>this.reconcileInTransaction(tx,tenantId,id,expectedStreamVersion,actorId,input,usage));
  }
  reconcileInTransaction(tx: KernelTransaction,tenantId: string,id: string,expectedStreamVersion: number,actorId: string,input: ActionReceipt,usage: BudgetAmountV1): CoordinatedAction {
      const action = this.require(tx, tenantId, id); this.check(tx, action, 'reconcile', actorId);
      const receipt = this.receipt(action, input);
      if (action.status === 'settled' && action.receipt && computeActionReceiptDigest(action.receipt) === computeActionReceiptDigest(receipt)) {
        const budget = tx.getProjection<BudgetReservationV1>('budget.reservation', action.reservationId);
        if (sha256(budget?.usage) !== sha256(usage)) fail('BUDGET_SETTLEMENT_CONFLICT');
        return action;
      }
      if (action.streamVersion !== expectedStreamVersion) fail('STREAM_VERSION_CONFLICT');
      if (!['committed', 'needs_reconciliation'].includes(action.status)) fail('ACTION_RECONCILIATION_REQUIRED');
      const next = this.settle(tx, action, receipt, usage, actorId);
      const job = action.jobId && tx.getProjection<Job>('job', action.jobId);
      if (job && ['available', 'leased'].includes(job.status)) {
        this.invalidate(tx, action, job, actorId, 'ACTION_RECONCILED');
      }
      return next;

  }
  async cancelBeforeDispatch(tenantId: string,id: string,actorId: string): Promise<CoordinatedAction> {
    return this.options.store.transact(tenantId,tx=>this.cancelBeforeDispatchInTransaction(tx,tenantId,id,actorId));
  }
  cancelBeforeDispatchInTransaction(tx: KernelTransaction,tenantId: string,id: string,actorId: string): CoordinatedAction {
      const action = this.require(tx, tenantId, id);
      if (['committed', 'needs_reconciliation'].includes(action.status)) fail('ACTION_RECONCILIATION_REQUIRED');
      this.check(tx, action, 'cancel', actorId);
      if (action.status === 'settled') return action;
      const execution = this.execution(tx, action);
      releaseBudget(tx, { tenantId, workspaceId: action.workspaceId, principalId: actorId, occurredAt: this.now(), reservationId: action.reservationId, operationKey: action.operationKey });
      expireExecutionApprovals(tx, { tenantId, executionId: execution.id, generation: execution.generation, actorId, occurredAt: this.now(), reason: '动作在派发前取消' });
      if (action.jobId) {
        const job = tx.getProjection<Job>('job', action.jobId);
        if (job && ['available', 'leased'].includes(job.status)) this.invalidate(tx, action, job, actorId, 'ACTION_CANCELLED');
      }
      this.executionState(tx, execution, 'cancelled', actorId);
      const next = this.write(tx, action, { status: 'settled', localOutcome: 'cancelled' }, 'action.cancelled_before_dispatch', actorId);
      tx.putOutbox({ id: `action-result:${action.id}`, tenantId, topic: 'action.result_available', payload: { actionId: action.id, executionId: action.executionId }, availableAt: this.now() });
      return next;

  }
  requestCancellationInTransaction(tx: KernelTransaction,tenantId: string,id: string,actorId: string): CoordinatedAction {
    const action=this.require(tx,tenantId,id);this.check(tx,action,'cancel',actorId);
    if(action.status==='settled'||action.cancelRequestedAt)return action;
    if(!['committed','needs_reconciliation'].includes(action.status))return this.cancelBeforeDispatchInTransaction(tx,tenantId,id,actorId);
    const execution=this.execution(tx,action);
    markBudgetUnknown(tx,{tenantId,workspaceId:action.workspaceId,principalId:actorId,occurredAt:this.now(),reservationId:action.reservationId,operationKey:action.operationKey});
    this.executionState(tx,execution,'needs_reconciliation',actorId);
    return this.write(tx,action,{status:'needs_reconciliation',cancelRequestedAt:this.now(),cancelRequestedBy:actorId},'action.cancellation_requested',actorId);
  }
  async rejectBeforeDispatch(tenantId: string, id: string, lease: KernelJobLeaseAssertion): Promise<KernelJobSettlementReceipt> {
    return this.options.store.transact(tenantId, tx => {
      const action = this.require(tx, tenantId, id); const currentLease = this.lease(tx, action, lease);
      if (!['prepared', 'awaiting_approval'].includes(action.status)) fail('ACTION_RECONCILIATION_REQUIRED');
      const actorId = `worker:${lease.workerId}`;
      const execution = this.check(tx, action, 'cancel', actorId, currentLease);
      releaseBudget(tx, { tenantId, workspaceId: action.workspaceId, principalId: actorId, occurredAt: this.now(), reservationId: action.reservationId, operationKey: action.operationKey });
      expireExecutionApprovals(tx, { tenantId, executionId: execution.id, generation: execution.generation, actorId, occurredAt: this.now(), reason: '动作准入未通过' });
      this.executionState(tx, execution, 'failed', actorId);
      this.write(tx, action, { status: 'settled', localOutcome: 'cancelled' }, 'action.rejected_before_dispatch', actorId);
      tx.putOutbox({ id: `action-result:${action.id}`, tenantId, topic: 'action.result_available', payload: { actionId: action.id, executionId: action.executionId }, availableAt: this.now() });
      if (!tx.settleJob) fail('ACTION_SETTLEMENT_UNAVAILABLE');
      return tx.settleJob({ ...currentLease, outcome: 'failed', value: { code: 'ACTION_ADMISSION_REJECTED', actionId: id }, occurredAt: this.now() });
    });
  }
}
