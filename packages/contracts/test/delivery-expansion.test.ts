// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenApiDocument } from '../src/openapi.js';
test('Office 上传格式与受保护资料的公开契约一致', () => {
  const doc = (createOpenApiDocument() as any).components.schemas.CreateAssetsMutation.properties.attachments.items.properties.mediaType.enum as string[];
  assert.ok(doc.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  assert.ok(doc.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
});
