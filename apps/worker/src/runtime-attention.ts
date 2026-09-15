// SPDX-License-Identifier: Apache-2.0
import { ExecutionBudgetExceededError, type Execution } from "@mn/contracts";
import type { RuntimeRecord } from "@mn/agent-runtime";
import { appendKernelEvent, type InboxItem, type KernelTransaction } from "@mn/kernel";

const budgetReasons = new Set(["duration", "coding_repair", "tokens", "cost", "model_unknown", "model_overrun"]
  .map(dimension => new ExecutionBudgetExceededError(dimension as ExecutionBudgetExceededError["dimension"]).message));

export function recordRuntimeAttention(tx: KernelTransaction, execution: Execution, records: readonly RuntimeRecord[]): void {
  const transition = records.filter(record => record.type === "execution/status").at(-1);
  if (transition?.payload.status !== "paused") return;
  const reason = transition.payload.reason;
  const summary = typeof reason === "string" && budgetReasons.has(reason)
    ? reason : "执行已暂停。请打开关联会话，审阅现有成果和下一步。";
  const item: InboxItem = { id: `runtime-pause:${execution.id}:${transition.id}`,
    tenantId: execution.tenantId, workspaceId: execution.workspaceId, executionId: execution.id,
    kind: "agent_question", title: "执行已暂停，需要决定下一步", summary,
    status: "open", createdAt: transition.occurredAt };
  tx.putProjection("inbox", item.id, item);
  appendKernelEvent(tx, { tenantId: execution.tenantId, aggregateType: "runtimePause", aggregateId: item.id,
    expectedStreamVersion: 0, type: "runtime.pause_attention", actorId: execution.executionPrincipalId,
    executionId: execution.id, generation: execution.generation, correlationId: execution.id,
    publicPayload: { workspaceId: execution.workspaceId, inboxId: item.id } });
}
