// SPDX-License-Identifier: Apache-2.0

import { deepFreeze, snapshotJsonValue, type JsonValue } from "@mn/agent-protocol";
import type { ThreadProjectionV3, TurnStatusV3 } from "@mn/agent-session";
import type { PlatformToolAdapters, PlatformToolHandler } from "@mn/agent-tools";

import {
  ThreadManager,
  type ThreadTurnResult,
  type ThreadUserInput
} from "./thread-manager.js";

export interface MultiAgentManagerOptions {
  readonly threadManager: ThreadManager;
  readonly maxAgentsPerRoot?: number;
  readonly maxConcurrentPerRoot?: number;
  readonly maxDepth?: number;
}

export interface SpawnAgentInput {
  readonly objective: string;
  readonly role?: string;
  readonly tokenBudget?: number;
  readonly input?: readonly ThreadUserInput[];
}

export interface ChildAgentSnapshot {
  readonly threadId: string;
  readonly parentThreadId: string;
  readonly status: ThreadProjectionV3["status"] | TurnStatusV3;
  readonly role?: string;
}

export interface MultiAgentGraph {
  readonly rootThreadId: string;
  readonly children: readonly ChildAgentSnapshot[];
}

const USER_INPUT_TYPES = new Set<ThreadUserInput["type"]>([
  "text", "image", "localImage", "audio", "localAudio", "skill", "mention"
]);

function requiredString(args: Readonly<Record<string, JsonValue>>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function optionalString(args: Readonly<Record<string, JsonValue>>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalPositiveInteger(args: Readonly<Record<string, JsonValue>>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function jsonResult(value: unknown): JsonValue {
  const snapshot = snapshotJsonValue(value);
  if (snapshot === undefined) throw new TypeError("sub-agent result is not lossless JSON");
  return snapshot as JsonValue;
}

function userInput(value: JsonValue | undefined, fallback?: string): readonly ThreadUserInput[] {
  if (value === undefined) {
    if (fallback === undefined) throw new TypeError("sub-agent input is required");
    return Object.freeze([{ type: "text", text: fallback }]);
  }
  if (typeof value === "string") return Object.freeze([{ type: "text", text: value }]);
  if (!Array.isArray(value)) throw new TypeError("sub-agent input must be a string or an array");
  return Object.freeze(value.map((entry) => {
    if (entry === null || Array.isArray(entry) || typeof entry !== "object") {
      throw new TypeError("sub-agent input entry must be an object");
    }
    if (typeof entry.type !== "string" || !USER_INPUT_TYPES.has(entry.type as ThreadUserInput["type"])) {
      throw new TypeError("sub-agent input type is invalid");
    }
    const scalar = (name: "text" | "url" | "path" | "name"): string | undefined => {
      const candidate = entry[name];
      if (candidate === undefined || typeof candidate === "string") return candidate;
      throw new TypeError(`sub-agent input ${name} is invalid`);
    };
    const detail = entry.detail;
    if (detail !== undefined && detail !== null
      && (typeof detail !== "string" || !["auto", "low", "high", "original"].includes(detail))) {
      throw new TypeError("sub-agent input detail is invalid");
    }
    const text = scalar("text");
    const url = scalar("url");
    const path = scalar("path");
    const name = scalar("name");
    return {
      type: entry.type as ThreadUserInput["type"],
      ...(text === undefined ? {} : { text }),
      ...(url === undefined ? {} : { url }),
      ...(path === undefined ? {} : { path }),
      ...(name === undefined ? {} : { name }),
      ...(detail === undefined ? {} : { detail: detail as ThreadUserInput["detail"] })
    };
  }));
}

function threadIds(args: Readonly<Record<string, JsonValue>>): readonly string[] {
  const value = args.threadIds;
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError("threadIds must be a non-empty string array");
  }
  return value as readonly string[];
}

function handler(
  operation: (args: Readonly<Record<string, JsonValue>>, parentThreadId: string) => Promise<JsonValue>
): PlatformToolHandler {
  return (args, context) => operation(args, context.sessionId);
}

export function createSubAgentToolAdapters(manager: MultiAgentManager): NonNullable<PlatformToolAdapters["subagents"]> {
  return deepFreeze({
    spawn: handler(async (args, parentThreadId) => {
      const objective = requiredString(args, "objective");
      const role = optionalString(args, "role");
      const tokenBudget = optionalPositiveInteger(args, "tokenBudget");
      return jsonResult(await manager.spawn(parentThreadId, {
        objective,
        ...(role === undefined ? {} : { role }),
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
        input: userInput(args.input, objective)
      }));
    }),
    send: handler(async (args, parentThreadId) => jsonResult(await manager.send(
      parentThreadId,
      requiredString(args, "threadId"),
      userInput(args.input)
    ))),
    wait: handler(async (args, parentThreadId) => jsonResult(
      await manager.wait(parentThreadId, threadIds(args))
    )),
    interrupt: handler(async (args, parentThreadId) => {
      await manager.interrupt(parentThreadId, requiredString(args, "threadId"));
      return { status: "interrupted" };
    }),
    close: handler(async (args, parentThreadId) => {
      await manager.close(parentThreadId, requiredString(args, "threadId"));
      return { status: "closed" };
    }),
    resume: handler(async (args, parentThreadId) => jsonResult(await manager.resume(
      parentThreadId,
      requiredString(args, "threadId")
    )))
  });
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${label} must be a positive integer`);
  return resolved;
}

function turnInput(input: readonly ThreadUserInput[] | undefined, objective: string): readonly ThreadUserInput[] {
  return input ?? Object.freeze([{ type: "text", text: objective }]);
}

export class MultiAgentManager {
  readonly #threads: ThreadManager;
  readonly #maxAgents: number;
  readonly #maxConcurrent: number;
  readonly #maxDepth: number;
  readonly #operations = new Map<string, Promise<ThreadTurnResult>>();
  readonly #rootTails = new Map<string, Promise<void>>();

  constructor(options: MultiAgentManagerOptions) {
    this.#threads = options.threadManager;
    this.#maxAgents = positiveInteger(options.maxAgentsPerRoot, 6, "root agent limit");
    this.#maxConcurrent = positiveInteger(options.maxConcurrentPerRoot, 4, "root concurrency limit");
    this.#maxDepth = positiveInteger(options.maxDepth, 1, "agent depth limit");
  }

  async spawn(parentThreadId: string, input: SpawnAgentInput): Promise<ChildAgentSnapshot> {
    if (!input.objective.trim()) throw new TypeError("child agent objective must not be empty");
    if (input.tokenBudget !== undefined
      && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 1)) {
      throw new TypeError("child agent token budget must be a positive integer");
    }
    const rootThreadId = await this.#rootOf(parentThreadId);
    return this.#withRootLock(rootThreadId, async () => {
      const parent = await this.#threads.readThread(parentThreadId);
      if (parent.tombstoned || parent.archived) throw new Error("child agent parent is not active");
      const depth = await this.#depth(parent);
      if (depth + 1 > this.#maxDepth) throw new Error("child agent depth limit would be exceeded");
      const descendants = await this.#descendants(rootThreadId);
      const retained = descendants.filter((thread) => !thread.tombstoned);
      if (retained.length >= this.#maxAgents) throw new Error("root agent limit is exhausted");
      const active = new Set([
        ...retained.filter((thread) => thread.status === "active").map((thread) => thread.threadId),
        ...retained.filter((thread) => this.#operations.has(thread.threadId)).map((thread) => thread.threadId)
      ]);
      if (active.size >= this.#maxConcurrent) throw new Error("root concurrent agent limit is exhausted");

      const root = await this.#threads.readThread(rootThreadId);
      let childBudget = input.tokenBudget;
      if (root.goal?.tokenBudget !== undefined) {
        const allocated = retained.reduce((total, thread) => total + (thread.goal?.tokenBudget ?? 0), 0);
        const available = root.goal.tokenBudget - root.goal.tokensUsed - allocated;
        childBudget ??= available;
        if (childBudget < 1 || childBudget > available) {
          throw new Error("child agent token budget exceeds the root budget allocation");
        }
      }

      const child = await this.#threads.forkThread(parentThreadId, undefined, {
        source: "subAgent",
        inheritGoal: false,
        inheritName: false
      });
      if (input.role !== undefined) await this.#threads.setThreadName(child.threadId, input.role);
      await this.#threads.setGoal(child.threadId, {
        objective: input.objective,
        status: "active",
        ...(childBudget === undefined ? {} : { tokenBudget: childBudget })
      });
      await this.#activity(parentThreadId, child.threadId, "started", input.role);
      const operation = this.#threads.runTurn(child.threadId, { input: turnInput(input.input, input.objective) });
      this.#track(parentThreadId, child.threadId, input.role, operation);
      await new Promise((resolve) => setImmediate(resolve));
      const projected = await this.#threads.readThread(child.threadId);
      return deepFreeze({
        threadId: child.threadId,
        parentThreadId,
        status: projected.status,
        ...(input.role === undefined ? {} : { role: input.role })
      });
    });
  }

  async send(
    parentThreadId: string,
    childThreadId: string,
    input: readonly ThreadUserInput[]
  ): Promise<ThreadTurnResult | { readonly threadId: string; readonly status: "steered" }> {
    const child = await this.#child(parentThreadId, childThreadId);
    const activeTurn = [...child.turns].reverse().find((turn) => turn.status === "inProgress");
    if (activeTurn !== undefined) {
      await this.#threads.steerTurn(childThreadId, activeTurn.turnId, { input });
      await this.#activity(parentThreadId, childThreadId, "interacted", child.name);
      return deepFreeze({ threadId: childThreadId, status: "steered" });
    }
    const operation = this.#threads.runTurn(childThreadId, { input });
    this.#track(parentThreadId, childThreadId, child.name, operation);
    return operation;
  }

  async wait(parentThreadId: string, childThreadIds: readonly string[]): Promise<readonly ChildAgentSnapshot[]> {
    if (!Array.isArray(childThreadIds) || childThreadIds.length === 0) {
      throw new TypeError("child agent wait requires at least one thread");
    }
    return Object.freeze(await Promise.all(childThreadIds.map(async (childThreadId) => {
      const child = await this.#child(parentThreadId, childThreadId);
      const operation = this.#operations.get(childThreadId);
      const result = operation === undefined ? undefined : await operation;
      const projected = await this.#threads.readThread(childThreadId);
      return deepFreeze({
        threadId: childThreadId,
        parentThreadId,
        status: result?.status ?? projected.turns.at(-1)?.status ?? projected.status,
        ...(child.name === undefined ? {} : { role: child.name })
      });
    })));
  }

  async interrupt(parentThreadId: string, childThreadId: string): Promise<void> {
    const child = await this.#child(parentThreadId, childThreadId);
    const turn = [...child.turns].reverse().find((candidate) => candidate.status === "inProgress");
    if (!turn) throw new Error("child agent has no active turn");
    await this.#threads.interruptTurn(childThreadId, turn.turnId);
    await this.#activity(parentThreadId, childThreadId, "interrupted", child.name);
  }

  async close(parentThreadId: string, childThreadId: string): Promise<void> {
    const rootThreadId = await this.#rootOf(parentThreadId);
    await this.#withRootLock(rootThreadId, async () => {
      const child = await this.#child(parentThreadId, childThreadId);
      if (child.status === "active" || this.#operations.has(childThreadId)) {
        throw new Error("running child agent cannot be closed");
      }
      await this.#threads.deleteThread(childThreadId);
      await this.#activity(parentThreadId, childThreadId, "completed", child.name);
    });
  }

  async resume(parentThreadId: string, childThreadId: string): Promise<ChildAgentSnapshot> {
    const child = await this.#child(parentThreadId, childThreadId);
    if (child.tombstoned) throw new Error("closed child agent cannot be resumed");
    return deepFreeze({
      threadId: childThreadId,
      parentThreadId,
      status: child.turns.at(-1)?.status ?? child.status,
      ...(child.name === undefined ? {} : { role: child.name })
    });
  }

  async graph(threadId: string): Promise<MultiAgentGraph> {
    const rootThreadId = await this.#rootOf(threadId);
    const children = await this.#descendants(rootThreadId);
    return deepFreeze({
      rootThreadId,
      children: children.filter((child) => !child.tombstoned).map((child) => ({
        threadId: child.threadId,
        parentThreadId: child.parentThreadId as string,
        status: child.turns.at(-1)?.status ?? child.status,
        ...(child.name === undefined ? {} : { role: child.name })
      }))
    });
  }

  #track(
    parentThreadId: string,
    childThreadId: string,
    role: string | undefined,
    operation: Promise<ThreadTurnResult>
  ): void {
    const tracked = operation.then(async (result) => {
      await this.#activity(
        parentThreadId,
        childThreadId,
        result.status === "completed" ? "completed" : result.status === "interrupted" ? "interrupted" : "failed",
        role
      );
      return result;
    }, async (error: unknown) => {
      await this.#activity(parentThreadId, childThreadId, "failed", role);
      throw error;
    });
    this.#operations.set(childThreadId, tracked);
    void tracked.finally(() => {
      if (this.#operations.get(childThreadId) === tracked) this.#operations.delete(childThreadId);
    }).catch(() => undefined);
  }

  async #activity(
    parentThreadId: string,
    childThreadId: string,
    kind: "started" | "interacted" | "interrupted" | "completed" | "failed",
    role?: string
  ): Promise<void> {
    const rootThreadId = await this.#rootOf(parentThreadId);
    await this.#threads.recordItem(parentThreadId, {
      kind: "subAgentActivity",
      content: { childThreadId, kind, ...(role === undefined ? {} : { role }) },
      publicControls: {
        agentThreadId: childThreadId,
        agentPath: `${rootThreadId}/${childThreadId}`,
        kind
      }
    });
  }

  async #child(parentThreadId: string, childThreadId: string): Promise<ThreadProjectionV3> {
    const child = await this.#threads.readThread(childThreadId);
    if (child.parentThreadId !== parentThreadId) throw new Error("child agent does not belong to the parent thread");
    return child;
  }

  async #rootOf(threadId: string): Promise<string> {
    let current = await this.#threads.readThread(threadId);
    const seen = new Set<string>();
    while (current.parentThreadId !== undefined) {
      if (seen.has(current.threadId)) throw new Error("child agent graph contains a cycle");
      seen.add(current.threadId);
      current = await this.#threads.readThread(current.parentThreadId);
    }
    return current.threadId;
  }

  async #depth(thread: ThreadProjectionV3): Promise<number> {
    let depth = 0;
    let current = thread;
    const seen = new Set<string>();
    while (current.parentThreadId !== undefined) {
      if (seen.has(current.threadId)) throw new Error("child agent graph contains a cycle");
      seen.add(current.threadId);
      depth += 1;
      current = await this.#threads.readThread(current.parentThreadId);
    }
    return depth;
  }

  async #descendants(rootThreadId: string): Promise<readonly ThreadProjectionV3[]> {
    const threads = await this.#threads.listThreads({ includeTombstoned: true });
    const byId = new Map(threads.map((thread) => [thread.threadId, thread]));
    return threads.filter((thread) => {
      let current = thread;
      const seen = new Set<string>();
      while (current.parentThreadId !== undefined) {
        if (current.parentThreadId === rootThreadId) return true;
        if (seen.has(current.threadId)) throw new Error("child agent graph contains a cycle");
        seen.add(current.threadId);
        const parent = byId.get(current.parentThreadId);
        if (!parent) return false;
        current = parent;
      }
      return false;
    });
  }

  async #withRootLock<T>(rootThreadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#rootTails.get(rootThreadId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => tail);
    this.#rootTails.set(rootThreadId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#rootTails.get(rootThreadId) === queued) this.#rootTails.delete(rootThreadId);
    }
  }
}
