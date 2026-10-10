// SPDX-License-Identifier: Apache-2.0
import type { GoalResourceRefV2 } from './goals.js';
/** Host-generated provenance. Public attachment upload cannot supply this field. */
export interface AssetProvenanceV2 {
  readonly version: 1;
  readonly kind: 'goal_export' | 'mcp_resource';
  readonly producer: { readonly namespace: 'goal.export' | 'mcp.resourceRead'; readonly resourceId: string };
  readonly sourceRefs: readonly GoalResourceRefV2[];
  readonly proof?: {
    readonly projections: readonly { readonly namespace: string; readonly resourceId: string; readonly digest: string }[];
    readonly protectedPayloadRefs: readonly string[];
  };
}
