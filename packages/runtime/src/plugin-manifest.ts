// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export interface RuntimePluginManifest {
  readonly schemaVersion: 1;
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

export interface VerifiedRuntimePlugin {
  readonly manifestPath: string;
  readonly entryPath: string;
  readonly manifest: RuntimePluginManifest;
}

const MANIFEST_KEYS = new Set([
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
]);
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const INTEGRITY_PATTERN = /^sha256-[a-f0-9]{64}$/u;

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function names(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !NAME_PATTERN.test(entry))) {
    throw new TypeError(`${label} must contain valid identifiers`);
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${label} contains duplicates`);
  return Object.freeze([...value]);
}

export function runtimePluginIntegrity(content: string | Buffer): string {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`;
}

function parseManifest(value: unknown): RuntimePluginManifest {
  const record = plainRecord(value, "runtime plugin manifest");
  if (Object.keys(record).some((key) => !MANIFEST_KEYS.has(key))
    || Object.keys(record).length !== MANIFEST_KEYS.size
    || record.schemaVersion !== 1
    || typeof record.name !== "string" || !NAME_PATTERN.test(record.name)
    || typeof record.version !== "string" || !VERSION_PATTERN.test(record.version)
    || typeof record.integrity !== "string" || !INTEGRITY_PATTERN.test(record.integrity)
    || typeof record.entry !== "string" || record.entry.length === 0 || path.isAbsolute(record.entry)
    || record.entry.includes("\0")) {
    throw new TypeError("runtime plugin manifest has invalid identity or executable fields");
  }
  const configSchema = plainRecord(record.configSchema, "runtime plugin config schema");
  return Object.freeze({
    schemaVersion: 1,
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
  });
}

export async function verifyRuntimePluginManifest(
  manifestPathInput: string,
  hostCapabilities: readonly string[]
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
