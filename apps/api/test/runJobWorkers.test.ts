import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunJobWorkerRegistry } from "../src/runJobWorkers.js";
import { workerCapabilityDigest, type PartialWorkerCapabilitySet } from "../src/runJobQueue.js";

test("run job worker registry tracks idle running stale and terminal counters", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-workers-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const registry = new RunJobWorkerRegistry({ rootDir });
  const idle = registry.heartbeat({
    ownerId: "worker/a",
    now: "2026-07-06T00:00:00.000Z",
    ttlMs: 1_000
  });
  assert.equal(idle.status, "idle");
  assert.equal(idle.capacity, 1);
  assert.deepEqual(idle.activeRunIds, []);
  assert.equal(idle.heartbeatExpiresAt, "2026-07-06T00:00:01.000Z");
  assert.equal(registry.list("2026-07-06T00:00:00.500Z")[0]?.state, "idle");
  assert.equal(registry.list("2026-07-06T00:00:01.000Z")[0]?.state, "stale");

  const running = registry.markClaimed({
    ownerId: "worker/a",
    activeRunId: "run-1",
    capacity: 1,
    now: "2026-07-06T00:00:02.000Z",
    ttlMs: 2_000
  });
  assert.equal(running.status, "running");
  assert.equal(running.activeRunId, "run-1");
  assert.deepEqual(running.activeRunIds, ["run-1"]);
  assert.equal(registry.hasClaimCapacity({ ownerId: "worker/a", now: "2026-07-06T00:00:03.000Z" }).available, false);
  assert.equal(running.lastClaimedAt, "2026-07-06T00:00:02.000Z");
  const runningView = registry.list("2026-07-06T00:00:03.000Z")[0];
  assert.equal(runningView?.state, "running");
  assert.equal(runningView?.activeRunCount, 1);
  assert.equal(runningView?.availableSlots, 0);

  const released = registry.markReleased({
    ownerId: "worker/a",
    runId: "run-1",
    now: "2026-07-06T00:00:03.000Z",
    ttlMs: 1_000,
    lastError: "executor aborted"
  });
  assert.equal(released.status, "idle");
  assert.equal(released.activeRunId, undefined);
  assert.deepEqual(released.activeRunIds, []);
  assert.equal(registry.hasClaimCapacity({ ownerId: "worker/a", now: "2026-07-06T00:00:03.500Z" }).available, true);
  assert.equal(released.releasedRunCount, 1);
  assert.equal(released.lastError, "executor aborted");

  registry.markClaimed({
    ownerId: "worker/a",
    activeRunId: "run-2",
    capacity: 2,
    now: "2026-07-06T00:00:04.000Z",
    ttlMs: 1_000
  });
  registry.markClaimed({
    ownerId: "worker/a",
    activeRunId: "run-3",
    capacity: 2,
    now: "2026-07-06T00:00:04.100Z",
    ttlMs: 1_000
  });
  assert.equal(registry.hasClaimCapacity({ ownerId: "worker/a", capacity: 2, now: "2026-07-06T00:00:04.200Z" }).available, false);
  const finished = registry.markFinished({
    ownerId: "worker/a",
    runId: "run-2",
    status: "completed",
    capacity: 2,
    now: "2026-07-06T00:00:04.500Z",
    ttlMs: 1_000
  });
  assert.equal(finished.status, "running");
  assert.equal(finished.activeRunId, "run-3");
  assert.deepEqual(finished.activeRunIds, ["run-3"]);
  assert.equal(finished.completedRunCount, 1);
  assert.equal(finished.failedRunCount, 0);
  assert.equal(finished.cancelledRunCount, 0);
  assert.equal(registry.hasClaimCapacity({ ownerId: "worker/a", capacity: 2, now: "2026-07-06T00:00:04.600Z" }).available, true);

  const workerFile = await readFile(join(rootDir, "worker-a.json"), "utf8");
  assert.match(workerFile, /"completedRunCount": 1/);
});

const capabilities: PartialWorkerCapabilitySet = {
  providers: ["codex"],
  languages: ["go", "node"],
  gateRunnerIds: ["builtin/contract", "builtin/security"],
  sandboxBackends: [{
    backendId: "container",
    enforcement: "enforced",
    capabilities: ["network-deny", "secret-injection"]
  }],
  tenantIds: ["tenant-a"],
  tools: ["docker", "go"]
};

test("worker registry persists capability digest and blocks active capability mutation", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-workers-capabilities-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  const registry = new RunJobWorkerRegistry({ rootDir });
  const idle = registry.heartbeat({
    ownerId: "worker-enterprise",
    now: "2026-07-06T00:00:00.000Z",
    ttlMs: 5_000,
    capabilities
  });
  assert.equal(idle.version, 2);
  assert.equal(idle.capabilityDigest, workerCapabilityDigest(capabilities));
  assert.deepEqual(idle.capabilities?.languages, ["go", "node"]);

  registry.markClaimed({
    ownerId: "worker-enterprise",
    activeRunId: "run-1",
    now: "2026-07-06T00:00:01.000Z",
    ttlMs: 5_000,
    capabilities
  });
  assert.throws(() => registry.heartbeat({
    ownerId: "worker-enterprise",
    status: "running",
    activeRunId: "run-1",
    now: "2026-07-06T00:00:02.000Z",
    ttlMs: 5_000,
    capabilities: { ...capabilities, providers: ["claude"] }
  }), /cannot change while runs are active/);

  registry.markFinished({
    ownerId: "worker-enterprise",
    runId: "run-1",
    status: "completed",
    now: "2026-07-06T00:00:03.000Z",
    ttlMs: 5_000
  });
  const changed = registry.heartbeat({
    ownerId: "worker-enterprise",
    now: "2026-07-06T00:00:04.000Z",
    ttlMs: 5_000,
    capabilities: { ...capabilities, providers: ["claude"] }
  });
  assert.equal(changed.capabilities?.providers[0], "claude");
  assert.notEqual(changed.capabilityDigest, idle.capabilityDigest);

  const workerFile = await readFile(join(rootDir, "worker-enterprise.json"), "utf8");
  assert.match(workerFile, /"capabilityDigest": "[a-f0-9]{64}"/);
});

test("worker registry rejects invalid time, ttl, and capacity boundaries", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-workers-boundaries-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  const registry = new RunJobWorkerRegistry({ rootDir });
  assert.throws(() => registry.heartbeat({ ownerId: "worker-a", now: "not-a-time" }), /timestamp/);
  assert.throws(() => registry.heartbeat({
    ownerId: "worker-a",
    now: "2026-07-06T00:00:00.000Z",
    ttlMs: 999
  }), /ttlMs/);
  assert.throws(() => registry.heartbeat({
    ownerId: "worker-a",
    now: "2026-07-06T00:00:00.000Z",
    capacity: 257
  }), /capacity/);
});

test("worker registry isolates the same owner id across tenant namespaces", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-workers-tenants-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  const registry = new RunJobWorkerRegistry({ rootDir });

  registry.heartbeat({
    ownerId: "shared-worker",
    capacity: 1,
    now: "2026-07-06T00:00:00.000Z",
    ttlMs: 5_000,
    lastError: "tenant-a-only"
  }, "tenant-a");
  registry.heartbeat({
    ownerId: "shared-worker",
    capacity: 2,
    now: "2026-07-06T00:00:01.000Z",
    ttlMs: 5_000,
    lastError: "tenant-b-only"
  }, "tenant-b");

  assert.equal(registry.read("shared-worker", "tenant-a")?.capacity, 1);
  assert.equal(registry.read("shared-worker", "tenant-a")?.lastError, "tenant-a-only");
  assert.equal(registry.read("shared-worker", "tenant-b")?.capacity, 2);
  assert.equal(registry.read("shared-worker", "tenant-b")?.lastError, "tenant-b-only");
  assert.deepEqual(
    registry.list("2026-07-06T00:00:02.000Z", "tenant-a").map((worker) => worker.ownerId),
    ["shared-worker"]
  );
  assert.deepEqual(
    registry.list("2026-07-06T00:00:02.000Z", "tenant-b").map((worker) => worker.ownerId),
    ["shared-worker"]
  );
  assert.deepEqual(registry.list("2026-07-06T00:00:02.000Z"), []);
});

test("enterprise fleet views reconcile terminal claims first observed by another API replica", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-workers-replica-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  const registry = new RunJobWorkerRegistry({ rootDir });

  assert.throws(() => registry.markReleased({
    ownerId: "worker-enterprise@pod-a",
    runId: "run-untracked",
    now: "2026-07-06T00:00:00.000Z"
  }, "tenant-a"), /cannot release a run that is not active/u);

  const released = registry.markReleased({
    ownerId: "worker-enterprise@pod-a",
    runId: "run-untracked",
    now: "2026-07-06T00:00:00.000Z"
  }, "tenant-a", { allowUntrackedRun: true });
  assert.equal(released.status, "idle");
  assert.equal(released.releasedRunCount, 1);

  const finished = registry.markFinished({
    ownerId: "worker-enterprise@pod-b",
    runId: "run-untracked",
    status: "completed",
    now: "2026-07-06T00:00:01.000Z"
  }, "tenant-a", { allowUntrackedRun: true });
  assert.equal(finished.status, "idle");
  assert.equal(finished.completedRunCount, 1);
});
