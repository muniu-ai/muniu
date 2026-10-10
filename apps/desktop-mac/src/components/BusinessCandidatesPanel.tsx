// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { GoalOutputRefV2, OpcBusinessCandidateDetailV2, OpcBusinessCandidateOriginV2 } from '@mn/contracts';
import { AgentOsApiError, type AgentOsClient } from '../api';
import { BusinessCandidateReview } from './BusinessCandidateReview';
type Pending = {work:()=>Promise<OpcBusinessCandidateDetailV2>;uncertain:boolean};
type OperationStore = {pending?:Pending;listeners:Set<()=>void>};
const operationStores=new WeakMap<AgentOsClient,Map<string,OperationStore>>();
function operationStore(api:AgentOsClient,workspaceId:string){let workspaces=operationStores.get(api);if(!workspaces){workspaces=new Map();operationStores.set(api,workspaces);}let store=workspaces.get(workspaceId);if(!store){store={listeners:new Set()};workspaces.set(workspaceId,store);}return store;}

export function BusinessCandidatesPanel({api,workspaceId,origin,outputs}:{api:AgentOsClient;workspaceId:string;origin?:Omit<OpcBusinessCandidateOriginV2,'outputKey'|'outputDigest'>;outputs?:readonly GoalOutputRefV2[]}) {
 const [items,setItems]=useState<readonly OpcBusinessCandidateDetailV2[]>([]),[detail,setDetail]=useState<OpcBusinessCandidateDetailV2>(),[error,setError]=useState<string>(),[busy,setBusy]=useState(false);
 const store=operationStore(api,workspaceId),[,refreshOperation]=useState(0);const pending=store.pending;
 function setPending(next:Pending|undefined){store.pending=next;for(const notify of store.listeners)notify();}
 useEffect(()=>{const notify=()=>refreshOperation(value=>value+1);store.listeners.add(notify);return()=>{store.listeners.delete(notify);};},[store]);
 const epoch=useRef(0),mounted=useRef(true),activeId=useRef<string|undefined>(undefined);
 useEffect(()=>{mounted.current=true;let timer:ReturnType<typeof setTimeout>|undefined;async function refresh(){const request=++epoch.current;try{if(origin){if(!activeId.current)return;const next=await api.businessCandidate(workspaceId,activeId.current);if(mounted.current&&request===epoch.current)setDetail(next);}else{const next=await api.businessCandidates(workspaceId);if(mounted.current&&request===epoch.current){setItems(next.items);setDetail(next.items.find(item=>item.candidate.id===activeId.current));}}}catch(caught){if(mounted.current&&request===epoch.current){setItems([]);setDetail(undefined);setError(failure(caught));}}}if(!origin)void refresh();const stop=api.watchWorkspaceEvents(workspaceId,()=>{epoch.current++;setItems([]);setDetail(undefined);if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh();},150);});return()=>{mounted.current=false;epoch.current++;stop();if(timer)clearTimeout(timer);};},[api,workspaceId,origin?.goalId,origin?.deliverySetId]);
 async function execute(request:Pending){if(busy)return;setBusy(true);setError(undefined);const started=epoch.current;try{const next=await request.work();if(!mounted.current)return;setPending(undefined);activeId.current=next.candidate.id;if(started===epoch.current)setDetail(next);else{const request=++epoch.current;const fresh=await api.businessCandidate(workspaceId,next.candidate.id);if(mounted.current&&request===epoch.current)setDetail(fresh);}}catch(caught){if(!mounted.current)return;if(!request.uncertain&&caught instanceof AgentOsApiError&&caught.status<500)setPending(undefined);else request.uncertain=true;if(caught instanceof AgentOsApiError&&[403,404].includes(caught.status)){epoch.current++;setItems([]);setDetail(undefined);}setError(failure(caught));}finally{if(mounted.current)setBusy(false);}}
 function mutate(work:(key:string)=>Promise<OpcBusinessCandidateDetailV2>){if(pending||busy)return;const key=crypto.randomUUID(),request={work:()=>work(key),uncertain:false};setPending(request);void execute(request);}
 const proposals=outputs?.flatMap(output=>(output.businessProposals??[]).map(proposal=>({output,proposal})))??[];
 if(origin&&!proposals.length&&!detail&&!error)return null;
 return <section aria-label="经营变更候选"><h3>经营变更候选</h3><p>核对字段变化、依据与影响后采纳，才会写入经营记录。</p>{error&&<p role="alert">{error}</p>}
 {pending&&!busy&&<><p>上次操作结果尚未确认，请复用原请求核对。</p><button className="secondary-button" onClick={()=>void execute(pending)}>核对候选操作</button></>}
 {proposals.map(({output,proposal})=><button className="secondary-button" key={`${output.key}:${proposal.key}`} disabled={busy||Boolean(pending)} onClick={()=>mutate(key=>api.createBusinessCandidate(workspaceId,{...origin!,outputKey:output.key,outputDigest:output.digest},proposal.key,key))}>审阅候选：{proposal.title}</button>)}
 {!origin&&items.map(item=><button className="secondary-button" key={item.candidate.id} disabled={busy||Boolean(pending)} onClick={()=>{activeId.current=item.candidate.id;setDetail(item);}}>{item.candidate.proposal.title}{item.decision?' · 已处理':item.availability.apply?' · 待决定':' · 需核验'}</button>)}
 {detail&&<BusinessCandidateReview detail={detail} disabled={busy||Boolean(pending)} onDecide={decision=>mutate(key=>api.decideBusinessCandidate(detail,decision,key))}/>}
 </section>;
}
function failure(caught:unknown){return caught instanceof AgentOsApiError?`${caught.detail.message}。${caught.detail.action}`:'候选操作未完成，请核对连接后重试。';}
