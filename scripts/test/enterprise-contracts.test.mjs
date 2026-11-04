// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['packages/contracts/src/enterprise-contracts.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const contract = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const { ENTERPRISE_CONTRACT_EXAMPLES: examples, parseEnterpriseContract: parse } = contract;
const apiCompiled = await build({ entryPoints: ['packages/contracts/src/openapi.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { createOpenApiDocument } = await import(`data:text/javascript;base64,${Buffer.from(apiCompiled.outputFiles[0].contents).toString('base64')}`);

test('每个核心契约包含事件、正例、撤权和过期版本的执行规格', () => {
  assert.equal(Object.keys(examples).length, 13);
  for (const [name, example] of Object.entries(examples)) {
    assert.deepEqual(parse(name, example.valid), example.valid, name);
    assert.match(example.eventType, /^enterprise\./);
    assert.equal(example.revoked.expectedCode, 'ACCESS_REVOKED');
    assert.equal(example.stale.expectedCode, 'STREAM_VERSION_CONFLICT');
    assert.ok(example.ownerPackage);
    assert.throws(() => parse(name, { ...example.valid, apiKey: 'protected-content' }), error => !String(error).includes('protected-content'));
  }
});

test('严格校验安全整数、摘要、日期与嵌套引用，不接受未知类型', () => {
  const ref = examples.BusinessObjectRef.valid;
  for (const streamVersion of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1, Infinity]) assert.throws(() => parse('BusinessObjectRef', { ...ref, streamVersion }));
  assert.throws(() => parse('BusinessObjectRef', { ...ref, digest: 'not-a-digest' }));
  const objective = examples.OperatingObjective.valid;
  assert.throws(() => parse('OperatingObjective', { ...objective, periodStart: '2026-02-30' }));
  assert.throws(() => parse('MissingType', ref));
});

test('未知动作回执不能同时声称已成功或附带成功结果', () => {
  const receipt = examples.ActionReceipt.valid;
  const { evidenceRefs, completedAt, ...unknown } = receipt;
  assert.doesNotThrow(() => parse('ActionReceipt', { ...unknown, status: 'unknown' }));
  assert.throws(() => parse('ActionReceipt', { ...receipt, status: 'unknown' }));
  assert.throws(() => parse('ActionReceipt', { ...unknown, status: 'succeeded' }));
});

test('目标接口不进入当前服务的 OpenAPI，五端口不含任意执行入口', () => {
  const paths = createOpenApiDocument().paths;
  for (const path of ['/v2/organizations', '/v2/actions/{actionId}', '/v2/events']) assert.equal(paths[path], undefined);
  assert.deepEqual(contract.ENTERPRISE_PROVIDER_PORTS, ['readSnapshot', 'listChanges', 'prepareAction', 'executeAction', 'getReceipt']);
  for (const operation of contract.ENTERPRISE_API_CATALOG) {
    assert.equal(operation.availability, 'planned');
    assert.ok(operation.path.startsWith('/v2/'));
    if (operation.kind === 'business_mutation') assert.equal(operation.idempotencyRequired, true);
  }
});

test('E2.2 查询响应固定余额、进度与成本字段，不容纳额外机密字段',()=>{
  const reference=examples.BusinessObjectRef.valid;
  const values={costsComplete:false,confirmedCostMinor:0,marginMinor:null,marginBasis:'order_value_minus_confirmed_cost'};
  assert.deepEqual(parse('EnterpriseProjectCosts',{reference,values}),{reference,values});
  assert.throws(()=>parse('EnterpriseProjectCosts',{reference,values:{...values,secret:'protected'}}));
  assert.throws(()=>parse('EnterpriseProjectCosts',{reference,values:{...values,confirmedCostMinor:0.1}}));
});
