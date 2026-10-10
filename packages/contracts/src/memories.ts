// SPDX-License-Identifier: Apache-2.0
import type { GoalResourceRefV2 } from './goals.js';
export interface MemoryProvenanceV2 {
 readonly version: 1;
 readonly kind: 'fact' | 'preference';
 readonly origin: 'user' | 'model';
 readonly sourceRefs: readonly GoalResourceRefV2[];
 readonly sourceExecution?: { readonly executionId: string; readonly generation: number };
}
export type MemoryAccessV2 = 'readable' | 'stale' | 'revoked' | 'unavailable';
export type MemoryActionV2 = 'accept' | 'reject' | 'revise' | 'delete' | 'share';
export interface MemoryAdoptionV2 {
 readonly memoryRef: GoalResourceRefV2;
 readonly valueDigest: string;
 readonly sourceRefs: readonly GoalResourceRefV2[];
 readonly shareGrantRef?: GoalResourceRefV2;
}
export interface MemorySelectionV2 {
 readonly version: 1;
 readonly queryDigest: string;
 readonly matcherVersion: 'keyword-v1';
 readonly maxBytes: number;
 readonly messageIndex: number;
 readonly contentDigest: string;
 readonly adoptions: readonly MemoryAdoptionV2[];
 readonly previousContext?: { readonly streamVersion: number; readonly digest: string };
}
