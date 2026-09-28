// SPDX-License-Identifier: Apache-2.0

import { RuntimeControlError, type ToolApprovalPort } from "@mn/agent-runtime";
import type { Approval, Execution, ToolCallIntent, ToolCallCommitment } from "@mn/contracts";

import { assertCurrentApprovalAuthorization, assertCurrentExecutionAuthorization } from "@mn/kernel";

export interface ToolApprovalKernel {
  requestToolApproval(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    intent: ToolCallIntent,
  ): Promise<
    | { readonly mode: "auto"; readonly intent: ToolCallCommitment }
    | { readonly mode: "approval"; readonly approval: Approval }
  >;
}

export interface ApprovalProjectionStore {
  transact<T>(
    tenantId: string,
    work: (transaction: {
      getProjection<U>(namespace: string, id: string): U | undefined;
    }) => T,
  ): Promise<T>;
}

export interface KernelToolApprovalPortOptions {
  readonly tenantId: string;
  readonly actorId: string;
  readonly kernel: ToolApprovalKernel;
  readonly store: ApprovalProjectionStore;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
}

export function createKernelToolApprovalPort(
  options: KernelToolApprovalPortOptions,
): ToolApprovalPort {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError("审批轮询间隔必须是正整数毫秒");
  }
  return {
    async authorize(intent, signal) {
      if (signal.aborted) throw new Error("工具审批等待已取消");
      const assertCurrentAuthorization = async () => {
        const control = await options.store.transact(options.tenantId, tx => {
          const execution = tx.getProjection<Execution>("execution", intent.executionId);
          if (!execution) throw new Error("Execution 不存在");
          if (execution.generation !== intent.generation) throw new Error("工具调用来自旧执行代次");
          if (execution.status === "cancelled" || execution.status === "paused" || execution.status === "interrupted") {
            throw new RuntimeControlError(execution.status);
          }
          assertCurrentExecutionAuthorization(tx, execution);
          return tx.getProjection<{ generation: number; command: string }>("execution-control", intent.executionId);
        });
        if (control?.generation === intent.generation && control.command === "interrupt") throw new RuntimeControlError("interrupted");
      };
      await assertCurrentAuthorization();
      const requested = await options.kernel.requestToolApproval(
        options.tenantId,
        options.actorId,
        `agent-runtime:${intent.executionId}:${intent.generation}:${intent.id}`,
        intent,
      );
      if (requested.mode === "auto") return requested;
      while (true) {
        if (signal.aborted) throw new Error("工具审批等待已取消");
        await assertCurrentAuthorization();
        const state = await options.store.transact(options.tenantId, (transaction) => {
          const approval = transaction.getProjection<Approval>("approval", requested.approval.id);
          if (approval?.status === "approved_once") assertCurrentApprovalAuthorization(transaction, approval);
          return { approval, persistedIntent: transaction.getProjection<ToolCallCommitment>("toolIntent", intent.id) };
        });
        if (!state.approval) throw new Error("持久化批准请求不存在");
        if (state.approval.status === "approved_once") {
          if (!state.persistedIntent) throw new Error("持久化工具调用意图不存在");
          return { mode: "approve_once", approvedIntent: state.persistedIntent };
        }
        if (state.approval.status === "denied") {
          return { mode: "deny", reason: "工具调用已被用户拒绝" };
        }
        if (state.approval.status === "expired" || Date.parse(state.approval.expiresAt) <= now()) {
          return { mode: "deny", reason: "工具调用批准已过期" };
        }
        await abortableApprovalDelay(pollIntervalMs, signal);
      }
    },
  };
}

async function abortableApprovalDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("工具审批等待已取消");
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("工具审批等待已取消"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
