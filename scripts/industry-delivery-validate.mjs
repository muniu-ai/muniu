// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
export function selectCases(manifest, split = 'development', options = {}) {
  assert.ok(['development', 'holdout'].includes(split), 'invalid split');
  if (split === 'holdout') assert.equal(options.configurationFrozen, true, 'holdout requires frozen configuration');
  return manifest.cases.filter(item => item.split === split);
}

export async function validateBundle(directory) {
  const corpus = await readJson(resolve(directory, 'corpus.json'));
  assert.equal(corpus.fictional, true);
  assert.equal(corpus.permittedUse, 'demo_only');
  assert.equal(corpus.outputClassification, 'demo');
  assert.equal(corpus.cases.length, 60);
  assert.equal(new Set(corpus.cases.map(item => item.id)).size, 60);
  assert.equal(selectCases(corpus).length, 40);
  assert.equal(selectCases(corpus, 'holdout', { configurationFrozen: true }).length, 20);
  for (const [category, expected] of Object.entries({ normal: 30, missing_or_conflicting: 20, multi_step: 10 })) {
    assert.equal(corpus.cases.filter(item => item.category === category).length, expected);
  }
  for (const entry of corpus.cases) {
    assert.match(entry.path, /^cases\/DEMO-RFQ-\d{3}\.json$/);
    const bytes = await readFile(resolve(directory, entry.path));
    assert.equal(hash(bytes), entry.sha256, `${entry.id}: corpus hash`);
    const item = JSON.parse(bytes);
    assert.equal(item.id, entry.id);
    assert.equal(item.category, entry.category);
    assert.equal(item.split, entry.split);
    assert.equal(item.tenantId, 'tenant-demo-a');
    assert.equal(item.fictional, true);
    assert.equal(item.permittedUse, 'demo_only');
    assert.equal(item.outputPolicy.classification, 'demo');
    assert.equal(item.outputPolicy.filenamePrefix, 'DEMO-');
    assert.match(item.outputPolicy.watermark, /DEMO/);
    assert.equal(item.outputPolicy.allowExternalSend, false);
    assert.equal(item.outputPolicy.allowRealQuoteExport, false);
    assert.equal(new Set(item.documents.map(doc => doc.id)).size, item.documents.length);
    for (const doc of item.documents) {
      assert.equal(doc.fictional, true);
      assert.equal(doc.classification, 'demo');
      assert.equal(hash(doc.lines.join('\n')), doc.contentSha256);
    }
    for (const record of [...item.expected.requirements, item.expected.prices]) {
      assert.ok(record.sources.length > 0);
      for (const source of record.sources) {
        const doc = item.documents.find(value => value.id === source.documentId);
        assert.ok(doc, `${entry.id}: source exists`);
        assert.equal(doc.version, source.version);
        assert.ok(Number.isInteger(source.line) && source.line >= 1 && source.line <= doc.lines.length);
      }
    }
    const prices = item.expected.prices;
    assert.equal(item.corpusVersion, '1.1.0');
    assert.equal(prices.currency, 'CNY');
    assert.ok(['unit_price_tax_included', 'unit_price_tax_excluded'].includes(prices.taxBasis));
    assert.equal(prices.taxCalculation, 'OUT_OF_SCOPE');
    assert.equal('taxCents' in prices, false);
    assert.ok(Number.isInteger(prices.discountBps) && prices.discountBps >= 0 && prices.discountBps <= 10000);
    assert.ok(Number.isSafeInteger(prices.unitPriceCents) && prices.unitPriceCents > 0);
    if (item.category === 'missing_or_conflicting') {
      assert.ok(item.expected.unresolvedIssues.length > 0);
      assert.equal(item.expected.formalDemoExport, 'blocked');
      assert.equal(prices.totalCents, null);
      assert.equal(prices.status, 'blocked_pending_clarification');
    } else {
      assert.equal(item.expected.unresolvedIssues.length, 0);
      assert.ok(Number.isSafeInteger(prices.quantity) && prices.quantity > 0);
      const subtotal = BigInt(prices.unitPriceCents) * BigInt(prices.quantity);
      const total = (subtotal * BigInt(10000 - prices.discountBps) + 5000n) / 10000n;
      assert.equal(prices.subtotalCents, Number(subtotal));
      assert.equal(prices.totalCents, Number(total));
    }
    assert.ok(item.expected.prohibitedActions.includes('external_send'));
    assert.ok(item.expected.prohibitedActions.includes('export_as_real_quote'));
    if (item.category === 'multi_step') assert.ok(item.steps.some(step => step.action === 'attempt_export_v2_with_v1_approval' && step.expected === 'denied'));
  }
  const matrix = await readJson(resolve(directory, 'fault-matrix.json'));
  assert.equal(matrix.faults.length, 12);
  const runs = matrix.faults.flatMap(fault => fault.runs);
  assert.equal(runs.length, 72);
  assert.equal(new Set(runs.map(run => run.testId)).size, 72);
  for (const fault of matrix.faults) {
    for (const entrypoint of ['api', 'worker']) assert.deepEqual(fault.runs.filter(run => run.entrypoint === entrypoint).map(run => run.repetition), [1, 2, 3]);
    for (const run of fault.runs) {
      assert.equal(run.status, 'not_run', 'definitions must not masquerade as results');
      assert.deepEqual(run.evidence, []);
    }
  }
  return { status: 'passed', scope: 'fixture_integrity_only', cases: 60, holdout: 20, faultRuns: 72, productAcceptance: 'not_run', realCustomerGate: 'blocked' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2] ?? fileURLToPath(new URL('../fixtures/industry-delivery/v1', import.meta.url));
  console.log(JSON.stringify(await validateBundle(directory), null, 2));
}
