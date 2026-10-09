// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from "@mn/contracts";

export interface InboxItem {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly executionId?: string;
  readonly kind: "approval" | "agent_question" | "credential" | "failure" | "reconciliation";
  readonly title: string;
  readonly summary: string;
  readonly risk?: string;
  readonly resourceSummary?: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly status: "open" | "resolved";
}

export interface ModelConnection {
  readonly defaultForNewExecutions?: boolean;
  readonly id: string;
  readonly tenantId: string;
  readonly presetId: string;
  readonly displayName: string;
  readonly secretRef: string;
  readonly defaultModel: string;
  readonly discoveredModels: readonly string[];
  readonly status: "pending" | "ready" | "invalid";
  readonly streamVersion: number;
}

export interface ProviderPreset {
  readonly id: string;
  readonly displayName: string;
  readonly secretLabel: string;
  readonly probeKind: "openai-compatible" | "anthropic" | "dashscope";
  readonly endpoint: string;
  readonly suggestedModels: readonly string[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    secretLabel: "API Key",
    probeKind: "openai-compatible",
    endpoint: "https://api.openai.com/v1",
    suggestedModels: ["gpt-5"],
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    secretLabel: "API Key",
    probeKind: "anthropic",
    endpoint: "https://api.anthropic.com/v1",
    suggestedModels: ["claude-sonnet-4-5"],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    secretLabel: "API Key",
    probeKind: "openai-compatible",
    endpoint: "https://api.deepseek.com/v1",
    suggestedModels: ["deepseek-flash", "deepseek-v4-pro"],
  },
  {
    id: "moonshot",
    displayName: "Kimi（月之暗面，中国区）",
    secretLabel: "开放平台 API Key",
    probeKind: "openai-compatible",
    endpoint: "https://api.moonshot.cn/v1",
    suggestedModels: ["kimi-k2.6"],
  },
  {
    id: "qwen",
    displayName: "通义千问（百炼北京）",
    secretLabel: "百炼北京地域 API Key",
    probeKind: "dashscope",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    suggestedModels: ["qwen-plus", "qwen-flash", "qwen3.5-plus"],
  },
] as const;

export interface PluginDomainCommand {
  readonly pluginId: string;
  readonly command: string;
  readonly payload: JsonObject;
}
