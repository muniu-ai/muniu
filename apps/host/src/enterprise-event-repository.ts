// SPDX-License-Identifier: Apache-2.0
import { randomUUID, createHash } from 'node:crypto';
import { canonicalJson } from '@mn/contracts';
import type { KernelStore } from '@mn/kernel';
import { EnterpriseError, type EnterpriseRecord, type EnterpriseRepository } from '@mn/enterprise-services';
import { EnvelopeCipher, type ContentAddressedStorage, type EncryptedEnvelopeV1, type KeyProvider } from '@mn/storage';
interface Snapshot { records: EnterpriseRecord[]; position: number; revision: number; }

/** Domain events are authoritative. This adapter never reads product projections. */
export function createEnterpriseEventRepository(options: { store: KernelStore; cas: ContentAddressedStorage; keyProvider: KeyProvider }): EnterpriseRepository {
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
        if (!event.type.startsWith('enterprise.')) throw new EnterpriseError('ENTERPRISE_STATE_NAMESPACE_REQUIRED', 503);
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
  return {
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
              if (change.assertBeforeCommit) {
                if (change.assertBeforeCommit.constructor.name === 'AsyncFunction') throw new EnterpriseError('COMMIT_GUARD_INVALID', 503);
                const result: unknown = change.assertBeforeCommit();
                if (result !== undefined) {
                  if (result instanceof Promise) void result.catch(() => {});
                  throw new EnterpriseError('COMMIT_GUARD_INVALID', 503);
                }
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
}
