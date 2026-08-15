import type {
  ManagedAgentApp,
  ProviderAppScope,
  ProviderCreateInput,
  ProviderPreset,
  ProviderRecord,
  ProviderUpdateInput
} from "./types.js";

export const managedApps: readonly ManagedAgentApp[] = ["claude", "codex"] as const;

export const providerPresets: readonly ProviderPreset[] = [
  {
    id: "claude-official",
    app: "claude",
    name: "Claude 官方",
    kind: "official",
    apiFormat: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-5",
    modelCatalog: [{ id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" }]
  },
  {
    id: "anthropic-compatible",
    app: "claude",
    name: "Anthropic-compatible",
    kind: "anthropic_compatible",
    apiFormat: "anthropic_messages",
    baseUrl: "https://example.com",
    defaultModel: "claude-compatible",
    modelCatalog: [{ id: "claude-compatible", displayName: "Claude-compatible" }]
  },
  {
    id: "openai-official",
    app: "codex",
    name: "OpenAI 官方",
    kind: "official",
    apiFormat: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5",
    wireApi: "responses",
    modelCatalog: [{ id: "gpt-5", displayName: "GPT-5" }]
  },
  {
    id: "openai-compatible",
    app: "codex",
    name: "OpenAI-compatible",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: "https://example.com/v1",
    defaultModel: "openai-compatible-model",
    wireApi: "chat",
    modelCatalog: [
      { id: "openai-compatible-model", displayName: "OpenAI-compatible model" }
    ]
  },
  {
    id: "deepseek",
    app: "codex",
    name: "DeepSeek",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    wireApi: "chat",
    modelCatalog: [
      { id: "deepseek-chat", displayName: "DeepSeek Chat" },
      { id: "deepseek-reasoner", displayName: "DeepSeek Reasoner" }
    ]
  },
  {
    id: "kimi",
    app: "codex",
    name: "Kimi",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2",
    wireApi: "chat",
    modelCatalog: [{ id: "kimi-k2", displayName: "Kimi K2" }]
  },
  {
    id: "openrouter",
    app: "unified",
    name: "OpenRouter",
    kind: "relay",
    apiFormat: "openai_chat",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto",
    wireApi: "chat",
    modelCatalog: [{ id: "openrouter/auto", displayName: "OpenRouter Auto" }]
  },
  {
    id: "siliconflow",
    app: "codex",
    name: "SiliconFlow",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    wireApi: "chat",
    modelCatalog: [
      { id: "deepseek-ai/DeepSeek-V3", displayName: "DeepSeek V3" }
    ]
  }
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return providerPresets.find((preset) => preset.id === id);
}

export function providerSupportsApp(
  provider: Pick<ProviderRecord, "app"> | Pick<ProviderPreset, "app">,
  app: ManagedAgentApp
): boolean {
  return provider.app === app || provider.app === "unified";
}

export function assertProviderSupportsApp(
  provider: Pick<ProviderRecord, "app" | "name">,
  app: ManagedAgentApp
): void {
  if (!providerSupportsApp(provider, app)) {
    throw new Error(`${provider.name} does not support ${app}`);
  }
}

export function createProviderInputFromPreset(
  presetId: string,
  overrides: Partial<ProviderCreateInput> = {}
): ProviderCreateInput {
  const preset = findProviderPreset(presetId);
  if (!preset) {
    throw new Error(`Unknown provider preset: ${presetId}`);
  }
  return {
    app: overrides.app ?? preset.app,
    name: overrides.name ?? preset.name,
    kind: overrides.kind ?? preset.kind,
    apiFormat: overrides.apiFormat ?? preset.apiFormat,
    baseUrl: overrides.baseUrl ?? preset.baseUrl,
    defaultModel: overrides.defaultModel ?? preset.defaultModel,
    modelReasoningEffort: overrides.modelReasoningEffort,
    disableResponseStorage: overrides.disableResponseStorage,
    wireApi: overrides.wireApi ?? preset.wireApi,
    apiKeyRef: overrides.apiKeyRef,
    modelCatalog: overrides.modelCatalog ?? preset.modelCatalog,
    enterpriseCapabilities:
      overrides.enterpriseCapabilities ?? preset.enterpriseCapabilities,
    config: { ...(preset.config ?? {}), ...(overrides.config ?? {}) },
    enabled: overrides.enabled,
    sortOrder: overrides.sortOrder
  };
}

export function mergeProviderUpdate(
  provider: ProviderRecord,
  patch: ProviderUpdateInput,
  updatedAt: string
): ProviderRecord {
  return {
    ...provider,
    ...patch,
    config: patch.config ?? provider.config,
    modelCatalog: patch.modelCatalog ?? provider.modelCatalog,
    updatedAt
  };
}

export function normalizeProviderApp(app: string): ProviderAppScope {
  if (app === "claude" || app === "codex" || app === "unified") return app;
  throw new Error(`Unknown provider app: ${app}`);
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
