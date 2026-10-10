// SPDX-License-Identifier: Apache-2.0
import { runKeychainCommand } from '@mn/storage';
import { sha256 } from '@mn/kernel';
import { mcpFail, type McpSecretScope, type McpSecretStore } from './mcp-sources.js';
/** Dedicated account/service namespace; model credentials are never reused. */
export class MacOsMcpSecretStore implements McpSecretStore {
  constructor(private readonly command: (args: readonly string[], stdin?: string) => Promise<string> = runKeychainCommand) {}
  private account(scope: McpSecretScope): string {
    if (![scope.tenantId, scope.workspaceId, scope.connectionId, scope.credentialId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) mcpFail('MCP_CREDENTIAL_INVALID');
    return `mcp-${sha256(scope)}`;
  }
  async save(scope: McpSecretScope, bearerToken: string): Promise<string> {
    const account = this.account(scope); if (!bearerToken || bearerToken.length > 8192 || !/^[\x21-\x7e]+$/u.test(bearerToken)) mcpFail('MCP_CREDENTIAL_INVALID');
    try { await this.command(['add-generic-password', '-U', '-s', 'com.muniu.agent-os.v2.mcp', '-a', account, '-w'], `${bearerToken}\n`); }
    catch { mcpFail('MCP_CREDENTIAL_UNAVAILABLE'); }
    return `keychain://muniu.v2.mcp/${account}`;
  }
  async read(scope: McpSecretScope, reference: string): Promise<string> {
    const account = this.account(scope); if (reference !== `keychain://muniu.v2.mcp/${account}`) mcpFail('MCP_CREDENTIAL_INVALID');
    try {
      const value = await this.command(['find-generic-password', '-s', 'com.muniu.agent-os.v2.mcp', '-a', account, '-w']);
      if (!value || value.length > 8192 || !/^[\x21-\x7e]+$/u.test(value)) mcpFail('MCP_CREDENTIAL_INVALID');
      return value;
    }
    catch { mcpFail('MCP_CREDENTIAL_UNAVAILABLE'); }
  }
}
