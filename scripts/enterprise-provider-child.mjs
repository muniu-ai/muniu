// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { actionFixture } from './lib/enterprise-action-fixture.mjs';
import { enterpriseProviderRuntime } from './lib/enterprise-provider-fixture.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8')), selected = config.enterpriseProvider;
assert.ok(selected && ['dispatch_committed', 'effect_committed'].includes(selected.phase));
assert.ok(Number.isSafeInteger(selected.clockOffset) && selected.clockOffset >= 0);
const f = await actionFixture(config, { workerId: 'builtin-provider-child', offset: selected.clockOffset });
try {
  const boundary = async intent => {
    assert.equal(intent.operationKey, selected.operationKey);
    await new Promise((resolve, reject) => process.send({ status: selected.phase, operationKey: intent.operationKey }, error => error ? reject(error) : resolve()));
    await new Promise(() => {});
  };
  const assembled = await enterpriseProviderRuntime({ store: f.store, cas: f.cas, key: config.key, tenantId: selected.tenantId, workspaceId: selected.workspaceId, now: f.now,
    beforeExecute: selected.phase === 'dispatch_committed' ? boundary : undefined,
    afterExecute: selected.phase === 'effect_committed' ? async (intent, receipt) => { assert.equal(receipt.status, 'succeeded'); await boundary(intent); } : undefined,
    onExecute: intent => f.pool.query('insert into fixture_provider.builtin_calls values($1,1) on conflict(operation_key) do update set calls=fixture_provider.builtin_calls.calls+1', [intent.operationKey]),
  });
  const result = await assembled.worker('builtin-provider-child').pollOnce();
  throw new Error('PROVIDER_CHILD_DID_NOT_REACH_BOUNDARY:' + result.status);
} finally { await f.close(); }
