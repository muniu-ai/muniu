// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'mn-collaboration-'));
try {
 const file=join(dir,'fixture.cjs');await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {AssignmentReview,NotificationReview} from './apps/desktop-mac/src/components/TaskCollaboration';export const assignment=(detail)=>renderToStaticMarkup(<AssignmentReview detail={detail} busy={false} onAssign={()=>{}}/>);export const notice=(item)=>renderToStaticMarkup(<NotificationReview item={item} busy={false} onCommand={()=>{}}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:file});
 const fixture=createRequire(import.meta.url)(file);
 test('责任分配展示不可选成员和现有不可用负责人，不暗示权限扩大',()=>{
 const member={principalId:'p',displayName:'责任人甲',workspaceRole:'viewer',available:false,unavailableReason:'当前角色不能访问任务'};
 const html=fixture.assignment({assignment:{responsiblePrincipalId:'p',streamVersion:3},summary:{responsible:member},members:[member],allowedActions:{assign:false,clear:true}});
 assert.ok(html.includes('责任人甲'));assert.ok(html.includes('当前角色不能访问任务'));assert.ok(html.includes('责任分配不改变任务权限或执行授权'));assert.match(html,/<option[^>]*disabled=""/);assert.ok(html.includes('取消分配'));assert.match(html,/<button[^>]*disabled=""[^>]*>保存负责人/);
 });
 test('通知只展示 Host 允许的已读命令且不显示审批验收操作',()=>{
 const html=fixture.notice({readState:'unread',allowedActions:['mark_read']});assert.ok(html.includes('标为已读'));assert.ok(!html.includes('标为未读'));assert.ok(!html.includes('接收'));assert.ok(!html.includes('批准'));
 assert.ok(!fixture.notice({readState:'read',allowedActions:[]}).includes('<button'));
 });
}finally{await rm(dir,{recursive:true,force:true});}
