// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { canonicalJson, type BusinessObjectRef, type JsonObject } from '@mn/contracts';
import { BusinessDomainError, type BusinessEvent, type BusinessObject, type BusinessState } from './model.js';
export const businessObjectKey = (type: string, id: string) => `${type}:${id}`;
export function businessDigest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
const patches: Readonly<Record<string, readonly string[]>> = {
    'customer.followup_scheduled': ['nextFollowupAt', 'nextStep'], 'opportunity.followup_scheduled': ['nextFollowupAt', 'nextStep'],
    'quote_version.package_issued': ['packageRefs'],
    'customer.renamed': ['name'], 'contact.updated': ['name', 'email', 'phone'], 'opportunity.updated': ['customer', 'title', 'departmentId'],
    'service_version.superseded': ['status', 'supersededBy'], 'quote_version.approved': ['status', 'approvalId'],
    'quote_version.accepted': ['status', 'acceptanceId'], 'contract.activated': ['status', 'approvalId', 'signatureEvidence'],
    'order.activated': ['status', 'approvalId'],
    'project.costs_confirmed': ['costReportId'], 'project.scope_blocked': ['status', 'changeRequestId'], 'project.scope_confirmed': ['status', 'order', 'scopeLines','scopeHistory'],
    'milestone.replanned': ['lines', 'order','status'], 'delivery_version.received': ['status', 'receivedBy', 'receivedAt'],
    'customer_acceptance.confirmed': ['status', 'approvalId', 'evidence', 'confirmedAt'],
    'payment_schedule.revised': ['termsHistory', 'amountMinor', 'dueDate', 'adjustmentId'],
    'payment_schedule.confirmed': ['status', 'approvalId', 'evidence', 'confirmedAt'],
    'receipt.confirmed': ['status', 'approvalId', 'evidence', 'confirmedAt'], 'receipt.cancelled': ['status'],
    'refund.confirmed': ['status', 'approvalId', 'evidence', 'confirmedAt'], 'refund.cancelled': ['status'],
    'adjustment.confirmed': ['status', 'approvalId', 'evidence', 'confirmedAt'], 'adjustment.cancelled': ['status'],
    'expense.confirmed': ['status', 'approvalId', 'evidence', 'confirmedAt'], 'expense.cancelled': ['status'],
    'change_request.priced': ['contract', 'status', 'lines', 'scopeLines', 'totalMinor', 'contractTotalMinor', 'commercialPreparedByPrincipalId'],
    'change_request.approved': ['status', 'approvalId', 'evidence', 'approvedAt', 'order'],
    'change_request.cancelled': ['status'],
    'change_request.completed': ['status', 'projectConfirmedBy', 'projectConfirmedAt'],
    'contract.amended': ['lines', 'scopeLines', 'totalMinor', 'changeRequestId'], 'order.amended': ['termsHistory', 'lines', 'scopeLines', 'totalMinor', 'contract', 'changeRequestId'],
};
const creations: Readonly<Record<string, string>> = {
    'followup_task.created': 'followup_task',
    'customer.created': 'customer', 'contact.created': 'contact', 'opportunity.created': 'opportunity', 'service_version.published': 'service_version',
    'project.created': 'project', 'milestone.created': 'milestone', 'delivery_version.reported': 'delivery_version',
    'customer_acceptance.prepared': 'customer_acceptance', 'payment_schedule.created': 'payment_schedule',
    'receipt.prepared': 'receipt', 'refund.prepared': 'refund', 'adjustment.prepared': 'adjustment', 'expense.prepared': 'expense',
    'metric_definition.published': 'metric_definition', 'operating_objective.created': 'operating_objective',
    'business_review.recorded': 'business_review', 'change_request.prepared': 'change_request',
    'quote_version.prepared': 'quote_version', 'contract.created': 'contract', 'order.created': 'order', 'customer_acceptance.recorded': 'customer_acceptance',
};
export function reduceBusinessEvents(events: readonly BusinessEvent[]): BusinessState {
    return applyBusinessEvents({ objects: new Map(), approvals: new Map() }, events);
}
export function applyBusinessEvents(initial: BusinessState, events: readonly BusinessEvent[]): BusinessState {
    const state: BusinessState = { objects: new Map(initial.objects), approvals: new Map(initial.approvals) };
    for (const event of events) {
        if (!/^[a-f0-9]{64}$/u.test(event.revisionSalt) || !event.tenantId || !event.workspaceId)
            throw new BusinessDomainError('BUSINESS_EVENT_HISTORY_INVALID', 503);
        if (event.objectType === 'business_approval') {
            if (event.type !== 'business_approval.recorded' || event.expectedStreamVersion !== 0 || state.approvals.has(event.objectId))
                throw new BusinessDomainError('BUSINESS_EVENT_HISTORY_INVALID', 503);
            state.approvals.set(event.objectId, structuredClone(event.payload));
            continue;
        }
        const key = businessObjectKey(event.objectType, event.objectId), previous = state.objects.get(key);
        if ((previous?.reference.streamVersion ?? 0) !== event.expectedStreamVersion || (previous &&
            (previous.reference.tenantId !== event.tenantId || previous.reference.workspaceId !== event.workspaceId)))
            throw new BusinessDomainError('BUSINESS_EVENT_HISTORY_INVALID', 503);
        let value: JsonObject;
        if (creations[event.type] === event.objectType) {
            if (previous)
                throw new BusinessDomainError('BUSINESS_EVENT_HISTORY_INVALID', 503);
            value = structuredClone(event.payload);
        }
        else {
            const allowed = patches[event.type];
            if (!previous || !event.type.startsWith(`${event.objectType}.`) || !allowed || Object.keys(event.payload).some(key => !allowed.includes(key)))
                throw new BusinessDomainError('BUSINESS_EVENT_HISTORY_INVALID', 503);
            value = { ...structuredClone(previous.value), ...structuredClone(event.payload) };
            if (event.type === 'opportunity.updated' && !Object.hasOwn(event.payload, 'departmentId')) {
                const { departmentId: _department, ...rest } = value;
                value = rest;
            }
            if (event.type === 'contact.updated')
                value = Object.fromEntries(Object.entries(value).filter(([field]) => !['email', 'phone'].includes(field) || Object.hasOwn(event.payload, field)));
        }
        const reference: BusinessObjectRef = { tenantId: event.tenantId, workspaceId: event.workspaceId, objectType: event.objectType,
            objectId: event.objectId, streamVersion: event.expectedStreamVersion + 1,
            // The salt stays inside encrypted facts; public references cannot enumerate hidden prices or contact values.
            digest: businessDigest([event.tenantId, event.workspaceId, event.objectType, event.objectId, event.expectedStreamVersion + 1, event.revisionSalt, value]) };
        state.objects.set(key, { reference, value });
    }
    return state;
}
export function findBusinessObject(state: BusinessState, type: string, id: string): BusinessObject | undefined { return state.objects.get(businessObjectKey(type, id)); }
