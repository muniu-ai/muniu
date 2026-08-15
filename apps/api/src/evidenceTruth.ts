import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { GateResultV2, Project, RunRecord } from "@mn/core";
import {
  analyzeTraceGraph,
  createTraceGraph,
  type CreateEvalAssetInput,
  type CreateLearningProposalInput,
  type MaturityMeasurementInput,
  type TraceAnalysis,
  type TraceGraph
} from "@mn/evidence";
import { approvalDecisionDigest, type GovernedRunState } from "@mn/loop";
import {
  canonicalJson,
  isStrictTimestamp,
  type SpecRef,
  type SpecRevision
} from "@mn/specs";
import { LOCAL_TENANT_ID, type MemoryStore } from "./store.js";

export interface EvidenceTruthScope {
  readonly tenantId: string;
  readonly projectId: string;
}

export interface EvidenceReferenceQuery extends EvidenceTruthScope {
  readonly ref: string;
  readonly digest?: string;
  readonly runId?: string;
}

export interface ResolvedEvidenceReference {
  readonly runId: string;
  readonly kind: "gate_result" | "gate_artifact" | "run_artifact" | "loop_artifact";
  readonly ref: string;
  readonly digest: string;
}

export interface EnterpriseEvidenceTruthResolvers {
  readonly resolveApprovedSpecRevision: (
    input: EvidenceTruthScope & { readonly specRef: SpecRef }
  ) => Promise<SpecRevision | undefined>;
  readonly listApprovedSpecRevisions: (
    input: EvidenceTruthScope
  ) => Promise<readonly SpecRevision[]>;
  readonly resolveEvidenceReference: (
    input: EvidenceReferenceQuery
  ) => Promise<ResolvedEvidenceReference | undefined>;
}

export interface MaturitySourceBinding {
  readonly kind: "server_aggregate-v1";
  readonly queryDigest: string;
  readonly sourceDigest: string;
  readonly runIds: readonly string[];
  readonly evalAssetDigests: readonly string[];
  readonly traceGraphDigests: readonly string[];
  readonly learningProposalDigests: readonly string[];
}

interface StrictValidationContext extends EvidenceTruthScope {
  readonly store: MemoryStore;
  readonly resolvers: EnterpriseEvidenceTruthResolvers;
}

export async function validateEnterpriseEvalAsset(
  asset: CreateEvalAssetInput,
  context: StrictValidationContext
): Promise<void> {
  const project = requireProject(context);
  const spec = await context.resolvers.resolveApprovedSpecRevision({
    tenantId: context.tenantId,
    projectId: context.projectId,
    specRef: asset.specRef
  });
  if (!spec || spec.status !== "approved" || spec.digest !== asset.specRef.digest) {
    throw new TypeError(
      "eval asset specRef must bind the exact approved Spec revision in the same tenant and project"
    );
  }

  const clauseIds = new Set(spec.acceptanceCases.map((item) => item.id));
  for (const clauseId of asset.specClauseIds) {
    if (!clauseIds.has(clauseId)) {
      throw new TypeError(`eval asset specClauseId ${clauseId} does not exist in its approved Spec`);
    }
  }
  requireProjectServices(asset.serviceIds, project, "eval asset");
  const targetServices = new Set(spec.targetServices);
  for (const serviceId of asset.serviceIds) {
    if (targetServices.size > 0 && !targetServices.has(serviceId)) {
      throw new TypeError(`eval asset serviceId ${serviceId} is outside its approved Spec scope`);
    }
  }

  if (asset.source.kind === "spec") {
    const acceptedRefs = new Set([
      spec.specSetId,
      `${spec.specSetId}@${spec.revision}`,
      `spec:${spec.specSetId}@${spec.revision}`
    ]);
    if (!acceptedRefs.has(asset.source.ref) || asset.source.digest !== spec.digest) {
      throw new TypeError("spec-sourced eval assets must bind the exact approved Spec ref and digest");
    }
  } else {
    if (!asset.source.digest) {
      throw new TypeError("enterprise eval asset source.digest is required");
    }
    await requireEvidenceReference(
      context,
      asset.source.ref,
      asset.source.digest,
      "eval asset source"
    );
  }
  await requireEvidenceReference(
    context,
    asset.contentRef,
    asset.contentDigest,
    "eval asset content"
  );
}

export async function validateEnterpriseTraceGraph(input: {
  readonly graph: TraceGraph;
  readonly analysis: {
    readonly requiredSpecClauseIds: readonly string[];
    readonly contracts?: readonly {
      readonly ref: string;
      readonly expectedDigest: string;
      readonly actualDigest: string;
    }[];
    readonly expectedContextDigest?: string;
    readonly actualContextDigest?: string;
  };
  readonly context: StrictValidationContext;
}): Promise<{ readonly spec: SpecRevision; readonly run: RunRecord }> {
  const { graph, analysis, context } = input;
  const project = requireProject(context);
  if (analysis === undefined) {
    throw new TypeError("enterprise trace graphs require server-verifiable analysis input");
  }

  const specs = (await context.resolvers.listApprovedSpecRevisions(context))
    .filter((spec) => spec.status === "approved" && spec.digest !== undefined);
  const required = sortedUnique(analysis.requiredSpecClauseIds);
  const graphSpecDigests = sortedUnique(
    graph.nodes.filter((node) => node.kind === "spec_clause").map((node) => node.digest)
  );
  const matchingSpecs = specs.filter((spec) =>
    arraysEqual(required, sortedUnique(spec.acceptanceCases.map((item) => item.id))) &&
    graphSpecDigests.length === 1 &&
    graphSpecDigests[0] === spec.digest
  );
  if (matchingSpecs.length !== 1) {
    throw new TypeError(
      "trace analysis requiredSpecClauseIds must exactly identify one approved Spec revision in the same project"
    );
  }
  const spec = matchingSpecs[0]!;
  const specDigest = spec.digest!;
  const clauses = new Set(spec.acceptanceCases.map((item) => item.id));

  for (const node of graph.nodes) {
    requireProjectServices(node.serviceIds, project, `trace node ${node.id}`);
    if (node.kind === "business_hypothesis") {
      if (node.ref !== spec.specSetId || node.digest !== sha256Text(spec.hypothesis)) {
        throw new TypeError(`trace node ${node.id} does not bind the approved Spec hypothesis`);
      }
    }
    if (node.kind === "spec_clause") {
      if (!clauses.has(node.ref) || node.digest !== specDigest) {
        throw new TypeError(`trace node ${node.id} does not bind a real approved Spec clause`);
      }
    }
  }
  const graphClauseRefs = sortedUnique(
    graph.nodes.filter((node) => node.kind === "spec_clause").map((node) => node.ref)
  );
  if (!arraysEqual(graphClauseRefs, required)) {
    throw new TypeError("trace graph must contain exactly the approved Spec clauses under analysis");
  }
  validateTraceEdgeSemantics(graph);

  const candidateRuns = scopedRuns(context.store, context)
    .filter((run) =>
      run.harnessManifest?.specRef.specSetId === spec.specSetId &&
      run.harnessManifest.specRef.revision === spec.revision &&
      run.harnessManifest.specRef.digest === specDigest
    );
  if (candidateRuns.length === 0) {
    throw new TypeError("trace graph has no governed Run bound to its approved Spec");
  }

  const failures: string[] = [];
  for (const run of candidateRuns) {
    try {
      await validateTraceAgainstRun(graph, analysis, spec, project, run, context);
      return { spec, run };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new TypeError(
    `trace graph nodes do not bind one real governed Run: ${sortedUnique(failures).join("; ")}`
  );
}

export async function validateEnterpriseLearningEvidence(input: {
  readonly proposal: CreateLearningProposalInput;
  readonly context: StrictValidationContext;
}): Promise<void> {
  const { proposal, context } = input;
  const sourceRun = scopedRuns(context.store, context).find(
    (run) => run.id === proposal.sourceRunId
  );
  if (!sourceRun) {
    throw new TypeError("learning proposal sourceRunId must bind a Run in the same tenant and project");
  }

  for (const evidenceId of proposal.sourceEvidenceIds) {
    const evalAsset = [...context.store.evalAssets.values()]
      .filter(
        (record) =>
          record.tenantId === context.tenantId &&
          record.projectId === context.projectId &&
          record.asset.id === evidenceId
      )
      .sort((left, right) => right.asset.revision - left.asset.revision)[0]?.asset;
    if (evalAsset) {
      const resolved = await context.resolvers.resolveEvidenceReference({
        tenantId: context.tenantId,
        projectId: context.projectId,
        runId: sourceRun.id,
        ref: evalAsset.contentRef,
        digest: evalAsset.contentDigest
      });
      if (!resolved) {
        throw new TypeError(
          `learning proposal sourceEvidenceId ${evidenceId} is not backed by its source Run`
        );
      }
      continue;
    }

    const trace = context.store.traceGraphs.get(
      JSON.stringify([context.tenantId, context.projectId, evidenceId])
    );
    if (trace) {
      const verified = await revalidatePersistedEnterpriseTrace(
        trace.graph,
        context,
        sourceRun.id
      );
      if (verified?.runId === sourceRun.id) continue;
    }

    if (await context.resolvers.resolveEvidenceReference({
      tenantId: context.tenantId,
      projectId: context.projectId,
      runId: sourceRun.id,
      ref: evidenceId
    })) {
      continue;
    }
    throw new TypeError(
      `learning proposal sourceEvidenceId ${evidenceId} does not exist in its source Run or project evidence registry`
    );
  }
}

/**
 * Rebuilds the server-derived analysis for a persisted Trace Graph and then
 * replays the same strict validation used at creation time. This is
 * intentionally done at every enterprise consumption boundary: a legacy
 * trace, a deleted/tampered CAS object, or a revoked authoritative Gate
 * receipt must stop contributing to Learning and maturity reports.
 */
async function revalidatePersistedEnterpriseTrace(
  graphInput: TraceGraph,
  context: StrictValidationContext,
  expectedRunId?: string
): Promise<Readonly<{
  runId: string;
  analysis: TraceAnalysis;
}> | undefined> {
  let graph: TraceGraph;
  try {
    graph = createTraceGraph({ nodes: graphInput.nodes, edges: graphInput.edges });
    if (canonicalJson(graph) !== canonicalJson(graphInput)) return undefined;
  } catch {
    return undefined;
  }

  const requiredSpecClauseIds = sortedUnique(
    graph.nodes
      .filter((node) => node.kind === "spec_clause")
      .map((node) => node.ref)
  );
  const contracts = graph.nodes
    .filter((node) => node.kind === "design_contract")
    .map((node) => ({
      ref: node.ref,
      expectedDigest: node.digest,
      actualDigest: node.digest
    }));
  const candidateContextDigests = sortedUnique(
    scopedRuns(context.store, context)
      .filter((run) => expectedRunId === undefined || run.id === expectedRunId)
      .map((run) => run.harnessManifest?.context.digest)
      .filter((digest): digest is string => typeof digest === "string")
  );

  for (const contextDigest of candidateContextDigests) {
    const analysisInput = {
      requiredSpecClauseIds,
      contracts,
      expectedContextDigest: contextDigest,
      actualContextDigest: contextDigest
    };
    try {
      const { run } = await validateEnterpriseTraceGraph({
        graph,
        analysis: analysisInput,
        context
      });
      if (expectedRunId !== undefined && run.id !== expectedRunId) continue;
      return Object.freeze({
        runId: run.id,
        analysis: analyzeTraceGraph(graph, analysisInput)
      });
    } catch {
      // Try the next immutable Harness context. No persisted analysis is
      // trusted as a shortcut around current server evidence truth.
    }
  }
  return undefined;
}

export async function aggregateEnterpriseMaturity(input: {
  readonly store: MemoryStore;
  readonly tenantId: string;
  readonly projectId: string;
  readonly resolvers: EnterpriseEvidenceTruthResolvers;
}): Promise<{
  readonly measurement: MaturityMeasurementInput;
  readonly source: MaturitySourceBinding;
}> {
  const scope = { tenantId: input.tenantId, projectId: input.projectId };
  const runs = scopedRuns(input.store, scope);
  const terminalRuns = runs.filter((run) =>
    run.status === "completed" || run.status === "failed" || run.status === "cancelled"
  );
  const traceRecords = [...input.store.traceGraphs.values()]
    .filter(
      (record) => record.tenantId === input.tenantId && record.projectId === input.projectId
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const traceCandidates = await Promise.all(traceRecords.map(async (record) => {
    const verified = await revalidatePersistedEnterpriseTrace(record.graph, {
      store: input.store,
      tenantId: input.tenantId,
      projectId: input.projectId,
      resolvers: input.resolvers
    });
    return verified ? { record, analysis: verified.analysis } : undefined;
  }));
  const traces = traceCandidates.filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined
  );
  const requiredClauses = new Set<string>();
  const coveredClauses = new Set<string>();
  for (const trace of traces) {
    for (const id of trace.analysis.requiredSpecClauseIds) requiredClauses.add(id);
    for (const id of trace.analysis.coveredSpecClauseIds) coveredClauses.add(id);
  }
  const verificationAttempts = runs.flatMap((run) =>
    (run.stages ?? []).filter((attempt) => attempt.stage === "verification")
  );
  const implementationAttempts = runs.flatMap((run) =>
    (run.stages ?? []).filter((attempt) => attempt.stage === "implementation")
  );
  const repairAttempts = runs.reduce(
    (total, run) => total + (run.budgetUsage?.repairAttempts ?? 0),
    0
  );
  const learningRuns = runs.filter((run) =>
    (run.stages ?? []).some(
      (attempt) => attempt.stage === "learning" && attempt.status === "completed"
    )
  );
  const latestLearning = latestLearningProposals(input.store, scope);
  const promoted = latestLearning.filter((proposal) => proposal.status === "promoted");
  const feedbackClosureSeconds = promoted.map((proposal) =>
    Math.max(
      0,
      (Date.parse(proposal.promotion!.promotedAt) - Date.parse(proposal.createdAt)) / 1000
    )
  );
  const measurement: MaturityMeasurementInput = {
    incrementCycleSeconds: terminalRuns.map((run) =>
      Math.max(0, (Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000)
    ),
    totalRuns: runs.length,
    failedRuns: runs.filter(
      (run) => run.status === "failed" || run.status === "cancelled"
    ).length,
    requiredContractClauses: requiredClauses.size,
    coveredContractClauses: [...coveredClauses].filter((id) => requiredClauses.has(id)).length,
    regressionRuns: verificationAttempts.length,
    regressionHits: verificationAttempts.filter((attempt) => attempt.status === "failed").length,
    contextComparisons: traces.length,
    contextDrifts: traces.filter((trace) => trace.analysis.contextDrift === true).length,
    aiChanges: implementationAttempts.length,
    aiReworks: Math.min(repairAttempts, implementationAttempts.length),
    completedRetrospectives: learningRuns.length,
    retainedLearnings: Math.min(latestLearning.length, learningRuns.length),
    feedbackClosureSeconds
  };
  const evalAssetDigests = [...input.store.evalAssets.values()]
    .filter(
      (record) => record.tenantId === input.tenantId && record.projectId === input.projectId
    )
    .map((record) => record.asset.digest)
    .sort();
  const traceGraphDigests = traces.map(({ record }) => record.graph.digest).sort();
  const learningProposalDigests = latestLearning.map((proposal) => proposal.digest).sort();
  const runBindings = runs.map((run) => ({
    id: run.id,
    status: run.status,
    updatedAt: run.updatedAt,
    ...(run.harnessManifest?.specRef.digest
      ? { specDigest: run.harnessManifest.specRef.digest }
      : {}),
    ...(run.governanceSnapshot?.digest
      ? { governanceDigest: run.governanceSnapshot.digest }
      : {}),
    ...(run.harnessManifest?.digest
      ? { harnessDigest: run.harnessManifest.digest }
      : {}),
    gateResultDigests: (run.gateResultsV2 ?? []).map((gate) => gate.outputDigest).sort()
  }));
  const sourcePayload = {
    query: scope,
    runs: runBindings,
    evalAssetDigests,
    traceGraphDigests,
    learningProposalDigests
  };
  return {
    measurement,
    source: Object.freeze({
      kind: "server_aggregate-v1",
      queryDigest: sha256Canonical(scope),
      sourceDigest: sha256Canonical(sourcePayload),
      runIds: runs.map((run) => run.id),
      evalAssetDigests,
      traceGraphDigests,
      learningProposalDigests
    })
  };
}

function requireProject(context: StrictValidationContext): Project {
  const project = context.store.projects.get(context.projectId);
  if (
    !project ||
    (project.tenantId ?? LOCAL_TENANT_ID) !== context.tenantId
  ) {
    throw new TypeError("evidence project is outside the authenticated tenant");
  }
  return project;
}

function requireProjectServices(
  serviceIds: readonly string[],
  project: Project,
  field: string
): void {
  const available = new Set(project.services.map((service) => service.id));
  for (const serviceId of serviceIds) {
    if (!available.has(serviceId)) {
      throw new TypeError(`${field} serviceId ${serviceId} is not declared by the project`);
    }
  }
}

async function requireEvidenceReference(
  context: StrictValidationContext,
  ref: string,
  digest: string,
  field: string
): Promise<ResolvedEvidenceReference> {
  const resolved = await context.resolvers.resolveEvidenceReference({
    tenantId: context.tenantId,
    projectId: context.projectId,
    ref,
    digest
  });
  if (!resolved) {
    throw new TypeError(`${field} ref and digest do not bind real same-project Run evidence`);
  }
  return resolved;
}

async function validateTraceAgainstRun(
  graph: TraceGraph,
  analysis: {
    readonly contracts?: readonly {
      readonly ref: string;
      readonly expectedDigest: string;
      readonly actualDigest: string;
    }[];
    readonly expectedContextDigest?: string;
    readonly actualContextDigest?: string;
  },
  spec: SpecRevision,
  project: Project,
  run: RunRecord,
  context: StrictValidationContext
): Promise<void> {
  const manifest = run.harnessManifest!;
  const loopState = context.store.governedLoopStates.get(run.id);
  const gateResults = run.gateResultsV2 ?? [];
  const gates = new Map(gateResults.map((gate) => [gate.id, gate]));
  if (gates.size !== gateResults.length) {
    throw new TypeError("completion trace Run contains duplicate GateResultV2 ids");
  }
  const gateByNode = new Map<string, GateResultV2>();
  const completion = requireCompletedTraceRun(run, loopState, gates);
  validateCompleteTracePaths(
    graph,
    spec.acceptanceCases.map((item) => item.id),
    [...completion.requiredGateIds]
  );

  for (const node of graph.nodes) {
    switch (node.kind) {
      case "business_hypothesis":
      case "spec_clause":
        break;
      case "design_contract": {
        const fragment = manifest.context.fragments.find(
          (candidate) =>
            referenceMatches(node.ref, candidate.id) ||
            referenceMatches(node.ref, candidate.source)
        );
        if (
          !fragment ||
          (node.digest !== fragment.contentDigest && node.digest !== fragment.digest)
        ) {
          throw new TypeError(`design_contract node ${node.id} is not a Harness context contract`);
        }
        break;
      }
      case "diff": {
        if (!realDiffBinding(node.ref, node.digest, project, loopState)) {
          throw new TypeError(`diff node ${node.id} is not bound to a governed Loop diff`);
        }
        break;
      }
      case "test_gate": {
        const gate = gates.get(node.ref);
        if (
          !gate ||
          gate.outputDigest !== node.digest ||
          gate.required !== true ||
          gate.status !== "pass" ||
          !completion.requiredGateIds.has(gate.id)
        ) {
          throw new TypeError(
            `test_gate node ${node.id} is not bound to a required passing GateResultV2 from the final successful verification attempt`
          );
        }
        const evidence = await context.resolvers.resolveEvidenceReference({
          tenantId: context.tenantId,
          projectId: context.projectId,
          runId: run.id,
          ref: gate.id,
          digest: gate.outputDigest
        });
        if (
          !evidence ||
          evidence.runId !== run.id ||
          evidence.kind !== "gate_result"
        ) {
          throw new TypeError(
            `test_gate node ${node.id} has no authoritative Gate receipt and verified CAS evidence`
          );
        }
        gateByNode.set(node.id, gate);
        break;
      }
      case "approval": {
        if (
          completion.approval.stageAttemptId !== node.ref ||
          completion.approval.digest !== node.digest
        ) {
          throw new TypeError(
            `approval node ${node.id} is not a server-issued approval after final verification`
          );
        }
        break;
      }
      case "observation": {
        const evidence = await context.resolvers.resolveEvidenceReference({
          tenantId: context.tenantId,
          projectId: context.projectId,
          runId: run.id,
          ref: node.ref,
          digest: node.digest
        });
        if (!evidence) {
          throw new TypeError(`observation node ${node.id} is not a persisted Run artifact`);
        }
        break;
      }
    }
  }

  const incomingClausesByGate = upstreamClauseRefs(graph);
  for (const [nodeId, gate] of gateByNode) {
    for (const clauseId of incomingClausesByGate.get(nodeId) ?? []) {
      if (!gate.specClauseIds.includes(clauseId)) {
        throw new TypeError(
          `GateResultV2 ${gate.id} does not cover upstream Spec clause ${clauseId}`
        );
      }
    }
  }

  const contractNodes = new Map(
    graph.nodes
      .filter((node) => node.kind === "design_contract")
      .map((node) => [node.ref, node])
  );
  for (const contract of analysis.contracts ?? []) {
    const node = contractNodes.get(contract.ref);
    if (
      !node ||
      contract.expectedDigest !== node.digest ||
      contract.actualDigest !== node.digest
    ) {
      throw new TypeError(`trace contract analysis ${contract.ref} is not server-derived`);
    }
  }
  if (
    analysis.expectedContextDigest !== manifest.context.digest ||
    analysis.actualContextDigest !== manifest.context.digest
  ) {
    throw new TypeError("trace context analysis must bind the Run Harness context digest");
  }

  if (spec.digest !== manifest.specRef.digest) {
    throw new TypeError("trace Spec and Harness bindings disagree");
  }
}

function requireCompletedTraceRun(
  run: RunRecord,
  state: GovernedRunState | undefined,
  gates: ReadonlyMap<string, GateResultV2>
) {
  if (run.status !== "completed") {
    throw new TypeError("completion trace requires run.status to be completed");
  }
  if (!state) {
    throw new TypeError("completion trace requires a governed Loop state");
  }
  if (state.runId !== run.id || state.status !== "completed") {
    throw new TypeError(
      "completion trace requires the same governed Loop state to be completed"
    );
  }

  let finalVerificationIndex = -1;
  for (let index = state.attempts.length - 1; index >= 0; index -= 1) {
    if (state.attempts[index]?.stage === "verification") {
      finalVerificationIndex = index;
      break;
    }
  }
  const finalVerification = state.attempts[finalVerificationIndex];
  if (
    !finalVerification ||
    finalVerification.stage !== "verification" ||
    finalVerification.status !== "completed" ||
    !isStrictTimestamp(finalVerification.finishedAt)
  ) {
    throw new TypeError(
      "completion trace requires the final verification attempt to be successfully completed"
    );
  }

  const finalBindings = (run.verificationEvidence ?? []).filter(
    (binding) => binding.stageAttemptId === finalVerification.id
  );
  if (finalBindings.length !== 1) {
    throw new TypeError(
      "completion trace requires exactly one evidence binding for the final successful verification attempt"
    );
  }
  const finalGateIds = finalBindings[0]!.gateResultIds;
  if (new Set(finalGateIds).size !== finalGateIds.length) {
    throw new TypeError("final verification evidence contains duplicate GateResultV2 ids");
  }
  const finalGates = finalGateIds.map((id) => gates.get(id));
  if (finalGates.some((gate) => gate === undefined)) {
    throw new TypeError("final verification evidence references an unknown GateResultV2");
  }
  if (finalGates.some((gate) => gate!.required === true && gate!.status !== "pass")) {
    throw new TypeError("final verification contains a required GateResultV2 that did not pass");
  }
  const requiredGateIds = new Set(
    finalGates
      .filter((gate): gate is GateResultV2 => gate?.required === true && gate.status === "pass")
      .map((gate) => gate.id)
  );
  if (requiredGateIds.size === 0) {
    throw new TypeError(
      "completion trace requires required passing GateResultV2 evidence from final verification"
    );
  }

  const approval = state.approval;
  if (!approval || approval.runId !== run.id || approval.decision !== "approve") {
    throw new TypeError(
      "completion trace requires a server-issued approval after final verification"
    );
  }
  let expectedApprovalDigest: string;
  try {
    expectedApprovalDigest = approvalDecisionDigest({
      runId: approval.runId,
      stageAttemptId: approval.stageAttemptId,
      decision: approval.decision,
      actorId: approval.actorId,
      decidedAt: approval.decidedAt
    });
  } catch {
    throw new TypeError("completion trace server-issued approval is malformed");
  }
  const approvalIndex = state.attempts.findIndex(
    (attempt) => attempt.id === approval.stageAttemptId
  );
  const approvalAttempt = state.attempts[approvalIndex];
  if (
    approval.digest !== expectedApprovalDigest ||
    !approvalAttempt ||
    approvalAttempt.stage !== "approval_demo" ||
    approvalAttempt.status !== "completed" ||
    approvalIndex <= finalVerificationIndex ||
    approvalAttempt.finishedAt !== approval.decidedAt ||
    !strictlyAfter(approval.decidedAt, finalVerification.finishedAt)
  ) {
    throw new TypeError(
      "completion trace requires a valid server-issued approval after final verification"
    );
  }

  return Object.freeze({ approval, requiredGateIds });
}

function validateCompleteTracePaths(
  graph: TraceGraph,
  requiredClauseRefs: readonly string[],
  requiredGateRefs: readonly string[]
): void {
  const byKind = (kind: TraceGraph["nodes"][number]["kind"]) =>
    graph.nodes.filter((node) => node.kind === kind);
  const hypotheses = byKind("business_hypothesis");
  const clauses = byKind("spec_clause");
  const approvals = byKind("approval");
  const observations = byKind("observation");
  const gates = byKind("test_gate");

  if (hypotheses.length !== 1) {
    throw new TypeError("completion trace requires exactly one business hypothesis node");
  }
  if (approvals.length !== 1) {
    throw new TypeError("completion trace requires exactly one approval node");
  }
  if (observations.length === 0) {
    throw new TypeError("completion trace requires at least one observation node");
  }
  if (
    clauses.length !== requiredClauseRefs.length ||
    !arraysEqual(
      clauses.map((node) => node.ref).sort(),
      sortedUnique(requiredClauseRefs)
    )
  ) {
    throw new TypeError(
      "completion trace requires exactly one Spec node for every required clause"
    );
  }
  if (
    gates.length !== requiredGateRefs.length ||
    !arraysEqual(
      gates.map((node) => node.ref).sort(),
      sortedUnique(requiredGateRefs)
    )
  ) {
    throw new TypeError(
      "completion trace must include every required passing Gate from final verification exactly once"
    );
  }

  const chain = [
    "derives",
    "designs",
    "implements",
    "verifies",
    "approves",
    "observes"
  ] as const;
  const layers = [
    hypotheses,
    clauses,
    byKind("design_contract"),
    byKind("diff"),
    gates,
    approvals,
    observations
  ] as const;
  const forward = layers.map(() => new Set<string>());
  hypotheses.forEach((node) => forward[0]!.add(node.id));
  for (let step = 0; step < chain.length; step += 1) {
    for (const edge of graph.edges) {
      if (edge.kind === chain[step] && forward[step]!.has(edge.from)) {
        forward[step + 1]!.add(edge.to);
      }
    }
  }
  const backward = layers.map(() => new Set<string>());
  observations.forEach((node) => backward[chain.length]!.add(node.id));
  for (let step = chain.length - 1; step >= 0; step -= 1) {
    for (const edge of graph.edges) {
      if (edge.kind === chain[step] && backward[step + 1]!.has(edge.to)) {
        backward[step]!.add(edge.from);
      }
    }
  }

  const completeNodeIds = new Set(
    layers.flatMap((layer, step) =>
      layer
        .filter(
          (node) => forward[step]!.has(node.id) && backward[step]!.has(node.id)
        )
        .map((node) => node.id)
    )
  );
  const completeEdgeIds = new Set<string>();
  for (let step = 0; step < chain.length; step += 1) {
    for (const edge of graph.edges) {
      if (
        edge.kind === chain[step] &&
        forward[step]!.has(edge.from) &&
        backward[step + 1]!.has(edge.to)
      ) {
        completeEdgeIds.add(traceEdgeIdentity(edge));
      }
    }
  }

  if (!observations.some((node) => forward[chain.length]!.has(node.id))) {
    throw new TypeError(
      "completion trace requires a complete hypothesis-to-observation evidence path"
    );
  }
  const disconnectedNode = graph.nodes.find((node) => !completeNodeIds.has(node.id));
  if (disconnectedNode) {
    throw new TypeError(
      `completion trace node ${disconnectedNode.id} is disconnected from the complete evidence path`
    );
  }
  const disconnectedEdge = graph.edges.find(
    (edge) => !completeEdgeIds.has(traceEdgeIdentity(edge))
  );
  if (disconnectedEdge) {
    throw new TypeError(
      `completion trace edge ${disconnectedEdge.from}->${disconnectedEdge.to} is not part of a complete evidence path`
    );
  }
}

function traceEdgeIdentity(edge: TraceGraph["edges"][number]): string {
  return `${edge.from}\0${edge.to}\0${edge.kind}`;
}

function strictlyAfter(later: string, earlier: string): boolean {
  if (!isStrictTimestamp(later) || !isStrictTimestamp(earlier)) return false;
  return Date.parse(later) > Date.parse(earlier);
}

function realDiffBinding(
  ref: string,
  digest: string,
  project: Project,
  state: GovernedRunState | undefined
): boolean {
  if (!state) return false;
  const artifact = state.attempts
    .flatMap((attempt) => attempt.outputArtifacts)
    .find(
      (candidate) =>
        candidate.kind === "diff" &&
        candidate.digest === digest &&
        (referenceMatches(ref, candidate.id) || referenceMatches(ref, candidate.path))
    );
  if (artifact) return true;
  const observed = state.repairHistory.some((item) => item.diffDigest === digest);
  if (!observed) return false;
  if (ref.split(/[\\/]+/u).includes("..")) return false;
  return project.services.some((service) => {
    const servicePath = isAbsolute(service.path)
      ? relative(project.rootPath, service.path)
      : service.path;
    return (
      referenceMatches(ref, service.path) ||
      ref.startsWith(`${service.path}/`) ||
      ref === servicePath ||
      ref.startsWith(`${servicePath}/`)
    );
  });
}

function validateTraceEdgeSemantics(graph: TraceGraph): void {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const expected: Record<string, readonly [string, string][]> = {
    derives: [["business_hypothesis", "spec_clause"]],
    designs: [["spec_clause", "design_contract"]],
    implements: [["design_contract", "diff"]],
    verifies: [["diff", "test_gate"]],
    approves: [["test_gate", "approval"]],
    observes: [["approval", "observation"]]
  };
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from)!;
    const to = nodes.get(edge.to)!;
    if (!expected[edge.kind]!.some(([left, right]) => left === from.kind && right === to.kind)) {
      throw new TypeError(
        `trace edge ${edge.from}->${edge.to} has invalid ${edge.kind} node kinds`
      );
    }
  }
}

function upstreamClauseRefs(graph: TraceGraph): Map<string, string[]> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }
  const result = new Map<string, string[]>();
  for (const gate of graph.nodes.filter((node) => node.kind === "test_gate")) {
    const seen = new Set<string>();
    const queue = [...(incoming.get(gate.id) ?? [])];
    const clauses: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = byId.get(id)!;
      if (node.kind === "spec_clause") clauses.push(node.ref);
      queue.push(...(incoming.get(id) ?? []));
    }
    result.set(gate.id, sortedUnique(clauses));
  }
  return result;
}

function scopedRuns(
  store: MemoryStore,
  scope: EvidenceTruthScope
): RunRecord[] {
  return [...store.runs.values()]
    .filter(
      (run) =>
        (run.tenantId ?? LOCAL_TENANT_ID) === scope.tenantId &&
        run.projectId === scope.projectId
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function latestLearningProposals(
  store: MemoryStore,
  scope: EvidenceTruthScope
) {
  const byId = new Map<string, (typeof store.learningProposals extends Map<unknown, infer V> ? V : never)>();
  for (const record of store.learningProposals.values()) {
    if (record.tenantId !== scope.tenantId || record.projectId !== scope.projectId) continue;
    const current = byId.get(record.proposal.id);
    if (!current || current.proposal.revision < record.proposal.revision) {
      byId.set(record.proposal.id, record);
    }
  }
  return [...byId.values()].map((record) => record.proposal).sort((a, b) => a.id.localeCompare(b.id));
}

function referenceMatches(left: string, right: string): boolean {
  return left === right || right.endsWith(`/${left}`) || left.endsWith(`/${right}`);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
