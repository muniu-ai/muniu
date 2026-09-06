// SPDX-License-Identifier: Apache-2.0

import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { assertPluginManifestShape, type PluginManifestV1 } from "@mn/contracts";
import {
  cloneJson,
  assertPluginSurfaces,
  canonicalJson,
  openVerifiedPluginPackage,
  sha256Hex,
  verifyPluginArtifact,
  verifyRegistryMetadata,
  type PluginDefinitionV1,
  type PluginPackageMetadataV1,
  type RegistryMetadataV1,
  type TrustedRegistryRoot,
} from "@mn/plugin-sdk";
import {
  LocalSignedPluginRepository,
  type LocalSignedPluginRelease,
  type LocalSignedPluginRepositorySnapshot,
} from "./plugin-installation.js";

interface RepositoryIndexReleaseV1 {
  readonly manifest: PluginManifestV1;
  readonly packagePath: string;
  readonly packageMetadata?: PluginPackageMetadataV1;
}

interface RepositoryIndexV1 {
  readonly schemaVersion: 1;
  readonly metadata: RegistryMetadataV1;
  readonly releases: readonly RepositoryIndexReleaseV1[];
}

interface TrustedRootFileV1 {
  readonly schemaVersion: 1;
  readonly roots: readonly {
    readonly keyId: string;
    readonly publicKeySpki: string;
    readonly notBefore?: string;
    readonly notAfter?: string;
    readonly revokedAt?: string;
  }[];
}

export interface EnterpriseFilePluginRepositoryOptions {
  readonly indexFile: string;
  readonly trustedRootsFile: string;
  readonly now?: () => Date;
}

export interface EnterpriseFilePluginRepositoryResult {
  readonly pluginRepository: LocalSignedPluginRepository;
  readonly trustedPluginRoots: readonly TrustedRegistryRoot[];
  readonly repositoryDigest: string;
}

/**
 * 读取镜像内只读插件目录。模块字节先经过仓库根签名、发布签名与 SHA-256 校验，
 * 再从已读取的同一份字节执行；不会直接 import 文件路径，也不接受远程模块。
 */
export async function createEnterpriseFilePluginRepository(
  options: EnterpriseFilePluginRepositoryOptions,
): Promise<EnterpriseFilePluginRepositoryResult> {
  if (!isAbsolute(options.indexFile) || !isAbsolute(options.trustedRootsFile)) {
    throw new Error("企业插件仓库索引和受信根必须使用绝对路径");
  }
  const [indexValue, rootValue] = await Promise.all([
    readJson(options.indexFile),
    readJson(options.trustedRootsFile),
  ]);
  const index = parseRepositoryIndex(indexValue);
  const trustedRoots = parseTrustedRoots(rootValue);
  const baseDirectory = dirname(resolve(options.indexFile));
  const now = options.now ?? (() => new Date());
  const checkedAt = now();
  const offlineRegistry = verifyRegistryMetadata(index.metadata, trustedRoots, {
    now: checkedAt,
    operation: "offline_start",
    minimumSequence: index.metadata.sequence,
  });
  const releases = await Promise.all(index.releases.map(async (release): Promise<LocalSignedPluginRelease> => {
    assertPluginManifestShape(release.manifest);
    const packagePath = resolvePackagePath(baseDirectory, release.packagePath, release.manifest);
    const packageBytes = Uint8Array.from(await readFile(packagePath));
    const artifact = verifyPluginArtifact({
      manifest: release.manifest,
      packageBytes,
      registry: offlineRegistry,
      now: checkedAt,
      operation: "offline_start",
      installedRelease: {
        sequence: release.manifest.release.sequence,
        version: release.manifest.version,
        packageSha256: release.manifest.packageSha256,
      },
      packageMetadata: release.packageMetadata,
    });
    openVerifiedPluginPackage({ artifact, packageBytes });
    const loadEntrypoint = verifiedEntrypointLoader({
      metadata: index.metadata,
      trustedRoots,
      manifest: release.manifest,
      packageBytes,
      packageMetadata: release.packageMetadata,
      now,
    });
    return {
      manifest: cloneJson(release.manifest),
      packageBytes,
      ...(release.packageMetadata ? { packageMetadata: cloneJson(release.packageMetadata) } : {}),
      loadDefinition: verifiedModuleLoader(release.manifest, loadEntrypoint),
      loadEntrypoint,
    };
  }));
  const snapshot: LocalSignedPluginRepositorySnapshot = {
    metadata: cloneJson(index.metadata),
    releases,
  };
  return {
    pluginRepository: new LocalSignedPluginRepository(snapshot),
    trustedPluginRoots: trustedRoots,
    repositoryDigest: sha256Hex(Buffer.from(canonicalJson({
      schemaVersion: 1,
      metadata: index.metadata,
      roots: (rootValue as TrustedRootFileV1).roots,
      releases: releases.map((release) => ({
        manifest: release.manifest,
        packageSha256: sha256Hex(release.packageBytes),
        packageMetadata: release.packageMetadata ?? {},
      })),
    }), "utf8")),
  };
}

function verifiedEntrypointLoader(input: {
  readonly metadata: RegistryMetadataV1;
  readonly trustedRoots: readonly TrustedRegistryRoot[];
  readonly manifest: PluginManifestV1;
  readonly packageBytes: Uint8Array;
  readonly packageMetadata?: PluginPackageMetadataV1;
  readonly now: () => Date;
}): (kind: "host" | "worker" | "ui" | "cli") => Promise<Uint8Array | undefined> {
  const loaded = new Map<string, Promise<Uint8Array | undefined>>();
  return (kind) => {
    let result = loaded.get(kind);
    if (!result) {
      result = (async () => {
        const checkedAt = input.now();
        const registry = verifyRegistryMetadata(input.metadata, input.trustedRoots, {
          now: checkedAt,
          operation: "offline_start",
          minimumSequence: input.metadata.sequence,
        });
        const artifact = verifyPluginArtifact({
          manifest: input.manifest,
          packageBytes: input.packageBytes,
          registry,
          now: checkedAt,
          operation: "offline_start",
          installedRelease: {
            sequence: input.manifest.release.sequence,
            version: input.manifest.version,
            packageSha256: input.manifest.packageSha256,
          },
          packageMetadata: input.packageMetadata,
        });
        return openVerifiedPluginPackage({ artifact, packageBytes: input.packageBytes })
          .readEntrypoint(kind);
      })();
      loaded.set(kind, result);
    }
    return result.then((bytes) => bytes ? Uint8Array.from(bytes) : undefined);
  };
}

function verifiedModuleLoader(
  manifest: PluginManifestV1,
  loadEntrypoint: (kind: "host" | "worker" | "ui" | "cli") => Promise<Uint8Array | undefined>,
): () => Promise<PluginDefinitionV1> {
  let loaded: Promise<PluginDefinitionV1> | undefined;
  return () => {
    loaded ??= (async () => {
      const bytes = await loadEntrypoint("host");
      if (!bytes) throw new Error(`插件 ${manifest.id} 没有 Host 入口`);
      const source = Buffer.from(bytes).toString("base64");
      const module = await import(`data:text/javascript;base64,${source}`);
      if (typeof module.default !== "function") {
        throw new Error(`插件 ${manifest.id} 的 Host 模块必须默认导出定义工厂`);
      }
      const definition = await module.default(cloneJson(manifest));
      if (!isObject(definition)) {
        throw new Error(`插件 ${manifest.id} 的 Host 定义无效`);
      }
      const surfaces: Record<string, unknown> = {};
      for (const kind of ["ui", "cli"] as const) {
        const entry = await loadEntrypoint(kind);
        if (!entry) continue;
        const surfaceModule = await import(`data:text/javascript;base64,${Buffer.from(entry).toString("base64")}`);
        if (typeof surfaceModule.default !== "function") throw new Error(`插件 ${manifest.id} 的 ${kind} 入口必须默认导出贡献工厂`);
        surfaces[kind] = await surfaceModule.default(cloneJson(manifest));
      }
      const typed = definition as unknown as PluginDefinitionV1;
      assertPluginSurfaces(surfaces, typed.contributions);
      return { ...typed, surfaces };
    })();
    return loaded;
  };
}

function resolvePackagePath(
  baseDirectory: string,
  packagePath: string,
  manifest: PluginManifestV1,
): string {
  const normalized = normalizeLocalPath(packagePath, "packagePath");
  const absolute = resolve(baseDirectory, normalized);
  const child = relative(baseDirectory, absolute);
  if (!child || child === ".." || child.startsWith(`..${posix.sep}`) || isAbsolute(child)) {
    throw new Error(`插件 ${manifest.id} 的 packagePath 越出仓库目录`);
  }
  return absolute;
}

function normalizeLocalPath(value: string, field: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new Error(`${field} 必须是仓库内相对路径`);
  }
  const normalized = posix.normalize(value.replace(/^\.\//u, ""));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${field} 必须是仓库内相对路径`);
  }
  return normalized;
}

async function readJson(file: string): Promise<unknown> {
  const bytes = await readFile(file);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function parseRepositoryIndex(value: unknown): RepositoryIndexV1 {
  if (!isObject(value)
    || value.schemaVersion !== 1
    || !isObject(value.metadata)
    || !Array.isArray(value.releases)) {
    throw new Error("企业插件仓库索引格式无效");
  }
  const releases = value.releases.map((candidate) => {
    if (!isObject(candidate)
      || !isObject(candidate.manifest)
      || typeof candidate.packagePath !== "string"
      || (candidate.packageMetadata !== undefined && !isObject(candidate.packageMetadata))) {
      throw new Error("企业插件仓库发布记录格式无效");
    }
    return candidate as unknown as RepositoryIndexReleaseV1;
  });
  return {
    schemaVersion: 1,
    metadata: value.metadata as unknown as RegistryMetadataV1,
    releases,
  };
}

function parseTrustedRoots(value: unknown): readonly TrustedRegistryRoot[] {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.roots) || value.roots.length === 0) {
    throw new Error("企业插件仓库受信根格式无效");
  }
  const ids = new Set<string>();
  return value.roots.map((candidate) => {
    if (!isObject(candidate)
      || typeof candidate.keyId !== "string"
      || !candidate.keyId
      || typeof candidate.publicKeySpki !== "string") {
      throw new Error("企业插件仓库受信根记录无效");
    }
    if (ids.has(candidate.keyId)) throw new Error(`企业插件仓库受信根 ${candidate.keyId} 重复`);
    ids.add(candidate.keyId);
    const bytes = Buffer.from(candidate.publicKeySpki, "base64url");
    if (bytes.toString("base64url") !== candidate.publicKeySpki) {
      throw new Error(`企业插件仓库受信根 ${candidate.keyId} 不是规范 Base64URL`);
    }
    const publicKey = createPublicKey({ key: bytes, format: "der", type: "spki" });
    return {
      keyId: candidate.keyId,
      publicKey,
      ...(typeof candidate.notBefore === "string" ? { notBefore: candidate.notBefore } : {}),
      ...(typeof candidate.notAfter === "string" ? { notAfter: candidate.notAfter } : {}),
      ...(typeof candidate.revokedAt === "string" ? { revokedAt: candidate.revokedAt } : {}),
    };
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
