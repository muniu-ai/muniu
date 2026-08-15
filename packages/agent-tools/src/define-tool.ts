/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/core/tools/src/schema.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: retained schema enforcement and typed defineTool construction;
 * removed output DSL, presentation hooks, concurrency plugins, and Cordis.
 */

import { deepFreeze, snapshotJsonValue, type JsonValue } from "@mn/agent-protocol";

import { assertObjectJsonSchema, type ObjectJsonSchema } from "./json-schema.js";

export type ToolRisk = "read-only" | "side-effecting";

export interface ToolRunContext {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

export interface ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly parameters: ObjectJsonSchema;
  execute(args: TArgs, context: ToolRunContext): JsonValue | Promise<JsonValue>;
}

export interface DefineToolOptions<TArgs extends Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly parameters: ObjectJsonSchema;
  execute(args: TArgs, context: ToolRunContext): JsonValue | Promise<JsonValue>;
}

export function defineTool<TArgs extends Record<string, unknown> = Record<string, unknown>>(
  options: DefineToolOptions<TArgs>
): ToolDefinition<TArgs> {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(options.name)) throw new Error("tool name is invalid");
  if (options.description.length === 0) throw new Error("tool description must not be empty");
  if (options.risk !== "read-only" && options.risk !== "side-effecting") throw new Error("tool risk is invalid");
  if (typeof options.execute !== "function") throw new Error("tool execute must be a function");
  const parameters = snapshotJsonValue(options.parameters);
  if (parameters === undefined) throw new Error("tool parameters are not lossless JSON");
  assertObjectJsonSchema(parameters);
  return deepFreeze({
    name: options.name,
    description: options.description,
    risk: options.risk,
    parameters,
    execute: options.execute
  }) as ToolDefinition<TArgs>;
}
