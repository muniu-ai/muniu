// SPDX-License-Identifier: Apache-2.0

import type { PluginEntrypointsV1, PluginManifestV1 } from "@mn/contracts";

import { canonicalJson, cloneJson, sha256Hex } from "./canonical.js";
import { PluginPolicyError } from "./errors.js";
import { assertVerifiedPluginArtifact, type VerifiedPluginArtifact } from "./registry.js";
import { assertPluginResource } from "./resources.js";

const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 512;
const SHA256 = /^[0-9a-f]{64}$/u;

export type PluginEntrypointKind = keyof PluginEntrypointsV1;

export interface PluginPackageFileV1 {
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly contentBase64: string;
}

export interface PluginPackageArchiveV1 {
  readonly schemaVersion: 1;
  readonly files: readonly PluginPackageFileV1[];
}

export interface VerifiedPluginPackageV1 {
  readonly manifest: PluginManifestV1;
  list(): readonly { readonly path: string; readonly mediaType: string; readonly sha256: string; readonly byteLength: number }[];
  read(path: string): Uint8Array;
  readEntrypoint(kind: PluginEntrypointKind): Uint8Array | undefined;
}

/**
 * 生成稳定的无安装脚本插件归档。发布方对返回字节计算 packageSha256，
 * 再对包含该摘要的 manifest 做 Ed25519 签名。
 */
export function createPluginPackageArchive(
  files: Readonly<Record<string, { readonly content: Uint8Array; readonly mediaType?: string }>>,
): Uint8Array {
  const records = Object.entries(files)
    .map(([path, file]) => {
      const normalized = normalizePackagePath(path);
      const content = Uint8Array.from(file.content);
      if (content.byteLength > MAX_FILE_BYTES) throw invalidPackage(`插件资源 ${normalized} 超过大小上限`);
      return {
        path: normalized,
        mediaType: file.mediaType ?? inferMediaType(normalized),
        sha256: sha256Hex(content),
        contentBase64: Buffer.from(content).toString("base64"),
      } satisfies PluginPackageFileV1;
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  assertUniquePaths(records);
  if (records.length === 0 || records.length > MAX_FILES) {
    throw invalidPackage("插件包资源数量无效");
  }
  const bytes = Buffer.from(canonicalJson({ schemaVersion: 1, files: records }), "utf8");
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw invalidPackage("插件包超过大小上限");
  return Uint8Array.from(bytes);
}

/** 只打开已完成仓库、manifest 和整包摘要验证的归档。 */
export function openVerifiedPluginPackage(input: {
  readonly artifact: VerifiedPluginArtifact;
  readonly packageBytes: Uint8Array;
}): VerifiedPluginPackageV1 {
  assertVerifiedPluginArtifact(input.artifact);
  if (input.packageBytes.byteLength < 1 || input.packageBytes.byteLength > MAX_PACKAGE_BYTES) {
    throw invalidPackage("插件包大小无效");
  }
  if (sha256Hex(input.packageBytes) !== input.artifact.manifest.packageSha256) {
    throw invalidPackage("插件包字节与已验签 manifest 摘要不一致");
  }
  let value: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(input.packageBytes);
    value = JSON.parse(source) as unknown;
  } catch {
    throw invalidPackage("插件包必须是 UTF-8 JSON 归档");
  }
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.files)
    || value.files.length === 0 || value.files.length > MAX_FILES) {
    throw invalidPackage("插件包归档结构无效");
  }
  const decoded = value.files.map((candidate) => decodeFile(candidate));
  assertUniquePaths(decoded);
  const totalBytes = decoded.reduce((total, file) => total + file.content.byteLength, 0);
  if (totalBytes > MAX_PACKAGE_BYTES) throw invalidPackage("插件包解压后超过大小上限");

  const byPath = new Map(decoded.map((file) => [file.path, file]));
  assertDeclaredResourcesPresent(input.artifact.manifest, byPath);
  const metadata = Object.freeze(decoded.map((file) => Object.freeze({
    path: file.path,
    mediaType: file.mediaType,
    sha256: file.sha256,
    byteLength: file.content.byteLength,
  })));
  const manifest = cloneJson(input.artifact.manifest);
  return Object.freeze({
    manifest,
    list: () => metadata,
    read(path: string) {
      const normalized = normalizePackagePath(path);
      const file = byPath.get(normalized);
      if (!file) throw invalidPackage(`插件包不包含资源 ${normalized}`);
      return Uint8Array.from(file.content);
    },
    readEntrypoint(kind: PluginEntrypointKind) {
      const entry = manifest.entrypoints[kind];
      return entry ? Uint8Array.from(byPath.get(normalizePackagePath(entry))!.content) : undefined;
    },
  });
}

interface DecodedPackageFile {
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly content: Uint8Array;
}

function decodeFile(value: unknown): DecodedPackageFile {
  if (!isObject(value)
    || typeof value.path !== "string"
    || typeof value.mediaType !== "string"
    || !value.mediaType.trim()
    || typeof value.sha256 !== "string"
    || !SHA256.test(value.sha256)
    || typeof value.contentBase64 !== "string") {
    throw invalidPackage("插件包资源记录无效");
  }
  const path = normalizePackagePath(value.path);
  let content: Uint8Array;
  try {
    const bytes = Buffer.from(value.contentBase64, "base64");
    if (bytes.toString("base64") !== value.contentBase64) throw new Error("non-canonical base64");
    content = Uint8Array.from(bytes);
  } catch {
    throw invalidPackage(`插件资源 ${path} 不是规范 Base64`);
  }
  if (content.byteLength > MAX_FILE_BYTES) throw invalidPackage(`插件资源 ${path} 超过大小上限`);
  assertPluginResource({
    mode: "production",
    resource: path,
    content,
    expectedSha256: value.sha256,
  });
  return { path, mediaType: value.mediaType, sha256: value.sha256, content };
}

function assertDeclaredResourcesPresent(
  manifest: PluginManifestV1,
  files: ReadonlyMap<string, DecodedPackageFile>,
): void {
  for (const [kind, rawEntry] of Object.entries(manifest.entrypoints)) {
    if (!rawEntry) continue;
    const entry = normalizePackagePath(rawEntry);
    const file = files.get(entry);
    if (!file) throw invalidPackage(`插件 ${manifest.id} 缺少 ${kind} 入口 ${entry}`);
    if ((kind === "host" || kind === "worker" || kind === "cli")
      && !/\.(?:js|mjs)$/u.test(entry)) {
      throw invalidPackage(`插件 ${manifest.id} 的 ${kind} 入口必须是 JavaScript 模块`);
    }
  }
  for (const projection of manifest.projections) {
    const entry = normalizePackagePath(projection.entry);
    if (!files.has(entry)) throw invalidPackage(`插件 ${manifest.id} 缺少投影资源 ${entry}`);
  }
}

function assertUniquePaths(files: readonly { readonly path: string }[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw invalidPackage(`插件包包含重复资源 ${file.path}`);
    paths.add(file.path);
  }
}

function normalizePackagePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) || value.startsWith("//")) {
    throw invalidPackage("插件资源必须是包内相对路径");
  }
  const normalized = value.replace(/^\.\//u, "").split("/").filter((part) => part !== ".").join("/");
  if (!normalized || normalized.split("/").some((part) => !part || part === "..")) {
    throw invalidPackage("插件资源必须是包内相对路径");
  }
  return normalized;
}

function inferMediaType(path: string): string {
  if (/\.m?js$/u.test(path)) return "text/javascript";
  if (/\.css$/u.test(path)) return "text/css";
  if (/\.json$/u.test(path)) return "application/json";
  if (/\.sql$/u.test(path)) return "application/sql";
  return "application/octet-stream";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPackage(message: string): PluginPolicyError {
  return new PluginPolicyError("PLUGIN_PACKAGE_INVALID", message, "重新构建并签名完整插件包");
}
