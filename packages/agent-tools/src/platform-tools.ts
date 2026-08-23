// SPDX-License-Identifier: Apache-2.0

import { snapshotJsonValue, type JsonValue } from "@mn/agent-protocol";

import { defineTool, type ToolDefinition, type ToolRisk, type ToolRunContext } from "./define-tool.js";
import type { ObjectJsonSchema } from "./json-schema.js";

export type PlatformToolHandler = (
  args: Readonly<Record<string, JsonValue>>,
  context: ToolRunContext
) => JsonValue | Promise<JsonValue>;

export interface PlatformToolAdapters {
  readonly attachments?: { readonly store: PlatformToolHandler };
  readonly images?: {
    readonly view: PlatformToolHandler;
    readonly generate: PlatformToolHandler;
  };
  readonly plan?: { readonly update: PlatformToolHandler };
  readonly goal?: { readonly update: PlatformToolHandler };
  readonly skills?: {
    readonly list: PlatformToolHandler;
    readonly invoke: PlatformToolHandler;
  };
  readonly mcp?: {
    readonly listServers: PlatformToolHandler;
    readonly readResource: PlatformToolHandler;
    readonly callTool: PlatformToolHandler;
  };
  readonly web?: {
    readonly search: PlatformToolHandler;
    readonly open: PlatformToolHandler;
  };
  readonly symbols?: { readonly search: PlatformToolHandler };
  readonly subagents?: {
    readonly spawn: PlatformToolHandler;
    readonly send: PlatformToolHandler;
    readonly wait: PlatformToolHandler;
    readonly interrupt: PlatformToolHandler;
    readonly close: PlatformToolHandler;
    readonly resume: PlatformToolHandler;
  };
}

interface BridgeTool {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly parameters: ObjectJsonSchema;
  readonly handler?: PlatformToolHandler;
}

const EmptyParameters: ObjectJsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
};

function objectArgs(value: unknown): Readonly<Record<string, JsonValue>> {
  const snapshot = snapshotJsonValue(value);
  if (snapshot === undefined || snapshot === null || Array.isArray(snapshot) || typeof snapshot !== "object") {
    throw new TypeError("platform tool arguments must be a lossless JSON object");
  }
  return snapshot as Record<string, JsonValue>;
}

function bridgeTool(input: BridgeTool): ToolDefinition | undefined {
  if (input.handler === undefined) return undefined;
  const handler = input.handler;
  return defineTool({
    name: input.name,
    description: input.description,
    risk: input.risk,
    parameters: input.parameters,
    execute: (args, context) => handler(objectArgs(args), context)
  });
}

function strict(properties: ObjectJsonSchema["properties"], required: readonly string[] = []): ObjectJsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required: [...required] }),
    additionalProperties: false
  };
}

export function createPlatformBridgeTools(adapters: PlatformToolAdapters): readonly ToolDefinition[] {
  const definitions: BridgeTool[] = [
    {
      name: "attachment_store",
      description: "Store a bounded attachment and return its durable reference.",
      risk: "side-effecting",
      parameters: strict({
        name: { type: "string" },
        mimeType: { type: "string" },
        path: { type: "string" }
      }, ["name", "mimeType", "path"]),
      handler: adapters.attachments?.store
    },
    {
      name: "image_view",
      description: "Inspect a local image through the configured image service.",
      risk: "read-only",
      parameters: strict({ path: { type: "string" }, detail: { type: "string", enum: ["high", "original"] } }, ["path"]),
      handler: adapters.images?.view
    },
    {
      name: "image_generate",
      description: "Generate or edit an image through the configured image service.",
      risk: "side-effecting",
      parameters: strict({ prompt: { type: "string" }, referencePaths: { type: "array", items: { type: "string" } } }, ["prompt"]),
      handler: adapters.images?.generate
    },
    {
      name: "plan_update",
      description: "Update the current governed execution plan.",
      risk: "side-effecting",
      parameters: strict({ explanation: { type: "string" }, plan: { type: "array", items: { type: "object" } } }, ["plan"]),
      handler: adapters.plan?.update
    },
    {
      name: "goal_update",
      description: "Create, read, update, clear or complete the current goal.",
      risk: "side-effecting",
      parameters: strict({
        operation: { type: "string", enum: ["create", "get", "update", "clear", "complete"] },
        objective: { type: "string" },
        tokenBudget: { type: "integer" }
      }, ["operation"]),
      handler: adapters.goal?.update
    },
    {
      name: "skills_list",
      description: "List skills available to the current workspace.",
      risk: "read-only",
      parameters: strict({ cwd: { type: "string" }, forceReload: { type: "boolean" } }),
      handler: adapters.skills?.list
    },
    {
      name: "skill_invoke",
      description: "Load and invoke a selected skill.",
      risk: "side-effecting",
      parameters: strict({ name: { type: "string" }, input: {} }, ["name"]),
      handler: adapters.skills?.invoke
    },
    {
      name: "mcp_server_list",
      description: "List configured MCP servers and their status.",
      risk: "read-only",
      parameters: EmptyParameters,
      handler: adapters.mcp?.listServers
    },
    {
      name: "mcp_resource_read",
      description: "Read an MCP resource through the centralized network policy.",
      risk: "side-effecting",
      parameters: strict({ server: { type: "string" }, uri: { type: "string" } }, ["server", "uri"]),
      handler: adapters.mcp?.readResource
    },
    {
      name: "mcp_tool_call",
      description: "Call an MCP tool through the centralized tool policy.",
      risk: "side-effecting",
      parameters: strict({ server: { type: "string" }, tool: { type: "string" }, arguments: {} }, ["server", "tool"]),
      handler: adapters.mcp?.callTool
    },
    {
      name: "web_search",
      description: "Search the web through the configured network service.",
      risk: "side-effecting",
      parameters: strict({ query: { type: "string" } }, ["query"]),
      handler: adapters.web?.search
    },
    {
      name: "web_open",
      description: "Open a web resource through the configured network service.",
      risk: "side-effecting",
      parameters: strict({ url: { type: "string" } }, ["url"]),
      handler: adapters.web?.open
    },
    {
      name: "symbol_search",
      description: "Search workspace symbols through an optional language service.",
      risk: "read-only",
      parameters: strict({ query: { type: "string" }, path: { type: "string" } }, ["query"]),
      handler: adapters.symbols?.search
    },
    {
      name: "subagent_spawn",
      description: "Spawn a governed child agent with inherited limits.",
      risk: "side-effecting",
      parameters: strict({ objective: { type: "string" }, role: { type: "string" } }, ["objective"]),
      handler: adapters.subagents?.spawn
    },
    {
      name: "subagent_send",
      description: "Send input to a governed child agent.",
      risk: "side-effecting",
      parameters: strict({ threadId: { type: "string" }, input: {} }, ["threadId", "input"]),
      handler: adapters.subagents?.send
    },
    {
      name: "subagent_wait",
      description: "Wait for one or more child agents.",
      risk: "read-only",
      parameters: strict({ threadIds: { type: "array", items: { type: "string" } } }, ["threadIds"]),
      handler: adapters.subagents?.wait
    },
    {
      name: "subagent_interrupt",
      description: "Interrupt a running child agent.",
      risk: "side-effecting",
      parameters: strict({ threadId: { type: "string" } }, ["threadId"]),
      handler: adapters.subagents?.interrupt
    },
    {
      name: "subagent_close",
      description: "Close a terminal child agent.",
      risk: "side-effecting",
      parameters: strict({ threadId: { type: "string" } }, ["threadId"]),
      handler: adapters.subagents?.close
    },
    {
      name: "subagent_resume",
      description: "Resume a persisted child agent without expanding its authority.",
      risk: "side-effecting",
      parameters: strict({ threadId: { type: "string" } }, ["threadId"]),
      handler: adapters.subagents?.resume
    }
  ];
  return Object.freeze(definitions.flatMap((definition) => {
    const tool = bridgeTool(definition);
    return tool === undefined ? [] : [tool];
  }));
}
