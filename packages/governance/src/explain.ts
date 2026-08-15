import { deepFreeze } from "./canonical.js";
import type {
  GovernanceExplanation,
  GovernanceSnapshot
} from "./types.js";

export function explainGovernance(
  snapshot: GovernanceSnapshot
): GovernanceExplanation {
  const sourceCount = snapshot.layers.length;
  const waiverCount = snapshot.appliedWaivers.length;
  return deepFreeze({
    digest: snapshot.digest,
    summary: `Resolved ${sourceCount} governance source(s) with ${waiverCount} applied waiver(s)`,
    sources: snapshot.layers.map((layer) => ({
      scope: layer.scope,
      scopeId: layer.scopeId,
      source: { ...layer.source },
      policyDigest: layer.policyDigest
    })),
    decisions: snapshot.decisions.map((decision) => ({
      field: decision.field,
      strategy: decision.strategy,
      effectiveValue: structuredClone(decision.effectiveValue),
      sourceIds: [...decision.sourceIds],
      ...(decision.waiverIds ? { waiverIds: [...decision.waiverIds] } : {}),
      summary: decision.summary
    })),
    appliedWaivers: snapshot.appliedWaivers.map((waiver) => ({
      id: waiver.id,
      target: { ...waiver.target },
      scope: { ...waiver.scope },
      reason: waiver.reason,
      approvedBy: waiver.approvedBy,
      approvedAt: waiver.approvedAt,
      expiresAt: waiver.expiresAt,
      sourceIds: [...waiver.sourceIds]
    }))
  });
}
