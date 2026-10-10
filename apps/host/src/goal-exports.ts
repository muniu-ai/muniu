// SPDX-License-Identifier: Apache-2.0
import {parseCreateGoalExportV2,type Asset,type CreateGoalExportV2,type GoalExportSourceV2,type GoalExportV2,type GoalResourceRefV2} from '@mn/contracts';
import {appendKernelEvent,KernelError,sha256,type KernelStore,type KernelTransaction} from '@mn/kernel';
import type {ContentAddressedStorage,KeyProvider} from '@mn/storage';
import type {ContextSourceValidator} from '@mn/worker';
import {assertAssetMembership,assertDerivedAssetProvenance,type AssetAccessScope} from './asset-provenance.js';
import {prepareProtectedAsset,commitPreparedDerivedAssetInTransaction} from './assets.js';
import type {FixedGoalOutputProof} from './goal-output-access.js';
import {renderGoalExport,GoalExportError,type GoalExportDocument,type RenderedGoalExport} from './goal-export-renderer.js';
import {EXPORT_MEDIA_TYPES} from './goal-export-renderer-types.js';
export interface GoalExportOptions extends AssetAccessScope {
 readonly store:KernelStore;readonly cas:ContentAddressedStorage;readonly keyProvider:KeyProvider;readonly protectedJournal:boolean;
 readonly now:()=>string;readonly id:(kind:string)=>string;readonly validateContextSource?:ContextSourceValidator;
 readonly ports:{readOutput(tx:KernelTransaction,scope:AssetAccessScope,origin:GoalExportSourceV2):FixedGoalOutputProof};
 readonly render?:(format:CreateGoalExportV2['format'],document:GoalExportDocument)=>Promise<RenderedGoalExport>;
}
function fail(code:string,message:string):never{throw new KernelError(code,message,'刷新成果版本和资料授权后重试');}
function stored(tx:KernelTransaction,options:GoalExportOptions,goalId:string,id:string):GoalExportV2{
 assertAssetMembership(tx,options);const record=tx.getProjection<GoalExportV2>('goal.export',id);
 if(!record||record.tenantId!==options.tenantId||record.workspaceId!==options.workspaceId||record.goalId!==goalId||record.id!==id||record.streamVersion!==1)fail('EXPORT_NOT_FOUND','成果导出记录不存在');
 const asset=tx.getProjection<Asset>('asset',record.assetRef.resourceId);
 if(!asset||asset.digest!==record.assetRef.digest||asset.streamVersion!==record.assetRef.streamVersion||asset.provenance?.producer.namespace!=='goal.export'||asset.provenance.producer.resourceId!==record.id)fail('EXPORT_SOURCE_INVALID','成果导出资料依据无效');
 assertDerivedAssetProvenance(tx,options,asset,options.validateContextSource);return record;
}
function fingerprint(proof:FixedGoalOutputProof):string{return sha256({output:proof.output,plan:proof.context.plan,proof:proof.proof,accepted:proof.accepted});}
function sourceRefs(proof:FixedGoalOutputProof):readonly GoalResourceRefV2[]{const entries=[...proof.context.plan.resourceRefs,proof.output.resourceRef,...proof.output.sourceRefs];return [...new Map(entries.map(ref=>[sha256(ref),ref])).values()];}
export async function createGoalExport(options:GoalExportOptions,goalId:string,input:CreateGoalExportV2,key:string):Promise<GoalExportV2>{
 try{parseCreateGoalExportV2(input);}catch{fail('EXPORT_REQUEST_INVALID','成果导出请求字段无效');}
 if(input.workspaceId!==options.workspaceId||!goalId.trim()||goalId.length>200)fail('EXPORT_REQUEST_INVALID','成果导出工作区或目标无效');
 if(!key.trim()||key.length>200)fail('IDEMPOTENCY_KEY_REQUIRED','导出需要幂等键');
 if(!options.protectedJournal)fail('PROTECTED_JOURNAL_REQUIRED','导出需要受保护的事件存储');
 const scope=`goal.export:${options.workspaceId}:${goalId}:${options.principalId}`,requestDigest=sha256(input);
 const source:GoalExportSourceV2={goalId,planRevisionId:input.planRevisionId,deliverySetId:input.deliverySetId,outputKey:input.outputKey,outputDigest:input.outputDigest};
 const begin=await options.store.transact(options.tenantId,tx=>{
  assertAssetMembership(tx,options,true);const prior=tx.getIdempotency(scope,key);
  if(prior){if(prior.requestDigest!==requestDigest)fail('IDEMPOTENCY_CONFLICT','此幂等键已用于其他导出请求');return{existing:stored(tx,options,goalId,(prior.response as {id:string}).id)};}
  const proof=options.ports.readOutput(tx,options,source);if(sha256(proof.origin)!==sha256(source))fail('EXPORT_SOURCE_INVALID','成果导出来源不匹配');return{proof};
 });
 if(begin.existing)return begin.existing;
 const proof=begin.proof!,createdAt=options.now(),id=options.id('goal-export'),assetId=options.id('asset');
 const title=proof.context.plan.deliverables.find(spec=>spec.key===input.outputKey)?.title??input.outputKey;
 const fileName=`成果-${sha256([source,id]).slice(0,12)}.${input.format}`;
 let rendered:RenderedGoalExport;
 try { rendered=await(options.render??renderGoalExport)(input.format,{title,text:proof.output.preview,sourceLabel:`${goalId} / ${source.planRevisionId} / ${source.deliverySetId} / ${source.outputKey} / ${source.outputDigest}`,accepted:proof.accepted,createdAt}); }
 catch(error) { if(error instanceof GoalExportError)throw new KernelError(error.code,error.message,error.code==='EXPORT_BUSY'?'稍后用同一幂等键重试':'检查成果长度、格式及所需字形',error.code==='EXPORT_BUSY');throw error; }
 let prepared;try{
  if(rendered.mediaType!==EXPORT_MEDIA_TYPES[input.format])fail('EXPORT_INVALID_RESULT','导出格式与文件类型不匹配');
  prepared=await prepareProtectedAsset({cas:options.cas,keyProvider:options.keyProvider,tenantId:options.tenantId,workspaceId:options.workspaceId,assetId,fileName,mediaType:rendered.mediaType,bytes:rendered.bytes,now:()=>createdAt,id:options.id});
 }finally{rendered.bytes.fill(0);}
 return options.store.transact(options.tenantId,tx=>{
  assertAssetMembership(tx,options,true);const prior=tx.getIdempotency(scope,key);
  if(prior){if(prior.requestDigest!==requestDigest)fail('IDEMPOTENCY_CONFLICT','此幂等键已用于其他导出请求');return stored(tx,options,goalId,(prior.response as {id:string}).id);}
  const current=options.ports.readOutput(tx,options,source);if(fingerprint(proof)!==fingerprint(current))fail('EXPORT_SOURCE_CHANGED','导出期间成果依据已变化');
  const asset=commitPreparedDerivedAssetInTransaction(tx,options,prepared,{version:1,kind:'goal_export',producer:{namespace:'goal.export',resourceId:id},sourceRefs:sourceRefs(current),proof:current.proof},options);
  const result:GoalExportV2={id,tenantId:options.tenantId,workspaceId:options.workspaceId,goalId,streamVersion:1,source,format:input.format,fileName,mediaType:asset.mediaType,byteLength:asset.byteLength,contentSha256:prepared.contentSha256,
   assetRef:{namespace:'asset',resourceId:asset.id,streamVersion:asset.streamVersion,digest:asset.digest},rendererVersion:rendered.rendererVersion,...(rendered.fontSha256?{fontSha256:rendered.fontSha256}:{}),accepted:current.accepted,createdAt};
  tx.putProjection('goal.export',id,result);appendKernelEvent(tx,{tenantId:options.tenantId,aggregateType:'goal.export',aggregateId:id,expectedStreamVersion:0,type:'goal.export_created',actorId:options.principalId,generation:0,correlationId:options.id('correlation'),publicPayload:{workspaceId:options.workspaceId,format:input.format}});
  tx.putIdempotency({tenantId:options.tenantId,scope,key,requestDigest,response:{id},createdAt});return result;
 });
}
export async function getGoalExport(options:GoalExportOptions,goalId:string,id:string):Promise<GoalExportV2>{return options.store.transact(options.tenantId,tx=>stored(tx,options,goalId,id));}
export async function listGoalExports(options:GoalExportOptions,goalId:string):Promise<readonly GoalExportV2[]>{return options.store.transact(options.tenantId,tx=>{assertAssetMembership(tx,options);return tx.listProjections<GoalExportV2>('goal.export').filter(record=>record.tenantId===options.tenantId&&record.workspaceId===options.workspaceId&&record.goalId===goalId).map(record=>stored(tx,options,goalId,record.id)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));});}
