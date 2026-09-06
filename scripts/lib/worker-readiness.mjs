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
      if (stopped) return Promise.resolve();
      if (active) return active;
      active = (async () => {
        try {
          const ready = await check();
          if (stopped) return;
          if (ready) await publish(); else await remove();
        } catch {
          if (!stopped) await remove();
        }
      })().catch(() => {
        // A stale readiness file expires at the deployment probe even if removal fails.
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
