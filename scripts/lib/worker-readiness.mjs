// SPDX-License-Identifier: Apache-2.0

export async function probeWorkerLocks(pool, expected) {
  const result = await pool.query({
    text: "select engine_digest, plugin_digest from mn_v2.runtime_locks where singleton = true",
    query_timeout: 3000,
  });
  const current = result.rows[0];
  return current?.engine_digest === expected.engine && current?.plugin_digest === expected.plugin;
}

export function createReadinessHeartbeat({ check, publish, remove }) {
  let stopped = false;
  let active;
  return {
    tick() {
      if (stopped) return Promise.resolve(false);
      if (active) return active;
      active = (async () => {
        try {
          const ready = await check();
          if (stopped) return false;
          if (ready) await publish(); else await remove();
          return ready === true && !stopped;
        } catch {
          if (!stopped) await remove();
          return false;
        }
      })().catch(() => {
        // A stale readiness file expires at the deployment probe even if removal fails.
        return false;
      }).finally(() => { active = undefined; });
      return active;
    },
    async stop() {
      stopped = true;
      await active;
      await remove();
    },
  };
}

export async function pollReadyWorker(worker, heartbeat, signal) {
  if (signal?.aborted || !await heartbeat.tick() || signal?.aborted) return { status: "unready" };
  return worker.pollOnce(signal);
}
