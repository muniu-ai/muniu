import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryOpcRepository,
  OpcDomainError,
  OpcService,
  createOpportunityDraft,
  type Actor,
  type MinimumPaidOfferInput,
} from "../src/index.js";

const HUMAN: Actor = { id: "principal-owner", kind: "human" };
const AGENT: Actor = { id: "agent-validator", kind: "agent" };
const WORKSPACE_ID = "workspace-one";
const OPPORTUNITY_ID = "opp-one";
const NOW = "2026-09-04T08:00:00.000Z";

function createFixture() {
  let sequence = 0;
  const repository = new InMemoryOpcRepository();
  const service = new OpcService({
    repository,
    clock: () => NOW,
    createId: (prefix) => `${prefix}-${++sequence}`,
  });
  return { repository, service };
}

function paidOffer(): MinimumPaidOfferInput {
  return {
    targetCustomer: "正在验证首个产品的独立开发者",
    promisedOutcome: "七天内得到可继续或停止的证据",
    inScope: ["访谈提纲", "证据账本", "一次决策复盘"],
    outOfScope: ["代替客户访谈", "自动外联"],
    price: { amountMinor: "9900", currency: "CNY", assumption: "首批三位客户测试价" },
    deliveryFormat: "线上工作坊与文档",
    duration: "7 天",
    acceptanceMethod: "完成五次访谈并形成明确决策",
    nextCustomerAction: "确认试用并预约启动会",
    risks: ["招募样本不足"],
  };
}

test("自然语言捕获只生成待审阅结构，不把推断当事实", () => {
  const draft = createOpportunityDraft(
    "目标客户：正在验证首个产品的独立开发者；问题：不知道该问谁和问什么；假设：若提供非诱导访谈包，他们愿意在一周内完成五次访谈",
  );

  assert.equal(draft.targetCustomer, "正在验证首个产品的独立开发者");
  assert.equal(draft.problem, "不知道该问谁和问什么");
  assert.equal(draft.falsifiableHypothesis, "若提供非诱导访谈包，他们愿意在一周内完成五次访谈");
  assert.equal(draft.reviewRequired, true);
  assert.deepEqual(draft.inferredFields, ["title"]);

  const ambiguous = createOpportunityDraft("想做一个帮助创作者的工具");
  assert.equal(ambiguous.targetCustomer, undefined);
  assert.equal(ambiguous.problem, undefined);
  assert.equal(ambiguous.falsifiableHypothesis, undefined);
  assert.equal(ambiguous.reviewRequired, true);

  const inferred = createOpportunityDraft(
    "面向独立开发者，解决客户访谈准备耗时；如果提供非诱导提纲，那么他们会完成五次访谈",
  );
  assert.equal(inferred.targetCustomer, "独立开发者");
  assert.equal(inferred.problem, "客户访谈准备耗时");
  assert.equal(inferred.falsifiableHypothesis, "如果提供非诱导提纲，那么他们会完成五次访谈");
  assert.deepEqual(inferred.inferredFields, ["title", "targetCustomer", "problem", "falsifiableHypothesis"]);
});

test("机会按固定状态机推进，framed 与 offer_ready 校验必填字段，决策只能由人完成", async () => {
  const { service } = createFixture();
  const captured = await service.capture({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: 0,
    actor: HUMAN,
    draft: createOpportunityDraft("独立开发者访谈验证"),
  });
  assert.equal(captured.state, "captured");

  await assert.rejects(
    service.frame({
      workspaceId: WORKSPACE_ID,
      opportunityId: OPPORTUNITY_ID,
      expectedStreamVersion: captured.streamVersion,
      actor: HUMAN,
      targetCustomer: "独立开发者",
      problem: "",
      falsifiableHypothesis: "会为访谈包付费",
    }),
    (error: unknown) => error instanceof OpcDomainError && error.code === "REQUIRED_FIELD",
  );

  const framed = await service.frame({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: captured.streamVersion,
    actor: HUMAN,
    targetCustomer: "独立开发者",
    problem: "不知道如何做非诱导访谈",
    falsifiableHypothesis: "五位目标客户中至少一位承诺付费试用",
  });
  const researching = await service.startResearch({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: framed.streamVersion,
    actor: AGENT,
  });
  const interviewing = await service.startInterviewing({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: researching.streamVersion,
    actor: AGENT,
  });
  const evaluating = await service.startEvaluation({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: interviewing.streamVersion,
    actor: AGENT,
  });

  await assert.rejects(
    service.prepareOffer({
      workspaceId: WORKSPACE_ID,
      opportunityId: OPPORTUNITY_ID,
      expectedStreamVersion: evaluating.streamVersion,
      actor: AGENT,
      offer: { ...paidOffer(), nextCustomerAction: "" },
    }),
    (error: unknown) => error instanceof OpcDomainError && error.code === "REQUIRED_FIELD",
  );

  const ready = await service.prepareOffer({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: evaluating.streamVersion,
    actor: AGENT,
    offer: paidOffer(),
  });
  assert.equal(ready.state, "offer_ready");

  await assert.rejects(
    service.decide({
      workspaceId: WORKSPACE_ID,
      opportunityId: OPPORTUNITY_ID,
      expectedStreamVersion: ready.streamVersion,
      actor: AGENT,
      decision: "pursue",
      rationale: "继续",
    }),
    (error: unknown) => error instanceof OpcDomainError && error.code === "HUMAN_REQUIRED",
  );

  const decided = await service.decide({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: ready.streamVersion,
    actor: HUMAN,
    decision: "pursue",
    rationale: "已有一位客户明确承诺参与",
  });
  assert.equal(decided.state, "decided");
  assert.equal(decided.decision?.choice, "pursue");
  assert.equal(decided.decision?.decidedBy, HUMAN.id);
});

test("暂停可恢复到原状态，放弃是非终态之外的显式终止", async () => {
  const { service } = createFixture();
  const captured = await service.capture({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: 0,
    actor: HUMAN,
    draft: createOpportunityDraft("暂缓验证"),
  });
  const paused = await service.pause({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: captured.streamVersion,
    actor: HUMAN,
    reason: "等待样本",
  });
  assert.equal(paused.state, "paused");
  assert.equal(paused.stateBeforePause, "captured");

  const resumed = await service.resume({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: paused.streamVersion,
    actor: HUMAN,
  });
  assert.equal(resumed.state, "captured");

  const abandoned = await service.abandon({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: resumed.streamVersion,
    actor: HUMAN,
    reason: "目标用户不存在",
  });
  assert.equal(abandoned.state, "abandoned");
  await assert.rejects(
    service.resume({
      workspaceId: WORKSPACE_ID,
      opportunityId: OPPORTUNITY_ID,
      expectedStreamVersion: abandoned.streamVersion,
      actor: HUMAN,
    }),
    (error: unknown) => error instanceof OpcDomainError && error.code === "INVALID_TRANSITION",
  );
});

test("访谈原文不可覆盖，模型和人只能追加标注", async () => {
  const { service } = createFixture();
  let aggregate = await service.capture({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: 0,
    actor: HUMAN,
    draft: createOpportunityDraft("访谈不可变测试"),
  });
  aggregate = await service.frame({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: aggregate.streamVersion,
    actor: HUMAN,
    targetCustomer: "独立开发者",
    problem: "不会访谈",
    falsifiableHypothesis: "愿意预约访谈",
  });
  aggregate = await service.startResearch({ workspaceId: WORKSPACE_ID, opportunityId: OPPORTUNITY_ID, expectedStreamVersion: aggregate.streamVersion, actor: AGENT });
  aggregate = await service.startInterviewing({ workspaceId: WORKSPACE_ID, opportunityId: OPPORTUNITY_ID, expectedStreamVersion: aggregate.streamVersion, actor: AGENT });
  await assert.rejects(
    service.recordInterview({
      workspaceId: WORKSPACE_ID,
      opportunityId: OPPORTUNITY_ID,
      expectedStreamVersion: aggregate.streamVersion,
      actor: AGENT,
      interviewId: "model-generated",
      participantRef: "受访者 A",
      occurredAt: NOW,
      rawRecord: "模型生成的原文",
    }),
    (error: unknown) => error instanceof OpcDomainError && error.code === "HUMAN_REQUIRED",
  );
  aggregate = await service.recordInterview({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: aggregate.streamVersion,
    actor: HUMAN,
    interviewId: "interview-one",
    participantRef: "受访者 A",
    occurredAt: NOW,
    rawRecord: "我上个月试了三种表格，最后都没坚持。",
  });
  aggregate = await service.annotateInterview({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: aggregate.streamVersion,
    actor: AGENT,
    interviewId: "interview-one",
    annotation: "已有替代方案，但持续使用困难",
  });
  aggregate = await service.annotateInterview({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: aggregate.streamVersion,
    actor: HUMAN,
    interviewId: "interview-one",
    annotation: "需追问停止使用的具体触发点",
  });

  assert.equal(aggregate.interviews[0]?.rawRecord, "我上个月试了三种表格，最后都没坚持。");
  assert.deepEqual(aggregate.interviews[0]?.annotations.map((item) => item.text), [
    "已有替代方案，但持续使用困难",
    "需追问停止使用的具体触发点",
  ]);
  assert.equal("replaceInterview" in service, false);
});

test("commitment 与 paid 只有人工确认后才提升证据等级", async () => {
  const { service } = createFixture();
  let aggregate = await service.capture({ workspaceId: WORKSPACE_ID, opportunityId: OPPORTUNITY_ID, expectedStreamVersion: 0, actor: HUMAN, draft: createOpportunityDraft("证据测试") });
  aggregate = await service.frame({ workspaceId: WORKSPACE_ID, opportunityId: OPPORTUNITY_ID, expectedStreamVersion: aggregate.streamVersion, actor: HUMAN, targetCustomer: "开发者", problem: "验证慢", falsifiableHypothesis: "愿意留下联系方式" });
  aggregate = await service.startResearch({ workspaceId: WORKSPACE_ID, opportunityId: OPPORTUNITY_ID, expectedStreamVersion: aggregate.streamVersion, actor: AGENT });
  aggregate = await service.recordSignal({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: aggregate.streamVersion,
    actor: AGENT,
    signal: {
      sourceKind: "manual",
      observedAt: NOW,
      summary: "两位受访者愿意继续沟通",
      relationship: "support",
      evidenceKind: "interest",
    },
  });
  assert.equal(aggregate.evidenceLevel, "interest");

  aggregate = await service.proposeCommitmentEvidence({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: aggregate.streamVersion,
    actor: AGENT,
    evidence: { level: "commitment", description: "客户口头同意试用", sourceRef: "访谈 A" },
  });
  const evidenceId = aggregate.commitmentEvidence[0]?.id;
  assert.ok(evidenceId);
  assert.equal(aggregate.evidenceLevel, "interest");

  await assert.rejects(
    service.confirmCommitmentEvidence({
      workspaceId: WORKSPACE_ID,
      opportunityId: OPPORTUNITY_ID,
      expectedStreamVersion: aggregate.streamVersion,
      actor: AGENT,
      evidenceId,
    }),
    (error: unknown) => error instanceof OpcDomainError && error.code === "HUMAN_REQUIRED",
  );

  aggregate = await service.confirmCommitmentEvidence({ workspaceId: WORKSPACE_ID, opportunityId: OPPORTUNITY_ID, expectedStreamVersion: aggregate.streamVersion, actor: HUMAN, evidenceId });
  assert.equal(aggregate.evidenceLevel, "commitment");
  aggregate = await service.proposeCommitmentEvidence({
    workspaceId: WORKSPACE_ID,
    opportunityId: OPPORTUNITY_ID,
    expectedStreamVersion: aggregate.streamVersion,
    actor: HUMAN,
    evidence: { level: "paid", description: "客户提供付款凭证", sourceRef: "receipt-1" },
  });
  const paidId = aggregate.commitmentEvidence.find((item) => item.level === "paid")?.id;
  assert.ok(paidId);
  assert.equal(aggregate.evidenceLevel, "commitment");
  aggregate = await service.confirmCommitmentEvidence({ workspaceId: WORKSPACE_ID, opportunityId: OPPORTUNITY_ID, expectedStreamVersion: aggregate.streamVersion, actor: HUMAN, evidenceId: paidId });
  assert.equal(aggregate.evidenceLevel, "paid");
});

test("仓库用工作区隔离事件，并以 streamVersion 拒绝并发覆盖", async () => {
  const repository = new InMemoryOpcRepository();
  const event = {
    type: "opportunity.captured" as const,
    actor: HUMAN,
    occurredAt: NOW,
    payload: { title: "机会", rawInput: "机会" },
  };
  await repository.append({ workspaceId: "w-a", opportunityId: "same-id", expectedStreamVersion: 0, events: [event] });
  await repository.append({ workspaceId: "w-b", opportunityId: "same-id", expectedStreamVersion: 0, events: [event] });

  await assert.rejects(
    repository.append({ workspaceId: "w-a", opportunityId: "same-id", expectedStreamVersion: 0, events: [event] }),
    (error: unknown) => error instanceof OpcDomainError && error.code === "STREAM_VERSION_CONFLICT",
  );
  assert.equal((await repository.load("w-a", "same-id"))?.streamVersion, 1);
  assert.equal((await repository.load("w-b", "same-id"))?.streamVersion, 1);
  assert.equal((await repository.events("w-a", "same-id"))[0]?.streamVersion, 1);
});
