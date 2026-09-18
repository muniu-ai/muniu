// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationDigest } from './industry-delivery-benchmark.mjs';
import { createHash } from 'node:crypto';
import { createLocalBenchmarkAdapter } from './industry-delivery-local-adapters.mjs';

function request(adapter = 'fixed_workflow') {
  const configuration = { model: { provider: 'fixture', name: 'fixture', revision: '1' }, prompt: { sha256: 'a'.repeat(64) } };
  const input = { caseId: 'DEMO-RFQ-001', fictional: true, permittedUse: 'demo_only', documents: [],
    outputPolicy: { allowExternalSend: false, allowRealQuoteExport: false },
    steps: ['import', 'extract_and_review', 'create_current_draft', 'human_approve_current_version', 'export_demo_pdf'].map(action => ({ action })) };
  return { schemaVersion: 1, adapter, runId: 'fixture-run', caseId: input.caseId, configuration,
    configurationSha256: configurationDigest(configuration), input, inputSha256: configurationDigest(input) };
}

test('缺少服务或模型凭据时，真实本地适配不访问业务服务', async () => {
  let calls = 0;
  const run = createLocalBenchmarkAdapter({ adapter: 'muniu', environment: {}, ports: {}, fetch: async () => { calls++; throw Error(); } });
  const result = await run(request('muniu'));
  assert.equal(result.status, 'not_run'); assert.equal(calls, 0); assert.equal(result.reasonCode, 'LOCAL_ADAPTER_CONFIGURATION_REQUIRED');
});

test('多步版本场景和标准答案输入在任何业务写入前拒绝', async () => {
  const run = createLocalBenchmarkAdapter({ adapter: 'fixed_workflow', environment: {}, ports: {} });
  const value = request(); value.input.steps.push({ action: 'create_draft_v1' }); value.inputSha256 = configurationDigest(value.input);
  assert.equal((await run(value)).reasonCode, 'SCENARIO_NOT_IMPLEMENTED');
  const leaked = request(); leaked.input.expected = { price: 123 }; leaked.inputSha256 = configurationDigest(leaked.input);
  await assert.rejects(run(leaked), /EXPECTED_DATA_FORBIDDEN/);
});

test('fixed workflow 始终标明共用木牛执行的内部消融，不冒充独立替代方案', async () => {
  const result = await createLocalBenchmarkAdapter({ adapter: 'fixed_workflow', environment: {}, ports: {} })(request());
  assert.equal(result.comparisonScope, 'fixed_extraction_with_muniu_execution');
  assert.equal(result.comparativeEligibility, 'internal_ablation_only');
});

test('正式模式不能注入测试模型或自动测试审批端口', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mn-local-adapter-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = { MN_LOCAL_SALES_URL: 'http://127.0.0.1:3101', MN_LOCAL_OS_URL: 'http://127.0.0.1:7331',
    MN_LOCAL_SALES_SESSION: 'fixture-session', MN_LOCAL_OS_TOKEN: 'fixture-os-token', MN_LOCAL_WORKSPACE_ID: 'workspace',
    MN_LOCAL_CUSTOMER_ID: 'customer', MN_BENCH_MODEL_TOKEN: 'fixture-model-token' };
  const run = createLocalBenchmarkAdapter({ adapter: 'fixed_workflow', environment, evidenceDirectory: directory,
    ports: { executionMode: 'fixture', modelPort: { extract() {} }, humanReviewPort: {} } });
  assert.equal((await run(request())).reasonCode, 'FIXTURE_PORTS_REQUIRE_FIXTURE_MODE');
});

async function protocolFixture(t, adapter, variant = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'mn-local-adapter-protocol-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = request(adapter); const sha = data => createHash('sha256').update(data).digest('hex');
  const document = { id: 'DEMO-inquiry', version: '1', lines: ['quantity: 2'], contentSha256: sha('quantity: 2') };
  value.input.documents = [document]; value.inputSha256 = configurationDigest(value.input);
  const candidate = { requirements: [] }; const digest = configurationDigest(candidate);
  const pdf = Buffer.from('%PDF-\n' + 'protocol fixture only\n'.repeat(100));
  const trace = []; let requirements = [], quote, approved = false, adopted = false;
  const pkg = { id: 'package', demo: true, contentDigest: 'quote-digest', contentVersion: '1', file: { sha256: sha(pdf) } };
  const environment = { MN_LOCAL_SALES_URL: 'http://127.0.0.1:3101', MN_LOCAL_OS_URL: 'http://127.0.0.1:7331',
    MN_LOCAL_SALES_SESSION: 'fixture-session', MN_LOCAL_OS_TOKEN: 'fixture-os-token', MN_LOCAL_WORKSPACE_ID: 'workspace',
    MN_LOCAL_CUSTOMER_ID: 'customer', MN_BENCH_MODEL_TOKEN: 'fixture-model-token' };
  const modelInvocation = { status: 'fixture', configurationSha256: configurationDigest(value.configuration.model), promptSha256: value.configuration.prompt.sha256 };
  const decision = digest => ({ approved: true, subjectDigest: digest, actorId: 'fixture-reviewer', kind: 'test_fixture' });
  const ports = { executionMode: 'fixture', checkModelReady: async () => true,
    modelPort: { async extract() { assert.equal(adapter, 'fixed_workflow'); return { candidate, modelInvocation }; } },
    readModelEvidence: async () => modelInvocation,
    humanReviewPort: {
      async reviewExtraction(input) { return { ...decision(input.candidateDigest), requirements: [{ field: 'quantity', value: 2, status: 'supported',
        sources: [{ documentId: document.id, version: '1', line: 1 }] }], unresolvedIssues: [],
      quote: { catalog: { name: 'DEMO 阀门', unitPriceCents: 125037 }, quantity: 2, discountBps: 0, taxBasis: 'unit_price_tax_included',
        company: { name: 'DEMO', address: 'DEMO', contact: 'DEMO' }, validUntil: '2099-01-01T00:00:00.000Z',
        issueDate: '2026-09-18', deliveryTerms: 'DEMO', paymentTerms: 'DEMO', priceSources: [{ documentId: document.id, version: '1', line: 1 }] } }; },
      async approveQuote({ quote }) { return variant === 'no_human_approval' ? { approved: false } : decision(quote.digest); },
      async approveAction({ action }) { return decision(action.actionDigest); },
    } };
  const fetch = async (url, init) => {
    const path = new URL(url).pathname; const body = init.body ? JSON.parse(init.body) : undefined;
    trace.push({ path, method: init.method }); let data;
    if (path === '/api/v1/bootstrap') data = { tenant: { demo: variant !== 'real_tenant' } };
    else if (path === '/api/v1/rfqs') data = { id: 'inquiry', revision: 1 };
    else if (path.endsWith('/sources')) data = { inquiry: { id: 'inquiry', revision: 2 }, source: { id: 'source', revision: 1 } };
    else if (path === '/v2/business-candidates' && init.method === 'POST') data = { id: 'candidate' };
    else if (path === '/v2/business-candidates/candidate') data = { id: 'candidate', status: 'completed', candidateDigest: digest };
    else if (path.endsWith('/candidates/candidate')) data = { id: 'candidate', digest, candidate };
    else if (path.endsWith('/candidates/adopt')) { adopted = true; data = { id: 'inquiry', revision: 3 }; }
    else if (path.endsWith('/requirements')) { requirements = body.requirements; data = { id: 'inquiry', revision: 4 }; }
    else if (path.endsWith('/rfq-catalog/import')) data = {};
    else if (path.endsWith('/quotes')) { quote = { contentVersion: '1', digest: 'quote-digest', content: { demo: true,
      items: [{ ...body.items[0], unitPriceCents: 125037 }], subtotalCents: 250074, totalCents: 250074, discountBps: 0,
      taxBasis: body.taxBasis, currency: 'CNY' } }; data = quote; }
    else if (path.endsWith('/approve')) data = { id: 'business-decision', status: 'approved', snapshotVersion: '1' };
    else if (path === '/v2/business-actions') data = { id: 'action' };
    else if (path === '/v2/business-actions/action') data = approved ? { id: 'action', status: 'completed', operationKey: 'opkey', actionDigest: 'action-digest',
      receipt: { packageId: 'package', files: [{ sha256: variant === 'wrong_pdf' ? '0'.repeat(64) : sha(pdf) }] } }
      : { id: 'action', status: 'waiting_approval', actionDigest: 'action-digest', approval: { id: 'approval', streamVersion: 1 } };
    else if (path === '/v2/approvals/approval/decisions') { assert.equal(body.decision, 'approve_once'); approved = true; data = {}; }
    else if (path === '/api/v1/rfqs/inquiry') data = { id: 'inquiry', revision: 5, requirements, quote, packages: approved ? [pkg] : [],
      template: { id: 'template', version: '1' }, renderVersion: 'fixture' };
    else if (path.endsWith('/pdf')) return new Response(pdf);
    else if (path.endsWith('/evidence')) data = variant === 'missing_evidence' ? {} : { classification: 'internal', fileSha256: sha(pdf),
      contentVersion: '1', contentDigest: 'quote-digest', requirementsCsv: 'id,text\nbenchmark-0,quantity', sources: [{ sourceId: 'source', sourceRevision: 1 }] };
    else throw Error('UNEXPECTED_PROTOCOL_PATH');
    return Response.json({ data });
  };
  const run = createLocalBenchmarkAdapter({ adapter, environment, evidenceDirectory: directory, ports, mode: 'fixture', fetch });
  return { result: await run(value), trace, adopted: () => adopted, run, value };
}

for (const adapter of ['fixed_workflow', 'muniu']) test(`协议替身：${adapter}必须经实际接口形状批准出包并核对下载摘要`, async t => {
  const fixture = await protocolFixture(t, adapter);
  assert.equal(fixture.result.status, adapter === 'fixed_workflow' ? 'not_run' : 'completed');
  assert.equal(fixture.result.executionMode, 'fixture'); assert.equal(fixture.result.actual.prices.totalCents, 250074);
  assert.ok(fixture.trace.some(item => item.path === '/v2/approvals/approval/decisions'));
  assert.ok(fixture.trace.some(item => item.path.endsWith('/quote-packages/package/pdf')));
  assert.equal(fixture.adopted(), adapter === 'muniu');
  const calls = fixture.trace.length;
  assert.equal((await fixture.run(fixture.value)).reasonCode, 'RUN_ALREADY_STARTED_OR_EVIDENCE_UNAVAILABLE');
  assert.equal(fixture.trace.length, calls, '同runId不可重新执行业务写入');
});

test('协议替身：下载PDF与OS回执不一致不能报告完成', async t => {
  const { result } = await protocolFixture(t, 'muniu', 'wrong_pdf');
  assert.equal(result.status, 'blocked'); assert.equal(result.reasonCode, 'PACKAGE_FILE_MISMATCH');
});

test('协议替身：内部证据未返回需求与版本不能报告完整业务成果', async t => {
  const { result } = await protocolFixture(t, 'muniu', 'missing_evidence');
  assert.equal(result.status, 'blocked'); assert.equal(result.reasonCode, 'INTERNAL_EVIDENCE_MISMATCH');
});

test('协议替身：无人工核准不自动批准，真实租户在写入前拒绝', async t => {
  const pending = await protocolFixture(t, 'muniu', 'no_human_approval');
  assert.equal(pending.result.status, 'not_run'); assert.equal(pending.result.reasonCode, 'HUMAN_DECISION_REQUIRED');
  assert.ok(!pending.trace.some(item => item.path.endsWith('/approve') || item.path.startsWith('/v2/business-actions')));
  const forbidden = await protocolFixture(t, 'muniu', 'real_tenant');
  assert.equal(forbidden.result.reasonCode, 'REAL_TENANT_FORBIDDEN'); assert.equal(forbidden.trace.length, 1);
});
