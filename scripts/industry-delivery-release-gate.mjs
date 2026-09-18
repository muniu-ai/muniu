// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify, createPublicKey, createHash } from 'node:crypto';

const hash = /^[a-f0-9]{64}$/;
export function canonicalManifestPayload(manifest) {
  const { signature: _signature, ...payload } = manifest;
  const sort = value => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
    return value;
  };
  return Buffer.from(JSON.stringify(sort(payload)), 'utf8');
}

export function verifyReleaseSignature(manifest, publicKey) {
  assert.equal(manifest.signature?.algorithm, 'Ed25519', 'release signature algorithm must be Ed25519');
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  assert.equal(key.asymmetricKeyType, 'ed25519', 'trusted key must be Ed25519');
  assert.ok(typeof manifest.signature.value === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(manifest.signature.value), 'invalid release signature encoding');
  assert.ok(verify(null, canonicalManifestPayload(manifest), key, Buffer.from(manifest.signature.value, 'base64')), 'invalid release signature');
}

export function assertReleaseAdmission(manifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'release', 'template cannot authorize release');
  assert.ok(typeof manifest.releaseId === 'string' && manifest.releaseId);
  assert.ok(!Number.isNaN(Date.parse(manifest.createdAt)));
  for (const name of ['agentOs', 'sales']) {
    const component = manifest.components[name];
    assert.match(component.commit ?? '', /^[a-f0-9]{40}$/);
    assert.match(component.lockSha256 ?? '', hash);
    assert.match(component.imageDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  }
  assert.match(manifest.components.web.commit ?? '', /^[a-f0-9]{40}$/);
  assert.match(manifest.components.web.assetSha256 ?? '', hash);
  for (const field of ['engineLockSha256', 'pluginLockSha256', 'actionCatalogSha256', 'databaseMigrationSha256', 'modelConfigurationSha256']) assert.match(manifest.components[field] ?? '', hash);
  assert.equal(manifest.p5.status, 'passed', 'P5 must pass before real admission');
  assert.ok(typeof manifest.p5.acceptanceOwner === 'string' && manifest.p5.acceptanceOwner);
  assert.ok(!Number.isNaN(Date.parse(manifest.p5.acceptedAt)));
  for (const name of ['jointVersion', 'baselineChecks', 'apiWorkerFaultMatrix', 'realDependencies', 'backupRecovery', 'runtimeAdmissionGate', 'sourceAuthorization']) {
    const check = manifest.p5.checks[name];
    assert.equal(check?.status, 'passed', `P5 ${name} not passed`);
    assert.ok(Array.isArray(check.evidence) && check.evidence.length > 0, `P5 ${name} missing evidence`);
    for (const evidence of check.evidence) assert.ok(typeof evidence.path === 'string' && evidence.path && hash.test(evidence.sha256), `P5 ${name} invalid evidence`);
  }
  return { status: 'metadata_valid', admissionAuthorization: 'requires_evidence_review_and_runtime_enforcement', realCustomerOutcome: manifest.p7.status };
}

export function verifyReleaseGate(manifest, trustedKeys, runtime, { now = Date.now(), tenantId } = {}) {
  assertReleaseAdmission(manifest);
  assert.ok(Array.isArray(trustedKeys.keys), 'trusted key configuration missing');
  assert.ok(typeof manifest.signature?.keyId === 'string' && manifest.signature.keyId, 'release signing key identity missing');
  const matches = trustedKeys.keys.filter(key => key.keyId === manifest.signature?.keyId);
  assert.equal(matches.length, 1, 'release key must uniquely match trusted configuration');
  assert.equal(matches[0].algorithm, 'Ed25519');
  assert.equal(matches[0].revoked, false, 'release key revoked or unspecified');
  verifyReleaseSignature(manifest, matches[0].publicKeyPem);
  const start = Date.parse(manifest.validFrom);
  const end = Date.parse(manifest.expiresAt);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && start < end && now >= start && now < end, 'release lease expired or not yet valid');
  assert.ok(typeof runtime.candidateId === 'string' && runtime.candidateId && runtime.candidateId === manifest.candidateId, 'release candidate mismatch');
  assert.ok(runtime.components && typeof runtime.components === 'object', 'runtime hashes missing');
  assert.deepEqual(runtime.components, manifest.components, 'runtime artifact hashes mismatch');
  assert.equal(manifest.newRealTenantsEnabled, true, 'real tenant admission disabled');
  assert.equal(manifest.demoOnly, false, 'demo-only release cannot admit real tenant');
  assert.ok(typeof tenantId === 'string' && tenantId && !tenantId.startsWith('tenant-demo-'), 'real tenant identity required');
  assert.ok(Array.isArray(manifest.allowedRealTenantIds) && manifest.allowedRealTenantIds.includes(tenantId), 'tenant not authorized by release');
  return { status: 'authorized', releaseId: manifest.releaseId, candidateId: manifest.candidateId, tenantId, expiresAt: manifest.expiresAt,
    manifestSha256: createHash('sha256').update(canonicalManifestPayload(manifest)).digest('hex'),
    evidenceReview: 'trusted_signer_attestation_not_independent_measurement', realCustomerOutcome: manifest.p7.status };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv[2], 'usage: node scripts/industry-delivery-release-gate.mjs MANIFEST.json');
    const manifest = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
    assertReleaseAdmission(manifest);
    const option = name => { const index = process.argv.indexOf(name); assert.ok(index >= 0 && process.argv[index + 1], `${name} required`); return process.argv[index + 1]; };
    const trustedKeys = JSON.parse(await readFile(resolve(option('--trusted-keys')), 'utf8'));
    const runtime = JSON.parse(await readFile(resolve(option('--runtime')), 'utf8'));
    const result = verifyReleaseGate(manifest, trustedKeys, runtime, { tenantId: option('--tenant') });
    for (const check of Object.values(manifest.p5.checks)) for (const evidence of check.evidence) {
      const bytes = await readFile(resolve(resolve(process.argv[2], '..'), evidence.path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), evidence.sha256, 'release evidence hash mismatch');
    }
    console.log(JSON.stringify({ ...result, evidenceFileHashes: 'verified' }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', newRealTenantsEnabled: false, reason: error.message }));
    process.exitCode = 1;
  }
}
