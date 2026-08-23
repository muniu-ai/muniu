// SPDX-License-Identifier: Apache-2.0

import {
  deepFreeze,
  verifyAgentEventV3Chain,
  type AgentEventV3,
  type EffectCommitmentV1,
  type JsonValue,
  type ProtectedJsonNodeV1,
  type ProtectedJsonViewV1,
  type ProtectedTextV1
} from "@mn/agent-protocol";

export type ThreadStatusV3 = "idle" | "active" | "systemError";
export type TurnStatusV3 = "inProgress" | "completed" | "interrupted" | "failed";
export type ThreadItemStatusV3 = "inProgress" | "completed" | "failed" | "declined" | "pending";

export type ThreadItemKindV3 =
  | "userMessage"
  | "agentMessage"
  | "plan"
  | "reasoning"
  | "commandExecution"
  | "fileChange"
  | "mcpToolCall"
  | "dynamicToolCall"
  | "subAgentActivity"
  | "webSearch"
  | "attachment"
  | "contextCompaction"
  | "approval"
  | "evidenceCheckpoint";

export interface ThreadGoalProjectionV3 {
  readonly objective: ProtectedTextV1;
  readonly status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  readonly tokenBudget?: number;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadTurnProjectionV3 {
  readonly turnId: string;
  readonly status: TurnStatusV3;
  readonly ordinal?: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly itemIds: readonly string[];
}

export interface ThreadItemProjectionV3 {
  readonly itemId: string;
  readonly turnId?: string;
  readonly kind: ThreadItemKindV3;
  readonly status: ThreadItemStatusV3;
  readonly publicControls: Readonly<Record<string, JsonValue>>;
  readonly protectedContent: ProtectedJsonViewV1;
  readonly effectCommitment?: EffectCommitmentV1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadProjectionV3 {
  readonly threadId: string;
  readonly parentThreadId?: string;
  readonly forkedFromTurnId?: string;
  readonly status: ThreadStatusV3;
  readonly source: string;
  readonly cwd: string;
  readonly name?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly permissionProfile: string;
  readonly sandbox: Readonly<Record<string, JsonValue>>;
  readonly taskId?: string;
  readonly runId?: string;
  readonly candidateId?: string;
  readonly goal?: ThreadGoalProjectionV3;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly tombstoned: boolean;
  readonly turns: readonly ThreadTurnProjectionV3[];
  readonly items: readonly ThreadItemProjectionV3[];
  readonly lastSequence: number;
  readonly lastDigest: string;
}

const ITEM_KINDS = new Set<ThreadItemKindV3>([
  "userMessage",
  "agentMessage",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "subAgentActivity",
  "webSearch",
  "attachment",
  "contextCompaction",
  "approval",
  "evidenceCheckpoint"
]);
const ITEM_STATUSES = new Set<ThreadItemStatusV3>([
  "inProgress", "completed", "failed", "declined", "pending"
]);
const GOAL_STATUSES = new Set<ThreadGoalProjectionV3["status"]>([
  "active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"
]);

function object(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
}

function stringControl(
  controls: Readonly<Record<string, JsonValue>>,
  key: string,
  fallback?: string
): string {
  const value = controls[key];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new TypeError(`V3 thread control ${key} is required`);
}

function optionalString(controls: Readonly<Record<string, JsonValue>>, key: string): string | undefined {
  const value = controls[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`V3 thread control ${key} must be a string`);
  return value;
}

function itemKind(event: AgentEventV3): ThreadItemKindV3 {
  const value = event.publicControls.itemKind;
  if (typeof value === "string" && ITEM_KINDS.has(value as ThreadItemKindV3)) {
    return value as ThreadItemKindV3;
  }
  if (event.type.startsWith("approval/")) return "approval";
  if (event.type === "context/compacted") return "contextCompaction";
  if (event.type === "evidence/checkpoint") return "evidenceCheckpoint";
  throw new TypeError("V3 item event has no valid item kind");
}

function itemStatus(event: AgentEventV3): ThreadItemStatusV3 {
  const value = event.publicControls.status;
  if (typeof value === "string" && ITEM_STATUSES.has(value as ThreadItemStatusV3)) {
    return value as ThreadItemStatusV3;
  }
  if (event.type === "item/started" || event.type === "item/delta") return "inProgress";
  if (event.type === "approval/requested") return "pending";
  return "completed";
}

function turnTerminalStatus(event: AgentEventV3): TurnStatusV3 {
  if (event.type === "turn/completed") return "completed";
  if (event.type === "turn/interrupted") return "interrupted";
  return "failed";
}

function protectedObjectString(root: ProtectedJsonNodeV1, key: string, fallback: string): string {
  if (root.type !== "object") return fallback;
  const entry = root.entries.find((candidate) => candidate.key.text === key);
  return entry?.value.type === "string" ? entry.value.value.text : fallback;
}

function projectGoal(event: AgentEventV3, existing?: ThreadGoalProjectionV3): ThreadGoalProjectionV3 {
  const status = event.publicControls.status;
  const tokenBudget = event.publicControls.tokenBudget;
  const tokensUsed = event.publicControls.tokensUsed;
  const timeUsedSeconds = event.publicControls.timeUsedSeconds;
  if (!event.currentSummary || typeof status !== "string"
    || !GOAL_STATUSES.has(status as ThreadGoalProjectionV3["status"])
    || tokenBudget !== undefined && (typeof tokenBudget !== "number" || !Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
    || typeof tokensUsed !== "number" || !Number.isSafeInteger(tokensUsed) || tokensUsed < 0
    || typeof timeUsedSeconds !== "number" || !Number.isSafeInteger(timeUsedSeconds) || timeUsedSeconds < 0) {
    throw new TypeError("V3 goal event is invalid");
  }
  return {
    objective: event.currentSummary,
    status: status as ThreadGoalProjectionV3["status"],
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    tokensUsed,
    timeUsedSeconds,
    createdAt: existing?.createdAt ?? event.occurredAt,
    updatedAt: event.occurredAt
  };
}

export function projectThreadV3(events: readonly AgentEventV3[]): ThreadProjectionV3 {
  verifyAgentEventV3Chain(events);
  const created = events[0];
  if (!created || created.type !== "thread/created") {
    throw new TypeError("V3 thread chain must start with thread/created");
  }
  const initialAssociations = object(created.publicControls.associations ?? {}, "V3 thread associations");
  let status: ThreadStatusV3 = "idle";
  let source = stringControl(created.publicControls, "source", "unknown");
  const cwd = protectedObjectString(created.protectedContent.root, "cwd", ".");
  let name = optionalString(created.publicControls, "name");
  let providerId = stringControl(created.publicControls, "providerId", "unbound");
  let modelId = stringControl(created.publicControls, "modelId", "unbound");
  let permissionProfile = stringControl(created.publicControls, "permissionProfile", "migrated-v0.1");
  let sandbox = object(created.publicControls.sandbox ?? {}, "V3 thread sandbox");
  let taskId = optionalString(initialAssociations, "taskId");
  let runId = optionalString(initialAssociations, "runId");
  let candidateId = optionalString(initialAssociations, "candidateId");
  let parentThreadId: string | undefined;
  let forkedFromTurnId: string | undefined;
  let goal: ThreadGoalProjectionV3 | undefined;
  let archived = false;
  let tombstoned = false;
  const turns = new Map<string, ThreadTurnProjectionV3>();
  const items = new Map<string, ThreadItemProjectionV3>();

  for (const event of events.slice(1)) {
    switch (event.type) {
      case "thread/updated": {
        source = stringControl(event.publicControls, "source", source);
        name = optionalString(event.publicControls, "name") ?? name;
        providerId = stringControl(event.publicControls, "providerId", providerId);
        modelId = stringControl(event.publicControls, "modelId", modelId);
        permissionProfile = stringControl(event.publicControls, "permissionProfile", permissionProfile);
        if (event.publicControls.sandbox !== undefined) {
          sandbox = object(event.publicControls.sandbox, "V3 thread sandbox");
        }
        const associations = event.publicControls.associations === undefined
          ? undefined
          : object(event.publicControls.associations, "V3 thread associations");
        taskId = associations === undefined ? taskId : optionalString(associations, "taskId");
        runId = associations === undefined ? runId : optionalString(associations, "runId");
        candidateId = associations === undefined ? candidateId : optionalString(associations, "candidateId");
        break;
      }
      case "thread/forked":
        parentThreadId = stringControl(event.publicControls, "parentThreadId");
        forkedFromTurnId = optionalString(event.publicControls, "forkedFromTurnId");
        break;
      case "thread/archived": archived = true; break;
      case "thread/unarchived": archived = false; break;
      case "thread/tombstoned":
        tombstoned = true;
        status = "idle";
        break;
      case "thread/goal-updated": goal = projectGoal(event, goal); break;
      case "thread/goal-cleared": goal = undefined; break;
      case "turn/started": {
        if (!event.turnId || turns.has(event.turnId)) throw new TypeError("V3 turn start is invalid");
        const ordinal = event.publicControls.ordinal;
        if (ordinal !== undefined && (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal <= 0)) {
          throw new TypeError("V3 turn ordinal is invalid");
        }
        turns.set(event.turnId, {
          turnId: event.turnId,
          status: "inProgress",
          ...(ordinal === undefined ? {} : { ordinal }),
          startedAt: event.occurredAt,
          itemIds: Object.freeze([])
        });
        status = "active";
        break;
      }
      case "turn/completed":
      case "turn/interrupted":
      case "turn/failed": {
        if (!event.turnId) throw new TypeError("V3 terminal turn event has no turn identifier");
        const turn = turns.get(event.turnId);
        if (!turn || turn.status !== "inProgress") throw new TypeError("V3 terminal turn event has no open turn");
        turns.set(event.turnId, {
          ...turn,
          status: turnTerminalStatus(event),
          completedAt: event.occurredAt
        });
        status = event.type === "turn/failed" ? "systemError" : "idle";
        break;
      }
      case "turn/steered":
      case "turn/progress":
        if (!event.turnId || !turns.has(event.turnId)) throw new TypeError("V3 turn progress has no turn");
        break;
      case "item/started":
      case "item/delta":
      case "item/completed":
      case "item/recorded":
      case "approval/requested":
      case "approval/resolved":
      case "context/compacted":
      case "evidence/checkpoint": {
        if (!event.itemId) throw new TypeError("V3 item event has no item identifier");
        const existing = items.get(event.itemId);
        const projected: ThreadItemProjectionV3 = {
          itemId: event.itemId,
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          kind: itemKind(event),
          status: itemStatus(event),
          publicControls: event.publicControls,
          protectedContent: event.protectedContent,
          ...(event.effectCommitment === undefined ? {} : { effectCommitment: event.effectCommitment }),
          createdAt: existing?.createdAt ?? event.occurredAt,
          updatedAt: event.occurredAt
        };
        items.set(event.itemId, projected);
        if (event.turnId !== undefined) {
          const turn = turns.get(event.turnId);
          if (!turn) throw new TypeError("V3 item refers to an unknown turn");
          if (!turn.itemIds.includes(event.itemId)) {
            turns.set(event.turnId, {
              ...turn,
              itemIds: Object.freeze([...turn.itemIds, event.itemId])
            });
          }
        }
        break;
      }
      case "thread/created": throw new TypeError("V3 thread chain contains multiple creation events");
    }
  }

  const last = events.at(-1) as AgentEventV3;
  return deepFreeze({
    threadId: created.threadId,
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(forkedFromTurnId === undefined ? {} : { forkedFromTurnId }),
    status,
    source,
    cwd,
    ...(name === undefined ? {} : { name }),
    providerId,
    modelId,
    permissionProfile,
    sandbox,
    ...(taskId === undefined ? {} : { taskId }),
    ...(runId === undefined ? {} : { runId }),
    ...(candidateId === undefined ? {} : { candidateId }),
    ...(goal === undefined ? {} : { goal }),
    createdAt: created.occurredAt,
    updatedAt: last.occurredAt,
    archived,
    tombstoned,
    turns: Object.freeze([...turns.values()]),
    items: Object.freeze([...items.values()]),
    lastSequence: last.sequence,
    lastDigest: last.digest
  });
}
