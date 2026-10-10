// SPDX-License-Identifier: Apache-2.0
import type { GoalResourceRefV2 } from './goals.js';
export type GoalExportFormatV2 = 'docx' | 'pdf' | 'xlsx';
export interface GoalExportSourceV2 { readonly goalId: string; readonly planRevisionId: string; readonly deliverySetId: string; readonly outputKey: string; readonly outputDigest: string }
export interface CreateGoalExportV2 {
  readonly workspaceId: string; readonly expectedStreamVersion: 0;
  readonly planRevisionId: string; readonly deliverySetId: string; readonly outputKey: string; readonly outputDigest: string;
  readonly format: GoalExportFormatV2;
}
export interface GoalExportV2 {
  readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly goalId: string; readonly streamVersion: 1;
  readonly source: GoalExportSourceV2; readonly format: GoalExportFormatV2; readonly fileName: string; readonly mediaType: string;
  readonly byteLength: number; readonly contentSha256: string; readonly assetRef: GoalResourceRefV2;
  readonly rendererVersion: string; readonly fontSha256?: string; readonly accepted: boolean; readonly createdAt: string;
}
export function parseCreateGoalExportV2(value: unknown): CreateGoalExportV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid export request');
  const x = value as Record<string, unknown>, fields = ['workspaceId','expectedStreamVersion','planRevisionId','deliverySetId','outputKey','outputDigest','format'];
  if (Object.keys(x).length !== fields.length || Object.keys(x).some(key => !fields.includes(key)) || x.expectedStreamVersion !== 0
    || !['docx','pdf','xlsx'].includes(x.format as string) || !/^[a-f0-9]{64}$/u.test(x.outputDigest as string)
    || ['workspaceId','planRevisionId','deliverySetId','outputKey'].some(key => typeof x[key] !== 'string' || !(x[key] as string).trim() || (x[key] as string).length > 200)) throw new Error('Invalid export request');
  return x as unknown as CreateGoalExportV2;
}
