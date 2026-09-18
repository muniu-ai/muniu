#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const root = resolve(dirname(filename), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const principal = 'candidate-fixture-owner';
const scenarios = ['normal', 'sales_revoked_queued', 'sales_revoked_during_model'];

export function candidatePlan(repetitions = 3) {
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 3, '重复次数须为 1 至 3');
  return Array.from({ length: repetitions }, (_, i) => scenarios.map(scenario => ({
    id: `${scenario}-${i + 1}`, scenario, repetition: i + 1, status: 'not_run',
  }))).flat();
}

export function candidateSummary(checks) {
  return { schemaVersion: '1', status: checks.some(item => item.status === 'failed') ? 'failed'
    : checks.length && checks.every(item => item.status === 'passed') ? 'passed' : 'not_run',
  fixture: 'DEMO', storage: { sales: 'PGlite-development-in-memory', agentOs: 'SQLite' },
  model: { mode: 'test_fixture', paidCalls: 0, qualityEvaluation: 'not_run' },
  realPostgreSql: 'not_run', fullFaultMatrix: 'not_run', checks,
  limits: ['仅使用虚构客户和明确的测试模型；未评价真实模型的抽取质量。',
    '真实 Sales Handler、OS Host/Kernel/Worker 和双向 HTTP 适配；Sales PGlite、OS SQLite，非真实 PostgreSQL。',
    '仅测试三种候选契约场景；未替代双 Worker、外部文件写入或完整 72 项故障矩阵。',
    'OS 用户身份由本地 fixture 注入；Sales 人类请求使用真实会话，服务读取使用独立临时 Bearer 身份。'] };
}

export function assertLoopbackUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:', '测试仅允许本机 HTTP');
  assert.equal(url.hostname, '127.0.0.1', '测试禁止访问真实模型或外部业务服务');
  assert.equal(url.username + url.password, '', 'URL 不得携带凭据');
}

export async function runCandidateIntegration({ salesRoot, repetitions = 3 } = {}) {
  assert.match(process.version, /^v22\.19\./u, '需要 Node 22.19.x');
  assert.equal(typeof salesRoot, 'string', '通过 --sales-root 或 MUNIU_CANDIDATE_SALES_ROOT 指定 Sales 仓库');
  candidatePlan(repetitions);
  const source = resolve(salesRoot);
  await readFile(join(source, 'apps/api/rfq-routes.ts'));
  const output = await mkdtemp('/tmp/muniu-candidate-e2e-');
  const logFile = join(output, 'process.log');
  const environment = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8',
    NODE_ENV: 'test', MN_CANDIDATE_SALES_ROOT: source, MN_CANDIDATE_OUTPUT: output, MN_CANDIDATE_REPETITIONS: String(repetitions) };
  // 子进程不继承模型、对象存储、数据库或用户业务服务凭据。
  const logs = [];
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [filename, '--fixture-child'], { cwd: output, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 80_000);
    child.stdout.on('data', data => logs.push(data)); child.stderr.on('data', data => logs.push(data));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', value => { clearTimeout(timer); done(value); });
  });
  await writeFile(logFile, Buffer.concat(logs), { mode: 0o600 });
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8').catch(() => {
    throw new Error(`候选集成未生成报告，退出码 ${code}；查看 ${logFile}`);
  }));
  if (code !== 0 && report.status !== 'failed') {
    report.status = 'failed'; report.runnerFailure = code === null ? 'fixture_timeout' : `child_exit_${code}`;
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  return { ...report, evidenceDirectory: output };
}

async function evidence(repository, paths) {
  const files = [];
  for (const path of paths) files.push({ path, sha256: sha256(await readFile(join(repository, path))) });
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    trackedDiffSha256: sha256(execFileSync('git', ['diff', 'HEAD'], { cwd: repository })), files };
}

async function serve(handler) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const parts = []; for await (const part of incoming) parts.push(part);
      const response = await handler(new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`, {
        method: incoming.method, headers: incoming.headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(parts) }),
      }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end('fixture HTTP adapter failure'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)) };
}

async function fixtureChild() {
  const salesRoot = process.env.MN_CANDIDATE_SALES_ROOT;
  const output = process.env.MN_CANDIDATE_OUTPUT;
  assert.ok(salesRoot && output);
  assert.equal(await realpath(process.cwd()), await realpath(output));
  const checks = candidatePlan(Number(process.env.MN_CANDIDATE_REPETITIONS));
  const report = { startedAt: new Date().toISOString(), ...candidateSummary(checks) };
  const recordHttp = [];
  const checkpoint = async phase => {
    Object.assign(report, candidateSummary(checks), { phase, http: recordHttp });
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  };
  await checkpoint('starting');
  const actualFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    assertLoopbackUrl(url);
    const response = await actualFetch(input, options);
    recordHttp.push({ method: options?.method ?? 'GET', path: new URL(url).pathname, status: response.status });
    return response;
  };
  let db, host, salesServer, store, unregister;
  try {
    report.sources = {
      agentOs: await evidence(root, ['package-lock.json', 'apps/host/dist/business-candidates.js', 'apps/worker/dist/business-candidates.js',
        'apps/worker/dist/business-provider.js', 'packages/contracts/dist/business-candidates.js', 'packages/kernel/dist/business-candidates.js']),
      sales: await evidence(salesRoot, ['package-lock.json', 'apps/api/rfq-service.ts', 'apps/api/rfq-routes.ts',
        'apps/api/rfq-candidate-client.ts', 'packages/contracts/business-candidates.ts']),
    };
    const { register } = await import(pathToFileURL(join(salesRoot, 'node_modules/tsx/dist/esm/api/index.mjs')).href);
    const imports = register({ namespace: 'industry-candidate-e2e', tsconfig: false });
    unregister = imports.unregister;
    const salesImport = path => imports.import(pathToFileURL(join(salesRoot, path)).href, import.meta.url);
    const [{ connectDatabase, migrate, Repo }, { bootstrap, issueSession, devTenant, devMember }, { createHandler }] = await Promise.all([
      salesImport('apps/api/database.ts'), salesImport('apps/api/auth.ts'), salesImport('apps/api/handler.ts'),
    ]);
    const [{ createAgentOsHost }, { SqliteStorage, FileCas, InMemoryKeyProvider }, workerApi, { createProtectedRuntimeStore }] = await Promise.all([
      import('../apps/host/dist/index.js'), import('../packages/storage/dist/index.js'), import('../apps/worker/dist/index.js'),
      import('../apps/worker/dist/runtime-store.js'),
    ]);
    await checkpoint('modules_loaded');
    db = await connectDatabase(undefined, true); await migrate(db); await bootstrap(db);
    await checkpoint('sales_database_ready');
    assert.equal(db.mode, 'pglite-development');
    const session = await db.transaction(q => issueSession(q, devTenant, devMember));
    const customer = await db.transaction(async q => (await new Repo(q, devTenant).list('customers'))[0]);
    const serviceToken = randomBytes(32).toString('hex');
    const authorityToken = randomBytes(32).toString('hex');
    const bindings = [];
    salesServer = await serve(createHandler(db, { bindings }));
    const ports = workerApi.createSalesBusinessProvider({ endpoint: salesServer.url + '/api/v1/os-business',
      allowInsecureHttp: true, tokenResolver: async () => serviceToken });
    await mkdir(join(output, 'os'), { recursive: true });
    store = new SqliteStorage({ databaseFile: join(output, 'os/state.sqlite'), hmacKey: randomBytes(32) });
    const protection = { cas: new FileCas({ rootDir: join(output, 'os/cas') }), keyProvider: new InMemoryKeyProvider(randomBytes(32)) };
    const scopes = [];
    host = await createAgentOsHost({ store, cas: protection.cas, protectedPayloadKeyProvider: protection.keyProvider,
      businessProvider: ports, businessWorkspaceScopes: scopes, businessAuthorityTokenResolver: async () => authorityToken,
      identityResolver: async () => ({ tenantId: devTenant, principalId: principal }),
      secretStore: { save: async () => 'keychain://muniu.v2/candidate-fixture', read: async () => 'non-billable-fixture' } });
    const listening = await host.listen({ host: '127.0.0.1', port: 0 });
    const hostUrl = `http://127.0.0.1:${listening.port}`;
    process.env.MUNIU_OS_URL = hostUrl;
    process.env.MUNIU_OS_AUTHORITY_TOKEN = authorityToken;
    const request = async (service, method, path, body, revision, statuses = [200, 201]) => {
      const response = await fetch((service === 'os' ? hostUrl : salesServer.url) + path, {
        method, signal: AbortSignal.timeout(15_000), headers: {
          ...(service === 'sales' ? { cookie: `muniu_session=${session}`, origin: 'http://localhost:3000' } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }),
          ...(revision === undefined ? {} : { 'If-Match': String(revision) }),
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const envelope = await response.json();
      assert.ok(statuses.includes(response.status), `${method} ${path}: ${response.status} ${JSON.stringify(envelope)}`);
      return { status: response.status, data: envelope.data, code: envelope.error?.code ?? envelope.code };
    };
    const workspace = (await request('os', 'POST', '/v2/workspaces', { name: '虚构询价契约测试', viewMode: 'business', pluginIds: [] })).data;
    await checkpoint('host_ready');
    scopes.push({ tenantId: devTenant, workspaceId: workspace.id });
    bindings.push({ tenantId: devTenant, workspaceId: workspace.id, principals: { [principal]: devMember }, token: serviceToken });
    await store.transact(devTenant, tx => tx.putProjection('modelConnection', 'fixture-model', { id: 'fixture-model', tenantId: devTenant,
      presetId: 'deepseek', defaultModel: 'deepseek-v4-flash', status: 'ready', streamVersion: 1, secretRef: 'keychain://muniu.v2/candidate-fixture' }));
    const runtime = createProtectedRuntimeStore({ ...protection, store, tenantId: devTenant, workspaceId: workspace.id });
    const setSalesActive = active => db.transaction(async q => {
      const repo = new Repo(q, devTenant); await repo.tenant(true);
      await repo.save('memberships', { ...await repo.get('memberships', devMember), active });
    });
    for (const check of checks) {
      const startHttp = recordHttp.length;
      let modelCalls = 0;
      try {
        await checkpoint(`${check.id}:starting`);
        await setSalesActive(true);
        const rfq = (await request('sales', 'POST', '/api/v1/rfqs', { customerId: customer.id, title: `虚构阀门询价 ${check.id}` })).data;
        const text = '虚构询价🧪：需要标准阀门，材料316L，数量2台。';
        const attached = (await request('sales', 'POST', `/api/v1/rfqs/${rfq.id}/sources`, {
          name: '虚构询价.txt', mime: 'text/plain', base64: Buffer.from(text).toString('base64'),
        }, rfq.revision)).data;
        const inquiry = attached.inquiry;
        const candidate = (await request('os', 'POST', '/v2/business-candidates', { expectedStreamVersion: 0,
          workspaceId: workspace.id, customerId: customer.id, inquiryId: inquiry.id, inquiryRevision: String(inquiry.revision) })).data;
        assert.equal(candidate.status, 'queued');
        await checkpoint(`${check.id}:queued`);
        if (check.scenario === 'sales_revoked_queued') await setSalesActive(false);
        const worker = new workerApi.AgentOsWorker({ id: 'candidate-fixture-worker', store,
          lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' },
          handlers: { 'business.candidate.extract': workerApi.createBusinessCandidateWorkerHandler({ store, runtimeProtection: protection,
            sourcePort: ports.inquiries, modelMode: 'test_fixture', secretStore: { read: async () => 'non-billable-fixture' },
            modelQuoter: async () => ({ inputTokenLimit: 1000, maxOutputTokens: 1000, rates: { id: 'non-billable-fixture', currency: 'CNY',
              inputNanoMinorUnitsPerToken: '0', cachedInputNanoMinorUnitsPerToken: '0', outputNanoMinorUnitsPerToken: '0' } }),
            modelInvoker: async input => {
              modelCalls++; assert.deepEqual(input.request.availableToolIds, []);
              const source = JSON.parse(input.request.messages.find(message => message.role === 'user').content);
              const page = source.pages[0];
              assert.equal(page.text, text);
              if (check.scenario === 'sales_revoked_during_model') await setSalesActive(false);
              return { text: JSON.stringify({ requirements: [{ text: '材料与数量待人工确认', citations: [{ sourceId: page.sourceId,
                pageNumber: page.pageNumber, start: 0, end: Array.from(page.text).length, quote: page.text }] }],
              facts: [], suggestions: [], unknown: [], conflicts: [] }), toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
            },
          }) } });
        await worker.pollOnce();
        await checkpoint(`${check.id}:worker_finished`);
        const final = (await request('os', 'GET', `/v2/business-candidates/${candidate.id}`)).data;
        assert.doesNotMatch(JSON.stringify(final), /虚构询价🧪|candidateProtectedPayloadRef|sourceProtectedPayloadRef|non-billable-fixture/u);
        const member = await store.transact(devTenant, tx => tx.getProjection('membership', `${workspace.id}:${principal}`));
        assert.equal(member.workspaceRole, 'owner', 'Sales 撤权场景必须保留 OS 成员权限');
        const records = await runtime.readExecution(candidate.executionId);
        const settlements = records.filter(record => record.type === 'model/settled').length;
        check.modelCalls = modelCalls; check.modelSettlements = settlements; check.osMembership = member.workspaceRole;
        check.candidateStatus = final.status; check.candidateId = final.id;
        if (check.scenario === 'normal') {
          assert.equal(final.status, 'completed'); assert.equal(modelCalls, 1); assert.equal(settlements, 1);
          const content = (await request('sales', 'GET', `/api/v1/rfqs/${inquiry.id}/candidates/${candidate.id}`)).data;
          assert.equal(content.digest, final.candidateDigest);
          assert.equal(content.candidate.sourceDigest, final.sourceDigest);
          assert.equal(content.candidate.modelProvenance.mode, 'test_fixture');
          assert.equal(content.candidate.requirements[0].citations[0].quote, text);
          const adopted = (await request('sales', 'POST', `/api/v1/rfqs/${inquiry.id}/candidates/adopt`,
            { candidateId: candidate.id, digest: final.candidateDigest }, inquiry.revision)).data;
          assert.equal(adopted.requirements.length, 1);
          assert.equal(adopted.requirements[0].kind, 'suggestion'); assert.equal(adopted.requirements[0].confirmed, false);
          assert.equal(adopted.requirements[0].source.sourceId, attached.source.id);
          const current = (await request('sales', 'GET', `/api/v1/rfqs/${inquiry.id}`)).data;
          assert.equal(current.decisions.length, 0); assert.equal(current.quote, undefined);
          check.humanAdoption = 'unconfirmed'; check.protectedContentDigest = content.digest;
        } else {
          assert.equal(final.status, 'failed');
          assert.equal(final.reasonCode, 'BUSINESS_CANDIDATE_SOURCE_UNAVAILABLE');
          assert.equal(final.candidateDigest, undefined);
          assert.equal(modelCalls, check.scenario === 'sales_revoked_queued' ? 0 : 1);
          assert.equal(settlements, check.scenario === 'sales_revoked_queued' ? 0 : 1);
          if (check.scenario === 'sales_revoked_queued') assert.equal(records.length, 0, '撤权后不得持久化或外发模型请求');
          const params = new URLSearchParams(candidate.scope);
          const protectedResponse = await fetch(`${hostUrl}/v2/business-candidates/${candidate.id}/content?${params}`, {
            headers: { authorization: `Bearer ${authorityToken}` },
          });
          assert.notEqual(protectedResponse.status, 200);
          const noCandidate = await protectedResponse.json(); assert.equal(noCandidate.code, 'BUSINESS_CANDIDATE_NOT_READY');
          await request('sales', 'POST', `/api/v1/rfqs/${inquiry.id}/candidates/adopt`,
            { candidateId: candidate.id, digest: '0'.repeat(64) }, inquiry.revision, [403]);
          const row = await db.transaction(q => new Repo(q, devTenant).get('inquiries', inquiry.id));
          assert.equal(row.requirements.length, 0);
          check.humanAdoption = 'blocked';
        }
        assert.equal((await worker.pollOnce()).status, 'idle', '已处理任务不得重放模型调用');
        const events = await store.readEvents(devTenant, 0, 2000);
        assert.doesNotMatch(JSON.stringify(events), /虚构询价🧪|non-billable-fixture/u);
        check.http = recordHttp.slice(startHttp);
        assert.ok(check.http.some(item => item.path === '/api/v1/os-business/inquiries'));
        if (check.scenario === 'normal') assert.ok(check.http.filter(item => item.path.endsWith('/content') && item.status === 200).length >= 2);
        check.status = 'passed';
      } catch (error) { check.status = 'failed'; check.error = String(error.message).slice(0, 1600); }
      finally { check.http = recordHttp.slice(startHttp); await checkpoint(`${check.id}:finished`); await setSalesActive(true); }
    }
  } catch (error) {
    report.setupError = String(error.message).slice(0, 1600);
    checks[0].status = 'failed';
  } finally {
    Object.assign(report, candidateSummary(checks), { finishedAt: new Date().toISOString() });
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await salesServer?.close(); await host?.close();
    if (!host) await store?.close();
    await db?.close();
    await unregister?.();
  }
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv.includes('--fixture-child')) await fixtureChild();
  else if (process.argv.includes('--help')) process.stdout.write('node scripts/industry-candidate-e2e.mjs --sales-root PATH [--repetitions 1..3]\n默认重复三次；依赖已构建的 OS 与 Sales node_modules。所有状态位于新建 /tmp 目录，不调用真实模型。\n');
  else {
    const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
    const result = await runCandidateIntegration({ salesRoot: arg('--sales-root') ?? process.env.MUNIU_CANDIDATE_SALES_ROOT,
      repetitions: Number(arg('--repetitions') ?? '3') });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.status !== 'passed') process.exitCode = 1;
  }
}
