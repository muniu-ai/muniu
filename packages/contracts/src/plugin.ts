import type { JsonObject } from "./json.js";
import type { PluginId, ToolEffectClass } from "./models.js";

export interface PluginEntrypointsV1 {
  readonly host?: string;
  readonly worker?: string;
  readonly ui?: string;
  readonly cli?: string;
}

export interface PluginContributionsV1 {
  readonly routes: readonly string[];
  readonly navigation: readonly string[];
  readonly widgets: readonly string[];
  readonly commands: readonly string[];
  readonly agents: readonly string[];
  readonly skills: readonly string[];
  readonly workflows: readonly string[];
  readonly tools: readonly string[];
  readonly memorySchemas: readonly string[];
  readonly healthCheck?: string;
}

export interface PluginPermissionV1 {
  readonly id: string;
  readonly effectClasses: readonly ToolEffectClass[];
  readonly description: string;
  readonly required: boolean;
}

export interface PluginProjectionV1 {
  readonly engine: "sqlite" | "postgresql";
  readonly namespace: string;
  readonly entry: string;
}

export interface PluginDependencyV1 {
  readonly id: PluginId;
  readonly version: string;
  readonly sha256: string;
}

export interface PluginManifestV1 {
  readonly schemaVersion: 1;
  readonly id: PluginId;
  readonly version: string;
  readonly engineApi: string;
  readonly displayName: string;
  readonly description: string;
  readonly entrypoints: PluginEntrypointsV1;
  readonly contributes: PluginContributionsV1;
  readonly permissions: readonly PluginPermissionV1[];
  readonly dataNamespace: string;
  readonly eventSchemas: Readonly<Record<string, JsonObject>>;
  readonly projections: readonly PluginProjectionV1[];
  readonly dependencies: readonly PluginDependencyV1[];
  readonly packageSha256: string;
  readonly signature: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly value: string;
  };
  readonly release: {
    readonly sequence: number;
    readonly publishedAt: string;
    readonly expiresAt: string;
    readonly source: string;
  };
  readonly license: string;
  readonly homepage?: string;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ENTRY = /^(?:\.\/)?[A-Za-z0-9_./-]+\.(?:js|mjs|css|json|sql)$/;

export function assertPluginManifestShape(manifest: PluginManifestV1): void {
  if (manifest.schemaVersion !== 1 || !manifest.id || !EXACT_VERSION.test(manifest.version)) {
    throw new Error("插件清单版本无效");
  }
  if (!SHA256.test(manifest.packageSha256)) {
    throw new Error("插件包摘要必须是 SHA-256");
  }
  for (const dependency of manifest.dependencies) {
    if (!EXACT_VERSION.test(dependency.version) || !SHA256.test(dependency.sha256)) {
      throw new Error(`插件依赖 ${dependency.id} 必须固定版本和摘要`);
    }
  }
  for (const entry of Object.values(manifest.entrypoints)) {
    if (entry && (!SAFE_ENTRY.test(entry) || entry.startsWith("/") || entry.includes(".."))) {
      throw new Error("插件入口必须是包内本地资源");
    }
  }
  if (manifest.signature.algorithm !== "Ed25519" || manifest.release.sequence < 1) {
    throw new Error("插件发布签名或序号无效");
  }
}
