// SPDX-License-Identifier: Apache-2.0
import { parseEnterpriseContract, type EnterpriseContractTypes } from '@mn/contracts';
import { sha256, type KernelTransaction } from '@mn/kernel';
import { EnterpriseError, type EnterpriseActor } from '@mn/enterprise-services';
import { EnterpriseArtifactService } from './enterprise-artifacts.js';
import { EnterpriseKnowledgeService, KNOWLEDGE_USE } from './enterprise-knowledge.js';
type Experience = EnterpriseContractTypes['EnterpriseExperienceView'];
export const ENTERPRISE_EXPERIENCE = 'enterprise-experience.version';
export class EnterpriseExperienceService {
  constructor(readonly options: { artifacts: EnterpriseArtifactService; knowledge: EnterpriseKnowledgeService }) {}
  private get operating() { return this.options.knowledge.operating; }
  private key(key: string): void { if (!key.trim() || key.length > 200) throw new EnterpriseError('IDEMPOTENCY_KEY_REQUIRED', 400); }
  private require(tx: KernelTransaction, id: string): Experience { const value = tx.getProjection<Experience>(ENTERPRISE_EXPERIENCE, id); if (!value) throw new EnterpriseError('EXPERIENCE_NOT_FOUND', 404); return value; }
  async propose(actor: EnterpriseActor, artifactId: string, key: string, raw: EnterpriseContractTypes['EnterpriseExperienceProposal']): Promise<Experience> {
    this.key(key); const input = parseEnterpriseContract('EnterpriseExperienceProposal', raw), artifact = await this.options.artifacts.get(actor, artifactId);
    if (artifact.status !== 'accepted') throw new EnterpriseError('ACCEPTED_ARTIFACT_REQUIRED', 409);
    const id = 'experience:' + sha256([artifact.workspaceId, input.id]), digest = sha256([artifactId, input]);
    const material = await this.options.knowledge.createDerived(actor, artifact.workspaceId, 'experience:' + key, { documentId: id, title: input.title, text: input.text, bindings: [{ reference: artifact.reference, fields: ['text'] }], objectType: 'memory_entry', sourceKind: 'candidate_experience', visibility: 'business_scope' });
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      const check = () => { this.options.knowledge.requireReadable(tx, actor, material.reference); }; check(); tx.beforeCommit!(check);
      const existing = tx.getProjection<Experience>(ENTERPRISE_EXPERIENCE, id), receiptId = sha256([actor.principalId, key]), previous = tx.getProjection<{ requestDigest: string }>('enterprise-experience.command', receiptId);
      if (previous) { if (previous.requestDigest !== digest || !existing) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return existing; }
      if (existing) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
      const value: Experience = { id, tenantId: actor.tenantId, workspaceId: artifact.workspaceId, streamVersion: 1, artifactId, reference: material.reference, status: 'proposed', proposedBy: actor.principalId, createdAt: this.operating.now() };
      this.operating.record(tx, 'enterprise-experience.command', { id: receiptId, tenantId: actor.tenantId, workspaceId: value.workspaceId, streamVersion: 1, requestDigest: digest }, actor.principalId, 'experience.command_recorded');
      return this.operating.record(tx, ENTERPRISE_EXPERIENCE, value, actor.principalId, 'experience.proposed');
    });
  }
  async get(actor: EnterpriseActor, id: string): Promise<Experience> { return this.operating.bridge.store.transact(actor.tenantId, tx => { const value = this.require(tx, id); this.options.knowledge.requireReadable(tx, actor, value.reference); return value; }); }
  enable(actor: EnterpriseActor, id: string, expected: number, digest: string, key: string): Promise<Experience> { return this.decide(actor, id, expected, digest, key, true); }
  disable(actor: EnterpriseActor, id: string, expected: number, digest: string, key: string): Promise<Experience> { return this.decide(actor, id, expected, digest, key, false); }
  private async decide(actor: EnterpriseActor, id: string, expected: number, digest: string, key: string, enabled: boolean): Promise<Experience> {
    this.key(key);
    return this.operating.bridge.store.transact(actor.tenantId, tx => {
      const value = this.require(tx, id);
      const check = () => { this.operating.actor(tx, actor, value.workspaceId, true); if (enabled) this.options.knowledge.requireReadable(tx, actor, value.reference); }; check(); tx.beforeCommit!(check);
      const receiptId = sha256([actor.principalId, key]), requestDigest = sha256([id, expected, digest, enabled]), previous = tx.getProjection<{ requestDigest: string }>('enterprise-experience.command', receiptId);
      if (previous) { if (previous.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return value; }
      if (value.streamVersion !== expected) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
      if (value.reference.digest !== digest) throw new EnterpriseError('EXPERIENCE_DIGEST_MISMATCH', 409);
      const use = tx.getProjection<{ streamVersion: number }>(KNOWLEDGE_USE, value.reference.objectId);
      this.operating.record(tx, KNOWLEDGE_USE, { id: value.reference.objectId, tenantId: actor.tenantId, workspaceId: value.workspaceId, streamVersion: (use?.streamVersion ?? 0) + 1, enabled }, actor.principalId, 'knowledge.experience_use_changed');
      this.operating.record(tx, 'enterprise-experience.command', { id: receiptId, tenantId: actor.tenantId, workspaceId: value.workspaceId, streamVersion: 1, requestDigest }, actor.principalId, 'experience.command_recorded');
      return this.operating.record(tx, ENTERPRISE_EXPERIENCE, { ...value, streamVersion: expected + 1, status: enabled ? 'enabled' as const : 'disabled' as const, decidedBy: actor.principalId }, actor.principalId, 'experience.activation_changed');
    });
  }
}
