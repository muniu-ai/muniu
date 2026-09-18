// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { candidatePlan, candidateSummary, assertLoopbackUrl, runCandidateIntegration } from './industry-candidate-e2e.mjs';

test('候选契约集成逐项记录三种场景，不将测试模型标记为质量实测', () => {
  const plan = candidatePlan(3);
  assert.equal(plan.length, 9);
  assert.equal(new Set(plan.map(item => item.id)).size, 9);
  assert.ok(plan.every(item => item.status === 'not_run'));
  for (const scenario of ['normal', 'sales_revoked_queued', 'sales_revoked_during_model'])
    assert.deepEqual(plan.filter(item => item.scenario === scenario).map(item => item.repetition), [1, 2, 3]);
  assert.throws(() => candidatePlan(0));
  assert.throws(() => candidatePlan(4));
  const report = candidateSummary(plan.map(item => ({ ...item, status: 'passed' })));
  assert.equal(report.status, 'passed');
  assert.equal(report.model.mode, 'test_fixture');
  assert.equal(report.model.qualityEvaluation, 'not_run');
  assert.equal(report.realPostgreSql, 'not_run');
  assert.equal(report.fullFaultMatrix, 'not_run');
  assert.equal(candidateSummary(plan).status, 'not_run');
  assert.equal(candidateSummary([{ ...plan[0], status: 'failed' }]).status, 'failed');
});

test('集成运行器禁止访问非本机服务，包括真实模型端点', () => {
  assert.doesNotThrow(() => assertLoopbackUrl('http://127.0.0.1:1234/api/v1/rfqs'));
  for (const url of ['https://api.deepseek.com/v1/chat/completions', 'https://api.openai.com/v1/responses',
    'http://localhost:1234/', 'http://user:password@127.0.0.1:1234/', 'file:///tmp/model'])
    assert.throws(() => assertLoopbackUrl(url));
});

test('真实 Sales HTTP 与 OS 候选保护、采纳和撤权集成（测试模型，非 PostgreSQL）', {
  skip: !process.env.MUNIU_CANDIDATE_SALES_ROOT && '设置 MUNIU_CANDIDATE_SALES_ROOT 后执行跨仓库集成',
  timeout: 90_000,
}, async () => {
  const report = await runCandidateIntegration({ salesRoot: process.env.MUNIU_CANDIDATE_SALES_ROOT, repetitions: 3 });
  assert.equal(report.status, 'passed', JSON.stringify(report.checks));
  assert.equal(report.checks.length, 9);
  assert.equal(report.checks.filter(item => item.scenario === 'normal').every(item => item.humanAdoption === 'unconfirmed'), true);
  assert.equal(report.checks.filter(item => item.scenario === 'sales_revoked_queued').every(item => item.modelCalls === 0), true);
  assert.equal(report.checks.filter(item => item.scenario === 'sales_revoked_during_model').every(item => item.modelSettlements === 1), true);
});
