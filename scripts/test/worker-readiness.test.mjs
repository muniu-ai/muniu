// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createReadinessHeartbeat, pollReadyWorker, probeWorkerLocks } from "../lib/worker-readiness.mjs";

test("Worker readiness checks live database locks after startup", async () => {
  const expected = { engine: "engine-a", plugin: "plugin-a" };
  let rows = [{ engine_digest: expected.engine, plugin_digest: expected.plugin }];
  const pool = { query: async () => ({ rows }) };
  assert.equal(await probeWorkerLocks(pool, expected), true);
  rows = [{ engine_digest: "engine-b", plugin_digest: expected.plugin }];
  assert.equal(await probeWorkerLocks(pool, expected), false);
  rows = [];
  assert.equal(await probeWorkerLocks(pool, expected), false);
});

test("dependency failures stop claims while independent process liveness continues", async () => {
  let dependenciesReady = false;
  let claims = 0;
  let liveWrites = 0;
  const worker = { pollOnce: async () => { claims++; return { status: "idle" }; } };
  const readiness = createReadinessHeartbeat({ check: async () => dependenciesReady, publish: async () => {}, remove: async () => {} });
  const liveness = createReadinessHeartbeat({ check: async () => true, publish: async () => { liveWrites++; }, remove: async () => {} });
  assert.deepEqual(await pollReadyWorker(worker, readiness), { status: "unready" });
  assert.equal(claims, 0);
  assert.equal(await liveness.tick(), true);
  assert.equal(liveWrites, 1);
  dependenciesReady = true;
  assert.deepEqual(await pollReadyWorker(worker, readiness), { status: "idle" });
  assert.equal(claims, 1);
  dependenciesReady = false;
  await pollReadyWorker(worker, readiness);
  assert.equal(claims, 1);
  await readiness.stop();
  dependenciesReady = true;
  await pollReadyWorker(worker, readiness);
  assert.equal(claims, 1);
});

test("shutdown during a dependency probe never claims a new job", async () => {
  const abort = new AbortController();
  let claims = 0;
  const heartbeat = createReadinessHeartbeat({ check: async () => { abort.abort(); return true; }, publish: async () => {}, remove: async () => {} });
  assert.deepEqual(await pollReadyWorker({ pollOnce: async () => { claims++; } }, heartbeat, abort.signal), { status: "unready" });
  assert.equal(claims, 0);
});

test("failed readiness publication or removal cannot authorize claims", async () => {
  let valid = true;
  const heartbeat = createReadinessHeartbeat({ check: async () => valid,
    publish: async () => { throw new Error("filesystem failure"); }, remove: async () => { throw new Error("filesystem failure"); } });
  assert.equal(await heartbeat.tick(), false);
  valid = false;
  assert.equal(await heartbeat.tick(), false);
});

test("Worker removes readiness on failed probes and never overlaps probes or republishes after shutdown", async () => {
  let valid = true;
  let release;
  let block;
  let probes = 0;
  const writes = [];
  const heartbeat = createReadinessHeartbeat({
    check: async () => { probes++; await block; if (!valid) throw new Error("private database credential"); return true; },
    publish: async () => { writes.push("ready"); },
    remove: async () => { writes.push("removed"); },
  });
  await heartbeat.tick();
  assert.deepEqual(writes, ["ready"]);
  valid = false;
  await heartbeat.tick();
  assert.deepEqual(writes, ["ready", "removed"]);
  valid = true;
  block = new Promise(resolve => { release = resolve; });
  const pending = heartbeat.tick();
  void heartbeat.tick();
  assert.equal(probes, 3);
  const stopping = heartbeat.stop();
  release();
  await Promise.all([pending, stopping]);
  await heartbeat.tick();
  assert.deepEqual(writes, ["ready", "removed", "removed"]);
  assert.equal(probes, 3);
});
