// SPDX-License-Identifier: Apache-2.0
import { parseEnterpriseContract } from '@mn/contracts/enterprise-client';
import type { BusinessObjectRef, EnterpriseContractTypes } from '@mn/contracts';
import { EnterpriseApiFailure, type EnterpriseBrowserClient } from './client.js';
import { WorkspaceResource } from './workspace-resource.js';
import { formatDate, formatMoney } from './format.js';

type View = EnterpriseContractTypes['EnterpriseBusinessObjectView'];
type Capabilities = EnterpriseContractTypes['EnterpriseBusinessCapabilities'];
export interface ReferenceName { readonly status: 'ready' | 'denied' | 'unavailable' | 'stale' | 'unnamed' | 'invalid'; readonly reference?: BusinessObjectRef; readonly name?: string; }
export interface ReferenceNames { readonly owner: BusinessObjectRef; readonly fields: Readonly<Record<string, ReferenceName>>; }
export const BUSINESS_REFERENCE_FIELDS: Readonly<Record<string, BusinessObjectRef['objectType']>> = {
  customer: 'customer', opportunity: 'opportunity', quote: 'quote_version', contract: 'contract', order: 'order', project: 'project', milestone: 'milestone', delivery: 'delivery_version', objective: 'operating_objective', metric: 'metric_definition',
};
const nameFields: Readonly<Partial<Record<BusinessObjectRef['objectType'], readonly string[]>>> = {
  customer: ['name'], contact: ['name'], opportunity: ['title'], service_version: ['title', 'serviceCode'], contract: ['title'], project: ['title'], milestone: ['title'], delivery_version: ['summary'], metric_definition: ['title'],
};
function referenceSummary(view: View): string | undefined {
  const direct = (nameFields[view.reference.objectType] ?? []).map(key => Object.hasOwn(view.values, key) ? view.values[key] : undefined).find(value => typeof value === 'string' && value.trim().length > 0);
  if (typeof direct === 'string') return direct;
  const labels: Readonly<Partial<Record<BusinessObjectRef['objectType'], string>>> = { quote_version: '报价', order: '订单', operating_objective: '经营目标', payment_schedule: '付款期', receipt: '收款' };
  const label = labels[view.reference.objectType]; if (!label) return undefined;
  const parts: string[] = [], values = view.values;
  const lines = Array.isArray(values.scopeLines) ? values.scopeLines : Array.isArray(values.lines) ? values.lines : [];
  const titles = [...new Set(lines.flatMap(line => line && typeof line === 'object' && 'title' in line && typeof line.title === 'string' && line.title.trim() ? [line.title] : []))];
  if (titles.length) parts.push(titles.slice(0, 3).join('、') + (titles.length > 3 ? '等' : ''));
  const amount = ['totalMinor', 'amountMinor', 'targetMinor', 'costTargetMinor'].map(field => values[field]).find(value => typeof value === 'number' && Number.isSafeInteger(value));
  if (amount !== undefined) parts.push(formatMoney(amount));
  if (typeof values.dueDate === 'string') parts.push(formatDate(values.dueDate));
  if (typeof values.periodStart === 'string' && typeof values.periodEnd === 'string') parts.push(formatDate(values.periodStart) + ' 至 ' + formatDate(values.periodEnd));
  return parts.length ? label + ' · ' + parts.join(' · ') : undefined;
}
export function sameBusinessReference(a: BusinessObjectRef, b: BusinessObjectRef): boolean {
  return a.tenantId === b.tenantId && a.workspaceId === b.workspaceId && a.objectType === b.objectType && a.objectId === b.objectId && a.streamVersion === b.streamVersion && a.digest === b.digest;
}
export class BusinessReferenceModel {
  private readonly resource = new WorkspaceResource<ReferenceNames>();
  readonly snapshot = this.resource.snapshot; readonly subscribe = this.resource.subscribe;
  constructor(private readonly api: EnterpriseBrowserClient) {}
  clear(): void { this.resource.clear(); }
  load(view: View, capabilities: Capabilities): Promise<void> {
    const current = structuredClone(view), access = structuredClone(capabilities);
    const ownerKey = JSON.stringify([current.reference.tenantId, current.reference.workspaceId, current.reference.objectType, current.reference.objectId, current.reference.streamVersion, current.reference.digest]);
    return this.resource.load(ownerKey, async signal => {
      if (!sameBusinessReference(current.reference, access.reference)) throw new EnterpriseApiFailure({ status: 409, code: 'SOURCE_VERSION_CONFLICT' });
      if (this.api.session?.tenantId !== current.reference.tenantId) throw new EnterpriseApiFailure({ status: 403, code: 'OBJECT_SCOPE_MISMATCH' });
      const fields: Record<string, ReferenceName> = {};
      for (const [field, objectType] of Object.entries(BUSINESS_REFERENCE_FIELDS)) {
        if (!access.readableFields.includes(field) || !Object.hasOwn(current.values, field) || current.values[field] == null) continue;
        if (typeof current.values[field] !== 'object' || Array.isArray(current.values[field])) continue;
        let reference: BusinessObjectRef;
        try { reference = parseEnterpriseContract('BusinessObjectRef', current.values[field]); }
        catch { fields[field] = { status: 'invalid' }; continue; }
        if (reference.tenantId !== current.reference.tenantId || reference.workspaceId !== current.reference.workspaceId || reference.objectType !== objectType) { fields[field] = { status: 'invalid' }; continue; }
        if (signal.aborted) throw new DOMException('Reference read stopped', 'AbortError');
        try {
          const response = await this.api.query('getBusinessObjectVersion', { path: { workspaceId: reference.workspaceId, objectType: reference.objectType, objectId: reference.objectId, streamVersion: String(reference.streamVersion) } }, signal);
          if (signal.aborted) throw new DOMException('Reference read stopped', 'AbortError');
          if (!sameBusinessReference(response.reference, reference)) { fields[field] = { status: 'stale', reference }; continue; }
          const name = referenceSummary(response);
          fields[field] = typeof name === 'string' ? { status: 'ready', reference, name } : { status: 'unnamed', reference };
        } catch (error) {
          if (signal.aborted || error instanceof EnterpriseApiFailure && (error.status === 401 || error.code === 'STALE_RESPONSE')) throw error;
          fields[field] = { status: error instanceof EnterpriseApiFailure && error.status === 403 ? 'denied' : 'unavailable', reference };
        }
      }
      return { owner: current.reference, fields };
    });
  }
}
