// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createReadinessHeartbeat, probeWorkerLocks } from "../lib/worker-readiness.mjs";

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
