// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
const REQUIREMENTS = ['B01', 'B02', 'B03', 'A01', 'A02', 'A03', 'R01', 'R02', 'R03', 'R04', 'R05', 'P01', 'P02', 'K01', 'C01', 'C02', 'U01'];
const FLOWS = ['opportunity', 'quote', 'delivery', 'receivable', 'review'];
const check = (condition, message) => { if (!condition) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const unique = (items, field, label) => {
  check(Array.isArray(items), `${label}必须是数组`);
  check(items.every(item => nonempty(item?.[field])), `${label}缺少标识`);
  check(new Set(items.map(item => item[field])).size === items.length, `${label}标识重复`);
};

export function verifyAcceptanceDigest(source, lock) {
  check(lock.schemaVersion === 1 && nonempty(lock.version), '冻结记录版本无效');
  check(createHash('sha256').update(source).digest('hex') === lock.sha256, '验收基线摘要已变化；必须发布经审阅的新基线版本');
  check(JSON.parse(source).version === lock.version, '冻结版本不一致');
}

/** Validates acceptance materials, never marks a product or external integration as passed. */
export function validateAcceptanceSpec(spec) {
  check(spec.schemaVersion === 1 && spec.purpose === 'acceptance_specification_only', '验收规格版本无效');
  check(JSON.stringify(spec.modes) === JSON.stringify(['builtin', 'sales']), '两模式必须独立验收');
  check(spec.currency === 'CNY' && spec.businessTimezone === 'Asia/Shanghai', '业务金额和日期口径不符');
  unique(spec.scenarios, 'id', '场景'); unique(spec.tasks, 'id', '任务'); unique(spec.safetyTasks, 'id', '安全任务');
  unique(spec.requirements, 'id', '要求'); unique(spec.gates, 'command', '门禁');
  const requirements = new Set(spec.requirements.map(item => item.id));
  check(requirements.size === REQUIREMENTS.length && REQUIREMENTS.every(id => requirements.has(id)), 'B01—U01 要求缺失');
  const gates = new Set(spec.gates.map(item => item.command));
  for (const item of spec.gates) check(nonempty(item.owner) && nonempty(item.purpose) && item.status === 'not_implemented'
    && item.evidenceStatus === 'not_run', '冻结门禁登记不能冒充执行结果');
  for (const item of spec.requirements) check(item.owners?.length && item.gates?.length && item.gates.every(gate => gates.has(gate)), '要求缺少负责包或使用未知门禁');
  check(spec.scenarios.length === 30 && spec.tasks.length === 60, '两模式必须各有 30 项独立任务');
  const scenarios = new Map(spec.scenarios.map(item => [item.id, item]));
  for (const scenario of spec.scenarios) {
    check(FLOWS.includes(scenario.flow) && nonempty(scenario.title) && scenario.input && typeof scenario.input === 'object'
      && !Array.isArray(scenario.input) && Object.keys(scenario.input).length > 0 && scenario.expected?.length
      && scenario.expected.every(nonempty), '场景缺少输入、预期或流程');
    check(['development', 'holdout'].includes(scenario.partition), '场景划分无效');
    check(scenario.requirements?.length && scenario.requirements.every(id => requirements.has(id)), '场景要求映射无效');
  }
  for (const mode of spec.modes) {
    const tasks = spec.tasks.filter(task => task.mode === mode);
    check(tasks.length === 30 && new Set(tasks.map(task => task.scenarioId)).size === 30, '两模式任务配对不完整');
    for (const task of tasks) {
      const scenario = scenarios.get(task.scenarioId);
      check(scenario && task.partition === scenario.partition && task.rounds === 3, '任务场景、划分或轮数无效');
      check(Object.keys(task).every(key => ['id', 'scenarioId', 'mode', 'tenantId', 'partition', 'rounds', 'executionStatus'].includes(key)), '配对任务不能覆盖共享输入与预期');
      check(task.tenantId === `tenant-${mode}`, '配对任务租户不匹配');
      check(task.executionStatus === 'not_run', '基线不能携带未经执行的执行结果');
    }
    check(tasks.filter(task => task.partition === 'development').length === 20 && tasks.filter(task => task.partition === 'holdout').length === 10, '调试与留出划分必须为 20/10');
    for (const flow of FLOWS) {
      const subset = tasks.filter(task => scenarios.get(task.scenarioId).flow === flow);
      check(subset.length === 6 && subset.filter(task => task.partition === 'holdout').length === 2, '每流程任务必须含四项调试和两项留出');
    }
  }
  check(spec.safetyTasks.length >= 20, '安全恢复任务少于 20 项');
  for (const task of spec.safetyTasks) check(requirements.has(task.requirement) && nonempty(task.injection) && nonempty(task.expected)
    && task.executionStatus === 'not_run' && task.rounds === 3 && task.modes?.length
    && task.modes.every(mode => spec.modes.includes(mode)), '安全任务缺少故障输入、预期或伪造执行结果');
  const covered = new Set([...spec.scenarios.flatMap(item => item.requirements), ...spec.safetyTasks.map(item => item.requirement)]);
  check(REQUIREMENTS.every(id => covered.has(id)), '关键要求没有绑定任务');
  for (const item of spec.legacyCoverage) check(nonempty(item.path) && !item.path.includes('..') && !item.path.startsWith('/')
    && nonempty(item.invariant) && item.requirements?.length && item.requirements.every(id => requirements.has(id))
    && item.removalAllowed === false && item.replacementStatus === 'not_implemented', '旧测试缺少替代覆盖或被提前删除');
  for (const item of spec.legacyUiGates) check(nonempty(item.command) && item.replacementGates?.length
    && item.replacementGates.every(gate => gates.has(gate)) && item.removalAllowed === false, '旧测试 UI 门禁映射无效');
  const company = spec.syntheticCompany;
  check(company.realCustomerData === false && company.identityMode === 'test_oidc_only', '合成企业不能使用真实客户与生产身份');
  unique(company.members, 'id', '合成成员');
  const members = new Set(company.members.map(member => member.id));
  const amount = value => Number.isSafeInteger(value) && value >= 0;
  check(amount(company.order.totalMinor) && company.paymentSchedules.every(period => amount(period.amountMinor) && period.orderId === company.order.id)
    && company.paymentSchedules.reduce((sum, period) => sum + period.amountMinor, 0) === company.order.totalMinor, '合成付款期金额与订单不一致');
  for (const receipt of company.receipts) check(amount(receipt.amountMinor) && members.has(receipt.preparedBy) && members.has(receipt.approvedBy)
    && receipt.preparedBy !== receipt.approvedBy, '合成收款违反职责分离');
  check(spec.rubric.frozen === true && spec.rubric.humanBaselineRunsPerTask === 1 && spec.rubric.agentRunsPerTask === 3
    && spec.rubric.publicationPartition === 'holdout' && spec.rubric.requiredRunBindings?.length >= 8
    && nonempty(spec.rubric.runIsolation) && nonempty(spec.rubric.holdoutProtection), '评估量表未固定');
  check(spec.executionPrerequisites?.length >= 7 && spec.executionPrerequisites.every(item =>
    ['not_bound', 'not_verified'].includes(item.status) && nonempty(item.required) && item.gates.every(gate => gates.has(gate))), '真实执行前置条件记录无效');
  check(spec.rubric.thresholds.observationWorkdays === 10 && spec.rubric.thresholds.reviewedProactiveCandidates === 100
    && spec.rubric.thresholds.unauthorizedActions === 0 && spec.rubric.thresholds.humanActiveTimeReduction === '>=20%'
    && spec.rubric.thresholds.firstAcceptanceVsHuman === '>=1' && spec.rubric.thresholds.proactivePrecision === '>=90%', '验收阈值与计划不符');
  return { tasks: spec.tasks.length, scenarios: spec.scenarios.length, safetyTasks: spec.safetyTasks.length, requirements: requirements.size };
}
