// SPDX-License-Identifier: Apache-2.0
import { parseEnterpriseContract, type BusinessObjectRef, type EnterpriseContractTypes, type JsonObject } from '@mn/contracts';
import type { BusinessCommandContext, BusinessEvent, BusinessState } from './model.js';
import { businessDigest, businessObjectKey } from './state.js';
import { businessCommandTools, fail, json, valueAs } from './command-context.js';
export interface ProviderBusinessContext extends BusinessCommandContext { readonly assertExecutionAllowed: () => void; }
export function decideBuiltinProviderAction(state: BusinessState, raw: EnterpriseContractTypes['EnterpriseProviderActionPreparation'], context: ProviderBusinessContext, rawDocument?: unknown): { events: readonly BusinessEvent[]; primaryObjectKey: string } {
  const request = parseEnterpriseContract('EnterpriseProviderActionPreparation', raw);
  if (context.assertExecutionAllowed.constructor.name === 'AsyncFunction') fail('EXECUTION_VERIFIER_INVALID', 503);
  const allowed: unknown = context.assertExecutionAllowed();
  if (allowed !== undefined) { if (allowed instanceof Promise) void allowed.catch(() => {}); fail('EXECUTION_VERIFIER_INVALID', 503); }
  if (request.tenantId !== context.tenantId || request.workspaceId !== context.workspaceId || request.target.tenantId !== context.tenantId || request.target.workspaceId !== context.workspaceId) fail('OBJECT_SCOPE_MISMATCH', 403);
  if ('provider' in request.target) fail('PROVIDER_NOT_RESPONSIBLE');
  if (Date.parse(request.expiresAt) <= Date.parse(context.now)) fail('ACTION_EXPIRED');
  const tools = businessCommandTools(state, { type: 'provider.' + request.action }, context);
  const { source, check, find, create, event, events, parentFields } = tools;
  const target = request.target;
  if (request.action === 'create_followup_task' || request.action === 'update_followup_date') {
    if (target.objectType !== 'customer' && target.objectType !== 'opportunity') fail('ACTION_TARGET_UNSUPPORTED');
    const current = source(target, target.objectType, [target.objectType === 'customer' ? 'name' : 'title'], 'write');
    const customer = target.objectType === 'customer' ? current : find('customer', valueAs<BusinessObjectRef>(current.value.customer).objectId);
    check(customer, 'read', ['name']);
    check(current, 'write', ['nextFollowupAt', ...(request.action === 'create_followup_task' ? ['nextStep'] : [])]);
    if (request.action === 'create_followup_task') {
      const id = 'followup:' + businessDigest([request.tenantId, request.workspaceId, request.operationKey]);
      create('followup_task', id, 'created', { ...parentFields(current), ...json({ target, customer: customer.reference, title: request.input.title, ...(request.input.description ? { description: request.input.description } : {}), dueAt: request.input.dueAt, status: 'open', operationKey: request.operationKey }) });
      event(target.objectType, target.objectId, target.streamVersion, target.objectType + '.followup_scheduled', { nextFollowupAt: request.input.dueAt, nextStep: request.input.title });
      return { events, primaryObjectKey: businessObjectKey('followup_task', id) };
    }
    event(target.objectType, target.objectId, target.streamVersion, target.objectType + '.followup_scheduled', { nextFollowupAt: request.input.nextFollowupAt });
    return { events, primaryObjectKey: businessObjectKey(target.objectType, target.objectId) };
  }
  if (target.objectType !== 'quote_version') fail('ACTION_TARGET_UNSUPPORTED');
  const quote = source(target, 'quote_version', ['lines', 'totalMinor', 'validUntil'], 'write');
  const approval = state.approvals.get(request.businessApprovalRef);
  if (!['approved', 'accepted'].includes(String(quote.value.status)) || quote.value.approvalId !== request.businessApprovalRef || !approval || approval.decision !== 'approve' || (approval.subjectRef as unknown as BusinessObjectRef).objectId !== target.objectId) fail('BUSINESS_APPROVAL_REQUIRED');
  if (Date.parse(String(quote.value.validUntil)) < Date.parse(request.expiresAt)) fail('QUOTE_EXPIRED');
  const document = parseEnterpriseContract('EnterpriseProviderQuoteFile', rawDocument);
  const media = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  if (media[request.input.format] !== document.mediaType) fail('QUOTE_PACKAGE_INVALID');
  const packages = valueAs<readonly JsonObject[]>(quote.value.packageRefs ?? []);
  if (packages.some(p => p.operationKey === request.operationKey)) fail('PROVIDER_OPERATION_ALREADY_APPLIED');
  event('quote_version', target.objectId, target.streamVersion, 'quote_version.package_issued', { packageRefs: [...packages, json({ operationKey: request.operationKey, ...document, sourceQuote: target, issuedAt: context.now })] });
  return { events, primaryObjectKey: businessObjectKey(target.objectType, target.objectId) };
}
