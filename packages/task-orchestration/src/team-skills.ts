// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, type GoalTeamPlanProposalV2, type GoalTeamPlanRevisionV2, type TeamSkillNodeV2, type TeamSkillVersionV2 } from '@mn/contracts';
import { digest } from './benchmark-comparison.mjs';
import { getTeamTemplate } from './templates.js';
export function skillNodes(plan: GoalTeamPlanProposalV2): readonly TeamSkillNodeV2[] {
  const template = getTeamTemplate(plan.template.id);
  if (canonicalJson(plan.template) !== canonicalJson({ id: template.id, version: template.version, digest: template.digest }) || plan.pluginId !== template.pluginId
    || plan.nodes.length !== template.nodes.length) throw new Error('TEAM_SKILL_TEMPLATE_INVALID');
  return template.nodes.map(slot => {
    const node = plan.nodes.find(node => node.id === slot.id);
    if (!node || node.kind !== slot.kind || canonicalJson(node.dependsOn) !== canonicalJson(slot.dependsOn)) throw new Error('TEAM_SKILL_TEMPLATE_INVALID');
    if (node.kind === 'agent' && (node.roleId !== slot.roleId || node.executor.pluginId !== slot.pluginId || node.executor.runnerId !== 'builtin'
      || node.executor.agentDefinitionId !== (slot.agentDefinitionId ?? 'opc.business-assistant'))) throw new Error('TEAM_SKILL_TEMPLATE_INVALID');
    return { id: node.id, kind: node.kind, title: slot.title, dependsOn: [...node.dependsOn],
      ...(node.kind === 'agent' ? { roleId: node.roleId, pluginId: node.executor.pluginId, agentDefinitionId: node.executor.agentDefinitionId } : {}),
      inputs: node.inputs.map(input => input.kind === 'source' ? { key: input.key, kind: 'source_slot' as const } : { ...input }),
      outputs: node.outputs.map(({ key, kind }) => ({ key, kind })),
      ...(node.kind === 'agent' && node.review ? { review: structuredClone(node.review) } : {}),
      ...(node.kind === 'human_decision' ? { choices: [...node.choices] } : {}),
      ...(node.kind === 'join' ? { mappings: structuredClone(node.mappings) } : {}) };
  });
}
export function extractTeamSkillDefinition(plan: GoalTeamPlanRevisionV2): Pick<TeamSkillVersionV2, 'nodes' | 'permissionRequirements' | 'inputSlots' | 'outputSpecs' | 'deliverableBindings' | 'limits' | 'checkRules' | 'evaluationVersion'> {
  const nodes = skillNodes(plan);
  return { nodes, permissionRequirements: plan.nodes.filter(node => node.kind === 'agent').map(node => ({ nodeId: node.id, pluginId: node.executor.pluginId,
    agentDefinitionId: node.executor.agentDefinitionId, toolIds: [...node.executor.toolIds], effectClasses: [...node.executor.autoAllowedEffects], isolation: node.executor.pluginId === 'coding' ? 'required_sandbox' : 'none' })),
    inputSlots: plan.resourceRefs.map((ref, index) => ({ key: `source.${index}`, namespace: ref.namespace })),
    outputSpecs: structuredClone(plan.deliverables), deliverableBindings: structuredClone(plan.deliverableBindings), limits: { ...plan.limits },
    checkRules: ['required_deliverables', 'authorized_sources', 'independent_review', ...(plan.pluginId === 'coding' ? ['coding_gate' as const] : [])], evaluationVersion: 'agent-os-delivery-1.0.0' };
}
export function assertTeamSkillStructure(skill: TeamSkillVersionV2, plan: GoalTeamPlanProposalV2): void {
  if (canonicalJson(skill.nodes) !== canonicalJson(skillNodes(plan)) || canonicalJson(skill.deliverableBindings) !== canonicalJson(plan.deliverableBindings)) throw new Error('TEAM_SKILL_TEMPLATE_INVALID');
  for (const node of plan.nodes) if (node.kind === 'agent') {
    const requirement = skill.permissionRequirements.find(item => item.nodeId === node.id);
    if (!requirement || node.executor.pluginId !== requirement.pluginId || node.executor.agentDefinitionId !== requirement.agentDefinitionId
      || node.executor.toolIds.some(id => !requirement.toolIds.includes(id)) || node.executor.autoAllowedEffects.some(effect => !requirement.effectClasses.includes(effect))) throw new Error('TEAM_SKILL_PERMISSION_ESCALATION');
  }
  for (const key of Object.keys(skill.limits) as (keyof typeof skill.limits)[]) if (plan.limits[key] > skill.limits[key]) throw new Error('TEAM_SKILL_LIMIT_ESCALATION');
}

/** Evidence attests to exact outcomes; evidence references themselves are excluded to avoid a digest cycle. */
export function teamSkillResultsDigest(report: { readonly arms?: unknown }): string {
  function content(value: unknown, depth = 0): unknown {
    if (depth > 32) throw new Error('TEAM_SKILL_REPORT_INVALID');
    if (Array.isArray(value)) return value.map(item => content(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'evidence').map(([key, item]) => [key, content(item, depth + 1)]));
    return value;
  }
  return digest(content(report.arms));
}
