// SPDX-License-Identifier: Apache-2.0
import {useCallback,useEffect,useRef,useState} from 'react';
import type {GoalExportFormatV2,GoalExportSourceV2,GoalExportV2} from '@mn/contracts';
import type {AgentOsClient} from '../api';
import {ExportFileError,saveBinaryExport} from '../export';
import {reuseFailure,useReuseAction,useReuseRead} from './ReuseState';
export function sameExportSource(left:GoalExportSourceV2,right:GoalExportSourceV2):boolean {return left.goalId===right.goalId&&left.planRevisionId===right.planRevisionId&&left.deliverySetId===right.deliverySetId&&left.outputKey===right.outputKey&&left.outputDigest===right.outputDigest;}
type SaveSession={controller:AbortController;verify?:()=>Promise<void>};
export function GoalExports({api,workspaceId,source}:{api:AgentOsClient;workspaceId:string;source:GoalExportSourceV2}) {
 const [format,setFormat]=useState<GoalExportFormatV2>('pdf'),[message,setMessage]=useState<string>(),[saving,setSaving]=useState(false),download=useRef<SaveSession | undefined>(undefined),sourceEpoch=useRef(0);
 const load=useCallback(()=>api.goalExports(workspaceId,source.goalId),[api,workspaceId,source.goalId]),read=useReuseRead(api,workspaceId,load);
 const identity=JSON.stringify(source), action=useReuseAction(api,workspaceId,`export:${identity}`,()=>{void read.reload();});
 useEffect(()=>{const stop=api.watchWorkspaceEvents(workspaceId,()=>{sourceEpoch.current++;void download.current?.verify?.().catch(()=>{});});return()=>{stop();sourceEpoch.current++;download.current?.controller.abort();};},[api,workspaceId,identity]);
 async function save(item:GoalExportV2){
  download.current?.controller.abort();const controller=new AbortController(),session:SaveSession={controller};download.current=session;setSaving(true);setMessage(undefined);
  try{
   const current=await api.goalExport(workspaceId,source.goalId,item.id);controller.signal.throwIfAborted();if(!sameExportSource(current.source,source))throw new ExportFileError('成果来源或版本已变化，请核对后重新保存');
   let checking:Promise<void>|undefined;
   session.verify=()=>{
    checking??=(async()=>{
     let checkedEpoch:number;
     do{
      checkedEpoch=sourceEpoch.current;controller.signal.throwIfAborted();
      const latest=await api.goalExport(workspaceId,source.goalId,current.id);controller.signal.throwIfAborted();
      const asset=await api.asset(latest.assetRef.resourceId);controller.signal.throwIfAborted();
      if(!sameExportSource(latest.source,source)||latest.contentSha256!==current.contentSha256||latest.byteLength!==current.byteLength||latest.assetRef.resourceId!==current.assetRef.resourceId||asset.streamVersion!==current.assetRef.streamVersion||asset.digest!==current.assetRef.digest)throw new ExportFileError('成果来源或版本已变化，请核对后重新保存');
     }while(checkedEpoch!==sourceEpoch.current);
    })().catch(error=>{if(download.current===session&&!controller.signal.aborted){controller.abort();setMessage(error instanceof ExportFileError?error.message:reuseFailure(error));}throw error;}).finally(()=>{checking=undefined;});
    return checking;
   };
   const content=await api.assetContent(current.assetRef.resourceId,controller.signal,current.byteLength);
   const result=await saveBinaryExport(current,content,async()=>{if(checking)await checking;await session.verify!();},controller.signal);
   if(!controller.signal.aborted)setMessage(result==='saved'?'文件已保存。':result==='cancelled'?'已取消保存。':'已发起下载，请在浏览器中确认文件。');
  }
  catch(error){if(!controller.signal.aborted)setMessage(error instanceof ExportFileError?error.message:reuseFailure(error));}
  finally{if(download.current===session){download.current=undefined;setSaving(false);}}
 }
 return <section aria-label="成果文件导出"><h4>导出固定版本</h4><p>导出保留此成果版本。Agent 验收记录不代表客户验收。</p><div className="button-row"><select aria-label="成果文件格式" value={format} disabled={action.locked} onChange={event=>setFormat(event.target.value as GoalExportFormatV2)}><option value="pdf">PDF</option><option value="docx">Word（DOCX）</option><option value="xlsx">Excel（XLSX）</option></select><button className="secondary-button" disabled={action.locked} onClick={()=>{const input={workspaceId,expectedStreamVersion:0 as const,planRevisionId:source.planRevisionId,deliverySetId:source.deliverySetId,outputKey:source.outputKey,outputDigest:source.outputDigest,format};action.run(key=>api.createGoalExport(source.goalId,input,key));}}>生成文件</button></div>{action.error&&<p role="alert">{action.error}</p>}{action.pending&&!action.busy&&<button onClick={action.retry}>重试原导出请求</button>}{read.error&&<p role="alert">{read.error}</p>}{read.value?.filter(item=>sameExportSource(item.source,source)).map(item=><div className="button-row" key={item.id}><span>{item.fileName} · {Math.ceil(item.byteLength/1024)} KiB · {item.accepted?'已接收成果':'未接收成果'}</span><button className="quiet-button" disabled={saving} onClick={()=>void save(item)}>保存 {item.format.toUpperCase()}</button></div>)}{message&&<p role="status">{message}</p>}</section>;
}
