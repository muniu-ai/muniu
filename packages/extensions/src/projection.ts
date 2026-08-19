import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseToml, stringifyToml, type TomlValue } from "@mn/config-manager";
import type { ManagedAgentApp } from "@mn/provider-catalog";
import type {
  ExtensionProjectionResult,
  McpProjectionOptions,
  McpServerRecord,
  PromptActivationOptions,
  PromptActivationResult,
  PromptPresetRecord
} from "./types.js";

interface ClaudeMcpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function projectMcpServer(
  server: McpServerRecord,
  options: McpProjectionOptions
): Promise<ExtensionProjectionResult[]> {
  const apps = (options.apps ?? server.apps).filter((app) => server.apps.includes(app));
  const results: ExtensionProjectionResult[] = [];
  for (const app of uniqueApps(apps)) {
    results.push(await projectMcpServerForApp(server, app, options));
  }
  return results;
}

export async function activatePromptPreset(
  preset: PromptPresetRecord,
  options: PromptActivationOptions
): Promise<PromptActivationResult> {
  if (!preset.apps.includes(options.app)) {
    throw new Error(`${preset.name} is not bound to ${options.app}`);
  }
  const targetPath = promptPath(options.homeDir, options.app);
  const previous = await readTextIfExists(targetPath);
  const previousHash = sha256(previous ?? "");
  const backfill = options.previousActivation &&
    previous !== undefined &&
    previousHash !== options.previousActivation.liveConfigHash
    ? {
        promptId: options.previousActivation.promptId,
        app: options.app,
        content: previous,
        liveConfigHash: previousHash
      }
    : undefined;
  const projectedConfig = normalizePromptContent(preset.content);
  const changed = projectedConfig !== (previous ?? "");
  let backupPath: string | undefined;
  if (!options.dryRun && changed) {
    backupPath = await backupFileIfExists(
      targetPath,
      backupRoot(options),
      `${options.app}-prompt`,
      options.now
    );
    await atomicWriteText(targetPath, projectedConfig);
  }
  return {
    promptId: preset.id,
    app: options.app,
    targetPath,
    backupPath,
    liveConfigHash: sha256(projectedConfig),
    changed,
    dryRun: options.dryRun ?? false,
    projectedConfig,
    ...(backfill ? { backfill } : {})
  };
}

export async function readPromptLiveFile(
  homeDir: string,
  app: ManagedAgentApp
): Promise<{ path: string; exists: boolean; content: string; liveConfigHash: string }> {
  const path = promptPath(homeDir, app);
  const content = await readTextIfExists(path);
  return {
    path,
    exists: content !== undefined,
    content: content ?? "",
    liveConfigHash: sha256(content ?? "")
  };
}

async function projectMcpServerForApp(
  server: McpServerRecord,
  app: ManagedAgentApp,
  options: McpProjectionOptions
): Promise<ExtensionProjectionResult> {
  if (app === "claude") return projectClaudeMcpServer(server, options);
  return projectCodexMcpServer(server, options);
}

async function projectClaudeMcpServer(
  server: McpServerRecord,
  options: McpProjectionOptions
): Promise<ExtensionProjectionResult> {
  const targetPath = join(options.homeDir, ".claude.json");
  const previous = await readTextIfExists(targetPath);
  const config = parseClaudeMcpConfig(previous);
  const mcpServers = {
    ...(config.mcpServers ?? {})
  };
  if (server.enabled) {
    mcpServers[server.name] = {
      command: server.command,
      args: server.args,
      env: server.env
    };
  } else {
    delete mcpServers[server.name];
  }
  config.mcpServers = mcpServers;
  const projectedConfig = `${JSON.stringify(config, null, 2)}\n`;
  return writeProjection({
    app: "claude",
    targetPath,
    previous,
    projectedConfig,
    backupLabel: "claude-mcp",
    options
  });
}

async function projectCodexMcpServer(
  server: McpServerRecord,
  options: McpProjectionOptions
): Promise<ExtensionProjectionResult> {
  const targetPath = join(options.homeDir, ".codex", "config.toml");
  const previous = await readTextIfExists(targetPath);
  const document = parseToml(previous ?? "");
  const tableName = `mcp_servers.${codexTableId(server.name)}`;
  const envTableName = `${tableName}.env`;
  if (server.enabled) {
    const table: Record<string, TomlValue> = {
      ...(document.tables[tableName] ?? {}),
      command: server.command,
      args: server.args
    };
    delete table.name;
    delete table.args_json;
    delete table.env_json;
    document.tables[tableName] = table;
    if (Object.keys(server.env).length > 0) {
      document.tables[envTableName] = server.env;
    } else {
      delete document.tables[envTableName];
    }
  } else {
    deleteTomlTablePrefix(document, tableName);
  }
  const projectedConfig = stringifyToml(document);
  return writeProjection({
    app: "codex",
    targetPath,
    previous,
    projectedConfig,
    backupLabel: "codex-mcp",
    options
  });
}

function deleteTomlTablePrefix(
  document: ReturnType<typeof parseToml>,
  tableName: string
): void {
  for (const name of Object.keys(document.tables)) {
    if (name === tableName || name.startsWith(`${tableName}.`)) {
      delete document.tables[name];
    }
  }
}

async function writeProjection(input: {
  app: ManagedAgentApp;
  targetPath: string;
  previous: string | undefined;
  projectedConfig: string;
  backupLabel: string;
  options: McpProjectionOptions;
}): Promise<ExtensionProjectionResult> {
  const changed = input.projectedConfig !== (input.previous ?? "");
  let backupPath: string | undefined;
  if (!input.options.dryRun && changed) {
    backupPath = await backupFileIfExists(
      input.targetPath,
      backupRoot(input.options),
      input.backupLabel,
      input.options.now
    );
    await atomicWriteText(input.targetPath, input.projectedConfig);
  }
  return {
    app: input.app,
    targetPath: input.targetPath,
    backupPath,
    liveConfigHash: sha256(input.projectedConfig),
    changed,
    dryRun: input.options.dryRun ?? false,
    projectedConfig: input.projectedConfig
  };
}

function parseClaudeMcpConfig(raw: string | undefined): ClaudeMcpConfig {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as ClaudeMcpConfig;
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new Error("Claude mcpServers must be an object");
  }
  return parsed;
}

function promptPath(homeDir: string, app: ManagedAgentApp): string {
  return app === "claude"
    ? join(homeDir, ".claude", "CLAUDE.md")
    : join(homeDir, ".codex", "AGENTS.md");
}

function normalizePromptContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content);
  await rename(tempPath, path);
}

async function backupFileIfExists(
  path: string,
  root: string,
  label: string,
  now = new Date()
): Promise<string | undefined> {
  const current = await readTextIfExists(path);
  if (current === undefined) return undefined;
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const backupDir = join(root, safeLabel);
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `${timestamp(now)}.bak`);
  await copyFile(path, backupPath);
  return backupPath;
}

function backupRoot(options: { homeDir: string; mniuRoot?: string }): string {
  return join(options.mniuRoot ?? join(options.homeDir, ".muniu"), "backups");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function codexTableId(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function uniqueApps(apps: ManagedAgentApp[]): ManagedAgentApp[] {
  return Array.from(new Set(apps));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
