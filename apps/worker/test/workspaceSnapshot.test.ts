import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WORKSPACE_SNAPSHOT_MATERIALIZER_SCRIPT,
  createWorkspaceSnapshot,
  parseWorkspaceSnapshot
} from "../src/index.js";

test("workspace snapshots are deterministic, bounded and omit generated state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-workspace-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(root, "src", "main.mjs"), "export default 1;\n");
  await chmod(join(root, "src", "main.mjs"), 0o755);
  await writeFile(join(root, ".git", "config"), "secret-ish metadata");
  await writeFile(join(root, "node_modules", "ignored", "index.js"), "ignored");
  await symlink("src/main.mjs", join(root, "main-link"));

  const first = await createWorkspaceSnapshot(root);
  const second = await createWorkspaceSnapshot(root);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.content, second.content);
  assert.equal(first.contentType, "application/vnd.muniu.workspace-snapshot.v1+json");
  const parsed = parseWorkspaceSnapshot(first.content);
  assert.deepEqual(parsed.entries.map((entry) => entry.path), [
    "main-link",
    "src",
    "src/main.mjs"
  ]);
  assert.equal(parsed.entries.at(-1)?.mode, 0o755);
});

test("snapshot materializer reconstructs only validated relative entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-workspace-source-"));
  const destination = await mkdtemp(join(tmpdir(), "mn-workspace-destination-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(destination, { recursive: true, force: true })
  ]));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "bin", "tool"), 0o755);
  await symlink("bin/tool", join(root, "tool"));
  const snapshot = await createWorkspaceSnapshot(root);

  await runMaterializer(destination, snapshot.digest, snapshot.content);

  assert.equal(await readFile(join(destination, "bin", "tool"), "utf8"), "#!/bin/sh\nexit 0\n");
  assert.equal((await lstat(join(destination, "bin", "tool"))).mode & 0o777, 0o755);
  assert.equal(await readlink(join(destination, "tool")), "bin/tool");
});

async function runMaterializer(
  destination: string,
  digest: string,
  content: Buffer
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "-e",
      WORKSPACE_SNAPSHOT_MATERIALIZER_SCRIPT,
      destination,
      digest
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`materializer exited ${String(code)}: ${stderr}`));
    });
    child.stdin.end(content);
  });
}

test("workspace snapshots reject escaping links, special files and size overflow", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-workspace-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink("../outside", join(root, "escape"));
  await assert.rejects(createWorkspaceSnapshot(root), /symlink target escapes/u);
  await rm(join(root, "escape"));
  await writeFile(join(root, "large.bin"), Buffer.alloc(16));
  await assert.rejects(
    createWorkspaceSnapshot(root, { maxBytes: 8 }),
    /exceeds the configured byte limit/u
  );
});
