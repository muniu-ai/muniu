// SPDX-License-Identifier: Apache-2.0

/** SQLite uses one connection: no operation may observe an uncommitted async CAS flush. */
export function serializeAsyncMethods<T extends object>(target: T, names: readonly (keyof T)[]): void {
  let tail: Promise<unknown> = Promise.resolve();
  for (const name of names) {
    const method = target[name];
    if (typeof method !== "function") throw new TypeError(`Invalid serialized storage method ${String(name)}`);
    Object.defineProperty(target, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        const pending = tail.then(() => Reflect.apply(method, target, args));
        tail = pending.catch(() => undefined);
        return pending;
      },
    });
  }
}
