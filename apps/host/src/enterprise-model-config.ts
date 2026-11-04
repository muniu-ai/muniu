// SPDX-License-Identifier: Apache-2.0
import { EnterpriseError } from '@mn/enterprise-services';
import type { EvaluationModel } from './enterprise-evaluation.js';
export function enterpriseEvaluationConfiguration(value: unknown, environment: Readonly<Record<string, string | undefined>> = process.env) {
  const bindings = new Map<string, EvaluationModel[]>(), credentials = new Map<string, string>();
  const fail = (): never => { throw new EnterpriseError('ENTERPRISE_MODEL_CONFIG_INVALID', 503); };
  if (value !== undefined && (!Array.isArray(value) || value.length > 100)) fail();
  for (const entry of value as readonly Record<string, unknown>[] | undefined ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).sort().join(',') !== 'id,modelId,providerId,secretEnvironment,tenantId,version,workspaceId'
      || ['id', 'modelId', 'providerId', 'secretEnvironment', 'tenantId', 'workspaceId'].some(k => typeof entry[k] !== 'string' || !(entry[k] as string).trim() || (entry[k] as string).length > 200)
      || !Number.isSafeInteger(entry.version) || Number(entry.version) < 1 || !['openai', 'deepseek', 'anthropic', 'moonshot', 'qwen'].includes(String(entry.providerId))
      || !/^MN_ENTERPRISE_MODEL_[A-Z0-9_]+$/u.test(String(entry.secretEnvironment))) fail();
    const key = JSON.stringify([entry.tenantId, entry.workspaceId]), models = bindings.get(key) ?? []; if (models.some(model => model.id === entry.id)) fail();
    const secretRef = 'env://muniu.enterprise/' + entry.secretEnvironment;
    models.push({ id: String(entry.id), version: Number(entry.version), providerId: entry.providerId as EvaluationModel['providerId'], modelId: String(entry.modelId), secretRef, mode: 'live' }); bindings.set(key, models);
    credentials.set(secretRef, String(entry.secretEnvironment));
  }
  return { modelFor(tenantId: string, workspaceId: string): EvaluationModel | undefined { const model = bindings.get(JSON.stringify([tenantId, workspaceId]))?.[0]; return model ? structuredClone(model) : undefined; },
    modelsFor(tenantId: string, workspaceId: string): readonly EvaluationModel[] { return structuredClone(bindings.get(JSON.stringify([tenantId, workspaceId])) ?? []); },
    secretStore: { async read(reference: string): Promise<string> { const name = credentials.get(reference), secret = name ? environment[name] : undefined;
      if (!secret?.trim()) throw new EnterpriseError('MODEL_CREDENTIAL_UNAVAILABLE', 503); return secret; } } };
}
