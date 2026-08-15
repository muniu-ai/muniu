// SPDX-License-Identifier: Apache-2.0

import type { AgentSessionEventV1, CandidateId, RunId } from "@mn/agent-protocol";

import type { AgentSession as Session } from "@mn/agent-session";

import { withAgentRunLease } from "./run-lease.js";

export type AgentRunReason = "completed" | "cancelled" | "budget-exceeded" | "error";

export interface AgentRunInput {
  readonly session: Session;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly maxSteps?: number;
  readonly maxToolCalls?: number;
  readonly runId?: RunId;
  readonly candidateId?: CandidateId;
}

export interface AgentRunResult {
  readonly reason: AgentRunReason;
  readonly steps: number;
  readonly toolCalls: number;
  readonly lastEvent?: AgentSessionEventV1;
}

export interface AgentExecutor {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export class AgentRegistry {
  private readonly executors = new Map<string, AgentExecutor>();
  private sealed = false;

  register(id: string, executor: AgentExecutor): () => void {
    if (this.sealed) throw new Error("agent registry is sealed");
    if (id.length === 0) throw new Error("agent id must not be empty");
    const runMethod = executor.run;
    if (typeof runMethod !== "function") throw new Error("agent executor run must be a function");
    const run = runMethod.bind(executor);
    const stable: AgentExecutor = Object.freeze({ run });
    if (this.executors.has(id)) throw new Error(`agent "${id}" is already registered`);
    this.executors.set(id, stable);
    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      if (this.executors.get(id) === stable) this.executors.delete(id);
    };
  }

  seal(): void { this.sealed = true; }

  require(id: string): AgentExecutor {
    const executor = this.executors.get(id);
    if (executor === undefined) throw new Error(`agent "${id}" is not registered`);
    return executor;
  }
}

export interface RoutedAgentRunInput extends AgentRunInput {
  readonly agentId: string;
}

export class AgentKernel {
  constructor(private readonly registry: AgentRegistry) {}

  async run(input: RoutedAgentRunInput): Promise<AgentRunResult> {
    const executor = this.registry.require(input.agentId);
    const sessionId = input.session.header.sessionId;
    return withAgentRunLease(sessionId, "kernel", () => executor.run(input));
  }
}
