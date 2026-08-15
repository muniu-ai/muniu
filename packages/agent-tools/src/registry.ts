// SPDX-License-Identifier: Apache-2.0

import { deepFreeze, snapshotJsonValue, type JsonValue, type ToolSchema } from "@mn/agent-protocol";

import { validateJsonSchemaValue } from "./json-schema.js";
import { defineTool, type ToolDefinition, type ToolRisk, type ToolRunContext } from "./define-tool.js";

export interface ToolAuthorizationRequest {
  readonly name: string;
  readonly risk: ToolRisk;
  readonly args: Readonly<Record<string, unknown>>;
  readonly context: ToolRunContext;
}

export interface ToolAuthorizer {
  authorize(request: ToolAuthorizationRequest): Promise<{ readonly decision: "approve" | "deny" }>;
}

export interface ToolInvocation {
  readonly name: string;
  readonly arguments: string;
  readonly context: ToolRunContext;
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

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly authorize: ToolAuthorizer["authorize"];
  private sealed = false;
  private tail: Promise<void> = Promise.resolve();

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
    const operation = this.tail.then(() => this.executeSerial(snapshot));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async executeSerial(invocation: ToolInvocation): Promise<JsonValue> {
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
    assertToolNotCancelled(signal);
    let decision: "approve" | "deny";
    try {
      decision = (await this.authorize({
        name: tool.name,
        risk: tool.risk,
        args: authorizationArgs,
        context: invocationContext
      })).decision;
    } catch {
      assertToolNotCancelled(signal);
      throw new ToolExecutionError("Tool authorization failed", "TOOL_AUTHORIZATION_FAILED");
    }
    assertToolNotCancelled(signal);
    if (decision !== "approve") throw new ToolExecutionError("Tool execution denied", "TOOL_DENIED");
    assertToolNotCancelled(signal);
    try {
      const result = await tool.execute(handlerArgs, invocationContext);
      assertToolNotCancelled(signal);
      const snapshot = snapshotJsonValue(result);
      if (snapshot === undefined) throw new Error("non-JSON tool result");
      return snapshot;
    } catch (error: unknown) {
      assertToolNotCancelled(signal);
      throw new ToolExecutionError("Tool execution failed", "TOOL_EXECUTION_FAILED");
    }
  }
}
