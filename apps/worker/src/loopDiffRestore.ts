import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  unlink
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { sha256Canonical } from "@mn/governance";
import {
  prepareSnapshotCandidateWorkspace,
  type WorkspaceResult
} from "./workspace.js";

export const LOOP_DIFF_MANIFEST_CONTENT_TYPE =
  "application/vnd.mn.loop-diff-manifest+json";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 5_000;
const MAX_SNAPSHOT_FILES = 100_000;
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

interface RestorableLoopDiffFile {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly beforeMode: 0o644 | 0o755 | null;
  readonly afterMode: 0o644 | 0o755 | null;
}

interface RestorableLoopDiffManifest {
  readonly schemaVersion: 2;
  readonly files: readonly RestorableLoopDiffFile[];
}

export interface RestoreLoopDiffWorkspaceInput {
  readonly projectRoot: string;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly content: Buffer | Uint8Array;
  readonly digest: string;
  readonly projectSnapshotDigest: string;
  readonly candidateSnapshotDigest: string;
}

export interface RestoredLoopDiffWorkspace extends WorkspaceResult {
  readonly changedPaths: readonly string[];
}

/**
 * Recreates a candidate from the immutable source snapshot plus the API-owned
 * diff CAS object. Both complete workspace digests are checked so a resumed
 * Gate can never consume a partial, stale, or differently based patch.
 */
export async function restoreLoopDiffWorkspace(
  input: RestoreLoopDiffWorkspaceInput
): Promise<RestoredLoopDiffWorkspace> {
  const content = Buffer.from(input.content);
  if (!digest(input.digest) || sha256(content) !== input.digest) {
    throw new TypeError("Loop diff restore content digest mismatch");
  }
  if (!digest(input.projectSnapshotDigest) || !digest(input.candidateSnapshotDigest)) {
    throw new TypeError("Loop diff restore workspace digest binding is invalid");
  }
  const manifest = parseRestorableLoopDiffManifest(content);
  const sourceDigest = await workspaceSnapshotDigest(input.projectRoot);
  if (sourceDigest !== input.projectSnapshotDigest) {
    throw new Error("Loop diff restore source snapshot does not match its API binding");
  }
  const workspace = await prepareSnapshotCandidateWorkspace({
    projectRoot: input.projectRoot,
    workspaceRoot: input.workspaceRoot,
    runId: `${input.runId}--governed`,
    candidateId: input.candidateId,
    isolated: true
  });
  try {
    await applyManifest(workspace.path, manifest);
    const restoredDigest = await workspaceSnapshotDigest(workspace.path);
    if (restoredDigest !== input.candidateSnapshotDigest) {
      throw new Error("Restored candidate snapshot does not match its API binding");
    }
    return {
      ...workspace,
      changedPaths: Object.freeze(manifest.files.map((file) => file.path))
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

function parseRestorableLoopDiffManifest(content: Buffer): RestorableLoopDiffManifest {
  if (content.byteLength > MAX_MANIFEST_BYTES) {
    throw new TypeError("Loop diff restore manifest exceeds the 16 MiB limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new TypeError("Loop diff restore manifest must be valid JSON", { cause: error });
  }
  const record = exactRecord(parsed, ["schemaVersion", "files"], "diffManifest");
  if (record.schemaVersion !== 2 || !Array.isArray(record.files)) {
    throw new TypeError("Loop diff restore requires a v2 manifest");
  }
  if (record.files.length > MAX_FILES) {
    throw new TypeError(`Loop diff restore contains more than ${MAX_FILES} files`);
  }
  let previousPath = "";
  const files = record.files.map((value, index): RestorableLoopDiffFile => {
    const file = exactRecord(
      value,
      ["path", "before", "after", "beforeMode", "afterMode"],
      `diffManifest.files[${index}]`
    );
    const path = safeRelativePath(file.path);
    if (index > 0 && compareCodeUnits(path, previousPath) <= 0) {
      throw new TypeError("Loop diff restore paths must be unique and sorted");
    }
    previousPath = path;
    const before = nullableString(file.before, `${path}.before`);
    const after = nullableString(file.after, `${path}.after`);
    const beforeMode = nullableMode(file.beforeMode, `${path}.beforeMode`);
    const afterMode = nullableMode(file.afterMode, `${path}.afterMode`);
    if (
      (before === null) !== (beforeMode === null) ||
      (after === null) !== (afterMode === null)
    ) {
      throw new TypeError(`Loop diff restore content and mode disagree for ${path}`);
    }
    if (before === after && beforeMode === afterMode) {
      throw new TypeError(`Loop diff restore entry ${path} is unchanged`);
    }
    return Object.freeze({ path, before, after, beforeMode, afterMode });
  });
  return Object.freeze({ schemaVersion: 2, files: Object.freeze(files) });
}

async function applyManifest(
  requestedRoot: string,
  manifest: RestorableLoopDiffManifest
): Promise<void> {
  const root = await realDirectory(requestedRoot, "candidate workspace");
  for (const file of manifest.files) {
    const target = resolve(root, ...file.path.split("/"));
    if (!within(root, target)) throw new TypeError("Loop diff restore path escaped workspace");
    await assertSafeParents(root, dirname(target));
    const stats = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (file.before === null) {
      if (stats !== undefined) {
        throw new Error(`Loop diff restore expected ${file.path} to be absent`);
      }
    } else {
      if (!stats?.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Loop diff restore expected ${file.path} to be a regular file`);
      }
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let before: Buffer;
      try {
        before = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (
        !before.equals(Buffer.from(file.before, "utf8")) ||
        normalizedMode(stats.mode) !== file.beforeMode
      ) {
        throw new Error(`Loop diff restore base content does not match ${file.path}`);
      }
    }
  }

  for (const file of manifest.files) {
    const target = resolve(root, ...file.path.split("/"));
    if (file.after === null) {
      await unlink(target);
      continue;
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o777 });
    await assertSafeParents(root, dirname(target));
    const handle = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        (constants.O_NOFOLLOW ?? 0),
      writableMode(file.afterMode!)
    );
    try {
      await handle.writeFile(Buffer.from(file.after, "utf8"));
    } finally {
      await handle.close();
    }
    await chmod(target, writableMode(file.afterMode!));
  }
}

async function workspaceSnapshotDigest(requestedRoot: string): Promise<string> {
  const root = await realDirectory(requestedRoot, "workspace snapshot root");
  const entries: Array<{
    path: string;
    kind: "file" | "symlink";
    digest: string;
    byteLength: number;
    mode: number | null;
  }> = [];
  let count = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const child of children) {
      if (child.isDirectory() && IGNORED_DIRECTORIES.has(child.name)) continue;
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = join(directory, child.name);
      const stats = await lstat(absolute);
      if (stats.isDirectory()) {
        await visit(absolute, path);
        continue;
      }
      count += 1;
      if (count > MAX_SNAPSHOT_FILES) {
        throw new TypeError(`Loop diff restore workspace exceeds ${MAX_SNAPSHOT_FILES} files`);
      }
      if (stats.isSymbolicLink()) {
        const target = await readlink(absolute);
        entries.push({
          path,
          kind: "symlink",
          digest: sha256(Buffer.from(target, "utf8")),
          byteLength: Buffer.byteLength(target, "utf8"),
          mode: null
        });
      } else if (stats.isFile()) {
        const handle = await open(
          absolute,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        );
        let content: Buffer;
        try {
          content = await handle.readFile();
        } finally {
          await handle.close();
        }
        entries.push({
          path,
          kind: "file",
          digest: sha256(content),
          byteLength: content.byteLength,
          mode: normalizedMode(stats.mode)
        });
      } else {
        throw new TypeError(`Loop diff restore workspace contains special file ${path}`);
      }
    }
  };
  await visit(root, "");
  return sha256Canonical(entries);
}

async function assertSafeParents(root: string, requestedParent: string): Promise<void> {
  const child = relative(root, requestedParent);
  if (child === "") return;
  let current = root;
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stats === undefined) return;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new TypeError("Loop diff restore path crosses a non-directory or symbolic link");
    }
  }
}

async function realDirectory(value: string, field: string): Promise<string> {
  if (!value || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  const root = await realpath(resolve(value));
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError(`${field} must be a real directory`);
  }
  return root;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} contains unexpected fields`);
  }
  return record;
}

function safeRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError("Loop diff restore path is unsafe");
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new TypeError(`${field} must be a string or null`);
  }
  return value as string | null;
}

function nullableMode(value: unknown, field: string): 0o644 | 0o755 | null {
  if (value !== null && value !== 0o644 && value !== 0o755) {
    throw new TypeError(`${field} must be 0644, 0755 or null`);
  }
  return value as 0o644 | 0o755 | null;
}

function normalizedMode(mode: number): 0o644 | 0o755 {
  return mode & 0o111 ? 0o755 : 0o644;
}

function writableMode(mode: 0o644 | 0o755): 0o666 | 0o777 {
  return mode === 0o755 ? 0o777 : 0o666;
}

function digest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function within(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
