import type { JsonObject } from "./json.js";

export type TenantId = string;
export type PrincipalId = string;
export type WorkspaceId = string;
export type ThreadId = string;
export type ExecutionId = string;
export type PluginId = string;
export type IsoDateTime = string;

export interface VersionedEntity {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly streamVersion: number;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface Tenant extends VersionedEntity {
  readonly slug: string;
  readonly displayName: string;
  readonly profile: "local" | "enterprise";
}

export interface Principal extends VersionedEntity {
  readonly kind: "human" | "service" | "agent";
  readonly displayName: string;
  readonly disabledAt?: IsoDateTime;
}

export type OrganizationRole =
  | "organization_admin"
  | "governance_admin"
  | "auditor";

export type WorkspaceRole = "owner" | "operator" | "reviewer" | "viewer";

export interface WorkspaceMembership extends VersionedEntity {
  readonly workspaceId: WorkspaceId;
  readonly principalId: PrincipalId;
  readonly organizationRoles: readonly OrganizationRole[];
  readonly workspaceRole: WorkspaceRole;
}

export interface Workspace extends VersionedEntity {
  readonly name: string;
  readonly description?: string;
  readonly viewMode: "business" | "professional";
  readonly activePluginIds: readonly PluginId[];
}

export interface Thread extends VersionedEntity {
  readonly workspaceId: WorkspaceId;
  readonly subject: string;
  readonly pluginId: PluginId;
  readonly resourceRef?: ResourceRef;
  readonly sessionLogHead?: string;
  readonly archivedAt?: IsoDateTime;
}

export type ExecutionStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "paused"
  | "interrupted"
  | "needs_reconciliation"
  | "completed"
  | "failed"
  | "cancelled";

export interface Execution extends VersionedEntity {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly pluginId: PluginId;
  readonly agentDefinitionId: string;
  readonly modelBindingId: string;
  readonly initiatedBy: PrincipalId;
  readonly executionPrincipalId: PrincipalId;
  readonly generation: number;
  readonly status: ExecutionStatus;
  readonly authorityId: string;
  readonly parentExecutionId?: ExecutionId;
  readonly startedAt?: IsoDateTime;
  readonly finishedAt?: IsoDateTime;
  readonly failureCode?: string;
}

export interface AgentDefinition extends VersionedEntity {
  readonly pluginId: PluginId;
  readonly name: string;
  readonly description: string;
  readonly promptContributionIds: readonly string[];
  readonly skillIds: readonly string[];
  readonly toolIds: readonly string[];
  readonly workflowId?: string;
}

export interface ModelBinding extends VersionedEntity {
  readonly presetId: string;
  readonly connectionId: string;
  readonly modelName: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
}

export type ToolEffectClass =
  | "local_read"
  | "external_read"
  | "local_reversible_write"
  | "local_irreversible_write"
  | "external_side_effect"
  | "financial"
  | "privileged"
  | "unknown";

export interface ExecutionBudget {
  readonly maxSubagentDepth: number;
  readonly maxSubagents: number;
  readonly maxTokens: number;
  readonly maxCostMinorUnits: string;
  readonly currency: string;
  readonly maxDurationMs: number;
}

export interface ExecutionAuthority extends VersionedEntity {
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly principalId: PrincipalId;
  readonly toolIds: readonly string[];
  readonly dataScopes: readonly ResourceRef[];
  readonly autoAllowedEffects: readonly ToolEffectClass[];
  readonly budget: ExecutionBudget;
  readonly parentAuthorityId?: string;
  readonly commitment: string;
}

export interface Approval extends VersionedEntity {
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly toolCallId: string;
  readonly effectClass: ToolEffectClass;
  readonly intent: string;
  readonly resourceRefs: readonly ResourceRef[];
  readonly authorityCommitment: string;
  readonly expiresAt: IsoDateTime;
  readonly status: "pending" | "approved_once" | "denied" | "expired";
  readonly decidedBy?: PrincipalId;
  readonly decidedAt?: IsoDateTime;
}

export interface ResourceRef {
  readonly namespace: string;
  readonly resourceId: string;
  readonly digest?: string;
}

export interface Deliverable extends VersionedEntity {
  readonly workspaceId: WorkspaceId;
  readonly pluginId: PluginId;
  readonly threadId: ThreadId;
  readonly executionId?: ExecutionId;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly assetIds: readonly string[];
  readonly nextAction?: string;
}

export interface Asset extends VersionedEntity {
  readonly workspaceId: WorkspaceId;
  readonly digest: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly fileName: string;
  readonly protected: boolean;
}

export interface MemoryRecord extends VersionedEntity {
  readonly workspaceId: WorkspaceId;
  readonly scopeType: "workspace" | "thread" | "resource" | "principal";
  readonly namespace: string;
  readonly resourceId: string;
  readonly sourceEventId: string;
  readonly status: "proposed" | "accepted" | "rejected" | "deleted" | "invalidated";
  readonly confidence: number;
  readonly value?: JsonObject;
  readonly protectedPayloadRef?: string;
  readonly confirmedAt?: IsoDateTime;
  readonly expiresAt?: IsoDateTime;
  readonly shareGrantIds: readonly string[];
}

export interface ShareGrant extends VersionedEntity {
  readonly workspaceId: WorkspaceId;
  readonly memoryId: string;
  readonly fromNamespace: string;
  readonly toNamespace: string;
  readonly grantedBy: PrincipalId;
  readonly grantedAt: IsoDateTime;
  readonly revokedAt?: IsoDateTime;
}

export interface Job extends VersionedEntity {
  readonly workspaceId?: WorkspaceId;
  readonly kind: string;
  readonly payload: JsonObject;
  readonly status: "available" | "leased" | "completed" | "failed";
  readonly attempts: number;
  readonly availableAt: IsoDateTime;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: IsoDateTime;
  readonly fencingToken: number;
  readonly idempotencyKey: string;
}

export interface PluginInstallation extends VersionedEntity {
  readonly pluginId: PluginId;
  readonly version: string;
  readonly packageSha256: string;
  readonly releaseSequence: number;
  readonly status:
    | "installed"
    | "active"
    | "draining"
    | "disabled"
    | "revoked"
    | "failed";
  readonly projectionNamespace: string;
  readonly developmentMode: boolean;
}
