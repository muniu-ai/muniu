// SPDX-License-Identifier: Apache-2.0
import { useCallback, useState } from 'react';
import type { GoalAssignmentDetailV2, GoalAssignmentSummaryV2, InboxItemV2 } from '@mn/contracts';
import type { AgentOsClient } from '../api';
import { useReuseAction, useReuseRead } from './ReuseState';
export function assignmentLabel(summary?: GoalAssignmentSummaryV2): string {
 const person=summary?.responsible;
 return person ? `负责人：${person.displayName}${person.available?'':'（当前不可用）'}` : '未分配负责人';
}
export function AssignmentReview({detail,busy,onAssign}:{detail:GoalAssignmentDetailV2;busy:boolean;onAssign:(principalId:string|null)=>void}) {
 const [person,setPerson]=useState(detail.assignment.responsiblePrincipalId??'');
 return <div className="form-stack"><p>{assignmentLabel(detail.summary)}</p>{detail.summary.responsible?.unavailableReason&&<p>{detail.summary.responsible.unavailableReason}</p>}<p className="muted">责任分配不改变任务权限或执行授权。</p><label>任务负责人<select aria-label="任务负责人" value={person} disabled={busy||!detail.allowedActions.assign} onChange={event=>setPerson(event.target.value)}><option value="">选择负责人</option>{detail.members.map(member=><option key={member.principalId} value={member.principalId} disabled={!member.available}>{member.displayName}{member.available?'':` · ${member.unavailableReason??'当前不可用'}`}</option>)}</select></label><div className="button-row"><button className="secondary-button" disabled={busy||!detail.allowedActions.assign||!detail.members.some(member=>member.principalId===person&&member.available)} onClick={()=>onAssign(person)}>保存负责人</button>{detail.allowedActions.clear&&<button className="quiet-button" disabled={busy} onClick={()=>onAssign(null)}>取消分配</button>}</div></div>;
}
export function GoalAssignmentPanel({api,workspaceId,goalId,onChanged}:{api:AgentOsClient;workspaceId:string;goalId:string;onChanged:()=>void}) {
 const load=useCallback(()=>api.goalAssignment(workspaceId,goalId),[api,workspaceId,goalId]), read=useReuseRead(api,workspaceId,load);
 const action=useReuseAction(api,workspaceId,`assignment:${goalId}`,()=>{void read.reload();onChanged();});
 return <section className="panel" aria-label="任务责任"><h3>任务责任</h3>{read.error&&<p role="alert">{read.error}</p>}{read.value&&<AssignmentReview key={read.value.assignment.streamVersion} detail={read.value} busy={action.locked} onAssign={responsiblePrincipalId=>{const expectedStreamVersion=read.value!.assignment.streamVersion;action.run(key=>api.setGoalAssignment(goalId,{workspaceId,expectedStreamVersion,responsiblePrincipalId},key));}}/>}{action.error&&<p role="alert">{action.error}</p>}{action.pending&&!action.busy&&<button onClick={action.retry}>重试原责任分配</button>}{action.success&&<p role="status">责任分配已保存。</p>}</section>;
}
export function NotificationReview({item,busy,onCommand}:{item:Pick<InboxItemV2,'readState'|'allowedActions'>;busy:boolean;onCommand:(command:'mark_read'|'mark_unread')=>void}) {
 return <div className="button-row"><span className="pill">{item.readState==='read'?'已读':'未读'}</span>{item.allowedActions?.includes('mark_read')&&<button className="quiet-button" disabled={busy} onClick={()=>onCommand('mark_read')}>标为已读</button>}{item.allowedActions?.includes('mark_unread')&&<button className="quiet-button" disabled={busy} onClick={()=>onCommand('mark_unread')}>标为未读</button>}</div>;
}
export function NotificationActions({api,workspaceId,item,onChanged}:{api:AgentOsClient;workspaceId:string;item:InboxItemV2;onChanged:()=>void}) {
 const action=useReuseAction(api,workspaceId,`notice:${item.id}`,onChanged);
 if(!item.readState||item.streamVersion===undefined)return null;
 return <><NotificationReview item={item} busy={action.locked} onCommand={command=>{const expectedStreamVersion=item.streamVersion!;action.run(key=>api.commandNotification(item.id,{workspaceId,expectedStreamVersion,command},key));}}/>{action.error&&<p role="alert">{action.error}</p>}{action.pending&&!action.busy&&<button onClick={action.retry}>重试原已读操作</button>}</>;
}
