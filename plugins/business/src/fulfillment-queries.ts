// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, type BusinessObjectRef } from '@mn/contracts';
import { BusinessDomainError, type BusinessObject, type BusinessState } from './model.js';
import { businessObjectKey } from './state.js';
import { deriveOrderBalance } from './order-balance.js';
export interface Units {
    readonly lineId: string;
    readonly quantity: number;
}
export const cast = <T>(value: unknown): T => value as T;
export function entity(state: BusinessState, type: string, id: string): BusinessObject { const object = state.objects.get(businessObjectKey(type, id)); if (!object)
    throw new BusinessDomainError('OBJECT_NOT_FOUND', 404); return object; }
export const referenceId = (value: unknown) => cast<BusinessObjectRef | undefined>(value)?.objectId;
export const related = (state: BusinessState, type: string, field: string, id: string) => [...state.objects.values()].filter(object => object.reference.objectType === type && referenceId(object.value[field]) === id);
export function businessDate(instant: string): string {
    const date = new Date(instant);
    if (!Number.isFinite(date.getTime()))
        throw new BusinessDomainError('INVALID_BUSINESS_DATE', 400);
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
export function sumUnits(lines: readonly Units[]): Map<string, bigint> { const sum = new Map<string, bigint>(); for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || sum.has(line.lineId))
        throw new BusinessDomainError('INVALID_DELIVERY_QUANTITY', 400);
    sum.set(line.lineId, BigInt(line.quantity));
} return sum; }
export function addUnits(target: Map<string, bigint>, lines: readonly Units[]): void { for (const [id, count] of sumUnits(lines))
    target.set(id, (target.get(id) ?? 0n) + count); }
export function withinUnits(actual: Map<string, bigint>, maximum: Map<string, bigint>, code: string): void { for (const [id, count] of actual)
    if (!maximum.has(id) || count > maximum.get(id)!)
        throw new BusinessDomainError(code); }
export function projectProgress(state: BusinessState, projectId: string, asOfDate = '9999-12-31') {
    const project = entity(state, 'project', projectId), promised = cast<{effectiveDate:string;scopeLines:Units[]}[]>(project.value.scopeHistory??[]).filter(term=>term.effectiveDate<=asOfDate).at(-1)?.scopeLines??cast<Units[]>(project.value.scopeLines), delivered = new Map<string, bigint>(), accepted = new Map<string, bigint>();
    for (const delivery of related(state, 'delivery_version', 'project', projectId))
        if (delivery.value.status === 'received' && businessDate(String(delivery.value.receivedAt)) <= asOfDate)
            addUnits(delivered, cast<Units[]>(delivery.value.lines));
    for (const acceptance of related(state, 'customer_acceptance', 'project', projectId))
        if (acceptance.value.purpose === 'delivery' && acceptance.value.status === 'confirmed' && businessDate(String(acceptance.value.confirmedAt)) <= asOfDate)
            addUnits(accepted, cast<Units[]>(acceptance.value.lines));
    const limit = sumUnits(promised);
    withinUnits(delivered, limit, 'DELIVERY_QUANTITY_EXCEEDED');
    withinUnits(accepted, delivered, 'ACCEPTANCE_QUANTITY_EXCEEDED');
    return { project: project.reference, status: String(project.value.status), lines: promised.map(line => ({ lineId: line.lineId, promised: line.quantity, delivered: Number(delivered.get(line.lineId) ?? 0n), internallyReceived: Number(delivered.get(line.lineId) ?? 0n), accepted: Number(accepted.get(line.lineId) ?? 0n), remaining: line.quantity - Number(accepted.get(line.lineId) ?? 0n) })) };
}
export function orderFinancials(state: BusinessState, orderId: string, asOfDate: string) {
    const order = entity(state, 'order', orderId);
    const orderTerms = cast<{
        effectiveDate: string;
        totalMinor: number;
    }[]>(order.value.termsHistory ?? []).filter(term => term.effectiveDate <= asOfDate).at(-1);
    const included = (object: BusinessObject) => object.value.status === 'confirmed' && String(object.value.businessDate ?? '') <= asOfDate;
    const allocations = (value: unknown) => cast<{
        schedule: BusinessObjectRef;
        amountMinor: number;
    }[]>(value ?? []).map(part => ({ scheduleId: part.schedule.objectId, amountMinor: part.amountMinor }));
    const receiptAllocations=(object:BusinessObject)=>{const parts=new Map<string,bigint>();for(const part of allocations(object.value.allocations))parts.set(part.scheduleId,BigInt(part.amountMinor));for(const adjustment of adjustments)if(adjustment.value.kind==='receipt_allocation'&&referenceId(adjustment.value.receipt)===object.reference.objectId){const id=referenceId(adjustment.value.schedule)!;parts.set(id,(parts.get(id)??0n)+BigInt(Number(adjustment.value.amountMinor)));}return [...parts].map(([scheduleId,value])=>{if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new BusinessDomainError('MONEY_OUT_OF_RANGE');return {scheduleId,amountMinor:Number(value)};});};
    const fact = (object: BusinessObject) => ({ id: object.reference.objectId, orderId, status: 'confirmed' as const, amountMinor: Number(object.value.amountMinor) });
    const adjustments = related(state, 'adjustment', 'order', orderId).filter(included);
    return deriveOrderBalance({ orderId, totalMinor: orderTerms?.totalMinor ?? Number(order.value.totalMinor), asOfDate,
        schedules: related(state, 'payment_schedule', 'order', orderId).filter(object => object.value.status === 'confirmed').map(object => { const term = cast<{
            effectiveDate: string;
            amountMinor: number;
            dueDate: string;
        }[]>(object.value.termsHistory ?? []).filter(term => term.effectiveDate <= asOfDate).at(-1); return { id: object.reference.objectId, orderId, amountMinor: term?.amountMinor ?? Number(object.value.amountMinor), dueDate: term?.dueDate ?? String(object.value.dueDate) }; }),
        receipts: related(state, 'receipt', 'order', orderId).filter(included).map(object => ({ ...fact(object), allocations: receiptAllocations(object) })),
        refunds: related(state, 'refund', 'order', orderId).filter(included).map(object => ({ ...fact(object), receiptId: referenceId(object.value.receipt)!, releasedAllocations: allocations(object.value.releasedAllocations) })),
        reversals: adjustments.filter(object => object.value.kind === 'receipt_reversal').map(object => ({ ...fact(object), receiptId: referenceId(object.value.receipt)!, releasedAllocations: allocations(object.value.releasedAllocations) })),
        writeOffs: adjustments.filter(object => object.value.kind === 'write_off').map(object => ({ ...fact(object), scheduleId: referenceId(object.value.schedule)! })),
    });
}
export function projectCosts(state: BusinessState, projectId: string, asOfDate = '9999-12-31') {
    const project = entity(state, 'project', projectId), expenses = related(state, 'expense', 'project', projectId).filter(object => object.value.status !== 'cancelled');
    const confirmed = expenses.filter(object => object.value.status === 'confirmed' && String(object.value.businessDate) <= asOfDate);
    const total = confirmed.reduce((sum, object) => sum + BigInt(Number(object.value.amountMinor)), 0n);
    if (total > BigInt(Number.MAX_SAFE_INTEGER))
        throw new BusinessDomainError('MONEY_OUT_OF_RANGE');
    const report = state.objects.get(businessObjectKey('business_review', String(project.value.costReportId)));
    const expected = confirmed.map(object => canonicalJson(object.reference)).sort(), captured = cast<BusinessObjectRef[]>(report?.value.expenseRefs ?? []).map(ref => canonicalJson(ref)).sort();
    const complete = !!report && expenses.length === confirmed.length && JSON.stringify(expected) === JSON.stringify(captured) && canonicalJson(report.value.order) === canonicalJson(project.value.order);
    const order = entity(state, 'order', referenceId(project.value.order)!);
    return { costsComplete: complete, confirmedCostMinor: Number(total), marginMinor: complete ? orderFinancials(state,order.reference.objectId,asOfDate).totalMinor - Number(total) : null,marginBasis:'order_value_minus_confirmed_cost' as const };
}
export function validateFinancialTimeline(state: BusinessState, orderId: string): void {
    const dates = new Set<string>(['9999-12-31']);
    for (const object of state.objects.values())
        if (referenceId(object.value.order) === orderId || object.reference.objectType === 'order' && object.reference.objectId === orderId) {
            if (typeof object.value.businessDate === 'string')
                dates.add(object.value.businessDate);
            for (const term of cast<{
                effectiveDate: string;
            }[]>(object.value.termsHistory ?? []))
                dates.add(term.effectiveDate);
        }
    for (const date of dates)
        orderFinancials(state, orderId, date);
}
