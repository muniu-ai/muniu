import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { S3CompatibleArtifactStore } from "./artifactRemoteStore.js";

export interface RunScopedCasObjectRef {
  readonly schemaVersion: 1;
  readonly objectKey: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly contentType: string;
}

export interface RunScopedCasPutInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly contentType: string;
  readonly content: Buffer | Uint8Array | string;
}

export interface RunScopedCasOptions {
  readonly localRoot: string;
  readonly remoteStore?: S3CompatibleArtifactStore;
  readonly remotePrefix?: string;
  /** Enterprise callers set this so a missing/corrupt S3 object can never be
   * hidden by the compatibility filesystem mirror. */
  readonly requireRemote?: boolean;
}

export class RunScopedCasIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunScopedCasIntegrityError";
  }
}

/**
 * API-owned, run-scoped content-addressed storage. Object keys contain only
 * hashes produced by this class; caller-controlled tenant/project/run ids are
 * never used as filesystem or object-store path segments.
 *
 * The class deliberately knows nothing about Gate artifacts. Implementation
 * diffs, usage receipts and other enterprise evidence can reuse the same byte
 * truth layer and bind the returned ref in their own durable domain record.
 */
export class RunScopedCas {
  private readonly localRoot: string;
  private readonly remoteStore?: S3CompatibleArtifactStore;
  private readonly remotePrefix: string;
  private readonly requireRemote: boolean;

  constructor(options: RunScopedCasOptions) {
    this.localRoot = resolve(options.localRoot);
    this.remoteStore = options.remoteStore;
    this.remotePrefix = normalizePrefix(options.remotePrefix);
    this.requireRemote = options.requireRemote ?? false;
    if (this.requireRemote && !this.remoteStore) {
      throw new TypeError("RunScopedCas requires a remote store in enforced mode");
    }
  }

  async put(input: RunScopedCasPutInput): Promise<RunScopedCasObjectRef> {
    for (const [field, value] of [
      ["tenantId", input.tenantId],
      ["projectId", input.projectId],
      ["runId", input.runId]
    ] as const) {
      if (!value || value !== value.trim() || /[\r\n\0]/u.test(value)) {
        throw new TypeError(`Invalid RunScopedCas ${field}`);
      }
    }
    const content = toBuffer(input.content);
    const digest = sha256(content);
    const objectKey = this.objectKey(input, digest);
    const ref: RunScopedCasObjectRef = Object.freeze({
      schemaVersion: 1,
      objectKey,
      digest,
      byteLength: content.byteLength,
      contentType: normalizeContentType(input.contentType)
    });

    if (this.remoteStore) {
      const stored = await this.remoteStore.putObject(objectKey, content, {
        contentType: ref.contentType,
        metadata: {
          "mn-sha256": ref.digest,
          "mn-byte-length": String(ref.byteLength),
          "mn-schema-version": "1"
        }
      });
      if (stored.sha256 !== ref.digest || stored.bytes !== ref.byteLength) {
        throw new RunScopedCasIntegrityError(
          `CAS remote write verification failed for ${objectKey}`
        );
      }
    }

    // In enforced enterprise mode the remote object is the sole source of
    // truth. A local mirror must not make a deleted/tampered S3 object appear
    // healthy. Local/classic uses the filesystem CAS for compatibility.
    if (!this.requireRemote) {
      const destination = this.localPath(objectKey);
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, content);
      await rename(temporary, destination);
    }
    return ref;
  }

  /** Returns verified bytes, undefined for a missing object, and throws when
   * the stored bytes do not match the immutable reference. */
  async readVerified(ref: RunScopedCasObjectRef): Promise<Buffer | undefined> {
    validateRef(ref);
    let content: Buffer | undefined;
    if (this.requireRemote) {
      content = await this.remoteStore!.getObject(ref.objectKey);
    } else {
      content = await this.readLocal(ref.objectKey);
      if (!content && this.remoteStore) {
        content = await this.remoteStore.getObject(ref.objectKey);
      }
    }
    if (!content) return undefined;
    if (content.byteLength !== ref.byteLength) {
      throw new RunScopedCasIntegrityError(
        `CAS object ${ref.objectKey} byteLength mismatch`
      );
    }
    if (sha256(content) !== ref.digest) {
      throw new RunScopedCasIntegrityError(
        `CAS object ${ref.objectKey} digest mismatch`
      );
    }
    return content;
  }

  private objectKey(input: RunScopedCasPutInput, digest: string): string {
    const scope = [input.tenantId, input.projectId, input.runId]
      .map((value) => sha256(Buffer.from(value, "utf8")).slice(0, 24));
    const suffix = `cas/v1/${scope.join("/")}/${digest.slice(0, 2)}/${digest}`;
    return this.remotePrefix ? `${this.remotePrefix}/${suffix}` : suffix;
  }

  private localPath(objectKey: string): string {
    // objectKey is generated internally and validated again before read.
    return join(this.localRoot, ...objectKey.split("/"));
  }

  private async readLocal(objectKey: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.localPath(objectKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

function validateRef(ref: RunScopedCasObjectRef): void {
  if (
    ref.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/u.test(ref.digest) ||
    !Number.isSafeInteger(ref.byteLength) ||
    ref.byteLength < 0 ||
    !/^(?:[a-f0-9]{24}\/)?cas\/v1\/[a-f0-9]{24}\/[a-f0-9]{24}\/[a-f0-9]{24}\/[a-f0-9]{2}\/[a-f0-9]{64}$/u.test(
      ref.objectKey
    ) ||
    !ref.objectKey.endsWith(`/${ref.digest}`)
  ) {
    throw new TypeError("Invalid RunScopedCas object reference");
  }
}

function normalizePrefix(value: string | undefined): string {
  if (!value?.trim()) return "";
  const normalized = value.trim().replace(/^\/+|\/+$/gu, "");
  if (!/^[A-Za-z0-9._/-]+$/u.test(normalized) || normalized.includes("..")) {
    throw new TypeError("Invalid RunScopedCas remote prefix");
  }
  // Hash arbitrary deployment prefixes into one safe stable segment so the
  // strict object-ref parser never has to trust caller-provided paths.
  return sha256(Buffer.from(normalized, "utf8")).slice(0, 24);
}

function normalizeContentType(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n\0]/u.test(normalized)) {
    throw new TypeError("Invalid CAS content type");
  }
  return normalized;
}

function toBuffer(value: Buffer | Uint8Array | string): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
