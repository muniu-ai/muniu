// SPDX-License-Identifier: Apache-2.0
import { parseEnterpriseContract, type EnterpriseContractTypes, type BusinessObjectRef, type JsonObject } from '@mn/contracts';
import { sha256 } from '@mn/kernel';
import { EnterpriseError } from '@mn/enterprise-services';
export function validateReportCitations(report: EnterpriseContractTypes['EnterpriseTaskReport'], sources: readonly { reference: BusinessObjectRef; fields: JsonObject }[]): void {
  const available = new Map<string, Set<string>>();
  for (const source of sources) {
    const citations = source.fields.citations;
    if (Array.isArray(citations)) available.set(sha256(source.reference), new Set(citations.map(value => sha256(parseEnterpriseContract('EvidenceRef', value)))));
  }
  for (const entry of [...report.findings, ...report.acceptance]) {
    const citations = entry.citations ?? [], referenced = entry.sources.map(ref => sha256(ref));
    for (const citation of citations) if (!referenced.some(ref => available.get(ref)?.has(sha256(citation)))) throw new EnterpriseError('TASK_CITATION_INVALID', 409);
    for (const source of entry.sources) {
      if (!['evidence_ref', 'artifact_version', 'memory_entry', 'decision_record'].includes(source.objectType)) continue;
      if ('status' in entry && entry.status !== 'satisfied') continue;
      if (!citations.some(citation => available.get(sha256(source))?.has(sha256(citation)))) throw new EnterpriseError('TASK_CITATION_REQUIRED', 409);
    }
  }
}
