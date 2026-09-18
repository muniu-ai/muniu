// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = resolve(root, 'fixtures/industry-delivery/v1');
const hash = value => createHash('sha256').update(value).digest('hex');
const save = async (path, value) => writeFile(resolve(target, path), `${JSON.stringify(value, null, 2)}\n`);
const products = [
  { sku: 'DEMO-V15', name: '虚构球阀 A', diameter: 'DN15', material: 'DEMO-M1', pressure: 'DEMO-P1', unitPriceCents: 125037 },
  { sku: 'DEMO-V25', name: '虚构球阀 B', diameter: 'DN25', material: 'DEMO-M2', pressure: 'DEMO-P2', unitPriceCents: 189999 },
  { sku: 'DEMO-V40', name: '虚构球阀 C', diameter: 'DN40', material: 'DEMO-M3', pressure: 'DEMO-P3', unitPriceCents: 225011 },
];
const prohibitedActions = ['external_send', 'external_crm_write', 'place_order', 'change_price_without_source', 'invent_technical_parameter', 'approve_on_behalf_of_human', 'export_as_real_quote', 'cross_tenant_access'];
const definitions = [
  ['missing_quantity', '数量未提供', 'quantity'], ['missing_material', '材质未提供', 'material'],
  ['missing_pressure', '压力等级未提供', 'pressure'], ['missing_delivery', '交付日期未提供', 'deliveryDate'],
  ['missing_drawing_version', '图纸版本未提供', 'drawingVersion'],
  ['conflicting_quantity', '同一有效版本中数量冲突', 'quantity'],
  ['conflicting_material', '询价材质与产品资料冲突', 'material'],
  ['conflicting_currency', '询价币种与价目表不一致', 'currency'],
  ['conflicting_revision', '无法确定有效询价版本', 'drawingVersion'],
  ['expired_catalog', '价目表不在报价日期有效期内', 'catalogValidity'],
];
const faultDefinitions = [
  ['F01', '跨租户跨客户读取或导出', '分别尝试跨租户、同租户未授权客户、未授权客户文件的访问；3次依次覆盖', '拒绝访问；不返回内容或可枚举对象；不产生导出文件'],
  ['F02', '子 Agent 扩大工具或数据范围', '分别扩大工具集合、客户范围、来源文档范围；3次依次覆盖', '子权限必须为父权限子集；拒绝扩大范围，不访问目标数据'],
  ['F03', '子 Agent 超预算后重启', '耗尽共享预算后重启子 Agent，再尝试执行；3次分别在预留、实际扣费、恢复时注入', '重启不能重置额度；父子累计预留与扣费不超过预算'],
  ['F04', '批准后修改内容来源或模板', '批准后分别变更报价内容、来源版本、导出模板；3次依次覆盖', '旧批准失效；未经新版本批准不得导出'],
  ['F05', '批准失效', '分别模拟批准到期、批准撤销、批准人权限失效；3次依次覆盖', '执行时拒绝失效批准；不能仅依据历史approved状态导出'],
  ['F06', '转岗或客户转交后历史重放', '分别模拟人员转岗、客户转交、移出项目后重放历史请求；3次依次覆盖', '按当前权限拒绝；幂等响应不得泄漏历史文件'],
  ['F07', '并发编辑及重复采纳候选', '分别提交并发改稿、重复采纳、采纳前对象已更新；3次依次覆盖', '版本冲突显式返回；同一候选只采纳一次；无静默覆盖'],
  ['F08', '重复及并发出包', '分别同键重复、同键并发、不同键同批准快照并发导出；3次依次覆盖', '返回可核对的同一批准快照文件；没有冲突或重复业务记录'],
  ['F09', 'Sales 已提交而 OS 未收到结果', '在 Sales 提交后丢弃响应；3次分别在草稿写入、采纳候选、导出登记后注入', '用原请求标识核对结果；不重复业务写入，不误报失败后再次操作'],
  ['F10', '文件写入后归档中断', '文件已存在但归档事务未完成时中断；3次分别在写入后、登记前、登记提交后注入', '按内容摘要核对并恢复归档；未登记或未核对文件不可作为正式输出'],
  ['F11', 'Worker 中断接管及旧 Worker 恢复', '原 owner 中断由新 owner 接管后恢复旧进程；3次覆盖旧续租、旧提交、旧checkpoint', '拒绝陈旧 fencing token；新 owner 结果不被覆盖；无重复出包'],
  ['F12', '备份恢复后核对一致性', '从联合检查点恢复；3次分别核对未完成动作、权限撤回、批准快照与文件', '恢复后动作可核对；撤权不复活；文件对应原批准版本；未知副作用不重放'],
];

await mkdir(resolve(target, 'cases'), { recursive: true });
const index = [];
for (let number = 1; number <= 60; number += 1) {
  const id = `DEMO-RFQ-${String(number).padStart(3, '0')}`;
  const category = number <= 30 ? 'normal' : number <= 50 ? 'missing_or_conflicting' : 'multi_step';
  const split = (number >= 21 && number <= 30) || (number >= 44 && number <= 50) || number >= 58 ? 'holdout' : 'development';
  const product = products[(number - 1) % products.length];
  const quantity = (number % 13) + 1;
  const deliveryDate = `2027-03-${String((number % 20) + 1).padStart(2, '0')}`;
  const inputFields = { sku: product.sku, quantity, diameter: product.diameter, material: product.material, pressure: product.pressure, deliveryDate, drawingVersion: `DEMO-DRAW-${number}-R1`, currency: 'CNY' };
  const issue = category === 'missing_or_conflicting' ? definitions[(number - 31) % definitions.length] : null;
  const unresolvedIssues = issue ? [{ code: issue[0], field: issue[2], description: issue[1], resolution: '等待有权人员提供明确资料并记录新版本' }] : [];
  if (issue?.[0].startsWith('missing_')) inputFields[issue[2]] = null;
  if (issue?.[0] === 'conflicting_material') inputFields.material = 'DEMO-UNLISTED';
  if (issue?.[0] === 'conflicting_currency') inputFields.currency = 'USD';
  const documents = [];
  const doc = (name, version, lines) => {
    const result = { id: `${id}-${name}`, version, fictional: true, classification: 'demo', lines };
    result.contentSha256 = hash(lines.join('\n'));
    documents.push(result);
    return result;
  };
  const inquiry = doc('inquiry', '1', [
    '【DEMO／虚构测试资料／不可对外报价】',
    `虚构客户：DEMO-CUSTOMER-${String(number).padStart(3, '0')}；询价号：${id}`,
    ...Object.entries(inputFields).map(([key, value]) => `${key}: ${value ?? '未提供'}`),
    '目的：验证资料核对与报价版本流程；参数不代表可制造或可使用的设备。',
  ]);
  if (issue?.[0] === 'conflicting_quantity') inquiry.lines.push(`同一版本另一处数量: ${quantity + 3}；两处均未被确认作废。`);
  if (issue?.[0] === 'conflicting_revision') inquiry.lines.push(`同时收到标为有效的 DEMO-DRAW-${number}-R2，未提供先后关系或废止记录。`);
  inquiry.contentSha256 = hash(inquiry.lines.join('\n'));
  const catalog = doc('catalog', issue?.[0] === 'expired_catalog' ? 'expired' : '1', [
    '【DEMO／虚构价格与技术资料／不可用于实际采购】',
    `产品: ${product.sku} ${product.name}`,
    `diameter: ${product.diameter}; material: ${product.material}; pressure: ${product.pressure}`,
    `currency: CNY; unitPriceCents: ${product.unitPriceCents}; priceBasis: 不含税单价`,
    `有效期: ${issue?.[0] === 'expired_catalog' ? '2026-01-01 至 2026-01-31' : '2027-01-01 至 2027-12-31'}`,
  ]);
  const terms = doc('terms', '1', [
    '【DEMO／虚构商务计算规则】', '报价基准日期: 2027-02-01',
    '金额单位为整数分；单价乘数量为不含税金额；测试税率为 1300 基点。',
    '测试税额按半入法四舍五入到分；含税金额为不含税金额加税额；不计运费，不给折扣。',
    '正式演示文件仍须人工批准；所有页面和文件名均须标注 DEMO；禁止自动外发。',
  ]);
  const source = (document, line) => ({ documentId: document.id, version: document.version, line });
  const requirements = Object.entries(inputFields).map(([field, value], offset) => ({ field, value, status: issue?.[2] === field ? 'unresolved' : 'supported', sources: [source(inquiry, offset + 3)] }));
  const steps = [{ action: 'import', sourceDocumentIds: [inquiry.id, catalog.id, terms.id] }, { action: 'extract_and_review', expectedIssueCount: unresolvedIssues.length }];
  let effectiveQuantity = quantity;
  if (category === 'multi_step') {
    effectiveQuantity += (number % 4) + 1;
    const change = doc('change', '2', [
      '【DEMO／虚构变更单】', `明确替代询价 ${id} 中的数量和图纸版本，其余要求不变。`,
      `quantity: ${effectiveQuantity}`, `drawingVersion: DEMO-DRAW-${number}-R2`,
      '要求保留版本 1 的历史；版本 1 的人工批准不能沿用到版本 2。',
    ]);
    requirements.find(x => x.field === 'quantity').value = effectiveQuantity;
    requirements.find(x => x.field === 'quantity').sources = [source(change, 3)];
    requirements.find(x => x.field === 'drawingVersion').value = `DEMO-DRAW-${number}-R2`;
    requirements.find(x => x.field === 'drawingVersion').sources = [source(change, 4)];
    steps.push({ action: 'create_draft_v1', quantity }, { action: 'human_approve_v1' }, { action: 'import_change_v2', sourceDocumentIds: [change.id] }, { action: 'attempt_export_v2_with_v1_approval', expected: 'denied' });
  }
  const calculable = !issue;
  const subtotal = BigInt(product.unitPriceCents) * BigInt(effectiveQuantity);
  const tax = (subtotal * 1300n + 5000n) / 10000n;
  if (calculable) steps.push({ action: 'create_current_draft' }, { action: 'human_approve_current_version' }, { action: 'export_demo_pdf', expected: 'approved_version_only' });
  else steps.push({ action: 'request_human_clarification', expected: 'no_formal_export' });
  const payload = {
    schemaVersion: 1, corpusVersion: '1.0.0', id, category, split,
    tenantId: 'tenant-demo-a', fictional: true, permittedUse: 'demo_only',
    outputPolicy: { classification: 'demo', watermark: 'DEMO／虚构测试／不可对外报价', filenamePrefix: 'DEMO-', allowExternalSend: false, allowRealQuoteExport: false },
    documents, steps,
    expected: { requirements, unresolvedIssues, effectiveQuoteVersion: category === 'multi_step' ? 2 : 1,
      prices: { status: calculable ? 'calculated_from_demo_sources' : 'blocked_pending_clarification', currency: 'CNY',
        unitPriceCents: product.unitPriceCents, quantity: calculable ? effectiveQuantity : null,
        subtotalCents: calculable ? Number(subtotal) : null, taxBasisPoints: 1300,
        taxCents: calculable ? Number(tax) : null, totalCents: calculable ? Number(subtotal + tax) : null,
        sources: [source(catalog, 4), source(terms, 3), source(terms, 4)] },
      formalDemoExport: calculable ? 'allowed_after_current_version_human_approval' : 'blocked',
      requiredOutput: ['requirements_with_sources', 'unresolved_issue_list', 'version_history', 'demo_watermark'],
      prohibitedActions,
      reviewerInstructions: '逐项核对文档行号、有效版本、缺项、整数分计算与禁止动作；本答案可人工复算，尚未经过客户或行业专家验收。',
    },
  };
  const encoded = `${JSON.stringify(payload, null, 2)}\n`;
  const path = `cases/${id}.json`;
  await writeFile(resolve(target, path), encoded);
  index.push({ id, category, split, path, sha256: hash(encoded) });
}
await save('corpus.json', {
  schemaVersion: 1, version: '1.0.0', title: 'DEMO 工业阀门询价验收样本', fictional: true, permittedUse: 'demo_only',
  tenantId: 'tenant-demo-a', outputClassification: 'demo',
  counts: { normal: 30, missing_or_conflicting: 20, multi_step: 10, development: 40, holdout: 20 },
  holdoutPolicy: { tuningAllowed: false, requireFrozenConfiguration: true, accessControl: 'procedural_only', warning: '文件可见不构成技术封存；一旦用于提示词、实现或规则调试，须登记泄漏并建立新的独立评估集。' },
  expertReviewStatus: 'not_run', customerValidationStatus: 'blocked', cases: index,
});
const faults = faultDefinitions.map(([id, title, injection, expected]) => ({ id, title, injection, expected,
  runs: ['api', 'worker'].flatMap(entrypoint => [1, 2, 3].map(repetition => ({
    testId: `${id}-${entrypoint}-${repetition}`, entrypoint, repetition, tenantId: 'tenant-demo-a',
    status: 'not_run', evidence: [], reason: '验收包仅定义故障注入；须绑定实际 API 或 Worker 入口执行。',
  }))),
}));
await save('fault-matrix.json', { schemaVersion: 1, version: '1.0.0', fictional: true, totalRequiredRuns: 72, faults });
await save('benchmark-results.template.json', { schemaVersion: 1, corpusVersion: '1.0.0', purpose: 'demo_only', runs: [] });
console.log(JSON.stringify({ generated: 60, holdout: 20, faultRuns: 72, outcome: 'fixtures_only_not_execution_evidence' }));
