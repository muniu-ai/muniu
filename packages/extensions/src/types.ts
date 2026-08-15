import type { ManagedAgentApp } from "@mn/provider-catalog";

export type ExtensionAppScope = ManagedAgentApp | "unified";

export interface McpServerRecord {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  apps: ManagedAgentApp[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerCreateInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  apps?: ManagedAgentApp[];
  enabled?: boolean;
}

export interface McpServerUpdateInput {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  apps?: ManagedAgentApp[];
  enabled?: boolean;
}

export interface PromptPresetRecord {
  id: string;
  name: string;
  content: string;
  apps: ManagedAgentApp[];
  createdAt: string;
  updatedAt: string;
}

export interface PromptPresetCreateInput {
  name: string;
  content: string;
  apps?: ManagedAgentApp[];
}

export interface PromptPresetUpdateInput {
  name?: string;
  content?: string;
  apps?: ManagedAgentApp[];
}

export interface PromptActivationRecord {
  id: string;
  promptId: string;
  app: ManagedAgentApp;
  targetPath: string;
  liveConfigHash: string;
  backupPath?: string;
  activatedAt: string;
}

export interface ExtensionProjectionOptions {
  homeDir: string;
  mniuRoot?: string;
  dryRun?: boolean;
  now?: Date;
}

export interface McpProjectionOptions extends ExtensionProjectionOptions {
  apps?: ManagedAgentApp[];
}

export interface ExtensionProjectionResult {
  app: ManagedAgentApp;
  targetPath: string;
  backupPath?: string;
  liveConfigHash: string;
  changed: boolean;
  dryRun: boolean;
  projectedConfig: string;
}

export interface PromptActivationOptions extends ExtensionProjectionOptions {
  app: ManagedAgentApp;
  previousActivation?: PromptActivationRecord;
}

export interface PromptBackfill {
  promptId: string;
  app: ManagedAgentApp;
  content: string;
  liveConfigHash: string;
}

export interface PromptActivationResult extends ExtensionProjectionResult {
  promptId: string;
  backfill?: PromptBackfill;
}

export type SkillSyncMode = "copy" | "symlink";

export interface SkillRecord {
  id: string;
  name: string;
  sourcePath: string;
  description?: string;
  version?: string;
  apps: ManagedAgentApp[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillCreateInput {
  name: string;
  sourcePath: string;
  description?: string;
  version?: string;
  apps?: ManagedAgentApp[];
  enabled?: boolean;
}

export interface SkillUpdateInput {
  name?: string;
  sourcePath?: string;
  description?: string;
  version?: string;
  apps?: ManagedAgentApp[];
  enabled?: boolean;
}

export interface SkillInstallationRecord {
  id: string;
  skillId: string;
  app: ManagedAgentApp;
  mode: SkillSyncMode;
  sourcePath: string;
  targetPath: string;
  installedHash: string;
  backupPath?: string;
  installedAt: string;
  updatedAt: string;
}

export interface SkillInstallOptions extends ExtensionProjectionOptions {
  app: ManagedAgentApp;
  mode?: SkillSyncMode;
}

export interface SkillUninstallOptions extends ExtensionProjectionOptions {
  app: ManagedAgentApp;
  installation?: SkillInstallationRecord;
}

export interface SkillSyncResult {
  skillId: string;
  app: ManagedAgentApp;
  mode?: SkillSyncMode;
  sourcePath?: string;
  targetPath: string;
  backupPath?: string;
  installedHash?: string;
  changed: boolean;
  dryRun: boolean;
  action: "install" | "uninstall";
}

export interface SkillSourceCandidate {
  name: string;
  sourcePath: string;
  sourceRoot: "mniu" | "agents";
  description?: string;
  version?: string;
}

export interface SkillRegistryFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface SkillRegistryEntry {
  name: string;
  version: string;
  files: SkillRegistryFile[];
  sha256: string;
  signature?: string;
  publicKeyId?: string;
  description?: string;
  apps?: ManagedAgentApp[];
}

export interface SkillRegistryPublicKey {
  id: string;
  publicKey: string;
  status?: "active" | "retired" | "revoked";
}

export interface SkillRegistryTrustProfileInput {
  name: string;
  registryUrl: string;
  requireSignature?: boolean;
  requireReleaseMetadata?: boolean;
  publicKey?: string;
  trustedPublicKeys?: SkillRegistryPublicKey[];
  revokedPublicKeyIds?: string[];
}

export interface SkillRegistryTrustProfileRecord
  extends SkillRegistryTrustProfileInput {
  id: string;
  requireSignature: boolean;
  requireReleaseMetadata: boolean;
  trustedPublicKeys: SkillRegistryPublicKey[];
  revokedPublicKeyIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillRegistryReleaseMetadata {
  version: 1;
  sequence: number;
  issuedAt: string;
  expiresAt?: string;
  registrySha256: string;
  signature?: string;
  publicKeyId?: string;
}

export interface SkillRegistryIndex {
  version: 1;
  skills: SkillRegistryEntry[];
  publicKey?: string;
  publicKeys?: SkillRegistryPublicKey[];
  revokedPublicKeyIds?: string[];
  signatureAlgorithm?: "ed25519";
  releaseMetadata?: SkillRegistryReleaseMetadata;
}

export interface SkillRegistrySyncOptions {
  registryUrl: string;
  homeDir: string;
  mniuRoot?: string;
  dryRun?: boolean;
  installedSkills?: SkillRecord[];
  requireSignature?: boolean;
  requireReleaseMetadata?: boolean;
  publicKey?: string;
  trustedPublicKeys?: SkillRegistryPublicKey[];
  revokedPublicKeyIds?: string[];
  now?: Date;
}

export type SkillRegistrySyncStatus = "new" | "update" | "refresh" | "current" | "downgrade";

export interface SkillRegistrySyncSkillResult {
  name: string;
  version: string;
  description?: string;
  apps: ManagedAgentApp[];
  sourcePath: string;
  sha256: string;
  status: SkillRegistrySyncStatus;
  changed: boolean;
  applied: boolean;
  dryRun: boolean;
  signatureVerified: boolean;
  publicKeyId?: string;
  existingVersion?: string;
  backupPath?: string;
}

export interface SkillRegistryReleaseVerificationResult {
  sequence: number;
  issuedAt: string;
  expiresAt?: string;
  registrySha256: string;
  signatureVerified: boolean;
  publicKeyId?: string;
}

export interface SkillRegistrySyncResult {
  registryUrl: string;
  dryRun: boolean;
  releaseMetadata?: SkillRegistryReleaseVerificationResult;
  skills: SkillRegistrySyncSkillResult[];
}
