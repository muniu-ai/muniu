// SPDX-License-Identifier: Apache-2.0

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

export class AgentHost {
  private disposed = false;

  constructor(
    private readonly kernel: AgentKernel,
    private readonly sessions: AgentSessionStore,
    private readonly lifecycle: LifecycleScope
  ) {}

  async run(input: AgentHostRunInput): Promise<AgentHostRunResult> {
    if (this.disposed) throw new Error("agent host is disposed");
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
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
      ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId })
    });
    return { session, reason: result.reason, steps: result.steps, toolCalls: result.toolCalls };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return this.lifecycle.dispose();
    this.disposed = true;
    return this.lifecycle.dispose();
  }
}

export async function createAgentHost(options: AgentHostOptions): Promise<AgentHost> {
  const lifecycle = new LifecycleScope();
  try {
    const sessionStore: AgentSessionStore = options.sessionStore ?? new InMemoryAgentSessionStore();
    if (sessionStore.dispose !== undefined) lifecycle.defer(() => sessionStore.dispose?.());
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
      throw new AggregateError([cause, rollbackError], message);
    }
    throw cause;
  }
}
