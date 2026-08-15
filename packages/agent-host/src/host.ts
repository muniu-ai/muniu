// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

import {
  AgentKernel,
  AgentRegistry,
  LifecycleScope,
  StaticSystemPrompt,
  createBuiltinAgentKernel,
  type AgentRunReason
} from "@mn/agent-kernel";
import { LlmRuntime, type LlmAdapter } from "@mn/agent-llm";
import type { CandidateId, RunId, SessionId } from "@mn/agent-protocol";
import {
  InMemoryAgentSessionStore,
  type AgentSession,
  type AgentSessionStore
} from "@mn/agent-session";
import {
  ToolRegistry,
  type ToolAuthorizer,
  type ToolDefinition
} from "@mn/agent-tools";

export interface AgentHostOptions {
  readonly adapters: readonly LlmAdapter[];
  readonly tools: readonly ToolDefinition[];
  readonly authorizer: ToolAuthorizer;
  readonly sessionStore?: AgentSessionStore;
  readonly systemPrompt?: StaticSystemPrompt;
}

export interface AgentHostRunInput {
  readonly sessionId?: SessionId;
  readonly cwd?: string;
  readonly labels?: Record<string, string>;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly maxSteps?: number;
  readonly maxToolCalls?: number;
  readonly runId?: RunId;
  readonly candidateId?: CandidateId;
}

export interface AgentHostRunResult {
  readonly session: AgentSession;
  readonly reason: AgentRunReason;
  readonly steps: number;
  readonly toolCalls: number;
}

interface ActiveHostRunContext {
  readonly host: AgentHost;
  active: boolean;
}

interface ActiveHostRun {
  readonly controller: AbortController;
  readonly operation: Promise<AgentHostRunResult>;
}

const ACTIVE_HOST_RUN = new AsyncLocalStorage<ActiveHostRunContext>();

function bindExternalSignal(
  external: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (external === undefined) return () => {};
  const addEventListener = external.addEventListener;
  const removeEventListener = external.removeEventListener;
  if (typeof addEventListener !== "function" || typeof removeEventListener !== "function") {
    throw new TypeError("agent host run signal must be an AbortSignal");
  }
  const abort = (): void => { controller.abort(external.reason); };
  if (external.aborted) {
    abort();
    return () => {};
  }
  addEventListener.call(external, "abort", abort, { once: true });
  return (): void => { removeEventListener.call(external, "abort", abort); };
}

function stableSessionStore(
  source: AgentSessionStore,
  lifecycle: LifecycleScope
): AgentSessionStore {
  if ((typeof source !== "object" && typeof source !== "function") || source === null) {
    throw new TypeError("agent session store must be an object");
  }

  const disposeMethod = source.dispose;
  if (disposeMethod !== undefined && typeof disposeMethod !== "function") {
    throw new TypeError("agent session store dispose must be a function");
  }
  const dispose = disposeMethod?.bind(source);
  if (dispose !== undefined) lifecycle.defer(dispose);

  const createMethod = source.create;
  const openMethod = source.open;
  if (typeof createMethod !== "function") {
    throw new TypeError("agent session store create must be a function");
  }
  if (typeof openMethod !== "function") {
    throw new TypeError("agent session store open must be a function");
  }
  return Object.freeze({
    create: createMethod.bind(source),
    open: openMethod.bind(source),
    ...(dispose === undefined ? {} : { dispose })
  });
}

function rollbackFailures(error: unknown): unknown[] {
  return error instanceof AggregateError ? [...error.errors] : [error];
}

export class AgentHost {
  private acceptingRuns = true;
  private readonly activeRuns = new Set<ActiveHostRun>();
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly kernel: AgentKernel,
    private readonly sessions: AgentSessionStore,
    private readonly lifecycle: LifecycleScope
  ) {}

  run(input: AgentHostRunInput): Promise<AgentHostRunResult> {
    if (!this.acceptingRuns) return Promise.reject(new Error("agent host is disposed"));
    const controller = new AbortController();
    let removeExternalListener: () => void;
    try {
      removeExternalListener = bindExternalSignal(input.signal, controller);
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    const context: ActiveHostRunContext = { host: this, active: true };
    let start!: () => void;
    const startGate = new Promise<void>((resolve) => { start = resolve; });
    let active!: ActiveHostRun;
    const operation = startGate
      .then(() => ACTIVE_HOST_RUN.run(context, () => this.runInternal(input, controller.signal)))
      .finally(() => {
        context.active = false;
        removeExternalListener();
        this.activeRuns.delete(active);
      });
    active = { controller, operation };
    this.activeRuns.add(active);
    start();
    return operation;
  }

  private async runInternal(
    input: AgentHostRunInput,
    signal: AbortSignal
  ): Promise<AgentHostRunResult> {
    const session = await this.sessions.create({
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.labels === undefined ? {} : { labels: input.labels })
    });
    const result = await this.kernel.run({
      agentId: "builtin",
      session,
      prompt: input.prompt,
      provider: input.provider,
      model: input.model,
      signal,
      ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
      ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId })
    });
    return { session, reason: result.reason, steps: result.steps, toolCalls: result.toolCalls };
  }

  dispose(): Promise<void> {
    const context = ACTIVE_HOST_RUN.getStore();
    if (context?.host === this && context.active) {
      return Promise.reject(new Error("agent host cannot be disposed reentrantly from an active host run"));
    }
    if (this.disposal !== undefined) return this.disposal;

    this.acceptingRuns = false;
    const active = [...this.activeRuns];
    for (const run of active) run.controller.abort();
    this.disposal = this.drainAndDispose(active);
    return this.disposal;
  }

  private async drainAndDispose(active: readonly ActiveHostRun[]): Promise<void> {
    // Cancellation is cooperative. Retaining the lifecycle until every run is
    // settled keeps adapters, tools, and durable session writers valid even
    // when an implementation takes time to observe its AbortSignal.
    await Promise.allSettled(active.map((run) => run.operation));
    await this.lifecycle.dispose();
  }
}

export async function createAgentHost(options: AgentHostOptions): Promise<AgentHost> {
  const lifecycle = new LifecycleScope();
  try {
    const sessionStore = stableSessionStore(
      options.sessionStore ?? new InMemoryAgentSessionStore(),
      lifecycle
    );
    const llm = new LlmRuntime();
    for (const adapter of options.adapters) lifecycle.defer(llm.register(adapter));

    const tools = new ToolRegistry(options.authorizer);
    for (const tool of options.tools) lifecycle.defer(tools.register(tool));

    llm.seal();
    tools.seal();
    const agents = new AgentRegistry();
    agents.register("builtin", createBuiltinAgentKernel({
      llm,
      tools,
      systemPrompt: options.systemPrompt ?? new StaticSystemPrompt([])
    }));
    agents.seal();
    return new AgentHost(
      new AgentKernel(agents),
      sessionStore,
      lifecycle
    );
  } catch (cause: unknown) {
    try {
      await lifecycle.dispose();
    } catch (rollbackError: unknown) {
      const message = cause instanceof Error ? cause.message : "agent host initialization failed";
      throw new AggregateError(
        [cause, ...rollbackFailures(rollbackError)],
        message,
        { cause }
      );
    }
    throw cause;
  }
}
