import type {
  JsonObject,
  PluginManifestV1,
  ToolEffectClass,
  PluginSurfacesV1,
} from "@mn/contracts";
import { PluginPolicyError } from "./errors.js";
import { assertPluginSurfaces } from "./surfaces.js";
import type { PluginDomainEventV1, PluginProjectionRecordV1 } from "./projection-program.js";

export type PluginTrustBoundary = "process_equivalent";

export interface RouteContributionV1 {
  readonly id: string;
  readonly path: string;
}

export interface NavigationContributionV1 {
  readonly id: string;
  readonly label: string;
  readonly routeId: string;
  readonly order?: number;
}

export interface WidgetContributionV1 {
  readonly id: string;
  readonly slot: "home" | "workspace";
  readonly title: string;
}

export interface CommandContextV1 {
  readonly workspaceId: string;
  readonly principalId?: string;
  readonly data?: PluginDataPortV1;
}

export interface PluginDataPortV1 {
  /** A stable step key makes retrying a command return the original committed event. */
  append(input: { readonly key: string; readonly resourceId: string; readonly eventType: string;
    readonly payload: JsonObject; readonly expectedStreamVersion: number }): Promise<PluginDomainEventV1>;
  get(view: string, resourceId: string): Promise<PluginProjectionRecordV1 | undefined>;
}

export interface CommandContributionV1 {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  run(input: JsonObject, context: CommandContextV1): Promise<unknown>;
}

export interface AgentContributionV1 {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
}

export interface SkillContributionV1 {
  readonly id: string;
  readonly title: string;
  readonly expectedOutcome: string;
  readonly exampleInput?: string;
  readonly source: string;
  readonly license: string;
  readonly version: string;
  readonly permissionIds: readonly string[];
}

export interface WorkflowContributionV1 {
  readonly id: string;
  readonly version: string;
}

export interface ToolContributionV1 {
  readonly id: string;
  readonly version: string;
  readonly effectClass: ToolEffectClass;
}

export interface MemorySchemaContributionV1 {
  readonly id: string;
  readonly version: string;
  readonly namespace: string;
}

export interface PluginContributionBundleV1 {
  readonly routes: readonly RouteContributionV1[];
  readonly navigation: readonly NavigationContributionV1[];
  readonly widgets: readonly WidgetContributionV1[];
  readonly commands: readonly CommandContributionV1[];
  readonly agents: readonly AgentContributionV1[];
  readonly skills: readonly SkillContributionV1[];
  readonly workflows: readonly WorkflowContributionV1[];
  readonly tools: readonly ToolContributionV1[];
  readonly memorySchemas: readonly MemorySchemaContributionV1[];
}

export interface PluginHealthV1 {
  readonly status: "healthy" | "degraded";
  readonly message?: string;
}

export interface PluginActivationContextV1 {
  readonly workspaceId: string;
  readonly onDispose?: (cleanup: () => Promise<void> | void) => void;
}

export interface PluginActivationLifecycle {
  activate(workspaceId: string, definition: PluginDefinitionV1): Promise<void>;
  deactivate(workspaceId: string, pluginId: string): Promise<void>;
}

export interface PluginDefinitionV1 {
  readonly surfaces?: PluginSurfacesV1;
  readonly id: string;
  readonly version: string;
  readonly official: boolean;
  /** 插件与宿主进程权限等价；该边界明确不是沙箱。 */
  readonly trustBoundary: PluginTrustBoundary;
  readonly manifest?: PluginManifestV1;
  readonly contributions: PluginContributionBundleV1;
  activate?(context: PluginActivationContextV1): Promise<void> | void;
  deactivate?(context: PluginActivationContextV1): Promise<void> | void;
  healthCheck?(context: PluginActivationContextV1): Promise<PluginHealthV1> | PluginHealthV1;
}

export interface ProductPluginHostV1 {
  registerOfficial(definition: PluginDefinitionV1): void;
  activate(workspaceId: string, pluginId: string): Promise<void>;
  deactivate(workspaceId: string, pluginId: string): Promise<void>;
  contributions(workspaceId: string): PluginContributionBundleV1;
  runCommand(
    workspaceId: string,
    pluginId: string,
    commandId: string,
    input: JsonObject,
    principalId?: string,
    data?: PluginDataPortV1,
  ): Promise<unknown>;
}

const GLOBAL_ROUTES = [
  "/",
  "/home",
  "/workspaces",
  "/inbox",
  "/deliverables",
  "/activity",
  "/agents",
  "/integrations",
  "/settings",
];

export function assertPluginDefinition(definition: PluginDefinitionV1): void {
  if (!definition.id || !definition.version || definition.trustBoundary !== "process_equivalent") {
    throw invalidDefinition("插件必须声明进程等价信任边界");
  }
  if (definition.manifest
    && (definition.manifest.id !== definition.id || definition.manifest.version !== definition.version)) {
    throw invalidDefinition("插件定义与清单身份不一致");
  }
  const contributionKinds = [
    "routes",
    "navigation",
    "widgets",
    "commands",
    "agents",
    "skills",
    "workflows",
    "tools",
    "memorySchemas",
  ] as const;
  for (const kind of contributionKinds) assertUniqueIds(kind, definition.contributions[kind]);

  const routeIds = new Set(definition.contributions.routes.map((route) => route.id));
  for (const route of definition.contributions.routes) {
    if (!route.path.startsWith("/") || route.path.includes("?") || route.path.includes("#")) {
      throw invalidContribution(`插件路由 ${route.id} 不是绝对应用路径`);
    }
    if (GLOBAL_ROUTES.some((reserved) => {
      const normalized = normalizeRoute(route.path);
      return normalized === reserved || (reserved !== "/" && normalized.startsWith(`${reserved}/`));
    })) {
      throw invalidContribution(`插件不得替换全局路由 ${route.path}`);
    }
  }
  for (const navigation of definition.contributions.navigation) {
    if (!routeIds.has(navigation.routeId)) {
      throw invalidContribution(`导航 ${navigation.id} 引用了未声明路由`);
    }
  }
  if (definition.manifest) assertManifestDeclarations(definition.manifest, definition.contributions);
  if (definition.surfaces) assertPluginSurfaces(definition.surfaces, definition.contributions);
  if (definition.manifest
    && Boolean(definition.manifest.contributes.healthCheck) !== Boolean(definition.healthCheck)) {
    throw invalidContribution("健康检查贡献与签名清单不一致");
  }
}

function assertManifestDeclarations(
  manifest: PluginManifestV1,
  contributions: PluginContributionBundleV1,
): void {
  const pairs: readonly [readonly string[], readonly { readonly id: string }[], string][] = [
    [manifest.contributes.routes, contributions.routes, "路由"],
    [manifest.contributes.navigation, contributions.navigation, "导航"],
    [manifest.contributes.widgets, contributions.widgets, "组件"],
    [manifest.contributes.commands, contributions.commands, "命令"],
    [manifest.contributes.agents, contributions.agents, "Agent"],
    [manifest.contributes.skills, contributions.skills, "Skill"],
    [manifest.contributes.workflows, contributions.workflows, "工作流"],
    [manifest.contributes.tools, contributions.tools, "工具"],
    [manifest.contributes.memorySchemas, contributions.memorySchemas, "记忆结构"],
  ];
  for (const [declared, actual, label] of pairs) {
    const left = [...declared].sort();
    const right = actual.map((entry) => entry.id).sort();
    if (left.length !== right.length || left.some((id, index) => id !== right[index])) {
      throw invalidContribution(`${label}贡献与签名清单不一致`);
    }
  }
}

function assertUniqueIds(
  kind: string,
  contributions: readonly { readonly id: string }[],
): void {
  const ids = new Set<string>();
  for (const contribution of contributions) {
    if (!contribution.id || ids.has(contribution.id)) {
      throw invalidContribution(`${kind} 包含空值或重复 ID`);
    }
    ids.add(contribution.id);
  }
}

function normalizeRoute(route: string): string {
  const normalized = route.replace(/\/+$/u, "");
  return normalized || "/";
}

function invalidDefinition(message: string): PluginPolicyError {
  return new PluginPolicyError("PLUGIN_DEFINITION_INVALID", message, "修复插件定义后重新加载");
}

function invalidContribution(message: string): PluginPolicyError {
  return new PluginPolicyError("PLUGIN_CONTRIBUTION_INVALID", message, "修复贡献声明后重新加载");
}
