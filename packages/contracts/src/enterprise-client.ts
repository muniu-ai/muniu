// SPDX-License-Identifier: Apache-2.0
import { ENTERPRISE_HTTP_OPERATIONS } from './enterprise-api-schema.js';
import { parseEnterpriseContract } from './enterprise-contracts.js';
import type { EnterpriseApiInputs, EnterpriseApiOutputs } from './enterprise-api-types.js';
export type { EnterpriseApiInputs, EnterpriseApiOutputs } from './enterprise-api-types.js';
export type EnterpriseOperationId = keyof EnterpriseApiInputs;
export function enterpriseRequest<K extends EnterpriseOperationId>(id: K, input: EnterpriseApiInputs[K]) {
  const operation = ENTERPRISE_HTTP_OPERATIONS.find(item => item.id === id);
  if (!operation) throw new Error('企业 API 操作不存在');
  if ('body' in operation) parseEnterpriseContract(operation.body, (input as { body?: unknown }).body);
  if (operation.mutation) {
    const headers = (input as { headers?: Record<string, unknown> }).headers;
    if (!headers || ['Idempotency-Key', 'X-CSRF-Token'].some(name => typeof headers[name] !== 'string' || !(headers[name] as string).trim())
      || Object.keys(headers).some(name => !['Idempotency-Key', 'X-CSRF-Token'].includes(name))) throw new Error('企业 API 写入头无效');
  }
  const params = (input.path ?? {}) as Readonly<Record<string,string>>;
  const path = operation.path.replace(/\{([^}]+)\}/gu, (_match, key: string) => {
    const value = params[key];
    if (typeof value !== 'string' || !value || value === '.' || value === '..') throw new Error('企业 API 路径参数无效');
    return encodeURIComponent(value);
  });
  return { path, method: operation.method.toUpperCase(), ...('body' in input ? { body: input.body } : {}),
    ...('headers' in input ? { headers: input.headers } : {}) };
}
export function parseEnterpriseResponse<K extends EnterpriseOperationId>(id: K, envelope: unknown): EnterpriseApiOutputs[K] {
  const operation = ENTERPRISE_HTTP_OPERATIONS.find(item => item.id === id);
  if (!operation || !envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('企业 API 响应格式无效');
  const value = envelope as Record<string,unknown>;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || !Object.hasOwn(value, 'traceId') || !Object.hasOwn(value, 'data')
    || typeof value.traceId !== 'string' || Object.keys(value).some(key => !['data', 'traceId'].includes(key))) throw new Error('企业 API 响应格式无效');
  return parseEnterpriseContract(operation.response, value.data) as EnterpriseApiOutputs[K];
}
