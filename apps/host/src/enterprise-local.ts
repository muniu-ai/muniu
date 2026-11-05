// SPDX-License-Identifier: Apache-2.0
import { EnterpriseWorkflowService } from './enterprise-workflows.js';
import { EnterpriseKnowledgeService } from './enterprise-knowledge.js';
import { EnterpriseArtifactService } from './enterprise-artifacts.js';
import { EnterpriseExperienceService } from './enterprise-experience.js';
import { EnterpriseGoalService } from './enterprise-goals.js';
import { EnterpriseTaskRuntime } from './enterprise-task-runtime.js';
import type { EvaluationModel } from './enterprise-evaluation.js';
import { EnterpriseEvaluationRuntime } from './enterprise-evaluation.js';
import { AgentOsWorker } from '@mn/worker';
import { reduceIdentityEvents } from '@mn/enterprise-services';
import { EnterpriseOperatingService } from './enterprise-operating.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { mkdir, readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { acquireLocalStateLock, FileCas, MacOsKeychainKeyProvider, SqliteStorage, DEFAULT_PROJECTION_JOURNAL_NAMESPACES, runKeychainCommand, type KeyProvider } from '@mn/storage';
import { EnterpriseExecutionRuntime } from './enterprise-execution-runtime.js';
import { EnterpriseProviderService } from './enterprise-provider-service.js';
import { EnterpriseError } from '@mn/enterprise-services';
import { createEnterpriseEventRepository } from './enterprise-event-repository.js';
import { createEnterpriseHost, type EnterpriseHostOptions } from './enterprise-host.js';
import type { EnterpriseIdentityService, EnterpriseQuotaLimits } from '@mn/enterprise-services';
export const ENTERPRISE_KEYCHAIN_SERVICE = 'com.muniu.enterprise.v1';
const missing = (error: unknown) => error instanceof Error && /not found|could not be found|-25300|errSecItemNotFound/iu.test(error.message);
async function hmacKey(account: string, existing: boolean): Promise<Buffer> {
  let encoded: string;
  try { encoded = await runKeychainCommand(['find-generic-password', '-s', ENTERPRISE_KEYCHAIN_SERVICE, '-a', account, '-w']); }
  catch (error) {
    if (!missing(error) || existing) throw new Error('ENTERPRISE_KEY_UNAVAILABLE');
    encoded = randomBytes(32).toString('base64');
    await runKeychainCommand(['add-generic-password', '-s', ENTERPRISE_KEYCHAIN_SERVICE, '-a', account, '-w'], `${encoded}\n`);
  }
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== 32) throw new Error('ENTERPRISE_KEY_INVALID');
  return key;
}
export interface StartEnterpriseLocalOptions extends Omit<EnterpriseHostOptions, 'repository' | 'executionRuntime' | 'businessProviders' | 'operating' | 'evaluation' | 'goals'> {
  readonly operatingBackground?: boolean;
  readonly evaluationOptions?: Omit<ConstructorParameters<typeof EnterpriseEvaluationRuntime>[0], 'operating' | 'protection'> & { readonly modelsFor?: (tenantId: string, workspaceId: string) => readonly EvaluationModel[] };
  readonly executionProviders?: Pick<ConstructorParameters<typeof EnterpriseExecutionRuntime>[0], 'resolveProvider' | 'usageForReceipt'>;
  readonly stateRoot?: string;
  readonly host?: string;
  readonly port?: number;
  readonly organizations: readonly Parameters<EnterpriseIdentityService['provision']>[0][];
  readonly platformQuotas?: readonly { tenantId: string; idempotencyKey: string; expectedStreamVersion: number; limits: EnterpriseQuotaLimits; capacityEvidenceDigest?: string }[];
  /** Explicit trusted injection for fixtures or an operator-owned KMS adapter. */
  readonly keys?: { readonly hmacKey: Uint8Array; readonly keyProvider: KeyProvider };
}
export async function startEnterpriseLocalHost(options: StartEnterpriseLocalOptions) {
  const configured = options.stateRoot ?? process.env.MN_ENTERPRISE_STATE_ROOT ?? join(homedir(), '.muniu', 'enterprise-v1');
  if (!isAbsolute(configured) || !configured.trim()) throw new Error('ENTERPRISE_STATE_ROOT_INVALID');
  const root = resolve(configured), markerPath = join(root, 'enterprise-state.json');
  const stat = await lstat(root).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077))) throw new Error('ENTERPRISE_STATE_ROOT_INVALID');
  const entries = stat ? await readdir(root) : [];
  if (entries.length && !entries.includes('enterprise-state.json') && entries.some(name => name !== 'state.owner.lock')) throw new Error('ENTERPRISE_STATE_DIRECTORY_NOT_EMPTY');
  if (!stat) await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = await acquireLocalStateLock(root);
  let store: SqliteStorage | undefined;
  let host: ReturnType<typeof createEnterpriseHost> | undefined;
  try {
    let marker: { format: string; version: number; instanceId: string };
    try {
      const file = await lstat(markerPath);
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077)) throw new Error('ENTERPRISE_STATE_MARKER_INVALID');
      marker = JSON.parse(await readFile(markerPath, 'utf8')) as typeof marker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if ((await readdir(root)).some(name => name !== 'state.owner.lock')) throw new Error('ENTERPRISE_STATE_DIRECTORY_NOT_EMPTY');
      marker = { format: 'muniu.enterprise.state', version: 1, instanceId: randomUUID() };
      await writeFile(markerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    }
    if (marker.format !== 'muniu.enterprise.state' || marker.version !== 1 || !/^[0-9a-f-]{36}$/u.test(marker.instanceId)) throw new Error('ENTERPRISE_STATE_MARKER_INVALID');
    if (!options.keys && process.platform !== 'darwin') throw new Error('ENTERPRISE_KEY_PROVIDER_REQUIRED');
    const databaseFile = join(root, 'enterprise.sqlite');
    const existing = await lstat(databaseFile).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
    const keys = options.keys ?? { hmacKey: await hmacKey(`${marker.instanceId}:event-hmac`, existing),
      keyProvider: new MacOsKeychainKeyProvider({ account: `${marker.instanceId}:wrapping-key`, service: ENTERPRISE_KEYCHAIN_SERVICE }) };
    const cas = new FileCas({ rootDir: join(root, 'objects') });
    store = new SqliteStorage({ databaseFile, hmacKey: keys.hmacKey, now: () => new Date(options.now?.() ?? new Date().toISOString()), projectionJournal:{cas,keyProvider:keys.keyProvider,namespaces:DEFAULT_PROJECTION_JOURNAL_NAMESPACES} });
    const repository = createEnterpriseEventRepository({ store, cas, keyProvider: keys.keyProvider, allowExecutionEvents:true });
    let businessProviders: EnterpriseProviderService;
    const executionRuntime = new EnterpriseExecutionRuntime({store,repository,now:options.now,
      resolveProvider: options.executionProviders?.resolveProvider ?? ((tenantId, workspaceId, id) => businessProviders.resolveRuntime(tenantId, workspaceId, id)),
      usageForReceipt: options.executionProviders?.usageForReceipt ?? ((receipt, action) => {
        if (action.provider !== 'builtin' || receipt.provider !== 'builtin') throw new EnterpriseError('USAGE_METER_UNCONFIGURED', 503);
        return { tokens: 0, costMinorUnits: '0', currency: 'CNY' };
      }) });
    businessProviders = new EnterpriseProviderService({ store, repository, execution: executionRuntime, protection: { cas, keyProvider: keys.keyProvider }, now: options.now });
    const operating = new EnterpriseOperatingService({ store, repository, now: options.now });
    const evaluation = new EnterpriseEvaluationRuntime({ operating, protection: { cas, keyProvider: keys.keyProvider }, modelFor: options.evaluationOptions?.modelFor ?? (() => undefined), secretStore: options.evaluationOptions?.secretStore ?? { async read() { throw new EnterpriseError('MODEL_CREDENTIAL_UNAVAILABLE', 503); } }, ...options.evaluationOptions });
    const goals = new EnterpriseGoalService({ operating, modelsFor: options.evaluationOptions?.modelsFor ?? ((tenant, workspace) => { const model = options.evaluationOptions?.modelFor(tenant, workspace); return model ? [model] : []; }) });
    const taskRuntime = new EnterpriseTaskRuntime({ goals, protection: { cas, keyProvider: keys.keyProvider }, secretStore: evaluation.options.secretStore, invoke: options.evaluationOptions?.invoke, quote: options.evaluationOptions?.quote });
    const workflows = new EnterpriseWorkflowService({ operating });
    const knowledge = new EnterpriseKnowledgeService({ operating, protection: { cas, keyProvider: keys.keyProvider } });
    const artifacts = new EnterpriseArtifactService({ goals, knowledge }), experiences = new EnterpriseExperienceService({ artifacts, knowledge });
    host = createEnterpriseHost({ ...options, repository, executionRuntime, businessProviders, operating, evaluation, goals, workflows, knowledge, artifacts, experiences });
    for (const organization of options.organizations) {
      if (options.providers[organization.tenantId]?.issuer !== organization.issuer) throw new Error('OIDC_PROVISIONING_ISSUER_MISMATCH');
      await host.identity.provision(organization);
    }
    for (const quota of options.platformQuotas ?? []) await host.quotas.provision(quota.tenantId, quota.idempotencyKey, quota.expectedStreamVersion, quota.limits, quota.capacityEvidenceDigest);
    const address = await host.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 7319 });
    const activeHost = host, activeStore = store;
    let closed = false, cycle: Promise<void> | undefined;
    const stop = new AbortController();
    const worker = new AgentOsWorker({ id: 'enterprise-local-' + marker.instanceId, store: evaluation.workerStore(activeStore), now: () => new Date(options.now?.() ?? new Date().toISOString()),
      lock: { engineLockDigest: 'in-process', expectedEngineLockDigest: 'in-process', pluginLockDigest: 'in-process', expectedPluginLockDigest: 'in-process' }, handlers: { 'enterprise.evaluation': evaluation.workerHandler(), 'enterprise.task': taskRuntime.workerHandler(), 'provider.action.execute': executionRuntime.workerHandler() }, kinds: ['enterprise.evaluation', 'enterprise.task', 'provider.action.execute'] });
    const runOperatingCycle = () => {
      if (closed) return Promise.resolve();
      if (cycle) return cycle;
      cycle = (async () => {
        const tenants = options.organizations.map(o => o.tenantId);
        for (const tenant of tenants) {
          const identity = reduceIdentityEvents(await repository.read(tenant));
          for (const workspace of identity.workspaces.values()) {
            await operating.initializeWorkspace(tenant, workspace.id);
            await operating.ingestBusinessChanges(tenant, workspace.id);
            await operating.tick(tenant, workspace.id);
          }
          await goals.runTenant(tenant);
        }
        if (!closed) { await evaluation.dispatchFair(tenants); await worker.pollOnce(stop.signal); }
      })().finally(() => { cycle = undefined; });
      return cycle;
    };
    let operatingError: string | undefined;
    const timer = options.operatingBackground ? setInterval(() => { void runOperatingCycle().then(() => { operatingError = undefined; }, () => { operatingError = 'OPERATING_CYCLE_FAILED'; }); }, 5000) : undefined;
    timer?.unref();
    return { ...host, businessProviders, operating, evaluation, goals, workflows, knowledge, artifacts, experiences, taskRuntime, runOperatingCycle, operatingHealth: () => ({ ready: !operatingError, ...(operatingError ? { code: operatingError } : {}) }), address, stateRoot: root, async close() {
      if (closed) return; closed = true; if (timer) clearInterval(timer); stop.abort(); await cycle?.catch(() => {});
      try { await activeHost.close(); } finally { try { await activeStore.close(); } finally { lock.release(); } }
    } };
  } catch (error) {
    try { await host?.close(); } finally { try { await store?.close(); } finally { lock.release(); } }
    throw error;
  }
}
