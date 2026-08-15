// SPDX-License-Identifier: Apache-2.0

import { snapshotJsonValue, type JsonValue, type ToolSchema } from "@mn/agent-protocol";

import { validateJsonSchemaValue } from "./json-schema.js";
import type { ToolDefinition, ToolRisk, ToolRunContext } from "./define-tool.js";

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
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
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
    let decision: "approve" | "deny";
    try {
      decision = (await this.authorizer.authorize({
        name: tool.name,
        risk: tool.risk,
        args: args as Record<string, unknown>,
        context: invocation.context
      })).decision;
    } catch {
      throw new ToolExecutionError("Tool authorization failed", "TOOL_AUTHORIZATION_FAILED");
    }
    if (decision !== "approve") throw new ToolExecutionError("Tool execution denied", "TOOL_DENIED");
    try {
      const result = await tool.execute(args as Record<string, unknown>, invocation.context);
      const snapshot = snapshotJsonValue(result);
      if (snapshot === undefined) throw new Error("non-JSON tool result");
      return snapshot;
    } catch {
      throw new ToolExecutionError("Tool execution failed", "TOOL_EXECUTION_FAILED");
    }
  }
}
