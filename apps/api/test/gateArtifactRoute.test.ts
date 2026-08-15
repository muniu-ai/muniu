import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunScopedCas } from "../src/runScopedCas.js";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/store.js";

test("claimed worker registers server-verified Gate bytes idempotently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-gate-route-"));
  const projectRoot = join(root, "project");
  const mniuRoot = join(root, "state");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "package.json"), "{}\n", "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "api-state.json");
  const store = new MemoryStore({ statePath });
  const app = buildServer({
    store,
    mniuRoot,
    workspaceRoot: join(root, "workspaces"),
    useMockExecutors: true
  });
  t.after(() => app.close());

  const project = (await app.inject({
    method: "POST",
    url: "/v1/projects",
    payload: { name: "gate-route", rootPath: projectRoot }
  })).json();
  const taskResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "register gate bytes",
      prompt: "noop",
      strategy: {
        providers: ["claude"],
        candidates: 1,
        sandbox: "isolated-worktree",
        requiredGates: [],
        humanApproval: "never",
        timeoutSeconds: 60
      }
    }
  });
  assert.equal(taskResponse.statusCode, 201, taskResponse.body);
  const task = taskResponse.json();
  const runResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/runs`,
    payload: { queueOnly: true }
  });
  assert.equal(runResponse.statusCode, 201, runResponse.body);
  const run = runResponse.json();
  const claimResponse = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/claim",
    payload: { ownerId: "worker-a", ttlMs: 60_000 }
  });
  assert.equal(claimResponse.statusCode, 200, claimResponse.body);
  const claim = claimResponse.json();
  assert.equal(claim.item.runId, run.id);

  const bytes = Buffer.from("actual gate log", "utf8");
  const request = {
    ownerId: "worker-a",
    claimToken: claim.claimToken,
    ttlMs: 60_000,
    candidateId: "candidate-a",
    gateResultId: "gate-result-a",
    gateId: "unit_test",
    artifact: {
      id: "unit-test-log",
      kind: "log",
      contentType: "text/plain",
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      contentBase64: bytes.toString("base64")
    }
  } as const;
  const url = `/v1/run-jobs/queue/${run.id}/artifacts`;
  const forged = await app.inject({
    method: "POST",
    url,
    payload: { ...request, artifact: { ...request.artifact, digest: "0".repeat(64) } }
  });
  assert.equal(forged.statusCode, 400, forged.body);
  assert.match(forged.body, /does not match uploaded bytes/u);

  const registered = await app.inject({ method: "POST", url, payload: request });
  assert.equal(registered.statusCode, 201, registered.body);
  const response = registered.json();
  assert.match(response.artifact.handle, /^mn:\/\/cas\/gate-artifacts\//u);
  assert.equal(response.artifact.path, undefined);
  assert.equal(response.artifact.digest, request.artifact.digest);
  const record = store.gateArtifactHandles.get(response.artifact.handle);
  assert.ok(record);
  const cas = new RunScopedCas({ localRoot: join(mniuRoot, "artifacts", "cas") });
  assert.deepEqual(await cas.readVerified(record.cas), bytes);
  assert.ok([...store.auditEvents.values()].some((event) =>
    event.action === "gate_artifact.register" &&
    event.resourceId === record.handle &&
    event.projectId === project.id &&
    event.result === "success"
  ));
  assert.equal(
    new MemoryStore({ statePath }).gateArtifactHandles.get(record.handle)?.digest,
    record.digest
  );

  const retried = await app.inject({ method: "POST", url, payload: request });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().artifact.handle, response.artifact.handle);

  const changed = Buffer.from("different bytes", "utf8");
  const conflict = await app.inject({
    method: "POST",
    url,
    payload: {
      ...request,
      artifact: {
        ...request.artifact,
        digest: createHash("sha256").update(changed).digest("hex"),
        byteLength: changed.byteLength,
        contentBase64: changed.toString("base64")
      }
    }
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.match(conflict.body, /already registered/u);
});
