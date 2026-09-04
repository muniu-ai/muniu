import { createPublicKey, type KeyLike } from "node:crypto";
import type { PluginManifestV1 } from "@mn/contracts";
import { assertPluginManifestShape } from "@mn/contracts";
import {
  cloneJson,
  deepFreeze,
  detachedEd25519Sign,
  detachedEd25519Verify,
  sha256Hex,
  signingPayload,
} from "./canonical.js";
import { PluginPolicyError } from "./errors.js";

const REGISTRY_SIGNATURE_DOMAIN = "mn.plugin-registry-metadata.v1";
const MANIFEST_SIGNATURE_DOMAIN = "mn.plugin-manifest.v1";
const MAX_REVOCATION_AGE_MS = 24 * 60 * 60 * 1_000;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type RegistryOperation = "install" | "update" | "offline_start";

export interface RegistryReleaseKeyV1 {
  readonly keyId: string;
  readonly publicKeySpki: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly replacesKeyId?: string;
}

export interface RevokedRegistryKeyV1 {
  readonly keyId: string;
  readonly revokedAt: string;
  readonly reason: string;
}

export interface RevokedPluginReleaseV1 {
  readonly pluginId: string;
  readonly packageSha256: string;
  readonly revokedAt: string;
  readonly reason: string;
}

export interface RegistryMetadataV1 {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly keys: readonly RegistryReleaseKeyV1[];
  readonly revokedKeys: readonly RevokedRegistryKeyV1[];
  readonly revokedReleases: readonly RevokedPluginReleaseV1[];
  readonly signature: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly value: string;
  };
}

export interface TrustedRegistryRoot {
  readonly keyId: string;
  readonly publicKey: KeyLike;
  readonly notBefore?: string;
  readonly notAfter?: string;
  readonly revokedAt?: string;
}

export interface VerifyRegistryOptions {
  readonly now: Date;
  readonly operation: RegistryOperation;
  readonly minimumSequence?: number;
}

export interface VerifiedRegistryMetadata {
  readonly metadata: RegistryMetadataV1;
  readonly operation: RegistryOperation;
  readonly verifiedAt: string;
}

export interface PluginPackageMetadataV1 {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly integrity?: {
    readonly algorithm: string;
    readonly value: string;
  };
  readonly remoteJavaScript?: readonly string[];
}

export interface InstalledReleaseIdentity {
  readonly sequence: number;
  readonly version: string;
  readonly packageSha256: string;
}

export interface ResolvedPluginDependency {
  readonly id: string;
  readonly version: string;
  readonly packageSha256: string;
}

export interface VerifyPluginArtifactInput {
  readonly manifest: PluginManifestV1;
  readonly packageBytes: Uint8Array;
  readonly registry: VerifiedRegistryMetadata;
  readonly now: Date;
  readonly operation: "install" | "update";
  readonly installedRelease?: InstalledReleaseIdentity;
  readonly packageMetadata?: PluginPackageMetadataV1;
}

export interface VerifiedPluginArtifact {
  readonly manifest: PluginManifestV1;
  readonly registrySequence: number;
  readonly verifiedAt: string;
}

const verifiedRegistries = new WeakSet<object>();
const verifiedArtifacts = new WeakSet<object>();

export function createSignedRegistryMetadata(
  metadata: Omit<RegistryMetadataV1, "signature">,
  keyId: string,
  privateKey: KeyLike,
): RegistryMetadataV1 {
  const unsigned = stripSignature(metadata as RegistryMetadataV1);
  const signature = detachedEd25519Sign(
    signingPayload(REGISTRY_SIGNATURE_DOMAIN, unsigned),
    privateKey,
  );
  return deepFreeze({
    ...cloneJson(unsigned),
    signature: { algorithm: "Ed25519", keyId, value: signature },
  });
}

export function verifyRegistryMetadata(
  metadata: RegistryMetadataV1,
  roots: readonly TrustedRegistryRoot[],
  options: VerifyRegistryOptions,
): VerifiedRegistryMetadata {
  assertRegistryShape(metadata);
  const now = options.now.getTime();
  const issuedAt = parseDate(metadata.issuedAt, "仓库元数据签发时间");
  const expiresAt = parseDate(metadata.expiresAt, "仓库元数据过期时间");
  if (issuedAt > now || expiresAt <= issuedAt) {
    throw policy("REGISTRY_TIME_INVALID", "插件仓库元数据时间范围无效", "刷新插件仓库元数据");
  }
  if (options.minimumSequence !== undefined && metadata.sequence < options.minimumSequence) {
    throw policy("REGISTRY_SEQUENCE_ROLLBACK", "插件仓库序号发生回退", "使用不低于已信任序号的元数据");
  }
  if (options.operation !== "offline_start") {
    if (now - issuedAt > MAX_REVOCATION_AGE_MS) {
      throw policy(
        "REVOCATION_METADATA_STALE",
        "插件撤销元数据已超过 24 小时",
        "联网刷新撤销元数据后再安装或更新",
      );
    }
    if (now > expiresAt) {
      throw policy("REGISTRY_TIME_INVALID", "插件仓库元数据已过期", "联网刷新插件仓库元数据");
    }
  }

  const root = roots.find((candidate) => candidate.keyId === metadata.signature.keyId);
  if (!root || isRootUnavailable(root, now)) {
    throw policy("REGISTRY_ROOT_UNTRUSTED", "插件仓库根密钥不受信任", "更新受信任根密钥");
  }
  const valid = detachedEd25519Verify(
    signingPayload(REGISTRY_SIGNATURE_DOMAIN, stripSignature(metadata)),
    metadata.signature.value,
    root.publicKey,
  );
  if (!valid) {
    throw policy("REGISTRY_SIGNATURE_INVALID", "插件仓库元数据签名无效", "停止安装并重新获取元数据");
  }
  const result = deepFreeze({
    metadata: cloneJson(metadata),
    operation: options.operation,
    verifiedAt: options.now.toISOString(),
  });
  verifiedRegistries.add(result);
  return result;
}

export function signPluginManifest(
  manifest: PluginManifestV1,
  privateKey: KeyLike,
): PluginManifestV1 {
  const unsigned = stripManifestSignature(manifest);
  const value = detachedEd25519Sign(
    signingPayload(MANIFEST_SIGNATURE_DOMAIN, unsigned),
    privateKey,
  );
  return deepFreeze({
    ...cloneJson(manifest),
    signature: { ...manifest.signature, algorithm: "Ed25519", value },
  });
}

export function verifyPluginArtifact(input: VerifyPluginArtifactInput): VerifiedPluginArtifact {
  if (!verifiedRegistries.has(input.registry as object)) {
    throw policy("REGISTRY_SIGNATURE_INVALID", "插件仓库元数据未经本进程验证", "先验证仓库元数据");
  }
  assertManifest(input.manifest);
  assertPackageMetadata(input.packageMetadata);
  if (input.registry.operation === "offline_start") {
    throw policy("REGISTRY_TIME_INVALID", "离线启动凭据不能授权安装或更新", "刷新仓库元数据");
  }
  const actualDigest = sha256Hex(input.packageBytes);
  if (actualDigest !== input.manifest.packageSha256) {
    throw policy("PACKAGE_DIGEST_MISMATCH", "插件包摘要与清单不一致", "删除插件包并重新下载");
  }
  enforceReleaseOrder(input.manifest, input.installedRelease);
  const now = input.now.getTime();
  const publishedAt = parseDate(input.manifest.release.publishedAt, "插件发布时间");
  const releaseExpiresAt = parseDate(input.manifest.release.expiresAt, "插件发布过期时间");
  if (publishedAt > now || releaseExpiresAt <= now) {
    throw policy("RELEASE_EXPIRED", "插件发布已过期或尚未生效", "获取当前有效版本");
  }

  const metadata = input.registry.metadata;
  const releaseKey = metadata.keys.find((key) => key.keyId === input.manifest.signature.keyId);
  if (!releaseKey) {
    throw policy("RELEASE_KEY_UNTRUSTED", "插件发布密钥不在可信仓库中", "刷新仓库元数据");
  }
  const keyNotBefore = parseDate(releaseKey.notBefore, "发布密钥生效时间");
  const keyNotAfter = parseDate(releaseKey.notAfter, "发布密钥失效时间");
  if (publishedAt < keyNotBefore || publishedAt >= keyNotAfter || now >= keyNotAfter) {
    throw policy("RELEASE_KEY_UNTRUSTED", "插件发布密钥不在有效期内", "使用当前发布密钥签名的版本");
  }
  const keyRevocation = metadata.revokedKeys.find((item) => item.keyId === releaseKey.keyId);
  if (keyRevocation && parseDate(keyRevocation.revokedAt, "密钥撤销时间") <= now) {
    throw policy("RELEASE_KEY_REVOKED", "插件发布密钥已撤销", "停止安装并检查安全公告");
  }
  const releaseRevocation = metadata.revokedReleases.find((item) => {
    return item.pluginId === input.manifest.id
      && item.packageSha256 === input.manifest.packageSha256
      && parseDate(item.revokedAt, "插件撤销时间") <= now;
  });
  if (releaseRevocation) {
    throw policy("PLUGIN_RELEASE_REVOKED", "该插件版本已撤销", "选择未撤销版本");
  }

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    const keyBytes = Buffer.from(releaseKey.publicKeySpki, "base64url");
    if (keyBytes.toString("base64url") !== releaseKey.publicKeySpki) {
      throw new Error("non-canonical key");
    }
    publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  } catch {
    throw policy("RELEASE_KEY_UNTRUSTED", "插件发布公钥格式无效", "刷新仓库元数据");
  }
  const valid = detachedEd25519Verify(
    signingPayload(MANIFEST_SIGNATURE_DOMAIN, stripManifestSignature(input.manifest)),
    input.manifest.signature.value,
    publicKey,
  );
  if (!valid) {
    throw policy("MANIFEST_SIGNATURE_INVALID", "插件清单签名无效", "停止安装并重新下载插件");
  }
  const artifact = deepFreeze({
    manifest: cloneJson(input.manifest),
    registrySequence: metadata.sequence,
    verifiedAt: input.now.toISOString(),
  });
  verifiedArtifacts.add(artifact);
  return artifact;
}

export function assertVerifiedPluginArtifact(
  artifact: VerifiedPluginArtifact,
): asserts artifact is VerifiedPluginArtifact {
  if (!verifiedArtifacts.has(artifact as object)) {
    throw policy(
      "MANIFEST_SIGNATURE_INVALID",
      "插件制品没有可信验签凭据",
      "通过 verifyPluginArtifact 验证后再安装",
    );
  }
}

export function assertResolvedPluginDependencies(
  manifest: PluginManifestV1,
  resolvedDependencies: readonly ResolvedPluginDependency[],
): void {
  const resolved = new Map(resolvedDependencies.map((dependency) => [dependency.id, dependency]));
  for (const dependency of manifest.dependencies) {
    const installed = resolved.get(dependency.id);
    if (!installed
      || installed.version !== dependency.version
      || installed.packageSha256 !== dependency.sha256) {
      throw policy(
        "PLUGIN_MANIFEST_INVALID",
        `插件依赖 ${dependency.id} 未按精确版本和摘要解析`,
        "安装清单锁定的依赖版本",
      );
    }
  }
}

function stripSignature(metadata: RegistryMetadataV1): Omit<RegistryMetadataV1, "signature"> {
  const { signature: _signature, ...unsigned } = metadata;
  return unsigned;
}

function stripManifestSignature(manifest: PluginManifestV1): Record<string, unknown> {
  return {
    ...manifest,
    signature: {
      algorithm: manifest.signature.algorithm,
      keyId: manifest.signature.keyId,
    },
  };
}

function assertRegistryShape(metadata: RegistryMetadataV1): void {
  if (metadata.schemaVersion !== 1 || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 1) {
    throw policy("REGISTRY_SIGNATURE_INVALID", "插件仓库元数据格式无效", "重新获取仓库元数据");
  }
  if (metadata.signature?.algorithm !== "Ed25519" || !metadata.signature.keyId) {
    throw policy("REGISTRY_SIGNATURE_INVALID", "插件仓库签名字段无效", "重新获取仓库元数据");
  }
  if (!Array.isArray(metadata.keys)
    || !Array.isArray(metadata.revokedKeys)
    || !Array.isArray(metadata.revokedReleases)) {
    throw policy("REGISTRY_SIGNATURE_INVALID", "插件仓库列表字段无效", "重新获取仓库元数据");
  }
  const keyIds = new Set<string>();
  for (const key of metadata.keys) {
    if (!key || typeof key !== "object" || !key.keyId
      || keyIds.has(key.keyId) || key.replacesKeyId === key.keyId
      || typeof key.publicKeySpki !== "string" || !key.publicKeySpki) {
      throw policy("REGISTRY_SIGNATURE_INVALID", "插件仓库发布密钥定义无效", "修复密钥轮换元数据");
    }
    keyIds.add(key.keyId);
    parseDate(key.notBefore, "发布密钥生效时间");
    parseDate(key.notAfter, "发布密钥失效时间");
  }
  const revokedKeyIds = new Set<string>();
  for (const revocation of metadata.revokedKeys) {
    if (!revocation || typeof revocation !== "object" || !revocation.keyId
      || revokedKeyIds.has(revocation.keyId) || !revocation.reason) {
      throw policy("REGISTRY_SIGNATURE_INVALID", "发布密钥撤销表无效", "修复撤销元数据");
    }
    revokedKeyIds.add(revocation.keyId);
    parseDate(revocation.revokedAt, "密钥撤销时间");
  }
  const revokedReleases = new Set<string>();
  for (const revocation of metadata.revokedReleases) {
    const identity = `${revocation?.pluginId ?? ""}\0${revocation?.packageSha256 ?? ""}`;
    if (!revocation || typeof revocation !== "object" || !revocation.pluginId
      || !/^[0-9a-f]{64}$/u.test(revocation.packageSha256)
      || revokedReleases.has(identity) || !revocation.reason) {
      throw policy("REGISTRY_SIGNATURE_INVALID", "插件撤销表无效", "修复撤销元数据");
    }
    revokedReleases.add(identity);
    parseDate(revocation.revokedAt, "插件撤销时间");
  }
}

function assertManifest(manifest: PluginManifestV1): void {
  try {
    assertPluginManifestShape(manifest);
  } catch (error) {
    throw policy(
      "PLUGIN_MANIFEST_INVALID",
      error instanceof Error ? error.message : "插件清单无效",
      "修复插件清单后重新签名",
    );
  }
  if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(manifest.id)
    || !/^[a-z][a-z0-9_]{0,62}$/u.test(manifest.dataNamespace)
    || !Number.isSafeInteger(manifest.release.sequence)) {
    throw policy(
      "PLUGIN_MANIFEST_INVALID",
      "插件 ID、数据命名空间或发布序号无效",
      "使用稳定标识和正整数发布序号",
    );
  }
  if (!Array.isArray(manifest.projections)
    || !Array.isArray(manifest.dependencies)
    || !Array.isArray(manifest.permissions)) {
    throw policy("PLUGIN_MANIFEST_INVALID", "插件清单列表字段无效", "修复插件清单后重新签名");
  }
  if (!EXACT_VERSION.test(manifest.engineApi)) {
    throw policy("PLUGIN_MANIFEST_INVALID", "engineApi 必须是精确版本", "填写精确 engineApi 版本");
  }
  let source: URL;
  try {
    source = new URL(manifest.release.source);
  } catch {
    throw policy("PLUGIN_MANIFEST_INVALID", "插件发布来源不是有效 URL", "使用 HTTPS 发布地址");
  }
  if (source.protocol !== "https:") {
    throw policy("PLUGIN_MANIFEST_INVALID", "插件发布来源必须使用 HTTPS", "使用 HTTPS 发布地址");
  }
  if (source.username || source.password || source.hash) {
    throw policy("PLUGIN_MANIFEST_INVALID", "插件发布来源不得包含凭据或片段", "使用无凭据的 HTTPS 地址");
  }
  const raw = manifest as unknown as Record<string, unknown>;
  if (raw.installHooks !== undefined || raw.scripts !== undefined) {
    throw policy("INSTALL_HOOK_FORBIDDEN", "插件清单不得声明安装钩子", "移除安装钩子");
  }
  if (raw.remoteJavaScript !== undefined || raw.remoteScripts !== undefined) {
    throw policy("REMOTE_JAVASCRIPT_FORBIDDEN", "插件清单不得声明远程 JavaScript", "将资源打包并签名");
  }
  if (raw.digestAlgorithm !== undefined && raw.digestAlgorithm !== "sha256") {
    throw policy("DIGEST_DOWNGRADE_FORBIDDEN", "插件摘要算法不得降级", "使用 SHA-256");
  }
  const dependencyIds = new Set<string>();
  for (const dependency of manifest.dependencies) {
    if (dependencyIds.has(dependency.id)) {
      throw policy("PLUGIN_MANIFEST_INVALID", `插件依赖 ${dependency.id} 重复`, "每个依赖只保留一项");
    }
    dependencyIds.add(dependency.id);
  }
  for (const projection of manifest.projections) {
    if (!projection || typeof projection !== "object"
      || !/^[a-z][a-z0-9_]{0,62}$/u.test(projection.namespace)
      || !isLocalManifestEntry(projection.entry)) {
      throw policy("PLUGIN_MANIFEST_INVALID", "插件投影命名空间或入口无效", "使用独立命名空间和包内 SQL 入口");
    }
  }
}

function assertPackageMetadata(metadata: PluginPackageMetadataV1 | undefined): void {
  if (!metadata) return;
  const installHooks = new Set(["preinstall", "install", "postinstall", "prepare"]);
  if (Object.keys(metadata.scripts ?? {}).some((name) => installHooks.has(name))) {
    throw policy("INSTALL_HOOK_FORBIDDEN", "插件包不得包含安装钩子", "移除安装钩子并重新发布");
  }
  if (metadata.integrity && metadata.integrity.algorithm.toLowerCase() !== "sha256") {
    throw policy("DIGEST_DOWNGRADE_FORBIDDEN", "插件包完整性算法低于 SHA-256", "使用 SHA-256 摘要");
  }
  if ((metadata.remoteJavaScript?.length ?? 0) > 0) {
    throw policy("REMOTE_JAVASCRIPT_FORBIDDEN", "插件包不得加载远程 JavaScript", "将脚本打包为本地资源");
  }
}

function enforceReleaseOrder(
  manifest: PluginManifestV1,
  installed: InstalledReleaseIdentity | undefined,
): void {
  if (!installed) return;
  if (manifest.release.sequence < installed.sequence) {
    throw policy("RELEASE_ROLLBACK", "插件发布序号低于已安装版本", "安装更高发布序号的版本");
  }
  if (manifest.release.sequence === installed.sequence
    && (manifest.version !== installed.version || manifest.packageSha256 !== installed.packageSha256)) {
    throw policy("RELEASE_SEQUENCE_REUSED", "同一发布序号绑定了不同内容", "提高发布序号并重新签名");
  }
}

function isRootUnavailable(root: TrustedRegistryRoot, now: number): boolean {
  return (root.notBefore !== undefined && parseDate(root.notBefore, "根密钥生效时间") > now)
    || (root.notAfter !== undefined && parseDate(root.notAfter, "根密钥失效时间") <= now)
    || (root.revokedAt !== undefined && parseDate(root.revokedAt, "根密钥撤销时间") <= now);
}

function parseDate(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
    || !Number.isFinite(parsed)) {
    throw policy("REGISTRY_TIME_INVALID", `${label} 必须是规范 ISO 时间`, "修复时间字段");
  }
  return parsed;
}

function isLocalManifestEntry(entry: unknown): entry is string {
  if (typeof entry !== "string" || !entry
    || entry.includes("\\") || entry.includes("\0") || entry.startsWith("/")) return false;
  const normalized = entry.replace(/^\.\//u, "");
  return normalized !== ".." && !normalized.startsWith("../") && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(entry);
}

function policy(code: ConstructorParameters<typeof PluginPolicyError>[0], message: string, action: string) {
  return new PluginPolicyError(code, message, action);
}
