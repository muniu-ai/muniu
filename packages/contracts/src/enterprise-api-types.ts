// Generated from enterprise-api-schema.ts. Do not edit.
// SPDX-License-Identifier: Apache-2.0
import type * as Types from "./enterprise-types.js";
export interface EnterpriseApiInputs {
  readonly getBusinessApproval: { readonly path: { readonly workspaceId: string; readonly approvalId: string; }; };
  readonly executeBusinessCommand: { readonly path: { readonly workspaceId: string; }; readonly body: Types.EnterpriseBusinessCommand; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly listBusinessObjects: { readonly path: { readonly workspaceId: string; readonly objectType: string; }; };
  readonly getBusinessObject: { readonly path: { readonly workspaceId: string; readonly objectType: string; readonly objectId: string; }; };
  readonly getBusinessObjectVersion: { readonly path: { readonly workspaceId: string; readonly objectType: string; readonly objectId: string; readonly streamVersion: string; }; };
  readonly recordBusinessEvidence: { readonly path: { readonly workspaceId: string; }; readonly body: Types.EnterpriseBusinessEvidenceCreate; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly getBusinessEvidence: { readonly path: { readonly workspaceId: string; readonly evidenceId: string; }; };
  readonly withdrawBusinessEvidence: { readonly path: { readonly workspaceId: string; readonly evidenceId: string; }; readonly body: Types.EnterpriseBusinessEvidenceWithdraw; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly getQuotaConfiguration: { readonly path: { readonly workspaceId: string; }; };
  readonly configureWorkspaceQuota: { readonly path: { readonly workspaceId: string; }; readonly body: Types.EnterpriseQuotaConfigure; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly getAccessConfiguration: { readonly path: { readonly workspaceId: string; }; };
  readonly createDepartment: { readonly path: { readonly workspaceId: string; }; readonly body: Types.EnterpriseDepartmentCreate; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly grantBusinessRole: { readonly path: { readonly workspaceId: string; }; readonly body: Types.BusinessRoleGrantCreate; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly grantBusinessObject: { readonly path: { readonly workspaceId: string; }; readonly body: Types.BusinessObjectGrantCreate; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly revokeBusinessRole: { readonly path: { readonly workspaceId: string; readonly grantId: string; }; readonly body: Types.EnterpriseAccessRevoke; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly revokeBusinessObject: { readonly path: { readonly workspaceId: string; readonly grantId: string; }; readonly body: Types.EnterpriseAccessRevoke; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly enterpriseHealth: { readonly path?: Record<string, never>; };
  readonly enterpriseSession: { readonly path?: Record<string, never>; };
  readonly listOrganizations: { readonly path?: Record<string, never>; };
  readonly listEnterpriseWorkspaces: { readonly path?: Record<string, never>; };
  readonly createEnterpriseWorkspace: { readonly path?: Record<string, never>; readonly body: Types.EnterpriseWorkspaceCreate; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly listOrganizationMembers: { readonly path: { readonly organizationId: string; }; };
  readonly inviteOrganizationMember: { readonly path: { readonly organizationId: string; }; readonly body: Types.OrganizationInvitationCreate; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly acceptOrganizationInvitation: { readonly path: { readonly organizationId: string; readonly memberId: string; }; readonly body: Types.OrganizationInvitationAccept; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
  readonly commandOrganizationMember: { readonly path: { readonly organizationId: string; readonly memberId: string; }; readonly body: Types.OrganizationMemberCommand; readonly headers: { readonly "Idempotency-Key": string; readonly "X-CSRF-Token": string; }; };
}
export interface EnterpriseApiOutputs {
  readonly getBusinessApproval: Types.BusinessApproval;
  readonly executeBusinessCommand: Types.EnterpriseBusinessObjectView;
  readonly listBusinessObjects: Types.EnterpriseBusinessObjectList;
  readonly getBusinessObject: Types.EnterpriseBusinessObjectView;
  readonly getBusinessObjectVersion: Types.EnterpriseBusinessObjectView;
  readonly recordBusinessEvidence: Types.EvidenceRef;
  readonly getBusinessEvidence: Types.EnterpriseBusinessEvidenceView;
  readonly withdrawBusinessEvidence: Types.EnterpriseBusinessEvidenceWithdrawn;
  readonly getQuotaConfiguration: Types.EnterpriseQuotaConfiguration;
  readonly configureWorkspaceQuota: Types.EnterpriseQuotaView;
  readonly getAccessConfiguration: Types.EnterpriseAccessConfiguration;
  readonly createDepartment: Types.EnterpriseDepartmentView;
  readonly grantBusinessRole: Types.BusinessRoleGrantView;
  readonly grantBusinessObject: Types.BusinessObjectGrantView;
  readonly revokeBusinessRole: Types.BusinessRoleGrantView;
  readonly revokeBusinessObject: Types.BusinessObjectGrantView;
  readonly enterpriseHealth: Types.EnterpriseHealthView;
  readonly enterpriseSession: Types.EnterpriseSessionView;
  readonly listOrganizations: Types.OrganizationList;
  readonly listEnterpriseWorkspaces: Types.EnterpriseWorkspaceList;
  readonly createEnterpriseWorkspace: Types.EnterpriseWorkspaceView;
  readonly listOrganizationMembers: Types.OrganizationMemberList;
  readonly inviteOrganizationMember: Types.OrganizationInvitationView;
  readonly acceptOrganizationInvitation: Types.OrganizationMemberView;
  readonly commandOrganizationMember: Types.OrganizationMemberView;
}
