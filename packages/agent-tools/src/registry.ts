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
  | "TOOL_AUTHORIZATION_FAILED"
  | "TOOL_EXECUTION_FAILED";

export class ToolExecutionError extends Error {
  constructor(message: string, readonly code: ToolExecutionErrorCode) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private sealed = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly authorizer: ToolAuthorizer) {
    if (authorizer === undefined || typeof authorizer.authorize !== "function") {
      throw new Error("a tool authorizer is required");
    }
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
    const operation = this.tail.then(() => this.executeSerial(invocation));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async executeSerial(invocation: ToolInvocation): Promise<JsonValue> {
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
    const authorizationContext = deepFreeze({
      sessionId: invocation.context.sessionId,
      ...(invocation.context.signal === undefined ? {} : { signal: invocation.context.signal })
    });
    const handlerContext = deepFreeze({
      sessionId: invocation.context.sessionId,
      ...(invocation.context.signal === undefined ? {} : { signal: invocation.context.signal })
    });
    let decision: "approve" | "deny";
    try {
      decision = (await this.authorizer.authorize({
        name: tool.name,
        risk: tool.risk,
        args: authorizationArgs,
        context: authorizationContext
      })).decision;
    } catch {
      throw new ToolExecutionError("Tool authorization failed", "TOOL_AUTHORIZATION_FAILED");
    }
    if (decision !== "approve") throw new ToolExecutionError("Tool execution denied", "TOOL_DENIED");
    try {
      const result = await tool.execute(handlerArgs, handlerContext);
      const snapshot = snapshotJsonValue(result);
      if (snapshot === undefined) throw new Error("non-JSON tool result");
      return snapshot;
    } catch {
      throw new ToolExecutionError("Tool execution failed", "TOOL_EXECUTION_FAILED");
    }
  }
}
