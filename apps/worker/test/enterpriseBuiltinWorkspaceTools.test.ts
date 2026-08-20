// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import type { EnterpriseBuiltinToolCallV1 } from "@mn/core";
import type {
  DockerAgentSandbox,
  DockerSandboxCommandResult,
  DockerSandboxExecuteRequest
} from "../src/index.js";
import { executeEnterpriseBuiltinWorkspaceTool } from "../src/enterpriseBuiltinWorkspaceTools.js";

test("enterprise builtin workspace tools mutate and inspect only through the sandbox runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-builtin-tools-"));
  const workspace = join(root, "candidate");
  await mkdir(workspace);
  const backend = new LocalSandbox(root);
  t.after(() => rm(root, { recursive: true, force: true }));

  const written = await executeTool(backend, workspace, call("write_file", {
    path: "src/index.ts",
    content: "export const value = 1;\n"
  }, 1));
  assert.equal(written.ok, true);
  assert.equal(await readFile(join(workspace, "src/index.ts"), "utf8"), "export const value = 1;\n");
  assert.equal((await stat(join(workspace, "src"))).mode & 0o777, 0o755);
  assert.equal((await stat(join(workspace, "src/index.ts"))).mode & 0o777, 0o644);

  const patched = await executeTool(backend, workspace, call("apply_patch", {
    path: "src/index.ts",
    oldText: "value = 1",
    newText: "value = 2"
  }, 2));
  assert.equal(patched.ok, true);
  assert.equal((await stat(join(workspace, "src/index.ts"))).mode & 0o777, 0o644);

  await writeFile(join(workspace, "src/executable.mjs"), "process.exit(0);\n");
  await chmod(join(workspace, "src/executable.mjs"), 0o755);
  const executablePatched = await executeTool(backend, workspace, call("apply_patch", {
    path: "src/executable.mjs",
    oldText: "exit(0)",
    newText: "exitCode = 0"
  }, 3));
  assert.equal(executablePatched.ok, true);
  assert.equal((await stat(join(workspace, "src/executable.mjs"))).mode & 0o777, 0o755);

  const searched = await executeTool(backend, workspace, call("search_text", {
    path: ".",
    query: "value = 2"
  }, 4));
  assert.equal(searched.ok, true);
  assert.deepEqual(searched.result, {
    matches: [{ path: "src/index.ts", line: 1, text: "export const value = 2;" }],
    truncated: false
  });

  const command = await executeTool(backend, workspace, call("run_command", {
    executable: "node",
    args: ["-e", "process.stdout.write(process.cwd())"],
    cwd: ".",
    timeoutSeconds: 5
  }, 5));
  assert.equal(command.ok, true);
  assert.equal((command.result as { exitCode: number }).exitCode, 0);
  assert.equal((command.result as { stdout: string }).stdout, await realpath(workspace));
});

test("enterprise builtin workspace tools fail closed for traversal, symlinks and binding changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-builtin-tools-boundary-"));
  const workspace = join(root, "candidate");
  await mkdir(workspace);
  await writeFile(join(root, "outside.txt"), "secret", "utf8");
  await symlink(join(root, "outside.txt"), join(workspace, "link.txt"));
  const backend = new LocalSandbox(root);
  t.after(() => rm(root, { recursive: true, force: true }));

  const traversal = await executeTool(backend, workspace, call("read_file", {
    path: "../outside.txt"
  }, 1));
  assert.equal(traversal.ok, false);

  const linked = await executeTool(backend, workspace, call("read_file", {
    path: "link.txt"
  }, 2));
  assert.equal(linked.ok, false);

  await assert.rejects(
    executeEnterpriseBuiltinWorkspaceTool({
      backend,
      leaseId: "lease-1",
      hostWorkspacePath: workspace,
      executionId: "execution-1",
      sessionId: "session-1",
      call: { ...call("list_files", { path: "." }, 3), workspacePath: "/workspace/project" },
      timeoutSeconds: 30
    }),
    /workspace binding changed/u
  );
});

async function executeTool(
  backend: DockerAgentSandbox,
  workspace: string,
  toolCall: EnterpriseBuiltinToolCallV1
) {
  return executeEnterpriseBuiltinWorkspaceTool({
    backend,
    leaseId: "lease-1",
    hostWorkspacePath: workspace,
    executionId: "execution-1",
    sessionId: "session-1",
    call: toolCall,
    timeoutSeconds: 30
  });
}

function call(
  name: EnterpriseBuiltinToolCallV1["name"],
  args: EnterpriseBuiltinToolCallV1["args"],
  ordinal: number
): EnterpriseBuiltinToolCallV1 {
  return {
    schemaVersion: 1,
    callId: `call-${ordinal}`,
    executionId: "execution-1",
    sessionId: "session-1",
    name,
    risk: name === "read_file" || name === "list_files" || name === "search_text"
      ? "read-only"
      : "side-effecting",
    args,
    workspacePath: "/workspace/scratch/candidate",
    createdAt: new Date().toISOString()
  };
}

class LocalSandbox implements DockerAgentSandbox {
  constructor(private readonly root: string) {}

  workspaceRoot(): string {
    return this.root;
  }

  containerPath(_leaseId: string, hostPath: string): string {
    return `/workspace/scratch/${relative(this.root, hostPath).split("\\").join("/")}`;
  }

  execute(
    _leaseId: string,
    request: DockerSandboxExecuteRequest & { readonly stdin?: string }
  ): Promise<DockerSandboxCommandResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
      if (request.stdin !== undefined) child.stdin.end(request.stdin);
      else child.stdin.end();
    });
  }
}
