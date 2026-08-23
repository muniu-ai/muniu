// SPDX-License-Identifier: Apache-2.0

import type {
  ContextCompactionInput,
  ThreadManager,
  ThreadTurnResult,
  ThreadUserInput
} from "@mn/agent-kernel";
import type { JsonSchemaNode } from "@mn/agent-tools";
import type { JsonValue, ProtectedJsonNodeV1 } from "@mn/agent-protocol";
import type {
  ThreadItemProjectionV3,
  ThreadProjectionV3,
  ThreadTurnProjectionV3
} from "@mn/agent-session";
import {
  FileUpdateChangeSchema,
  ThreadSchema,
  type MethodResult,
  type ServerNotificationMethod,
  type ServerNotificationParams,
  type Thread,
  type ThreadItem,
  type Turn,
  type UserInput
} from "@mn/app-server-protocol";

import { RpcFault, type AppServerHandlers } from "./connection.js";

type Notify = <M extends ServerNotificationMethod>(
  method: M,
  params: ServerNotificationParams<M>
) => void | Promise<void>;

export interface CoreHandlerDefaults {
  readonly cwd: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly permissionProfile: string;
  readonly sandbox: Readonly<Record<string, JsonValue>>;
  readonly approvalPolicy?: "untrusted" | "on-request" | "never";
  readonly approvalsReviewer?: "user" | "auto_review" | "guardian_subagent";
  readonly instructionSources?: readonly string[];
}

export interface CoreAppServerHandlerOptions {
  readonly threads: ThreadManager;
  readonly defaults: CoreHandlerDefaults;
  readonly notify?: Notify;
  readonly compact?: ContextCompactionInput["summarize"];
  readonly models?: () => Promise<MethodResult<"model/list">["data"]>;
  readonly skills?: (cwds: readonly string[], forceReload: boolean) => Promise<MethodResult<"skills/list">>;
  readonly setSkillExtraRoots?: (roots: readonly string[]) => Promise<void>;
  readonly hooks?: (cwds: readonly string[]) => Promise<MethodResult<"hooks/list">>;
  readonly readConfig?: (cwd: string | undefined, includeLayers: boolean) => Promise<MethodResult<"config/read">>;
  readonly reloadMcp?: () => Promise<void>;
  readonly listMcpServers?: (params: {
    readonly cursor?: string | null;
    readonly limit?: number | null;
    readonly threadId?: string | null;
    readonly detail?: "full" | "toolsAndAuthOnly" | null;
  }) => Promise<MethodResult<"mcpServerStatus/list">>;
  readonly readMcpResource?: (params: {
    readonly server: string;
    readonly uri: string;
    readonly threadId?: string | null;
    readonly connectorId?: string | null;
    readonly originCallId?: string | null;
  }) => Promise<MethodResult<"mcpServer/resource/read">>;
  readonly callMcpTool?: (params: {
    readonly server: string;
    readonly tool: string;
    readonly threadId: string;
    readonly arguments?: JsonValue;
    readonly _meta?: JsonValue;
  }) => Promise<MethodResult<"mcpServer/tool/call">>;
}

function jsonFromProtected(node: ProtectedJsonNodeV1): JsonValue {
  if (node.type === "null") return null;
  if (node.type === "boolean" || node.type === "number") return node.value;
  if (node.type === "string") return node.value.text;
  if (node.type === "array") return node.items.map(jsonFromProtected);
  return Object.fromEntries(node.entries.map((entry) => [entry.key.text, jsonFromProtected(entry.value)]));
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function string(value: JsonValue | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function integer(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}

function itemStatus(item: ThreadItemProjectionV3): "inProgress" | "completed" | "failed" | "declined" {
  if (item.status === "pending") return "inProgress";
  return item.status;
}

function projectInput(value: JsonValue): UserInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof entry.type !== "string") return [];
    return [entry as unknown as UserInput];
  });
}

function fileChanges(value: JsonValue | undefined): Array<{
  path: string;
  kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path?: string | null };
  diff: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = FileUpdateChangeSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function projectItem(item: ThreadItemProjectionV3): ThreadItem {
  const content = jsonFromProtected(item.protectedContent.root);
  const body = record(content);
  const controls = item.publicControls;
  switch (item.kind) {
    case "userMessage":
      return {
        id: item.itemId,
        type: "userMessage",
        content: projectInput(content),
        ...(typeof controls.clientUserMessageId === "string" ? { clientId: controls.clientUserMessageId } : {})
      };
    case "agentMessage":
      return { id: item.itemId, type: "agentMessage", text: string(body.text, string(content)) };
    case "plan":
      return { id: item.itemId, type: "plan", text: string(controls.text, string(body.text, string(content))) };
    case "reasoning": {
      const summary = Array.isArray(body.summary) ? body.summary.filter((entry): entry is string => typeof entry === "string") : [];
      return { id: item.itemId, type: "reasoning", summary };
    }
    case "commandExecution":
      return {
        id: item.itemId,
        type: "commandExecution",
        command: string(controls.command, string(body.command)),
        cwd: string(controls.cwd, string(body.cwd, ".")),
        status: itemStatus(item),
        commandActions: Array.isArray(controls.commandActions)
          ? controls.commandActions.filter((entry): entry is Record<string, JsonValue> => entry !== null && typeof entry === "object" && !Array.isArray(entry))
          : [],
        ...(typeof controls.aggregatedOutput === "string" ? { aggregatedOutput: controls.aggregatedOutput } : {}),
        ...(integer(controls.exitCode) === undefined ? {} : { exitCode: integer(controls.exitCode) }),
        ...(integer(controls.durationMs) === undefined ? {} : { durationMs: integer(controls.durationMs) }),
        ...(typeof controls.processId === "string" ? { processId: controls.processId } : {})
      };
    case "fileChange":
      return {
        id: item.itemId,
        type: "fileChange",
        status: itemStatus(item),
        changes: fileChanges(body.changes)
      };
    case "mcpToolCall":
      return {
        id: item.itemId,
        type: "mcpToolCall",
        server: string(controls.server, string(body.server, "unknown")),
        tool: string(controls.tool, string(body.tool, "unknown")),
        arguments: body.arguments ?? {},
        status: item.status === "declined" ? "failed" : item.status === "pending" ? "inProgress" : item.status,
        ...(body.result === undefined ? {} : { result: body.result }),
        ...(body.error === undefined ? {} : { error: body.error }),
        ...(integer(controls.durationMs) === undefined ? {} : { durationMs: integer(controls.durationMs) })
      };
    case "dynamicToolCall":
      return {
        id: item.itemId,
        type: "dynamicToolCall",
        ...(typeof controls.namespace === "string" ? { namespace: controls.namespace } : {}),
        tool: string(controls.tool, string(body.tool, "unknown")),
        arguments: body.arguments ?? {},
        status: item.status === "declined" ? "failed" : item.status === "pending" ? "inProgress" : item.status,
        ...(typeof body.success === "boolean" ? { success: body.success } : {}),
        ...(Array.isArray(body.contentItems) ? { contentItems: body.contentItems } : {}),
        ...(integer(controls.durationMs) === undefined ? {} : { durationMs: integer(controls.durationMs) })
      };
    case "subAgentActivity":
      return {
        id: item.itemId,
        type: "subAgentActivity",
        agentThreadId: string(controls.agentThreadId),
        agentPath: string(controls.agentPath),
        kind: string(controls.kind, "interacted") as "started" | "interacted" | "interrupted" | "completed" | "failed"
      };
    case "webSearch":
      return {
        id: item.itemId,
        type: "webSearch",
        query: string(controls.query, string(body.query)),
        ...(Array.isArray(body.results) ? { results: body.results } : {})
      };
    case "attachment":
      return {
        id: item.itemId,
        type: "attachment",
        name: string(controls.name, string(body.name, "attachment")),
        mimeType: string(controls.mimeType, string(body.mimeType, "application/octet-stream")),
        uri: string(controls.uri, string(body.uri, string(controls.casRef, "cas:missing"))),
        digest: string(controls.digest, string(body.digest, string(controls.contentDigest, item.protectedContent.digest)))
      };
    case "contextCompaction":
      return {
        id: item.itemId,
        type: "contextCompaction",
        ...(typeof body.previousSummary === "string" ? { previousSummary: body.previousSummary } : {}),
        ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
        ...(Array.isArray(controls.artifactRefs)
          ? { artifactRefs: controls.artifactRefs.filter((entry): entry is string => typeof entry === "string") }
          : {})
      };
    case "approval": {
      const approvalStatus = string(controls.approvalStatus);
      return {
        id: item.itemId,
        type: "approval",
        approvalId: string(controls.approvalId, item.itemId),
        effectCommitment: item.effectCommitment?.tag ?? string(controls.effectCommitment, item.protectedContent.digest),
        status: (["pending", "accepted", "declined", "cancelled", "expired"] as const).includes(approvalStatus as never)
          ? approvalStatus as "pending" | "accepted" | "declined" | "cancelled" | "expired"
          : item.status === "pending" ? "pending" : item.status === "declined" ? "declined" : "accepted"
      };
    }
    case "evidenceCheckpoint":
      return {
        id: item.itemId,
        type: "evidenceCheckpoint",
        evidenceId: string(controls.evidenceId, item.itemId),
        digest: string(controls.digest, item.protectedContent.digest),
        status: string(controls.evidenceStatus, item.status === "failed" ? "failed" : "recorded") as "recorded" | "verified" | "failed"
      };
  }
}

function projectTurn(thread: ThreadProjectionV3, turn: ThreadTurnProjectionV3): Turn {
  const items = turn.itemIds.flatMap((itemId) => {
    const item = thread.items.find((candidate) => candidate.itemId === itemId);
    return item === undefined ? [] : [projectItem(item)];
  });
  return {
    id: turn.turnId,
    status: turn.status,
    items,
    startedAt: timestamp(turn.startedAt),
    ...(turn.completedAt === undefined ? {} : {
      completedAt: timestamp(turn.completedAt),
      durationMs: Math.max(0, Date.parse(turn.completedAt) - Date.parse(turn.startedAt))
    })
  };
}

export function projectAppServerThread(thread: ThreadProjectionV3): Thread {
  const turns = thread.turns.map((turn) => projectTurn(thread, turn));
  const lastAgentMessage = [...turns].reverse().flatMap((turn) => [...turn.items].reverse())
    .find((item) => item.type === "agentMessage");
  const source = thread.source === "subAgent"
    ? { subAgent: { parentThreadId: thread.parentThreadId ?? "" } }
    : (["cli", "vscode", "exec", "appServer", "unknown"] as const).includes(thread.source as never)
      ? thread.source as "cli" | "vscode" | "exec" | "appServer" | "unknown"
      : { custom: thread.source };
  const value = {
    id: thread.threadId,
    sessionId: thread.threadId,
    preview: lastAgentMessage?.type === "agentMessage" ? lastAgentMessage.text : thread.name ?? "",
    modelProvider: thread.providerId,
    cliVersion: "0.2.0",
    createdAt: timestamp(thread.createdAt),
    updatedAt: timestamp(thread.updatedAt),
    recencyAt: timestamp(thread.updatedAt),
    cwd: thread.cwd,
    source,
    status: thread.status === "active"
      ? { type: "active" as const, activeFlags: [] }
      : thread.status === "systemError" ? { type: "systemError" as const } : { type: "idle" as const },
    turns,
    ...(thread.name === undefined ? {} : { name: thread.name }),
    ...(thread.parentThreadId === undefined ? {} : { parentThreadId: thread.parentThreadId }),
    ...(thread.forkedFromTurnId === undefined ? {} : { forkedFromId: thread.forkedFromTurnId }),
    projectId: null,
    ephemeral: false,
    muniu: {
      providerId: thread.providerId,
      modelId: thread.modelId,
      permissionProfile: thread.permissionProfile,
      sandbox: thread.sandbox,
      ...(thread.goal === undefined ? {} : { goal: {
        threadId: thread.threadId,
        objective: thread.goal.objective.text,
        status: thread.goal.status,
        ...(thread.goal.tokenBudget === undefined ? {} : { tokenBudget: thread.goal.tokenBudget }),
        tokensUsed: thread.goal.tokensUsed,
        timeUsedSeconds: thread.goal.timeUsedSeconds,
        createdAt: timestamp(thread.goal.createdAt),
        updatedAt: timestamp(thread.goal.updatedAt)
      } }),
      ...(thread.taskId === undefined ? {} : { taskId: thread.taskId }),
      ...(thread.runId === undefined ? {} : { runId: thread.runId }),
      ...(thread.candidateId === undefined ? {} : { candidateId: thread.candidateId }),
      evidenceIds: [],
      archived: thread.archived,
      tombstoned: thread.tombstoned
    }
  };
  return ThreadSchema.parse(value);
}

function runtimeResult(thread: ThreadProjectionV3, defaults: CoreHandlerDefaults): MethodResult<"thread/start"> {
  return {
    thread: projectAppServerThread(thread),
    model: thread.modelId,
    modelProvider: thread.providerId,
    cwd: thread.cwd,
    instructionSources: [...(defaults.instructionSources ?? [])],
    approvalPolicy: defaults.approvalPolicy ?? "on-request",
    approvalsReviewer: defaults.approvalsReviewer ?? "user",
    sandbox: thread.sandbox
  };
}

function offset(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null) return 0;
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RpcFault(-32602, "Invalid cursor");
  return parsed;
}

async function emitItems(notify: Notify | undefined, thread: ThreadProjectionV3, turn: Turn, ids: Set<string>): Promise<void> {
  if (!notify) return;
  for (const item of turn.items) {
    if (ids.has(item.id)) continue;
    const projected = thread.items.find((candidate) => candidate.itemId === item.id);
    await notify("item/completed", {
      threadId: thread.threadId,
      turnId: turn.id,
      item,
      completedAtMs: projected === undefined ? Date.now() : Date.parse(projected.updatedAt)
    });
    ids.add(item.id);
  }
}

export function createCoreAppServerHandlers(options: CoreAppServerHandlerOptions): AppServerHandlers {
  const notify = options.notify;
  const startTurn = async (threadId: string, input: readonly ThreadUserInput[], run: {
    readonly clientUserMessageId?: string | null;
    readonly outputSchema?: JsonValue;
  } = {}): Promise<Turn> => {
    const before = await options.threads.readThread(threadId);
    const operation = options.threads.runTurn(threadId, {
      input,
      ...(run.clientUserMessageId === undefined || run.clientUserMessageId === null
        ? {}
        : { clientUserMessageId: run.clientUserMessageId }),
      ...(run.outputSchema === undefined ? {} : { outputSchema: run.outputSchema as JsonSchemaNode })
    });
    let projected = before;
    for (let attempt = 0; attempt < 32 && projected.turns.length === before.turns.length; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      projected = await options.threads.readThread(threadId);
    }
    const turnProjection = projected.turns.at(-1);
    if (!turnProjection || projected.turns.length === before.turns.length) {
      await operation;
      throw new RpcFault(-32603, "Turn did not start");
    }
    const turn = projectTurn(projected, turnProjection);
    await notify?.("turn/started", { threadId, turn });
    const emitted = new Set<string>();
    await emitItems(notify, projected, turn, emitted);
    void operation.then(async (_result: ThreadTurnResult) => {
      const completedThread = await options.threads.readThread(threadId);
      const completedProjection = completedThread.turns.find((candidate) => candidate.turnId === turn.id);
      if (!completedProjection) return;
      const completed = projectTurn(completedThread, completedProjection);
      await emitItems(notify, completedThread, completed, emitted);
      await notify?.("turn/completed", { threadId, turn: completed });
    }).catch(async () => {
      await notify?.("warning", { threadId, message: "Turn completion could not be projected." });
    });
    return turn;
  };

  const handlers = {
    "thread/start": async (params: Parameters<AppServerHandlers["thread/start"]>[0]) => {
      const thread = await options.threads.startThread({
        cwd: params.cwd ?? options.defaults.cwd,
        providerId: params.modelProvider ?? options.defaults.providerId,
        modelId: params.model ?? options.defaults.modelId,
        permissionProfile: params.approvalPolicy ?? options.defaults.permissionProfile,
        sandbox: params.sandbox === undefined || params.sandbox === null
          ? options.defaults.sandbox
          : { mode: params.sandbox },
        source: params.threadSource ?? "appServer",
        instructions: {
          ...(params.baseInstructions === undefined || params.baseInstructions === null
            ? {}
            : { systemInvariants: [params.baseInstructions] }),
          ...(params.developerInstructions === undefined || params.developerInstructions === null
            ? {}
            : { appDeveloperInstructions: [params.developerInstructions] })
        }
      });
      const result = runtimeResult(thread, options.defaults);
      await notify?.("thread/started", { thread: result.thread });
      return result;
    },
    "thread/resume": async (params: Parameters<AppServerHandlers["thread/resume"]>[0]) =>
      runtimeResult(await options.threads.readThread(params.threadId), options.defaults),
    "thread/fork": async (params: Parameters<AppServerHandlers["thread/fork"]>[0]) => {
      const thread = await options.threads.forkThread(params.threadId, params.lastTurnId ?? undefined, {
        ...(params.cwd === undefined || params.cwd === null ? {} : { cwd: params.cwd }),
        ...(params.modelProvider === undefined || params.modelProvider === null ? {} : { providerId: params.modelProvider }),
        ...(params.model === undefined || params.model === null ? {} : { modelId: params.model }),
        ...(params.approvalPolicy === undefined || params.approvalPolicy === null ? {} : { permissionProfile: params.approvalPolicy }),
        ...(params.sandbox === undefined || params.sandbox === null ? {} : { sandbox: { mode: params.sandbox } })
      });
      const result = runtimeResult(thread, options.defaults);
      await notify?.("thread/started", { thread: result.thread });
      return result;
    },
    "thread/list": async (params: Parameters<AppServerHandlers["thread/list"]>[0]) => {
      let threads = [...await options.threads.listThreads()]
        .filter((thread) => thread.archived === (params.archived ?? false));
      if (params.modelProviders?.length) threads = threads.filter((thread) => params.modelProviders?.includes(thread.providerId));
      if (params.sourceKinds?.length) threads = threads.filter((thread) => params.sourceKinds?.includes(thread.source));
      if (params.cwd !== undefined && params.cwd !== null) {
        const cwds = Array.isArray(params.cwd) ? params.cwd : [params.cwd];
        threads = threads.filter((thread) => cwds.includes(thread.cwd));
      }
      if (params.searchTerm) {
        const term = params.searchTerm.toLocaleLowerCase();
        threads = threads.filter((thread) => thread.name?.toLocaleLowerCase().includes(term) || thread.threadId.includes(term));
      }
      threads.sort((left, right) => {
        const delta = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
        return params.sortDirection === "asc" ? delta : -delta;
      });
      const start = offset(params.cursor);
      const limit = params.limit ?? 100;
      const data = threads.slice(start, start + limit).map(projectAppServerThread);
      return {
        data,
        ...(start + data.length >= threads.length ? {} : { nextCursor: String(start + data.length) }),
        ...(start === 0 ? {} : { backwardsCursor: String(Math.max(0, start - limit)) })
      };
    },
    "thread/loaded/list": async (params: Parameters<AppServerHandlers["thread/loaded/list"]>[0]) => {
      const threads = await options.threads.listThreads();
      const start = offset(params.cursor);
      const limit = params.limit ?? 100;
      const data = threads.slice(start, start + limit).map((thread) => thread.threadId);
      return { data, ...(start + data.length >= threads.length ? {} : { nextCursor: String(start + data.length) }) };
    },
    "thread/read": async (params: Parameters<AppServerHandlers["thread/read"]>[0]) => ({
      thread: projectAppServerThread(await options.threads.readThread(params.threadId))
    }),
    "thread/archive": async (params: Parameters<AppServerHandlers["thread/archive"]>[0]) => {
      await options.threads.archiveThread(params.threadId);
      await notify?.("thread/archived", { threadId: params.threadId });
      return {};
    },
    "thread/unarchive": async (params: Parameters<AppServerHandlers["thread/unarchive"]>[0]) => {
      const thread = await options.threads.unarchiveThread(params.threadId);
      await notify?.("thread/unarchived", { threadId: params.threadId });
      return { thread: projectAppServerThread(thread) };
    },
    "thread/delete": async (params: Parameters<AppServerHandlers["thread/delete"]>[0]) => {
      await options.threads.deleteThread(params.threadId);
      await notify?.("thread/deleted", { threadId: params.threadId });
      return {};
    },
    "thread/unsubscribe": async () => ({ status: "notSubscribed" as const }),
    "thread/name/set": async (params: Parameters<AppServerHandlers["thread/name/set"]>[0]) => {
      await options.threads.setThreadName(params.threadId, params.name);
      await notify?.("thread/name/updated", { threadId: params.threadId, threadName: params.name });
      return {};
    },
    "thread/goal/set": async (params: Parameters<AppServerHandlers["thread/goal/set"]>[0]) => {
      const existing = await options.threads.getGoal(params.threadId);
      const objective = params.objective ?? existing?.objective.text;
      if (!objective) throw new RpcFault(-32602, "Goal objective is required");
      const goal = await options.threads.setGoal(params.threadId, {
        objective,
        status: params.status ?? existing?.status ?? "active",
        ...(params.tokenBudget === undefined || params.tokenBudget === null ? {} : { tokenBudget: params.tokenBudget })
      });
      const projected = projectAppServerThread(await options.threads.readThread(params.threadId)).muniu.goal;
      if (!projected) throw new RpcFault(-32603, "Goal projection failed");
      await notify?.("thread/goal/updated", { threadId: params.threadId, goal: projected });
      return { goal: projected };
    },
    "thread/goal/get": async (params: Parameters<AppServerHandlers["thread/goal/get"]>[0]) => ({
      goal: projectAppServerThread(await options.threads.readThread(params.threadId)).muniu.goal
    }),
    "thread/goal/clear": async (params: Parameters<AppServerHandlers["thread/goal/clear"]>[0]) => {
      const cleared = await options.threads.clearGoal(params.threadId);
      if (cleared) await notify?.("thread/goal/cleared", { threadId: params.threadId });
      return { cleared };
    },
    "thread/compact/start": async (params: Parameters<AppServerHandlers["thread/compact/start"]>[0]) => {
      if (!options.compact) throw new RpcFault(-32004, "Context summarizer is unavailable");
      await options.threads.compactThread(params.threadId, options.compact);
      const thread = await options.threads.readThread(params.threadId);
      const turn = thread.turns.at(-1);
      if (turn) await notify?.("thread/compacted", { threadId: params.threadId, turnId: turn.turnId });
      return {};
    },
    "turn/start": async (params: Parameters<AppServerHandlers["turn/start"]>[0]) => ({
      turn: await startTurn(params.threadId, params.input, {
        clientUserMessageId: params.clientUserMessageId,
        outputSchema: params.outputSchema
      })
    }),
    "turn/steer": async (params: Parameters<AppServerHandlers["turn/steer"]>[0]) => {
      await options.threads.steerTurn(params.threadId, params.expectedTurnId, {
        input: params.input,
        ...(params.clientUserMessageId === undefined || params.clientUserMessageId === null
          ? {}
          : { clientUserMessageId: params.clientUserMessageId })
      });
      return { turnId: params.expectedTurnId };
    },
    "turn/interrupt": async (params: Parameters<AppServerHandlers["turn/interrupt"]>[0]) => {
      await options.threads.interruptTurn(params.threadId, params.turnId);
      return {};
    },
    "review/start": async (params: Parameters<AppServerHandlers["review/start"]>[0]) => {
      const child = await options.threads.forkThread(params.threadId, undefined, { source: "review" });
      const instructions = params.target.type === "custom"
        ? params.target.instructions
        : `Review target: ${JSON.stringify(params.target)}`;
      const turn = await startTurn(child.threadId, [{ type: "text", text: instructions }]);
      return { reviewThreadId: child.threadId, turn };
    },
    "model/list": async (params: Parameters<AppServerHandlers["model/list"]>[0]) => {
      const models = options.models ? await options.models() : [];
      const visible = params.includeHidden ? models : models.filter((model) => !model.hidden);
      const start = offset(params.cursor);
      const limit = params.limit ?? 100;
      const data = visible.slice(start, start + limit);
      return { data, ...(start + data.length >= visible.length ? {} : { nextCursor: String(start + data.length) }) };
    },
    "skills/list": async (params: Parameters<AppServerHandlers["skills/list"]>[0]) =>
      options.skills?.(params.cwds ?? [options.defaults.cwd], params.forceReload ?? false)
        ?? { data: (params.cwds ?? [options.defaults.cwd]).map((cwd) => ({ cwd, skills: [], errors: [] })) },
    "skills/extraRoots/set": async (params: Parameters<AppServerHandlers["skills/extraRoots/set"]>[0]) => {
      await options.setSkillExtraRoots?.(params.extraRoots);
      return {};
    },
    "hooks/list": async (params: Parameters<AppServerHandlers["hooks/list"]>[0]) =>
      options.hooks?.(params.cwds ?? [options.defaults.cwd])
        ?? { data: (params.cwds ?? [options.defaults.cwd]).map((cwd) => ({ cwd, hooks: [], errors: [], warnings: [] })) },
    "config/read": async (params: Parameters<AppServerHandlers["config/read"]>[0]) =>
      options.readConfig?.(params.cwd ?? undefined, params.includeLayers ?? false)
        ?? { config: {}, origins: {} },
    "config/mcpServer/reload": async () => {
      await options.reloadMcp?.();
      return {};
    },
    "mcpServerStatus/list": async (params: Parameters<AppServerHandlers["mcpServerStatus/list"]>[0]) =>
      options.listMcpServers?.(params) ?? { data: [] },
    "mcpServer/resource/read": async (params: Parameters<AppServerHandlers["mcpServer/resource/read"]>[0]) => {
      if (!options.readMcpResource) throw new RpcFault(-32004, "MCP resource service is unavailable");
      return options.readMcpResource(params);
    },
    "mcpServer/tool/call": async (params: Parameters<AppServerHandlers["mcpServer/tool/call"]>[0]) => {
      if (!options.callMcpTool) throw new RpcFault(-32004, "MCP tool service is unavailable");
      return options.callMcpTool(params);
    }
  };
  return handlers as unknown as AppServerHandlers;
}
