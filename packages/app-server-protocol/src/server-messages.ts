// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  FileUpdateChangeSchema,
  IdentifierSchema,
  ThreadGoalSchema,
  ThreadItemSchema,
  ThreadSchema,
  ThreadStatusSchema,
  ThreadTokenUsageSchema,
  TimestampMillisecondsSchema,
  TurnErrorSchema,
  TurnSchema
} from "./entities.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";

const LifecycleIdsSchema = {
  threadId: IdentifierSchema,
  turnId: IdentifierSchema
};

export const SERVER_NOTIFICATION_SCHEMAS = {
  "thread/started": z.object({ thread: ThreadSchema }).strict(),
  "thread/status/changed": z.object({ threadId: IdentifierSchema, status: ThreadStatusSchema }).strict(),
  "thread/archived": z.object({ threadId: IdentifierSchema }).strict(),
  "thread/unarchived": z.object({ threadId: IdentifierSchema }).strict(),
  "thread/deleted": z.object({ threadId: IdentifierSchema }).strict(),
  "thread/name/updated": z.object({ threadId: IdentifierSchema, threadName: z.string().nullable().optional() }).strict(),
  "thread/goal/updated": z.object({ threadId: IdentifierSchema, goal: ThreadGoalSchema }).strict(),
  "thread/goal/cleared": z.object({ threadId: IdentifierSchema }).strict(),
  "turn/started": z.object({ threadId: IdentifierSchema, turn: TurnSchema }).strict(),
  "turn/completed": z.object({ threadId: IdentifierSchema, turn: TurnSchema }).strict(),
  "item/started": z.object({ ...LifecycleIdsSchema, item: ThreadItemSchema, startedAtMs: TimestampMillisecondsSchema }).strict(),
  "item/completed": z.object({ ...LifecycleIdsSchema, item: ThreadItemSchema, completedAtMs: TimestampMillisecondsSchema }).strict(),
  "item/agentMessage/delta": z.object({ ...LifecycleIdsSchema, itemId: IdentifierSchema, delta: z.string() }).strict(),
  "item/plan/delta": z.object({ ...LifecycleIdsSchema, itemId: IdentifierSchema, delta: z.string() }).strict(),
  "item/reasoning/summaryTextDelta": z.object({ ...LifecycleIdsSchema, itemId: IdentifierSchema, delta: z.string(), summaryIndex: z.number().int().nonnegative() }).strict(),
  "item/commandExecution/outputDelta": z.object({ ...LifecycleIdsSchema, itemId: IdentifierSchema, delta: z.string() }).strict(),
  "item/fileChange/patchUpdated": z.object({ ...LifecycleIdsSchema, itemId: IdentifierSchema, changes: z.array(FileUpdateChangeSchema) }).strict(),
  "item/mcpToolCall/progress": z.object({ ...LifecycleIdsSchema, itemId: IdentifierSchema, message: z.string() }).strict(),
  "thread/tokenUsage/updated": z.object({ ...LifecycleIdsSchema, tokenUsage: ThreadTokenUsageSchema }).strict(),
  "turn/diff/updated": z.object({ ...LifecycleIdsSchema, diff: z.string() }).strict(),
  "thread/compacted": z.object(LifecycleIdsSchema).strict(),
  "mcpServer/startupStatus/updated": z.object({
    name: z.string().min(1),
    status: z.enum(["starting", "ready", "failed", "cancelled"]),
    error: z.string().nullable().optional(),
    failureReason: z.literal("reauthenticationRequired").nullable().optional(),
    threadId: IdentifierSchema.nullable().optional()
  }).strict(),
  "warning": z.object({ message: z.string(), threadId: z.string().nullable().optional() }).strict(),
  "error": z.object({ ...LifecycleIdsSchema, error: TurnErrorSchema, willRetry: z.boolean() }).strict()
} as const;

export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_SCHEMAS;
export const SERVER_NOTIFICATION_METHODS = Object.freeze(Object.keys(SERVER_NOTIFICATION_SCHEMAS)) as readonly ServerNotificationMethod[];
export type ServerNotificationParams<M extends ServerNotificationMethod> = z.infer<(typeof SERVER_NOTIFICATION_SCHEMAS)[M]>;

const ApprovalIdsSchema = {
  threadId: IdentifierSchema,
  turnId: IdentifierSchema,
  itemId: IdentifierSchema,
  startedAtMs: TimestampMillisecondsSchema
};
const ApprovalDecisionSchema = z.enum(["accept", "acceptForSession", "decline", "cancel"]);

const DynamicToolContentItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text: z.string() }).strict(),
  z.object({ type: z.literal("inputImage"), imageUrl: z.string().min(1) }).strict(),
  z.object({ type: z.literal("inputAudio"), audioUrl: z.string().min(1) }).strict()
]);

const ToolQuestionSchema = z.object({
  id: IdentifierSchema,
  header: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string() }).strict()).nullable().optional(),
  isOther: z.boolean().optional(),
  isSecret: z.boolean().optional()
}).strict();

const McpElicitationBaseShape = {
  serverName: z.string().min(1),
  threadId: IdentifierSchema,
  turnId: IdentifierSchema.nullable().optional()
};

export const SERVER_REQUEST_SCHEMAS = {
  "item/commandExecution/requestApproval": {
    params: z.object({
      ...ApprovalIdsSchema,
      approvalId: z.string().nullable().optional(),
      command: z.string().nullable().optional(),
      cwd: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
      commandActions: z.array(JsonObjectSchema).nullable().optional(),
      environmentId: z.string().nullable().optional(),
      networkApprovalContext: JsonValueSchema.nullable().optional(),
      proposedExecpolicyAmendment: z.array(z.string()).nullable().optional(),
      proposedNetworkPolicyAmendments: z.array(JsonValueSchema).nullable().optional(),
      muniu: z.object({ effectCommitment: z.string().min(1) }).strict().optional()
    }).strict(),
    result: z.object({ decision: ApprovalDecisionSchema }).strict()
  },
  "item/fileChange/requestApproval": {
    params: z.object({
      ...ApprovalIdsSchema,
      reason: z.string().nullable().optional(),
      muniu: z.object({ effectCommitment: z.string().min(1) }).strict().optional()
    }).strict(),
    result: z.object({ decision: ApprovalDecisionSchema }).strict()
  },
  "item/permissions/requestApproval": {
    params: z.object({
      ...ApprovalIdsSchema,
      cwd: z.string(),
      environmentId: z.string().nullable().optional(),
      permissions: JsonObjectSchema,
      reason: z.string().nullable().optional(),
      muniu: z.object({ effectCommitment: z.string().min(1) }).strict().optional()
    }).strict(),
    result: z.object({
      permissions: JsonObjectSchema,
      scope: z.enum(["turn", "session"]).optional(),
      strictAutoReview: z.boolean().nullable().optional(),
      muniu: z.object({ scope: z.enum(["once", "turn", "session"]) }).strict().optional()
    }).strict()
  },
  "item/tool/requestUserInput": {
    params: z.object({
      ...LifecycleIdsSchema,
      itemId: IdentifierSchema,
      questions: z.array(ToolQuestionSchema).min(1),
      isBlocking: z.boolean(),
      autoResolutionMs: z.number().int().nonnegative().nullable().optional()
    }).strict(),
    result: z.object({ answers: z.record(z.object({ answers: z.array(z.string()) }).strict()) }).strict()
  },
  "item/tool/call": {
    params: z.object({ ...LifecycleIdsSchema, callId: IdentifierSchema, namespace: z.string().nullable().optional(), tool: z.string().min(1), arguments: JsonValueSchema }).strict(),
    result: z.object({ success: z.boolean(), contentItems: z.array(DynamicToolContentItemSchema) }).strict()
  },
  "mcpServer/elicitation/request": {
    params: z.discriminatedUnion("mode", [
      z.object({ ...McpElicitationBaseShape, mode: z.literal("form"), message: z.string(), requestedSchema: JsonObjectSchema, _meta: JsonValueSchema.optional() }).strict(),
      z.object({ ...McpElicitationBaseShape, mode: z.literal("openai/form"), message: z.string(), requestedSchema: JsonValueSchema, _meta: JsonValueSchema.optional() }).strict(),
      z.object({ ...McpElicitationBaseShape, mode: z.literal("url"), message: z.string(), elicitationId: IdentifierSchema, url: z.string().min(1), _meta: JsonValueSchema.optional() }).strict()
    ]),
    result: z.object({ action: z.enum(["accept", "decline", "cancel"]), content: JsonValueSchema.optional(), _meta: JsonValueSchema.optional() }).strict()
  }
} as const;

export type ServerRequestMethod = keyof typeof SERVER_REQUEST_SCHEMAS;
export const SERVER_REQUEST_METHODS = Object.freeze(Object.keys(SERVER_REQUEST_SCHEMAS)) as readonly ServerRequestMethod[];
export type ServerRequestParams<M extends ServerRequestMethod> = z.infer<(typeof SERVER_REQUEST_SCHEMAS)[M]["params"]>;
export type ServerRequestResult<M extends ServerRequestMethod> = z.infer<(typeof SERVER_REQUEST_SCHEMAS)[M]["result"]>;
