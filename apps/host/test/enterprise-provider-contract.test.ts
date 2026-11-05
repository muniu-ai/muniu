// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinProviderContractFixture, type ProviderContractFixtureInput } from './fixtures/enterprise-provider-contract.js';

const suiteUrl = new URL('../../../../scripts/lib/provider-contract-suite.mjs', import.meta.url).href;
const suite = await import(suiteUrl) as {
  PROVIDER_CONTRACT_CASES: readonly { readonly id: string }[];
  runProviderContractCase(id: string, factory: (input: ProviderContractFixtureInput) => Promise<unknown>): Promise<{ id: string; status: string }>;
};

test('真实内置提供方通过与 Sales 共用的五端口契约套件', { concurrency: 1 }, async t => {
  assert.equal(suite.PROVIDER_CONTRACT_CASES.length, 16);
  for (const entry of suite.PROVIDER_CONTRACT_CASES) {
    await t.test(entry.id, async child => {
      const result = await suite.runProviderContractCase(entry.id, input => createBuiltinProviderContractFixture(input, child));
      assert.deepEqual(result, { id: entry.id, status: 'passed' });
    });
  }
});
