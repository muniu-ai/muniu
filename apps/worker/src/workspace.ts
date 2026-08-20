import { chmod, cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Project } from "@mn/core";
import { runCommand } from "@mn/executors";

export interface WorkspaceResult {
  path: string;
  branchName?: string;
  cleanup: () => Promise<void>;
}

export interface CandidateWorkspaceRequest {
  projectRoot: string;
  workspaceRoot: string;
  runId: string;
  candidateId: string;
  isolated: boolean;
}

export type CandidateWorkspacePreparer = (
  params: CandidateWorkspaceRequest
) => Promise<WorkspaceResult>;

/**
 * Relocates host-absolute project metadata to a materialized source snapshot.
 * The source root does not need to exist in the worker process, so containment
 * is deliberately lexical; the control plane already canonicalized and bound
 * these paths before publishing the content-addressed snapshot.
 */
export function projectAtSnapshot(project: Project, snapshotRoot: string): Project {
  const originalRoot = resolve(project.rootPath);
  return {
    ...project,
    rootPath: resolve(snapshotRoot),
    services: project.services.map((service) => {
      const path = isAbsolute(service.path)
        ? snapshotRelativePath(originalRoot, service.path, `Service ${service.id}`) || "."
        : service.path;
      return {
        ...service,
        path,
        contracts: service.contracts.map((contract) => ({
          ...contract,
          path: isAbsolute(contract.path)
            ? snapshotRelativePath(
                originalRoot,
                contract.path,
                `Contract ${contract.path}`
              )
            : contract.path
        }))
      };
    })
  };
}

function snapshotRelativePath(
  originalRoot: string,
  absolutePath: string,
  field: string
): string {
  const child = relative(resolve(originalRoot), resolve(absolutePath));
  if (
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new TypeError(`${field} escapes the project snapshot`);
  }
  return child;
}

export async function prepareCandidateWorkspace(
  params: CandidateWorkspaceRequest
): Promise<WorkspaceResult> {
  await mkdir(params.workspaceRoot, { recursive: true });

  if (!params.isolated) {
    return {
      path: params.projectRoot,
      cleanup: async () => undefined
    };
  }

  const worktreePath = join(params.workspaceRoot, `${params.runId}-${params.candidateId}`);
  const branchName = `mn/${params.runId}/${params.candidateId}`;
  const gitCheck = await runCommand({
    command: "git",
    args: ["rev-parse", "--is-inside-work-tree"],
    cwd: params.projectRoot,
    timeoutSeconds: 10,
    runId: params.runId,
    candidateId: params.candidateId
  });

  if (gitCheck.exitCode !== 0) {
    await copySourceSnapshot(params.projectRoot, worktreePath);
    return {
      path: worktreePath,
      cleanup: async () => {
        await rm(worktreePath, { recursive: true, force: true });
      }
    };
  }

  const add = await runCommand({
    command: "git",
    args: ["worktree", "add", worktreePath, "-b", branchName],
    cwd: params.projectRoot,
    timeoutSeconds: 60,
    runId: params.runId,
    candidateId: params.candidateId
  });

  if (add.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${add.stderr || add.stdout}`);
  }

  return {
    path: worktreePath,
    branchName,
    cleanup: async () => {
      await runCommand({
        command: "git",
        args: ["worktree", "remove", "--force", worktreePath],
        cwd: params.projectRoot,
        timeoutSeconds: 60,
        runId: params.runId,
        candidateId: params.candidateId
      });
    }
  };
}

/** Deterministic enterprise workspace materializer. It performs no host
 * command execution (not even `git rev-parse`); provider and Gate commands can
 * therefore remain exclusively behind the enforced sandbox executor. */
export async function prepareSnapshotCandidateWorkspace(
  params: CandidateWorkspaceRequest
): Promise<WorkspaceResult> {
  if (!params.isolated) {
    throw new TypeError("Enterprise snapshot candidates require isolated workspace mode");
  }
  await mkdir(params.workspaceRoot, { recursive: true });
  const workspacePath = join(
    params.workspaceRoot,
    `${params.runId}-${params.candidateId}`
  );
  await copySourceSnapshot(params.projectRoot, workspacePath);
  await makeSandboxTreeWritable(workspacePath);
  return {
    path: workspacePath,
    cleanup: async () => {
      await rm(workspacePath, { recursive: true, force: true });
    }
  };
}

async function makeSandboxTreeWritable(root: string): Promise<void> {
  const stats = await lstat(root);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    await chmod(root, 0o777);
    const entries = await readdir(root);
    await Promise.all(entries.map((entry) =>
      makeSandboxTreeWritable(join(root, entry))
    ));
    return;
  }
  if (stats.isFile()) {
    await chmod(root, stats.mode & 0o111 ? 0o777 : 0o666);
  }
}

async function copySourceSnapshot(source: string, target: string): Promise<void> {
  const ignored = new Set([
    ".git",
    ".mn",
    "node_modules",
    "dist",
    "dist-test",
    "coverage",
    ".cache"
  ]);

  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;

    const from = `${source}/${entry.name}`;
    const to = `${target}/${entry.name}`;
    await cp(from, to, {
      recursive: true,
      filter: (path) => !ignored.has(basename(path))
    });
  }
}
