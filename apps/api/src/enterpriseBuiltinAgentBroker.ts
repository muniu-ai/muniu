// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";

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
import {
  EnterpriseBuiltinAgentPersistence,
  type DurableBuiltinExecutionOwnerKey
} from "./enterpriseBuiltinAgentPersistence.js";
import type {
  DurableAgentApprovalBridge,
  ToolAuthorizationRequest
} from "./agentApprovalCoordinator.js";

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
  durableKey?: DurableBuiltinExecutionOwnerKey;
  done?: Promise<void>;
  state: EnterpriseBuiltinExecutionViewV1["state"];
  revision: number;
  toolOrdinal: number;
  pendingTool?: PendingToolCall;
  output?: EnterpriseBuiltinExecutionOutputV1;
  error?: string;
  cleanupTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  heartbeatRunning?: boolean;
  ownershipLost?: boolean;
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
  readonly #instanceId: string;
  #disposed = false;

  constructor(
    private readonly persistence?: EnterpriseBuiltinAgentPersistence,
    instanceId?: string
  ) {
    this.#instanceId = instanceId === undefined
      ? randomUUID()
      : safeIdentity(instanceId, "instanceId");
  }

  migrate(): Promise<void> {
    return this.persistence?.migrate() ?? Promise.resolve();
  }

  async shouldRecoverSession(tenantId: string, sessionId: string): Promise<boolean> {
    const fixedTenantId = safeIdentity(tenantId, "tenantId");
    const fixedSessionId = safeIdentity(sessionId, "sessionId");
    if (this.persistence) {
      return !(await this.persistence.sessionIsActivelyOwned(fixedTenantId, fixedSessionId));
    }
    return !this.#sessions.has(this.#sessionKey(fixedTenantId, fixedSessionId));
  }

  approvalBridgeForTenant(tenantId: string): DurableAgentApprovalBridge | undefined {
    const fixedTenantId = safeIdentity(tenantId, "tenantId");
    const persistence = this.persistence;
    if (!persistence) return undefined;
    return Object.freeze({
      authorize: async (request: ToolAuthorizationRequest) => {
        const durable = request.approvalRequest;
        const binding = request.approvalBinding;
        if (!durable || !binding) throw new Error("durable Agent approval binding is unavailable");
        const execution = this.#sessions.get(this.#sessionKey(
          fixedTenantId,
          request.context.sessionId
        ));
        if (!execution?.durableKey || execution.state !== "running") {
          return undefined;
        }
        const decision = await persistence.waitForApproval(
          execution.durableKey,
          durable,
          binding,
          request.context.signal
        );
        return decision === "deny"
          ? Object.freeze({
              decision: "deny" as const,
              approvalDecision: "deny" as const,
              resolution: "decided" as const
            })
          : Object.freeze({
              decision: "approve" as const,
              approvalDecision: decision,
              resolution: "decided" as const
            });
      },
      decide: (input: Parameters<DurableAgentApprovalBridge["decide"]>[0]) => persistence.decideApproval({
        tenantId: fixedTenantId,
        ...input
      })
    });
  }

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
    if (this.persistence) {
      return this.#startDurable({
        options,
        identity,
        request,
        providerId,
        modelId,
        executionBinding,
        humanApproval,
        executionId,
        requestDigest
      });
    }
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
        await this.cancel(executionId, {
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
      .catch((error: unknown) => {
        if (execution.state !== "running") return;
        execution.state = execution.controller.signal.aborted ? "cancelled" : "failed";
        execution.error = execution.state === "cancelled"
          ? "enterprise builtin execution was cancelled"
          : executionFailureSummary(error);
        this.#terminal(execution);
      });
    return this.#view(execution);
  }

  async #startDurable(input: {
    readonly options: EnterpriseBuiltinExecutionStartOptions;
    readonly identity: EnterpriseBuiltinExecutionIdentity;
    readonly request: EnterpriseBuiltinExecutionStartV1;
    readonly providerId: string;
    readonly modelId: string;
    readonly executionBinding: AgentExecutionBindingV1;
    readonly humanApproval: ApprovalPolicy;
    readonly executionId: string;
    readonly requestDigest: string;
  }): Promise<EnterpriseBuiltinExecutionViewV1> {
    const persistence = this.persistence!;
    const acquired = await persistence.acquire({
      ...input.identity,
      executionId: input.executionId,
      requestDigest: input.requestDigest,
      runId: input.request.runId,
      candidateId: input.request.candidateId,
      sessionId: input.request.sessionId,
      providerId: input.providerId,
      modelId: input.modelId,
      executionBinding: input.executionBinding,
      humanApproval: input.humanApproval,
      ownerInstanceId: this.#instanceId
    });
    if (!acquired.owned) return acquired.view;

    const current = this.#executions.get(input.executionId);
    if (
      current?.durableKey?.generation === acquired.generation &&
      current.durableKey.ownerInstanceId === this.#instanceId &&
      current.state === "running"
    ) {
      return acquired.view;
    }
    if (current) {
      current.ownershipLost = true;
      current.controller.abort(new Error("enterprise builtin execution ownership changed"));
      await current.done?.catch(() => undefined);
    }
    const sessionKey = this.#sessionKey(input.identity.tenantId, input.request.sessionId);
    if (this.#sessions.has(sessionKey)) {
      throw new Error("enterprise builtin Agent session already has an active execution");
    }
    const durableKey: DurableBuiltinExecutionOwnerKey = Object.freeze({
      ...input.identity,
      executionId: input.executionId,
      generation: acquired.generation,
      ownerInstanceId: this.#instanceId
    });
    const execution: BrokerExecution = {
      executionId: input.executionId,
      requestDigest: input.requestDigest,
      ...input.identity,
      request: input.request,
      providerId: input.providerId,
      modelId: input.modelId,
      executionBinding: input.executionBinding,
      humanApproval: input.humanApproval,
      controller: new AbortController(),
      waiters: new Set(),
      completedToolResults: new Map(),
      durableKey,
      state: "running",
      revision: acquired.view.revision,
      toolOrdinal: 0
    };
    this.#executions.set(input.executionId, execution);
    this.#sessions.set(sessionKey, execution);
    this.#startOwnerHeartbeat(execution);
    execution.done = (async () => {
      try {
        const output = await input.options.execute({
          ...input.request,
          providerId: input.providerId,
          modelId: input.modelId,
          executionBinding: input.executionBinding
        }, execution.controller.signal);
        if (execution.ownershipLost) return;
        execution.output = Object.freeze({
          ...snapshotOutput(output),
          providerId: input.providerId,
          modelId: input.modelId,
          executionBinding: input.executionBinding
        });
        execution.state = output.reason === "completed"
          ? "completed"
          : output.reason === "cancelled"
            ? "cancelled"
            : "failed";
        execution.error = execution.state === "failed"
          ? "enterprise builtin execution did not complete"
          : undefined;
        await persistence.complete(
          durableKey,
          execution.state,
          execution.output,
          execution.error
        );
      } catch (error: unknown) {
        if (execution.ownershipLost) return;
        execution.state = execution.controller.signal.aborted ? "cancelled" : "failed";
        execution.error = execution.state === "cancelled"
          ? "enterprise builtin execution was cancelled"
          : executionFailureSummary(error);
        try {
          await persistence.complete(durableKey, execution.state, undefined, execution.error);
        } catch {
          execution.ownershipLost = true;
          await persistence.relinquish(durableKey).catch(() => undefined);
        }
      } finally {
        this.#detachDurable(execution);
      }
    })();
    return acquired.view;
  }

  async poll(
    executionId: string,
    identity: EnterpriseBuiltinExecutionIdentity,
    afterRevision: number,
    waitMs: number
  ): Promise<EnterpriseBuiltinExecutionViewV1> {
    if (this.persistence) {
      const snapshot = await this.persistence.waitForChange(
        safeIdentity(executionId, "executionId"),
        normalizeIdentity(identity),
        afterRevision,
        Math.max(0, Math.min(waitMs, 10_000))
      );
      if (snapshot.ownerLeaseExpired) {
        throw new Error("enterprise builtin execution owner lease expired");
      }
      return snapshot.view;
    }
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

  async submitToolResult(
    executionId: string,
    identity: EnterpriseBuiltinExecutionIdentity,
    result: EnterpriseBuiltinToolResultV1
  ): Promise<EnterpriseBuiltinExecutionViewV1> {
    if (this.persistence) {
      const fixed = snapshotToolResult(result);
      const snapshot = await this.persistence.submitToolResult(
        safeIdentity(executionId, "executionId"),
        normalizeIdentity(identity),
        fixed,
        sha256Canonical(fixed)
      );
      if (snapshot.ownerLeaseExpired) {
        throw new Error("enterprise builtin execution owner lease expired");
      }
      return snapshot.view;
    }
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

  async cancel(
    executionId: string,
    identity: EnterpriseBuiltinExecutionIdentity
  ): Promise<EnterpriseBuiltinExecutionViewV1> {
    if (this.persistence) {
      const snapshot = await this.persistence.cancel(
        safeIdentity(executionId, "executionId"),
        normalizeIdentity(identity)
      );
      return snapshot.view;
    }
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
    const relinquishments: Promise<void>[] = [];
    for (const execution of this.#executions.values()) {
      if (execution.cleanupTimer) clearTimeout(execution.cleanupTimer);
      if (execution.heartbeatTimer) clearInterval(execution.heartbeatTimer);
      if (execution.durableKey && this.persistence) {
        execution.ownershipLost = true;
        relinquishments.push(this.persistence.relinquish(execution.durableKey));
      }
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
    await Promise.allSettled(relinquishments);
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
      callId: `${execution.executionId}${execution.durableKey ? `-g${execution.durableKey.generation}` : ""}-tool-${execution.toolOrdinal}`,
      executionId: execution.executionId,
      sessionId: execution.request.sessionId,
      name,
      risk,
      args: fixedArgs as Readonly<Record<string, EnterpriseBuiltinJsonValue>>,
      workspacePath: execution.request.workspacePath,
      createdAt: new Date().toISOString()
    });
    if (execution.durableKey && this.persistence) {
      await this.persistence.publishToolCall(
        execution.durableKey,
        call,
        execution.toolOrdinal
      );
      const result = await this.persistence.waitForToolResult(
        execution.durableKey,
        call.callId,
        context.signal
      );
      if (!result.ok) throw new Error("sandbox workspace tool execution failed");
      return result.result as JsonValue;
    }
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

  #startOwnerHeartbeat(execution: BrokerExecution): void {
    const key = execution.durableKey;
    const persistence = this.persistence;
    if (!key || !persistence) return;
    const tick = async (): Promise<void> => {
      if (execution.heartbeatRunning || execution.ownershipLost || execution.state !== "running") return;
      execution.heartbeatRunning = true;
      try {
        if (await persistence.heartbeat(key)) return;
      } catch {
        // A database outage makes ownership unverifiable and therefore unsafe.
      } finally {
        execution.heartbeatRunning = false;
      }
      execution.ownershipLost = true;
      execution.controller.abort(new Error("enterprise builtin execution ownership was lost"));
    };
    execution.heartbeatTimer = setInterval(() => void tick(), 3_000);
    execution.heartbeatTimer.unref?.();
  }

  #detachDurable(execution: BrokerExecution): void {
    if (execution.heartbeatTimer) clearInterval(execution.heartbeatTimer);
    execution.heartbeatTimer = undefined;
    this.#sessions.delete(this.#sessionKey(execution.tenantId, execution.request.sessionId));
    if (this.#executions.get(execution.executionId) === execution) {
      this.#executions.delete(execution.executionId);
    }
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

function executionFailureSummary(error: unknown): string {
  const detail = (error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "unknown error")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, 512);
  return detail.length === 0
    ? "enterprise builtin execution failed"
    : `enterprise builtin execution failed: ${detail}`;
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
