// SPDX-License-Identifier: Apache-2.0
import type { Principal } from '@mn/contracts';
import { appendKernelEvent, KernelError, type KernelStore } from '@mn/kernel';

/** Only the Host's successful enterprise identity resolver may call this port. */
export async function registerAuthenticatedPrincipal(options: {
  readonly store: KernelStore;
  readonly tenantId: string;
  readonly principalId: string;
  readonly now: () => string;
  readonly id: (kind: string) => string;
}): Promise<void> {
  const validId = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 200
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!validId(options.tenantId) || !validId(options.principalId))
    throw new KernelError('AUTHENTICATION_REQUIRED', '企业身份标识无效', '重新登录后重试');
  await options.store.transact(options.tenantId, tx => {
    const principal = tx.getProjection<Principal>('principal', options.principalId);
    if (principal) {
      if (principal.id !== options.principalId || principal.tenantId !== options.tenantId || principal.kind !== 'human'
        || principal.disabledAt !== undefined || !Number.isSafeInteger(principal.streamVersion) || principal.streamVersion < 1)
        throw new KernelError('PRINCIPAL_ACCESS_DENIED', '当前企业身份不可用', '联系管理员核对身份状态');
      return;
    }
    const now = options.now();
    tx.putProjection<Principal>('principal', options.principalId, {
      id: options.principalId, tenantId: options.tenantId, kind: 'human', displayName: options.principalId,
      streamVersion: 1, createdAt: now, updatedAt: now,
    });
    // An existing stream with a missing projection must conflict, never reactivate.
    appendKernelEvent(tx, {
      tenantId: options.tenantId, aggregateType: 'principal', aggregateId: options.principalId,
      expectedStreamVersion: 0, type: 'principal.authenticated', actorId: options.principalId,
      generation: 0, correlationId: options.id('principal-authentication'), publicPayload: {},
    });
  });
}
