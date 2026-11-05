// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, type BusinessObjectRef, type JsonObject } from '@mn/contracts';
import type { BusinessCommand, BusinessCommandContext, BusinessObject, BusinessObjectType, BusinessState } from './model.js';
import { fail, json, money, type BusinessCommandTools } from './command-context.js';
import { applyBusinessEvents, businessDigest, businessObjectKey } from './state.js';
import { addUnits, businessDate, cast, entity, orderFinancials, projectCosts, projectProgress, referenceId, related, sumUnits, withinUnits, validateFinancialTimeline, type Units } from './fulfillment-queries.js';
import { decideReview } from './review-commands.js';
import { decideChangeRequest } from './scope-changes.js';
export function decideFulfillmentCommand(state: BusinessState, command: BusinessCommand, context: BusinessCommandContext, t: BusinessCommandTools) {
    const { events, source, current, event, create, confirm, evidence, check } = t;
    const finish = (type: BusinessObjectType) => ({ events, primaryObjectKey: businessObjectKey(type, command.id) });
    const parent = (object: BusinessObject) => ({ ownerPrincipalId: String(object.value.ownerPrincipalId), ...(object.value.departmentId ? { departmentId: object.value.departmentId } : {}) });
    const order = (reference: BusinessObjectRef, fields: readonly string[]) => { const value = source(reference, 'order', fields); if (value.value.status !== 'active')
        fail('ORDER_NOT_ACTIVE'); return value; };
    const currentOrder = (ref: BusinessObjectRef) => { const target = entity(state, 'order', ref.objectId); check(target, 'read', ['totalMinor']); if (target.value.status !== 'active')
        fail('ORDER_NOT_ACTIVE'); return target; };
    const liveProject = (id: string) => {
        const project = entity(state, 'project', id);
        check(project, 'read', ['scopeLines']);
        if (project.value.status !== 'active')
            fail('PROJECT_SCOPE_PENDING');
        order(cast<BusinessObjectRef>(project.value.order), ['scopeLines']);
        return project;
    };
    const allocations = (parts: readonly {
        schedule: BusinessObjectRef;
        amountMinor: number;
    }[], orderId: string) => {
        if (new Set(parts.map(part => part.schedule.objectId)).size !== parts.length)
            fail('DUPLICATE_PAYMENT_ALLOCATION', 400);
        for (const part of parts) {
            const period = source(part.schedule, 'payment_schedule', ['amountMinor', 'dueDate']);
            if (period.value.status !== 'confirmed' || referenceId(period.value.order) !== orderId)
                fail('PAYMENT_SCHEDULE_UNAVAILABLE');
        }
    };
    const actualDate = (value: string) => { if (value > businessDate(context.now))
        fail('BUSINESS_DATE_IN_FUTURE', 400); };
    const validateFunds = (orderId: string) => { validateFinancialTimeline(applyBusinessEvents(state, events), orderId); };
    const confirmation = (type: BusinessObjectType, fields: readonly string[]) => {
        if (!('expectedStreamVersion' in command) || !('evidence' in command))
            fail('INVALID_COMMAND', 400);
        const input = command as Extract<BusinessCommand, {
            evidence: unknown;
        }>, object = current(type, command.id, input.expectedStreamVersion, fields, 'business_approve');
        if (object.value.status !== 'draft')
            fail('BUSINESS_STATE_CONFLICT');
        evidence(input.evidence, object);
        const approvalId = confirm(object, fields);
        return { object, approvalId, evidence: input.evidence };
    };
    switch (command.type) {
        case 'project.create': {
            const target = order(command.order, ['scopeLines']);
            if (related(state, 'project', 'order', command.order.objectId).length)
                fail('ORDER_PROJECT_EXISTS');
            create('project', command.id, 'created', { ...(target.value.departmentId ? { departmentId: target.value.departmentId } : {}), order: json(command.order), title: command.title, scopeLines: target.value.scopeLines!, status: 'active' });
            return finish('project');
        }
        case 'milestone.create': {
            const project = source(command.project, 'project', ['scopeLines'], 'write');
            liveProject(project.reference.objectId);
            const all = new Map<string, bigint>();
            for (const milestone of related(state, 'milestone', 'project', project.reference.objectId))
                addUnits(all, cast<Units[]>(milestone.value.lines));
            addUnits(all, command.lines);
            withinUnits(all, sumUnits(cast<Units[]>(project.value.scopeLines)), 'MILESTONE_QUANTITY_EXCEEDED');
            create('milestone', command.id, 'created', { ...parent(project), project: json(project.reference), order: project.value.order!, title: command.title, dueDate: command.dueDate, lines: json({ value: command.lines }).value!, status: 'active' });
            return finish('milestone');
        }
        case 'delivery.report': {
            const milestone = source(command.milestone, 'milestone', ['lines'], 'write'), project = liveProject(referenceId(milestone.value.project)!);
            withinUnits(sumUnits(command.lines), sumUnits(cast<Units[]>(milestone.value.lines)), 'DELIVERY_QUANTITY_EXCEEDED');
            create('delivery_version', command.id, 'reported', { ...parent(project), project: json(project.reference), order: project.value.order!, milestone: json(milestone.reference), summary: command.summary, lines: json({ value: command.lines }).value!, status: 'draft' });
            return finish('delivery_version');
        }
        case 'delivery.receive': {
            const delivery = current('delivery_version', command.id, command.expectedStreamVersion, ['lines', 'summary']);
            if (context.actorKind !== 'human')
                fail('HUMAN_CONFIRMATION_REQUIRED', 403);
            if (delivery.value.status !== 'draft')
                fail('BUSINESS_STATE_CONFLICT');
            liveProject(referenceId(delivery.value.project)!);
            const milestone = source(cast<BusinessObjectRef>(delivery.value.milestone), 'milestone', ['lines']);
            const count = new Map<string, bigint>();
            for (const other of related(state, 'delivery_version', 'milestone', milestone.reference.objectId))
                if (other.value.status === 'received')
                    addUnits(count, cast<Units[]>(other.value.lines));
            addUnits(count, cast<Units[]>(delivery.value.lines));
            withinUnits(count, sumUnits(cast<Units[]>(milestone.value.lines)), 'DELIVERY_QUANTITY_EXCEEDED');
            event('delivery_version', command.id, command.expectedStreamVersion, 'delivery_version.received', { status: 'received', receivedBy: context.actorId, receivedAt: context.now });
            return finish('delivery_version');
        }
        case 'acceptance.prepare': {
            const delivery = source(command.delivery, 'delivery_version', ['lines', 'summary']);
            if (delivery.value.status !== 'received')
                fail('DELIVERY_NOT_RECEIVED');
            const project = liveProject(referenceId(delivery.value.project)!);
            withinUnits(sumUnits(command.lines), sumUnits(cast<Units[]>(delivery.value.lines)), 'ACCEPTANCE_QUANTITY_EXCEEDED');
            create('customer_acceptance', command.id, 'prepared', { ...parent(project), purpose: 'delivery', project: json(project.reference), order: project.value.order!, delivery: json(delivery.reference), lines: json({ value: command.lines }).value!, status: 'draft' });
            return finish('customer_acceptance');
        }
        case 'acceptance.confirm': {
            const { object, approvalId, evidence: proof } = confirmation('customer_acceptance', ['delivery', 'lines']);
            if (object.value.purpose !== 'delivery')
                fail('ACCEPTANCE_SCOPE_INVALID');
            const delivery = source(cast<BusinessObjectRef>(object.value.delivery), 'delivery_version', ['lines', 'summary']);
            liveProject(referenceId(delivery.value.project)!);
            if (delivery.value.preparedByPrincipalId === context.actorId)
                fail('SEPARATION_OF_DUTIES_REQUIRED', 403);
            const accepted = new Map<string, bigint>();
            for (const other of related(state, 'customer_acceptance', 'delivery', delivery.reference.objectId))
                if (other.value.status === 'confirmed')
                    addUnits(accepted, cast<Units[]>(other.value.lines));
            addUnits(accepted, cast<Units[]>(object.value.lines));
            withinUnits(accepted, sumUnits(cast<Units[]>(delivery.value.lines)), 'ACCEPTANCE_QUANTITY_EXCEEDED');
            event('customer_acceptance', command.id, command.expectedStreamVersion, 'customer_acceptance.confirmed', { status: 'confirmed', approvalId, evidence: proof, confirmedAt: context.now });
            return finish('customer_acceptance');
        }
        case 'payment_schedule.create': {
            const target = order(command.order, ['totalMinor']);
            const effectiveDate = command.businessDate ?? businessDate(context.now); actualDate(effectiveDate);
            create('payment_schedule', command.id, 'created', { ...parent(target), order: json(target.reference), amountMinor: command.amountMinor, dueDate: command.dueDate, businessDate: effectiveDate,
                termsHistory: [{ effectiveDate, amountMinor: command.amountMinor, dueDate: command.dueDate }], currency: 'CNY', status: 'draft' });
            return finish('payment_schedule');
        }
        case 'receipt.prepare': {
            const target = order(command.order, ['totalMinor']);
            actualDate(command.businessDate);
            allocations(command.allocations, target.reference.objectId);
            if (command.allocations.reduce((sum, part) => sum + BigInt(part.amountMinor), 0n) > BigInt(command.amountMinor))
                fail('PAYMENT_ALLOCATION_EXCEEDED');
            create('receipt', command.id, 'prepared', { ...parent(target), ...json({ order: target.reference, amountMinor: command.amountMinor, businessDate: command.businessDate, allocations: command.allocations }), currency: 'CNY', status: 'draft' });
            return finish('receipt');
        }
        case 'refund.prepare': {
            const receipt = source(command.receipt, 'receipt', ['amountMinor', 'allocations']);
            if (receipt.value.status !== 'confirmed')
                fail('RECEIPT_NOT_CONFIRMED');
            actualDate(command.businessDate);
            if (command.businessDate < String(receipt.value.businessDate))
                fail('REDUCTION_DATE_INVALID', 400);
            const target = currentOrder(cast<BusinessObjectRef>(receipt.value.order));
            allocations(command.releasedAllocations, target.reference.objectId);
            create('refund', command.id, 'prepared', { ...parent(target), ...json({ receipt: receipt.reference, order: target.reference, amountMinor: command.amountMinor, businessDate: command.businessDate, releasedAllocations: command.releasedAllocations }), currency: 'CNY', status: 'draft' });
            return finish('refund');
        }
        case 'adjustment.prepare': {
            actualDate(command.businessDate);
            let target: BusinessObject;
            if (command.kind === 'receipt_reversal'||command.kind==='receipt_allocation') {
                const receipt = source(command.receipt, 'receipt', ['amountMinor', 'allocations']);
                if (receipt.value.status !== 'confirmed')
                    fail('RECEIPT_NOT_CONFIRMED');
                if (command.businessDate < String(receipt.value.businessDate))
                    fail('REDUCTION_DATE_INVALID', 400);
                target = currentOrder(cast<BusinessObjectRef>(receipt.value.order));
                allocations(command.kind==='receipt_reversal'?command.releasedAllocations:[{schedule:command.schedule,amountMinor:command.amountMinor}], target.reference.objectId);
            }
            else if (command.kind === 'schedule_revision') {
                const schedule = source(command.schedule, 'payment_schedule', ['amountMinor', 'dueDate']);
                if (schedule.value.status !== 'confirmed')
                    fail('PAYMENT_SCHEDULE_UNAVAILABLE');
                target = currentOrder(cast<BusinessObjectRef>(schedule.value.order));
            }
            else {
                target = order(command.order, ['totalMinor']);
                allocations([{ schedule: command.schedule, amountMinor: command.amountMinor }], target.reference.objectId);
            }
            const { type: _type, id: _id, ...data } = command;
            create('adjustment', command.id, 'prepared', { ...parent(target), ...json(data), order: json(target.reference), currency: 'CNY', status: 'draft' });
            return finish('adjustment');
        }
        case 'expense.prepare': {
            const project = source(command.project, 'project', ['scopeLines']);
            actualDate(command.businessDate);
            const target = order(cast<BusinessObjectRef>(project.value.order), ['totalMinor']);
            create('expense', command.id, 'prepared', { ...parent(target), project: json(project.reference), order: json(target.reference), amountMinor: command.amountMinor, businessDate: command.businessDate, description: command.description, currency: 'CNY', status: 'draft' });
            return finish('expense');
        }
        case 'payment_schedule.confirm':
        case 'receipt.confirm':
        case 'refund.confirm':
        case 'adjustment.confirm':
        case 'expense.confirm': {
            const type = command.type.split('.')[0] as BusinessObjectType;
            const fields = type === 'payment_schedule' ? ['amountMinor', 'dueDate', 'businessDate'] : type === 'expense' ? ['amountMinor', 'description'] : ['amountMinor', 'businessDate'];
            const { object, approvalId, evidence: proof } = confirmation(type, fields), target = order(cast<BusinessObjectRef>(object.value.order), ['totalMinor']);
            if (type === 'receipt')
                allocations(cast<{
                    schedule: BusinessObjectRef;
                    amountMinor: number;
                }[]>(object.value.allocations), target.reference.objectId);
            if (type === 'refund' || (type === 'adjustment' && ['receipt_reversal','receipt_allocation'].includes(String(object.value.kind)))) {
                const receipt = source(cast<BusinessObjectRef>(object.value.receipt), 'receipt', ['amountMinor', 'allocations']);
                if (receipt.value.status !== 'confirmed')
                    fail('RECEIPT_NOT_CONFIRMED');
                allocations(cast<{
                    schedule: BusinessObjectRef;
                    amountMinor: number;
                }[]>(object.value.kind==='receipt_allocation'?[{schedule:object.value.schedule,amountMinor:object.value.amountMinor}]:object.value.releasedAllocations), target.reference.objectId);
            }
            if (type === 'adjustment' && object.value.kind === 'write_off')
                allocations([{ schedule: cast<BusinessObjectRef>(object.value.schedule), amountMinor: Number(object.value.amountMinor) }], target.reference.objectId);
            if (type === 'expense')
                source(cast<BusinessObjectRef>(object.value.project), 'project', ['scopeLines']);
            if (type === 'adjustment' && object.value.kind === 'schedule_revision') {
                const schedule = source(cast<BusinessObjectRef>(object.value.schedule), 'payment_schedule', ['amountMinor', 'dueDate']);
                const last = cast<{
                    effectiveDate: string;
                }[]>(schedule.value.termsHistory ?? []).at(-1);
                if (last && String(object.value.businessDate) < last.effectiveDate)
                    fail('ADJUSTMENT_DATE_CONFLICT');
                if (!last) fail('PAYMENT_SCHEDULE_HISTORY_INVALID');
                event('payment_schedule', schedule.reference.objectId, schedule.reference.streamVersion, 'payment_schedule.revised', { amountMinor: object.value.proposedAmountMinor, dueDate: object.value.proposedDueDate, adjustmentId: command.id, termsHistory: [...cast<unknown[]>(schedule.value.termsHistory), { effectiveDate: object.value.businessDate, amountMinor: object.value.proposedAmountMinor, dueDate: object.value.proposedDueDate }] });
            }
            event(type, command.id, command.expectedStreamVersion, `${type}.confirmed`, { status: 'confirmed', approvalId, evidence: proof, confirmedAt: context.now });
            validateFunds(target.reference.objectId);
            return finish(type);
        }
        case 'receipt.cancel':
        case 'refund.cancel':
        case 'adjustment.cancel':
        case 'expense.cancel': {
            const type = command.type.split('.')[0] as BusinessObjectType, object = current(type, command.id, command.expectedStreamVersion, []);
            if (object.value.status !== 'draft')
                fail('BUSINESS_STATE_CONFLICT');
            event(type, command.id, command.expectedStreamVersion, `${type}.cancelled`, { status: 'cancelled' });
            return finish(type);
        }
        case 'project.costs.confirm': {
            const project = current('project', command.id, command.expectedStreamVersion, ['scopeLines', 'costReportId'], 'business_approve');
            liveProject(project.reference.objectId);
            const expenses = related(state, 'expense', 'project', project.reference.objectId).filter(object => object.value.status !== 'cancelled');
            if (expenses.some(object => object.value.status !== 'confirmed'))
                fail('COSTS_UNCONFIRMED');
            const expected = expenses.map(object => canonicalJson(object.reference)).sort(), selected = command.expenseRefs.map(ref => canonicalJson(ref)).sort();
            if (JSON.stringify(expected) !== JSON.stringify(selected) || command.zeroCost !== (expenses.length === 0))
                fail('COST_SCOPE_MISMATCH');
            for (const ref of command.expenseRefs)
                source(ref, 'expense', ['amountMinor', 'description']);
            evidence(command.evidence, project);
            const approvalId = confirm(project, ['scopeLines', 'costReportId']);
            const id = businessDigest(['cost-report', project.reference, command.expenseRefs]);
            event('business_review', id, 0, 'business_review.recorded', { ...parent(project), preparedByPrincipalId: context.actorId, purpose: 'cost_completion', project: project.reference, order: project.value.order, expenseRefs: command.expenseRefs, zeroCost: command.zeroCost, evidence: command.evidence, approvalId, recordedAt: context.now });
            event('project', command.id, command.expectedStreamVersion, 'project.costs_confirmed', { costReportId: id });
            return finish('project');
        }
        case 'metric.publish':
        case 'objective.create':
        case 'business_review.snapshot': return decideReview(state, command, context, t);
        default: return decideChangeRequest(state, command, context, t);
    }
}
