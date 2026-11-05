// SPDX-License-Identifier: Apache-2.0
import { randomUUID, createHash } from 'node:crypto';
import { canonicalJson, type JsonValue } from '@mn/contracts';
import type { KernelStore, KernelTransaction } from '@mn/kernel';
import { EnterpriseError, type EnterpriseRecord, type EnterpriseRepository } from '@mn/enterprise-services';
import { EnvelopeCipher, type ContentAddressedStorage, type EncryptedEnvelopeV1, type KeyProvider } from '@mn/storage';
interface Snapshot { records: EnterpriseRecord[]; position: number; revision: number; }
export interface EnterpriseSnapshot { readonly tenantId: string; readonly records: readonly EnterpriseRecord[]; readonly position: number; readonly revision: number; }
export interface EnterpriseEventRepository extends EnterpriseRepository {
  readonly acceptsExecutionEvents: boolean;
  readSnapshot(tenantId: string): Promise<EnterpriseSnapshot>;
  assertSnapshot(tenantId: string, tx: KernelTransaction, snapshot: EnterpriseSnapshot): void;
  readCurrent<T extends JsonValue>(tenantId: string, project: (records: readonly EnterpriseRecord[]) => T): Promise<T>;
}

/** Domain events are authoritative. This adapter never reads product projections. */
export function createEnterpriseEventRepository(options: { store: KernelStore; cas: ContentAddressedStorage; keyProvider: KeyProvider; allowExecutionEvents?: boolean }): EnterpriseEventRepository {
  if (!options.store.readEventHistory) throw new Error('企业运行需要完整的认证事件历史');
  const snapshots = new Map<string, Snapshot>();
  const queues = new Map<string, Promise<unknown>>();
  const cipher = new EnvelopeCipher(options.keyProvider);
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
  async function serial<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    const prior = queues.get(tenantId) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(work);
    queues.set(tenantId, current);
    try { return await current; } finally { if (queues.get(tenantId) === current) queues.delete(tenantId); }
  }
  async function load(tenantId: string): Promise<Snapshot> {
    const cached = snapshots.get(tenantId) ?? { records: [], position: 0, revision: 0 };
    const next: Snapshot = { records: [...cached.records], position: cached.position, revision: cached.revision };
    let pending = 0;
    while (true) {
      const page = await options.store.readEventHistory!(tenantId, next.position, 1000);
      for (const event of page.events) {
        if (!event.type.startsWith('enterprise.')) {
          if (!options.allowExecutionEvents || next.revision === 0 || !next.records.some(record => record.type === 'enterprise.organization.provisioned'))
            throw new EnterpriseError('ENTERPRISE_STATE_NAMESPACE_REQUIRED', 503);
          next.position = event.position;
          continue;
        }
        if (event.type === 'enterprise.batch.committed') {
          if (event.streamVersion !== next.revision + 1 || event.publicPayload.recordCount !== pending) throw new EnterpriseError('EVENT_HISTORY_INVALID', 503);
          next.revision = event.streamVersion; pending = 0;
        } else {
          const recordId = event.publicPayload.recordId;
          if (!event.protectedPayloadRef || typeof recordId !== 'string') throw new EnterpriseError('EVENT_HISTORY_INVALID', 503);
          const bytes = await options.cas.get(event.protectedPayloadRef);
          if (hash(bytes) !== event.protectedPayloadRef) throw new EnterpriseError('PROTECTED_CONTENT_INVALID', 503);
          const envelope = JSON.parse(bytes.toString('utf8')) as EncryptedEnvelopeV1;
          if (envelope.context.tenantId !== tenantId || envelope.context.purpose !== `enterprise-event:${recordId}`) throw new EnterpriseError('PROTECTED_CONTENT_SCOPE_MISMATCH', 503);
          const plaintext = await cipher.decrypt(envelope);
          let record: EnterpriseRecord;
          try { record = JSON.parse(plaintext.toString('utf8')) as EnterpriseRecord; } finally { plaintext.fill(0); }
          if (record.type !== event.type || record.aggregateType !== event.aggregateType || record.aggregateId !== event.aggregateId
            || record.expectedStreamVersion + 1 !== event.streamVersion || record.actorId !== event.actorId) throw new EnterpriseError('EVENT_HISTORY_INVALID', 503);
          next.records.push(record); pending++;
        }
        next.position = event.position;
      }
      if (page.events.length < 1000) break;
    }
    if (pending) throw new EnterpriseError('EVENT_BATCH_INCOMPLETE', 503);
    snapshots.set(tenantId, next);
    return next;
  }
  const repository: EnterpriseEventRepository = {
    acceptsExecutionEvents: options.allowExecutionEvents === true,
    async readSnapshot(tenantId) { return serial(tenantId, async () => structuredClone({tenantId, ...await load(tenantId)})); },
    assertSnapshot(tenantId, tx, snapshot) {
      if (!tx.getStreamVersion) throw new EnterpriseError('EXECUTION_STORE_REQUIRED', 503);
      if (snapshot.tenantId !== tenantId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH');
      if (tx.getStreamVersion('enterprise.batch',tenantId) !== snapshot.revision) throw new EnterpriseError('ENTERPRISE_SNAPSHOT_CHANGED',409);
    },
    async readCurrent<T extends JsonValue>(tenantId: string, project: (records: readonly EnterpriseRecord[]) => T): Promise<T> {
      if (typeof project !== 'function' || project.constructor.name === 'AsyncFunction') throw new EnterpriseError('CONSISTENT_READ_INVALID', 503);
      for (let attempt = 0; attempt < 8; attempt++) {
        // Snapshot loading releases the tenant queue before entering the native transaction.
        const snapshot = await repository.readSnapshot(tenantId);
        const evaluate = (): T => {
          const value: unknown = project(structuredClone(snapshot.records));
          if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value && typeof value.then === 'function') {
            if (value instanceof Promise) void value.catch(() => {});
            throw new EnterpriseError('CONSISTENT_READ_INVALID', 503);
          }
          return structuredClone(value) as T;
        };
        try {
          return await options.store.transact(tenantId, tx => {
            if (typeof tx.beforeCommit !== 'function' || typeof tx.getStreamVersion !== 'function') throw new EnterpriseError('CONSISTENT_READ_REQUIRED', 503);
            repository.assertSnapshot(tenantId, tx, snapshot);
            const value = evaluate(), fingerprint = canonicalJson(value);
            tx.beforeCommit(() => {
              repository.assertSnapshot(tenantId, tx, snapshot);
              if (canonicalJson(evaluate()) !== fingerprint) throw new EnterpriseError('ENTERPRISE_READ_CHANGED', 409);
            });
            return value;
          });
        } catch (error) {
          if (!(error instanceof EnterpriseError) || !['ENTERPRISE_SNAPSHOT_CHANGED', 'ENTERPRISE_READ_CHANGED'].includes(error.code)) throw error;
        }
      }
      throw new EnterpriseError('CONCURRENT_READ_RETRY', 409);
    },
    async read(tenantId) { return serial(tenantId, async () => structuredClone((await load(tenantId)).records)); },
    async transact(tenantId, work) {
      return serial(tenantId, async () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const snapshot = await load(tenantId);
          const change = work(structuredClone(snapshot.records));
          if (!change.events.length) return change.value;
          const prepared = await Promise.all(change.events.map(async record => {
            if (!record.type.startsWith('enterprise.') || record.type === 'enterprise.batch.committed') throw new EnterpriseError('EVENT_TYPE_INVALID', 500);
            const recordId = randomUUID();
            const plaintext = Buffer.from(canonicalJson(record));
            let envelope: EncryptedEnvelopeV1;
            try { envelope = await cipher.encrypt(plaintext, { tenantId, purpose: `enterprise-event:${recordId}` }); }
            finally { plaintext.fill(0); }
            const bytes = Buffer.from(canonicalJson(envelope));
            const stored = await options.cas.put(bytes);
            if (stored.digest !== hash(bytes) || stored.byteLength !== bytes.byteLength) throw new EnterpriseError('PROTECTED_CONTENT_INVALID', 503);
            return { record, recordId, protectedPayloadRef: stored.digest };
          }));
          try {
            await options.store.transact(tenantId, tx => {
              const validate = () => { if (change.assertBeforeCommit) {
                if (change.assertBeforeCommit.constructor.name === 'AsyncFunction') throw new EnterpriseError('COMMIT_GUARD_INVALID', 503);
                const result: unknown = change.assertBeforeCommit();
                if (result !== undefined) {
                  if (result instanceof Promise) void result.catch(() => {});
                  throw new EnterpriseError('COMMIT_GUARD_INVALID', 503);
                }
              }
              };
              validate();
              if (change.assertBeforeCommit) {
                if(!tx.beforeCommit) throw new EnterpriseError('COMMIT_GUARD_UNAVAILABLE',503);
                tx.beforeCommit(validate);
              }
              for (const item of prepared) tx.appendEvent({ tenantId, aggregateType: item.record.aggregateType, aggregateId: item.record.aggregateId,
                expectedStreamVersion: item.record.expectedStreamVersion, type: item.record.type, actorId: item.record.actorId,
                generation: 0, correlationId: item.recordId, publicPayload: { recordId: item.recordId }, protectedPayloadRef: item.protectedPayloadRef });
              // A failed guard rolls back the entire transaction, including its domain events.
              tx.appendEvent({ tenantId, aggregateType: 'enterprise.batch', aggregateId: tenantId,
                expectedStreamVersion: snapshot.revision, type: 'enterprise.batch.committed', actorId: prepared[0]!.record.actorId,
                generation: 0, correlationId: prepared[0]!.recordId, publicPayload: { recordCount: prepared.length } });
            });
            return change.value;
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'STREAM_VERSION_CONFLICT') throw error;
          }
        }
        throw new EnterpriseError('CONCURRENT_COMMAND_RETRY', 409);
      });
    },
  };
  return repository;
}
