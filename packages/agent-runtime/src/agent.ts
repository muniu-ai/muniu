// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  approvalStillMatches,
  isPotentiallyAutoApprovable,
  type ToolCallIntent,
} from "@mn/contracts";

import {
  assertToolAuthority,
  snapshotRuntimeAuthority,
  SubagentAuthorityAllocator,
} from "./authority.js";
import {
  findUnresolvedToolIntentRecords,
  parseWaitingApprovalRecovery,
  type WaitingApprovalRecovery,
} from "./approval-recovery.js";
import { PersistentInbox } from "./inbox.js";
import { PersistentExecutionBudget, ExecutionBudgetExceededError } from "./budget.js";
import { assertSubagentBudgetAvailable, validateModelUsage } from "./model-budget.js";
import type { AgentScope, TurnContributions } from "./scope.js";
import { DefaultSessionSurface, PersistentSessionLog } from "./session.js";
import type {
  AgentHandleOptions,
  ExecutionStatus,
  JsonObject,
  JsonValue,
  LlmContribution,
  ModelMessage,
  ModelRequest,
  ModelToolCall,
  PreparedToolCall,
  ResourceRef,
  RequestedSubagentAuthority,
  RuntimeAuthority,
  RuntimeRecord,
  RuntimeStore,
  SessionSurface,
  SubagentSpawnRequest,
  ToolApprovalPort,
  ToolContribution,
  ToolEffectClass,
} from "./types.js";

const TERMINAL_STATUSES = new Set<ExecutionStatus>(["completed", "failed", "cancelled"]);
const NON_REPLAYABLE_EFFECTS = new Set<ToolEffectClass>([
  "local_irreversible_write",
  "external_side_effect",
  "financial",
  "privileged",
  "unknown",
]);
const DEFAULT_TOOL_INTENT_TTL_MS = 5 * 60_000;

interface TurnRuntime {
  readonly turn: number;
  readonly generation: number;
  readonly contributions: TurnContributions;
  readonly llm: LlmContribution;
  readonly availableToolIds: readonly string[];
  readonly prompts: readonly string[];
}

export class UnknownToolOutcomeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnknownToolOutcomeError";
  }
}

export class AgentRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}

export class RuntimeControlError extends AgentRuntimeError {
  constructor(readonly status: "cancelled" | "paused" | "interrupted") {
    super(`执行已进入 ${status} 状态`);
    this.name = "RuntimeControlError";
  }
}

export class AgentHandle {
  readonly #executionId: string;
  readonly #scope: AgentScope;
  readonly #store: RuntimeStore;
  readonly #definition: AgentHandleOptions["definition"];
  readonly #authority: AgentHandleOptions["authority"];
  readonly #approval: ToolApprovalPort;
  readonly #surface: SessionSurface;
  readonly #maxModelBoundariesPerTurn: number;
  readonly #toolIntentTtlMs: number;
  readonly #now: () => string;
  readonly #inbox: PersistentInbox;
  readonly #sessionLog: PersistentSessionLog;
  readonly #budget: PersistentExecutionBudget;
  readonly #pendingEnqueues = new Set<Promise<unknown>>();
  readonly #subagents = new Map<AgentScope, AbortController>();
  #status: ExecutionStatus = "queued";
  #turn = 0;
  #drainPromise: Promise<void> | undefined;
  #abortController: AbortController | undefined;
  #lastError: unknown;

  private constructor(options: AgentHandleOptions) {
    this.#executionId = options.executionId;
    this.#scope = options.scope;
    this.#store = options.store;
    this.#definition = options.definition;
    this.#authority = snapshotRuntimeAuthority(options.authority);
    this.#approval = options.approval;
    this.#surface = options.surface ?? new DefaultSessionSurface();
    this.#maxModelBoundariesPerTurn = options.maxModelBoundariesPerTurn ?? 16;
    if (!Number.isSafeInteger(this.#maxModelBoundariesPerTurn) || this.#maxModelBoundariesPerTurn < 1) {
      throw new Error("每 turn 的模型边界上限必须是正整数");
    }
    this.#toolIntentTtlMs = options.toolIntentTtlMs ?? DEFAULT_TOOL_INTENT_TTL_MS;
    if (!Number.isSafeInteger(this.#toolIntentTtlMs) || this.#toolIntentTtlMs < 1) {
      throw new Error("工具调用批准有效期必须是正整数毫秒");
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#budget = new PersistentExecutionBudget({ store: this.#store, executionId: this.#executionId,
      maxDurationMs: this.#authority.budget.maxDurationMs, now: () => Date.parse(this.#now()) });
    this.#inbox = new PersistentInbox(this.#store, this.#executionId);
    this.#sessionLog = new PersistentSessionLog(this.#store, this.#executionId);
    this.#scope.onDispose(async () => {
      if (this.#status !== "running" && this.#status !== "waiting_approval") return;
      await this.interrupt("执行 Scope 已关闭");
      await this.whenIdle();
    });
  }

  static async open(options: AgentHandleOptions): Promise<AgentHandle> {
    await options.scope.ready;
    const handle = new AgentHandle(options);
    await handle.#recover();
    return handle;
  }

  get executionId(): string { return this.#executionId; }
  get status(): ExecutionStatus { return this.#status; }
  get lastError(): unknown { return this.#lastError; }
  get sessionLog(): PersistentSessionLog { return this.#sessionLog; }

  async start(message: string): Promise<void> {
    if (this.#status === "waiting_approval" || this.#status === "running") return;
    if (this.#status !== "queued") throw new AgentRuntimeError("start 只接受尚未开始的执行；中断后请使用 resume");
    const pending = this.#inbox.enqueueInitial(message);
    this.#trackEnqueue(pending);
    await pending;
    this.#kick();
  }

  async followUp(text: string): Promise<void> {
    this.#assertCanQueue("follow_up");
    const pending = this.#inbox.enqueue("follow_up", text);
    this.#trackEnqueue(pending);
    await pending;
    this.#kick();
  }

  async steer(text: string): Promise<void> {
    this.#assertCanQueue("steer");
    const pending = this.#inbox.enqueue("steer", text);
    this.#trackEnqueue(pending);
    await pending;
  }

  async cancel(reason = "已取消"): Promise<void> {
    if (TERMINAL_STATUSES.has(this.#status)) return;
    await this.#transition("cancelled", reason);
    this.#abortController?.abort(reason);
    await this.#stopSubagents(reason);
  }

  async interrupt(reason = "执行已中断"): Promise<void> {
    if (TERMINAL_STATUSES.has(this.#status)
      || this.#status === "needs_reconciliation"
      || this.#status === "interrupted") return;
    try {
      await this.#transition("interrupted", reason);
    } finally {
      this.#abortController?.abort(reason);
      await this.#stopSubagents(reason);
    }
  }

  async resume(): Promise<void> {
    if (this.#status !== "paused" && this.#status !== "interrupted") {
      throw new AgentRuntimeError("resume 只接受 paused 或 interrupted 状态");
    }
    const records = await this.#store.readExecution(this.#executionId);
    const uncertain = uncertainNonReplayableIntent(records);
    if (uncertain !== undefined) {
      await this.#store.append({
        executionId: this.#executionId,
        type: "tool/outcome_unknown",
        payload: {
          toolCallId: uncertain.toolCallId,
          recoveredAfterInterrupt: true,
          message: "中断前的高影响工具可能已经执行",
        },
      });
      await this.#transition("needs_reconciliation", "外部副作用结果未知，需要人工核对");
      return;
    }
    if ((hasIncompleteTurn(records) || await this.#inbox.hasSteers()) && !await this.#inbox.hasResume()) {
      await this.#inbox.enqueue("resume", "继续中断前未完成的任务");
    }
    await this.#transition("queued", "恢复执行");
    this.#kick();
  }

  async whenIdle(): Promise<void> {
    while (true) {
      if (this.#pendingEnqueues.size > 0) {
        await Promise.allSettled([...this.#pendingEnqueues]);
        continue;
      }
      const running = this.#drainPromise;
      if (running === undefined) return;
      await running;
    }
  }

  async spawnSubagent(request: SubagentSpawnRequest): Promise<unknown> {
    if (!["queued", "running", "waiting_approval"].includes(this.#status)) {
      throw new AgentRuntimeError("当前执行状态不允许创建子 Agent");
    }
    if (this.#scope.level !== "execution" && this.#scope.level !== "subagent") {
      throw new AgentRuntimeError("只能从 execution 或 subagent Scope 创建子 Agent");
    }
    const contributions = this.#scope.resolveTurn();
    const contribution = contributions.get("subagent", request.contributionId);
    if (contribution === undefined) {
      throw new AgentRuntimeError(`子 Agent 贡献 ${request.contributionId} 不存在`);
    }
    const remaining = await this.#budget.remainingMilliseconds();
    let authority: RuntimeAuthority;
    for (;;) {
      const records = await this.#store.readExecution(this.#executionId);
      const reservations = records.filter(record => record.type === "subagent/reserved");
      if (reservations.some(record => record.payload.scopeId === request.scopeId)) {
        throw new AgentRuntimeError("子 Agent 身份已预留，不能自动重复创建；请核对原执行");
      }
      const allocator = new SubagentAuthorityAllocator(this.#authority);
      for (const reservation of reservations) {
        const restored = allocator.allocate(reservation.payload.authority as unknown as RequestedSubagentAuthority);
        if (restored.commitment !== reservation.payload.commitment) throw new AgentRuntimeError("子 Agent 预算预留承诺不一致");
      }
      authority = allocator.allocate(request.authority);
      assertSubagentBudgetAvailable(records, this.#authority.budget, authority.budget);
      const committed = await this.#store.commit(this.#executionId, records.at(-1)?.sequence ?? 0, [{
        executionId: this.#executionId, type: "subagent/reserved", payload: {
          scopeId: request.scopeId, contributionId: request.contributionId, generation: contributions.generation,
          authority: JSON.parse(JSON.stringify(request.authority)) as JsonObject, commitment: authority.commitment,
        },
      }]);
      if (committed) break;
    }
    const lifetimeMs = Math.min(remaining, authority.budget.maxDurationMs,
      await this.#budget.remainingMilliseconds());
    if (lifetimeMs <= 0) throw new ExecutionBudgetExceededError("duration");
    if (!["queued", "running", "waiting_approval"].includes(this.#status)) throw new AgentRuntimeError("父执行已停止，禁止启动子 Agent");
    const childScope = this.#scope.createChild("subagent", request.scopeId);
    const abort = new AbortController();
    this.#subagents.set(childScope, abort);
    const deadlineAt = new Date(Date.parse(this.#now()) + lifetimeMs).toISOString();
    const timer = setTimeout(() => {
      abort.abort(new ExecutionBudgetExceededError("duration"));
      void childScope.dispose().catch(error => { this.#lastError = error; });
    }, lifetimeMs);
    timer.unref();
    childScope.onDispose(() => {
      clearTimeout(timer);
      abort.abort("子 Agent Scope 已关闭");
      this.#subagents.delete(childScope);
    });
    try {
      await childScope.ready;
      abort.signal.throwIfAborted();
      return await raceAbort(contribution.spawn({
        parentExecutionId: this.#executionId,
        generation: contributions.generation,
        authority,
        scope: childScope,
        signal: abort.signal,
        deadlineAt,
      }), abort.signal);
    } catch (error: unknown) {
      await childScope.dispose();
      throw error;
    }
  }

  async #stopSubagents(reason: string): Promise<void> {
    const scopes = [...this.#subagents.keys()];
    for (const controller of this.#subagents.values()) controller.abort(reason);
    await Promise.all(scopes.map(scope => scope.dispose()));
  }

  async #recover(): Promise<void> {
    const records = await this.#store.readExecution(this.#executionId);
    this.#turn = records.filter((record) => record.type === "turn/started").length;
    this.#status = latestStatus(records) ?? "queued";
    if (this.#definition.jobId && (this.#status === "running" || this.#status === "waiting_approval")) {
      const contributions = this.#scope.resolveTurn();
      const start = records.filter(record => record.type === "job/started").at(-1);
      const turn = records.filter(record => record.type === "turn/started").at(-1);
      const item = records.find(record => record.type === "inbox/enqueued" && record.payload.id === turn?.payload.itemId);
      const job = contributions.get("job", this.#definition.jobId);
      if (!start || !turn || !item || start.payload.turn !== this.#turn
        || start.payload.jobId !== this.#definition.jobId || start.payload.generation !== contributions.generation
        || start.payload.authorityCommitment !== this.#authority.commitment || !job?.recover) {
        await this.#transition("interrupted", "产品工作流缺少可恢复检查点，需要显式恢复");
        return;
      }
      if (this.#status === "waiting_approval") await this.#transition("running", "恢复产品工作流审批检查点");
      const drain = (async () => {
        try {
          await this.#runTurn(String(item.payload.text), item.payload.kind === "resume" ? "resume" : "follow_up",
            this.#turn, contributions, true);
          if (this.#status === "running") await this.#drain();
        } catch (error) {
          this.#lastError = error;
          await this.#transition(error instanceof ExecutionBudgetExceededError ? "paused" : error instanceof RuntimeControlError ? error.status : "failed",
            error instanceof Error ? error.message : "产品工作流恢复失败");
        }
      })();
      this.#drainPromise = drain;
      void drain.catch(() => {}).finally(() => { if (this.#drainPromise === drain) this.#drainPromise = undefined; });
      return;
    }
    if (this.#status === "waiting_approval") {
      const recovery = parseWaitingApprovalRecovery(records, this.#executionId, this.#definition);
      if (recovery.turn !== this.#turn) {
        throw new AgentRuntimeError("等待审批的工具调用不属于当前 turn");
      }
      const drain = this.#resumeWaitingApproval(recovery);
      this.#drainPromise = drain;
      void drain.catch(() => {}).finally(() => {
        if (this.#drainPromise === drain) this.#drainPromise = undefined;
      });
      return;
    }
    if (this.#status !== "running") return;

    const unresolved = unresolvedToolIntents(records)
      .filter((intent) => NON_REPLAYABLE_EFFECTS.has(intent.effectClass))
      .at(-1);
    if (unresolved !== undefined) {
      await this.#store.append({
        executionId: this.#executionId,
        type: "tool/outcome_unknown",
        payload: {
          toolCallId: unresolved.toolCallId,
          recoveredAfterRestart: true,
          message: "进程中断前未持久化工具结果",
        },
      });
      await this.#transition("needs_reconciliation", "外部副作用结果未知，需要人工核对");
      return;
    }
    await this.#transition("interrupted", "进程中断，需要显式恢复");
  }

  async #resumeWaitingApproval(recovery: WaitingApprovalRecovery): Promise<void> {
    try {
      this.#abortController = new AbortController();
      const pendingCall = recovery.calls[recovery.pendingCallIndex];
      if (pendingCall === undefined) throw new AgentRuntimeError("持久化工具续点不存在");
      await this.#authorizeAndExecute(
        pendingCall,
        recovery.intent,
        pendingCall.arguments,
        recovery.turn,
        false,
      );
      if (this.#status !== "running") return;

      const contributions = this.#scope.resolveTurn();
      if (contributions.generation !== recovery.generation) {
        throw new AgentRuntimeError("恢复审批后插件代次已变化，必须重新请求批准");
      }
      const availableToolIds = this.#availableToolIds(contributions);
      if (!sameStringList(availableToolIds, recovery.availableToolIds)) {
        throw new AgentRuntimeError("恢复审批后工具范围已变化，必须重新请求批准");
      }
      for (let index = recovery.pendingCallIndex + 1; index < recovery.calls.length; index += 1) {
        const call = recovery.calls[index];
        if (call === undefined) throw new AgentRuntimeError("持久化工具调用不存在");
        if (!availableToolIds.includes(call.toolId)) {
          throw new AgentRuntimeError(`工具 ${call.toolId} 不在本 turn 的可用范围内`);
        }
        await this.#executeTool(call, contributions, recovery.turn, recovery.boundary);
        if (this.#status !== "running") return;
      }

      const llm = requiredContribution(contributions, "llm", this.#definition.llmId);
      await this.#runModelBoundaries({
        turn: recovery.turn,
        generation: recovery.generation,
        contributions,
        llm,
        availableToolIds,
        prompts: recovery.prompts,
      }, recovery.boundary + 1);
      if (this.#status === "running") await this.#drain();
    } catch (error: unknown) {
      this.#lastError = error;
      if (error instanceof ExecutionBudgetExceededError) { await this.#transition("paused", error.message); return; }
      if (error instanceof RuntimeControlError) { await this.#transition(error.status, error.message); return; }
      if (this.#status === "cancelled" || this.#status === "needs_reconciliation") return;
      await this.#transition("failed", error instanceof Error ? error.message : "执行失败");
    }
  }

  #assertCanQueue(command: "follow_up" | "steer"): void {
    if (this.#status === "needs_reconciliation") {
      throw new AgentRuntimeError("执行结果需要人工核对，核对前不能继续");
    }
    if (TERMINAL_STATUSES.has(this.#status)) {
      throw new AgentRuntimeError(`${command} 不能用于 ${this.#status} 状态`);
    }
  }

  #trackEnqueue(pending: Promise<unknown>): void {
    this.#pendingEnqueues.add(pending);
    void pending.then(
      () => { this.#pendingEnqueues.delete(pending); },
      () => { this.#pendingEnqueues.delete(pending); },
    );
  }

  #kick(): void {
    if (this.#drainPromise !== undefined || !this.#canDrain()) return;
    const drain = this.#drain();
    this.#drainPromise = drain;
    void drain.catch(() => {}).finally(() => {
      if (this.#drainPromise === drain) this.#drainPromise = undefined;
    });
  }

  #canDrain(): boolean {
    return this.#status === "queued" || this.#status === "running";
  }

  async #drain(): Promise<void> {
    try {
      if (this.#status === "queued") await this.#transition("running", "开始处理收件箱");
      while (this.#status === "running") {
        const contributions = this.#scope.resolveTurn();
        const followUp = await this.#inbox.beginTurn(contributions.generation);
        if (followUp === undefined) {
          if (this.#pendingEnqueues.size > 0) {
            await Promise.allSettled([...this.#pendingEnqueues]);
            continue;
          }
          const idleStatus = await this.#inbox.completeIfEmpty();
          if (idleStatus) { this.#status = idleStatus; break; }
          continue;
        }
        await this.#runTurn(followUp.item.text, followUp.item.kind, followUp.turn, contributions);
      }
    } catch (error: unknown) {
      this.#lastError = error;
      if (error instanceof ExecutionBudgetExceededError) { await this.#transition("paused", error.message); return; }
      if (error instanceof RuntimeControlError) { await this.#transition(error.status, error.message); return; }
      if (this.#status === "cancelled"
        || this.#status === "interrupted"
        || this.#status === "needs_reconciliation") return;
      await this.#transition("failed", error instanceof Error ? error.message : "执行失败");
    }
  }

  async #runTurn(text: string, kind: "follow_up" | "resume", turn: number, contributions: TurnContributions, recoveringJob = false): Promise<void> {
    const remaining = await this.#budget.remainingMilliseconds();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      this.#abortController?.abort(new ExecutionBudgetExceededError("duration"));
    }, remaining);
    timer.unref();
    try {
      await this.#executeTurn(text, kind, turn, contributions, recoveringJob);
      if (expired && this.#status === "running") throw new ExecutionBudgetExceededError("duration");
    }
    catch (error) {
      if (expired && this.#status !== "needs_reconciliation") throw new ExecutionBudgetExceededError("duration");
      throw error;
    } finally { clearTimeout(timer); }
  }

  async #executeTurn(text: string, kind: "follow_up" | "resume", turn: number, contributions: TurnContributions, recoveringJob = false): Promise<void> {
    this.#turn = turn;
    const availableToolIds = this.#availableToolIds(contributions);
    this.#abortController = new AbortController();

    if (this.#definition.jobId) {
      const job = contributions.get("job", this.#definition.jobId);
      if (!job) throw new AgentRuntimeError(`Job 贡献 ${this.#definition.jobId} 不存在`);
      const input = { turn, generation: contributions.generation, message: text, kind,
        executionId: this.#executionId, authorityCommitment: this.#authority.commitment };
      if (!recoveringJob) await this.#store.append({ executionId: this.#executionId, type: "job/started",
        payload: { jobId: job.id, turn, generation: contributions.generation, authorityCommitment: this.#authority.commitment } });
      const prior = (await this.#store.readExecution(this.#executionId))
        .find(record => record.type === "job/completed" && record.payload.turn === turn && record.payload.jobId === job.id);
      const rawResult = prior?.payload.result ?? await (recoveringJob ? job.recover! : job.run)(input, this.#abortController.signal);
      if (this.#status !== "running") return;
      if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
        throw new AgentRuntimeError("产品工作流返回了无效的执行状态");
      }
      const result = rawResult as JsonObject;
      if (!["completed", "paused", "needs_human_decision", "needs_reconciliation", "failed", "cancelled"].includes(String(result.status))) {
        throw new AgentRuntimeError("产品工作流返回了无效的执行状态");
      }
      for (;;) {
        const records = await this.#store.readExecution(this.#executionId);
        if (records.some(record => record.type === "job/completed" && record.payload.turn === turn && record.payload.jobId === job.id)) break;
        const committed = await this.#store.commit(this.#executionId, records.at(-1)?.sequence ?? 0, [
          { executionId: this.#executionId, type: "job/completed", payload: { jobId: job.id, turn, generation: contributions.generation, result } },
          ...(typeof result.summary === "string" && result.summary ? [{ executionId: this.#executionId, type: "session/entry" as const,
            payload: { role: "assistant", content: result.summary, turn, modelVisible: true } }] : []),
          ...(result.status === "completed" ? [{ executionId: this.#executionId, type: "turn/completed" as const,
            payload: { turn, generation: contributions.generation } }] : []),
        ]);
        if (committed) break;
      }
      if (result.status !== "completed") {
        const status = result.status === "needs_human_decision" ? "paused" : result.status as ExecutionStatus;
        const reason = typeof result.nextStep === "string" ? result.nextStep : "产品工作流等待处理";
        if (status === "failed") this.#lastError = new AgentRuntimeError(reason);
        await this.#transition(status, reason);
        return;
      }
      return;
    }

    const llm = requiredContribution(contributions, "llm", this.#definition.llmId);

    const prompts = await Promise.all(this.#definition.promptIds.map(async (id) => {
      const prompt = requiredContribution(contributions, "prompt", id);
      return prompt.render({
        scope: this.#scope.identity,
        executionId: this.#executionId,
        generation: contributions.generation,
      });
    }));

    await this.#runModelBoundaries({
      turn,
      generation: contributions.generation,
      contributions,
      llm,
      availableToolIds,
      prompts,
    }, 1);
  }

  async #runModelBoundaries(runtime: TurnRuntime, firstBoundary: number): Promise<void> {
    for (let boundary = firstBoundary; boundary <= this.#maxModelBoundariesPerTurn; boundary += 1) {
      if (this.#status !== "running") return;
      await this.#budget.remainingMilliseconds();
      await this.#appendSteersAtBoundary(runtime.turn);
      const prompts = await Promise.all(this.#definition.promptIds.map((id, index) => {
        const contribution = requiredContribution(runtime.contributions, "prompt", id);
        return contribution.refreshAtBoundary ? contribution.render({
          scope: this.#scope.identity, executionId: this.#executionId, generation: runtime.generation,
        }) : runtime.prompts[index]!;
      }));
      const request: ModelRequest = {
        executionId: this.#executionId,
        agentId: this.#definition.id,
        generation: runtime.generation,
        messages: [
          ...prompts.map((content): ModelMessage => ({ role: "system", content })),
          ...await this.#sessionLog.modelView(this.#surface),
        ],
        availableToolIds: runtime.availableToolIds,
      };

      await this.#persistModelRequest(request, boundary, prompts);
      const modelResponse = await this.#invokeModelWithinDeadline(runtime.llm, request);
      if (modelResponse.usage) validateModelUsage(modelResponse.usage);
      if (new Set(modelResponse.toolCalls.map(call => call.id)).size !== modelResponse.toolCalls.length) {
        throw new AgentRuntimeError("模型响应包含重复的工具调用标识");
      }
      const response = { ...modelResponse, toolCalls: modelResponse.toolCalls.map(call => ({ ...call,
        id: `tool-${digestJson({ executionId: this.#executionId, generation: runtime.generation,
          turn: runtime.turn, boundary, providerCallId: call.id })}`,
      })) };
      if (this.#status !== "running") return;
      await this.#store.append({
        executionId: this.#executionId,
        type: "model/response",
        payload: {
          turn: runtime.turn,
          boundary,
          generation: runtime.generation,
          text: response.text,
          ...(response.usage ? { usage: { ...response.usage } } : {}),
          toolCalls: response.toolCalls.map((call) => ({
            id: call.id,
            toolId: call.toolId,
            arguments: call.arguments,
            ...(call.intent === undefined ? {} : { intent: call.intent }),
          })),
        },
      });
      if (response.text.length > 0) {
        await this.#sessionLog.append({ role: "assistant", content: response.text, turn: runtime.turn });
      }
      await this.#budget.remainingMilliseconds();
      if (response.toolCalls.length === 0) {
        await this.#store.append({
          executionId: this.#executionId,
          type: "turn/completed",
          payload: { turn: runtime.turn, generation: runtime.generation },
        });
        return;
      }
      for (const call of response.toolCalls) {
        if (!runtime.availableToolIds.includes(call.toolId)) {
          throw new AgentRuntimeError(`工具 ${call.toolId} 不在本 turn 的可用范围内`);
        }
        await this.#executeTool(call, runtime.contributions, runtime.turn, boundary);
        if (this.#status !== "running") return;
      }
    }
    throw new AgentRuntimeError("单个 turn 超出模型边界上限");
  }

  #availableToolIds(contributions: TurnContributions): readonly string[] {
    const requested = this.#definition.toolIds ?? contributions.list("tool").map((tool) => tool.id);
    return [...new Set(requested)].filter((id) =>
      contributions.get("tool", id) !== undefined && this.#authority.toolIds.includes(id));
  }

  async #appendSteersAtBoundary(turn: number): Promise<void> {
    await this.#inbox.applySteersAtModelBoundary(turn);
  }

  async #persistModelRequest(
    request: ModelRequest,
    boundary: number,
    prompts: readonly string[],
  ): Promise<void> {
    await this.#store.append({
      executionId: this.#executionId,
      type: "model/request",
      payload: {
        turn: this.#turn,
        boundary,
        generation: request.generation,
        agentId: request.agentId,
        llmId: this.#definition.llmId,
        promptIds: this.#definition.promptIds,
        prompts,
        messages: request.messages.map((message) => ({ ...message })),
        availableToolIds: request.availableToolIds,
      },
    });
  }

  async #executeTool(
    call: ModelToolCall,
    contributions: TurnContributions,
    turn: number,
    boundary: number,
  ): Promise<void> {
    const tool = requiredContribution(contributions, "tool", call.toolId);
    await this.#budget.remainingMilliseconds();
    const context = {
      executionId: this.#executionId,
      generation: contributions.generation,
      signal: this.#abortController?.signal ?? AbortSignal.abort("执行已结束"),
      scope: this.#scope.identity,
      authority: this.#authority,
    };
    const originalArguments = structuredClone(call.arguments) as JsonObject;
    const prepared = snapshotPrepared(await tool.prepare(originalArguments, context));
    assertToolAuthority(this.#authority, tool.id, tool.effectClass, prepared.resourceRefs);
    const argumentsDigest = digestJson(prepared.normalizedArguments);
    const resourcesDigest = digestResources(prepared.resourceRefs);
    const requestedAt = this.#now();
    const requestedAtMs = Date.parse(requestedAt);
    if (!Number.isFinite(requestedAtMs)) throw new AgentRuntimeError("工具调用时间无效");
    const intent = snapshotToolIntent({
      id: call.id,
      executionId: this.#executionId,
      generation: contributions.generation,
      toolId: tool.id,
      toolVersion: tool.version,
      effectClass: tool.effectClass,
      intent: call.intent ?? `调用 ${tool.id}`,
      normalizedArguments: prepared.normalizedArguments,
      argumentsDigest,
      resourceRefs: prepared.resourceRefs,
      resourcesDigest,
      authorityCommitment: this.#authority.commitment,
      expiresAt: new Date(requestedAtMs + this.#toolIntentTtlMs).toISOString(),
    });
    await this.#store.append({
      executionId: this.#executionId,
      type: "tool/intent",
      payload: {
        toolCallId: intent.id,
        toolId: intent.toolId,
        toolVersion: intent.toolVersion,
        effectClass: intent.effectClass,
        intent: intent.intent,
        normalizedArguments: intent.normalizedArguments,
        argumentsDigest: intent.argumentsDigest,
        resourceRefs: intent.resourceRefs.map((resource) => ({
          namespace: resource.namespace,
          resourceId: resource.resourceId,
          ...(resource.digest === undefined ? {} : { digest: resource.digest }),
        })),
        resourcesDigest: intent.resourcesDigest,
        generation: intent.generation,
        authorityCommitment: intent.authorityCommitment,
        expiresAt: intent.expiresAt,
        turn,
        boundary,
      },
    });

    await this.#authorizeAndExecute(call, intent, originalArguments, turn, true);
  }

  async #authorizeAndExecute(
    call: ModelToolCall,
    intent: ToolCallIntent,
    originalArguments: JsonObject,
    turn: number,
    enterApprovalWait: boolean,
  ): Promise<void> {
    const context = {
      executionId: this.#executionId,
      generation: intent.generation,
      signal: this.#abortController?.signal ?? AbortSignal.abort("执行已结束"),
      scope: this.#scope.identity,
      authority: this.#authority,
    };
    const requiresManualApproval = !isPotentiallyAutoApprovable(intent.effectClass);
    if (requiresManualApproval && enterApprovalWait) {
      await this.#transition("waiting_approval", "工具调用等待人工批准");
    }
    const approvalSignal = context.signal;
    const authorization = await raceAbort(
      this.#approval.authorize(snapshotToolIntent(intent), approvalSignal),
      approvalSignal,
    );
    if (this.#status === "cancelled") return;
    if (authorization.mode === "deny") {
      throw new AgentRuntimeError(authorization.reason ?? "工具调用已被拒绝");
    }
    if (requiresManualApproval && authorization.mode !== "approve_once") {
      throw new AgentRuntimeError("高影响工具只能由人工单次批准");
    }
    const approvedIntent = authorization.mode === "auto"
      ? authorization.intent
      : authorization.approvedIntent;
    if (!sameApprovedIntent(approvedIntent, intent)) {
      throw new AgentRuntimeError("批准内容与已持久化工具调用不一致");
    }
    if (requiresManualApproval) {
      await this.#transition("running", "工具调用已获单次批准");
    }

    const currentContributions = this.#scope.resolveTurn();
    if (currentContributions.generation !== intent.generation) {
      throw new AgentRuntimeError("批准后插件代次已变化，必须重新请求批准");
    }
    if (call.toolId !== intent.toolId) {
      throw new AgentRuntimeError("持久化模型响应与工具调用意图不一致");
    }
    const currentTool = requiredContribution(currentContributions, "tool", intent.toolId);
    if (currentTool.version !== intent.toolVersion || currentTool.effectClass !== intent.effectClass) {
      throw new AgentRuntimeError("批准后工具版本或副作用类型已变化，必须重新请求批准");
    }
    if (this.#authority.commitment !== intent.authorityCommitment) {
      throw new AgentRuntimeError("批准后执行权限已变化，必须重新请求批准");
    }

    const revalidated = snapshotPrepared(await currentTool.prepare(
      structuredClone(originalArguments) as JsonObject,
      context,
    ));
    if (this.#scope.resolveTurn().generation !== intent.generation) {
      throw new AgentRuntimeError("工具复核期间插件代次已变化，必须重新请求批准");
    }
    assertToolAuthority(
      this.#authority,
      currentTool.id,
      currentTool.effectClass,
      revalidated.resourceRefs,
    );
    const currentIntent: ToolCallIntent = {
      ...intent,
      toolVersion: currentTool.version,
      effectClass: currentTool.effectClass,
      normalizedArguments: revalidated.normalizedArguments,
      argumentsDigest: digestJson(revalidated.normalizedArguments),
      resourceRefs: revalidated.resourceRefs,
      resourcesDigest: digestResources(revalidated.resourceRefs),
      authorityCommitment: this.#authority.commitment,
    };
    if (!sameApprovedIntent(intent, currentIntent)
      || !sameApprovedIntent(approvedIntent, currentIntent)) {
      throw new AgentRuntimeError("工具参数、资源或授权在批准后发生变化，已拒绝执行");
    }
    if (Date.parse(intent.expiresAt) <= validCurrentTime(this.#now())) {
      throw new AgentRuntimeError("工具调用批准已过期，必须重新请求批准");
    }

    let result: JsonValue;
    await this.#budget.remainingMilliseconds();
    await this.#store.append({ executionId: this.#executionId, type: "tool/started",
      payload: { toolCallId: call.id, toolId: currentTool.id, generation: intent.generation, turn } });
    if (context.signal.aborted || this.#status !== "running") return;
    try {
      result = await currentTool.execute(revalidated, context);
    } catch (error: unknown) {
      if (NON_REPLAYABLE_EFFECTS.has(currentTool.effectClass)) {
        await this.#store.append({
          executionId: this.#executionId,
          type: "tool/outcome_unknown",
          payload: {
            toolCallId: call.id,
            toolId: currentTool.id,
            effectClass: currentTool.effectClass,
            generation: intent.generation,
            message: "工具已开始执行，但未返回可持久化的确定结果",
          },
        });
        await this.#transition("needs_reconciliation", "外部副作用结果未知，需要人工核对");
        return;
      }
      throw error;
    }
    await this.#store.append({
      executionId: this.#executionId,
      type: "tool/result",
      payload: {
        toolCallId: call.id,
        toolId: currentTool.id,
        generation: intent.generation,
        result,
      },
    });
    await this.#sessionLog.append({
      role: "tool",
      content: jsonText(result),
      turn,
      name: currentTool.id,
      toolCallId: call.id,
    });
  }

  async #invokeModelWithinDeadline(llm: LlmContribution, request: ModelRequest) {
    const remaining = await this.#budget.remainingMilliseconds();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new ExecutionBudgetExceededError("duration")), remaining);
    timer.unref();
    const signal = AbortSignal.any([deadline.signal, this.#abortController?.signal ?? AbortSignal.abort("执行已结束")]);
    try {
      signal.throwIfAborted();
      return await raceAbort(llm.complete(request, { signal, scope: this.#scope.identity }), signal);
    } catch (error) {
      if (deadline.signal.aborted) throw new ExecutionBudgetExceededError("duration");
      throw error;
    } finally { clearTimeout(timer); }
  }

  async #transition(status: ExecutionStatus, reason: string): Promise<void> {
    const previous = this.#status;
    this.#status = status;
    try {
      await this.#store.append({
        executionId: this.#executionId,
        type: "execution/status",
        payload: { status, reason },
      });
    } catch (error: unknown) {
      if (this.#status === status) this.#status = previous;
      if (error instanceof RuntimeControlError && error.status !== status) {
        await this.#transition(error.status, error.message);
        return;
      }
      throw error;
    }
  }
}

function sameApprovedIntent(approved: Omit<ToolCallIntent, "normalizedArguments">, current: ToolCallIntent): boolean {
  return approvalStillMatches(approved, current)
    && approved.id === current.id
    && approved.effectClass === current.effectClass
    && approved.expiresAt === current.expiresAt;
}

function snapshotToolIntent(intent: ToolCallIntent): ToolCallIntent {
  return {
    ...intent,
    normalizedArguments: structuredClone(intent.normalizedArguments) as JsonObject,
    resourceRefs: intent.resourceRefs.map((resource) => ({ ...resource })),
  };
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AgentRuntimeError("执行已取消");
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new AgentRuntimeError("执行已取消"));
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function validCurrentTime(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new AgentRuntimeError("当前时间无效");
  return timestamp;
}

function requiredContribution<K extends "llm" | "prompt" | "tool">(
  contributions: TurnContributions,
  kind: K,
  id: string,
): K extends "llm" ? LlmContribution : K extends "tool" ? ToolContribution : import("./types.js").PromptContribution {
  const contribution = contributions.get(kind, id);
  if (contribution === undefined) throw new AgentRuntimeError(`${kind} 贡献 ${id} 不存在`);
  return contribution as never;
}

function latestStatus(records: readonly RuntimeRecord[]): ExecutionStatus | undefined {
  const record = records.filter((candidate) => candidate.type === "execution/status").at(-1);
  if (record === undefined) return undefined;
  const status = record.payload.status;
  if (typeof status !== "string" || !isExecutionStatus(status)) {
    throw new AgentRuntimeError("持久化 execution 状态无效");
  }
  return status;
}

function isExecutionStatus(status: string): status is ExecutionStatus {
  return [
    "queued", "running", "waiting_approval", "paused", "interrupted",
    "needs_reconciliation", "completed", "failed", "cancelled",
  ].includes(status);
}

function unresolvedToolIntents(records: readonly RuntimeRecord[]): readonly {
  readonly toolCallId: string;
  readonly effectClass: ToolEffectClass;
}[] {
  return findUnresolvedToolIntentRecords(records)
    .map((intent) => {
      const effectClass = stringField(intent.payload, "effectClass");
      if (!isToolEffectClass(effectClass)) throw new AgentRuntimeError("持久化工具副作用类型无效");
      return { toolCallId: stringField(intent.payload, "toolCallId"), effectClass };
    });
}

function uncertainNonReplayableIntent(records: readonly RuntimeRecord[]): {
  readonly toolCallId: string;
} | undefined {
  const unresolved = findUnresolvedToolIntentRecords(records)
    .filter((record) => {
      const effectClass = stringField(record.payload, "effectClass");
      if (!isToolEffectClass(effectClass)) throw new AgentRuntimeError("持久化工具副作用类型无效");
      if (!NON_REPLAYABLE_EFFECTS.has(effectClass)) return false;
      return records.some((candidate) => candidate.sequence > record.sequence
        && ((candidate.type === "execution/status" && candidate.payload.status === "running")
          || (candidate.type === "tool/started" && candidate.payload.toolCallId === record.payload.toolCallId)));
    })
    .at(-1);
  return unresolved === undefined
    ? undefined
    : { toolCallId: stringField(unresolved.payload, "toolCallId") };
}

function hasIncompleteTurn(records: readonly RuntimeRecord[]): boolean {
  const started = records
    .filter((record) => record.type === "turn/started")
    .map((record) => positiveIntegerField(record.payload, "turn"));
  const completed = new Set(records
    .filter((record) => record.type === "turn/completed")
    .map((record) => positiveIntegerField(record.payload, "turn")));
  return started.some((turn) => !completed.has(turn));
}

function isToolEffectClass(value: string): value is ToolEffectClass {
  return [
    "local_read", "external_read", "local_reversible_write", "local_irreversible_write",
    "external_side_effect", "financial", "privileged", "unknown",
  ].includes(value);
}

function snapshotPrepared(prepared: PreparedToolCall): PreparedToolCall {
  return {
    normalizedArguments: structuredClone(prepared.normalizedArguments) as JsonObject,
    resourceRefs: prepared.resourceRefs.map((resource) => ({ ...resource })),
  };
}

function digestResources(resources: readonly ResourceRef[]): string {
  return digestJson([...resources]
    .map((resource) => ({ ...resource }))
    .sort((left, right) => `${left.namespace}\u0000${left.resourceId}\u0000${left.digest ?? ""}`
      .localeCompare(`${right.namespace}\u0000${right.resourceId}\u0000${right.digest ?? ""}`)));
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function jsonText(value: JsonValue): string {
  return typeof value === "string" ? value : canonicalJson(value);
}

function stringField(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new AgentRuntimeError(`持久化字段 ${key} 无效`);
  return value;
}

function positiveIntegerField(payload: JsonObject, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AgentRuntimeError(`持久化字段 ${key} 无效`);
  }
  return value as number;
}
