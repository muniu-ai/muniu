// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import type { BusinessContextTargetV2 } from '@mn/contracts';
import type { AgentOsClient } from '../api';
export function BusinessMaterialPicker({api,workspaceId,disabled,onSelect}:{api:AgentOsClient;workspaceId:string;disabled:boolean;onSelect:(target:BusinessContextTargetV2)=>void}) {
 const [open,setOpen]=useState(false),[choices,setChoices]=useState<readonly {key:string;title:string;target:BusinessContextTargetV2}[]>([]),[selected,setSelected]=useState(''),[error,setError]=useState('');
 useEffect(()=>{if(!open)return;let active=true;setChoices([]);setError('');void api.business(workspaceId).then(({state})=>{if(!active)return;const services=new Map<string,typeof state.services[number]>();for(const item of state.services)if((services.get(item.id)?.version??0)<item.version)services.set(item.id,item);const customers=new Map<string,typeof state.customers[number]>();for(const item of state.customers)if((customers.get(item.id)?.version??0)<item.version)customers.set(item.id,item);setChoices([
 ...[...customers.values()].map(item=>({key:`customer:${item.id}`,title:`客户 · ${item.name}`,target:{kind:'customer' as const,resourceId:item.id}})),
 ...[...services.values()].map(item=>({key:`service:${item.id}`,title:`服务 · ${item.title} · 第 ${item.version} 版`,target:{kind:'service' as const,resourceId:item.id}})),
 ...state.quotes.map(item=>({key:`quote:${item.id}`,title:`报价 · ${customers.get(item.customerId)?.name??item.customerId} · 服务第 ${item.serviceVersion} 版`,target:{kind:'quote' as const,resourceId:item.id}})),
 ...state.orders.map(item=>({key:`order:${item.id}`,title:`订单 · ${customers.get(item.customerId)?.name??item.customerId} · ${item.contractedOn}`,target:{kind:'order' as const,resourceId:item.id}})),
 ...state.deliveries.map(item=>({key:`delivery:${item.id}`,title:`交付 · ${item.title}`,target:{kind:'delivery' as const,resourceId:item.id}})),
 ...state.reviews.map(item=>({key:`review:${item.id}`,title:`复盘 · ${item.period.start} 至 ${item.period.end}`,target:{kind:'review' as const,resourceId:item.id}}))]);}).catch(()=>{if(active)setError('无法读取业务对象，请重新打开后重试。');});return()=>{active=false;};},[api,workspaceId,open]);
 return <div><button type="button" className="quiet-button" disabled={disabled} onClick={()=>setOpen(value=>!value)}>选择业务资料</button>{open&&<><p>只有明确选入的对象版本会提供给 Agent。报价需选入客户及服务版本。</p>{error&&<p role="alert">{error}</p>}<label>业务对象<select aria-label="业务对象资料" disabled={disabled} value={selected} onChange={event=>setSelected(event.target.value)}><option value="">请选择对象与版本</option>{choices.map(item=><option key={item.key} value={item.key}>{item.title}</option>)}</select></label><button type="button" className="secondary-button" disabled={disabled||!choices.some(item=>item.key===selected)} onClick={()=>{const choice=choices.find(item=>item.key===selected);if(choice){onSelect(choice.target);setOpen(false);setSelected('');}}}>加入任务资料</button></>}</div>;
}
