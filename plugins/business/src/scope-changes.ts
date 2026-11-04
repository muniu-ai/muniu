// SPDX-License-Identifier: Apache-2.0
import type { BusinessObjectRef } from '@mn/contracts';
import type { BusinessCommand, BusinessCommandContext, BusinessState, OrderLine, QuoteLine, BusinessObject } from './model.js';
import { fail, json, money, type BusinessCommandTools } from './command-context.js';
import { applyBusinessEvents, businessDigest, businessObjectKey } from './state.js';
import { cast, entity, related, referenceId, sumUnits, withinUnits, addUnits, orderFinancials, businessDate, validateFinancialTimeline, type Units } from './fulfillment-queries.js';
const scopes = (lines: readonly OrderLine[]) => lines.map(line => ({ lineId: line.quoteLineId, service: line.service, title: line.title, unit: line.unit, quantity: line.quantity, scope: line.scope, acceptanceCriteria: line.acceptanceCriteria }));
export function decideChangeRequest(state: BusinessState, command: BusinessCommand, context: BusinessCommandContext, t: BusinessCommandTools) {
    const { events, source, current, check, create, event, confirm, evidence, activeService } = t;
    const finish = () => ({ events, primaryObjectKey: businessObjectKey('change_request', command.id) });
    const active = (object: BusinessObject) => { if (object.value.status !== 'active')
        fail('BUSINESS_STATE_CONFLICT'); };
    const delivered = (projectId: string, lines: readonly OrderLine[]) => { const counts = new Map<string, bigint>(); for (const d of related(state, 'delivery_version', 'project', projectId))
        if (d.value.status === 'received')
            addUnits(counts, cast<Units[]>(d.value.lines)); withinUnits(counts, sumUnits(scopes(lines)), 'DELIVERY_QUANTITY_EXCEEDED'); };
    switch (command.type) {
        case 'change_request.prepare': {
            const project = source(command.project, 'project', ['scopeLines'], 'write');
            active(project);
            const order = source(cast<BusinessObjectRef>(project.value.order), 'order', ['scopeLines']);
            active(order);
            if (related(state, 'change_request', 'project', project.reference.objectId).some(c => !['completed', 'cancelled'].includes(String(c.value.status))))
                fail('CHANGE_REQUEST_PENDING');
            create('change_request', command.id, 'prepared', { ownerPrincipalId: String(project.value.ownerPrincipalId), ...(project.value.departmentId ? { departmentId: project.value.departmentId } : {}), project: json(project.reference), order: json(order.reference), contract: order.value.contract!, description: command.description, status: 'draft' });
            return finish();
        }
        case 'change_request.cancel': {
            const change = current('change_request', command.id, command.expectedStreamVersion, ['status']);
            if (!['draft', 'priced'].includes(String(change.value.status)))
                fail('BUSINESS_STATE_CONFLICT');
            event('change_request', command.id, command.expectedStreamVersion, 'change_request.cancelled', { status: 'cancelled' });
            return finish();
        }
        case 'change_request.price': {
            const change = current('change_request', command.id, command.expectedStreamVersion, ['description', 'lines', 'totalMinor']);
            if (change.value.status !== 'draft')
                fail('BUSINESS_STATE_CONFLICT');
            const project = source(cast<BusinessObjectRef>(change.value.project), 'project', ['scopeLines']);
            active(project);
            const order = source(cast<BusinessObjectRef>(change.value.order), 'order', ['lines', 'totalMinor'], 'write');
            active(order);
            const contract = entity(state, 'contract', referenceId(order.value.contract)!);
            check(contract, 'read', ['lines', 'totalMinor']);
            active(contract);
            const previous = cast<OrderLine[]>(order.value.lines);
            const lines: OrderLine[] = command.lines.map((line, index) => {
                if ('orderLineId' in line) {
                    const old = previous.find(old => old.quoteLineId === line.orderLineId);
                    if (!old)
                        fail('ORDER_LINE_NOT_FOUND');
                    return { ...old!, quantity: line.quantity, totalMinor: money(BigInt(old!.unitPriceMinor) * BigInt(line.quantity)) };
                }
                const service = source(line.service, 'service_version', ['unitPriceMinor', 'scope', 'acceptanceCriteria']);
                activeService(service);
                return { quoteLineId: 'change-' + businessDigest([command.id, index]).slice(0, 24), service: service.reference, title: String(service.value.title), unit: String(service.value.unit), scope: String(service.value.scope), acceptanceCriteria: cast<string[]>(service.value.acceptanceCriteria), unitPriceMinor: Number(service.value.unitPriceMinor), quantity: line.quantity, totalMinor: money(BigInt(Number(service.value.unitPriceMinor)) * BigInt(line.quantity)) };
            });
            if (new Set(lines.map(line => line.quoteLineId)).size !== lines.length)
                fail('DUPLICATE_QUOTE_LINE', 400);
            delivered(project.reference.objectId, lines);
            const totalMinor = money(lines.reduce((sum, line) => sum + BigInt(line.totalMinor), 0n));
            event('change_request', command.id, command.expectedStreamVersion, 'change_request.priced', { status: 'priced', lines, scopeLines: scopes(lines), totalMinor, contractTotalMinor: money(BigInt(Number(contract.value.totalMinor)) - BigInt(Number(order.value.totalMinor)) + BigInt(totalMinor)), commercialPreparedByPrincipalId: context.actorId, contract: contract.reference });
            return finish();
        }
        case 'change_request.approve': {
            const change = current('change_request', command.id, command.expectedStreamVersion, ['lines', 'totalMinor', 'contractTotalMinor'], 'business_approve');
            if (change.value.status !== 'priced')
                fail('BUSINESS_STATE_CONFLICT');
            const project = source(cast<BusinessObjectRef>(change.value.project), 'project', ['scopeLines']);
            active(project);
            const order = source(cast<BusinessObjectRef>(change.value.order), 'order', ['lines', 'totalMinor']);
            active(order);
            const contract = source(cast<BusinessObjectRef>(change.value.contract), 'contract', ['lines', 'totalMinor']);
            active(contract);
            const lines = cast<OrderLine[]>(change.value.lines);
            delivered(project.reference.objectId, lines);
            for (const line of lines)
                if (!cast<OrderLine[]>(order.value.lines).some(old => old.quoteLineId === line.quoteLineId))
                    activeService(source(line.service, 'service_version', ['unitPriceMinor', 'scope', 'acceptanceCriteria']));
            if (change.value.preparedByPrincipalId === context.actorId)
                fail('SEPARATION_OF_DUTIES_REQUIRED', 403);
            evidence(command.evidence, change);
            const approvalId = confirm({ ...change, value: { ...change.value, preparedByPrincipalId: change.value.commercialPreparedByPrincipalId! } }, ['lines', 'totalMinor', 'contractTotalMinor']);
            check(order, 'business_approve', ['lines', 'totalMinor']);
            check(contract, 'business_approve', ['lines', 'totalMinor']);
            const amended = new Map(cast<QuoteLine[]>(contract.value.lines).map(line => [line.id, { ...line }]));
            for (const old of cast<OrderLine[]>(order.value.lines)) {
                const line = amended.get(old.quoteLineId);
                if (!line || line.quantity < old.quantity)
                    fail('CONTRACT_ALLOCATION_EXCEEDED');
                amended.set(old.quoteLineId, { ...line, quantity: line.quantity - old.quantity, totalMinor: money(BigInt(line.unitPriceMinor) * BigInt(line.quantity - old.quantity)) });
            }
            for (const line of lines) {
                const existing = amended.get(line.quoteLineId), quantity = (existing?.quantity ?? 0) + line.quantity;
                if (!Number.isSafeInteger(quantity))
                    fail('MONEY_OUT_OF_RANGE');
                const { quoteLineId, ...terms } = line;
                amended.set(quoteLineId, { ...terms, id: quoteLineId, quantity, totalMinor: money(BigInt(line.unitPriceMinor) * BigInt(quantity)) });
            }
            const contractLines = [...amended.values()].filter(line => line.quantity > 0);
            event('contract', contract.reference.objectId, contract.reference.streamVersion, 'contract.amended', { lines: contractLines, scopeLines: contractLines.map(({ id, ...line }) => ({ ...scopes([{ ...line, quoteLineId: id }])[0] })), totalMinor: change.value.contractTotalMinor, changeRequestId: command.id });
            const updatedContract = entity(applyBusinessEvents(state, events), 'contract', contract.reference.objectId);
            event('order', order.reference.objectId, order.reference.streamVersion, 'order.amended', { lines, scopeLines: scopes(lines), totalMinor: change.value.totalMinor, termsHistory: [...cast<unknown[]>(order.value.termsHistory ?? [{ effectiveDate: '0001-01-01', totalMinor: order.value.totalMinor }]), { effectiveDate: businessDate(context.now), totalMinor: change.value.totalMinor }], contract: updatedContract.reference, changeRequestId: command.id });
            const updated = applyBusinessEvents(state, events);
            validateFinancialTimeline(updated, order.reference.objectId);
            event('project', project.reference.objectId, project.reference.streamVersion, 'project.scope_blocked', { status: 'scope_pending', changeRequestId: command.id });
            event('change_request', command.id, command.expectedStreamVersion, 'change_request.approved', { status: 'approved', approvalId, evidence: command.evidence, approvedAt: context.now, order: entity(updated, 'order', order.reference.objectId).reference });
            return finish();
        }
        case 'change_request.project_confirm': {
            const change = current('change_request', command.id, command.expectedStreamVersion, ['project', 'scopeLines']);
            if (change.value.status !== 'approved')
                fail('BUSINESS_STATE_CONFLICT');
            if (context.actorKind !== 'human')
                fail('HUMAN_CONFIRMATION_REQUIRED', 403);
            const project = entity(state, 'project', referenceId(change.value.project)!);
            check(project, 'write', ['scopeLines']);
            if (project.value.status !== 'scope_pending' || project.value.changeRequestId !== command.id)
                fail('PROJECT_SCOPE_PENDING');
            const order = source(cast<BusinessObjectRef>(change.value.order), 'order', ['scopeLines']);
            const all = related(state, 'milestone', 'project', project.reference.objectId);
            if (new Set(command.milestones.map(m => m.milestone.objectId)).size !== command.milestones.length)
                fail('MILESTONE_SCOPE_MISMATCH');
            const total = new Map<string, bigint>();
            const replacements=new Map(command.milestones.map(item=>[item.milestone.objectId,item]));
            for(const milestone of all){check(milestone,'read',['lines']);addUnits(total,replacements.get(milestone.reference.objectId)?.lines??cast<Units[]>(milestone.value.lines));}
            for (const replacement of command.milestones) {
                const milestone = source(replacement.milestone, 'milestone', ['lines'], 'write');
                if (referenceId(milestone.value.project) !== project.reference.objectId || replacement.expectedStreamVersion !== milestone.reference.streamVersion)
                    fail('MILESTONE_SCOPE_MISMATCH');
                const received = new Map<string, bigint>();
                for (const d of related(state, 'delivery_version', 'milestone', milestone.reference.objectId))
                    if (d.value.status === 'received')
                        addUnits(received, cast<Units[]>(d.value.lines));
                withinUnits(received, sumUnits(replacement.lines), 'DELIVERY_QUANTITY_EXCEEDED');
                event('milestone', milestone.reference.objectId, milestone.reference.streamVersion, 'milestone.replanned', { lines: replacement.lines, order: order.reference,status:replacement.lines.length?'active':'removed' });
            }
            withinUnits(total, sumUnits(cast<Units[]>(order.value.scopeLines)), 'MILESTONE_QUANTITY_EXCEEDED');
            event('project', project.reference.objectId, project.reference.streamVersion, 'project.scope_confirmed', { status: 'active', order: order.reference, scopeLines: order.value.scopeLines,scopeHistory:[...cast<unknown[]>(project.value.scopeHistory??[{effectiveDate:'0001-01-01',scopeLines:project.value.scopeLines}]),{effectiveDate:businessDate(context.now),scopeLines:order.value.scopeLines}] });
            event('change_request', command.id, command.expectedStreamVersion, 'change_request.completed', { status: 'completed', projectConfirmedBy: context.actorId, projectConfirmedAt: context.now });
            return finish();
        }
        default: return fail('BUSINESS_COMMAND_UNSUPPORTED', 400);
    }
}
