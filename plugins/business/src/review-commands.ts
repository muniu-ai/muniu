// SPDX-License-Identifier: Apache-2.0
import type { BusinessObjectRef } from '@mn/contracts';
import type { BusinessCommand, BusinessCommandContext, BusinessState } from './model.js';
import { fail, json, money, type BusinessCommandTools } from './command-context.js';
import { businessObjectKey } from './state.js';
import { businessDate, cast, orderFinancials, projectCosts, projectProgress, referenceId, related } from './fulfillment-queries.js';
import { BUSINESS_FIELD_CLASSES } from './access.js';
export function decideReview(state: BusinessState, command: BusinessCommand, context: BusinessCommandContext, t: BusinessCommandTools) {
    const { events, source, check, create } = t;
    const finish = (type: string) => ({ events, primaryObjectKey: businessObjectKey(type, command.id) });
    if (command.type === 'metric.publish') {
        if (context.actorKind !== 'human')
            fail('HUMAN_CONFIRMATION_REQUIRED', 403);
        create('metric_definition', command.id, 'published', { metric: command.metric, title: command.title, algorithmVersion: 'business-balances-v1' });
        return finish('metric_definition');
    }
    if (command.type === 'objective.create') {
        if (context.actorKind !== 'human')
            fail('HUMAN_CONFIRMATION_REQUIRED', 403);
        if (command.periodStart > command.periodEnd)
            fail('REVIEW_PERIOD_INVALID', 400);
        const order = source(command.order, 'order', ['totalMinor']), metric = source(command.metric, 'metric_definition', ['metric', 'algorithmVersion']);
        if (metric.value.metric === 'confirmed_cost')
            check(order, 'read', ['totalMinor']);
        create('operating_objective', command.id, 'created', { ...(order.value.departmentId ? { departmentId: order.value.departmentId } : {}), ...json({ order: order.reference, metric: metric.reference, periodStart: command.periodStart, periodEnd: command.periodEnd, ...(metric.value.metric === 'confirmed_cost' ? { costTargetMinor: command.targetMinor } : { targetMinor: command.targetMinor }), responsiblePrincipalId: context.actorId }) });
        return finish('operating_objective');
    }
    if (command.type !== 'business_review.snapshot')
        return fail('BUSINESS_COMMAND_UNSUPPORTED', 400);
    const order = source(command.order, 'order', ['totalMinor', 'scopeLines']);
    if (order.value.status !== 'active')
        fail('ORDER_NOT_ACTIVE');
    if (command.periodStart > command.periodEnd || command.periodEnd > businessDate(context.now))
        fail('REVIEW_PERIOD_INVALID', 400);
    const all = [order, ...[...state.objects.values()].filter(object => referenceId(object.value.order) === order.reference.objectId && !['business_review', 'operating_objective'].includes(object.reference.objectType))];
    const refs: BusinessObjectRef[] = [];
    for (const object of all) {
        if (object.reference.objectType === 'expense' && !command.includeCosts)
            continue;
        const fields = BUSINESS_FIELD_CLASSES[object.reference.objectType as keyof typeof BUSINESS_FIELD_CLASSES];
        check(object, 'read', Object.keys(object.value).filter(field => command.includeCosts || fields[field] !== 'cost'));
        refs.push(object.reference);
    }
    const financial = orderFinancials(state, order.reference.objectId, command.periodEnd);
    const priorDay = new Date(command.periodStart + 'T00:00:00.000Z');
    priorDay.setUTCDate(priorDay.getUTCDate() - 1);
    const opening = orderFinancials(state, order.reference.objectId, priorDay.toISOString().slice(0, 10));
    const period = { grossReceivedMinor: financial.grossReceivedMinor - opening.grossReceivedMinor, refundedMinor: financial.refundedMinor - opening.refundedMinor, reversedMinor: financial.reversedMinor - opening.reversedMinor, netReceivedMinor: financial.netReceivedMinor - opening.netReceivedMinor, writtenOffMinor: financial.writtenOffMinor - opening.writtenOffMinor };
    const project = related(state, 'project', 'order', order.reference.objectId)[0];
    if(command.includeCosts&&project?.value.costReportId){const report=state.objects.get(businessObjectKey('business_review',String(project.value.costReportId)));if(report){check(report,'read',Object.keys(report.value));refs.push(report.reference);}}
    const costs = command.includeCosts && project ? projectCosts(state, project.reference.objectId, command.periodEnd) : undefined;
    const periodCost = command.includeCosts ? money(related(state, 'expense', 'order', order.reference.objectId).filter(e => e.value.status === 'confirmed' && String(e.value.businessDate) >= command.periodStart && String(e.value.businessDate) <= command.periodEnd).reduce((sum, e) => sum + BigInt(Number(e.value.amountMinor)), 0n)) : undefined;
    let objectiveResult: unknown, costObjectiveResult: unknown;
    if (command.objective) {
        const objective = source(command.objective, 'operating_objective', ['periodStart', 'periodEnd', 'metric']);
        if (referenceId(objective.value.order) !== order.reference.objectId || objective.value.periodStart !== command.periodStart || objective.value.periodEnd !== command.periodEnd)
            fail('OBJECTIVE_PERIOD_MISMATCH');
        const metric = source(cast<BusinessObjectRef>(objective.value.metric), 'metric_definition', ['metric', 'algorithmVersion']);
        check(objective, 'read', [metric.value.metric === 'confirmed_cost' ? 'costTargetMinor' : 'targetMinor']);
        if (metric.value.metric === 'confirmed_cost' && !command.includeCosts)
            fail('COST_SCOPE_REQUIRED', 403);
        refs.push(objective.reference, metric.reference);
        const actualMinor = metric.value.metric === 'net_received' ? period.netReceivedMinor : metric.value.metric === 'outstanding' ? financial.outstandingMinor : periodCost;
        // Cost results remain in the cost-protected section.
        if (metric.value.metric === 'confirmed_cost')
            costObjectiveResult = { metric: metric.reference, targetMinor: objective.value.costTargetMinor, actualMinor };
        else
            objectiveResult = { metric: metric.reference, targetMinor: objective.value.targetMinor, actualMinor };
    }
    create('business_review', command.id, 'recorded', { ...(order.value.departmentId ? { departmentId: order.value.departmentId } : {}), purpose: 'operating_review', algorithmVersion: 'business-balances-v1', ...json({ order: order.reference, periodStart: command.periodStart, periodEnd: command.periodEnd, observedAt: context.now, sourceRefs: refs.filter(ref => ['order', 'project', 'milestone', 'delivery_version', 'customer_acceptance'].includes(ref.objectType)), financialSources: refs.filter(ref => !['expense', 'project', 'milestone', 'delivery_version', 'customer_acceptance'].includes(ref.objectType)), ...(command.includeCosts ? { costSources: refs.filter(ref => ['order', 'project', 'expense', 'operating_objective', 'metric_definition','business_review'].includes(ref.objectType)) } : {}), financialMetrics: { ...financial, period }, deliveryMetrics: project ? projectProgress(state, project.reference.objectId, command.periodEnd) : null, ...(command.includeCosts ? { costMetrics: { ...(costs ?? { costsComplete: false, confirmedCostMinor: 0, marginMinor: null }), periodCostMinor: periodCost, ...(costObjectiveResult ? { objectiveResult: costObjectiveResult } : {}) } } : {}), ...(command.objective ? { objective: command.objective } : {}), ...(objectiveResult ? { objectiveResult } : {}) }) });
    return finish('business_review');
}
