// SPDX-License-Identifier: Apache-2.0
import type { BusinessContextTargetV2, BusinessObjectContextV2, BusinessStateV1, GoalResourceRefV2, Workspace } from "@mn/contracts";
import { KernelError, sha256, type KernelTransaction } from "@mn/kernel";
import { calculateBusinessSummary } from "@mn/plugin-opc";
import { assertBusinessAccess, OPC_BUSINESS_NAMESPACE } from "./business-management.js";

interface SourceScope { readonly tenantId: string; readonly workspaceId: string }
interface ReaderScope extends SourceScope { readonly principalId: string }
const kinds = new Set(["customer", "order", "delivery", "review"]);
const prefix = "opc.business.";
function fail(code: string, message: string): never { throw new KernelError(code, message, "重新选择当前工作区的业务对象并核对资料"); }

export function isBusinessContextRef(ref: { readonly namespace: string }): boolean {
  return ref.namespace.startsWith(prefix) && kinds.has(ref.namespace.slice(prefix.length));
}

function selectedContext(tx: KernelTransaction, scope: SourceScope, target: BusinessContextTargetV2): BusinessObjectContextV2 {
  const workspace = tx.getProjection<Workspace>("workspace", scope.workspaceId);
  if (!workspace || workspace.tenantId !== scope.tenantId) fail("WORKSPACE_NOT_FOUND", "工作区不存在");
  if (!workspace.activePluginIds.includes("opc")) fail("PLUGIN_NOT_ACTIVE", "工作区尚未启用 OPC");
  if (!kinds.has(target.kind) || !target.resourceId || target.resourceId.length > 200) fail("BUSINESS_CONTEXT_INVALID", "业务对象类型或标识无效");
  const state = tx.getProjection<BusinessStateV1>(OPC_BUSINESS_NAMESPACE, scope.workspaceId);
  if (!state || state.workspaceId !== scope.workspaceId || state.streamVersion < 1) fail("BUSINESS_CONTEXT_NOT_FOUND", "业务对象不存在");
  const customer = (id: string, version?: number) => {
    const value = state.customers.slice().reverse().find(item => item.id === id && (version === undefined || item.version === version));
    if (!value) fail("BUSINESS_CONTEXT_NOT_FOUND", "关联客户不存在");
    // Contact details are unnecessary for analysis and are not selected implicitly.
    const { contact: _contact, ...facts } = value;
    return facts;
  };
  const orderFacts = (id: string) => {
    const order = state.orders.find(item => item.id === id);
    if (!order) fail("BUSINESS_CONTEXT_NOT_FOUND", "关联订单不存在");
    const service = state.services.find(item => item.id === order.serviceId && item.version === order.serviceVersion);
    if (!service) fail("BUSINESS_CONTEXT_NOT_FOUND", "关联产品版本不存在");
    const payments = state.payments.filter(item => item.orderId === id);
    return { order, customer: customer(order.customerId, order.customerVersion), service,
      adjustments: state.adjustments.filter(item => item.orderId === id),
      deliveries: state.deliveries.filter(item => item.orderId === id),
      acceptances: state.acceptances.filter(item => item.orderId === id), payments,
      paymentReversals: state.paymentReversals.filter(item => payments.some(payment => payment.id === item.paymentId)),
      refunds: state.refunds.filter(item => item.orderId === id),
      balance: calculateBusinessSummary(state).orders.find(item => item.orderId === id),
    };
  };
  let title: string, selected: object;
  if (target.kind === "customer") {
    const value = customer(target.resourceId);
    title = `客户 · ${value.name}`; selected = { customer: value };
  } else if (target.kind === "order") {
    const facts = orderFacts(target.resourceId);
    title = `订单 · ${facts.customer.name} · ${facts.service.title}`; selected = facts;
  } else if (target.kind === "delivery") {
    const delivery = state.deliveries.find(item => item.id === target.resourceId);
    if (!delivery) fail("BUSINESS_CONTEXT_NOT_FOUND", "交付记录不存在");
    title = `交付 · ${delivery.title}`; selected = { delivery, ...orderFacts(delivery.orderId) };
  } else {
    const review = state.reviews.find(item => item.id === target.resourceId);
    if (!review) fail("BUSINESS_CONTEXT_NOT_FOUND", "复盘记录不存在");
    title = `复盘 · ${review.period.start} 至 ${review.period.end}`; selected = { review };
  }
  const content = JSON.stringify({ currency: "CNY", ...selected }, null, 2);
  const digest = sha256({ tenantId: scope.tenantId, workspaceId: scope.workspaceId, kind: target.kind,
    resourceId: target.resourceId, sourceStreamVersion: state.streamVersion, content });
  return { kind: target.kind, resourceId: target.resourceId, title, content,
    sourceRef: { namespace: `${prefix}${target.kind}`, resourceId: target.resourceId, streamVersion: state.streamVersion, digest } };
}

export function readBusinessContext(tx: KernelTransaction, scope: ReaderScope, target: BusinessContextTargetV2 | GoalResourceRefV2): BusinessObjectContextV2 {
  assertBusinessAccess(tx, scope, false);
  if ("namespace" in target) {
    if (!isBusinessContextRef(target)) fail("BUSINESS_CONTEXT_INVALID", "业务来源类型无效");
    const result = selectedContext(tx, scope, { kind: target.namespace.slice(prefix.length) as BusinessContextTargetV2["kind"], resourceId: target.resourceId });
    checkRef(result, target); return result;
  }
  return selectedContext(tx, scope, target);
}

function checkRef(current: BusinessObjectContextV2, ref: GoalResourceRefV2): void {
  if (current.sourceRef.streamVersion !== ref.streamVersion || !ref.digest || current.sourceRef.digest !== ref.digest)
    fail("GOAL_RESOURCE_CHANGED", "业务资料版本已变化");
}

export function assertBusinessContextRef(tx: KernelTransaction, scope: ReaderScope, ref: GoalResourceRefV2): void {
  readBusinessContext(tx, scope, ref);
}

/** This validates dependencies; the caller still checks the current reader or execution authority. */
export function validateBusinessContextSource(tx: KernelTransaction, scope: SourceScope, ref: GoalResourceRefV2): boolean {
  if (!isBusinessContextRef(ref)) return false;
  checkRef(selectedContext(tx, scope, { kind: ref.namespace.slice(prefix.length) as BusinessContextTargetV2["kind"], resourceId: ref.resourceId }), ref);
  return true;
}
