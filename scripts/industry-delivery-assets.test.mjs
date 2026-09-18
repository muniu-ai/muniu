// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateBundle, selectCases } from './industry-delivery-validate.mjs';
import { summarizeResults } from './industry-delivery-summary.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { assertReleaseAdmission, canonicalManifestPayload, verifyReleaseSignature, verifyReleaseGate } from './industry-delivery-release-gate.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const bundle = resolve(root, 'fixtures/industry-delivery/v1');

test('synthetic corpus has exact category and holdout counts', async () => {
  const result = await validateBundle(bundle);
  assert.equal(result.cases, 60);
  assert.equal(result.holdout, 20);
  assert.equal(result.faultRuns, 72);
});

test('development selection cannot expose holdout by default', async () => {
  const manifest = JSON.parse(await readFile(resolve(bundle, 'corpus.json'), 'utf8'));
  assert.equal(selectCases(manifest).length, 40);
  assert.equal(selectCases(manifest).some(x => x.split === 'holdout'), false);
  assert.throws(() => selectCases(manifest, 'holdout'), /frozen/);
  assert.equal(selectCases(manifest, 'holdout', { configurationFrozen: true }).length, 20);
});

test('unexecuted adapters cannot claim a measured result', () => {
  const input = { schemaVersion: 1, corpusVersion: '1.1.0', runs: [] };
  const summary = summarizeResults(input);
  assert.equal(summary.productionReady, false);
  assert.equal(summary.comparativeAdvantage, 'unknown');
  assert.equal(summary.adapters.adp.status, 'not_run');
  assert.equal(summary.adapters.adp.passed, 0);
});

test('documented capability remains unmeasured', () => {
  const input = { schemaVersion: 1, corpusVersion: '1.1.0', runs: [{
    adapter: 'adp', testId: 'DEMO-RFQ-001', status: 'documented',
    reason: '仅核对官方文档', sourceUrl: 'https://cloud.tencent.com/document/product/1759/128604',
  }] };
  const summary = summarizeResults(input);
  assert.equal(summary.adapters.adp.documented, 1);
  assert.equal(summary.adapters.adp.passed, 0);
  assert.equal(summary.adapters.adp.status, 'documented');
});

test('pass without execution identity and durable evidence is rejected', () => {
  assert.throws(() => summarizeResults({ schemaVersion: 1, corpusVersion: '1.1.0', runs: [{
    adapter: 'muniu', testId: 'DEMO-RFQ-001', status: 'passed',
  }] }), /execution evidence/);
});

test('duplicate rows cannot inflate pass totals', () => {
  const row = { adapter: 'adp', testId: 'DEMO-RFQ-001', status: 'unknown', reason: '未知' };
  assert.throws(() => summarizeResults({ schemaVersion: 1, corpusVersion: '1.1.0', runs: [row, row] }), /duplicate/);
});

test('a result with incomplete quality metrics cannot pass', () => {
  assert.throws(() => summarizeResults({ schemaVersion: 1, corpusVersion: '1.1.0', runs: [{
    adapter: 'muniu', testId: 'DEMO-RFQ-001', status: 'passed', runId: 'demo-run',
    executedAt: '2026-09-18T00:00:00Z', configurationSha256: 'a'.repeat(64),
    evidence: [{ path: 'private/result.json', sha256: 'b'.repeat(64) }],
    metrics: { requiredAssertions: 3, passedAssertions: 2, criticalViolations: 0 },
  }] }), /all assertions/);
});

test('release template never opens real admission', async () => {
  const template = JSON.parse(await readFile(resolve(root, 'docs/industry-delivery/release-manifest.template.json'), 'utf8'));
  assert.equal(template.newRealTenantsEnabled, false);
  assert.throws(() => assertReleaseAdmission(template), /template/);
});

test('unknown case identifiers cannot count as executed coverage', () => {
  assert.throws(() => summarizeResults({ schemaVersion: 1, corpusVersion: '1.1.0', runs: [{ adapter: 'adp', testId: 'DEMO-RFQ-999', status: 'unknown', reason: 'unknown' }] }));
});

test('release signature requires trusted key and rejects tampering', () => {
  const trusted = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const manifest = { schemaVersion: 1, releaseId: 'test-only', newRealTenantsEnabled: false };
  manifest.signature = { algorithm: 'Ed25519', keyId: 'test-key', value: sign(null, canonicalManifestPayload(manifest), trusted.privateKey).toString('base64') };
  assert.doesNotThrow(() => verifyReleaseSignature(manifest, trusted.publicKey));
  assert.throws(() => verifyReleaseSignature(manifest, other.publicKey), /signature/);
  manifest.newRealTenantsEnabled = true;
  assert.throws(() => verifyReleaseSignature(manifest, trusted.publicKey), /signature/);
});

test('signed gate binds tenant, candidate, artifacts, expiry and P5 results', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'docs/industry-delivery/release-manifest.template.json'), 'utf8'));
  Object.assign(manifest, { kind: 'release', releaseId: 'unit-test-only', candidateId: 'unit-test-candidate', createdAt: '2026-09-18T00:00:00Z', validFrom: '2026-09-18T00:00:00Z', expiresAt: '2026-09-19T00:00:00Z', allowedRealTenantIds: ['tenant-unit-test'], newRealTenantsEnabled: true, demoOnly: false });
  for (const component of ['agentOs', 'sales']) manifest.components[component] = { commit: 'a'.repeat(40), lockSha256: 'b'.repeat(64), imageDigest: `sha256:${'c'.repeat(64)}` };
  manifest.components.web = { commit: 'a'.repeat(40), assetSha256: 'b'.repeat(64) };
  for (const key of Object.keys(manifest.components)) if (key.endsWith('Sha256')) manifest.components[key] = 'd'.repeat(64);
  Object.assign(manifest.p5, { status: 'passed', acceptanceOwner: 'unit-test-owner', acceptedAt: '2026-09-18T00:00:00Z' });
  for (const check of Object.values(manifest.p5.checks)) Object.assign(check, { status: 'passed', evidence: [{ path: 'unit-test-only', sha256: 'e'.repeat(64) }] });
  const pair = generateKeyPairSync('ed25519');
  const signManifest = value => { value.signature = { algorithm: 'Ed25519', keyId: 'unit-test-key', value: sign(null, canonicalManifestPayload(value), pair.privateKey).toString('base64') }; };
  signManifest(manifest);
  const keys = { keys: [{ keyId: 'unit-test-key', algorithm: 'Ed25519', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }), revoked: false }] };
  const runtime = { candidateId: manifest.candidateId, components: structuredClone(manifest.components) };
  const options = { now: Date.parse('2026-09-18T12:00:00Z'), tenantId: 'tenant-unit-test' };
  assert.equal(verifyReleaseGate(manifest, keys, runtime, options).status, 'authorized');
  assert.throws(() => verifyReleaseGate(manifest, keys, runtime, { ...options, tenantId: 'other-tenant' }), /tenant/);
  assert.throws(() => verifyReleaseGate(manifest, keys, runtime, { ...options, now: Date.parse('2026-09-20T00:00:00Z') }), /lease/);
  assert.throws(() => verifyReleaseGate(manifest, keys, { ...runtime, candidateId: 'other' }, options), /candidate/);
  const changed = structuredClone(runtime);
  changed.components.sales.lockSha256 = 'f'.repeat(64);
  assert.throws(() => verifyReleaseGate(manifest, keys, changed, options), /artifact/);
  const revoked = structuredClone(keys);
  revoked.keys[0].revoked = true;
  assert.throws(() => verifyReleaseGate(manifest, revoked, runtime, options), /revoked/);
  const missing = structuredClone(manifest);
  missing.p5.checks.backupRecovery.status = 'not_run';
  signManifest(missing);
  assert.throws(() => verifyReleaseGate(missing, keys, runtime, options), /backupRecovery/);
});
