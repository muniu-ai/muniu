import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedAgentApp } from "@mn/provider-catalog";
import type {
  SkillRegistryEntry,
  SkillRegistryFile,
  SkillRegistryIndex,
  SkillRegistryPublicKey,
  SkillRegistryReleaseMetadata,
  SkillRegistrySyncOptions,
  SkillRegistrySyncResult,
  SkillRegistrySyncSkillResult,
  SkillInstallOptions,
  SkillRecord,
  SkillSourceCandidate,
  SkillSyncMode,
  SkillSyncResult,
  SkillUninstallOptions
} from "./types.js";

export async function discoverSkillSources(options: {
  homeDir: string;
  mniuRoot?: string;
}): Promise<SkillSourceCandidate[]> {
  const roots: Array<{ root: string; sourceRoot: SkillSourceCandidate["sourceRoot"] }> = [
    { root: join(options.mniuRoot ?? join(options.homeDir, ".muniu"), "skills"), sourceRoot: "mniu" },
    { root: join(options.homeDir, ".agents", "skills"), sourceRoot: "agents" }
  ];
  const candidates: SkillSourceCandidate[] = [];
  for (const { root, sourceRoot } of roots) {
    for (const sourcePath of await listChildDirectories(root)) {
      if (!(await pathExists(join(sourcePath, "SKILL.md")))) continue;
      const metadata = await readSkillMetadata(sourcePath);
      candidates.push({
        name: metadata.name ?? basename(sourcePath),
        sourcePath,
        sourceRoot,
        ...(metadata.description ? { description: metadata.description } : {}),
        ...(metadata.version ? { version: metadata.version } : {})
      });
    }
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

export async function syncSkillRegistry(
  options: SkillRegistrySyncOptions
): Promise<SkillRegistrySyncResult> {
  const registry = await readSkillRegistryIndex(options.registryUrl);
  const mniuRoot = options.mniuRoot ?? join(options.homeDir, ".muniu");
  const trustPolicy = buildSkillRegistryTrustPolicy(registry, options);
  const releaseMetadata = verifySkillRegistryReleaseMetadata(registry, trustPolicy, options);
  const installedSkills = options.installedSkills ?? [];
  const results: SkillRegistrySyncSkillResult[] = [];

  for (const entry of registry.skills) {
    const normalized = normalizeSkillRegistryEntry(entry);
    const sha256 = hashSkillRegistryFiles(normalized.files);
    if (sha256 !== normalized.sha256) {
      throw new Error(`Skill registry hash mismatch for ${normalized.name}`);
    }
    const signatureVerification = verifySkillRegistryEntrySignature(normalized, trustPolicy);
    if (normalized.signature && !signatureVerification.verified) {
      throw new Error(`Skill registry signature mismatch for ${normalized.name}`);
    }
    if (options.requireSignature && !signatureVerification.verified) {
      throw new Error(`Skill registry signature required for ${normalized.name}`);
    }

    const sourcePath = join(mniuRoot, "skills", skillFolderName(normalized.name));
    const existingSkill = installedSkills.find((skill) => skill.name === normalized.name);
    const existingVersion = existingSkill?.version;
    const versionComparison = existingVersion
      ? compareVersions(normalized.version, existingVersion)
      : 1;
    const targetHash = await hashTarget(sourcePath);
    const expectedTargetHash = `dir:${sha256}`;
    const status = skillRegistrySyncStatus({
      hasExisting: Boolean(existingSkill),
      versionComparison,
      targetHash,
      expectedTargetHash,
      existingSourcePath: existingSkill?.sourcePath,
      sourcePath
    });
    const changed = status === "new" || status === "update" || status === "refresh";
    let backupPath: string | undefined;

    if (changed && !options.dryRun) {
      backupPath = await writeSkillRegistrySource({
        sourcePath,
        files: normalized.files,
        mniuRoot,
        name: normalized.name,
        now: options.now
      });
    }

    results.push({
      name: normalized.name,
      version: normalized.version,
      ...(normalized.description ? { description: normalized.description } : {}),
      apps: normalized.apps ?? ["claude", "codex"],
      sourcePath,
      sha256,
      status,
      changed,
      applied: changed && !options.dryRun,
      dryRun: options.dryRun ?? false,
      signatureVerified: signatureVerification.verified,
      ...(signatureVerification.publicKeyId
        ? { publicKeyId: signatureVerification.publicKeyId }
        : {}),
      ...(existingVersion ? { existingVersion } : {}),
      ...(backupPath ? { backupPath } : {})
    });
  }

  return {
    registryUrl: options.registryUrl,
    dryRun: options.dryRun ?? false,
    ...(releaseMetadata ? { releaseMetadata } : {}),
    skills: results
  };
}

export async function installSkill(
  skill: SkillRecord,
  options: SkillInstallOptions
): Promise<SkillSyncResult> {
  if (!skill.apps.includes(options.app)) {
    throw new Error(`${skill.name} is not bound to ${options.app}`);
  }
  if (!skill.enabled) {
    throw new Error(`${skill.name} is disabled`);
  }
  const mode = options.mode ?? "copy";
  const sourcePath = resolve(skill.sourcePath);
  await assertSkillSource(sourcePath);
  const targetPath = skillTargetPath(options.homeDir, options.app, skill.name);
  const nextHash = mode === "symlink"
    ? `symlink:${sourcePath}`
    : await hashDirectory(sourcePath);
  const previousHash = await hashTarget(targetPath);
  const changed = previousHash !== nextHash;
  let backupPath: string | undefined;

  if (!options.dryRun && changed) {
    backupPath = await backupTargetIfExists(
      targetPath,
      backupRoot(options),
      `${options.app}-skill-${skillFolderName(skill.name)}`,
      options.now
    );
    await rm(targetPath, { recursive: true, force: true });
    await mkdir(dirname(targetPath), { recursive: true });
    if (mode === "symlink") {
      await symlink(sourcePath, targetPath, "dir");
    } else {
      await cp(sourcePath, targetPath, { recursive: true });
    }
  }

  return {
    skillId: skill.id,
    app: options.app,
    mode,
    sourcePath,
    targetPath,
    backupPath,
    installedHash: nextHash,
    changed,
    dryRun: options.dryRun ?? false,
    action: "install"
  };
}

export async function uninstallSkill(
  skill: SkillRecord,
  options: SkillUninstallOptions
): Promise<SkillSyncResult> {
  const targetPath =
    options.installation?.targetPath ?? skillTargetPath(options.homeDir, options.app, skill.name);
  const exists = await pathExists(targetPath);
  let backupPath: string | undefined;
  if (!options.dryRun && exists) {
    backupPath = await backupTargetIfExists(
      targetPath,
      backupRoot(options),
      `${options.app}-skill-${skillFolderName(skill.name)}-uninstall`,
      options.now
    );
    await rm(targetPath, { recursive: true, force: true });
  }
  return {
    skillId: skill.id,
    app: options.app,
    mode: options.installation?.mode,
    sourcePath: options.installation?.sourcePath ?? skill.sourcePath,
    targetPath,
    backupPath,
    changed: exists,
    dryRun: options.dryRun ?? false,
    action: "uninstall"
  };
}

export function skillTargetPath(
  homeDir: string,
  app: ManagedAgentApp,
  name: string
): string {
  return app === "claude"
    ? join(homeDir, ".claude", "skills", skillFolderName(name))
    : join(homeDir, ".codex", "skills", skillFolderName(name));
}

export function hashSkillRegistryFiles(files: SkillRegistryFile[]): string {
  const hash = createHash("sha256");
  for (const file of normalizeSkillRegistryFiles(files)) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(registryFileContent(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function skillRegistrySignaturePayload(entry: Pick<
  SkillRegistryEntry,
  "name" | "version" | "description" | "apps" | "sha256"
>): string {
  return JSON.stringify({
    name: entry.name,
    version: entry.version,
    description: entry.description ?? "",
    apps: normalizeSkillRegistryApps(entry.apps),
    sha256: entry.sha256
  });
}

export function skillRegistryReleasePayload(index: Pick<
  SkillRegistryIndex,
  | "version"
  | "skills"
  | "publicKey"
  | "publicKeys"
  | "revokedPublicKeyIds"
  | "signatureAlgorithm"
>): string {
  const skills = index.skills
    .map(normalizeSkillRegistryEntry)
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      description: entry.description ?? "",
      apps: normalizeSkillRegistryApps(entry.apps),
      sha256: entry.sha256,
      signature: entry.signature ?? "",
      publicKeyId: entry.publicKeyId ?? ""
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const publicKeys = normalizeSkillRegistryPublicKeys(index.publicKeys ?? [])
    .map((key) => ({
      id: key.id,
      publicKey: key.publicKey,
      status: key.status ?? "active"
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({
    version: index.version,
    publicKey: index.publicKey ?? "",
    publicKeys,
    revokedPublicKeyIds: normalizePublicKeyIds(index.revokedPublicKeyIds ?? []).sort(),
    signatureAlgorithm: index.signatureAlgorithm ?? "",
    skills
  });
}

export function hashSkillRegistryReleasePayload(index: Parameters<
  typeof skillRegistryReleasePayload
>[0]): string {
  return createHash("sha256")
    .update(skillRegistryReleasePayload(index))
    .digest("hex");
}

export function skillRegistryReleaseSignaturePayload(
  metadata: Pick<
    SkillRegistryReleaseMetadata,
    "version" | "sequence" | "issuedAt" | "expiresAt" | "registrySha256"
  >
): string {
  return JSON.stringify({
    version: metadata.version,
    sequence: metadata.sequence,
    issuedAt: metadata.issuedAt,
    expiresAt: metadata.expiresAt ?? "",
    registrySha256: metadata.registrySha256
  });
}

async function assertSkillSource(sourcePath: string): Promise<void> {
  const info = await lstat(sourcePath);
  if (!info.isDirectory()) throw new Error(`Skill source is not a directory: ${sourcePath}`);
  if (!(await pathExists(join(sourcePath, "SKILL.md")))) {
    throw new Error(`Skill source must contain SKILL.md: ${sourcePath}`);
  }
}

async function readSkillRegistryIndex(registryUrl: string): Promise<SkillRegistryIndex> {
  const raw = await readRegistryText(registryUrl);
  const parsed = JSON.parse(raw) as Partial<SkillRegistryIndex>;
  if (parsed.version !== 1) throw new Error("Skill registry version must be 1");
  if (!Array.isArray(parsed.skills)) throw new Error("Skill registry skills must be an array");
  return {
    version: 1,
    skills: parsed.skills.map(normalizeSkillRegistryEntry),
    ...(typeof parsed.publicKey === "string" ? { publicKey: parsed.publicKey } : {}),
    ...(Array.isArray(parsed.publicKeys)
      ? { publicKeys: normalizeSkillRegistryPublicKeys(parsed.publicKeys) }
      : {}),
    ...(Array.isArray(parsed.revokedPublicKeyIds)
      ? { revokedPublicKeyIds: normalizePublicKeyIds(parsed.revokedPublicKeyIds) }
      : {}),
    ...(parsed.signatureAlgorithm === "ed25519"
      ? { signatureAlgorithm: parsed.signatureAlgorithm }
      : {}),
    ...(parsed.releaseMetadata
      ? { releaseMetadata: normalizeSkillRegistryReleaseMetadata(parsed.releaseMetadata) }
      : {})
  };
}

async function readRegistryText(registryUrl: string): Promise<string> {
  if (registryUrl.startsWith("http://") || registryUrl.startsWith("https://")) {
    return readHttpText(registryUrl);
  }
  if (registryUrl.startsWith("file://")) {
    return readFile(fileURLToPath(registryUrl), "utf8");
  }
  return readFile(resolve(registryUrl), "utf8");
}

async function readHttpText(registryUrl: string): Promise<string> {
  const transport = registryUrl.startsWith("https://") ? httpsGet : httpGet;
  return new Promise((resolvePromise, reject) => {
    const request = transport(registryUrl, (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Skill registry request failed with status ${statusCode}`));
        return;
      }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolvePromise(body));
    });
    request.on("error", reject);
  });
}

function normalizeSkillRegistryEntry(entry: SkillRegistryEntry): SkillRegistryEntry {
  if (!entry || typeof entry !== "object") throw new Error("Invalid skill registry entry");
  if (!entry.name || typeof entry.name !== "string") {
    throw new Error("Skill registry entry is missing name");
  }
  if (!entry.version || typeof entry.version !== "string") {
    throw new Error(`Skill registry entry ${entry.name} is missing version`);
  }
  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    throw new Error(`Skill registry entry ${entry.name} is missing files`);
  }
  const files = normalizeSkillRegistryFiles(entry.files);
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new Error(`Skill registry entry ${entry.name} must include SKILL.md`);
  }
  if (!entry.sha256 || typeof entry.sha256 !== "string") {
    throw new Error(`Skill registry entry ${entry.name} is missing sha256`);
  }
  if (entry.publicKeyId && typeof entry.publicKeyId !== "string") {
    throw new Error(`Skill registry entry ${entry.name} has invalid publicKeyId`);
  }
  return {
    name: entry.name,
    version: entry.version,
    files,
    sha256: entry.sha256,
    ...(entry.signature ? { signature: entry.signature } : {}),
    ...(entry.publicKeyId ? { publicKeyId: entry.publicKeyId } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    apps: normalizeSkillRegistryApps(entry.apps)
  };
}

function normalizeSkillRegistryFiles(files: SkillRegistryFile[]): SkillRegistryFile[] {
  return files
    .map((file) => {
      if (!file || typeof file !== "object") {
        throw new Error("Invalid skill registry file");
      }
      if (!file.path || typeof file.path !== "string") {
        throw new Error("Skill registry file is missing path");
      }
      if (typeof file.content !== "string") {
        throw new Error(`Skill registry file ${file.path} is missing content`);
      }
      const path = normalizeRegistryRelativePath(file.path);
      const encoding = file.encoding ?? "utf8";
      if (encoding !== "utf8" && encoding !== "base64") {
        throw new Error(`Unsupported skill registry file encoding: ${encoding}`);
      }
      return { path, content: file.content, encoding };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function normalizeSkillRegistryApps(apps?: ManagedAgentApp[]): ManagedAgentApp[] {
  const normalized: ManagedAgentApp[] = apps?.length ? apps : ["claude", "codex"];
  const unique = Array.from(new Set(normalized));
  for (const app of unique) {
    if (app !== "claude" && app !== "codex") {
      throw new Error(`Unsupported skill registry app: ${String(app)}`);
    }
  }
  return unique.sort();
}

function normalizeSkillRegistryPublicKeys(
  publicKeys: SkillRegistryPublicKey[]
): SkillRegistryPublicKey[] {
  return publicKeys.map((publicKey) => {
    if (!publicKey || typeof publicKey !== "object") {
      throw new Error("Invalid skill registry public key");
    }
    if (!publicKey.id || typeof publicKey.id !== "string") {
      throw new Error("Skill registry public key is missing id");
    }
    if (!publicKey.publicKey || typeof publicKey.publicKey !== "string") {
      throw new Error(`Skill registry public key ${publicKey.id} is missing publicKey`);
    }
    const status = publicKey.status ?? "active";
    if (status !== "active" && status !== "retired" && status !== "revoked") {
      throw new Error(`Unsupported skill registry public key status: ${String(status)}`);
    }
    return {
      id: publicKey.id,
      publicKey: publicKey.publicKey,
      status
    };
  });
}

function normalizeSkillRegistryReleaseMetadata(
  metadata: SkillRegistryReleaseMetadata
): SkillRegistryReleaseMetadata {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Invalid skill registry release metadata");
  }
  if (metadata.version !== 1) {
    throw new Error("Skill registry release metadata version must be 1");
  }
  if (!Number.isSafeInteger(metadata.sequence) || metadata.sequence < 0) {
    throw new Error("Skill registry release metadata sequence must be a non-negative integer");
  }
  if (!metadata.registrySha256 || typeof metadata.registrySha256 !== "string") {
    throw new Error("Skill registry release metadata is missing registrySha256");
  }
  const issuedAt = normalizeRegistryTimestamp(metadata.issuedAt, "issuedAt");
  const expiresAt = metadata.expiresAt
    ? normalizeRegistryTimestamp(metadata.expiresAt, "expiresAt")
    : undefined;
  if (metadata.publicKeyId && typeof metadata.publicKeyId !== "string") {
    throw new Error("Skill registry release metadata has invalid publicKeyId");
  }
  return {
    version: 1,
    sequence: metadata.sequence,
    issuedAt,
    ...(expiresAt ? { expiresAt } : {}),
    registrySha256: metadata.registrySha256,
    ...(metadata.signature ? { signature: metadata.signature } : {}),
    ...(metadata.publicKeyId ? { publicKeyId: metadata.publicKeyId } : {})
  };
}

function normalizeRegistryTimestamp(value: unknown, field: string): string {
  if (!value || typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Skill registry release metadata ${field} must be a timestamp`);
  }
  return value;
}

function normalizePublicKeyIds(ids: string[]): string[] {
  return Array.from(
    new Set(
      ids.map((id) => {
        if (!id || typeof id !== "string") {
          throw new Error("Skill registry public key id must be a string");
        }
        return id;
      })
    )
  );
}

type SkillRegistryTrustKey = Required<SkillRegistryPublicKey>;

interface SkillRegistryTrustPolicy {
  keys: SkillRegistryTrustKey[];
  revokedPublicKeyIds: Set<string>;
}

function buildSkillRegistryTrustPolicy(
  registry: SkillRegistryIndex,
  options: SkillRegistrySyncOptions
): SkillRegistryTrustPolicy {
  const keys: SkillRegistryTrustKey[] = [];
  if (options.publicKey) {
    keys.push({ id: "cli", publicKey: options.publicKey, status: "active" });
  }
  if (registry.publicKey) {
    keys.push({ id: "registry", publicKey: registry.publicKey, status: "active" });
  }
  keys.push(
    ...(normalizeSkillRegistryPublicKeys(options.trustedPublicKeys ?? []) as SkillRegistryTrustKey[])
  );
  keys.push(
    ...(normalizeSkillRegistryPublicKeys(registry.publicKeys ?? []) as SkillRegistryTrustKey[])
  );
  const revokedPublicKeyIds = new Set([
    ...(registry.revokedPublicKeyIds ?? []),
    ...(options.revokedPublicKeyIds ?? []),
    ...keys.filter((key) => key.status === "revoked").map((key) => key.id)
  ]);
  return { keys, revokedPublicKeyIds };
}

function verifySkillRegistryEntrySignature(
  entry: SkillRegistryEntry,
  trustPolicy: SkillRegistryTrustPolicy
): { verified: boolean; publicKeyId?: string } {
  if (!entry.signature) return { verified: false };
  const verificationKey = resolveSkillRegistrySignatureKey(entry, trustPolicy);
  if (trustPolicy.revokedPublicKeyIds.has(verificationKey.id)) {
    throw new Error(`Skill registry public key revoked for ${entry.name}: ${verificationKey.id}`);
  }
  const cryptoKey = verificationKey.publicKey.includes("BEGIN")
    ? createPublicKey(verificationKey.publicKey)
    : createPublicKey({
        key: Buffer.from(verificationKey.publicKey, "base64"),
        format: "der",
        type: "spki"
      });
  return {
    verified: verify(
      null,
      Buffer.from(skillRegistrySignaturePayload(entry)),
      cryptoKey,
      Buffer.from(entry.signature, "base64")
    ),
    publicKeyId: verificationKey.id
  };
}

function verifySkillRegistryReleaseMetadata(
  registry: SkillRegistryIndex,
  trustPolicy: SkillRegistryTrustPolicy,
  options: SkillRegistrySyncOptions
): SkillRegistrySyncResult["releaseMetadata"] {
  const metadata = registry.releaseMetadata;
  if (!metadata) {
    if (options.requireReleaseMetadata) {
      throw new Error("Skill registry release metadata required");
    }
    return undefined;
  }

  const expectedRegistrySha256 = hashSkillRegistryReleasePayload(registry);
  if (metadata.registrySha256 !== expectedRegistrySha256) {
    throw new Error("Skill registry release metadata hash mismatch");
  }
  const nowMs = (options.now ?? new Date()).getTime();
  if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= nowMs) {
    throw new Error("Skill registry release metadata expired");
  }

  let signatureVerified = false;
  let publicKeyId: string | undefined;
  if (metadata.signature) {
    const verificationKey = resolveSkillRegistryReleaseSignatureKey(metadata, trustPolicy);
    if (trustPolicy.revokedPublicKeyIds.has(verificationKey.id)) {
      throw new Error(`Skill registry release metadata public key revoked: ${verificationKey.id}`);
    }
    const cryptoKey = verificationKey.publicKey.includes("BEGIN")
      ? createPublicKey(verificationKey.publicKey)
      : createPublicKey({
          key: Buffer.from(verificationKey.publicKey, "base64"),
          format: "der",
          type: "spki"
        });
    signatureVerified = verify(
      null,
      Buffer.from(skillRegistryReleaseSignaturePayload(metadata)),
      cryptoKey,
      Buffer.from(metadata.signature, "base64")
    );
    if (!signatureVerified) {
      throw new Error("Skill registry release metadata signature mismatch");
    }
    publicKeyId = verificationKey.id;
  }
  if (options.requireReleaseMetadata && !signatureVerified) {
    throw new Error("Skill registry release metadata signature required");
  }

  return {
    sequence: metadata.sequence,
    issuedAt: metadata.issuedAt,
    ...(metadata.expiresAt ? { expiresAt: metadata.expiresAt } : {}),
    registrySha256: metadata.registrySha256,
    signatureVerified,
    ...(publicKeyId ? { publicKeyId } : {})
  };
}

function resolveSkillRegistrySignatureKey(
  entry: SkillRegistryEntry,
  trustPolicy: SkillRegistryTrustPolicy
): SkillRegistryTrustKey {
  if (entry.publicKeyId) {
    const key = trustPolicy.keys.find((candidate) => candidate.id === entry.publicKeyId);
    if (!key) {
      throw new Error(`Skill registry public key not trusted for ${entry.name}: ${entry.publicKeyId}`);
    }
    return key;
  }
  const activeKeys = trustPolicy.keys.filter((key) => key.status !== "revoked");
  if (activeKeys.length === 0) {
    throw new Error(`Skill registry entry ${entry.name} has a signature but no public key`);
  }
  if (activeKeys.length > 1) {
    throw new Error(
      `Skill registry entry ${entry.name} must include publicKeyId when multiple trusted keys are configured`
    );
  }
  return activeKeys[0]!;
}

function resolveSkillRegistryReleaseSignatureKey(
  metadata: SkillRegistryReleaseMetadata,
  trustPolicy: SkillRegistryTrustPolicy
): SkillRegistryTrustKey {
  if (metadata.publicKeyId) {
    const key = trustPolicy.keys.find((candidate) => candidate.id === metadata.publicKeyId);
    if (!key) {
      throw new Error(
        `Skill registry release metadata public key not trusted: ${metadata.publicKeyId}`
      );
    }
    return key;
  }
  const activeKeys = trustPolicy.keys.filter((key) => key.status !== "revoked");
  if (activeKeys.length === 0) {
    throw new Error("Skill registry release metadata has a signature but no public key");
  }
  if (activeKeys.length > 1) {
    throw new Error(
      "Skill registry release metadata must include publicKeyId when multiple trusted keys are configured"
    );
  }
  return activeKeys[0]!;
}

function skillRegistrySyncStatus(options: {
  hasExisting: boolean;
  versionComparison: number;
  targetHash?: string;
  expectedTargetHash: string;
  existingSourcePath?: string;
  sourcePath: string;
}): SkillRegistrySyncSkillResult["status"] {
  if (!options.hasExisting) return "new";
  if (options.versionComparison < 0) return "downgrade";
  if (options.versionComparison > 0) return "update";
  if (
    resolve(options.existingSourcePath ?? "") !== resolve(options.sourcePath) ||
    options.targetHash !== options.expectedTargetHash
  ) {
    return "refresh";
  }
  return "current";
}

async function writeSkillRegistrySource(options: {
  sourcePath: string;
  files: SkillRegistryFile[];
  mniuRoot: string;
  name: string;
  now?: Date;
}): Promise<string | undefined> {
  const tmpRoot = join(options.mniuRoot, "tmp");
  await mkdir(tmpRoot, { recursive: true });
  const staging = await mkdtemp(join(tmpRoot, `${skillFolderName(options.name)}-`));
  try {
    await writeRegistryFiles(staging, options.files);
    await assertSkillSource(staging);
    const backupPath = await backupTargetIfExists(
      options.sourcePath,
      join(options.mniuRoot, "skill-backups"),
      `registry-${skillFolderName(options.name)}`,
      options.now
    );
    await rm(options.sourcePath, { recursive: true, force: true });
    await mkdir(dirname(options.sourcePath), { recursive: true });
    await rename(staging, options.sourcePath);
    return backupPath;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function writeRegistryFiles(root: string, files: SkillRegistryFile[]): Promise<void> {
  for (const file of files) {
    const target = registryFileTarget(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, registryFileContent(file));
  }
}

function registryFileTarget(root: string, path: string): string {
  const rootPath = resolve(root);
  const target = resolve(rootPath, path);
  const relativePath = relative(rootPath, target);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Skill registry file escapes source root: ${path}`);
  }
  return target;
}

function registryFileContent(file: SkillRegistryFile): Buffer {
  return file.encoding === "base64"
    ? Buffer.from(file.content, "base64")
    : Buffer.from(file.content, "utf8");
}

function normalizeRegistryRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized === ".." ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.includes("../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error(`Invalid skill registry file path: ${path}`);
  }
  if (isAbsolute(normalized)) {
    throw new Error(`Invalid skill registry file path: ${path}`);
  }
  return normalized;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[.-]/);
  const rightParts = right.split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber)) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
      continue;
    }
    const compared = leftPart.localeCompare(rightPart);
    if (compared !== 0) return compared;
  }
  return 0;
}

async function listChildDirectories(root: string): Promise<string[]> {
  try {
    const dir = await opendir(root);
    const paths: string[] = [];
    for await (const entry of dir) {
      if (entry.isDirectory()) paths.push(join(root, entry.name));
    }
    return paths;
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function readSkillMetadata(sourcePath: string): Promise<{
  name?: string;
  description?: string;
  version?: string;
}> {
  const content = await readFile(join(sourcePath, "SKILL.md"), "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = match?.[1];
  if (!frontmatter) return {};
  const metadata: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    const key = field?.[1];
    const value = field?.[2];
    if (!key || value === undefined) continue;
    metadata[key] = value.replace(/^["']|["']$/g, "");
  }
  return {
    ...(metadata.name ? { name: metadata.name } : {}),
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.version ? { version: metadata.version } : {})
  };
}

async function hashTarget(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return `symlink:${resolve(dirname(path), await readlink(path))}`;
    if (info.isDirectory()) return hashDirectory(path);
    return hashFile(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await listFiles(root)) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return `dir:${hash.digest("hex")}`;
}

async function hashFile(path: string): Promise<string> {
  return `file:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const dir = await opendir(root);
  for await (const entry of dir) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

async function backupTargetIfExists(
  path: string,
  root: string,
  label: string,
  now = new Date()
): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  const backupDir = join(root, label.replace(/[^a-zA-Z0-9_.-]/g, "-"));
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `${timestamp(now)}.bak`);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(path), backupPath);
  } else if (info.isDirectory()) {
    await cp(path, backupPath, { recursive: true });
  } else {
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, await readFile(path));
  }
  return backupPath;
}

function backupRoot(options: { homeDir: string; mniuRoot?: string }): string {
  return join(options.mniuRoot ?? join(options.homeDir, ".muniu"), "backups");
}

function skillFolderName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
