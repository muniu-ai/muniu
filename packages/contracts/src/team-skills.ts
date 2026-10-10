// SPDX-License-Identifier: Apache-2.0
import type { GoalDeliverableSpecV2, GoalResourceRefV2 } from './goals.js';
import type { TeamOutputKindV1, TeamPlanLimitsV1, TeamDeliverableBindingV1, TeamTemplateIdV1 } from './team-goals.js';
import type { JsonObject } from './json.js';
import type { ToolEffectClass } from './models.js';

export interface TeamSkillRefV2 { readonly id: string; readonly version: string; readonly digest: string }
export interface TeamSkillSourceV2 { readonly goalId: string; readonly planRevisionId: string; readonly deliverySetId: string; readonly deliveryDigest: string }
export interface TeamSkillRoleV2 { readonly nodeId: string; readonly instructions: string; readonly sourceRefs: readonly GoalResourceRefV2[] }
export interface TeamSkillNodeV2 {
  readonly id: string; readonly kind: 'agent' | 'human_decision' | 'join'; readonly title: string;
  readonly dependsOn: readonly string[]; readonly roleId?: string; readonly pluginId?: 'opc' | 'coding'; readonly agentDefinitionId?: string;
  readonly inputs: readonly ({ readonly key: string; readonly kind: 'goal' | 'source_slot' } | { readonly key: string; readonly kind: 'node_output'; readonly nodeId: string; readonly outputKey: string })[];
  readonly outputs: readonly { readonly key: string; readonly kind: TeamOutputKindV1 }[];
  readonly review?: { readonly independent: true; readonly producerNodeIds: readonly string[] };
  readonly choices?: readonly ('continue' | 'stop')[];
  readonly mappings?: readonly { readonly outputKey: string; readonly fromNodeId: string; readonly fromOutputKey: string }[];
}
export interface TeamSkillPermissionRequirementV2 {
  readonly nodeId: string; readonly pluginId: 'opc' | 'coding'; readonly agentDefinitionId: string;
  readonly toolIds: readonly string[]; readonly effectClasses: readonly ToolEffectClass[]; readonly isolation: 'none' | 'required_sandbox';
}
export interface TeamSkillVersionV2 {
  readonly schemaVersion: '1'; readonly id: string; readonly tenantId: string; readonly workspaceId: string;
  readonly skillId: string; readonly version: string; readonly streamVersion: 1; readonly digest: string;
  readonly title: string; readonly description: string; readonly pluginId: 'opc' | 'coding';
  readonly template: { readonly id: TeamTemplateIdV1; readonly version: '1'; readonly digest: string };
  readonly source: TeamSkillSourceV2 & { readonly acceptanceId: string };
  readonly roles: readonly TeamSkillRoleV2[]; readonly nodes: readonly TeamSkillNodeV2[];
  readonly inputSlots: readonly { readonly key: string; readonly namespace: string }[];
  readonly outputSpecs: readonly GoalDeliverableSpecV2[];
  readonly deliverableBindings: readonly TeamDeliverableBindingV1[];
  readonly permissionRequirements: readonly TeamSkillPermissionRequirementV2[];
  readonly checkRules: readonly ('required_deliverables' | 'authorized_sources' | 'independent_review' | 'coding_gate')[];
  readonly limits: TeamPlanLimitsV1; readonly evaluationVersion: 'agent-os-delivery-1.0.0';
  readonly sourceRefs: readonly GoalResourceRefV2[]; readonly createdAt: string; readonly createdBy: string;
}
export interface TeamSkillEvaluationConfigurationV2 {
  readonly model: { readonly provider: string; readonly name: string; readonly revision: string; readonly parameters: { readonly temperature: number } };
  readonly promptSha256: string; readonly policySha256: string; readonly materialsSha256: string;
  readonly budget: { readonly revision: 'budget-v1'; readonly maxTokens: number; readonly maxCostMinorUnits: string; readonly currency: string };
}
export interface TeamSkillEvidenceV2 {
  readonly artifactRef: GoalResourceRefV2; readonly artifactSha256: string;
  readonly method: 'human' | 'deterministic'; readonly reviewer?: string; readonly check?: string;
}
export interface TeamSkillEvaluationV2 {
  readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly streamVersion: number; readonly digest: string;
  readonly skillRef: TeamSkillRefV2; readonly datasetVersion: '1.0.0'; readonly datasetDigest: string;
  readonly executionMode: 'measured' | 'test_fixture'; readonly configuration: TeamSkillEvaluationConfigurationV2; readonly configurationDigest: string;
  readonly baselineRevision: string; readonly candidateRevision: string; readonly frozenAt: string;
  readonly status: 'awaiting_report' | 'evaluated'; readonly releaseGate: 'not_evaluated' | 'blocked' | 'passed';
  readonly reportRef?: GoalResourceRefV2; readonly evidence: readonly TeamSkillEvidenceV2[]; readonly comparison?: JsonObject;
  readonly submittedBy?: string; readonly submittedAt?: string;
}
export interface TeamSkillActivationV2 {
  readonly workspaceId: string; readonly skillId: string; readonly streamVersion: number;
  readonly activeRef: TeamSkillRefV2 | null; readonly evaluationId?: string; readonly recommendationEnabled: boolean; readonly updatedAt?: string;
}
export interface TeamSkillSummaryV2 extends TeamSkillRefV2 {
  readonly stopControl?: { readonly expectedStreamVersion: number };
  readonly title: string; readonly description: string; readonly pluginId: 'opc' | 'coding';
  readonly validation: 'unmeasured' | 'passed' | 'failed'; readonly recommended: boolean; readonly available: boolean; readonly unavailableReason?: string;
}
export interface TeamSkillDetailV2 {
  readonly streamVersion: number; readonly version: TeamSkillVersionV2; readonly versions: readonly TeamSkillSummaryV2[];
  readonly validation: 'unmeasured' | 'passed' | 'failed'; readonly evaluations: readonly TeamSkillEvaluationV2[]; readonly activation: TeamSkillActivationV2;
  readonly allowedActions: { readonly trial: boolean; readonly createVersion: boolean; readonly enable: boolean; readonly rollback: boolean; readonly disable: boolean };
  readonly staleReasons: readonly string[];
}
export interface TeamSkillListV2 { readonly items: readonly TeamSkillSummaryV2[] }
export interface CreateTeamSkillVersionV2 {
  readonly skillId: string; readonly expectedStreamVersion: number; readonly source: TeamSkillSourceV2;
  readonly title: string; readonly description: string; readonly roles: readonly TeamSkillRoleV2[];
}
export interface RegisterTeamSkillEvaluationV2 {
  readonly expectedStreamVersion: 0; readonly skillRef: TeamSkillRefV2; readonly executionMode: 'measured' | 'test_fixture';
  readonly configuration: TeamSkillEvaluationConfigurationV2; readonly baselineRevision: string; readonly candidateRevision: string;
}
export interface SubmitTeamSkillEvaluationV2 {
  readonly expectedStreamVersion: number; readonly reportRef: GoalResourceRefV2; readonly evidence: readonly TeamSkillEvidenceV2[];
}
export type CommandTeamSkillV2 =
  | { readonly expectedStreamVersion: number; readonly command: 'disable' }
  | { readonly expectedStreamVersion: number; readonly command: 'enable' | 'rollback'; readonly skillRef: TeamSkillRefV2; readonly evaluationId: string; readonly recommendationEnabled: boolean };

function fail(): never { throw new TypeError('团队技能字段、版本或证据格式无效'); }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const item = value as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(item).length || required.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => ![...required, ...optional].includes(key))) fail();
  return item;
}
function text(value: unknown, max = 200): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(); }
function integer(value: unknown, min = 0): void { if (!Number.isSafeInteger(value) || Number(value) < min) fail(); }
function digest(value: unknown): void { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(); }
function revision(value: unknown): void { if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) fail(); }
function ref(value: unknown): void { const item = object(value, ['namespace', 'resourceId', 'streamVersion', 'digest']); text(item.namespace); text(item.resourceId); integer(item.streamVersion, 1); digest(item.digest); }
export function parseTeamSkillRefV2(value: unknown): TeamSkillRefV2 {
  const item = object(value, ['id', 'version', 'digest']); text(item.id); digest(item.digest);
  if (typeof item.version !== 'string' || !/^[1-9][0-9]{0,5}$/u.test(item.version)) fail();
  return structuredClone(value) as TeamSkillRefV2;
}
export function parseCreateTeamSkillVersionV2(value: unknown): CreateTeamSkillVersionV2 {
  const item = object(value, ['skillId', 'expectedStreamVersion', 'source', 'title', 'description', 'roles']);
  text(item.skillId); integer(item.expectedStreamVersion); text(item.title); text(item.description, 2000);
  const source = object(item.source, ['goalId', 'planRevisionId', 'deliverySetId', 'deliveryDigest']);
  for (const field of ['goalId', 'planRevisionId', 'deliverySetId']) text(source[field]); digest(source.deliveryDigest);
  if (!Array.isArray(item.roles) || item.roles.length > 12) fail();
  const nodes = new Set();
  for (const value of item.roles) {
    const role = object(value, ['nodeId', 'instructions', 'sourceRefs']); text(role.nodeId); text(role.instructions, 4000);
    if (nodes.has(role.nodeId)) fail(); nodes.add(role.nodeId);
    if (!Array.isArray(role.sourceRefs) || role.sourceRefs.length > 20) fail(); role.sourceRefs.forEach(ref);
  }
  return structuredClone(value) as CreateTeamSkillVersionV2;
}
export function parseRegisterTeamSkillEvaluationV2(value: unknown): RegisterTeamSkillEvaluationV2 {
  const item = object(value, ['expectedStreamVersion', 'skillRef', 'executionMode', 'configuration', 'baselineRevision', 'candidateRevision']);
  if (item.expectedStreamVersion !== 0 || !['measured', 'test_fixture'].includes(String(item.executionMode))) fail();
  parseTeamSkillRefV2(item.skillRef); revision(item.baselineRevision); revision(item.candidateRevision);
  const config = object(item.configuration, ['model', 'promptSha256', 'policySha256', 'materialsSha256', 'budget']);
  digest(config.promptSha256); digest(config.policySha256); digest(config.materialsSha256);
  const model = object(config.model, ['provider', 'name', 'revision', 'parameters']); text(model.provider); text(model.name); text(model.revision);
  if (['latest', 'auto', 'default'].includes(model.revision.toLowerCase())) fail();
  const params = object(model.parameters, ['temperature']);
  if (typeof params.temperature !== 'number' || !Number.isFinite(params.temperature) || params.temperature < 0 || params.temperature > 2) fail();
  const budget = object(config.budget, ['revision', 'maxTokens', 'maxCostMinorUnits', 'currency']);
  if (budget.revision !== 'budget-v1' || typeof budget.maxCostMinorUnits !== 'string' || !/^(0|[1-9][0-9]{0,29})$/u.test(budget.maxCostMinorUnits)
    || typeof budget.currency !== 'string' || !/^[A-Z]{3}$/u.test(budget.currency)) fail(); integer(budget.maxTokens, 1);
  return structuredClone(value) as RegisterTeamSkillEvaluationV2;
}
export function parseSubmitTeamSkillEvaluationV2(value: unknown): SubmitTeamSkillEvaluationV2 {
  const item = object(value, ['expectedStreamVersion', 'reportRef', 'evidence']); integer(item.expectedStreamVersion, 1); ref(item.reportRef);
  if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 2000) fail();
  const seen = new Set<string>();
  for (const value of item.evidence) {
    const evidence = object(value, ['artifactRef', 'artifactSha256', 'method'], ['reviewer', 'check']); ref(evidence.artifactRef); digest(evidence.artifactSha256);
    if (evidence.method === 'human') { text(evidence.reviewer); if (evidence.check !== undefined) fail(); }
    else if (evidence.method === 'deterministic') { text(evidence.check); if (evidence.reviewer !== undefined) fail(); } else fail();
    const key = JSON.stringify([evidence.artifactSha256, evidence.method, evidence.reviewer ?? evidence.check]);
    if (seen.has(key)) fail(); seen.add(key);
  }
  return structuredClone(value) as SubmitTeamSkillEvaluationV2;
}
export function parseCommandTeamSkillV2(value: unknown): CommandTeamSkillV2 {
  const shape = object(value, ['expectedStreamVersion', 'command'], ['skillRef', 'evaluationId', 'recommendationEnabled']); integer(shape.expectedStreamVersion);
  if (shape.command === 'disable') object(value, ['expectedStreamVersion', 'command']);
  else {
    object(value, ['expectedStreamVersion', 'command', 'skillRef', 'evaluationId', 'recommendationEnabled']);
    if (!['enable', 'rollback'].includes(String(shape.command)) || typeof shape.recommendationEnabled !== 'boolean') fail();
    parseTeamSkillRefV2(shape.skillRef); text(shape.evaluationId);
  }
  return structuredClone(value) as CommandTeamSkillV2;
}
