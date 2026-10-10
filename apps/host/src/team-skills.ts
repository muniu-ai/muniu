// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { parseCreateTeamSkillVersionV2, parseRegisterTeamSkillEvaluationV2, parseSubmitTeamSkillEvaluationV2, parseCommandTeamSkillV2,
  type CommandTeamSkillV2, type CreateTeamSkillVersionV2, type GoalDeliveryAcceptanceV2, type GoalDeliverySetV2, type GoalTeamPlanRevisionV2, type GoalV2, type JsonObject,
  type RegisterTeamSkillEvaluationV2, type SubmitTeamSkillEvaluationV2, type TeamSkillActivationV2, type TeamSkillDetailV2, type TeamSkillEvaluationV2, type TeamSkillListV2,
  type TeamSkillRefV2, type TeamSkillSourceV2, type TeamSkillSummaryV2, type TeamSkillVersionV2, type GoalResourceRefV2, type Thread, type Workspace } from '@mn/contracts';
import { appendKernelEvent, KernelError, sha256, type KernelTransaction } from '@mn/kernel';
import { compareTeamSkillReport, TEAM_SKILL_BENCHMARK, extractTeamSkillDefinition, teamSkillResultsDigest } from '@mn/task-orchestration';
import { assertContextSource, type ContextSourceValidator } from '@mn/worker';
import type { GoalScope, GoalServiceOptions } from './goals.js';
import type { GoalDeliveryHistoryRecord } from './goal-delivery-service.js';
import { assertAssetReader } from './asset-context.js';
import { readAssetContent } from './assets.js';
import { assertTeamSkillReader, teamSkillMatchesGoal, readTeamSkillVersion, teamSkillRef, teamSkillVersionId, TEAM_SKILL_VERSION_NAMESPACE } from './team-skill-context.js';

export interface TeamSkillAcceptedSource { readonly goal: GoalV2; readonly plan: GoalTeamPlanRevisionV2; readonly deliverySet: GoalDeliverySetV2; readonly acceptanceId: string }
export interface TeamSkillApplicationPorts {
  assertDelivery(tx: KernelTransaction, scope: GoalScope, source: TeamSkillAcceptedSource): void;
  readonly validateContextSource: ContextSourceValidator;
  readonly isTemplateAvailable?: (tx: KernelTransaction, scope: GoalScope, skill: TeamSkillVersionV2) => boolean;
}
export interface TeamSkillServiceOptions extends Omit<GoalServiceOptions, 'ports'> { readonly ports: TeamSkillApplicationPorts }
interface SkillState { id: string; tenantId: string; workspaceId: string; skillId: string; streamVersion: number; latestVersion: string }
const STATE = 'team.skill', EVALUATION = 'team.skillEvaluation', ACTIVATION = 'team.skillActivation';
function fail(code: string): never { throw new KernelError(code, '团队技能操作或评测证据无效', '核对来源、固定版本、评测报告和当前权限'); }
const stateId = (options: GoalScope, skillId: string) => `skill:${sha256([options.workspaceId, skillId])}`;
function guard(tx: KernelTransaction, options: TeamSkillServiceOptions, owner = false): void {
  if (!options.protectedJournal || !options.cas || !options.keyProvider) fail('PROTECTED_PAYLOAD_UNAVAILABLE');
  assertTeamSkillReader(tx, options, owner);
}
function event(tx: KernelTransaction, options: TeamSkillServiceOptions, namespace: string, id: string, previous: number, type: string): void {
  appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: namespace, aggregateId: id, expectedStreamVersion: previous,
    type, actorId: options.principalId, generation: 0, correlationId: options.id('team-skill-event'), publicPayload: { workspaceId: options.workspaceId } });
}
function record<T extends object>(value: T): T & { digest: string } { return { ...value, digest: sha256(value) }; }
function verifyRecord(value: { digest: string }): void { const { digest, ...body } = value; if (sha256(body) !== digest) fail('TEAM_SKILL_RECORD_CHANGED'); }
function state(tx: KernelTransaction, options: GoalScope, skillId: string): SkillState | undefined {
  const value = tx.getProjection<SkillState>(STATE, stateId(options, skillId));
  if (value && (value.tenantId !== options.tenantId || value.workspaceId !== options.workspaceId || value.skillId !== skillId)) fail('TEAM_SKILL_SCOPE_INVALID'); return value;
}
function version(tx: KernelTransaction, options: GoalScope, skillId: string, requested?: string): TeamSkillVersionV2 {
  const current = state(tx, options, skillId); if (!current) fail('TEAM_SKILL_NOT_FOUND');
  const value = tx.getProjection<TeamSkillVersionV2>(TEAM_SKILL_VERSION_NAMESPACE, teamSkillVersionId(options.workspaceId, skillId, requested ?? current.latestVersion));
  if (!value) fail('TEAM_SKILL_NOT_FOUND'); return readTeamSkillVersion(tx, options, teamSkillRef(value));
}
function activation(tx: KernelTransaction, options: GoalScope, skillId: string): TeamSkillActivationV2 {
  return tx.getProjection<TeamSkillActivationV2>(ACTIVATION, stateId(options, skillId)) ?? { workspaceId: options.workspaceId, skillId, streamVersion: 0, activeRef: null, recommendationEnabled: false };
}
function validateEvidenceRefs(tx: KernelTransaction, options: TeamSkillServiceOptions, value: TeamSkillEvaluationV2): void {
  verifyRecord(value);
  readTeamSkillVersion(tx, options, value.skillRef);
  if (value.reportRef) assertAssetReader(tx, options, value.reportRef, options.ports.validateContextSource);
  for (const evidence of value.evidence) assertAssetReader(tx, options, evidence.artifactRef, options.ports.validateContextSource);
}
function evaluations(tx: KernelTransaction, options: TeamSkillServiceOptions, skill: TeamSkillVersionV2): TeamSkillEvaluationV2[] {
  return tx.listProjections<TeamSkillEvaluationV2>(EVALUATION).filter(value => value.tenantId === options.tenantId && value.workspaceId === options.workspaceId
    && sha256(value.skillRef) === sha256(teamSkillRef(skill))).map(value => { validateEvidenceRefs(tx, options, value); return value; });
}
function stopControl(tx: KernelTransaction, options: TeamSkillServiceOptions, skillId: string): { readonly expectedStreamVersion: number } | undefined {
  try { assertTeamSkillReader(tx, options, true); const current = activation(tx, options, skillId); return current.activeRef ? { expectedStreamVersion: current.streamVersion } : undefined; } catch { return undefined; }
}
function summary(tx: KernelTransaction, options: TeamSkillServiceOptions, value: TeamSkillVersionV2): TeamSkillSummaryV2 {
  const refs = evaluations(tx, options, value), last = refs.filter(item => item.status === 'evaluated').at(-1);
  return { ...teamSkillRef(value), ...(stopControl(tx, options, value.skillId) ? { stopControl: stopControl(tx, options, value.skillId) } : {}), title: value.title, description: value.description, pluginId: value.pluginId,
    validation: last ? last.releaseGate === 'passed' ? 'passed' : 'failed' : 'unmeasured', recommended: false, available: true };
}
function detail(tx: KernelTransaction, options: TeamSkillServiceOptions, skillId: string, requested?: string): TeamSkillDetailV2 {
  const selected = version(tx, options, skillId, requested), status = summary(tx, options, selected), refs = evaluations(tx, options, selected);
  const currentActivation = activation(tx, options, skillId);
  let owner = true; try { assertTeamSkillReader(tx, options, true); } catch { owner = false; }
  const passed = refs.some(item => item.executionMode === 'measured' && item.releaseGate === 'passed');
  const versions = tx.listProjections<TeamSkillVersionV2>(TEAM_SKILL_VERSION_NAMESPACE).filter(value => value.workspaceId === options.workspaceId && value.tenantId === options.tenantId && value.skillId === skillId)
    .sort((a, b) => Number(b.version) - Number(a.version)).map(value => { try { return summary(tx, options, readTeamSkillVersion(tx, options, teamSkillRef(value))); }
      catch { return { ...teamSkillRef(value), title: '来源已不可用', description: '', pluginId: value.pluginId, validation: 'unmeasured' as const, recommended: false, available: false, unavailableReason: '来源或评测证据已不可用' }; } });
  return { streamVersion: state(tx, options, skillId)!.streamVersion, version: selected, versions, validation: status.validation, evaluations: refs, activation: currentActivation,
    allowedActions: { trial: true, createVersion: owner, enable: owner && passed, rollback: owner && passed && !!currentActivation.activeRef && Number(selected.version) < Number(currentActivation.activeRef.version), disable: owner && !!currentActivation.activeRef }, staleReasons: [] };
}
function acceptedSource(tx: KernelTransaction, options: TeamSkillServiceOptions, input: TeamSkillSourceV2): TeamSkillAcceptedSource {
  let goal = tx.getProjection<GoalV2>('goal.state', input.goalId);
  if (!goal || goal.tenantId !== options.tenantId || goal.workspaceId !== options.workspaceId) fail('TEAM_SKILL_SOURCE_INVALID');
  if (goal.planRevisionId !== input.planRevisionId || goal.deliverySetId !== input.deliverySetId) {
    const history = tx.getProjection<GoalDeliveryHistoryRecord>('goal.deliveryHistory', `${input.goalId}:${input.planRevisionId}`);
    if (!history || history.tenantId !== options.tenantId || history.workspaceId !== options.workspaceId || history.deliverySet.id !== input.deliverySetId) fail('TEAM_SKILL_SOURCE_INVALID'); goal = history.goal;
  }
  const plan = tx.getProjection<GoalTeamPlanRevisionV2>('goal.plan', input.planRevisionId), deliverySet = tx.getProjection<GoalDeliverySetV2>('goal.deliverySet', input.deliverySetId);
  if (!plan || plan.kind !== 'team-v1' || plan.goalId !== goal.id || plan.threadId !== goal.threadId || !deliverySet || deliverySet.goalId !== goal.id
    || deliverySet.planRevisionId !== plan.id || deliverySet.digest !== input.deliveryDigest || goal.status !== 'accepted' || !goal.acceptanceId) fail('TEAM_SKILL_ACCEPTANCE_REQUIRED');
  verifyRecord(plan);
  if (deliverySet.digest !== sha256({ goalId: goal.id, planRevisionId: plan.id, criteriaVersion: deliverySet.criteriaVersion, items: deliverySet.items }) || deliverySet.criteriaVersion !== plan.criteriaVersion) fail('TEAM_SKILL_SOURCE_INVALID');
  const acceptance = tx.getProjection<GoalDeliveryAcceptanceV2>('goal.deliveryAcceptance', goal.acceptanceId);
  if (!acceptance || acceptance.goalId !== goal.id || acceptance.deliverySetId !== deliverySet.id || acceptance.criteriaVersion !== plan.criteriaVersion
    || acceptance.items.length !== deliverySet.items.length || plan.deliverables.some(spec => spec.required && !deliverySet.items.some(item => item.key === spec.key))
    || deliverySet.items.some(item => item.checks.some(check => check.status === 'failed') || !acceptance.items.some(accepted => accepted.key === item.key && accepted.digest === item.digest
      && plan.deliverables.find(spec => spec.key === item.key)!.criteria.every(rule => accepted.reviewedCriterionIds.includes(rule.id))))) fail('TEAM_SKILL_ACCEPTANCE_REQUIRED');
  const source = { goal, plan, deliverySet, acceptanceId: goal.acceptanceId }; options.ports.assertDelivery(tx, options, source); return source;
}
function replay<T>(tx: KernelTransaction, options: TeamSkillServiceOptions, operation: string, key: string, input: unknown): { cached?: T; save(value: T): T } {
  if (!key.trim() || key.length > 200) fail('IDEMPOTENCY_KEY_REQUIRED');
  const scope = `team-skill:${options.workspaceId}:${operation}`, requestDigest = sha256({ principalId: options.principalId, input });
  const previous = tx.getIdempotency(scope, key); if (previous && previous.requestDigest !== requestDigest) fail('IDEMPOTENCY_KEY_REUSED');
  return { ...(previous ? { cached: previous.response as T } : {}), save(value) { tx.putIdempotency({ tenantId: options.tenantId, scope, key, requestDigest, response: value, createdAt: options.now() }); return value; } };
}
function recommended(tx: KernelTransaction, options: TeamSkillServiceOptions, skill: TeamSkillVersionV2, goal?: GoalV2): boolean {
  if (!goal || !teamSkillMatchesGoal(skill, goal)) return false;
  const thread = tx.getProjection<Thread>('thread', goal.threadId), workspace = tx.getProjection<Workspace>('workspace', options.workspaceId);
  if (!thread || thread.workspaceId !== options.workspaceId || thread.tenantId !== options.tenantId || thread.pluginId !== skill.pluginId
    || !workspace || skill.permissionRequirements.some(role => !workspace.activePluginIds.includes(role.pluginId))
    || options.ports.isTemplateAvailable?.(tx, options, skill) === false) return false;
  try {
    for (const ref of goal.resourceRefs) assertContextSource(tx, options, ref, options.ports.validateContextSource);
    const active = activation(tx, options, skill.skillId);
    if (!active.recommendationEnabled || !active.activeRef || sha256(active.activeRef) !== sha256(teamSkillRef(skill)) || !active.evaluationId) return false;
    const proof = evaluation(tx, options, skill.skillId, active.evaluationId);
    return proof.executionMode === 'measured' && proof.status === 'evaluated' && proof.releaseGate === 'passed' && sha256(proof.skillRef) === sha256(active.activeRef);
  } catch { return false; }
}
export async function listTeamSkills(options: TeamSkillServiceOptions, goalId?: string): Promise<TeamSkillListV2> {
  return options.store.transact(options.tenantId, tx => {
    guard(tx, options);
    const goal = goalId ? tx.getProjection<GoalV2>('goal.state', goalId) : undefined;
    if (goalId && (!goal || goal.tenantId !== options.tenantId || goal.workspaceId !== options.workspaceId)) fail('TEAM_SKILL_SCOPE_INVALID');
    return { items: tx.listProjections<SkillState>(STATE).filter(item => item.tenantId === options.tenantId && item.workspaceId === options.workspaceId).flatMap(item => {
      try {
        const active = activation(tx, options, item.skillId);
        let selected = version(tx, options, item.skillId);
        if (goal && active.activeRef) {
          try { const candidate = readTeamSkillVersion(tx, options, active.activeRef); if (recommended(tx, options, candidate, goal)) selected = candidate; } catch { /* Unavailable versions cannot be recommended. */ }
        }
        return [{ ...summary(tx, options, selected), recommended: recommended(tx, options, selected, goal) }];
      } catch {
        const raw = tx.getProjection<TeamSkillVersionV2>(TEAM_SKILL_VERSION_NAMESPACE, teamSkillVersionId(options.workspaceId, item.skillId, item.latestVersion));
        if (!raw || raw.tenantId !== options.tenantId || raw.workspaceId !== options.workspaceId) return [];
        return [{ id: item.skillId, version: item.latestVersion, digest: raw.digest, title: '来源已不可用', description: '', pluginId: raw.pluginId, validation: 'unmeasured' as const, recommended: false, available: false, unavailableReason: '来源或评测证据已不可用',
          ...(stopControl(tx, options, item.skillId) ? { stopControl: stopControl(tx, options, item.skillId) } : {}) }];
      }
    }) };
  });
}
export async function getTeamSkill(options: TeamSkillServiceOptions, skillId: string, requested?: string): Promise<TeamSkillDetailV2> {
  return options.store.transact(options.tenantId, tx => { guard(tx, options); return detail(tx, options, skillId, requested); });
}
export async function createTeamSkillVersion(options: TeamSkillServiceOptions, raw: CreateTeamSkillVersionV2, key: string): Promise<TeamSkillDetailV2> {
  const input = parseCreateTeamSkillVersionV2(raw);
  return options.store.transact(options.tenantId, tx => {
    guard(tx, options, true); const receipt = replay<TeamSkillDetailV2>(tx, options, 'create', key, input);
    if (receipt.cached) { version(tx, options, input.skillId, receipt.cached.version.version); return receipt.cached; }
    const current = state(tx, options, input.skillId);
    if ((current?.streamVersion ?? 0) !== input.expectedStreamVersion) fail('STREAM_VERSION_CONFLICT');
    if (Number(current?.latestVersion ?? 0) >= 100 || (!current && tx.listProjections<SkillState>(STATE).filter(value => value.workspaceId === options.workspaceId).length >= 100)) fail('TEAM_SKILL_LIMIT_REACHED');
    const source = acceptedSource(tx, options, input.source), definition = extractTeamSkillDefinition(source.plan);
    const agentNodes = definition.nodes.filter(node => node.kind === 'agent');
    if (input.roles.some(role => !agentNodes.some(node => node.id === role.nodeId))) fail('TEAM_SKILL_ROLE_INVALID');
    for (const role of input.roles) for (const ref of role.sourceRefs) {
      if (ref.namespace !== 'asset' && !ref.namespace.startsWith('opc.business.')) fail('TEAM_SKILL_SOURCE_INVALID');
      assertContextSource(tx, options, ref, options.ports.validateContextSource);
      if (ref.namespace === 'asset') assertAssetReader(tx, options, ref, options.ports.validateContextSource);
    }
    const nextVersion = String(Number(current?.latestVersion ?? 0) + 1);
    const value: TeamSkillVersionV2 = record({ schemaVersion: '1' as const, id: teamSkillVersionId(options.workspaceId, input.skillId, nextVersion), tenantId: options.tenantId, workspaceId: options.workspaceId,
      skillId: input.skillId, version: nextVersion, streamVersion: 1 as const, title: input.title, description: input.description, pluginId: source.plan.pluginId, template: source.plan.template,
      source: { ...input.source, acceptanceId: source.acceptanceId }, ...definition,
      roles: agentNodes.map(node => input.roles.find(role => role.nodeId === node.id) ?? { nodeId: node.id, instructions: node.title, sourceRefs: [] }),
      sourceRefs: source.plan.resourceRefs, createdAt: options.now(), createdBy: options.principalId });
    tx.putProjection(TEAM_SKILL_VERSION_NAMESPACE, value.id, value); event(tx, options, TEAM_SKILL_VERSION_NAMESPACE, value.id, 0, 'team.skill_version_created');
    const next: SkillState = { id: stateId(options, input.skillId), tenantId: options.tenantId, workspaceId: options.workspaceId, skillId: input.skillId, streamVersion: (current?.streamVersion ?? 0) + 1, latestVersion: nextVersion };
    tx.putProjection(STATE, next.id, next); event(tx, options, STATE, next.id, current?.streamVersion ?? 0, 'team.skill_version_registered');
    return receipt.save(detail(tx, options, input.skillId));
  });
}
export async function registerTeamSkillEvaluation(options: TeamSkillServiceOptions, skillId: string, raw: RegisterTeamSkillEvaluationV2, key: string): Promise<TeamSkillEvaluationV2> {
  const input = parseRegisterTeamSkillEvaluationV2(raw);
  return options.store.transact(options.tenantId, tx => {
    guard(tx, options, true); if (input.skillRef.id !== skillId) fail('TEAM_SKILL_SCOPE_INVALID'); readTeamSkillVersion(tx, options, input.skillRef);
    const receipt = replay<TeamSkillEvaluationV2>(tx, options, `register:${skillId}`, key, input); if (receipt.cached) { validateEvidenceRefs(tx, options, receipt.cached); return receipt.cached; }
    if (input.configuration.materialsSha256 !== TEAM_SKILL_BENCHMARK.manifest.tasksSha256) fail('TEAM_SKILL_DATASET_MISMATCH');
    if (tx.listProjections<TeamSkillEvaluationV2>(EVALUATION).filter(value => value.workspaceId === options.workspaceId && value.skillRef.id === skillId).length >= 100) fail('TEAM_SKILL_LIMIT_REACHED');
    const value: TeamSkillEvaluationV2 = record({ id: options.id('skill-evaluation'), tenantId: options.tenantId, workspaceId: options.workspaceId, streamVersion: 1,
      skillRef: input.skillRef, datasetVersion: '1.0.0' as const, datasetDigest: TEAM_SKILL_BENCHMARK.manifest.tasksSha256,
      executionMode: input.executionMode, configuration: input.configuration, configurationDigest: sha256(input.configuration), baselineRevision: input.baselineRevision, candidateRevision: input.candidateRevision,
      frozenAt: options.now(), status: 'awaiting_report' as const, releaseGate: 'not_evaluated' as const, evidence: [] });
    tx.putProjection(EVALUATION, value.id, value); event(tx, options, EVALUATION, value.id, 0, 'team.skill_evaluation_registered'); return receipt.save(value);
  });
}
function evaluation(tx: KernelTransaction, options: TeamSkillServiceOptions, skillId: string, evaluationId: string): TeamSkillEvaluationV2 {
  const value = tx.getProjection<TeamSkillEvaluationV2>(EVALUATION, evaluationId);
  if (!value || value.tenantId !== options.tenantId || value.workspaceId !== options.workspaceId || value.skillRef.id !== skillId) fail('TEAM_SKILL_EVALUATION_INVALID');
  validateEvidenceRefs(tx, options, value); return value;
}
async function readJson(options: TeamSkillServiceOptions, ref: GoalResourceRefV2, maxBytes: number): Promise<{ json: any; plaintextDigest: string; byteLength: number }> {
  const asset = await options.store.transact(options.tenantId, tx => { guard(tx, options, true); const asset = assertAssetReader(tx, options, ref, options.ports.validateContextSource);
    if (ref.namespace !== 'asset' || asset.mediaType !== 'application/json' || asset.byteLength > maxBytes) fail('TEAM_SKILL_REPORT_TOO_LARGE'); return asset; });
  const bytes = await readAssetContent({ store: options.store, cas: options.cas, protectedPayloadKeyProvider: options.keyProvider, tenantId: options.tenantId, principalId: options.principalId, asset, validateContextSource: options.ports.validateContextSource });
  await options.store.transact(options.tenantId, tx => { guard(tx, options, true); assertAssetReader(tx, options, ref, options.ports.validateContextSource); });
  try { return { json: JSON.parse(bytes.toString('utf8')), plaintextDigest: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength }; }
  catch { return fail('TEAM_SKILL_REPORT_INVALID'); } finally { bytes.fill(0); }
}
export async function submitTeamSkillEvaluation(options: TeamSkillServiceOptions, skillId: string, evaluationId: string, raw: SubmitTeamSkillEvaluationV2, key: string): Promise<TeamSkillEvaluationV2> {
  const input = parseSubmitTeamSkillEvaluationV2(raw);
  const prepared = await options.store.transact(options.tenantId, tx => { guard(tx, options, true); const value = evaluation(tx, options, skillId, evaluationId);
    const receipt = replay<TeamSkillEvaluationV2>(tx, options, `submit:${evaluationId}`, key, input);
    if (receipt.cached) { validateEvidenceRefs(tx, options, receipt.cached); return { value, replay: receipt.cached }; }
    if (value.streamVersion !== input.expectedStreamVersion || value.status !== 'awaiting_report') fail('STREAM_VERSION_CONFLICT'); return { value }; });
  if (prepared.replay) return prepared.replay;
  const report = (await readJson(options, input.reportRef, 4 * 1024 * 1024)).json, fixed = prepared.value;
  if (!report || report.evaluationId !== evaluationId || sha256(report.skillRef) !== sha256(fixed.skillRef) || report.executionMode !== fixed.executionMode
    || report.frozenAt !== fixed.frozenAt || report.configurationSha256 !== fixed.configurationDigest || sha256(report.configuration) !== fixed.configurationDigest
    || report.arms?.find((arm: any) => arm.arm === 'baseline')?.implementationRevision !== fixed.baselineRevision
    || report.arms?.find((arm: any) => arm.arm === 'candidate')?.implementationRevision !== fixed.candidateRevision) fail('TEAM_SKILL_REPORT_BINDING_INVALID');
  const resultsDigest = teamSkillResultsDigest(report);
  if (report.arms?.some((arm: any) => arm.results?.some((result: any) => Date.parse(result.startedAt) > Date.parse(options.now())))) fail('TEAM_SKILL_REPORT_INVALID');
  const evidence = new Map<string, any>(), readAssets = new Map<string, { json: any; plaintextDigest: string; byteLength: number }>(); let bytes = 0;
  for (const item of input.evidence) {
    const key = sha256(item.artifactRef); let artifact = readAssets.get(key);
    if (!artifact) { artifact = await readJson(options, item.artifactRef, 1024 * 1024); bytes += artifact.byteLength; if (bytes > 16 * 1024 * 1024) fail('TEAM_SKILL_REPORT_TOO_LARGE'); readAssets.set(key, artifact); }
    if (artifact.plaintextDigest !== item.artifactSha256 || artifact.json.format !== 'muniu.skill-evidence.v1' || artifact.json.evaluationId !== evaluationId
      || artifact.json.executionMode !== fixed.executionMode || artifact.json.resultsDigest !== resultsDigest || artifact.json.configurationDigest !== fixed.configurationDigest || sha256(artifact.json.skillRef) !== sha256(fixed.skillRef)
      || artifact.json.method !== item.method || (item.method === 'human' ? artifact.json.reviewer !== item.reviewer || item.reviewer !== options.principalId : artifact.json.check !== item.check)) fail('TEAM_SKILL_EVIDENCE_INVALID');
    evidence.set(sha256({ artifactSha256: item.artifactSha256, method: item.method, ...(item.method === 'human' ? { reviewer: item.reviewer } : { check: item.check }) }), artifact.json);
  }
  let evidenceCount = 0;
  const visit = (value: any, depth = 0): void => {
    if (depth > 32) fail('TEAM_SKILL_REPORT_INVALID');
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) { if (key === 'evidence') { if (!evidence.has(sha256(item))) fail('TEAM_SKILL_EVIDENCE_INVALID'); evidenceCount++; } else visit(item, depth + 1); }
  };
  visit(report); if (!evidenceCount) fail('TEAM_SKILL_EVIDENCE_INVALID');
  let comparison: JsonObject;
  try { comparison = JSON.parse(JSON.stringify(compareTeamSkillReport(TEAM_SKILL_BENCHMARK, { ...report, executionMode: 'measured' }))) as JsonObject; } catch { return fail('TEAM_SKILL_REPORT_INVALID'); }
  return options.store.transact(options.tenantId, tx => {
    guard(tx, options, true); const current = evaluation(tx, options, skillId, evaluationId), receipt = replay<TeamSkillEvaluationV2>(tx, options, `submit:${evaluationId}`, key, input);
    if (receipt.cached) { validateEvidenceRefs(tx, options, receipt.cached); return receipt.cached; }
    if (current.streamVersion !== input.expectedStreamVersion || current.digest !== fixed.digest || current.status !== 'awaiting_report') fail('STREAM_VERSION_CONFLICT');
    assertAssetReader(tx, options, input.reportRef, options.ports.validateContextSource); for (const evidence of input.evidence) assertAssetReader(tx, options, evidence.artifactRef, options.ports.validateContextSource);
    const { digest: _digest, ...body } = current;
    const result: TeamSkillEvaluationV2 = record({ ...body, streamVersion: current.streamVersion + 1, status: 'evaluated' as const,
      releaseGate: fixed.executionMode === 'measured' && comparison.releaseGate === 'passed' ? 'passed' as const : 'blocked' as const,
      reportRef: input.reportRef, evidence: input.evidence, comparison, submittedBy: options.principalId, submittedAt: options.now() });
    tx.putProjection(EVALUATION, result.id, result); event(tx, options, EVALUATION, result.id, current.streamVersion, 'team.skill_evaluation_submitted'); return receipt.save(result);
  });
}
export async function commandTeamSkill(options: TeamSkillServiceOptions, skillId: string, raw: CommandTeamSkillV2, key: string): Promise<TeamSkillActivationV2> {
  const input = parseCommandTeamSkillV2(raw);
  return options.store.transact(options.tenantId, tx => {
    guard(tx, options, true); const receipt = replay<TeamSkillActivationV2>(tx, options, `command:${skillId}`, key, input);
    if (!state(tx, options, skillId)) fail('TEAM_SKILL_NOT_FOUND');
    if (receipt.cached) { if (input.command !== 'disable') { readTeamSkillVersion(tx, options, input.skillRef); evaluation(tx, options, skillId, input.evaluationId); } return receipt.cached; }
    const current = activation(tx, options, skillId); if (current.streamVersion !== input.expectedStreamVersion) fail('STREAM_VERSION_CONFLICT');
    if (input.command !== 'disable') {
      if (input.skillRef.id !== skillId) fail('TEAM_SKILL_SCOPE_INVALID'); readTeamSkillVersion(tx, options, input.skillRef);
      const proof = evaluation(tx, options, skillId, input.evaluationId);
      if (proof.executionMode !== 'measured' || proof.releaseGate !== 'passed' || proof.status !== 'evaluated' || sha256(proof.skillRef) !== sha256(input.skillRef)) fail('TEAM_SKILL_QUALITY_GATE_REQUIRED');
      if (input.command === 'rollback' && (!current.activeRef || Number(input.skillRef.version) >= Number(current.activeRef.version))) fail('TEAM_SKILL_ROLLBACK_INVALID');
    }
    const next: TeamSkillActivationV2 = { workspaceId: options.workspaceId, skillId, streamVersion: current.streamVersion + 1, activeRef: input.command === 'disable' ? null : input.skillRef,
      ...(input.command === 'disable' ? {} : { evaluationId: input.evaluationId }), recommendationEnabled: input.command !== 'disable' && input.recommendationEnabled, updatedAt: options.now() };
    tx.putProjection(ACTIVATION, stateId(options, skillId), next); event(tx, options, ACTIVATION, stateId(options, skillId), current.streamVersion, 'team.skill_activation_changed');
    return receipt.save(next);
  });
}
