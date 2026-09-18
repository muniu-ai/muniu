// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProject, validateFixtureConfig, acceptanceSummary, databaseUrl, acceptancePlan, restoreTargets } from './industry-delivery-e2e.mjs';

test('every planned scenario repeats and template API checks never claim a Worker execution', () => {
  const plan = acceptancePlan(3);
  assert.equal(new Set(plan.map(x => x.id)).size, plan.length);
  for (const name of ['worker-takeover', 'database-restore', 'customer-transfer', 'concurrent-package'])
    assert.deepEqual(plan.filter(x => x.scenario === name).map(x => x.repetition), [1, 2, 3]);
  assert.deepEqual(plan.find(x => x.scenario === 'template-version').paths, ['api']);
  assert.ok(plan.every(x => x.status === 'not_run'));
  assert.throws(() => acceptancePlan(0));
  assert.throws(() => acceptancePlan(4));
});

test('each restore uses a fresh target pair while source databases remain fixed', () => {
  const targets = [1, 2, 3].map(restoreTargets);
  assert.equal(new Set(targets.flatMap(x => [x.os, x.sales])).size, 6);
  assert.ok(targets.every(x => x.sourceOs === 'mn_os' && x.sourceSales === 'mn_sales'));
  assert.throws(() => restoreTargets('1;drop database mn_os'));
});

test('restoring a database changes only the database path, preserving the login role', () => {
  const value = new URL(databaseUrl('postgres://mn_sales:fixture@127.0.0.1:55432/mn_sales', 'mn_sales_restored'));
  assert.equal(value.username, 'mn_sales');
  assert.equal(value.password, 'fixture');
  assert.equal(value.pathname, '/mn_sales_restored');
});

test('integration fixture is confined to a synthetic tenant and loopback services', () => {
  const base = { synthetic: true, tenantId: '11111111-1111-4111-8111-111111111111', salesUrl: 'http://127.0.0.1:3101', hostUrl: 'http://127.0.0.1:7318', jwksUrl: 'http://127.0.0.1:59080' };
  assert.doesNotThrow(() => validateFixtureConfig(base));
  assert.throws(() => validateFixtureConfig({ ...base, tenantId: 'real-tenant' }));
  assert.throws(() => validateFixtureConfig({ ...base, synthetic: false }));
  assert.throws(() => validateFixtureConfig({ ...base, salesUrl: 'https://example.com' }));
  assert.match(fixtureProject(), /^mn-industry-[a-z0-9-]+$/u);
});

test('partial integration checks never produce a P5 release pass', () => {
  const result = acceptanceSummary([{ id: 'normal', status: 'passed' }]);
  assert.equal(result.status, 'passed');
  assert.equal(result.p5, 'blocked');
  assert.equal(result.fullFaultMatrix, 'not_run');
  assert.equal(acceptanceSummary([{ id: 'normal', status: 'failed' }]).status, 'failed');
  assert.equal(acceptanceSummary([{ id: 'normal', status: 'not_run' }]).status, 'not_run');
});
