// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { enterpriseEvaluationConfiguration } from '../src/enterprise-model-config.js';
test('模型配置按企业与工作区选择，只读取新企业凭据命名空间', async () => {
  const env = { MN_ENTERPRISE_MODEL_TEST: 'synthetic-only', LEGACY_SECRET: 'must-not-read' };
  const binding = { tenantId: 'tenant', workspaceId: 'workspace', id: 'intake', version: 1, providerId: 'openai', modelId: 'gpt-4.1-mini', secretEnvironment: 'MN_ENTERPRISE_MODEL_TEST' };
  const config = enterpriseEvaluationConfiguration([binding], env);
  assert.equal(config.modelFor('other', 'workspace'), undefined);
  const model = config.modelFor('tenant', 'workspace')!;
  assert.equal(model.mode, 'live'); assert.equal(await config.secretStore.read(model.secretRef), 'synthetic-only');
  await assert.rejects(config.secretStore.read('env://muniu.enterprise/LEGACY_SECRET'));
  assert.throws(() => enterpriseEvaluationConfiguration([{ ...binding, secretEnvironment: 'LEGACY_SECRET' }], env));
  assert.throws(() => enterpriseEvaluationConfiguration([binding, binding], env));
  assert.equal(enterpriseEvaluationConfiguration(undefined, env).modelFor('tenant', 'workspace'), undefined);
});
