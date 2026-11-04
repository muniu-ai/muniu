// SPDX-License-Identifier: Apache-2.0
import { parseEnterpriseContract, type BusinessObjectRef, type EvidenceRef, type JsonObject } from '@mn/contracts';
import { BusinessDomainError, type BusinessCommand, type BusinessCommandContext, type BusinessEvent, type BusinessObject, type BusinessObjectType, type BusinessState, type QuoteLine, type OrderLine } from './model.js';
import { businessDigest, businessObjectKey } from './state.js';
import { decideFulfillmentCommand } from './fulfillment-commands.js';
import { businessCommandTools, json, fail, valueAs, money } from './command-context.js';
function scopeLines(lines: readonly (QuoteLine | OrderLine)[]) {
    return lines.map(line => ({ lineId: 'id' in line ? line.id : line.quoteLineId, service: line.service, title: line.title,
        unit: line.unit, quantity: line.quantity, scope: line.scope, acceptanceCriteria: line.acceptanceCriteria }));
}
export function decideBusinessCommand(state: BusinessState, raw: BusinessCommand, context: BusinessCommandContext): {
    events: readonly BusinessEvent[];
    primaryObjectKey: string;
} {
    const command = parseEnterpriseContract('EnterpriseBusinessCommand', raw);
    const tools = businessCommandTools(state, command, context);
    const { events, source, event, create, current, confirm, evidence, activeService, parentFields } = tools;
    let primaryType: BusinessObjectType;
    switch (command.type) {
        case 'customer.create':
            primaryType = 'customer';
            create(primaryType, command.id, 'created', json({ name: command.name, ...(command.departmentId ? { departmentId: command.departmentId } : {}) }));
            break;
        case 'customer.rename': {
            primaryType = 'customer';
            current(primaryType, command.id, command.expectedStreamVersion, ['name']);
            event(primaryType, command.id, command.expectedStreamVersion, 'customer.renamed', { name: command.name });
            break;
        }
        case 'contact.create': {
            primaryType = 'contact';
            const customer = source(command.customer, 'customer', ['name'], 'write');
            create(primaryType, command.id, 'created', { ...parentFields(customer), ...json({ customer: command.customer, name: command.name, email: command.email, phone: command.phone }) });
            break;
        }
        case 'contact.update': {
            primaryType = 'contact';
            current(primaryType, command.id, command.expectedStreamVersion, ['name', 'email', 'phone']);
            event(primaryType, command.id, command.expectedStreamVersion, 'contact.updated', { name: command.name, email: command.email, phone: command.phone });
            break;
        }
        case 'opportunity.create':
        case 'opportunity.update': {
            primaryType = 'opportunity';
            const customer = source(command.customer, 'customer', ['name'], 'write');
            const data = { ...parentFields(customer), ...json({ customer: command.customer, title: command.title }) };
            if (command.type === 'opportunity.create')
                create(primaryType, command.id, 'created', data);
            else {
                current(primaryType, command.id, command.expectedStreamVersion, ['customer', 'title', 'departmentId']);
                event(primaryType, command.id, command.expectedStreamVersion, 'opportunity.updated', data);
            }
            break;
        }
        case 'service.publish': {
            primaryType = 'service_version';
            if (context.actorKind !== 'human')
                fail('HUMAN_CONFIRMATION_REQUIRED', 403);
            if (Date.parse(command.validUntil) <= Date.parse(command.validFrom) || Date.parse(command.validUntil) <= Date.parse(context.now))
                fail('SERVICE_VALIDITY_INVALID', 400);
            const prior = [...state.objects.values()].filter(item => item.reference.objectType === primaryType && item.value.serviceCode === command.serviceCode && item.value.status === 'active');
            if (command.supersedes) {
                const previous = current(primaryType, command.supersedes.id, command.supersedes.expectedStreamVersion, ['unitPriceMinor', 'status']);
                if (previous.value.serviceCode !== command.serviceCode || previous.value.status !== 'active' || prior.length !== 1 || prior[0]!.reference.objectId !== previous.reference.objectId)
                    fail('SERVICE_VERSION_CONFLICT');
                event(primaryType, previous.reference.objectId, previous.reference.streamVersion, 'service_version.superseded', { status: 'superseded', supersededBy: command.id });
            }
            else if (prior.length)
                fail('SERVICE_VERSION_CONFLICT');
            const { type: _type, id: _id, supersedes: _supersedes, ...terms } = command;
            create(primaryType, command.id, 'published', { ...json(terms), status: 'active', currency: 'CNY' });
            break;
        }
        case 'quote.prepare': {
            primaryType = 'quote_version';
            const opportunity = source(command.opportunity, 'opportunity', ['title', 'customer'], 'write');
            source(valueAs<BusinessObjectRef>(opportunity.value.customer), 'customer', ['name']);
            if (Date.parse(command.validUntil) <= Date.parse(context.now))
                fail('QUOTE_EXPIRED');
            const lines: QuoteLine[] = command.lines.map((line, index) => {
                const service = source(line.service, 'service_version', ['title', 'unit', 'unitPriceMinor', 'scope', 'acceptanceCriteria']);
                activeService(service);
                if (Date.parse(command.validUntil) > Date.parse(String(service.value.validUntil)))
                    fail('QUOTE_VALIDITY_EXCEEDS_SERVICE');
                return { id: `line-${index + 1}`, service: line.service, title: String(service.value.title), unit: String(service.value.unit), unitPriceMinor: Number(service.value.unitPriceMinor),
                    scope: String(service.value.scope), acceptanceCriteria: valueAs<readonly string[]>(service.value.acceptanceCriteria),
                    quantity: line.quantity, totalMinor: money(BigInt(Number(service.value.unitPriceMinor)) * BigInt(line.quantity)) };
            });
            create(primaryType, command.id, 'prepared', { ...parentFields(opportunity), ...json({ opportunity: command.opportunity, customer: opportunity.value.customer, lines, scopeLines: scopeLines(lines),
                    totalMinor: money(lines.reduce((sum, line) => sum + BigInt(line.totalMinor), 0n)), currency: 'CNY', validUntil: command.validUntil, status: 'draft' }) });
            break;
        }
        case 'quote.approve': {
            primaryType = 'quote_version';
            const quote = current(primaryType, command.id, command.expectedStreamVersion, ['lines', 'totalMinor'], 'business_approve');
            if (quote.value.status !== 'draft')
                fail('QUOTE_STATE_CONFLICT');
            if (Date.parse(String(quote.value.validUntil)) <= Date.parse(context.now))
                fail('QUOTE_EXPIRED');
            source(valueAs<BusinessObjectRef>(quote.value.opportunity), 'opportunity', ['title', 'customer']);
            source(valueAs<BusinessObjectRef>(quote.value.customer), 'customer', ['name']);
            for (const line of valueAs<QuoteLine[]>(quote.value.lines))
                activeService(source(line.service, 'service_version', ['unitPriceMinor', 'scope', 'acceptanceCriteria']));
            const approvalId = confirm(quote, ['lines', 'totalMinor', 'validUntil']);
            event(primaryType, command.id, command.expectedStreamVersion, 'quote_version.approved', { status: 'approved', approvalId });
            break;
        }
        case 'quote.record_acceptance': {
            primaryType = 'quote_version';
            const quote = current(primaryType, command.id, command.expectedStreamVersion, ['lines', 'totalMinor'], 'business_approve');
            if (quote.value.status !== 'approved')
                fail('QUOTE_STATE_CONFLICT');
            if (Date.parse(String(quote.value.validUntil)) <= Date.parse(context.now))
                fail('QUOTE_EXPIRED');
            evidence(command.evidence, quote);
            const approvalId = confirm(quote, ['lines', 'totalMinor', 'validUntil']);
            const acceptanceId = businessDigest(['quote-acceptance', quote.reference]);
            // The same human confirmation creates the independent acceptance fact and advances the quote atomically.
            event('customer_acceptance', acceptanceId, 0, 'customer_acceptance.recorded', { ...parentFields(quote), ownerPrincipalId: quote.value.ownerPrincipalId, preparedByPrincipalId: quote.value.preparedByPrincipalId,
                subjectRef: quote.reference, evidence: command.evidence, confirmedByPrincipalId: context.actorId, confirmedAt: context.now, approvalId });
            event(primaryType, command.id, command.expectedStreamVersion, 'quote_version.accepted', { status: 'accepted', acceptanceId });
            break;
        }
        case 'contract.create': {
            primaryType = 'contract';
            const quote = source(command.quote, 'quote_version', ['lines', 'totalMinor'], 'write');
            if (quote.value.status !== 'accepted')
                fail('CUSTOMER_ACCEPTANCE_REQUIRED');
            create(primaryType, command.id, 'created', { ...parentFields(quote), ...json({ title: command.title, quote: command.quote, customer: quote.value.customer,
                    lines: quote.value.lines, scopeLines: quote.value.scopeLines, totalMinor: quote.value.totalMinor, currency: 'CNY', status: 'draft' }) });
            break;
        }
        case 'contract.activate': {
            primaryType = 'contract';
            const contract = current(primaryType, command.id, command.expectedStreamVersion, ['lines', 'totalMinor'], 'business_approve');
            if (contract.value.status !== 'draft')
                fail('CONTRACT_STATE_CONFLICT');
            const quote = source(valueAs<BusinessObjectRef>(contract.value.quote), 'quote_version', ['lines', 'totalMinor']);
            if (quote.value.status !== 'accepted')
                fail('CUSTOMER_ACCEPTANCE_REQUIRED');
            evidence(command.evidence, contract);
            const approvalId = confirm(contract, ['title', 'lines', 'totalMinor']);
            event(primaryType, command.id, command.expectedStreamVersion, 'contract.activated', { status: 'active', approvalId, signatureEvidence: command.evidence });
            break;
        }
        case 'order.create': {
            primaryType = 'order';
            const contract = source(command.contract, 'contract', ['lines', 'totalMinor'], 'write');
            if (contract.value.status !== 'active')
                fail('CONTRACT_NOT_ACTIVE');
            if (new Set(command.lines.map(line => line.quoteLineId)).size !== command.lines.length)
                fail('DUPLICATE_QUOTE_LINE', 400);
            const lines: OrderLine[] = command.lines.map(line => {
                const quoted = valueAs<QuoteLine[]>(contract.value.lines).find(item => item.id === line.quoteLineId);
                if (!quoted || line.quantity > quoted.quantity)
                    fail('CONTRACT_ALLOCATION_EXCEEDED');
                const { id: _id, ...terms } = quoted!;
                return { ...terms, ...line, totalMinor: money(BigInt(quoted!.unitPriceMinor) * BigInt(line.quantity)) };
            });
            create(primaryType, command.id, 'created', { ...parentFields(contract), ...json({ contract: command.contract, customer: contract.value.customer, lines, scopeLines: scopeLines(lines),
                    totalMinor: money(lines.reduce((sum, line) => sum + BigInt(line.totalMinor), 0n)), currency: 'CNY', status: 'draft' }) });
            break;
        }
        case 'order.activate': {
            primaryType = 'order';
            const order = current(primaryType, command.id, command.expectedStreamVersion, ['lines', 'totalMinor'], 'business_approve');
            if (order.value.status !== 'draft')
                fail('ORDER_STATE_CONFLICT');
            const contract = source(valueAs<BusinessObjectRef>(order.value.contract), 'contract', ['lines', 'totalMinor']);
            if (contract.value.status !== 'active')
                fail('CONTRACT_NOT_ACTIVE');
            const active = [...state.objects.values()].filter(item => item.reference.objectType === 'order' && item.value.status === 'active'
                && valueAs<BusinessObjectRef>(item.value.contract).objectId === contract.reference.objectId);
            for (const line of valueAs<OrderLine[]>(order.value.lines)) {
                const totalQuantity = active.reduce((sum, item) => sum + valueAs<OrderLine[]>(item.value.lines).filter(other => other.quoteLineId === line.quoteLineId).reduce((count, other) => count + BigInt(other.quantity), 0n), BigInt(line.quantity));
                const quoted = valueAs<QuoteLine[]>(contract.value.lines).find(item => item.id === line.quoteLineId);
                if (!quoted || totalQuantity > BigInt(quoted.quantity))
                    fail('CONTRACT_ALLOCATION_EXCEEDED');
            }
            if (active.reduce((sum, item) => sum + BigInt(Number(item.value.totalMinor)), BigInt(Number(order.value.totalMinor))) > BigInt(Number(contract.value.totalMinor)))
                fail('CONTRACT_ALLOCATION_EXCEEDED');
            const approvalId = confirm(order, ['lines', 'totalMinor']);
            event(primaryType, command.id, command.expectedStreamVersion, 'order.activated', { status: 'active', approvalId });
            break;
        }
        default: return decideFulfillmentCommand(state, command, context, tools);
    }
    return { events, primaryObjectKey: businessObjectKey(primaryType, command.id) };
}
