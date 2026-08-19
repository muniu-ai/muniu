import { join } from "node:path";
import { assertProviderSupportsApp } from "@mn/provider-catalog";
import type { ProviderRecord } from "@mn/provider-catalog";
import {
  atomicWriteText,
  backupFileIfExists,
  readTextIfExists,
  sha256
} from "./fs.js";
import { resolveProviderSecret } from "./secrets.js";
import type {
  ConfigProjectionOptions,
  ConfigProjectionResult,
  LiveConfigReadResult
} from "./types.js";

interface ClaudeSettings {
  env?: Record<string, string>;
  skipIntroduction?: boolean;
  [key: string]: unknown;
}

export async function readClaudeLiveConfig(
  homeDir: string
): Promise<LiveConfigReadResult> {
  const path = claudeSettingsPath(homeDir);
  const content = await readTextIfExists(path);
  return {
    path,
    exists: content !== undefined,
    content: content ?? ""
  };
}

export async function projectClaudeProvider(
  provider: ProviderRecord,
  options: ConfigProjectionOptions
): Promise<ConfigProjectionResult> {
  assertProviderSupportsApp(provider, "claude");
  const targetPath = claudeSettingsPath(options.homeDir);
  const previous = await readTextIfExists(targetPath);
  const settings = parseSettings(previous);
  const secret = await resolveProviderSecret(provider.apiKeyRef, options);
  const warnings: string[] = [];

  settings.env = { ...(settings.env ?? {}) };
  settings.env.ANTHROPIC_BASE_URL = provider.baseUrl;
  if (secret) {
    settings.env.ANTHROPIC_API_KEY = secret;
  } else if (provider.apiKeyRef) {
    warnings.push(`secret ${provider.apiKeyRef.type}:${provider.apiKeyRef.ref} was not resolved`);
  }
  settings.skipIntroduction = true;

  const projectedConfig = `${JSON.stringify(settings, null, 2)}\n`;
  const changed = projectedConfig !== (previous ?? "");
  let backupPath: string | undefined;
  if (!options.dryRun && changed) {
    backupPath = await backupFileIfExists(
      targetPath,
      join(options.mniuRoot ?? join(options.homeDir, ".muniu"), "backups"),
      "claude-settings",
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
    warnings,
    projectedConfig,
    files: changed ? [{ targetPath, backupPath, liveConfigHash: sha256(projectedConfig) }] : [],
    filePreviews: changed
      ? [{ targetPath, before: previous ?? "", after: projectedConfig }]
      : []
  };
}

function claudeSettingsPath(homeDir: string): string {
  return join(homeDir, ".claude", "settings.json");
}

function parseSettings(raw: string | undefined): ClaudeSettings {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as ClaudeSettings;
  if (parsed.env && typeof parsed.env !== "object") {
    throw new Error("Claude settings env must be an object");
  }
  return parsed;
}
