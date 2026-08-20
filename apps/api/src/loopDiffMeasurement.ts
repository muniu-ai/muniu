import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Canonical } from "@mn/governance";

export const LOOP_DIFF_MANIFEST_CONTENT_TYPE =
  "application/vnd.mn.loop-diff-manifest+json";
export const MAX_LOOP_DIFF_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_LOOP_DIFF_FILES = 5_000;
const MAX_LOOP_DIFF_TEXT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LOOP_SNAPSHOT_FILES = 100_000;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".mn",
  "node_modules",
  "dist",
  "dist-test",
  "coverage",
  ".cache",
  "target",
  ".gradle"
]);

export interface CanonicalLoopDiffFile {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
  /** Normalized POSIX execution semantics: 0644 or 0755. Missing files use
   * null. Other permission bits are deliberately excluded for portability. */
  readonly beforeMode: number | null;
  readonly afterMode: number | null;
}

export type CanonicalLoopDiffManifest = Readonly<
  | {
      /** Read compatibility only. API authority never emits v1. */
      schemaVersion: 1;
      files: readonly Readonly<Pick<CanonicalLoopDiffFile, "path" | "before" | "after">>[];
    }
  | {
      schemaVersion: 2;
      files: readonly CanonicalLoopDiffFile[];
    }
>;

export interface MeasuredLoopDiff {
  readonly manifest: CanonicalLoopDiffManifest;
  readonly content: Buffer;
  readonly changedFiles: number;
  readonly changedLines: number;
}

export interface AuthoritativeLoopWorkspaceDiff extends MeasuredLoopDiff {
  readonly projectSnapshotDigest: string;
  readonly candidateSnapshotDigest: string;
}

/** Resolves the one deterministic candidate directory admitted for a stage.
 * The worker supplies only this opaque URI; the mount source itself comes from
 * the trusted runtime inspection. */
export async function resolveAuthoritativeCandidateWorkspace(input: {
  readonly workspaceUri: string;
  readonly leaseId: string;
  readonly scratchRoot: string;
  readonly runId: string;
  readonly implementationAttempt: number;
  readonly candidateId: string;
}): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(input.workspaceUri);
  } catch (error) {
    throw new TypeError("workspaceUri must be a valid mn sandbox URI", { cause: error });
  }
  const rawSegments = parsed.pathname.split("/").filter(Boolean);
  let segments: string[];
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch (error) {
    throw new TypeError("workspaceUri contains invalid percent encoding", { cause: error });
  }
  const legacyWorkspace =
    `${input.runId}--implementation-${input.implementationAttempt}-${input.candidateId}`;
  const governedWorkspace = `${input.runId}--governed-${input.candidateId}`;
  const workspace = segments[1];
  if (
    parsed.protocol !== "mn:" ||
    parsed.hostname !== "sandbox" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    segments.length !== 2 ||
    segments[0] !== input.leaseId ||
    (workspace !== legacyWorkspace && workspace !== governedWorkspace) ||
    segments.some((segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    )
  ) {
    throw new TypeError(
      "workspaceUri is not bound to the active lease, run and candidate"
    );
  }
  const scratchRoot = await realpath(resolve(input.scratchRoot));
  const candidate = resolve(scratchRoot, workspace!);
  const stats = await lstat(candidate);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError("workspaceUri does not identify a real candidate directory");
  }
  const canonical = await realpath(candidate);
  if (!within(scratchRoot, canonical)) {
    throw new TypeError("workspaceUri escapes the authoritative scratch mount");
  }
  return canonical;
}

interface WorkspaceSnapshotEntry {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly digest: string;
  readonly byteLength: number;
  readonly mode: number | null;
}

/**
 * Builds the implementation manifest from API-read filesystem state. Neither
 * manifest bytes nor counts cross the worker trust boundary. Unchanged binary,
 * large and symlink entries may exist, but changing any of them fails closed
 * because a line budget cannot be proven for that change.
 */
export async function measureAuthoritativeLoopWorkspaceDiff(input: {
  readonly projectRoot: string;
  readonly candidateRoot: string;
}): Promise<AuthoritativeLoopWorkspaceDiff> {
  await assertNoIgnoredWorkspaceInputs(input.candidateRoot);
  const project = await snapshotWorkspace(input.projectRoot, "projectRoot");
  const candidate = await snapshotWorkspace(input.candidateRoot, "candidateRoot");
  const paths = [...new Set([...project.entries.keys(), ...candidate.entries.keys()])]
    .filter((path) => !sameEntry(project.entries.get(path), candidate.entries.get(path)))
    .sort(compareCodeUnits);
  if (paths.length > MAX_LOOP_DIFF_FILES) {
    throw new TypeError(`Loop diff contains more than ${MAX_LOOP_DIFF_FILES} changed files`);
  }

  const files: CanonicalLoopDiffFile[] = [];
  let encodedBytes = 0;
  for (const path of paths) {
    const beforeEntry = project.entries.get(path);
    const afterEntry = candidate.entries.get(path);
    if (beforeEntry?.kind === "symlink" || afterEntry?.kind === "symlink") {
      throw new TypeError(`Loop diff changed symbolic link ${path}`);
    }
    const before = beforeEntry
      ? await readChangedText(project.root, path, beforeEntry, "projectRoot")
      : null;
    const after = afterEntry
      ? await readChangedText(candidate.root, path, afterEntry, "candidateRoot")
      : null;
    const file = Object.freeze({
      path,
      before,
      after,
      beforeMode: beforeEntry?.mode ?? null,
      afterMode: afterEntry?.mode ?? null
    });
    encodedBytes += Buffer.byteLength(JSON.stringify(file), "utf8") + 1;
    if (encodedBytes > MAX_LOOP_DIFF_MANIFEST_BYTES) {
      throw new TypeError("Loop diff manifest exceeds the 16 MiB limit");
    }
    files.push(file);
  }
  const measured = measureLoopDiffManifest(
    Buffer.from(JSON.stringify({ schemaVersion: 2, files }), "utf8")
  );
  return Object.freeze({
    ...measured,
    projectSnapshotDigest: project.digest,
    candidateSnapshotDigest: candidate.digest
  });
}

/** Candidate snapshots deliberately exclude generated/dependency trees. They
 * therefore cannot be recreated inside writable scratch and still influence
 * a Gate. Rejecting them closes PATH/plugin/config shadowing (for example
 * `node_modules/.bin/node`) instead of silently excluding executable bytes
 * from diff and budget truth. */
export async function assertNoIgnoredWorkspaceInputs(
  requestedRoot: string
): Promise<void> {
  const root = await realpath(resolve(requestedRoot));
  let directories = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const child of children) {
      const repositoryPath = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isSymbolicLink()) {
        throw new TypeError(
          `candidate workspace contains untrusted symbolic link ${repositoryPath}`
        );
      }
      if (!child.isDirectory()) continue;
      if (IGNORED_DIRECTORIES.has(child.name)) {
        throw new TypeError(
          `candidate workspace contains untrusted Gate input directory ${repositoryPath}`
        );
      }
      directories += 1;
      if (directories > MAX_LOOP_SNAPSHOT_FILES) {
        throw new TypeError(
          `candidate workspace directory count exceeds ${MAX_LOOP_SNAPSHOT_FILES}`
        );
      }
      await visit(join(directory, child.name), repositoryPath);
    }
  };
  await visit(root, "");
}

/** Parses a worker-supplied snapshot delta and derives conservative change
 * counts from the actual bytes. Counts never trust worker-provided numbers:
 * each modified file is charged for every before and after line. */
export function measureLoopDiffManifest(content: Buffer): MeasuredLoopDiff {
  if (!Buffer.isBuffer(content) || content.byteLength > MAX_LOOP_DIFF_MANIFEST_BYTES) {
    throw new TypeError("Loop diff manifest exceeds the 16 MiB limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new TypeError("Loop diff manifest must be valid JSON", { cause: error });
  }
  const record = exactRecord(parsed, ["schemaVersion", "files"], "diffManifest");
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    throw new TypeError("diffManifest.schemaVersion must be 1 or 2");
  }
  if (!Array.isArray(record.files) || record.files.length > MAX_LOOP_DIFF_FILES) {
    throw new TypeError("diffManifest.files must contain at most 5000 entries");
  }
  const schemaVersion = record.schemaVersion as 1 | 2;
  const paths = new Set<string>();
  const files = record.files.map((value, index) => {
    const file = exactRecord(
      value,
      schemaVersion === 1
        ? ["path", "before", "after"]
        : ["path", "before", "after", "beforeMode", "afterMode"],
      `diffManifest.files[${index}]`
    );
    const path = safeRelativePath(file.path, `diffManifest.files[${index}].path`);
    if (paths.has(path)) throw new TypeError(`diffManifest contains duplicate path ${path}`);
    paths.add(path);
    const before = nullableString(file.before, `diffManifest.files[${index}].before`);
    const after = nullableString(file.after, `diffManifest.files[${index}].after`);
    if (schemaVersion === 1) {
      if (before === after) {
        throw new TypeError(`diffManifest file ${path} does not describe a change`);
      }
      return Object.freeze({ path, before, after });
    }
    const beforeMode = nullableMode(
      file.beforeMode,
      `diffManifest.files[${index}].beforeMode`
    );
    const afterMode = nullableMode(
      file.afterMode,
      `diffManifest.files[${index}].afterMode`
    );
    if (
      (before === null) !== (beforeMode === null) ||
      (after === null) !== (afterMode === null)
    ) {
      throw new TypeError(`diffManifest file ${path} content and mode presence disagree`);
    }
    if (before === after && beforeMode === afterMode) {
      throw new TypeError(`diffManifest file ${path} does not describe a change`);
    }
    return Object.freeze({ path, before, after, beforeMode, afterMode });
  }).sort((left, right) => left.path.localeCompare(right.path));
  const manifest = Object.freeze({
    schemaVersion,
    files: Object.freeze(files)
  }) as CanonicalLoopDiffManifest;
  const canonical = Buffer.from(JSON.stringify(manifest), "utf8");
  if (canonical.byteLength > MAX_LOOP_DIFF_MANIFEST_BYTES) {
    throw new TypeError("Canonical Loop diff manifest exceeds the 16 MiB limit");
  }
  return Object.freeze({
    manifest,
    content: canonical,
    changedFiles: files.length,
    changedLines: files.reduce(
      (sum, file) => sum + lineCount(file.before) + lineCount(file.after),
      0
    )
  });
}

async function snapshotWorkspace(
  requestedRoot: string,
  field: string
): Promise<{
  readonly root: string;
  readonly entries: ReadonlyMap<string, WorkspaceSnapshotEntry>;
  readonly digest: string;
}> {
  if (
    typeof requestedRoot !== "string" ||
    requestedRoot.length === 0 ||
    requestedRoot !== requestedRoot.trim() ||
    !isAbsolute(requestedRoot) ||
    requestedRoot.includes("\0")
  ) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  const lexicalRoot = resolve(requestedRoot);
  const rootStats = await lstat(lexicalRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new TypeError(`${field} must be a real directory`);
  }
  const root = await realpath(lexicalRoot);
  const entries = new Map<string, WorkspaceSnapshotEntry>();
  let fileCount = 0;

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const child of children) {
      if (child.isDirectory() && IGNORED_DIRECTORIES.has(child.name)) continue;
      const repositoryPath = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = join(directory, child.name);
      const stats = await lstat(absolute);
      if (stats.isDirectory()) {
        await visit(absolute, repositoryPath);
        continue;
      }
      fileCount += 1;
      if (fileCount > MAX_LOOP_SNAPSHOT_FILES) {
        throw new TypeError(`Loop workspace snapshot exceeds ${MAX_LOOP_SNAPSHOT_FILES} files`);
      }
      if (stats.isSymbolicLink()) {
        const target = await readlink(absolute);
        entries.set(repositoryPath, Object.freeze({
          path: repositoryPath,
          kind: "symlink",
          digest: sha256Buffer(Buffer.from(target, "utf8")),
          byteLength: Buffer.byteLength(target, "utf8"),
          mode: null
        }));
        continue;
      }
      if (!stats.isFile()) {
        throw new TypeError(`Loop workspace contains unsupported entry ${repositoryPath}`);
      }
      entries.set(repositoryPath, Object.freeze({
        path: repositoryPath,
        kind: "file",
        digest: await hashFile(absolute),
        byteLength: stats.size,
        mode: normalizedFileMode(stats.mode)
      }));
    }
  };
  await visit(root, "");
  const semantic = [...entries.values()].sort((left, right) =>
    compareCodeUnits(left.path, right.path)
  );
  return Object.freeze({ root, entries, digest: sha256Canonical(semantic) });
}

async function readChangedText(
  root: string,
  repositoryPath: string,
  expected: WorkspaceSnapshotEntry,
  field: string
): Promise<string> {
  if (expected.kind !== "file") {
    throw new TypeError(`Loop diff changed symbolic link ${repositoryPath}`);
  }
  if (expected.byteLength > MAX_LOOP_DIFF_TEXT_FILE_BYTES) {
    throw new TypeError(`Loop diff changed oversized file ${repositoryPath}`);
  }
  const absolute = join(root, ...repositoryPath.split("/"));
  const canonical = await realpath(absolute);
  if (!within(root, canonical)) {
    throw new TypeError(`${field} changed path escapes its authoritative root`);
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expected.byteLength) {
      throw new TypeError(`Loop diff source changed during measurement: ${repositoryPath}`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      normalizedFileMode(before.mode) !== expected.mode ||
      normalizedFileMode(after.mode) !== expected.mode ||
      sha256Buffer(content) !== expected.digest
    ) {
      throw new TypeError(`Loop diff source changed during measurement: ${repositoryPath}`);
    }
    if (content.includes(0)) {
      throw new TypeError(`Loop diff changed binary file ${repositoryPath}`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch (error) {
      throw new TypeError(`Loop diff changed non-UTF-8 file ${repositoryPath}`, {
        cause: error
      });
    }
  } finally {
    await handle.close();
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function sameEntry(
  left: WorkspaceSnapshotEntry | undefined,
  right: WorkspaceSnapshotEntry | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.kind === right.kind &&
    left.byteLength === right.byteLength &&
    left.digest === right.digest &&
    left.mode === right.mode
  );
}

function normalizedFileMode(mode: number): 420 | 493 {
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}

function within(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  path: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${path} must contain exactly ${expected.join(", ")}`);
  }
  return record;
}

function safeRelativePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.split(/[\\/]+/u).some((part) => part === "" || part === "." || part === "..") ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a traversal-free relative path`);
  }
  return value.split("\\").join("/");
}

function nullableString(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new TypeError(`${field} must be a string or null`);
  }
  return value as string | null;
}

function nullableMode(value: unknown, field: string): 420 | 493 | null {
  if (value === null) return null;
  if (value !== 0o644 && value !== 0o755) {
    throw new TypeError(`${field} must be normalized POSIX mode 0644, 0755 or null`);
  }
  return value;
}

function lineCount(value: string | null): number {
  if (value === null || value.length === 0) return 0;
  const lines = value.split(/\r\n|\n|\r/u);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}
