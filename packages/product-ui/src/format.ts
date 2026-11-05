// SPDX-License-Identifier: Apache-2.0
const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const currencySymbol = money.formatToParts(0).find(part => part.type === 'currency')?.value ?? '¥';
export function moneyInputValue(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return '';
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
  return (amount < 0n ? '-' : '') + (absolute / 100n).toString() + '.' + (absolute % 100n).toString().padStart(2, '0');
}
export function formatMoney(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return '未提供';
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
  return (amount < 0n ? '-' : '') + currencySymbol + wholeNumber.format(absolute / 100n) + '.' + (absolute % 100n).toString().padStart(2, '0');
}
export function parseMoneyInput(value: string): number {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/u.test(value.trim())) throw new Error('金额最多保留两位小数');
  const [whole, decimal = ''] = value.trim().split('.'), amount = BigInt(whole!) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额超出允许范围'); return Number(amount);
}
export function businessDate(now = new Date()): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
export function formatDate(value: unknown): string {
  if (typeof value !== 'string' || !value) return '未提供';
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : '未提供';
}
export const STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: '草稿', prepared: '待核对', approved: '已批准', accepted: '已接受', active: '有效', inactive: '未启用', cancelled: '已取消', superseded: '已替代', open: '进行中', closed: '已关闭', confirmed: '已确认', reported: '已登记', received: '已接收', proposed: '待确认', enabled: '已启用', disabled: '已停用', removed: '已移除', invited: '待接受邀请',
  awaiting_authorization: '待授权', awaiting_approval: '待批准', running: '执行中', queued: '排队中', waiting_person: '等待人员', waiting_external: '等待外部变化', awaiting_acceptance: '待验收', needs_reconciliation: '待核对', completed: '已完成', failed: '未完成', partial: '部分可读', complete: '已提取', unreadable: '无法提取', candidate: '候选成果', withdrawn: '已撤回',
};
export function statusLabel(value: unknown): string { return typeof value === 'string' ? STATUS_LABELS[value] ?? '待核对状态' : '未提供'; }
