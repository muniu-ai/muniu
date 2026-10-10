// SPDX-License-Identifier: Apache-2.0
import { businessDateAt, parseBusinessCommand, parseBusinessPeriod, type BusinessManagementViewV1, type BusinessPeriodV1, type BusinessStateV1,
  type Principal, type Workspace, type WorkspaceMembership } from "@mn/contracts";
import { appendKernelEvent, KernelError, sha256, type KernelStore, type KernelTransaction } from "@mn/kernel";
import { applyBusinessCommand, calculateBusinessSummary, createEmptyBusiness } from "@mn/plugin-opc";

export const OPC_BUSINESS_NAMESPACE = "opc.business";
interface BusinessScope {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
}
interface BusinessOptions extends BusinessScope {
  readonly store: KernelStore;
  readonly now: () => string;
}

export function assertBusinessAccess(tx: KernelTransaction, scope: BusinessScope, write: boolean): void {
  const workspace = tx.getProjection<Workspace>("workspace", scope.workspaceId);
  const member = tx.getProjection<WorkspaceMembership>("membership", `${scope.workspaceId}:${scope.principalId}`);
  const principal = tx.getProjection<Principal>("principal", scope.principalId);
  if (!workspace || workspace.tenantId !== scope.tenantId) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "重新选择工作区");
  if (!principal || principal.tenantId !== scope.tenantId || principal.disabledAt || !member || member.removedAt
    || !(write ? ["owner", "operator"] : ["owner", "operator", "reviewer", "viewer"]).includes(member.workspaceRole))
    throw new KernelError("WORKSPACE_ACCESS_DENIED", "无权访问经营台账", "联系工作区所有者授予权限");
  if (write && principal.kind !== "human") throw new KernelError("BUSINESS_FACT_ACCESS_DENIED", "经营事实必须由人员登记", "由有权限的人员核对并确认");
  if (!workspace.activePluginIds.includes("opc")) throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用 OPC", "先启用 OPC 经营管理");
}

export function businessPeriod(start: string | null, end: string | null, timestamp: string): BusinessPeriodV1 {
  if ((start === null) !== (end === null)) throw new KernelError("INVALID_BODY", "统计起止日期必须一起提供", "同时填写 periodStart 和 periodEnd");
  const today = businessDateAt(timestamp);
  const period = parseBusinessPeriod({ start: start ?? "0001-01-01", end: end ?? today });
  if (period.end > today) throw new KernelError("BUSINESS_DATE_INVALID", "统计结束日期不能晚于今天", "选择已经发生的统计期间");
  return period;
}

function current(tx: KernelTransaction, workspaceId: string): BusinessStateV1 {
  const state = tx.getProjection<BusinessStateV1>(OPC_BUSINESS_NAMESPACE, workspaceId) ?? createEmptyBusiness(workspaceId);
  if (state.workspaceId !== workspaceId) throw new KernelError("BUSINESS_SCOPE_MISMATCH", "经营台账作用域无效", "核对受保护经营状态");
  return state;
}

export async function readOpcBusiness(options: BusinessOptions, period: BusinessPeriodV1): Promise<BusinessManagementViewV1> {
  return options.store.transact(options.tenantId, tx => {
    assertBusinessAccess(tx, options, false);
    const state = current(tx, options.workspaceId);
    return { state, summary: calculateBusinessSummary(state, period) };
  });
}

export async function commandOpcBusiness(options: BusinessOptions & {
  readonly expectedStreamVersion: number;
  readonly command: unknown;
  readonly idempotencyKey: string;
}): Promise<BusinessManagementViewV1> {
  const command = parseBusinessCommand(options.command);
  const requestDigest = sha256({ workspaceId: options.workspaceId, principalId: options.principalId,
    expectedStreamVersion: options.expectedStreamVersion, command });
  const scope = `opc.business:${options.workspaceId}`;
  return options.store.transact(options.tenantId, tx => {
    assertBusinessAccess(tx, options, true);
    const previous = tx.getIdempotency(scope, options.idempotencyKey);
    if (previous) {
      if (previous.requestDigest !== requestDigest) throw new KernelError("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同经营命令", "使用新的 Idempotency-Key");
      return previous.response as BusinessManagementViewV1;
    }
    const state = current(tx, options.workspaceId);
    if (state.streamVersion !== options.expectedStreamVersion)
      throw new KernelError("STREAM_VERSION_CONFLICT", "经营台账版本已变化", "重新读取台账并核对命令", true);
    const timestamp = options.now();
    const next = applyBusinessCommand(state, command, { principalId: options.principalId, occurredAt: timestamp });
    const response = { state: next, summary: calculateBusinessSummary(next, businessPeriod(null, null, timestamp)) };
    tx.putProjection(OPC_BUSINESS_NAMESPACE, options.workspaceId, next);
    appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: OPC_BUSINESS_NAMESPACE, aggregateId: options.workspaceId,
      expectedStreamVersion: state.streamVersion, type: `opc.business.${command.type}`, actorId: options.principalId,
      generation: 0, correlationId: sha256([scope, options.idempotencyKey]), publicPayload: { workspaceId: options.workspaceId, command: command.type } });
    tx.putIdempotency({ tenantId: options.tenantId, scope, key: options.idempotencyKey, requestDigest, response, createdAt: timestamp });
    return response;
  });
}
