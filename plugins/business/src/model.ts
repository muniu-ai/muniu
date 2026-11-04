// SPDX-License-Identifier: Apache-2.0
import type { BusinessObjectRef, EnterpriseContractTypes, EvidenceRef, JsonObject } from '@mn/contracts';
export type BusinessCommand = EnterpriseContractTypes['EnterpriseBusinessCommand'];
export type BusinessObjectType = 'customer' | 'contact' | 'opportunity' | 'service_version' | 'quote_version' | 'contract' | 'order' | 'customer_acceptance' | 'project' | 'milestone' | 'delivery_version' | 'payment_schedule' | 'receipt' | 'refund' | 'adjustment' | 'expense' | 'business_review' | 'change_request' | 'metric_definition' | 'operating_objective';
export interface BusinessEvent {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly objectType: BusinessObjectType | 'business_approval';
    readonly objectId: string;
    readonly expectedStreamVersion: number;
    readonly type: string;
    readonly actorId: string;
    readonly occurredAt: string;
    readonly revisionSalt: string;
    readonly payload: JsonObject;
}
export interface BusinessObject {
    readonly reference: BusinessObjectRef;
    readonly value: JsonObject;
}
export interface BusinessState {
    readonly objects: Map<string, BusinessObject>;
    readonly approvals: Map<string, JsonObject>;
}
export interface BusinessPermissionRequirement {
    readonly object: BusinessObject;
    readonly operation: 'read' | 'write' | 'business_approve';
    readonly fields: readonly string[];
    readonly preparedByPrincipalId?: string;
}
export interface BusinessCommandContext {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly actorId: string;
    readonly actorKind: 'human' | 'agent' | 'service';
    readonly now: string;
    readonly revisionSalt: string;
    readonly assertCurrent: (requirement: BusinessPermissionRequirement) => void;
    readonly assertEvidence: (evidence: EvidenceRef, subject: BusinessObjectRef) => void;
}
export interface QuoteLine {
    readonly id: string;
    readonly service: BusinessObjectRef;
    readonly title: string;
    readonly unit: string;
    readonly scope: string;
    readonly acceptanceCriteria: readonly string[];
    readonly unitPriceMinor: number;
    readonly quantity: number;
    readonly totalMinor: number;
}
export interface OrderLine extends Omit<QuoteLine, 'id'> {
    readonly quoteLineId: string;
}
export type BusinessEvidence = EvidenceRef;
export class BusinessDomainError extends Error {
    constructor(readonly code: string, readonly status = 409) { super(code); this.name = 'BusinessDomainError'; }
}
