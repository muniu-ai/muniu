// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  type ApprovalPolicy,
  type AgentExecutionBindingV1,
  type EnterpriseBuiltinExecutionOutputV1,
  type EnterpriseBuiltinExecutionStartV1,
  type EnterpriseBuiltinExecutionViewV1,
  type EnterpriseBuiltinJsonValue,
  type EnterpriseBuiltinToolCallV1,
  type EnterpriseBuiltinToolResultV1,
  type EnterpriseBuiltinWorkspaceToolName
} from "@mn/core";
import { sha256Canonical } from "@mn/governance";
import { snapshotJsonValue, type JsonValue } from "@mn/agent-protocol";
import {
  createWorkspaceTools,
  defineTool,
  type ToolDefinition,
  type ToolRunContext
} from "@mn/agent-tools";

export interface EnterpriseBuiltinExecutionIdentity {
  readonly tenantId: string;
  readonly workerId: string;
  readonly claimDigest: string;
}

export interface EnterpriseBuiltinExecutionStartOptions
  extends EnterpriseBuiltinExecutionIdentity {
  readonly request: EnterpriseBuiltinExecutionStartV1;
  readonly providerId: string;
  readonly modelId: string;
  readonly executionBinding: AgentExecutionBindingV1;
  readonly humanApproval: ApprovalPolicy;
  readonly execute: (
    input: EnterpriseBuiltinExecutionStartV1,
    signal: AbortSignal
  ) => Promise<Omit<EnterpriseBuiltinExecutionOutputV1, "providerId" | "modelId" | "executionBinding">>;
}

interface PendingToolCall {
  readonly call: EnterpriseBuiltinToolCallV1;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
  delivery: "pending" | "delivered";
}

interface BrokerExecution {
  readonly executionId: string;
  readonly requestDigest: string;
  readonly tenantId: string;
  readonly workerId: string;
  readonly claimDigest: string;
  readonly request: EnterpriseBuiltinExecutionStartV1;
  readonly providerId: string;
  readonly modelId: string;
  readonly executionBinding: AgentExecutionBindingV1;
  readonly humanApproval: ApprovalPolicy;
  readonly controller: AbortController;
  readonly waiters: Set<() => void>;
  readonly completedToolResults: Map<string, string>;
  done?: Promise<void>;
  state: EnterpriseBuiltinExecutionViewV1["state"];
  revision: number;
  toolOrdinal: number;
  pendingTool?: PendingToolCall;
  output?: EnterpriseBuiltinExecutionOutputV1;
  error?: string;
  cleanupTimer?: NodeJS.Timeout;
}

const WORKSPACE_TOOL_NAMES = new Set<EnterpriseBuiltinWorkspaceToolName>([
  "read_file",
  "list_files",
  "search_text",
  "write_file",
  "apply_patch",
  "run_command"
]);
const MAX_TOOL_RESULT_BYTES = 1024 * 1024;
const TERMINAL_RETENTION_MS = 15 * 60 * 1_000;

export class EnterpriseBuiltinAgentBroker {
  readonly #executions = new Map<string, BrokerExecution>();
  readonly #sessions = new Map<string, BrokerExecution>();
  #disposed = false;

  toolsForTenant(tenantId: string): readonly ToolDefinition[] {
    const fixedTenantId = safeIdentity(tenantId, "tenantId");
    return Object.freeze(createWorkspaceTools().map((tool) => {
      if (!WORKSPACE_TOOL_NAMES.has(tool.name as EnterpriseBuiltinWorkspaceToolName)) {
        throw new TypeError(`unsupported enterprise workspace tool ${tool.name}`);
      }
      return defineTool({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        parameters: tool.parameters,
        execute: (args, context) => this.#dispatch(
          fixedTenantId,
          tool.name as EnterpriseBuiltinWorkspaceToolName,
          tool.risk,
          args,
          context
        )
      });
    }));
  }

  shouldAutoApprove(
    tenantId: string,
    sessionId: string,
    risk: "read-only" | "side-effecting"
  ): boolean {
    if (risk === "read-only") return true;
    const execution = this.#sessions.get(this.#sessionKey(tenantId, sessionId));
    return execution?.humanApproval === "never" || execution?.humanApproval === "before-merge";
  }

  async start(options: EnterpriseBuiltinExecutionStartOptions): Promise<EnterpriseBuiltinExecutionViewV1> {
    if (this.#disposed) throw new Error("enterprise builtin Agent broker is disposed");
    const identity = normalizeIdentity(options);
    const request = snapshotStartRequest(options.request);
    const providerId = safeIdentity(options.providerId, "providerId");
    const modelId = safeIdentity(options.modelId, "modelId");
    const humanApproval = normalizeApprovalPolicy(options.humanApproval);
    const executionBinding = snapshotExecutionBinding(options.executionBinding);
    const executionId = enterpriseBuiltinExecutionId(identity.tenantId, request);
    const requestDigest = sha256Canonical({
      identity,
      request,
      providerId,
      modelId,
      executionBinding,
      humanApproval
    });
    const existing = this.#executions.get(executionId);
    if (existing) {
      if (existing.requestDigest === requestDigest) {
        return this.#view(existing);
      }
      if (
        existing.tenantId !== identity.tenantId ||
        (existing.workerId === identity.workerId && existing.claimDigest === identity.claimDigest)
      ) {
        throw new Error("enterprise builtin execution identifier is already bound to different input");
      }
      if (existing.state === "running") {
        this.cancel(executionId, {
          tenantId: existing.tenantId,
          workerId: existing.workerId,
          claimDigest: existing.claimDigest
        });
      }
      await existing.done?.catch(() => undefined);
      if (existing.cleanupTimer) clearTimeout(existing.cleanupTimer);
      if (this.#executions.get(executionId) === existing) this.#executions.delete(executionId);
    }
    const sessionKey = this.#sessionKey(identity.tenantId, request.sessionId);
    if (this.#sessions.has(sessionKey)) {
      throw new Error("enterprise builtin Agent session already has an active execution");
    }
    const execution: BrokerExecution = {
      executionId,
      requestDigest,
      ...identity,
      request,
      providerId,
      modelId,
      executionBinding,
      humanApproval,
      controller: new AbortController(),
      waiters: new Set(),
      completedToolResults: new Map(),
      state: "running",
      revision: 0,
      toolOrdinal: 0
    };
    this.#executions.set(executionId, execution);
    this.#sessions.set(sessionKey, execution);
    execution.done = Promise.resolve()
      .then(() => options.execute({
        ...request,
        providerId,
        modelId,
        executionBinding
      }, execution.controller.signal))
      .then((output) => {
        if (execution.state !== "running") return;
        execution.output = Object.freeze({
          ...snapshotOutput(output),
          providerId,
          modelId,
          executionBinding
        });
        execution.state = output.reason === "completed"
          ? "completed"
          : output.reason === "cancelled"
            ? "cancelled"
            : "failed";
        if (execution.state === "failed") {
          execution.error = "enterprise builtin execution did not complete";
        }
        this.#terminal(execution);
      })
      .catch(() => {
        if (execution.state !== "running") return;
        execution.state = execution.controller.signal.aborted ? "cancelled" : "failed";
        execution.error = execution.state === "cancelled"
          ? "enterprise builtin execution was cancelled"
          : "enterprise builtin execution failed";
        this.#terminal(execution);
      });
    return this.#view(execution);
  }

  async poll(
    executionId: string,
    identity: EnterpriseBuiltinExecutionIdentity,
    afterRevision: number,
    waitMs: number
  ): Promise<EnterpriseBuiltinExecutionViewV1> {
    const execution = this.#require(executionId, identity);
    const pending = this.#pendingToolView(execution);
    if (pending) return pending;
    if (execution.revision <= afterRevision && execution.state === "running") {
      await this.#wait(execution, Math.max(0, Math.min(waitMs, 10_000)));
    }
    const afterWait = this.#pendingToolView(execution);
    if (afterWait) return afterWait;
    return this.#view(execution);
  }

  submitToolResult(
    executionId: string,
    identity: EnterpriseBuiltinExecutionIdentity,
    result: EnterpriseBuiltinToolResultV1
  ): EnterpriseBuiltinExecutionViewV1 {
    const execution = this.#require(executionId, identity);
    const fixed = snapshotToolResult(result);
    const resultDigest = sha256Canonical(fixed);
    const completedDigest = execution.completedToolResults.get(fixed.callId);
    if (completedDigest !== undefined) {
      if (completedDigest !== resultDigest) {
        throw new Error("enterprise builtin tool result conflicts with its committed result");
      }
      return this.#view(execution);
    }
    const pending = execution.pendingTool;
    if (!pending || pending.delivery !== "delivered" || pending.call.callId !== fixed.callId) {
      throw new Error("enterprise builtin tool call is not awaiting this result");
    }
    execution.pendingTool = undefined;
    execution.completedToolResults.set(fixed.callId, resultDigest);
    pending.cleanup();
    this.#changed(execution);
    if (fixed.ok) pending.resolve(fixed.result as JsonValue);
    else pending.reject(new Error("sandbox workspace tool execution failed"));
    return this.#view(execution);
  }

  cancel(
    executionId: string,
    identity: EnterpriseBuiltinExecutionIdentity
  ): EnterpriseBuiltinExecutionViewV1 {
    const execution = this.#require(executionId, identity);
    if (execution.state === "running") {
      execution.state = "cancelled";
      execution.error = "enterprise builtin execution was cancelled";
      execution.controller.abort(new Error("enterprise builtin execution was cancelled"));
      this.#terminal(execution);
    }
    return this.#view(execution);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const execution of this.#executions.values()) {
      if (execution.cleanupTimer) clearTimeout(execution.cleanupTimer);
      if (execution.state === "running") {
        execution.state = "cancelled";
        execution.controller.abort(new Error("enterprise builtin Agent broker disposed"));
      }
      execution.pendingTool?.cleanup();
      execution.pendingTool?.reject(new Error("enterprise builtin Agent broker disposed"));
      execution.pendingTool = undefined;
      this.#notify(execution);
    }
    this.#executions.clear();
    this.#sessions.clear();
  }

  async #dispatch(
    tenantId: string,
    name: EnterpriseBuiltinWorkspaceToolName,
    risk: "read-only" | "side-effecting",
    args: Record<string, unknown>,
    context: ToolRunContext
  ): Promise<JsonValue> {
    const execution = this.#sessions.get(this.#sessionKey(tenantId, context.sessionId));
    if (!execution || execution.state !== "running") {
      throw new Error("enterprise Agent session has no active sandbox execution");
    }
    if (context.cwd !== execution.request.workspacePath) {
      throw new Error("enterprise Agent tool workspace binding changed");
    }
    if (execution.pendingTool) {
      throw new Error("enterprise Agent session already has a pending tool call");
    }
    const fixedArgs = snapshotJsonValue(args);
    if (!fixedArgs || typeof fixedArgs !== "object" || Array.isArray(fixedArgs)) {
      throw new Error("enterprise Agent tool arguments are not an object");
    }
    execution.toolOrdinal += 1;
    const call: EnterpriseBuiltinToolCallV1 = Object.freeze({
      schemaVersion: 1,
      callId: `${execution.executionId}-tool-${execution.toolOrdinal}`,
      executionId: execution.executionId,
      sessionId: execution.request.sessionId,
      name,
      risk,
      args: fixedArgs as Readonly<Record<string, EnterpriseBuiltinJsonValue>>,
      workspacePath: execution.request.workspacePath,
      createdAt: new Date().toISOString()
    });
    return new Promise<JsonValue>((resolve, reject) => {
      const abort = (): void => {
        const pending = execution.pendingTool;
        if (!pending || pending.call.callId !== call.callId) return;
        execution.pendingTool = undefined;
        pending.cleanup();
        this.#changed(execution);
        reject(new Error("enterprise Agent tool call was cancelled"));
      };
      const cleanup = (): void => {
        context.signal?.removeEventListener("abort", abort);
      };
      execution.pendingTool = {
        call,
        resolve,
        reject,
        cleanup,
        delivery: "pending"
      };
      context.signal?.addEventListener("abort", abort, { once: true });
      if (context.signal?.aborted) abort();
      else this.#changed(execution);
    });
  }

  #require(
    executionId: string,
    identity: EnterpriseBuiltinExecutionIdentity
  ): BrokerExecution {
    const fixedId = safeIdentity(executionId, "executionId");
    const fixedIdentity = normalizeIdentity(identity);
    const execution = this.#executions.get(fixedId);
    if (!execution || execution.tenantId !== fixedIdentity.tenantId) {
      throw new Error("enterprise builtin execution was not found");
    }
    if (
      execution.workerId !== fixedIdentity.workerId ||
      execution.claimDigest !== fixedIdentity.claimDigest
    ) {
      throw new Error("enterprise builtin execution claim binding changed");
    }
    return execution;
  }

  #terminal(execution: BrokerExecution): void {
    const pending = execution.pendingTool;
    execution.pendingTool = undefined;
    if (pending) {
      pending.cleanup();
      pending.reject(new Error("enterprise builtin execution ended during a tool call"));
    }
    this.#sessions.delete(this.#sessionKey(execution.tenantId, execution.request.sessionId));
    this.#changed(execution);
    execution.cleanupTimer = setTimeout(() => {
      if (this.#executions.get(execution.executionId) === execution) {
        this.#executions.delete(execution.executionId);
      }
    }, TERMINAL_RETENTION_MS);
    execution.cleanupTimer.unref?.();
  }

  #changed(execution: BrokerExecution): void {
    execution.revision += 1;
    this.#notify(execution);
  }

  #notify(execution: BrokerExecution): void {
    for (const resolve of execution.waiters) resolve();
    execution.waiters.clear();
  }

  #wait(execution: BrokerExecution, waitMs: number): Promise<void> {
    if (waitMs === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        execution.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      execution.waiters.add(finish);
    });
  }

  #view(
    execution: BrokerExecution,
    toolCall?: EnterpriseBuiltinToolCallV1
  ): EnterpriseBuiltinExecutionViewV1 {
    return Object.freeze({
      schemaVersion: 1,
      executionId: execution.executionId,
      state: execution.state,
      revision: execution.revision,
      providerId: execution.providerId,
      modelId: execution.modelId,
      executionBinding: execution.executionBinding,
      ...(toolCall ? { toolCall } : {}),
      ...(execution.output ? { output: execution.output } : {}),
      ...(execution.error ? { error: execution.error } : {})
    });
  }

  #pendingToolView(execution: BrokerExecution): EnterpriseBuiltinExecutionViewV1 | undefined {
    const pending = execution.pendingTool;
    if (!pending) return undefined;
    if (pending.delivery === "pending") {
      pending.delivery = "delivered";
      this.#changed(execution);
    }
    return this.#view(execution, pending.call);
  }

  #sessionKey(tenantId: string, sessionId: string): string {
    return `${tenantId}\0${sessionId}`;
  }
}

export function enterpriseBuiltinExecutionId(
  tenantId: string,
  request: Pick<EnterpriseBuiltinExecutionStartV1, "runId" | "candidateId" | "sessionId">
): string {
  return `mn-builtin-${createHash("sha256").update(sha256Canonical({
    tenantId: safeIdentity(tenantId, "tenantId"),
    runId: safeIdentity(request.runId, "runId"),
    candidateId: safeIdentity(request.candidateId, "candidateId"),
    sessionId: safeIdentity(request.sessionId, "sessionId")
  })).digest("hex").slice(0, 40)}`;
}

function snapshotStartRequest(
  value: EnterpriseBuiltinExecutionStartV1
): EnterpriseBuiltinExecutionStartV1 {
  const snapshot = snapshotJsonValue(value as unknown as JsonValue);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("enterprise builtin execution request is not JSON");
  }
  return Object.freeze(snapshot as unknown as EnterpriseBuiltinExecutionStartV1);
}

function snapshotExecutionBinding(value: AgentExecutionBindingV1): AgentExecutionBindingV1 {
  const snapshot = snapshotJsonValue(value as unknown as JsonValue);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("enterprise builtin execution binding is not JSON");
  }
  return Object.freeze(snapshot as unknown as AgentExecutionBindingV1);
}

function snapshotOutput(
  value: Omit<EnterpriseBuiltinExecutionOutputV1, "providerId" | "modelId" | "executionBinding">
): Omit<EnterpriseBuiltinExecutionOutputV1, "providerId" | "modelId" | "executionBinding"> {
  const snapshot = snapshotJsonValue(value as unknown as JsonValue);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("enterprise builtin execution output is not JSON");
  }
  return Object.freeze(snapshot as unknown as Omit<
    EnterpriseBuiltinExecutionOutputV1,
    "providerId" | "modelId" | "executionBinding"
  >);
}

function snapshotToolResult(value: EnterpriseBuiltinToolResultV1): EnterpriseBuiltinToolResultV1 {
  const snapshot = snapshotJsonValue(value as unknown as JsonValue);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("enterprise builtin tool result is not JSON");
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_TOOL_RESULT_BYTES) {
    throw new TypeError("enterprise builtin tool result exceeds the size limit");
  }
  return Object.freeze(snapshot as unknown as EnterpriseBuiltinToolResultV1);
}

function normalizeIdentity(
  value: EnterpriseBuiltinExecutionIdentity
): EnterpriseBuiltinExecutionIdentity {
  return Object.freeze({
    tenantId: safeIdentity(value.tenantId, "tenantId"),
    workerId: safeIdentity(value.workerId, "workerId"),
    claimDigest: digest(value.claimDigest, "claimDigest")
  });
}

function safeIdentity(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a safe identifier`);
  }
  return value;
}

function digest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`);
  return value;
}

function normalizeApprovalPolicy(value: ApprovalPolicy): ApprovalPolicy {
  if (value !== "never" && value !== "on-risk" && value !== "before-merge") {
    throw new TypeError("humanApproval is invalid");
  }
  return value;
}
