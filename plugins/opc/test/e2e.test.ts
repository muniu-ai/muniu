import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryOpcRepository,
  OPC_DELIVERABLE_OUTCOMES,
  OpcService,
  createOpportunityDraft,
  exportOpportunityDeliverables,
  renderDeliverablesAsText,
  type Actor,
} from "../src/index.js";

const HUMAN: Actor = { id: "owner", kind: "human" };
const AGENT: Actor = { id: "validator", kind: "agent" };

test("确定性 E2E：捕获、支持与反证、访谈、待验证方案、人工承诺、决策和完整导出", async () => {
  let id = 0;
  const service = new OpcService({
    repository: new InMemoryOpcRepository(),
    clock: () => "2026-09-04T09:00:00.000Z",
    createId: (prefix) => `${prefix}-${++id}`,
  });
  const base = { workspaceId: "workspace", opportunityId: "opportunity", actor: HUMAN };
  let opportunity = await service.capture({
    ...base,
    expectedStreamVersion: 0,
    draft: createOpportunityDraft("目标客户：独立开发者；问题：不会做有效访谈；假设：一周访谈包能促成付费试用"),
  });
  opportunity = await service.frame({
    ...base,
    expectedStreamVersion: opportunity.streamVersion,
    targetCustomer: "独立开发者",
    problem: "不会做有效访谈",
    falsifiableHypothesis: "五次访谈中至少一人承诺付费试用",
  });
  opportunity = await service.startResearch({ ...base, actor: AGENT, expectedStreamVersion: opportunity.streamVersion });
  opportunity = await service.recordSignal({
    ...base,
    actor: AGENT,
    expectedStreamVersion: opportunity.streamVersion,
    signal: {
      sourceKind: "public_web",
      sourceUrl: "https://example.com/research",
      observedAt: "2026-09-04T08:30:00.000Z",
      excerpt: "访谈准备耗时",
      summary: "目标群体会搜索访谈模板",
      relationship: "support",
      evidenceKind: "context",
    },
  });
  opportunity = await service.recordSignal({
    ...base,
    actor: AGENT,
    expectedStreamVersion: opportunity.streamVersion,
    signal: {
      sourceKind: "pasted",
      observedAt: "2026-09-04T08:40:00.000Z",
      excerpt: "免费模板已经很多",
      summary: "现有免费替代方案降低付费意愿",
      relationship: "oppose",
      evidenceKind: "context",
    },
  });
  opportunity = await service.startInterviewing({ ...base, actor: AGENT, expectedStreamVersion: opportunity.streamVersion });
  opportunity = await service.recordInterview({
    ...base,
    expectedStreamVersion: opportunity.streamVersion,
    interviewId: "interview-a",
    participantRef: "受访者 A",
    occurredAt: "2026-09-03T10:00:00.000Z",
    rawRecordAssetId: "asset-interview-a",
  });
  opportunity = await service.annotateInterview({
    ...base,
    actor: AGENT,
    expectedStreamVersion: opportunity.streamVersion,
    interviewId: "interview-a",
    annotation: "问题集中在访谈质量，而不是模板数量",
  });
  opportunity = await service.startEvaluation({ ...base, actor: AGENT, expectedStreamVersion: opportunity.streamVersion });
  opportunity = await service.recordExperiment({
    ...base,
    actor: AGENT,
    expectedStreamVersion: opportunity.streamVersion,
    experiment: {
      question: "受访者是否会采取明确的下一步",
      method: "提供七天试用方案并记录回应",
      successCriterion: "至少一人承诺试用",
      status: "planned",
    },
  });
  assert.equal(opportunity.experiments.length, 1);

  const interviewRawRecords = new Map([["asset-interview-a", "我下载过模板，但不知道问题是否带有诱导性。"]]);
  const beforeCommitment = exportOpportunityDeliverables(opportunity, { interviewRawRecords });
  const beforeText = renderDeliverablesAsText(beforeCommitment);
  assert.match(beforeText, /方案待验证/u);
  assert.doesNotMatch(beforeText, /已验证/u);
  assert.match(beforeText, /支持证据/u);
  assert.match(beforeText, /反证/u);
  assert.match(beforeText, /证据缺口/u);

  opportunity = await service.prepareOffer({
    ...base,
    actor: AGENT,
    expectedStreamVersion: opportunity.streamVersion,
    offer: {
      targetCustomer: "独立开发者",
      promisedOutcome: "七天内形成继续或停止的证据",
      inScope: ["访谈提纲", "证据账本"],
      outOfScope: ["代替访谈", "自动外联"],
      price: { amountMinor: "9900", currency: "CNY", assumption: "首批测试价" },
      deliveryFormat: "在线文档与复盘会",
      duration: "7 天",
      acceptanceMethod: "完成五次访谈并形成结论",
      nextCustomerAction: "确认参与试用",
      risks: ["样本招募不足"],
    },
  });
  opportunity = await service.proposeCommitmentEvidence({
    ...base,
    actor: AGENT,
    expectedStreamVersion: opportunity.streamVersion,
    evidence: { level: "commitment", description: "客户确认愿意按测试价试用", sourceRef: "interview-a" },
  });
  const evidenceId = opportunity.commitmentEvidence[0]?.id;
  assert.ok(evidenceId);
  opportunity = await service.confirmCommitmentEvidence({ ...base, expectedStreamVersion: opportunity.streamVersion, evidenceId });
  opportunity = await service.decide({
    ...base,
    expectedStreamVersion: opportunity.streamVersion,
    decision: "pursue",
    rationale: "有明确承诺，同时保留对免费替代方案的风险观察",
  });

  const deliverables = exportOpportunityDeliverables(opportunity, { interviewRawRecords });
  assert.deepEqual(deliverables.map((item) => item.kind), OPC_DELIVERABLE_OUTCOMES.map((item) => item.kind));
  assert.equal(deliverables.length, 6);
  assert.match(renderDeliverablesAsText(deliverables), /人工确认的承诺证据/u);
  assert.match(renderDeliverablesAsText(deliverables), /pursue/u);
});
