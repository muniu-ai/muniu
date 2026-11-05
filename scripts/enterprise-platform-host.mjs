// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnterpriseContract } from '@mn/contracts/enterprise-client';
import { enterpriseEvaluationConfiguration } from '../apps/host/dist/enterprise-model-config.js';
import { startEnterpriseLocalHost } from '../apps/host/dist/enterprise-local.js';
export function enterprisePlatformOptions(configuration, env = process.env) {
  if (!configuration || !['development', 'hosted'].includes(configuration.profile) || !Array.isArray(configuration.organizations)
    || typeof configuration.providers !== 'object' || !configuration.providers) throw new Error('ENTERPRISE_CONFIG_INVALID');
  if (configuration.webRoot !== undefined && (typeof configuration.webRoot !== 'string' || !isAbsolute(configuration.webRoot))) throw new Error('ENTERPRISE_CONFIG_INVALID');
  if (configuration.loginOrganizations !== undefined) {
    try { parseEnterpriseContract('EnterpriseLoginDirectory', { organizations: configuration.loginOrganizations }); }
    catch { throw new Error('ENTERPRISE_CONFIG_INVALID'); }
  }
  const providers = Object.fromEntries(Object.entries(configuration.providers).map(([tenantId, provider]) => {
    if (!provider || typeof provider.issuer !== 'string' || typeof provider.clientId !== 'string') throw new Error('ENTERPRISE_CONFIG_INVALID');
    return [tenantId, { issuer: provider.issuer, clientId: provider.clientId, ...(provider.clientSecretEnv ? { clientSecret: async () => {
      const secret = env[provider.clientSecretEnv]; if (!secret) throw new Error('OIDC_CLIENT_SECRET_REQUIRED'); return secret;
    } } : {}) }];
  }));
  return { origin: configuration.origin, profile: configuration.profile, providers,
    operatingBackground: true, evaluationOptions: enterpriseEvaluationConfiguration(configuration.evaluationModels, env), organizations: configuration.organizations, platformQuotas: configuration.platformQuotas,
    ...(configuration.port === undefined ? {} : { port: configuration.port }),
    ...(configuration.webRoot === undefined ? {} : { webRoot: configuration.webRoot }),
    ...(configuration.loginOrganizations === undefined ? {} : { loginOrganizations: configuration.loginOrganizations }) };
}
async function main() {
  const file = process.env.MN_ENTERPRISE_CONFIG_FILE;
  if (!file) throw new Error('ENTERPRISE_CONFIG_FILE_REQUIRED');
  const configuration = JSON.parse(await readFile(file, 'utf8'));
  const host = await startEnterpriseLocalHost(enterprisePlatformOptions(configuration));
  process.stdout.write(`木牛企业入口已启动，模式=${configuration.profile}，地址=${host.address.host}:${host.address.port}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void host.close().catch(() => { process.exitCode = 1; }); });
}
let directlyInvoked = false;
try { directlyInvoked = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (directlyInvoked) main().catch(() => { process.stderr.write('企业入口启动失败，请核对独立状态目录、Keychain 和 OIDC 配置。\n'); process.exitCode = 1; });
