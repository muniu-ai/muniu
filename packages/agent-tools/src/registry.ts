// SPDX-License-Identifier: Apache-2.0

import {
  assertAgentToolApprovalBindingV1,
  createProtectedTextV1,
  deepFreeze,
  digestJson,
  isAgentSessionEventV1,
  snapshotJsonValue,
  type AgentApprovalDecisionV1,
  type AgentApprovalResolutionV1,
  type AgentToolApprovalBindingV1,
  type AgentSessionEventV1,
  type JsonValue,
  type ToolSchema
} from "@mn/agent-protocol";

import { validateJsonSchemaValue } from "./json-schema.js";
import { defineTool, type ToolDefinition, type ToolRisk, type ToolRunContext } from "./define-tool.js";

export interface ToolAuthorizationRequest {
  readonly name: string;
  readonly risk: ToolRisk;
  readonly args: Readonly<Record<string, unknown>>;
  readonly context: ToolRunContext;
  readonly approvalBinding?: AgentToolApprovalBindingV1;
  readonly approvalRequest?: AgentSessionEventV1<"approval/requested">;
}

export type ToolAuthorizationResult =
  | {
    readonly decision: "approve";
    readonly approvalDecision?: "approve_once" | "approve_session_scope";
    readonly resolution?: "decided";
  }
  | {
    readonly decision: "deny";
    readonly approvalDecision?: "deny";
    readonly resolution?: AgentApprovalResolutionV1;
  };

export interface ToolAuthorizer {
  authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult>;
}

export interface ToolInvocation {
  readonly name: string;
  readonly arguments: string;
  readonly context: ToolRunContext;
}

export interface PreparedToolInvocation {
  readonly name: string;
  readonly risk: ToolRisk;
  readonly context: ToolRunContext;
}

export interface ToolAuthorizationOutcome {
  readonly decision: "approve" | "deny";
  readonly approvalDecision: AgentApprovalDecisionV1;
  readonly resolution: AgentApprovalResolutionV1;
}

export interface AuthorizedToolInvocationPermit {
  readonly approvalEventDigest: string;
}

export type ToolExecutionErrorCode =
  | "TOOL_NOT_FOUND"
  | "INVALID_ARGUMENTS"
  | "TOOL_DENIED"
  | "TOOL_CANCELLED"
  | "TOOL_AUTHORIZATION_FAILED"
  | "TOOL_EXECUTION_FAILED";

export class ToolExecutionError extends Error {
  constructor(message: string, readonly code: ToolExecutionErrorCode) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

function snapshotToolInvocation(invocation: ToolInvocation): ToolInvocation {
  if (invocation === null || typeof invocation !== "object" || Array.isArray(invocation)) {
    throw new ToolExecutionError("Invalid tool invocation", "INVALID_ARGUMENTS");
  }
  const name = invocation.name;
  const argumentsJson = invocation.arguments;
  const suppliedContext = invocation.context;
  if (suppliedContext === null || typeof suppliedContext !== "object" || Array.isArray(suppliedContext)) {
    throw new ToolExecutionError("Invalid tool invocation", "INVALID_ARGUMENTS");
  }
  const sessionId = suppliedContext.sessionId;
  const signal = suppliedContext.signal;
  if (typeof name !== "string" || typeof argumentsJson !== "string"
    || typeof sessionId !== "string" || sessionId.length === 0
    || (signal !== undefined && !(signal instanceof AbortSignal))) {
    throw new ToolExecutionError("Invalid tool invocation", "INVALID_ARGUMENTS");
  }
  const context = deepFreeze({
    sessionId,
    ...(signal === undefined ? {} : { signal })
  });
  return deepFreeze({ name, arguments: argumentsJson, context });
}

function assertToolNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ToolExecutionError("Tool execution cancelled", "TOOL_CANCELLED");
  }
}

interface PreparedState {
  readonly owner: ToolRegistry;
  readonly tool: ToolDefinition;
  readonly authorizationArgs: Readonly<Record<string, unknown>>;
  readonly handlerArgs: Readonly<Record<string, unknown>>;
  readonly context: ToolRunContext;
  readonly argumentsJson: string;
  status: "prepared" | "approved-legacy" | "awaiting-resolution" | "denied" | "permitted" | "executed";
  requestedEvent?: AgentSessionEventV1<"approval/requested">;
  outcome?: ToolAuthorizationOutcome;
}

const preparedStates = new WeakMap<object, PreparedState>();
const permitStates = new WeakMap<object, { readonly owner: ToolRegistry; readonly prepared: PreparedToolInvocation }>();

function sameApprovalBinding(left: AgentToolApprovalBindingV1, right: AgentToolApprovalBindingV1): boolean {
  return digestJson(left as unknown as JsonValue) === digestJson(right as unknown as JsonValue);
}

function normalizeAuthorizationResult(value: unknown): ToolAuthorizationOutcome {
  const snapshot = snapshotJsonValue(value);
  if (snapshot === undefined || snapshot === null || Array.isArray(snapshot)
    || typeof snapshot !== "object") {
    throw new TypeError("tool authorization result is invalid");
  }
  const record = snapshot as Record<string, JsonValue>;
  const allowed = new Set(["decision", "approvalDecision", "resolution"]);
  const keys = Object.keys(record);
  if (!keys.includes("decision") || keys.some((key) => !allowed.has(key))) {
    throw new TypeError("tool authorization result is invalid");
  }
  if (record.decision === "approve") {
    const approvalDecision = record.approvalDecision ?? "approve_once";
    const resolution = record.resolution ?? "decided";
    if ((approvalDecision !== "approve_once" && approvalDecision !== "approve_session_scope")
      || resolution !== "decided") {
      throw new TypeError("tool authorization result is invalid");
    }
    return deepFreeze({ decision: "approve", approvalDecision, resolution });
  }
  if (record.decision === "deny") {
    const approvalDecision = record.approvalDecision ?? "deny";
    const resolution = record.resolution ?? "decided";
    if (approvalDecision !== "deny"
      || (resolution !== "decided" && resolution !== "cancelled"
        && resolution !== "closed" && resolution !== "interrupted")) {
      throw new TypeError("tool authorization result is invalid");
    }
    return deepFreeze({ decision: "deny", approvalDecision, resolution });
  }
  throw new TypeError("tool authorization result is invalid");
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly authorize: ToolAuthorizer["authorize"];
  private sealed = false;
  private readonly sessionTails = new Map<string, Promise<void>>();

  constructor(authorizer: ToolAuthorizer) {
    const authorize = authorizer?.authorize;
    if (typeof authorize !== "function") {
      throw new Error("a tool authorizer is required");
    }
    this.authorize = authorize.bind(authorizer);
  }

  register(tool: ToolDefinition): () => void {
    if (this.sealed) throw new Error("tool registry is sealed");
    const name = tool.name;
    const description = tool.description;
    const risk = tool.risk;
    const parameters = tool.parameters;
    const execute = tool.execute;
    const stable = defineTool({
      name,
      description,
      risk,
      parameters,
      execute
    });
    if (this.tools.has(stable.name)) throw new Error(`tool "${stable.name}" is already registered`);
    this.tools.set(stable.name, stable);
    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      if (this.tools.get(stable.name) === stable) this.tools.delete(stable.name);
    };
  }

  seal(): void { this.sealed = true; }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.parameters) as unknown as JsonValue
    }));
  }

  execute(invocation: ToolInvocation): Promise<JsonValue> {
    const snapshot = snapshotToolInvocation(invocation);
    const previous = this.sessionTails.get(snapshot.context.sessionId) ?? Promise.resolve();
    const operation = previous.then(() => this.executeSerial(snapshot));
    const tail = operation.then(() => undefined, () => undefined);
    this.sessionTails.set(snapshot.context.sessionId, tail);
    void tail.then(() => {
      if (this.sessionTails.get(snapshot.context.sessionId) === tail) {
        this.sessionTails.delete(snapshot.context.sessionId);
      }
    });
    return operation;
  }

  prepare(invocation: ToolInvocation): PreparedToolInvocation {
    return this.prepareSnapshot(snapshotToolInvocation(invocation));
  }

  async authorizePrepared(
    prepared: PreparedToolInvocation,
    requestedEvent?: AgentSessionEventV1<"approval/requested">
  ): Promise<ToolAuthorizationOutcome> {
    const state = preparedStates.get(prepared as object);
    if (state === undefined || state.owner !== this || state.status !== "prepared") {
      throw new ToolExecutionError("Invalid prepared tool invocation", "INVALID_ARGUMENTS");
    }
    let fixedBinding: AgentToolApprovalBindingV1 | undefined;
    if (requestedEvent !== undefined) {
      if (!isAgentSessionEventV1(requestedEvent) || requestedEvent.type !== "approval/requested") {
        throw new ToolExecutionError("Invalid durable approval request", "INVALID_ARGUMENTS");
      }
      fixedBinding = assertAgentToolApprovalBindingV1(requestedEvent.payload.publicControls.binding);
      const protectedArguments = createProtectedTextV1(state.argumentsJson);
      if (fixedBinding.name !== state.tool.name
        || fixedBinding.risk !== state.tool.risk
        || fixedBinding.commitment.sessionId !== state.context.sessionId
        || fixedBinding.commitment.protectedInputDigest !== protectedArguments.digest
        || fixedBinding.commitment.protectionPolicyDigest !== protectedArguments.policyDigest) {
        throw new ToolExecutionError("Durable approval request does not match the prepared invocation", "INVALID_ARGUMENTS");
      }
    }
    assertToolNotCancelled(state.context.signal);
    let outcome: ToolAuthorizationOutcome;
    try {
      outcome = normalizeAuthorizationResult(await this.authorize({
        name: state.tool.name,
        risk: state.tool.risk,
        args: state.authorizationArgs,
        context: state.context,
        ...(fixedBinding === undefined ? {} : {
          approvalBinding: fixedBinding,
          approvalRequest: requestedEvent
        })
      }));
    } catch {
      assertToolNotCancelled(state.context.signal);
      throw new ToolExecutionError("Tool authorization failed", "TOOL_AUTHORIZATION_FAILED");
    }
    if (outcome.decision === "approve") assertToolNotCancelled(state.context.signal);
    state.outcome = outcome;
    if (outcome.decision === "approve") {
      state.status = requestedEvent === undefined ? "approved-legacy" : "awaiting-resolution";
    } else {
      state.status = "denied";
    }
    if (requestedEvent !== undefined) state.requestedEvent = requestedEvent;
    return outcome;
  }

  issueExecutePermit(
    prepared: PreparedToolInvocation,
    resolvedEvent: AgentSessionEventV1<"approval/resolved">
  ): AuthorizedToolInvocationPermit | undefined {
    const state = preparedStates.get(prepared as object);
    const requested = state?.requestedEvent;
    const outcome = state?.outcome;
    if (state === undefined || state.owner !== this || requested === undefined || outcome === undefined
      || (state.status !== "awaiting-resolution" && state.status !== "denied")
      || !isAgentSessionEventV1(resolvedEvent) || resolvedEvent.type !== "approval/resolved") {
      throw new ToolExecutionError("Invalid durable approval resolution", "TOOL_DENIED");
    }
    const requestedBinding = requested.payload.publicControls.binding;
    const resolvedControls = resolvedEvent.payload.publicControls;
    if (resolvedEvent.sessionId !== requested.sessionId
      || resolvedEvent.runId !== requested.runId
      || resolvedEvent.candidateId !== requested.candidateId
      || resolvedEvent.seq !== requested.seq + 1
      || resolvedEvent.previousDigest !== requested.digest
      || resolvedControls.requestEventId !== requested.eventId
      || resolvedControls.requestDigest !== requested.digest
      || !sameApprovalBinding(requestedBinding, resolvedControls.binding)
      || resolvedControls.decision !== outcome.approvalDecision
      || resolvedControls.resolution !== outcome.resolution) {
      throw new ToolExecutionError("Durable approval resolution does not match its request", "TOOL_DENIED");
    }
    if (outcome.decision !== "approve") {
      state.status = "executed";
      return undefined;
    }
    state.status = "permitted";
    const permit = deepFreeze({ approvalEventDigest: resolvedEvent.digest });
    permitStates.set(permit, { owner: this, prepared });
    return permit;
  }

  async executeAuthorized(permit: AuthorizedToolInvocationPermit): Promise<JsonValue> {
    const permitState = permit !== null && typeof permit === "object"
      ? permitStates.get(permit as object)
      : undefined;
    const state = permitState === undefined
      ? undefined
      : preparedStates.get(permitState.prepared as object);
    if (permitState === undefined || permitState.owner !== this
      || state === undefined || state.owner !== this || state.status !== "permitted") {
      throw new ToolExecutionError("Tool execution permit is invalid or already consumed", "TOOL_DENIED");
    }
    state.status = "executed";
    permitStates.delete(permit as object);
    return this.executePreparedState(state);
  }

  private async executePreparedState(state: PreparedState): Promise<JsonValue> {
    const signal = state.context.signal;
    assertToolNotCancelled(signal);
    try {
      const result = await state.tool.execute(state.handlerArgs, state.context);
      assertToolNotCancelled(signal);
      const snapshot = snapshotJsonValue(result);
      if (snapshot === undefined) throw new Error("non-JSON tool result");
      return snapshot;
    } catch {
      assertToolNotCancelled(signal);
      throw new ToolExecutionError("Tool execution failed", "TOOL_EXECUTION_FAILED");
    }
  }

  private prepareSnapshot(invocation: ToolInvocation): PreparedToolInvocation {
    const invocationContext = invocation.context;
    const signal = invocationContext.signal;
    assertToolNotCancelled(signal);
    const tool = this.tools.get(invocation.name);
    if (tool === undefined) throw new ToolExecutionError("Tool is not registered", "TOOL_NOT_FOUND");
    let args: unknown;
    try {
      args = JSON.parse(invocation.arguments);
    } catch {
      throw new ToolExecutionError("Invalid tool arguments", "INVALID_ARGUMENTS");
    }
    const violations = validateJsonSchemaValue(tool.parameters, args, "");
    if (violations.length > 0) throw new ToolExecutionError("Invalid tool arguments", "INVALID_ARGUMENTS");
    const authorizationArgs = snapshotJsonValue(args) as Record<string, unknown> | undefined;
    const handlerArgs = snapshotJsonValue(args) as Record<string, unknown> | undefined;
    if (authorizationArgs === undefined || handlerArgs === undefined) {
      throw new ToolExecutionError("Invalid tool arguments", "INVALID_ARGUMENTS");
    }
    deepFreeze(authorizationArgs);
    deepFreeze(handlerArgs);
    const prepared = deepFreeze({
      name: tool.name,
      risk: tool.risk,
      context: invocationContext
    });
    preparedStates.set(prepared, {
      owner: this,
      tool,
      authorizationArgs,
      handlerArgs,
      context: invocationContext,
      argumentsJson: invocation.arguments,
      status: "prepared"
    });
    return prepared;
  }

  private async executeSerial(invocation: ToolInvocation): Promise<JsonValue> {
    const prepared = this.prepareSnapshot(invocation);
    const outcome = await this.authorizePrepared(prepared);
    if (outcome.decision !== "approve") {
      throw new ToolExecutionError("Tool execution denied", "TOOL_DENIED");
    }
    const state = preparedStates.get(prepared as object);
    if (state === undefined || state.owner !== this || state.status !== "approved-legacy") {
      throw new ToolExecutionError("Tool execution was not authorized", "TOOL_DENIED");
    }
    state.status = "executed";
    return this.executePreparedState(state);
  }
}
