// SPDX-License-Identifier: Apache-2.0
import type { EnterpriseContractTypes } from '@mn/contracts';
type Definition = EnterpriseContractTypes['EnterpriseWorkflowDefinition'];
const flow = (flowId: Definition['flowId'], title: string, sourceTypes: string[], acceptanceCriteria: string[], humanDecisions: string[], instruction: string): Definition => ({ flowId, title, sourceTypes, acceptanceCriteria, humanDecisions, stages: [
  { id: 'analyze', capabilityId: 'business.analyze', instruction },
  { id: 'review', capabilityId: 'business.review', instruction: '复核资料缺项、来源版本、金额计算口径和权限；列出未解决的承诺与不确定性。' },
  { id: 'summarize', capabilityId: 'business.summarize', instruction: '整理可回源的候选与人员待办；不得把建议、模型文字或发送提醒当作客户确认、批准或到账事实。' },
] });
export const BUSINESS_WORKFLOWS: readonly Definition[] = [
  flow('opportunity', '商机跟进', ['customer', 'opportunity'], ['责任人与跟进依据可核对', '缺失需求与下一步分别列明'], ['客户归属', '销售承诺', '对外发送'], '核对需求、阶段和跟进记录，区分客户回应、人员记录和建议；获准内部待办由动作协议执行。'),
  flow('quote', '方案报价', ['opportunity', 'service_version', 'quote_version'], ['报价引用有效服务与报价版本', '条款缺项及人员批准状态可核对'], ['正式报价与折扣', '合同条款', '客户接受', '订单生效'], '整理需求与方案，引用领域规则计算的整数分金额，核查条款；正式文件出包必须经过业务与执行批准。'),
  flow('delivery', '项目交付', ['order', 'project', 'delivery_version'], ['交付范围与版本可核对', '客户验收和未完成承诺分别列明'], ['范围与费用变更', '内部接收', '客户验收'], '对照生效订单、里程碑和资源拆解交付，核查延期与范围；内部成果接收不等于客户验收。'),
  flow('receivable', '应收跟进', ['order', 'payment_schedule', 'receipt'], ['应收余额引用固定口径与来源', '到期事项及下一步可核对'], ['对外催收', '到账登记', '退款登记'], '引用领域规则的付款计划、有效收款和调整计算结果，识别到期事项、准备催收草稿；发送提醒不能认定到账。'),
  flow('review', '经营复盘', ['operating_objective', 'business_review'], ['期间口径与来源版本固定', '偏差建议与后续工作有依据'], ['下周期目标', '资源调整', '预算调整'], '对照期间目标与领域规则形成的业务、成本和用量指标解释偏差，保留缺项；不得自行改变指标算法或财务事实。'),
];
