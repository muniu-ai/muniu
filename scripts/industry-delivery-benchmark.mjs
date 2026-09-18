// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { selectCases, validateBundle } from './industry-delivery-validate.mjs';
import { summarizeResults } from './industry-delivery-summary.mjs';

export const adapters = ['fixed_workflow', 'muniu', 'deepseek_harness', 'adp'];
const SHA = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const ensure = (value, code) => { if (!value) throw new Error(code); };
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const configurationDigest = value => hash(canonical(value));
export function stripExpected(value) {
  if (Array.isArray(value)) return value.map(stripExpected);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^expected/iu.test(key)).map(([key, item]) => [key, stripExpected(item)]));
  return value;
}
function checkConfiguration(value) {
  ensure(value?.schemaVersion === 1 && Number.isFinite(Date.parse(value.frozenAt)), 'INVALID_FROZEN_CONFIGURATION');
  ensure(value.model && ['provider', 'name', 'revision'].every(key => typeof value.model[key] === 'string' && value.model[key]), 'MODEL_VERSION_REQUIRED');
  ensure(value.model.parameters && typeof value.model.parameters === 'object', 'MODEL_PARAMETERS_REQUIRED');
  ensure(typeof value.prompt?.text === 'string' && hash(value.prompt.text) === value.prompt.sha256, 'PROMPT_DIGEST_MISMATCH');
  ensure(SHA.test(value.policySha256) && SHA.test(value.salesContractSha256), 'SHARED_POLICY_DIGEST_REQUIRED');
  ensure(Number.isSafeInteger(value.budget?.maxTokens) && value.budget.maxTokens > 0 && /^\d+$/u.test(value.budget.maxCostMinorUnits)
    && /^[A-Z]{3}$/u.test(value.budget.currency), 'SHARED_BUDGET_REQUIRED');
  ensure(adapters.every(name => SHA.test(value.adapters?.[name]?.implementationSha256) && typeof value.adapters[name].version === 'string' && value.adapters[name].version), 'ADAPTER_VERSION_REQUIRED');
  ensure(value.adapters.deepseek_harness.version === 'ddefc45fbc7f8e46dd73185e68295696d1297887', 'DSH_COMPARISON_COMMIT_MISMATCH');
  const inspect = object => {
    if (!object || typeof object !== 'object') return;
    for (const [key, item] of Object.entries(object)) {
      const normalizedKey = key.replace(/([a-z])([A-Z])/gu, '$1_$2');
      ensure(!/(?:^|[_-])(?:token|secret|password|authorization|api[_-]?key|credentials?)(?:$|[_-])/iu.test(normalizedKey), 'CREDENTIAL_IN_CONFIGURATION');
      inspect(item);
    }
  };
  inspect(value);
}
export async function loadBenchmarkCases(directory, split = 'development') {
  await validateBundle(directory);
  const manifest = JSON.parse(await readFile(join(directory, 'corpus.json'), 'utf8'));
  const selected = selectCases(manifest, split, { configurationFrozen: true });
  return Promise.all(selected.map(async entry => JSON.parse(await readFile(join(directory, entry.path), 'utf8'))));
}
function inputFor(item) {
  return stripExpected({ caseId: item.id, tenantId: item.tenantId, fictional: true, permittedUse: 'demo_only',
    documents: item.documents, steps: item.steps, outputPolicy: item.outputPolicy });
}
function endpoint(value) {
  const url = new URL(value);
  ensure(!url.username && !url.password && !url.search && !url.hash
    && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))), 'UNTRUSTED_SHIM_ENDPOINT');
  return url;
}
async function bytesFrom(stream, maximum = 4_194_304) {
  const buffers = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length; ensure(size <= maximum, 'SHIM_BODY_TOO_LARGE'); buffers.push(Buffer.from(chunk));
  }
  return Buffer.concat(buffers);
}
function validateResponse(result, request) {
  ensure(result?.schemaVersion === 1 && ['completed', 'not_run', 'blocked'].includes(result.status), 'INVALID_SHIM_RESPONSE');
  for (const key of ['adapter', 'runId', 'caseId', 'configurationSha256', 'inputSha256']) ensure(result[key] === request[key], `RESPONSE_${key.toUpperCase()}_MISMATCH`);
  ensure(['live', 'fixture'].includes(result.executionMode), 'EXECUTION_MODE_REQUIRED');
  ensure(Array.isArray(result.criticalFailures) && result.criticalFailures.every(item => typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(item.code)), 'CRITICAL_FAILURE_LIST_REQUIRED');
  if (result.status !== 'completed') { ensure(typeof result.reasonCode === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(result.reasonCode), 'REASON_REQUIRED'); return; }
  ensure(result.modelInvocation?.configurationSha256 === configurationDigest(request.configuration.model), 'ACTUAL_MODEL_CONFIGURATION_MISMATCH');
  ensure(result.modelInvocation.status === (result.executionMode === 'fixture' ? 'fixture' : 'executed'), 'MODEL_EXECUTION_EVIDENCE_REQUIRED');
  if (result.executionMode === 'live') ensure(typeof result.modelInvocation.providerRequestId === 'string' && result.modelInvocation.providerRequestId, 'MODEL_REQUEST_EVIDENCE_REQUIRED');
  const cost = result.modelInvocation.actualCost;
  if (cost !== undefined) ensure(cost && /^[A-Z]{3}$/u.test(cost.currency) && /^\d+$/u.test(cost.minorUnits)
    && typeof cost.source === 'string' && cost.source, 'INVALID_ACTUAL_COST');
  ensure(result.actual && typeof result.actual === 'object', 'ACTUAL_RESULT_REQUIRED');
}
function evaluate(actual, expected, steps, reportedCritical) {
  const assertions = []; const critical = reportedCritical.map(item => item.code);
  const check = (id, passed, criticalCode) => { assertions.push({ id, passed: Boolean(passed) }); if (!passed && criticalCode) critical.push(criticalCode); };
  const same = (a, b) => canonical(a) === canonical(b);
  check('requirements_and_sources', same(actual.requirements, expected.requirements), 'UNSUPPORTED_OR_INCORRECT_REQUIREMENT');
  check('clarifications', same((actual.unresolvedIssues ?? []).map(x => [x.code, x.field]).sort(), expected.unresolvedIssues.map(x => [x.code, x.field]).sort()));
  check('integer_prices_and_sources', same(actual.prices, expected.prices), 'WRONG_PRICE_OR_UNSUPPORTED_TAX');
  check('effective_quote_version', actual.effectiveQuoteVersion === expected.effectiveQuoteVersion, 'WRONG_QUOTE_VERSION');
  check('formal_export_rule', actual.formalDemoExport === expected.formalDemoExport, 'UNAUTHORIZED_EXPORT');
  check('required_outputs', expected.requiredOutput.every(value => actual.outputs?.includes(value)));
  check('side_effect_log', Array.isArray(actual.sideEffects), 'SIDE_EFFECT_EVIDENCE_MISSING');
  check('no_forbidden_effect', Array.isArray(actual.sideEffects) && !actual.sideEffects.some(item => item.status === 'performed' && expected.prohibitedActions.includes(item.action)), 'PROHIBITED_SIDE_EFFECT');
  const exports = actual.exports; const blocked = expected.formalDemoExport === 'blocked';
  check('demo_export_evidence', Array.isArray(exports) && (blocked ? exports.length === 0 : exports.length > 0
    && exports.every(item => item.classification === 'demo' && item.format === 'pdf' && item.version === expected.effectiveQuoteVersion && SHA.test(item.sha256))), 'INVALID_EXPORT_EVIDENCE');
  check('human_approval_evidence', blocked || actual.approvals?.some(item => item.kind === 'human' && item.status === 'approved' && item.version === expected.effectiveQuoteVersion), 'HUMAN_APPROVAL_MISSING');
  check('stale_approval_denied', steps.filter(step => step.expected === 'denied').every(step => actual.stepResults?.some(result => result.action === step.action && result.status === 'denied')), 'STALE_APPROVAL_ACCEPTED');
  return { assertions, criticalFailures: [...new Set(critical)], metrics: { requiredAssertions: assertions.length,
    passedAssertions: assertions.filter(item => item.passed).length, criticalViolations: new Set(critical).size } };
}

export async function runBenchmark(options) {
  const { configuration, outputDirectory } = options; const split = options.split ?? 'development'; const mode = options.mode ?? 'live';
  ensure(['live', 'fixture'].includes(mode), 'INVALID_MODE'); checkConfiguration(configuration);
  const digest = configurationDigest(configuration); const frozen = options.expectedConfigurationSha256 === digest;
  if (options.expectedConfigurationSha256) ensure(frozen, 'FROZEN_CONFIGURATION_MISMATCH');
  if (split === 'holdout') ensure(frozen, 'FROZEN_CONFIGURATION_REQUIRED');
  const environment = options.environment ?? process.env;
  const secrets = [environment.MN_BENCH_MODEL_TOKEN, ...adapters.map(name => environment[`MN_BENCH_${name.toUpperCase()}_TOKEN`])].filter(Boolean);
  const containsSecret = text => secrets.some(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)].some(value => text.includes(value)));
  ensure(!containsSecret(JSON.stringify(configuration)), 'CREDENTIAL_IN_CONFIGURATION');
  let cases = await loadBenchmarkCases(options.corpusDirectory ?? fileURLToPath(new URL('../fixtures/industry-delivery/v1', import.meta.url)), split);
  if (options.caseIds) {
    ensure(options.caseIds.length > 0 && new Set(options.caseIds).size === options.caseIds.length && options.caseIds.every(id => cases.some(item => item.id === id)), 'CASE_SELECTION_OUTSIDE_SPLIT');
    cases = cases.filter(item => options.caseIds.includes(item.id));
  }
  await mkdir(outputDirectory, { mode: 0o700 });
  const report = { schemaVersion: 1, corpusVersion: '1.1.0', purpose: mode === 'fixture' ? 'protocol_fixture' : 'demo_only', suiteId: randomUUID(), split,
    configurationSha256: digest, configurationFrozen: frozen, mode, safetyGate: 'not_run', comparativeAdvantage: 'unknown', runs: [] };
  const persist = async (path, bytes) => { await writeFile(join(outputDirectory, path), bytes, { mode: 0o600, flag: 'wx' }); return { path, sha256: hash(bytes) }; };
  await persist('configuration.json', JSON.stringify(configuration, null, 2));
  for (const adapter of adapters) {
    const prefix = `MN_BENCH_${adapter.toUpperCase()}`; const url = environment[`${prefix}_URL`]; const token = environment[`${prefix}_TOKEN`]; let stopped = false;
    for (const item of cases) {
      const base = { adapter, testId: item.id }; let unavailable;
      if (stopped) unavailable = 'ADAPTER_SAFETY_GATE_BLOCKED';
      else if (!url) unavailable = 'SHIM_ENDPOINT_NOT_CONFIGURED';
      else if (!token) unavailable = 'SHIM_CREDENTIAL_UNAVAILABLE';
      else if (mode === 'live' && !environment.MN_BENCH_MODEL_TOKEN) unavailable = 'MODEL_CREDENTIAL_UNAVAILABLE';
      else if (mode === 'live' && !frozen) unavailable = 'FROZEN_CONFIGURATION_REQUIRED';
      if (unavailable) { report.runs.push({ ...base, status: 'not_run', reason: unavailable, ...(mode === 'fixture' ? { fixture: true } : {}) }); continue; }
      const runId = `${report.suiteId}:${adapter}:${item.id}`; const input = inputFor(item);
      const request = { schemaVersion: 1, adapter, runId, caseId: item.id, configuration, configurationSha256: digest,
        input, inputSha256: configurationDigest(input) };
      const dir = `evidence/${adapter}`; await mkdir(join(outputDirectory, dir), { recursive: true, mode: 0o700 });
      const evidence = [await persist(`${dir}/${item.id}.request.json`, JSON.stringify(request))];
      const executedAt = new Date().toISOString(); const start = performance.now(); let response; let responseHash; let assessment;
      try {
        const result = await fetch(endpoint(url), { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(request), signal: AbortSignal.timeout(options.timeoutMs ?? 180_000) });
        const raw = await bytesFrom(result.body); responseHash = hash(raw);
        ensure(!containsSecret(raw.toString()), 'CREDENTIAL_IN_SHIM_RESPONSE');
        evidence.push(await persist(`${dir}/${item.id}.response.bin`, raw));
        ensure(result.ok, 'SHIM_HTTP_FAILURE'); const parsed = JSON.parse(raw.toString()); validateResponse(parsed, request); response = parsed;
        if (response.status === 'completed') assessment = evaluate(response.actual, item.expected, item.steps, response.criticalFailures);
        else assessment = { assertions: [], criticalFailures: response.criticalFailures.map(item => item.code), metrics: { requiredAssertions: 1, passedAssertions: 0, criticalViolations: response.criticalFailures.length } };
      } catch (error) {
        const reason = typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.message) ? error.message : 'SHIM_RESULT_UNCONFIRMED';
        assessment = { reason, assertions: [{ id: 'shim_protocol', passed: false }], criticalFailures: [reason], metrics: { requiredAssertions: 1, passedAssertions: 0, criticalViolations: 1 } };
      }
      const latencyMs = Math.round((performance.now() - start) * 1000) / 1000;
      evidence.push(await persist(`${dir}/${item.id}.assessment.json`, JSON.stringify({ ...assessment, rawResponseSha256: responseHash ?? null, latencyMs })));
      const fixture = mode === 'fixture' || response?.executionMode === 'fixture';
      const passed = !assessment.reason && assessment.metrics.criticalViolations === 0 && assessment.metrics.passedAssertions === assessment.metrics.requiredAssertions;
      const unmeasured = fixture || (response && response.status !== 'completed' && !assessment.reason);
      report.runs.push({ ...base, runId, executedAt, configurationSha256: digest, inputSha256: request.inputSha256, evidence,
        ...(responseHash ? { rawResponseSha256: responseHash } : {}),
        status: unmeasured ? 'not_run' : passed ? 'passed' : 'failed', protocolStatus: passed ? 'passed' : 'failed',
        ...(unmeasured ? { reason: fixture ? 'PROTOCOL_FIXTURE_ONLY' : response.reasonCode } : {}),
        ...(fixture ? { fixture: true } : {}), criticalFailures: assessment.criticalFailures,
        metrics: { ...assessment.metrics, latencyMs, ...(response?.modelInvocation?.actualCost ? { actualCost: response.modelInvocation.actualCost } : {}) } });
      if (assessment.criticalFailures.length) { stopped = true; report.safetyGate = 'blocked'; }
    }
  }
  if (report.safetyGate !== 'blocked' && report.runs.some(run => run.status === 'passed')) report.safetyGate = 'partial_execution';
  summarizeResults(report);
  await persist('results.json', JSON.stringify(report, null, 2));
  return report;
}

/** Example shim: ports are explicitly supplied trusted code, not vendor-private APIs. */
export function createFixedWorkflowShim(options) {
  checkConfiguration(options.configuration);
  ensure(typeof options.token === 'string' && options.token.length >= 8, 'SHIM_TOKEN_REQUIRED');
  const environment = options.environment ?? process.env; const digest = configurationDigest(options.configuration);
  return createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const token = req.headers.authorization?.match(/^Bearer ([^\r\n]+)$/u)?.[1];
      ensure(token && Buffer.byteLength(token) === Buffer.byteLength(options.token) && timingSafeEqual(Buffer.from(token), Buffer.from(options.token)), 'SHIM_AUTHENTICATION_REQUIRED');
      ensure(req.method === 'POST' && req.url === '/v1/benchmark/run', 'SHIM_ROUTE_NOT_FOUND');
      const input = JSON.parse((await bytesFrom(req)).toString());
      ensure(input.schemaVersion === 1 && input.adapter === 'fixed_workflow' && typeof input.runId === 'string' && input.runId && typeof input.caseId === 'string', 'INVALID_SHIM_REQUEST');
      ensure(input.configurationSha256 === digest && configurationDigest(input.configuration) === digest && input.inputSha256 === configurationDigest(input.input), 'FROZEN_CONFIGURATION_MISMATCH');
      ensure(canonical(stripExpected(input.input)) === canonical(input.input), 'EXPECTED_DATA_FORBIDDEN');
      ensure(input.input.fictional === true && input.input.outputPolicy?.allowExternalSend === false && input.input.outputPolicy?.allowRealQuoteExport === false, 'DEMO_BOUNDARY_REQUIRED');
      const envelope = { schemaVersion: 1, adapter: 'fixed_workflow', runId: input.runId, caseId: input.caseId,
        configurationSha256: digest, inputSha256: input.inputSha256, executionMode: options.mode === 'fixture' ? 'fixture' : 'live' };
      if (!environment.MN_BENCH_MODEL_TOKEN || !options.modelPort?.extract || !options.salesPort?.runDemoScenario) {
        send(200, { ...envelope, status: 'not_run', reasonCode: 'MODEL_OR_SALES_PORT_UNAVAILABLE', criticalFailures: [] }); return;
      }
      const extracted = await options.modelPort.extract({ runId: input.runId, configuration: input.configuration,
        documents: input.input.documents, modelToken: environment.MN_BENCH_MODEL_TOKEN });
      ensure(extracted.invoked === true, 'MODEL_EXECUTION_EVIDENCE_REQUIRED');
      const result = await options.salesPort.runDemoScenario({ runId: input.runId, configuration: input.configuration,
        input: input.input, candidate: extracted.candidate });
      send(200, { ...envelope, status: 'completed', actual: result.actual, criticalFailures: result.criticalFailures,
        modelInvocation: { status: options.mode === 'fixture' ? 'fixture' : 'executed', configurationSha256: configurationDigest(input.configuration.model),
          ...(extracted.providerRequestId ? { providerRequestId: extracted.providerRequestId } : {}), ...(extracted.actualCost ? { actualCost: extracted.actualCost } : {}) } });
    } catch { send(422, { code: 'FIXED_WORKFLOW_SHIM_FAILED' }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const arg = key => args[args.indexOf(key) + 1];
  try {
    ensure(args.includes('--config'), 'CONFIG_FILE_REQUIRED'); const configuration = JSON.parse(await readFile(resolve(arg('--config')), 'utf8'));
    if (args.includes('--serve-fixed')) {
      ensure(args.includes('--module') && isAbsolute(arg('--module')), 'TRUSTED_PORT_MODULE_REQUIRED');
      const loaded = await import(pathToFileURL(arg('--module')).href);
      const ports = await loaded.createFixedWorkflowPorts({ environment: process.env });
      const server = createFixedWorkflowShim({ ...ports, configuration, environment: process.env, token: process.env.MN_BENCH_FIXED_WORKFLOW_TOKEN });
      await new Promise(resolve => server.listen(Number(args.includes('--port') ? arg('--port') : 3199), '127.0.0.1', resolve));
      process.stdout.write('固定工作流比较适配服务已启动；仅接受 DEMO 测试输入。\n');
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
    } else {
      ensure(args.includes('--output') && isAbsolute(arg('--output')), 'NEW_ABSOLUTE_OUTPUT_DIRECTORY_REQUIRED');
      const report = await runBenchmark({ configuration, outputDirectory: arg('--output'), split: args.includes('--split') ? arg('--split') : 'development',
        ...(args.includes('--config-sha256') ? { expectedConfigurationSha256: arg('--config-sha256') } : {}),
        ...(args.includes('--corpus') ? { corpusDirectory: resolve(arg('--corpus')) } : {}), mode: args.includes('--fixture') ? 'fixture' : 'live' });
      process.stdout.write(JSON.stringify(summarizeResults(report), null, 2) + '\n');
      if (report.safetyGate === 'blocked') process.exitCode = 1;
    }
  } catch (error) { process.stderr.write(`比较未完成：${/^[A-Z][A-Z0-9_]{0,95}$/u.test(error.message) ? error.message : 'BENCHMARK_SETUP_FAILED'}\n`); process.exitCode = 1; }
}
