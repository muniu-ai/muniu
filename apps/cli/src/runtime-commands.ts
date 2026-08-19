// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { option, printJson, requestJson } from "./command-client.js";

const execFileAsync = promisify(execFile);

interface PluginRecord {
  id: string;
  source: "local" | "npm";
  specifier: string;
  resolvedPath: string;
  version: string;
  integrity: string;
  installedAt: string;
}

interface PluginManifest {
  schemaVersion: 1;
  plugins: PluginRecord[];
}

async function runtimeRoot(): Promise<string> {
  const home = process.env.HOME ?? homedir();
  const current = join(home, ".muniu");
  const legacy = join(home, ".mniu");
  if (!existsSync(current) && existsSync(legacy)) await rename(legacy, current);
  const root = join(current, "runtime");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

async function readManifest(root: string): Promise<PluginManifest> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "plugins.json"), "utf8")) as PluginManifest;
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.plugins)) throw new Error();
    return manifest;
  } catch {
    return { schemaVersion: 1, plugins: [] };
  }
}

async function writeManifest(root: string, manifest: PluginManifest, action: string): Promise<void> {
  const manifestPath = join(root, "plugins.json");
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, manifestPath);
  const entries = manifest.plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.resolvedPath,
    config: {}
  }));
  const configPath = join(root, "plugins.yml");
  const configTemporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(configTemporary, stringifyYaml(entries), { mode: 0o600 });
  await rename(configTemporary, configPath);
  await appendFile(join(root, "plugin-audit.jsonl"), `${JSON.stringify({
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    action,
    manifestDigest: sha256(JSON.stringify(manifest))
  })}\n`, { mode: 0o600 });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactNpmName(specifier: string): { name: string; version: string } {
  const match = /^(?<name>@[^/]+\/[^@]+|[^@/]+)@(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(specifier);
  if (!match?.groups) throw new TypeError("npm plugins require an exact name@x.y.z version");
  return { name: match.groups.name!, version: match.groups.version! };
}

async function resolveInstalledPlugin(root: string, specifier: string): Promise<PluginRecord> {
  const candidate = resolve(specifier);
  if (existsSync(candidate)) {
    const metadata = await stat(candidate);
    let version = "0.0.0-local";
    if (metadata.isDirectory()) {
      const packageJson = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof packageJson.version === "string") version = packageJson.version;
    }
    const integrity = metadata.isFile()
      ? `sha256-${sha256(await readFile(candidate))}`
      : `sha256-${sha256(await readFile(join(candidate, "package.json")))}`;
    return {
      id: basename(candidate),
      source: "local",
      specifier,
      resolvedPath: candidate,
      version,
      integrity,
      installedAt: new Date().toISOString()
    };
  }

  const exact = exactNpmName(specifier);
  const installRoot = join(root, "npm");
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  await execFileAsync(process.env.npm_execpath ? process.execPath : "npm", [
    ...(process.env.npm_execpath ? [process.env.npm_execpath] : []),
    "install",
    "--prefix",
    installRoot,
    "--save-exact",
    specifier
  ]);
  const lock = JSON.parse(await readFile(join(installRoot, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string; integrity?: string }>;
  };
  const locked = lock.packages?.[`node_modules/${exact.name}`];
  if (locked?.version !== exact.version || !locked.integrity) {
    throw new Error("npm did not produce the requested exact plugin lock and integrity hash");
  }
  return {
    id: exact.name,
    source: "npm",
    specifier,
    resolvedPath: join(installRoot, "node_modules", exact.name),
    version: exact.version,
    integrity: locked.integrity,
    installedAt: new Date().toISOString()
  };
}

export async function pluginCommand(
  subcommand: string | undefined,
  args: readonly string[]
): Promise<void> {
  if (subcommand === "list") {
    const root = await runtimeRoot();
    printJson({ installed: (await readManifest(root)).plugins, active: await requestJson("/v1/runtime/plugins") });
    return;
  }
  if (subcommand === "reload") {
    printJson(await requestJson("/v1/runtime/plugins/reload", { method: "POST", body: {} }));
    return;
  }
  const specifier = args[0];
  if (!specifier) throw new TypeError(`plugin ${subcommand ?? "command"} requires a plugin specifier`);
  const root = await runtimeRoot();
  const manifest = await readManifest(root);
  if (subcommand === "install") {
    const plugin = await resolveInstalledPlugin(root, specifier);
    const next = manifest.plugins.filter((entry) => entry.id !== plugin.id);
    next.push(plugin);
    next.sort((left, right) => left.id.localeCompare(right.id));
    await writeManifest(root, { schemaVersion: 1, plugins: next }, "plugin.install");
    printJson({ installed: plugin, trustedCode: true, reloadRequired: true });
    return;
  }
  if (subcommand === "remove") {
    const next = manifest.plugins.filter((entry) => entry.id !== specifier && entry.specifier !== specifier);
    if (next.length === manifest.plugins.length) throw new Error(`plugin not installed: ${specifier}`);
    await writeManifest(root, { schemaVersion: 1, plugins: next }, "plugin.remove");
    printJson({ removed: specifier, reloadRequired: true });
    return;
  }
  throw new TypeError("plugin command must be list, install, remove, or reload");
}

export async function profileCommand(
  subcommand: string | undefined,
  args: readonly string[]
): Promise<void> {
  if (subcommand === "inspect") {
    printJson(await requestJson("/v1/runtime/profiles"));
    return;
  }
  if (subcommand !== "validate") throw new TypeError("profile command must be validate or inspect");
  const file = option(args, "--file");
  if (!file) {
    printJson({ valid: true, runtime: await requestJson("/v1/runtime/profiles") });
    return;
  }
  const raw = await readFile(resolve(file), "utf8");
  const value = parseYaml(raw) as unknown;
  if (!Array.isArray(value) || value.some((entry) =>
    !entry || typeof entry !== "object" ||
    typeof (entry as Record<string, unknown>).id !== "string" ||
    typeof (entry as Record<string, unknown>).name !== "string")) {
    throw new TypeError("profile must be an array of entries with string id and name fields");
  }
  printJson({ valid: true, path: resolve(file), entries: value.length, digest: sha256(raw) });
}
