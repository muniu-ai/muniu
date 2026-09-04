import { randomUUID } from "node:crypto";
import type {
  Execution,
  JsonObject,
  PluginInstallation,
  PluginManifestV1,
  PluginPurgeResult,
  Workspace,
} from "@mn/contracts";
import {
  KernelError,
  StreamVersionConflictError,
  sha256,
  type KernelStore,
  type KernelTransaction,
} from "@mn/kernel";
import {
  InMemoryPluginStateStore,
  PluginContributionHost,
  PluginLifecycleManager,
  PluginPolicyError,
  canonicalJson,
  cloneJson,
  sha256Hex,
  verifyPluginArtifact,
  verifyRegistryMetadata,
  type InstalledPluginRecord,
  type PluginDefinitionV1,
  type PluginExecutionControl,
  type PluginPackageMetadataV1,
  type RegistryMetadataV1,
  type ResolvedPluginDependency,
  type TrustedRegistryRoot,
} from "@mn/plugin-sdk";
import { encodePluginWorkspace } from "./plugin-workspace.js";

export const PLUGIN_INSTALLATION_PROJECTION = "plugin-installation";
export const PLUGIN_LIFECYCLE_PROJECTION = "plugin-lifecycle";
export const PLUGIN_LOCK_PROJECTION = "plugin-lock";
export const PLUGIN_REGISTRY_PROJECTION = "plugin-registry";
export const PLUGIN_TOMBSTONE_PROJECTION = "plugin-installation-tombstone";

const ENGINE_API_VERSION = "0.2.0";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export interface LocalSignedPluginRelease {
  readonly manifest: PluginManifestV1;
  readonly packageBytes: Uint8Array;
  readonly definition: PluginDefinitionV1;
  readonly packageMetadata?: PluginPackageMetadataV1;
}

export interface LocalSignedPluginRepositorySnapshot {
  readonly metadata: RegistryMetadataV1;
  readonly releases: readonly LocalSignedPluginRelease[];
}

export type LocalSignedPluginRepositorySource = () =>
  | LocalSignedPluginRepositorySnapshot
  | undefined
  | Promise<LocalSignedPluginRepositorySnapshot | undefined>;

/**
 * 组合根提供的本地制品目录。该目录不访问网络；运行定义已经随本地签名包加载。
 * 生产插件仍与 Host 进程权限等价，不是沙箱。
 */
export class LocalSignedPluginRepository {
  readonly #source: LocalSignedPluginRepositorySource;

  constructor(source?: LocalSignedPluginRepositorySnapshot | LocalSignedPluginRepositorySource) {
    if (typeof source === "function") {
      this.#source = source;
    } else {
      const snapshot = source ? cloneRepositorySnapshot(source) : undefined;
      this.#source = () => snapshot;
    }
  }

  async read(): Promise<LocalSignedPluginRepositorySnapshot | undefined> {
    const snapshot = await this.#source();
    if (!snapshot) return undefined;
    return cloneRepositorySnapshot(snapshot);
  }
}

export interface PluginLockEntryV1 {
  readonly pluginId: string;
  readonly version: string;
  readonly packageSha256: string;
  readonly releaseSequence: number;
}

export interface PluginLockV1 {
  readonly schemaVersion: 1;
  readonly registrySequence: number;
  readonly plugins: readonly PluginLockEntryV1[];
  readonly digest: string;
  readonly updatedAt: string;
}

interface PluginRegistryStateV1 {
  readonly sequence: number;
  readonly verifiedAt: string;
}

interface PluginInstallationTombstoneV1 {
  readonly pluginId: string;
  readonly streamVersion: number;
  readonly purgedAt: string;
}

export interface PluginInstallerPort {
  initialize?(): Promise<void>;
  list?(): Promise<readonly PluginInstallation[]>;
  isInstalled?(pluginId: string): boolean;
  install(input: JsonObject, context?: PluginInstallContext): Promise<PluginInstallation>;
  update?(pluginId: string, input: JsonObject, context?: PluginInstallContext): Promise<PluginInstallation>;
  activate?(pluginId: string): Promise<PluginInstallation>;
  disable?(pluginId: string, input: JsonObject, context?: PluginInstallContext): Promise<PluginInstallation>;
  purge?(pluginId: string, input: JsonObject, context?: PluginInstallContext): Promise<PluginPurgeResult>;
  assertCanStartExecution?(pluginId: string): void;
}

export interface PluginInstallContext {
  readonly idempotencyKey: string;
  readonly idempotencyScope: string;
}

export interface PreparedProductionProjectionUpgrade {
  readonly namespace: string;
  /** 与 installation、plugin lock 和升级事件在同一 Kernel 事务内切换。 */
  activate(transaction: KernelTransaction): void;
  discard(): Promise<void> | void;
}

export interface ProductionPluginProjectionManager {
  replayAndValidate(input: {
    readonly pluginId: string;
    readonly manifest: PluginManifestV1;
    readonly namespace: string;
  }): Promise<PreparedProductionProjectionUpgrade>;
  /** 仅删除可由事实事件重建的插件投影；该回调与安装态和 lock 在同一事务内执行。 */
  purge?(input: {
    readonly pluginId: string;
    readonly namespaces: readonly string[];
    readonly transaction: KernelTransaction;
  }): void;
}

export interface LocalProductionPluginInstallerOptions {
  readonly store: KernelStore;
  readonly repository: LocalSignedPluginRepository;
  readonly trustedRoots: readonly TrustedRegistryRoot[];
  readonly contributions: PluginContributionHost;
  readonly tenantId?: string;
  readonly actorId?: string;
  readonly now?: () => string;
  readonly executionControl?: PluginExecutionControl;
  readonly projections?: ProductionPluginProjectionManager;
}

export class LocalProductionPluginInstaller implements PluginInstallerPort {
  readonly #store: KernelStore;
  readonly #repository: LocalSignedPluginRepository;
  readonly #trustedRoots: readonly TrustedRegistryRoot[];
  readonly #contributions: PluginContributionHost;
  readonly #tenantId: string;
  readonly #actorId: string;
  readonly #now: () => string;
  readonly #executionControl: PluginExecutionControl;
  readonly #projections?: ProductionPluginProjectionManager;
  readonly #available = new Set<string>();
  readonly #active = new Set<string>();
  readonly #startingBlocked = new Set<string>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: LocalProductionPluginInstallerOptions) {
    this.#store = options.store;
    this.#repository = options.repository;
    this.#trustedRoots = [...options.trustedRoots];
    this.#contributions = options.contributions;
    this.#tenantId = options.tenantId ?? "local";
    this.#actorId = options.actorId ?? "local-owner";
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#executionControl = options.executionControl ?? {
      drain: (pluginId) => assertNoActiveExecutions(this.#store, this.#tenantId, pluginId),
      async interruptAtSafeBoundary() {},
    };
    this.#projections = options.projections;
  }

  async initialize(): Promise<void> {
    await this.#exclusive(async () => {
      const state = await this.#readState();
      if (state.records.length === 0) return;
      try {
        assertPersistedLock(state);
      } catch (error) {
        for (const record of state.records) {
          await this.#markLoadFailure(record, "failed", policyMessage(error));
        }
        return;
      }
      const snapshot = await this.#repository.read();
      if (!snapshot) {
        for (const record of state.records) {
          await this.#markLoadFailure(record, "failed", "本地插件制品不存在");
        }
        return;
      }
      let registry;
      try {
        registry = verifyRegistryMetadata(snapshot.metadata, this.#trustedRoots, {
          now: new Date(this.#now()),
          operation: "offline_start",
          minimumSequence: Math.max(
            state.registry?.sequence ?? 0,
            ...state.records.map((record) => record.registrySequence),
          ),
        });
      } catch (error) {
        for (const record of state.records) {
          await this.#markLoadFailure(record, "failed", policyMessage(error));
        }
        return;
      }
      for (const record of state.records) {
        if (record.status === "revoked" || record.status === "failed") continue;
        const release = findRelease(snapshot, record.manifest.id, record.manifest.version);
        try {
          if (!release
            || release.manifest.packageSha256 !== record.manifest.packageSha256
            || canonicalJson(release.manifest) !== canonicalJson(record.manifest)) {
            throw new PluginPolicyError(
              "PACKAGE_DIGEST_MISMATCH",
              `插件 ${record.manifest.id} 的本地制品与 lock 不一致`,
              "恢复 lock 中完全一致的插件制品",
            );
          }
          const artifact = verifyPluginArtifact({
            manifest: release.manifest,
            packageBytes: release.packageBytes,
            registry,
            now: new Date(this.#now()),
            operation: "offline_start",
            installedRelease: releaseIdentity(record),
            packageMetadata: release.packageMetadata,
          });
          this.#contributions.registerVerified(artifact, release.definition);
          this.#available.add(record.manifest.id);
          if (record.status === "active") this.#active.add(record.manifest.id);
        } catch (error) {
          const status = error instanceof PluginPolicyError
            && (error.code === "PLUGIN_RELEASE_REVOKED" || error.code === "RELEASE_KEY_REVOKED")
            ? "revoked" as const
            : "failed" as const;
          await this.#markLoadFailure(record, status, policyMessage(error));
        }
      }
    });
  }

  async list(): Promise<readonly PluginInstallation[]> {
    return this.#store.transact(this.#tenantId, (transaction) =>
      [...transaction.listProjections<PluginInstallation>(PLUGIN_INSTALLATION_PROJECTION)]
        .sort((left, right) => left.pluginId.localeCompare(right.pluginId)));
  }

  isInstalled(pluginId: string): boolean {
    return this.#available.has(pluginId) && !this.#startingBlocked.has(pluginId);
  }

  assertCanStartExecution(pluginId: string): void {
    if (this.#startingBlocked.has(pluginId)) {
      throw new PluginPolicyError(
        "PLUGIN_NOT_ACTIVE",
        `插件 ${pluginId} 正在排空执行`,
        "等待插件更新完成后重试",
      );
    }
    if (!this.#active.has(pluginId)) {
      throw new PluginPolicyError(
        "PLUGIN_NOT_ACTIVE",
        `插件 ${pluginId} 未激活`,
        "先在工作区启用插件",
      );
    }
  }

  async install(input: JsonObject, context?: PluginInstallContext): Promise<PluginInstallation> {
    const request = parseInstallRequest(input);
    return this.#exclusive(async () => {
      const snapshot = await this.#repository.read();
      if (!snapshot || this.#trustedRoots.length === 0) {
        throw new PluginPolicyError(
          "PLUGIN_REGISTRY_UNAVAILABLE",
          "本地签名插件仓库不可用",
          "配置受信根和本地签名制品后重试",
        );
      }
      const state = await this.#readState();
      const registry = verifyRegistryMetadata(snapshot.metadata, this.#trustedRoots, {
        now: new Date(this.#now()),
        operation: "install",
        minimumSequence: state.registry?.sequence,
      });
      const release = findRelease(snapshot, request.pluginId, request.version);
      if (!release) {
        throw new PluginPolicyError(
          "PLUGIN_RELEASE_NOT_FOUND",
          `本地仓库没有插件 ${request.pluginId} ${request.version}`,
          "刷新本地签名仓库或选择已有的精确版本",
        );
      }
      if (this.#contributions.listRegistered().some((item) => item.pluginId === request.pluginId)) {
        throw new PluginPolicyError(
          "PLUGIN_ALREADY_INSTALLED",
          `插件 ${request.pluginId} 已注册`,
          "查看现有安装或使用升级操作",
        );
      }
      const resolvedDependencies = resolveDependencies(release.manifest, state.records);
      const artifact = verifyPluginArtifact({
        manifest: release.manifest,
        packageBytes: release.packageBytes,
        registry,
        now: new Date(this.#now()),
        operation: "install",
        packageMetadata: release.packageMetadata,
      });
      preflightDefinition(artifact, release.definition);
      const lifecycleStore = new InMemoryPluginStateStore(state.records);
      const lifecycle = new PluginLifecycleManager({
        store: lifecycleStore,
        engineApiVersion: ENGINE_API_VERSION,
        now: () => new Date(this.#now()),
      });
      const record = lifecycle.installVerified(artifact, resolvedDependencies);
      const timestamp = this.#now();
      const tombstone = state.tombstones.find((item) => item.pluginId === request.pluginId);
      const installation = installationFromRecord(
        record,
        undefined,
        this.#tenantId,
        timestamp,
        tombstone?.streamVersion,
      );
      const records = [...state.records, record];
      const lock = createPluginLock(records, registry.metadata.sequence, timestamp);
      const persisted = await this.#store.transact(this.#tenantId, (transaction) => {
        const previous = context
          ? transaction.getIdempotency(context.idempotencyScope, context.idempotencyKey)
          : undefined;
        if (previous) {
          if (previous.requestDigest !== sha256(input)) {
            throw new KernelError(
              "IDEMPOTENCY_KEY_REUSED",
              "幂等键已用于不同的插件安装请求",
              "使用新的 Idempotency-Key",
            );
          }
          return { installation: previous.response as PluginInstallation, applied: false };
        }
        if (transaction.getProjection(PLUGIN_LIFECYCLE_PROJECTION, request.pluginId)) {
          throw new PluginPolicyError(
            "PLUGIN_ALREADY_INSTALLED",
            `插件 ${request.pluginId} 已安装`,
            "查看现有安装或使用升级操作",
          );
        }
        const currentTombstone = transaction.getProjection<PluginInstallationTombstoneV1>(
          PLUGIN_TOMBSTONE_PROJECTION,
          request.pluginId,
        );
        if ((currentTombstone?.streamVersion ?? 0) !== (tombstone?.streamVersion ?? 0)) {
          throw new PluginPolicyError(
            "PLUGIN_PURGE_INVALID",
            `插件 ${request.pluginId} 的清除游标已经变化`,
            "刷新插件列表后重试",
          );
        }
        transaction.deleteProjection(PLUGIN_TOMBSTONE_PROJECTION, request.pluginId);
        transaction.putProjection(PLUGIN_LIFECYCLE_PROJECTION, request.pluginId, record);
        transaction.putProjection(PLUGIN_INSTALLATION_PROJECTION, request.pluginId, installation);
        transaction.putProjection(PLUGIN_REGISTRY_PROJECTION, "current", {
          sequence: registry.metadata.sequence,
          verifiedAt: registry.verifiedAt,
        } satisfies PluginRegistryStateV1);
        transaction.putProjection(PLUGIN_LOCK_PROJECTION, "current", lock);
        transaction.appendEvent({
          tenantId: this.#tenantId,
          aggregateType: "pluginInstallation",
          aggregateId: request.pluginId,
          expectedStreamVersion: tombstone?.streamVersion ?? 0,
          type: "plugin.installed",
          actorId: this.#actorId,
          generation: 0,
          correlationId: randomUUID(),
          publicPayload: {
            pluginId: request.pluginId,
            version: request.version,
            packageSha256: release.manifest.packageSha256,
            lockDigest: lock.digest,
          },
        });
        if (context) {
          transaction.putIdempotency({
            tenantId: this.#tenantId,
            scope: context.idempotencyScope,
            key: context.idempotencyKey,
            requestDigest: sha256(input),
            response: installation,
            createdAt: timestamp,
          });
        }
        return { installation, applied: true };
      });
      if (!persisted.applied) return persisted.installation;
      this.#contributions.registerVerified(artifact, release.definition);
      this.#available.add(request.pluginId);
      return persisted.installation;
    });
  }

  async update(
    pluginId: string,
    input: JsonObject,
    context?: PluginInstallContext,
  ): Promise<PluginInstallation> {
    const request = parseUpdateRequest(pluginId, input);
    return this.#exclusive(async () => {
      const previousReceipt = context
        ? await this.#store.transact(this.#tenantId, (transaction) =>
          transaction.getIdempotency(context.idempotencyScope, context.idempotencyKey))
        : undefined;
      if (previousReceipt) {
        if (previousReceipt.requestDigest !== sha256(input)) {
          throw new KernelError(
            "IDEMPOTENCY_KEY_REUSED",
            "幂等键已用于不同的插件更新请求",
            "使用新的 Idempotency-Key",
          );
        }
        return previousReceipt.response as PluginInstallation;
      }

      const snapshot = await this.#repository.read();
      if (!snapshot || this.#trustedRoots.length === 0) {
        throw new PluginPolicyError(
          "PLUGIN_REGISTRY_UNAVAILABLE",
          "本地签名插件仓库不可用",
          "配置受信根和本地签名制品后重试",
        );
      }
      const state = await this.#readState();
      const before = state.records.find((record) => record.manifest.id === pluginId);
      const installationBefore = state.installations.find((item) => item.pluginId === pluginId);
      if (!before || !installationBefore) {
        throw new PluginPolicyError("PLUGIN_NOT_INSTALLED", `插件 ${pluginId} 未安装`, "先安装插件");
      }
      if (installationBefore.streamVersion !== request.expectedStreamVersion) {
        throw new StreamVersionConflictError(
          request.expectedStreamVersion,
          installationBefore.streamVersion,
        );
      }
      const registry = verifyRegistryMetadata(snapshot.metadata, this.#trustedRoots, {
        now: new Date(this.#now()),
        operation: "update",
        minimumSequence: Math.max(state.registry?.sequence ?? 0, before.registrySequence),
      });
      const release = findRelease(snapshot, pluginId, request.version);
      if (!release) {
        throw new PluginPolicyError(
          "PLUGIN_RELEASE_NOT_FOUND",
          `本地仓库没有插件 ${pluginId} ${request.version}`,
          "刷新本地签名仓库或选择已有的精确版本",
        );
      }
      const resolvedDependencies = resolveDependencies(release.manifest, state.records);
      const artifact = verifyPluginArtifact({
        manifest: release.manifest,
        packageBytes: release.packageBytes,
        registry,
        now: new Date(this.#now()),
        operation: "update",
        installedRelease: releaseIdentity(before),
        packageMetadata: release.packageMetadata,
      });
      preflightDefinition(artifact, release.definition);

      // 复用 SDK 生命周期规则生成新记录；真正的排空、重放和切换由下方生产端口完成。
      const lifecycleStore = new InMemoryPluginStateStore(state.records);
      const lifecycle = new PluginLifecycleManager({
        store: lifecycleStore,
        engineApiVersion: ENGINE_API_VERSION,
        now: () => new Date(this.#now()),
      });
      const planned = await lifecycle.upgradeVerified(artifact, resolvedDependencies);
      if (release.manifest.projections.length > 0 && !this.#projections) {
        throw new PluginPolicyError(
          "PLUGIN_UPGRADE_INVALID",
          `插件 ${pluginId} 声明了投影，但 Host 未配置投影重放器`,
          "配置对应存储引擎的投影重放器后重试",
        );
      }

      this.#startingBlocked.add(pluginId);
      let prepared: PreparedProductionProjectionUpgrade | undefined;
      let projectionCommitted = false;
      try {
        await this.#executionControl.drain(pluginId);
        prepared = this.#projections
          ? await this.#projections.replayAndValidate({
            pluginId,
            manifest: artifact.manifest,
            namespace: planned.projectionNamespace,
          })
          : {
            namespace: planned.projectionNamespace,
            activate() {},
            discard() {},
          };
        if (prepared.namespace !== planned.projectionNamespace) {
          throw new PluginPolicyError(
            "PLUGIN_UPGRADE_INVALID",
            "投影准备返回了错误命名空间",
            "检查投影升级实现",
          );
        }

        const timestamp = this.#now();
        const installation = installationFromRecord(
          planned,
          installationBefore,
          this.#tenantId,
          timestamp,
        );
        const records = state.records.map((record) =>
          record.manifest.id === pluginId ? planned : record);
        const lock = createPluginLock(records, registry.metadata.sequence, timestamp);
        const persisted = await this.#store.transact(this.#tenantId, (transaction) => {
          const previous = context
            ? transaction.getIdempotency(context.idempotencyScope, context.idempotencyKey)
            : undefined;
          if (previous) {
            if (previous.requestDigest !== sha256(input)) {
              throw new KernelError(
                "IDEMPOTENCY_KEY_REUSED",
                "幂等键已用于不同的插件更新请求",
                "使用新的 Idempotency-Key",
              );
            }
            return { installation: previous.response as PluginInstallation, applied: false };
          }
          const current = transaction.getProjection<PluginInstallation>(
            PLUGIN_INSTALLATION_PROJECTION,
            pluginId,
          );
          const currentRecord = transaction.getProjection<InstalledPluginRecord>(
            PLUGIN_LIFECYCLE_PROJECTION,
            pluginId,
          );
          if (!current || !currentRecord) {
            throw new PluginPolicyError("PLUGIN_NOT_INSTALLED", `插件 ${pluginId} 未安装`, "刷新插件列表");
          }
          if (current.streamVersion !== request.expectedStreamVersion) {
            throw new StreamVersionConflictError(request.expectedStreamVersion, current.streamVersion);
          }
          if (current.packageSha256 !== before.manifest.packageSha256
            || currentRecord.manifest.packageSha256 !== before.manifest.packageSha256) {
            throw new PluginPolicyError(
              "PLUGIN_UPGRADE_INVALID",
              `插件 ${pluginId} 状态在更新期间发生变化`,
              "刷新插件状态后重试",
            );
          }

          prepared!.activate(transaction);
          transaction.putProjection(PLUGIN_LIFECYCLE_PROJECTION, pluginId, planned);
          transaction.putProjection(PLUGIN_INSTALLATION_PROJECTION, pluginId, installation);
          transaction.putProjection(PLUGIN_REGISTRY_PROJECTION, "current", {
            sequence: registry.metadata.sequence,
            verifiedAt: registry.verifiedAt,
          } satisfies PluginRegistryStateV1);
          transaction.putProjection(PLUGIN_LOCK_PROJECTION, "current", lock);
          transaction.appendEvent({
            tenantId: this.#tenantId,
            aggregateType: "pluginInstallation",
            aggregateId: pluginId,
            expectedStreamVersion: current.streamVersion,
            type: "plugin.upgraded",
            actorId: this.#actorId,
            generation: 0,
            correlationId: randomUUID(),
            publicPayload: {
              pluginId,
              previousVersion: current.version,
              version: installation.version,
              packageSha256: installation.packageSha256,
              projectionNamespace: installation.projectionNamespace,
              lockDigest: lock.digest,
            },
          });
          if (context) {
            transaction.putIdempotency({
              tenantId: this.#tenantId,
              scope: context.idempotencyScope,
              key: context.idempotencyKey,
              requestDigest: sha256(input),
              response: installation,
              createdAt: timestamp,
            });
          }
          return { installation, applied: true };
        });
        if (!persisted.applied) {
          await Promise.resolve(prepared.discard()).catch(() => undefined);
          return persisted.installation;
        }
        projectionCommitted = true;
        try {
          if (this.#contributions.definition(pluginId)) {
            this.#contributions.replaceVerified(artifact, release.definition);
          } else {
            this.#contributions.registerVerified(artifact, release.definition);
          }
          this.#available.add(pluginId);
          if (planned.status === "active") this.#active.add(pluginId);
          else this.#active.delete(pluginId);
        } catch (error) {
          this.#available.delete(pluginId);
          this.#active.delete(pluginId);
          await this.#markLoadFailure(planned, "failed", policyMessage(error));
          throw error;
        }
        return persisted.installation;
      } catch (error) {
        if (prepared && !projectionCommitted) {
          await Promise.resolve(prepared.discard()).catch(() => undefined);
        }
        throw error;
      } finally {
        this.#startingBlocked.delete(pluginId);
      }
    });
  }

  async activate(pluginId: string): Promise<PluginInstallation> {
    return this.#exclusive(async () => {
      if (!this.#available.has(pluginId)) {
        throw new PluginPolicyError(
          "PLUGIN_NOT_INSTALLED",
          `插件 ${pluginId} 不可用`,
          "安装或修复插件后重试",
        );
      }
      const state = await this.#readState();
      const before = state.records.find((record) => record.manifest.id === pluginId);
      const installationBefore = state.installations.find((item) => item.pluginId === pluginId);
      if (!before || !installationBefore) {
        throw new PluginPolicyError("PLUGIN_NOT_INSTALLED", `插件 ${pluginId} 未安装`, "先安装插件");
      }
      const lifecycleStore = new InMemoryPluginStateStore(state.records);
      const lifecycle = new PluginLifecycleManager({
        store: lifecycleStore,
        engineApiVersion: ENGINE_API_VERSION,
        now: () => new Date(this.#now()),
      });
      const active = await lifecycle.activate(pluginId);
      if (installationBefore.status === "active") {
        this.#active.add(pluginId);
        return installationBefore;
      }
      const timestamp = this.#now();
      const installation = installationFromRecord(
        active,
        installationBefore,
        this.#tenantId,
        timestamp,
      );
      await this.#store.transact(this.#tenantId, (transaction) => {
        const current = transaction.getProjection<PluginInstallation>(PLUGIN_INSTALLATION_PROJECTION, pluginId);
        if (!current
          || current.streamVersion !== installationBefore.streamVersion
          || current.packageSha256 !== installationBefore.packageSha256) {
          throw new PluginPolicyError(
            "PLUGIN_UPGRADE_INVALID",
            `插件 ${pluginId} 状态在激活期间发生变化`,
            "刷新插件状态后重试",
          );
        }
        transaction.putProjection(PLUGIN_LIFECYCLE_PROJECTION, pluginId, active);
        transaction.putProjection(PLUGIN_INSTALLATION_PROJECTION, pluginId, installation);
        transaction.appendEvent({
          tenantId: this.#tenantId,
          aggregateType: "pluginInstallation",
          aggregateId: pluginId,
          expectedStreamVersion: current.streamVersion,
          type: "plugin.activated",
          actorId: this.#actorId,
          generation: 0,
          correlationId: randomUUID(),
          publicPayload: { pluginId, version: current.version },
        });
      });
      this.#active.add(pluginId);
      return installation;
    });
  }

  async disable(
    pluginId: string,
    input: JsonObject,
    context?: PluginInstallContext,
  ): Promise<PluginInstallation> {
    const request = parseVersionedPluginRequest(pluginId, input, "停用");
    return this.#exclusive(async () => {
      const previousReceipt = context
        ? await this.#store.transact(this.#tenantId, (transaction) =>
          transaction.getIdempotency(context.idempotencyScope, context.idempotencyKey))
        : undefined;
      if (previousReceipt) {
        if (previousReceipt.requestDigest !== sha256(input)) {
          throw new KernelError(
            "IDEMPOTENCY_KEY_REUSED",
            "幂等键已用于不同的插件停用请求",
            "使用新的 Idempotency-Key",
          );
        }
        return previousReceipt.response as PluginInstallation;
      }

      const state = await this.#readState();
      const before = state.records.find((record) => record.manifest.id === pluginId);
      const installationBefore = state.installations.find((item) => item.pluginId === pluginId);
      if (!before || !installationBefore) {
        throw new PluginPolicyError("PLUGIN_NOT_INSTALLED", `插件 ${pluginId} 未安装`, "刷新插件列表");
      }
      if (installationBefore.streamVersion !== request.expectedStreamVersion) {
        throw new StreamVersionConflictError(request.expectedStreamVersion, installationBefore.streamVersion);
      }
      if (installationBefore.status === "disabled") {
        await this.#store.transact(this.#tenantId, (transaction) => {
          if (context) {
            transaction.putIdempotency({
              tenantId: this.#tenantId,
              scope: context.idempotencyScope,
              key: context.idempotencyKey,
              requestDigest: sha256(input),
              response: installationBefore,
              createdAt: this.#now(),
            });
          }
        });
        this.#active.delete(pluginId);
        return installationBefore;
      }

      this.#startingBlocked.add(pluginId);
      const deactivatedScopes: string[] = [];
      try {
        await this.#executionControl.drain(pluginId);
        const lifecycleStore = new InMemoryPluginStateStore(state.records);
        const lifecycle = new PluginLifecycleManager({
          store: lifecycleStore,
          engineApiVersion: ENGINE_API_VERSION,
          now: () => new Date(this.#now()),
        });
        const disabledRecord = await lifecycle.disable(pluginId);
        for (const scope of this.#contributions.activeWorkspaceIds(pluginId)) {
          deactivatedScopes.push(scope);
          await this.#contributions.deactivate(scope, pluginId).catch(() => undefined);
        }

        const timestamp = this.#now();
        const disabledInstallation = installationFromRecord(
          disabledRecord,
          installationBefore,
          this.#tenantId,
          timestamp,
        );
        const records = state.records.map((record) =>
          record.manifest.id === pluginId ? disabledRecord : record);
        const registrySequence = state.registry?.sequence ?? state.lock?.registrySequence;
        if (registrySequence === undefined) {
          throw new PluginPolicyError(
            "PLUGIN_MANIFEST_INVALID",
            "插件仓库状态与 plugin lock 不完整",
            "从可信备份恢复插件状态",
          );
        }
        const lock = createPluginLock(records, registrySequence, timestamp);
        const persisted = await this.#store.transact(this.#tenantId, (transaction) => {
          const previous = context
            ? transaction.getIdempotency(context.idempotencyScope, context.idempotencyKey)
            : undefined;
          if (previous) {
            if (previous.requestDigest !== sha256(input)) {
              throw new KernelError(
                "IDEMPOTENCY_KEY_REUSED",
                "幂等键已用于不同的插件停用请求",
                "使用新的 Idempotency-Key",
              );
            }
            return { installation: previous.response as PluginInstallation, applied: false };
          }
          const current = transaction.getProjection<PluginInstallation>(
            PLUGIN_INSTALLATION_PROJECTION,
            pluginId,
          );
          const currentRecord = transaction.getProjection<InstalledPluginRecord>(
            PLUGIN_LIFECYCLE_PROJECTION,
            pluginId,
          );
          if (!current || !currentRecord) {
            throw new PluginPolicyError("PLUGIN_NOT_INSTALLED", `插件 ${pluginId} 未安装`, "刷新插件列表");
          }
          if (current.streamVersion !== request.expectedStreamVersion) {
            throw new StreamVersionConflictError(request.expectedStreamVersion, current.streamVersion);
          }
          if (current.packageSha256 !== installationBefore.packageSha256
            || currentRecord.manifest.packageSha256 !== before.manifest.packageSha256) {
            throw new PluginPolicyError(
              "PLUGIN_UPGRADE_INVALID",
              `插件 ${pluginId} 状态在停用期间发生变化`,
              "刷新插件状态后重试",
            );
          }
          assertNoActiveExecutionsInTransaction(transaction, pluginId, "PLUGIN_UPGRADE_INVALID");

          let deactivatedWorkspaceCount = 0;
          for (const workspace of transaction.listProjections<Workspace>("workspace")) {
            if (!workspace.activePluginIds.includes(pluginId)) continue;
            deactivatedWorkspaceCount += 1;
            const nextWorkspace: Workspace = {
              ...workspace,
              activePluginIds: workspace.activePluginIds.filter((id) => id !== pluginId),
              streamVersion: workspace.streamVersion + 1,
              updatedAt: timestamp,
            };
            transaction.putProjection("workspace", workspace.id, nextWorkspace);
            transaction.appendEvent({
              tenantId: this.#tenantId,
              aggregateType: "workspace",
              aggregateId: workspace.id,
              expectedStreamVersion: workspace.streamVersion,
              type: "workspace.plugin_deactivated",
              actorId: this.#actorId,
              generation: 0,
              correlationId: randomUUID(),
              publicPayload: { pluginId, reason: "installation_disabled" },
            });
          }
          transaction.putProjection(PLUGIN_LIFECYCLE_PROJECTION, pluginId, disabledRecord);
          transaction.putProjection(PLUGIN_INSTALLATION_PROJECTION, pluginId, disabledInstallation);
          transaction.putProjection(PLUGIN_LOCK_PROJECTION, "current", lock);
          transaction.appendEvent({
            tenantId: this.#tenantId,
            aggregateType: "pluginInstallation",
            aggregateId: pluginId,
            expectedStreamVersion: current.streamVersion,
            type: "plugin.disabled",
            actorId: this.#actorId,
            generation: 0,
            correlationId: randomUUID(),
            publicPayload: {
              pluginId,
              version: current.version,
              deactivatedWorkspaceCount,
              lockDigest: lock.digest,
            },
          });
          if (context) {
            transaction.putIdempotency({
              tenantId: this.#tenantId,
              scope: context.idempotencyScope,
              key: context.idempotencyKey,
              requestDigest: sha256(input),
              response: disabledInstallation,
              createdAt: timestamp,
            });
          }
          return { installation: disabledInstallation, applied: true };
        });
        this.#active.delete(pluginId);
        return persisted.installation;
      } catch (error) {
        this.#startingBlocked.delete(pluginId);
        for (const scope of deactivatedScopes) {
          await this.#contributions.activate(scope, pluginId).catch(() => undefined);
        }
        throw error;
      } finally {
        this.#startingBlocked.delete(pluginId);
      }
    });
  }

  async purge(
    pluginId: string,
    input: JsonObject,
    context?: PluginInstallContext,
  ): Promise<PluginPurgeResult> {
    const request = parseVersionedPluginRequest(pluginId, input, "清除");
    return this.#exclusive(async () => {
      const previousReceipt = context
        ? await this.#store.transact(this.#tenantId, (transaction) =>
          transaction.getIdempotency(context.idempotencyScope, context.idempotencyKey))
        : undefined;
      if (previousReceipt) {
        if (previousReceipt.requestDigest !== sha256(input)) {
          throw new KernelError(
            "IDEMPOTENCY_KEY_REUSED",
            "幂等键已用于不同的插件清除请求",
            "使用新的 Idempotency-Key",
          );
        }
        return previousReceipt.response as PluginPurgeResult;
      }

      const state = await this.#readState();
      const before = state.records.find((record) => record.manifest.id === pluginId);
      const installationBefore = state.installations.find((item) => item.pluginId === pluginId);
      if (!before || !installationBefore) {
        throw new PluginPolicyError("PLUGIN_NOT_INSTALLED", `插件 ${pluginId} 未安装`, "刷新插件列表");
      }
      if (installationBefore.streamVersion !== request.expectedStreamVersion) {
        throw new StreamVersionConflictError(request.expectedStreamVersion, installationBefore.streamVersion);
      }
      if (installationBefore.status === "active" || installationBefore.status === "draining") {
        throw new PluginPolicyError(
          "PLUGIN_PURGE_INVALID",
          `插件 ${pluginId} 仍处于活动状态`,
          "先停用插件后再清除",
        );
      }
      this.#startingBlocked.add(pluginId);
      try {
        await assertNoActiveExecutions(this.#store, this.#tenantId, pluginId, "PLUGIN_PURGE_INVALID");
        const activeWorkspaces = await this.#store.transact(this.#tenantId, (transaction) =>
          transaction.listProjections<Workspace>("workspace")
            .filter((workspace) => workspace.activePluginIds.includes(pluginId)));
        if (activeWorkspaces.length > 0 || this.#contributions.activeWorkspaceIds(pluginId).length > 0) {
          throw new PluginPolicyError(
            "PLUGIN_PURGE_INVALID",
            `插件 ${pluginId} 仍在活动工作区中启用`,
            "先停用插件后再清除",
          );
        }
        const namespaces = projectionNamespaces(before);
        if (namespaces.length > 0 && !this.#projections?.purge) {
          throw new PluginPolicyError(
            "PLUGIN_PURGE_INVALID",
            `插件 ${pluginId} 的可重建投影尚未配置清除器`,
            "配置投影清除器后重试",
          );
        }
        const timestamp = this.#now();
        const result: PluginPurgeResult = {
          pluginId,
          purged: true,
          streamVersion: installationBefore.streamVersion + 1,
          purgedAt: timestamp,
        };
        const records = state.records.filter((record) => record.manifest.id !== pluginId);
        const registrySequence = state.registry?.sequence ?? state.lock?.registrySequence;
        if (registrySequence === undefined) {
          throw new PluginPolicyError(
            "PLUGIN_MANIFEST_INVALID",
            "插件仓库状态与 plugin lock 不完整",
            "从可信备份恢复插件状态",
          );
        }
        const lock = createPluginLock(records, registrySequence, timestamp);
        const persisted = await this.#store.transact(this.#tenantId, (transaction) => {
          const previous = context
            ? transaction.getIdempotency(context.idempotencyScope, context.idempotencyKey)
            : undefined;
          if (previous) {
            if (previous.requestDigest !== sha256(input)) {
              throw new KernelError(
                "IDEMPOTENCY_KEY_REUSED",
                "幂等键已用于不同的插件清除请求",
                "使用新的 Idempotency-Key",
              );
            }
            return { result: previous.response as PluginPurgeResult, applied: false };
          }
          const current = transaction.getProjection<PluginInstallation>(
            PLUGIN_INSTALLATION_PROJECTION,
            pluginId,
          );
          if (!current) {
            throw new PluginPolicyError("PLUGIN_NOT_INSTALLED", `插件 ${pluginId} 未安装`, "刷新插件列表");
          }
          if (current.streamVersion !== request.expectedStreamVersion) {
            throw new StreamVersionConflictError(request.expectedStreamVersion, current.streamVersion);
          }
          if (transaction.listProjections<Workspace>("workspace")
            .some((workspace) => workspace.activePluginIds.includes(pluginId))) {
            throw new PluginPolicyError(
              "PLUGIN_PURGE_INVALID",
              `插件 ${pluginId} 仍在活动工作区中启用`,
              "先停用插件后再清除",
            );
          }
          assertNoActiveExecutionsInTransaction(transaction, pluginId, "PLUGIN_PURGE_INVALID");
          this.#projections?.purge?.({ pluginId, namespaces, transaction });
          transaction.deleteProjection(PLUGIN_INSTALLATION_PROJECTION, pluginId);
          transaction.deleteProjection(PLUGIN_LIFECYCLE_PROJECTION, pluginId);
          transaction.putProjection(PLUGIN_TOMBSTONE_PROJECTION, pluginId, {
            pluginId,
            streamVersion: result.streamVersion,
            purgedAt: timestamp,
          } satisfies PluginInstallationTombstoneV1);
          transaction.putProjection(PLUGIN_LOCK_PROJECTION, "current", lock);
          transaction.appendEvent({
            tenantId: this.#tenantId,
            aggregateType: "pluginInstallation",
            aggregateId: pluginId,
            expectedStreamVersion: current.streamVersion,
            type: "plugin.purged",
            actorId: this.#actorId,
            generation: 0,
            correlationId: randomUUID(),
            publicPayload: { pluginId, previousVersion: current.version, lockDigest: lock.digest },
          });
          if (context) {
            transaction.putIdempotency({
              tenantId: this.#tenantId,
              scope: context.idempotencyScope,
              key: context.idempotencyKey,
              requestDigest: sha256(input),
              response: result,
              createdAt: timestamp,
            });
          }
          return { result, applied: true };
        });
        this.#contributions.unregisterVerified(pluginId);
        this.#available.delete(pluginId);
        this.#active.delete(pluginId);
        return persisted.result;
      } finally {
        this.#startingBlocked.delete(pluginId);
      }
    });
  }

  async #readState(): Promise<{
    readonly records: readonly InstalledPluginRecord[];
    readonly installations: readonly PluginInstallation[];
    readonly registry: PluginRegistryStateV1 | undefined;
    readonly lock: PluginLockV1 | undefined;
    readonly tombstones: readonly PluginInstallationTombstoneV1[];
  }> {
    return this.#store.transact(this.#tenantId, (transaction) => ({
      records: transaction.listProjections<InstalledPluginRecord>(PLUGIN_LIFECYCLE_PROJECTION),
      installations: transaction.listProjections<PluginInstallation>(PLUGIN_INSTALLATION_PROJECTION),
      registry: transaction.getProjection<PluginRegistryStateV1>(PLUGIN_REGISTRY_PROJECTION, "current"),
      lock: transaction.getProjection<PluginLockV1>(PLUGIN_LOCK_PROJECTION, "current"),
      tombstones: transaction.listProjections<PluginInstallationTombstoneV1>(PLUGIN_TOMBSTONE_PROJECTION),
    }));
  }

  async #markLoadFailure(
    record: InstalledPluginRecord,
    status: "failed" | "revoked",
    reason: string,
  ): Promise<void> {
    if (record.status === status) return;
    this.#available.delete(record.manifest.id);
    this.#active.delete(record.manifest.id);
    await this.#store.transact(this.#tenantId, (transaction) => {
      const current = transaction.getProjection<InstalledPluginRecord>(
        PLUGIN_LIFECYCLE_PROJECTION,
        record.manifest.id,
      );
      const installation = transaction.getProjection<PluginInstallation>(
        PLUGIN_INSTALLATION_PROJECTION,
        record.manifest.id,
      );
      if (!current || !installation) return;
      const timestamp = this.#now();
      const nextRecord: InstalledPluginRecord = {
        ...current,
        status,
        ...(status === "revoked" ? { revokedReason: reason } : {}),
      };
      const nextInstallation: PluginInstallation = {
        ...installation,
        status,
        streamVersion: installation.streamVersion + 1,
        updatedAt: timestamp,
      };
      transaction.putProjection(PLUGIN_LIFECYCLE_PROJECTION, record.manifest.id, nextRecord);
      transaction.putProjection(PLUGIN_INSTALLATION_PROJECTION, record.manifest.id, nextInstallation);
      transaction.appendEvent({
        tenantId: this.#tenantId,
        aggregateType: "pluginInstallation",
        aggregateId: record.manifest.id,
        expectedStreamVersion: installation.streamVersion,
        type: status === "revoked" ? "plugin.revoked" : "plugin.load_failed",
        actorId: this.#actorId,
        generation: 0,
        correlationId: randomUUID(),
        publicPayload: { pluginId: record.manifest.id, reason },
      });
    });
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function parseInstallRequest(input: JsonObject): { readonly pluginId: string; readonly version: string } {
  const allowed = new Set(["pluginId", "version"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw invalidRequest("安装请求只能指定插件 ID 和精确版本");
  }
  if (typeof input.pluginId !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/u.test(input.pluginId)) {
    throw invalidRequest("pluginId 格式无效");
  }
  if (typeof input.version !== "string" || !EXACT_VERSION.test(input.version)) {
    throw invalidRequest("version 必须是精确语义版本，不能使用范围或浮动标签");
  }
  return { pluginId: input.pluginId, version: input.version };
}

function parseUpdateRequest(
  pluginId: string,
  input: JsonObject,
): { readonly version: string; readonly expectedStreamVersion: number } {
  const allowed = new Set(["version", "expectedStreamVersion"]);
  if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(pluginId)
    || Object.keys(input).some((key) => !allowed.has(key))) {
    throw invalidRequest("插件更新路径或请求字段无效");
  }
  if (typeof input.version !== "string" || !EXACT_VERSION.test(input.version)) {
    throw invalidRequest("version 必须是精确语义版本，不能使用范围或浮动标签");
  }
  if (!Number.isSafeInteger(input.expectedStreamVersion)
    || Number(input.expectedStreamVersion) < 0) {
    throw invalidRequest("expectedStreamVersion 必须是非负整数");
  }
  return {
    version: input.version,
    expectedStreamVersion: Number(input.expectedStreamVersion),
  };
}

function parseVersionedPluginRequest(
  pluginId: string,
  input: JsonObject,
  operation: "停用" | "清除",
): { readonly expectedStreamVersion: number } {
  if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(pluginId)
    || Object.keys(input).some((key) => key !== "expectedStreamVersion")) {
    throw invalidRequest(`插件${operation}路径或请求字段无效`);
  }
  if (!Number.isSafeInteger(input.expectedStreamVersion)
    || Number(input.expectedStreamVersion) < 0) {
    throw invalidRequest("expectedStreamVersion 必须是非负整数");
  }
  return { expectedStreamVersion: Number(input.expectedStreamVersion) };
}

function cloneRepositorySnapshot(
  snapshot: LocalSignedPluginRepositorySnapshot,
): LocalSignedPluginRepositorySnapshot {
  return {
    metadata: cloneJson(snapshot.metadata),
    releases: snapshot.releases.map((release) => ({
      ...release,
      manifest: cloneJson(release.manifest),
      packageBytes: Uint8Array.from(release.packageBytes),
      packageMetadata: release.packageMetadata ? cloneJson(release.packageMetadata) : undefined,
    })),
  };
}

function invalidRequest(message: string): KernelError {
  return new KernelError("INVALID_BODY", message, "修正插件安装请求");
}

function findRelease(
  snapshot: LocalSignedPluginRepositorySnapshot,
  pluginId: string,
  version: string,
): LocalSignedPluginRelease | undefined {
  const matches = snapshot.releases.filter((release) =>
    release.manifest.id === pluginId && release.manifest.version === version);
  if (matches.length > 1) {
    throw new PluginPolicyError(
      "PLUGIN_MANIFEST_INVALID",
      `本地仓库重复声明插件 ${pluginId} ${version}`,
      "删除重复发布记录",
    );
  }
  return matches[0];
}

function resolveDependencies(
  manifest: PluginManifestV1,
  records: readonly InstalledPluginRecord[],
): readonly ResolvedPluginDependency[] {
  return manifest.dependencies.map((dependency) => {
    const record = records.find((candidate) => candidate.manifest.id === dependency.id);
    if (!record || record.status === "failed" || record.status === "revoked") {
      return { id: dependency.id, version: "", packageSha256: "" };
    }
    return {
      id: record.manifest.id,
      version: record.manifest.version,
      packageSha256: record.manifest.packageSha256,
    };
  });
}

function preflightDefinition(
  artifact: ReturnType<typeof verifyPluginArtifact>,
  definition: PluginDefinitionV1,
): void {
  const host = new PluginContributionHost({ isAvailable: () => true });
  host.registerVerified(artifact, definition);
}

function releaseIdentity(record: InstalledPluginRecord) {
  return {
    sequence: record.manifest.release.sequence,
    version: record.manifest.version,
    packageSha256: record.manifest.packageSha256,
  };
}

function installationFromRecord(
  record: InstalledPluginRecord,
  previous: PluginInstallation | undefined,
  tenantId: string,
  timestamp: string,
  previousStreamVersion = previous?.streamVersion ?? 0,
): PluginInstallation {
  return {
    id: record.manifest.id,
    tenantId,
    streamVersion: previousStreamVersion + 1,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
    pluginId: record.manifest.id,
    version: record.manifest.version,
    packageSha256: record.manifest.packageSha256,
    releaseSequence: record.manifest.release.sequence,
    status: record.status,
    projectionNamespace: record.projectionNamespace,
    developmentMode: false,
  };
}

function createPluginLock(
  records: readonly InstalledPluginRecord[],
  registrySequence: number,
  updatedAt: string,
): PluginLockV1 {
  const plugins = records
    .map((record): PluginLockEntryV1 => ({
      pluginId: record.manifest.id,
      version: record.manifest.version,
      packageSha256: record.manifest.packageSha256,
      releaseSequence: record.manifest.release.sequence,
    }))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  const body = { schemaVersion: 1 as const, registrySequence, plugins };
  return {
    ...body,
    digest: sha256Hex(Buffer.from(canonicalJson(body), "utf8")),
    updatedAt,
  };
}

function policyMessage(error: unknown): string {
  return error instanceof PluginPolicyError ? error.message : "插件加载失败";
}

async function assertNoActiveExecutions(
  store: KernelStore,
  tenantId: string,
  pluginId: string,
  code: "PLUGIN_UPGRADE_INVALID" | "PLUGIN_PURGE_INVALID" = "PLUGIN_UPGRADE_INVALID",
): Promise<void> {
  const activeExecutionIds = await store.transact(tenantId, (transaction) =>
    activeExecutionIdsInTransaction(transaction, pluginId));
  if (activeExecutionIds.length > 0) {
    throw new PluginPolicyError(
      code,
      `插件 ${pluginId} 仍有 ${activeExecutionIds.length} 个未终结执行`,
      "等待执行终结或在安全边界中断后重试",
    );
  }
}

function assertNoActiveExecutionsInTransaction(
  transaction: KernelTransaction,
  pluginId: string,
  code: "PLUGIN_UPGRADE_INVALID" | "PLUGIN_PURGE_INVALID",
): void {
  const activeExecutionIds = activeExecutionIdsInTransaction(transaction, pluginId);
  if (activeExecutionIds.length > 0) {
    throw new PluginPolicyError(
      code,
      `插件 ${pluginId} 仍有 ${activeExecutionIds.length} 个未终结执行`,
      "等待执行终结或在安全边界中断后重试",
    );
  }
}

function activeExecutionIdsInTransaction(
  transaction: KernelTransaction,
  pluginId: string,
): readonly string[] {
  return transaction.listProjections<Execution>("execution")
    .filter((execution) => execution.pluginId === pluginId)
    .filter((execution) => !["completed", "failed", "cancelled"].includes(execution.status))
    .map((execution) => execution.id);
}

function projectionNamespaces(record: InstalledPluginRecord): readonly string[] {
  const namespaces = new Set<string>();
  let current: PluginReleaseSnapshotLike | undefined = record;
  while (current) {
    if (current.manifest.projections.length > 0) namespaces.add(current.projectionNamespace);
    current = current.previousRelease;
  }
  return [...namespaces].sort();
}

interface PluginReleaseSnapshotLike {
  readonly manifest: PluginManifestV1;
  readonly projectionNamespace: string;
  readonly previousRelease?: PluginReleaseSnapshotLike;
}

function assertPersistedLock(state: {
  readonly records: readonly InstalledPluginRecord[];
  readonly installations: readonly PluginInstallation[];
  readonly registry: PluginRegistryStateV1 | undefined;
  readonly lock: PluginLockV1 | undefined;
}): void {
  const lock = state.lock;
  const registry = state.registry;
  const expected = lock
    ? createPluginLock(state.records, lock.registrySequence, lock.updatedAt)
    : undefined;
  const installations = new Map(state.installations.map((installation) => [installation.pluginId, installation]));
  const recordsMatchInstallations = state.records.length === state.installations.length
    && state.records.every((record) => {
      const installation = installations.get(record.manifest.id);
      return installation
        && installation.version === record.manifest.version
        && installation.packageSha256 === record.manifest.packageSha256
        && installation.releaseSequence === record.manifest.release.sequence;
    });
  if (!lock
    || !registry
    || lock.registrySequence !== registry.sequence
    || expected?.digest !== lock.digest
    || canonicalJson(expected?.plugins) !== canonicalJson(lock.plugins)
    || !recordsMatchInstallations) {
    throw new PluginPolicyError(
      "PLUGIN_MANIFEST_INVALID",
      "插件 installation、仓库序号与 plugin lock 不一致",
      "从可信备份恢复 plugin lock 和安装记录",
    );
  }
}

export type { TrustedRegistryRoot };
