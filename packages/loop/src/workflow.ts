import { cloneAndFreeze, sha256Canonical } from "./canonical.js";
import { GOVERNED_INCREMENT_WORKFLOW_REF as CORE_WORKFLOW_REF } from "@mn/core";
import type { GovernedWorkflowRef, LoopDefinition } from "./types.js";

const semanticDefinition = {
  id: "governed-increment-v1" as const,
  version: "1" as const,
  stages: [
    "discovery",
    "specification",
    "impact_architecture",
    "implementation",
    "verification",
    "approval_demo",
    "learning"
  ] as const,
  repair: {
    from: "verification" as const,
    to: "implementation" as const,
    defaultMaximumAttempts: 3 as const,
    noProgressConsecutiveRounds: 2 as const
  },
  approval: {
    stage: "approval_demo" as const,
    explicitDecisionRequired: true as const
  },
  learning: {
    stage: "learning" as const,
    outputKind: "learning_proposal" as const,
    automaticActivationAllowed: false as const
  }
};

export const GOVERNED_INCREMENT_DEFINITION: LoopDefinition = cloneAndFreeze({
  ...semanticDefinition,
  digest: sha256Canonical(semanticDefinition)
});

if (GOVERNED_INCREMENT_DEFINITION.digest !== CORE_WORKFLOW_REF.digest) {
  throw new Error(
    "@mn/core governed workflow digest is out of sync with @mn/loop definition"
  );
}

export const GOVERNED_INCREMENT_WORKFLOW_REF: GovernedWorkflowRef = cloneAndFreeze({
  id: CORE_WORKFLOW_REF.id as GovernedWorkflowRef["id"],
  version: CORE_WORKFLOW_REF.version as GovernedWorkflowRef["version"],
  digest: CORE_WORKFLOW_REF.digest
});
