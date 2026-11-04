// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { actionFixture } from './lib/enterprise-action-fixture.mjs';
import { goalsRuntime } from './lib/enterprise-goals-fixture.mjs';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const f = await actionFixture(config);
try {
  const runtime = goalsRuntime({ store: f.store, cas: f.cas, key: config.key, modelUrl: config.modelUrl, invoke: async () => { process.send?.({ status: 'committed' }); await new Promise(() => {}); } });
  await runtime.worker('goal-crash').pollOnce();
} finally { await f.close(); }
