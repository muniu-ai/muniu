// SPDX-License-Identifier: Apache-2.0

import { createHash, verify as verifySignature } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { canonicalRuntimeJson } from "./canonical.js";

interface RuntimePluginManifestCommon {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly entry: string;
  readonly skills: readonly string[];
  readonly mcpServers: readonly string[];
  readonly hooks: readonly string[];
  readonly tools: readonly string[];
  readonly configSchema: Readonly<Record<string, unknown>>;
  readonly requiredCapabilities: readonly string[];
}

export interface RuntimePluginManifestV1 extends RuntimePluginManifestCommon {
  readonly schemaVersion: 1;
}

export interface RuntimePluginReleaseV2 {
  readonly sequence: number;
  readonly publishedAt: string;
}

export interface RuntimePluginSignatureV2 {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface RuntimePluginContributionsV2 {
  readonly domains: readonly string[];
  readonly recordSchemas: readonly string[];
  readonly workflows: readonly string[];
  readonly gates: readonly string[];
  readonly connectors: readonly string[];
  readonly renderers: readonly string[];
}

export interface RuntimePluginMigrationV2 {
  readonly id: string;
  readonly fromVersion: string;
  readonly toVersion: string;
}

export interface RuntimePluginManifestV2 extends RuntimePluginManifestCommon {
  readonly schemaVersion: 2;
  readonly release: RuntimePluginReleaseV2;
  readonly signature: RuntimePluginSignatureV2;
  readonly trustClass: "official-domain" | "official-connector";
  readonly contributes: RuntimePluginContributionsV2;
  readonly externalEffects: readonly string[];
  readonly migrations: readonly RuntimePluginMigrationV2[];
}

export type RuntimePluginManifest = RuntimePluginManifestV1 | RuntimePluginManifestV2;

export interface VerifiedRuntimePlugin {
  readonly manifestPath: string;
  readonly entryPath: string;
  readonly manifest: RuntimePluginManifest;
}

export interface RuntimePluginTrustOptions {
  readonly trustedKeys?: Readonly<Record<string, string>>;
}

const COMMON_KEYS = [
  "schemaVersion",
  "name",
  "version",
  "integrity",
  "entry",
  "skills",
  "mcpServers",
  "hooks",
  "tools",
  "configSchema",
  "requiredCapabilities"
] as const;
const V1_KEYS = new Set<string>(COMMON_KEYS);
const V2_KEYS = new Set<string>([
  ...COMMON_KEYS,
  "release",
  "signature",
  "trustClass",
  "contributes",
  "externalEffects",
  "migrations"
]);
const CONTRIBUTION_KEYS = new Set([
  "domains",
  "recordSchemas",
  "workflows",
  "gates",
  "connectors",
  "renderers"
]);
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const INTEGRITY_PATTERN = /^sha256-[a-f0-9]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: ReadonlySet<string>, label: string): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new TypeError(`${label} has unsupported or missing fields`);
  }
}

function names(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !NAME_PATTERN.test(entry))) {
    throw new TypeError(`${label} must contain valid identifiers`);
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${label} contains duplicates`);
  return Object.freeze([...value]);
}

function common(record: Record<string, unknown>): RuntimePluginManifestCommon {
  if (typeof record.name !== "string" || !NAME_PATTERN.test(record.name)
    || typeof record.version !== "string" || !VERSION_PATTERN.test(record.version)
    || typeof record.integrity !== "string" || !INTEGRITY_PATTERN.test(record.integrity)
    || typeof record.entry !== "string" || record.entry.length === 0 || path.isAbsolute(record.entry)
    || record.entry.includes("\0")) {
    throw new TypeError("runtime plugin manifest has invalid identity or executable fields");
  }
  const configSchema = plainRecord(record.configSchema, "runtime plugin config schema");
  return {
    name: record.name,
    version: record.version,
    integrity: record.integrity,
    entry: record.entry,
    skills: names(record.skills, "runtime plugin skills"),
    mcpServers: names(record.mcpServers, "runtime plugin MCP servers"),
    hooks: names(record.hooks, "runtime plugin hooks"),
    tools: names(record.tools, "runtime plugin tools"),
    configSchema: Object.freeze(structuredClone(configSchema)),
    requiredCapabilities: names(record.requiredCapabilities, "runtime plugin required capabilities")
  };
}

function parseV1(record: Record<string, unknown>): RuntimePluginManifestV1 {
  exactKeys(record, V1_KEYS, "runtime plugin V1 manifest");
  return Object.freeze({ schemaVersion: 1, ...common(record) });
}

function parseRelease(value: unknown): RuntimePluginReleaseV2 {
  const record = plainRecord(value, "runtime plugin release");
  exactKeys(record, new Set(["sequence", "publishedAt"]), "runtime plugin release");
  if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) < 1) {
    throw new TypeError("runtime plugin release sequence must be a positive safe integer");
  }
  const publishedAt = record.publishedAt;
  const parsed = typeof publishedAt === "string" ? Date.parse(publishedAt) : Number.NaN;
  const normalized = typeof publishedAt === "string"
    ? (publishedAt.includes(".")
      ? publishedAt.replace(/\.(\d{1,3})Z$/u, (_match, fraction: string) => `.${fraction.padEnd(3, "0")}Z`)
      : publishedAt.replace(/Z$/u, ".000Z"))
    : "";
  if (typeof publishedAt !== "string" || !RFC3339_PATTERN.test(publishedAt)
    || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new TypeError("runtime plugin release publishedAt must be RFC3339 UTC");
  }
  return Object.freeze({ sequence: Number(record.sequence), publishedAt });
}

function parseSignature(value: unknown): RuntimePluginSignatureV2 {
  const record = plainRecord(value, "runtime plugin signature");
  exactKeys(record, new Set(["algorithm", "keyId", "value"]), "runtime plugin signature");
  const signature = typeof record.value === "string" && BASE64_PATTERN.test(record.value)
    ? Buffer.from(record.value, "base64")
    : undefined;
  if (record.algorithm !== "ed25519" || typeof record.keyId !== "string" || !NAME_PATTERN.test(record.keyId)
    || typeof record.value !== "string" || signature === undefined || signature.length !== 64
    || signature.toString("base64") !== record.value) {
    throw new TypeError("runtime plugin signature is invalid");
  }
  return Object.freeze({ algorithm: "ed25519", keyId: record.keyId, value: record.value });
}

function parseContributions(value: unknown): RuntimePluginContributionsV2 {
  const record = plainRecord(value, "runtime plugin contributions");
  exactKeys(record, CONTRIBUTION_KEYS, "runtime plugin contributions");
  return Object.freeze({
    domains: names(record.domains, "runtime plugin domains"),
    recordSchemas: names(record.recordSchemas, "runtime plugin record schemas"),
    workflows: names(record.workflows, "runtime plugin workflows"),
    gates: names(record.gates, "runtime plugin gates"),
    connectors: names(record.connectors, "runtime plugin connectors"),
    renderers: names(record.renderers, "runtime plugin renderers")
  });
}

function parseMigrations(value: unknown): readonly RuntimePluginMigrationV2[] {
  if (!Array.isArray(value)) throw new TypeError("runtime plugin migrations must be an array");
  const ids = new Set<string>();
  const result = value.map((candidate, index) => {
    const record = plainRecord(candidate, `runtime plugin migrations[${index}]`);
    exactKeys(record, new Set(["id", "fromVersion", "toVersion"]), `runtime plugin migrations[${index}]`);
    if (typeof record.id !== "string" || !NAME_PATTERN.test(record.id)
      || typeof record.fromVersion !== "string" || !VERSION_PATTERN.test(record.fromVersion)
      || typeof record.toVersion !== "string" || !VERSION_PATTERN.test(record.toVersion)) {
      throw new TypeError(`runtime plugin migrations[${index}] is invalid`);
    }
    if (ids.has(record.id)) throw new TypeError("runtime plugin migrations contain duplicates");
    ids.add(record.id);
    return Object.freeze({ id: record.id, fromVersion: record.fromVersion, toVersion: record.toVersion });
  });
  return Object.freeze(result);
}

function parseV2(record: Record<string, unknown>): RuntimePluginManifestV2 {
  exactKeys(record, V2_KEYS, "runtime plugin V2 manifest");
  if (record.trustClass !== "official-domain" && record.trustClass !== "official-connector") {
    throw new TypeError("runtime plugin trustClass is invalid");
  }
  return Object.freeze({
    schemaVersion: 2,
    ...common(record),
    release: parseRelease(record.release),
    signature: parseSignature(record.signature),
    trustClass: record.trustClass,
    contributes: parseContributions(record.contributes),
    externalEffects: names(record.externalEffects, "runtime plugin external effects"),
    migrations: parseMigrations(record.migrations)
  });
}

function parseManifest(value: unknown): RuntimePluginManifest {
  const record = plainRecord(value, "runtime plugin manifest");
  if (record.schemaVersion === 1) return parseV1(record);
  if (record.schemaVersion === 2) return parseV2(record);
  throw new TypeError("runtime plugin manifest schemaVersion is unsupported");
}

export function runtimePluginIntegrity(content: string | Buffer): string {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`;
}

export function runtimePluginSignaturePayload(
  manifest: Omit<RuntimePluginManifestV2, "signature"> | Record<string, unknown>
): string {
  const { signature: _signature, ...unsigned } = manifest as Record<string, unknown>;
  return canonicalRuntimeJson(unsigned);
}

function verifyV2Signature(
  manifest: RuntimePluginManifestV2,
  options: RuntimePluginTrustOptions
): void {
  const trustedKey = options.trustedKeys?.[manifest.signature.keyId];
  if (trustedKey === undefined) throw new Error(`runtime plugin signature key is not trusted: ${manifest.signature.keyId}`);
  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(runtimePluginSignaturePayload(manifest), "utf8"),
      trustedKey,
      Buffer.from(manifest.signature.value, "base64")
    );
  } catch (error: unknown) {
    throw new Error("runtime plugin signature verification failed", { cause: error });
  }
  if (!valid) throw new Error("runtime plugin signature does not match its manifest");
}

export async function verifyRuntimePluginManifest(
  manifestPathInput: string,
  hostCapabilities: readonly string[],
  trustOptions: RuntimePluginTrustOptions = {}
): Promise<VerifiedRuntimePlugin> {
  const manifestPath = path.resolve(manifestPathInput);
  const manifestStats = await lstat(manifestPath);
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.size > 1024 * 1024) {
    throw new Error("runtime plugin manifest must be a bounded regular file");
  }
  const manifestRoot = await realpath(path.dirname(manifestPath));
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error: unknown) {
    throw new Error("runtime plugin manifest is not valid JSON", { cause: error });
  }
  const manifest = parseManifest(value);
  if (manifest.schemaVersion === 2) verifyV2Signature(manifest, trustOptions);
  const entryLexical = path.resolve(manifestRoot, manifest.entry);
  const relative = path.relative(manifestRoot, entryLexical);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("runtime plugin entry escapes its root");
  const entryStats = await lstat(entryLexical);
  if (!entryStats.isFile() || entryStats.isSymbolicLink() || entryStats.size > 64 * 1024 * 1024) {
    throw new Error("runtime plugin entry must be a bounded regular file and not a symbolic link");
  }
  const entryPath = await realpath(entryLexical);
  if (path.dirname(entryPath) !== manifestRoot && !entryPath.startsWith(`${manifestRoot}${path.sep}`)) {
    throw new Error("runtime plugin entry escapes its root");
  }
  if (runtimePluginIntegrity(await readFile(entryPath)) !== manifest.integrity) {
    throw new Error("runtime plugin entry integrity does not match its manifest");
  }
  const capabilities = new Set(hostCapabilities);
  const missing = manifest.requiredCapabilities.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) throw new Error(`runtime plugin required capability is unavailable: ${missing.join(", ")}`);
  return Object.freeze({ manifestPath, entryPath, manifest });
}
