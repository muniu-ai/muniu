import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  McpServerCreateInput,
  McpServerRecord,
  McpServerUpdateInput,
  PromptActivationRecord,
  PromptPresetCreateInput,
  PromptPresetRecord,
  PromptPresetUpdateInput,
  SkillCreateInput,
  SkillInstallationRecord,
  SkillRegistryTrustProfileInput,
  SkillRegistryTrustProfileRecord,
  SkillRecord,
  SkillUpdateInput
} from "@mn/extensions";
import type {
  ManagedAgentApp,
  ProviderAppProjection,
  ProviderConsumerId,
  ProviderCreateInput,
  ProviderHealthEvent,
  ProviderHealthRecord,
  ProviderRecord,
  ProviderUpdateInput,
  ProxyConfig,
  ProxyReplayRecord,
  ProxyRequestLog
} from "@mn/provider-catalog";
import {
  assertProviderWireConfiguration,
  mergeProviderUpdate,
  providerSupportsApp
} from "@mn/provider-catalog";
import type { FileLocalStoreOptions, LocalStoreData } from "./types.js";

const defaultProxy: ProxyConfig = {
  status: "stopped",
  port: 15721,
  takenOverApps: []
};

export class FileLocalStore {
  readonly rootDir: string;
  readonly dataFile: string;

  constructor(options: FileLocalStoreOptions) {
    this.rootDir = options.rootDir;
    this.dataFile = options.dataFile ?? join(options.rootDir, "mniu.db.json");
  }

  async listProviders(app?: ProviderConsumerId): Promise<ProviderRecord[]> {
    const data = await this.read();
    const providers = app
      ? data.providers.filter((provider) => providerSupportsApp(provider, app))
      : data.providers;
    return providers
      .map((provider) => providerActivationView(provider, app))
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async getProvider(id: string): Promise<ProviderRecord | undefined> {
    const data = await this.read();
    return data.providers.find((provider) => provider.id === id);
  }

  async createProvider(input: ProviderCreateInput): Promise<ProviderRecord> {
    const data = await this.read();
    const now = new Date().toISOString();
    const provider: ProviderRecord = {
      id: randomUUID(),
      app: input.app,
      name: input.name,
      kind: input.kind,
      apiFormat: input.apiFormat,
      baseUrl: input.baseUrl,
      defaultModel: input.defaultModel,
      modelReasoningEffort: input.modelReasoningEffort,
      wireCompatibility: input.wireCompatibility,
      disableResponseStorage: input.disableResponseStorage ?? true,
      wireApi: input.wireApi,
      apiKeyRef: input.apiKeyRef,
      modelCatalog: input.modelCatalog ?? [],
      enterpriseCapabilities: input.enterpriseCapabilities,
      config: input.config ?? {},
      ...providerWithEnabledConsumers(
        input.app,
        input.enabled ? supportedProviderConsumers(input.app) : []
      ),
      sortOrder: input.sortOrder ?? data.providers.length + 1,
      createdAt: now,
      updatedAt: now
    };
    assertProviderWireConfiguration(provider);
    data.providers.push(provider);
    await this.write(data);
    return provider;
  }

  async updateProvider(
    id: string,
    patch: ProviderUpdateInput
  ): Promise<ProviderRecord> {
    const data = await this.read();
    const index = data.providers.findIndex((provider) => provider.id === id);
    if (index < 0) throw new Error(`Provider not found: ${id}`);
    const current = data.providers[index];
    if (!current) throw new Error(`Provider not found: ${id}`);
    const merged = mergeProviderUpdate(current, patch, new Date().toISOString());
    assertProviderWireConfiguration(merged);
    const updated = patch.enabled === undefined
      ? normalizeProviderActivationRecord(merged)
      : {
          ...merged,
          ...providerWithEnabledConsumers(
            merged.app,
            patch.enabled ? supportedProviderConsumers(merged.app) : []
          )
        };
    data.providers[index] = updated;
    await this.write(data);
    return updated;
  }

  async deleteProvider(id: string): Promise<void> {
    const data = await this.read();
    data.providers = data.providers.filter((provider) => provider.id !== id);
    data.projections = data.projections.filter(
      (projection) => projection.providerId !== id
    );
    data.providerHealth = data.providerHealth.filter(
      (health) => health.providerId !== id
    );
    await this.write(data);
  }

  async enableProvider(
    id: string,
    app: ProviderConsumerId
  ): Promise<ProviderRecord> {
    const data = await this.read();
    const provider = data.providers.find((item) => item.id === id);
    if (!provider) throw new Error(`Provider not found: ${id}`);
    if (!providerSupportsApp(provider, app)) {
      throw new Error(`${provider.name} does not support ${app}`);
    }
    const updatedAt = new Date().toISOString();
    data.providers = data.providers.map((item) => {
      if (providerSupportsApp(item, app)) {
        const enabledConsumers = providerEnabledConsumers(item).filter(
          (consumer) => consumer !== app
        );
        if (item.id === id) enabledConsumers.push(app);
        return {
          ...item,
          ...providerWithEnabledConsumers(item.app, enabledConsumers),
          updatedAt
        };
      }
      return item;
    });
    await this.write(data);
    const enabled = data.providers.find((item) => item.id === id);
    if (!enabled) throw new Error(`Provider not found after enable: ${id}`);
    return enabled;
  }

  async getEnabledProvider(
    app: ProviderConsumerId
  ): Promise<ProviderRecord | undefined> {
    const providers = await this.listProviders(app);
    return providers.find((provider) => provider.enabled);
  }

  async disableProvider(id: string, app: ProviderConsumerId): Promise<ProviderRecord> {
    const data = await this.read();
    const index = data.providers.findIndex((provider) => provider.id === id);
    const provider = data.providers[index];
    if (!provider) throw new Error(`Provider not found: ${id}`);
    if (!providerSupportsApp(provider, app)) {
      throw new Error(`${provider.name} does not support ${app}`);
    }
    const disabled = {
      ...provider,
      ...providerWithEnabledConsumers(
        provider.app,
        providerEnabledConsumers(provider).filter((consumer) => consumer !== app)
      ),
      updatedAt: new Date().toISOString()
    };
    data.providers[index] = disabled;
    await this.write(data);
    return disabled;
  }

  async saveProjection(
    projection: Omit<ProviderAppProjection, "id" | "projectedAt">
  ): Promise<ProviderAppProjection> {
    const data = await this.read();
    const saved: ProviderAppProjection = {
      ...projection,
      id: randomUUID(),
      projectedAt: new Date().toISOString()
    };
    data.projections = data.projections.filter(
      (item) =>
        item.app !== saved.app ||
        item.providerId !== saved.providerId ||
        (item.purpose ?? "provider") !== (saved.purpose ?? "provider")
    );
    data.projections.push(saved);
    await this.write(data);
    return saved;
  }

  async getLatestProjection(options: {
    app: ManagedAgentApp;
    purpose?: ProviderAppProjection["purpose"];
  }): Promise<ProviderAppProjection | undefined> {
    const data = await this.read();
    const purpose = options.purpose ?? "provider";
    return data.projections
      .filter((projection) => projection.app === options.app)
      .filter((projection) => (projection.purpose ?? "provider") === purpose)
      .sort((a, b) => b.projectedAt.localeCompare(a.projectedAt))[0];
  }

  async readProxy(): Promise<ProxyConfig> {
    return (await this.read()).proxy;
  }

  async writeProxy(proxy: ProxyConfig): Promise<ProxyConfig> {
    const data = await this.read();
    data.proxy = proxy;
    await this.write(data);
    return proxy;
  }

  async appendProxyRequestLog(log: ProxyRequestLog): Promise<void> {
    const data = await this.read();
    data.proxyRequestLogs.push(log);
    await this.write(data);
  }

  async listProxyRequestLogs(options: {
    app?: ManagedAgentApp;
    providerId?: string;
    runId?: string;
    candidateId?: string;
    limit?: number;
  } = {}): Promise<ProxyRequestLog[]> {
    const data = await this.read();
    const limit = options.limit ?? 100;
    return data.proxyRequestLogs
      .filter((log) => !options.app || log.app === options.app)
      .filter((log) => !options.providerId || log.providerId === options.providerId)
      .filter((log) => !options.runId || log.runId === options.runId)
      .filter((log) => !options.candidateId || log.candidateId === options.candidateId)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async getProxyReplayRecord(key: string): Promise<ProxyReplayRecord | undefined> {
    const data = await this.read();
    return data.proxyReplayRecords.find((record) => record.key === key);
  }

  async saveProxyReplayRecord(record: ProxyReplayRecord): Promise<ProxyReplayRecord> {
    const data = await this.read();
    data.proxyReplayRecords = data.proxyReplayRecords.filter(
      (current) => current.key !== record.key
    );
    data.proxyReplayRecords.push(record);
    await this.write(data);
    return record;
  }

  async markProxyReplayRecordReplayed(
    key: string,
    now = new Date().toISOString()
  ): Promise<ProxyReplayRecord | undefined> {
    const data = await this.read();
    const index = data.proxyReplayRecords.findIndex((record) => record.key === key);
    if (index < 0) return undefined;
    const current = data.proxyReplayRecords[index];
    if (!current) return undefined;
    const updated: ProxyReplayRecord = {
      ...current,
      lastReplayedAt: now,
      replayCount: current.replayCount + 1
    };
    data.proxyReplayRecords[index] = updated;
    await this.write(data);
    return updated;
  }

  async listProviderHealth(options: {
    app?: ManagedAgentApp;
    providerId?: string;
  } = {}): Promise<ProviderHealthRecord[]> {
    const data = await this.read();
    return data.providerHealth
      .filter((health) => !options.app || health.app === options.app)
      .filter((health) => !options.providerId || health.providerId === options.providerId)
      .map((health) => effectiveProviderHealth(health))
      .sort((a, b) => a.app.localeCompare(b.app) || a.providerId.localeCompare(b.providerId));
  }

  async getProviderHealth(
    providerId: string,
    app?: ManagedAgentApp
  ): Promise<ProviderHealthRecord | undefined> {
    return (await this.listProviderHealth({ providerId, app }))[0];
  }

  async resetProviderHealth(options: {
    providerId: string;
    app?: ManagedAgentApp;
  }): Promise<ProviderHealthRecord[]> {
    const data = await this.read();
    const removed: ProviderHealthRecord[] = [];
    data.providerHealth = data.providerHealth.filter((health) => {
      const matches =
        health.providerId === options.providerId && (!options.app || health.app === options.app);
      if (matches) removed.push(effectiveProviderHealth(health));
      return !matches;
    });
    await this.write(data);
    return removed.sort((a, b) => a.app.localeCompare(b.app));
  }

  async recordProviderHealthEvent(
    event: ProviderHealthEvent
  ): Promise<ProviderHealthRecord> {
    const data = await this.read();
    const index = data.providerHealth.findIndex(
      (health) => health.providerId === event.providerId && health.app === event.app
    );
    const current = index >= 0 ? data.providerHealth[index] : undefined;
    const updated = nextProviderHealth(current, event);
    if (index >= 0) {
      data.providerHealth[index] = updated;
    } else {
      data.providerHealth.push(updated);
    }
    await this.write(data);
    return effectiveProviderHealth(updated);
  }

  async listMcpServers(app?: ManagedAgentApp): Promise<McpServerRecord[]> {
    const data = await this.read();
    return data.mcpServers
      .filter((server) => !app || server.apps.includes(app))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getMcpServer(id: string): Promise<McpServerRecord | undefined> {
    const data = await this.read();
    return data.mcpServers.find((server) => server.id === id);
  }

  async createMcpServer(input: McpServerCreateInput): Promise<McpServerRecord> {
    const data = await this.read();
    const now = new Date().toISOString();
    const server: McpServerRecord = {
      id: randomUUID(),
      name: input.name,
      command: input.command,
      args: input.args ?? [],
      env: input.env ?? {},
      apps: normalizeApps(input.apps),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now
    };
    data.mcpServers.push(server);
    await this.write(data);
    return server;
  }

  async updateMcpServer(
    id: string,
    patch: McpServerUpdateInput
  ): Promise<McpServerRecord> {
    const data = await this.read();
    const index = data.mcpServers.findIndex((server) => server.id === id);
    if (index < 0) throw new Error(`MCP server not found: ${id}`);
    const current = data.mcpServers[index];
    if (!current) throw new Error(`MCP server not found: ${id}`);
    const updated: McpServerRecord = {
      ...current,
      ...patch,
      apps: patch.apps ? normalizeApps(patch.apps) : current.apps,
      updatedAt: new Date().toISOString()
    };
    data.mcpServers[index] = updated;
    await this.write(data);
    return updated;
  }

  async deleteMcpServer(id: string): Promise<void> {
    const data = await this.read();
    data.mcpServers = data.mcpServers.filter((server) => server.id !== id);
    await this.write(data);
  }

  async listPromptPresets(app?: ManagedAgentApp): Promise<PromptPresetRecord[]> {
    const data = await this.read();
    return data.promptPresets
      .filter((preset) => !app || preset.apps.includes(app))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getPromptPreset(id: string): Promise<PromptPresetRecord | undefined> {
    const data = await this.read();
    return data.promptPresets.find((preset) => preset.id === id);
  }

  async createPromptPreset(
    input: PromptPresetCreateInput
  ): Promise<PromptPresetRecord> {
    const data = await this.read();
    const now = new Date().toISOString();
    const preset: PromptPresetRecord = {
      id: randomUUID(),
      name: input.name,
      content: input.content,
      apps: normalizeApps(input.apps),
      createdAt: now,
      updatedAt: now
    };
    data.promptPresets.push(preset);
    await this.write(data);
    return preset;
  }

  async updatePromptPreset(
    id: string,
    patch: PromptPresetUpdateInput
  ): Promise<PromptPresetRecord> {
    const data = await this.read();
    const index = data.promptPresets.findIndex((preset) => preset.id === id);
    if (index < 0) throw new Error(`Prompt preset not found: ${id}`);
    const current = data.promptPresets[index];
    if (!current) throw new Error(`Prompt preset not found: ${id}`);
    const updated: PromptPresetRecord = {
      ...current,
      ...patch,
      apps: patch.apps ? normalizeApps(patch.apps) : current.apps,
      updatedAt: new Date().toISOString()
    };
    data.promptPresets[index] = updated;
    await this.write(data);
    return updated;
  }

  async deletePromptPreset(id: string): Promise<void> {
    const data = await this.read();
    data.promptPresets = data.promptPresets.filter((preset) => preset.id !== id);
    data.promptActivations = data.promptActivations.filter(
      (activation) => activation.promptId !== id
    );
    await this.write(data);
  }

  async savePromptActivation(
    activation: Omit<PromptActivationRecord, "id" | "activatedAt">
  ): Promise<PromptActivationRecord> {
    const data = await this.read();
    const saved: PromptActivationRecord = {
      ...activation,
      id: randomUUID(),
      activatedAt: new Date().toISOString()
    };
    data.promptActivations = data.promptActivations.filter(
      (item) => item.app !== saved.app
    );
    data.promptActivations.push(saved);
    await this.write(data);
    return saved;
  }

  async getLatestPromptActivation(
    app: ManagedAgentApp
  ): Promise<PromptActivationRecord | undefined> {
    const data = await this.read();
    return data.promptActivations
      .filter((activation) => activation.app === app)
      .sort((a, b) => b.activatedAt.localeCompare(a.activatedAt))[0];
  }

  async listSkills(app?: ManagedAgentApp): Promise<SkillRecord[]> {
    const data = await this.read();
    return data.skills
      .filter((skill) => !app || skill.apps.includes(app))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSkill(id: string): Promise<SkillRecord | undefined> {
    const data = await this.read();
    return data.skills.find((skill) => skill.id === id);
  }

  async createSkill(input: SkillCreateInput): Promise<SkillRecord> {
    const data = await this.read();
    const now = new Date().toISOString();
    const skill: SkillRecord = {
      id: randomUUID(),
      name: input.name,
      sourcePath: input.sourcePath,
      description: input.description,
      version: input.version,
      apps: normalizeApps(input.apps),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now
    };
    data.skills.push(skill);
    await this.write(data);
    return skill;
  }

  async updateSkill(
    id: string,
    patch: SkillUpdateInput
  ): Promise<SkillRecord> {
    const data = await this.read();
    const index = data.skills.findIndex((skill) => skill.id === id);
    if (index < 0) throw new Error(`Skill not found: ${id}`);
    const current = data.skills[index];
    if (!current) throw new Error(`Skill not found: ${id}`);
    const updated: SkillRecord = {
      ...current,
      ...patch,
      apps: patch.apps ? normalizeApps(patch.apps) : current.apps,
      updatedAt: new Date().toISOString()
    };
    data.skills[index] = updated;
    await this.write(data);
    return updated;
  }

  async deleteSkill(id: string): Promise<void> {
    const data = await this.read();
    data.skills = data.skills.filter((skill) => skill.id !== id);
    data.skillInstallations = data.skillInstallations.filter(
      (installation) => installation.skillId !== id
    );
    await this.write(data);
  }

  async saveSkillInstallation(
    installation: Omit<SkillInstallationRecord, "id" | "installedAt" | "updatedAt">
  ): Promise<SkillInstallationRecord> {
    const data = await this.read();
    const now = new Date().toISOString();
    const existing = data.skillInstallations.find(
      (item) => item.skillId === installation.skillId && item.app === installation.app
    );
    const saved: SkillInstallationRecord = {
      ...installation,
      id: existing?.id ?? randomUUID(),
      installedAt: existing?.installedAt ?? now,
      updatedAt: now
    };
    data.skillInstallations = data.skillInstallations.filter(
      (item) => item.skillId !== saved.skillId || item.app !== saved.app
    );
    data.skillInstallations.push(saved);
    await this.write(data);
    return saved;
  }

  async getSkillInstallation(
    skillId: string,
    app: ManagedAgentApp
  ): Promise<SkillInstallationRecord | undefined> {
    const data = await this.read();
    return data.skillInstallations.find(
      (installation) => installation.skillId === skillId && installation.app === app
    );
  }

  async deleteSkillInstallation(
    skillId: string,
    app: ManagedAgentApp
  ): Promise<void> {
    const data = await this.read();
    data.skillInstallations = data.skillInstallations.filter(
      (installation) => installation.skillId !== skillId || installation.app !== app
    );
    await this.write(data);
  }

  async listSkillRegistryTrustProfiles(): Promise<SkillRegistryTrustProfileRecord[]> {
    const data = await this.read();
    return data.skillRegistryTrustProfiles
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSkillRegistryTrustProfile(
    id: string
  ): Promise<SkillRegistryTrustProfileRecord | undefined> {
    const data = await this.read();
    return data.skillRegistryTrustProfiles.find((profile) => profile.id === id);
  }

  async createSkillRegistryTrustProfile(
    input: SkillRegistryTrustProfileInput
  ): Promise<SkillRegistryTrustProfileRecord> {
    const data = await this.read();
    const now = new Date().toISOString();
    const profile: SkillRegistryTrustProfileRecord = {
      ...normalizeSkillRegistryTrustProfileInput(input),
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    data.skillRegistryTrustProfiles.push(profile);
    await this.write(data);
    return profile;
  }

  async updateSkillRegistryTrustProfile(
    id: string,
    patch: Partial<SkillRegistryTrustProfileInput>
  ): Promise<SkillRegistryTrustProfileRecord> {
    const data = await this.read();
    const index = data.skillRegistryTrustProfiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw new Error(`Skill registry trust profile not found: ${id}`);
    const current = data.skillRegistryTrustProfiles[index];
    if (!current) throw new Error(`Skill registry trust profile not found: ${id}`);
    const updated: SkillRegistryTrustProfileRecord = {
      ...current,
      ...normalizeSkillRegistryTrustProfilePatch(patch),
      updatedAt: new Date().toISOString()
    };
    data.skillRegistryTrustProfiles[index] = updated;
    await this.write(data);
    return updated;
  }

  async deleteSkillRegistryTrustProfile(id: string): Promise<void> {
    const data = await this.read();
    data.skillRegistryTrustProfiles = data.skillRegistryTrustProfiles.filter(
      (profile) => profile.id !== id
    );
    await this.write(data);
  }

  async read(): Promise<LocalStoreData> {
    try {
      const raw = await readFile(this.dataFile, "utf8");
      const parsed = JSON.parse(raw) as LocalStoreData;
      return {
        version: 1,
        providers: (parsed.providers ?? []).map(normalizeProviderActivationRecord),
        projections: parsed.projections ?? [],
        proxy: parsed.proxy ?? defaultProxy,
        proxyRequestLogs: parsed.proxyRequestLogs ?? [],
        proxyReplayRecords: parsed.proxyReplayRecords ?? [],
        providerHealth: parsed.providerHealth ?? [],
        mcpServers: parsed.mcpServers ?? [],
        promptPresets: parsed.promptPresets ?? [],
        promptActivations: parsed.promptActivations ?? [],
        skills: parsed.skills ?? [],
        skillInstallations: parsed.skillInstallations ?? [],
        skillRegistryTrustProfiles: (parsed.skillRegistryTrustProfiles ?? []).map(
          normalizeSkillRegistryTrustProfileRecord
        )
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return emptyStoreData();
      }
      throw error;
    }
  }

  async write(data: LocalStoreData): Promise<void> {
    await mkdir(dirname(this.dataFile), { recursive: true });
    const tempFile = `${this.dataFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600
    });
    await rename(tempFile, this.dataFile);
  }
}

export function emptyStoreData(): LocalStoreData {
  return {
    version: 1,
    providers: [],
    projections: [],
    proxy: defaultProxy,
    proxyRequestLogs: [],
    proxyReplayRecords: [],
    providerHealth: [],
    mcpServers: [],
    promptPresets: [],
    promptActivations: [],
    skills: [],
    skillInstallations: [],
    skillRegistryTrustProfiles: []
  };
}

export function normalizeProviderActivationRecord(provider: ProviderRecord): ProviderRecord {
  return {
    ...provider,
    ...(provider.enabledApps !== undefined
      ? { enabledApps: providerLegacyEnabledApps(provider) }
      : {}),
    ...providerWithEnabledConsumers(provider.app, providerEnabledConsumers(provider))
  };
}

function providerActivationView(
  provider: ProviderRecord,
  app?: ProviderConsumerId
): ProviderRecord {
  const normalized = normalizeProviderActivationRecord(provider);
  return app
    ? {
        ...normalized,
        enabled: normalized.enabledConsumers?.includes(app) ?? false
      }
    : normalized;
}

function providerEnabledConsumers(provider: ProviderRecord): ProviderConsumerId[] {
  if (provider.enabledConsumers) {
    return provider.enabledConsumers.filter((consumer) =>
      providerSupportsApp(provider, consumer)
    );
  }
  if (provider.enabledApps) {
    return providerLegacyEnabledApps(provider);
  }
  return provider.enabled ? supportedProviderConsumers(provider.app) : [];
}

function providerLegacyEnabledApps(provider: ProviderRecord): ManagedAgentApp[] {
  return (provider.enabledApps ?? []).filter(
    (app) =>
      (app === "claude" || app === "codex") && providerSupportsApp(provider, app)
  );
}

function providerWithEnabledConsumers(
  scope: ProviderRecord["app"],
  consumers: readonly ProviderConsumerId[]
): Pick<ProviderRecord, "enabled" | "enabledConsumers"> {
  const supported = new Set(supportedProviderConsumers(scope));
  const enabledConsumers = Array.from(
    new Set(consumers.filter((consumer) => supported.has(consumer)))
  );
  return { enabled: enabledConsumers.length > 0, enabledConsumers };
}

function supportedProviderConsumers(
  scope: ProviderRecord["app"]
): ProviderConsumerId[] {
  return scope === "unified" ? ["claude", "codex", "agent"] : [scope];
}

function normalizeApps(apps: ManagedAgentApp[] | undefined): ManagedAgentApp[] {
  const normalized = Array.from(
    new Set<ManagedAgentApp>(apps ?? ["claude", "codex"])
  );
  if (normalized.length === 0) throw new Error("At least one app is required.");
  return normalized;
}

function normalizeSkillRegistryTrustProfileInput(
  input: SkillRegistryTrustProfileInput
): Omit<SkillRegistryTrustProfileRecord, "id" | "createdAt" | "updatedAt"> {
  return {
    name: input.name.trim(),
    registryUrl: input.registryUrl.trim(),
    requireSignature: input.requireSignature ?? false,
    requireReleaseMetadata: input.requireReleaseMetadata ?? false,
    ...(input.publicKey?.trim() ? { publicKey: input.publicKey.trim() } : {}),
    trustedPublicKeys: normalizeSkillRegistryPublicKeys(input.trustedPublicKeys),
    revokedPublicKeyIds: normalizePublicKeyIds(input.revokedPublicKeyIds)
  };
}

function normalizeSkillRegistryTrustProfilePatch(
  patch: Partial<SkillRegistryTrustProfileInput>
): Partial<Omit<SkillRegistryTrustProfileRecord, "id" | "createdAt" | "updatedAt">> {
  return {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.registryUrl !== undefined ? { registryUrl: patch.registryUrl.trim() } : {}),
    ...(patch.requireSignature !== undefined
      ? { requireSignature: patch.requireSignature }
      : {}),
    ...(patch.requireReleaseMetadata !== undefined
      ? { requireReleaseMetadata: patch.requireReleaseMetadata }
      : {}),
    ...(patch.publicKey !== undefined
      ? patch.publicKey.trim()
        ? { publicKey: patch.publicKey.trim() }
        : { publicKey: undefined }
      : {}),
    ...(patch.trustedPublicKeys !== undefined
      ? { trustedPublicKeys: normalizeSkillRegistryPublicKeys(patch.trustedPublicKeys) }
      : {}),
    ...(patch.revokedPublicKeyIds !== undefined
      ? { revokedPublicKeyIds: normalizePublicKeyIds(patch.revokedPublicKeyIds) }
      : {})
  };
}

export function normalizeSkillRegistryTrustProfileRecord(
  profile: SkillRegistryTrustProfileRecord
): SkillRegistryTrustProfileRecord {
  return {
    id: profile.id,
    name: profile.name,
    registryUrl: profile.registryUrl,
    requireSignature: profile.requireSignature ?? false,
    requireReleaseMetadata: profile.requireReleaseMetadata ?? false,
    ...(profile.publicKey ? { publicKey: profile.publicKey } : {}),
    trustedPublicKeys: normalizeSkillRegistryPublicKeys(profile.trustedPublicKeys),
    revokedPublicKeyIds: normalizePublicKeyIds(profile.revokedPublicKeyIds),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

function normalizeSkillRegistryPublicKeys(
  publicKeys: SkillRegistryTrustProfileInput["trustedPublicKeys"] = []
): SkillRegistryTrustProfileRecord["trustedPublicKeys"] {
  return publicKeys.map((key) => ({
    id: key.id.trim(),
    publicKey: key.publicKey.trim(),
    ...(key.status ? { status: key.status } : {})
  }));
}

function normalizePublicKeyIds(ids: string[] = []): string[] {
  return Array.from(
    new Set(ids.map((id) => id.trim()).filter(Boolean))
  );
}

export function defaultMniuRoot(homeDir = process.env.HOME ?? process.cwd()): string {
  return join(homeDir, ".mniu");
}

export function nextProviderHealth(
  current: ProviderHealthRecord | undefined,
  event: ProviderHealthEvent
): ProviderHealthRecord {
  const now = event.occurredAt ?? new Date().toISOString();
  const retryable = event.retryable ?? !event.ok;
  if (event.ok) {
    return {
      providerId: event.providerId,
      app: event.app,
      state: "healthy",
      consecutiveFailures: 0,
      lastStatusCode: event.statusCode,
      lastLatencyMs: event.latencyMs,
      lastSuccessAt: now,
      lastFailureAt: current?.lastFailureAt,
      updatedAt: now
    };
  }

  const consecutiveFailures = (current?.consecutiveFailures ?? 0) + 1;
  const failureThreshold = event.failureThreshold ?? 3;
  const shouldOpenCircuit = retryable && consecutiveFailures >= failureThreshold;
  const circuitOpenMs = event.circuitOpenMs ?? 60_000;
  return {
    providerId: event.providerId,
    app: event.app,
    state: shouldOpenCircuit ? "circuit_open" : "degraded",
    consecutiveFailures,
    lastStatusCode: event.statusCode,
    lastLatencyMs: event.latencyMs,
    lastError: event.error,
    lastSuccessAt: current?.lastSuccessAt,
    lastFailureAt: now,
    circuitOpenedAt: shouldOpenCircuit ? now : current?.circuitOpenedAt,
    circuitOpenUntil: shouldOpenCircuit
      ? new Date(Date.parse(now) + circuitOpenMs).toISOString()
      : current?.circuitOpenUntil,
    updatedAt: now
  };
}

export function effectiveProviderHealth(
  health: ProviderHealthRecord,
  now = new Date()
): ProviderHealthRecord {
  if (
    health.state === "circuit_open" &&
    health.circuitOpenUntil &&
    Date.parse(health.circuitOpenUntil) <= now.getTime()
  ) {
    return {
      ...health,
      state: "degraded"
    };
  }
  return health;
}
