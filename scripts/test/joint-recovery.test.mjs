// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalManifestPayload } from '../industry-delivery-release-gate.mjs';
import { verifyJointRecovery } from '../joint-recovery.mjs';

const at = '2026-09-23T04:00:00.000Z';
const stopped = '2026-09-23T03:00:00.000Z';
const earliest = '2026-09-23T01:00:00.000Z';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mn-recovery-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const trusted = { keys: [{ keyId: 'synthetic', algorithm: 'Ed25519', revoked: false, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) }] };
  async function artifact(path, value) {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    await writeFile(join(root, path), bytes);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const artifacts = {};
  for (const name of ['release', 'engineLock', 'pluginLock', 'actionCatalog', 'migrations', 'templates', 'fonts', 'trustedRoots', 'writerIsolation', 'keyRecovery'])
    artifacts[name] = await artifact(name + '.json', { synthetic: true });
  for (const name of ['revocations', 'tombstones', 'identityFreezes'])
    artifacts[name] = await artifact(name + '.json', { schemaVersion: 1, checkpointAt: stopped });
  artifacts.effects = await artifact('effects.json', { schemaVersion: 1, coverageStart: earliest, coverageEnd: stopped, includesActiveAtStart: true, operations: [
    { operationKey: 'finished-after-backup', dispatchedAt: '2026-09-23T02:15:00.000Z', observedAt: '2026-09-23T02:16:00.000Z', state: 'succeeded' },
    { operationKey: 'started-before-backup', dispatchedAt: '2026-09-22T23:00:00.000Z', observedAt: '2026-09-23T01:05:00.000Z', state: 'succeeded' },
  ] });
  artifacts.restoredOperations = await artifact('restored-operations.json', { schemaVersion: 1, operations: [
    { operationKey: 'restored-running', dispatchedAt: '2026-09-23T00:55:00.000Z', state: 'running' },
  ] });
  const object = await artifact('quote.pdf', 'synthetic PDF bytes');
  const manifest = { schemaVersion: 1, kind: 'joint_recovery_checkpoint', checkpointId: 'synthetic-checkpoint', createdAt: at, expiresAt: '2026-09-24T04:00:00.000Z', sourceStoppedAt: stopped,
    databases: { agentOs: { restorePoint: earliest, artifact: await artifact('os.dump', 'synthetic OS dump') }, sales: { restorePoint: '2026-09-23T02:00:00.000Z', artifact: await artifact('sales.dump', 'synthetic Sales dump') } },
    objects: [{ source: { bucket: 'original', key: 'quote', versionId: null }, backup: { bucket: 'backup', key: 'quote-unique', versionId: 'backup-version' }, artifact: object }], artifacts };
  const seal = () => { manifest.signature = { algorithm: 'Ed25519', keyId: 'synthetic', value: sign(null, canonicalManifestPayload(manifest), privateKey).toString('base64') }; };
  seal();
  return { root, trusted, manifest, artifact, seal, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const verify = f => verifyJointRecovery(f.manifest, f.trusted, f.root, { now: Date.parse(at) });

void test('联合清单核对文件并覆盖最早恢复点至停写，已完成但回退丢失的效果仍须核对', async () => {
  const f = await fixture();
  try {
    const result = await verify(f);
    assert.equal(result.status, 'inventory_verified');
    assert.equal(result.productionAdmission, false);
    assert.equal(result.replayAllowed, false);
    assert.deepEqual(result.reconcileOperationKeys, ['finished-after-backup', 'restored-running', 'started-before-backup']);
    assert.equal(result.coverageStart, earliest);
    assert.equal(f.manifest.objects[0].source.versionId, null);
  } finally { await f.cleanup(); }
});

void test('签名漂移、吊销或过期信任不能通过', async () => {
  const f = await fixture();
  try {
    f.manifest.checkpointId = 'tampered';
    await assert.rejects(verify(f), /signature/);
    f.seal(); f.trusted.keys[0].revoked = true;
    await assert.rejects(verify(f), /trust/);
    f.trusted.keys[0].revoked = false;
    await assert.rejects(verifyJointRecovery(f.manifest, f.trusted, f.root, { now: Date.parse('2026-09-25T00:00:00Z') }), /expired/);
  } finally { await f.cleanup(); }
});

void test('对象篡改、缺少恢复证据、目录穿越和符号链接均拒绝', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'quote.pdf'), 'tampered');
    await assert.rejects(verify(f), /artifact/);
    f.manifest.objects[0].artifact = await f.artifact('quote.pdf', 'synthetic PDF bytes');
    delete f.manifest.artifacts.keyRecovery; f.seal();
    await assert.rejects(verify(f), /keyRecovery/);
    f.manifest.artifacts.keyRecovery = await f.artifact('keyRecovery.json', {});
    f.manifest.objects[0].artifact.path = '../outside'; f.seal();
    await assert.rejects(verify(f), /path/);
    await symlink(join(f.root, 'quote.pdf'), join(f.root, 'link.pdf'));
    f.manifest.objects[0].artifact.path = 'link.pdf'; f.seal();
    await assert.rejects(verify(f), /symlink/);
    f.manifest.objects[0].artifact.path = 'quote.pdf';
    f.manifest.objects.push({ ...f.manifest.objects[0], source: { key: 'quote', versionId: null, bucket: 'original' } }); f.seal();
    await assert.rejects(verify(f), /duplicate source object/);
  } finally { await f.cleanup(); }
});

void test('撤销检查点陈旧、效果证据窗口缺口和缺失在途范围均拒绝', async () => {
  const f = await fixture();
  try {
    f.manifest.artifacts.revocations = await f.artifact('revocations.json', { schemaVersion: 1, checkpointAt: earliest }); f.seal();
    await assert.rejects(verify(f), /revocations/);
    f.manifest.artifacts.revocations = await f.artifact('revocations.json', { schemaVersion: 1, checkpointAt: stopped });
    for (const extra of [{ coverageStart: '2026-09-23T02:00:00.000Z' }, { coverageEnd: '2026-09-23T02:59:00.000Z' }, { includesActiveAtStart: false }]) {
      f.manifest.artifacts.effects = await f.artifact('effects.json', { schemaVersion: 1, coverageStart: earliest, coverageEnd: stopped, includesActiveAtStart: true, operations: [], ...extra }); f.seal();
      await assert.rejects(verify(f), /coverage/);
    }
  } finally { await f.cleanup(); }
});
