// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  EnvelopeCipher,
  type EncryptedEnvelopeV1,
  type KeyContext,
  type KeyProvider,
  type WrappedDataKey
} from "./encryption.js";
import { canonicalJson } from "./integrity.js";

const BACKUP_FORMAT = "muniu-agent-os-local-backup";
const BACKUP_PURPOSE = "local-sqlite-backup";
const DEFAULT_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

export type LocalBackupErrorCode =
  | "BACKUP_INVALID_PATH"
  | "BACKUP_SOURCE_NOT_FOUND"
  | "BACKUP_DESTINATION_EXISTS"
  | "BACKUP_ARCHIVE_TOO_LARGE"
  | "BACKUP_FORMAT_INVALID"
  | "BACKUP_VERSION_UNSUPPORTED"
  | "BACKUP_INTEGRITY_FAILED"
  | "BACKUP_ENCRYPTION_FAILED"
  | "BACKUP_DECRYPTION_FAILED"
  | "BACKUP_SQLITE_INVALID"
  | "BACKUP_IO_FAILED";

export class LocalBackupError extends Error {
  constructor(readonly code: LocalBackupErrorCode, message: string) {
    super(message);
    this.name = "LocalBackupError";
  }
}

export interface LocalBackupManifestV1 {
  readonly format: typeof BACKUP_FORMAT;
  readonly manifestVersion: 1;
  readonly createdAt: string;
  readonly capabilities: {
    readonly sqlite: true;
    readonly cas: false;
  };
  readonly payload: {
    readonly mediaType: "application/vnd.sqlite3";
    readonly bytes: number;
    readonly sha256: string;
    readonly sqliteSchemaVersion: string;
  };
  readonly encryption: {
    readonly algorithm: "AES-256-GCM";
    readonly keyManagement: "external-key-provider";
  };
}

export interface LocalBackupCreateResult {
  readonly file: string;
  readonly manifest: LocalBackupManifestV1;
}

export interface LocalBackupCheckResult {
  readonly file: string;
  readonly manifest: LocalBackupManifestV1;
  readonly verified: true;
}

export interface LocalBackupRestoreResult {
  readonly file: string;
  readonly manifest: LocalBackupManifestV1;
}

export interface LocalSqliteBackupOptions {
  readonly databaseFile: string;
  readonly backupDirectory: string;
  readonly restoreDirectory: string;
  readonly keyProvider: KeyProvider;
  readonly tenantId?: string;
  readonly now?: () => Date;
  readonly maxArchiveBytes?: number;
}

interface BackupKeyContext extends KeyContext {
  readonly manifestSha256: string;
}

interface LocalBackupArchiveV1 {
  readonly manifest: LocalBackupManifestV1;
  readonly envelope: EncryptedEnvelopeV1;
}

interface DecodedBackup {
  readonly manifest: LocalBackupManifestV1;
  readonly payload: Buffer;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" ? error.code : undefined;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function secureDirectory(path: string): string {
  const absolute = resolve(path);
  try {
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new LocalBackupError("BACKUP_INVALID_PATH", "备份目录必须是普通目录");
    }
    return realpathSync(absolute);
  } catch (error) {
    if (error instanceof LocalBackupError) throw error;
    throw new LocalBackupError("BACKUP_INVALID_PATH", "无法使用备份目录");
  }
}

function safeLeaf(root: string, name: string): string {
  if (!name || name.trim() !== name || isAbsolute(name) || basename(name) !== name
    || name === "." || name === ".." || name.includes("/") || name.includes("\\")
    || name.includes("\0")) {
    throw new LocalBackupError("BACKUP_INVALID_PATH", "备份文件名必须是不含路径的文件名");
  }
  return join(root, name);
}

function assertRegularFile(path: string, missingCode: LocalBackupErrorCode): number {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      throw new LocalBackupError(missingCode, "备份文件不存在");
    }
    throw new LocalBackupError("BACKUP_IO_FAILED", "无法读取备份文件状态");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LocalBackupError("BACKUP_INVALID_PATH", "备份路径必须指向普通文件");
  }
  return stat.size;
}

function assertSourceDatabase(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new LocalBackupError("BACKUP_INVALID_PATH", "SQLite 源路径必须指向普通文件");
    }
  } catch (error) {
    if (error instanceof LocalBackupError) throw error;
    if (nodeErrorCode(error) === "ENOENT") {
      throw new LocalBackupError("BACKUP_SOURCE_NOT_FOUND", "SQLite 源数据库不存在");
    }
    throw new LocalBackupError("BACKUP_IO_FAILED", "无法读取 SQLite 源数据库状态");
  }
}

function atomicCreate(path: string, bytes: Uint8Array): void {
  const directory = realpathSync(join(path, ".."));
  const temporary = join(directory, `.mn-backup-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") {
      throw new LocalBackupError("BACKUP_DESTINATION_EXISTS", "目标文件已存在");
    }
    if (error instanceof LocalBackupError) throw error;
    throw new LocalBackupError("BACKUP_IO_FAILED", "无法写入备份文件");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", `备份字段 ${key} 无效`);
  }
  return value;
}

function validBase64(value: string, bytes?: number): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return bytes === undefined || Buffer.from(value, "base64").byteLength === bytes;
}

function parseContext(value: unknown): BackupKeyContext {
  if (!isRecord(value)) throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份加密上下文无效");
  const tenantId = requiredString(value, "tenantId");
  const purpose = requiredString(value, "purpose");
  const manifestSha256 = requiredString(value, "manifestSha256");
  if (!/^[a-f0-9]{64}$/u.test(manifestSha256)) {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份清单摘要无效");
  }
  return { tenantId, purpose, manifestSha256 };
}

function parseWrappedKey(value: unknown): WrappedDataKey {
  if (!isRecord(value) || value.algorithm !== "AES-256-GCM") {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份密钥封装无效");
  }
  const provider = requiredString(value, "provider");
  const keyId = requiredString(value, "keyId");
  const nonce = requiredString(value, "nonce");
  const ciphertext = requiredString(value, "ciphertext");
  const tag = requiredString(value, "tag");
  if (!validBase64(nonce, 12) || !validBase64(ciphertext) || !validBase64(tag, 16)) {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份密钥封装编码无效");
  }
  return {
    algorithm: "AES-256-GCM",
    provider,
    keyId,
    nonce,
    ciphertext,
    tag,
    context: parseContext(value.context)
  };
}

function parseEnvelope(value: unknown): EncryptedEnvelopeV1 {
  if (!isRecord(value) || value.version !== 1 || value.algorithm !== "AES-256-GCM") {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份加密数据无效");
  }
  const nonce = requiredString(value, "nonce");
  const ciphertext = requiredString(value, "ciphertext");
  const tag = requiredString(value, "tag");
  if (!validBase64(nonce, 12) || !validBase64(ciphertext) || !validBase64(tag, 16)) {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份密文编码无效");
  }
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    nonce,
    ciphertext,
    tag,
    context: parseContext(value.context),
    wrappedKey: parseWrappedKey(value.wrappedKey)
  };
}

function parseManifest(value: unknown): LocalBackupManifestV1 {
  if (!isRecord(value) || value.format !== BACKUP_FORMAT) {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份格式无效");
  }
  if (value.manifestVersion !== 1) {
    throw new LocalBackupError("BACKUP_VERSION_UNSUPPORTED", "不支持该备份清单版本");
  }
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份创建时间无效");
  }
  if (!isRecord(value.capabilities) || value.capabilities.sqlite !== true
    || value.capabilities.cas !== false) {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份能力声明无效");
  }
  if (!isRecord(value.payload) || value.payload.mediaType !== "application/vnd.sqlite3"
    || !Number.isSafeInteger(value.payload.bytes) || Number(value.payload.bytes) < 1
    || typeof value.payload.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.payload.sha256)
    || typeof value.payload.sqliteSchemaVersion !== "string" || !value.payload.sqliteSchemaVersion) {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份负载清单无效");
  }
  if (!isRecord(value.encryption) || value.encryption.algorithm !== "AES-256-GCM"
    || value.encryption.keyManagement !== "external-key-provider") {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份加密清单无效");
  }
  return value as unknown as LocalBackupManifestV1;
}

function parseArchive(bytes: Buffer): LocalBackupArchiveV1 {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份文件不是有效的 JSON");
  }
  if (!isRecord(value)) throw new LocalBackupError("BACKUP_FORMAT_INVALID", "备份文件结构无效");
  return { manifest: parseManifest(value.manifest), envelope: parseEnvelope(value.envelope) };
}

function sqliteMetadata(file: string): string {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    const integrity = database.prepare("pragma integrity_check").get();
    if (!integrity || Object.values(integrity)[0] !== "ok") {
      throw new LocalBackupError("BACKUP_SQLITE_INVALID", "SQLite 快照完整性检查失败");
    }
    const schema = database.prepare("select value from storage_meta where key = 'schema_version'").get();
    if (!schema || typeof schema.value !== "string" || !schema.value) {
      throw new LocalBackupError("BACKUP_SQLITE_INVALID", "SQLite 快照缺少存储版本");
    }
    return schema.value;
  } catch (error) {
    if (error instanceof LocalBackupError) throw error;
    throw new LocalBackupError("BACKUP_SQLITE_INVALID", "无法读取 SQLite 快照");
  } finally {
    database?.close();
  }
}

function validateSqliteBytes(bytes: Buffer): string {
  const directory = mkdtempSync(join(tmpdir(), "mn-v2-backup-check-"));
  const file = join(directory, "snapshot.sqlite");
  try {
    writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    return sqliteMetadata(file);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export class LocalSqliteBackup {
  readonly #databaseFile: string;
  readonly #backupDirectory: string;
  readonly #restoreDirectory: string;
  readonly #cipher: EnvelopeCipher;
  readonly #tenantId: string;
  readonly #now: () => Date;
  readonly #maxArchiveBytes: number;

  constructor(options: LocalSqliteBackupOptions) {
    if (!options.tenantId?.trim() && options.tenantId !== undefined) {
      throw new TypeError("tenantId 不能为空");
    }
    const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 1) {
      throw new TypeError("maxArchiveBytes 必须是正整数");
    }
    this.#databaseFile = resolve(options.databaseFile);
    this.#backupDirectory = secureDirectory(options.backupDirectory);
    this.#restoreDirectory = secureDirectory(options.restoreDirectory);
    this.#cipher = new EnvelopeCipher(options.keyProvider);
    this.#tenantId = options.tenantId ?? "local";
    this.#now = options.now ?? (() => new Date());
    this.#maxArchiveBytes = maxArchiveBytes;
  }

  async create(fileName: string): Promise<LocalBackupCreateResult> {
    const target = safeLeaf(this.#backupDirectory, fileName);
    if (exists(target)) throw new LocalBackupError("BACKUP_DESTINATION_EXISTS", "目标文件已存在");
    assertSourceDatabase(this.#databaseFile);
    const directory = mkdtempSync(join(tmpdir(), "mn-v2-backup-create-"));
    const snapshot = join(directory, "snapshot.sqlite");
    try {
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(this.#databaseFile, { readOnly: true });
        database.exec("pragma busy_timeout = 5000");
        database.prepare("vacuum into ?").run(snapshot);
      } catch {
        throw new LocalBackupError("BACKUP_SQLITE_INVALID", "无法生成一致的 SQLite 快照");
      } finally {
        database?.close();
      }
      chmodSync(snapshot, 0o600);
      const sqliteSchemaVersion = sqliteMetadata(snapshot);
      const payload = readFileSync(snapshot);
      const manifest: LocalBackupManifestV1 = {
        format: BACKUP_FORMAT,
        manifestVersion: 1,
        createdAt: this.#now().toISOString(),
        capabilities: { sqlite: true, cas: false },
        payload: {
          mediaType: "application/vnd.sqlite3",
          bytes: payload.byteLength,
          sha256: sha256(payload),
          sqliteSchemaVersion
        },
        encryption: { algorithm: "AES-256-GCM", keyManagement: "external-key-provider" }
      };
      const context: BackupKeyContext = {
        tenantId: this.#tenantId,
        purpose: BACKUP_PURPOSE,
        manifestSha256: sha256(canonicalJson(manifest))
      };
      let envelope: EncryptedEnvelopeV1;
      try {
        envelope = await this.#cipher.encrypt(payload, context);
      } catch {
        throw new LocalBackupError("BACKUP_ENCRYPTION_FAILED", "无法加密 SQLite 快照");
      } finally {
        payload.fill(0);
      }
      const archive = Buffer.from(JSON.stringify({ manifest, envelope } satisfies LocalBackupArchiveV1));
      if (archive.byteLength > this.#maxArchiveBytes) {
        throw new LocalBackupError("BACKUP_ARCHIVE_TOO_LARGE", "备份文件超过允许大小");
      }
      atomicCreate(target, archive);
      return { file: target, manifest };
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }

  async check(fileName: string): Promise<LocalBackupCheckResult> {
    const file = safeLeaf(this.#backupDirectory, fileName);
    const decoded = await this.#decode(file);
    try {
      return { file, manifest: decoded.manifest, verified: true };
    } finally {
      decoded.payload.fill(0);
    }
  }

  async restore(fileName: string, destinationName: string): Promise<LocalBackupRestoreResult> {
    const source = safeLeaf(this.#backupDirectory, fileName);
    const destination = safeLeaf(this.#restoreDirectory, destinationName);
    if (exists(destination)) {
      throw new LocalBackupError("BACKUP_DESTINATION_EXISTS", "目标文件已存在");
    }
    const decoded = await this.#decode(source);
    try {
      atomicCreate(destination, decoded.payload);
      return { file: destination, manifest: decoded.manifest };
    } finally {
      decoded.payload.fill(0);
    }
  }

  async #decode(file: string): Promise<DecodedBackup> {
    const archiveBytes = assertRegularFile(file, "BACKUP_SOURCE_NOT_FOUND");
    if (archiveBytes > this.#maxArchiveBytes) {
      throw new LocalBackupError("BACKUP_ARCHIVE_TOO_LARGE", "备份文件超过允许大小");
    }
    let archive: LocalBackupArchiveV1;
    try {
      archive = parseArchive(readFileSync(file));
    } catch (error) {
      if (error instanceof LocalBackupError) throw error;
      throw new LocalBackupError("BACKUP_IO_FAILED", "无法读取备份文件");
    }
    const manifestSha256 = sha256(canonicalJson(archive.manifest));
    const context = archive.envelope.context as BackupKeyContext;
    if (context.tenantId !== this.#tenantId || context.purpose !== BACKUP_PURPOSE
      || context.manifestSha256 !== manifestSha256) {
      throw new LocalBackupError("BACKUP_INTEGRITY_FAILED", "备份清单完整性检查失败");
    }
    let payload: Buffer;
    try {
      payload = await this.#cipher.decrypt(archive.envelope);
    } catch {
      throw new LocalBackupError("BACKUP_DECRYPTION_FAILED", "无法解密备份文件");
    }
    try {
      if (payload.byteLength !== archive.manifest.payload.bytes
        || sha256(payload) !== archive.manifest.payload.sha256) {
        throw new LocalBackupError("BACKUP_INTEGRITY_FAILED", "SQLite 快照摘要不匹配");
      }
      if (validateSqliteBytes(payload) !== archive.manifest.payload.sqliteSchemaVersion) {
        throw new LocalBackupError("BACKUP_INTEGRITY_FAILED", "SQLite 存储版本与清单不一致");
      }
      return { manifest: archive.manifest, payload };
    } catch (error) {
      payload.fill(0);
      throw error;
    }
  }
}
