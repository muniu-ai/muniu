// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { EnterpriseContractTypes } from '@mn/contracts';
import type { EnterpriseBrowserClient, MutationTicket } from './client.js';
import { EnterpriseApiFailure } from './client.js';
import { Dialog, EmptyState, ErrorNotice, LoadingState, PageHeading, Status, useResource } from './components.js';
import { OBJECT_LABELS, objectTitle } from './business-fields.js';
import { formatDate } from './format.js';
import { useMutation } from './use-mutation.js';
import type { BusinessView, Workspace } from './business-page.js';
import { submissionError, useSubmission } from './submission-ui.js';

const roles = [{ value: 'sales', label: '销售' }, { value: 'sales_manager', label: '销售经理' }, { value: 'project_owner', label: '项目负责人' }, { value: 'finance', label: '财务' }, { value: 'auditor', label: '审计' }] as const;
const operations = [{ value: 'read', label: '读取业务记录' }, { value: 'draft', label: '准备草稿' }, { value: 'write', label: '修改业务记录' }, { value: 'business_approve', label: '批准业务事实' }, { value: 'execution_approve', label: '批准系统执行' }, { value: 'audit', label: '审计读取' }] as const;
const fields = [{ value: 'public', label: '一般业务字段' }, { value: 'price', label: '价格与回款' }, { value: 'cost', label: '成本' }, { value: 'contact', label: '联系方式' }] as const;
type Member = EnterpriseContractTypes['OrganizationMemberView'];
type RoleGrant = EnterpriseContractTypes['BusinessRoleGrantView'];
type Access = EnterpriseContractTypes['EnterpriseAccessConfiguration'];
type Scope = EnterpriseContractTypes['BusinessAccessScope'];
type Operation = typeof operations[number]['value'];
type FieldClass = typeof fields[number]['value'];

export function OrganizationPage({ api, workspace }: { api: EnterpriseBrowserClient; workspace: Workspace }) {
  const state = useResource(workspace.id, 'organization', async signal => {
    const members = await api.query('listOrganizationMembers', { path: { organizationId: workspace.tenantId } }, signal), access = await api.query('getAccessConfiguration', { path: { workspaceId: workspace.id } }, signal);
    return { members, access };
  });
  const [dialog, setDialog] = useState<'invite' | 'role' | 'department'>(), [member, setMember] = useState<Member>(), [revoke, setRevoke] = useState<RoleGrant>();
  const done = () => { setDialog(undefined); setMember(undefined); setRevoke(undefined); state.reload(); };
  return <><PageHeading title="组织与权限" description="组织管理员管理成员与授权；业务读取、制单和批准权限单独授予。" action={<button className="mn-button-secondary" onClick={state.reload}><RefreshCw size={15} aria-hidden="true" />重新载入</button>} />
    {state.status === 'loading' && <LoadingState />}{state.status === 'error' && <ErrorNotice error={state.error} onRetry={state.reload} />}
    {state.data && <><section className="mn-panel"><div className="mn-toolbar"><h2>企业成员</h2><button className="mn-button" onClick={() => setDialog('invite')}><Plus size={15} aria-hidden="true" />邀请成员</button></div><div className="mn-table-wrap"><table className="mn-table"><thead><tr><th>成员</th><th>身份</th><th>当前状态</th><th>操作</th></tr></thead><tbody>{state.data.members.map(item => <tr key={item.id}><td>{item.displayName}</td><td>{item.organizationAdmin ? '组织管理员' : '企业成员'}</td><td><Status value={item.status} /></td><td><button type="button" className="mn-link-button" onClick={() => setMember(item)}>管理成员状态</button></td></tr>)}</tbody></table></div></section>
      <section className="mn-panel"><div className="mn-toolbar"><h2>业务权限</h2><button className="mn-button-secondary" onClick={() => setDialog('role')}>授予业务权限</button></div>{state.data.access.roles.length ? <div className="mn-table-wrap"><table className="mn-table"><thead><tr><th>成员</th><th>业务角色</th><th>对象范围</th><th>有效期</th><th>操作</th></tr></thead><tbody>{state.data.access.roles.map(grant => <tr key={grant.id}><td>{state.data!.members.find(item => item.id === grant.principalId)?.displayName ?? '企业成员'}</td><td>{roles.find(role => role.value === grant.role)?.label}</td><td>{({ owned: '本人负责记录', workspace: '当前经营主体', department: '指定部门', objects: '指定业务记录' } as const)[grant.scope.kind]}</td><td>{grant.revokedAt ? '已撤销' : formatDate(grant.expiresAt)}</td><td>{!grant.revokedAt && <button className="mn-link-button" onClick={() => setRevoke(grant)}>撤销权限</button>}</td></tr>)}</tbody></table></div> : <EmptyState title="尚未授予业务角色" detail="为成员明确选择对象范围、可操作事项和可见字段。" />}</section>
      <section className="mn-panel"><div className="mn-toolbar"><h2>部门</h2><button className="mn-button-secondary" onClick={() => setDialog('department')}>添加部门</button></div>{state.data.access.departments.length ? <ul className="mn-list">{state.data.access.departments.map(item => <li className="mn-list-row" key={item.id}>{item.name}{item.revokedAt && <span className="mn-tag">已撤销</span>}</li>)}</ul> : <EmptyState title="尚未设置部门" detail="需要按部门授权时，可先建立真实的企业部门。" />}</section>
      {dialog === 'invite' && <Dialog title="邀请企业成员" onClose={() => setDialog(undefined)}><InviteMember api={api} workspace={workspace} onDone={done} /></Dialog>}
      {dialog === 'role' && <Dialog title="授予业务权限" onClose={() => setDialog(undefined)}><GrantRole api={api} workspace={workspace} members={state.data.members} access={state.data.access} onDone={done} /></Dialog>}
      {dialog === 'department' && <Dialog title="添加部门" onClose={() => setDialog(undefined)}><CreateDepartment api={api} workspace={workspace} onDone={done} /></Dialog>}
      {member && <Dialog title={'管理' + member.displayName} onClose={() => setMember(undefined)}><MemberState api={api} workspace={workspace} member={member} onDone={done} /></Dialog>}
      {revoke && <Dialog title="撤销业务权限" onClose={() => setRevoke(undefined)}><RevokeRole api={api} workspace={workspace} grant={revoke} onDone={done} /></Dialog>}
    </>}
  </>;
}
function InviteMember({ api, workspace, onDone }: { api: EnterpriseBrowserClient; workspace: Workspace; onDone: () => void }) {
  const [displayName, setName] = useState(''), [subject, setSubject] = useState(''), [admin, setAdmin] = useState(false), [invitation, setInvitation] = useState<EnterpriseContractTypes['OrganizationInvitationView']>();
  const mutation = useMutation(api, 'inviteOrganizationMember', setInvitation);
  const url = new URL('/', api.origin);
  if (invitation) url.hash = 'invitation?' + new URLSearchParams({ organizationId: workspace.tenantId, memberId: invitation.member.id, version: String(invitation.member.streamVersion), token: invitation.token });
  return invitation ? <div className="mn-stack"><p className="mn-inline-note">邀请已创建。请通过可信渠道将下面的邀请链接交给本人；本人须使用已绑定的企业账号登录并接受。</p><label className="mn-small">邀请链接<input className="mn-form-input" readOnly value={url.href} onFocus={event => event.currentTarget.select()} /></label><button className="mn-button" onClick={onDone}>完成</button></div> : <form className="mn-form" onSubmit={event => { event.preventDefault(); void mutation.submit({ path: { organizationId: workspace.tenantId }, body: { subject: subject.trim(), displayName: displayName.trim(), organizationAdmin: admin } }); }}>
    {mutation.error !== undefined && <ErrorNotice error={mutation.error} />}<fieldset className="mn-form-fields" disabled={mutation.busy || mutation.uncertain}><label>成员姓名<input required maxLength={200} value={displayName} onChange={event => setName(event.target.value)} /></label><label>企业登录账号标识<input required maxLength={200} value={subject} onChange={event => setSubject(event.target.value)} /><span className="mn-form-field-note">使用企业身份服务提供的账号标识；姓名或邮箱域名不能自动授予身份。</span></label><label className="mn-checkbox"><input type="checkbox" checked={admin} onChange={event => setAdmin(event.target.checked)} />同时授予组织管理职责</label></fieldset><div className="mn-form-footer"><button className="mn-button" disabled={mutation.busy}>{mutation.busy ? '正在创建…' : mutation.uncertain ? '重试原请求' : '创建邀请'}</button></div></form>;
}
function GrantRole({ api, workspace, members, access, onDone }: { api: EnterpriseBrowserClient; workspace: Workspace; members: readonly Member[]; access: Access; onDone: () => void }) {
  const [principalId, setPrincipal] = useState(''), [role, setRole] = useState<typeof roles[number]['value']>('sales'), [scope, setScope] = useState<Scope['kind']>('owned'), [departmentId, setDepartment] = useState(''), [selected, setSelected] = useState<BusinessView>();
  const [allowedOperations, setOperations] = useState<Operation[]>(['read']), [fieldClasses, setFields] = useState<FieldClass[]>(['public']), [expires, setExpires] = useState(''), [localError, setError] = useState<unknown>();
  const mutation = useMutation(api, 'grantBusinessRole', onDone);
  const save = () => {
    try {
      if (!principalId || !allowedOperations.length || !fieldClasses.length || !expires) throw new Error('请选择成员、权限、字段和有效期');
      let range: Scope;
      if (scope === 'department') { if (!departmentId) throw new Error('请选择部门'); range = { kind: 'department', departmentId }; }
      else if (scope === 'objects') { if (!selected) throw new Error('请选择业务记录'); range = { kind: 'objects', objects: [{ objectType: selected.reference.objectType, objectId: selected.reference.objectId }] }; }
      else range = { kind: scope };
      setError(undefined); void mutation.submit({ path: { workspaceId: workspace.id }, body: { principalId, role, scope: range, operations: allowedOperations, fieldClasses, expiresAt: new Date(expires + 'T23:59:59+08:00').toISOString() } });
    } catch (cause) { setError(cause); }
  };
  return <form className="mn-form" onSubmit={event => { event.preventDefault(); save(); }}>{(localError ?? mutation.error) !== undefined && <ErrorNotice error={localError ?? mutation.error} />}<fieldset className="mn-form-fields" disabled={mutation.busy || mutation.uncertain}>
    <label>成员<select required value={principalId} onChange={event => setPrincipal(event.target.value)}><option value="">请选择成员</option>{members.filter(item => item.status !== 'removed').map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
    <div className="mn-form-grid"><label>业务角色<select value={role} onChange={event => setRole(event.target.value as typeof role)}>{roles.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label>对象范围<select value={scope} onChange={event => { setScope(event.target.value as Scope['kind']); setSelected(undefined); }}>{[{ value: 'owned', label: '本人负责记录' }, { value: 'workspace', label: '当前经营主体' }, { value: 'department', label: '指定部门' }, { value: 'objects', label: '指定业务记录' }].map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
    {scope === 'department' && <label>部门<select value={departmentId} required onChange={event => setDepartment(event.target.value)}><option value="">请选择部门</option>{access.departments.filter(item => !item.revokedAt).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {scope === 'objects' && <ObjectScope api={api} workspace={workspace} onSelect={setSelected} />}
    <fieldset className="mn-fieldset"><legend>允许的操作</legend>{operations.map(item => <label className="mn-checkbox" key={item.value}><input type="checkbox" checked={allowedOperations.includes(item.value)} onChange={event => setOperations(value => event.target.checked ? [...value, item.value] : value.filter(entry => entry !== item.value))} />{item.label}</label>)}</fieldset>
    <fieldset className="mn-fieldset"><legend>允许的字段</legend>{fields.map(item => <label className="mn-checkbox" key={item.value}><input type="checkbox" checked={fieldClasses.includes(item.value)} onChange={event => setFields(value => event.target.checked ? [...value, item.value] : value.filter(entry => entry !== item.value))} />{item.label}</label>)}</fieldset>
    <label>有效期至<input type="date" required value={expires} onChange={event => setExpires(event.target.value)} /></label></fieldset><div className="mn-form-footer"><button className="mn-button" disabled={mutation.busy}>{mutation.busy ? '正在保存…' : mutation.uncertain ? '重试原请求' : '授予业务权限'}</button></div></form>;
}
function ObjectScope({ api, workspace, onSelect }: { api: EnterpriseBrowserClient; workspace: Workspace; onSelect: (object: BusinessView | undefined) => void }) {
  const [type, setType] = useState('customer'), [selected, setSelected] = useState('');
  const records = useResource(workspace.id, 'grant-objects:' + type, signal => api.query('listBusinessObjects', { path: { workspaceId: workspace.id, objectType: type } }, signal));
  return <div className="mn-form-grid"><label>业务类型<select value={type} onChange={event => { setType(event.target.value); setSelected(''); onSelect(undefined); }}>{['customer', 'opportunity', 'order', 'project'].map(item => <option key={item} value={item}>{OBJECT_LABELS[item]}</option>)}</select></label><label>业务记录<select value={selected} required onChange={event => { setSelected(event.target.value); onSelect(records.data?.find(item => item.reference.objectId === event.target.value)); }}><option value="">请选择有权查看的记录</option>{records.data?.map(item => <option key={item.reference.objectId} value={item.reference.objectId}>{objectTitle(item)}</option>)}</select></label>{records.status === 'error' && <ErrorNotice error={records.error} onRetry={records.reload} />}</div>;
}
function CreateDepartment({ api, workspace, onDone }: { api: EnterpriseBrowserClient; workspace: Workspace; onDone: () => void }) {
  const [name, setName] = useState(''), mutation = useMutation(api, 'createDepartment', onDone);
  return <form className="mn-form" onSubmit={event => { event.preventDefault(); void mutation.submit({ path: { workspaceId: workspace.id }, body: { name: name.trim() } }); }}>{mutation.error !== undefined && <ErrorNotice error={mutation.error} />}<label>部门名称<input required maxLength={200} value={name} disabled={mutation.busy || mutation.uncertain} onChange={event => setName(event.target.value)} /></label><div className="mn-form-footer"><button className="mn-button" disabled={mutation.busy}>{mutation.uncertain ? '重试原请求' : '添加部门'}</button></div></form>;
}
function MemberState({ api, workspace, member, onDone }: { api: EnterpriseBrowserClient; workspace: Workspace; member: Member; onDone: () => void }) {
  const [command, setCommand] = useState<'disable' | 'activate' | 'remove'>(member.status === 'disabled' ? 'activate' : 'disable'), [confirmed, setConfirmed] = useState(false), mutation = useMutation(api, 'commandOrganizationMember', onDone);
  return <form className="mn-form" onSubmit={event => { event.preventDefault(); if (confirmed) void mutation.submit({ path: { organizationId: workspace.tenantId, memberId: member.id }, body: { type: command, expectedStreamVersion: member.streamVersion } }); }}>{mutation.error !== undefined && <ErrorNotice error={mutation.error} />}<p className="mn-inline-note">停用或移除成员会使其当前登录失效。系统会重新核对管理员资格及最后一位有效管理员限制。</p><label>成员操作<select value={command} disabled={mutation.busy || mutation.uncertain} onChange={event => setCommand(event.target.value as typeof command)}><option value="disable">停用成员</option><option value="activate">恢复成员</option><option value="remove">移除成员</option></select></label><label className="mn-checkbox"><input required type="checkbox" checked={confirmed} disabled={mutation.busy || mutation.uncertain} onChange={event => setConfirmed(event.target.checked)} />确认对 {member.displayName} 提交这次变更</label><div className="mn-form-footer"><button className="mn-button-danger" disabled={mutation.busy}>{mutation.uncertain ? '重试原请求' : '确认变更'}</button></div></form>;
}
function RevokeRole({ api, workspace, grant, onDone }: { api: EnterpriseBrowserClient; workspace: Workspace; grant: RoleGrant; onDone: () => void }) {
  const [confirmed, setConfirmed] = useState(false), mutation = useMutation(api, 'revokeBusinessRole', onDone);
  return <form className="mn-form" onSubmit={event => { event.preventDefault(); if (confirmed) void mutation.submit({ path: { workspaceId: workspace.id, grantId: grant.id }, body: { expectedStreamVersion: grant.streamVersion } }); }}>{mutation.error !== undefined && <ErrorNotice error={mutation.error} />}<p>撤销后，后续读取与执行会重新检查该成员剩余权限。</p><label className="mn-checkbox"><input required type="checkbox" checked={confirmed} disabled={mutation.busy || mutation.uncertain} onChange={event => setConfirmed(event.target.checked)} />确认撤销这项业务授权</label><div className="mn-form-footer"><button className="mn-button-danger" disabled={mutation.busy}>{mutation.uncertain ? '重试原请求' : '撤销权限'}</button></div></form>;
}

export function WorkflowsPage({ api, workspace }: { api: EnterpriseBrowserClient; workspace: Workspace }) {
  const state = useResource(workspace.id, 'workflows', signal => api.query('listEnterpriseWorkflows', { path: { workspaceId: workspace.id } }, signal));
  return <><PageHeading title="Agent 与流程" description="流程是经过版本管理的工作起点，不会自动取得同名人员的业务权限。" />{state.status === 'loading' && <LoadingState />}{state.status === 'error' && <ErrorNotice error={state.error} onRetry={state.reload} />}{state.data && <section className="mn-panel">{state.data.builtins.map(definition => <WorkflowItem key={definition.flowId} api={api} workspace={workspace} definition={definition} state={state.data!.states.find(item => item.flowId === definition.flowId)} onSaved={state.reload} />)}</section>}<p className="mn-small mn-muted">启用流程定义不会创建或执行工作。具体工作仍需负责人授权，计划与执行批准入口由后续工作台提供。</p></>;
}
function WorkflowItem({ api, workspace, definition, state, onSaved }: { api: EnterpriseBrowserClient; workspace: Workspace; definition: EnterpriseContractTypes['EnterpriseWorkflowDefinition']; state?: EnterpriseContractTypes['EnterpriseWorkflowState']; onSaved: () => void }) {
  const [publishTicket, setPublishTicket] = useState<MutationTicket<'publishEnterpriseWorkflow'>>(), [selectTicket, setSelectTicket] = useState<MutationTicket<'selectEnterpriseWorkflow'>>(), [published, setPublished] = useState<EnterpriseContractTypes['EnterpriseWorkflowState']>();
  const [error, setError] = useState<unknown>(), submission = useSubmission('启用流程'), { busy } = submission;
  const enable = async () => {
    if (submission.chain.snapshot().busy) return;
    setError(undefined);
    try {
      await submission.run(async scope => {
        let selected = selectTicket;
        if (!selected) {
          let version = published;
          if (!version) { const ticket = publishTicket ?? api.prepareMutation('publishEnterpriseWorkflow', { path: { workspaceId: workspace.id }, body: { expectedStreamVersion: state?.streamVersion ?? 0, definition } }); setPublishTicket(ticket); version = await scope.write({ key: ticket.key, label: '流程定义', execute: signal => api.executeMutation(ticket, signal) }); setPublished(version); }
          const reference = version.versions.at(-1); if (!reference) throw new EnterpriseApiFailure({ status: 503, code: 'INVALID_SERVICE_RESPONSE' });
          selected = api.prepareMutation('selectEnterpriseWorkflow', { path: { workspaceId: workspace.id, flowId: definition.flowId }, body: { expectedStreamVersion: version.streamVersion, reference } }); setSelectTicket(selected);
        }
        return scope.write({ key: selected.key, label: '启用流程', execute: signal => api.executeMutation(selected!, signal) });
      });
      if (submission.isMounted()) onSaved();
    } catch (cause) { if (submission.isMounted()) setError(submissionError(cause, submission.chain)); }
  };
  return <div className="mn-list-row"><div><h3>{definition.title}</h3><p>{definition.acceptanceCriteria.join('；')}</p>{error !== undefined && <ErrorNotice error={error} />}</div><button className={state?.active ? 'mn-button-secondary' : 'mn-button'} disabled={busy || !!state?.active} onClick={() => void enable()}>{busy ? '正在启用…' : state?.active ? '已启用' : error ? '重试原请求' : '启用流程'}</button></div>;
}
export function ConnectionsPage({ api, workspace }: { api: EnterpriseBrowserClient; workspace: Workspace }) {
  const state = useResource(workspace.id, 'models', signal => api.query('getGoalConfiguration', { path: { workspaceId: workspace.id } }, signal));
  return <><PageHeading title="连接与模型" description="模型凭据由服务端受控配置保存，浏览器不会读取或填写密钥。" /><section className="mn-panel">{state.status === 'loading' && <LoadingState />}{state.status === 'error' && <div className="mn-panel-body"><ErrorNotice error={state.error} onRetry={state.reload} /></div>}{state.data && (state.data.models.length ? <ul className="mn-list">{state.data.models.map(model => <li className="mn-list-row" key={model.id}><div><h3>{model.modelId}</h3><p>{model.mode === 'test_fixture' ? '合成测试模型' : '已配置模型服务'}</p></div><span className="mn-tag">{model.available ? '当前可用' : '当前不可用'}</span></li>)}</ul> : <EmptyState title="尚未配置可用模型" detail="请由企业管理员通过受控配置接入模型。缺少模型时仍可管理业务记录。" />)}</section><section className="mn-panel"><EmptyState title="外部业务与企业微信连接尚未接入" detail="连接可用后再提供绑定与运行状态；当前不会显示虚构连接或测试成功结果。" unavailable /></section></>;
}
export function UsagePage({ api, workspace }: { api: EnterpriseBrowserClient; workspace: Workspace }) {
  const state = useResource(workspace.id, 'quota', signal => api.query('getQuotaConfiguration', { path: { workspaceId: workspace.id } }, signal));
  return <><PageHeading title="用量与审计" description="这里只显示服务端实际配置的额度，不将额度上限当作已发生用量。" /><section className="mn-panel">{state.status === 'loading' && <LoadingState />}{state.status === 'error' && <div className="mn-panel-body"><ErrorNotice error={state.error} onRetry={state.reload} /></div>}{state.data && (state.data.workspace ? <div className="mn-panel-body"><h2>当前经营主体额度</h2><dl className="mn-details"><dt>模型 Token 上限</dt><dd>{state.data.workspace.tokens.toLocaleString('zh-CN')}</dd><dt>费用上限</dt><dd>{state.data.workspace.costMinorUnits} 分（人民币）</dd><dt>同时运行节点上限</dt><dd>{state.data.workspace.tenantRunningNodes}</dd><dt>有效期至</dt><dd>{formatDate(state.data.workspace.expiresAt)}</dd></dl></div> : <EmptyState title="尚未配置工作区模型额度" detail="模型评估与执行需要有效额度。缺少额度时仍可管理业务记录。" />)}</section><section className="mn-panel"><EmptyState title="实际用量与审计查询尚未接入" detail="完整用量和恢复审计验收由后续工作包提供。" unavailable /></section></>;
}
