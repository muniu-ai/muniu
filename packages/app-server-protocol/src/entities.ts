// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { JsonObjectSchema, JsonValueSchema } from "./json.js";

export const IdentifierSchema = z.string().min(1).max(512);
export const TimestampSecondsSchema = z.number().int().nonnegative();
export const TimestampMillisecondsSchema = z.number().int().nonnegative();

export const UserInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({
    type: z.literal("image"),
    url: z.string().min(1),
    detail: z.enum(["auto", "low", "high", "original"]).nullable().optional()
  }).strict(),
  z.object({
    type: z.literal("localImage"),
    path: z.string().min(1),
    detail: z.enum(["auto", "low", "high", "original"]).nullable().optional()
  }).strict(),
  z.object({ type: z.literal("audio"), url: z.string().min(1) }).strict(),
  z.object({ type: z.literal("localAudio"), path: z.string().min(1) }).strict(),
  z.object({ type: z.literal("skill"), name: z.string().min(1), path: z.string().min(1) }).strict(),
  z.object({ type: z.literal("mention"), name: z.string().min(1), path: z.string().min(1) }).strict()
]);

export const FileUpdateChangeSchema = z.object({
  path: z.string().min(1),
  kind: z.discriminatedUnion("type", [
    z.object({ type: z.literal("add") }).strict(),
    z.object({ type: z.literal("delete") }).strict(),
    z.object({ type: z.literal("update"), move_path: z.string().nullable().optional() }).strict()
  ]),
  diff: z.string()
}).strict();

const InProgressCompletedFailedSchema = z.enum(["inProgress", "completed", "failed"]);
const GovernedEffectStatusSchema = z.enum(["inProgress", "completed", "failed", "declined"]);

const UserMessageItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("userMessage"),
  content: z.array(UserInputSchema),
  clientId: z.string().nullable().optional()
}).strict();

const AgentMessageItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("agentMessage"),
  text: z.string()
}).strict();

const PlanItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("plan"),
  text: z.string()
}).strict();

const ReasoningItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("reasoning"),
  summary: z.array(z.string())
}).strict();

const CommandExecutionItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("commandExecution"),
  command: z.string(),
  cwd: z.string(),
  status: GovernedEffectStatusSchema,
  commandActions: z.array(JsonObjectSchema).default([]),
  aggregatedOutput: z.string().nullable().optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  processId: z.string().nullable().optional()
}).strict();

const FileChangeItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("fileChange"),
  status: GovernedEffectStatusSchema,
  changes: z.array(FileUpdateChangeSchema)
}).strict();

const McpToolCallItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("mcpToolCall"),
  server: z.string().min(1),
  tool: z.string().min(1),
  arguments: JsonValueSchema,
  status: InProgressCompletedFailedSchema,
  result: JsonValueSchema.nullable().optional(),
  error: JsonValueSchema.nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional()
}).strict();

const DynamicToolCallItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("dynamicToolCall"),
  namespace: z.string().nullable().optional(),
  tool: z.string().min(1),
  arguments: JsonValueSchema,
  status: InProgressCompletedFailedSchema,
  success: z.boolean().nullable().optional(),
  contentItems: z.array(JsonValueSchema).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional()
}).strict();

const SubAgentActivityItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("subAgentActivity"),
  agentThreadId: IdentifierSchema,
  agentPath: z.string(),
  kind: z.enum(["started", "interacted", "interrupted", "completed", "failed"])
}).strict();

const WebSearchItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("webSearch"),
  query: z.string(),
  results: z.array(JsonValueSchema).nullable().optional()
}).strict();

const AttachmentItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("attachment"),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  uri: z.string().min(1),
  digest: z.string().min(1)
}).strict();

const ContextCompactionItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("contextCompaction"),
  previousSummary: z.string().nullable().optional(),
  summary: z.string().optional(),
  artifactRefs: z.array(z.string()).optional()
}).strict();

const ApprovalItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("approval"),
  approvalId: IdentifierSchema,
  effectCommitment: z.string().min(1),
  status: z.enum(["pending", "accepted", "declined", "cancelled", "expired"])
}).strict();

const EvidenceCheckpointItemSchema = z.object({
  id: IdentifierSchema,
  type: z.literal("evidenceCheckpoint"),
  evidenceId: IdentifierSchema,
  digest: z.string().min(1),
  status: z.enum(["recorded", "verified", "failed"])
}).strict();

export const ThreadItemSchema = z.discriminatedUnion("type", [
  UserMessageItemSchema,
  AgentMessageItemSchema,
  PlanItemSchema,
  ReasoningItemSchema,
  CommandExecutionItemSchema,
  FileChangeItemSchema,
  McpToolCallItemSchema,
  DynamicToolCallItemSchema,
  SubAgentActivityItemSchema,
  WebSearchItemSchema,
  AttachmentItemSchema,
  ContextCompactionItemSchema,
  ApprovalItemSchema,
  EvidenceCheckpointItemSchema
]);

export const TurnStatusSchema = z.enum(["completed", "interrupted", "failed", "inProgress"]);

export const TurnErrorSchema = z.object({
  message: z.string(),
  additionalDetails: z.string().nullable().optional(),
  codexErrorInfo: JsonValueSchema.nullable().optional(),
  muniu: z.object({ code: z.string().optional() }).strict().optional()
}).strict();

export const TurnSchema = z.object({
  id: IdentifierSchema,
  status: TurnStatusSchema,
  items: z.array(ThreadItemSchema),
  error: TurnErrorSchema.nullable().optional(),
  startedAt: TimestampSecondsSchema.nullable().optional(),
  completedAt: TimestampSecondsSchema.nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional()
}).strict();

export const ThreadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }).strict(),
  z.object({ type: z.literal("idle") }).strict(),
  z.object({ type: z.literal("systemError") }).strict(),
  z.object({
    type: z.literal("active"),
    activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"]))
  }).strict()
]);

export const ThreadGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete"
]);

export const ThreadGoalSchema = z.object({
  threadId: IdentifierSchema,
  objective: z.string(),
  status: ThreadGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable().optional(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  createdAt: TimestampSecondsSchema,
  updatedAt: TimestampSecondsSchema
}).strict();

export const MuniuThreadMetadataSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  permissionProfile: z.string().min(1),
  sandbox: JsonObjectSchema,
  goal: ThreadGoalSchema.nullable().optional(),
  taskId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  candidateId: z.string().nullable().optional(),
  evidenceIds: z.array(z.string()).default([]),
  archived: z.boolean().default(false),
  tombstoned: z.boolean().default(false)
}).strict();

export const ThreadSchema = z.object({
  id: IdentifierSchema,
  sessionId: IdentifierSchema,
  preview: z.string(),
  modelProvider: z.string().min(1),
  cliVersion: z.string().default("0.2.0"),
  createdAt: TimestampSecondsSchema,
  updatedAt: TimestampSecondsSchema,
  recencyAt: TimestampSecondsSchema.nullable().optional(),
  cwd: z.string(),
  source: z.union([
    z.enum(["cli", "vscode", "exec", "appServer", "unknown"]),
    z.object({ custom: z.string().min(1) }).strict(),
    z.object({ subAgent: JsonObjectSchema }).strict()
  ]),
  status: ThreadStatusSchema,
  turns: z.array(TurnSchema),
  name: z.string().nullable().optional(),
  parentThreadId: z.string().nullable().optional(),
  forkedFromId: z.string().nullable().optional(),
  projectId: z.string().nullable().default(null),
  threadSource: z.string().nullable().optional(),
  agentNickname: z.string().nullable().optional(),
  agentRole: z.string().nullable().optional(),
  ephemeral: z.boolean().default(false),
  muniu: MuniuThreadMetadataSchema
}).strict();

export const TokenUsageBreakdownSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative()
}).strict();

export const ThreadTokenUsageSchema = z.object({
  total: TokenUsageBreakdownSchema,
  last: TokenUsageBreakdownSchema,
  modelContextWindow: z.number().int().positive().nullable().optional()
}).strict();

export type UserInput = z.infer<typeof UserInputSchema>;
export type ThreadItem = z.infer<typeof ThreadItemSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type ThreadGoal = z.infer<typeof ThreadGoalSchema>;
