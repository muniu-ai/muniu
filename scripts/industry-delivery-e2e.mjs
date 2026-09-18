#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdtemp, unlink, mkdir, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL = 'industry-fixture-owner@example.test';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = data => createHash('sha256').update(data).digest('hex');
export const fixtureProject = () => `mn-industry-${Date.now()}-${randomBytes(3).toString('hex')}`;
export function databaseUrl(connectionString, database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}
export function restoreTargets(repetition) {
  assert.ok(Number.isInteger(repetition) && repetition >= 1 && repetition <= 3);
  return { sourceOs: 'mn_os', sourceSales: 'mn_sales', os: `mn_os_restored_${repetition}`, sales: `mn_sales_restored_${repetition}` };
}
export function acceptancePlan(repetitions) {
  restoreTargets(repetitions);
  const scenarios = [
    ['normal', null, ['api', 'worker']], ['afterCommit', 'F09', ['worker']], ['afterWrite', 'F10', ['worker']],
    ['scope-boundary', 'F01', ['api', 'worker']], ['quote-change', 'F04', ['api', 'worker']],
    ['source-change', 'F04', ['api', 'worker']], ['template-version', 'F04', ['api']],
    ['approval-revoked', 'F05', ['api', 'worker']], ['customer-transfer', 'F06', ['api', 'worker']],
    ['concurrent-package', 'F08', ['api', 'worker']], ['worker-takeover', 'F11', ['worker']],
    ['database-restore', 'F12', ['api', 'worker']],
  ];
  return Array.from({ length: repetitions }, (_, i) => scenarios.map(([scenario, faultId, paths]) =>
    ({ id: `${scenario}-${i + 1}`, scenario, faultId, paths, repetition: i + 1, status: 'not_run' }))).flat();
}
export function validateFixtureConfig(config) {
  assert.equal(config.synthetic, true, 'synthetic fixture required');
  assert.equal(config.tenantId, TENANT, 'only the built-in synthetic tenant is allowed');
  for (const field of ['salesUrl', 'hostUrl', 'jwksUrl']) {
    const value = new URL(config[field]);
    assert.equal(value.protocol, 'http:'); assert.equal(value.hostname, '127.0.0.1');
    assert.equal(value.username + value.password, '');
  }
}
export function acceptanceSummary(checks) {
  return { status: checks.some(x => x.status === 'failed') ? 'failed' : checks.every(x => x.status === 'passed') && checks.length ? 'passed' : 'not_run',
    p5: 'blocked', p7: 'blocked', fullFaultMatrix: 'not_run', checks,
    limits: ['Synthetic data only; no customer validation, model, DSH or ADP execution.',
      'Local Node processes, real PostgreSQL, MinIO and disposable Vault dev mode; this is not a production deployment certification.',
      'Database restore retains object storage and Vault keys. Full coordinated object/KMS restore remains not_run.',
      'Focused end-to-end scenarios do not satisfy all 72 API/worker fault-matrix repetitions.'] };
}
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function until(label, fn, timeout = 45_000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(`${label}: timeout${last ? ` (${last.message})` : ''}`);
}
async function sourceSnapshot(cwd, output, name) {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd }).toString().split('\0').filter(Boolean).sort();
  const manifest = [];
  for (const path of paths) {
    try { manifest.push({ path, sha256: sha256(await readFile(join(cwd, path))) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; manifest.push({ path, deleted: true }); }
  }
  const encoded = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(output, `${name}-source-manifest.json`), encoded);
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
    sourceManifestSha256: sha256(encoded), sourceManifest: `${name}-source-manifest.json`,
    trackedDiffSha256: sha256(execFileSync('git', ['diff', 'HEAD'], { cwd })),
    clean: execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() === '',
    lockSha256: sha256(await readFile(join(cwd, 'package-lock.json'))) };
}
async function compiledSnapshot(output) {
  const manifest = [];
  const walk = async directory => {
    for (const item of await readdir(join(root, directory), { withFileTypes: true }).catch(() => [])) {
      const path = `${directory}/${item.name}`;
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) manifest.push({ path, sha256: sha256(await readFile(join(root, path))) });
    }
  };
  for (const parent of ['apps', 'packages', 'plugins', 'vendor']) {
    for (const item of await readdir(join(root, parent), { withFileTypes: true })) if (item.isDirectory()) await walk(`${parent}/${item.name}/dist`);
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  const encoded = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(output, 'agentOs-compiled-manifest.json'), encoded);
  return { manifest: 'agentOs-compiled-manifest.json', sha256: sha256(encoded), files: manifest.length };
}
async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('node scripts/industry-delivery-e2e.mjs --sales-root PATH [--output PATH] [--repetitions 1..3]\nRequires built OS workspaces, Sales dependencies and Chromium, Docker with Compose. Creates and removes its own disposable project.\n'); return;
  }
  assert.match(process.version, /^v22\.19\./u, 'Node 22.19.x required');
  const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
  const salesRoot = resolve(arg('--sales-root', '/Users/xiaomingwang/Documents/ChatGPT/创业项目/muniu-ai-sales-rfq'));
  const repetitions = Number(arg('--repetitions', '1'));
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 3);
  const output = resolve(arg('--output', await mkdtemp(join(tmpdir(), 'mn-industry-e2e-'))));
  await mkdir(output, { recursive: true, mode: 0o700 });
  const privateDir = await mkdtemp(join(tmpdir(), 'mn-industry-private-'));
  const project = fixtureProject();
  const composeBin = process.env.MN_COMPOSE_BIN || '/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose';
  const composeArgs = ['-p', project, '-f', join(root, 'fixtures/industry-delivery/runtime/docker-compose.yml')];
  const children = new Map(); const streams = [];
  const checks = acceptancePlan(repetitions);
  const report = { schemaVersion: '1', fixture: 'DEMO', startedAt: new Date().toISOString(), project, repetitions, node: process.version, checks };
  const cmd = (file, args, options = {}) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env: { ...process.env, PATH: '/Applications/Docker.app/Contents/Resources/bin:' + process.env.PATH }, ...options });
    const out = [], err = [];
    child.stdout?.on('data', value => out.push(value)); child.stderr?.on('data', value => err.push(value));
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(Buffer.concat(out).toString()) : reject(new Error(`Command failed (${code}): ${Buffer.concat(err).toString().slice(-3000)}`)));
  });
  const compose = args => cmd(composeBin, [...composeArgs, ...args]);
  const configFile = join(privateDir, 'runtime.json');
  const config = { synthetic: true, tenantId: TENANT, salesRoot,
    salesUrl: `http://127.0.0.1:${await freePort()}`, hostUrl: `http://127.0.0.1:${await freePort()}`, jwksUrl: `http://127.0.0.1:${await freePort()}`,
    serviceToken: randomBytes(32).toString('hex'), authorityToken: randomBytes(32).toString('hex'), hmacKey: randomBytes(32).toString('base64'),
    engineLock: sha256('industry-fixture-engine'), pluginLock: sha256('industry-fixture-plugin'),
    faultFile: join(privateDir, 'fault.json'), faultEvents: join(output, 'fault-events.jsonl'), bindingsFile: join(privateDir, 'bindings.json') };
  const saveConfig = () => writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const start = (role, name = role) => {
    const log = createWriteStream(join(output, `${name}.log`), { flags: 'a', mode: 0o600 }); streams.push(log);
    const args = role === 'jwks' ? [join(root, 'scripts/jwks-fixture.mjs')] : [
      ...(role === 'sales' ? ['--import', pathToFileURL(join(salesRoot, 'node_modules/tsx/dist/loader.mjs')).href] : []),
      join(root, 'scripts/industry-delivery-runtime.mjs'), role, name];
    const child = spawn(process.execPath, args, { cwd: role === 'sales' ? salesRoot : root,
      env: { ...process.env, MN_INDUSTRY_CONFIG: configFile, JWKS_PORT: new URL(config.jwksUrl).port, JWKS_ISSUER: config.jwksUrl, JWKS_AUDIENCE: 'mn-industry-e2e' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log); child.stderr.pipe(log); children.set(name, child); return child;
  };
  const stop = async name => {
    const child = children.get(name); if (!child || child.exitCode !== null || child.signalCode) return;
    child.kill('SIGCONT'); child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('close', resolve)), sleep(4_000)]);
    if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)); }
  };
  let osPool, salesPool, admin;
  let accessToken, cookie;
  const request = async (kind, method, path, body, revision, expected = [200, 201], options = {}) => {
    const base = kind === 'os' ? config.hostUrl : config.salesUrl;
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(35_000),
      headers: { ...(kind === 'os' ? { authorization: `Bearer ${accessToken}` } : kind === 'service' ? { authorization: `Bearer ${config.serviceToken}` } : { origin: config.salesUrl, ...(cookie ? { cookie } : {}) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'Idempotency-Key': options.idempotencyKey ?? randomUUID() }), ...(revision ? { 'If-Match': `"${revision}"` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let parsed; try { parsed = JSON.parse(text); } catch { /* Non-JSON failure remains diagnostic only. */ }
    assert.ok(expected.includes(response.status), `${method} ${path}: ${response.status} ${text.slice(0, 1000)}`);
    return { data: parsed?.data, errorCode: parsed?.error?.code ?? parsed?.code, response };
  };
  const run = async (id, work) => {
    process.stdout.write(`${id}: running\n`); const began = Date.now();
    const result = checks.find(x => x.id === id);
    try { const evidence = await work(); Object.assign(result, { status: 'passed', durationMs: Date.now() - began, evidence }); process.stdout.write(`${id}: passed\n`); }
    catch (error) { Object.assign(result, { status: 'failed', durationMs: Date.now() - began, error: error.message }); throw error; }
  };
  try {
    report.source = { agentOs: await sourceSnapshot(root, output, 'agentOs'), sales: await sourceSnapshot(salesRoot, output, 'sales') };
    report.compiledArtifacts = await compiledSnapshot(output);
    process.stdout.write(`DEMO integration output: ${output}\n`);
    await writeFile(join(output, 'compose-up.log'), await compose(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres', 'minio', 'vault']), { mode: 0o600 });
    for (const service of ['minio-init', 'vault-init']) await compose(['run', '--rm', '--no-deps', service]);
    const port = async (service, target) => (await compose(['port', service, String(target)])).trim().split(':').at(-1);
    const pgPort = await port('postgres', 5432);
    config.osDatabase = `postgres://mn:mn-industry-fixture-only@127.0.0.1:${pgPort}/mn_os`;
    config.salesDatabase = `postgres://mn_sales:mn-sales-fixture-only@127.0.0.1:${pgPort}/mn_sales`;
    config.s3Endpoint = `http://127.0.0.1:${await port('minio', 9000)}`;
    config.vaultUrl = `http://127.0.0.1:${await port('vault', 8200)}`;
    const { createPostgresPool } = await import('./lib/postgres-pool.mjs');
    admin = createPostgresPool({ connectionString: config.osDatabase, max: 2 });
    await admin.query("create role mn_sales login password 'mn-sales-fixture-only' nosuperuser nobypassrls");
    await admin.query('create database mn_sales owner mn_sales');
    osPool = createPostgresPool({ connectionString: config.osDatabase, max: 2 });
    salesPool = createPostgresPool({ connectionString: databaseUrl(config.osDatabase, 'mn_sales'), max: 2 });
    await writeFile(config.faultFile, '{}', { mode: 0o600 }); await writeFile(config.bindingsFile, '[]', { mode: 0o600 }); await saveConfig();
    start('jwks'); start('sales'); start('host');
    await until('JWKS ready', async () => (await fetch(config.jwksUrl + '/health')).ok);
    const token = await fetch(config.jwksUrl + `/token?tenant=${TENANT}&sub=${PRINCIPAL}&role=organization_admin`, { method: 'POST' }); accessToken = (await token.json()).access_token;
    await until('Sales PostgreSQL ready', async () => (await request('sales', 'GET', '/api/v1/health')).data?.database === 'postgresql');
    await until('Host ready', async () => (await request('os', 'GET', '/v2/readiness')).data?.ready === true);
    const signedIn = await request('sales', 'POST', '/api/v1/auth/dev', {}); cookie = signedIn.response.headers.get('set-cookie').split(';')[0];
    config.workspaceId = (await request('os', 'POST', '/v2/workspaces', { name: 'DEMO 工业询价验收', viewMode: 'business', pluginIds: [] })).data.id;
    await writeFile(config.bindingsFile, JSON.stringify([{ tenantId: TENANT, workspaceId: config.workspaceId, principals: { [PRINCIPAL]: MEMBER }, token: config.serviceToken }]), { mode: 0o600 });
    await saveConfig(); await stop('host'); start('host');
    await until('Enabled Host ready', async () => (await request('os', 'GET', '/v2/readiness')).data?.ready === true);
    start('worker', 'worker-a'); start('worker', 'worker-b');
    const customerId = (await salesPool.query('select id from customers where tenant_id=$1 order by id limit 1', [TENANT])).rows[0].id;
    const catalog = (await request('sales', 'POST', '/api/v1/rfq-catalog/import', {
      csv: 'id,revision,name,unitPriceCents\nDEMO-V15,1,DEMO 虚构球阀 DN15,125037',
    })).data.products[0];
    report.dependencies = { postgres: (await admin.query('select version()')).rows[0].version, salesRole: (await salesPool.query("select rolname,rolsuper,rolbypassrls from pg_roles where rolname='mn_sales'")).rows[0], workers: ['worker-a', 'worker-b'], pdf: 'real Playwright Chromium; font digest bound to renderVersion', font: JSON.parse(await readFile(join(salesRoot, 'templates/font-manifest.json'), 'utf8')), vault: 'real Transit API in disposable dev mode' };
    const prepare = async (title, createAction = true) => {
      let inquiry = (await request('sales', 'POST', '/api/v1/rfqs', { customerId, title: `DEMO ${title}` })).data;
      const inputText = 'DEMO 虚构球阀 DN15，目录编号 DEMO-V15，数量为 2，禁止外发。';
      const added = (await request('sales', 'POST', `/api/v1/rfqs/${inquiry.id}/sources`, { name: 'DEMO-inquiry.txt', mime: 'text/plain', base64: Buffer.from(inputText).toString('base64') }, inquiry.revision)).data;
      inquiry = (await request('sales', 'PUT', `/api/v1/rfqs/${inquiry.id}/requirements`, { requirements: [{ id: 'r1', text: inputText, kind: 'fact', critical: true, confirmed: true, source: { sourceId: added.source.id, sourceRevision: added.source.revision, page: 1, start: 0, end: Array.from(inputText).length } }], conflicts: [] }, added.inquiry.revision)).data;
      const quoteBody = { items: [{ catalogItemId: catalog.id, catalogRevision: catalog.revision, quantity: 2 }], discountBps: 0, taxBasis: 'unit_price_tax_included', company: { name: 'DEMO 虚构工业企业', address: '演示地址', contact: '演示联系人' }, validUntil: new Date(Date.now() + 86400_000).toISOString(), deliveryTerms: '仅为虚构演示', paymentTerms: '不产生付款义务' };
      await request('sales', 'POST', `/api/v1/rfqs/${inquiry.id}/quotes`, quoteBody, inquiry.revision);
      inquiry = (await request('sales', 'GET', `/api/v1/rfqs/${inquiry.id}`)).data;
      assert.equal(inquiry.quote.content.totalCents, 250074);
      assert.equal(inquiry.quote.content.demo, true);
      assert.equal(inquiry.quote.content.items[0].catalogItemId, 'DEMO-V15');
      report.dependencies.renderVersion = inquiry.renderVersion;
      const approvalReplay = { body: { contentVersion: inquiry.quote.contentVersion, digest: inquiry.quote.digest }, revision: inquiry.revision, idempotencyKey: randomUUID() };
      const decision = (await request('sales', 'POST', `/api/v1/rfqs/${inquiry.id}/approve`, approvalReplay.body, approvalReplay.revision, [200, 201], approvalReplay)).data;
      const actionBody = { schemaVersion: '1', action: 'issueQuotePackage', expectedStreamVersion: 0, workspaceId: config.workspaceId, customerId, quoteId: inquiry.id, quoteVersion: inquiry.quote.contentVersion, decisionId: decision.id, templateId: inquiry.template.id, templateVersion: inquiry.template.version, renderVersion: inquiry.renderVersion, exportFormat: 'pdf', issueDate: new Date().toISOString().slice(0, 10) };
      const action = createAction ? (await request('os', 'POST', '/v2/business-actions', actionBody)).data : undefined;
      return { inquiry, action, decision, actionBody, quoteBody, approvalReplay };
    };
    const actionRead = async id => (await request('os', 'GET', `/v2/business-actions/${id}`)).data;
    const waiting = async id => until('tool approval', async () => { const a = await actionRead(id); if (a.status === 'rejected') throw new Error('business action rejected before approval'); return a.approval ? a : undefined; });
    const approve = async action => request('os', 'POST', `/v2/approvals/${action.approval.id}/decisions`, { expectedStreamVersion: action.approval.streamVersion, decision: 'approve_once' });
    const final = async (id, status) => until(`action ${status}`, async () => { const a = await actionRead(id); if (a.status !== status) throw new Error(`observed ${a.status}`); return a; }, 60_000);
    const verifyPackage = async (inquiry, action) => {
      const view = (await request('sales', 'GET', `/api/v1/rfqs/${inquiry.id}`)).data;
      assert.equal(view.packages.length, 1, 'exactly one package');
      const pkg = view.packages[0];
      const response = await fetch(config.salesUrl + `/api/v1/quote-packages/${pkg.id}/pdf`, { headers: { cookie } });
      assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      assert.ok(bytes.length > 1000); assert.equal(action.receipt.packageId, pkg.id);
      assert.equal(action.receipt.files[0].sha256, sha256(bytes));
      const name = `DEMO-${pkg.id}.pdf`; await writeFile(join(output, name), bytes);
      return { actionId: action.id, inquiryId: inquiry.id, packageId: pkg.id, operationKey: action.operationKey, pdf: { path: name, sha256: sha256(bytes), byteLength: bytes.length }, packageCount: 1 };
    };
    const scope = { tenantId: TENANT, workspaceId: config.workspaceId, customerId, principalId: PRINCIPAL };
    const snapshotQuery = fixture => ({ schemaVersion: '1', scope, objectId: fixture.inquiry.id, version: fixture.inquiry.quote.contentVersion,
      templateId: fixture.inquiry.template.id, templateVersion: fixture.inquiry.template.version });
    const denied = async (kind, method, path, body, expectedStatus, expectedCode, revision, options) => {
      const result = await request(kind, method, path, body, revision, [expectedStatus], options);
      assert.equal(result.errorCode, expectedCode);
      return { path, status: result.response.status, code: result.errorCode };
    };
    const workerRejected = async fixture => {
      const rejected = await final(fixture.action.id, 'rejected');
      const job = await until('rejected physical Worker job', async () => {
        const row = (await osPool.query('select job_id,status,fencing_token from mn_v2.jobs where tenant_id=$1 and job_id=$2', [TENANT, fixture.action.jobId])).rows[0];
        return row?.status === 'failed' ? row : undefined;
      });
      assert.ok(Number(job.fencing_token) > 0, 'a real Worker must have leased the job');
      const operations = (await salesPool.query("select count(*)::int as n from quote_operations where tenant_id=$1 and data->>'inquiryId'=$2", [TENANT, fixture.inquiry.id])).rows[0].n;
      const packages = (await salesPool.query("select count(*)::int as n from quote_packages where tenant_id=$1 and data->>'inquiryId'=$2", [TENANT, fixture.inquiry.id])).rows[0].n;
      assert.equal(operations, 0); assert.equal(packages, 0);
      return { actionId: rejected.id, inquiryId: fixture.inquiry.id, actionStatus: rejected.status, physicalJob: job, operationCount: operations, packageCount: packages };
    };
    const restoreReferences = [];
    for (let iteration = 1; iteration <= repetitions; iteration++) {
      await run(`normal-${iteration}`, async () => { const { inquiry, action } = await prepare('正常出包'); await approve(await waiting(action.id)); const done = await final(action.id, 'completed'); const evidence = await verifyPackage(inquiry, done); restoreReferences.push({ inquiry, action: done, evidence }); return evidence; });
      for (const stage of ['afterCommit', 'afterWrite']) await run(`${stage}-${iteration}`, async () => {
        const { inquiry, action } = await prepare(stage); await writeFile(config.faultFile, JSON.stringify({ stage }), { mode: 0o600 });
        await approve(await waiting(action.id)); let pending = await final(action.id, 'needs_reconciliation');
        const op = (await salesPool.query("select data from quote_operations where tenant_id=$1 and data->>'operationKey'=$2", [TENANT, pending.operationKey])).rows[0].data;
        assert.equal(op.status, stage === 'afterCommit' ? 'completed' : 'writing');
        const before = (await request('sales', 'GET', `/api/v1/rfqs/${inquiry.id}`)).data;
        assert.equal(before.packages.length, stage === 'afterCommit' ? 1 : 0);
        pending = (await request('os', 'POST', `/v2/business-actions/${action.id}/reconciliation-decisions`, { expectedStreamVersion: pending.streamVersion, decision: 'mark_completed' })).data;
        assert.equal(pending.status, 'completed'); const evidence = await verifyPackage(inquiry, pending);
        assert.equal(evidence.pdf.sha256, op.file.sha256, 'reconciliation preserves originally staged PDF bytes');
        return { ...evidence, injectedStage: stage, statusBeforeReconcile: op.status, archiveCountBeforeReconcile: before.packages.length, explicitReconciliation: true };
      });
      await run(`scope-boundary-${iteration}`, async () => {
        const fixture = await prepare('服务范围边界'); const pending = await waiting(fixture.action.id);
        const query = snapshotQuery(fixture);
        const otherCustomer = (await salesPool.query('select id from customers where tenant_id=$1 and id<>$2 order by id limit 1', [TENANT, customerId])).rows[0].id;
        const api = [
          await denied('service', 'POST', '/api/v1/os-business/snapshots', { ...query, scope: { ...scope, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }, 403, 'SERVICE_SCOPE_DENIED'),
          await denied('service', 'POST', '/api/v1/os-business/snapshots', { ...query, scope: { ...scope, customerId: otherCustomer } }, 403, 'SCOPE_MISMATCH'),
        ];
        const original = await readFile(config.bindingsFile);
        try {
          const bindings = JSON.parse(original); bindings[0].tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
          await writeFile(config.bindingsFile, JSON.stringify(bindings));
          await approve(pending);
          return { api, workerInjection: 'service tenant binding changed after tool approval was requested', worker: await workerRejected(fixture) };
        } finally { await writeFile(config.bindingsFile, original); }
      });
      for (const change of ['quote', 'source']) await run(`${change}-change-${iteration}`, async () => {
        const fixture = await prepare(`批准后${change}变化`); const pending = await waiting(fixture.action.id);
        const current = (await request('sales', 'GET', `/api/v1/rfqs/${fixture.inquiry.id}`)).data;
        if (change === 'quote') await request('sales', 'POST', `/api/v1/rfqs/${fixture.inquiry.id}/quotes`, { ...fixture.quoteBody, items: [{ ...fixture.quoteBody.items[0], quantity: 3 }] }, current.revision);
        else await request('sales', 'POST', `/api/v1/rfqs/${fixture.inquiry.id}/sources`, { name: 'DEMO-changed.txt', mime: 'text/plain', base64: Buffer.from('DEMO 新增虚构来源，须重新核准').toString('base64') }, current.revision);
        const api = await denied('service', 'POST', '/api/v1/os-business/snapshots', snapshotQuery(fixture), 409, 'QUOTE_CONTENT_CHANGED');
        await approve(pending);
        return { api, changeAfterBusinessApproval: change, worker: await workerRejected(fixture) };
      });
      await run(`template-version-${iteration}`, async () => {
        const fixture = await prepare('错误模板版本', false);
        const api = await denied('service', 'POST', '/api/v1/os-business/snapshots', { ...snapshotQuery(fixture), templateVersion: `${fixture.inquiry.template.version}-DEMO-stale` }, 409, 'TEMPLATE_CHANGED');
        return { inquiryId: fixture.inquiry.id, api, worker: 'not_run', limitation: 'Mismatched requested version only; live template deployment changes are not exercised.' };
      });
      await run(`approval-revoked-${iteration}`, async () => {
        const fixture = await prepare('批准撤销'); const pending = await waiting(fixture.action.id);
        await request('sales', 'POST', `/api/v1/rfqs/${fixture.inquiry.id}/decisions/${fixture.decision.id}/revoke`, { reason: 'DEMO 验收撤销批准' });
        const api = await denied('service', 'POST', '/api/v1/os-business/decisions', { schemaVersion: '1', scope, decisionId: fixture.decision.id }, 409, 'BUSINESS_APPROVAL_INVALID');
        await approve(pending); return { api, worker: await workerRejected(fixture) };
      });
      await run(`customer-transfer-${iteration}`, async () => {
        const fixture = await prepare('客户交接后历史请求'); const pending = await waiting(fixture.action.id);
        const originalMember = (await salesPool.query('select data from memberships where tenant_id=$1 and id=$2', [TENANT, MEMBER])).rows[0].data;
        const originalCustomer = (await salesPool.query('select data,owner_id from customers where tenant_id=$1 and id=$2', [TENANT, customerId])).rows[0];
        const newOwner = randomUUID();
        try {
          await salesPool.query('insert into memberships(tenant_id,id,data) values($1,$2,$3)', [TENANT, newOwner, JSON.stringify({ ...originalMember, id: newOwner, subject: `DEMO:${newOwner}`, roles: ['sales'], teamIds: [] })]);
          await salesPool.query('update memberships set data=$3 where tenant_id=$1 and id=$2', [TENANT, MEMBER, JSON.stringify({ ...originalMember, roles: ['sales'], teamIds: [] })]);
          await salesPool.query('update customers set owner_id=$3,data=$4 where tenant_id=$1 and id=$2', [TENANT, customerId, newOwner, JSON.stringify({ ...originalCustomer.data, ownerId: newOwner, sharedWith: [] })]);
          const api = [
            await denied('sales', 'GET', `/api/v1/rfqs/${fixture.inquiry.id}`, undefined, 403, 'PERMISSION_DENIED'),
            await denied('sales', 'POST', `/api/v1/rfqs/${fixture.inquiry.id}/approve`, fixture.approvalReplay.body, 403, 'PERMISSION_DENIED', fixture.approvalReplay.revision, fixture.approvalReplay),
          ];
          await approve(pending);
          return { api, exactHistoricalIdempotencyKeyReplayed: true, fixtureInjection: 'current membership and customer ownership updated in real PostgreSQL', worker: await workerRejected(fixture) };
        } finally {
          await salesPool.query('update memberships set data=$3 where tenant_id=$1 and id=$2', [TENANT, MEMBER, JSON.stringify(originalMember)]);
          await salesPool.query('update customers set owner_id=$3,data=$4 where tenant_id=$1 and id=$2', [TENANT, customerId, originalCustomer.owner_id, JSON.stringify(originalCustomer.data)]);
          await salesPool.query('delete from memberships where tenant_id=$1 and id=$2', [TENANT, newOwner]);
        }
      });
      await run(`concurrent-package-${iteration}`, async () => {
        const fixture = await prepare('并发重复出包', false); const idempotencyKey = randomUUID();
        const created = await Promise.all([idempotencyKey, idempotencyKey, randomUUID()].map(key => request('os', 'POST', '/v2/business-actions', fixture.actionBody, undefined, [200, 201], { idempotencyKey: key })));
        assert.equal(new Set(created.map(x => x.data.id)).size, 1, 'same and different keys converge on the stable operation');
        const action = created[0].data; await approve(await waiting(action.id)); const done = await final(action.id, 'completed');
        const replay = (await request('os', 'POST', '/v2/business-actions', fixture.actionBody)).data;
        assert.equal(replay.id, action.id); assert.equal(replay.status, 'completed');
        const count = (await salesPool.query("select count(*)::int as n from quote_operations where tenant_id=$1 and data->>'inquiryId'=$2", [TENANT, fixture.inquiry.id])).rows[0].n;
        assert.equal(count, 1);
        const jobs = (await osPool.query('select job_id,status,fencing_token from mn_v2.jobs where tenant_id=$1 and job_id=$2', [TENANT, action.jobId])).rows;
        assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'completed'); assert.ok(Number(jobs[0].fencing_token) > 0);
        return { ...await verifyPackage(fixture.inquiry, done), concurrentRequests: 3, completedReplay: true, operationCount: count, physicalJob: jobs[0] };
      });
    }
    for (let iteration = 1; iteration <= repetitions; iteration++) await run(`worker-takeover-${iteration}`, async () => {
      const { inquiry, action } = await prepare('租约接管'); await waiting(action.id);
      const original = (await osPool.query('select job_id,lease_owner,fencing_token from mn_v2.jobs where tenant_id=$1 and job_id=$2', [TENANT, action.jobId])).rows[0];
      assert.ok(original?.lease_owner); const oldWorker = children.get(original.lease_owner); assert.ok(oldWorker); oldWorker.kill('SIGSTOP');
      try {
        const takeover = await until('physical lease takeover', async () => { const row = (await osPool.query('select lease_owner,fencing_token,status from mn_v2.jobs where job_id=$1', [original.job_id])).rows[0]; return row.lease_owner && row.lease_owner !== original.lease_owner && Number(row.fencing_token) > Number(original.fencing_token) ? row : undefined; }, 50_000);
        await approve(await waiting(action.id)); const done = await final(action.id, 'completed'); oldWorker.kill('SIGCONT');
        await until('stale worker rejects its old lease', async () => (await readFile(join(output, `${original.lease_owner}.log`), 'utf8')).split('\n').some(line => {
          try { const value = JSON.parse(line); return value.status === 'lost_lease' && value.jobId === original.job_id; } catch { return false; }
        }), 15_000);
        const settled = (await osPool.query('select status,fencing_token from mn_v2.jobs where job_id=$1', [original.job_id])).rows[0];
        assert.equal(settled.status, 'completed'); assert.equal(Number(settled.fencing_token), Number(takeover.fencing_token));
        const evidence = await verifyPackage(inquiry, done); return { ...evidence, original: { worker: original.lease_owner, token: Number(original.fencing_token) }, takeover: { worker: takeover.lease_owner, token: Number(takeover.fencing_token) }, staleWorkerResumed: true, staleWorkerOutcome: 'lost_lease' };
      } finally { oldWorker.kill('SIGCONT'); }
    });
    await stop('worker-a'); await stop('worker-b'); await stop('host'); await stop('sales');
    for (const db of ['mn_os', 'mn_sales']) await compose(['exec', '-T', 'postgres', 'pg_dump', '-U', 'mn', '-Fc', '-f', `/tmp/${db}.dump`, db]);
    const sourceOsDatabase = config.osDatabase; const sourceSalesDatabase = config.salesDatabase;
    for (let iteration = 1; iteration <= repetitions; iteration++) await run(`database-restore-${iteration}`, async () => {
      const targets = restoreTargets(iteration); const restoreReference = restoreReferences[iteration - 1];
      await stop('worker-a'); await stop('worker-b'); await stop('host'); await stop('sales');
      const previousPools = [osPool, salesPool]; osPool = undefined; salesPool = undefined;
      await Promise.all(previousPools.map(pool => pool.end()));
      for (const [source, target, owner] of [[targets.sourceOs, targets.os, 'mn'], [targets.sourceSales, targets.sales, 'mn_sales']]) {
        await admin.query(`create database ${target} owner ${owner}`);
        await compose(['exec', '-T', 'postgres', 'pg_restore', '-U', 'mn', '-d', target, `/tmp/${source}.dump`]);
      }
      config.osDatabase = databaseUrl(sourceOsDatabase, targets.os); config.salesDatabase = databaseUrl(sourceSalesDatabase, targets.sales); config.restored = true; await saveConfig();
      osPool = createPostgresPool({ connectionString: config.osDatabase, max: 2 });
      salesPool = createPostgresPool({ connectionString: databaseUrl(sourceOsDatabase, targets.sales), max: 2 });
      start('sales'); start('host');
      await until('restored host', async () => (await request('os', 'GET', '/v2/readiness')).data?.ready === true);
      await until('restored sales', async () => (await request('sales', 'GET', '/api/v1/health')).data?.database === 'postgresql');
      const restored = await actionRead(restoreReference.action.id); assert.equal(restored.status, 'completed');
      const evidence = await verifyPackage(restoreReference.inquiry, restored); assert.equal(evidence.pdf.sha256, restoreReference.evidence.pdf.sha256);
      assert.equal((await salesPool.query('select data from memberships where tenant_id=$1 and id=$2', [TENANT, MEMBER])).rows[0].data.active, true, 'each independent restore begins with current active personnel');
      start('worker', 'worker-a'); start('worker', 'worker-b');
      const fixture = await prepare(`恢复后撤权 ${iteration}`); const pending = await waiting(fixture.action.id);
      await salesPool.query("update memberships set data=jsonb_set(data,'{active}','false') where tenant_id=$1 and id=$2", [TENANT, MEMBER]);
      const forbidden = await fetch(config.salesUrl + `/api/v1/quote-packages/${evidence.packageId}/pdf`, { headers: { cookie } }); assert.ok([401, 403].includes(forbidden.status));
      await approve(pending); const rejected = await workerRejected(fixture);
      return { ...evidence, databases: [targets.os, targets.sales], originalSnapshotSources: [targets.sourceOs, targets.sourceSales], initiallyActiveMember: true,
        preservedObjectStore: true, preservedVault: true, currentPermissionDeniedAfterRestore: forbidden.status, restoredWorkerRechecksRevokedPermission: rejected };
    });
  } catch (error) {
    report.failure = error.message;
    if (!checks.some(x => x.status === 'failed')) checks.push({ id: 'setup', status: 'failed', error: error.message });
    report.diagnostics = {
      salesOperations: await salesPool?.query("select id,status,data->'file' as file,data->'action'->>'actionId' as action_id from quote_operations").then(r => r.rows).catch(e => ({ unavailable: e.code ?? e.name })),
      osJobs: await osPool?.query('select job_id,status,result_json,failure_json from mn_v2.jobs').then(r => r.rows).catch(e => ({ unavailable: e.code ?? e.name })),
    };
    process.exitCode = 1;
  }
  finally {
    for (const name of [...children.keys()].reverse()) await stop(name);
    await Promise.all([osPool?.end(), salesPool?.end(), admin?.end()]);
    try { await compose(['down', '-v', '--remove-orphans']); report.cleanup = 'completed'; } catch { report.cleanup = 'failed'; process.exitCode = 1; }
    for (const file of [configFile, config.faultFile, config.bindingsFile]) await unlink(file).catch(() => {});
    for (const stream of streams) stream.end();
    Object.assign(report, acceptanceSummary(checks), { finishedAt: new Date().toISOString() });
    await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`Integration ${report.status}; P5 blocked. Evidence: ${join(output, 'result.json')}\n`);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
