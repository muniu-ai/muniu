// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { schemaType, renderResponseTypes } from '../lib/schema-types.mjs';

test('schema 类型保留引用、递归、联合、字典和二进制', () => {
  assert.equal(schemaType({ $ref: '#/components/schemas/Node' }), 'Node');
  assert.equal(schemaType({ type: 'string', format: 'binary' }), 'ArrayBuffer');
  assert.equal(schemaType({ type: 'array', items: { $ref: '#/components/schemas/Node' } }), 'readonly (Node)[]');
  assert.equal(schemaType({ anyOf: [{ type: 'null' }, { const: 'ready' }] }), '(null) | ("ready")');
  assert.equal(schemaType({ type: 'object', additionalProperties: { type: 'number' } }), '{ readonly [key: string]: number; }');
  assert.throws(() => schemaType({}), /Unsupported/);
  assert.throws(() => schemaType({ $ref: 'https://example.test/schema' }), /reference/);
});

test('响应类型只读取 schema，字段变更同时影响 DTO 和操作输出', () => {
  const render = (type) => renderResponseTypes({
    outputs: { getSample: { $ref: '#/components/schemas/OutputSample' } },
    components: { OutputSample: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type } } } },
    publicTypes: { Sample: 'OutputSample' },
  });
  assert.match(render('string'), /readonly "value": string/);
  assert.match(render('number'), /readonly "value": number/);
  assert.match(render('string'), /export type Sample = OutputSample/);
  assert.match(render('string'), /readonly getSample: OutputSample/);
  assert.throws(() => renderResponseTypes({ outputs: {}, components: {}, publicTypes: { Missing: 'Missing' } }), /Missing/);
});
