// SPDX-License-Identifier: Apache-2.0
import type { Approval } from "@mn/contracts";
import type { InboxItem } from "./models.js";
import type { KernelTransaction } from "./store.js";
import { appendKernelEvent } from "./projections.js";

export function expireExecutionApprovals(transaction: KernelTransaction, input: {
  readonly tenantId: string; readonly executionId: string; readonly generation: number;
  readonly actorId: string; readonly occurredAt: string; readonly reason: string;
}): void {
  for (const approval of transaction.listProjections<Approval>("approval")) {
    if (approval.executionId !== input.executionId || !["pending", "approved_once"].includes(approval.status)) continue;
    transaction.putProjection("approval", approval.id, { ...approval, status: "expired",
      streamVersion: approval.streamVersion + 1, updatedAt: input.occurredAt });
    const inboxId = `approval:${approval.id}`;
    const inbox = transaction.getProjection<InboxItem>("inbox", inboxId);
    if (inbox) transaction.putProjection("inbox", inboxId, { ...inbox, status: "resolved" });
    appendKernelEvent(transaction, {
      tenantId: input.tenantId, aggregateType: "approval", aggregateId: approval.id,
      expectedStreamVersion: approval.streamVersion, type: "approval.expired", actorId: input.actorId,
      executionId: input.executionId, generation: input.generation,
      correlationId: input.executionId,
      publicPayload: { toolCallId: approval.toolCallId, reason: input.reason },
    });
  }
}
