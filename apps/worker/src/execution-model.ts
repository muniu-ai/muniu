// SPDX-License-Identifier: Apache-2.0
import type { Execution } from "@mn/contracts";
import type { KernelTransaction } from "@mn/kernel";

export function resolveExecutionModel(tx: KernelTransaction, execution: Execution): {
  id: string; tenantId: string; presetId: string; secretRef: string; defaultModel: string; status: "pending" | "ready" | "invalid";
} | undefined {
  if (execution.runnerId && execution.runnerId !== "builtin" && execution.modelBindingId === `runner:${execution.runnerId}`) {
    return { id: execution.modelBindingId, tenantId: execution.tenantId, presetId: "external-cli", secretRef: "", defaultModel: "CLI 自有模型", status: "ready" };
  }
  return tx.getProjection("modelConnection", execution.modelBindingId);
}
