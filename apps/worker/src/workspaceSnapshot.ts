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
  symlink,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { canonicalJson } from "@mn/governance";

export const WORKSPACE_SNAPSHOT_CONTENT_TYPE =
  "application/vnd.muniu.workspace-snapshot.v1+json";

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 200_000;
const IGNORED_NAMES = new Set([
  ".git",
  ".mn",
  ".mn-source-digest",
  "node_modules",
  "dist",
  "dist-test",
  "coverage",
  ".cache"
]);

export interface WorkspaceSnapshotDirectoryEntry {
  readonly path: string;
  readonly type: "directory";
  readonly mode: number;
}

export interface WorkspaceSnapshotFileEntry {
  readonly path: string;
  readonly type: "file";
  readonly mode: number;
  readonly byteLength: number;
  readonly digest: string;
  readonly contentBase64: string;
}

export interface WorkspaceSnapshotSymlinkEntry {
  readonly path: string;
  readonly type: "symlink";
  readonly mode: number;
  readonly target: string;
}

export type WorkspaceSnapshotEntry =
  | WorkspaceSnapshotDirectoryEntry
  | WorkspaceSnapshotFileEntry
  | WorkspaceSnapshotSymlinkEntry;

export interface WorkspaceSnapshotV1 {
  readonly schemaVersion: 1;
  readonly entries: readonly WorkspaceSnapshotEntry[];
}

export interface CreatedWorkspaceSnapshot {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly byteLength: number;
  readonly contentType: typeof WORKSPACE_SNAPSHOT_CONTENT_TYPE;
  readonly content: Buffer;
}

export interface WorkspaceSnapshotOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
}

/** Creates a deterministic command-free repository snapshot. Generated and
 * VCS state is excluded by basename at every depth. */
export async function createWorkspaceSnapshot(
  projectRoot: string,
  options: WorkspaceSnapshotOptions = {}
): Promise<CreatedWorkspaceSnapshot> {
  const root = await realpath(requireAbsolute(projectRoot, "projectRoot"));
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory()) throw new TypeError("projectRoot must be a directory");
  const maxBytes = positiveLimit(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
  const maxEntries = positiveLimit(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
  const entries: WorkspaceSnapshotEntry[] = [];
  let payloadBytes = 0;

  const visit = async (directory: string): Promise<void> => {
    const children = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !IGNORED_NAMES.has(entry.name))
      .sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const repositoryPath = relative(root, absolute).split(sep).join("/");
      requireSnapshotPath(repositoryPath);
      const stats = await lstat(absolute);
      if (entries.length >= maxEntries) {
        throw new Error("workspace snapshot exceeds the configured entry limit");
      }
      if (stats.isDirectory()) {
        entries.push({ path: repositoryPath, type: "directory", mode: 0o755 });
        await visit(absolute);
      } else if (stats.isFile()) {
        const handle = await open(
          absolute,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        );
        let content: Buffer;
        try {
          if (!(await handle.stat()).isFile()) {
            throw new TypeError(`workspace snapshot contains a non-file: ${repositoryPath}`);
          }
          content = await handle.readFile();
        } finally {
          await handle.close();
        }
        payloadBytes += content.byteLength;
        if (payloadBytes > maxBytes) {
          throw new Error("workspace snapshot exceeds the configured byte limit");
        }
        entries.push({
          path: repositoryPath,
          type: "file",
          mode: safeMode(stats.mode),
          byteLength: content.byteLength,
          digest: sha256(content),
          contentBase64: content.toString("base64")
        });
      } else if (stats.isSymbolicLink()) {
        const target = await readlink(absolute);
        validateSymlinkTarget(repositoryPath, target);
        entries.push({
          path: repositoryPath,
          type: "symlink",
          mode: 0o777,
          target
        });
      } else {
        throw new TypeError(`workspace snapshot contains unsupported special file: ${repositoryPath}`);
      }
    }
  };
  await visit(root);
  const content = Buffer.from(canonicalJson({ schemaVersion: 1, entries }), "utf8");
  return Object.freeze({
    schemaVersion: 1,
    digest: sha256(content),
    byteLength: content.byteLength,
    contentType: WORKSPACE_SNAPSHOT_CONTENT_TYPE,
    content
  });
}

export function parseWorkspaceSnapshot(content: Buffer | Uint8Array): WorkspaceSnapshotV1 {
  const bytes = Buffer.from(content);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new TypeError("workspace snapshot is not valid JSON", { cause: error });
  }
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new TypeError("workspace snapshot is not a v1 document");
  }
  if (value.entries.length > DEFAULT_MAX_ENTRIES) {
    throw new TypeError("workspace snapshot exceeds the configured entry limit");
  }
  let payloadBytes = 0;
  let previous = "";
  const entries = value.entries.map((candidate, index): WorkspaceSnapshotEntry => {
    if (!record(candidate)) throw new TypeError(`workspace snapshot entry ${index} is invalid`);
    const path = requireSnapshotPath(candidate.path);
    if (index > 0 && compareCodeUnits(path, previous) <= 0) {
      throw new TypeError("workspace snapshot entries must be unique and sorted");
    }
    previous = path;
    const mode = safeMode(candidate.mode);
    if (candidate.type === "directory") return { path, type: "directory", mode };
    if (candidate.type === "symlink") {
      if (typeof candidate.target !== "string") {
        throw new TypeError("workspace snapshot symlink target is invalid");
      }
      validateSymlinkTarget(path, candidate.target);
      return { path, type: "symlink", mode, target: candidate.target };
    }
    if (
      candidate.type !== "file" ||
      typeof candidate.contentBase64 !== "string" ||
      !Number.isSafeInteger(candidate.byteLength) ||
      (candidate.byteLength as number) < 0 ||
      !/^[a-f0-9]{64}$/u.test(String(candidate.digest))
    ) {
      throw new TypeError("workspace snapshot file entry is invalid");
    }
    const decoded = Buffer.from(candidate.contentBase64, "base64");
    if (
      decoded.toString("base64") !== candidate.contentBase64 ||
      decoded.byteLength !== candidate.byteLength ||
      sha256(decoded) !== candidate.digest
    ) {
      throw new TypeError("workspace snapshot file content binding is invalid");
    }
    payloadBytes += decoded.byteLength;
    if (payloadBytes > DEFAULT_MAX_BYTES) {
      throw new TypeError("workspace snapshot exceeds the configured byte limit");
    }
    return {
      path,
      type: "file",
      mode,
      byteLength: decoded.byteLength,
      digest: candidate.digest,
      contentBase64: candidate.contentBase64
    };
  });
  return Object.freeze({ schemaVersion: 1, entries: Object.freeze(entries) });
}

export async function materializeWorkspaceSnapshot(
  content: Buffer | Uint8Array,
  targetRoot: string,
  expectedDigest: string
): Promise<void> {
  const bytes = Buffer.from(content);
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest) || sha256(bytes) !== expectedDigest) {
    throw new TypeError("workspace snapshot digest mismatch");
  }
  const root = requireAbsolute(targetRoot, "targetRoot");
  const snapshot = parseWorkspaceSnapshot(bytes);
  await mkdir(root, { recursive: true });
  for (const entry of snapshot.entries) {
    const destination = resolve(root, ...entry.path.split("/"));
    if (!within(root, destination)) throw new TypeError("workspace snapshot path escaped target");
    if (entry.type === "directory") {
      await mkdir(destination, { recursive: true, mode: entry.mode });
      await chmod(destination, entry.mode);
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    if (entry.type === "symlink") {
      await symlink(entry.target, destination);
      continue;
    }
    const data = Buffer.from(entry.contentBase64, "base64");
    await writeFile(destination, data, { mode: entry.mode });
    await chmod(destination, entry.mode);
  }
  await writeFile(join(root, ".mn-source-digest"), `${expectedDigest}\n`, { mode: 0o444 });
}

/** Self-contained Node program used only by the trusted loader container. It
 * repeats path, link, byte-length and digest validation before writing the
 * project emptyDir and a digest marker. */
export const WORKSPACE_SNAPSHOT_MATERIALIZER_SCRIPT = String.raw`
const c=require('node:crypto'),f=require('node:fs'),p=require('node:path');
const root=p.resolve(process.argv[1]),expected=process.argv[2];let chunks=[];
process.stdin.on('data',x=>chunks.push(x));process.stdin.on('end',()=>{
 const bytes=Buffer.concat(chunks);if(c.createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('snapshot digest mismatch');
 const s=JSON.parse(bytes.toString('utf8'));if(s.schemaVersion!==1||!Array.isArray(s.entries))throw Error('invalid snapshot');
 const safe=x=>typeof x==='string'&&x.length>0&&!x.includes('\\')&&!x.includes('\0')&&!p.posix.isAbsolute(x)&&x.split('/').every(y=>y&&y!=='.'&&y!=='..');
 const inside=(base,x)=>{const r=p.relative(base,x);return r===''||(!p.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+p.sep));};
 f.mkdirSync(root,{recursive:true});let last='';
 for(const e of s.entries){if(!safe(e.path)||e.path<=last)throw Error('unsafe snapshot path');last=e.path;const out=p.resolve(root,...e.path.split('/'));if(!inside(root,out))throw Error('snapshot escape');
  if(e.type==='directory'){f.mkdirSync(out,{recursive:true,mode:e.mode});f.chmodSync(out,e.mode);continue;}
  f.mkdirSync(p.dirname(out),{recursive:true});
  if(e.type==='symlink'){if(typeof e.target!=='string'||p.posix.isAbsolute(e.target)||!inside(root,p.resolve(p.dirname(out),...e.target.split('/'))))throw Error('unsafe symlink');f.symlinkSync(e.target,out);continue;}
  if(e.type!=='file'||!Number.isSafeInteger(e.byteLength)||typeof e.contentBase64!=='string')throw Error('invalid file');const data=Buffer.from(e.contentBase64,'base64');
  if(data.length!==e.byteLength||c.createHash('sha256').update(data).digest('hex')!==e.digest)throw Error('file digest mismatch');f.writeFileSync(out,data,{mode:e.mode});f.chmodSync(out,e.mode);
 }
 f.writeFileSync(p.join(root,'.mn-source-digest'),expected+'\n',{mode:292});
});`;

function validateSymlinkTarget(repositoryPath: string, target: string): void {
  if (
    !target ||
    target.includes("\0") ||
    target.includes("\\") ||
    posix.isAbsolute(target)
  ) {
    throw new TypeError(`workspace symlink target escapes the snapshot: ${repositoryPath}`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(repositoryPath), target));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) {
    throw new TypeError(`workspace symlink target escapes the snapshot: ${repositoryPath}`);
  }
}

function requireSnapshotPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError("workspace snapshot path is unsafe");
  }
  return value;
}

function requireAbsolute(value: string, field: string): string {
  if (!value || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  return resolve(value);
}

function safeMode(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new TypeError("workspace snapshot mode is invalid");
  const mode = (value as number) & 0o777;
  return mode & 0o111 ? 0o755 : 0o644;
}

function positiveLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be positive`);
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
