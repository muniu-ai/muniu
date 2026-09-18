#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configurationDigest, stripExpected } from './industry-delivery-benchmark.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ensure = (value, code) => { if (!value) throw Error(code); };
const normalSteps = ['import', 'extract_and_review', 'create_current_draft', 'human_approve_current_version', 'export_demo_pdf'];
const sleep = ms => new Promise(done => setTimeout(done, ms));
function serviceUrl(value) {
  const url = new URL(value);
  ensure(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
    && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'LOCAL_SERVICE_URL_INVALID');
  return url;
}
function bindDecision(decision, digest, mode) {
  ensure(decision?.approved === true, 'HUMAN_DECISION_REQUIRED');
  ensure(decision.subjectDigest === digest && typeof decision.actorId === 'string' && decision.actorId, 'HUMAN_DECISION_BINDING_MISMATCH');
  ensure(decision.kind === (mode === 'fixture' ? 'test_fixture' : 'human'), 'HUMAN_DECISION_MODE_MISMATCH');
}
function checkModel(evidence, configuration, mode) {
  ensure(evidence?.configurationSha256 === configurationDigest(configuration.model)
    && evidence.promptSha256 === configuration.prompt.sha256, 'ACTUAL_MODEL_CONFIGURATION_MISMATCH');
  ensure(evidence.status === (mode === 'fixture' ? 'fixture' : 'executed'), 'MODEL_EXECUTION_EVIDENCE_REQUIRED');
  if (mode === 'live') ensure(typeof evidence.providerRequestId === 'string' && evidence.providerRequestId, 'MODEL_REQUEST_EVIDENCE_REQUIRED');
  if (evidence.actualCost !== undefined) ensure(/^[A-Z]{3}$/u.test(evidence.actualCost.currency)
    && /^\d+$/u.test(evidence.actualCost.minorUnits) && typeof evidence.actualCost.source === 'string', 'INVALID_ACTUAL_COST');
  return { status: evidence.status, configurationSha256: evidence.configurationSha256, promptSha256: evidence.promptSha256,
    ...(evidence.providerRequestId ? { providerRequestId: evidence.providerRequestId } : {}),
    ...(evidence.actualCost ? { actualCost: evidence.actualCost } : {}) };
}
function location(ref, documents) {
  const source = documents.find(item => item.document.id === ref.documentId && item.document.version === ref.version);
  ensure(source && Number.isSafeInteger(ref.line) && ref.line > 0 && ref.line <= source.document.lines.length, 'REVIEW_SOURCE_INVALID');
  const start = Array.from(source.document.lines.slice(0, ref.line - 1).join('\n')).length + (ref.line > 1 ? 1 : 0);
  return { sourceId: source.id, sourceRevision: source.revision, page: 1, start, end: start + Array.from(source.document.lines[ref.line - 1]).length };
}

/** Credentials stay in the calling process. Ports are pinned, process-equivalent trusted code. */
export function createLocalBenchmarkAdapter(options) {
  ensure(['fixed_workflow', 'muniu'].includes(options.adapter), 'LOCAL_ADAPTER_INVALID');
  const adapter = options.adapter; const mode = options.mode ?? 'live'; const environment = options.environment ?? process.env;
  const ports = options.ports ?? {}; const callFetch = options.fetch ?? fetch;
  const secrets = ['MN_LOCAL_SALES_SESSION', 'MN_LOCAL_OS_TOKEN', 'MN_BENCH_MODEL_TOKEN', 'MN_BENCH_FIXED_WORKFLOW_TOKEN', 'MN_BENCH_MUNIU_TOKEN']
    .map(key => environment[key]).filter(Boolean);
  const assertNoSecret = value => ensure(!secrets.some(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]
    .some(encoded => value.includes(encoded))), 'CREDENTIAL_IN_BUSINESS_EVIDENCE');
  return async request => {
    ensure(request?.schemaVersion === 1 && request.adapter === adapter && request.caseId === request.input?.caseId
      && typeof request.runId === 'string' && request.runId && request.configurationSha256 === configurationDigest(request.configuration)
      && request.inputSha256 === configurationDigest(request.input), 'BENCHMARK_REQUEST_BINDING_INVALID');
    ensure(configurationDigest(stripExpected(request.input)) === request.inputSha256, 'EXPECTED_DATA_FORBIDDEN');
    assertNoSecret(JSON.stringify(request));
    ensure(request.input.fictional === true && request.input.permittedUse === 'demo_only'
      && request.input.outputPolicy.allowExternalSend === false && request.input.outputPolicy.allowRealQuoteExport === false, 'DEMO_BOUNDARY_REQUIRED');
    const envelope = { schemaVersion: 1, adapter, runId: request.runId, caseId: request.caseId,
      configurationSha256: request.configurationSha256, inputSha256: request.inputSha256, executionMode: mode,
      comparisonScope: adapter === 'fixed_workflow' ? 'fixed_extraction_with_muniu_execution' : 'muniu_reference_application',
      comparativeEligibility: adapter === 'fixed_workflow' ? 'internal_ablation_only' : 'scenario_only' };
    const unavailable = reasonCode => ({ ...envelope, status: 'not_run', reasonCode, criticalFailures: [] });
    if (JSON.stringify(request.input.steps.map(step => step.action)) !== JSON.stringify(normalSteps)) return unavailable('SCENARIO_NOT_IMPLEMENTED');
    const names = ['MN_LOCAL_SALES_URL', 'MN_LOCAL_OS_URL', 'MN_LOCAL_SALES_SESSION', 'MN_LOCAL_OS_TOKEN', 'MN_LOCAL_WORKSPACE_ID', 'MN_LOCAL_CUSTOMER_ID', 'MN_BENCH_MODEL_TOKEN'];
    if (names.some(name => !environment[name]) || !options.evidenceDirectory) return unavailable('LOCAL_ADAPTER_CONFIGURATION_REQUIRED');
    if (mode !== 'fixture' && ports.executionMode === 'fixture') return unavailable('FIXTURE_PORTS_REQUIRE_FIXTURE_MODE');
    if (!['live', 'fixture'].includes(mode) || ports.executionMode !== mode) return unavailable('TRUSTED_PORT_MODE_REQUIRED');
    if (mode === 'live' && !/^[a-f0-9]{64}$/u.test(options.configurationSha256 ?? '')) return unavailable('FROZEN_CONFIGURATION_REQUIRED');
    if (options.configurationSha256) ensure(options.configurationSha256 === request.configurationSha256, 'FROZEN_CONFIGURATION_MISMATCH');
    if (['reviewExtraction', 'approveQuote', 'approveAction'].some(name => typeof ports.humanReviewPort?.[name] !== 'function')) return unavailable('HUMAN_REVIEW_PORT_REQUIRED');
    if (adapter === 'fixed_workflow' ? typeof ports.modelPort?.extract !== 'function' : typeof ports.readModelEvidence !== 'function') return unavailable('MODEL_ADAPTER_OR_EVIDENCE_REQUIRED');
    if (typeof ports.checkModelReady !== 'function' || !(await ports.checkModelReady({ configuration: request.configuration, adapter }))) return unavailable('MODEL_CONFIGURATION_NOT_READY');
    ensure(isAbsolute(options.evidenceDirectory), 'PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
    const sales = serviceUrl(environment.MN_LOCAL_SALES_URL), os = serviceUrl(environment.MN_LOCAL_OS_URL);
    const directory = join(options.evidenceDirectory, hash(request.runId));
    await mkdir(options.evidenceDirectory, { recursive: true, mode: 0o700 });
    try { await mkdir(directory, { mode: 0o700 }); } catch { return unavailable('RUN_ALREADY_STARTED_OR_EVIDENCE_UNAVAILABLE'); }
    const trace = []; let ordinal = 0; const artifacts = []; let inquiry; let modelInvocation;
    const record = async (name, bytes) => { assertNoSecret(bytes.toString()); await writeFile(join(directory, name), bytes, { mode: 0o600, flag: 'wx' }); return { path: `${hash(request.runId)}/${name}`, sha256: hash(bytes), byteLength: Buffer.byteLength(bytes) }; };
    const send = async (service, method, path, body, revision, binary = false) => {
      const step = ordinal++; const headers = service === 'sales' ? { cookie: `muniu_session=${environment.MN_LOCAL_SALES_SESSION}`,
        origin: environment.MN_LOCAL_SALES_ORIGIN ?? 'http://localhost:3000' } : { authorization: `Bearer ${environment.MN_LOCAL_OS_TOKEN}` };
      if (body !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'Idempotency-Key': hash(`${request.runId}:${step}`) });
      if (revision !== undefined) headers['If-Match'] = String(revision);
      const result = await callFetch(new URL(path, service === 'sales' ? sales : os), { method, headers, redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(options.requestTimeoutMs ?? 30_000) });
      const raw = Buffer.from(await result.arrayBuffer()); ensure(raw.length <= 10_000_000, 'BUSINESS_RESPONSE_TOO_LARGE');
      trace.push({ service, method, path, status: result.status, ...(body === undefined ? {} : { requestSha256: configurationDigest(body) }), responseSha256: hash(raw) });
      ensure(result.ok, 'BUSINESS_HTTP_REJECTED');
      if (binary) return raw;
      const value = JSON.parse(raw); return value.data ?? value;
    };
    const current = () => send('sales', 'GET', `/api/v1/rfqs/${inquiry.id}`);
    const wait = async (path, wanted) => {
      const deadline = Date.now() + (options.pollTimeoutMs ?? 90_000);
      while (Date.now() < deadline) {
        if (mode === 'fixture') await ports.driveWorkers?.();
        const value = await send('os', 'GET', path);
        if (wanted(value)) return value;
        ensure(!['failed', 'rejected', 'needs_reconciliation', 'terminated'].includes(value.status), 'BUSINESS_EXECUTION_UNCONFIRMED');
        await sleep(options.pollIntervalMs ?? 200);
      }
      throw Error('BUSINESS_EXECUTION_UNCONFIRMED');
    };
    try {
      const bootstrap = await send('sales', 'GET', '/api/v1/bootstrap');
      ensure(bootstrap.tenant?.demo === true, 'REAL_TENANT_FORBIDDEN');
      ensure(Array.isArray(request.input.documents) && request.input.documents.length > 0, 'DOCUMENTS_REQUIRED');
      inquiry = await send('sales', 'POST', '/api/v1/rfqs', { customerId: environment.MN_LOCAL_CUSTOMER_ID, title: `DEMO ${request.caseId} ${adapter}` });
      const documents = [];
      for (const document of request.input.documents) {
        const raw = Buffer.from(document.lines.join('\n'));
        ensure(hash(raw) === document.contentSha256, 'DOCUMENT_DIGEST_MISMATCH');
        const added = await send('sales', 'POST', `/api/v1/rfqs/${inquiry.id}/sources`, { name: `${document.id}.txt`, mime: 'text/plain', base64: raw.toString('base64') }, inquiry.revision);
        inquiry = added.inquiry; documents.push({ document, id: added.source.id, revision: added.source.revision });
      }
      let candidate, candidateState, candidateEnvelope;
      if (adapter === 'muniu') {
        const queued = await send('os', 'POST', '/v2/business-candidates', { expectedStreamVersion: 0,
          workspaceId: environment.MN_LOCAL_WORKSPACE_ID, customerId: environment.MN_LOCAL_CUSTOMER_ID, inquiryId: inquiry.id, inquiryRevision: String(inquiry.revision) });
        candidateState = await wait(`/v2/business-candidates/${queued.id}`, state => state.status === 'completed');
        candidateEnvelope = await send('sales', 'GET', `/api/v1/rfqs/${inquiry.id}/candidates/${queued.id}`);
        ensure(candidateEnvelope.digest === candidateState.candidateDigest, 'PROTECTED_CANDIDATE_DIGEST_MISMATCH');
        candidate = candidateEnvelope.candidate;
        modelInvocation = checkModel(await ports.readModelEvidence({ candidateState, configuration: request.configuration }), request.configuration, mode);
      } else {
        const extraction = await ports.modelPort.extract({ runId: request.runId, configuration: request.configuration,
          input: request.input, modelToken: environment.MN_BENCH_MODEL_TOKEN });
        candidate = extraction.candidate; modelInvocation = checkModel(extraction.modelInvocation, request.configuration, mode);
      }
      assertNoSecret(JSON.stringify({ candidate, modelInvocation }));
      const review = await ports.humanReviewPort.reviewExtraction({ runId: request.runId, configuration: request.configuration,
        input: request.input, inputSha256: request.inputSha256, candidate, candidateDigest: configurationDigest(candidate), documents });
      bindDecision(review, configurationDigest(candidate), mode);
      assertNoSecret(JSON.stringify(review));
      ensure(Array.isArray(review.requirements) && review.requirements.length > 0 && Array.isArray(review.unresolvedIssues), 'REVIEW_RESULT_REQUIRED');
      if (review.unresolvedIssues.length) {
        const result = { ...unavailable('HUMAN_CLARIFICATION_REQUIRED'), businessEvidence: { inquiryId: inquiry.id } };
        await record('result.json', JSON.stringify(result)); return result;
      }
      if (candidateEnvelope) inquiry = await send('sales', 'POST', `/api/v1/rfqs/${inquiry.id}/candidates/adopt`,
        { candidateId: candidateState.id, digest: candidateEnvelope.digest }, inquiry.revision);
      const rows = review.requirements.map((r, i) => {
        ensure(r.status === 'supported' && typeof r.field === 'string' && Array.isArray(r.sources) && r.sources.length === 1, 'REVIEW_REQUIREMENT_UNSUPPORTED');
        return { id: `benchmark-${i}`, text: JSON.stringify({ field: r.field, value: r.value, status: r.status }),
          kind: 'fact', confirmed: true, critical: true, source: location(r.sources[0], documents) };
      });
      inquiry = await send('sales', 'PUT', `/api/v1/rfqs/${inquiry.id}/requirements`, { requirements: rows, conflicts: [] }, inquiry.revision);
      const plan = review.quote;
      ensure(plan && Number.isSafeInteger(plan.catalog?.unitPriceCents) && plan.catalog.unitPriceCents >= 0
        && Array.isArray(plan.priceSources) && plan.priceSources.length > 0, 'REVIEW_QUOTE_PLAN_REQUIRED');
      plan.priceSources.forEach(ref => location(ref, documents));
      const catalogId = `DEMO-${hash(request.runId).slice(0, 20)}`;
      const csv = `id,revision,name,unitPriceCents\n${catalogId},1,"${String(plan.catalog.name).replaceAll('"', '""')}",${plan.catalog.unitPriceCents}`;
      await send('sales', 'POST', '/api/v1/rfq-catalog/import', { csv });
      const quote = await send('sales', 'POST', `/api/v1/rfqs/${inquiry.id}/quotes`, { items: [{ catalogItemId: catalogId, catalogRevision: 1, quantity: plan.quantity }],
        discountBps: plan.discountBps, taxBasis: plan.taxBasis, company: plan.company, validUntil: plan.validUntil,
        deliveryTerms: plan.deliveryTerms, paymentTerms: plan.paymentTerms }, inquiry.revision);
      ensure(quote.content.demo === true, 'REAL_QUOTE_FORBIDDEN'); inquiry = await current();
      const businessApproval = await ports.humanReviewPort.approveQuote({ runId: request.runId, quote, configuration: request.configuration });
      bindDecision(businessApproval, quote.digest, mode);
      const decision = await send('sales', 'POST', `/api/v1/rfqs/${inquiry.id}/approve`, { contentVersion: quote.contentVersion, digest: quote.digest }, inquiry.revision);
      const action = await send('os', 'POST', '/v2/business-actions', { schemaVersion: '1', action: 'issueQuotePackage', expectedStreamVersion: 0,
        workspaceId: environment.MN_LOCAL_WORKSPACE_ID, customerId: environment.MN_LOCAL_CUSTOMER_ID, quoteId: inquiry.id, quoteVersion: quote.contentVersion,
        decisionId: decision.id, templateId: inquiry.template.id, templateVersion: inquiry.template.version, renderVersion: inquiry.renderVersion,
        exportFormat: 'pdf', issueDate: plan.issueDate });
      const pending = await wait(`/v2/business-actions/${action.id}`, value => value.status === 'waiting_approval' && value.approval);
      const executionApproval = await ports.humanReviewPort.approveAction({ runId: request.runId, action: pending, configuration: request.configuration });
      bindDecision(executionApproval, pending.actionDigest, mode);
      await send('os', 'POST', `/v2/approvals/${pending.approval.id}/decisions`, { expectedStreamVersion: pending.approval.streamVersion, decision: 'approve_once' });
      const completed = await wait(`/v2/business-actions/${action.id}`, value => value.status === 'completed');
      inquiry = await current();
      ensure(inquiry.packages.length === 1 && completed.receipt?.packageId === inquiry.packages[0].id, 'PACKAGE_RECEIPT_MISMATCH');
      const pkg = inquiry.packages[0];
      ensure(pkg.demo === true && pkg.contentDigest === quote.digest && pkg.contentVersion === quote.contentVersion, 'PACKAGE_SNAPSHOT_MISMATCH');
      const pdf = await send('sales', 'GET', `/api/v1/quote-packages/${pkg.id}/pdf`, undefined, undefined, true);
      ensure(pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 1000
        && hash(pdf) === pkg.file.sha256 && completed.receipt.files.some(file => file.sha256 === hash(pdf)), 'PACKAGE_FILE_MISMATCH');
      artifacts.push(await record('DEMO-quote.pdf', pdf));
      const proof = await send('sales', 'GET', `/api/v1/quote-packages/${pkg.id}/evidence`);
      ensure(proof.classification === 'internal' && proof.fileSha256 === hash(pdf) && proof.contentVersion === pkg.contentVersion
        && proof.contentDigest === quote.digest && typeof proof.requirementsCsv === 'string' && proof.requirementsCsv.length > 0
        && Array.isArray(proof.sources) && proof.sources.length > 0, 'INTERNAL_EVIDENCE_MISMATCH');
      artifacts.push(await record('internal-evidence.json', JSON.stringify(proof)));
      const actualRequirements = inquiry.requirements.map(row => {
        const source = documents.find(item => item.id === row.source?.sourceId && item.revision === row.source.sourceRevision);
        ensure(source && row.confirmed === true, 'STORED_REQUIREMENT_MISMATCH');
        const offset = Array.from(source.document.lines.join('\n')).slice(0, row.source.start).join('');
        return { ...JSON.parse(row.text), sources: [{ documentId: source.document.id, version: source.document.version, line: offset.split('\n').length }] };
      });
      const money = inquiry.quote.content;
      const actual = { requirements: actualRequirements, unresolvedIssues: [], effectiveQuoteVersion: Number(inquiry.quote.contentVersion),
        prices: { status: 'calculated_from_demo_sources', currency: money.currency, unitPriceCents: money.items[0].unitPriceCents,
          quantity: money.items[0].quantity, subtotalCents: money.subtotalCents, discountBps: money.discountBps, taxBasis: money.taxBasis,
          taxCalculation: 'OUT_OF_SCOPE', totalCents: money.totalCents, sources: plan.priceSources },
        formalDemoExport: 'allowed_after_current_version_human_approval', outputs: ['requirements_with_sources', 'unresolved_issue_list', 'version_history', 'demo_watermark'],
        approvals: [{ kind: 'human', status: decision.status, version: Number(decision.snapshotVersion) }],
        exports: [{ format: 'pdf', classification: 'demo', version: Number(pkg.contentVersion), sha256: hash(pdf) }],
        sideEffects: [{ action: 'issue_demo_quote_package', status: 'performed', packageId: pkg.id }],
        stepResults: normalSteps.map(action => ({ action, status: 'completed' })) };
      const businessEvidence = { inquiryId: inquiry.id, ...(candidateState ? { candidateId: candidateState.id } : {}),
        businessDecisionId: decision.id, actionId: completed.id, actionDigest: completed.actionDigest,
        operationKey: completed.operationKey, packageId: pkg.id, fileSha256: hash(pdf), artifacts };
      const result = { ...envelope, status: adapter === 'fixed_workflow' ? 'not_run' : 'completed',
        ...(adapter === 'fixed_workflow' ? { reasonCode: 'INTERNAL_ABLATION_ONLY', ablationStatus: 'completed' } : {}),
        actual, modelInvocation, businessEvidence, criticalFailures: [] };
      await record('result.json', JSON.stringify(result)); return result;
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{0,95}$/u.test(error?.message) ? error.message : 'LOCAL_BUSINESS_RESULT_UNCONFIRMED';
      const awaitingHuman = code === 'HUMAN_DECISION_REQUIRED';
      const result = { ...envelope, status: awaitingHuman ? 'not_run' : 'blocked', reasonCode: code, criticalFailures: awaitingHuman ? [] : [{ code }],
        ...(inquiry ? { businessEvidence: { inquiryId: inquiry.id, artifacts } } : {}) };
      await record('result.json', JSON.stringify(result)); return result;
    } finally { await record('http-evidence.json', JSON.stringify(trace)); }
  };
}

export function createLocalBenchmarkShim(options) {
  const run = createLocalBenchmarkAdapter(options); const token = options.token;
  ensure(typeof token === 'string' && token.length >= 16, 'ADAPTER_BEARER_REQUIRED');
  return createServer(async (req, res) => {
    try {
      const supplied = req.headers.authorization?.match(/^Bearer ([^\r\n]+)$/u)?.[1] ?? '';
      ensure(Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token)), 'ADAPTER_AUTHENTICATION_REQUIRED');
      ensure(req.method === 'POST' && req.url === '/v1/benchmark/run', 'ADAPTER_ROUTE_NOT_FOUND');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; ensure(size <= 4_194_304, 'REQUEST_TOO_LARGE'); chunks.push(chunk); }
      const result = await run(JSON.parse(Buffer.concat(chunks)));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(422, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'LOCAL_ADAPTER_REQUEST_REJECTED' })); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
  try {
    ensure(isAbsolute(arg('--module') ?? '') && isAbsolute(arg('--evidence') ?? '') && isAbsolute(arg('--config') ?? ''), 'TRUSTED_MODULE_AND_EVIDENCE_REQUIRED');
    const configuration = JSON.parse(await readFile(arg('--config'), 'utf8'));
    const ports = await (await import(pathToFileURL(arg('--module')).href)).createLocalBenchmarkPorts({ environment: process.env });
    const adapter = arg('--adapter');
    const server = createLocalBenchmarkShim({ adapter, ports, configurationSha256: configurationDigest(configuration), evidenceDirectory: arg('--evidence'), environment: process.env,
      token: process.env[`MN_BENCH_${String(adapter).toUpperCase()}_TOKEN`], mode: process.argv.includes('--fixture') ? 'fixture' : 'live' });
    await new Promise(done => server.listen(Number(arg('--port') ?? 3199), '127.0.0.1', done));
    process.stdout.write('本地 DEMO 基准适配服务已启动。\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  } catch { process.stderr.write('本地基准适配服务配置无效。\n'); process.exitCode = 1; }
}
