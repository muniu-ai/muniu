// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOCK_RECORD_LIMIT = 2_048;
const NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const uid = process.getuid?.();
const lockRoot = path.join(os.tmpdir(), `muniu-agent-session-writer-locks-${String(uid ?? "unsupported")}`);

interface WriterLockRecordV1 {
  readonly schemaVersion: 1;
  readonly identityDigest: string;
  readonly nonce: string;
  readonly pid: number;
  readonly uid: number;
  readonly createdAt: string;
}

interface ReadLockRecord {
  readonly record: WriterLockRecordV1;
  readonly stat: Stats;
}

export interface OsWriterLock {
  readonly identity: string;
  readonly nonce: string;
  readonly released: boolean;
  release(): Promise<void>;
}

export class WriterLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WriterLockError";
  }
}

function identityDigest(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openLockDirectory(directoryPath: string) {
  const handle = await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  const stat = await handle.stat().catch(async (error: unknown) => {
    await handle.close();
    throw error;
  });
  if (!stat.isDirectory() || stat.uid !== uid) {
    await handle.close();
    throw new WriterLockError("writer lock directory has unsafe type or ownership");
  }
  return { handle, stat };
}

let lockRootReady: Promise<void> | undefined;

async function ensureLockRoot(): Promise<void> {
  if (uid === undefined) throw new WriterLockError("writer locks require an operating-system user identity");
  lockRootReady ??= (async () => {
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const { handle } = await openLockDirectory(lockRoot);
    try {
      await handle.chmod(0o700);
      const verified = await handle.stat();
      if ((verified.mode & 0o777) !== 0o700 || verified.uid !== uid) {
        throw new WriterLockError("writer lock directory permissions are not private");
      }
    } finally {
      await handle.close();
    }
  })();
  return lockRootReady;
}

async function syncLockRoot(): Promise<void> {
  const { handle } = await openLockDirectory(lockRoot);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateRecord(value: unknown, expectedDigest: string): WriterLockRecordV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WriterLockError("writer lock has invalid content");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["createdAt", "identityDigest", "nonce", "pid", "schemaVersion", "uid"];
  if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0")
    || record.schemaVersion !== 1
    || record.identityDigest !== expectedDigest
    || typeof record.nonce !== "string"
    || !NONCE_PATTERN.test(record.nonce)
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || record.uid !== uid
    || typeof record.createdAt !== "string"
    || Number.isNaN(Date.parse(record.createdAt))
    || new Date(record.createdAt).toISOString() !== record.createdAt) {
    throw new WriterLockError("writer lock has invalid content");
  }
  return record as unknown as WriterLockRecordV1;
}

async function readLockRecord(filePath: string, expectedDigest: string): Promise<ReadLockRecord> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error: unknown) {
    throw new WriterLockError("writer lock cannot be opened safely", { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1
      || stat.size <= 0 || stat.size > LOCK_RECORD_LIMIT) {
      throw new WriterLockError("writer lock has unsafe type, ownership, permissions, or link count");
    }
    const content = await handle.readFile("utf8");
    if (!content.endsWith("\n") || content.indexOf("\n") !== content.length - 1) {
      throw new WriterLockError("writer lock has invalid framing");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.slice(0, -1));
    } catch (error: unknown) {
      throw new WriterLockError("writer lock has invalid JSON", { cause: error });
    }
    return { record: validateRecord(parsed, expectedDigest), stat };
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function quarantineVerifiedLock(
  filePath: string,
  expectedDigest: string,
  observed: ReadLockRecord,
  reason: "stale" | "release"
): Promise<boolean> {
  const quarantinePath = `${filePath}.${reason}-${observed.record.nonce}-${randomUUID()}`;
  try {
    await rename(filePath, quarantinePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new WriterLockError(`writer lock ${reason} quarantine failed`, { cause: error });
  }

  let moved: ReadLockRecord;
  try {
    moved = await readLockRecord(quarantinePath, expectedDigest);
  } catch (error: unknown) {
    await rename(quarantinePath, filePath).catch(() => {});
    throw error;
  }
  if (moved.record.nonce !== observed.record.nonce || !sameFile(moved.stat, observed.stat)) {
    await rename(quarantinePath, filePath).catch(() => {});
    throw new WriterLockError("writer lock changed while ownership was being verified");
  }
  await unlink(quarantinePath);
  await syncLockRoot();
  return true;
}

class OwnedWriterLock implements OsWriterLock {
  private isReleased = false;

  constructor(
    readonly identity: string,
    readonly nonce: string,
    private readonly digest: string,
    private readonly filePath: string,
    private readonly stat: Stats
  ) {}

  get released(): boolean {
    return this.isReleased;
  }

  async release(): Promise<void> {
    if (this.isReleased) return;
    const current = await readLockRecord(this.filePath, this.digest);
    if (current.record.nonce !== this.nonce || !sameFile(current.stat, this.stat)) {
      throw new WriterLockError("refusing to release a writer lock owned by another nonce");
    }
    const removed = await quarantineVerifiedLock(this.filePath, this.digest, current, "release");
    if (!removed) throw new WriterLockError("writer lock disappeared before release");
    this.isReleased = true;
  }
}

export async function acquireOsWriterLock(identity: string): Promise<OsWriterLock> {
  await ensureLockRoot();
  const digest = identityDigest(identity);
  const filePath = path.join(lockRoot, `${digest}.lock`);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = randomUUID();
    const record: WriterLockRecordV1 = {
      schemaVersion: 1,
      identityDigest: digest,
      nonce,
      pid: process.pid,
      uid: uid as number,
      createdAt: new Date().toISOString()
    };
    let handle;
    try {
      handle = await open(
        filePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new WriterLockError("writer lock could not be created", { cause: error });
      }
      const observed = await readLockRecord(filePath, digest);
      if (processIsAlive(observed.record.pid)) {
        throw new WriterLockError("session already has an active operating-system writer lease");
      }
      await quarantineVerifiedLock(filePath, digest, observed, "stale");
      continue;
    }

    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
        throw new WriterLockError("new writer lock did not retain strict ownership and permissions");
      }
      await handle.close();
      handle = undefined;
      await syncLockRoot();
      return new OwnedWriterLock(identity, nonce, digest, filePath, stat);
    } catch (error: unknown) {
      await handle?.close().catch(() => {});
      const current = await readLockRecord(filePath, digest).catch(() => undefined);
      if (current?.record.nonce === nonce) {
        await quarantineVerifiedLock(filePath, digest, current, "release").catch(() => {});
      }
      throw error;
    }
  }
  throw new WriterLockError("writer lock contention did not converge safely");
}
