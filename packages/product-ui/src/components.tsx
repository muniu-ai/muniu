// SPDX-License-Identifier: Apache-2.0
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { AlertCircle, Inbox, LoaderCircle, X } from 'lucide-react';
import { EnterpriseApiFailure } from './client.js';
import { WorkspaceResource, type ResourceSnapshot } from './workspace-resource.js';
import { statusLabel } from './format.js';
export const UiActivityContext = createContext(false);
export const UiActivityGuardContext = createContext<() => boolean>(() => false);

export function useResource<T>(workspaceId: string, key: string, loader: (signal: AbortSignal) => Promise<T>, refreshOnFocus = true): ResourceSnapshot<T> & { reload: () => void } {
  const resource = useMemo(() => new WorkspaceResource<T>(), []), work = useRef(loader); work.current = loader;
  const scope = workspaceId + '\u0000' + key;
  const reload = useCallback(() => { void resource.load(scope, signal => work.current(signal)); }, [resource, scope]);
  useEffect(() => { reload(); const focus = () => { if (refreshOnFocus && document.visibilityState === 'visible') reload(); }; window.addEventListener('focus', focus); return () => { window.removeEventListener('focus', focus); resource.clear(); }; }, [reload, resource, refreshOnFocus]);
  const snapshot = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot);
  return { ...(snapshot.workspaceId === scope ? snapshot : { status: 'loading' as const }), reload };
}
export function errorMessage(error: unknown): string {
  if (!(error instanceof EnterpriseApiFailure)) return error instanceof Error && !/^[A-Z_]+$/u.test(error.message) ? error.message : '无法完成操作，请核对输入后重试。';
  if (error.unknownOutcome) return error.status === 403 ? '当前权限不足，原保存结果仍未确认。请联系管理员核对后再重试。' : '尚未确认保存结果。请重试原请求，系统会使用同一操作标识核对，避免重复保存。';
  const messages: Readonly<Record<string, string>> = {
    NETWORK_UNAVAILABLE: '无法连接服务，请检查网络后重新载入。', LOGOUT_UNCONFIRMED: '未能确认退出结果，请恢复连接后重试退出。',
    SESSION_CHANGED: '登录身份已变化，请重新载入后再操作。', AUTHENTICATION_REQUIRED: '请先登录企业账号。', SESSION_EXPIRED: '登录已过期，请重新登录。', SESSION_REVOKED: '当前登录已失效，请重新登录。',
    LAST_ADMINISTRATOR: '企业须至少保留一名有效的组织管理员。请先邀请另一名组织管理员，并由本人接受邀请后再办理。',
    SEPARATION_OF_DUTIES_REQUIRED: '制单人与批准人须为不同人员，请交由有权同事处理。', BUSINESS_APPROVAL_REQUIRED: '请先完成关联记录的业务批准。',
    SOURCE_VERSION_CONFLICT: '关联资料已更新，请重新载入并核对当前内容。', STREAM_VERSION_CONFLICT: '记录已更新，本次内容尚未保存。请重新载入后核对。',
    IDEMPOTENCY_KEY_REUSED: '原操作标识已经用于另一份内容，请重新载入并核对记录。', PROVIDER_NOT_RESPONSIBLE: '当前模式尚未接入这类业务记录。',
    KNOWLEDGE_SOURCE_WITHDRAWN: '资料已撤回，不能继续查看。', MODEL_QUOTA_UNCONFIGURED: '尚未配置模型额度。仍可管理业务记录。', WORKSPACE_LIMIT_EXCEEDED: '企业已有经营主体，请重新载入工作台。',
    INVALID_SERVICE_RESPONSE: '服务响应无法识别，请重新载入。', STALE_RESPONSE: '页面已切换，本次响应已忽略。',
  };
  return messages[error.code] ?? (error.status === 403 ? '当前账号无权完成此操作。请联系企业管理员核对业务权限。' : error.status === 404 ? '记录不存在，或当前账号无权查看。' : error.status === 409 ? '当前记录或关联资料不满足操作条件，请重新载入后核对。' : error.status >= 500 ? '服务暂时不可用，请稍后重新载入。' : '无法完成操作，请核对输入和当前权限。');
}
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <div className="mn-alert" role="alert"><p>{errorMessage(error)}</p>{onRetry && <button type="button" className="mn-link-button" onClick={onRetry}>重新载入</button>}{error instanceof EnterpriseApiFailure && error.traceId && <details className="mn-small"><summary>问题编号</summary>{error.traceId}</details>}</div>;
}
export function EmptyState({ title, detail, action, unavailable = false }: { title: string; detail?: string; action?: ReactNode; unavailable?: boolean }) {
  const Icon = unavailable ? AlertCircle : Inbox;
  return <div className="mn-state"><Icon className="mn-state-icon" size={30} aria-hidden="true" /><h2>{title}</h2>{detail && <p>{detail}</p>}{action}</div>;
}
export function LoadingState() { return <div className="mn-state" role="status"><LoaderCircle size={24} className="mn-state-icon" aria-hidden="true" /><p>正在载入…</p></div>; }
export function Status({ value }: { value: unknown }) {
  if (typeof value !== 'string' || !value) return <span className="mn-muted">—</span>;
  const good = ['active', 'approved', 'confirmed', 'accepted', 'completed', 'enabled'].includes(String(value)), bad = ['failed', 'cancelled', 'withdrawn', 'removed', 'disabled'].includes(String(value));
  return <span className={'mn-tag' + (good ? ' mn-tag-good' : bad ? ' mn-tag-bad' : ' mn-tag-wait')}>{statusLabel(value)}</span>;
}
export function PageHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) { return <div className="mn-page-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>; }
export function Dialog({ title, description, children, onClose, busy = false, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean }) {
  const activity = useContext(UiActivityContext); busy = busy || activity;
  const activityGuard = useContext(UiActivityGuardContext);
  const titleId = useId(), ref = useRef<HTMLDivElement>(null), close = useRef(onClose), active = useRef(busy); close.current = onClose; active.current = busy;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined, previousClass = document.body.classList.contains('mn-modal-open');
    document.body.classList.add('mn-modal-open'); ref.current?.focus();
    return () => { if (!previousClass) document.body.classList.remove('mn-modal-open'); previous?.focus(); };
  }, []);
  return <div className="mn-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy && !activityGuard()) onClose(); }}><div className={'mn-dialog' + (wide ? ' mn-dialog-wide' : '')} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref} onKeyDown={event => {
    if (event.key === 'Escape' && !active.current && !activityGuard()) { event.stopPropagation(); close.current(); }
    if (event.key !== 'Tab') return;
    const focusable = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])].filter(element => !element.hidden);
    const first = focusable[0], last = focusable.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}><header className="mn-dialog-header"><div><h2 id={titleId}>{title}</h2>{description && <p className="mn-small mn-muted">{description}</p>}</div><button className="mn-icon-button" type="button" aria-label="关闭对话框" disabled={busy} onClick={() => { if (!active.current && !activityGuard()) onClose(); }}><X size={20} aria-hidden="true" /></button></header><div className="mn-dialog-body">{children}</div></div></div>;
}
