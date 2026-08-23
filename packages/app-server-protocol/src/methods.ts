// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  IdentifierSchema,
  ThreadGoalSchema,
  ThreadGoalStatusSchema,
  ThreadSchema,
  TurnSchema,
  UserInputSchema
} from "./entities.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";

const optionalNullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional();
const EmptyObjectSchema = z.object({}).strict();
const OptionalUnitParamsSchema = z.preprocess(
  (value) => value === null ? {} : value,
  EmptyObjectSchema
);
const CursorSchema = optionalNullable(z.string());
const LimitSchema = optionalNullable(z.number().int().nonnegative().max(10_000));
const ApprovalPolicySchema = z.enum(["untrusted", "on-request", "never"]);
const ApprovalsReviewerSchema = z.enum(["user", "auto_review", "guardian_subagent"]);
const SandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const PersonalitySchema = z.enum(["none", "friendly", "pragmatic"]);
const ReasoningSummarySchema = z.enum(["auto", "concise", "detailed", "none"]);

export const ClientInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  title: optionalNullable(z.string().min(1))
}).strict();

export const InitializeCapabilitiesSchema = z.object({
  optOutNotificationMethods: optionalNullable(z.array(z.string().min(1))),
  extensions: optionalNullable(JsonObjectSchema),
  mcpServerOpenaiFormElicitation: z.boolean().optional()
}).strict();

export const InitializeParamsSchema = z.object({
  clientInfo: ClientInfoSchema,
  capabilities: optionalNullable(InitializeCapabilitiesSchema)
}).strict();

export const ServerInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1).optional()
}).strict();

export const CompatibilityDeclarationSchema = z.object({
  protocol: z.literal("app-server-v2"),
  baselineCommit: z.literal("99660ab3c7b861c916e467581fa9b8723504d66b"),
  methodSet: z.literal("core-stable-subset")
}).strict();

const ThreadStartParamsSchema = z.object({
  model: optionalNullable(z.string()),
  modelProvider: optionalNullable(z.string()),
  serviceTier: optionalNullable(z.string()),
  cwd: optionalNullable(z.string()),
  approvalPolicy: optionalNullable(ApprovalPolicySchema),
  approvalsReviewer: optionalNullable(ApprovalsReviewerSchema),
  sandbox: optionalNullable(SandboxModeSchema),
  config: optionalNullable(JsonObjectSchema),
  serviceName: optionalNullable(z.string()),
  baseInstructions: optionalNullable(z.string()),
  developerInstructions: optionalNullable(z.string()),
  personality: optionalNullable(PersonalitySchema),
  ephemeral: optionalNullable(z.boolean()),
  sessionStartSource: optionalNullable(z.enum(["startup", "clear"])),
  threadSource: optionalNullable(z.string())
}).strict();

const ThreadResumeParamsSchema = ThreadStartParamsSchema.omit({
  ephemeral: true,
  serviceName: true,
  sessionStartSource: true,
  threadSource: true
}).extend({ threadId: IdentifierSchema }).strict();

const ThreadForkParamsSchema = ThreadStartParamsSchema.omit({
  personality: true,
  serviceName: true,
  sessionStartSource: true
}).extend({
  threadId: IdentifierSchema,
  lastTurnId: optionalNullable(IdentifierSchema),
  ephemeral: z.boolean().optional()
}).strict();

const ThreadListParamsSchema = z.object({
  cursor: CursorSchema,
  limit: LimitSchema,
  sortKey: optionalNullable(z.enum(["created_at", "updated_at", "recency_at", "section_position"])),
  sortDirection: optionalNullable(z.enum(["asc", "desc"])),
  archived: optionalNullable(z.boolean()),
  modelProviders: optionalNullable(z.array(z.string())),
  sourceKinds: optionalNullable(z.array(z.string())),
  cwd: optionalNullable(z.union([z.string(), z.array(z.string())])),
  searchTerm: optionalNullable(z.string()),
  sectionId: optionalNullable(z.string()),
  useStateDbOnly: z.boolean().optional()
}).strict();

const ThreadListResponseSchema = z.object({
  data: z.array(ThreadSchema),
  nextCursor: CursorSchema,
  backwardsCursor: CursorSchema
}).strict();

const ThreadLoadedListParamsSchema = z.object({ cursor: CursorSchema, limit: LimitSchema }).strict();
const ThreadLoadedListResponseSchema = z.object({
  data: z.array(IdentifierSchema),
  nextCursor: CursorSchema
}).strict();
const ThreadIdParamsSchema = z.object({ threadId: IdentifierSchema }).strict();

const ThreadUnsubscribeResponseSchema = z.object({
  status: z.enum(["notLoaded", "notSubscribed", "unsubscribed"])
}).strict();

const ThreadGoalSetParamsSchema = z.object({
  threadId: IdentifierSchema,
  objective: optionalNullable(z.string()),
  status: optionalNullable(ThreadGoalStatusSchema),
  tokenBudget: optionalNullable(z.number().int().positive())
}).strict();

const TurnStartParamsSchema = z.object({
  threadId: IdentifierSchema,
  input: z.array(UserInputSchema).min(1),
  cwd: optionalNullable(z.string()),
  approvalPolicy: optionalNullable(ApprovalPolicySchema),
  approvalsReviewer: optionalNullable(ApprovalsReviewerSchema),
  sandboxPolicy: optionalNullable(JsonObjectSchema),
  model: optionalNullable(z.string()),
  serviceTier: optionalNullable(z.string()),
  effort: optionalNullable(z.string().min(1)),
  summary: optionalNullable(ReasoningSummarySchema),
  personality: optionalNullable(PersonalitySchema),
  outputSchema: JsonValueSchema.optional(),
  clientUserMessageId: optionalNullable(z.string())
}).strict();

const TurnSteerParamsSchema = z.object({
  threadId: IdentifierSchema,
  expectedTurnId: IdentifierSchema,
  input: z.array(UserInputSchema).min(1),
  clientUserMessageId: optionalNullable(z.string())
}).strict();

const ReviewTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommittedChanges") }).strict(),
  z.object({ type: z.literal("baseBranch"), branch: z.string().min(1) }).strict(),
  z.object({ type: z.literal("commit"), sha: z.string().min(1), title: optionalNullable(z.string()) }).strict(),
  z.object({ type: z.literal("custom"), instructions: z.string().min(1) }).strict()
]);

const ModelSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string(),
  description: z.string(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  defaultReasoningEffort: z.string().min(1),
  supportedReasoningEfforts: z.array(JsonValueSchema),
  inputModalities: z.array(z.enum(["text", "image", "audio"])) .optional(),
  supportsPersonality: z.boolean().optional()
}).strict();

const SkillsListResponseSchema = z.object({ data: z.array(z.object({
  cwd: z.string(),
  skills: z.array(JsonValueSchema),
  errors: z.array(JsonValueSchema)
}).strict()) }).strict();

const HooksListResponseSchema = z.object({ data: z.array(z.object({
  cwd: z.string(),
  hooks: z.array(JsonValueSchema),
  errors: z.array(JsonValueSchema),
  warnings: z.array(z.string())
}).strict()) }).strict();

const McpServerToolCallResponseSchema = z.object({
  content: z.array(JsonValueSchema),
  structuredContent: JsonValueSchema.optional(),
  isError: optionalNullable(z.boolean()),
  _meta: JsonValueSchema.optional()
}).strict();

const ThreadRuntimeResponseSchema = z.object({
  thread: ThreadSchema,
  model: z.string(),
  modelProvider: z.string(),
  serviceTier: z.string().nullable().optional(),
  cwd: z.string(),
  instructionSources: z.array(z.string()).optional(),
  approvalPolicy: ApprovalPolicySchema,
  approvalsReviewer: ApprovalsReviewerSchema,
  sandbox: JsonObjectSchema,
  reasoningEffort: z.string().nullable().optional()
}).strict();

export const InitializeResultSchema = z.object({
  serverInfo: ServerInfoSchema,
  protocolVersion: z.literal("2"),
  capabilities: z.object({
    methods: z.array(z.string().min(1)),
    notifications: z.array(z.string().min(1)),
    serverRequests: z.array(z.string().min(1))
  }).strict(),
  instructionSources: z.array(z.string()),
  muniu: z.object({ compatibility: CompatibilityDeclarationSchema }).strict()
}).strict();

export const METHOD_SCHEMAS = {
  "initialize": { params: InitializeParamsSchema, result: InitializeResultSchema },
  "thread/start": { params: ThreadStartParamsSchema, result: ThreadRuntimeResponseSchema },
  "thread/resume": { params: ThreadResumeParamsSchema, result: ThreadRuntimeResponseSchema },
  "thread/fork": { params: ThreadForkParamsSchema, result: ThreadRuntimeResponseSchema },
  "thread/list": { params: ThreadListParamsSchema, result: ThreadListResponseSchema },
  "thread/loaded/list": { params: ThreadLoadedListParamsSchema, result: ThreadLoadedListResponseSchema },
  "thread/read": { params: ThreadIdParamsSchema.extend({ includeTurns: z.boolean().optional() }).strict(), result: z.object({ thread: ThreadSchema }).strict() },
  "thread/archive": { params: ThreadIdParamsSchema, result: EmptyObjectSchema },
  "thread/unarchive": { params: ThreadIdParamsSchema, result: z.object({ thread: ThreadSchema }).strict() },
  "thread/delete": { params: ThreadIdParamsSchema, result: EmptyObjectSchema },
  "thread/unsubscribe": { params: ThreadIdParamsSchema, result: ThreadUnsubscribeResponseSchema },
  "thread/name/set": { params: ThreadIdParamsSchema.extend({ name: z.string() }).strict(), result: EmptyObjectSchema },
  "thread/goal/set": { params: ThreadGoalSetParamsSchema, result: z.object({ goal: ThreadGoalSchema }).strict() },
  "thread/goal/get": { params: ThreadIdParamsSchema, result: z.object({ goal: ThreadGoalSchema.nullable().optional() }).strict() },
  "thread/goal/clear": { params: ThreadIdParamsSchema, result: z.object({ cleared: z.boolean() }).strict() },
  "thread/compact/start": { params: ThreadIdParamsSchema, result: EmptyObjectSchema },
  "turn/start": { params: TurnStartParamsSchema, result: z.object({ turn: TurnSchema }).strict() },
  "turn/steer": { params: TurnSteerParamsSchema, result: z.object({ turnId: IdentifierSchema }).strict() },
  "turn/interrupt": { params: z.object({ threadId: IdentifierSchema, turnId: IdentifierSchema }).strict(), result: EmptyObjectSchema },
  "review/start": { params: z.object({ threadId: IdentifierSchema, target: ReviewTargetSchema, delivery: optionalNullable(z.enum(["inline", "detached"])) }).strict(), result: z.object({ reviewThreadId: IdentifierSchema, turn: TurnSchema }).strict() },
  "model/list": { params: z.object({ cursor: CursorSchema, limit: LimitSchema, includeHidden: optionalNullable(z.boolean()) }).strict(), result: z.object({ data: z.array(ModelSchema), nextCursor: CursorSchema }).strict() },
  "skills/list": { params: z.object({ cwds: z.array(z.string()).optional(), forceReload: z.boolean().optional() }).strict(), result: SkillsListResponseSchema },
  "skills/extraRoots/set": { params: z.object({ extraRoots: z.array(z.string()) }).strict(), result: EmptyObjectSchema },
  "hooks/list": { params: z.object({ cwds: z.array(z.string()).optional() }).strict(), result: HooksListResponseSchema },
  "config/read": { params: z.object({ cwd: optionalNullable(z.string()), includeLayers: z.boolean().optional() }).strict(), result: z.object({ config: JsonObjectSchema, origins: JsonObjectSchema, layers: optionalNullable(z.array(JsonValueSchema)) }).strict() },
  "config/mcpServer/reload": { params: OptionalUnitParamsSchema, result: EmptyObjectSchema },
  "mcpServerStatus/list": { params: z.object({ cursor: CursorSchema, limit: LimitSchema, threadId: optionalNullable(IdentifierSchema), detail: optionalNullable(z.enum(["full", "toolsAndAuthOnly"])) }).strict(), result: z.object({ data: z.array(JsonValueSchema), nextCursor: CursorSchema }).strict() },
  "mcpServer/resource/read": { params: z.object({ server: z.string().min(1), uri: z.string().min(1), threadId: optionalNullable(IdentifierSchema), connectorId: optionalNullable(z.string()), originCallId: optionalNullable(z.string()) }).strict(), result: z.object({ contents: z.array(JsonValueSchema), originCallId: optionalNullable(z.string()) }).strict() },
  "mcpServer/tool/call": { params: z.object({ server: z.string().min(1), tool: z.string().min(1), threadId: IdentifierSchema, arguments: JsonValueSchema.optional(), _meta: JsonValueSchema.optional() }).strict(), result: McpServerToolCallResponseSchema }
} as const;

export const CLIENT_METHODS = Object.freeze(Object.keys(METHOD_SCHEMAS)) as readonly ClientMethod[];

export type ClientMethod = keyof typeof METHOD_SCHEMAS;
export type MethodParams<M extends ClientMethod> = z.infer<(typeof METHOD_SCHEMAS)[M]["params"]>;
export type MethodResult<M extends ClientMethod> = z.infer<(typeof METHOD_SCHEMAS)[M]["result"]>;
