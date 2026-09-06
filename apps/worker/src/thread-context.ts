// SPDX-License-Identifier: Apache-2.0
import type { ModelMessage, RuntimeStore } from "@mn/agent-runtime";
import type { Execution } from "@mn/contracts";
import type { KernelStore } from "@mn/kernel";

interface ThreadTurn {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly executionId: string;
  readonly threadStreamVersion: number;
}

/** History changes the model surface only; the model request persists its exact view. */
export async function readThreadHistory(store: KernelStore, runtime: RuntimeStore, execution: Execution): Promise<readonly ModelMessage[]> {
  const turns = await store.transact(execution.tenantId, tx => tx.listProjections<ThreadTurn>("session-log-entry")
    .filter(turn => turn.tenantId === execution.tenantId && turn.workspaceId === execution.workspaceId
      && turn.threadId === execution.threadId));
  const current = turns.find(turn => turn.executionId === execution.id);
  if (!current) return [];
  if (!Number.isSafeInteger(current.threadStreamVersion)) throw new Error("会话轮次缺少持久化顺序");
  const prior = turns.filter(turn => Number.isSafeInteger(turn.threadStreamVersion)
    && turn.threadStreamVersion < current.threadStreamVersion)
    .sort((left, right) => left.threadStreamVersion - right.threadStreamVersion)
    .map(turn => turn.executionId);
  const messages: ModelMessage[] = [];
  for (const id of prior) {
    const previous = await store.transact(execution.tenantId, (transaction) => transaction.getProjection<Execution>("execution", id));
    if (!previous || previous.threadId !== execution.threadId || previous.workspaceId !== execution.workspaceId
      || previous.pluginId !== execution.pluginId || previous.status !== "completed") continue;
    for (const record of await runtime.readExecution(id)) {
      const entry = record.payload;
      if (record.type === "session/entry" && entry.modelVisible !== false && typeof entry.content === "string"
        && (entry.role === "user" || entry.role === "assistant")) messages.push({ role: entry.role, content: entry.content });
    }
  }
  return messages;
}
