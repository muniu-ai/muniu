// SPDX-License-Identifier: Apache-2.0
import type { BusinessObjectType } from './model.js';
const common = { ownerPrincipalId: 'public', preparedByPrincipalId: 'public', departmentId: 'public', createdAt: 'public', status: 'public' } as const;
export const BUSINESS_FIELD_CLASSES: Readonly<Record<BusinessObjectType, Readonly<Record<string, 'public' | 'price' | 'cost' | 'contact'>>>> = {
    metric_definition: { ...common, metric: 'public', title: 'public', algorithmVersion: 'public' },
    operating_objective: { ...common, order: 'public', metric: 'public', periodStart: 'public', periodEnd: 'public', targetMinor: 'price', costTargetMinor: 'cost', responsiblePrincipalId: 'public' },
    project: { ...common, order: 'public', title: 'public', scopeLines: 'public', scopeHistory:'public',costReportId: 'cost', changeRequestId: 'public' },
    milestone: { ...common, project: 'public', order: 'public', title: 'public', dueDate: 'public', lines: 'public' },
    delivery_version: { ...common, project: 'public', order: 'public', milestone: 'public', summary: 'public', lines: 'public', receivedBy: 'public', receivedAt: 'public' },
    payment_schedule: { ...common, termsHistory: 'price', adjustmentId: 'public', order: 'public', amountMinor: 'price', dueDate: 'public', businessDate: 'public', currency: 'public', approvalId: 'public', evidence: 'public', confirmedAt: 'public' },
    receipt: { ...common, order: 'public', amountMinor: 'price', businessDate: 'public', allocations: 'price', currency: 'public', approvalId: 'public', evidence: 'public', confirmedAt: 'public' },
    refund: { ...common, order: 'public', receipt: 'public', amountMinor: 'price', businessDate: 'public', releasedAllocations: 'price', currency: 'public', approvalId: 'public', evidence: 'public', confirmedAt: 'public' },
    adjustment: { ...common, proposedAmountMinor: 'price', proposedDueDate: 'public', order: 'public', kind: 'public', receipt: 'public', schedule: 'public', amountMinor: 'price', businessDate: 'public', reason: 'price', releasedAllocations: 'price', currency: 'public', approvalId: 'public', evidence: 'public', confirmedAt: 'public' },
    expense: { ...common, order: 'public', project: 'public', amountMinor: 'cost', businessDate: 'public', description: 'cost', currency: 'public', approvalId: 'public', evidence: 'public', confirmedAt: 'public' },
    business_review: { ...common, purpose: 'public', algorithmVersion: 'public', order: 'public', project: 'public', periodStart: 'public', periodEnd: 'public', sourceRefs: 'public', financialSources: 'price', costSources: 'cost', observedAt: 'public', objective: 'public', objectiveResult: 'price', financialMetrics: 'price', deliveryMetrics: 'public', costMetrics: 'cost', expenseRefs: 'cost', zeroCost: 'cost', evidence: 'cost', approvalId: 'public', recordedAt: 'public' },
    change_request: { ...common, project: 'public', order: 'public', contract: 'public', description: 'public', lines: 'price', scopeLines: 'public', totalMinor: 'price', contractTotalMinor: 'price', commercialPreparedByPrincipalId: 'public', approvalId: 'public', evidence: 'price', approvedAt: 'public', projectConfirmedBy: 'public', projectConfirmedAt: 'public' },
    customer: { ...common, name: 'public' },
    contact: { ...common, customer: 'public', name: 'public', email: 'contact', phone: 'contact' },
    opportunity: { ...common, customer: 'public', title: 'public' },
    service_version: { ...common, serviceCode: 'public', title: 'public', unit: 'public', unitPriceMinor: 'price', currency: 'public', scope: 'public',
        acceptanceCriteria: 'public', validFrom: 'public', validUntil: 'public', supersededBy: 'public' },
    quote_version: { ...common, opportunity: 'public', customer: 'public', scopeLines: 'public', lines: 'price', totalMinor: 'price', currency: 'public', validUntil: 'public', approvalId: 'public', acceptanceId: 'public' },
    contract: { ...common, changeRequestId: 'public', title: 'public', quote: 'public', customer: 'public', scopeLines: 'public', lines: 'price', totalMinor: 'price', currency: 'public', approvalId: 'public', signatureEvidence: 'public' },
    order: { ...common, termsHistory: 'price', changeRequestId: 'public', contract: 'public', customer: 'public', scopeLines: 'public', lines: 'price', totalMinor: 'price', currency: 'public', approvalId: 'public' },
    customer_acceptance: { ...common, purpose: 'public', project: 'public', order: 'public', delivery: 'public', lines: 'public', subjectRef: 'public', evidence: 'public', confirmedByPrincipalId: 'public', confirmedAt: 'public', approvalId: 'public' },
};
