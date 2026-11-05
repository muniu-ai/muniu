// SPDX-License-Identifier: Apache-2.0
export interface SubmissionWrite<T> { readonly key: string; readonly label?: string; readonly execute: (signal: AbortSignal) => Promise<T>; }
export interface SubmissionScope {
  read<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  write<T>(write: SubmissionWrite<T>): Promise<T>;
}
export interface SubmissionSnapshot {
  readonly busy: boolean;
  readonly status: 'idle' | 'running' | 'stopping' | 'stopped' | 'uncertain' | 'completed' | 'failed';
  readonly pendingKey?: string;
  readonly pendingLabel?: string;
  readonly confirmedKeys: readonly string[];
  readonly confirmedLabels: readonly string[];
}
interface Attempt { readonly controller: AbortController; stopped: boolean; }
const stopped = () => Object.assign(new Error('后续提交步骤已停止'), { code: 'SUBMISSION_STOPPED' });
const reconciliationRequired = () => Object.assign(new Error('请先核对原保存请求'), { code: 'SUBMISSION_RECONCILIATION_REQUIRED' });
function uncertain(error: unknown): boolean {
  return !!error && typeof error === 'object' && (('unknownOutcome' in error && error.unknownOutcome === true)
    || ('code' in error && error.code === 'STALE_RESPONSE') || ('status' in error && [401, 403].includes(Number(error.status))));
}
export class SubmissionChain {
  private value: SubmissionSnapshot = Object.freeze({ busy: false, status: 'idle', confirmedKeys: [], confirmedLabels: [] });
  private readonly listeners = new Set<() => void>(); private readonly confirmed = new Map<string, string>();
  private current?: Attempt; private pending?: SubmissionWrite<unknown>;
  readonly snapshot = (): SubmissionSnapshot => this.value;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(status: SubmissionSnapshot['status'], busy: boolean): void {
    this.value = Object.freeze({ status, busy, ...(this.pending ? { pendingKey: this.pending.key, pendingLabel: this.pending.label ?? '保存请求' } : {}), confirmedKeys: [...this.confirmed.keys()], confirmedLabels: [...this.confirmed.values()] });
    for (const listener of this.listeners) listener();
  }
  private active(attempt: Attempt): void { if (this.current !== attempt || attempt.stopped || attempt.controller.signal.aborted) throw stopped(); }
  cancel(): void {
    const attempt = this.current; if (!attempt) return;
    attempt.stopped = true; attempt.controller.abort(); this.publish(this.pending ? 'uncertain' : 'stopping', true);
  }
  async run<T>(work: (scope: SubmissionScope) => Promise<T>): Promise<T> {
    if (this.current) throw Object.assign(new Error('保存步骤仍在处理'), { code: 'SUBMISSION_BUSY' });
    const attempt: Attempt = { controller: new AbortController(), stopped: false }; this.current = attempt; this.publish('running', true);
    const scope: SubmissionScope = {
      read: async <R>(read: (signal: AbortSignal) => Promise<R>): Promise<R> => {
        this.active(attempt); if (this.pending) throw reconciliationRequired();
        const result = await read(attempt.controller.signal); this.active(attempt); return result;
      },
      write: async <R>(requested: SubmissionWrite<R>): Promise<R> => {
        this.active(attempt);
        if (this.pending && this.pending.key !== requested.key) throw reconciliationRequired();
        const priorUnknown = this.pending !== undefined, write: SubmissionWrite<unknown> = this.pending ?? requested;
        this.pending = write; this.publish('running', true);
        try {
          const result = await write.execute(attempt.controller.signal);
          this.active(attempt);
          this.pending = undefined; this.confirmed.set(write.key, write.label ?? '保存请求'); this.publish('running', true); return result as R;
        } catch (error) {
          if (!attempt.stopped && !attempt.controller.signal.aborted && !priorUnknown && !uncertain(error)) this.pending = undefined;
          throw error;
        }
      },
    };
    try { const result = await work(scope); this.active(attempt); this.current = undefined; this.publish('completed', false); return result; }
    catch (error) { this.current = undefined; this.publish(this.pending ? 'uncertain' : attempt.stopped ? 'stopped' : 'failed', false); if (attempt.stopped && !this.pending) throw stopped(); throw error; }
    finally { if (this.current === attempt) this.current = undefined; }
  }
  async retryPending(): Promise<unknown> {
    const pending = this.pending; if (!pending) throw reconciliationRequired();
    return this.run(scope => scope.write(pending));
  }
}
