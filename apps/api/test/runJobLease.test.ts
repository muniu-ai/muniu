import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunJobLeaseManager } from "../src/runJobLease.js";

test("run job lease prevents concurrent owners for the same run", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-lease-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const first = new RunJobLeaseManager({
    rootDir,
    ownerId: "api-1",
    heartbeatMs: 0
  });
  const second = new RunJobLeaseManager({
    rootDir,
    ownerId: "api-2",
    heartbeatMs: 0
  });

  const lease = first.acquire("run:1");
  assert.ok(lease);
  assert.equal(second.acquire("run:1"), undefined);

  lease.release();
  const nextLease = second.acquire("run:1");
  assert.ok(nextLease);
  nextLease.release();
});

test("run job lease reclaims expired locks", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-run-job-lease-expired-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const staleOwner = new RunJobLeaseManager({
    rootDir,
    ownerId: "stale-api",
    ttlMs: 5,
    heartbeatMs: 0
  });
  const liveOwner = new RunJobLeaseManager({
    rootDir,
    ownerId: "live-api",
    ttlMs: 60_000,
    heartbeatMs: 0
  });

  const staleLease = staleOwner.acquire("run:expired");
  assert.ok(staleLease);
  await delay(20);

  const liveLease = liveOwner.acquire("run:expired");
  assert.ok(liveLease);
  assert.equal(liveLease.ownerId, "live-api");

  staleLease.release();
  assert.equal(liveOwner.acquire("run:expired"), undefined);
  liveLease.release();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
