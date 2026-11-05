// SPDX-License-Identifier: Apache-2.0
export interface ResourceSnapshot<T> { readonly workspaceId?: string; readonly status: 'idle' | 'loading' | 'ready' | 'error'; readonly data?: T; readonly error?: unknown; }
export class WorkspaceResource<T> {
  private value: ResourceSnapshot<T> = { status: 'idle' }; private controller?: AbortController; private generation = 0;
  private readonly listeners = new Set<() => void>();
  readonly snapshot = (): ResourceSnapshot<T> => this.value;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: ResourceSnapshot<T>): void { this.value = value; for (const listener of this.listeners) listener(); }
  clear(): void { this.generation++; this.controller?.abort(); this.controller = undefined; this.publish({ status: 'idle' }); }
  async load(workspaceId: string, work: (signal: AbortSignal) => Promise<T>): Promise<void> {
    this.controller?.abort(); const controller = new AbortController(), generation = ++this.generation;
    this.controller = controller; this.publish({ workspaceId, status: 'loading' });
    try {
      const data = await work(controller.signal);
      if (generation === this.generation && !controller.signal.aborted) this.publish({ workspaceId, status: 'ready', data });
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) this.publish({ workspaceId, status: 'error', error });
    }
  }
}
