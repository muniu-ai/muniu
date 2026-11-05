// SPDX-License-Identifier: Apache-2.0
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { EnterpriseApiFailure } from './client.js';
import { ErrorNotice, UiActivityContext, UiActivityGuardContext } from './components.js';
import { SubmissionChain, type SubmissionScope } from './submission-chain.js';

interface Entry { readonly id: number; readonly chain: SubmissionChain; readonly label: string; readonly scope: string; attached: boolean; unsubscribe: () => void; error?: unknown; }
interface RegistrySnapshot { readonly busy: boolean; readonly pending: readonly Entry[]; readonly notice?: string; }
class SubmissionRegistry {
  private readonly entries = new Map<SubmissionChain, Entry>(); private readonly listeners = new Set<() => void>(); private serial = 0; private closed = false;
  private value: RegistrySnapshot = { busy: false, pending: [] }; private notice?: string;
  readonly snapshot = () => this.value;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly isBusy = () => [...this.entries.keys()].some(chain => chain.snapshot().busy);
  has(chain: SubmissionChain): boolean { return this.entries.has(chain); }
  enable(): void { this.closed = false; this.update(); }
  assertCapacity(chain: SubmissionChain): void {
    if (!chain.snapshot().pendingKey && [...this.entries.values()].filter(entry => entry.chain.snapshot().pendingKey).length >= 8) throw new Error('已有多项保存结果尚未确认，请先核对原请求后继续');
  }
  private update(): void {
    if (this.closed) return;
    for (const entry of this.entries.values()) {
      const state = entry.chain.snapshot();
      if (!entry.attached && !state.busy && !state.pendingKey) {
        if (['stopped', 'failed'].includes(state.status) && state.confirmedLabels.length) this.notice = '后续步骤未完成；已保存的' + [...new Set(state.confirmedLabels)].join('、') + '仍保留，请在业务记录中核对。';
        entry.unsubscribe(); this.entries.delete(entry.chain);
      }
    }
    this.value = { busy: this.isBusy(), pending: [...this.entries.values()].filter(entry => !entry.attached && entry.chain.snapshot().pendingKey !== undefined), ...(this.notice ? { notice: this.notice } : {}) };
    for (const listener of this.listeners) listener();
  }
  attach(chain: SubmissionChain, label: string, scope: string): () => void {
    if (this.closed) return () => chain.cancel();
    let entry = this.entries.get(chain);
    if (!entry) { entry = { id: ++this.serial, chain, label, scope, attached: true, unsubscribe: () => {} }; this.entries.set(chain, entry); entry.unsubscribe = chain.subscribe(() => this.update()); }
    else entry.attached = true;
    this.update();
    return () => { if (!entry) return; entry.attached = false; chain.cancel(); this.update(); };
  }
  async retry(entry: Entry): Promise<void> {
    if (this.closed || !this.entries.has(entry.chain)) return;
    entry.error = undefined;
    try { await entry.chain.retryPending(); this.notice = '原保存请求已确认。未启动的后续步骤不会自动继续，请重新载入相关业务记录。'; }
    catch (error) { entry.error = submissionError(error, entry.chain); }
    this.update();
  }
  clearNotice(): void { this.notice = undefined; this.update(); }
  dispose(): void { this.closed = true; for (const entry of this.entries.values()) { entry.unsubscribe(); entry.chain.cancel(); } this.entries.clear(); this.listeners.clear(); }
}
const SubmissionContext = createContext<{ registry: SubmissionRegistry; scope: string } | undefined>(undefined);
export function submissionError(error: unknown, chain: SubmissionChain): unknown {
  return chain.snapshot().pendingKey ? new EnterpriseApiFailure({ status: error instanceof EnterpriseApiFailure ? error.status : 0, code: error instanceof EnterpriseApiFailure ? error.code : 'WRITE_RESULT_UNKNOWN', traceId: error instanceof EnterpriseApiFailure ? error.traceId : undefined, unknownOutcome: true }) : error;
}
export function SubmissionProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [registry] = useState(() => new SubmissionRegistry()), state = useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot);
  const activity = useContext(UiActivityContext), inheritedGuard = useContext(UiActivityGuardContext), guard = useCallback(() => inheritedGuard() || registry.isBusy(), [inheritedGuard, registry]);
  useEffect(() => { registry.enable(); return () => registry.dispose(); }, [registry]);
  return <SubmissionContext.Provider value={{ registry, scope }}><UiActivityContext.Provider value={activity || state.busy}><UiActivityGuardContext.Provider value={guard}><div className="mn-submission-scope" aria-busy={state.busy}>{children}</div>
    {(state.pending.length > 0 || state.notice) && <aside className="mn-pending-saves" aria-label="保存结果核对">{state.pending.map(entry => <div className="mn-pending-save" key={entry.id}><h3>{entry.scope} · {entry.chain.snapshot().pendingLabel ?? entry.label}</h3><p>原请求可能已经保存，关闭页面不代表取消。重试仍使用原内容，避免重复保存。</p>{entry.error !== undefined && <ErrorNotice error={entry.error} />}<button type="button" className="mn-button-secondary" disabled={entry.chain.snapshot().busy} onClick={() => void registry.retry(entry)}>{entry.chain.snapshot().busy ? '正在核对…' : '重试原保存'}</button></div>)}{state.notice && <div className="mn-pending-save"><p role="status">{state.notice}</p><button type="button" className="mn-link-button" onClick={() => registry.clearNotice()}>知道了</button></div>}</aside>}
  </UiActivityGuardContext.Provider></UiActivityContext.Provider></SubmissionContext.Provider>;
}
export function useSubmission(label: string) {
  const context = useContext(SubmissionContext), [chain] = useState(() => new SubmissionChain()), mounted = useRef(true);
  const registry = context?.registry, scope = context?.scope ?? '当前企业';
  const detach = useRef<(() => void) | undefined>(undefined);
  useEffect(() => { mounted.current = true; detach.current = registry?.attach(chain, label, scope); return () => { mounted.current = false; chain.cancel(); detach.current?.(); detach.current = undefined; }; }, [registry, chain, label, scope]);
  const state = useSyncExternalStore(chain.subscribe, chain.snapshot, chain.snapshot);
  const run = useCallback(async <T,>(work: (submission: SubmissionScope) => Promise<T>): Promise<T> => {
    if (!mounted.current) throw Object.assign(new Error('页面已关闭'), { code: 'SUBMISSION_STOPPED' });
    if (registry && !registry.has(chain)) detach.current = registry.attach(chain, label, scope);
    registry?.assertCapacity(chain);
    return chain.run(work);
  }, [chain, registry, label, scope]);
  return { chain, run, busy: state.busy, uncertain: state.pendingKey !== undefined && !state.busy, isMounted: () => mounted.current };
}
