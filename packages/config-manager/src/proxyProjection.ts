import { join } from "node:path";
import type { ProviderRecord } from "@mn/provider-catalog";
import {
  atomicWriteText,
  backupFileIfExists,
  readTextIfExists,
  removeFileIfExists,
  sha256
} from "./fs.js";
import { parseToml, stringifyToml } from "./toml.js";
import type { ConfigProjectionOptions, ConfigProjectionResult } from "./types.js";

export interface ProxyProjectionOptions extends ConfigProjectionOptions {
  proxyBaseUrl: string;
}

export interface RestoreProjectionOptions {
  targetPath: string;
  expectedLiveConfigHash: string;
  backupPath?: string;
  dryRun?: boolean;
}

export interface RestoreProjectionResult {
  targetPath: string;
  restored: boolean;
  removed: boolean;
  dryRun: boolean;
  liveConfigHash: string;
  conflict: boolean;
  reason?: "live_config_changed" | "missing_target_path";
}

export interface RestoreProjectionSetResult {
  files: RestoreProjectionResult[];
  dryRun: boolean;
  conflict: boolean;
}

interface ClaudeSettings {
  env?: Record<string, string>;
  skipIntroduction?: boolean;
  [key: string]: unknown;
}

export async function projectClaudeProxyConfig(
  provider: ProviderRecord,
  options: ProxyProjectionOptions
): Promise<ConfigProjectionResult> {
  const targetPath = join(options.homeDir, ".claude", "settings.json");
  const previous = await readTextIfExists(targetPath);
  const settings = parseClaudeSettings(previous);
  settings.env = { ...(settings.env ?? {}) };
  settings.env.ANTHROPIC_BASE_URL = options.proxyBaseUrl;
  settings.env.ANTHROPIC_API_KEY =
    settings.env.ANTHROPIC_API_KEY ?? "mniu-local-proxy";
  settings.skipIntroduction = true;

  const projectedConfig = `${JSON.stringify(settings, null, 2)}\n`;
  const changed = projectedConfig !== (previous ?? "");
  let backupPath: string | undefined;
  if (!options.dryRun && changed) {
    backupPath = await backupFileIfExists(
      targetPath,
      join(options.mniuRoot ?? join(options.homeDir, ".muniu"), "backups"),
      "claude-proxy-takeover",
      options.now
    );
    await atomicWriteText(targetPath, projectedConfig);
  }

  return {
    providerId: provider.id,
    app: "claude",
    targetPath,
    backupPath,
    liveConfigHash: sha256(projectedConfig),
    changed,
    dryRun: options.dryRun ?? false,
    warnings: [],
    projectedConfig,
    filePreviews: changed
      ? [{ targetPath, before: previous ?? "", after: projectedConfig }]
      : []
  };
}

export async function projectCodexProxyConfig(
  provider: ProviderRecord,
  options: ProxyProjectionOptions
): Promise<ConfigProjectionResult> {
  const targetPath = join(options.homeDir, ".codex", "config.toml");
  const previous = await readTextIfExists(targetPath);
  const document = parseToml(previous ?? "");
  const providerTableId = `mniu_proxy_${provider.id.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const providerTable = `model_providers.${providerTableId}`;

  document.values.model_provider = providerTableId;
  document.values.model = provider.defaultModel;
  document.values.model_reasoning_effort =
    provider.modelReasoningEffort ?? "medium";
  document.values.disable_response_storage =
    provider.disableResponseStorage ?? true;
  document.tables[providerTable] = {
    name: `木牛本地代理 · ${provider.name}`,
    base_url: `${options.proxyBaseUrl.replace(/\/+$/, "")}/v1`,
    wire_api: "responses",
    experimental_bearer_token: "mniu-local-proxy",
    model_catalog_json: JSON.stringify({
      models: provider.modelCatalog.map((model) => ({
        id: model.id,
        name: model.displayName
      }))
    })
  };
  document.tables.features = {
    ...(document.tables.features ?? {}),
    goals: true
  };

  const projectedConfig = stringifyToml(document);
  const changed = projectedConfig !== (previous ?? "");
  let backupPath: string | undefined;
  if (!options.dryRun && changed) {
    backupPath = await backupFileIfExists(
      targetPath,
      join(options.mniuRoot ?? join(options.homeDir, ".muniu"), "backups"),
      "codex-proxy-takeover",
      options.now
    );
    await atomicWriteText(targetPath, projectedConfig);
  }

  return {
    providerId: provider.id,
    app: "codex",
    targetPath,
    backupPath,
    liveConfigHash: sha256(projectedConfig),
    changed,
    dryRun: options.dryRun ?? false,
    warnings: [],
    projectedConfig,
    filePreviews: changed
      ? [{ targetPath, before: previous ?? "", after: projectedConfig }]
      : []
  };
}

export async function restoreLiveConfigProjection(
  options: RestoreProjectionOptions
): Promise<RestoreProjectionResult> {
  const current = await readTextIfExists(options.targetPath);
  const liveConfigHash = sha256(current ?? "");
  if (liveConfigHash !== options.expectedLiveConfigHash) {
    return {
      targetPath: options.targetPath,
      restored: false,
      removed: false,
      dryRun: options.dryRun ?? false,
      liveConfigHash,
      conflict: true,
      reason: "live_config_changed"
    };
  }

  if (options.dryRun) {
    return {
      targetPath: options.targetPath,
      restored: true,
      removed: !options.backupPath,
      dryRun: true,
      liveConfigHash,
      conflict: false
    };
  }

  if (options.backupPath) {
    const backup = await readTextIfExists(options.backupPath);
    await atomicWriteText(options.targetPath, backup ?? "");
    return {
      targetPath: options.targetPath,
      restored: true,
      removed: false,
      dryRun: false,
      liveConfigHash: sha256(backup ?? ""),
      conflict: false
    };
  }

  await removeFileIfExists(options.targetPath);
  return {
    targetPath: options.targetPath,
    restored: true,
    removed: true,
    dryRun: false,
    liveConfigHash: sha256(""),
    conflict: false
  };
}

export async function restoreLiveConfigProjectionSet(
  files: RestoreProjectionOptions[],
  dryRun = false
): Promise<RestoreProjectionSetResult> {
  const previews = await Promise.all(
    files.map((file) => restoreLiveConfigProjection({ ...file, dryRun: true }))
  );
  if (previews.some((result) => result.conflict) || dryRun) {
    return {
      files: previews,
      dryRun,
      conflict: previews.some((result) => result.conflict)
    };
  }

  const snapshots = await Promise.all(
    files.map(async (file) => ({
      targetPath: file.targetPath,
      content: await readTextIfExists(file.targetPath)
    }))
  );
  try {
    const results: RestoreProjectionResult[] = [];
    for (const file of files) {
      results.push(await restoreLiveConfigProjection({ ...file, dryRun: false }));
    }
    return { files: results, dryRun: false, conflict: false };
  } catch (error) {
    await Promise.all(
      snapshots.map(async (snapshot) => {
        if (snapshot.content === undefined) await removeFileIfExists(snapshot.targetPath);
        else await atomicWriteText(snapshot.targetPath, snapshot.content);
      })
    );
    throw error;
  }
}

function parseClaudeSettings(raw: string | undefined): ClaudeSettings {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as ClaudeSettings;
  if (parsed.env && typeof parsed.env !== "object") {
    throw new Error("Claude settings env must be an object");
  }
  return parsed;
}
