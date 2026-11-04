// SPDX-License-Identifier: Apache-2.0
const reads = new Set(['getProjection', 'listProjections', 'getIdempotency', 'getStreamVersion', 'assertJobLease']);
/** Guards run after asynchronous preparation; retained handles cannot mutate a closing transaction. */
export function guardedTransaction<T extends object>(target: T) {
    let phase: 'work' | 'validation' | 'closed' = 'work';
    const guards: (() => void)[] = [];
    const transaction = new Proxy({ ...target, beforeCommit(check: () => void) {
            if (phase !== 'work')
                throw new Error('TRANSACTION_GUARD_READ_ONLY');
            if (typeof check !== 'function' || check.constructor.name === 'AsyncFunction')
                throw new TypeError('TRANSACTION_GUARD_INVALID');
            guards.push(check);
        } }, { get(object, property, receiver) {
            const value: unknown = Reflect.get(object, property, receiver);
            if (typeof value !== 'function')
                return value;
            return (...args: unknown[]) => {
                if (phase === 'closed')
                    throw new Error('TRANSACTION_CLOSED');
                if (phase === 'validation' && !reads.has(String(property)))
                    throw new Error('TRANSACTION_GUARD_READ_ONLY');
                const result: unknown = Reflect.apply(value, object, args);
                return phase === 'validation' ? structuredClone(result) : result;
            };
        } });
    return { transaction, validate() {
            phase = 'validation';
            for (const guard of guards) {
                const result: unknown = guard();
                if (result !== undefined) {
                    if (result instanceof Promise)
                        void result.catch(() => { });
                    throw new TypeError('TRANSACTION_GUARD_INVALID');
                }
            }
        }, close() { phase = 'closed'; guards.length = 0; } };
}
