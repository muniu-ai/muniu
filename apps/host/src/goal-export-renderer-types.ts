// SPDX-License-Identifier: Apache-2.0
import type { GoalExportFormatV2 } from '@mn/contracts';
export const EXPORT_RENDERER_VERSION = '1';
export const EXPORT_FONT_SHA256 = '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b';
export const EXPORT_FONT_BYTES = 16437364;
export const EXPORT_MAX_BYTES = 20 * 1024 * 1024;
export const EXPORT_MEDIA_TYPES = {docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pdf:'application/pdf',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'} as const;
export interface GoalExportDocument { readonly title:string; readonly text:string; readonly sourceLabel:string; readonly accepted:boolean; readonly createdAt:string }
export interface RenderedGoalExport { readonly bytes:Uint8Array; readonly mediaType:string; readonly rendererVersion:string; readonly fontSha256?:string }
export class GoalExportError extends Error { constructor(readonly code:string,message:string) {super(message);this.name='GoalExportError';} }
export function validateExportDocument(format:GoalExportFormatV2,doc:GoalExportDocument):void {
 if(!Object.hasOwn(EXPORT_MEDIA_TYPES,format) || !doc || typeof doc.title !== 'string' || typeof doc.text !== 'string' || typeof doc.sourceLabel !== 'string'
  || typeof doc.accepted !== 'boolean' || typeof doc.createdAt !== 'string' || !Number.isFinite(Date.parse(doc.createdAt))) throw new GoalExportError('EXPORT_INVALID','成果导出内容无效');
 if(Buffer.byteLength(doc.title)>2048 || Buffer.byteLength(doc.sourceLabel)>4096 || Buffer.byteLength(doc.text)>1024*1024 || doc.text.split('\n').length>10000)
  throw new GoalExportError('EXPORT_LIMIT','成果超过导出内容限制');
 // XML 1.0 and the font writer must see the exact same scalar text; never silently repair or truncate it.
 if([doc.title,doc.text,doc.sourceLabel].some(s=>/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(s)))
  throw new GoalExportError('EXPORT_INVALID','成果包含不能导出的控制字符');
}
