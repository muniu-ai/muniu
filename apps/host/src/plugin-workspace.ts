// SPDX-License-Identifier: Apache-2.0

export function encodePluginWorkspace(tenantId: string, workspaceId: string): string {
  return Buffer.from(JSON.stringify([tenantId, workspaceId]), "utf8").toString("base64url");
}
