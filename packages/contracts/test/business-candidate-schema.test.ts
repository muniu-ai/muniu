// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import * as schemas from '../src/business-api-schema.js';

test('候选命令 schema 仅复用三个领域变体，保留必填字段和数值约束', () => {
  const build = (schemas as any).opcBusinessCandidateCommandSchema;
  assert.equal(typeof build, 'function');
  const actual = build();
  const commands = (schemas.businessMutationSchema().properties as any).command.oneOf;
  assert.deepEqual(actual, { oneOf: commands.filter((value: any) => ['quote.create', 'delivery.record', 'review.record'].includes(value.properties.type.const)) });
  const [quote, delivery, review] = actual.oneOf;
  assert.equal(quote.additionalProperties, false);
  assert.ok(quote.required.includes('serviceVersion'));
  assert.equal(quote.properties.serviceVersion.minimum, 1);
  assert.equal(quote.properties.quantity.maximum, 10_000);
  assert.equal(quote.properties.discountMinor.type, 'string');
  assert.equal(delivery.properties.progressPercent.maximum, 100);
  assert.deepEqual(review.properties.period.required, ['start', 'end']);
  assert.ok(review.required.includes('nextDecisions'));
  quote.properties.serviceVersion.minimum = 0;
  assert.equal(build().oneOf[0].properties.serviceVersion.minimum, 1, '调用者不能改写后续请求的 schema');
});
