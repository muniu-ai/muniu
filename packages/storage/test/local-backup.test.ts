// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import {
  EnvelopeCipher,
  FileCas,
  InMemoryKeyProvider,
  LocalBackupError,
  LocalSqliteBackup,
  SqliteStorage,
  canonicalJson,
  type EncryptedEnvelopeV1,
  type LocalBackupManifestV1
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "mn-local-backup-"));
  temporaryDirectories.push(root);
  return root;
}

function hasBackupCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof LocalBackupError && error.code === code;
}

interface BackupFixture {
  readonly manifest: LocalBackupManifestV1;
  readonly envelope: EncryptedEnvelopeV1;
}

test("恢复状态目录可直接作为 v2 状态根使用，且拒绝覆盖现有目录", async t => {
  const root = temporaryDirectory();
  const databaseFile = join(root, "state.sqlite3");
  const storage = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 2) });
  t.after(() => storage.close());
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const object = await cas.put(Buffer.from("restore state fixture"));
  const backup = new LocalSqliteBackup({ databaseFile, casDirectory: join(root, "cas"),
    backupDirectory: join(root, "backups"), restoreDirectory: join(root, "restore"),
    keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 3)) });
  await backup.create("state.mnbackup");
  const restore = () => backup.restoreState("state.mnbackup", "verified-state", {
    hmacKey: Buffer.alloc(32, 2), keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 3)),
  });
  const result = await restore();
  assert.equal(result.verified, true);
  assert.equal(existsSync(join(result.stateRoot, ".restore-pending")), false);
  assert.equal(result.file, join(result.stateRoot, "state.sqlite3"));
  assert.equal(result.casDirectory, join(result.stateRoot, "cas"));
  assert.deepEqual(await new FileCas({ rootDir: result.casDirectory }).get(object.digest), Buffer.from("restore state fixture"));
  const marker = join(result.stateRoot, "user-marker");
  writeFileSync(marker, "keep");
  await assert.rejects(restore(), hasBackupCode("BACKUP_DESTINATION_EXISTS"));
  assert.equal(readFileSync(marker, "utf8"), "keep");
});

test("恢复状态根在事件 HMAC 校验失败时不返回可启动目录", async t => {
  const root = temporaryDirectory();
  const databaseFile = join(root, "state.sqlite3");
  const storage = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 2) });
  t.after(() => storage.close());
  await storage.transact("local", tx => tx.appendEvent({ tenantId: "local", aggregateType: "fixture", aggregateId: "fixture",
    expectedStreamVersion: 0, type: "fixture.created", actorId: "owner", generation: 0, correlationId: "fixture", publicPayload: {} }));
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 3));
  const backup = new LocalSqliteBackup({ databaseFile, backupDirectory: join(root, "backups"), restoreDirectory: join(root, "restore"), keyProvider });
  await backup.create("state.mnbackup");
  const restore = backup.restoreState as (...args: any[]) => Promise<unknown>;
  await assert.rejects(restore.call(backup, "state.mnbackup", "rejected", { hmacKey: Buffer.alloc(32, 4), keyProvider }),
    hasBackupCode("BACKUP_INTEGRITY_FAILED"));
  assert.equal(existsSync(join(root, "restore", "rejected")), false);
  assert.equal(existsSync(databaseFile), true);
  const raw = new DatabaseSync(databaseFile);
  try { raw.exec("delete from tenant_heads"); } finally { raw.close(); }
  await backup.create("missing-head.mnbackup");
  await assert.rejects(restore.call(backup, "missing-head.mnbackup", "missing-head", { hmacKey: Buffer.alloc(32, 2), keyProvider }),
    hasBackupCode("BACKUP_INTEGRITY_FAILED"));
  assert.equal(existsSync(join(root, "restore", "missing-head")), false);
});

test("backup checks the source size before loading a snapshot and synchronizes created directory entries", async t => {
  const root = temporaryDirectory();
  const databaseFile = join(root, "state.sqlite");
  const storage = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 3) });
  t.after(() => storage.close());
  const options = { databaseFile, backupDirectory: join(root, "backups"), restoreDirectory: join(root, "restore"),
    keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 4)) };
  let snapshotReads = 0;
  let directorySyncs = 0;
  const read = fs.readFileSync;
  const sync = fs.fsyncSync;
  const readMock = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    if (String(args[0]).endsWith("snapshot.sqlite")) snapshotReads++;
    return read(...args);
  });
  const syncMock = t.mock.method(fs, "fsyncSync", (descriptor: number) => {
    if (fs.fstatSync(descriptor).isDirectory()) directorySyncs++;
    return sync(descriptor);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(new LocalSqliteBackup({ ...options, maxArchiveBytes: 100 }).create("limited.mnbackup"), hasBackupCode("BACKUP_ARCHIVE_TOO_LARGE"));
    assert.equal(snapshotReads, 0);
    const backup = new LocalSqliteBackup(options);
    await backup.create("state.mnbackup");
    assert.ok(directorySyncs > 0);
    const before = directorySyncs;
    await backup.restore("state.mnbackup", "restored.sqlite");
    assert.ok(directorySyncs > before);
  } finally { readMock.mock.restore(); syncMock.mock.restore(); syncBuiltinESMExports(); }
});

test("a concurrent restore destination is never removed by failed CAS creation", async (t) => {
  const root = temporaryDirectory();
  const databaseFile = join(root, "state.sqlite");
  const storage = new SqliteStorage({ databaseFile, hmacKey: randomBytes(32) });
  const restoreDirectory = join(root, "restore");
  const backup = new LocalSqliteBackup({ databaseFile, backupDirectory: join(root, "backups"), restoreDirectory,
    keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 1)) });
  try {
    await backup.create("state.mnbackup");
    const target = join(fs.realpathSync(restoreDirectory), "restored.sqlite.cas");
    const marker = join(target, "existing-user-data");
    const originalMkdir = fs.mkdirSync;
    const mock = t.mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
      if (String(args[0]) === target) {
        originalMkdir(target);
        writeFileSync(marker, "preserve");
        throw Object.assign(new Error("target exists"), { code: "EEXIST" });
      }
      return Reflect.apply(originalMkdir, fs, args);
    });
    syncBuiltinESMExports();
    try { await assert.rejects(backup.restore("state.mnbackup", "restored.sqlite")); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(existsSync(marker), true);
    assert.equal(readFileSync(marker, "utf8"), "preserve");
    assert.equal(existsSync(join(restoreDirectory, "restored.sqlite")), false);
  } finally { storage.close(); }
});

test("本地备份从活动 WAL 生成包含 CAS 的统一加密快照", async () => {
  const root = temporaryDirectory();
  const databaseFile = join(root, "state.sqlite");
  const casDirectory = join(root, "cas");
  const backupDirectory = join(root, "backups");
  const restoreDirectory = join(root, "restore");
  const masterKey = Buffer.alloc(32, 0x5a);
  const hmacKey = randomBytes(32);
  const storage = new SqliteStorage({ databaseFile, hmacKey });
  const cas = new FileCas({ rootDir: casDirectory });
  const asset = await cas.put(Buffer.from("private-cas-marker"));
  const backup = new LocalSqliteBackup({
    databaseFile,
    casDirectory,
    backupDirectory,
    restoreDirectory,
    keyProvider: new InMemoryKeyProvider(masterKey),
    now: () => new Date("2026-09-04T08:00:00.000Z")
  });

  try {
    await storage.commit({
      event: {
        tenantId: "local",
        aggregateType: "workspace",
        aggregateId: "workspace-1",
        expectedStreamVersion: 0,
        type: "workspace.created",
        actorId: "local-owner",
        generation: 1,
        correlationId: "backup-test",
        publicPayload: { marker: "private-backup-marker" }
      }
    });

    const created = await backup.create("state.mnbackup");
    assert.equal(created.manifest.format, "muniu-agent-os-local-backup");
    assert.equal(created.manifest.manifestVersion, 1);
    assert.deepEqual(created.manifest.capabilities, { sqlite: true, cas: true });
    assert.equal(created.manifest.payload.mediaType, "application/vnd.muniu.agent-os-local-state+json");
    assert.equal(created.manifest.payload.casObjects, 1);
    assert.equal(created.manifest.payload.casBytes, Buffer.byteLength("private-cas-marker"));
    assert.equal(created.manifest.encryption.algorithm, "AES-256-GCM");
    assert.equal(created.manifest.createdAt, "2026-09-04T08:00:00.000Z");

    const archiveText = readFileSync(created.file, "utf8");
    assert.doesNotMatch(archiveText, /private-backup-marker/);
    assert.doesNotMatch(archiveText, /private-cas-marker/);
    assert.equal(archiveText.includes(masterKey.toString("base64")), false);

    const checked = await backup.check("state.mnbackup");
    assert.equal(checked.verified, true);
    assert.deepEqual(checked.manifest, created.manifest);

    const restored = await backup.restore("state.mnbackup", "restored.sqlite");
    const database = new DatabaseSync(restored.file, { readOnly: true });
    try {
      assert.equal(database.prepare("select count(*) as count from events").get()!.count, 1);
      assert.equal(database.prepare("pragma integrity_check").get()!.integrity_check, "ok");
    } finally {
      database.close();
    }
    const restoredCas = new FileCas({ rootDir: restored.casDirectory });
    assert.equal((await restoredCas.get(asset.digest)).toString(), "private-cas-marker");
  } finally {
    await storage.close();
  }
});

test("校验拒绝清单篡改、密文篡改和错误密钥", async () => {
  const root = temporaryDirectory();
  const databaseFile = join(root, "state.sqlite");
  const backupDirectory = join(root, "backups");
  const restoreDirectory = join(root, "restore");
  const storage = new SqliteStorage({ databaseFile, hmacKey: randomBytes(32) });
  const key = Buffer.alloc(32, 0x21);
  const backup = new LocalSqliteBackup({
    databaseFile,
    backupDirectory,
    restoreDirectory,
    keyProvider: new InMemoryKeyProvider(key)
  });

  try {
    const created = await backup.create("valid.mnbackup");
    const original = JSON.parse(readFileSync(created.file, "utf8")) as BackupFixture;

    const changedManifest = {
      ...original,
      manifest: { ...original.manifest, createdAt: "2026-09-05T00:00:00.000Z" }
    };
    writeFileSync(join(backupDirectory, "manifest-tampered.mnbackup"), JSON.stringify(changedManifest));
    await assert.rejects(
      backup.check("manifest-tampered.mnbackup"),
      hasBackupCode("BACKUP_INTEGRITY_FAILED")
    );

    const changedCiphertext = {
      ...original,
      envelope: {
        ...original.envelope,
        ciphertext: `${original.envelope.ciphertext.slice(0, -4)}AAAA`
      }
    };
    writeFileSync(join(backupDirectory, "ciphertext-tampered.mnbackup"), JSON.stringify(changedCiphertext));
    await assert.rejects(
      backup.check("ciphertext-tampered.mnbackup"),
      hasBackupCode("BACKUP_DECRYPTION_FAILED")
    );

    const wrongKey = new LocalSqliteBackup({
      databaseFile,
      backupDirectory,
      restoreDirectory,
      keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 0x22))
    });
    await assert.rejects(wrongKey.check("valid.mnbackup"), hasBackupCode("BACKUP_DECRYPTION_FAILED"));

    const plaintext = await new EnvelopeCipher(new InMemoryKeyProvider(key)).decrypt(original.envelope);
    try {
      const manifest = {
        ...original.manifest,
        payload: { ...original.manifest.payload, sqliteSchemaVersion: "999" }
      };
      const manifestSha256 = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
      const envelope = await new EnvelopeCipher(new InMemoryKeyProvider(key)).encrypt(plaintext, {
        tenantId: "local",
        purpose: "local-state-backup",
        manifestSha256
      });
      writeFileSync(
        join(backupDirectory, "schema-mismatch.mnbackup"),
        JSON.stringify({ manifest, envelope })
      );
    } finally {
      plaintext.fill(0);
    }
    await assert.rejects(
      backup.check("schema-mismatch.mnbackup"),
      hasBackupCode("BACKUP_INTEGRITY_FAILED")
    );
  } finally {
    await storage.close();
  }
});

test("restore 拒绝覆盖、路径穿越和符号链接", async () => {
  const root = temporaryDirectory();
  const databaseFile = join(root, "state.sqlite");
  const backupDirectory = join(root, "backups");
  const restoreDirectory = join(root, "restore");
  const storage = new SqliteStorage({ databaseFile, hmacKey: randomBytes(32) });
  const backup = new LocalSqliteBackup({
    databaseFile,
    backupDirectory,
    restoreDirectory,
    keyProvider: new InMemoryKeyProvider(randomBytes(32))
  });

  try {
    const created = await backup.create("state.mnbackup");
    writeFileSync(join(restoreDirectory, "existing.sqlite"), "keep");

    await assert.rejects(
      backup.restore("state.mnbackup", "existing.sqlite"),
      hasBackupCode("BACKUP_DESTINATION_EXISTS")
    );
    assert.equal(readFileSync(join(restoreDirectory, "existing.sqlite"), "utf8"), "keep");

    await assert.rejects(
      backup.restore("state.mnbackup", "../escaped.sqlite"),
      hasBackupCode("BACKUP_INVALID_PATH")
    );
    assert.equal(existsSync(join(root, "escaped.sqlite")), false);

    mkdirSync(join(restoreDirectory, "cas-conflict.sqlite.cas"));
    await assert.rejects(
      backup.restore("state.mnbackup", "cas-conflict.sqlite"),
      hasBackupCode("BACKUP_DESTINATION_EXISTS")
    );
    assert.equal(existsSync(join(restoreDirectory, "cas-conflict.sqlite")), false);

    symlinkSync(created.file, join(backupDirectory, "linked.mnbackup"));
    await assert.rejects(backup.check("linked.mnbackup"), hasBackupCode("BACKUP_INVALID_PATH"));
  } finally {
    await storage.close();
  }
});

test("create 在 CAS 对象摘要损坏时失败关闭", async () => {
  const root = temporaryDirectory();
  const databaseFile = join(root, "state.sqlite");
  const casDirectory = join(root, "cas");
  const storage = new SqliteStorage({ databaseFile, hmacKey: randomBytes(32) });
  const cas = new FileCas({ rootDir: casDirectory });
  const stored = await cas.put(Buffer.from("original"));
  writeFileSync(stored.path!, "tampered");
  const backup = new LocalSqliteBackup({
    databaseFile,
    casDirectory,
    backupDirectory: join(root, "backups"),
    restoreDirectory: join(root, "restore"),
    keyProvider: new InMemoryKeyProvider(randomBytes(32)),
  });
  try {
    await assert.rejects(
      backup.create("corrupt.mnbackup"),
      hasBackupCode("BACKUP_INTEGRITY_FAILED")
    );
    assert.equal(existsSync(join(root, "backups", "corrupt.mnbackup")), false);
  } finally {
    await storage.close();
  }
});

test("create 使用 create-only 语义并报告稳定错误", async () => {
  const root = temporaryDirectory();
  const databaseFile = join(root, "state.sqlite");
  const backupDirectory = join(root, "backups");
  const restoreDirectory = join(root, "restore");
  const storage = new SqliteStorage({ databaseFile, hmacKey: randomBytes(32) });
  const backup = new LocalSqliteBackup({
    databaseFile,
    backupDirectory,
    restoreDirectory,
    keyProvider: new InMemoryKeyProvider(randomBytes(32))
  });

  try {
    await backup.create("state.mnbackup");
    await assert.rejects(
      backup.create("state.mnbackup"),
      hasBackupCode("BACKUP_DESTINATION_EXISTS")
    );

    const limited = new LocalSqliteBackup({
      databaseFile,
      backupDirectory,
      restoreDirectory,
      keyProvider: new InMemoryKeyProvider(randomBytes(32)),
      maxArchiveBytes: 100
    });
    await assert.rejects(
      limited.create("too-large.mnbackup"),
      hasBackupCode("BACKUP_ARCHIVE_TOO_LARGE")
    );
    assert.equal(existsSync(join(backupDirectory, "too-large.mnbackup")), false);
  } finally {
    await storage.close();
  }

  const missing = new LocalSqliteBackup({
    databaseFile: join(root, "missing.sqlite"),
    backupDirectory,
    restoreDirectory,
    keyProvider: new InMemoryKeyProvider(randomBytes(32))
  });
  await assert.rejects(missing.create("missing.mnbackup"), hasBackupCode("BACKUP_SOURCE_NOT_FOUND"));
});
