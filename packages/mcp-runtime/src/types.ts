// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "@mn/agent-protocol";

interface McpServerBase {
  readonly name: string;
  readonly required: boolean;
  readonly enabled?: boolean;
}

export interface StdioMcpServerConfig extends McpServerBase {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly secretEnv?: Readonly<Record<string, string>>;
}

export interface HttpMcpServerConfig extends McpServerBase {
  readonly transport: "streamableHttp";
  readonly url: string;
  readonly oauthTokenRef?: string;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface SecretVault {
  read(reference: string): Promise<string>;
}

export interface McpEffect {
  readonly threadId: string;
  readonly server: string;
  readonly operation: "resource.read" | "tool.call";
  readonly arguments: JsonValue;
}

export interface McpEffectGate {
  authorize(effect: McpEffect): Promise<boolean>;
}

export interface McpConnection {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface McpConnectionInput {
  readonly config: McpServerConfig;
  readonly secretEnv: Readonly<Record<string, string>>;
  readonly oauthToken?: string;
}

export interface McpTransportFactory {
  connect(input: McpConnectionInput): Promise<McpConnection>;
}

export interface McpServerStatus {
  readonly name: string;
  readonly transport: McpServerConfig["transport"];
  readonly required: boolean;
  readonly state: "stopped" | "starting" | "ready" | "failed";
  readonly protocolVersion?: string;
  readonly serverInfo?: Readonly<{ name: string; version: string }>;
  readonly errorCode?: "START_FAILED" | "CONNECTION_CLOSED";
}

export interface McpRuntimeOptions {
  readonly servers: readonly McpServerConfig[];
  readonly vault: SecretVault;
  readonly effectGate: McpEffectGate;
  readonly transportFactory?: McpTransportFactory;
  readonly allowedStdioCommands?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
}
