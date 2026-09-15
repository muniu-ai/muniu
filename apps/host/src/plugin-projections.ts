// SPDX-License-Identifier: Apache-2.0
import type { KernelEventV1, PluginManifestV1 } from "@mn/contracts";
import type { KernelStore, KernelTransaction } from "@mn/kernel";
import { PluginPolicyError, assertPluginEventSchema, assertVerifiedPluginArtifact, canonicalJson, openVerifiedPluginPackage, parseProjectionProgram, reducePluginProjection,
  type PluginDomainEventV1, type PluginProjectionProgramV1, type PluginProjectionRecordV1,
  type VerifiedPluginArtifact } from "@mn/plugin-sdk";
import type { PreparedProductionProjectionUpgrade, ProductionPluginProjectionManager } from "./plugin-installation.js";

export const PLUGIN_DATA_HEAD_NAMESPACE = "plugin-data-head";
export const PLUGIN_PROJECTION_LAYOUT_NAMESPACE = "plugin-projection-layout";

export interface PluginDataHead {
  readonly streamVersion: number;
  readonly position: number;
}

interface ProjectionLayout {
  readonly pluginId: string;
  readonly versions: readonly { readonly base: string; readonly namespaces: readonly string[] }[];
}

export function pluginProjectionKey(workspaceId: string, resourceId: string): string {
  return JSON.stringify([workspaceId, resourceId]);
}

export function pluginProjectionNamespace(pluginId: string, base: string, view: string): string {
  if (!/^[A-Za-z0-9_]+$/u.test(base) || !/^[a-z][a-z0-9_]{0,62}$/u.test(view)) throw new Error("插件投影命名空间无效");
  return `p_${Buffer.from(pluginId).toString("hex")}__${base}__${view}`;
}

export class KernelPluginProjectionManager implements ProductionPluginProjectionManager {
  readonly #definitions = new Map<string, ReadonlyMap<string, PluginProjectionProgramV1>>();

  constructor(readonly options: {
    readonly store: KernelStore;
    readonly tenantId: string;
    readonly engine: "sqlite" | "postgresql";
    readonly readEvent: (event: KernelEventV1) => Promise<PluginDomainEventV1>;
    readonly replayLimits?: { readonly maxEvents?: number; readonly maxBytes?: number; readonly maxDurationMs?: number };
  }) {}

  async loadDefinition(input: { readonly artifact: VerifiedPluginArtifact; readonly packageBytes: Uint8Array }): Promise<void> {
    assertVerifiedPluginArtifact(input.artifact);
    const manifest = input.artifact.manifest;
    for (const schema of Object.values(manifest.eventSchemas)) assertPluginEventSchema(schema);
    const programs = new Map<string, PluginProjectionProgramV1>();
    if (manifest.projections.length) {
      const archive = openVerifiedPluginPackage(input);
      const variants = new Map<string, Map<string, PluginProjectionProgramV1>>();
      for (const projection of manifest.projections) {
        if (!projection.entry.endsWith(".json")) throw new Error("生产投影必须使用包内声明式 JSON 定义");
        const program = parseProjectionProgram(archive.read(projection.entry));
        if (program.rules.some(rule => !Object.hasOwn(manifest.eventSchemas, rule.eventType))) throw new Error("投影引用了未声明的事件类型");
        const engines = variants.get(projection.namespace) ?? new Map();
        if (engines.has(projection.engine)) throw new Error("插件投影引擎定义重复");
        engines.set(projection.engine, program);
        variants.set(projection.namespace, engines);
      }
      for (const [namespace, engines] of variants) {
        if (!engines.has("sqlite") || !engines.has("postgresql")
          || canonicalJson(engines.get("sqlite")) !== canonicalJson(engines.get("postgresql"))) {
          throw new Error("SQLite 与 PostgreSQL 必须提供语义一致的投影定义");
        }
        programs.set(namespace, engines.get(this.options.engine)!);
      }
    }
    this.#definitions.set(manifest.packageSha256, programs);
  }

  programs(manifest: PluginManifestV1): ReadonlyMap<string, PluginProjectionProgramV1> {
    const programs = this.#definitions.get(manifest.packageSha256);
    if (!programs) throw new Error("插件投影定义尚未验签加载");
    return programs;
  }

  async replayAndValidate(input: { readonly pluginId: string; readonly manifest: PluginManifestV1; readonly namespace: string;
    readonly artifact?: VerifiedPluginArtifact; readonly packageBytes?: Uint8Array }): Promise<PreparedProductionProjectionUpgrade> {
    try { return await this.#prepare(input); }
    catch {
      throw new PluginPolicyError("PLUGIN_UPGRADE_INVALID", "插件投影重放或校验失败，原版本保持不变", "检查签名包的投影定义与历史事件结构后重试");
    }
  }

  async #prepare(input: { readonly pluginId: string; readonly manifest: PluginManifestV1; readonly namespace: string;
    readonly artifact?: VerifiedPluginArtifact; readonly packageBytes?: Uint8Array }): Promise<PreparedProductionProjectionUpgrade> {
    const limits = { maxEvents: 1_000_000, maxBytes: 128 * 1024 * 1024, maxDurationMs: 30_000, ...this.options.replayLimits };
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error("无效的投影重放预算");
    const startedAt = performance.now();
    let eventCount = 0;
    let byteCount = 0;
    const checkBudget = () => {
      if (eventCount > limits.maxEvents || byteCount > limits.maxBytes || performance.now() - startedAt > limits.maxDurationMs) {
        throw new Error("投影重放超过资源预算");
      }
    };
    if (!input.artifact || !input.packageBytes || canonicalJson(input.manifest) !== canonicalJson(input.artifact.manifest)
      || input.pluginId !== input.manifest.id) throw new Error("插件投影重放必须绑定已验签制品");
    await this.loadDefinition({ artifact: input.artifact, packageBytes: input.packageBytes });
    const programs = this.programs(input.manifest);
    const { store, tenantId } = this.options;
    if (!store.readEventHistory) throw new Error("存储未提供独立于 SSE 保留期的事实重放接口");
    const before = await store.transact(tenantId, tx => tx.getProjection<PluginDataHead>(PLUGIN_DATA_HEAD_NAMESPACE, input.pluginId));
    const projections = new Map([...programs.keys()].map(namespace => [namespace, new Map<string, PluginProjectionRecordV1>()]));
    const versions = new Map<string, number>();
    let cursor = 0;
    let lastSourcePosition = 0;
    for (;;) {
      checkBudget();
      const page = await store.readEventHistory(tenantId, cursor, 1000);
      for (const event of page.events) {
        eventCount++;
        checkBudget();
        if (event.aggregateType !== `plugin:${input.pluginId}`) continue;
        if (!Object.hasOwn(input.manifest.eventSchemas, event.type)) throw new Error("历史事件类型不在已验签清单中");
        const decoded = await this.options.readEvent(event);
        byteCount += Buffer.byteLength(canonicalJson(decoded), "utf8");
        checkBudget();
        if (decoded.tenantId !== tenantId || decoded.id !== event.id || decoded.position !== event.position
          || decoded.streamVersion !== event.streamVersion || decoded.type !== event.type
          || decoded.workspaceId !== event.publicPayload.workspaceId || decoded.resourceId !== event.publicPayload.resourceId) {
          throw new Error("插件事实解密结果与事件身份不一致");
        }
        const key = pluginProjectionKey(decoded.workspaceId, decoded.resourceId);
        if (decoded.streamVersion !== (versions.get(key) ?? 0) + 1) throw new Error("插件事实事件流存在缺口");
        versions.set(key, decoded.streamVersion);
        for (const [namespace, program] of programs) {
          const rows = projections.get(namespace)!;
          const next = reducePluginProjection(program, rows.get(key), decoded);
          if (next) byteCount += Buffer.byteLength(canonicalJson(next), "utf8");
          checkBudget();
          if (next) rows.set(key, next); else rows.delete(key);
        }
        lastSourcePosition = event.position;
      }
      if (!page.events.length) break;
      if (page.nextPosition <= cursor) throw new Error("事实重放游标未前进");
      cursor = page.nextPosition;
      if (page.events.length < 1000) break;
    }
    checkBudget();
    if ((before?.position ?? 0) !== lastSourcePosition) throw new Error("插件事实与写入水位不一致");
    let discarded = false;
    return {
      namespace: input.namespace,
      activate(transaction) {
        if (discarded) throw new Error("投影重放结果已丢弃");
        const current = transaction.getProjection<PluginDataHead>(PLUGIN_DATA_HEAD_NAMESPACE, input.pluginId);
        if (canonicalJson(current ?? null) !== canonicalJson(before ?? null)) throw new Error("插件事实在重放后发生变化");
        if (!programs.size) return;
        const namespaces: string[] = [];
        for (const [view, rows] of projections) {
          const namespace = pluginProjectionNamespace(input.pluginId, input.namespace, view);
          if (transaction.listProjections(namespace).length) throw new Error("新投影命名空间并非空白");
          for (const [key, row] of rows) transaction.putProjection(namespace, key, row);
          namespaces.push(namespace);
        }
        const layout = transaction.getProjection<ProjectionLayout>(PLUGIN_PROJECTION_LAYOUT_NAMESPACE, input.pluginId);
        if (layout?.versions.some(version => version.base === input.namespace)) throw new Error("投影版本已切换，不能重复激活");
        transaction.putProjection(PLUGIN_PROJECTION_LAYOUT_NAMESPACE, input.pluginId, { pluginId: input.pluginId,
          versions: [...layout?.versions ?? [], { base: input.namespace, namespaces }] } satisfies ProjectionLayout);
      },
      discard() { discarded = true; projections.clear(); },
    };
  }

  purge(input: { readonly pluginId: string; readonly namespaces: readonly string[]; readonly transaction: KernelTransaction }): void {
    const layout = input.transaction.getProjection<ProjectionLayout>(PLUGIN_PROJECTION_LAYOUT_NAMESPACE, input.pluginId);
    if (!layout) return;
    for (const version of layout.versions) {
      for (const namespace of version.namespaces) {
        const prefix = `p_${Buffer.from(input.pluginId).toString("hex")}__${version.base}__`;
        if (layout.pluginId !== input.pluginId || !namespace.startsWith(prefix)
          || pluginProjectionNamespace(input.pluginId, version.base, namespace.slice(prefix.length)) !== namespace) {
          throw new Error("插件投影记录超出清除范围");
        }
        for (const row of input.transaction.listProjections<PluginProjectionRecordV1>(namespace)) {
          input.transaction.deleteProjection(namespace, pluginProjectionKey(row.workspaceId, row.id));
        }
      }
    }
    input.transaction.deleteProjection(PLUGIN_PROJECTION_LAYOUT_NAMESPACE, input.pluginId);
  }
}
