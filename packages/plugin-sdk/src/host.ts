import type { JsonObject } from "@mn/contracts";
import {
  assertPluginDefinition,
  type PluginContributionBundleV1,
  type PluginDefinitionV1,
  type PluginHealthV1,
  type ProductPluginHostV1,
} from "./contributions.js";
import { canonicalJson } from "./canonical.js";
import { PluginBoundaryError, PluginPolicyError } from "./errors.js";
import {
  assertVerifiedPluginArtifact,
  type VerifiedPluginArtifact,
} from "./registry.js";

export interface ContributionHostAuditEvent {
  readonly pluginId: string;
  readonly workspaceId?: string;
  readonly action:
    | "official_registered"
    | "verified_registered"
    | "verified_replaced"
    | "verified_unregistered"
    | "activated"
    | "deactivated"
    | "plugin_fault";
  readonly message: string;
  readonly at: string;
}

export interface PluginContributionHostOptions {
  readonly isAvailable: (pluginId: string) => boolean;
  readonly audit?: (event: ContributionHostAuditEvent) => void;
  readonly now?: () => Date;
}

export interface HostHealthV1 {
  readonly core: { readonly status: "healthy" };
  readonly plugins: readonly ({ readonly pluginId: string } & PluginHealthV1)[];
}

interface RegisteredDefinition {
  readonly definition: PluginDefinitionV1;
  readonly registrationOrder: number;
}

const EMPTY_CONTRIBUTIONS: PluginContributionBundleV1 = {
  routes: [],
  navigation: [],
  widgets: [],
  commands: [],
  agents: [],
  skills: [],
  workflows: [],
  tools: [],
  memorySchemas: [],
};

export class PluginContributionHost implements ProductPluginHostV1 {
  readonly #definitions = new Map<string, RegisteredDefinition>();
  readonly #workspacePlugins = new Map<string, Set<string>>();
  readonly #faults = new Map<string, string>();
  readonly #isAvailable: (pluginId: string) => boolean;
  readonly #audit: (event: ContributionHostAuditEvent) => void;
  readonly #now: () => Date;
  #registrationOrder = 0;

  constructor(options: PluginContributionHostOptions) {
    this.#isAvailable = options.isAvailable;
    this.#audit = options.audit ?? (() => undefined);
    this.#now = options.now ?? (() => new Date());
  }

  registerOfficial(definition: PluginDefinitionV1): void {
    assertPluginDefinition(definition);
    if (!definition.official) {
      throw new PluginPolicyError(
        "PLUGIN_DEFINITION_INVALID",
        `插件 ${definition.id} 不是官方预装插件`,
        "使用签名仓库安装第三方插件",
      );
    }
    this.#register(definition);
    this.#recordAudit(definition.id, undefined, "official_registered", `官方插件 ${definition.id} 已预装，默认未启用`);
  }

  registerVerified(artifact: VerifiedPluginArtifact, definition: PluginDefinitionV1): void {
    this.#assertVerifiedDefinition(artifact, definition);
    this.#register(definition);
    this.#recordAudit(
      definition.id,
      undefined,
      "verified_registered",
      `已注册本地验签插件 ${definition.id} ${definition.version}`,
    );
  }

  /**
   * 在制品、执行和投影已经由组合根完成校验与切换后，更换进程内贡献定义。
   * 保留工作区激活集合和注册顺序，避免升级改变导航排序。
   */
  replaceVerified(artifact: VerifiedPluginArtifact, definition: PluginDefinitionV1): void {
    this.#assertVerifiedDefinition(artifact, definition);
    const registered = this.#definitions.get(definition.id);
    if (!registered || registered.definition.official) {
      throw new PluginPolicyError(
        "PLUGIN_NOT_INSTALLED",
        `签名仓库插件 ${definition.id} 尚未注册`,
        "先安装插件后再更新",
      );
    }
    for (const active of this.#workspacePlugins.values()) {
      if (active.has(definition.id)) {
        this.#assertNoRouteCollisions(active, definition, definition.id);
      }
    }
    this.#definitions.set(definition.id, {
      definition,
      registrationOrder: registered.registrationOrder,
    });
    this.#faults.delete(definition.id);
    this.#recordAudit(
      definition.id,
      undefined,
      "verified_replaced",
      `已切换本地验签插件 ${definition.id} ${definition.version}`,
    );
  }

  activeWorkspaceIds(pluginId: string): readonly string[] {
    return [...this.#workspacePlugins]
      .filter(([, active]) => active.has(pluginId))
      .map(([workspaceId]) => workspaceId)
      .sort();
  }

  unregisterVerified(pluginId: string): void {
    const registered = this.#definitions.get(pluginId);
    if (!registered) return;
    if (registered.definition.official) {
      throw new PluginPolicyError(
        "PLUGIN_PURGE_INVALID",
        `官方预装插件 ${pluginId} 不能清除`,
        "仅清除从签名仓库安装的插件",
      );
    }
    const activeWorkspaceIds = this.activeWorkspaceIds(pluginId);
    if (activeWorkspaceIds.length > 0) {
      throw new PluginPolicyError(
        "PLUGIN_PURGE_INVALID",
        `插件 ${pluginId} 仍在 ${activeWorkspaceIds.length} 个工作区中启用`,
        "先停用插件后再清除",
      );
    }
    this.#definitions.delete(pluginId);
    this.#faults.delete(pluginId);
    this.#recordAudit(
      pluginId,
      undefined,
      "verified_unregistered",
      `已移除本地验签插件 ${pluginId} 的进程内贡献`,
    );
  }

  listRegistered(): readonly {
    readonly pluginId: string;
    readonly version: string;
    readonly official: boolean;
    readonly trustBoundary: "process_equivalent";
  }[] {
    return this.#orderedDefinitions().map(({ definition }) => ({
      pluginId: definition.id,
      version: definition.version,
      official: definition.official,
      trustBoundary: definition.trustBoundary,
    }));
  }

  definition(pluginId: string): PluginDefinitionV1 | undefined {
    return this.#definitions.get(pluginId)?.definition;
  }

  listOfficial(): readonly {
    readonly pluginId: string;
    readonly version: string;
    readonly activeByDefault: false;
    readonly trustBoundary: "process_equivalent";
  }[] {
    return this.#orderedDefinitions()
      .filter(({ definition }) => definition.official)
      .map(({ definition }) => ({
        pluginId: definition.id,
        version: definition.version,
        activeByDefault: false as const,
        trustBoundary: definition.trustBoundary,
      }));
  }

  async activate(workspaceId: string, pluginId: string): Promise<void> {
    const definition = this.#requireDefinition(pluginId);
    if (!this.#isAvailable(pluginId)) {
      throw new PluginPolicyError(
        "PLUGIN_NOT_INSTALLED",
        `插件 ${pluginId} 不可用`,
        "安装或修复插件后重试",
      );
    }
    const active = this.#workspacePlugins.get(workspaceId) ?? new Set<string>();
    if (active.has(pluginId)) return;
    this.#assertNoRouteCollisions(active, definition);
    try {
      await definition.activate?.({ workspaceId });
    } catch (error) {
      this.#fault(pluginId, workspaceId, "activate", error);
    }
    active.add(pluginId);
    this.#workspacePlugins.set(workspaceId, active);
    this.#recordAudit(pluginId, workspaceId, "activated", `工作区已启用插件 ${pluginId}`);
  }

  async deactivate(workspaceId: string, pluginId: string): Promise<void> {
    const definition = this.#requireDefinition(pluginId);
    const active = this.#workspacePlugins.get(workspaceId);
    if (!active?.has(pluginId)) return;
    active.delete(pluginId);
    try {
      await definition.deactivate?.({ workspaceId });
    } catch (error) {
      this.#fault(pluginId, workspaceId, "deactivate", error);
    }
    this.#recordAudit(pluginId, workspaceId, "deactivated", `工作区已停用插件 ${pluginId}`);
  }

  contributions(workspaceId: string): PluginContributionBundleV1 {
    const active = this.#workspacePlugins.get(workspaceId) ?? new Set<string>();
    const bundles = this.#orderedDefinitions()
      .filter(({ definition }) => active.has(definition.id))
      .map(({ definition }) => definition.contributions);
    return {
      routes: bundles.flatMap((bundle) => bundle.routes),
      navigation: bundles.flatMap((bundle) => bundle.navigation),
      widgets: bundles.flatMap((bundle) => bundle.widgets),
      commands: bundles.flatMap((bundle) => bundle.commands),
      agents: bundles.flatMap((bundle) => bundle.agents),
      skills: bundles.flatMap((bundle) => bundle.skills),
      workflows: bundles.flatMap((bundle) => bundle.workflows),
      tools: bundles.flatMap((bundle) => bundle.tools),
      memorySchemas: bundles.flatMap((bundle) => bundle.memorySchemas),
    };
  }

  async runCommand(
    workspaceId: string,
    pluginId: string,
    commandId: string,
    input: JsonObject,
    principalId?: string,
  ): Promise<unknown> {
    if (!this.#workspacePlugins.get(workspaceId)?.has(pluginId)) {
      throw new PluginPolicyError(
        "PLUGIN_NOT_ACTIVE",
        `工作区未启用插件 ${pluginId}`,
        "先在工作区启用插件",
      );
    }
    const definition = this.#requireDefinition(pluginId);
    const command = definition.contributions.commands.find((candidate) => candidate.id === commandId);
    if (!command) {
      throw new PluginPolicyError(
        "PLUGIN_CONTRIBUTION_INVALID",
        `插件 ${pluginId} 未提供命令 ${commandId}`,
        "刷新插件贡献目录",
      );
    }
    try {
      const result = await command.run(input, { workspaceId, principalId });
      this.#faults.delete(pluginId);
      return result;
    } catch (error) {
      this.#fault(pluginId, workspaceId, `command:${commandId}`, error);
    }
  }

  async health(workspaceId: string): Promise<HostHealthV1> {
    const active = this.#workspacePlugins.get(workspaceId) ?? new Set<string>();
    const plugins = await Promise.all(this.#orderedDefinitions()
      .filter(({ definition }) => active.has(definition.id))
      .map(async ({ definition }) => {
        const previousFault = this.#faults.get(definition.id);
        if (!definition.healthCheck && previousFault) {
          return { pluginId: definition.id, status: "degraded" as const, message: previousFault };
        }
        try {
          const health = await definition.healthCheck?.({ workspaceId }) ?? { status: "healthy" as const };
          if (health.status === "healthy") this.#faults.delete(definition.id);
          return { pluginId: definition.id, ...health };
        } catch (error) {
          const message = safeErrorMessage(error);
          this.#faults.set(definition.id, message);
          this.#recordAudit(
            definition.id,
            workspaceId,
            "plugin_fault",
            `插件 ${definition.id} 健康检查失败：${message}`,
          );
          return { pluginId: definition.id, status: "degraded" as const, message };
        }
      }));
    return { core: { status: "healthy" }, plugins };
  }

  #orderedDefinitions(): readonly RegisteredDefinition[] {
    return [...this.#definitions.values()].sort((left, right) => {
      return left.registrationOrder - right.registrationOrder;
    });
  }

  #register(definition: PluginDefinitionV1): void {
    if (this.#definitions.has(definition.id)) {
      throw new PluginPolicyError(
        "PLUGIN_DEFINITION_INVALID",
        `插件 ${definition.id} 已注册`,
        "移除重复注册",
      );
    }
    this.#definitions.set(definition.id, {
      definition,
      registrationOrder: this.#registrationOrder++,
    });
  }

  #assertNoRouteCollisions(
    active: ReadonlySet<string>,
    candidate: PluginDefinitionV1,
    replacingPluginId?: string,
  ): void {
    const occupied = new Map<string, string>();
    for (const { definition } of this.#orderedDefinitions()) {
      if (definition.id === replacingPluginId) continue;
      if (!active.has(definition.id)) continue;
      for (const route of definition.contributions.routes) {
        occupied.set(normalizeRoute(route.path), definition.id);
      }
    }
    for (const route of candidate.contributions.routes) {
      const owner = occupied.get(normalizeRoute(route.path));
      if (owner) {
        throw new PluginPolicyError(
          "PLUGIN_CONTRIBUTION_INVALID",
          `路由 ${route.path} 已由插件 ${owner} 提供`,
          "修改插件路由后重新启用",
        );
      }
    }
  }

  #assertVerifiedDefinition(
    artifact: VerifiedPluginArtifact,
    definition: PluginDefinitionV1,
  ): void {
    assertVerifiedPluginArtifact(artifact);
    assertPluginDefinition(definition);
    if (definition.official) {
      throw new PluginPolicyError(
        "PLUGIN_DEFINITION_INVALID",
        `签名仓库插件 ${definition.id} 不得冒充官方预装插件`,
        "将 official 设为 false",
      );
    }
    if (!definition.manifest
      || canonicalJson(definition.manifest) !== canonicalJson(artifact.manifest)) {
      throw new PluginPolicyError(
        "PLUGIN_DEFINITION_INVALID",
        `插件 ${definition.id} 的运行定义与已验签清单不一致`,
        "绑定同一份已验签清单后重试",
      );
    }
  }

  #requireDefinition(pluginId: string): PluginDefinitionV1 {
    const registered = this.#definitions.get(pluginId);
    if (!registered) {
      throw new PluginPolicyError(
        "PLUGIN_NOT_INSTALLED",
        `插件 ${pluginId} 未注册`,
        "安装并注册插件",
      );
    }
    return registered.definition;
  }

  #fault(pluginId: string, workspaceId: string, operation: string, error: unknown): never {
    const message = safeErrorMessage(error);
    this.#faults.set(pluginId, message);
    this.#recordAudit(pluginId, workspaceId, "plugin_fault", `插件 ${pluginId} 执行失败：${message}`);
    throw new PluginBoundaryError(pluginId, operation, error);
  }

  #recordAudit(
    pluginId: string,
    workspaceId: string | undefined,
    action: ContributionHostAuditEvent["action"],
    message: string,
  ): void {
    this.#audit({ pluginId, workspaceId, action, message, at: this.#now().toISOString() });
  }
}

export function emptyPluginContributions(): PluginContributionBundleV1 {
  return { ...EMPTY_CONTRIBUTIONS };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? "插件内部错误" : "未知错误";
}

function normalizeRoute(route: string): string {
  const normalized = route.replace(/\/+$/u, "");
  return normalized || "/";
}
