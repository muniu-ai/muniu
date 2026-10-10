// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const bundled = await build({entryPoints:[new URL('../../src/api.ts',import.meta.url).pathname],bundle:true,platform:'browser',format:'esm',write:false,define:{'import.meta.env.VITE_MN_API_URL':'"http://host.test"'}});
const {AgentOsClient}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
test('责任、通知、固定成果导出和 MCP 请求使用公共契约及固定幂等身份',async()=>{
 const previous=globalThis.fetch,requests=[];
 globalThis.fetch=async(input,init)=>{const request=new Request(input,init);requests.push({path:new URL(request.url).pathname,method:request.method,key:request.headers.get('Idempotency-Key'),body:request.method==='GET'?undefined:await request.json()});return Response.json({code:'STREAM_VERSION_CONFLICT',message:'版本变化',action:'刷新',fieldIssues:[],traceId:'test',retryable:false},{status:409});};
 try {const api=new AgentOsClient('http://host.test');
 for(const call of [()=>api.setGoalAssignment('goal',{workspaceId:'w',expectedStreamVersion:0,responsiblePrincipalId:'person'},'assign'),()=>api.commandNotification('notice',{workspaceId:'w',expectedStreamVersion:2,command:'mark_read'},'read'),()=>api.createGoalExport('goal',{workspaceId:'w',expectedStreamVersion:0,planRevisionId:'p',deliverySetId:'d',outputKey:'report',outputDigest:'digest',format:'pdf'},'export'),()=>api.createMcpRequest('w','connection',{expectedStreamVersion:3,kind:'read',selection:{catalogRequestId:'catalog',uri:'mcp:report'}},'import')])await assert.rejects(call);
 assert.deepEqual(requests.map(({path,method,key})=>({path,method,key})),[{path:'/v2/goals/goal/assignment',method:'PUT',key:'assign'},{path:'/v2/notifications/notice/commands',method:'POST',key:'read'},{path:'/v2/goals/goal/exports',method:'POST',key:'export'},{path:'/v2/workspaces/w/mcp/connections/connection/requests',method:'POST',key:'import'}]);
 assert.deepEqual(requests[0].body,{workspaceId:'w',expectedStreamVersion:0,responsiblePrincipalId:'person'});assert.equal(requests[2].body.outputDigest,'digest');assert.equal(requests[2].body.expectedStreamVersion,0);assert.deepEqual(requests[3].body.selection,{catalogRequestId:'catalog',uri:'mcp:report'});
 }finally{globalThis.fetch=previous;}
});
test('成果下载在流读取阶段拒绝超额、截断和错误声明大小',async()=>{const previous=globalThis.fetch;try{const api=new AgentOsClient('http://host.test');for(const [data,length] of [['too large',3],['a',3]]){globalThis.fetch=async()=>new Response(data);await assert.rejects(()=>api.assetContent('asset',undefined,length));}globalThis.fetch=async()=>new Response('abc',{headers:{'Content-Length':'9'}});await assert.rejects(()=>api.assetContent('asset',undefined,3));globalThis.fetch=async()=>new Response('abc');assert.equal((await api.assetContent('asset',undefined,3)).size,3);}finally{globalThis.fetch=previous;}});
