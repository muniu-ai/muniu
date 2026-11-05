// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { LogOut, RefreshCw } from 'lucide-react';
import type { EnterpriseContractTypes } from '@mn/contracts';
import { EnterpriseApiFailure, EnterpriseBrowserClient, type EnterpriseSession } from './client.js';
import { EmptyState, ErrorNotice, LoadingState, PageHeading, Status, UiActivityContext, useResource } from './components.js';
import { WorkspaceNavigation, type Page } from './navigation.js';
import { WorkspaceRouter } from './navigation-state.js';
import { BusinessPage, type Workspace } from './business-page.js';
import { KnowledgePage, type DownloadFile } from './knowledge-page.js';
import { ConnectionsPage, OrganizationPage, UsagePage, WorkflowsPage } from './management-page.js';
import { objectTitle } from './business-fields.js';
import { useMutation } from './use-mutation.js';
import { SubmissionProvider } from './submission-ui.js';

function Brand({ logo }: { logo: string }) { return <div className="mn-brand"><span className="mn-brand-image"><img src={logo} alt="木牛" /></span><div><span className="mn-brand-mark">木牛</span><span className="mn-brand-description">企业经营工作台</span></div></div>; }
export function EnterpriseApp({ origin, brandLogoUrl, download }: { origin: string; brandLogoUrl: string; download: DownloadFile }) {
  const [session, setSession] = useState<EnterpriseSession>(), [started, setStarted] = useState(false), [error, setError] = useState<unknown>(), [pending, setPending] = useState(0);
  const [api] = useState(() => new EnterpriseBrowserClient({ origin, onSessionInvalid: () => { setSession(undefined); setStarted(true); setError(undefined); }, fetch: async (input, init) => {
    const active = init?.method === 'POST'; if (active) setPending(value => value + 1);
    try { return await globalThis.fetch(input, init); } finally { if (active) setPending(value => Math.max(0, value - 1)); }
  } }));
  const load = useCallback(async (signal?: AbortSignal) => {
    try { const next = await api.loadSession(signal); setSession(next); setError(undefined); }
    catch (cause) { if (signal?.aborted || cause instanceof EnterpriseApiFailure && cause.code === 'STALE_RESPONSE') return; if (cause instanceof EnterpriseApiFailure && cause.status === 401) { setSession(undefined); setError(undefined); } else setError(cause); }
    finally { if (!signal?.aborted) setStarted(true); }
  }, [api]);
  useEffect(() => {
    const controller = new AbortController(); void load(controller.signal);
    const refresh = () => { if (document.visibilityState === 'visible') void load(controller.signal); };
    const interval = window.setInterval(refresh, 60000); window.addEventListener('focus', refresh);
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener('focus', refresh); };
  }, [load]);
  const logout = async () => { setError(undefined); try { await api.logout(); } catch (cause) { setError(cause); } };
  return <UiActivityContext.Provider value={pending > 0}>{!started ? <LoadingState /> : session ? session.status === 'invited'
    ? <SubmissionProvider key={session.csrfToken} scope="企业邀请"><InvitationAcceptance api={api} session={session} logo={brandLogoUrl} onAccepted={() => void load()} onLogout={() => void logout()} /></SubmissionProvider>
    : <AuthenticatedWorkspace key={session.tenantId + ':' + session.principalId + ':' + session.csrfToken} api={api} session={session} logo={brandLogoUrl} download={download} pending={pending > 0} error={error} onLogout={() => void logout()} />
    : <LoginPage api={api} logo={brandLogoUrl} error={error} onRetry={() => void load()} />}</UiActivityContext.Provider>;
}
function LoginPage({ api, logo, error, onRetry }: { api: EnterpriseBrowserClient; logo: string; error: unknown; onRetry: () => void }) {
  const state = useResource('public', 'login-directory', async signal => ({ directory: await api.query('listEnterpriseLoginOrganizations', {}, signal), health: await api.query('enterpriseHealth', {}, signal) }));
  const explicitOrganization = new URLSearchParams(window.location.search).get('organizationId');
  const login = (organizationId: string) => { const url = new URL(api.loginUrl(organizationId)); if (window.location.hash.startsWith('#invitation?')) url.searchParams.set('returnTo', '/' + window.location.hash); return url.href; };
  return <main className="mn-login"><aside className="mn-login-aside"><Brand logo={logo} /><div className="mn-login-statement"><h1>从客户需求<br />到交付与回款</h1><p>围绕真实业务记录，安排工作、明确责任、核对结果。</p><ul className="mn-login-lines"><li>客户与销售</li><li>项目与交付</li><li>资金与复盘</li></ul></div><p className="mn-small">每项业务决定都保留来源与确认记录。</p></aside><section className="mn-login-main"><div className="mn-login-form"><h2>登录企业工作台</h2><p className="mn-muted">使用企业已有的登录账号继续。</p>
    {state.data?.health.profile === 'development' && <p className="mn-inline-note">开发验证环境</p>}{error !== undefined && <ErrorNotice error={error} onRetry={onRetry} />}
    {state.status === 'loading' && <LoadingState />}{state.status === 'error' && <ErrorNotice error={state.error} onRetry={state.reload} />}
    {state.data && (state.data.directory.organizations.length ? state.data.directory.organizations.map(organization => <a className="mn-login-choice" href={login(organization.id)} key={organization.id}>{organization.name}<span className="mn-table-secondary">通过企业登录服务验证身份</span></a>) : <><p className="mn-inline-note">请使用管理员提供的企业登录入口。</p>{explicitOrganization && explicitOrganization.length <= 200 && <a className="mn-button" href={login(explicitOrganization)}>使用企业登录入口</a>}</>)}
    <p className="mn-login-foot">企业身份由管理员开通并绑定。登录后仍按实际业务权限访问记录。</p>
  </div></section></main>;
}
function AuthenticatedWorkspace({ api, session, logo, download, pending, error, onLogout }: { api: EnterpriseBrowserClient; session: EnterpriseSession; logo: string; download: DownloadFile; pending: boolean; error: unknown; onLogout: () => void }) {
  const [router] = useState(() => new WorkspaceRouter({ read: () => window.location.hash, write: hash => { window.location.hash = hash; }, subscribe: listener => { window.addEventListener('hashchange', listener); return () => window.removeEventListener('hashchange', listener); } }));
  const route = useSyncExternalStore(router.subscribe, router.snapshot, router.snapshot), page = route.page;
  const [workspaceId, setWorkspaceId] = useState('');
  const state = useResource(session.tenantId, 'workspace-start', async signal => ({ organizations: await api.query('listOrganizations', {}, signal), workspaces: await api.query('listEnterpriseWorkspaces', {}, signal) }), false);
  const navigate = (next: Page, objectType?: string) => { if (!pending) router.navigate(next, objectType); };
  const workspace = state.data?.workspaces.find(item => item.id === workspaceId) ?? state.data?.workspaces[0];
  const organization = state.data?.organizations[0];
  return <SubmissionProvider scope={workspace?.name ?? organization?.name ?? '企业初始化'}><div className="mn-app"><aside className="mn-sidebar"><Brand logo={logo} /><WorkspaceNavigation active={page} onNavigate={navigate} organizationAdmin={session.organizationAdmin} disabled={pending} /><div className="mn-sidebar-footer">以当前业务事实为准<br />人民币 · 北京时间</div></aside><main className="mn-main"><header className="mn-topbar"><div className="mn-workspace-switch"><div><div className="mn-organization">{organization?.name ?? '企业工作台'}</div>{workspace ? <select aria-label="当前经营主体" value={workspace.id} disabled={pending || state.data!.workspaces.length < 2} onChange={event => setWorkspaceId(event.target.value)}>{state.data!.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : <strong>经营主体初始化</strong>}</div></div><div className="mn-person">{session.profile === 'development' && <span className="mn-tag mn-tag-wait">开发验证环境</span>}{pending && <span role="status" className="mn-muted">正在处理…</span>}<span>{session.displayName}</span><button type="button" className="mn-icon-button" aria-label="退出登录" disabled={pending} onClick={onLogout}><LogOut size={17} aria-hidden="true" /></button></div></header>
    <div className="mn-content">{error !== undefined && <ErrorNotice error={error} />}{state.status === 'loading' && <LoadingState />}{state.status === 'error' && <ErrorNotice error={state.error} onRetry={state.reload} />}
      {state.data && (!workspace ? <WorkspaceSetup api={api} administrator={session.organizationAdmin} organizationName={organization?.name ?? '当前企业'} onSaved={state.reload} /> : <div key={workspace.id + ':' + page + ':' + (route.objectType ?? '')}>
        {page === 'overview' && <OverviewPage api={api} workspace={workspace} onNavigate={navigate} />}
        {page === 'attention' && <><PageHeading title="待我处理" description="需要人员明确决定的事项集中在这里。" /><section className="mn-panel"><EmptyState title="集中待办入口尚未接入" detail="目前可在具体业务记录详情中办理已支持的业务批准。Agent 计划、执行批准和未知动作核对将在后续阶段接入。" unavailable action={<button className="mn-button-secondary" onClick={() => navigate('sales')}>查看业务记录</button>} /></section></>}
        {(page === 'sales' || page === 'delivery' || page === 'finance') && <BusinessPage api={api} workspace={workspace} group={page} selectedType={route.objectType} onTypeChange={type => navigate(page, type)} />}
        {page === 'knowledge' && <KnowledgePage api={api} workspace={workspace} download={download} />}
        {['organization', 'workflows', 'connections', 'usage'].includes(page) && !session.organizationAdmin && <EmptyState title="需要组织管理权限" detail="请联系企业管理员核对管理职责。" unavailable />}
        {session.organizationAdmin && page === 'organization' && <OrganizationPage api={api} workspace={workspace} />}{session.organizationAdmin && page === 'workflows' && <WorkflowsPage api={api} workspace={workspace} />}{session.organizationAdmin && page === 'connections' && <ConnectionsPage api={api} workspace={workspace} />}{session.organizationAdmin && page === 'usage' && <UsagePage api={api} workspace={workspace} />}
      </div>)}
    </div></main></div></SubmissionProvider>;
}
function WorkspaceSetup({ api, administrator, organizationName, onSaved }: { api: EnterpriseBrowserClient; administrator: boolean; organizationName: string; onSaved: () => void }) {
  const [name, setName] = useState(''), mutation = useMutation(api, 'createEnterpriseWorkspace', onSaved);
  if (!administrator) return <EmptyState title="经营主体尚未建立" detail="请由企业管理员完成初始化后继续。" />;
  return <><PageHeading title="建立经营主体" description={organizationName + ' 已完成企业身份开通。请选择本次业务数据的经营主体。'} /><section className="mn-panel"><div className="mn-panel-body"><form className="mn-form" onSubmit={event => { event.preventDefault(); void mutation.submit({ body: { name: name.trim(), mode: 'builtin' } }); }}>{mutation.error !== undefined && <ErrorNotice error={mutation.error} />}<fieldset className="mn-form-fields" disabled={mutation.busy || mutation.uncertain}><label>经营主体名称<input required maxLength={200} value={name} onChange={event => setName(event.target.value)} placeholder="填写实际经营主体名称" /></label><fieldset className="mn-fieldset"><legend>经营管理方式</legend><label className="mn-checkbox"><input type="radio" name="mode" value="builtin" checked readOnly />内置经营管理</label><p className="mn-small mn-muted">客户、项目和收支由木牛统一管理。创建后管理方式固定。</p><label className="mn-checkbox"><input type="radio" name="mode" value="sales" disabled />连接木牛 Sales（当前尚未接入）</label></fieldset></fieldset><div className="mn-form-footer"><button className="mn-button" disabled={mutation.busy}>{mutation.busy ? '正在建立…' : mutation.uncertain ? '重试原请求' : '建立经营主体'}</button></div></form></div></section><p className="mn-small mn-muted">建立后请在“组织与权限”中授予实际业务权限。没有模型或额度时仍可管理业务记录。</p></>;
}
function OverviewPage({ api, workspace, onNavigate }: { api: EnterpriseBrowserClient; workspace: Workspace; onNavigate: (page: Page, objectType?: string) => void }) {
  return <><PageHeading title="经营总览" description={workspace.name + ' 的当前业务记录。每个条目均来自当前账号有权访问的数据。'} /><OverviewSection api={api} workspace={workspace} objectType="operating_objective" title="经营目标" onOpen={() => onNavigate('finance', 'operating_objective')} /><OverviewSection api={api} workspace={workspace} objectType="project" title="项目记录" onOpen={() => onNavigate('delivery', 'project')} /><OverviewSection api={api} workspace={workspace} objectType="payment_schedule" title="付款安排" onOpen={() => onNavigate('finance', 'payment_schedule')} /></>;
}
function OverviewSection({ api, workspace, objectType, title, onOpen }: { api: EnterpriseBrowserClient; workspace: Workspace; objectType: string; title: string; onOpen: () => void }) {
  const state = useResource(workspace.id, 'overview:' + objectType, signal => api.query('listBusinessObjects', { path: { workspaceId: workspace.id, objectType } }, signal));
  return <section className="mn-panel"><div className="mn-panel-heading"><h2>{title}</h2><button type="button" className="mn-link-button" onClick={onOpen}>查看台账</button></div>{state.status === 'loading' && <LoadingState />}{state.status === 'error' && <div className="mn-panel-body"><ErrorNotice error={state.error} onRetry={state.reload} /></div>}{state.data && (state.data.length ? <ul className="mn-list">{state.data.slice(0, 6).map(item => <li className="mn-list-row" key={item.reference.objectId}><div><h3>{objectTitle(item)}</h3><p>第 {item.reference.streamVersion} 版</p></div><Status value={item.values.status} /></li>)}</ul> : <EmptyState title="暂无可见记录" detail="这里只展示当前账号获准查看的业务记录。" />)}</section>;
}
function InvitationAcceptance({ api, session, logo, onAccepted, onLogout }: { api: EnterpriseBrowserClient; session: EnterpriseSession; logo: string; onAccepted: () => void; onLogout: () => void }) {
  const [link, setLink] = useState(() => window.location.hash.startsWith('#invitation?') ? window.location.href : ''), [localError, setError] = useState<unknown>();
  const mutation = useMutation(api, 'acceptOrganizationInvitation', onAccepted);
  useEffect(() => { if (window.location.hash.startsWith('#invitation?')) window.history.replaceState(null, '', '/'); }, []);
  const accept = () => {
    try {
      const url = new URL(link), input = new URLSearchParams(url.hash.replace(/^#invitation\?/u, ''));
      const memberId = input.get('memberId'), organizationId = input.get('organizationId'), token = input.get('token'), version = Number(input.get('version'));
      if (url.origin !== api.origin || !url.hash.startsWith('#invitation?') || memberId !== session.principalId || organizationId !== session.tenantId || !token || token.length > 200 || !Number.isSafeInteger(version) || version < 1) throw new Error('邀请链接与当前企业账号不匹配，请使用管理员提供给本人的完整链接');
      setError(undefined); void mutation.submit({ path: { organizationId, memberId }, body: { expectedStreamVersion: version, token } });
    } catch (cause) { setError(cause); }
  };
  return <main className="mn-login"><aside className="mn-login-aside"><Brand logo={logo} /><div className="mn-login-statement"><h1>接受企业邀请</h1><p>完成本人确认后，按企业管理员授予的权限进入工作台。</p></div></aside><section className="mn-login-main"><form className="mn-login-form mn-form" onSubmit={event => { event.preventDefault(); accept(); }}><h2>{session.displayName}，确认加入企业</h2>{(localError ?? mutation.error) !== undefined && <ErrorNotice error={localError ?? mutation.error} />}<label>管理员提供的完整邀请链接<textarea required value={link} disabled={mutation.busy || mutation.uncertain} onChange={event => setLink(event.target.value)} /></label><button className="mn-button" disabled={mutation.busy}>{mutation.uncertain ? '重试原请求' : '接受企业邀请'}</button><button type="button" className="mn-button-secondary" disabled={mutation.busy} onClick={onLogout}>退出当前账号</button></form></section></main>;
}
