// SPDX-License-Identifier: Apache-2.0

export type LifecycleDisposer = () => void | Promise<void>;

/** A small, static lifecycle owner with deterministic LIFO rollback. */
export class LifecycleScope {
  private readonly disposers: LifecycleDisposer[] = [];
  private closed = false;
  private disposal: Promise<void> | undefined;

  defer(disposer: LifecycleDisposer): LifecycleDisposer {
    if (this.closed) throw new Error("lifecycle scope is closed");
    if (typeof disposer !== "function") throw new TypeError("lifecycle disposer must be a function");
    let active = true;
    const once = async (): Promise<void> => {
      if (!active) return;
      active = false;
      await disposer();
    };
    this.disposers.push(once);
    return once;
  }

  child(): LifecycleScope {
    const child = new LifecycleScope();
    this.defer(() => child.dispose());
    return child;
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.closed = true;
    this.disposal = this.disposeAll();
    return this.disposal;
  }

  private async disposeAll(): Promise<void> {
    const errors: unknown[] = [];
    while (this.disposers.length > 0) {
      const disposer = this.disposers.pop();
      if (disposer === undefined) continue;
      try {
        await disposer();
      } catch (error: unknown) {
        if (error instanceof AggregateError) errors.push(...error.errors);
        else errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "lifecycle scope disposal failed");
  }
}
