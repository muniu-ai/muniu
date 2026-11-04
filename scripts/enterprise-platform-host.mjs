// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { enterpriseEvaluationConfiguration } from '../apps/host/dist/enterprise-model-config.js';
import { startEnterpriseLocalHost } from '../apps/host/dist/enterprise-local.js';
async function main() {
  const file = process.env.MN_ENTERPRISE_CONFIG_FILE;
  if (!file) throw new Error('ENTERPRISE_CONFIG_FILE_REQUIRED');
  const configuration = JSON.parse(await readFile(file, 'utf8'));
  if (!configuration || !['development', 'hosted'].includes(configuration.profile) || !Array.isArray(configuration.organizations)
    || typeof configuration.providers !== 'object' || !configuration.providers) throw new Error('ENTERPRISE_CONFIG_INVALID');
  const providers = Object.fromEntries(Object.entries(configuration.providers).map(([tenantId, provider]) => {
    if (!provider || typeof provider.issuer !== 'string' || typeof provider.clientId !== 'string') throw new Error('ENTERPRISE_CONFIG_INVALID');
    return [tenantId, { issuer: provider.issuer, clientId: provider.clientId, ...(provider.clientSecretEnv ? { clientSecret: async () => {
      const secret = process.env[provider.clientSecretEnv]; if (!secret) throw new Error('OIDC_CLIENT_SECRET_REQUIRED'); return secret;
    } } : {}) }];
  }));
  const host = await startEnterpriseLocalHost({ origin: configuration.origin, profile: configuration.profile, providers,
    operatingBackground: true, evaluationOptions: enterpriseEvaluationConfiguration(configuration.evaluationModels), organizations: configuration.organizations, platformQuotas: configuration.platformQuotas, ...(configuration.port === undefined ? {} : { port: configuration.port }) });
  process.stdout.write(`木牛企业入口已启动，模式=${configuration.profile}，地址=${host.address.host}:${host.address.port}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void host.close().catch(() => { process.exitCode = 1; }); });
}
main().catch(() => { process.stderr.write('企业入口启动失败，请核对独立状态目录、Keychain 和 OIDC 配置。\n'); process.exitCode = 1; });
