// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { compareReport, digest, loadBenchmark, validateBenchmark } from '../verify-agent-os-benchmark.mjs';

const corpus = await loadBenchmark();
const clone = value => structuredClone(value);
const evidence = () => ({ method: 'human', artifactSha256: 'a'.repeat(64), reviewer: 'benchmark-reviewer' });
const assessments = items => items.map(item => ({ id: item.id, passed: true, evidence: evidence() }));
function report() {
  const configuration = {
    model: { provider: 'test-provider', name: 'test-model', revision: 'test-revision', parameters: { temperature: 0 } },
    promptSha256: 'b'.repeat(64), policySha256: 'c'.repeat(64), materialsSha256: corpus.manifest.tasksSha256,
    budget: { revision: 'budget-v1', maxTokens: 20000, maxCostMinorUnits: '10000', currency: 'CNY' },
  };
  return {
    schemaVersion: 1, datasetVersion: corpus.manifest.version, datasetSha256: corpus.manifest.tasksSha256,
    executionMode: 'measured', frozenAt: '2026-10-10T00:00:00.000Z', configuration,
    configurationSha256: digest(configuration), tuningCaseIds: corpus.tasks.filter(t => t.split === 'development').map(t => t.id),
    arms: ['baseline', 'candidate'].map(arm => ({
      arm, implementationRevision: arm === 'baseline' ? 'd'.repeat(40) : 'e'.repeat(40),
      configurationSha256: digest(configuration),
      safetyRecovery: assessments(corpus.controls),
      results: corpus.tasks.map(task => ({
        taskId: task.id, runId: `${arm}-${task.id}`, startedAt: '2026-10-10T01:00:00.000Z',
        inputSha256: digest(task.input), configurationSha256: digest(configuration),
        firstAttempt: assessments(task.acceptance), finalAttempt: assessments(task.acceptance), safety: assessments(task.safety),
        cost: { status: 'known', currency: 'CNY', minorUnits: arm === 'baseline' ? '100' : '80', evidence: evidence() },
        humanTime: { status: 'known', milliseconds: arm === 'baseline' ? 1000 : 800, evidence: evidence() },
      })),
    })),
  };
}

test('60 个独立合成任务按领域和开发/留出拆分，摘要固定', () => {
  assert.equal(corpus.tasks.length, 60);
  assert.equal(corpus.tasks.filter(t => t.split === 'development').length, 40);
  assert.equal(corpus.tasks.filter(t => t.split === 'holdout').length, 20);
  for (const domain of ['business', 'research', 'coding']) assert.equal(corpus.tasks.filter(t => t.domain === domain).length, 20);
  assert.equal(new Set(corpus.tasks.map(t => t.input.request)).size, 60);
  assert.equal(new Set(corpus.tasks.map(t => t.input.documents[0].content)).size, 60);
  assert.ok(corpus.tasks.every(t => t.acceptance.length >= 3 && t.safety.length >= 2));
});

test('数据修改、重复样本、空验收和留出拆分改变均被拒绝', () => {
  for (const mutate of [
    c => { c.tasks[0].input.request = 'changed'; },
    c => { c.tasks[1].id = c.tasks[0].id; },
    c => { c.tasks[0].acceptance = []; },
    c => { c.tasks[0].split = 'holdout'; },
    c => { c.manifest.frozenAt = '2020-01-01T00:00:00.000Z'; },
    c => { c.manifest.counts.holdout = 0; },
  ]) {
    const modified = clone(corpus); mutate(modified);
    assert.throws(() => validateBenchmark(modified));
  }
});

test('CLI 数据校验成功仍显示未测，显式报告门禁拒绝未测模板', () => {
  const script = new URL('../verify-agent-os-benchmark.mjs', import.meta.url).pathname;
  const template = new URL('../../benchmarks/agent-os-delivery/v1/report.template.json', import.meta.url).pathname;
  const validate = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(validate.status, 0); assert.equal(JSON.parse(validate.stdout).releaseGate, 'not_evaluated');
  const gate = spawnSync(process.execPath, [script, '--report', template], { encoding: 'utf8' });
  assert.equal(gate.status, 1); assert.equal(JSON.parse(gate.stdout).status, 'not_measured');
});

test('空模板明确未测，不能生成通过结论', async () => {
  const template = JSON.parse(await readFile(new URL('../../benchmarks/agent-os-delivery/v1/report.template.json', import.meta.url), 'utf8'));
  assert.deepEqual(compareReport(corpus, template), { status: 'not_measured', releaseGate: 'not_evaluated', reason: 'NO_MEASURED_RESULTS' });
  template.arms = report().arms;
  assert.throws(() => compareReport(corpus, template), /UNMEASURED_REPORT_HAS_RESULTS/);
});

test('同配置成对结果在安全全通过且首次验收率不降时接受恰好 20% 改善', () => {
  const result = compareReport(corpus, report());
  assert.equal(result.releaseGate, 'passed');
  assert.equal(result.holdout.baseline.firstAcceptanceRate, 1);
  assert.equal(result.holdout.candidate.firstAcceptanceRate, 1);
  assert.equal(result.cost.improvementPercent, 20);
  assert.equal(result.humanTime.improvementPercent, 20);
});

test('未知费用独立列出，不能按零费用计入，时间可独立满足门槛', () => {
  const value = report(); value.arms[1].results[59].cost = { status: 'unknown', reason: 'CLI_BILL_PENDING' };
  const result = compareReport(corpus, value);
  assert.equal(result.cost.status, 'not_comparable');
  assert.equal(result.cost.unknownResults, 1);
  assert.equal(result.releaseGate, 'passed');
  value.arms[1].results[59].cost.minorUnits = '0';
  assert.throws(() => compareReport(corpus, value), /UNKNOWN_COST_HAS_AMOUNT/);
});

test('首次验收回退、任何安全恢复失败、无 20% 改善均阻断', () => {
  const regression = report();
  regression.arms[1].results.find(r => corpus.tasks.find(t => t.id === r.taskId).split === 'holdout').firstAttempt[0].passed = false;
  assert.equal(compareReport(corpus, regression).releaseGate, 'blocked');
  for (const group of ['safetyRecovery', 'safety']) {
    const value = report();
    (group === 'safetyRecovery' ? value.arms[1].safetyRecovery : value.arms[1].results[0].safety)[0].passed = false;
    assert.equal(compareReport(corpus, value).releaseGate, 'blocked');
  }
  const expensive = report();
  for (const r of expensive.arms[1].results) { r.cost.minorUnits = '81'; r.humanTime.milliseconds = 801; }
  assert.equal(compareReport(corpus, expensive).releaseGate, 'blocked');
});

test('失败任务的花费计入每个已验收成果，不能通过丢弃失败来降低费用', () => {
  const value = report();
  for (const arm of value.arms) {
    const failed = arm.results.find(r => corpus.tasks.find(t => t.id === r.taskId).split === 'holdout');
    failed.firstAttempt[0].passed = false; failed.finalAttempt[0].passed = false;
  }
  assert.equal(compareReport(corpus, value).cost.baselineMinorUnitsPerAccepted, 2000 / 19);
});

test('跨币种不换汇；双方零基线、未知时间和无验收结果不能冒充改善', () => {
  const value = report();
  value.arms[1].results[59].cost.currency = 'USD';
  for (const arm of value.arms) for (const r of arm.results) r.humanTime = { status: 'unknown', reason: 'NOT_OBSERVED' };
  assert.equal(compareReport(corpus, value).releaseGate, 'blocked');
  assert.equal(compareReport(corpus, value).cost.status, 'not_comparable');
  const zero = report();
  for (const arm of zero.arms) for (const r of arm.results) { r.cost.minorUnits = '0'; r.humanTime.milliseconds = 0; }
  assert.equal(compareReport(corpus, zero).releaseGate, 'blocked');
  const rejected = report();
  for (const arm of rejected.arms) for (const r of arm.results) { r.firstAttempt[0].passed = false; r.finalAttempt[0].passed = false; }
  assert.equal(compareReport(corpus, rejected).releaseGate, 'blocked');
});

for (const [label, mutate, error] of [
  ['缺结果', r => r.arms[1].results.pop(), /RESULT_SET_MISMATCH/],
  ['重复结果', r => { r.arms[1].results[1] = r.arms[1].results[0]; }, /RESULT_SET_MISMATCH/],
  ['缺安全场景', r => r.arms[0].safetyRecovery.pop(), /ASSESSMENT_SET_MISMATCH/],
  ['缺验收项', r => r.arms[0].results[0].firstAttempt.pop(), /ASSESSMENT_SET_MISMATCH/],
  ['模型评分替代人工', r => { r.arms[0].results[0].firstAttempt[0].evidence.method = 'model'; }, /INVALID_EVIDENCE/],
  ['留出调参', r => r.tuningCaseIds.push(corpus.tasks.find(t => t.split === 'holdout').id), /HOLDOUT_TUNING_FORBIDDEN/],
  ['未知调参样本', r => r.tuningCaseIds.push('external'), /INVALID_TUNING_CASE/],
  ['双方配置不一致', r => { r.arms[1].configurationSha256 = 'f'.repeat(64); }, /CONFIGURATION_MISMATCH/],
  ['单次运行配置不一致', r => { r.arms[1].results[0].configurationSha256 = 'f'.repeat(64); }, /CONFIGURATION_MISMATCH/],
  ['任务资料替换', r => { r.arms[0].results[0].inputSha256 = 'f'.repeat(64); }, /INPUT_MISMATCH/],
  ['配置冻结在执行后', r => { r.frozenAt = '2026-10-11T00:00:00.000Z'; }, /CONFIGURATION_NOT_FROZEN/],
  ['预算改动未冻结', r => { r.configuration.budget.maxTokens++; }, /CONFIGURATION_MISMATCH/],
  ['未固定模型版本', r => { r.configuration.model.revision = ''; }, /INVALID_CONFIGURATION/],
  ['fixture冒充实测', r => { r.executionMode = 'fixture'; }, /MEASURED_REPORT_REQUIRED/],
  ['负费用', r => { r.arms[0].results[0].cost.minorUnits = '-1'; }, /INVALID_COST/],
  ['未知耗时伪零', r => { r.arms[0].results[0].humanTime = { status: 'unknown', reason: 'MISSING', milliseconds: 0 }; }, /UNKNOWN_TIME_HAS_VALUE/],
]) test(`不合法报告被拒绝：${label}`, () => {
  const value = report(); mutate(value); assert.throws(() => compareReport(corpus, value), error);
});
