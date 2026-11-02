// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { EnterpriseIdentityService, EnterpriseQuotaService, assertModelQuota, type EnterpriseRecord, type EnterpriseRepository } from '../src/index.js';
async function fixture() {
  const events: EnterpriseRecord[] = [];
  const repository: EnterpriseRepository = { async read() { return structuredClone(events); }, async transact(_tenant, work) {
    const result = work(structuredClone(events)); events.push(...structuredClone(result.events)); return result.value;
  } };
  let clock = '2026-11-02T01:00:00.000Z'; const now = () => clock;
  const identity = new EnterpriseIdentityService({ repository, now });
  await identity.provision({ tenantId: 'tenant', name: '合成企业', issuer: 'https://issuer.test/', maxMembers: 20,
    administrator: { id: 'admin', subject: 'admin', displayName: '管理员' } });
  const actor = { tenantId: 'tenant', principalId: 'admin', sessionEpoch: 1 };
  const workspace = await identity.createWorkspace(actor, 'workspace', { name: '主体', mode: 'builtin' });
  const service = new EnterpriseQuotaService({ repository, now });
  const limits = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20 };
  const budget = { tokens: 10000, costMinorUnits: '500', evaluationDailyTokens: 1000, evaluationDailyCostMinorUnits: '50',
    singleEvaluationTokens: 200, singleEvaluationCostMinorUnits: '10', currency: 'CNY' as const };
  const input = { ...budget, ...limits, validFrom: '2026-11-02T00:00:00.000Z', expiresAt: '2026-11-03T00:00:00.000Z' };
  return { events, repository, service, actor, workspace, input, now, advance(value: string) { clock = value; } };
}
test('未开通或未分配额度时禁止模型工作，管理员不能自行提高平台上限', async () => {
  const f = await fixture();
  const request = { tokens: 100, costMinorUnits: '1', expiresAt: '2026-11-02T02:00:00.000Z', purpose: 'goal' as const };
  assert.throws(() => assertModelQuota(f.events, f.actor, f.workspace.id, request, f.now()), { code: 'MODEL_QUOTA_UNCONFIGURED' });
  await f.service.provision('tenant', 'provision', 0, f.input);
  assert.throws(() => assertModelQuota(f.events, f.actor, f.workspace.id, request, f.now()), { code: 'MODEL_QUOTA_UNCONFIGURED' });
  await assert.rejects(f.service.configure(f.actor, 'too-high', f.workspace.id, 0, { ...f.input, tokens: 10001 }), { code: 'PLATFORM_QUOTA_EXCEEDED' });
  const configured = await f.service.configure(f.actor, 'configure', f.workspace.id, 0, f.input);
  assert.deepEqual(await f.service.configure(f.actor, 'configure', f.workspace.id, 0, f.input), configured);
  assert.equal(assertModelQuota(f.events, f.actor, f.workspace.id, request, f.now()).streamVersion, 1);
  await assert.rejects(f.service.configure(f.actor, 'stale', f.workspace.id, 0, f.input), { code: 'STREAM_VERSION_CONFLICT' });
  assert.throws(() => assertModelQuota(f.events, f.actor, f.workspace.id, { ...request, tokens: 10001 }, f.now()), { code: 'MODEL_QUOTA_EXCEEDED' });
  assert.throws(() => assertModelQuota(f.events, f.actor, f.workspace.id, { ...request, expiresAt: '2026-11-04T00:00:00.000Z' }, f.now()), { code: 'MODEL_QUOTA_EXPIRED' });
});
test('入站评估独立限额，过期、撤销成员和平台降额后立即拒绝', async () => {
  const f = await fixture();
  await f.service.provision('tenant', 'provision', 0, f.input);
  await f.service.configure(f.actor, 'configure', f.workspace.id, 0, f.input);
  const request = { tokens: 201, costMinorUnits: '1', expiresAt: '2026-11-02T02:00:00.000Z', purpose: 'evaluation' as const };
  assert.throws(() => assertModelQuota(f.events, f.actor, f.workspace.id, request, f.now()), { code: 'MODEL_QUOTA_EXCEEDED' });
  await f.service.provision('tenant', 'lower', 1, { ...f.input, tokens: 100 });
  assert.throws(() => assertModelQuota(f.events, f.actor, f.workspace.id, { ...request, tokens: 10 }, f.now()), { code: 'PLATFORM_QUOTA_EXCEEDED' });
  await f.service.configure(f.actor, 'lower-workspace', f.workspace.id, 1, { ...f.input, tokens: 100 });
  assert.equal(assertModelQuota(f.events, f.actor, f.workspace.id, { ...request, tokens: 10 }, f.now()).streamVersion, 2);
  assert.throws(() => assertModelQuota(f.events, { ...f.actor, sessionEpoch: 0 }, f.workspace.id, { ...request, tokens: 10 }, f.now()), { code: 'SESSION_REVOKED' });
  f.advance('2026-11-03T00:00:00.000Z');
  assert.throws(() => assertModelQuota(f.events, f.actor, f.workspace.id, { ...request, tokens: 10 }, f.now()), { code: 'MODEL_QUOTA_EXPIRED' });
});
test('提高调度上限必须提供容量验证摘要，金额与整数限制不能被异常输入绕过', async () => {
  const f = await fixture();
  await assert.rejects(f.service.provision('tenant', 'raised', 0, { ...f.input, parallelNodes: 7 }), { code: 'CAPACITY_EVIDENCE_REQUIRED' });
  await assert.rejects(f.service.provision('tenant', 'invalid', 0, { ...f.input, costMinorUnits: '-1' }), { code: 'INVALID_QUOTA' });
  await f.service.provision('tenant', 'raised-verified', 0, { ...f.input, parallelNodes: 7 }, 'sha256:' + 'a'.repeat(64));
  await assert.rejects(f.service.configure(f.actor, 'invalid', f.workspace.id, 0, { ...f.input, tokens: Number.NaN }), { code: 'INVALID_QUOTA' });
});
