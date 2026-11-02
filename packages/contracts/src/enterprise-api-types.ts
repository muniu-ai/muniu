// Generated from enterprise-api-schema.ts. Do not edit.
// SPDX-License-Identifier: Apache-2.0
import type * as Types from "./enterprise-types.js";
export interface EnterpriseApiInputs {
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
