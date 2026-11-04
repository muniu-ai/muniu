// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { evaluateOperatingEvidence } from '../lib/operating-evaluation.mjs';
const baseline = JSON.parse(await readFile(new URL('../../docs/enterprise-acceptance/baseline.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../docs/enterprise-acceptance/baseline.lock.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const configuration = { modelVersions: ['fixture@1'], promptDigests: [digest('prompt')], fixtureDigest: digest('fixture'), permissionSnapshot: digest('permissions'), toolVersions: ['host@484566b'], pricingVersion: 'fixture@1', reviewerPrincipalIds: ['reviewer'], baselineOperatorPrincipalIds: ['human'], frozenAt: '2026-11-02T00:00:00.000Z' };
  const configurationDigest = digest(configuration), common = { configurationDigest, startedAt: '2026-11-03T00:00:00.000Z', finishedAt: '2026-11-03T00:10:00.000Z', reviewerPrincipalId: 'reviewer', firstAccepted: true, programChecks: { amounts: true, permissions: true, provenance: true }, logs: [{ path: 'fixture.json', digest: digest('log') }], humanTime: { prepareMs: 100, reviewMs: 100, correctionMs: 0, reworkMs: 0, sharedMs: 0 }, waits: [] };
  const runs = [], humanBaselines = [], safety = [];
  for (const task of baseline.tasks) {
    const inputDigest = digest([baseline.scenarios.find(s => s.id === task.scenarioId).input, configuration.fixtureDigest, configuration.permissionSnapshot, configuration.toolVersions]);
    humanBaselines.push({ ...structuredClone(common), taskId: task.id, inputDigest, operatorPrincipalId: 'human', humanTime: { ...common.humanTime, prepareMs: 900 } });
    for (let round = 1; round <= 3; round++) runs.push({ ...structuredClone(common), taskId: task.id, inputDigest, operatorPrincipalId: 'operator', round, stateNamespace: task.id + '-' + round, modelMode: 'test_fixture', status: 'completed', tokens: 20, costMinorUnits: '1', costKnown: true });
  }
  for (const task of baseline.safetyTasks) for (const mode of task.modes) for (let round = 1; round <= task.rounds; round++) safety.push({ ...structuredClone(common), id: task.id, mode, round, passed: true, stateNamespace: 'safety-' + mode + '-' + task.id + '-' + round, operatorPrincipalId: 'operator', inputDigest: digest([task.injection, configuration.fixtureDigest, configuration.permissionSnapshot, configuration.toolVersions]), modelMode: 'test_fixture', tokens: 0, costMinorUnits: '0', costKnown: true });
  return { schemaVersion: 1, kind: 'synthetic', baselineDigest: lock.sha256, configuration, configurationDigest, holdoutUntouched: true, runs, humanBaselines, safety };
}
test('冻结任务三轮逐项统计，合成数据始终不能成为真实质量通过证据', () => {
  const report = evaluateOperatingEvidence(baseline, lock, fixture());
  assert.equal(report.complete, true); assert.equal(report.passed, false); assert.equal(report.qualification, 'synthetic_only');
  assert.equal(report.modes.builtin.holdout.count, 30); assert.equal(Object.keys(report.modes.builtin.flows).length, 5);
  assert.equal(report.modes.builtin.holdout.humanTimeReduction, 0.8);
});
test('缺失轮次、人工基线和安全结果不能省略，重复轮次不能充当新增样本', () => {
  const evidence = fixture(); evidence.runs.pop(); evidence.humanBaselines.pop(); evidence.safety.pop();
  assert.equal(evaluateOperatingEvidence(baseline, lock, evidence).complete, false);
  const duplicate = fixture(); duplicate.runs.push(duplicate.runs[0]);
  assert.throws(() => evaluateOperatingEvidence(baseline, lock, duplicate), /重复/);
});
test('失败和返工进入统计，开发集不能抵消留出集或安全失败', () => {
  const evidence = fixture(), task = baseline.tasks.find(t => t.mode === 'sales' && t.partition === 'holdout');
  const run = evidence.runs.find(r => r.taskId === task.id); run.firstAccepted = false; run.status = 'failed'; run.failureReason = '缺少来源'; run.humanTime.reworkMs = 500000;
  evidence.safety[0].passed = false; evidence.safety[0].failureReason = '安全断言失败';
  const report = evaluateOperatingEvidence(baseline, lock, evidence);
  assert.equal(report.thresholdsMet, false); assert.ok(report.modes.sales.holdout.firstAcceptanceRate < 1); assert.equal(report.safety.failed, 1);
});
test('拒绝输入变化、身份自审、未知费用伪装和合成模型冒充实测', () => {
  for (const mutate of [e => { e.runs[0].inputDigest = digest('changed'); }, e => { e.humanBaselines[0].reviewerPrincipalId = 'human'; }, e => { e.kind = 'measured'; }, e => { e.runs[0].configurationDigest = digest('new'); }]) {
    const evidence = fixture(); mutate(evidence); assert.throws(() => evaluateOperatingEvidence(baseline, lock, evidence));
  }
  const unknown = fixture(); unknown.runs[0].costKnown = false;
  assert.equal(evaluateOperatingEvidence(baseline, lock, unknown).thresholdsMet, false);
});
test('评测日志逐块核验，拒绝目录外引用，格式错误不回显输入正文', async t => {
  const { mkdtemp, writeFile, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { readOperatingEvidence, verifyOperatingLogs } = await import('../lib/operating-evaluation-files.mjs');
  const root = await mkdtemp(join(tmpdir(), 'mn-evaluation-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'records.json'), raw = Buffer.alloc(2 * 1024 * 1024, 'x'), digest = createHash('sha256').update(raw).digest('hex');
  await writeFile(file, 'CONFIDENTIAL-invalid-json');
  await assert.rejects(readOperatingEvidence(file), error => !String(error).includes('CONFIDENTIAL'));
  await writeFile(file, JSON.stringify({ runs: [{ logs: [{ path: 'log.bin', digest }] }], humanBaselines: [], safety: [] })); await writeFile(join(root, 'log.bin'), raw);
  const { evidence } = await readOperatingEvidence(file); assert.equal(await verifyOperatingLogs(file, evidence), 1);
  await symlink('/etc/hosts', join(root, 'outside')); evidence.runs[0].logs[0].path = 'outside';
  await assert.rejects(verifyOperatingLogs(file, evidence), /目录/);
});

test('安全样本必须独立隔离并计入总成本，统计整数溢出不能静默舍入', () => {
  const missing = fixture(); delete missing.safety[0].stateNamespace;
  assert.throws(() => evaluateOperatingEvidence(baseline, lock, missing));
  const reuse = fixture(); reuse.safety[0].stateNamespace = reuse.runs[0].stateNamespace;
  assert.throws(() => evaluateOperatingEvidence(baseline, lock, reuse), /重复/);
  const overflow = fixture(); overflow.runs.forEach(r => { r.tokens = Number.MAX_SAFE_INTEGER; });
  assert.throws(() => evaluateOperatingEvidence(baseline, lock, overflow), /溢出/);
  const billed = fixture(); billed.safety[0].costMinorUnits = '5';
  assert.equal(evaluateOperatingEvidence(baseline, lock, billed).safety.knownCostMinorUnits, '5');
});
test('纯程序安全检查明确记录未调用模型，不能同时填写模型用量', () => {
  const evidence = fixture(); evidence.safety[0].modelMode = 'not_used';
  assert.equal(evaluateOperatingEvidence(baseline, lock, evidence).complete, true);
  evidence.safety[0].tokens = 1;
  assert.throws(() => evaluateOperatingEvidence(baseline, lock, evidence));
});
