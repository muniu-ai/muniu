import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Canonical } from "@mn/governance";
import { restoreLoopDiffWorkspace } from "../src/loopDiffRestore.js";

test("restores an API-bound v2 Loop diff into a fresh candidate workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-loop-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const workspaces = join(root, "workspaces");
  await mkdir(source);
  await writeFile(join(source, "a.txt"), "old\n", { mode: 0o644 });
  await writeFile(join(source, "delete.txt"), "bye\n", { mode: 0o644 });
  await chmod(join(source, "a.txt"), 0o644);
  await chmod(join(source, "delete.txt"), 0o644);

  const files = [
    {
      path: "a.txt",
      before: "old\n",
      after: "new\n",
      beforeMode: 0o644,
      afterMode: 0o755
    },
    {
      path: "delete.txt",
      before: "bye\n",
      after: null,
      beforeMode: 0o644,
      afterMode: null
    },
    {
      path: "new.txt",
      before: null,
      after: "created\n",
      beforeMode: null,
      afterMode: 0o644
    }
  ] as const;
  const content = Buffer.from(JSON.stringify({ schemaVersion: 2, files }), "utf8");
  const restored = await restoreLoopDiffWorkspace({
    projectRoot: source,
    workspaceRoot: workspaces,
    runId: "run-a",
    candidateId: "builtin-1",
    content,
    digest: sha256(content),
    projectSnapshotDigest: snapshotDigest([
      entry("a.txt", "old\n", 0o644),
      entry("delete.txt", "bye\n", 0o644)
    ]),
    candidateSnapshotDigest: snapshotDigest([
      entry("a.txt", "new\n", 0o755),
      entry("new.txt", "created\n", 0o644)
    ])
  });

  assert.equal(restored.path, join(workspaces, "run-a--governed-builtin-1"));
  assert.deepEqual(restored.changedPaths, ["a.txt", "delete.txt", "new.txt"]);
  assert.equal(await readFile(join(restored.path, "a.txt"), "utf8"), "new\n");
  assert.equal((await stat(join(restored.path, "a.txt"))).mode & 0o111, 0o111);
  assert.equal(await readFile(join(restored.path, "new.txt"), "utf8"), "created\n");
  await assert.rejects(access(join(restored.path, "delete.txt")));
});

test("fails closed before restoration when the source snapshot binding changed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-loop-restore-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "a.txt"), "unexpected\n");
  const content = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    files: [{
      path: "a.txt",
      before: "old\n",
      after: "new\n",
      beforeMode: 0o644,
      afterMode: 0o644
    }]
  }));
  await assert.rejects(
    restoreLoopDiffWorkspace({
      projectRoot: source,
      workspaceRoot: join(root, "workspaces"),
      runId: "run-a",
      candidateId: "builtin-1",
      content,
      digest: sha256(content),
      projectSnapshotDigest: snapshotDigest([entry("a.txt", "old\n", 0o644)]),
      candidateSnapshotDigest: snapshotDigest([entry("a.txt", "new\n", 0o644)])
    }),
    /source snapshot does not match/u
  );
});

function entry(path: string, content: string, mode: number) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    kind: "file" as const,
    digest: sha256(bytes),
    byteLength: bytes.byteLength,
    mode
  };
}

function snapshotDigest(entries: readonly ReturnType<typeof entry>[]): string {
  return sha256Canonical(entries);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
