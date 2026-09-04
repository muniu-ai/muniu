import type { PluginManifestV1 } from "@mn/contracts";
import { cloneJson, deepFreeze } from "./canonical.js";
import { PluginPolicyError } from "./errors.js";
import {
  assertDevelopmentSource,
  DEVELOPMENT_TRUST_WARNING,
  type DevelopmentPluginSource,
} from "./resources.js";
import {
  assertResolvedPluginDependencies,
  assertVerifiedPluginArtifact,
  type ResolvedPluginDependency,
  type VerifiedPluginArtifact,
} from "./registry.js";

export type InstalledPluginStatus =
  | "installed"
  | "active"
  | "draining"
  | "disabled"
  | "revoked"
  | "failed";

export interface PluginReleaseSnapshot {
  readonly manifest: PluginManifestV1;
  readonly registrySequence: number;
  readonly verifiedAt: string;
  readonly status: Exclude<InstalledPluginStatus, "draining" | "revoked" | "failed">;
  readonly projectionNamespace: string;
  readonly developmentMode: boolean;
  readonly developmentSource?: DevelopmentPluginSource;
}

export interface InstalledPluginRecord extends Omit<PluginReleaseSnapshot, "status"> {
  readonly status: InstalledPluginStatus;
  readonly eventsAfterSwitch: number;
  readonly previousRelease?: PluginReleaseSnapshot;
  readonly revokedReason?: string;
}

export interface PluginStateTransaction {
  read(pluginId: string): InstalledPluginRecord | undefined;
  write(record: InstalledPluginRecord): void;
}

export interface PluginStateStore {
  read(pluginId: string): InstalledPluginRecord | undefined;
  transaction<T>(operation: (transaction: PluginStateTransaction) => Promise<T> | T): Promise<T>;
  mutate<T>(operation: (transaction: PluginStateTransaction) => T): T;
  list(): readonly InstalledPluginRecord[];
}

export interface PluginAuditEvent {
  readonly pluginId: string;
  readonly action:
    | "installed"
    | "development_installed"
    | "activated"
    | "disabled"
    | "draining"
    | "upgraded"
    | "upgrade_failed"
    | "rolled_back"
    | "revoked"
    | "event_recorded";
  readonly message: string;
  readonly at: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export interface PluginExecutionControl {
  drain(pluginId: string): Promise<void>;
  interruptAtSafeBoundary(pluginId: string): Promise<void>;
}

export interface PreparedProjectionUpgrade {
  readonly namespace: string;
  activate(transaction: PluginStateTransaction): Promise<void> | void;
  discard(): Promise<void> | void;
}

export interface PluginProjectionManager {
  replayAndValidate(input: {
    readonly pluginId: string;
    readonly manifest: PluginManifestV1;
    readonly namespace: string;
  }): Promise<PreparedProjectionUpgrade>;
}

export interface PluginLifecycleDependencies {
  readonly store: PluginStateStore;
  readonly executionControl?: PluginExecutionControl;
  readonly projections?: PluginProjectionManager;
  readonly audit?: (event: PluginAuditEvent) => void;
  readonly now?: () => Date;
  readonly engineApiVersion?: string;
}

export interface DevelopmentPluginInstall extends DevelopmentPluginSource {
  readonly manifest: PluginManifestV1;
  readonly resolvedDependencies?: readonly ResolvedPluginDependency[];
}

const NOOP_EXECUTION_CONTROL: PluginExecutionControl = {
  async drain() {},
  async interruptAtSafeBoundary() {},
};

const NOOP_PROJECTIONS: PluginProjectionManager = {
  async replayAndValidate(input) {
    return {
      namespace: input.namespace,
      async activate() {},
      async discard() {},
    };
  },
};

export class InMemoryPluginStateStore implements PluginStateStore {
  readonly #records = new Map<string, InstalledPluginRecord>();
  #transactionTail: Promise<void> = Promise.resolve();

  read(pluginId: string): InstalledPluginRecord | undefined {
    return cloneRecord(this.#records.get(pluginId));
  }

  list(): readonly InstalledPluginRecord[] {
    return [...this.#records.values()]
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
      .map((record) => cloneRecord(record)!);
  }

  mutate<T>(operation: (transaction: PluginStateTransaction) => T): T {
    const snapshot = cloneMap(this.#records);
    const transaction = createTransaction(snapshot);
    const result = operation(transaction);
    this.#replace(snapshot);
    return result;
  }

  async transaction<T>(operation: (transaction: PluginStateTransaction) => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const predecessor = this.#transactionTail;
    this.#transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      const snapshot = cloneMap(this.#records);
      const result = await operation(createTransaction(snapshot));
      this.#replace(snapshot);
      return result;
    } finally {
      release();
    }
  }

  #replace(next: Map<string, InstalledPluginRecord>): void {
    this.#records.clear();
    for (const [id, record] of next) this.#records.set(id, cloneRecord(record)!);
  }
}

export class PluginLifecycleManager {
  readonly #store: PluginStateStore;
  readonly #executionControl: PluginExecutionControl;
  readonly #projections: PluginProjectionManager;
  readonly #audit: (event: PluginAuditEvent) => void;
  readonly #now: () => Date;
  readonly #engineApiVersion: string;

  constructor(dependencies: PluginLifecycleDependencies) {
    this.#store = dependencies.store;
    this.#executionControl = dependencies.executionControl ?? NOOP_EXECUTION_CONTROL;
    this.#projections = dependencies.projections ?? NOOP_PROJECTIONS;
    this.#audit = dependencies.audit ?? (() => undefined);
    this.#now = dependencies.now ?? (() => new Date());
    this.#engineApiVersion = dependencies.engineApiVersion ?? "0.2.0";
  }

  installVerified(
    artifact: VerifiedPluginArtifact,
    resolvedDependencies: readonly ResolvedPluginDependency[] = [],
  ): InstalledPluginRecord {
    assertVerifiedPluginArtifact(artifact);
    this.#assertEngineApi(artifact.manifest);
    assertResolvedPluginDependencies(artifact.manifest, resolvedDependencies);
    const pluginId = artifact.manifest.id;
    const record = this.#store.mutate((transaction) => {
      if (transaction.read(pluginId)) {
        throw policy("PLUGIN_ALREADY_INSTALLED", `插件 ${pluginId} 已安装`, "使用插件更新操作");
      }
      const installed: InstalledPluginRecord = {
        manifest: cloneJson(artifact.manifest),
        registrySequence: artifact.registrySequence,
        verifiedAt: artifact.verifiedAt,
        status: "installed",
        projectionNamespace: projectionNamespace(artifact.manifest),
        developmentMode: false,
        eventsAfterSwitch: 0,
      };
      transaction.write(installed);
      return installed;
    });
    this.#recordAudit(pluginId, "installed", `已安装插件 ${pluginId} ${artifact.manifest.version}`);
    return cloneRecord(record)!;
  }

  installDevelopment(input: DevelopmentPluginInstall): InstalledPluginRecord {
    assertDevelopmentSource(input);
    this.#assertEngineApi(input.manifest);
    assertResolvedPluginDependencies(input.manifest, input.resolvedDependencies ?? []);
    const pluginId = input.manifest.id;
    const record = this.#store.mutate((transaction) => {
      if (transaction.read(pluginId)) {
        throw policy("PLUGIN_ALREADY_INSTALLED", `插件 ${pluginId} 已安装`, "先停用现有插件");
      }
      const installed: InstalledPluginRecord = {
        manifest: cloneJson(input.manifest),
        registrySequence: 0,
        verifiedAt: this.#now().toISOString(),
        status: "installed",
        projectionNamespace: projectionNamespace(input.manifest),
        developmentMode: true,
        developmentSource: { localPath: input.localPath, hmrUrl: input.hmrUrl },
        eventsAfterSwitch: 0,
      };
      transaction.write(installed);
      return installed;
    });
    this.#recordAudit(
      pluginId,
      "development_installed",
      `${DEVELOPMENT_TRUST_WARNING}。已记录本地路径与 HMR 配置`,
      { localPath: input.localPath, hmrEnabled: input.hmrUrl !== undefined },
    );
    return cloneRecord(record)!;
  }

  async activate(pluginId: string): Promise<InstalledPluginRecord> {
    const record = await this.#store.transaction((transaction) => {
      const current = requireInstalled(transaction, pluginId);
      if (current.status === "revoked") {
        throw policy("PLUGIN_REVOKED", `插件 ${pluginId} 已撤销`, "安装未撤销版本");
      }
      if (current.status === "draining" || current.status === "failed") {
        throw policy("PLUGIN_NOT_ACTIVE", `插件 ${pluginId} 当前不可激活`, "等待升级完成或修复插件");
      }
      const next = { ...current, status: "active" as const };
      transaction.write(next);
      return next;
    });
    this.#recordAudit(pluginId, "activated", `已激活插件 ${pluginId}`);
    return record;
  }

  async disable(pluginId: string): Promise<InstalledPluginRecord> {
    const current = this.#store.read(pluginId);
    if (!current) throw notInstalled(pluginId);
    if (current.status === "active") await this.#executionControl.drain(pluginId);
    const record = await this.#store.transaction((transaction) => {
      const latest = requireInstalled(transaction, pluginId);
      assertSameRelease(latest, current);
      if (latest.status === "revoked") return latest;
      const next = { ...latest, status: "disabled" as const };
      transaction.write(next);
      return next;
    });
    this.#recordAudit(pluginId, "disabled", `已停用插件 ${pluginId}`);
    return record;
  }

  async upgradeVerified(
    artifact: VerifiedPluginArtifact,
    resolvedDependencies: readonly ResolvedPluginDependency[] = [],
  ): Promise<InstalledPluginRecord> {
    assertVerifiedPluginArtifact(artifact);
    this.#assertEngineApi(artifact.manifest);
    assertResolvedPluginDependencies(artifact.manifest, resolvedDependencies);
    const pluginId = artifact.manifest.id;
    const before = this.#store.read(pluginId);
    if (!before) throw notInstalled(pluginId);
    assertUpgrade(before, artifact);

    await this.#store.transaction((transaction) => {
      const current = requireInstalled(transaction, pluginId);
      assertSameRelease(current, before);
      transaction.write({ ...current, status: "draining" });
    });
    this.#recordAudit(pluginId, "draining", `插件 ${pluginId} 正在排空执行`);

    let prepared: PreparedProjectionUpgrade | undefined;
    try {
      await this.#executionControl.drain(pluginId);
      const namespace = projectionNamespace(artifact.manifest);
      prepared = await this.#projections.replayAndValidate({
        pluginId,
        manifest: artifact.manifest,
        namespace,
      });
      if (prepared.namespace !== namespace) {
        throw policy("PLUGIN_UPGRADE_INVALID", "投影准备返回了错误命名空间", "检查投影升级实现");
      }
      const upgraded = await this.#store.transaction(async (transaction) => {
        const draining = requireInstalled(transaction, pluginId);
        assertSameRelease(draining, before);
        if (draining.status !== "draining") {
          throw policy("PLUGIN_UPGRADE_INVALID", "插件升级状态已变化", "重新发起升级");
        }
        await prepared!.activate(transaction);
        const next: InstalledPluginRecord = {
          manifest: cloneJson(artifact.manifest),
          registrySequence: artifact.registrySequence,
          verifiedAt: artifact.verifiedAt,
          status: before.status === "active"
            ? "active"
            : before.status === "disabled"
              ? "disabled"
              : "installed",
          projectionNamespace: namespace,
          developmentMode: false,
          eventsAfterSwitch: 0,
          previousRelease: releaseSnapshot(before),
        };
        transaction.write(next);
        return next;
      });
      this.#recordAudit(pluginId, "upgraded", `插件 ${pluginId} 已升级到 ${artifact.manifest.version}`);
      return upgraded;
    } catch (error) {
      if (prepared) await Promise.resolve(prepared.discard()).catch(() => undefined);
      await this.#store.transaction((transaction) => {
        const current = transaction.read(pluginId);
        if (current?.status === "draining") transaction.write(before);
      });
      this.#recordAudit(pluginId, "upgrade_failed", `插件 ${pluginId} 升级失败，已保留原版本`);
      throw error;
    }
  }

  async rollbackLastUpgrade(pluginId: string): Promise<InstalledPluginRecord> {
    const current = this.#store.read(pluginId);
    if (!current) throw notInstalled(pluginId);
    if (!current.previousRelease) {
      throw policy("PLUGIN_UPGRADE_INVALID", `插件 ${pluginId} 没有可恢复版本`, "保留当前版本");
    }
    if (current.eventsAfterSwitch > 0) {
      throw policy(
        "AUTOMATIC_DOWNGRADE_UNSAFE",
        "插件切换后已产生新事件，不能自动降级",
        "保留当前版本并人工处理兼容问题",
      );
    }
    await this.#executionControl.drain(pluginId);
    const previous = current.previousRelease;
    const prepared = await this.#projections.replayAndValidate({
      pluginId,
      manifest: previous.manifest,
      namespace: previous.projectionNamespace,
    });
    if (prepared.namespace !== previous.projectionNamespace) {
      await Promise.resolve(prepared.discard()).catch(() => undefined);
      throw policy("PLUGIN_UPGRADE_INVALID", "恢复投影返回了错误命名空间", "检查投影恢复实现");
    }
    try {
      const rolledBack = await this.#store.transaction(async (transaction) => {
        const latest = requireInstalled(transaction, pluginId);
        assertSameRelease(latest, current);
        if (latest.eventsAfterSwitch > 0) {
          throw policy(
            "AUTOMATIC_DOWNGRADE_UNSAFE",
            "排空期间产生了新事件，不能自动降级",
            "保留当前版本并人工处理",
          );
        }
        await prepared.activate(transaction);
        const next: InstalledPluginRecord = {
          ...cloneJson(previous),
          eventsAfterSwitch: 0,
        };
        transaction.write(next);
        return next;
      });
      this.#recordAudit(pluginId, "rolled_back", `插件 ${pluginId} 已恢复到升级前版本`);
      return rolledBack;
    } catch (error) {
      await Promise.resolve(prepared.discard()).catch(() => undefined);
      throw error;
    }
  }

  recordPluginEvent(pluginId: string): InstalledPluginRecord {
    const record = this.#store.mutate((transaction) => {
      const current = requireInstalled(transaction, pluginId);
      if (current.status !== "active") {
        throw policy("PLUGIN_NOT_ACTIVE", `插件 ${pluginId} 未激活`, "激活插件后再写入事件");
      }
      const next = { ...current, eventsAfterSwitch: current.eventsAfterSwitch + 1 };
      transaction.write(next);
      return next;
    });
    this.#recordAudit(pluginId, "event_recorded", `插件 ${pluginId} 已产生新事件`, {
      eventsAfterSwitch: record.eventsAfterSwitch,
    });
    return record;
  }

  async revoke(pluginId: string, reason: string): Promise<InstalledPluginRecord> {
    const revoked = await this.#store.transaction((transaction) => {
      const current = requireInstalled(transaction, pluginId);
      const next = { ...current, status: "revoked" as const, revokedReason: reason };
      transaction.write(next);
      return next;
    });
    this.#recordAudit(pluginId, "revoked", `插件 ${pluginId} 已撤销：${reason}`);
    await this.#executionControl.interruptAtSafeBoundary(pluginId);
    return revoked;
  }

  assertCanStartExecution(pluginId: string): InstalledPluginRecord {
    const record = this.#store.read(pluginId);
    if (!record) throw notInstalled(pluginId);
    if (record.status !== "active") {
      throw policy("PLUGIN_NOT_ACTIVE", `插件 ${pluginId} 未处于活动状态`, "激活插件或处理撤销状态");
    }
    return record;
  }

  persistentWarnings(): readonly { pluginId: string; message: string }[] {
    return this.#store.list()
      .filter((record) => record.developmentMode)
      .map((record) => ({ pluginId: record.manifest.id, message: DEVELOPMENT_TRUST_WARNING }));
  }

  #recordAudit(
    pluginId: string,
    action: PluginAuditEvent["action"],
    message: string,
    details?: PluginAuditEvent["details"],
  ): void {
    this.#audit({ pluginId, action, message, at: this.#now().toISOString(), details });
  }

  #assertEngineApi(manifest: PluginManifestV1): void {
    if (manifest.engineApi !== this.#engineApiVersion) {
      throw policy(
        "PLUGIN_MANIFEST_INVALID",
        `插件需要 engineApi ${manifest.engineApi}，当前版本为 ${this.#engineApiVersion}`,
        "安装与当前 Agent OS 兼容的插件版本",
      );
    }
  }
}

function createTransaction(records: Map<string, InstalledPluginRecord>): PluginStateTransaction {
  return {
    read(pluginId) { return cloneRecord(records.get(pluginId)); },
    write(record) { records.set(record.manifest.id, cloneRecord(record)!); },
  };
}

function cloneMap(records: Map<string, InstalledPluginRecord>): Map<string, InstalledPluginRecord> {
  return new Map([...records].map(([id, record]) => [id, cloneRecord(record)!]));
}

function cloneRecord(record: InstalledPluginRecord | undefined): InstalledPluginRecord | undefined {
  return record ? deepFreeze(cloneJson(record)) : undefined;
}

function releaseSnapshot(record: InstalledPluginRecord): PluginReleaseSnapshot {
  return {
    manifest: cloneJson(record.manifest),
    registrySequence: record.registrySequence,
    verifiedAt: record.verifiedAt,
    status: record.status === "active" ? "active" : record.status === "disabled" ? "disabled" : "installed",
    projectionNamespace: record.projectionNamespace,
    developmentMode: record.developmentMode,
    developmentSource: record.developmentSource ? cloneJson(record.developmentSource) : undefined,
  };
}

function projectionNamespace(manifest: PluginManifestV1): string {
  const id = manifest.id.replace(/[^A-Za-z0-9_]/gu, "_");
  const version = manifest.version.replace(/[^A-Za-z0-9_]/gu, "_");
  return `${id}__${version}__${manifest.release.sequence}`;
}

function requireInstalled(transaction: PluginStateTransaction, pluginId: string): InstalledPluginRecord {
  const record = transaction.read(pluginId);
  if (!record) throw notInstalled(pluginId);
  return record;
}

function notInstalled(pluginId: string): PluginPolicyError {
  return policy("PLUGIN_NOT_INSTALLED", `插件 ${pluginId} 未安装`, "先安装插件");
}

function assertUpgrade(current: InstalledPluginRecord, artifact: VerifiedPluginArtifact): void {
  if (current.status === "revoked") {
    throw policy("PLUGIN_REVOKED", `插件 ${current.manifest.id} 已撤销`, "安装经过验证的新版本");
  }
  if (artifact.manifest.id !== current.manifest.id
    || artifact.manifest.release.sequence <= current.manifest.release.sequence
    || artifact.registrySequence < current.registrySequence) {
    throw policy("PLUGIN_UPGRADE_INVALID", "插件升级未提高发布序号或仓库序号回退", "选择更高发布序号");
  }
}

function assertSameRelease(left: InstalledPluginRecord, right: InstalledPluginRecord): void {
  if (left.manifest.packageSha256 !== right.manifest.packageSha256
    || left.manifest.release.sequence !== right.manifest.release.sequence) {
    throw policy("PLUGIN_UPGRADE_INVALID", "插件状态在操作期间发生变化", "重新读取状态后重试");
  }
}

function policy(code: ConstructorParameters<typeof PluginPolicyError>[0], message: string, action: string) {
  return new PluginPolicyError(code, message, action);
}
