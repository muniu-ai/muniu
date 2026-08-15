import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  canonicalJson,
  deepFreezeJsonValue,
  digestSpecRevision
} from "./canonical.js";
import {
  assertSafeSpecSetId,
  atomicWriteText,
  isSafeSpecSetId
} from "./fileUtils.js";
import type {
  SpecRepositoryRecord,
  SpecRevision,
  SpecSet
} from "./types.js";
import { isStrictTimestamp, validateSpecRevision } from "./validation.js";

interface RepositoryDocument {
  apiVersion: "mn.dev/spec-repository/v1";
  kind: "SpecSet";
  specSet: SpecSet;
  revisions: SpecRevision[];
}
const REPOSITORY_DOCUMENT_FIELDS = new Set([
  "apiVersion",
  "kind",
  "specSet",
  "revisions"
]);
const SPEC_SET_FIELDS = new Set([
  "id",
  "title",
  "description",
  "latestRevision",
  "createdAt",
  "updatedAt"
]);

const WRITE_LOCK_TIMEOUT_MS = 5_000;
const STALE_WRITE_LOCK_MS = 30_000;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revisionEventTimestamp(revision: SpecRevision): number {
  return Math.max(
    Date.parse(revision.createdAt),
    revision.approvedAt === undefined
      ? Date.parse(revision.createdAt)
      : Date.parse(revision.approvedAt)
  );
}

function revisionEventTime(revision: SpecRevision): string {
  return new Date(revisionEventTimestamp(revision)).toISOString();
}

function deterministicDocument(record: SpecRepositoryRecord): string {
  const document: RepositoryDocument = {
    apiVersion: "mn.dev/spec-repository/v1",
    kind: "SpecSet",
    specSet: record.specSet,
    revisions: record.revisions
  };
  const canonical = JSON.parse(canonicalJson(document)) as unknown;
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function parseRepositoryDocument(content: string): SpecRepositoryRecord {
  let document: unknown;
  try {
    document = JSON.parse(content) as unknown;
  } catch (error) {
    throw new TypeError("Invalid persisted spec document", { cause: error });
  }
  if (
    !isRecord(document) ||
    document.apiVersion !== "mn.dev/spec-repository/v1" ||
    document.kind !== "SpecSet" ||
    !isRecord(document.specSet) ||
    !Array.isArray(document.revisions)
  ) {
    throw new TypeError("Invalid persisted spec document envelope");
  }
  if (
    Object.keys(document).some((field) => !REPOSITORY_DOCUMENT_FIELDS.has(field)) ||
    Object.keys(document.specSet).some((field) => !SPEC_SET_FIELDS.has(field))
  ) {
    throw new TypeError("Persisted spec document contains unsupported fields");
  }

  const specSet = document.specSet as unknown as SpecSet;
  assertSafeSpecSetId(specSet.id);
  if (
    typeof specSet.title !== "string" ||
    specSet.title.trim().length === 0 ||
    !Number.isSafeInteger(specSet.latestRevision) ||
    specSet.latestRevision < 0 ||
    !isStrictTimestamp(specSet.createdAt) ||
    !isStrictTimestamp(specSet.updatedAt) ||
    Date.parse(specSet.updatedAt) < Date.parse(specSet.createdAt) ||
    (specSet.description !== undefined &&
      typeof specSet.description !== "string")
  ) {
    throw new TypeError("Invalid persisted spec set metadata");
  }

  const revisions = document.revisions as unknown as SpecRevision[];
  for (const revision of revisions) {
    if (typeof revision.digest !== "string") {
      throw new TypeError("Persisted spec revision must include a digest");
    }
    const validation = validateSpecRevision(revision);
    if (!validation.valid || revision.specSetId !== specSet.id) {
      throw new TypeError("Invalid persisted spec revision");
    }
  }
  const numbers = revisions.map((revision) => revision.revision);
  const expectedNumbers = Array.from(
    { length: revisions.length },
    (_value, index) => index + 1
  );
  if (
    numbers.some((revision, index) => revision !== expectedNumbers[index]) ||
    specSet.latestRevision !== revisions.length
  ) {
    throw new TypeError("Persisted spec revisions are not append-only");
  }
  for (let index = 1; index < revisions.length; index += 1) {
    if (
      Date.parse(revisions[index]!.createdAt) <
      revisionEventTimestamp(revisions[index - 1]!)
    ) {
      throw new TypeError("Persisted spec revision event timestamps are not monotonic");
    }
  }
  if (revisions.length > 0) {
    if (
      Date.parse(revisions[0]!.createdAt) < Date.parse(specSet.createdAt) ||
      specSet.updatedAt !== revisionEventTime(revisions.at(-1)!)
    ) {
      throw new TypeError("Persisted spec set timestamps do not match its revisions");
    }
  }

  return deepFreezeJsonValue({ specSet, revisions });
}

function normalizeSpecSetForCreate(input: SpecSet): SpecSet {
  let cloned: unknown;
  try {
    cloned = JSON.parse(canonicalJson(input)) as unknown;
  } catch (error) {
    throw new TypeError("Spec set must contain canonical declarative JSON", {
      cause: error
    });
  }
  if (!isRecord(cloned)) throw new TypeError("Spec set must be an object");
  if (Object.keys(cloned).some((field) => !SPEC_SET_FIELDS.has(field))) {
    throw new TypeError("Spec set contains unsupported fields");
  }
  const specSet = cloned as unknown as SpecSet;
  assertSafeSpecSetId(specSet.id);
  if (typeof specSet.title !== "string" || specSet.title.trim().length === 0) {
    throw new TypeError("Spec set title must be a non-empty string");
  }
  if (
    specSet.description !== undefined &&
    typeof specSet.description !== "string"
  ) {
    throw new TypeError("Spec set description must be a string when provided");
  }
  if (
    !Number.isSafeInteger(specSet.latestRevision) ||
    specSet.latestRevision < 0
  ) {
    throw new TypeError("Spec set latestRevision must be a non-negative integer");
  }
  for (const [field, value] of [
    ["createdAt", specSet.createdAt],
    ["updatedAt", specSet.updatedAt]
  ] as const) {
    if (!isStrictTimestamp(value)) {
      throw new TypeError(`Spec set ${field} must be an ISO date string`);
    }
  }
  if (Date.parse(specSet.updatedAt) < Date.parse(specSet.createdAt)) {
    throw new TypeError("Spec set updatedAt must be at or after createdAt");
  }
  return specSet;
}

function normalizeRevision(revision: SpecRevision): SpecRevision {
  const validation = validateSpecRevision(revision);
  if (!validation.valid) {
    throw new TypeError(
      `Invalid spec revision: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
  }
  const normalized = {
    ...revision,
    digest: digestSpecRevision(revision)
  };
  return JSON.parse(canonicalJson(normalized)) as SpecRevision;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readStoredFile(filePath: string): Promise<string | undefined> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed in spec storage: ${filePath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Spec storage path is not a regular file: ${filePath}`);
  }
  return readFile(filePath, "utf8");
}

export class FileSpecRepository {
  readonly rootDir: string;
  private readonly specsDir: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.specsDir = path.join(this.rootDir, "specs");
  }

  private async ensureSpecsDirectory(create: boolean): Promise<boolean> {
    let rootStats;
    try {
      rootStats = await lstat(this.rootDir);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      if (!create) return false;
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      rootStats = await lstat(this.rootDir);
    }
    if (rootStats.isSymbolicLink()) {
      throw new Error(
        `Symbolic links are not allowed for the spec repository root: ${this.rootDir}`
      );
    }
    if (!rootStats.isDirectory()) {
      throw new Error(`Spec repository root is not a directory: ${this.rootDir}`);
    }

    let stats;
    try {
      stats = await lstat(this.specsDir);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
      if (!create) {
        return false;
      }
      await mkdir(this.specsDir, { recursive: true, mode: 0o700 });
      stats = await lstat(this.specsDir);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Symbolic links are not allowed in spec storage: ${this.specsDir}`
      );
    }
    if (!stats.isDirectory()) {
      throw new Error(`Spec storage path is not a directory: ${this.specsDir}`);
    }
    return true;
  }

  private specDirectory(specSetId: string): string {
    assertSafeSpecSetId(specSetId);
    return path.join(this.specsDir, specSetId);
  }

  private parseStoredRecord(
    specSetId: string,
    content: string
  ): SpecRepositoryRecord {
    const record = parseRepositoryDocument(content);
    if (record.specSet.id !== specSetId) {
      throw new Error(
        `Persisted spec set ${record.specSet.id} does not match storage id ${specSetId}`
      );
    }
    return record;
  }

  private async withWriteLock<T>(
    specSetId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.writeQueues.get(specSetId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const release = await this.acquireFileWriteLock(specSetId);
      try {
        return await operation();
      } finally {
        await release();
      }
    });
    const settled = current.then(
      () => undefined,
      () => undefined
    );
    this.writeQueues.set(specSetId, settled);
    try {
      return await current;
    } finally {
      if (this.writeQueues.get(specSetId) === settled) {
        this.writeQueues.delete(specSetId);
      }
    }
  }

  private async acquireFileWriteLock(
    specSetId: string
  ): Promise<() => Promise<void>> {
    assertSafeSpecSetId(specSetId);
    await this.ensureSpecsDirectory(true);
    const lockDirectory = path.join(this.specsDir, ".locks");
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    const lockDirectoryStats = await lstat(lockDirectory);
    if (lockDirectoryStats.isSymbolicLink() || !lockDirectoryStats.isDirectory()) {
      throw new Error(`Spec write lock path is not a safe directory: ${lockDirectory}`);
    }
    const lockPath = path.join(lockDirectory, `${specSetId}.lock`);
    const startedAt = Date.now();

    for (;;) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
          "utf8"
        );
        return async () => {
          await handle.close();
          await rm(lockPath, { force: true });
        };
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
      }

      const lockStats = await lstat(lockPath);
      if (lockStats.isSymbolicLink() || !lockStats.isFile()) {
        throw new Error(`Spec write lock is not a regular file: ${lockPath}`);
      }
      if (Date.now() - lockStats.mtimeMs > STALE_WRITE_LOCK_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt >= WRITE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring spec write lock for ${specSetId}`);
      }
      await delay(10);
    }
  }

  async create(
    specSet: SpecSet,
    initialRevision?: SpecRevision
  ): Promise<SpecRepositoryRecord> {
    const normalizedSpecSet = normalizeSpecSetForCreate(specSet);
    const normalizedInitialRevision = initialRevision
      ? normalizeRevision(initialRevision)
      : undefined;
    if (
      normalizedInitialRevision &&
      (normalizedInitialRevision.specSetId !== normalizedSpecSet.id ||
        normalizedInitialRevision.revision !== 1)
    ) {
      throw new TypeError("Initial revision must be revision 1 of the spec set");
    }
    return this.withWriteLock(normalizedSpecSet.id, async () => {
      await this.ensureSpecsDirectory(true);
      if ((await this.get(normalizedSpecSet.id)) !== undefined) {
        throw new Error(`Spec set ${normalizedSpecSet.id} already exists`);
      }

      const revisions = normalizedInitialRevision
        ? [normalizedInitialRevision]
        : [];
      if (
        revisions[0] &&
        Date.parse(revisions[0].createdAt) < Date.parse(normalizedSpecSet.createdAt)
      ) {
        throw new TypeError(
          "Initial revision createdAt must be at or after the spec set createdAt"
        );
      }
      const expectedLatest = revisions.length;
      if (
        normalizedSpecSet.latestRevision !== 0 &&
        normalizedSpecSet.latestRevision !== expectedLatest
      ) {
        throw new TypeError(
          `Spec set latestRevision must be 0 or ${expectedLatest} when created`
        );
      }

      const record: SpecRepositoryRecord = {
        specSet: {
          ...normalizedSpecSet,
          latestRevision: expectedLatest,
          updatedAt:
            normalizedInitialRevision === undefined
              ? normalizedSpecSet.updatedAt
              : revisionEventTime(normalizedInitialRevision)
        },
        revisions
      };
      const serialized = deterministicDocument(record);
      const validatedRecord = parseRepositoryDocument(serialized);

      const directory = this.specDirectory(normalizedSpecSet.id);
      try {
        await mkdir(directory, { recursive: false });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          throw new Error(`Spec set ${normalizedSpecSet.id} already exists`, { cause: error });
        }
        throw error;
      }

      await atomicWriteText(
        path.join(directory, "spec.yaml"),
        serialized
      );
      return validatedRecord;
    });
  }

  async get(specSetId: string): Promise<SpecRepositoryRecord | undefined> {
    assertSafeSpecSetId(specSetId);
    if (!(await this.ensureSpecsDirectory(false))) {
      return undefined;
    }
    const directory = this.specDirectory(specSetId);
    let directoryStats;
    try {
      directoryStats = await lstat(directory);
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
    if (directoryStats.isSymbolicLink()) {
      throw new Error(
        `Symbolic links are not allowed in spec storage: ${directory}`
      );
    }
    if (!directoryStats.isDirectory()) {
      throw new Error(`Spec storage path is not a directory: ${directory}`);
    }

    const yaml = await readStoredFile(path.join(directory, "spec.yaml"));
    if (yaml !== undefined) {
      return this.parseStoredRecord(specSetId, yaml);
    }
    const json = await readStoredFile(path.join(directory, "spec.json"));
    return json === undefined
      ? undefined
      : this.parseStoredRecord(specSetId, json);
  }

  async list(): Promise<SpecSet[]> {
    if (!(await this.ensureSpecsDirectory(false))) {
      return [];
    }
    let entries;
    try {
      entries = await readdir(this.specsDir, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }

    const records = await Promise.all(
      entries
        .filter(
          (entry) => entry.isDirectory() && isSafeSpecSetId(entry.name)
        )
        .map((entry) => this.get(entry.name))
    );
    return deepFreezeJsonValue(records
      .filter((record): record is SpecRepositoryRecord => record !== undefined)
      .map((record) => record.specSet)
      .sort((left, right) => compareCodeUnits(left.id, right.id)));
  }

  async saveRevision(revision: SpecRevision): Promise<SpecRepositoryRecord> {
    const normalized = normalizeRevision(revision);
    assertSafeSpecSetId(normalized.specSetId);
    return this.withWriteLock(normalized.specSetId, async () => {
      const record = await this.get(normalized.specSetId);
      if (record === undefined) {
        throw new Error(`Spec set ${normalized.specSetId} does not exist`);
      }
      const existing = record.revisions.find(
        (candidate) => candidate.revision === normalized.revision
      );
      if (existing !== undefined) {
        if (existing.digest !== normalized.digest) {
          throw new Error(
            `Revision ${normalized.revision} already exists with a different digest`
          );
        }
        return record;
      }

      const expectedRevision = record.revisions.length + 1;
      if (normalized.revision !== expectedRevision) {
        throw new Error(
          `Expected revision ${expectedRevision} but received ${normalized.revision}`
        );
      }

      const predecessor = record.revisions.at(-1);
      if (
        predecessor &&
        Date.parse(normalized.createdAt) < revisionEventTimestamp(predecessor)
      ) {
        throw new Error(
          `Revision ${normalized.revision} createdAt must be at or after the predecessor event floor`
        );
      }

      const updated: SpecRepositoryRecord = {
        specSet: {
          ...record.specSet,
          latestRevision: normalized.revision,
          updatedAt: revisionEventTime(normalized)
        },
        revisions: [...record.revisions, normalized]
      };
      const serialized = deterministicDocument(updated);
      const validatedRecord = parseRepositoryDocument(serialized);
      await atomicWriteText(
        path.join(this.specDirectory(normalized.specSetId), "spec.yaml"),
        serialized
      );
      return validatedRecord;
    });
  }

  /**
   * Restores a complete, already-versioned repository record from a durable
   * control-plane backend. The whole document is validated before the atomic
   * replacement, so a partial revision history is never exposed.
   */
  async restore(
    input: SpecRepositoryRecord,
    options: { overwrite?: boolean } = {}
  ): Promise<SpecRepositoryRecord> {
    const serialized = deterministicDocument(input);
    const validated = parseRepositoryDocument(serialized);
    const specSetId = validated.specSet.id;
    assertSafeSpecSetId(specSetId);
    return this.withWriteLock(specSetId, async () => {
      await this.ensureSpecsDirectory(true);
      const existing = await this.get(specSetId);
      if (
        existing !== undefined &&
        deterministicDocument(existing) !== serialized &&
        options.overwrite === false
      ) {
        throw new Error(`Spec set ${specSetId} already exists with different content`);
      }
      const directory = this.specDirectory(specSetId);
      try {
        const stats = await lstat(directory);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new Error(`Spec storage path is not a safe directory: ${directory}`);
        }
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        await mkdir(directory, { recursive: false, mode: 0o700 });
      }
      if (existing === undefined || deterministicDocument(existing) !== serialized) {
        await atomicWriteText(path.join(directory, "spec.yaml"), serialized);
      }
      return validated;
    });
  }

  /**
   * Removes a repository record while reconciling an authoritative external
   * control-plane snapshot. Normal Spec lifecycle APIs never call this: Spec
   * revisions remain append-only. It exists solely to compensate an
   * uncommitted file mutation after the enterprise PostgreSQL transaction has
   * failed.
   */
  async removeForAuthoritativeRestore(specSetId: string): Promise<boolean> {
    assertSafeSpecSetId(specSetId);
    return this.withWriteLock(specSetId, async () => {
      const directory = this.specDirectory(specSetId);
      try {
        const stats = await lstat(directory);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new Error(`Spec storage path is not a safe directory: ${directory}`);
        }
      } catch (error) {
        if (isMissingFile(error)) return false;
        throw error;
      }
      await rm(directory, { recursive: true, force: false });
      return true;
    });
  }
}
