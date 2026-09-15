// SPDX-License-Identifier: Apache-2.0
import type { RuntimeStore } from "./types.js";
import { ExecutionBudgetExceededError } from "@mn/contracts";
export { ExecutionBudgetExceededError } from "@mn/contracts";

export class PersistentExecutionBudget {
  constructor(readonly options: {
    readonly store: RuntimeStore;
    readonly executionId: string;
    readonly maxDurationMs: number;
    readonly now?: () => number;
  }) {
    if (!Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs < 0) {
      throw new TypeError("执行时间预算必须为非负整数毫秒");
    }
  }

  async remainingMilliseconds(): Promise<number> {
    const { store, executionId, maxDurationMs } = this.options;
    for (;;) {
      const records = await store.readExecution(executionId);
      const start = records.find(record => record.type === "budget/started");
      const now = (this.options.now ?? Date.now)();
      if (!Number.isSafeInteger(now)) throw new TypeError("执行预算时钟无效");
      if (!start) {
        const saved = await store.commit(executionId, records.at(-1)?.sequence ?? 0, [{ executionId,
          type: "budget/started", payload: { startedAtMs: now, maxDurationMs } }]);
        if (saved) {
          if (maxDurationMs === 0) throw new ExecutionBudgetExceededError("duration");
          return maxDurationMs;
        }
        continue;
      }
      const startedAt = Number(start.payload.startedAtMs);
      const originalLimit = Number(start.payload.maxDurationMs);
      if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(originalLimit) || originalLimit < 0 || now < startedAt) {
        throw new Error("持久化预算或时钟无效，已拒绝继续执行");
      }
      const remaining = Math.min(originalLimit, maxDurationMs) - (now - startedAt);
      if (remaining <= 0) throw new ExecutionBudgetExceededError("duration");
      return remaining;
    }
  }

  async counter(kind: "coding_repair"): Promise<number> {
    const records = await this.options.store.readExecution(this.options.executionId);
    return records.filter(record => record.type === "budget/reserved" && record.payload.kind === kind).length;
  }

  async reserveCounter(kind: "coding_repair", id: string, limit: number): Promise<void> {
    if (!id || !Number.isSafeInteger(limit) || limit < 0) throw new TypeError("执行预算预留参数无效");
    const { store, executionId } = this.options;
    for (;;) {
      const records = await store.readExecution(executionId);
      const reservations = records.filter(record => record.type === "budget/reserved" && record.payload.kind === kind);
      if (reservations.some(record => record.payload.id === id)) return;
      if (reservations.length >= limit) throw new ExecutionBudgetExceededError(kind);
      const saved = await store.commit(executionId, records.at(-1)?.sequence ?? 0, [{ executionId,
        type: "budget/reserved", payload: { kind, id, ordinal: reservations.length + 1, limit } }]);
      if (saved) return;
    }
  }
}
