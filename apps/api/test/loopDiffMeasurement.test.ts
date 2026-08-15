import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  measureAuthoritativeLoopWorkspaceDiff,
  measureLoopDiffManifest,
  resolveAuthoritativeCandidateWorkspace
} from "../src/loopDiffMeasurement.js";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/store.js";

test("diff measurement derives conservative file and line counts from canonical bytes", () => {
  const measured = measureLoopDiffManifest(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    files: [
      { path: "services/orders/new.ts", before: null, after: "one\ntwo\n" },
      { path: "services/orders/old.ts", before: "old\n", after: "new\nvalue\n" }
    ]
  })));
  assert.equal(measured.changedFiles, 2);
  assert.equal(measured.changedLines, 5);
  assert.deepEqual(measured.manifest.files.map((file) => file.path), [
    "services/orders/new.ts",
    "services/orders/old.ts"
  ]);
  assert.deepEqual(JSON.parse(measured.content.toString("utf8")), measured.manifest);
});

test("diff measurement rejects traversal, duplicate and worker-supplied count fields", () => {
  for (const value of [
    {
      schemaVersion: 1,
      files: [{ path: "../secret", before: null, after: "x" }]
    },
    {
      schemaVersion: 1,
      files: [
        { path: "a.ts", before: null, after: "x" },
        { path: "a.ts", before: "x", after: "y" }
      ]
    },
    {
      schemaVersion: 1,
      files: [{ path: "a.ts", before: null, after: "x", changedLines: 0 }]
    }
  ]) {
    assert.throws(() => measureLoopDiffManifest(Buffer.from(JSON.stringify(value))));
  }
});

test("API derives exact manifest and conservative counts from authoritative workspaces", async (t) => {
  const fixture = await workspaceFixture(t);
  await mkdir(join(fixture.project, "services/orders"), { recursive: true });
  await mkdir(join(fixture.candidate, "services/orders"), { recursive: true });
  await writeFile(join(fixture.project, "services/orders/a.ts"), "old\nvalue\n");
  await writeFile(join(fixture.candidate, "services/orders/a.ts"), "new\nvalue\n");
  await writeFile(join(fixture.candidate, "services/orders/new.ts"), "one\ntwo\n");

  const measured = await measureAuthoritativeLoopWorkspaceDiff({
    projectRoot: fixture.project,
    candidateRoot: fixture.candidate
  });
  assert.equal(measured.changedFiles, 2);
  assert.equal(measured.changedLines, 6);
  assert.deepEqual(measured.manifest.files.map((file) => file.path), [
    "services/orders/a.ts",
    "services/orders/new.ts"
  ]);
  assert.match(measured.projectSnapshotDigest, /^[a-f0-9]{64}$/u);
  assert.match(measured.candidateSnapshotDigest, /^[a-f0-9]{64}$/u);
  assert.notEqual(measured.projectSnapshotDigest, measured.candidateSnapshotDigest);
});

test("chmod-only executable changes alter snapshot, diff, changed scope and budget", async (t) => {
  const fixture = await workspaceFixture(t);
  const body = "#!/bin/sh\nexit 0\n";
  await writeFile(join(fixture.project, "gate.sh"), body, { mode: 0o644 });
  await writeFile(join(fixture.candidate, "gate.sh"), body, { mode: 0o644 });
  const before = await measureAuthoritativeLoopWorkspaceDiff({
    projectRoot: fixture.project,
    candidateRoot: fixture.candidate
  });
  assert.equal(before.changedFiles, 0);
  assert.equal(before.projectSnapshotDigest, before.candidateSnapshotDigest);

  await chmod(join(fixture.candidate, "gate.sh"), 0o755);
  const after = await measureAuthoritativeLoopWorkspaceDiff({
    projectRoot: fixture.project,
    candidateRoot: fixture.candidate
  });
  assert.equal(after.manifest.schemaVersion, 2);
  assert.equal(after.changedFiles, 1);
  assert.equal(after.changedLines, 4);
  assert.notEqual(after.projectSnapshotDigest, after.candidateSnapshotDigest);
  assert.deepEqual(after.manifest.files, [{
    path: "gate.sh",
    before: body,
    after: body,
    beforeMode: 0o644,
    afterMode: 0o755
  }]);
  assert.deepEqual(
    measureLoopDiffManifest(after.content).manifest,
    after.manifest,
    "CAS bytes must retain executable mode semantics"
  );
});

test("workspace URI is bound to one active lease, run, attempt and candidate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-loop-workspace-uri-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = "run-a--implementation-1-claude-1";
  await mkdir(join(root, expected));
  const valid = `mn://sandbox/lease-a/${expected}`;
  assert.equal(
    await resolveAuthoritativeCandidateWorkspace({
      workspaceUri: valid,
      leaseId: "lease-a",
      scratchRoot: root,
      runId: "run-a",
      implementationAttempt: 1,
      candidateId: "claude-1"
    }),
    await realpath(join(root, expected))
  );
  for (const workspaceUri of [
    "mn://sandbox/lease-a/.",
    `mn://sandbox/lease-b/${expected}`,
    "mn://sandbox/lease-a/run-b--implementation-1-claude-1",
    "mn://sandbox/lease-a/run-a--implementation-1-codex-1",
    `mn://sandbox/lease-a/${expected}/nested`
  ]) {
    await assert.rejects(
      resolveAuthoritativeCandidateWorkspace({
        workspaceUri,
        leaseId: "lease-a",
        scratchRoot: root,
        runId: "run-a",
        implementationAttempt: 1,
        candidateId: "claude-1"
      }),
      /workspaceUri/u
    );
  }
});

test("changed binary, symlink and oversized files fail closed", async (t) => {
  for (const kind of ["binary", "symlink", "oversized"] as const) {
    await t.test(kind, async (nested) => {
      const fixture = await workspaceFixture(nested);
      if (kind === "binary") {
        await writeFile(join(fixture.project, "value.bin"), Buffer.from([1, 0, 2]));
        await writeFile(join(fixture.candidate, "value.bin"), Buffer.from([1, 0, 3]));
      } else if (kind === "symlink") {
        await writeFile(join(fixture.project, "target-a"), "a");
        await writeFile(join(fixture.candidate, "target-a"), "a");
        await writeFile(join(fixture.project, "target-b"), "b");
        await writeFile(join(fixture.candidate, "target-b"), "b");
        await symlink("target-a", join(fixture.project, "link"));
        await symlink("target-b", join(fixture.candidate, "link"));
      } else {
        await writeFile(join(fixture.project, "large.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 97));
        await writeFile(join(fixture.candidate, "large.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 98));
      }
      await assert.rejects(
        measureAuthoritativeLoopWorkspaceDiff({
          projectRoot: fixture.project,
          candidateRoot: fixture.candidate
        }),
        kind === "binary"
          ? /binary/u
          : kind === "symlink"
            ? /symbolic link/u
            : /oversized/u
      );
    });
  }
});

test("candidate dependency and generated directories cannot influence Gate outside the snapshot", async (t) => {
  for (const ignoredPath of [
    ["node_modules", ".bin", "node"],
    ["services", "orders", "dist", "gate-plugin.js"]
  ]) {
    await t.test(ignoredPath.join("/"), async (nested) => {
      const fixture = await workspaceFixture(nested);
      await mkdir(join(fixture.candidate, ...ignoredPath.slice(0, -1)), {
        recursive: true
      });
      await writeFile(join(fixture.candidate, ...ignoredPath), "unmeasured executable bytes\n");
      await assert.rejects(
        measureAuthoritativeLoopWorkspaceDiff({
          projectRoot: fixture.project,
          candidateRoot: fixture.candidate
        }),
        /untrusted Gate input directory/u
      );
    });
  }

  await t.test("unchanged symbolic link", async (nested) => {
    const fixture = await workspaceFixture(nested);
    await writeFile(join(fixture.project, "target.js"), "export default 1;\n");
    await writeFile(join(fixture.candidate, "target.js"), "export default 1;\n");
    await symlink("target.js", join(fixture.project, "gate-input.js"));
    await symlink("target.js", join(fixture.candidate, "gate-input.js"));
    await assert.rejects(
      measureAuthoritativeLoopWorkspaceDiff({
        projectRoot: fixture.project,
        candidateRoot: fixture.candidate
      }),
      /untrusted symbolic link/u
    );
  });
});

test("measurement endpoint rejects worker self-reported manifest bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-loop-manifest-submit-"));
  const app = buildServer({
    store: new MemoryStore(),
    mniuRoot: root,
    providerModelCatalogSyncScheduler: false
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/run-a/measurements",
    payload: {
      ownerId: "worker-a",
      claimToken: "claim-a",
      stageAttemptId: "run-a:implementation:1",
      stage: "implementation",
      attempt: 1,
      diffManifestBase64: Buffer.from('{"schemaVersion":1,"files":[]}').toString("base64")
    }
  });
  assert.equal(response.statusCode, 400);
  assert.doesNotMatch(response.body, /"measurement"/u);
});

async function workspaceFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "mn-authoritative-loop-diff-"));
  const project = join(root, "project");
  const candidate = join(root, "candidate");
  await mkdir(project);
  await mkdir(candidate);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { project, candidate };
}
