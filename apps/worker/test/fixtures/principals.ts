// SPDX-License-Identifier: Apache-2.0
import { appendKernelEvent, type KernelStore } from '@mn/kernel';
export async function seedFixturePrincipals(store: KernelStore, tenantId: string, ids: readonly string[], occurredAt: string): Promise<void> {
  await store.transact(tenantId, tx => {
    for (const id of ids) {
      tx.putProjection('principal', id, { id, tenantId, kind: 'human', displayName: id, streamVersion: 1, createdAt: occurredAt, updatedAt: occurredAt });
      appendKernelEvent(tx, { tenantId, aggregateType: 'principal', aggregateId: id, expectedStreamVersion: 0,
        type: 'principal.fixture_registered', actorId: id, generation: 0, correlationId: id, publicPayload: {} });
    }
  });
}
