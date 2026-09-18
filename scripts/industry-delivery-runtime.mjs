#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { validateFixtureConfig } from './industry-delivery-e2e.mjs';

const config = JSON.parse(await readFile(process.env.MN_INDUSTRY_CONFIG, 'utf8'));
validateFixtureConfig(config);
const role = process.argv[2];
let shutdown;
if (role === 'sales') {
  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL = config.salesDatabase;
  process.env.APP_ORIGIN = config.salesUrl;
  process.env.S3_ENDPOINT = config.s3Endpoint;
  process.env.S3_BUCKET = 'mn-sales-artifacts';
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_ACCESS_KEY_ID = 'mn-e2e';
  process.env.S3_SECRET_ACCESS_KEY = 'mn-e2e-secret-only';
  process.env.MUNIU_OS_URL = config.hostUrl;
  process.env.MUNIU_OS_AUTHORITY_TOKEN = config.authorityToken;
  process.env.MUNIU_OS_BINDINGS_FILE = config.bindingsFile;
  const fromSales = path => import(pathToFileURL(`${config.salesRoot}/${path}`).href);
  const { connectDatabase, migrate } = await fromSales('apps/api/database.ts');
  const { bootstrap } = await fromSales('apps/api/auth.ts');
  const { createHandler } = await fromSales('apps/api/handler.ts');
  const db = await connectDatabase();
  if (db.mode !== 'postgresql') throw new Error('REAL_POSTGRES_REQUIRED');
  if (!config.restored) { await migrate(db); await bootstrap(db); }
  const fault = async stage => {
    const value = JSON.parse(await readFile(config.faultFile, 'utf8'));
    if (value.stage !== stage) return;
    await writeFile(config.faultFile, '{}', { mode: 0o600 });
    await appendFile(config.faultEvents, JSON.stringify({ stage, occurredAt: new Date().toISOString() }) + '\n');
    throw new Error(`FIXTURE_${stage.toUpperCase()}`);
  };
  const handler = createHandler(db, { afterWrite: () => fault('afterWrite'), afterCommit: () => fault('afterCommit') });
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 9_500_000) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const result = await handler(new Request(new URL(req.url, config.salesUrl), {
        method: req.method, headers: req.headers,
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
      }));
      if (!result.ok || req.url?.startsWith('/api/v1/os-business/')) {
        const diagnostic = await result.clone().json().catch(() => ({}));
        process.stderr.write(JSON.stringify({ event: 'business_http', path: req.url?.split('?')[0], status: result.status,
          code: diagnostic.code ?? diagnostic.error?.code, keys: Object.keys(diagnostic.data ?? {}) }) + '\n');
      }
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      process.stderr.write(`sales bridge: ${error.code ?? error.name}\n`);
      res.writeHead(500); res.end('Fixture request incomplete');
    }
  });
  await new Promise(resolve => server.listen(Number(new URL(config.salesUrl).port), '127.0.0.1', resolve));
  shutdown = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); };
} else if (role === 'host' || role === 'worker') {
  const { S3Cas } = await import('@mn/storage');
  const { AgentOsKernel } = await import('@mn/kernel');
  const { AgentOsWorker, createBusinessActionWorkerHandler, createSalesBusinessProvider } = await import('@mn/worker');
  const { createAgentOsHost, configureProductProjectionJournal } = await import('@mn/host');
  const { createPostgresPool } = await import('./lib/postgres-pool.mjs');
  const { PostgresKernelStore } = await import('./lib/postgres-kernel-store.mjs');
  const { PostgresWorkerStore } = await import('./lib/postgres-worker-store.mjs');
  const { createEnterpriseWorkerStore } = await import('./lib/enterprise-worker-store.mjs');
  const { VaultTransitKeyProvider, VaultModelSecretStore } = await import('./lib/enterprise-secrets.mjs');
  const { SigV4S3Client } = await import('./lib/s3-client.mjs');
  const { OidcIdentityResolver } = await import('./lib/oidc-identity.mjs');
  const workerId = process.argv[3] ?? 'fixture-host';
  const pool = createPostgresPool({ connectionString: config.osDatabase, application_name: workerId, max: 6 });
  const hmacKey = Buffer.from(config.hmacKey, 'base64');
  const kernelStore = new PostgresKernelStore({ pool, hmacKey });
  await kernelStore.initialize();
  const transact = kernelStore.transact.bind(kernelStore);
  kernelStore.transact = async (...args) => {
    try { return await transact(...args); }
    catch (error) {
      let message = String(error.message ?? error.name).replace(/(?:https?|postgres):\/\/\S+/gu, '[redacted-url]');
      for (const value of [config.serviceToken, config.authorityToken, config.hmacKey]) message = message.split(value).join('[redacted]');
      process.stderr.write(JSON.stringify({ event: 'fixture_transaction_failure', code: error.code ?? error.name, message }) + '\n');
      throw error;
    }
  };
  const s3 = new SigV4S3Client({ endpoint: config.s3Endpoint, region: 'us-east-1', accessKeyId: 'mn-e2e', secretAccessKey: 'mn-e2e-secret-only' });
  const cas = new S3Cas({ client: s3, bucket: 'mn-os-artifacts', prefix: 'v2/' });
  const keys = new VaultTransitKeyProvider({ address: config.vaultUrl, token: 'mn-industry-fixture-only', mount: 'transit', keyName: 'industry-protected-payloads', individuallyRevocable: true });
  const ports = createSalesBusinessProvider({ endpoint: config.salesUrl + '/api/v1/os-business', tokenResolver: async () => config.serviceToken, allowInsecureHttp: true });
  if (role === 'host') {
    await kernelStore.setRuntimeLocks(config.engineLock, config.pluginLock);
    const oidc = new OidcIdentityResolver({ issuer: config.jwksUrl, audience: 'mn-industry-e2e', jwksUrl: config.jwksUrl + '/jwks.json' });
    const host = await createAgentOsHost({ profile: 'enterprise', store: kernelStore, cas,
      protectedPayloadKeyProvider: keys,
      secretStore: new VaultModelSecretStore({ address: config.vaultUrl, token: 'mn-industry-fixture-only', mount: 'secret' }),
      businessProvider: ports, businessWorkspaceScopes: config.workspaceId ? [{ tenantId: config.tenantId, workspaceId: config.workspaceId }] : [],
      businessAuthorityTokenResolver: async () => config.authorityToken,
      trustedWorkerSupportedKinds: ['business.action.execute'], identityResolver: req => oidc.resolve(req),
      readiness: async () => {
        const [pg, objectStore, kms] = await Promise.all([pool.query('select 1').then(() => true), s3.probe('mn-os-artifacts'), keys.probe()]);
        return { ready: pg && objectStore && kms, issues: [] };
      },
    });
    await host.listen({ host: '127.0.0.1', port: Number(new URL(config.hostUrl).port) });
    shutdown = async () => { await host.close(); };
  } else {
    configureProductProjectionJournal(kernelStore, cas, keys);
    const store = createEnterpriseWorkerStore({ kernelStore, jobStore: new PostgresWorkerStore({ pool, hmacKey }) });
    const kernel = new AgentOsKernel(store);
    const locks = await kernelStore.runtimeLocks();
    const worker = new AgentOsWorker({ id: workerId, store,
      lock: { engineLockDigest: config.engineLock, expectedEngineLockDigest: locks.engineLockDigest,
        pluginLockDigest: config.pluginLock, expectedPluginLockDigest: locks.pluginLockDigest },
      handlers: { 'business.action.execute': createBusinessActionWorkerHandler({ store, kernel, ports }) }, kinds: ['business.action.execute'] });
    const controller = new AbortController();
    let running = true;
    shutdown = async () => { running = false; controller.abort(); };
    process.stdout.write(JSON.stringify({ event: 'ready', role, workerId }) + '\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutdown());
    while (running) {
      try { const result = await worker.pollOnce(controller.signal); if (result.status !== 'idle') process.stdout.write(JSON.stringify(result) + '\n'); }
      catch (error) { process.stderr.write(JSON.stringify({ event: 'worker_error', code: error.code ?? error.name }) + '\n'); }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    await kernelStore.close();
    process.exit(0);
  }
} else throw new Error('FIXTURE_ROLE_INVALID');
process.stdout.write(JSON.stringify({ event: 'ready', role }) + '\n');
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (closing) return;
  closing = true;
  void shutdown().then(() => process.exit(0), () => process.exit(1));
});
