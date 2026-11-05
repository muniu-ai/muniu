// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, cp, symlink, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROVIDER_CONTRACT_CASES, runProviderContractCase, runProviderContractSuite } from '../lib/provider-contract-suite.mjs';
import { exportProviderContracts, verifyProviderContractBundle } from '../export-provider-contracts.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const clone = value => structuredClone(value);
const execute = promisify(execFile);

// This model checks the suite itself. It is never evidence that a product provider passed.
function modelFixture({ defect, onClose } = {}) {
  let version = 1, revoked = false, leaseExpired = false, armed, fired = false;
  let effects = [], execution, calls = 0;
  const receipts = new Map(), preparations = new Map(), contents = new Map(), cursors = new Map(), committedIds = new Set();
  const reference = (n = version, objectType = 'customer') => ({ tenantId: 'fixture', workspaceId: 'workspace', objectType, objectId: objectType, streamVersion: n, digest: hash([objectType, n]) });
  const context = (role = 'writer') => ({ tenantId: role === 'otherTenant' ? 'other' : 'fixture', workspaceId: 'workspace', principalId: role, signal: new AbortController().signal });
  const guard = ctx => {
    if (ctx.tenantId !== 'fixture' || ctx.workspaceId !== 'workspace') throw failure('PROVIDER_CONTEXT_MISMATCH');
    if (revoked && ctx.principalId === 'writer') throw failure('OBJECT_ACCESS_DENIED');
  };
  const fire = boundary => { if (armed === boundary) { fired = true; revoked = true; } };
  const state = () => ({ version, effects: clone(effects) });
  const provider = {
    id: 'model',
    async readSnapshot(ref, ctx) {
      guard(ctx);
      if (ref.tenantId !== ctx.tenantId || ref.workspaceId !== ctx.workspaceId) throw failure('OBJECT_SCOPE_MISMATCH');
      if (ref.streamVersion > version || ref.digest !== reference(ref.streamVersion, ref.objectType).digest) throw failure('SOURCE_VERSION_CONFLICT');
      fire('snapshot'); if (defect !== 'async-revocation') guard(ctx);
      const objectRef = defect === 'historical-version' ? reference(version, ref.objectType) : ref;
      const id = 'content-' + hash([objectRef, ctx.principalId]);
      contents.set(id, { owner: ctx.principalId, objectRef });
      return { status: 'supported', value: { objectRef, protectedContentRef: id, observedAt: '2026-11-05T00:00:00.000Z' } };
    },
    async listChanges(cursor, ctx) {
      guard(ctx);
      const old = cursor === null ? { offset: 0, owner: ctx.principalId } : cursors.get(cursor);
      if (!old || old.owner !== ctx.principalId) throw failure('PROVIDER_CURSOR_INVALID');
      const changes = [];
      for (let n = old.offset + 1; n <= version; n++) changes.push({ sourceEventId: 'event-' + n + (defect === 'event-id' ? '-' + calls++ : ''), sourceEventType: 'customer.changed', sourceOccurredAt: '2026-11-05T00:00:00.000Z', snapshot: (await provider.readSnapshot(reference(n), ctx)).value });
      const nextCursor = 'cursor-' + cursors.size; cursors.set(nextCursor, { offset: version, owner: ctx.principalId });
      return { status: 'supported', value: { changes, nextCursor } };
    },
    async prepareAction(request, ctx) {
      guard(ctx);
      if (request.target.streamVersion !== version) throw failure('SOURCE_VERSION_CONFLICT');
      const old = preparations.get(request.operationKey);
      if (old && old.inputDigest !== hash(request)) throw failure('IDEMPOTENCY_KEY_REUSED');
      const result = old ?? { preparedInputRef: 'prepared-' + request.operationKey, inputDigest: hash(request), target: request.target, expiresAt: request.expiresAt };
      preparations.set(request.operationKey, result);
      if (defect === 'prepare-effect') effects.push({ action: request.action });
      return { status: 'supported', value: clone(result) };
    },
    async executeAction(intent, ctx) {
      guard(ctx);
      if (!committedIds.has(intent.id) || !ctx.executionLease) throw failure('PROVIDER_EXECUTION_NOT_COMMITTED');
      if (leaseExpired) throw failure('STALE_FENCING_TOKEN');
      fire('commit'); if (defect !== 'commit-revocation') guard(ctx);
      const old = receipts.get(intent.operationKey);
      if (old && defect !== 'duplicate-effect') return { status: 'supported', value: clone(old) };
      if (!old && intent.target.streamVersion !== version && defect !== 'stale-execution') throw failure('SOURCE_VERSION_CONFLICT');
      effects.push({ operationKey: intent.operationKey, action: intent.action }); version++;
      const receipt = { tenantId: 'fixture', workspaceId: 'workspace', id: 'receipt-' + intent.operationKey, operationKey: intent.operationKey, actionDigest: hash(intent), provider: 'model', receivedAt: '2026-11-05T00:00:00.000Z', status: 'succeeded', completedAt: '2026-11-05T00:00:00.000Z', evidenceRefs: [{ id: 'evidence' }] };
      receipts.set(intent.operationKey, receipt);
      return { status: 'supported', value: clone(receipt) };
    },
    async getReceipt(key, ctx) {
      guard(ctx);
      const receipt = receipts.get(key);
      if (!receipt) {
        if (defect === 'false-negative') return { status: 'supported', value: { operationKey: key, status: 'not_executed', reasonCode: 'MISSING' } };
        throw failure('PROVIDER_RECEIPT_UNAVAILABLE');
      }
      return { status: 'supported', value: clone(receipt) };
    },
  };
  const commit = async (request, prepared) => {
    if (request.target.streamVersion !== version && defect !== 'stale-commit') throw failure('SOURCE_VERSION_CONFLICT');
    const intent = { ...request, ...prepared, id: 'committed-' + request.operationKey, status: 'committed', authorityRevisionId: 'authority', reservationId: 'reservation-' + request.operationKey };
    committedIds.add(intent.id);
    return { intent, actionDigest: hash(intent), context: { ...context(), authorityRevisionId: 'authority', executionLease: { jobId: 'job-' + request.operationKey, workerId: 'worker', fencingToken: 1 } } };
  };
  return {
    providerFor: () => provider, context, reference: reference(), fieldReference: reference(1, 'quote_version'),
    fieldExpectations: { publicFields: ['currency'], restrictedFields: ['totalMinor'] },
    async readContent(id, ctx) {
      guard(ctx); const content = contents.get(id);
      if (!content || content.owner !== ctx.principalId) throw failure('PROVIDER_CONTENT_NOT_FOUND');
      return { reference: content.objectRef, values: { currency: 'CNY', ...(ctx.principalId === 'restricted' && defect !== 'field-leak' ? {} : { totalMinor: 30000 }) } };
    },
    request(operationKey, action = 'create_followup_task') {
      return { tenantId: 'fixture', workspaceId: 'workspace', operationKey, providerBindingVersion: 1, target: reference(version, action === 'issue_quote_package' ? 'quote_version' : 'customer'), expiresAt: '2026-12-01T00:00:00.000Z', action,
        ...(action === 'issue_quote_package' ? { businessApprovalRef: 'approval' } : {}),
        input: action === 'create_followup_task' ? { title: '合成跟进', dueAt: '2026-11-06T00:00:00.000Z' } : action === 'update_followup_date' ? { nextFollowupAt: '2026-11-07T00:00:00.000Z' } : { format: 'docx' } };
    },
    businessState: async () => state(),
    mutateTarget: async () => { version++; return reference(); },
    revoke: async () => { revoked = true; },
    armRevocation: async boundary => { armed = boundary; return { triggered: () => fired }; },
    commit, expireLease: async () => { leaseExpired = true; },
    async dispatch(request, prepared, { execute }) {
      const committed = await commit(request, prepared);
      execution = { operationKey: request.operationKey, reservationId: committed.intent.reservationId, status: 'committed', reservationStatus: 'reserved' };
      try { await execute(committed.intent, committed.context); execution.status = 'settled'; execution.reservationStatus = 'settled'; }
      catch { execution.status = 'needs_reconciliation'; }
      if (defect === 'replay-unknown') await execute(committed.intent, committed.context).catch(() => {});
    },
    executionState: async () => clone(execution),
    async reconcile() { execution.status = 'settled'; execution.reservationStatus = 'settled'; },
    close: async () => onClose?.(),
  };
}

test('套件自测按场景串行创建并释放夹具，不能替代真实提供方验收', async () => {
  let live = 0, closed = 0;
  const result = await runProviderContractSuite(async () => {
    assert.equal(live, 0); live++;
    return modelFixture({ onClose: () => { live--; closed++; } });
  });
  assert.equal(result.status, 'passed'); assert.equal(result.cases.length, PROVIDER_CONTRACT_CASES.length);
  assert.equal(closed, PROVIDER_CONTRACT_CASES.length); assert.equal(live, 0);
});

for (const [caseId, defect] of [
  ['snapshot_versions', 'historical-version'], ['field_tenant_isolation', 'field-leak'], ['change_replay', 'event-id'],
  ['prepare_immutable', 'prepare-effect'], ['execute_create_followup_task', 'duplicate-effect'], ['unknown_receipt', 'false-negative'],
  ['lost_response', 'replay-unknown'], ['snapshot_revocation', 'async-revocation'], ['commit_revocation', 'commit-revocation'],
  ['concurrent_version', 'stale-execution'], ['concurrent_version', 'stale-commit'],
]) test('套件可识别违约实现：' + defect, async () => {
  let closed = false;
  await assert.rejects(runProviderContractCase(caseId, async () => modelFixture({ defect, onClose: () => { closed = true; } })));
  assert.equal(closed, true);
});

test('缺少真实夹具接口或未知场景不能跳过后返回通过', async () => {
  await assert.rejects(runProviderContractSuite(async () => ({})));
  await assert.rejects(runProviderContractCase('missing-case', async () => modelFixture()));
});

test('导出包来自权威 schema 和 SDK，运行时不依赖木牛私有包，清单可检测篡改', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mn-provider-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = join(root, 'bundle');
  const manifest = await exportProviderContracts({ outputDir, allowDirty: true });
  assert.match(manifest.source.gitCommit, /^[a-f0-9]{40}$/u);
  assert.equal(typeof manifest.source.workingTreeDirty, 'boolean');
  assert.ok(Object.keys(manifest.source.files).includes('packages/contracts/src/enterprise-schema.ts'));
  const verified = await verifyProviderContractBundle(outputDir);
  assert.deepEqual(verified, manifest);
  const standaloneVerifier = await readFile(join(outputDir, 'verify.mjs'), 'utf8');
  assert.doesNotMatch(standaloneVerifier, /@mn\/|esbuild|export-provider-contracts\.mjs/u);
  assert.ok(manifest.files['verify.mjs']);
  const packageJson = JSON.parse(await readFile(join(outputDir, 'package.json'), 'utf8'));
  assert.equal(packageJson.exports['./verify'], './verify.mjs');
  const received = join(root, 'sales-received-bundle');
  await cp(outputDir, received, { recursive: true });
  const checkReceived = () => execute(process.execPath, [join(received, 'verify.mjs')], { cwd: root, env: { NODE_OPTIONS: '--max-old-space-size=64' }, maxBuffer: 8192 });
  const report = JSON.parse((await checkReceived()).stdout);
  assert.equal(report.status, 'integrity-verified'); assert.equal(report.source, manifest.source.gitCommit);
  assert.equal(report.workingTreeDirty, manifest.source.workingTreeDirty);
  const originalManifest = await readFile(join(received, 'manifest.json'));
  assert.equal(report.manifestSha256, createHash('sha256').update(originalManifest).digest('hex'));
  const standaloneModule = await import(pathToFileURL(join(received, 'verify.mjs')).href);
  assert.deepEqual(await standaloneModule.verifyProviderContractBundle(received), manifest);
  const escaped = structuredClone(manifest); escaped.source.files['../outside-config.json'] = 'a'.repeat(64);
  await writeFile(join(received, 'manifest.json'), JSON.stringify(escaped));
  await assert.rejects(checkReceived(), error => /path/u.test(error.stderr));
  await writeFile(join(received, 'manifest.json'), originalManifest);
  await writeFile(join(received, 'unexpected-config.json'), '{}');
  await assert.rejects(checkReceived(), error => /inventory|Unexpected files/u.test(error.stderr));
  await unlink(join(received, 'unexpected-config.json'));
  const schemaBytes = await readFile(join(received, 'enterprise-schema.json'));
  await writeFile(join(root, 'outside-schema.json'), schemaBytes);
  await unlink(join(received, 'enterprise-schema.json'));
  await symlink(join(root, 'outside-schema.json'), join(received, 'enterprise-schema.json'));
  await assert.rejects(checkReceived(), error => /integrity|regular file/u.test(error.stderr));
  await unlink(join(received, 'enterprise-schema.json'));
  await writeFile(join(received, 'enterprise-schema.json'), schemaBytes);
  await writeFile(join(root, 'outside-manifest.json'), originalManifest);
  await unlink(join(received, 'manifest.json'));
  await symlink(join(root, 'outside-manifest.json'), join(received, 'manifest.json'));
  await assert.rejects(checkReceived(), error => /integrity|regular file/u.test(error.stderr));
  await unlink(join(received, 'manifest.json'));
  await writeFile(join(received, 'manifest.json'), originalManifest);
  await unlink(join(received, 'verify.mjs'));
  await symlink(join(outputDir, 'verify.mjs'), join(received, 'verify.mjs'));
  await assert.rejects(checkReceived(), error => /integrity|regular file/u.test(error.stderr));
  await unlink(join(received, 'verify.mjs'));
  await writeFile(join(received, 'verify.mjs'), standaloneVerifier + '\n// changed after delivery\n');
  await assert.rejects(checkReceived(), error => /integrity/u.test(error.stderr));
  const document = JSON.parse(await readFile(join(outputDir, 'enterprise-schema.json'), 'utf8'));
  assert.ok(document.components.schemas.EnterpriseProviderActionPreparation);
  const declaration = await readFile(join(outputDir, 'provider-types.d.ts'), 'utf8');
  assert.doesNotMatch(declaration, /@mn\//u); assert.match(declaration, /executionLease/u);
  const portable = await import(pathToFileURL(join(outputDir, 'provider-contract-suite.mjs')).href);
  assert.deepEqual(portable.PROVIDER_CONTRACT_CASES.map(x => x.id), PROVIDER_CONTRACT_CASES.map(x => x.id));
  const validator = await import(pathToFileURL(join(outputDir, 'validate.mjs')).href);
  const request = modelFixture().request('export-check');
  assert.deepEqual(validator.parseEnterpriseContract('EnterpriseProviderActionPreparation', request), request);
  assert.throws(() => validator.parseEnterpriseContract('EnterpriseProviderActionPreparation', { ...request, reservationId: 'premature' }));
  await assert.rejects(exportProviderContracts({ outputDir, allowDirty: true }), /exist/u);
  await writeFile(join(outputDir, 'enterprise-schema.json'), '{}\n');
  await assert.rejects(verifyProviderContractBundle(outputDir), /integrity/u);
});
