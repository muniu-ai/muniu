// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

const PORTS = Object.freeze(['readSnapshot', 'listChanges', 'prepareAction', 'executeAction', 'getReceipt']);
const ACTIONS = Object.freeze(['create_followup_task', 'update_followup_date', 'issue_quote_package']);
const REQUIRED_METHODS = ['providerFor', 'context', 'readContent', 'request', 'businessState', 'mutateTarget', 'revoke', 'armRevocation', 'commit', 'expireLease', 'dispatch', 'executionState', 'reconcile', 'close'];
const copy = value => structuredClone(value);
const state = async fixture => copy(await fixture.businessState());

function supported(result, port) {
  assert.equal(result?.status, 'supported', port + ' must be implemented by the acceptance fixture');
  assert.ok(result.value && typeof result.value === 'object', port + ' must return a value');
  return result.value;
}
function text(value, label) {
  assert.equal(typeof value, 'string', label + ' must be a string');
  assert.ok(value.length > 0, label + ' must not be empty');
}
async function refused(work, label) {
  await assert.rejects(work, error => error instanceof Error && typeof error.code === 'string' && error.code.length > 0, label);
}
async function provider(fixture, role = 'writer') {
  const value = await fixture.providerFor(role);
  for (const name of PORTS) assert.equal(typeof value?.[name], 'function', 'Missing provider port: ' + name);
  return value;
}
function snapshot(value, expectedReference) {
  assert.deepEqual(value.objectRef, expectedReference, 'The original object reference must be preserved');
  text(value.protectedContentRef, 'protectedContentRef');
  text(value.observedAt, 'observedAt');
  assert.deepEqual(Object.keys(value).sort(), ['objectRef', 'observedAt', 'protectedContentRef'], 'Snapshots expose references, not plaintext fields');
}
function receipt(value, committed, request) {
  assert.equal(value.status, 'succeeded');
  assert.equal(value.operationKey, request.operationKey);
  assert.equal(value.tenantId, request.tenantId);
  assert.equal(value.workspaceId, request.workspaceId);
  assert.equal(value.actionDigest, committed.actionDigest);
  text(value.id, 'receipt.id'); text(value.provider, 'receipt.provider');
  assert.ok(Array.isArray(value.evidenceRefs) && value.evidenceRefs.length > 0, 'A successful receipt needs evidence');
  text(value.completedAt, 'receipt.completedAt');
}
async function prepare(fixture, operationKey, action = 'create_followup_task') {
  const ports = await provider(fixture), context = fixture.context('writer');
  const request = copy(await fixture.request(operationKey, action));
  assert.equal(request.action, action); assert.equal(request.operationKey, operationKey);
  for (const forbidden of ['authorityRevisionId', 'reservationId', 'executionApprovalRef', 'status']) {
    assert.equal(Object.hasOwn(request, forbidden), false, 'Preparation must precede execution admission: ' + forbidden);
  }
  const prepared = supported(await ports.prepareAction(request, context), 'prepareAction');
  assert.deepEqual(prepared.target, request.target);
  assert.equal(prepared.expiresAt, request.expiresAt);
  text(prepared.preparedInputRef, 'preparedInputRef');
  assert.match(prepared.inputDigest, /^[a-f0-9]{64}$/u);
  return { ports, context, request, prepared };
}
async function commit(fixture, prepared) {
  const committed = await fixture.commit(prepared.request, prepared.prepared);
  assert.equal(committed.intent.status, 'committed');
  assert.equal(committed.intent.operationKey, prepared.request.operationKey);
  assert.equal(committed.intent.preparedInputRef, prepared.prepared.preparedInputRef);
  assert.equal(committed.intent.inputDigest, prepared.prepared.inputDigest);
  text(committed.intent.authorityRevisionId, 'authorityRevisionId');
  text(committed.intent.reservationId, 'reservationId');
  assert.match(committed.actionDigest, /^[a-f0-9]{64}$/u);
  text(committed.context.executionLease?.jobId, 'executionLease.jobId');
  text(committed.context.executionLease?.workerId, 'executionLease.workerId');
  assert.ok(Number.isSafeInteger(committed.context.executionLease?.fencingToken) && committed.context.executionLease.fencingToken > 0);
  return committed;
}
async function unknownReceipt(ports, operationKey, context) {
  let result;
  try { result = await ports.getReceipt(operationKey, context); }
  catch (error) {
    assert.equal(error?.code, 'PROVIDER_RECEIPT_UNAVAILABLE', 'Missing history must remain explicitly unknown');
    return;
  }
  const value = supported(result, 'getReceipt');
  assert.equal(value.operationKey, operationKey);
  assert.ok(['pending', 'unknown'].includes(value.status), 'Missing receipt cannot prove execution or non-execution');
  assert.equal(Object.hasOwn(value, 'evidenceRefs'), false);
  assert.equal(Object.hasOwn(value, 'completedAt'), false);
}
async function changes(ports, cursor, context) {
  const page = supported(await ports.listChanges(cursor, context), 'listChanges');
  assert.ok(Array.isArray(page.changes) && page.changes.length <= 500);
  text(page.nextCursor, 'nextCursor');
  assert.ok(page.nextCursor.length <= 4096);
  const ids = new Set();
  for (const item of page.changes) {
    text(item.sourceEventId, 'sourceEventId'); text(item.sourceEventType, 'sourceEventType'); text(item.sourceOccurredAt, 'sourceOccurredAt');
    assert.equal(ids.has(item.sourceEventId), false, 'A page must not duplicate source events'); ids.add(item.sourceEventId);
    assert.equal(item.snapshot.objectRef.tenantId, context.tenantId);
    assert.equal(item.snapshot.objectRef.workspaceId, context.workspaceId);
    snapshot(item.snapshot, item.snapshot.objectRef);
  }
  return page;
}
const changeIdentity = page => page.changes.map(item => ({ sourceEventId: item.sourceEventId, sourceEventType: item.sourceEventType, sourceOccurredAt: item.sourceOccurredAt, reference: item.snapshot.objectRef }));

const cases = [
  { id: 'snapshot_versions', async run(fixture) {
    const ports = await provider(fixture), context = fixture.context('writer'), original = copy(fixture.reference);
    snapshot(supported(await ports.readSnapshot(original, context), 'readSnapshot'), original);
    const current = await fixture.mutateTarget(); assert.notDeepEqual(current, original);
    snapshot(supported(await ports.readSnapshot(original, context), 'readSnapshot'), original);
    snapshot(supported(await ports.readSnapshot(current, context), 'readSnapshot'), current);
    const before = await state(fixture);
    const corrupt = { ...original, digest: (original.digest[0] === '0' ? '1' : '0') + original.digest.slice(1) };
    await refused(() => ports.readSnapshot(corrupt, context), 'Digest mismatch must not silently select another version');
    const absent = 'streamVersion' in current ? { ...current, streamVersion: current.streamVersion + 1000000 } : { ...current, sourceVersion: current.sourceVersion + '-missing' };
    await refused(() => ports.readSnapshot(absent, context), 'An unknown source version must not become the current version');
    assert.deepEqual(await state(fixture), before);
  } },
  { id: 'field_tenant_isolation', async run(fixture) {
    const writer = await provider(fixture), limited = await provider(fixture, 'restricted'), other = await provider(fixture, 'otherTenant');
    const full = supported(await writer.readSnapshot(fixture.fieldReference, fixture.context('writer')), 'readSnapshot');
    const filtered = supported(await limited.readSnapshot(fixture.fieldReference, fixture.context('restricted')), 'readSnapshot');
    const fullContent = await fixture.readContent(full.protectedContentRef, fixture.context('writer'));
    const limitedContent = await fixture.readContent(filtered.protectedContentRef, fixture.context('restricted'));
    assert.ok(fixture.fieldExpectations?.publicFields?.length > 0 && fixture.fieldExpectations?.restrictedFields?.length > 0);
    for (const field of fixture.fieldExpectations.publicFields) {
      assert.ok(Object.hasOwn(fullContent.values, field)); assert.ok(Object.hasOwn(limitedContent.values, field));
      assert.deepEqual(limitedContent.values[field], fullContent.values[field]);
    }
    for (const field of fixture.fieldExpectations.restrictedFields) {
      assert.ok(Object.hasOwn(fullContent.values, field), 'The fixture must seed a protected field');
      assert.equal(Object.hasOwn(limitedContent.values, field), false, 'Restricted fields must be removed');
    }
    await refused(() => other.readSnapshot(fixture.reference, fixture.context('otherTenant')), 'Cross-tenant reads must fail');
    await refused(() => writer.readSnapshot(fixture.reference, { ...fixture.context('writer'), workspaceId: 'contract-other-workspace' }), 'Context strings cannot change scope');
    await refused(() => fixture.readContent(full.protectedContentRef, fixture.context('restricted')), 'A masked reader cannot reuse another principal content reference');
    await refused(() => fixture.readContent(full.protectedContentRef, fixture.context('otherTenant')), 'Protected references must be tenant-bound');
  } },
  { id: 'change_replay', async run(fixture) {
    const ports = await provider(fixture), context = fixture.context('writer'); let cursor = null, quiet = false;
    for (let pages = 0; pages < 64; pages++) {
      const page = await changes(ports, cursor, context); cursor = page.nextCursor;
      if (page.changes.length === 0) { quiet = true; break; }
    }
    assert.ok(quiet, 'Synthetic fixtures must reach the end of their change history');
    const current = await fixture.mutateTarget(), before = await state(fixture);
    const first = await changes(ports, cursor, context), repeated = await changes(ports, cursor, context);
    assert.ok(first.changes.some(item => isDeepStrictEqual(item.snapshot.objectRef, current)), 'The changed object must retain its original version');
    assert.deepEqual(changeIdentity(repeated), changeIdentity(first), 'Repeated cursors preserve source event identity');
    assert.equal((await changes(ports, first.nextCursor, context)).changes.length, 0);
    const limited = await provider(fixture, 'restricted');
    await refused(() => limited.listChanges(cursor, fixture.context('restricted')), 'A cursor cannot cross principal boundaries');
    await fixture.revoke('writer');
    await refused(() => ports.listChanges(cursor, context), 'A cursor cannot retain revoked authority');
    assert.deepEqual(await state(fixture), before);
  } },
  { id: 'prepare_immutable', async run(fixture) {
    const before = await state(fixture), item = await prepare(fixture, 'contract-prepare');
    assert.deepEqual(supported(await item.ports.prepareAction(item.request, item.context), 'prepareAction'), item.prepared);
    await refused(() => item.ports.prepareAction({ ...item.request, input: { ...item.request.input, title: item.request.input.title + '-changed' } }, item.context), 'An operation key must bind one input');
    assert.deepEqual(await state(fixture), before, 'Preparation cannot create business effects');
    await fixture.revoke('writer');
    await refused(() => item.ports.prepareAction(item.request, item.context), 'Preparation replay must recheck current authorization');
  } },
  { id: 'stale_preparation', async run(fixture) {
    const ports = await provider(fixture), request = await fixture.request('contract-stale');
    await fixture.mutateTarget(); const before = await state(fixture);
    await refused(() => ports.prepareAction(request, fixture.context('writer')), 'Preparation requires the current source version');
    assert.deepEqual(await state(fixture), before);
  } },
  ...ACTIONS.map(action => ({ id: 'execute_' + action, action, async run(fixture) {
    const before = await state(fixture), item = await prepare(fixture, 'contract-' + action, action);
    assert.deepEqual(await state(fixture), before, 'Each action preparation must be side-effect free');
    const committed = await commit(fixture, item);
    const first = supported(await item.ports.executeAction(committed.intent, committed.context), 'executeAction');
    receipt(first, committed, item.request);
    const after = await state(fixture); assert.notDeepEqual(after, before, 'The fixture must observe real business effects');
    const read = supported(await item.ports.getReceipt(item.request.operationKey, item.context), 'getReceipt');
    assert.deepEqual(read, first);
    assert.deepEqual(supported(await item.ports.getReceipt(item.request.operationKey, item.context), 'getReceipt'), first);
    assert.deepEqual(supported(await item.ports.executeAction(committed.intent, committed.context), 'executeAction'), first);
    assert.deepEqual(await state(fixture), after, 'Duplicate requests must return the saved receipt without repeating effects');
  } })),
  { id: 'forged_execution', async run(fixture) {
    const item = await prepare(fixture, 'contract-forged'), committed = await commit(fixture, item), before = await state(fixture);
    const { executionLease: _lease, ...withoutLease } = committed.context;
    await refused(() => item.ports.executeAction(committed.intent, withoutLease), 'A status string cannot replace a real execution lease');
    await refused(() => item.ports.executeAction({ ...committed.intent, id: committed.intent.id + '-forged' }, committed.context), 'A foreign action cannot use another job lease');
    assert.deepEqual(await state(fixture), before);
  } },
  { id: 'unknown_receipt', async run(fixture) {
    const ports = await provider(fixture), before = await state(fixture);
    await unknownReceipt(ports, 'contract-unseen-operation', fixture.context('writer'));
    assert.deepEqual(await state(fixture), before);
  } },
  { id: 'lost_response', async run(fixture) {
    const item = await prepare(fixture, 'contract-response-lost'), before = await state(fixture); let calls = 0;
    await fixture.dispatch(item.request, item.prepared, { execute: async (intent, context) => {
      calls++;
      await item.ports.executeAction(intent, context);
      throw Object.assign(new Error('Synthetic response loss after the provider persisted its result'), { code: 'SYNTHETIC_RESPONSE_LOST' });
    } });
    assert.equal(calls, 1, 'An unknown external result must never be replayed automatically');
    const pending = copy(await fixture.executionState(item.request.operationKey));
    assert.equal(pending.operationKey, item.request.operationKey); text(pending.reservationId, 'reservationId');
    assert.equal(pending.status, 'needs_reconciliation'); assert.equal(pending.reservationStatus, 'reserved');
    const after = await state(fixture); assert.notDeepEqual(after, before);
    const saved = supported(await item.ports.getReceipt(item.request.operationKey, item.context), 'getReceipt');
    assert.equal(saved.status, 'succeeded'); assert.equal(saved.operationKey, item.request.operationKey);
    await fixture.reconcile(item.request.operationKey);
    const settled = await fixture.executionState(item.request.operationKey);
    assert.equal(settled.status, 'settled'); assert.equal(settled.reservationStatus, 'settled');
    assert.equal(settled.operationKey, pending.operationKey); assert.equal(settled.reservationId, pending.reservationId);
    assert.equal(calls, 1); assert.deepEqual(await state(fixture), after);
  } },
  { id: 'revoked_authority', async run(fixture) {
    const item = await prepare(fixture, 'contract-revoked');
    const read = supported(await item.ports.readSnapshot(fixture.reference, item.context), 'readSnapshot');
    const committed = await commit(fixture, item), before = await state(fixture);
    await fixture.revoke('writer');
    await refused(() => fixture.readContent(read.protectedContentRef, item.context), 'Previously stored content must recheck current authorization');
    await refused(() => item.ports.executeAction(committed.intent, committed.context), 'A prior commitment cannot retain revoked authority');
    assert.deepEqual(await state(fixture), before);
  } },
  { id: 'snapshot_revocation', async run(fixture) {
    const ports = await provider(fixture), before = await state(fixture), hook = await fixture.armRevocation('snapshot');
    await refused(() => ports.readSnapshot(fixture.reference, fixture.context('writer')), 'Revocation during asynchronous storage must prevent returning content');
    assert.equal(hook.triggered(), true, 'The fixture must reach the real asynchronous boundary');
    assert.deepEqual(await state(fixture), before);
  } },
  { id: 'commit_revocation', async run(fixture) {
    const item = await prepare(fixture, 'contract-commit-revoke'), committed = await commit(fixture, item), before = await state(fixture);
    const hook = await fixture.armRevocation('commit');
    await refused(() => item.ports.executeAction(committed.intent, committed.context), 'Revocation at native commit must roll back the business effect and receipt');
    assert.equal(hook.triggered(), true); assert.deepEqual(await state(fixture), before);
  } },
  { id: 'stale_lease', async run(fixture) {
    const item = await prepare(fixture, 'contract-stale-lease'), committed = await commit(fixture, item), before = await state(fixture);
    await fixture.expireLease(committed);
    await refused(() => item.ports.executeAction(committed.intent, committed.context), 'A stale fencing token cannot commit business effects');
    assert.deepEqual(await state(fixture), before);
  } },
  { id: 'concurrent_version', async run(fixture) {
    const first = await prepare(fixture, 'contract-race-first'), second = await prepare(fixture, 'contract-race-second');
    assert.deepEqual(first.request.target, second.request.target);
    const a = await commit(fixture, first);
    const current = await fixture.mutateTarget(); assert.notDeepEqual(current, first.request.target);
    const after = await state(fixture);
    await refused(() => first.ports.executeAction(a.intent, a.context), 'A committed action cannot overwrite a concurrent business update');
    await refused(() => fixture.commit(second.request, second.prepared), 'Another prepared action cannot commit a stale original version');
    assert.deepEqual(await state(fixture), after);
    await unknownReceipt(first.ports, first.request.operationKey, first.context);
    await unknownReceipt(second.ports, second.request.operationKey, second.context);
  } },
];

export const PROVIDER_CONTRACT_CASES = Object.freeze(cases.map(({ id, action }) => Object.freeze({ id, ...(action ? { action } : {}) })));

/** Only synthetic, isolated fixture adapters are supported. Every case is mandatory. */
export async function runProviderContractCase(caseId, createFixture) {
  const entry = cases.find(item => item.id === caseId);
  assert.ok(entry, 'Unknown provider contract case: ' + caseId);
  assert.equal(typeof createFixture, 'function', 'A real fixture factory is required');
  const fixture = await createFixture({ caseId: entry.id, action: entry.action ?? 'create_followup_task' });
  try {
    for (const method of REQUIRED_METHODS) assert.equal(typeof fixture?.[method], 'function', 'Missing fixture method: ' + method);
    assert.ok(fixture.reference && fixture.fieldReference, 'Seeded object references are required');
    await entry.run(fixture);
    return { id: entry.id, status: 'passed' };
  } finally { if (typeof fixture?.close === 'function') await fixture.close(); }
}

export async function runProviderContractSuite(createFixture) {
  const results = [];
  for (const entry of PROVIDER_CONTRACT_CASES) results.push(await runProviderContractCase(entry.id, createFixture));
  return { suite: 'muniu-provider-contracts-v1', status: 'passed', cases: results };
}
