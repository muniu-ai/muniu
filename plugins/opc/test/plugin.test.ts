import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflow } from "@mn/contracts";
import { assertPluginDefinition } from "@mn/plugin-sdk";
import {
  InMemoryOpcRepository,
  OPC_DELIVERABLE_OUTCOMES,
  OPC_OPPORTUNITY_WORKFLOW,
  OpcService,
  createOpcPluginDefinition,
} from "../src/index.js";

test("官方 OPC 插件声明成果导向 Skill，且只注册公开网页读取工具", async () => {
  const service = new OpcService({
    repository: new InMemoryOpcRepository(),
    clock: () => "2026-09-04T10:00:00.000Z",
    createId: (prefix) => `${prefix}-1`,
  });
  const definition = createOpcPluginDefinition({ service });
  assert.doesNotThrow(() => assertPluginDefinition(definition));
  assert.doesNotThrow(() => validateWorkflow(OPC_OPPORTUNITY_WORKFLOW));
  assert.equal(definition.id, "opc");
  assert.equal(definition.official, true);
  assert.equal(definition.trustBoundary, "process_equivalent");
  assert.deepEqual(definition.contributions.tools, [{
    id: "opc.public-web.read",
    version: "0.2.0",
    effectClass: "external_read",
  }]);
  const forbidden = /crm|outreach|publish|quote\.send|payment|支付|外联|发布/iu;
  assert.equal(definition.contributions.tools.some((tool) => forbidden.test(tool.id)), false);
  assert.ok(definition.contributions.skills.length >= 3);
  for (const skill of definition.contributions.skills) {
    assert.ok(skill.expectedOutcome);
    assert.ok(skill.exampleInput);
    assert.ok(skill.source);
    assert.ok(skill.license);
    assert.equal(skill.version, "0.2.0");
  }
  assert.equal(OPC_DELIVERABLE_OUTCOMES.length, 6);

  const preview = definition.contributions.commands.find((item) => item.id === "opc.capture.preview");
  assert.ok(preview);
  const result = await preview.run(
    { text: "目标客户：独立开发者；问题：访谈难；假设：愿意购买访谈包" },
    { workspaceId: "workspace" },
  ) as { reviewRequired: boolean };
  assert.equal(result.reviewRequired, true);
});
