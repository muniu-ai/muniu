// SPDX-License-Identifier: Apache-2.0
import type { GoalResourceRefV2 } from './goals.js';

export interface DocumentLocatorV2 {
  readonly page?: number;
  readonly paragraph?: number;
  readonly sheet?: string;
  readonly cell?: string;
  readonly row?: number;
  readonly column?: number;
  readonly part?: string;
}
export interface AssetExtractionV2 {
  readonly assetRef: GoalResourceRefV2;
  readonly fileName: string;
  readonly mediaType: string;
  readonly status: 'complete' | 'partial' | 'unreadable';
  readonly blocks: readonly { readonly id: string; readonly text: string; readonly locator: DocumentLocatorV2 }[];
  readonly issues: readonly { readonly code: string; readonly message: string; readonly locator?: DocumentLocatorV2 }[];
  readonly extractorVersion: '1';
  readonly textDigest: string;
}
export interface ContextMaterialV2 {
  readonly assetRef: GoalResourceRefV2;
  readonly textDigest: string;
  readonly extractorVersion: '1';
  readonly status: 'complete' | 'partial';
  readonly selection: { readonly strategy: 'keyword-v1'; readonly queryDigest: string; readonly totalBlockCount: number; readonly maxBytes: number };
  readonly selectedBlocks: readonly { readonly id: string; readonly locator: DocumentLocatorV2; readonly textDigest: string }[];
}
/** Dependencies include inherited evidence; materials name blocks included in this execution's initial input. */
export interface ExecutionContextV2 {
  readonly version: 1;
  readonly executionId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly streamVersion: number;
  readonly sourceRefs: readonly GoalResourceRefV2[];
  readonly materials: readonly ContextMaterialV2[];
  readonly inheritedExecutionIds: readonly string[];
  readonly digest: string;
}
