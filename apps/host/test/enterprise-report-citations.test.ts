// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReportCitations } from '../src/enterprise-report-citations.js';
import type { BusinessObjectRef, EvidenceRef, EnterpriseContractTypes } from '@mn/contracts';
const reference: BusinessObjectRef = { tenantId: 't', workspaceId: 'w', objectType: 'evidence_ref', objectId: 'doc', streamVersion: 1, digest: 'a'.repeat(64) };
const citation: EvidenceRef = { tenantId: 't', workspaceId: 'w', id: 'doc:block', sourceKind: 'raw_material', protectedContentRef: 'protected:doc', sourceVersion: '1', digest: 'b'.repeat(64), permissionRef: 'permission', locator: { page: 2 } };
const report = (): EnterpriseContractTypes['EnterpriseTaskReport'] => ({ status: 'complete', summary: '有出处的结论', findings: [{ text: '第二页的要求', sources: [reference], citations: [citation] }], acceptance: [{ criterion: '可核对', status: 'satisfied', sources: [reference], citations: [citation] }], unknown: [] });
const input = [{ reference, fields: { text: '第二页', citations: [citation] } }];
test('报告引用只能来自本次持久模型上下文，不能伪造页码、摘要或换成别的来源', () => {
  validateReportCitations(report(), input);
  for (const fake of [{ ...citation, locator: { page: 3 } }, { ...citation, digest: 'c'.repeat(64) }, { ...citation, tenantId: 'other' }]) {
    const base = report(), changed = { ...base, findings: [{ ...base.findings[0]!, citations: [fake] }] };
    assert.throws(() => validateReportCitations(changed, input), { code: 'TASK_CITATION_INVALID' });
  }
  assert.throws(() => validateReportCitations(report(), [{ reference: { ...reference, objectId: 'other' }, fields: input[0]!.fields }]), { code: 'TASK_CITATION_INVALID' });
});
test('完成判断必须逐项给出资料定位，缺少提取结果不能凭对象引用宣称已核验', () => {
  const base = report(), { citations: _citations, ...uncited } = base.acceptance[0]!, changed = { ...base, acceptance: [uncited] };
  assert.throws(() => validateReportCitations(changed, input), { code: 'TASK_CITATION_REQUIRED' });
  assert.throws(() => validateReportCitations(report(), [{ reference, fields: { text: '', citations: [] } }]), { code: 'TASK_CITATION_INVALID' });
});
