// SPDX-License-Identifier: Apache-2.0
import type { BusinessObjectRef, EvidenceRef, EnterpriseContractTypes as Types } from '@mn/contracts';
import { EnterpriseError, type EnterpriseActor } from '@mn/enterprise-services';
import type { EnterpriseKnowledgeService } from './enterprise-knowledge.js';
import type { EnterpriseArtifactService } from './enterprise-artifacts.js';
import type { EnterpriseExperienceService } from './enterprise-experience.js';
export async function dispatchEnterpriseKnowledge(options: { operationId: string; params: Readonly<Record<string, string>>; actor: EnterpriseActor; input: unknown; key?: string; knowledge?: EnterpriseKnowledgeService; artifacts?: EnterpriseArtifactService; experiences?: EnterpriseExperienceService }): Promise<{ handled: false } | { handled: true; value: unknown }> {
  const { operationId, params, actor, input, key, knowledge, artifacts, experiences } = options;
  const knowledgeOperations = ['snapshotEnterpriseBusinessFact', 'importEnterpriseDocument', 'readEnterpriseKnowledge', 'searchEnterpriseKnowledge', 'citeEnterpriseKnowledge', 'exportEnterpriseKnowledge', 'shareEnterpriseKnowledge', 'getEnterpriseDocumentControl', 'withdrawEnterpriseDocument'];
  const artifactOperations = ['materializeEnterpriseDecision', 'freezeEnterpriseArtifact', 'getEnterpriseArtifact', 'acceptEnterpriseArtifact'];
  const experienceOperations = ['proposeEnterpriseExperience', 'getEnterpriseExperience', 'decideEnterpriseExperience'];
  if (![...knowledgeOperations, ...artifactOperations, ...experienceOperations].includes(operationId)) return { handled: false };
  if ((knowledgeOperations.includes(operationId) && !knowledge) || (artifactOperations.includes(operationId) && !artifacts) || (experienceOperations.includes(operationId) && !experiences)) throw new EnterpriseError('KNOWLEDGE_RUNTIME_UNCONFIGURED', 503);
  const scope = (ref: BusinessObjectRef | EvidenceRef) => { if (ref.tenantId !== actor.tenantId || ref.workspaceId !== params.workspaceId) throw new EnterpriseError('OBJECT_SCOPE_MISMATCH'); return ref; };
  let value: unknown;
  switch (operationId) {
    case 'snapshotEnterpriseBusinessFact': value = await knowledge!.snapshotBusiness(actor, params.workspaceId!, key!, input as Types['EnterpriseSourceScope']); break;
    case 'materializeEnterpriseDecision': value = await artifacts!.decision(actor, (input as Types['EnterpriseArtifactDecisionMaterial']).artifactId, key!); break;
    case 'importEnterpriseDocument': value = await knowledge!.importDocument(actor, params.workspaceId!, key!, input as Types['EnterpriseDocumentImport']); break;
    case 'readEnterpriseKnowledge': scope(input as BusinessObjectRef); value = await knowledge!.get(actor, input as BusinessObjectRef); break;
    case 'searchEnterpriseKnowledge': { const body = input as Types['EnterpriseKnowledgeSearch']; value = await knowledge!.search(actor, params.workspaceId!, body.query, body.limit); break; }
    case 'citeEnterpriseKnowledge': scope(input as EvidenceRef); value = await knowledge!.cite(actor, input as EvidenceRef); break;
    case 'exportEnterpriseKnowledge': { const body = input as Types['EnterpriseKnowledgeExport']; scope(body.reference); value = await knowledge!.exportDocument(actor, body.reference, body.format); break; }
    case 'shareEnterpriseKnowledge': { const body = input as Types['EnterpriseKnowledgeShare']; scope(body.reference); value = await knowledge!.share(actor, body.reference, body.expectedStreamVersion, body.enabled, key!); break; }
    case 'getEnterpriseDocumentControl': value = await knowledge!.controlState(actor, params.workspaceId!, params.documentId!); break;
    case 'withdrawEnterpriseDocument': value = await knowledge!.withdraw(actor, params.workspaceId!, params.documentId!, (input as Types['EnterpriseKnowledgeControl']).expectedStreamVersion, key!); break;
    case 'freezeEnterpriseArtifact': { const body = input as Types['EnterpriseArtifactFreeze']; value = await artifacts!.freeze(actor, body.goalId, body.attemptId, key!); break; }
    case 'getEnterpriseArtifact': value = await artifacts!.get(actor, params.artifactId!); break;
    case 'acceptEnterpriseArtifact': { const body = input as Types['EnterpriseArtifactAccept']; value = await artifacts!.accept(actor, params.artifactId!, body.expectedStreamVersion, body.expectedGoalVersion, body.criteria, body.attestation, key!); break; }
    case 'proposeEnterpriseExperience': value = await experiences!.propose(actor, params.artifactId!, key!, input as Types['EnterpriseExperienceProposal']); break;
    case 'getEnterpriseExperience': value = await experiences!.get(actor, params.experienceId!); break;
    case 'decideEnterpriseExperience': { const body = input as Types['EnterpriseExperienceDecision']; value = await experiences![body.enabled ? 'enable' : 'disable'](actor, params.experienceId!, body.expectedStreamVersion, body.digest, key!); break; }
  }
  return { handled: true, value };
}
