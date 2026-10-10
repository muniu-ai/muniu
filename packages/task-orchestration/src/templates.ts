// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { canonicalJson, type TeamPlanLimitsV1, type TeamPlanNodeV1, type TeamTemplateIdV1 } from "@mn/contracts";

export const TEAM_DEFAULT_LIMITS: Readonly<TeamPlanLimitsV1> = Object.freeze({ maxParallelNodes: 3, maxDelegationDepth: 1, maxNodes: 12, maxAttempts: 24, maxReworkRounds: 2 });
export interface TeamTemplateNodeV1 {
  readonly id: string; readonly title: string; readonly kind: TeamPlanNodeV1["kind"];
  readonly dependsOn: readonly string[]; readonly roleId?: string;
  readonly pluginId?: "opc" | "coding"; readonly agentDefinitionId?: string;
}
export interface TeamTemplateDefinitionV1 {
  readonly id: TeamTemplateIdV1; readonly version: "1"; readonly title: string; readonly description: string;
  readonly pluginId: "opc" | "coding"; readonly nodes: readonly TeamTemplateNodeV1[]; readonly digest: string;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const agent = (id: string, title: string, dependsOn: readonly string[], pluginId: "opc" | "coding" = "opc", agentDefinitionId?: string): TeamTemplateNodeV1 => ({
  id, title, kind: "agent", dependsOn, roleId: id, pluginId, ...(agentDefinitionId ? { agentDefinitionId } : {}),
});
const definitions: readonly Omit<TeamTemplateDefinitionV1, "digest">[] = [
  { id: "research-summary", version: "1", title: "研究汇总", description: "分方向取证、汇总并独立复核来源与反证", pluginId: "opc", nodes: [
    agent("research-primary", "主要方向取证", []), agent("research-counter", "反证取证", []),
    agent("synthesis", "汇总研究结果", ["research-primary", "research-counter"]), agent("review", "独立复核", ["synthesis"]),
    { id: "handoff", title: "汇合交付", kind: "join", dependsOn: ["synthesis", "review"] },
  ] },
  { id: "business-proposal", version: "1", title: "经营方案", description: "整理需求、形成方案与报价候选，复核后由用户确认业务事实", pluginId: "opc", nodes: [
    agent("requirements", "整理需求", []), agent("proposal", "方案与报价候选", ["requirements"]), agent("review", "独立复核", ["proposal"]),
    { id: "confirm", title: "确认业务事实", kind: "human_decision", dependsOn: ["review"] },
    { id: "handoff", title: "汇合交付", kind: "join", dependsOn: ["proposal", "review", "confirm"] },
  ] },
  { id: "code-delivery", version: "1", title: "代码交付", description: "保留规格、实现、检查和批准候选流程，再独立复核交付成果", pluginId: "coding", nodes: [
    agent("delivery", "规格、实现、检查与批准候选", [], "coding", "coding.builtin"),
    agent("review", "独立复核成果与证据", ["delivery"], "opc", "opc.business-assistant"),
    { id: "handoff", title: "汇合交付", kind: "join", dependsOn: ["delivery", "review"] },
  ] },
];
const templates = freeze(definitions.map(template => ({ ...template, digest: createHash("sha256").update(canonicalJson(template)).digest("hex") })));
export function listTeamTemplates(): readonly TeamTemplateDefinitionV1[] { return templates; }
export function getTeamTemplate(id: TeamTemplateIdV1): TeamTemplateDefinitionV1 {
  const template = templates.find(item => item.id === id);
  if (!template) throw new RangeError("团队模板不存在");
  return template;
}
