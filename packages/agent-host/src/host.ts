// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { types as utilTypes } from "node:util";

import {
  AgentKernel,
  AgentRegistry,
  LifecycleScope,
  StaticSystemPrompt,
  createBuiltinAgentKernel,
  type AgentRunReason
} from "@mn/agent-kernel";
import { LlmRuntime, type LlmAdapter } from "@mn/agent-llm";
import {
  snapshotEffectPolicyBindingV1,
  type CandidateId,
  type EffectPolicyBindingV1,
  type RunId,
  type SessionId
} from "@mn/agent-protocol";
import {
  InMemoryAgentSessionStore,
  snapshotCreateAgentSessionOptions,
  type AgentSession,
  type AgentSessionStore,
  type CreateAgentSessionOptionsSnapshot
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
  readonly effectPolicyBinding?: EffectPolicyBindingV1;
}

export interface AgentHostResumeInput extends Omit<AgentHostRunInput, "cwd" | "labels" | "sessionId"> {
  readonly sessionId: SessionId;
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
  readonly context: ActiveHostRunContext;
  readonly operation: Promise<AgentHostRunResult>;
}

interface AgentHostRunInputSnapshot {
  readonly mode: "create" | "open";
  readonly creation: CreateAgentSessionOptionsSnapshot;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly maxSteps?: number;
  readonly maxToolCalls?: number;
  readonly runId?: RunId;
  readonly candidateId?: CandidateId;
  readonly effectPolicyBinding?: EffectPolicyBindingV1;
}

const ACTIVE_HOST_RUN = new AsyncLocalStorage<ActiveHostRunContext>();
const ABORT_SIGNAL_ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const ABORT_SIGNAL_REASON = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")?.get;
const EVENT_TARGET_ADD = EventTarget.prototype.addEventListener;
const EVENT_TARGET_REMOVE = EventTarget.prototype.removeEventListener;

const RESUME_INPUT_KEYS = new Set([
  "sessionId",
  "prompt",
  "provider",
  "model",
  "signal",
  "maxSteps",
  "maxToolCalls",
  "runId",
  "candidateId",
  "effectPolicyBinding"
]);

function snapshotAgentHostRunInput(input: AgentHostRunInput): AgentHostRunInputSnapshot {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("agent host run input must be an object");
  }
  const sessionId = input.sessionId;
  const cwd = input.cwd;
  const labels = input.labels;
  const prompt = input.prompt;
  const provider = input.provider;
  const model = input.model;
  const signal = input.signal;
  const maxSteps = input.maxSteps;
  const maxToolCalls = input.maxToolCalls;
  const runId = input.runId;
  const candidateId = input.candidateId;
  const effectPolicyBinding = input.effectPolicyBinding;
  const creation = snapshotCreateAgentSessionOptions({ sessionId, cwd, labels });
  const fixedEffectPolicyBinding = effectPolicyBinding === undefined
    ? undefined
    : snapshotEffectPolicyBindingV1(effectPolicyBinding);
  return Object.freeze({
    mode: "create" as const,
    creation,
    prompt,
    provider,
    model,
    ...(signal === undefined ? {} : { signal }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    ...(runId === undefined ? {} : { runId }),
    ...(candidateId === undefined ? {} : { candidateId }),
    ...(fixedEffectPolicyBinding === undefined ? {} : { effectPolicyBinding: fixedEffectPolicyBinding })
  });
}

function snapshotAgentHostResumeInput(input: AgentHostResumeInput): AgentHostRunInputSnapshot {
  if (input === null || typeof input !== "object" || utilTypes.isProxy(input) || Array.isArray(input)) {
    throw new TypeError("agent host resume input must be an exact data object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("agent host resume input must be an exact data object");
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !RESUME_INPUT_KEYS.has(key)) {
      throw new TypeError("agent host resume input must be an exact data object");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("agent host resume input must be an exact data object");
    }
    values[key] = descriptor.value;
  }
  const sessionId = values.sessionId;
  const prompt = values.prompt;
  const provider = values.provider;
  const model = values.model;
  if (typeof sessionId !== "string" || sessionId.length === 0
    || typeof prompt !== "string" || typeof provider !== "string" || typeof model !== "string") {
    throw new TypeError("agent host resume input must contain the required data properties");
  }
  const signal = values.signal;
  if (signal !== undefined) {
    if (signal === null || typeof signal !== "object" || utilTypes.isProxy(signal)
      || ABORT_SIGNAL_ABORTED === undefined) {
      throw new TypeError("agent host resume signal must be a native AbortSignal");
    }
    try {
      Reflect.apply(ABORT_SIGNAL_ABORTED, signal, []);
    } catch {
      throw new TypeError("agent host resume signal must be a native AbortSignal");
    }
  }
  const effectPolicyBinding = values.effectPolicyBinding === undefined
    ? undefined
    : snapshotEffectPolicyBindingV1(values.effectPolicyBinding as EffectPolicyBindingV1);
  return Object.freeze({
    mode: "open" as const,
    creation: snapshotCreateAgentSessionOptions({ sessionId: sessionId as SessionId }),
    prompt,
    provider,
    model,
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
    ...(values.maxSteps === undefined ? {} : { maxSteps: values.maxSteps as number }),
    ...(values.maxToolCalls === undefined ? {} : { maxToolCalls: values.maxToolCalls as number }),
    ...(values.runId === undefined ? {} : { runId: values.runId as RunId }),
    ...(values.candidateId === undefined ? {} : { candidateId: values.candidateId as CandidateId }),
    ...(effectPolicyBinding === undefined ? {} : { effectPolicyBinding })
  });
}

function bindExternalSignal(
  external: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (external === undefined) return () => {};
  if (!utilTypes.isProxy(external) && ABORT_SIGNAL_ABORTED !== undefined) {
    let aborted = false;
    let nativeSignal = false;
    try {
      aborted = Reflect.apply(ABORT_SIGNAL_ABORTED, external, []) === true;
      nativeSignal = true;
    } catch {
      nativeSignal = false;
    }
    if (nativeSignal) {
      const abort = (): void => {
        let reason: unknown;
        if (ABORT_SIGNAL_REASON !== undefined) {
          try {
            reason = Reflect.apply(ABORT_SIGNAL_REASON, external, []);
          } catch {
            reason = undefined;
          }
        }
        controller.abort(reason);
      };
      if (aborted) {
        abort();
        return () => {};
      }
      try {
        Reflect.apply(EVENT_TARGET_ADD, external, ["abort", abort, { once: true }]);
      } catch (primary: unknown) {
        try {
          Reflect.apply(EVENT_TARGET_REMOVE, external, ["abort", abort]);
        } catch (cleanup: unknown) {
          throw new AggregateError(
            [primary, cleanup],
            "agent host signal registration and cleanup failed",
            { cause: primary }
          );
        }
        throw primary;
      }
      return (): void => {
        Reflect.apply(EVENT_TARGET_REMOVE, external, ["abort", abort]);
      };
    }
  }
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
  try {
    addEventListener.call(external, "abort", abort, { once: true });
  } catch (primary: unknown) {
    try {
      removeEventListener.call(external, "abort", abort);
    } catch (cleanup: unknown) {
      throw new AggregateError(
        [primary, cleanup],
        "agent host signal registration and cleanup failed",
        { cause: primary }
      );
    }
    throw primary;
  }
  return (): void => { removeEventListener.call(external, "abort", abort); };
}

async function settleHostRun(
  primaryOperation: Promise<AgentHostRunResult>,
  cleanup: () => void,
  settled: () => void
): Promise<AgentHostRunResult> {
  let result!: AgentHostRunResult;
  let primary: unknown;
  let primaryFailed = false;
  try {
    result = await primaryOperation;
  } catch (error: unknown) {
    primary = error;
    primaryFailed = true;
  }

  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    cleanup();
  } catch (error: unknown) {
    cleanupFailure = error;
    cleanupFailed = true;
  } finally {
    settled();
  }

  if (primaryFailed && cleanupFailed) {
    throw new AggregateError(
      [primary, cleanupFailure],
      "agent host run and signal cleanup failed",
      { cause: primary }
    );
  }
  if (primaryFailed) throw primary;
  if (cleanupFailed) throw cleanupFailure;
  return result;
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
    return this.startRun(() => snapshotAgentHostRunInput(input));
  }

  resume(input: AgentHostResumeInput): Promise<AgentHostRunResult> {
    return this.startRun(() => snapshotAgentHostResumeInput(input));
  }

  private startRun(snapshotInput: () => AgentHostRunInputSnapshot): Promise<AgentHostRunResult> {
    if (!this.acceptingRuns) return Promise.reject(new Error("agent host is disposed"));
    const controller = new AbortController();
    const context: ActiveHostRunContext = { host: this, active: true };
    let start!: (snapshot: AgentHostRunInputSnapshot) => void;
    let rejectStart!: (error: unknown) => void;
    const startGate = new Promise<AgentHostRunInputSnapshot>((resolve, reject) => {
      start = resolve;
      rejectStart = reject;
    });
    let removeExternalListener = (): void => {};
    let active!: ActiveHostRun;
    const primaryOperation = startGate.then((snapshot) => {
      return ACTIVE_HOST_RUN.run(context, () => this.runInternal(snapshot, controller.signal));
    });
    const operation = settleHostRun(
      primaryOperation,
      () => { removeExternalListener(); },
      () => {
        context.active = false;
        this.activeRuns.delete(active);
      }
    );
    active = { controller, context, operation };
    this.activeRuns.add(active);
    try {
      const snapshot = snapshotInput();
      removeExternalListener = bindExternalSignal(snapshot.signal, controller);
      start(snapshot);
    } catch (error: unknown) {
      rejectStart(error);
    }
    return operation;
  }

  private async runInternal(
    input: AgentHostRunInputSnapshot,
    signal: AbortSignal
  ): Promise<AgentHostRunResult> {
    const session = input.mode === "create"
      ? await this.sessions.create(input.creation)
      : await this.sessions.open(input.creation.sessionId);
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
      ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
      ...(input.effectPolicyBinding === undefined ? {} : { effectPolicyBinding: input.effectPolicyBinding })
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
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const abortFailures: unknown[] = [];
    this.disposal = (async () => {
      await drainGate;
      let teardownFailure: unknown;
      let teardownFailed = false;
      try {
        await this.drainAndDispose(active);
      } catch (error: unknown) {
        teardownFailure = error;
        teardownFailed = true;
      }

      if (abortFailures.length > 0 && teardownFailed) {
        throw new AggregateError(
          [...abortFailures, teardownFailure],
          "agent host cancellation and teardown failed",
          { cause: abortFailures[0] }
        );
      }
      if (abortFailures.length === 1) throw abortFailures[0];
      if (abortFailures.length > 1) {
        throw new AggregateError(
          abortFailures,
          "agent host cancellation failed",
          { cause: abortFailures[0] }
        );
      }
      if (teardownFailed) throw teardownFailure;
    })();
    try {
      for (const run of active) {
        try {
          ACTIVE_HOST_RUN.run(run.context, () => { run.controller.abort(); });
        } catch (error: unknown) {
          abortFailures.push(error);
        }
      }
    } finally {
      releaseDrain();
    }
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
