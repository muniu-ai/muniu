// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { mkdir, readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { acquireLocalStateLock, FileCas, MacOsKeychainKeyProvider, SqliteStorage, runKeychainCommand, type KeyProvider } from '@mn/storage';
import { createEnterpriseEventRepository } from './enterprise-event-repository.js';
import { createEnterpriseHost, type EnterpriseHostOptions } from './enterprise-host.js';
import type { EnterpriseIdentityService } from '@mn/enterprise-services';
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
export interface StartEnterpriseLocalOptions extends Omit<EnterpriseHostOptions, 'repository'> {
  readonly stateRoot?: string;
  readonly host?: string;
  readonly port?: number;
  readonly organizations: readonly Parameters<EnterpriseIdentityService['provision']>[0][];
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
    store = new SqliteStorage({ databaseFile, hmacKey: keys.hmacKey });
    const repository = createEnterpriseEventRepository({ store, cas: new FileCas({ rootDir: join(root, 'objects') }), keyProvider: keys.keyProvider });
    host = createEnterpriseHost({ ...options, repository });
    for (const organization of options.organizations) {
      if (options.providers[organization.tenantId]?.issuer !== organization.issuer) throw new Error('OIDC_PROVISIONING_ISSUER_MISMATCH');
      await host.identity.provision(organization);
    }
    const address = await host.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 7319 });
    const activeHost = host, activeStore = store;
    let closed = false;
    return { ...host, address, stateRoot: root, async close() {
      if (closed) return; closed = true;
      try { await activeHost.close(); } finally { try { await activeStore.close(); } finally { lock.release(); } }
    } };
  } catch (error) {
    try { await host?.close(); } finally { try { await store?.close(); } finally { lock.release(); } }
    throw error;
  }
}
