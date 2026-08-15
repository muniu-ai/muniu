// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

export type AgentRunBoundary = "kernel" | "driver";

interface AgentRunLeaseContext {
  readonly sessionId: string;
  readonly owner: symbol;
  readonly boundary: AgentRunBoundary;
}

const ACTIVE_SESSION_RUNS = new Map<string, symbol>();
const ACTIVE_RUN_CONTEXT = new AsyncLocalStorage<AgentRunLeaseContext>();

export async function withAgentRunLease<T>(
  sessionId: string,
  boundary: AgentRunBoundary,
  operation: () => Promise<T>
): Promise<T> {
  const currentOwner = ACTIVE_SESSION_RUNS.get(sessionId);
  if (currentOwner !== undefined) {
    const context = ACTIVE_RUN_CONTEXT.getStore();
    if (boundary === "driver"
      && context?.boundary === "kernel"
      && context.sessionId === sessionId
      && context.owner === currentOwner) {
      return ACTIVE_RUN_CONTEXT.run({ sessionId, owner: currentOwner, boundary }, operation);
    }
    throw new Error(`session "${sessionId}" already has an active agent run`);
  }

  const owner = Symbol(sessionId);
  ACTIVE_SESSION_RUNS.set(sessionId, owner);
  try {
    return await ACTIVE_RUN_CONTEXT.run({ sessionId, owner, boundary }, operation);
  } finally {
    if (ACTIVE_SESSION_RUNS.get(sessionId) === owner) ACTIVE_SESSION_RUNS.delete(sessionId);
  }
}
