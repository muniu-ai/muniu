import type {
  CodexProviderMode,
  ProviderRecord,
  ProviderSecretRef
} from "@mn/provider-catalog";

export interface SecretResolveOptions {
  env?: NodeJS.ProcessEnv;
  secretResolver?: (secretRef: ProviderSecretRef) => Promise<string | undefined>;
}

export interface ConfigProjectionOptions extends SecretResolveOptions {
  homeDir: string;
  mniuRoot?: string;
  dryRun?: boolean;
  now?: Date;
}

export interface CodexProjectionOptions extends ConfigProjectionOptions {
  mode?: CodexProviderMode;
}

export interface ConfigProjectionResult {
  providerId: string;
  app: "claude" | "codex";
  targetPath: string;
  backupPath?: string;
  liveConfigHash: string;
  changed: boolean;
  dryRun: boolean;
  warnings: string[];
  projectedConfig: string;
  files?: ConfigProjectionFile[];
  filePreviews?: ConfigProjectionPreview[];
}

export interface ConfigProjectionFile {
  targetPath: string;
  backupPath?: string;
  liveConfigHash: string;
}

export interface ConfigProjectionPreview {
  targetPath: string;
  before: string;
  after: string;
}

export interface LiveConfigReadResult {
  path: string;
  exists: boolean;
  content: string;
}

export type ManagedEnvName =
  | "ANTHROPIC_API_KEY"
  | "ANTHROPIC_BASE_URL"
  | "OPENAI_API_KEY";

export interface EnvConflict {
  name: ManagedEnvName;
  maskedValue: string;
  source: "process.env" | "shell_profile" | "launch_agent" | "ide_settings";
  sourcePath?: string;
  line?: number;
}

export interface ProviderProjectionInput {
  provider: ProviderRecord;
}
