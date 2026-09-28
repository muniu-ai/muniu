// SPDX-License-Identifier: Apache-2.0
import type { Execution } from "@mn/contracts";
import { KernelError } from "./errors.js";
import { appendKernelEvent } from "./projections.js";
import type { KernelTransaction } from "./store.js";

export interface ToolAdmission {
  readonly id: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly toolCallId: string;
  readonly generation: number;
  readonly status: "started" | "settled";
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Commit with dispatch or a confirmed result; exceptions never settle an admission. */
export function recordToolAdmission(transaction: KernelTransaction, execution: Execution,
  toolCallId: string, status: ToolAdmission["status"], occurredAt: string): void {
  const id = `${execution.id}:${toolCallId}`;
  const current = transaction.getProjection<ToolAdmission>("toolAdmission", id);
  if (status === "started" && current) {
    throw new KernelError("TOOL_ALREADY_ADMITTED", "工具调用已经准入，不能重复派发", "核对已有调用结果");
  }
  if (status === "settled" && (!current || current.status === "settled")) return;
  const next: ToolAdmission = { id, tenantId: execution.tenantId, executionId: execution.id,
    toolCallId, generation: current?.generation ?? execution.generation, status,
    streamVersion: (current?.streamVersion ?? 0) + 1, createdAt: current?.createdAt ?? occurredAt, updatedAt: occurredAt };
  transaction.putProjection("toolAdmission", id, next);
  appendKernelEvent(transaction, { tenantId: execution.tenantId, aggregateType: "toolAdmission", aggregateId: id,
    expectedStreamVersion: current?.streamVersion ?? 0, type: `tool_admission.${status}`,
    actorId: execution.executionPrincipalId, executionId: execution.id, generation: next.generation,
    correlationId: execution.id, publicPayload: { toolCallId, status } });
}
