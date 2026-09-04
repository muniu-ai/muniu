// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

export interface CasPutResult {
  readonly digest: string;
  readonly byteLength: number;
  readonly created: boolean;
  readonly path?: string;
  readonly key?: string;
}

export interface ContentAddressedStorage {
  put(bytes: Uint8Array): Promise<CasPutResult>;
  get(digest: string): Promise<Buffer>;
  has(digest: string): Promise<boolean>;
  gcOrphans(referencedDigests: ReadonlySet<string>, olderThan: Date): Promise<readonly string[]>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("CAS digest must be lowercase SHA-256");
}

function verifyExisting(path: string, digest: string): void {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error("CAS object is not a regular file");
  if (sha256(readFileSync(path)) !== digest) throw new Error("Existing CAS object digest mismatch");
}

function assertPrivateDirectory(path: string): void {
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("CAS path must be a regular directory");
  }
  if ((status.mode & 0o077) !== 0) throw new Error("CAS directory permissions are too broad");
}

function syncDirectory(path: string): void {
  const handle = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

export interface FileCasOptions {
  readonly rootDir: string;
}

export class FileCas implements ContentAddressedStorage {
  readonly #rootDir: string;

  constructor(options: FileCasOptions) {
    this.#rootDir = options.rootDir;
    mkdirSync(join(this.#rootDir, "sha256"), { recursive: true, mode: 0o700 });
    assertPrivateDirectory(this.#rootDir);
    assertPrivateDirectory(join(this.#rootDir, "sha256"));
  }

  #path(digest: string): string {
    assertDigest(digest);
    return join(this.#rootDir, "sha256", digest.slice(0, 2), digest);
  }

  async put(bytes: Uint8Array): Promise<CasPutResult> {
    const digest = sha256(bytes);
    const path = this.#path(digest);
    const directory = join(this.#rootDir, "sha256", digest.slice(0, 2));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(directory);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let handle: number | undefined;
    try {
      handle = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(handle, bytes);
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      try {
        linkSync(temporaryPath, path);
        syncDirectory(directory);
        return { digest, byteLength: bytes.byteLength, created: true, path };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        verifyExisting(path, digest);
        return { digest, byteLength: bytes.byteLength, created: false, path };
      }
    } catch (error) {
      if (handle !== undefined) {
        closeSync(handle);
        unlinkSync(temporaryPath);
      }
      throw error;
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  async get(digest: string): Promise<Buffer> {
    const path = this.#path(digest);
    verifyExisting(path, digest);
    return readFileSync(path);
  }

  async has(digest: string): Promise<boolean> {
    const path = this.#path(digest);
    if (!existsSync(path)) return false;
    verifyExisting(path, digest);
    return true;
  }

  async gcOrphans(
    referencedDigests: ReadonlySet<string>,
    olderThan: Date
  ): Promise<readonly string[]> {
    const removed: string[] = [];
    const root = join(this.#rootDir, "sha256");
    for (const prefix of readdirSync(root, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const directory = join(root, prefix.name);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".tmp")) {
          const temporaryPath = join(directory, entry.name);
          if (statSync(temporaryPath).mtimeMs < olderThan.getTime()) unlinkSync(temporaryPath);
          continue;
        }
        if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        if (referencedDigests.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (statSync(path).mtimeMs >= olderThan.getTime()) continue;
        unlinkSync(path);
        removed.push(entry.name);
      }
    }
    return removed.sort();
  }
}

export interface S3ObjectSummary {
  readonly key: string;
  readonly lastModified?: Date;
}

export interface S3ClientLike {
  headObject(input: { readonly bucket: string; readonly key: string }): Promise<
    | { readonly contentLength?: number }
    | undefined
  >;
  putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly ifNoneMatch: "*";
    readonly checksumSha256: string;
  }): Promise<boolean>;
  getObject(input: { readonly bucket: string; readonly key: string }): Promise<Uint8Array>;
  listObjects(input: { readonly bucket: string; readonly prefix: string }): Promise<readonly S3ObjectSummary[]>;
  deleteObjects(input: { readonly bucket: string; readonly keys: readonly string[] }): Promise<void>;
}

export interface S3CasOptions {
  readonly client: S3ClientLike;
  readonly bucket: string;
  readonly prefix?: string;
}

export class S3Cas implements ContentAddressedStorage {
  readonly #client: S3ClientLike;
  readonly #bucket: string;
  readonly #prefix: string;

  constructor(options: S3CasOptions) {
    this.#client = options.client;
    this.#bucket = options.bucket;
    const prefix = options.prefix ?? "v2/";
    this.#prefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    if (this.#prefix !== "v2/" && !this.#prefix.startsWith("v2/")) {
      throw new TypeError("S3 CAS prefix must remain under v2/");
    }
  }

  #key(digest: string): string {
    assertDigest(digest);
    return `${this.#prefix}sha256/${digest}`;
  }

  async put(bytes: Uint8Array): Promise<CasPutResult> {
    const digest = sha256(bytes);
    const key = this.#key(digest);
    const created = await this.#client.putObject({
      bucket: this.#bucket,
      key,
      body: bytes,
      ifNoneMatch: "*",
      checksumSha256: Buffer.from(digest, "hex").toString("base64")
    });
    if (!created) {
      const existing = Buffer.from(await this.#client.getObject({ bucket: this.#bucket, key }));
      if (sha256(existing) !== digest) throw new Error("Existing S3 CAS object digest mismatch");
    }
    return { digest, byteLength: bytes.byteLength, created, key };
  }

  async get(digest: string): Promise<Buffer> {
    const value = Buffer.from(await this.#client.getObject({
      bucket: this.#bucket,
      key: this.#key(digest)
    }));
    if (sha256(value) !== digest) throw new Error("S3 CAS object digest mismatch");
    return value;
  }

  async has(digest: string): Promise<boolean> {
    return Boolean(await this.#client.headObject({ bucket: this.#bucket, key: this.#key(digest) }));
  }

  async gcOrphans(
    referencedDigests: ReadonlySet<string>,
    olderThan: Date
  ): Promise<readonly string[]> {
    const objects = await this.#client.listObjects({
      bucket: this.#bucket,
      prefix: `${this.#prefix}sha256/`
    });
    const keys: string[] = [];
    const digests: string[] = [];
    for (const object of objects) {
      const digest = object.key.slice(`${this.#prefix}sha256/`.length);
      if (!/^[a-f0-9]{64}$/.test(digest) || referencedDigests.has(digest)) continue;
      if (!object.lastModified || object.lastModified.getTime() >= olderThan.getTime()) continue;
      keys.push(object.key);
      digests.push(digest);
    }
    if (keys.length > 0) await this.#client.deleteObjects({ bucket: this.#bucket, keys });
    return digests.sort();
  }
}
