// SPDX-License-Identifier: Apache-2.0
import { ENTERPRISE_SCHEMAS, parseEnterpriseContract } from '@mn/contracts/enterprise-client';
import type { EnterpriseContractTypes } from '@mn/contracts';
import { parseMoneyInput } from './format.js';
export type BusinessCommand = EnterpriseContractTypes['EnterpriseBusinessCommand'];
export type BusinessObjectView = EnterpriseContractTypes['EnterpriseBusinessObjectView'];
export interface Schema { readonly type?: string; readonly const?: unknown; readonly enum?: readonly unknown[]; readonly $ref?: string; readonly format?: string; readonly minLength?: number; readonly maxLength?: number; readonly minimum?: number; readonly maximum?: number; readonly minItems?: number; readonly maxItems?: number; readonly items?: Schema; readonly properties?: Readonly<Record<string, Schema>>; readonly required?: readonly string[]; readonly oneOf?: readonly Schema[]; }
export interface BusinessAction { readonly command: BusinessCommand['type']; readonly objectType: string; readonly label: string; readonly create?: boolean; readonly confirmation?: boolean; readonly businessApproval?: boolean; readonly evidence?: boolean; readonly variant?: string; readonly explanation?: string; }
const actions: readonly BusinessAction[] = [
  { objectType: 'customer', command: 'customer.create', label: '新建客户', create: true }, { objectType: 'customer', command: 'customer.rename', label: '修改客户名称' },
  { objectType: 'contact', command: 'contact.create', label: '添加联系人', create: true }, { objectType: 'contact', command: 'contact.update', label: '修改联系人' },
  { objectType: 'opportunity', command: 'opportunity.create', label: '新建商机', create: true }, { objectType: 'opportunity', command: 'opportunity.update', label: '修改商机' },
  { objectType: 'service_version', command: 'service.publish', label: '发布服务版本', create: true },
  { objectType: 'quote_version', command: 'quote.prepare', label: '准备报价', create: true }, { objectType: 'quote_version', command: 'quote.approve', label: '批准报价', confirmation: true, businessApproval: true, explanation: '本次批准固定报价内容，不代表客户已经接受。' }, { objectType: 'quote_version', command: 'quote.record_acceptance', label: '登记客户接受', confirmation: true, businessApproval: true, evidence: true },
  { objectType: 'contract', command: 'contract.create', label: '起草合同', create: true }, { objectType: 'contract', command: 'contract.activate', label: '确认合同生效', confirmation: true, businessApproval: true, evidence: true },
  { objectType: 'order', command: 'order.create', label: '起草订单', create: true }, { objectType: 'order', command: 'order.activate', label: '确认订单生效', confirmation: true, businessApproval: true },
  { objectType: 'project', command: 'project.create', label: '建立项目', create: true }, { objectType: 'project', command: 'project.costs.confirm', label: '确认成本完整', confirmation: true, businessApproval: true, evidence: true },
  { objectType: 'milestone', command: 'milestone.create', label: '添加里程碑', create: true },
  { objectType: 'delivery_version', command: 'delivery.report', label: '登记交付', create: true }, { objectType: 'delivery_version', command: 'delivery.receive', label: '内部接收交付', confirmation: true, explanation: '内部接收只确认企业内部核对结果，客户验收需要独立登记。' },
  { objectType: 'customer_acceptance', command: 'acceptance.prepare', label: '准备客户验收', create: true }, { objectType: 'customer_acceptance', command: 'acceptance.confirm', label: '确认客户验收', confirmation: true, businessApproval: true, evidence: true },
  { objectType: 'payment_schedule', command: 'payment_schedule.create', label: '安排付款期', create: true }, { objectType: 'payment_schedule', command: 'payment_schedule.confirm', label: '确认付款安排', confirmation: true, businessApproval: true, evidence: true },
  { objectType: 'receipt', command: 'receipt.prepare', label: '登记收款草稿', create: true }, { objectType: 'receipt', command: 'receipt.confirm', label: '确认实际到账', confirmation: true, businessApproval: true, evidence: true, explanation: '请核对实际到账凭证。发送提醒或提交收款草稿均不代表到账。' }, { objectType: 'receipt', command: 'receipt.cancel', label: '取消收款草稿', confirmation: true },
  { objectType: 'refund', command: 'refund.prepare', label: '登记退款草稿', create: true }, { objectType: 'refund', command: 'refund.confirm', label: '确认退款', confirmation: true, businessApproval: true, evidence: true }, { objectType: 'refund', command: 'refund.cancel', label: '取消退款草稿', confirmation: true },
  { objectType: 'expense', command: 'expense.prepare', label: '登记费用草稿', create: true }, { objectType: 'expense', command: 'expense.confirm', label: '确认费用', confirmation: true, businessApproval: true, evidence: true }, { objectType: 'expense', command: 'expense.cancel', label: '取消费用草稿', confirmation: true },
  { objectType: 'adjustment', command: 'adjustment.prepare', label: '登记金额调整', create: true, variant: 'write_off' }, { objectType: 'adjustment', command: 'adjustment.confirm', label: '确认金额调整', confirmation: true, businessApproval: true, evidence: true }, { objectType: 'adjustment', command: 'adjustment.cancel', label: '取消调整草稿', confirmation: true },
  { objectType: 'metric_definition', command: 'metric.publish', label: '发布经营指标', create: true }, { objectType: 'operating_objective', command: 'objective.create', label: '设定经营目标', create: true }, { objectType: 'business_review', command: 'business_review.snapshot', label: '形成经营复盘', create: true },
  { objectType: 'change_request', command: 'change_request.prepare', label: '提出范围变更', create: true }, { objectType: 'change_request', command: 'change_request.price', label: '核对变更价格' }, { objectType: 'change_request', command: 'change_request.approve', label: '批准范围变更', confirmation: true, businessApproval: true, evidence: true }, { objectType: 'change_request', command: 'change_request.project_confirm', label: '确认项目新范围', confirmation: true }, { objectType: 'change_request', command: 'change_request.cancel', label: '取消变更草稿', confirmation: true },
];
export const ADJUSTMENT_KINDS = [{ value: 'write_off', label: '应收核销' }, { value: 'receipt_reversal', label: '收款冲正' }, { value: 'schedule_revision', label: '调整付款期' }, { value: 'receipt_allocation', label: '分配已有收款' }] as const;
export function commandDefinition(command: string): BusinessAction | undefined { return actions.find(action => action.command === command); }
export function createActionFor(objectType: string): BusinessAction | undefined { return actions.find(action => action.objectType === objectType && action.create); }
export function actionsForObject(objectType: string): readonly BusinessAction[] { return actions.filter(action => action.objectType === objectType && !action.create); }
export function businessCommandSchema(action: BusinessAction): Schema {
  if (!actions.some(item => item.command === action.command && item.objectType === action.objectType && item.create === action.create)) throw new Error('这项业务操作尚未接入界面');
  const variants = (ENTERPRISE_SCHEMAS.EnterpriseBusinessCommand as unknown as Schema).oneOf ?? [];
  const result = variants.find(schema => schema.properties?.type?.const === action.command && (!action.variant || schema.properties?.kind?.const === action.variant));
  if (!result) throw new Error('业务表单契约不可用'); return result;
}
export const REFERENCE_TYPES: Readonly<Record<string, string>> = { customer: 'customer', opportunity: 'opportunity', service: 'service_version', quote: 'quote_version', contract: 'contract', order: 'order', project: 'project', milestone: 'milestone', delivery: 'delivery_version', receipt: 'receipt', schedule: 'payment_schedule', metric: 'metric_definition', objective: 'operating_objective', expenseRefs: 'expense', supersedes: 'service_version' };
export function referenceTypes(action: BusinessAction): readonly string[] {
  const found = new Set<string>();
  const visit = (schema: Schema, name: string) => {
    if (schema.$ref === '#/components/schemas/BusinessObjectRef') { if (!REFERENCE_TYPES[name]) throw new Error('关联记录选择器尚未接入'); found.add(REFERENCE_TYPES[name]!); }
    if (name === 'supersedes') found.add('service_version');
    for (const [key, child] of Object.entries(schema.properties ?? {})) visit(child, key);
    if (schema.items) visit(schema.items, name);
    for (const child of schema.oneOf ?? []) visit(child, name);
  };
  visit(businessCommandSchema(action), ''); return [...found];
}
export function buildBusinessCommand(action: BusinessAction, draft: Readonly<Record<string, unknown>>, context: { tenantId: string; workspaceId: string; recordId: string; object?: BusinessObjectView }): BusinessCommand {
  const schema = businessCommandSchema(action);
  const { id: _id, type: _type, expectedStreamVersion: _version, ...fields } = draft;
  if (!action.create && (!context.object || context.object.reference.objectType !== action.objectType)) throw new Error('请先载入当前业务记录');
  const reference = context.object?.reference;
  if (reference && (reference.tenantId !== context.tenantId || reference.workspaceId !== context.workspaceId)) throw new Error('业务记录不属于当前经营主体');
  const normalize = (value: unknown, node: Schema, name: string): unknown => {
    if (typeof value === 'string' && node.type === 'integer' && /Minor$/u.test(name)) return parseMoneyInput(value);
    if (Array.isArray(value) && node.items) return value.map(item => normalize(item, node.items!, name));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      let selected = node;
      if (node.oneOf) selected = node.oneOf.find(branch => Object.keys(branch.properties ?? {}).filter(key => node.oneOf!.some(other => !Object.hasOwn(other.properties ?? {}, key))).some(key => Object.hasOwn(value, key))) ?? node.oneOf[0]!;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, selected.properties?.[key] ?? {}, key)]));
    }
    return value;
  };
  const command = { ...normalize(fields, schema, '') as FieldsForCommand, type: action.command, id: action.create ? context.recordId : reference!.objectId, ...(!action.create ? { expectedStreamVersion: reference!.streamVersion } : {}), ...(action.variant ? { kind: action.variant } : {}) };
  const check = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(check); return; }
    const record = value as Record<string, unknown>;
    if ('objectType' in record && 'objectId' in record && (record.tenantId !== context.tenantId || record.workspaceId !== context.workspaceId)) throw new Error('关联记录不属于当前经营主体');
    Object.values(record).forEach(check);
  };
  check(command);
  try { return parseEnterpriseContract('EnterpriseBusinessCommand', command); }
  catch { throw new Error('请补全必填项，并核对金额、日期和关联业务明细'); }
}
type FieldsForCommand = Readonly<Record<string, unknown>>;
export function lineOptions(view?: BusinessObjectView): readonly { value: string; label: string }[] {
  const source = Array.isArray(view?.values.lines) ? view.values.lines : Array.isArray(view?.values.scopeLines) ? view.values.scopeLines : [];
  return source.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>, value = item.lineId ?? item.id ?? item.quoteLineId;
    if (typeof value !== 'string') return [];
    const label = typeof item.description === 'string' ? item.description : typeof item.title === 'string' ? item.title : typeof item.scope === 'string' ? item.scope : '第 ' + (index + 1) + ' 项';
    return [{ value, label }];
  });
}
