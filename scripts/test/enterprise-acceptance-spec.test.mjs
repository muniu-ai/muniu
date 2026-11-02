// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateAcceptanceSpec, verifyAcceptanceDigest } from '../lib/enterprise-acceptance-spec.mjs';
const source = readFileSync(new URL('../../docs/enterprise-acceptance/baseline.json', import.meta.url), 'utf8');
const lock = JSON.parse(readFileSync(new URL('../../docs/enterprise-acceptance/baseline.lock.json', import.meta.url), 'utf8'));
const baseline = JSON.parse(source);
const copy = () => structuredClone(baseline);

test('冻结任务集覆盖两模式、五流程、独立留出和安全恢复场景', () => {
  assert.deepEqual(validateAcceptanceSpec(baseline), { tasks: 60, scenarios: 30, safetyTasks: 31, requirements: 17 });
  assert.doesNotThrow(() => verifyAcceptanceDigest(source, lock));
});
test('内容变更不能沿用冻结摘要', () => {
  assert.throws(() => verifyAcceptanceDigest(source + '\n', lock), /摘要/);
});
test('样本重复、划分错误和缺少流程不能充当更多独立样本', () => {
  const duplicate = copy(); duplicate.tasks[1].id = duplicate.tasks[0].id;
  assert.throws(() => validateAcceptanceSpec(duplicate), /重复/);
  const partition = copy(); partition.tasks[0].partition = 'holdout';
  assert.throws(() => validateAcceptanceSpec(partition), /划分/);
  const missing = copy(); missing.tasks = missing.tasks.filter(t => t.scenarioId !== 'T01');
  assert.throws(() => validateAcceptanceSpec(missing), /任务/);
});
test('缺少故障、未知门禁和未经执行的通过声明均被拒绝', () => {
  const safety = copy(); safety.safetyTasks = safety.safetyTasks.slice(0, 19);
  assert.throws(() => validateAcceptanceSpec(safety), /安全/);
  const gate = copy(); gate.requirements[0].gates = ['invented-gate'];
  assert.throws(() => validateAcceptanceSpec(gate), /门禁/);
  const status = copy(); status.tasks[0].executionStatus = 'passed';
  assert.throws(() => validateAcceptanceSpec(status), /执行结果/);
});
test('配对任务不得使用不同输入或绕过租户隔离', () => {
  const task = copy(); task.tasks[30].scenarioId = 'T02';
  assert.throws(() => validateAcceptanceSpec(task), /任务|配对/);
  const tenant = copy(); tenant.tasks[0].tenantId = 'tenant-sales';
  assert.throws(() => validateAcceptanceSpec(tenant), /租户/);
});
test('合成企业付款期、制单批准和旧测试覆盖仍须自洽', () => {
  const money = copy(); money.syntheticCompany.paymentSchedules[0].amountMinor++;
  assert.throws(() => validateAcceptanceSpec(money), /付款期/);
  const approval = copy(); approval.syntheticCompany.receipts[0].approvedBy = approval.syntheticCompany.receipts[0].preparedBy;
  assert.throws(() => validateAcceptanceSpec(approval), /职责/);
  const legacy = copy(); legacy.legacyCoverage[0].removalAllowed = true;
  assert.throws(() => validateAcceptanceSpec(legacy), /旧测试/);
});
test('不能降低人工节省、首次验收与候选准确率门槛', () => {
  for (const [field, value] of [['humanActiveTimeReduction', '>=5%'], ['firstAcceptanceVsHuman', '>=0.5'], ['proactivePrecision', '>=50%']]) {
    const changed = copy(); changed.rubric.thresholds[field] = value;
    assert.throws(() => validateAcceptanceSpec(changed), /阈值/);
  }
});
