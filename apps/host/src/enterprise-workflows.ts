// SPDX-License-Identifier: Apache-2.0
import { parseEnterpriseContract, type EnterpriseContractTypes as Types } from '@mn/contracts';
import { BUSINESS_WORKFLOWS } from '@mn/plugin-business';
import { sha256, type KernelTransaction } from '@mn/kernel';
import { EnterpriseError, type EnterpriseActor } from '@mn/enterprise-services';
import { EnterpriseOperatingService } from './enterprise-operating.js';
const STATE = 'enterprise-workflow.state', VERSION = 'enterprise-workflow.version', COMMAND = 'enterprise-workflow.command';
type State = Types['EnterpriseWorkflowState']; type Ref = Types['EnterpriseWorkflowRef']; type Definition = Types['EnterpriseWorkflowDefinition'];
interface Version { id: string; tenantId: string; workspaceId: string; streamVersion: number; reference: Ref; definition: Definition; }
const stateKey = (workspaceId: string, flowId: string) => sha256([workspaceId, flowId]);
const versionKey = (workspaceId: string, ref: Ref) => sha256([workspaceId, ref.id, ref.version]);
export function resolveEnterpriseWorkflow(tx: KernelTransaction, workspaceId: string, spec: Types['EnterpriseGoalSpec'], active = false): Definition | undefined {
  if (!spec.workflow) return undefined;
  const version = tx.getProjection<Version>(VERSION, versionKey(workspaceId, spec.workflow));
  if (!version || sha256(version.reference) !== sha256(spec.workflow)) throw new EnterpriseError('WORKFLOW_VERSION_INVALID', 409);
  if (active && sha256(tx.getProjection<State>(STATE, stateKey(workspaceId, spec.workflow.id))?.active ?? null) !== sha256(spec.workflow)) throw new EnterpriseError('WORKFLOW_NOT_ENABLED', 409);
  if (version.definition.acceptanceCriteria.some(c => !spec.acceptanceCriteria.includes(c))) throw new EnterpriseError('WORKFLOW_ACCEPTANCE_REQUIRED', 409);
  return version.definition;
}
export class EnterpriseWorkflowService {
  constructor(readonly options: { operating: EnterpriseOperatingService }) {}
  async list(actor: EnterpriseActor, workspaceId: string): Promise<Types['EnterpriseWorkflowCatalog']> {
    return this.options.operating.bridge.store.transact(actor.tenantId, tx => { this.options.operating.actor(tx, actor, workspaceId); return { builtins: structuredClone(BUSINESS_WORKFLOWS), states: tx.listProjections<State>(STATE).filter(s => s.workspaceId === workspaceId) }; });
  }
  async read(actor: EnterpriseActor, workspaceId: string, reference: Ref): Promise<Types['EnterpriseWorkflowVersion']> {
    parseEnterpriseContract('EnterpriseWorkflowRef', reference);
    return this.options.operating.bridge.store.transact(actor.tenantId, tx => {
      this.options.operating.actor(tx, actor, workspaceId);
      const version = tx.getProjection<Version>(VERSION, versionKey(workspaceId, reference));
      if (!version || sha256(version.reference) !== sha256(reference)) throw new EnterpriseError('WORKFLOW_VERSION_INVALID', 409);
      return { reference, definition: version.definition };
    });
  }
  private async change(actor: EnterpriseActor, workspaceId: string, flowId: string, expected: number, key: string, request: unknown, work: (tx: KernelTransaction, current: State | undefined) => State): Promise<State> {
    if (!key.trim() || key.length > 200) throw new EnterpriseError('IDEMPOTENCY_KEY_REQUIRED', 400);
    return this.options.operating.bridge.store.transact(actor.tenantId, tx => {
      const operating = this.options.operating, check = () => { operating.actor(tx, actor, workspaceId, true); }; check(); tx.beforeCommit!(check);
      const id = stateKey(workspaceId, flowId), current = tx.getProjection<State>(STATE, id), receiptId = sha256([actor.principalId, workspaceId, key]), digest = sha256(request), prior = tx.getProjection<{ digest: string }>(COMMAND, receiptId);
      if (prior) { if (prior.digest !== digest || !current) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return current; }
      if ((current?.streamVersion ?? 0) !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
      const value = work(tx, current);
      operating.record(tx, COMMAND, { id: receiptId, tenantId: actor.tenantId, workspaceId, streamVersion: 1, digest }, actor.principalId, 'workflow.command_recorded');
      return operating.record(tx, STATE, value, actor.principalId, 'workflow.selection_changed');
    });
  }
  publish(actor: EnterpriseActor, workspaceId: string, expected: number, raw: Definition, key: string): Promise<State> {
    const definition = parseEnterpriseContract('EnterpriseWorkflowDefinition', raw), builtin = BUSINESS_WORKFLOWS.find(f => f.flowId === definition.flowId)!;
    if (builtin.acceptanceCriteria.some(c => !definition.acceptanceCriteria.includes(c)) || sha256(builtin.humanDecisions) !== sha256(definition.humanDecisions) || new Set(definition.stages.map(s => s.id)).size !== definition.stages.length) throw new EnterpriseError('WORKFLOW_SAFEGUARDS_REQUIRED', 409);
    return this.change(actor, workspaceId, definition.flowId, expected, key, ['publish', expected, definition], (tx, current) => {
      if ((current?.versions.length ?? 0) >= 100) throw new EnterpriseError('WORKFLOW_VERSION_LIMIT', 409);
      const revision = (current?.versions.length ?? 0) + 1, reference: Ref = { id: definition.flowId, version: revision, digest: sha256([actor.tenantId, workspaceId, revision, definition]) };
      this.options.operating.record<Version>(tx, VERSION, { id: versionKey(workspaceId, reference), tenantId: actor.tenantId, workspaceId, streamVersion: 1, reference, definition }, actor.principalId, 'workflow.version_published');
      return { id: stateKey(workspaceId, definition.flowId), tenantId: actor.tenantId, workspaceId, streamVersion: expected + 1, flowId: definition.flowId, versions: [...(current?.versions ?? []), reference], ...(current?.active ? { active: current.active } : {}) };
    });
  }
  select(actor: EnterpriseActor, workspaceId: string, flowId: string, expected: number, reference: Ref | null, key: string): Promise<State> {
    if (reference) parseEnterpriseContract('EnterpriseWorkflowRef', reference);
    return this.change(actor, workspaceId, flowId, expected, key, ['select', flowId, expected, reference], (_tx, current) => {
      if (!current || (reference && !current.versions.some(v => sha256(v) === sha256(reference)))) throw new EnterpriseError('WORKFLOW_VERSION_INVALID', 409);
      const { active: _active, ...base } = current;
      return { ...base, streamVersion: expected + 1, ...(reference ? { active: reference } : {}) };
    });
  }
}
