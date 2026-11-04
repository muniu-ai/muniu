// SPDX-License-Identifier: Apache-2.0
import type { BusinessObjectType } from './model.js';
const common = { ownerPrincipalId: 'public', preparedByPrincipalId: 'public', departmentId: 'public', createdAt: 'public', status: 'public' } as const;
export const BUSINESS_FIELD_CLASSES: Readonly<Record<BusinessObjectType, Readonly<Record<string, 'public' | 'price' | 'cost' | 'contact'>>>> = {
  customer: { ...common, name: 'public' },
  contact: { ...common, customer: 'public', name: 'public', email: 'contact', phone: 'contact' },
  opportunity: { ...common, customer: 'public', title: 'public' },
  service_version: { ...common, serviceCode: 'public', title: 'public', unit: 'public', unitPriceMinor: 'price', currency: 'public', scope: 'public',
    acceptanceCriteria: 'public', validFrom: 'public', validUntil: 'public', supersededBy: 'public' },
  quote_version: { ...common, opportunity: 'public', customer: 'public', scopeLines: 'public', lines: 'price', totalMinor: 'price', currency: 'public', validUntil: 'public', approvalId: 'public', acceptanceId: 'public' },
  contract: { ...common, title: 'public', quote: 'public', customer: 'public', scopeLines: 'public', lines: 'price', totalMinor: 'price', currency: 'public', approvalId: 'public', signatureEvidence: 'public' },
  order: { ...common, contract: 'public', customer: 'public', scopeLines: 'public', lines: 'price', totalMinor: 'price', currency: 'public', approvalId: 'public' },
  customer_acceptance: { ...common, subjectRef: 'public', evidence: 'public', confirmedByPrincipalId: 'public', confirmedAt: 'public', approvalId: 'public' },
};
