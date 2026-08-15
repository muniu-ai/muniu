import type {
  ProviderAppProjection,
  ProviderHealthRecord,
  ProviderRecord,
  ProxyConfig,
  ProxyReplayRecord,
  ProxyRequestLog
} from "@mn/provider-catalog";
import type {
  McpServerRecord,
  PromptActivationRecord,
  PromptPresetRecord,
  SkillRegistryTrustProfileRecord,
  SkillInstallationRecord,
  SkillRecord
} from "@mn/extensions";

export interface LocalStoreData {
  version: 1;
  providers: ProviderRecord[];
  projections: ProviderAppProjection[];
  proxy: ProxyConfig;
  proxyRequestLogs: ProxyRequestLog[];
  proxyReplayRecords: ProxyReplayRecord[];
  providerHealth: ProviderHealthRecord[];
  mcpServers: McpServerRecord[];
  promptPresets: PromptPresetRecord[];
  promptActivations: PromptActivationRecord[];
  skills: SkillRecord[];
  skillInstallations: SkillInstallationRecord[];
  skillRegistryTrustProfiles: SkillRegistryTrustProfileRecord[];
}

export interface FileLocalStoreOptions {
  rootDir: string;
  dataFile?: string;
}
