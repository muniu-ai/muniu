import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RunJobQueue,
  normalizeWorkerCapabilities,
  workerCapabilityDigest,
  workerRequirementsDigest,
  type PartialWorkerCapabilitySet,
  type PartialWorkerRequirements
} from "../src/runJobQueue.js";

test("run job queue persists queued, running, and terminal state", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-queue-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const queue = new RunJobQueue({ rootDir, ownerId: "api-owner" });
  const queued = queue.enqueue({
    runId: "run:queued/1",
    projectId: "project-1",
    taskId: "task-1",
    attempt: 2,
    recovered: true,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:01.000Z",
    resumeFromRunId: "run-source"
  });

  assert.equal(queued.status, "queued");
  assert.equal(queued.priority, 0);
  assert.equal(queued.attempt, 2);
  assert.equal(queued.recovered, true);
  assert.equal(queued.resumeFromRunId, "run-source");
  assert.equal(queue.listClaimable().map((item) => item.runId).join(","), "run:queued/1");

  const running = queue.markRunning("run:queued/1", "2026-07-06T00:00:02.000Z");
  assert.ok(running);
  assert.equal(running.status, "running");
  assert.equal(running.ownerId, "api-owner");
  assert.equal(running.startedAt, "2026-07-06T00:00:02.000Z");
  assert.equal(queue.listClaimable("2026-07-06T00:00:01.500Z").length, 0);

  const completed = queue.markFinished(
    "run:queued/1",
    "completed",
    "2026-07-06T00:00:03.000Z"
  );
  assert.ok(completed);
  assert.equal(completed.status, "completed");
  assert.equal(completed.finishedAt, "2026-07-06T00:00:03.000Z");

  const reloaded = new RunJobQueue({ rootDir }).read("run:queued/1");
  assert.ok(reloaded);
  assert.equal(reloaded.status, "completed");
  assert.equal(reloaded.priority, 0);
  assert.equal(reloaded.createdAt, "2026-07-06T00:00:00.000Z");

  const queueFile = await readFile(join(rootDir, "run-queued-1.json"), "utf8");
  assert.match(queueFile, /"status": "completed"/);
});

test("run job queue supports claim heartbeat expiry and release", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-queue-claim-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const queue = new RunJobQueue({ rootDir });
  queue.enqueue({
    runId: "run-claim",
    projectId: "project-1",
    taskId: "task-1",
    attempt: 1,
    recovered: false,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z"
  });

  const claimed = queue.claimNext({
    ownerId: "worker-a",
    now: "2026-07-06T00:00:01.000Z",
    ttlMs: 1_000
  });
  assert.ok(claimed);
  assert.equal(claimed.item.status, "running");
  assert.equal(claimed.item.ownerId, "worker-a");
  assert.equal(claimed.item.claimToken, claimed.claimToken);
  assert.equal(claimed.item.claimedAt, "2026-07-06T00:00:01.000Z");
  assert.equal(claimed.item.claimExpiresAt, "2026-07-06T00:00:02.000Z");
  assert.equal(queue.listClaimable("2026-07-06T00:00:01.500Z").length, 0);

  const heartbeat = queue.heartbeat("run-claim", {
    ownerId: "worker-a",
    claimToken: claimed.claimToken,
    now: "2026-07-06T00:00:01.500Z",
    ttlMs: 2_000
  });
  assert.ok(heartbeat);
  assert.equal(heartbeat.heartbeatAt, "2026-07-06T00:00:01.500Z");
  assert.equal(heartbeat.claimExpiresAt, "2026-07-06T00:00:03.500Z");
  assert.equal(
    queue.heartbeat("run-claim", {
      ownerId: "worker-b",
      claimToken: claimed.claimToken,
      now: "2026-07-06T00:00:02.000Z"
    }),
    undefined
  );

  const released = queue.release("run-claim", {
    ownerId: "worker-a",
    claimToken: claimed.claimToken,
    now: "2026-07-06T00:00:02.000Z"
  });
  assert.ok(released);
  assert.equal(released.status, "queued");
  assert.equal(released.ownerId, undefined);
  assert.equal(released.claimToken, undefined);
  assert.equal(released.startedAt, undefined);
  assert.equal(released.releasedAt, "2026-07-06T00:00:02.000Z");
  assert.deepEqual(
    queue.listClaimable("2026-07-06T00:00:02.000Z").map((item) => item.runId),
    ["run-claim"]
  );

  const expired = queue.claim("run-claim", {
    ownerId: "worker-c",
    now: "2026-07-06T00:00:03.000Z",
    ttlMs: 1_000
  });
  assert.ok(expired);
  assert.equal(expired.item.claimExpiresAt, "2026-07-06T00:00:04.000Z");
  assert.equal(
    queue.heartbeat("run-claim", {
      ownerId: "worker-c",
      claimToken: expired.claimToken,
      now: "2026-07-06T00:00:05.000Z"
    }),
    undefined
  );
  const reclaimed = queue.claimNext({
    ownerId: "worker-d",
    now: "2026-07-06T00:00:05.000Z",
    ttlMs: 1_000
  });
  assert.ok(reclaimed);
  assert.equal(reclaimed.item.ownerId, "worker-d");
  assert.notEqual(reclaimed.claimToken, expired.claimToken);
});

test("run job queue claims higher priority before fifo order", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-queue-priority-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const queue = new RunJobQueue({ rootDir });
  queue.enqueue({
    runId: "run-low-old",
    projectId: "project-1",
    taskId: "task-1",
    priority: 0,
    attempt: 1,
    recovered: false,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z"
  });
  queue.enqueue({
    runId: "run-high-new",
    projectId: "project-1",
    taskId: "task-2",
    priority: 10,
    attempt: 1,
    recovered: false,
    createdAt: "2026-07-06T00:00:05.000Z",
    updatedAt: "2026-07-06T00:00:05.000Z"
  });
  queue.enqueue({
    runId: "run-low-new",
    projectId: "project-1",
    taskId: "task-3",
    priority: 0,
    attempt: 1,
    recovered: false,
    createdAt: "2026-07-06T00:00:10.000Z",
    updatedAt: "2026-07-06T00:00:10.000Z"
  });

  assert.deepEqual(
    queue.listClaimable("2026-07-06T00:00:11.000Z").map((item) => item.runId),
    ["run-high-new", "run-low-old", "run-low-new"]
  );

  const claimed = queue.claimNext({
    ownerId: "worker-priority",
    now: "2026-07-06T00:00:12.000Z"
  });
  assert.ok(claimed);
  assert.equal(claimed.item.runId, "run-high-new");
  assert.equal(claimed.item.priority, 10);
});

const enterpriseCapabilities: PartialWorkerCapabilitySet = {
  providers: ["codex", "claude"],
  languages: ["go", "node"],
  gateRunnerIds: ["builtin/security", "builtin/contract"],
  sandboxBackends: [
    {
      backendId: "container",
      enforcement: "enforced",
      capabilities: ["network-deny", "readonly-root", "secret-injection"]
    }
  ],
  tenantIds: ["tenant-a"],
  tools: ["docker", "go", "node"]
};

const enterpriseRequirements: PartialWorkerRequirements = {
  requiredProviders: ["codex"],
  requiredLanguages: ["go"],
  requiredGateRunnerIds: ["builtin/contract", "builtin/security"],
  sandbox: {
    allowedBackendIds: ["container"],
    minEnforcement: "enforced",
    requiredCapabilities: ["network-deny", "secret-injection"]
  },
  requiredTools: ["docker", "go"]
};

test("v2 queue only assigns enterprise jobs to a fully compatible tenant worker", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-queue-v2-capability-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  const queue = new RunJobQueue({ rootDir });
  queue.enqueue({
    version: 2,
    runId: "run-enterprise",
    projectId: "project-1",
    taskId: "task-1",
    tenantId: "tenant-a",
    requirements: enterpriseRequirements,
    attempt: 1,
    recovered: false,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z"
  });

  assert.equal(queue.claimNext({
    ownerId: "worker-insufficient",
    now: "2026-07-06T00:00:01.000Z",
    capabilities: {
      ...enterpriseCapabilities,
      gateRunnerIds: ["builtin/contract"]
    }
  }), undefined);
  const incompatibleCapabilitySets: PartialWorkerCapabilitySet[] = [
    { ...enterpriseCapabilities, providers: ["claude"] },
    { ...enterpriseCapabilities, languages: ["node"] },
    { ...enterpriseCapabilities, tools: ["node"] },
    {
      ...enterpriseCapabilities,
      sandboxBackends: [{ backendId: "container", enforcement: "enforced" as const, capabilities: ["network-deny"] }]
    }
  ];
  for (const capabilities of incompatibleCapabilitySets) {
    assert.equal(queue.claimNext({
      ownerId: "worker-missing-required-dimension",
      now: "2026-07-06T00:00:01.000Z",
      capabilities
    }), undefined);
  }
  assert.equal(queue.claimNext({
    ownerId: "worker-wrong-tenant",
    now: "2026-07-06T00:00:01.000Z",
    capabilities: {
      ...enterpriseCapabilities,
      tenantIds: ["tenant-b"]
    }
  }), undefined);
  assert.equal(queue.claimNext({
    ownerId: "worker-weak-sandbox",
    now: "2026-07-06T00:00:01.000Z",
    capabilities: {
      ...enterpriseCapabilities,
      sandboxBackends: [{ backendId: "container", enforcement: "postcheck", capabilities: ["network-deny", "secret-injection"] }]
    }
  }), undefined);

  const claimed = queue.claimNext({
    ownerId: "worker-enterprise",
    now: "2026-07-06T00:00:01.000Z",
    ttlMs: 2_000,
    capabilities: enterpriseCapabilities
  });
  assert.ok(claimed);
  assert.equal(claimed.item.version, 2);
  assert.equal(claimed.item.claimToken, undefined);
  assert.match(claimed.item.claimTokenHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(claimed.item.claimBindingDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(claimed.item.workerCapabilityDigest, workerCapabilityDigest(enterpriseCapabilities));

  const queueFile = await readFile(join(rootDir, "run-enterprise.json"), "utf8");
  assert.equal(queueFile.includes(claimed.claimToken), false);
  assert.doesNotMatch(queueFile, /"claimToken"\s*:/);
  assert.match(queueFile, /"claimTokenHash"\s*:/);

  assert.equal(queue.heartbeat("run-enterprise", {
    ownerId: "worker-enterprise",
    claimToken: "00000000-0000-4000-8000-000000000000",
    now: "2026-07-06T00:00:02.000Z"
  }), undefined);
  assert.ok(queue.heartbeat("run-enterprise", {
    ownerId: "worker-enterprise",
    claimToken: claimed.claimToken,
    now: "2026-07-06T00:00:02.000Z",
    ttlMs: 2_000,
    capabilities: enterpriseCapabilities
  }));
  assert.equal(queue.heartbeat("run-enterprise", {
    ownerId: "worker-enterprise",
    claimToken: claimed.claimToken,
    now: "2026-07-06T00:00:04.000Z"
  }), undefined);
});

test("v2 claim binding rejects cross-run tokens and persisted capability mutation", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-queue-v2-binding-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  const queue = new RunJobQueue({ rootDir });
  for (const runId of ["run-a", "run-b"]) {
    queue.enqueue({
      version: 2,
      runId,
      projectId: "project-1",
      taskId: `task-${runId}`,
      tenantId: "tenant-a",
      requirements: enterpriseRequirements,
      attempt: 1,
      recovered: false,
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z"
    });
  }
  const claimA = queue.claim("run-a", {
    ownerId: "worker-enterprise",
    now: "2026-07-06T00:00:01.000Z",
    ttlMs: 10_000,
    capabilities: enterpriseCapabilities
  });
  const claimB = queue.claim("run-b", {
    ownerId: "worker-enterprise",
    now: "2026-07-06T00:00:01.000Z",
    ttlMs: 10_000,
    capabilities: enterpriseCapabilities
  });
  assert.ok(claimA);
  assert.ok(claimB);
  assert.equal(queue.heartbeat("run-b", {
    ownerId: "worker-enterprise",
    claimToken: claimA.claimToken,
    now: "2026-07-06T00:00:02.000Z"
  }), undefined);

  const path = join(rootDir, "run-a.json");
  const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  persisted.workerCapabilityDigest = "0".repeat(64);
  await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  assert.equal(queue.read("run-a"), undefined);
  assert.equal(queue.heartbeat("run-a", {
    ownerId: "worker-enterprise",
    claimToken: claimA.claimToken,
    now: "2026-07-06T00:00:02.000Z"
  }), undefined);
});

test("worker capability and requirement digests are deterministic after normalization", () => {
  const reversed: PartialWorkerCapabilitySet = {
    ...enterpriseCapabilities,
    providers: ["claude", "codex"],
    tools: ["node", "go", "docker"]
  };
  assert.deepEqual(normalizeWorkerCapabilities(reversed).providers, ["claude", "codex"]);
  assert.equal(workerCapabilityDigest(reversed), workerCapabilityDigest(enterpriseCapabilities));
  assert.equal(
    workerRequirementsDigest({ ...enterpriseRequirements, requiredTools: ["go", "docker"] }),
    workerRequirementsDigest(enterpriseRequirements)
  );
});
