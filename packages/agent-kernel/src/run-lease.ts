// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

export type AgentRunBoundary = "kernel" | "driver";

interface DelegatedRunSettlement {
  readonly status: "fulfilled" | "rejected";
  readonly reason?: unknown;
}

interface AgentRunDelegation {
  open: boolean;
  consumed: boolean;
  readonly pending: Array<Promise<DelegatedRunSettlement>>;
}

interface AgentRunLeaseOwner {
  readonly sessionId: string;
  readonly boundary: AgentRunBoundary;
  readonly delegation?: AgentRunDelegation;
  active: boolean;
}

interface AgentRunLeaseContext {
  readonly owner: AgentRunLeaseOwner;
  readonly boundary: AgentRunBoundary;
}

const ACTIVE_SESSION_RUNS = new Map<string, AgentRunLeaseOwner>();
const ACTIVE_RUN_CONTEXT = new AsyncLocalStorage<AgentRunLeaseContext>();

function activeRunError(sessionId: string): Error {
  return new Error(`session "${sessionId}" already has an active agent run`);
}

function delegatedRun<T>(
  owner: AgentRunLeaseOwner,
  operation: () => Promise<T>
): Promise<T> {
  const context = ACTIVE_RUN_CONTEXT.getStore();
  const delegation = owner.delegation;
  if (!owner.active
    || delegation === undefined
    || !delegation.open
    || delegation.consumed
    || context?.owner !== owner
    || context.boundary !== "kernel") {
    return Promise.reject(activeRunError(owner.sessionId));
  }

  delegation.consumed = true;
  let delegated: Promise<T>;
  try {
    delegated = Promise.resolve(ACTIVE_RUN_CONTEXT.run({ owner, boundary: "driver" }, operation));
  } catch (error: unknown) {
    delegated = Promise.reject(error);
  }
  delegation.pending.push(delegated.then(
    () => ({ status: "fulfilled" }),
    (reason: unknown) => ({ status: "rejected", reason })
  ));
  return delegated;
}

async function ownedRun<T>(
  owner: AgentRunLeaseOwner,
  operation: () => Promise<T>
): Promise<T> {
  let result!: T;
  let primaryFailure: unknown;
  let primaryFailed = false;
  let delegatedFailures: unknown[] = [];
  try {
    try {
      result = await ACTIVE_RUN_CONTEXT.run({ owner, boundary: owner.boundary }, operation);
    } catch (error: unknown) {
      primaryFailed = true;
      primaryFailure = error;
    }

    const delegation = owner.delegation;
    if (delegation !== undefined) {
      delegation.open = false;
      const settlements = await Promise.all(delegation.pending);
      delegatedFailures = settlements.flatMap((settlement) => {
        return settlement.status === "rejected" ? [settlement.reason] : [];
      });
    }
  } finally {
    owner.active = false;
    if (ACTIVE_SESSION_RUNS.get(owner.sessionId) === owner) {
      ACTIVE_SESSION_RUNS.delete(owner.sessionId);
    }
  }

  if (primaryFailed) {
    const additionalFailures = delegatedFailures.filter((failure) => failure !== primaryFailure);
    if (additionalFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...additionalFailures],
        `session "${owner.sessionId}" agent run and delegated driver both failed`,
        { cause: primaryFailure }
      );
    }
    throw primaryFailure;
  }
  if (delegatedFailures.length === 1) throw delegatedFailures[0];
  if (delegatedFailures.length > 1) {
    throw new AggregateError(delegatedFailures, `session "${owner.sessionId}" delegated drivers failed`);
  }
  return result;
}

export function withAgentRunLease<T>(
  sessionId: string,
  boundary: AgentRunBoundary,
  operation: () => Promise<T>
): Promise<T> {
  const currentOwner = ACTIVE_SESSION_RUNS.get(sessionId);
  if (currentOwner !== undefined) {
    if (boundary === "driver") return delegatedRun(currentOwner, operation);
    return Promise.reject(activeRunError(sessionId));
  }

  const inherited = ACTIVE_RUN_CONTEXT.getStore();
  if (inherited?.owner.sessionId === sessionId) {
    return Promise.reject(activeRunError(sessionId));
  }

  const owner: AgentRunLeaseOwner = {
    sessionId,
    boundary,
    active: true,
    ...(boundary === "kernel"
      ? { delegation: { open: true, consumed: false, pending: [] } }
      : {})
  };
  ACTIVE_SESSION_RUNS.set(sessionId, owner);
  return ownedRun(owner, operation);
}
