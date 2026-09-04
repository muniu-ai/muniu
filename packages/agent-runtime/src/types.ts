// SPDX-License-Identifier: Apache-2.0

import type {
  ExecutionBudget,
  ExecutionStatus,
  JsonObject,
  JsonValue,
  ResourceRef,
  ToolCallIntent,
  ToolEffectClass,
} from "@mn/contracts";

export type Awaitable<T> = T | Promise<T>;

export type ScopeLevel = "tenant" | "workspace" | "thread" | "execution" | "subagent";

export interface ScopeIdentity {
  readonly tenantId: string;
  readonly workspaceId?: string;
  readonly threadId?: string;
  readonly executionId?: string;
  readonly subagentPath: readonly string[];
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface ModelToolCall {
  readonly id: string;
  readonly toolId: string;
  readonly arguments: JsonObject;
  readonly intent?: string;
}

export interface ModelRequest {
  readonly executionId: string;
  readonly agentId: string;
  readonly generation: number;
  readonly messages: readonly ModelMessage[];
  readonly availableToolIds: readonly string[];
}

export interface ModelResponse {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
}

export interface ModelInvocationContext {
  readonly signal: AbortSignal;
  readonly scope: ScopeIdentity;
}

export interface ContributionResource {
  readonly id: string;
  readonly dispose?: () => void;
}

export interface PromptContribution extends ContributionResource {
  readonly render: (context: {
    readonly scope: ScopeIdentity;
    readonly executionId: string;
    readonly generation: number;
  }) => Awaitable<string>;
}

export interface LlmContribution extends ContributionResource {
  readonly complete: (
    request: ModelRequest,
    context: ModelInvocationContext,
  ) => Promise<ModelResponse>;
}

export interface PreparedToolCall {
  readonly normalizedArguments: JsonObject;
  readonly resourceRefs: readonly ResourceRef[];
}

export interface ToolExecutionContext {
  readonly executionId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly scope: ScopeIdentity;
  readonly authority: RuntimeAuthority;
}

export interface ToolContribution extends ContributionResource {
  readonly version: string;
  readonly effectClass: ToolEffectClass;
  readonly prepare: (
    arguments_: JsonObject,
    context: ToolExecutionContext,
  ) => Awaitable<PreparedToolCall>;
  readonly execute: (
    prepared: PreparedToolCall,
    context: ToolExecutionContext,
  ) => Promise<JsonValue>;
}

export interface SkillContribution extends ContributionResource {
  readonly description: string;
  readonly instructions: string;
}

export interface JobContribution extends ContributionResource {
  readonly run: (payload: JsonObject, signal: AbortSignal) => Promise<JsonValue>;
}

export interface SubagentSpawnContext {
  readonly parentExecutionId: string;
  readonly generation: number;
  readonly authority: RuntimeAuthority;
  readonly scope: import("./scope.js").AgentScope;
}

export interface SubagentContribution extends ContributionResource {
  readonly spawn: (context: SubagentSpawnContext) => Promise<unknown>;
}

export interface ContributionByKind {
  readonly prompt: PromptContribution;
  readonly llm: LlmContribution;
  readonly tool: ToolContribution;
  readonly skill: SkillContribution;
  readonly job: JobContribution;
  readonly subagent: SubagentContribution;
}

export type ContributionKind = keyof ContributionByKind;

export const CONTRIBUTION_KINDS: readonly ContributionKind[] = [
  "prompt",
  "llm",
  "tool",
  "skill",
  "job",
  "subagent",
] as const;

export interface RuntimeAuthority {
  readonly commitment: string;
  readonly toolIds: readonly string[];
  readonly dataScopes: readonly ResourceRef[];
  readonly effectClasses: readonly ToolEffectClass[];
  readonly budget: ExecutionBudget;
}

export interface RequestedSubagentAuthority {
  readonly commitment?: undefined;
  readonly toolIds: readonly string[];
  readonly dataScopes: readonly ResourceRef[];
  readonly effectClasses: readonly ToolEffectClass[];
  readonly budget: ExecutionBudget;
}

export interface RuntimeRecord {
  readonly sequence: number;
  readonly id: string;
  readonly executionId: string;
  readonly type: RuntimeRecordType;
  readonly occurredAt: string;
  readonly payload: JsonObject;
}

export type RuntimeRecordType =
  | "execution/status"
  | "inbox/enqueued"
  | "inbox/consumed"
  | "session/entry"
  | "session/compaction"
  | "turn/started"
  | "turn/completed"
  | "model/request"
  | "model/response"
  | "runner/event"
  | "runner/diagnostic"
  | "tool/intent"
  | "tool/result"
  | "tool/outcome_unknown";

export interface RuntimeRecordInput {
  readonly executionId: string;
  readonly type: RuntimeRecordType;
  readonly payload: JsonObject;
}

export interface RuntimeStore {
  append(input: RuntimeRecordInput): Promise<RuntimeRecord>;
  readExecution(executionId: string): Promise<readonly RuntimeRecord[]>;
}

export type ToolAuthorization =
  | { readonly mode: "auto"; readonly intent: ToolCallIntent }
  | { readonly mode: "approve_once"; readonly approvedIntent: ToolCallIntent }
  | { readonly mode: "deny"; readonly reason?: string };

/**
 * The runtime deliberately delegates every tool authorization to the kernel.
 * Implementations may return auto immediately, or resolve only after a human
 * has approved or denied the exact persisted intent.
 */
export interface ToolApprovalPort {
  authorize(intent: ToolCallIntent, signal: AbortSignal): Promise<ToolAuthorization>;
}

export interface SessionLogEntryInput {
  readonly role: ModelMessage["role"];
  readonly content: string;
  readonly turn: number;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly modelVisible?: boolean;
}

export interface SessionLogEntry extends SessionLogEntryInput {
  readonly id: string;
  readonly sequence: number;
  readonly modelVisible: boolean;
}

export interface SessionCompaction {
  readonly sequence: number;
  readonly throughSequence: number;
  readonly summary: string;
}

export interface SessionLogSnapshot {
  readonly entries: readonly SessionLogEntry[];
  readonly compactions: readonly SessionCompaction[];
}

export interface SessionSurface {
  project(snapshot: SessionLogSnapshot): readonly ModelMessage[];
}

export interface InboxItem {
  readonly id: string;
  readonly sequence: number;
  readonly kind: "follow_up" | "steer" | "resume";
  readonly text: string;
}

export interface RuntimeAgentDefinition {
  readonly id: string;
  readonly llmId: string;
  readonly promptIds: readonly string[];
  readonly toolIds?: readonly string[];
}

export interface AgentHandleOptions {
  readonly executionId: string;
  readonly scope: import("./scope.js").AgentScope;
  readonly store: RuntimeStore;
  readonly definition: RuntimeAgentDefinition;
  readonly authority: RuntimeAuthority;
  readonly approval: ToolApprovalPort;
  readonly surface?: SessionSurface;
  readonly maxModelBoundariesPerTurn?: number;
  readonly toolIntentTtlMs?: number;
  readonly now?: () => string;
}

export interface SubagentSpawnRequest {
  readonly contributionId: string;
  readonly scopeId: string;
  readonly authority: RequestedSubagentAuthority;
}

export type {
  ExecutionBudget,
  ExecutionStatus,
  JsonObject,
  JsonValue,
  ResourceRef,
  ToolCallIntent,
  ToolEffectClass,
};
