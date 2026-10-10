// SPDX-License-Identifier: Apache-2.0
import type { AssignmentMemberV2, GoalAssignmentDetailV2, GoalAssignmentSummaryV2, GoalAssignmentV2, GoalListItemV2, GoalPlanV2, GoalV2, InboxItemV2, Principal, Thread, Workspace, WorkspaceMembership } from '@mn/contracts';
import { appendKernelEvent, KernelError, sha256, type KernelStore, type KernelTransaction } from '@mn/kernel';
import { readBoundedJsonBody } from './http-body.js';
import { readFollowupNotices } from './followup-notices.js';
import { assertGoalResource } from './goal-runtime.js';
import { validateHistoricalHostContextSource } from './context-source-validation.js';

interface Scope { readonly tenantId: string; readonly workspaceId: string; readonly principalId: string }
interface Options { readonly store: KernelStore; readonly protectedJournal: boolean; readonly now: () => string; readonly id: (kind: string) => string }
interface Assignment extends GoalAssignmentV2 { readonly tenantId: string }
interface Notice { readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly principalId: string; readonly goalId: string;
  readonly assignmentVersion: number; readonly kind: 'assignment' | 'delivery'; readonly createdAt: string; readonly streamVersion: 1; readonly stateKey?: string }
interface ReadState { readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly principalId: string; readonly readState: 'read' | 'unread'; readonly streamVersion: number }
const ASSIGNMENT = 'goal.assignment', NOTICE = 'collaboration.notice', READ_STATE = 'notification.read';
function fail(code: string, message: string): never { throw new KernelError(code, message, '刷新任务、成员和通知后重试'); }
function member(tx: KernelTransaction, scope: Scope): WorkspaceMembership {
  const workspace = tx.getProjection<Workspace>('workspace', scope.workspaceId), person = tx.getProjection<Principal>('principal', scope.principalId);
  const value = tx.getProjection<WorkspaceMembership>('membership', `${scope.workspaceId}:${scope.principalId}`);
  if (!workspace || workspace.tenantId !== scope.tenantId || !value || value.tenantId !== scope.tenantId || value.workspaceId !== scope.workspaceId
    || value.principalId !== scope.principalId || value.removedAt || !['owner', 'operator'].includes(value.workspaceRole)
    || !person || person.tenantId !== scope.tenantId || person.disabledAt) fail('WORKSPACE_ACCESS_DENIED', '无权访问此工作区任务');
  return value;
}
function goal(tx: KernelTransaction, scope: Scope, goalId: string): GoalV2 {
  member(tx, scope); const value = tx.getProjection<GoalV2>('goal.state', goalId);
  if (!value || value.tenantId !== scope.tenantId || value.workspaceId !== scope.workspaceId) fail('GOAL_NOT_FOUND', '任务不存在');
  return value;
}
function stored(tx: KernelTransaction, scope: Scope, goalId: string): Assignment {
  const value = tx.getProjection<Assignment>(ASSIGNMENT, goalId);
  if (value && (value.tenantId !== scope.tenantId || value.workspaceId !== scope.workspaceId || value.goalId !== goalId)) fail('GOAL_NOT_FOUND', '任务责任记录不存在');
  return value ?? { tenantId: scope.tenantId, workspaceId: scope.workspaceId, goalId, streamVersion: 0, responsiblePrincipalId: null };
}
function describeMember(tx: KernelTransaction, scope: Scope, principalId: string): AssignmentMemberV2 {
  const value = tx.getProjection<WorkspaceMembership>('membership', `${scope.workspaceId}:${principalId}`), person = tx.getProjection<Principal>('principal', principalId);
  const validScope = value?.tenantId === scope.tenantId && value.workspaceId === scope.workspaceId && value.principalId === principalId;
  const unavailableReason = !validScope || value.removedAt ? '成员已移除，待重新分配' : !person || person.tenantId !== scope.tenantId || person.disabledAt ? '成员身份不可用，待重新分配'
    : !['owner', 'operator'].includes(value.workspaceRole) ? '当前角色不能访问任务' : undefined;
  return { principalId, displayName: person?.tenantId === scope.tenantId ? person.displayName : principalId, workspaceRole: validScope ? value.workspaceRole : 'viewer',
    available: !unavailableReason, ...(unavailableReason ? { unavailableReason } : {}) };
}
function summary(tx: KernelTransaction, scope: Scope, value: Assignment): GoalAssignmentSummaryV2 {
  return { streamVersion: value.streamVersion, responsible: value.responsiblePrincipalId ? describeMember(tx, scope, value.responsiblePrincipalId) : null };
}
function detail(tx: KernelTransaction, scope: Scope, value: Assignment): GoalAssignmentDetailV2 {
  const { tenantId: _tenantId, ...assignment } = value;
  const ids = new Set(tx.listProjections<WorkspaceMembership>('membership').filter(m => m.tenantId === scope.tenantId && m.workspaceId === scope.workspaceId && !m.removedAt).map(m => m.principalId));
  if (value.responsiblePrincipalId) ids.add(value.responsiblePrincipalId);
  return { assignment, summary: summary(tx, scope, value), members: [...ids].sort().map(id => describeMember(tx, scope, id)), allowedActions: { assign: true, clear: Boolean(value.responsiblePrincipalId) } };
}
export async function listAssignedGoals(options: Options & Scope, values: readonly GoalV2[]): Promise<readonly GoalListItemV2[]> {
  return options.store.transact(options.tenantId, tx => { member(tx, options); return values.map(value => ({ ...value, assignment: summary(tx, options, stored(tx, options, value.id)) })); });
}
function event(tx: KernelTransaction, options: Options & Scope, aggregateType: string, aggregateId: string, version: number, type: string): void {
  appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType, aggregateId, expectedStreamVersion: version, type, actorId: options.principalId,
    generation: 0, correlationId: options.id('collaboration-event'), publicPayload: { workspaceId: options.workspaceId } });
}
function notify(tx: KernelTransaction, options: Options & Scope, assignment: Assignment, kind: Notice['kind'], stateKey?: string): void {
  if (!assignment.responsiblePrincipalId) return;
  const id = `notice-${sha256([options.tenantId, assignment.goalId, assignment.streamVersion, assignment.responsiblePrincipalId, kind, stateKey ?? null])}`;
  if (tx.getProjection(NOTICE, id)) return;
  const value: Notice = { id, tenantId: options.tenantId, workspaceId: options.workspaceId, principalId: assignment.responsiblePrincipalId,
    goalId: assignment.goalId, assignmentVersion: assignment.streamVersion, kind, createdAt: options.now(), streamVersion: 1, ...(stateKey ? { stateKey } : {}) };
  tx.putProjection(NOTICE, id, value); event(tx, options, NOTICE, id, 0, 'collaboration.notification_created');
}
function assertNoticeSources(tx: KernelTransaction, scope: Scope, value: GoalV2): void {
  const plan = value.planRevisionId ? tx.getProjection<GoalPlanV2>('goal.plan', value.planRevisionId) : undefined;
  for (const ref of [...value.resourceRefs, ...(plan?.resourceRefs ?? [])]) assertGoalResource(tx, scope, ref, validateHistoricalHostContextSource);
}
function observedState(value: GoalV2): string | undefined {
  if (!['awaiting_acceptance', 'failed', 'needs_reconciliation', 'waiting_approval'].includes(value.status)) return;
  return sha256([value.status, value.planRevisionId ?? null, value.deliverySetId ?? null, value.executionRef ?? null, value.reasonCode ?? null]);
}
const cursors = new WeakMap<KernelStore, Map<string, number>>();
export async function recoverTaskNotifications(options: Options & { readonly tenantId: string }): Promise<void> {
  if (!options.protectedJournal) return;
  await options.store.transact(options.tenantId, tx => {
    const assignments = tx.listProjections<Assignment>(ASSIGNMENT).filter(a => a.tenantId === options.tenantId && a.responsiblePrincipalId).sort((a, b) => a.goalId.localeCompare(b.goalId));
    if (!assignments.length) return;
    const cursor = cursors.get(options.store) ?? new Map<string, number>(); cursors.set(options.store, cursor);
    const start = (cursor.get(options.tenantId) ?? 0) % assignments.length;
    for (let offset = 0; offset < Math.min(20, assignments.length); offset++) {
      const value = assignments[(start + offset) % assignments.length]!;
      const scope = { ...options, workspaceId: value.workspaceId, principalId: value.responsiblePrincipalId! };
      let task: GoalV2; try { task = goal(tx, scope, value.goalId); assertNoticeSources(tx, scope, task); } catch { continue; }
      const key = observedState(task); if (key) notify(tx, scope, value, 'delivery', key);
    }
    cursor.set(options.tenantId, (start + Math.min(20, assignments.length)) % assignments.length);
  });
}
export function readLocalNotifications(tx: KernelTransaction, tenantId: string, principalId: string, workspaceId?: string): InboxItemV2[] {
  const local = tx.listProjections<Notice>(NOTICE).filter(n => n.tenantId === tenantId && n.principalId === principalId && (!workspaceId || n.workspaceId === workspaceId)).flatMap(n => {
    const scope = { tenantId, principalId, workspaceId: n.workspaceId };
    let task: GoalV2; try { task = goal(tx, scope, n.goalId); assertNoticeSources(tx, scope, task); } catch { return []; }
    const assignment = stored(tx, scope, n.goalId);
    if (assignment.streamVersion !== n.assignmentVersion || assignment.responsiblePrincipalId !== principalId || (n.kind === 'delivery' && observedState(task) !== n.stateKey)) return [];
    return [{ id: n.id, tenantId, workspaceId: n.workspaceId, kind: 'notice' as const, noticeType: n.kind, status: 'open' as const,
      title: n.kind === 'assignment' ? '任务已分配给你' : task.status === 'awaiting_acceptance' ? '负责的任务已有成果' : '负责的任务需要处理',
      summary: n.kind === 'assignment' ? '请查看任务要求与当前进展。责任分配不改变任务权限或执行授权。' : '请查看当前任务及已有证据；已读不代表批准操作或接收成果。',
      createdAt: n.createdAt, navigation: { pluginId: tx.getProjection<Thread>('thread', task.threadId)?.pluginId ?? 'opc', threadId: task.threadId, resourceRef: { namespace: 'goal.state', resourceId: task.id } } }];
  });
  const followups = readFollowupNotices(tx, tenantId, principalId, workspaceId).filter(n => { try { member(tx, { tenantId, workspaceId: n.workspaceId, principalId }); return true; } catch { return false; } });
  return [...local, ...followups.map(n => ({ ...n, noticeType: 'followup' as const }))].map(item => {
    const state = tx.getProjection<ReadState>(READ_STATE, `${principalId}:${item.id}`);
    if (state && (state.tenantId !== tenantId || state.workspaceId !== item.workspaceId || state.principalId !== principalId)) fail('NOTIFICATION_NOT_FOUND', '通知不存在');
    const readState = state?.readState ?? 'unread';
    return { ...item, streamVersion: state?.streamVersion ?? 0, readState, allowedActions: [readState === 'unread' ? 'mark_read' : 'mark_unread'] };
  });
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f]/u.test(value); }
function parse(body: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length || Object.keys(body).some(k => !fields.includes(k))) fail('COLLABORATION_INPUT_INVALID', '责任或通知请求字段无效');
  const value = body as Record<string, unknown>;
  if (!text(value.workspaceId) || !Number.isSafeInteger(value.expectedStreamVersion) || Number(value.expectedStreamVersion) < 0) fail('COLLABORATION_INPUT_INVALID', '工作区或记录版本无效');
  return value;
}
export async function dispatchTaskCollaborationRequest(options: Options & { readonly request: Request; readonly tenantId: string; readonly principalId: string; readonly mutationKey?: string }): Promise<{ status: number; data: unknown } | undefined> {
  const url = new URL(options.request.url), assignmentMatch = /^\/v2\/goals\/([^/]+)\/assignment$/u.exec(url.pathname), noticeMatch = /^\/v2\/notifications\/([^/]+)\/commands$/u.exec(url.pathname);
  if (!assignmentMatch && !noticeMatch) return;
  if (!options.protectedJournal) fail('PROTECTED_PAYLOAD_UNAVAILABLE', '责任与通知需要受保护的事件存储');
  let id: string; try { id = decodeURIComponent((assignmentMatch ?? noticeMatch)![1]!); } catch { fail('COLLABORATION_INPUT_INVALID', '记录标识无效'); }
  if (!text(id)) fail('COLLABORATION_INPUT_INVALID', '记录标识无效');
  if (assignmentMatch && options.request.method === 'GET') {
    const workspaceId = url.searchParams.get('workspaceId');
    if (!text(workspaceId) || url.searchParams.size !== 1) fail('COLLABORATION_INPUT_INVALID', '查询需要工作区标识');
    const scope = { ...options, workspaceId };
    return { status: 200, data: await options.store.transact(options.tenantId, tx => { goal(tx, scope, id); return detail(tx, scope, stored(tx, scope, id)); }) };
  }
  if (options.request.method !== (assignmentMatch ? 'PUT' : 'POST')) return;
  if (url.searchParams.size) fail('COLLABORATION_INPUT_INVALID', '变更请求不接受查询参数');
  const key = options.mutationKey ?? options.request.headers.get('Idempotency-Key'); if (!text(key)) fail('IDEMPOTENCY_KEY_REQUIRED', '变更需要幂等键');
  const body = parse(await readBoundedJsonBody(options.request, { maxBytes: 4096 }), assignmentMatch ? ['workspaceId', 'expectedStreamVersion', 'responsiblePrincipalId'] : ['workspaceId', 'expectedStreamVersion', 'command']);
  const scope = { ...options, workspaceId: body.workspaceId as string };
  if (assignmentMatch && body.responsiblePrincipalId !== null && !text(body.responsiblePrincipalId)) fail('COLLABORATION_INPUT_INVALID', '责任人标识无效');
  if (noticeMatch && !['mark_read', 'mark_unread'].includes(String(body.command))) fail('COLLABORATION_INPUT_INVALID', '通知操作无效');
  return { status: 200, data: await options.store.transact(options.tenantId, tx => {
    member(tx, scope); const idemScope = `collaboration.${assignmentMatch ? 'assignment' : 'notification'}:${scope.workspaceId}:${scope.principalId}:${id}`, digest = sha256(body);
    const receipt = tx.getIdempotency(idemScope, key);
    if (receipt && receipt.requestDigest !== digest) fail('IDEMPOTENCY_KEY_REUSED', '幂等键已用于其他请求');
    let result: GoalAssignmentDetailV2 | InboxItemV2;
    if (assignmentMatch) {
      goal(tx, scope, id);
      if (receipt) return detail(tx, scope, receipt.response as Assignment);
      const current = stored(tx, scope, id);
      if (current.streamVersion !== body.expectedStreamVersion) fail('STREAM_VERSION_CONFLICT', '责任记录版本已变化');
      const responsiblePrincipalId = body.responsiblePrincipalId as string | null;
      if (responsiblePrincipalId && !describeMember(tx, scope, responsiblePrincipalId).available) fail('WORKSPACE_ACCESS_DENIED', '责任人当前不能访问此任务');
      const next: Assignment = { ...current, responsiblePrincipalId, streamVersion: current.streamVersion + 1, updatedAt: options.now(), updatedBy: options.principalId };
      tx.putProjection(ASSIGNMENT, id, next); event(tx, scope, ASSIGNMENT, id, current.streamVersion, 'goal.assignment_updated'); notify(tx, scope, next, 'assignment');
      tx.putIdempotency({ tenantId: options.tenantId, scope: idemScope, key, requestDigest: digest, response: next, createdAt: options.now() });
      result = detail(tx, scope, next);
    } else {
      const visible = readLocalNotifications(tx, options.tenantId, options.principalId, scope.workspaceId).find(n => n.id === id);
      if (!visible) fail('NOTIFICATION_NOT_FOUND', '通知不存在或已失效');
      if (receipt) return receipt.response as InboxItemV2;
      if (visible.streamVersion !== body.expectedStreamVersion) fail('STREAM_VERSION_CONFLICT', '通知状态已变化');
      const state: ReadState = { id: `${options.principalId}:${id}`, tenantId: options.tenantId, workspaceId: scope.workspaceId, principalId: options.principalId,
        readState: body.command === 'mark_read' ? 'read' : 'unread', streamVersion: Number(visible.streamVersion) + 1 };
      tx.putProjection(READ_STATE, state.id, state); event(tx, scope, READ_STATE, state.id, Number(visible.streamVersion), 'notification.read_state_updated');
      result = { ...visible, streamVersion: state.streamVersion, readState: state.readState, allowedActions: [state.readState === 'read' ? 'mark_unread' : 'mark_read'] };
      tx.putIdempotency({ tenantId: options.tenantId, scope: idemScope, key, requestDigest: digest, response: result, createdAt: options.now() });
    }
    return result;
  }) };
}
