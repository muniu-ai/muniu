import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { GateResultV2, RunRecord } from "@mn/core";
import {
  createGateArtifactHandleRecord,
  gateArtifactFromRecord,
  resolveVerifiedGateArtifact,
  validateEnterpriseGateArtifactHandles
} from "../src/gateArtifactCas.js";
import { RunScopedCas } from "../src/runScopedCas.js";
import { MemoryStore } from "../src/store.js";

test("Gate artifact handles bind verified bytes to tenant, run, result and active claim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-gate-artifact-cas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cas = new RunScopedCas({ localRoot: root });
  const store = new MemoryStore();
  const content = Buffer.from("trusted gate output", "utf8");
  const ref = await cas.put({
    tenantId: "tenant-a",
    projectId: "project-a",
    runId: "run-a",
    contentType: "text/plain",
    content
  });
  const claimTokenHash = "1".repeat(64);
  const record = createGateArtifactHandleRecord({
    tenantId: "tenant-a",
    projectId: "project-a",
    runId: "run-a",
    candidateId: "candidate-a",
    gateResultId: "gate-result-a",
    gateId: "unit_test",
    artifact: {
      id: "unit-test-log",
      kind: "log",
      contentType: "text/plain",
      digest: createHash("sha256").update(content).digest("hex"),
      byteLength: content.byteLength
    },
    cas: ref,
    claimTokenHash,
    ownerId: "worker-a",
    registeredAt: new Date().toISOString()
  });
  store.gateArtifactHandles.set(record.handle, record);
  const artifact = gateArtifactFromRecord(record);
  const gate = gateResult(artifact);
  const incoming = run(gate);
  const validation = (overrides: Partial<Parameters<typeof validateEnterpriseGateArtifactHandles>[0]> = {}) =>
    validateEnterpriseGateArtifactHandles({
      existing: undefined,
      incoming,
      tenantId: "tenant-a",
      ownerId: "worker-a",
      claimTokenHash,
      store,
      cas,
      ...overrides
    });

  assert.equal(await validation(), undefined);
  assert.deepEqual(
    (await resolveVerifiedGateArtifact({
      tenantId: "tenant-a",
      projectId: "project-a",
      runId: "run-a",
      gate,
      artifact,
      store,
      cas
    }))?.content,
    content
  );

  assert.match(
    await validation({ incoming: run({ ...gate, artifacts: [{ ...artifact, handle: undefined }] }) }) ?? "",
    /API-managed CAS handle/u
  );
  assert.match(await validation({ tenantId: "tenant-b" }) ?? "", /tenant\/run\/result metadata/u);
  assert.match(
    await validation({ incoming: { ...incoming, id: "run-b" } }) ?? "",
    /tenant\/run\/result metadata/u
  );
  assert.match(
    await validation({ claimTokenHash: "2".repeat(64) }) ?? "",
    /active claim/u
  );
  assert.match(
    await validation({
      incoming: run({
        ...gate,
        artifacts: [{ ...artifact, digest: "3".repeat(64) }]
      })
    }) ?? "",
    /tenant\/run\/result metadata/u
  );

  // Once the exact handle is in an accepted checkpoint, a reclaim may retain
  // it without pretending the new claim produced historical evidence.
  assert.equal(
    await validation({ existing: incoming, claimTokenHash: "2".repeat(64), ownerId: "worker-b" }),
    undefined
  );

  await rm(join(root, ...ref.objectKey.split("/")), { force: true });
  assert.match(await validation() ?? "", /is missing/u);

  await cas.put({
    tenantId: "tenant-a",
    projectId: "project-a",
    runId: "run-a",
    contentType: "text/plain",
    content
  });
  const localPath = join(root, ...ref.objectKey.split("/"));
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, Buffer.alloc(content.byteLength, 0x78));
  assert.match(await validation() ?? "", /digest mismatch/u);
});

function gateResult(artifact: ReturnType<typeof gateArtifactFromRecord>): GateResultV2 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: "gate-result-a",
    runId: "run-a",
    candidateId: "candidate-a",
    gateId: "unit_test",
    runnerId: "unit_test",
    runnerVersion: "1",
    required: true,
    status: "pass",
    summary: "passed",
    specClauseIds: ["acceptance-a"],
    workingDirectory: "/workspace",
    exitCode: 0,
    inputDigest: "4".repeat(64),
    outputDigest: "5".repeat(64),
    artifacts: [artifact],
    startedAt: now,
    finishedAt: now,
    freshUntil: new Date(Date.parse(now) + 60_000).toISOString()
  };
}

function run(gate: GateResultV2): RunRecord {
  const now = new Date().toISOString();
  return {
    id: "run-a",
    tenantId: "tenant-a",
    projectId: "project-a",
    taskId: "task-a",
    status: "verifying",
    candidates: [{
      id: "candidate-a",
      runId: "run-a",
      provider: "claude",
      worktreePath: "/workspace",
      status: "completed",
      gates: []
    }],
    gates: [],
    gateResultsV2: [gate],
    createdAt: now,
    updatedAt: now
  };
}
