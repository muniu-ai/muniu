// SPDX-License-Identifier: Apache-2.0
import { formatDate, formatMoney, statusLabel } from './format.js';
import type { ReferenceName } from './business-references.js';
export const OBJECT_LABELS: Readonly<Record<string, string>> = { customer: '客户', contact: '联系人', opportunity: '商机', service_version: '服务', quote_version: '报价', contract: '合同', order: '订单', project: '项目', milestone: '里程碑', delivery_version: '交付', customer_acceptance: '客户验收', change_request: '范围变更', payment_schedule: '付款期', receipt: '收款', refund: '退款', adjustment: '金额调整', expense: '费用', metric_definition: '经营指标', operating_objective: '经营目标', business_review: '经营复盘' };
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: '名称', title: '标题', status: '状态', customer: '客户', contact: '联系人', opportunity: '商机', serviceCode: '服务代码', unit: '计量单位', unitPriceMinor: '单价', scope: '服务范围', acceptanceCriteria: '验收条件', validFrom: '生效时间', validUntil: '有效期', lines: '明细', scopeLines: '服务范围', totalMinor: '合计金额', currency: '币种', quote: '报价', contract: '合同', order: '订单', project: '项目', milestone: '里程碑', delivery: '交付记录', amountMinor: '金额', dueDate: '到期日期', businessDate: '发生日期', summary: '交付说明', description: '说明', reason: '原因', periodStart: '起始日期', periodEnd: '结束日期', targetMinor: '目标金额', costTargetMinor: '目标成本', metric: '指标', financialMetrics: '资金指标', deliveryMetrics: '交付进度', costMetrics: '成本信息', objectiveResult: '目标对照', purpose: '用途', recordedAt: '记录时间', createdAt: '创建时间', confirmedAt: '确认时间', evidence: '核对依据', approvalId: '业务批准', allocations: '款项分配', releasedAllocations: '退回分配', proposedAmountMinor: '调整后金额', proposedDueDate: '调整后日期', kind: '调整类型', sources: '来源', responsiblePrincipalId: '责任人', ownerPrincipalId: '负责人', preparedByPrincipalId: '制单人', departmentId: '所属部门',
  quantity: '数量', lineTotalMinor: '行金额', promised: '承诺数量', delivered: '已交付', internallyReceived: '内部已接收', accepted: '客户已验收', remaining: '待交付', confirmedCostMinor: '已确认成本', marginMinor: '毛利', outstandingMinor: '应收余额', netReceivedMinor: '净回款', grossReceivedMinor: '收款金额', refundedMinor: '退款金额', reversedMinor: '冲正金额', allocatedMinor: '已分配', unallocatedMinor: '待分配', writtenOffMinor: '核销金额', dueMinor: '已到期未收',
  receivedBy: '内部接收人', confirmedByPrincipalId: '验收登记人', commercialPreparedByPrincipalId: '变更制单人', projectConfirmedBy: '项目范围确认人',
  email: '电子邮箱', phone: '电话', actualMinor: '实际金额', periodCostMinor: '本期已确认成本', period: '本期收支', periods: '付款期明细', costsComplete: '成本已确认完整', marginBasis: '毛利口径', observedAt: '核对时间', sourceRefs: '业务来源', financialSources: '资金来源', costSources: '成本来源',
  receipt: '原收款记录', schedule: '付款期', objective: '经营目标',
};
const moneyFields = new Set(Object.keys(FIELD_LABELS).filter(key => /Minor$/u.test(key)));
const references = new Set(['customer', 'contact', 'opportunity', 'quote', 'contract', 'order', 'project', 'milestone', 'delivery', 'evidence', 'sources', 'sourceRefs', 'financialSources', 'costSources', 'approvalId']);
const identities = new Set(['ownerPrincipalId', 'preparedByPrincipalId', 'responsiblePrincipalId', 'receivedBy', 'confirmedByPrincipalId', 'commercialPreparedByPrincipalId', 'projectConfirmedBy']);
export function objectTitle(view: { reference: { objectType: string }; values: Readonly<Record<string, unknown>> }): string {
  for (const name of ['name', 'title', 'summary', 'serviceCode', 'description']) if (typeof view.values[name] === 'string' && view.values[name]) return String(view.values[name]);
  return (OBJECT_LABELS[view.reference.objectType] ?? '业务记录') + '记录';
}
function valueLabel(field: string, value: unknown, names?: Readonly<Record<string, string>>): string {
  if (value === undefined || value === null) return '未提供';
  if (moneyFields.has(field)) return formatMoney(value);
  if (field === 'status') return statusLabel(value);
  if (field === 'currency') return value === 'CNY' ? '人民币' : '未提供';
  if (identities.has(field)) return typeof value === 'string' && names && Object.hasOwn(names, value) && typeof names[value] === 'string' ? names[value]! : '已关联';
  if (field === 'departmentId') return '已关联部门';
  if (references.has(field)) return '已关联业务记录';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (/At$|Date$|^validFrom$|^validUntil$|^periodStart$|^periodEnd$/u.test(field)) return formatDate(value);
    return ({ net_received: '净回款', outstanding: '应收余额', confirmed_cost: '已确认成本', write_off: '核销', receipt_reversal: '收款冲正', schedule_revision: '付款期调整', receipt_allocation: '款项分配', operating_review: '经营复盘', quote_acceptance: '报价接受', delivery_acceptance: '交付验收', cost_confirmation: '成本确认', order_value_minus_confirmed_cost: '订单金额减已确认成本' } as Readonly<Record<string, string>>)[value] ?? value;
  }
  if (Array.isArray(value)) return value.map(item => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    const allowed = ['description', 'title', 'scope', 'acceptanceCriteria', 'quantity', 'unit', 'dueDate', 'promised', 'delivered', 'internallyReceived', 'accepted', 'remaining', ...(field === 'scopeLines' ? [] : ['unitPriceMinor', 'lineTotalMinor', 'totalMinor', 'amountMinor', 'allocatedMinor', 'writtenOffMinor', 'outstandingMinor'])];
    return Object.entries(item).filter(([key]) => allowed.includes(key)).map(([key, entry]) => (FIELD_LABELS[key] ?? key) + '：' + valueLabel(key, entry)).join('，');
  }).filter(Boolean).join('\n') || '暂无明细';
  if (typeof value === 'object') return Object.entries(value).filter(([key]) => Object.hasOwn(FIELD_LABELS, key) && !references.has(key)).map(([key, entry]) => FIELD_LABELS[key] + '：' + valueLabel(key, entry)).join('\n') || '已关联记录';
  return '未提供';
}
export function BusinessFields({ objectType, values, readableFields, names, referenceNames }: { objectType: string; values: Readonly<Record<string, unknown>>; readableFields: readonly string[]; names?: Readonly<Record<string, string>>; referenceNames?: Readonly<Record<string, ReferenceName>> }) {
  const useTable = ['quote_version', 'contract', 'order'].includes(objectType);
  const priceLines = useTable && readableFields.includes('lines') && Array.isArray(values.lines) ? values.lines : undefined;
  const scopeLines = useTable && readableFields.includes('scopeLines') && Array.isArray(values.scopeLines) ? values.scopeLines : undefined;
  const lineSource = priceLines ?? scopeLines;
  const financial = objectType === 'business_review' && readableFields.includes('financialMetrics') ? record(values.financialMetrics) : undefined;
  const visible = Object.entries(values).filter(([key]) => readableFields.includes(key) && Object.hasOwn(FIELD_LABELS, key) && !(lineSource && ['lines', 'scopeLines'].includes(key)) && !(financial && key === 'financialMetrics'));
  return <><dl className="mn-details">{visible.map(([key, value]) => <div className="mn-detail-pair" key={key}><dt>{FIELD_LABELS[key]}</dt><dd>{referenceNames?.[key] ? <ReferenceValue field={key} value={referenceNames[key]!} /> : <p className={moneyFields.has(key) ? 'mn-number' : undefined}>{valueLabel(key, value, names)}</p>}</dd></div>)}</dl>{lineSource && <BusinessLineTable values={lineSource} showPrices={priceLines !== undefined} />}{financial && <FinancialReview values={financial} />}</>;
}
function record(value: unknown): Readonly<Record<string, unknown>> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined; }
function MoneySummary({ title, values, fields }: { title: string; values: Readonly<Record<string, unknown>>; fields: readonly string[] }) {
  const present = fields.filter(field => Object.hasOwn(values, field));
  if (!present.length) return null;
  return <section className="mn-detail-section" aria-label={title}><h3>{title}</h3><dl className="mn-money-summary">{present.map(field => <div key={field}><dt>{FIELD_LABELS[field]}</dt><dd className="mn-number">{formatMoney(values[field])}</dd></div>)}</dl></section>;
}
function FinancialReview({ values }: { values: Readonly<Record<string, unknown>> }) {
  const period = record(values.period), periods = Array.isArray(values.periods) ? values.periods.map(record) : undefined;
  const columns = ['dueDate', 'amountMinor', 'allocatedMinor', 'writtenOffMinor', 'outstandingMinor'].filter(field => periods?.some(row => row && Object.hasOwn(row, field)));
  return <>
    <MoneySummary title="累计资金" values={values} fields={['totalMinor', 'grossReceivedMinor', 'refundedMinor', 'reversedMinor', 'netReceivedMinor', 'allocatedMinor', 'unallocatedMinor', 'writtenOffMinor', 'outstandingMinor', 'dueMinor']} />
    {period && <MoneySummary title="本期收支" values={period} fields={['grossReceivedMinor', 'refundedMinor', 'reversedMinor', 'netReceivedMinor', 'writtenOffMinor']} />}
    {periods && <section className="mn-detail-section" aria-label="付款期明细"><h3>付款期明细</h3>{periods.length && columns.length ? <div className="mn-table-wrap"><table className="mn-table mn-financial-periods"><thead><tr>{columns.map(field => <th key={field}>{FIELD_LABELS[field]}</th>)}</tr></thead><tbody>{periods.map((row, index) => <tr key={index}>{columns.map(field => <td key={field} className={field === 'dueDate' ? undefined : 'mn-number'}>{field === 'dueDate' ? formatDate(row?.[field]) : formatMoney(row?.[field])}</td>)}</tr>)}</tbody></table></div> : <p className="mn-small mn-muted">本次复盘没有可显示的付款期明细。</p>}</section>}
  </>;
}
function ReferenceValue({ field, value }: { field: string; value: ReferenceName }) {
  if (value.status === 'ready' && value.name) return <p>{value.name}<span className="mn-table-secondary">引用第 {value.reference!.streamVersion} 版</span></p>;
  const label = FIELD_LABELS[field] ?? '业务记录';
  const descriptions = { denied: '当前无权查看关联' + label, unavailable: '关联' + label + '暂不可读取', stale: '无法核对关联' + label + '的原始版本', unnamed: '关联' + label + '没有可显示的名称', invalid: '关联' + label + '引用不可用' } as const;
  return <p className="mn-muted">{value.status === 'ready' ? '没有可显示的名称' : descriptions[value.status]}</p>;
}
function BusinessLineTable({ values, showPrices }: { values: readonly unknown[]; showPrices: boolean }) {
  const rows = values.map(value => value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined);
  const has = (key: string) => rows.some(row => row && Object.hasOwn(row, key) && row[key] !== undefined && row[key] !== null);
  const hasName = has('title') || has('description'), hasQuantity = has('quantity'), hasUnit = has('unit'), hasPrice = showPrices && has('unitPriceMinor'), hasAmount = showPrices && has('totalMinor');
  const hasTerms = has('scope') || has('acceptanceCriteria'), columnCount = Number(hasName) + Number(hasQuantity) + Number(hasUnit) + Number(hasPrice) + Number(hasAmount) + Number(hasTerms && !hasName);
  const terms = (row: Readonly<Record<string, unknown>>) => <>{typeof row.scope === 'string' && <span className="mn-table-secondary">范围：{row.scope}</span>}{Array.isArray(row.acceptanceCriteria) && row.acceptanceCriteria.filter((item): item is string => typeof item === 'string').map((item, index) => <span className="mn-table-secondary" key={index}>验收：{item}</span>)}</>;
  return <section className="mn-detail-section"><h3>服务明细</h3>{rows.length && columnCount ? <div className="mn-table-wrap"><table className="mn-table mn-line-table"><thead><tr>{hasName && <th>名称</th>}{hasQuantity && <th>数量</th>}{hasUnit && <th>单位</th>}{hasPrice && <th>单价</th>}{hasAmount && <th>金额</th>}{hasTerms && !hasName && <th>范围与验收条件</th>}</tr></thead><tbody>{rows.map((row, index) => row ? <tr key={index}>{hasName && <td className="mn-table-main"><strong>{typeof row.title === 'string' ? row.title : typeof row.description === 'string' ? row.description : '未提供'}</strong>{terms(row)}</td>}{hasQuantity && <td className="mn-number">{typeof row.quantity === 'number' && Number.isSafeInteger(row.quantity) ? row.quantity : '未提供'}</td>}{hasUnit && <td>{typeof row.unit === 'string' ? row.unit : '未提供'}</td>}{hasPrice && <td className="mn-number">{formatMoney(row.unitPriceMinor)}</td>}{hasAmount && <td className="mn-number">{formatMoney(row.totalMinor)}</td>}{hasTerms && !hasName && <td>{terms(row)}</td>}</tr> : <tr key={index}><td colSpan={columnCount}>这条明细无法识别，请重新载入并核对原记录。</td></tr>)}</tbody></table></div> : <p className="mn-small mn-muted">没有可显示的服务明细。</p>}</section>;
}
