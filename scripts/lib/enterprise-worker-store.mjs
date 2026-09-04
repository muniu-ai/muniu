// SPDX-License-Identifier: Apache-2.0

function method(target, name) {
  if (typeof target?.[name] !== "function") {
    throw new TypeError(`企业 Worker store 缺少 ${name}`);
  }
  return (...args) => target[name](...args);
}

/**
 * Agent Runtime needs Kernel transactions while the worker loop needs physical
 * Job leasing. Both adapters share one PostgreSQL database and are exposed as
 * a single capability so a handler cannot accidentally persist runtime state
 * through a different authority store.
 */
export function createEnterpriseWorkerStore({ kernelStore, jobStore }) {
  return Object.freeze({
    transact: method(kernelStore, "transact"),
    readEvents: method(kernelStore, "readEvents"),
    listTenantIds: typeof kernelStore?.listTenantIds === "function"
      ? method(kernelStore, "listTenantIds")
      : undefined,
    claimJob: method(jobStore, "claimJob"),
    renewJobLease: method(jobStore, "renewJobLease"),
    completeJob: method(jobStore, "completeJob"),
    failJob: method(jobStore, "failJob"),
    interruptJob: method(jobStore, "interruptJob"),
    markNeedsReconciliation: method(jobStore, "markNeedsReconciliation"),
  });
}
