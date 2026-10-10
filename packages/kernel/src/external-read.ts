// SPDX-License-Identifier: Apache-2.0
import type { Job, JsonValue, Principal, ResourceRef, Workspace, WorkspaceMembership } from '@mn/contracts';
import { isPotentiallyAutoApprovable } from '@mn/contracts';
import { sha256 } from './canonical.js';
import { KernelError } from './errors.js';
import { appendKernelEvent } from './projections.js';
import type { KernelJobSettlementReceipt, KernelTransaction } from './store.js';

export interface ExternalReadAdmission {
  readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly principalId: string;
  readonly toolId: string; readonly toolVersion: string; readonly effectClass: 'external_read';
  readonly resourceRefs: readonly ResourceRef[]; readonly requestDigest: string; readonly authorityDigest: string;
  readonly replayScopeDigest?: string;
  readonly expiresAt: string; readonly now: string; readonly jobKind: string;
}
export interface ExternalReadCommitment extends ExternalReadAdmission {
  readonly streamVersion: number; readonly jobId: string; readonly status: 'queued' | 'started' | 'completed' | 'failed' | 'needs_reconciliation';
  readonly membershipVersion: number; readonly startedFence?: number;
}
export interface ExternalReadBoundary { readonly id: string; readonly tenantId: string; readonly jobId: string; readonly workerId: string; readonly fencingToken: number; readonly occurredAt: string; readonly authorityDigest: string }
const namespace = 'kernel.externalRead';
function fail(code: string, message: string): never { throw new KernelError(code, message, '核对读取授权与已持久化的请求'); }
function member(tx: KernelTransaction, input: Pick<ExternalReadAdmission, 'tenantId' | 'workspaceId' | 'principalId'>): WorkspaceMembership {
  const value = tx.getProjection<WorkspaceMembership>('membership', `${input.workspaceId}:${input.principalId}`);
  const principal = tx.getProjection<Principal>('principal', input.principalId), workspace = tx.getProjection<Workspace>('workspace', input.workspaceId);
  if (!value || value.tenantId !== input.tenantId || value.workspaceId !== input.workspaceId || value.principalId !== input.principalId
    || value.removedAt || !['owner', 'operator'].includes(value.workspaceRole) || !principal || principal.tenantId !== input.tenantId || principal.disabledAt
    || !workspace || workspace.tenantId !== input.tenantId) fail('EXTERNAL_READ_DENIED', '当前读取授权已撤回');
  return value;
}
function event(tx: KernelTransaction, value: ExternalReadCommitment, previous: number, now: string): void {
  tx.putProjection(namespace, value.id, value);
  appendKernelEvent(tx, { tenantId: value.tenantId, aggregateType: namespace, aggregateId: value.id, expectedStreamVersion: previous,
    type: `external_read.${value.status}`, actorId: value.principalId, generation: 0, correlationId: value.id,
    publicPayload: { workspaceId: value.workspaceId, jobId: value.jobId, status: value.status, occurredAt: now } });
}
function assertNoUnknownReplay(tx: KernelTransaction, input: ExternalReadAdmission): void {
  const sources = (refs: readonly ResourceRef[]) => refs.map(ref => `${ref.namespace}\u0000${ref.resourceId}`).sort();
  if (tx.listProjections<ExternalReadCommitment>(namespace).some(value => value.id !== input.id
    && value.tenantId === input.tenantId && value.workspaceId === input.workspaceId && value.toolId === input.toolId
    && value.requestDigest === input.requestDigest && (input.replayScopeDigest
      ? value.replayScopeDigest === input.replayScopeDigest
      : sha256(sources(value.resourceRefs)) === sha256(sources(input.resourceRefs)))
    && ['started', 'needs_reconciliation'].includes(value.status))) fail('EXTERNAL_READ_REPLAY_BLOCKED', '原读取结果尚未核对，不能通过新请求重放');
}
/** Narrow central policy port: no Execution is invented and no effectful tool is admitted. */
export function admitExternalReadInTransaction(tx: KernelTransaction, input: ExternalReadAdmission): ExternalReadCommitment {
  if (input.effectClass !== 'external_read' || !isPotentiallyAutoApprovable(input.effectClass) || !input.toolId || !input.toolVersion
    || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(input.jobKind) || !input.resourceRefs.length || input.resourceRefs.length > 100
    || input.resourceRefs.some(ref => !ref.namespace || !ref.resourceId || ref.resourceId === '*' || !ref.digest)
    || !/^[a-f0-9]{64}$/u.test(input.requestDigest) || !/^[a-f0-9]{64}$/u.test(input.authorityDigest)
    || (input.replayScopeDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.replayScopeDigest))
    || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.parse(input.now)) fail('EXTERNAL_READ_POLICY_DENIED', '仅允许明确授权范围内的只读操作');
  const membership = member(tx, input), prior = tx.getProjection<ExternalReadCommitment>(namespace, input.id);
  if (prior) {
    const { streamVersion: _version, jobId: _job, status: _status, membershipVersion: _membership, startedFence: _fence, ...original } = prior;
    if (sha256(original) !== sha256(input)) fail('IDEMPOTENCY_KEY_REUSED', '读取标识已用于不同请求');
    return prior;
  }
  assertNoUnknownReplay(tx, input);
  const jobId = `external-read:${input.id}`, value: ExternalReadCommitment = { ...input, jobId, status: 'queued', streamVersion: 1, membershipVersion: membership.streamVersion };
  const job: Job = { id: jobId, tenantId: input.tenantId, workspaceId: input.workspaceId, kind: input.jobKind,
    payload: { readId: input.id }, status: 'available', attempts: 0, availableAt: input.now, fencingToken: 0,
    idempotencyKey: jobId, streamVersion: 1, createdAt: input.now, updatedAt: input.now };
  tx.putProjection('job', jobId, job);
  appendKernelEvent(tx, { tenantId: input.tenantId, aggregateType: 'job', aggregateId: jobId, expectedStreamVersion: 0,
    type: 'job.created', actorId: input.principalId, generation: 0, correlationId: input.id, publicPayload: { workspaceId: input.workspaceId, status: 'available' } });
  event(tx, value, 0, input.now);
  tx.putJob({ ...job }); tx.putOutbox({ id: jobId, tenantId: input.tenantId, topic: 'external.read.queued', payload: { jobId, readId: input.id }, availableAt: input.now });
  return value;
}
function current(tx: KernelTransaction, input: ExternalReadBoundary): ExternalReadCommitment {
  const value = tx.getProjection<ExternalReadCommitment>(namespace, input.id);
  if (!value || value.tenantId !== input.tenantId || value.jobId !== input.jobId || !tx.assertJobLease || !tx.settleJob) fail('EXTERNAL_READ_INVALID', '缺少持久读取或租约事务能力');
  tx.assertJobLease(input);
  return value;
}
export function assertExternalReadAuthorization(tx: KernelTransaction, value: ExternalReadCommitment, authorityDigest: string, now: string): void {
  if (member(tx, value).streamVersion !== value.membershipVersion || value.authorityDigest !== authorityDigest || Date.parse(value.expiresAt) <= Date.parse(now))
    fail('EXTERNAL_READ_DENIED', '当前读取授权、期限或资源版本已变化');
}
export function beginExternalReadInTransaction(tx: KernelTransaction, input: ExternalReadBoundary): ExternalReadCommitment {
  const value = current(tx, input); assertExternalReadAuthorization(tx, value, input.authorityDigest, input.occurredAt);
  if (value.status !== 'queued') fail('EXTERNAL_READ_ALREADY_STARTED', '读取已发出，不能重复派发；请核对原结果');
  assertNoUnknownReplay(tx, value);
  const next = { ...value, streamVersion: value.streamVersion + 1, status: 'started' as const, startedFence: input.fencingToken };
  event(tx, next, value.streamVersion, input.occurredAt); return next;
}
export function finishExternalReadInTransaction(tx: KernelTransaction, input: ExternalReadBoundary & { readonly outcome: 'completed' | 'failed' | 'needs_reconciliation'; readonly value: JsonValue }): KernelJobSettlementReceipt {
  const value = current(tx, input);
  if (!['queued', 'started'].includes(value.status)) fail('EXTERNAL_READ_CLOSED', '读取操作已经结束');
  if (input.outcome === 'completed') {
    assertExternalReadAuthorization(tx, value, input.authorityDigest, input.occurredAt);
    if (value.status !== 'started' || value.startedFence !== input.fencingToken) fail('EXTERNAL_READ_INVALID', '读取结果不属于当前外发承诺');
  }
  event(tx, { ...value, status: input.outcome, streamVersion: value.streamVersion + 1 }, value.streamVersion, input.occurredAt);
  return tx.settleJob!({ ...input, outcome: input.outcome === 'completed' ? 'completed' : 'failed' });
}
