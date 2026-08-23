// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  EventId,
  SessionId,
  assertSafePublicControlIdV1,
  createProtectedJsonViewV1,
  createProtectedTextV1,
  createSafeRandomPublicControlIdV1,
  deepFreeze,
  digestJson,
  snapshotBoundedJsonValue,
  type AgentEventV3,
  type JsonValue
} from "@mn/agent-protocol";
import {
  type AgentEventV3Store,
  type ThreadGoalProjectionV3,
  type ThreadItemKindV3,
  type ThreadProjectionV3,
  type TurnStatusV3
} from "@mn/agent-session";
import { validateJsonSchemaValue, type JsonSchemaNode } from "@mn/agent-tools";

import {
  ContextCompactionError,
  ContextManager,
  type AssembledContext,
  type ContextAssemblyInput
} from "./context-manager.js";
import { ItemProjector } from "./item-projector.js";

const INLINE_ITEM_LIMIT_BYTES = 128 * 1024;

export interface ThreadUserInput {
  readonly type: "text" | "image" | "localImage" | "audio" | "localAudio" | "skill" | "mention";
  readonly text?: string;
  readonly url?: string;
  readonly path?: string;
  readonly name?: string;
  readonly detail?: "auto" | "low" | "high" | "original" | null;
}

export interface ThreadStartInput {
  readonly cwd: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly permissionProfile: string;
  readonly sandbox: Readonly<Record<string, JsonValue>>;
  readonly source: string;
  readonly parentThreadId?: string;
  readonly forkedFromTurnId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly candidateId?: string;
  readonly instructions?: ContextAssemblyInput;
}

export interface TurnTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface TurnExecutionResult {
  readonly status: "completed" | "interrupted" | "failed";
  readonly tokenUsage?: TurnTokenUsage;
  readonly structuredOutput?: JsonValue;
  readonly error?: string;
}

export interface RecordTurnItemInput {
  readonly kind: ThreadItemKindV3;
  readonly status?: "inProgress" | "completed" | "failed" | "declined" | "pending";
  readonly content: JsonValue;
  readonly publicControls?: Readonly<Record<string, JsonValue>>;
}

export interface TurnExecutionInput {
  readonly threadId: string;
  readonly turnId: string;
  readonly input: readonly ThreadUserInput[];
  readonly context: AssembledContext;
  readonly signal: AbortSignal;
  readonly outputSchema?: JsonSchemaNode;
  readonly recordItem: (item: RecordTurnItemInput) => Promise<string>;
}

export interface TurnExecutor {
  execute(input: TurnExecutionInput): Promise<TurnExecutionResult>;
  steer?(input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly input: readonly ThreadUserInput[];
    readonly clientUserMessageId?: string;
  }): Promise<void>;
}

export interface ThreadRunInput {
  readonly input: readonly ThreadUserInput[];
  readonly clientUserMessageId?: string;
  readonly outputSchema?: JsonSchemaNode;
  readonly context?: ContextAssemblyInput;
  readonly estimatedInputTokens?: number;
  readonly summarizeContext?: Parameters<ContextManager["compact"]>[0]["summarize"];
}

export interface ThreadSteerInput {
  readonly input: readonly ThreadUserInput[];
  readonly clientUserMessageId?: string;
}

export interface ThreadTurnResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: TurnStatusV3;
  readonly tokenUsage?: TurnTokenUsage;
  readonly structuredOutput?: JsonValue;
  readonly error?: string;
}

export interface ThreadGoalInput {
  readonly objective: string;
  readonly status: ThreadGoalProjectionV3["status"];
  readonly tokenBudget?: number;
}

export interface ThreadRecoveryState {
  readonly thread: ThreadProjectionV3;
  readonly activeTurnId?: string;
  readonly pendingApprovalItemIds: readonly string[];
  readonly inProgressItemIds: readonly string[];
  readonly lastSequence: number;
  readonly lastDigest: string;
}

export interface ThreadCas {
  put(content: Buffer): Promise<{ readonly uri: string; readonly digest: string; readonly bytes: number }>;
  get(uri: string): Promise<Buffer | undefined>;
}

export class InMemoryThreadCas implements ThreadCas {
  readonly #content = new Map<string, Buffer>();

  async put(content: Buffer): Promise<{ uri: string; digest: string; bytes: number }> {
    const bytes = Buffer.from(content);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const uri = `cas://sha256/${digest}`;
    this.#content.set(uri, bytes);
    return Object.freeze({ uri, digest, bytes: bytes.byteLength });
  }

  async get(uri: string): Promise<Buffer | undefined> {
    const content = this.#content.get(uri);
    return content === undefined ? undefined : Buffer.from(content);
  }
}

type IdKind = "thread" | "turn" | "item" | "event";

interface ActiveTurn {
  readonly turnId: string;
  readonly controller: AbortController;
  readonly operation: Promise<ThreadTurnResult>;
}

export interface ThreadManagerOptions {
  readonly store: AgentEventV3Store;
  readonly executor: TurnExecutor;
  readonly contextManager?: ContextManager;
  readonly cas?: ThreadCas;
  readonly id?: (kind: IdKind) => string;
  readonly now?: () => string;
  readonly itemProjector?: ItemProjector;
}

export interface ThreadForkOverrides {
  readonly cwd?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly permissionProfile?: string;
  readonly sandbox?: Readonly<Record<string, JsonValue>>;
  readonly source?: string;
  readonly inheritGoal?: boolean;
  readonly inheritName?: boolean;
}

function defaultId(kind: IdKind): string {
  return createSafeRandomPublicControlIdV1(kind);
}

function snapshotInputs(input: readonly ThreadUserInput[]): readonly ThreadUserInput[] {
  const snapshot = snapshotBoundedJsonValue(input);
  if (!Array.isArray(snapshot) || snapshot.length === 0) throw new TypeError("turn input must not be empty");
  return deepFreeze(snapshot as unknown as ThreadUserInput[]);
}

function snapshotUsage(value: TurnTokenUsage | undefined): TurnTokenUsage | undefined {
  if (value === undefined) return undefined;
  for (const [label, count] of Object.entries(value)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError(`${label} must be a non-negative integer`);
  }
  return deepFreeze({ ...value });
}

function terminalEventType(status: ThreadTurnResult["status"]): "turn/completed" | "turn/interrupted" | "turn/failed" {
  if (status === "completed") return "turn/completed";
  if (status === "interrupted") return "turn/interrupted";
  return "turn/failed";
}

export class ThreadManager {
  readonly #store: AgentEventV3Store;
  readonly #executor: TurnExecutor;
  readonly #contextManager: ContextManager;
  readonly #cas: ThreadCas;
  readonly #id: (kind: IdKind) => string;
  readonly #now: () => string;
  readonly #itemProjector: ItemProjector;
  readonly #active = new Map<string, ActiveTurn>();
  readonly #instructions = new Map<string, ContextAssemblyInput>();

  constructor(options: ThreadManagerOptions) {
    this.#store = options.store;
    this.#executor = options.executor;
    this.#contextManager = options.contextManager ?? new ContextManager({
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      safetyMarginTokens: 4_096
    });
    this.#cas = options.cas ?? new InMemoryThreadCas();
    this.#id = options.id ?? defaultId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#itemProjector = options.itemProjector ?? new ItemProjector();
  }

  async startThread(input: ThreadStartInput): Promise<ThreadProjectionV3> {
    const threadId = SessionId(this.#nextId("thread"));
    const associations = {
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId })
    };
    const projection = await this.#store.create({
      eventId: EventId(this.#nextId("event")),
      threadId,
      sequence: 0,
      occurredAt: this.#now(),
      type: "thread/created",
      correlationId: threadId,
      publicControls: {
        source: input.source,
        providerId: input.providerId,
        modelId: input.modelId,
        permissionProfile: input.permissionProfile,
        sandbox: input.sandbox,
        associations
      },
      protectedContent: createProtectedJsonViewV1({ cwd: input.cwd })
    });
    if (input.parentThreadId !== undefined) {
      await this.#append(threadId, "thread/forked", {
        parentThreadId: input.parentThreadId,
        ...(input.forkedFromTurnId === undefined ? {} : { forkedFromTurnId: input.forkedFromTurnId })
      });
    }
    if (input.instructions !== undefined) this.#instructions.set(threadId, input.instructions);
    return input.parentThreadId === undefined ? projection : this.readThread(threadId);
  }

  async readThread(threadId: string): Promise<ThreadProjectionV3> {
    return this.#itemProjector.project(await this.#store.read(SessionId(threadId)));
  }

  async listThreads(options: { readonly includeTombstoned?: boolean } = {}): Promise<readonly ThreadProjectionV3[]> {
    const threads = await this.#store.list();
    return options.includeTombstoned ? threads : Object.freeze(threads.filter((thread) => !thread.tombstoned));
  }

  async forkThread(
    parentThreadId: string,
    forkedFromTurnId?: string,
    overrides: ThreadForkOverrides = {}
  ): Promise<ThreadProjectionV3> {
    const parent = await this.readThread(parentThreadId);
    if (parent.tombstoned) throw new Error("tombstoned thread cannot be forked");
    if (forkedFromTurnId !== undefined
      && !parent.turns.some((turn) => turn.turnId === forkedFromTurnId)) {
      throw new Error("fork turn does not belong to the parent thread");
    }
    const child = await this.startThread({
      cwd: overrides.cwd ?? parent.cwd,
      providerId: overrides.providerId ?? parent.providerId,
      modelId: overrides.modelId ?? parent.modelId,
      permissionProfile: overrides.permissionProfile ?? parent.permissionProfile,
      sandbox: overrides.sandbox ?? parent.sandbox,
      source: overrides.source ?? parent.source,
      parentThreadId,
      ...(forkedFromTurnId === undefined ? {} : { forkedFromTurnId }),
      ...(parent.taskId === undefined ? {} : { taskId: parent.taskId }),
      ...(parent.runId === undefined ? {} : { runId: parent.runId }),
      ...(parent.candidateId === undefined ? {} : { candidateId: parent.candidateId })
    });
    if (parent.name !== undefined && overrides.inheritName !== false) {
      await this.setThreadName(child.threadId, parent.name);
    }
    if (parent.goal !== undefined && overrides.inheritGoal !== false) {
      await this.setGoal(child.threadId, {
        objective: parent.goal.objective.text,
        status: parent.goal.status,
        ...(parent.goal.tokenBudget === undefined ? {} : { tokenBudget: parent.goal.tokenBudget })
      });
    }
    return this.readThread(child.threadId);
  }

  async archiveThread(threadIdValue: string): Promise<void> {
    const threadId = SessionId(threadIdValue);
    if (this.#active.has(threadId)) throw new Error("active thread cannot be archived");
    const thread = await this.readThread(threadId);
    if (!thread.archived) await this.#append(threadId, "thread/archived", {});
  }

  async unarchiveThread(threadIdValue: string): Promise<ThreadProjectionV3> {
    const threadId = SessionId(threadIdValue);
    const thread = await this.readThread(threadId);
    if (thread.tombstoned) throw new Error("tombstoned thread cannot be unarchived");
    if (thread.archived) await this.#append(threadId, "thread/unarchived", {});
    return this.readThread(threadId);
  }

  async deleteThread(threadIdValue: string): Promise<void> {
    const threadId = SessionId(threadIdValue);
    if (this.#active.has(threadId)) throw new Error("active thread cannot be deleted");
    const thread = await this.readThread(threadId);
    if (!thread.tombstoned) {
      await this.#append(threadId, "thread/tombstoned", { retention: "evidence-preserved" });
    }
  }

  async setThreadName(threadIdValue: string, name: string): Promise<void> {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError("thread name must not be empty");
    }
    await this.#append(SessionId(threadIdValue), "thread/updated", { name });
  }

  async runTurn(threadIdValue: string, input: ThreadRunInput): Promise<ThreadTurnResult> {
    const threadId = SessionId(threadIdValue);
    const userInput = snapshotInputs(input.input);
    const inputDigest = digestJson(userInput as unknown as JsonValue);
    if (input.clientUserMessageId !== undefined) {
      assertSafePublicControlIdV1(input.clientUserMessageId, "client user message identifier");
      const replay = await this.#idempotentTurn(threadId, input.clientUserMessageId, inputDigest);
      if (replay !== undefined) return replay;
    }
    if (this.#active.has(threadId)) throw new Error("thread already has an active turn");
    const projection = await this.readThread(threadId);
    if (projection.archived || projection.tombstoned) throw new Error("thread cannot start a turn in its current state");
    if (projection.goal?.tokenBudget !== undefined
      && projection.goal.tokensUsed >= projection.goal.tokenBudget) {
      throw new Error("thread goal token budget is exhausted");
    }
    const turnId = this.#nextId("turn");
    await this.#append(threadId, "turn/started", { ordinal: projection.turns.length + 1 }, { turnId });
    await this.#recordUserItem(threadId, turnId, userInput, input.clientUserMessageId, inputDigest);
    const controller = new AbortController();
    const operation = this.#executeTurn(threadId, turnId, userInput, input, controller);
    this.#active.set(threadId, { turnId, controller, operation });
    void operation.finally(() => {
      if (this.#active.get(threadId)?.operation === operation) this.#active.delete(threadId);
    }).catch(() => undefined);
    return operation;
  }

  async steerTurn(threadIdValue: string, expectedTurnId: string, input: ThreadSteerInput): Promise<void> {
    const threadId = SessionId(threadIdValue);
    const active = this.#active.get(threadId);
    if (!active || active.turnId !== expectedTurnId) throw new Error("expected turn is not active");
    const userInput = snapshotInputs(input.input);
    const inputDigest = digestJson(userInput as unknown as JsonValue);
    if (input.clientUserMessageId !== undefined) {
      assertSafePublicControlIdV1(input.clientUserMessageId, "client user message identifier");
      const existing = await this.#findClientMessage(threadId, input.clientUserMessageId);
      if (existing !== undefined) {
        if (existing.publicControls.inputDigest !== inputDigest) {
          throw new Error("client user message identifier conflicts with different input");
        }
        return;
      }
    }
    await this.#recordUserItem(threadId, expectedTurnId, userInput, input.clientUserMessageId, inputDigest);
    await this.#append(threadId, "turn/steered", {
      ...(input.clientUserMessageId === undefined ? {} : { clientUserMessageId: input.clientUserMessageId })
    }, { turnId: expectedTurnId });
    await this.#executor.steer?.({
      threadId,
      turnId: expectedTurnId,
      input: userInput,
      ...(input.clientUserMessageId === undefined ? {} : { clientUserMessageId: input.clientUserMessageId })
    });
  }

  async interruptTurn(threadIdValue: string, turnId: string): Promise<void> {
    const active = this.#active.get(threadIdValue);
    if (!active || active.turnId !== turnId) throw new Error("turn is not active");
    active.controller.abort("turn interrupted");
  }

  async recordItem(
    threadIdValue: string,
    input: RecordTurnItemInput,
    turnId?: string
  ): Promise<string> {
    const threadId = SessionId(threadIdValue);
    const thread = await this.readThread(threadId);
    if (thread.tombstoned) throw new Error("tombstoned thread cannot accept items");
    if (turnId !== undefined && !thread.turns.some((turn) => turn.turnId === turnId)) {
      throw new Error("item turn does not belong to the thread");
    }
    return this.#recordItem(threadId, turnId, input);
  }

  async setGoal(threadIdValue: string, input: ThreadGoalInput): Promise<ThreadGoalProjectionV3> {
    if (!input.objective.trim()) throw new TypeError("thread goal objective must not be empty");
    if (input.tokenBudget !== undefined
      && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 1)) {
      throw new TypeError("thread goal token budget must be a positive integer");
    }
    const threadId = SessionId(threadIdValue);
    const existing = (await this.readThread(threadId)).goal;
    await this.#store.append(threadId, {
      eventId: EventId(this.#nextId("event")),
      occurredAt: this.#now(),
      type: "thread/goal-updated",
      correlationId: threadId,
      publicControls: {
        status: input.status,
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
        tokensUsed: existing?.tokensUsed ?? 0,
        timeUsedSeconds: existing?.timeUsedSeconds ?? 0
      },
      protectedContent: createProtectedJsonViewV1(null),
      currentSummary: createProtectedTextV1(input.objective),
      ...(existing === undefined ? {} : { previousSummary: existing.objective })
    });
    return (await this.readThread(threadId)).goal as ThreadGoalProjectionV3;
  }

  async getGoal(threadIdValue: string): Promise<ThreadGoalProjectionV3 | undefined> {
    return (await this.readThread(threadIdValue)).goal;
  }

  async clearGoal(threadIdValue: string): Promise<boolean> {
    const threadId = SessionId(threadIdValue);
    if ((await this.readThread(threadId)).goal === undefined) return false;
    await this.#store.append(threadId, {
      eventId: EventId(this.#nextId("event")),
      occurredAt: this.#now(),
      type: "thread/goal-cleared",
      correlationId: threadId,
      publicControls: {},
      protectedContent: createProtectedJsonViewV1(null)
    });
    return true;
  }

  async recoverThread(threadIdValue: string): Promise<ThreadRecoveryState> {
    const thread = await this.readThread(threadIdValue);
    const activeTurn = [...thread.turns].reverse().find((turn) => turn.status === "inProgress");
    return deepFreeze({
      thread,
      ...(activeTurn === undefined ? {} : { activeTurnId: activeTurn.turnId }),
      pendingApprovalItemIds: thread.items
        .filter((item) => item.kind === "approval" && item.status === "pending")
        .map((item) => item.itemId),
      inProgressItemIds: thread.items
        .filter((item) => item.status === "inProgress")
        .map((item) => item.itemId),
      lastSequence: thread.lastSequence,
      lastDigest: thread.lastDigest
    });
  }

  async compactThread(
    threadIdValue: string,
    summarize: Parameters<ContextManager["compact"]>[0]["summarize"],
    turnIdValue?: string
  ): Promise<string> {
    const threadId = SessionId(threadIdValue);
    const events = await this.#store.read(threadId);
    const projection = this.#itemProjector.project(events);
    const turnId = turnIdValue ?? projection.turns.at(-1)?.turnId;
    if (!turnId) throw new Error("context compaction requires a thread turn");
    const previousSummary = [...events].reverse().find((event) => event.type === "context/compacted")
      ?.currentSummary?.text;
    const artifactRefs = projection.items.flatMap((item) => {
      const direct = typeof item.publicControls.casRef === "string" ? [item.publicControls.casRef] : [];
      const listed = Array.isArray(item.publicControls.artifactRefs)
        ? item.publicControls.artifactRefs.filter((value): value is string => typeof value === "string")
        : [];
      return [...direct, ...listed];
    });
    const compacted = await this.#contextManager.compact({
      ...(previousSummary === undefined ? {} : { previousSummary }),
      ...(projection.goal === undefined ? {} : { goal: projection.goal.objective.text }),
      pendingApprovals: projection.items
        .filter((item) => item.kind === "approval" && item.status === "pending")
        .map((item) => item.itemId),
      plan: projection.items
        .filter((item) => item.kind === "plan")
        .map((item) => typeof item.publicControls.text === "string" ? item.publicControls.text : item.itemId),
      ...(typeof projection.items.at(-1)?.publicControls.diff === "string"
        ? { diff: projection.items.at(-1)?.publicControls.diff as string }
        : {}),
      artifactRefs: [...new Set(artifactRefs)],
      entries: this.#contextManager.assemble(this.#instructions.get(threadId) ?? {}).entries,
      summarize
    });
    await this.#store.append(threadId, {
      eventId: EventId(this.#nextId("event")),
      turnId,
      itemId: this.#nextId("item"),
      occurredAt: this.#now(),
      type: "context/compacted",
      correlationId: threadId,
      publicControls: {
        itemKind: "contextCompaction",
        status: "completed",
        artifactRefs: [...compacted.artifactRefs]
      },
      protectedContent: createProtectedJsonViewV1({ summary: compacted.summary }),
      ...(previousSummary === undefined ? {} : { previousSummary: createProtectedTextV1(previousSummary) }),
      currentSummary: createProtectedTextV1(compacted.summary)
    });
    return compacted.summary;
  }

  async #executeTurn(
    threadId: SessionId,
    turnId: string,
    input: readonly ThreadUserInput[],
    run: ThreadRunInput,
    controller: AbortController
  ): Promise<ThreadTurnResult> {
    let result: TurnExecutionResult;
    try {
      if (run.estimatedInputTokens !== undefined
        && this.#contextManager.needsCompaction(run.estimatedInputTokens)) {
        if (run.summarizeContext === undefined) throw new ContextCompactionError();
        await this.compactThread(threadId, run.summarizeContext, turnId);
      }
      result = await this.#executor.execute({
        threadId,
        turnId,
        input,
        context: this.#contextManager.assemble({
          ...this.#instructions.get(threadId),
          ...run.context,
          userInputs: input.map((entry) => JSON.stringify(entry))
        }),
        signal: controller.signal,
        ...(run.outputSchema === undefined ? {} : { outputSchema: run.outputSchema }),
        recordItem: (item) => this.#recordExecutorItem(threadId, turnId, item)
      });
    } catch (error: unknown) {
      result = {
        status: controller.signal.aborted || error instanceof ContextCompactionError
          ? "interrupted"
          : "failed",
        error: error instanceof ContextCompactionError ? error.message : "turn execution failed"
      };
    }
    const status = controller.signal.aborted ? "interrupted" : result.status;
    const usage = snapshotUsage(result.tokenUsage);
    let structuredOutput = result.structuredOutput;
    if (structuredOutput !== undefined) structuredOutput = snapshotBoundedJsonValue(structuredOutput);
    if (status === "completed" && run.outputSchema !== undefined) {
      const violations = validateJsonSchemaValue(run.outputSchema, structuredOutput);
      if (violations.length > 0) {
        structuredOutput = undefined;
        result = { ...result, status: "failed", error: `structured output failed validation: ${violations.join("; ")}` };
      }
    }
    const finalStatus = controller.signal.aborted ? "interrupted" : result.status;
    if (usage !== undefined) {
      await this.#append(
        threadId,
        "turn/progress",
        { tokenUsage: snapshotBoundedJsonValue(usage) },
        { turnId }
      );
      await this.#addGoalUsage(threadId, usage.inputTokens + usage.outputTokens);
    }
    await this.#append(threadId, terminalEventType(finalStatus), {
      status: finalStatus,
      ...(result.error === undefined ? {} : { error: result.error })
    }, { turnId });
    return deepFreeze({
      threadId,
      turnId,
      status: finalStatus,
      ...(usage === undefined ? {} : { tokenUsage: usage }),
      ...(structuredOutput === undefined ? {} : { structuredOutput }),
      ...(result.error === undefined ? {} : { error: result.error })
    });
  }

  async #recordExecutorItem(
    threadId: SessionId,
    turnId: string,
    input: RecordTurnItemInput
  ): Promise<string> {
    return this.#recordItem(threadId, turnId, input);
  }

  async #recordItem(
    threadId: SessionId,
    turnId: string | undefined,
    input: RecordTurnItemInput
  ): Promise<string> {
    const itemId = this.#nextId("item");
    const snapshot = snapshotBoundedJsonValue(input.content);
    const encoded = Buffer.from(JSON.stringify(snapshot), "utf8");
    let protectedContent;
    let spill: Readonly<Record<string, JsonValue>> = {};
    if (encoded.byteLength > INLINE_ITEM_LIMIT_BYTES) {
      const stored = await this.#cas.put(encoded);
      protectedContent = createProtectedJsonViewV1({
        summary: `content moved to CAS (${stored.bytes} bytes)`,
        uri: stored.uri,
        digest: stored.digest
      });
      spill = { casRef: stored.uri, contentDigest: stored.digest, contentBytes: stored.bytes, inlineTruncated: true };
    } else {
      protectedContent = createProtectedJsonViewV1(snapshot);
    }
    await this.#store.append(threadId, {
      eventId: EventId(this.#nextId("event")),
      ...(turnId === undefined ? {} : { turnId }),
      itemId,
      occurredAt: this.#now(),
      type: "item/recorded",
      correlationId: threadId,
      publicControls: {
        ...input.publicControls,
        itemKind: input.kind,
        status: input.status ?? "completed",
        ...spill
      },
      protectedContent
    });
    return itemId;
  }

  async #recordUserItem(
    threadId: SessionId,
    turnId: string,
    input: readonly ThreadUserInput[],
    clientUserMessageId: string | undefined,
    inputDigest: string
  ): Promise<void> {
    await this.#store.append(threadId, {
      eventId: EventId(this.#nextId("event")),
      turnId,
      itemId: this.#nextId("item"),
      occurredAt: this.#now(),
      type: "item/recorded",
      correlationId: threadId,
      publicControls: {
        itemKind: "userMessage",
        status: "completed",
        inputDigest,
        ...(clientUserMessageId === undefined ? {} : { clientUserMessageId })
      },
      protectedContent: createProtectedJsonViewV1(input)
    });
  }

  async #idempotentTurn(
    threadId: SessionId,
    clientUserMessageId: string,
    inputDigest: string
  ): Promise<ThreadTurnResult | undefined> {
    const existing = await this.#findClientMessage(threadId, clientUserMessageId);
    if (existing === undefined) return undefined;
    if (existing.publicControls.inputDigest !== inputDigest) {
      throw new Error("client user message identifier conflicts with different input");
    }
    const active = this.#active.get(threadId);
    if (active !== undefined && active.turnId === existing.turnId) return active.operation;
    const turn = (await this.readThread(threadId)).turns.find((candidate) => candidate.turnId === existing.turnId);
    if (!turn) throw new Error("idempotent turn projection is missing");
    return deepFreeze({ threadId, turnId: turn.turnId, status: turn.status });
  }

  async #findClientMessage(threadId: SessionId, clientUserMessageId: string): Promise<AgentEventV3 | undefined> {
    return (await this.#store.read(threadId)).find((event) =>
      event.type === "item/recorded"
      && event.publicControls.itemKind === "userMessage"
      && event.publicControls.clientUserMessageId === clientUserMessageId
    );
  }

  async #addGoalUsage(threadId: SessionId, tokens: number): Promise<void> {
    const goal = (await this.readThread(threadId)).goal;
    if (!goal) return;
    const tokensUsed = goal.tokensUsed + tokens;
    await this.#store.append(threadId, {
      eventId: EventId(this.#nextId("event")),
      occurredAt: this.#now(),
      type: "thread/goal-updated",
      correlationId: threadId,
      publicControls: {
        status: goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget ? "budgetLimited" : goal.status,
        ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
        tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds
      },
      protectedContent: createProtectedJsonViewV1(null),
      previousSummary: goal.objective,
      currentSummary: goal.objective
    });
  }

  #append(
    threadId: SessionId,
    type: "thread/updated" | "thread/forked" | "thread/archived" | "thread/unarchived"
      | "thread/tombstoned" | "turn/started" | "turn/steered" | "turn/progress"
      | "turn/completed" | "turn/interrupted" | "turn/failed",
    publicControls: Readonly<Record<string, JsonValue>>,
    ids: { readonly turnId?: string; readonly itemId?: string } = {}
  ): Promise<AgentEventV3> {
    return this.#store.append(threadId, {
      eventId: EventId(this.#nextId("event")),
      ...ids,
      occurredAt: this.#now(),
      type,
      correlationId: threadId,
      publicControls,
      protectedContent: createProtectedJsonViewV1(null)
    });
  }

  #nextId(kind: IdKind): string {
    const value = this.#id(kind);
    assertSafePublicControlIdV1(value, `${kind} identifier`);
    return value;
  }
}
