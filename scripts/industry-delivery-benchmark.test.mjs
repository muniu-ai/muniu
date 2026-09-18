// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { configurationDigest, createFixedWorkflowShim, loadBenchmarkCases, runBenchmark, stripExpected } from './industry-delivery-benchmark.mjs';
import { summarizeResults } from './industry-delivery-summary.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const corpusDirectory = new URL('../fixtures/industry-delivery/v1/', import.meta.url).pathname;
const fixtureConfiguration = () => ({ schemaVersion: 1, frozenAt: '2026-09-18T00:00:00.000Z',
  model: { provider: 'fixture', name: 'fixture-model', revision: 'fixture-v1', parameters: { temperature: 0 } },
  prompt: { text: 'Extract only supported requirements.', sha256: hash('Extract only supported requirements.') },
  policySha256: 'a'.repeat(64), salesContractSha256: 'b'.repeat(64),
  budget: { maxTokens: 50000, maxCostMinorUnits: '100', currency: 'CNY' },
  adapters: Object.fromEntries(['muniu', 'fixed_workflow', 'deepseek_harness', 'adp'].map(name => [name, {
    implementationSha256: 'c'.repeat(64), version: name === 'deepseek_harness' ? 'ddefc45fbc7f8e46dd73185e68295696d1297887' : 'fixture-v1',
  }])),
});
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'mn-benchmark-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function server(t, handler) {
  const instance = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const value = await handler(JSON.parse(Buffer.concat(chunks).toString()), req);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}/v1/benchmark/run`;
}
async function responseFor(request) {
  const item = JSON.parse(await readFile(join(corpusDirectory, `cases/${request.caseId}.json`), 'utf8'));
  const e = item.expected;
  return { schemaVersion: 1, adapter: request.adapter, runId: request.runId, caseId: request.caseId,
    configurationSha256: request.configurationSha256, inputSha256: request.inputSha256, executionMode: 'fixture', status: 'completed',
    modelInvocation: { status: 'fixture', configurationSha256: configurationDigest(request.configuration.model) }, criticalFailures: [],
    actual: { requirements: e.requirements, unresolvedIssues: e.unresolvedIssues, prices: e.prices,
      effectiveQuoteVersion: e.effectiveQuoteVersion, formalDemoExport: e.formalDemoExport, outputs: e.requiredOutput,
      approvals: [{ kind: 'human', status: 'approved', version: e.effectiveQuoteVersion }],
      exports: e.formalDemoExport === 'blocked' ? [] : [{ format: 'pdf', classification: 'demo', version: e.effectiveQuoteVersion, sha256: 'd'.repeat(64) }],
      sideEffects: [], stepResults: item.steps.map(step => ({ action: step.action, status: step.expected === 'denied' ? 'denied' : 'completed' })) } };
}

test('development40与holdout20校验完整性，所有expected前缀递归去除', async () => {
  assert.equal((await loadBenchmarkCases(corpusDirectory, 'development')).length, 40);
  assert.equal((await loadBenchmarkCases(corpusDirectory, 'holdout')).length, 20);
  assert.deepEqual(stripExpected({ expected: 1, expectedIssueCount: 2, steps: [{ expected: 'denied', action: 'export' }] }), { steps: [{ action: 'export' }] });
});

test('没有endpoint或模型凭据保留not_run，结果兼容现有summary且不写假零成本', async t => {
  const root = await directory(t); const configuration = fixtureConfiguration();
  const report = await runBenchmark({ corpusDirectory, configuration, outputDirectory: join(root, 'results'), split: 'development', environment: {} });
  assert.equal(report.runs.length, 160);
  assert.ok(report.runs.every(run => run.status === 'not_run' && !('actualCost' in (run.metrics ?? {}))));
  assert.equal(summarizeResults(report).adapters.muniu.measuredCases, 0);
  await assert.rejects(runBenchmark({ corpusDirectory, configuration, split: 'holdout', outputDirectory: join(root, 'holdout'), environment: {} }), /FROZEN_CONFIGURATION_REQUIRED/);
  let calls = 0;
  const url = await server(t, () => { calls++; return {}; });
  const missingModel = await runBenchmark({ corpusDirectory, configuration, outputDirectory: join(root, 'missing-model'), caseIds: ['DEMO-RFQ-001'],
    environment: { MN_BENCH_MUNIU_URL: url, MN_BENCH_MUNIU_TOKEN: 'adapter-secret' }, expectedConfigurationSha256: configurationDigest(configuration) });
  assert.equal(calls, 0); assert.equal(missingModel.runs.find(run => run.adapter === 'muniu').reason, 'MODEL_CREDENTIAL_UNAVAILABLE');
});

for (const field of ['caseId', 'configurationSha256', 'inputSha256']) {
  test(`适配服务不能替换${field}`, async t => {
    const root = await directory(t);
    const url = await server(t, async request => ({ ...await responseFor(request), [field]: 'mismatched' }));
    const report = await runBenchmark({ corpusDirectory, configuration: fixtureConfiguration(), outputDirectory: join(root, 'results'), mode: 'fixture',
      caseIds: ['DEMO-RFQ-001'], environment: { MN_BENCH_MUNIU_URL: url, MN_BENCH_MUNIU_TOKEN: 'adapter-secret' } });
    assert.equal(report.safetyGate, 'blocked'); assert.equal(report.runs.find(run => run.adapter === 'muniu').protocolStatus, 'failed');
  });
}

test('关键违规即使其它断言通过也阻断；实测成本保留原币种整数分', async t => {
  const root = await directory(t);
  const url = await server(t, async request => ({ ...await responseFor(request), criticalFailures: [{ code: 'UNAUTHORIZED_APPROVAL' }],
    modelInvocation: { status: 'fixture', configurationSha256: configurationDigest(request.configuration.model), actualCost: { currency: 'CNY', minorUnits: '17', source: 'fixture-bill' } } }));
  const report = await runBenchmark({ corpusDirectory, configuration: fixtureConfiguration(), outputDirectory: join(root, 'results'), mode: 'fixture', caseIds: ['DEMO-RFQ-001'],
    environment: { MN_BENCH_MUNIU_URL: url, MN_BENCH_MUNIU_TOKEN: 'adapter-secret' } });
  const run = report.runs.find(run => run.adapter === 'muniu');
  assert.equal(report.safetyGate, 'blocked'); assert.equal(run.status, 'not_run');
  assert.equal(run.metrics.actualCost.minorUnits, '17'); assert.equal(run.metrics.criticalViolations, 1);
});

test('四个适配器收到相同配置和无答案输入，fixture证据不计竞争表现', async t => {
  const root = await directory(t); const requests = [];
  const url = await server(t, async (request, req) => {
    assert.equal(req.headers.authorization, 'Bearer adapter-test-secret');
    assert.ok(!JSON.stringify(request).includes('expected'));
    requests.push(request); return responseFor(request);
  });
  const configuration = fixtureConfiguration();
  const environment = Object.fromEntries(['muniu', 'fixed_workflow', 'deepseek_harness', 'adp'].flatMap(name => [
    [`MN_BENCH_${name.toUpperCase()}_URL`, url], [`MN_BENCH_${name.toUpperCase()}_TOKEN`, 'adapter-test-secret'] ]));
  const report = await runBenchmark({ corpusDirectory, configuration, outputDirectory: join(root, 'results'), split: 'development', mode: 'fixture',
    expectedConfigurationSha256: configurationDigest(configuration), caseIds: ['DEMO-RFQ-001'], environment });
  assert.equal(requests.length, 4);
  assert.equal(new Set(requests.map(r => r.configurationSha256)).size, 1);
  assert.equal(new Set(requests.map(r => r.inputSha256)).size, 1);
  assert.ok(report.runs.every(run => run.status === 'not_run' && run.protocolStatus === 'passed' && run.fixture));
  assert.equal(summarizeResults(report).adapters.fixed_workflow.measuredCases, 0);
  for (const run of report.runs) for (const evidence of run.evidence) assert.equal(hash(await readFile(join(root, 'results', evidence.path))), evidence.sha256);
});

test('配置、运行号不一致或criticalFailures阻断该适配器后续样本', async t => {
  const root = await directory(t); let calls = 0;
  const url = await server(t, async request => { calls++; const response = await responseFor(request); response.runId = 'wrong-run'; response.criticalFailures = [{ code: 'CROSS_TENANT_ACCESS' }]; return response; });
  const configuration = fixtureConfiguration();
  const report = await runBenchmark({ corpusDirectory, configuration, outputDirectory: join(root, 'results'), mode: 'fixture',
    caseIds: ['DEMO-RFQ-001', 'DEMO-RFQ-002'], environment: { MN_BENCH_MUNIU_URL: url, MN_BENCH_MUNIU_TOKEN: 'adapter-secret' } });
  assert.equal(calls, 1); assert.equal(report.safetyGate, 'blocked');
  const runs = report.runs.filter(run => run.adapter === 'muniu');
  assert.equal(runs[0].protocolStatus, 'failed'); assert.equal(runs[1].reason, 'ADAPTER_SAFETY_GATE_BLOCKED');
  assert.ok(runs.every(run => run.status === 'not_run'));
});

test('认证只由环境注入，服务回显凭据也不落盘', async t => {
  const root = await directory(t); const secret = 'do-not-persist-this-adapter-secret';
  const url = await server(t, async request => ({ ...await responseFor(request), debug: secret }));
  const report = await runBenchmark({ corpusDirectory, configuration: fixtureConfiguration(), outputDirectory: join(root, 'results'), mode: 'fixture', caseIds: ['DEMO-RFQ-001'],
    environment: { MN_BENCH_MUNIU_URL: url, MN_BENCH_MUNIU_TOKEN: secret } });
  assert.equal(report.safetyGate, 'blocked');
  for (const path of await readdir(join(root, 'results'), { recursive: true })) {
    const value = await readFile(join(root, 'results', path), 'utf8').catch(() => ''); assert.ok(!value.includes(secret));
  }
});

test('配置中的驼峰认证字段也在创建证据目录前拒绝', async t => {
  const root = await directory(t); const configuration = fixtureConfiguration();
  configuration.model.accessToken = 'not-from-environment';
  await assert.rejects(runBenchmark({ corpusDirectory, configuration, outputDirectory: join(root, 'results'), environment: {} }), /CREDENTIAL_IN_CONFIGURATION/);
  assert.deepEqual(await readdir(root), []);
});

test('固定工作流示例服务使用相同模型与Sales端口，缺少模型凭据时不调用端口', async t => {
  const configuration = fixtureConfiguration(); let calls = 0;
  const instance = createFixedWorkflowShim({ configuration, token: 'shim-secret', environment: {},
    modelPort: { async extract() { calls++; throw new Error('must not call'); } }, salesPort: { async runDemoScenario() { calls++; throw new Error('must not call'); } } });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  const item = (await loadBenchmarkCases(corpusDirectory, 'development'))[0];
  const input = stripExpected(item);
  const response = await fetch(`http://127.0.0.1:${instance.address().port}/v1/benchmark/run`, { method: 'POST', headers: { authorization: 'Bearer shim-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, adapter: 'fixed_workflow', runId: 'test-run', caseId: item.id, configuration, configurationSha256: configurationDigest(configuration), input, inputSha256: configurationDigest(input) }) });
  assert.equal((await response.json()).status, 'not_run'); assert.equal(calls, 0);
});

test('固定工作流示例按只读模型、Sales端口顺序执行且不向Sales传模型凭据', async t => {
  const root = await directory(t); const configuration = fixtureConfiguration(); const calls = [];
  const instance = createFixedWorkflowShim({ configuration, token: 'shim-secret', mode: 'fixture', environment: { MN_BENCH_MODEL_TOKEN: 'fixture-model-secret' },
    modelPort: { async extract(input) {
      calls.push('model'); assert.equal(input.modelToken, 'fixture-model-secret');
      assert.deepEqual(input.configuration, configuration); assert.ok(!JSON.stringify(input.documents).includes('expected'));
      return { invoked: true, candidate: { kind: 'fixture' }, providerRequestId: 'fixture-request' };
    } }, salesPort: { async runDemoScenario(input) {
      calls.push('sales'); assert.deepEqual(input.candidate, { kind: 'fixture' }); assert.ok(!JSON.stringify(input).includes('fixture-model-secret'));
      assert.deepEqual(input.configuration, configuration); assert.ok(!JSON.stringify(input).includes('expected'));
      const response = await responseFor({ caseId: input.input.caseId, configuration });
      return { actual: response.actual, criticalFailures: [] };
    } } });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  const report = await runBenchmark({ corpusDirectory, configuration, outputDirectory: join(root, 'results'), mode: 'fixture', caseIds: ['DEMO-RFQ-001'],
    environment: { MN_BENCH_FIXED_WORKFLOW_URL: `http://127.0.0.1:${instance.address().port}/v1/benchmark/run`, MN_BENCH_FIXED_WORKFLOW_TOKEN: 'shim-secret' } });
  assert.deepEqual(calls, ['model', 'sales']);
  const run = report.runs.find(item => item.adapter === 'fixed_workflow');
  assert.equal(run.protocolStatus, 'passed'); assert.equal(run.status, 'not_run'); assert.ok(run.fixture);
});
