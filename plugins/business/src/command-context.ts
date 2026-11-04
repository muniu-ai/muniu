// SPDX-License-Identifier: Apache-2.0
import type { BusinessObjectRef, EvidenceRef, JsonObject } from '@mn/contracts';
import { BusinessDomainError, type BusinessCommand, type BusinessCommandContext, type BusinessEvent, type BusinessObject, type BusinessObjectType, type BusinessState } from './model.js';
import { businessDigest, businessObjectKey } from './state.js';
export const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
export function fail(code: string, status = 409): never { throw new BusinessDomainError(code, status); }
export const valueAs = <T>(value: unknown): T => value as T;
export function money(value: bigint): number { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    fail('MONEY_OUT_OF_RANGE', 400); return Number(value); }
export function businessCommandTools(state: BusinessState, command: BusinessCommand, context: BusinessCommandContext) {
    if (!context.actorId || !Number.isFinite(Date.parse(context.now)) || !/^[a-f0-9]{64}$/u.test(context.revisionSalt))
        fail('BUSINESS_CONTEXT_INVALID', 503);
    const events: BusinessEvent[] = [];
    const scope = { tenantId: context.tenantId, workspaceId: context.workspaceId };
    const check = (object: BusinessObject, operation: 'read' | 'write' | 'business_approve', fields: readonly string[], preparedByPrincipalId?: string) => {
        const result: unknown = context.assertCurrent({ object: structuredClone(object), operation, fields, ...(preparedByPrincipalId ? { preparedByPrincipalId } : {}) });
        if (result !== undefined) {
            if (result instanceof Promise)
                void result.catch(() => { });
            fail('BUSINESS_POLICY_INVALID', 503);
        }
    };
    const find = (type: BusinessObjectType, id: string): BusinessObject => {
        const object = state.objects.get(businessObjectKey(type, id));
        if (!object || object.reference.tenantId !== context.tenantId || object.reference.workspaceId !== context.workspaceId)
            fail('OBJECT_NOT_FOUND', 404);
        return object!;
    };
    const source = (ref: BusinessObjectRef, type: BusinessObjectType, fields: readonly string[], operation: 'read' | 'write' = 'read'): BusinessObject => {
        if (ref.tenantId !== context.tenantId || ref.workspaceId !== context.workspaceId || ref.objectType !== type)
            fail('OBJECT_SCOPE_MISMATCH', 403);
        const object = find(type, ref.objectId);
        check(object, operation, fields);
        if (object.reference.streamVersion !== ref.streamVersion || object.reference.digest !== ref.digest)
            fail('SOURCE_VERSION_CONFLICT');
        return object;
    };
    const event = (objectType: BusinessEvent['objectType'], objectId: string, version: number, type: string, payload: unknown) => {
        events.push({ ...scope, objectType, objectId, expectedStreamVersion: version, type, actorId: context.actorId,
            occurredAt: context.now, revisionSalt: context.revisionSalt, payload: json(payload) });
    };
    const create = (type: BusinessObjectType, id: string, suffix: string, data: JsonObject) => {
        const existing = state.objects.get(businessObjectKey(type, id));
        if (existing) {
            check(existing, 'write', []);
            fail('OBJECT_ALREADY_EXISTS');
        }
        const value = { ownerPrincipalId: context.actorId, preparedByPrincipalId: context.actorId, createdAt: context.now, ...data };
        check({ reference: { ...scope, objectType: type, objectId: id, streamVersion: 1, digest: '0'.repeat(64) }, value }, 'write', Object.keys(value));
        event(type, id, 0, `${type}.${suffix}`, value);
    };
    const current = (type: BusinessObjectType, id: string, expected: number, fields: readonly string[], operation: 'write' | 'business_approve' = 'write') => {
        const object = find(type, id);
        check(object, operation, fields);
        if (object.reference.streamVersion !== expected)
            fail('STREAM_VERSION_CONFLICT');
        return object;
    };
    const confirm = (object: BusinessObject, fields: readonly string[]): string => {
        if (context.actorKind !== 'human')
            fail('HUMAN_CONFIRMATION_REQUIRED', 403);
        const maker = String(object.value.preparedByPrincipalId ?? '');
        check(object, 'business_approve', fields, maker);
        if (!maker || maker === context.actorId)
            fail('SEPARATION_OF_DUTIES_REQUIRED', 403);
        const id = businessDigest([object.reference, command.type, context.actorId]);
        event('business_approval', id, 0, 'business_approval.recorded', { ...scope, id, streamVersion: 1, subjectRef: object.reference,
            actionDigest: businessDigest(command), preparedByPrincipalId: maker, approvedByPrincipalId: context.actorId, decision: 'approve', decidedAt: context.now });
        return id;
    };
    const evidence = (proof: EvidenceRef, object: BusinessObject) => {
        if (proof.tenantId !== context.tenantId || proof.workspaceId !== context.workspaceId || proof.sourceKind === 'candidate_experience')
            fail('EVIDENCE_SCOPE_MISMATCH', 403);
        const result: unknown = context.assertEvidence(proof, object.reference);
        if (result !== undefined) {
            if (result instanceof Promise)
                void result.catch(() => { });
            fail('EVIDENCE_VERIFIER_INVALID', 503);
        }
    };
    const activeService = (object: BusinessObject) => {
        if (object.value.status !== 'active' || Date.parse(String(object.value.validFrom)) > Date.parse(context.now)
            || Date.parse(String(object.value.validUntil)) <= Date.parse(context.now))
            fail('SERVICE_VERSION_UNAVAILABLE');
    };
    const parentFields = (parent: BusinessObject): JsonObject => ({ ...(parent.value.departmentId ? { departmentId: parent.value.departmentId } : {}) });
    return { events, scope, check, find, source, event, create, current, confirm, evidence, activeService, parentFields };
}
export type BusinessCommandTools = ReturnType<typeof businessCommandTools>;
