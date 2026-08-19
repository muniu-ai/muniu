import { join } from "node:path";
import { assertProviderSupportsApp } from "@mn/provider-catalog";
import type { CodexProviderMode, ProviderRecord } from "@mn/provider-catalog";
import {
  atomicWriteText,
  backupFileIfExists,
  readTextIfExists,
  removeFileIfExists,
  sha256
} from "./fs.js";
import { resolveProviderSecret } from "./secrets.js";
import { parseToml, stringifyToml } from "./toml.js";
import type {
  CodexProjectionOptions,
  ConfigProjectionResult,
  LiveConfigReadResult
} from "./types.js";

export async function readCodexLiveConfig(
  homeDir: string
): Promise<LiveConfigReadResult> {
  const path = codexConfigPath(homeDir);
  const content = await readTextIfExists(path);
  return {
    path,
    exists: content !== undefined,
    content: content ?? ""
  };
}

export async function projectCodexProvider(
  provider: ProviderRecord,
  options: CodexProjectionOptions
): Promise<ConfigProjectionResult> {
  assertProviderSupportsApp(provider, "codex");
  const targetPath = codexConfigPath(options.homeDir);
  const previous = await readTextIfExists(targetPath);
  const document = parseToml(previous ?? "");
  const secret = await resolveProviderSecret(provider.apiKeyRef, options);
  const warnings: string[] = [];
  const mode = options.mode ?? defaultCodexMode(provider);
  const providerTableId = codexProviderTableId(provider.id);
  const providerTable = `model_providers.${providerTableId}`;

  document.values.model_provider = providerTableId;
  document.values.model = provider.defaultModel;
  document.values.model_reasoning_effort =
    provider.modelReasoningEffort ?? "medium";
  document.values.disable_response_storage =
    provider.disableResponseStorage ?? true;

  document.tables[providerTable] = {
    name: provider.name,
    base_url: provider.baseUrl,
    wire_api: provider.wireApi ?? inferWireApi(provider),
    model_catalog_json: JSON.stringify({
      models: provider.modelCatalog.map((model) => ({
        id: model.id,
        name: model.displayName
      }))
    })
  };
  if (secret) {
    document.tables[providerTable].experimental_bearer_token = secret;
  } else if (provider.apiKeyRef) {
    warnings.push(`secret ${provider.apiKeyRef.type}:${provider.apiKeyRef.ref} was not resolved`);
  }

  document.tables.features = {
    ...(document.tables.features ?? {}),
    goals: true
  };

  const projectedConfig = stringifyToml(document);
  const configChanged = projectedConfig !== (previous ?? "");
  const authPath = codexAuthPath(options.homeDir);
  const previousAuth = await readTextIfExists(authPath);
  const projectedAuth =
    mode === "api_key_auth_file" && secret
      ? `${JSON.stringify({ OPENAI_API_KEY: secret }, null, 2)}\n`
      : undefined;
  if (mode === "api_key_auth_file" && !secret) {
    warnings.push("api_key_auth_file mode requested but no secret was resolved");
  }
  const authChanged = projectedAuth !== undefined && projectedAuth !== (previousAuth ?? "");
  const changed = configChanged || authChanged;
  let backupPath: string | undefined;
  let authBackupPath: string | undefined;
  if (!options.dryRun && configChanged) {
    backupPath = await backupFileIfExists(
      targetPath,
      join(options.mniuRoot ?? join(options.homeDir, ".muniu"), "backups"),
      "codex-config",
      options.now
    );
  }
  if (!options.dryRun && authChanged) {
    authBackupPath = await backupFileIfExists(
      authPath,
      join(options.mniuRoot ?? join(options.homeDir, ".muniu"), "backups"),
      "codex-auth",
      options.now
    );
  }
  if (!options.dryRun && changed) {
    try {
      if (configChanged) await atomicWriteText(targetPath, projectedConfig);
      if (authChanged && projectedAuth !== undefined) await atomicWriteText(authPath, projectedAuth);
    } catch (error) {
      await restoreSnapshot(targetPath, previous);
      await restoreSnapshot(authPath, previousAuth);
      throw error;
    }
  }

  return {
    providerId: provider.id,
    app: "codex",
    targetPath,
    backupPath,
    liveConfigHash: sha256(projectedConfig),
    changed,
    dryRun: options.dryRun ?? false,
    warnings,
    projectedConfig,
    files: [
      ...(configChanged
        ? [{ targetPath, backupPath, liveConfigHash: sha256(projectedConfig) }]
        : []),
      ...(authChanged && projectedAuth !== undefined
        ? [{ targetPath: authPath, backupPath: authBackupPath, liveConfigHash: sha256(projectedAuth) }]
        : [])
    ],
    filePreviews: [
      ...(configChanged
        ? [{ targetPath, before: previous ?? "", after: projectedConfig }]
        : []),
      ...(authChanged && projectedAuth !== undefined
        ? [{ targetPath: authPath, before: previousAuth ?? "", after: projectedAuth }]
        : [])
    ]
  };
}

function codexConfigPath(homeDir: string): string {
  return join(homeDir, ".codex", "config.toml");
}

function codexAuthPath(homeDir: string): string {
  return join(homeDir, ".codex", "auth.json");
}

function codexProviderTableId(providerId: string): string {
  return providerId.replace(/[^A-Za-z0-9_]/g, "_");
}

function inferWireApi(provider: ProviderRecord): "responses" | "chat" {
  return provider.apiFormat === "openai_responses" ? "responses" : "chat";
}

function defaultCodexMode(provider: ProviderRecord): CodexProviderMode {
  return provider.kind === "official" ? "official" : "third_party_preserve_auth";
}

async function restoreSnapshot(path: string, content: string | undefined): Promise<void> {
  if (content === undefined) await removeFileIfExists(path);
  else await atomicWriteText(path, content);
}
