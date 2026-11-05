// SPDX-License-Identifier: Apache-2.0
import type { EnterpriseContractTypes } from '@mn/contracts';
import { parseEnterpriseContract } from '@mn/contracts/enterprise-client';
import { buildBusinessCommand, commandDefinition, type BusinessCommand } from './business-command-model.js';
import { EnterpriseApiFailure, type EnterpriseBrowserClient } from './client.js';
import { WorkspaceResource, type ResourceSnapshot } from './workspace-resource.js';

export interface CustomerCreationDraft { readonly tenantId: string; readonly workspaceId: string; readonly recordId: string; readonly name: string; }
interface CustomerCreationChoices {
  readonly draft: CustomerCreationDraft;
  readonly choices: EnterpriseContractTypes['EnterpriseCustomerCreationDepartments'];
  readonly sessionKey: string;
}
export interface CustomerCreationSnapshot extends ResourceSnapshot<CustomerCreationChoices> { readonly selectedDepartmentId?: string; }
export function customerCreationScope(draft: CustomerCreationDraft): string { return JSON.stringify([draft.tenantId, draft.workspaceId, draft.recordId, draft.name]); }

export class CustomerCreationModel {
  private readonly resource = new WorkspaceResource<CustomerCreationChoices>();
  private value: CustomerCreationSnapshot = { status: 'idle' };
  private readonly listeners = new Set<() => void>();
  readonly snapshot = (): CustomerCreationSnapshot => this.value;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  constructor(private readonly api: EnterpriseBrowserClient) { this.resource.subscribe(() => this.publish(this.resource.snapshot())); }
  private publish(value: CustomerCreationSnapshot): void { this.value = value; for (const listener of this.listeners) listener(); }
  private sessionKey(): string {
    const session = this.api.session;
    return JSON.stringify([session?.tenantId, session?.principalId, session?.csrfToken]);
  }
  clear(): void { this.resource.clear(); }
  load(draft: CustomerCreationDraft): Promise<void> {
    const current = { ...draft };
    if (!current.name.trim()) { this.clear(); return Promise.resolve(); }
    return this.resource.load(customerCreationScope(current), async signal => {
      if (this.api.session?.tenantId !== current.tenantId) throw new EnterpriseApiFailure({ status: 403, code: 'OBJECT_SCOPE_MISMATCH' });
      const sessionKey = this.sessionKey();
      const query = parseEnterpriseContract('EnterpriseCustomerCreationQuery', { type: 'customer.create', id: current.recordId, name: current.name });
      const choices = await this.api.query('queryEnterpriseCustomerCreationDepartments', { path: { workspaceId: current.workspaceId }, body: query }, signal);
      if (sessionKey !== this.sessionKey()) throw new EnterpriseApiFailure({ status: 0, code: 'STALE_RESPONSE' });
      return { draft: current, choices, sessionKey };
    });
  }
  private current(draft: CustomerCreationDraft): CustomerCreationChoices {
    if (!draft.name.trim()) throw new Error('请填写客户名称');
    const value = this.value;
    if (value.status !== 'ready' || !value.data || value.workspaceId !== customerCreationScope(draft) || value.data.sessionKey !== this.sessionKey()) throw new Error('请重新核对当前客户的归属部门');
    return value.data;
  }
  selectDepartment(departmentId: string | undefined): void {
    const data = this.value.data;
    if (!data) throw new Error('请先核对当前客户的归属部门');
    const { choices } = this.current(data.draft);
    if (departmentId !== undefined && !choices.departments.some(item => item.id === departmentId)) throw new Error('请选择当前允许的归属部门');
    this.publish({ ...this.value, selectedDepartmentId: departmentId });
  }
  build(draft: CustomerCreationDraft): Extract<BusinessCommand, { type: 'customer.create' }> {
    const { choices } = this.current(draft), departmentId = this.value.selectedDepartmentId;
    if (!choices.allowUnassigned && choices.departments.length === 0) throw new Error('当前账号没有新建此客户的业务权限');
    if (!departmentId && !choices.allowUnassigned) throw new Error('请选择客户的归属部门');
    if (departmentId && !choices.departments.some(item => item.id === departmentId)) throw new Error('请重新选择允许的归属部门');
    const definition = commandDefinition('customer.create');
    if (!definition) throw new Error('新建客户尚未接入');
    const command = buildBusinessCommand(definition, { name: draft.name, ...(departmentId ? { departmentId } : {}) }, draft);
    if (command.type !== 'customer.create') throw new Error('新建客户契约不可用');
    return command;
  }
}
