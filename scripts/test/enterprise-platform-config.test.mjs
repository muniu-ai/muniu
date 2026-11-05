// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { enterprisePlatformOptions } from '../enterprise-platform-host.mjs';

const configuration = {
  origin: 'https://enterprise.example.test', profile: 'development',
  organizations: [{ tenantId: 'private-tenant', name: '非公开企业', issuer: 'https://issuer.example.test', maxMembers: 5, administrator: { id: 'admin', subject: 'admin', displayName: '管理员' } }],
  providers: { 'private-tenant': { issuer: 'https://issuer.example.test', clientId: 'fixture', clientSecretEnv: 'MN_ENTERPRISE_TEST_CLIENT_SECRET' } },
};

test('企业启动配置默认不启用 Web 或公开企业目录，构造配置不读取凭据', () => {
  const options = enterprisePlatformOptions(configuration, new Proxy({}, { get() { throw new Error('credential-read-before-use'); } }));
  assert.equal(Object.hasOwn(options, 'webRoot'), false);
  assert.equal(Object.hasOwn(options, 'loginOrganizations'), false);
  assert.deepEqual(options.organizations, configuration.organizations);
  assert.equal(options.providers['private-tenant'].issuer, configuration.providers['private-tenant'].issuer);
});

test('企业启动配置仅透传显式静态目录和登录白名单，保留其他企业的非公开状态', () => {
  const published = [{ id: 'private-tenant', name: '管理员指定的公开入口' }];
  const options = enterprisePlatformOptions({ ...configuration, webRoot: '/synthetic/enterprise-web', loginOrganizations: published }, {});
  assert.equal(options.webRoot, '/synthetic/enterprise-web');
  assert.deepEqual(options.loginOrganizations, published);
  assert.deepEqual(enterprisePlatformOptions({ ...configuration, loginOrganizations: [] }, {}).loginOrganizations, []);
  assert.throws(() => enterprisePlatformOptions({ ...configuration, webRoot: 123 }, {}), /ENTERPRISE_CONFIG_INVALID/);
  assert.throws(() => enterprisePlatformOptions({ ...configuration, loginOrganizations: 'all' }, {}), /ENTERPRISE_CONFIG_INVALID/);
});
