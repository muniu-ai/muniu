// SPDX-License-Identifier: Apache-2.0
import { LayoutDashboard, Inbox, UsersRound, FolderKanban, Wallet, BookOpen, Settings2, Workflow, Plug, ChartNoAxesCombined } from 'lucide-react';
export const MAIN_NAVIGATION = [
  { id: 'overview', label: '经营总览', icon: LayoutDashboard }, { id: 'attention', label: '待我处理', icon: Inbox },
  { id: 'sales', label: '客户与销售', icon: UsersRound }, { id: 'delivery', label: '项目与交付', icon: FolderKanban },
  { id: 'finance', label: '资金与复盘', icon: Wallet }, { id: 'knowledge', label: '知识与成果', icon: BookOpen },
] as const;
export type MainPage = typeof MAIN_NAVIGATION[number]['id'];
export type Page = MainPage | 'organization' | 'workflows' | 'connections' | 'usage';
const MANAGEMENT = [{ id: 'organization', label: '组织与权限', icon: Settings2 }, { id: 'workflows', label: 'Agent 与流程', icon: Workflow }, { id: 'connections', label: '连接与模型', icon: Plug }, { id: 'usage', label: '用量与审计', icon: ChartNoAxesCombined }] as const;
export function WorkspaceNavigation({ active, onNavigate, organizationAdmin, disabled = false }: { active: Page; onNavigate: (page: Page) => void; organizationAdmin: boolean; disabled?: boolean }) {
  return <><nav className="mn-nav" aria-label="主导航">{MAIN_NAVIGATION.map(({ id, label, icon: Icon }) => <button key={id} disabled={disabled} type="button" className="mn-nav-button" aria-current={active === id ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={18} aria-hidden="true" /><span>{label}</span></button>)}</nav>
    {organizationAdmin && <div className="mn-management"><p className="mn-nav-label">企业管理</p><nav className="mn-nav" aria-label="企业管理">{MANAGEMENT.map(({ id, label, icon: Icon }) => <button type="button" disabled={disabled} key={id} className="mn-nav-button" aria-current={active === id ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={16} aria-hidden="true" /><span>{label}</span></button>)}</nav></div>}</>;
}
