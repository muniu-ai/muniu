// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseSignature } from './industry-delivery-release-gate.mjs';

const hash = /^[a-f0-9]{64}$/;
const time = (value, label) => {
  assert.ok(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value), `${label}: invalid timestamp`);
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, `${label}: invalid timestamp`);
  return parsed;
};
const identity = (value, label) => assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\r\n\0]/.test(value), `${label}: invalid identity`);

async function verifyArtifact(root, artifact, label, json = false) {
  assert.ok(artifact && hash.test(artifact.sha256) && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0, `${label}: invalid artifact`);
  assert.ok(typeof artifact.path === 'string' && artifact.path && !artifact.path.includes('\\'), `${label}: invalid path`);
  const parts = artifact.path.split('/');
  assert.ok(parts.every(part => part && part !== '.' && part !== '..'), `${label}: invalid path`);
  let target = root;
  for (const part of parts) {
    target = join(target, part);
    const stat = await lstat(target);
    assert.ok(!stat.isSymbolicLink(), `${label}: symlink forbidden`);
  }
  assert.equal(await realpath(target), target, `${label}: artifact path changed`);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert.ok(stat.isFile() && stat.size === artifact.bytes, `${label}: artifact size mismatch`);
    assert.ok(!json || stat.size <= 16 * 1024 * 1024, `${label}: evidence JSON too large`);
    const digest = createHash('sha256');
    const chunks = [];
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      digest.update(chunk);
      if (json) chunks.push(chunk);
    }
    assert.equal(digest.digest('hex'), artifact.sha256, `${label}: artifact digest mismatch`);
    if (json) return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await file.close(); }
}

function operations(evidence, stopped, label) {
  assert.equal(evidence.schemaVersion, 1, `${label}: invalid schema`);
  assert.ok(Array.isArray(evidence.operations), `${label}: operations missing`);
  const seen = new Set();
  for (const operation of evidence.operations) {
    identity(operation.operationKey, label);
    assert.ok(!seen.has(operation.operationKey), `${label}: duplicate operation`);
    seen.add(operation.operationKey);
    assert.ok(['running', 'unknown', 'succeeded', 'failed', 'cancelled'].includes(operation.state), `${label}: invalid operation state`);
    const dispatched = time(operation.dispatchedAt, label);
    assert.ok(dispatched <= stopped, `${label}: effect after writer stop`);
    if (operation.observedAt !== undefined) {
      const observed = time(operation.observedAt, label);
      assert.ok(observed >= dispatched && observed <= stopped, `${label}: invalid observation time`);
    } else assert.ok(['running', 'unknown'].includes(operation.state), `${label}: terminal effect needs observation time`);
  }
  return evidence.operations;
}

export async function verifyJointRecovery(manifest, trustedKeys, directory, { now = Date.now() } = {}) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'joint_recovery_checkpoint');
  identity(manifest.checkpointId, 'checkpoint');
  const matches = trustedKeys?.keys?.filter(key => key.keyId === manifest.signature?.keyId);
  assert.ok(matches?.length === 1 && matches[0].algorithm === 'Ed25519' && matches[0].revoked === false, 'recovery signing trust missing or revoked');
  verifyReleaseSignature(manifest, matches[0].publicKeyPem);
  const created = time(manifest.createdAt, 'createdAt');
  const expires = time(manifest.expiresAt, 'expiresAt');
  assert.ok(created <= now && now < expires && created < expires, 'recovery checkpoint expired or not yet valid');
  const stopped = time(manifest.sourceStoppedAt, 'sourceStoppedAt');
  assert.ok(stopped <= created, 'writer stop after checkpoint creation');
  const root = await realpath(directory);
  const points = [];
  for (const name of ['agentOs', 'sales']) {
    const database = manifest.databases?.[name];
    const point = time(database?.restorePoint, name);
    assert.ok(point <= stopped, 'restore point after writer stop');
    points.push(point);
    await verifyArtifact(root, database.artifact, name);
  }
  const earliest = Math.min(...points);
  for (const name of ['release', 'engineLock', 'pluginLock', 'actionCatalog', 'migrations', 'templates', 'fonts', 'trustedRoots', 'writerIsolation', 'keyRecovery'])
    await verifyArtifact(root, manifest.artifacts?.[name], name);
  for (const name of ['revocations', 'tombstones', 'identityFreezes']) {
    const checkpoint = await verifyArtifact(root, manifest.artifacts?.[name], name, true);
    assert.equal(checkpoint.schemaVersion, 1, `${name}: invalid schema`);
    const checked = time(checkpoint.checkpointAt, name);
    assert.ok(checked >= stopped && checked <= created, `${name}: checkpoint does not cover writer stop`);
  }
  assert.ok(Array.isArray(manifest.objects), 'object inventory missing');
  const originals = new Set();
  const backups = new Map();
  for (const object of manifest.objects) {
    for (const name of ['source', 'backup']) {
      const reference = object[name];
      identity(reference?.bucket, `${name} bucket`);
      identity(reference?.key, `${name} key`);
      assert.ok(reference.versionId === null || typeof reference.versionId === 'string', `${name}: explicit versionId required`);
      if (reference.versionId !== null) identity(reference.versionId, `${name} versionId`);
    }
    const objectId = JSON.stringify([object.source.bucket, object.source.key, object.source.versionId]);
    assert.ok(!originals.has(objectId), 'duplicate source object');
    originals.add(objectId);
    await verifyArtifact(root, object.artifact, 'object');
    const backupId = JSON.stringify([object.backup.bucket, object.backup.key, object.backup.versionId]);
    const content = `${object.artifact.sha256}:${object.artifact.bytes}`;
    assert.ok(!backups.has(backupId) || backups.get(backupId) === content, 'backup reference maps to conflicting content');
    backups.set(backupId, content);
  }
  const effects = await verifyArtifact(root, manifest.artifacts?.effects, 'effects', true);
  assert.ok(time(effects.coverageStart, 'coverageStart') <= earliest && time(effects.coverageEnd, 'coverageEnd') >= stopped && time(effects.coverageEnd, 'coverageEnd') <= created && effects.includesActiveAtStart === true, 'effect coverage incomplete');
  const restored = await verifyArtifact(root, manifest.artifacts?.restoredOperations, 'restoredOperations', true);
  const reconcile = new Set();
  for (const operation of [...operations(effects, stopped, 'effects'), ...operations(restored, stopped, 'restoredOperations')])
    if (['running', 'unknown'].includes(operation.state) || time(operation.dispatchedAt, 'dispatch') >= earliest || time(operation.observedAt, 'observation') >= earliest)
      reconcile.add(operation.operationKey);
  return {
    status: 'inventory_verified', checkpointId: manifest.checkpointId,
    coverageStart: new Date(earliest).toISOString(), coverageEnd: manifest.sourceStoppedAt,
    reconcileOperationKeys: [...reconcile].sort(), replayAllowed: false, productionAdmission: false,
    requiredNextStep: 'isolated_database_object_key_restore_and_current_revocation_reconciliation',
    evidenceBoundary: 'trusted_signer_attestation_and_local_file_integrity_not_live_recovery',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 5, 'usage: joint-recovery.mjs MANIFEST TRUSTED_KEYS ARTIFACT_DIRECTORY');
    const result = await verifyJointRecovery(JSON.parse(await readFile(process.argv[2], 'utf8')), JSON.parse(await readFile(process.argv[3], 'utf8')), process.argv[4]);
    console.log(JSON.stringify(result, null, 2));
  } catch {
    console.error(JSON.stringify({ status: 'blocked', productionAdmission: false, replayAllowed: false, reason: '联合恢复清单或证据校验失败' }));
    process.exitCode = 1;
  }
}
