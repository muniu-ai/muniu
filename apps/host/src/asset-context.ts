// SPDX-License-Identifier: Apache-2.0
import type { Asset, AssetExtractionV2, GoalResourceRefV2, Principal, WorkspaceMembership } from '@mn/contracts';
import { KernelError, sha256, type KernelTransaction } from '@mn/kernel';
import { assertContextSource } from '@mn/worker';
import { readAssetContent, type ReadAssetContentOptions } from './assets.js';
import { DocumentExtractionError, extractDocument } from './document-extraction.js';

export function assertAssetReader(tx: KernelTransaction, scope: { tenantId: string; workspaceId: string; principalId: string }, ref: GoalResourceRefV2): Asset {
  const member = tx.getProjection<WorkspaceMembership>('membership', `${scope.workspaceId}:${scope.principalId}`);
  const principal = tx.getProjection<Principal>('principal', scope.principalId);
  if (!principal || principal.disabledAt || !member || member.removedAt) throw new KernelError('WORKSPACE_ACCESS_DENIED', '无权读取工作区资料', '联系工作区所有者');
  assertContextSource(tx, scope, ref);
  const asset = tx.getProjection<Asset>('asset', ref.resourceId)!;
  if (!asset.protected) throw new KernelError('GOAL_MATERIAL_NOT_PROTECTED', '目标资料必须受保护', '重新上传受保护资料');
  return asset;
}
export async function readAssetExtraction(options: ReadAssetContentOptions & { readonly principalId: string }): Promise<AssetExtractionV2> {
  const { asset } = options;
  const assetRef: GoalResourceRefV2 = { namespace: 'asset', resourceId: asset.id, streamVersion: asset.streamVersion, digest: asset.digest };
  const scope = { tenantId: options.tenantId, workspaceId: asset.workspaceId, principalId: options.principalId };
  const check = () => options.store.transact(options.tenantId, tx => assertAssetReader(tx, scope, assetRef));
  await check();
  const bytes = await readAssetContent(options);
  let extracted;
  try { extracted = await extractDocument({ fileName: asset.fileName, mediaType: asset.mediaType, bytes }); }
  catch (error) {
    if (error instanceof DocumentExtractionError) throw new KernelError('DOCUMENT_EXTRACTION_REJECTED', '资料无法安全提取或超过解析限额', '缩小文件范围或转换为文本后重新上传');
    throw error;
  }
  await check();
  return { assetRef, fileName: asset.fileName, mediaType: asset.mediaType, ...extracted, textDigest: sha256(extracted) };
}
