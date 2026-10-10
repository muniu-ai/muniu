// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentOsKernel, appendKernelEvent, sha256 } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage, DEFAULT_PROJECTION_JOURNAL_NAMESPACES } from '@mn/storage';
import { getTeamTemplate, TEAM_DEFAULT_LIMITS } from '@mn/task-orchestration';
import { createTeamSkillVersion, getTeamSkill, commandTeamSkill, registerTeamSkillEvaluation } from '../src/team-skills.js';
import { bindTeamSkillPlan, readTeamSkillRole, validateTeamSkillContextSource } from '../src/team-skill-context.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mn-team-skills-'));
  const cas = new FileCas({ rootDir: join(root, 'cas') }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 15));
  const store = new SqliteStorage({ databaseFile: join(root, 'state.sqlite'), hmacKey: Buffer.alloc(32, 16), projectionJournal: { cas, keyProvider, namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES } });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const kernel = new AgentOsKernel(store); await kernel.bootstrapLocal('bootstrap');
  const workspace = await kernel.createWorkspace('local', 'local-owner', 'workspace', { name: '技能测试', viewMode: 'business', pluginIds: ['opc'] });
  const now = '2026-10-10T00:00:00.000Z';
  const template = getTeamTemplate('research-summary'), scope = { tenantId: 'local', workspaceId: workspace.id, principalId: 'local-owner' };
  const specs = [{ key: 'report', title: '研究报告', required: true, criteria: [{ id: 'source', description: '有来源证据' }] }];
  const raw: any = { id: 'plan', goalId: 'goal', threadId: 'thread', revision: 1, inputVersion: 1, criteriaVersion: sha256(specs), budget: { maxTokens: 10000, maxCostMinorUnits: '100', currency: 'CNY', maxDurationMs: 100000 }, resourceRefs: [], deliverables: specs, createdAt: now,
    kind: 'team-v1', template: { id: template.id, version: '1', digest: template.digest }, pluginId: 'opc', domainInputDigest: 'd'.repeat(64), threadStreamVersion: 1, limits: TEAM_DEFAULT_LIMITS,
    nodes: template.nodes.map(slot => ({ ...slot, inputs: [{ key: 'goal', kind: 'goal' }], outputs: [{ key: 'result', kind: slot.id === 'review' ? 'review' : 'artifact', description: '输出' }], ...(slot.kind === 'agent' ? { executor: { pluginId: 'opc', agentDefinitionId: 'opc.business-assistant', runnerId: 'builtin', toolIds: [], autoAllowedEffects: ['local_read'], dataScopes: [], modelBindingId: 'private-model-DO-NOT-COPY' }, capabilityRef: { id: 'cap', version: '1', digest: 'a'.repeat(64) }, budget: {} } : { mappings: [] }) })), deliverableBindings: [{ deliverableKey: 'report', nodeId: 'handoff', outputKey: 'result' }] };
  const plan = { ...raw, digest: sha256(raw) };
  const setBody = { goalId: 'goal', planRevisionId: plan.id, criteriaVersion: plan.criteriaVersion, items: [{ key: 'report', digest: 'b'.repeat(64), criteriaVersion: plan.criteriaVersion, resourceRef: { namespace: 'asset', resourceId: 'output', streamVersion: 1, digest: 'b'.repeat(64) }, preview: 'private-output-DO-NOT-COPY', sourceRefs: [], checks: [] }] };
  const set = { ...setBody, id: 'delivery', digest: sha256(setBody), createdAt: now };
  const goal: any = { ...scope, id: 'goal', threadId: 'thread', status: 'accepted', streamVersion: 5, planRevisionId: plan.id, deliverySetId: set.id, acceptanceId: 'acceptance', criteriaVersion: plan.criteriaVersion, resourceRefs: [], deliverables: specs, objective: 'private-objective-DO-NOT-COPY' };
  const options: any = { ...scope, store, cas, keyProvider, protectedJournal: true, now: () => now, id: (kind: string) => `${kind}-${randomUUID()}`, ports: { assertDelivery() {}, validateContextSource: () => false } };
  const alter = async (namespace: string, id: string, value: any) => store.transact('local', tx => { tx.putProjection(namespace, id, value); appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'fixture', aggregateId: randomUUID(), expectedStreamVersion: 0, type: 'fixture', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} }); });
  await alter('goal.state', goal.id, goal); await alter('goal.plan', plan.id, plan); await alter('goal.deliverySet', set.id, set);
  await alter('goal.deliveryAcceptance', 'acceptance', { id: 'acceptance', goalId: goal.id, deliverySetId: set.id, criteriaVersion: plan.criteriaVersion, principalId: 'local-owner', acceptedAt: now, items: [{ key: 'report', digest: 'b'.repeat(64), reviewedCriterionIds: ['source'] }] });
  const input = { skillId: 'skill', expectedStreamVersion: 0, source: { goalId: goal.id, planRevisionId: plan.id, deliverySetId: set.id, deliveryDigest: set.digest }, title: '研究流程', description: '检查来源和反证', roles: [{ nodeId: 'review', instructions: '核对反证；文字不授予工具权限', sourceRefs: [] }] };
  const create = () => createTeamSkillVersion(options, input, 'create');
  return { store, options, input, create, alter, goal, plan, set };
}
test('从接收目标保存不可变声明式技能，不复制正文、执行绑定与权限凭证', async t => {
  const f = await fixture(t), result = await f.create();
  assert.deepEqual(await f.create(), result);
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-COPY/u);
  assert.equal(result.version.version, '1'); assert.equal(result.validation, 'unmeasured');
  assert.equal(result.allowedActions.trial, true); assert.equal(result.allowedActions.enable, false);
  assert.equal(result.activation.recommendationEnabled, false);
  const changed = await createTeamSkillVersion(f.options, { ...f.input, expectedStreamVersion: 1, title: '改进流程' }, 'version-2');
  assert.equal(changed.version.version, '2');
  assert.deepEqual((await getTeamSkill(f.options, 'skill', '1')).version, result.version);
  const events = await f.store.readEvents('local', 0, 500);
  assert.doesNotMatch(JSON.stringify(events), /核对反证/u);
  await f.store.rebuildJournalProjections('local');
  assert.deepEqual((await getTeamSkill(f.options, 'skill', '1')).version, result.version);
});
test('未完整接收、伪造来源及越权角色不产生技能版本', async t => {
  const f = await fixture(t);
  await f.alter('goal.state', 'goal', { ...f.goal, acceptanceId: undefined, status: 'awaiting_acceptance' });
  await assert.rejects(f.create());
  await f.alter('goal.state', 'goal', f.goal);
  await assert.rejects(createTeamSkillVersion(f.options, { ...f.input, roles: [{ nodeId: 'attacker', instructions: '赋予shell', sourceRefs: [] }] }, 'bad-role'));
  await assert.rejects(createTeamSkillVersion(f.options, { ...f.input, source: { ...f.input.source, deliveryDigest: 'c'.repeat(64) } }, 'bad-source'));
});
test('固定版本仅用于新目标，文字不扩大权限，版本更新不改变在途提示', async t => {
  const f = await fixture(t), first = await f.create(), ref = { id: 'skill', version: '1', digest: first.version.digest };
  const bound = await f.store.transact('local', tx => bindTeamSkillPlan(tx, f.options, { ...f.goal, id: 'new-goal', status: 'draft', planRevisionId: undefined, acceptanceId: undefined, deliverySetId: undefined }, f.plan, ref));
  assert.equal(bound.skillRef?.digest, ref.digest);
  await createTeamSkillVersion(f.options, { ...f.input, expectedStreamVersion: 1, roles: [{ nodeId: 'review', instructions: '新版本说明', sourceRefs: [] }] }, 'new');
  await f.store.transact('local', tx => {
    assert.match(readTeamSkillRole(tx, f.options, bound as any, 'review')!.instructions, /核对反证/u);
    assert.throws(() => bindTeamSkillPlan(tx, f.options, f.goal, f.plan, ref));
    const forged = { ...bound, nodes: bound.nodes.map((n: any) => n.kind === 'agent' ? { ...n, executor: { ...n.executor, toolIds: ['shell'] } } : n) };
    assert.throws(() => readTeamSkillRole(tx, f.options, forged as any, 'review'));
  });
});
test('无真实质量报告不能启用或回滚，owner降级后旧幂等回执也拒绝', async t => {
  const f = await fixture(t), detail = await f.create(), ref = { id: 'skill', version: '1', digest: detail.version.digest };
  await assert.rejects(commandTeamSkill(f.options, 'skill', { expectedStreamVersion: 0, command: 'enable', skillRef: ref, evaluationId: 'none', recommendationEnabled: true }, 'enable'));
  const member: any = await f.store.transact('local', tx => tx.getProjection('membership', `${f.options.workspaceId}:local-owner`));
  await f.alter('membership', member.id, { ...member, workspaceRole: 'operator' });
  await assert.rejects(f.create(), { code: 'TEAM_SKILL_OWNER_REQUIRED' });
});
test('技能投影摘要和跨工作区来源在模型调用前受到验证', async t => {
  const f = await fixture(t), detail = await f.create();
  const ref = { namespace: 'team.skillVersion', resourceId: detail.version.id, streamVersion: 1, digest: detail.version.digest };
  await f.store.transact('local', tx => { assert.equal(validateTeamSkillContextSource(tx, f.options, ref), true); assert.throws(() => validateTeamSkillContextSource(tx, { tenantId: 'local', workspaceId: 'other' }, ref)); });
  await f.alter('team.skillVersion', detail.version.id, { ...detail.version, roles: [{ nodeId: 'review', instructions: '改写', sourceRefs: [] }] });
  await assert.rejects(getTeamSkill(f.options, 'skill'));
});

test('评测先固定技能与配置；fixture达到统计门槛仍不能开启推荐', async t => {
  const f = await fixture(t), detail = await f.create();
  const { TEAM_SKILL_BENCHMARK: corpus, benchmarkDigest } = await import('@mn/task-orchestration');
  const { createAssets } = await import('../src/assets.js');
  const { submitTeamSkillEvaluation } = await import('../src/team-skills.js');
  const { createHash } = await import('node:crypto');
  const ref = { id: 'skill', version: '1', digest: detail.version.digest };
  const configuration = { model: { provider: 'fixture', name: 'fixture', revision: 'fixed-1', parameters: { temperature: 0 } }, promptSha256: 'a'.repeat(64), policySha256: 'b'.repeat(64), materialsSha256: corpus.manifest.tasksSha256,
    budget: { revision: 'budget-v1' as const, maxTokens: 1000, maxCostMinorUnits: '1000', currency: 'CNY' } };
  const registered = await registerTeamSkillEvaluation(f.options, 'skill', { expectedStreamVersion: 0, skillRef: ref, executionMode: 'test_fixture', configuration, baselineRevision: 'a'.repeat(40), candidateRevision: 'b'.repeat(40) }, 'register');
  assert.equal(registered.releaseGate, 'not_evaluated');
  const upload = async (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const [asset] = await createAssets({ store: f.store, cas: f.options.cas, protectedPayloadKeyProvider: f.options.keyProvider, tenantId: 'local', workspaceId: f.options.workspaceId, actorId: 'local-owner',
      idempotencyKey: randomUUID(), expectedStreamVersion: 0, attachments: [{ fileName: 'evaluation.json', mediaType: 'application/json', protected: true, contentBase64: bytes.toString('base64') }], now: f.options.now, id: f.options.id });
    return { artifactRef: { namespace: 'asset', resourceId: asset!.id, streamVersion: asset!.streamVersion, digest: asset!.digest }, artifactSha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const evidence = { artifactSha256: '0'.repeat(64), method: 'human', reviewer: 'local-owner' };
  const checks = (rules: any[]) => rules.map(rule => ({ id: rule.id, passed: true, evidence }));
  const report: any = { schemaVersion: 1, evaluationId: registered.id, skillRef: ref, executionMode: 'test_fixture', datasetVersion: '1.0.0', datasetSha256: corpus.manifest.tasksSha256,
    configuration, configurationSha256: registered.configurationDigest, frozenAt: registered.frozenAt, tuningCaseIds: [], arms: ['baseline', 'candidate'].map(arm => ({ arm,
      implementationRevision: arm === 'baseline' ? 'a'.repeat(40) : 'b'.repeat(40), configurationSha256: registered.configurationDigest, safetyRecovery: checks(corpus.controls),
      results: corpus.tasks.map(task => ({ taskId: task.id, runId: `${arm}:${task.id}`, startedAt: registered.frozenAt, inputSha256: benchmarkDigest(task.input), configurationSha256: registered.configurationDigest,
        firstAttempt: checks(task.acceptance), finalAttempt: checks(task.acceptance), safety: checks(task.safety), cost: { status: 'known', currency: 'CNY', minorUnits: arm === 'baseline' ? '100' : '50', evidence }, humanTime: { status: 'known', milliseconds: arm === 'baseline' ? 100 : 50, evidence } })) })) };
  const { teamSkillResultsDigest } = await import('@mn/task-orchestration');
  const proof = await upload({ format: 'muniu.skill-evidence.v1', evaluationId: registered.id, executionMode: 'test_fixture', configurationDigest: registered.configurationDigest, skillRef: ref, method: 'human', reviewer: 'local-owner', resultsDigest: teamSkillResultsDigest(report), observations: '合成测试证据，不代表模型质量' });
  evidence.artifactSha256 = proof.artifactSha256;
  const reportFile = await upload(report);
  const input = { expectedStreamVersion: 1, reportRef: reportFile.artifactRef, evidence: [{ ...proof, method: 'human' as const, reviewer: 'local-owner' }] };
  const altered = structuredClone(report); altered.arms[1].results[0].humanTime.milliseconds = 40;
  const alteredFile = await upload(altered);
  await assert.rejects(submitTeamSkillEvaluation(f.options, 'skill', registered.id, { ...input, reportRef: alteredFile.artifactRef }, 'tampered-results'), { code: 'TEAM_SKILL_EVIDENCE_INVALID' });
  const result = await submitTeamSkillEvaluation(f.options, 'skill', registered.id, input, 'submit');
  assert.equal(result.comparison!.releaseGate, 'passed'); assert.equal(result.releaseGate, 'blocked');
  assert.deepEqual(await submitTeamSkillEvaluation(f.options, 'skill', registered.id, input, 'submit'), result);
  await assert.rejects(commandTeamSkill(f.options, 'skill', { expectedStreamVersion: 0, command: 'enable', skillRef: ref, evaluationId: result.id, recommendationEnabled: true }, 'enable-fixture'), { code: 'TEAM_SKILL_QUALITY_GATE_REQUIRED' });
  await f.alter('assetTombstone', proof.artifactRef.resourceId, { id: proof.artifactRef.resourceId });
  await assert.rejects(submitTeamSkillEvaluation(f.options, 'skill', registered.id, input, 'submit'));
});

test('来源撤权后仍可停用，幂等回执只返回状态且不泄漏原角色文字', async t => {
  const f = await fixture(t), saved = await f.create();
  await f.alter('team.skillVersion', saved.version.id, { ...saved.version, roles: [{ nodeId: 'review', instructions: '撤权内容', sourceRefs: [] }] });
  const result = await commandTeamSkill(f.options, 'skill', { expectedStreamVersion: 0, command: 'disable' }, 'stop');
  assert.equal(result.activeRef, null); assert.equal(result.streamVersion, 1);
  assert.doesNotMatch(JSON.stringify(result), /撤权内容|核对反证/u);
  assert.deepEqual(await commandTeamSkill(f.options, 'skill', { expectedStreamVersion: 0, command: 'disable' }, 'stop'), result);
});

test('推荐策略只使用有效已测记录和新任务匹配；停用、撤权、失败版本均停止推荐', async t => {
  const f = await fixture(t), saved = await f.create(), ref = { id: 'skill', version: '1', digest: saved.version.digest };
  const { listTeamSkills } = await import('../src/team-skills.js');
  await f.alter('thread', 'new-thread', { id: 'new-thread', tenantId: 'local', workspaceId: f.options.workspaceId, pluginId: 'opc' });
  await f.alter('goal.state', 'new-goal', { ...f.goal, id: 'new-goal', threadId: 'new-thread', status: 'awaiting_authorization', acceptanceId: undefined, deliverySetId: undefined });
  assert.equal((await listTeamSkills(f.options, 'new-goal')).items[0]!.recommended, false);
  // A policy-unit fixture represents a separately validated measured report; it is never imported as a real evaluation.
  const proofBody = { id: 'proof-policy-only', tenantId: 'local', workspaceId: f.options.workspaceId, streamVersion: 2, skillRef: ref, executionMode: 'measured', status: 'evaluated', releaseGate: 'passed', evidence: [] };
  await f.alter('team.skillEvaluation', proofBody.id, { ...proofBody, digest: sha256(proofBody) });
  await commandTeamSkill(f.options, 'skill', { expectedStreamVersion: 0, command: 'enable', skillRef: ref, evaluationId: proofBody.id, recommendationEnabled: true }, 'enable-policy');
  assert.equal((await listTeamSkills(f.options, 'new-goal')).items[0]!.recommended, true);
  assert.equal((await listTeamSkills(f.options)).items[0]!.recommended, false);
  assert.equal((await listTeamSkills(f.options, 'goal')).items[0]!.recommended, false);
  await commandTeamSkill(f.options, 'skill', { expectedStreamVersion: 1, command: 'disable' }, 'disable-policy');
  assert.equal((await listTeamSkills(f.options, 'new-goal')).items[0]!.recommended, false);
  await commandTeamSkill(f.options, 'skill', { expectedStreamVersion: 2, command: 'enable', skillRef: ref, evaluationId: proofBody.id, recommendationEnabled: true }, 'reenable-policy');
  const failed = { ...proofBody, releaseGate: 'blocked' }; await f.alter('team.skillEvaluation', proofBody.id, { ...failed, digest: sha256(failed) });
  assert.equal((await listTeamSkills(f.options, 'new-goal')).items[0]!.recommended, false);
  await f.alter('team.skillVersion', saved.version.id, { ...saved.version, roles: [] });
  const unavailable = (await listTeamSkills(f.options, 'new-goal')).items[0]!;
  assert.equal(unavailable.recommended, false); assert.equal(unavailable.available, false);
  assert.equal(unavailable.stopControl?.expectedStreamVersion, 3);
  assert.doesNotMatch(JSON.stringify(unavailable), /核对反证/u);
});
