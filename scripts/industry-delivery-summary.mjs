// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterNames = ['fixed_workflow', 'muniu', 'deepseek_harness', 'adp'];
const statuses = ['passed', 'failed', 'not_run', 'documented', 'unknown', 'blocked'];
const sha256 = /^[a-f0-9]{64}$/;
export function summarizeResults(input) {
  assert.equal(input.schemaVersion, 1);
  assert.equal(input.corpusVersion, '1.0.0');
  assert.ok(Array.isArray(input.runs));
  const adapters = Object.fromEntries(adapterNames.map(name => [name, { status: 'not_run', ...Object.fromEntries(statuses.map(status => [status, 0])) }]));
  const seen = new Set();
  for (const run of input.runs) {
    assert.ok(adapterNames.includes(run.adapter), 'unknown adapter');
    assert.ok(statuses.includes(run.status), 'unknown status');
    assert.match(run.testId, /^(DEMO-RFQ-(00[1-9]|0[1-5][0-9]|060)|F(0[1-9]|1[0-2])-(api|worker)-[123])$/);
    const key = `${run.adapter}/${run.testId}`;
    assert.ok(!seen.has(key), 'duplicate test result');
    seen.add(key);
    if (['passed', 'failed'].includes(run.status)) {
      assert.ok(typeof run.runId === 'string' && run.runId && !Number.isNaN(Date.parse(run.executedAt)) && sha256.test(run.configurationSha256) && Array.isArray(run.evidence) && run.evidence.length > 0, 'measured status requires execution evidence');
      for (const evidence of run.evidence) assert.ok(typeof evidence.path === 'string' && evidence.path && sha256.test(evidence.sha256), 'execution evidence must name content hash');
      const metrics = run.metrics;
      assert.ok(metrics && Number.isInteger(metrics.requiredAssertions) && metrics.requiredAssertions > 0 && Number.isInteger(metrics.passedAssertions) && metrics.passedAssertions >= 0 && metrics.passedAssertions <= metrics.requiredAssertions && Number.isInteger(metrics.criticalViolations) && metrics.criticalViolations >= 0, 'invalid assertion metrics');
      if (run.status === 'passed') assert.ok(metrics.passedAssertions === metrics.requiredAssertions && metrics.criticalViolations === 0, 'passing requires all assertions and no critical violations');
    } else {
      assert.ok(typeof run.reason === 'string' && run.reason.length > 0, 'unmeasured status requires reason');
      if (run.status === 'documented') assert.ok(typeof run.sourceUrl === 'string' && /^https:\/\//.test(run.sourceUrl), 'documented requires source URL');
    }
    adapters[run.adapter][run.status] += 1;
  }
  for (const data of Object.values(adapters)) {
    const measured = data.passed + data.failed;
    data.status = data.failed ? 'failed' : measured ? 'partial_execution' : data.documented ? 'documented' : data.blocked ? 'blocked' : data.unknown ? 'unknown' : 'not_run';
    data.measuredCases = measured;
    data.requiredCases = 132;
    data.missingResults = 132 - statuses.reduce((count, status) => count + data[status], 0);
    assert.ok(data.missingResults >= 0, 'too many test results');
  }
  return { schemaVersion: 1, corpusVersion: input.corpusVersion, adapters,
    evidenceVerification: 'metadata_only_use_verify_evidence_for_file_hashes',
    productionReady: false, realCustomerGate: 'blocked', comparativeAdvantage: 'unknown',
    limitation: '汇总仅检查结果格式，未读取私有证据文件；合成样本通过不证明生产适用性、客户收益或竞品领先。' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  assert.ok(path, 'usage: node scripts/industry-delivery-summary.mjs RESULT.json');
  const input = JSON.parse(await readFile(resolve(path), 'utf8'));
  const summary = summarizeResults(input);
  if (process.argv.includes('--verify-evidence')) {
    for (const run of input.runs) for (const evidence of run.evidence ?? []) {
      const { createHash } = await import('node:crypto');
      const bytes = await readFile(resolve(resolve(path, '..'), evidence.path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), evidence.sha256, `${run.testId}: evidence hash mismatch`);
    }
    summary.evidenceVerification = 'file_hashes_verified';
  }
  console.log(JSON.stringify(summary, null, 2));
}
