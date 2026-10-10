// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { GoalPlanProposalV2, GoalTeamPlanProposalV2, GoalSinglePlanProposalV2, TeamAgentCapabilityV1, TeamAgentNodeV1, TeamPlanNodeV1, TeamTemplateIdV1 } from "@mn/contracts";
import { assertSinglePlan, assertTeamPlan, getTeamTemplate, listTeamTemplates, readyTeamNodes, TEAM_DEFAULT_LIMITS, TeamPlanValidationError, type TeamPlanValidationContext } from "../src/index.js";

const digest = "a".repeat(64);
const source = { namespace: "asset", resourceId: "source", streamVersion: 1, digest };
const budget = { maxTokens: 10000, maxCostMinorUnits: "1000", currency: "CNY", maxDurationMs: 60000 };
function fixture(id: TeamTemplateIdV1 = "research-summary") {
  const template = getTeamTemplate(id);
  const capabilities: TeamAgentCapabilityV1[] = [];
  const nodes = template.nodes.map(node => {
    const common = { id: node.id, title: node.title, dependsOn: [...node.dependsOn],
      inputs: [{ key: "goal", kind: "goal" as const }, { key: "source", kind: "source" as const, resourceRef: source }],
      outputs: [{ key: "result", kind: "artifact" as const, description: "可审阅成果" }, { key: "evidence", kind: "evidence" as const, description: "来源证据" }],
    };
    if (node.kind === "human_decision") return { ...common, kind: node.kind, prompt: "确认业务事实后继续", choices: ["continue", "stop"],
      outputs: [{ key: "decision", kind: "decision", description: "用户决定" }],
      inputs: node.dependsOn.map(from => ({ key: from, kind: "node_output", nodeId: from, outputKey: "result" })) } as TeamPlanNodeV1;
    if (node.kind === "join") {
      const producer = id === "research-summary" ? "synthesis" : id === "business-proposal" ? "proposal" : "delivery";
      return { ...common, kind: node.kind, outputs: [{ key: "delivery", kind: "artifact", description: "交付成果" }],
        inputs: [{ key: "delivery", kind: "node_output", nodeId: producer, outputKey: "result" }],
        mappings: [{ outputKey: "delivery", fromNodeId: producer, fromOutputKey: "result" }] } as TeamPlanNodeV1;
    }
    const capability: TeamAgentCapabilityV1 = { id: `capability.${node.roleId}`, version: "1", digest,
      pluginId: node.pluginId!, agentDefinitionId: node.agentDefinitionId ?? `agent.${node.roleId}`, inputKinds: ["goal", "source", "node_output"],
      outputKinds: ["artifact", "evidence", "review", "self_assessment"], toolIds: [], effectClasses: ["local_read"],
      runnerIds: ["builtin"], isolation: "none", dataDestinations: ["model:fixture"], costControl: "hard_limit",
      independentReview: node.id === "review", evaluationVersion: "fixture-v1" };
    capabilities.push(capability);
    const executor: GoalPlanProposalV2 = { domainInputDigest: digest, threadStreamVersion: 1, pluginId: capability.pluginId, pluginVersion: "0.2.0",
      agentDefinitionId: capability.agentDefinitionId, modelBindingId: "model", modelConnectionStreamVersion: 1,
      model: "fixture", runnerId: "builtin", toolIds: [], dataScopes: [], autoAllowedEffects: ["local_read"] };
    const review = node.id === "review" ? { independent: true as const, producerNodeIds: [...node.dependsOn] } : undefined;
    return { ...common, inputs: [...common.inputs, ...node.dependsOn.map(from => ({ key: from, kind: "node_output" as const, nodeId: from, outputKey: "result" }))], kind: "agent", roleId: node.roleId!, executor,
      capabilityRef: { id: capability.id, version: capability.version, digest: capability.digest },
      budget: { ...budget, maxTokens: 1000, maxCostMinorUnits: "100" },
      ...(review ? { review, inputs: [...common.inputs, ...node.dependsOn.flatMap(from => [
        { key: `${from}.result`, kind: "node_output" as const, nodeId: from, outputKey: "result" },
        { key: `${from}.evidence`, kind: "node_output" as const, nodeId: from, outputKey: "evidence" },
      ])], outputs: [{ key: "result", kind: "review", description: "独立复核结论" }] } : {}),
    } as TeamAgentNodeV1;
  });
  const plan: GoalTeamPlanProposalV2 = { kind: "team-v1", template: { id, version: "1", digest: template.digest },
    pluginId: template.pluginId, domainInputDigest: digest, threadStreamVersion: 1, nodes,
    deliverableBindings: [{ deliverableKey: "report", nodeId: "handoff", outputKey: "delivery" }], limits: { ...TEAM_DEFAULT_LIMITS } };
  const context: TeamPlanValidationContext = { resourceRefs: [source], budget,
    deliverables: [{ key: "report", title: "交付成果", required: true, criteria: [{ id: "evidence", description: "依据可回溯" }] }],
    capabilities, authority: { toolIds: [], dataScopes: [], autoAllowedEffects: ["local_read"] } };
  return { plan, context };
}
function rejects(change: (value: ReturnType<typeof fixture>) => void, code: string) {
  const value = fixture(); change(value);
  assert.throws(() => assertTeamPlan(value.plan, value.context), (error: unknown) => error instanceof TeamPlanValidationError && error.code === code);
}
function agent(value: ReturnType<typeof fixture>, id = "research-primary"): TeamAgentNodeV1 {
  return value.plan.nodes.find(node => node.id === id) as TeamAgentNodeV1;
}
const mutate = (target: unknown, fields: object) => Object.assign(target as object, fields);

test("three pinned templates keep Coding governance in one delivery node", () => {
  assert.deepEqual(listTeamTemplates().map(template => template.id), ["research-summary", "business-proposal", "code-delivery"]);
  assert.deepEqual(getTeamTemplate("research-summary").nodes.map(node => [node.id, node.dependsOn]), [
    ["research-primary", []], ["research-counter", []], ["synthesis", ["research-primary", "research-counter"]], ["review", ["synthesis"]], ["handoff", ["synthesis", "review"]],
  ]);
  assert.deepEqual(getTeamTemplate("code-delivery").nodes.map(node => [node.id, node.kind]), [["delivery", "agent"], ["review", "agent"], ["handoff", "join"]]);
  assert.equal(getTeamTemplate("business-proposal").nodes.find(node => node.id === "confirm")!.kind, "human_decision");
  for (const id of ["research-summary", "business-proposal", "code-delivery"] as const) {
    const value = fixture(id); assert.equal(assertTeamPlan(value.plan, value.context).topologicalOrder.at(-1), "handoff");
  }
  assert.throws(() => { (getTeamTemplate("code-delivery").nodes as unknown as unknown[]).pop(); }, TypeError);
});

test("single-v2 keeps one original executor without an artificial review team", () => {
  const value = fixture();
  const { template: _template, kind: _kind, ...shared } = value.plan;
  const plan: GoalSinglePlanProposalV2 = { ...shared, kind: "single-v2", nodes: [{ ...agent(value), id: "execute" }],
    deliverableBindings: [{ deliverableKey: "report", nodeId: "execute", outputKey: "result" }] };
  assert.deepEqual(assertSinglePlan(plan, value.context).topologicalOrder, ["execute"]);
  mutate(value.context.capabilities[0], { costControl: "unknown" });
  assert.deepEqual(assertSinglePlan(plan, value.context).topologicalOrder, ["execute"]);
  assert.throws(() => assertSinglePlan({ ...plan, nodes: [...plan.nodes, { ...plan.nodes[0]!, id: "review" }] }, value.context), TeamPlanValidationError);
  assert.throws(() => assertSinglePlan({ ...plan, deliverableBindings: [] }, value.context), TeamPlanValidationError);
  mutate((plan.nodes[0] as TeamAgentNodeV1).executor, { toolIds: ["undeclared.write"] });
  assert.throws(() => assertSinglePlan(plan, value.context), TeamPlanValidationError);
});

test("only explicitly reused agent nodes avoid consuming new revision quotas", () => {
  const value = fixture();
  mutate(value.context, { cumulative: { nodes: 12, nodeIds: value.plan.nodes.map(node => node.id), attempts: 15, reworkRounds: 2, delegationDepth: 1 } });
  assert.throws(() => assertTeamPlan(value.plan, value.context), TeamPlanValidationError);
  mutate(value.context, { cumulative: { nodes: 10, attempts: 23, reworkRounds: 2, delegationDepth: 1 }, reusedNodeIds: ['research-primary', 'research-counter', 'synthesis'] });
  assert.equal(assertTeamPlan(value.plan, value.context).topologicalOrder.length, value.plan.nodes.length);
  mutate(value.context, { reusedNodeIds: ['handoff'] });
  assert.throws(() => assertTeamPlan(value.plan, value.context), TeamPlanValidationError);
});

test("Coding delivery uses its governed runner and the declared OPC read-only reviewer", () => {
  const value = fixture("code-delivery");
  assert.equal(agent(value, "delivery").executor.agentDefinitionId, "coding.builtin");
  assert.equal(agent(value, "review").executor.pluginId, "opc");
  assert.equal(agent(value, "review").executor.agentDefinitionId, "opc.business-assistant");
  mutate(agent(value, "review").executor, { pluginId: "coding", agentDefinitionId: "coding.builtin" });
  assert.throws(() => assertTeamPlan(value.plan, value.context), (error: unknown) => error instanceof TeamPlanValidationError && error.code === "TEAM_TEMPLATE_INVALID");
  const writes = fixture("code-delivery");
  mutate(agent(writes, "review").executor, { autoAllowedEffects: ["local_reversible_write"] });
  mutate(writes.context.capabilities.find(capability => capability.independentReview), { effectClasses: ["local_reversible_write"] });
  mutate(writes.context.authority, { autoAllowedEffects: ["local_reversible_write", "local_read"] });
  assert.throws(() => assertTeamPlan(writes.plan, writes.context), (error: unknown) => error instanceof TeamPlanValidationError && error.code === "TEAM_REVIEW_INVALID");
});

test("unknown versions, modified topology and changed template digests are rejected", () => {
  rejects(value => mutate(value.plan.template, { version: "2" }), "TEAM_TEMPLATE_INVALID");
  rejects(value => mutate(value.plan.template, { digest: "b".repeat(64) }), "TEAM_TEMPLATE_INVALID");
  rejects(value => mutate(agent(value), { roleId: "arbitrary-agent" }), "TEAM_TEMPLATE_INVALID");
  rejects(value => mutate(value.plan, { nodes: [...value.plan.nodes, { ...agent(value), id: "extra" }] }), "TEAM_TEMPLATE_INVALID");
});

test("cycles, duplicate node IDs and missing dependencies fail before dispatch", () => {
  rejects(value => mutate(agent(value), { dependsOn: ["handoff"] }), "TEAM_DAG_INVALID");
  rejects(value => mutate(agent(value), { dependsOn: ["missing"] }), "TEAM_DAG_INVALID");
  rejects(value => mutate(agent(value), { dependsOn: ["research-primary"] }), "TEAM_DAG_INVALID");
  rejects(value => mutate(value.plan.nodes[1], { id: "research-primary" }), "TEAM_DAG_INVALID");
});

test("inputs are pinned authorized sources or explicit direct dependency outputs", () => {
  rejects(value => mutate(agent(value), { inputs: [{ key: "source", kind: "source", resourceRef: { ...source, streamVersion: 2 } }] }), "TEAM_INPUT_DENIED");
  rejects(value => mutate(agent(value), { inputs: [{ key: "source", kind: "source", resourceRef: { ...source, resourceId: "other-workspace" } }] }), "TEAM_INPUT_DENIED");
  rejects(value => mutate(agent(value), { inputs: [{ key: "leak", kind: "node_output", nodeId: "research-counter", outputKey: "result" }] }), "TEAM_INPUT_DENIED");
  rejects(value => mutate(agent(value, "synthesis"), { inputs: [{ key: "leak", kind: "node_output", nodeId: "research-primary", outputKey: "missing" }] }), "TEAM_INPUT_DENIED");
  rejects(value => mutate(agent(value), { inputs: [{ key: "goal", kind: "goal" }, { key: "goal", kind: "goal" }] }), "TEAM_INPUT_DENIED");
  rejects(value => mutate(agent(value, "synthesis"), { inputs: [{ key: "goal", kind: "goal" }] }), "TEAM_INPUT_DENIED");
});

test("capability identity, declared tools and parent authority cannot be broadened", () => {
  rejects(value => mutate(agent(value).capabilityRef, { digest: "b".repeat(64) }), "TEAM_CAPABILITY_DENIED");
  rejects(value => mutate(agent(value).executor, { agentDefinitionId: "undeclared" }), "TEAM_CAPABILITY_DENIED");
  rejects(value => mutate(agent(value).executor, { toolIds: ["secret.write"] }), "TEAM_CAPABILITY_DENIED");
  rejects(value => mutate(agent(value).executor, { dataScopes: [{ namespace: "asset", resourceId: "*" }] }), "TEAM_AUTHORITY_DENIED");
  rejects(value => mutate(agent(value).executor, { autoAllowedEffects: ["financial"] }), "TEAM_CAPABILITY_DENIED");
  rejects(value => mutate(agent(value).executor, { domainInputDigest: "b".repeat(64) }), "TEAM_EXECUTOR_INVALID");
  rejects(value => mutate(value.context.capabilities[0], { isolation: "required_sandbox" }), "TEAM_CAPABILITY_DENIED");
});

test("independent review requires original criteria, producer result and evidence without self ratings", () => {
  rejects(value => mutate(agent(value, "review"), { review: undefined }), "TEAM_REVIEW_INVALID");
  rejects(value => mutate(agent(value, "review"), { inputs: agent(value, "review").inputs.filter(input => input.kind !== "goal") }), "TEAM_REVIEW_INVALID");
  rejects(value => mutate(agent(value, "review"), { inputs: agent(value, "review").inputs.filter(input => input.kind !== "node_output" || input.outputKey !== "evidence") }), "TEAM_REVIEW_INVALID");
  rejects(value => {
    const producer = agent(value, "synthesis");
    mutate(producer, { outputs: [...producer.outputs, { key: "score", kind: "self_assessment", description: "生成者自评分" }] });
    mutate(agent(value, "review"), { inputs: [...agent(value, "review").inputs, { key: "score", kind: "node_output", nodeId: "synthesis", outputKey: "score" }] });
  }, "TEAM_REVIEW_INVALID");
});

test("node budgets reserve a shared cumulative allowance without exchange or unknown-cost bypass", () => {
  rejects(value => mutate(agent(value), { budget: { ...budget, maxTokens: -1 } }), "TEAM_BUDGET_INVALID");
  rejects(value => mutate(agent(value).budget, { currency: "USD" }), "TEAM_BUDGET_INVALID");
  rejects(value => mutate(agent(value).budget, { maxDurationMs: budget.maxDurationMs - 1 }), "TEAM_BUDGET_INVALID");
  rejects(value => value.plan.nodes.filter(node => node.kind === "agent").forEach(node => mutate(node.budget, { maxTokens: 4000 })), "TEAM_BUDGET_INVALID");
  rejects(value => mutate(value.context.capabilities[0], { costControl: "unknown" }), "TEAM_BUDGET_UNCONTROLLED");
  rejects(value => mutate(value.context, { cumulative: { nodes: 8, attempts: 0, reworkRounds: 0, delegationDepth: 1 } }), "TEAM_LIMIT_EXCEEDED");
  rejects(value => mutate(value.context, { cumulative: { nodes: 0, attempts: 23, reworkRounds: 0, delegationDepth: 1 } }), "TEAM_LIMIT_EXCEEDED");
  rejects(value => mutate(value.context, { cumulative: { nodes: 0, attempts: 0, reworkRounds: 3, delegationDepth: 1 } }), "TEAM_LIMIT_EXCEEDED");
  rejects(value => mutate(value.context, { workspaceLimits: { maxParallelNodes: 1 } }), "TEAM_LIMIT_EXCEEDED");
  rejects(value => mutate(value.plan.limits, { maxNodes: 100 }), "TEAM_LIMIT_EXCEEDED");
});

test("join mappings and final deliverables cannot hide missing or duplicate producers", () => {
  rejects(value => mutate(value.plan, { deliverableBindings: [] }), "TEAM_DELIVERY_INVALID");
  rejects(value => mutate(value.plan.deliverableBindings[0], { nodeId: "research-primary", outputKey: "result" }), "TEAM_DELIVERY_INVALID");
  rejects(value => mutate(value.plan.nodes.at(-1), { mappings: [{ outputKey: "delivery", fromNodeId: "synthesis", fromOutputKey: "missing" }] }), "TEAM_DELIVERY_INVALID");
  rejects(value => mutate(value.plan, { deliverableBindings: [...value.plan.deliverableBindings, ...value.plan.deliverableBindings] }), "TEAM_DELIVERY_INVALID");
});

test("readiness waits for dependencies, respects pause and never replays unknown results", () => {
  const { plan } = fixture();
  const pending = Object.fromEntries(plan.nodes.map(node => [node.id, "pending" as const]));
  assert.deepEqual(readyTeamNodes(plan, pending).map(node => node.id), ["research-primary", "research-counter"]);
  assert.deepEqual(readyTeamNodes(plan, { ...pending, "research-primary": "completed", "research-counter": "completed" }).map(node => node.id), ["synthesis"]);
  assert.deepEqual(readyTeamNodes(plan, pending, "paused"), []);
  assert.deepEqual(readyTeamNodes(plan, { ...pending, "research-primary": "needs_reconciliation" }), []);
  assert.deepEqual(readyTeamNodes(plan, { ...pending, "research-primary": "failed" }), []);
  assert.deepEqual(readyTeamNodes(plan, {}).map(node => node.id), []);
  mutate(plan.limits, { maxParallelNodes: 1 });
  assert.deepEqual(readyTeamNodes(plan, pending).map(node => node.id), ["research-primary"]);
});
