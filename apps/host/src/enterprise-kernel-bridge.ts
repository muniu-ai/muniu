// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, type JsonObject } from '@mn/contracts';
import { appendKernelEvent, type KernelStore, type KernelTransaction } from '@mn/kernel';
import { EnterpriseError, reduceIdentityEvents, type EnterpriseRecord } from '@mn/enterprise-services';
import type { EnterpriseEventRepository, EnterpriseSnapshot } from './enterprise-event-repository.js';
export const ENTERPRISE_SYSTEM_PREFIX = 'enterprise-system:';
export const ENTERPRISE_AGENT_PREFIX = 'enterprise-agent:';
export const enterpriseBudgetPrincipal = (workspaceId: string) => ENTERPRISE_SYSTEM_PREFIX + 'budget:' + workspaceId;
/** Runtime identity projections do not grant business access; every command still checks E1 facts. */
export class EnterpriseKernelBridge {
    readonly store: KernelStore;
    private readonly snapshots = new WeakMap<KernelTransaction, EnterpriseSnapshot>();
    constructor(readonly options: {
        store: KernelStore;
        repository: EnterpriseEventRepository;
        now?: () => string;
    }) {
        if (!options.repository.acceptsExecutionEvents)
            throw new EnterpriseError('ENTERPRISE_EXECUTION_REPOSITORY_REQUIRED', 503);
        this.store = {
            transact: async <T>(tenantId: string, work: (tx: KernelTransaction) => T): Promise<T> => {
                for (let attempt = 0; attempt < 8; attempt++) {
                    const snapshot = await options.repository.readSnapshot(tenantId);
                    let transaction: KernelTransaction | undefined;
                    try {
                        return await options.store.transact(tenantId, tx => {
                            if (!tx.beforeCommit || !tx.getStreamVersion || !tx.protectedFactStorage)
                                throw new EnterpriseError('PROTECTED_EXECUTION_STORAGE_REQUIRED', 503);
                            options.repository.assertSnapshot(tenantId, tx, snapshot);
                            transaction = tx;
                            this.snapshots.set(tx, snapshot);
                            tx.beforeCommit!(() => options.repository.assertSnapshot(tenantId, tx, snapshot));
                            this.synchronize(tx, snapshot);
                            return work(tx);
                        });
                    }
                    catch (error) {
                        if (!(error instanceof EnterpriseError) || error.code !== 'ENTERPRISE_SNAPSHOT_CHANGED')
                            throw error;
                    }
                    finally {
                        if (transaction)
                            this.snapshots.delete(transaction);
                    }
                }
                throw new EnterpriseError('CONCURRENT_COMMAND_RETRY', 409);
            },
            readEvents: (...args) => options.store.readEvents(...args),
            ...(options.store.readEventHistory ? { readEventHistory: (...args: Parameters<NonNullable<KernelStore['readEventHistory']>>) => options.store.readEventHistory!(...args) } : {}),
            ...(options.store.listTenantIds ? { listTenantIds: () => options.store.listTenantIds!() } : {}),
        };
    }
    snapshot(tx: KernelTransaction): EnterpriseSnapshot { const snapshot = this.snapshots.get(tx); if (!snapshot)
        throw new EnterpriseError('ENTERPRISE_TRANSACTION_REQUIRED', 503); return snapshot; }
    private synchronize(tx: KernelTransaction, snapshot: EnterpriseSnapshot): void {
        const state = reduceIdentityEvents(snapshot.records), organization = state.organization;
        if (!organization || organization.id !== snapshot.tenantId)
            throw new EnterpriseError('ORGANIZATION_NOT_FOUND', 404);
        const now = this.options.now?.() ?? new Date().toISOString();
        const sourceDate = (type: string, id: string) => [...snapshot.records].reverse().find(r => r.aggregateType === type && r.aggregateId === id)?.occurredAt ?? now;
        const write = (namespace: string, id: string, data: JsonObject, occurredAt: string) => {
            const old = tx.getProjection<JsonObject>(namespace, id), clean = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null)), prior = old ? Object.fromEntries(Object.keys(data).filter(key => old[key] !== undefined && old[key] !== null).map(key => [key, old[key]])) : undefined;
            if (prior && canonicalJson(prior) === canonicalJson(clean))
                return;
            const value: JsonObject = { ...old, ...clean, id, tenantId: snapshot.tenantId, streamVersion: Number(old?.streamVersion ?? 0) + 1, createdAt: String(old?.createdAt ?? occurredAt), updatedAt: occurredAt };
            for (const [key, entry] of Object.entries(data))
                if (entry === null)
                    delete (value as Record<string, unknown>)[key];
            tx.putProjection(namespace, id, value);
            appendKernelEvent(tx, { tenantId: snapshot.tenantId, aggregateType: namespace === 'membership' ? 'workspaceMembership' : namespace, aggregateId: id, expectedStreamVersion: Number(old?.streamVersion ?? 0), type: 'execution.identity_synchronized', actorId: ENTERPRISE_SYSTEM_PREFIX + 'identity', generation: 0, correlationId: 'enterprise-identity:' + snapshot.revision, publicPayload: { namespace, ...(typeof data.workspaceId === 'string' ? { workspaceId: data.workspaceId } : {}) } });
        };
        write('tenant', organization.id, { name: organization.name, enterpriseVersion: organization.streamVersion }, sourceDate('enterprise.organization', organization.id));
        for (const member of state.members.values()) {
            if (member.id.startsWith(ENTERPRISE_SYSTEM_PREFIX) || member.id.startsWith(ENTERPRISE_AGENT_PREFIX))
                continue;
            const date = sourceDate('enterprise.member', member.id), disabledAt = member.status === 'active' ? null : date;
            write('principal', member.id, { kind: 'human', displayName: member.displayName, disabledAt, enterpriseVersion: member.streamVersion, enterpriseSessionEpoch: member.sessionEpoch }, date);
        }
        for (const workspace of state.workspaces.values()) {
            const date = sourceDate('enterprise.workspace', workspace.id), old = tx.getProjection<JsonObject>('workspace', workspace.id);
            write('workspace', workspace.id, { name: workspace.name, viewMode: 'business', activePluginIds: old?.activePluginIds ?? ['business'], enterpriseVersion: workspace.streamVersion }, date);
            const system = enterpriseBudgetPrincipal(workspace.id);
            write('principal', system, { kind: 'service', displayName: '企业预算记账' }, date);
            write('membership', workspace.id + ':' + system, { workspaceId: workspace.id, principalId: system, workspaceRole: 'operator' }, date);
            for (const member of state.members.values()) {
                if (member.id.startsWith(ENTERPRISE_SYSTEM_PREFIX) || member.id.startsWith(ENTERPRISE_AGENT_PREFIX))
                    continue;
                write('membership', workspace.id + ':' + member.id, { workspaceId: workspace.id, principalId: member.id, workspaceRole: 'operator', removedAt: member.status === 'active' ? null : sourceDate('enterprise.member', member.id), enterpriseVersion: member.streamVersion }, sourceDate('enterprise.member', member.id));
            }
        }
    }
}
