import { randomUUID } from "node:crypto";
import type {
  JsonObject,
  PluginInstallation,
  PluginManifestV1,
} from "@mn/contracts";
import { KernelError, sha256, type KernelStore } from "@mn/kernel";
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
  type PluginPackageMetadataV1,
  type RegistryMetadataV1,
  type ResolvedPluginDependency,
  type TrustedRegistryRoot,
} from "@mn/plugin-sdk";

export const PLUGIN_INSTALLATION_PROJECTION = "plugin-installation";
export const PLUGIN_LIFECYCLE_PROJECTION = "plugin-lifecycle";
export const PLUGIN_LOCK_PROJECTION = "plugin-lock";
export const PLUGIN_REGISTRY_PROJECTION = "plugin-registry";

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

export interface PluginInstallerPort {
  initialize?(): Promise<void>;
  list?(): Promise<readonly PluginInstallation[]>;
  isInstalled?(pluginId: string): boolean;
  install(input: JsonObject, context?: PluginInstallContext): Promise<PluginInstallation>;
  activate?(pluginId: string): Promise<PluginInstallation>;
}

export interface PluginInstallContext {
  readonly idempotencyKey: string;
  readonly idempotencyScope: string;
}

export interface LocalProductionPluginInstallerOptions {
  readonly store: KernelStore;
  readonly repository: LocalSignedPluginRepository;
  readonly trustedRoots: readonly TrustedRegistryRoot[];
  readonly contributions: PluginContributionHost;
  readonly tenantId?: string;
  readonly actorId?: string;
  readonly now?: () => string;
}

export class LocalProductionPluginInstaller implements PluginInstallerPort {
  readonly #store: KernelStore;
  readonly #repository: LocalSignedPluginRepository;
  readonly #trustedRoots: readonly TrustedRegistryRoot[];
  readonly #contributions: PluginContributionHost;
  readonly #tenantId: string;
  readonly #actorId: string;
  readonly #now: () => string;
  readonly #available = new Set<string>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: LocalProductionPluginInstallerOptions) {
    this.#store = options.store;
    this.#repository = options.repository;
    this.#trustedRoots = [...options.trustedRoots];
    this.#contributions = options.contributions;
    this.#tenantId = options.tenantId ?? "local";
    this.#actorId = options.actorId ?? "local-owner";
    this.#now = options.now ?? (() => new Date().toISOString());
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
    return this.#available.has(pluginId);
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
      const installation = installationFromRecord(record, undefined, this.#tenantId, timestamp);
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
          expectedStreamVersion: 0,
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
      if (installationBefore.status === "active") return installationBefore;
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
      return installation;
    });
  }

  async #readState(): Promise<{
    readonly records: readonly InstalledPluginRecord[];
    readonly installations: readonly PluginInstallation[];
    readonly registry: PluginRegistryStateV1 | undefined;
    readonly lock: PluginLockV1 | undefined;
  }> {
    return this.#store.transact(this.#tenantId, (transaction) => ({
      records: transaction.listProjections<InstalledPluginRecord>(PLUGIN_LIFECYCLE_PROJECTION),
      installations: transaction.listProjections<PluginInstallation>(PLUGIN_INSTALLATION_PROJECTION),
      registry: transaction.getProjection<PluginRegistryStateV1>(PLUGIN_REGISTRY_PROJECTION, "current"),
      lock: transaction.getProjection<PluginLockV1>(PLUGIN_LOCK_PROJECTION, "current"),
    }));
  }

  async #markLoadFailure(
    record: InstalledPluginRecord,
    status: "failed" | "revoked",
    reason: string,
  ): Promise<void> {
    if (record.status === status) return;
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
): PluginInstallation {
  return {
    id: record.manifest.id,
    tenantId,
    streamVersion: (previous?.streamVersion ?? 0) + 1,
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
