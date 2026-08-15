import type { FastifyRequest } from "fastify";
import { sha256Canonical } from "@mn/governance";
import type { FileSpecRepository } from "@mn/specs";
import {
  LOCAL_TENANT_ID,
  scopedTenantRecordKey,
  type MemoryStore
} from "./store.js";

/**
 * A domain audit plan is captured before a route mutates state. The response is
 * deliberately not trusted for identity unless the API allocates the identity
 * itself (project/task/run creation). This keeps resource ids stable for routes
 * such as Standard Pack import and Learning Proposal creation that do not have
 * an `:id` parameter.
 */
export interface DomainAuditPlan {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly projectId?: string;
  readonly beforeDigest?: string;
  readonly packDigest?: string;
  readonly mutates: boolean;
  readonly responseSelector?:
    | "identity"
    | "lock"
    | "project"
    | "run"
    | "snapshot";
  readonly responseResourceId?: "id" | "run.id" | "spec_revision";
  readonly responseResourcePrefix?: string;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function digest(value: unknown): string | undefined {
  return value === undefined ? undefined : sha256Canonical(value);
}

function tenantRecord<T extends { readonly tenantId?: string }>(
  values: Iterable<T>,
  tenantId: string,
  predicate: (value: T) => boolean
): T | undefined {
  return [...values].find(
    (value) =>
      (value.tenantId ?? LOCAL_TENANT_ID) === tenantId && predicate(value)
  );
}

function projectForTask(store: MemoryStore, taskId: string | undefined): string | undefined {
  return taskId ? store.tasks.get(taskId)?.projectId : undefined;
}

function projectForService(
  store: MemoryStore,
  tenantId: string,
  serviceId: string | undefined
): string | undefined {
  if (!serviceId) return undefined;
  return [...store.projects.values()].find(
    (project) =>
      (project.tenantId ?? LOCAL_TENANT_ID) === tenantId &&
      project.services.some((service) => service.id === serviceId)
  )?.id;
}

function latestLearningProposal(
  store: MemoryStore,
  tenantId: string,
  projectId: string | undefined,
  proposalId: string | undefined
) {
  if (!projectId || !proposalId) return undefined;
  return [...store.learningProposals.values()]
    .filter(
      (entry) =>
        entry.tenantId === tenantId &&
        entry.projectId === projectId &&
        entry.proposal.id === proposalId
    )
    .sort((left, right) => right.proposal.revision - left.proposal.revision)[0]
    ?.proposal;
}

function runPackDigest(run: ReturnType<MemoryStore["runs"]["get"]>): string | undefined {
  const layers = run?.governanceSnapshot?.layers;
  if (!layers || layers.length === 0) return undefined;
  return layers[layers.length - 1]?.source.digest;
}

function unknownRunPackDigest(value: unknown): string | undefined {
  const governanceSnapshot = record(record(value).governanceSnapshot);
  const layers = Array.isArray(governanceSnapshot.layers)
    ? governanceSnapshot.layers
    : [];
  const lastLayer = record(layers.at(-1));
  const source = record(lastLayer.source);
  const candidate = string(source.digest);
  return candidate && /^[a-f0-9]{64}$/u.test(candidate) ? candidate : undefined;
}

function learningAction(pathname: string): string | undefined {
  const match = pathname.match(
    /^\/v1\/learning-proposals\/[^/]+\/(submit|review|canary|promote|rollback)$/u
  );
  return match?.[1] ? `learning_proposal.${match[1]}` : undefined;
}

/**
 * Captures every governance mutation that must have an independent domain
 * AuditEvent. Keeping this registry centralized makes "unaudited governance
 * coverage = 0" mechanically testable.
 */
export async function prepareDomainAuditPlans(input: {
  readonly request: FastifyRequest;
  readonly store: MemoryStore;
  readonly specRepository: FileSpecRepository;
  readonly tenantId: string;
}): Promise<readonly DomainAuditPlan[]> {
  const { request, store, specRepository, tenantId } = input;
  const pathname = request.url.split("?")[0] ?? request.url;
  const method = request.method.toUpperCase();
  const body = record(request.body);
  const params = record(request.params);
  const query = record(request.query);

  if (method === "POST" && pathname === "/v1/projects") {
    return [{
      action: "project.create",
      resourceType: "project",
      mutates: true,
      responseResourceId: "id"
    }];
  }

  const projectIndex = pathname.match(/^\/v1\/projects\/([^/]+)\/index$/u);
  if (method === "POST" && projectIndex?.[1]) {
    const projectId = decodeURIComponent(projectIndex[1]);
    const before = store.projects.get(projectId);
    return [{
      action: "project.index",
      resourceType: "project",
      resourceId: projectId,
      projectId,
      ...(digest(before) ? { beforeDigest: digest(before)! } : {}),
      mutates: true,
      responseSelector: "project"
    }];
  }

  if (method === "POST" && pathname === "/v1/standard-packs/import") {
    const manifest = record(body.manifest);
    const id = string(manifest.id);
    const version = string(manifest.version);
    const resourceId = id && version ? `${id}@${version}` : undefined;
    const before = resourceId
      ? tenantRecord(store.standardPacks.values(), tenantId, (entry) => entry.key === resourceId)
      : undefined;
    return [{
      action: "standard_pack.import",
      resourceType: "standard_pack",
      ...(resourceId ? { resourceId } : {}),
      ...(digest(before) ? { beforeDigest: digest(before)! } : {}),
      mutates: true
    }];
  }

  if (method === "POST" && pathname === "/v1/standard-packs/activate") {
    const packId = string(body.id);
    const version = string(body.version);
    const scope = string(body.scope);
    const scopeId = string(body.scopeId);
    const packKey = packId && version ? `${packId}@${version}` : undefined;
    const pack = packKey
      ? tenantRecord(store.standardPacks.values(), tenantId, (entry) => entry.key === packKey)
      : undefined;
    const layerKey = scope && scopeId && packId
      ? `${scope}:${scopeId}:${packId}`
      : undefined;
    const layer = layerKey
      ? tenantRecord(store.governanceLayers.values(), tenantId, (entry) => entry.key === layerKey)
      : undefined;
    const projectId = string(body.projectId) ??
      (scope === "project" ? scopeId : undefined) ??
      (scope === "task" ? projectForTask(store, scopeId) : undefined) ??
      (scope === "service" ? projectForService(store, tenantId, scopeId) : undefined);
    const plans: DomainAuditPlan[] = [{
      action: "standard_pack.activate",
      resourceType: "governance_layer",
      ...(layerKey ? { resourceId: layerKey } : {}),
      ...(projectId ? { projectId } : {}),
      ...(digest(layer) ? { beforeDigest: digest(layer)! } : {}),
      ...(pack?.digest ? { packDigest: pack.digest } : {}),
      mutates: true
    }];
    if (projectId) {
      const lock = tenantRecord(
        store.projectPackLocks.values(),
        tenantId,
        (entry) => entry.projectId === projectId
      );
      plans.push({
        action: "standards_lock.update",
        resourceType: "standards_lock",
        resourceId: projectId,
        projectId,
        ...(digest(lock) ? { beforeDigest: digest(lock)! } : {}),
        ...(pack?.digest ? { packDigest: pack.digest } : {}),
        mutates: true,
        responseSelector: "lock"
      });
    }
    return plans;
  }

  if (method === "POST" && pathname === "/v1/waivers") {
    const resourceId = string(body.id);
    const scope = record(body.scope);
    const scopeLevel = string(scope.level);
    const scopeId = string(scope.id);
    const projectId = scopeLevel === "project"
      ? scopeId
      : scopeLevel === "task"
        ? projectForTask(store, scopeId)
        : scopeLevel === "service"
          ? projectForService(store, tenantId, scopeId)
          : undefined;
    const before = resourceId
      ? store.waivers.get(scopedTenantRecordKey(tenantId, resourceId)) ??
        (tenantId === LOCAL_TENANT_ID ? store.waivers.get(resourceId) : undefined)
      : undefined;
    return [{
      action: "waiver.create",
      resourceType: "waiver",
      ...(resourceId ? { resourceId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(digest(before) ? { beforeDigest: digest(before)! } : {}),
      mutates: true
    }];
  }

  if (method === "POST" && pathname === "/v1/spec-sets") {
    const specSet = record(body.specSet);
    const resourceId = string(specSet.id);
    const before = resourceId ? await specRepository.get(resourceId) : undefined;
    return [{
      action: "spec_set.create",
      resourceType: "spec_set",
      ...(resourceId ? { resourceId } : {}),
      ...(digest(before) ? { beforeDigest: digest(before)! } : {}),
      mutates: true
    }];
  }

  const revisionCreate = pathname.match(/^\/v1\/spec-sets\/([^/]+)\/revisions$/u);
  if (method === "POST" && revisionCreate?.[1]) {
    const specSetId = decodeURIComponent(revisionCreate[1]);
    const revision = integer(body.revision);
    const specRecord = await specRepository.get(specSetId);
    const before = specRecord?.revisions.find(
      (entry) => entry.revision === revision
    ) ?? specRecord?.revisions.find(
      (entry) => entry.revision === (revision ?? 0) - 1
    );
    return [{
      action: "spec_revision.create",
      resourceType: "spec_revision",
      resourceId: `${specSetId}@${revision ?? "invalid"}`,
      ...(digest(before) ? { beforeDigest: digest(before)! } : {}),
      mutates: true
    }];
  }

  const revisionApprove = pathname.match(
    /^\/v1\/spec-sets\/([^/]+)\/revisions\/([1-9][0-9]*)\/approve$/u
  );
  if (method === "POST" && revisionApprove?.[1] && revisionApprove[2]) {
    const specSetId = decodeURIComponent(revisionApprove[1]);
    const revision = Number(revisionApprove[2]);
    const before = (await specRepository.get(specSetId))?.revisions.find(
      (entry) => entry.revision === revision
    );
    return [{
      action: "spec_revision.approve",
      resourceType: "spec_revision",
      resourceId: `${specSetId}@${revision}`,
      responseResourceId: "spec_revision",
      responseResourcePrefix: specSetId,
      ...(digest(before) ? { beforeDigest: digest(before)! } : {}),
      mutates: true
    }];
  }

  const effectiveGovernance = pathname.match(
    /^\/v1\/projects\/([^/]+)\/(effective-governance|policy\/explain)$/u
  );
  if (method === "GET" && effectiveGovernance?.[1] && effectiveGovernance[2]) {
    const projectId = decodeURIComponent(effectiveGovernance[1]);
    const hasOverride = Object.keys(query).some((key) => key !== "now");
    return [{
      action: effectiveGovernance[2] === "policy/explain"
        ? "governance.explain"
        : hasOverride
          ? "governance.resolve_override"
          : "governance.resolve",
      resourceType: "governance_snapshot",
      resourceId: projectId,
      projectId,
      mutates: false,
      responseSelector: "snapshot"
    }];
  }

  if (method === "POST" && pathname === "/v1/tasks") {
    const projectId = string(body.projectId);
    const plans: DomainAuditPlan[] = [{
      action: "task.create",
      resourceType: "task",
      ...(projectId ? { projectId } : {}),
      mutates: true,
      responseResourceId: "id"
    }];
    if (body.workflowRef !== undefined || body.harnessProfileRef !== undefined) {
      plans.push({
        action: "governance.override",
        resourceType: "task_governance_binding",
        ...(projectId ? { projectId } : {}),
        mutates: true,
        responseResourceId: "id"
      });
    }
    return plans;
  }

  const runCreate = pathname.match(/^\/v1\/tasks\/([^/]+)\/runs$/u);
  if (method === "POST" && runCreate?.[1]) {
    const taskId = decodeURIComponent(runCreate[1]);
    const task = store.tasks.get(taskId);
    return [{
      action: "run.create",
      resourceType: "run",
      ...(task?.projectId ? { projectId: task.projectId } : {}),
      mutates: true,
      responseResourceId: "id"
    }];
  }

  const gateArtifactRegister = pathname.match(
    /^\/v1\/run-jobs\/queue\/([^/]+)\/artifacts$/u
  );
  if (method === "POST" && gateArtifactRegister?.[1]) {
    const runId = decodeURIComponent(gateArtifactRegister[1]);
    const run = store.runs.get(runId);
    return [{
      action: "gate_artifact.register",
      resourceType: "gate_artifact",
      ...(run?.projectId ? { projectId: run.projectId } : {}),
      ...(runPackDigest(run) ? { packDigest: runPackDigest(run)! } : {}),
      mutates: true,
      responseResourceId: "id"
    }];
  }

  const externalRunMutation = pathname.match(
    /^\/v1\/run-jobs\/queue\/([^/]+)\/(update|finish)$/u
  );
  if (method === "POST" && externalRunMutation?.[1] && externalRunMutation[2]) {
    const runId = decodeURIComponent(externalRunMutation[1]);
    const before = store.runs.get(runId);
    const bodyRun = record(body.run);
    const projectId = before?.projectId ?? string(bodyRun.projectId);
    return [{
      action: externalRunMutation[2] === "finish" ? "run.finish" : "run.checkpoint",
      resourceType: externalRunMutation[2] === "finish" ? "run" : "run_checkpoint",
      resourceId: runId,
      ...(projectId ? { projectId } : {}),
      ...(digest(before) ? { beforeDigest: digest(before)! } : {}),
      ...(runPackDigest(before) ? { packDigest: runPackDigest(before)! } : {}),
      mutates: true,
      responseSelector: "run"
    }];
  }

  const runAction = pathname.match(/^\/v1\/runs\/([^/]+)\/(approve|cancel|resume)$/u);
  if (method === "POST" && runAction?.[1] && runAction[2]) {
    const runId = decodeURIComponent(runAction[1]);
    const before = store.runs.get(runId);
    return [{
      action: `run.${runAction[2]}`,
      resourceType: "run",
      resourceId: runId,
      ...(before?.projectId ? { projectId: before.projectId } : {}),
      ...(digest(before) ? { beforeDigest: digest(before)! } : {}),
      ...(runPackDigest(before) ? { packDigest: runPackDigest(before)! } : {}),
      mutates: true,
      responseSelector: "run"
    }];
  }

  if (method === "POST" && pathname === "/v1/learning-proposals") {
    const proposal = record(body.proposal);
    const resourceId = string(proposal.id);
    const projectId = string(body.projectId);
    const before = latestLearningProposal(store, tenantId, projectId, resourceId);
    return [{
      action: "learning_proposal.create",
      resourceType: "learning_proposal",
      ...(resourceId ? { resourceId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(digest(before) ? { beforeDigest: digest(before)! } : {}),
      mutates: true
    }];
  }

  const learning = learningAction(pathname);
  if (method === "POST" && learning) {
    const resourceId = string(params.id) ??
      pathname.split("/").filter(Boolean)[2];
    const projectId = string(body.projectId);
    const before = latestLearningProposal(store, tenantId, projectId, resourceId);
    return [{
      action: learning,
      resourceType: "learning_proposal",
      ...(resourceId ? { resourceId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(digest(before) ? { beforeDigest: digest(before)! } : {}),
      mutates: true
    }];
  }

  if (method === "POST" && pathname === "/v1/eval-assets") {
    const asset = record(body.asset);
    const id = string(asset.id);
    const revision = integer(asset.revision) ?? 1;
    const projectId = string(body.projectId);
    return [{
      action: "eval_asset.create",
      resourceType: "eval_asset",
      ...(id ? { resourceId: `${id}@${revision}` } : {}),
      ...(projectId ? { projectId } : {}),
      mutates: true
    }];
  }

  if (method === "POST" && pathname === "/v1/trace-graphs") {
    const resourceId = string(body.id);
    const projectId = string(body.projectId);
    return [{
      action: "trace_graph.create",
      resourceType: "trace_graph",
      ...(resourceId ? { resourceId } : {}),
      ...(projectId ? { projectId } : {}),
      mutates: true
    }];
  }

  if (method === "POST" && pathname === "/v1/maturity-report") {
    const resourceId = string(body.id);
    const projectId = string(body.projectId);
    return [{
      action: "maturity_report.create",
      resourceType: "maturity_report",
      ...(resourceId ? { resourceId } : {}),
      ...(projectId ? { projectId } : {}),
      mutates: true
    }];
  }

  return [];
}

export function parseDomainAuditResponse(payload: unknown): unknown {
  if (Buffer.isBuffer(payload)) {
    try {
      return JSON.parse(payload.toString("utf8")) as unknown;
    } catch {
      return payload.toString("utf8");
    }
  }
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return payload;
    }
  }
  return payload;
}

function selectedResponse(plan: DomainAuditPlan, response: unknown): unknown {
  const value = record(response);
  switch (plan.responseSelector) {
    case "lock":
      return value.lock;
    case "project":
      return value.project;
    case "run":
      return value.run ?? response;
    case "snapshot":
      return value.snapshot ??
        (typeof value.snapshotDigest === "string"
          ? { digest: value.snapshotDigest }
          : response);
    case "identity":
    default:
      return response;
  }
}

export function finalizedDomainResource(input: {
  readonly plan: DomainAuditPlan;
  readonly response: unknown;
  readonly succeeded: boolean;
}): {
  readonly resourceId?: string;
  readonly afterDigest?: string;
  readonly packDigest?: string;
} {
  const { plan, response, succeeded } = input;
  const value = record(response);
  const responseRun = record(value.run);
  const responseAllocatedId = plan.responseResourceId === "run.id"
      ? string(responseRun.id)
      : plan.responseResourceId === "spec_revision"
        ? plan.responseResourcePrefix && integer(value.revision)
          ? `${plan.responseResourcePrefix}@${integer(value.revision)}`
          : undefined
      : plan.responseResourceId === "id"
        ? string(value.id)
        : undefined;
  const resourceId = succeeded
    ? responseAllocatedId ?? plan.resourceId
    : plan.resourceId ?? responseAllocatedId;
  if (!succeeded) return { ...(resourceId ? { resourceId } : {}) };
  const selected = selectedResponse(plan, response);
  const selectedRecord = record(selected);
  const semanticDigest = plan.responseSelector === "snapshot"
    ? string(selectedRecord.digest)
    : undefined;
  const responsePackDigest = plan.packDigest ??
    (plan.resourceType === "standard_pack"
      ? string(selectedRecord.digest)
      : plan.resourceType === "run" || plan.resourceType === "run_checkpoint"
        ? unknownRunPackDigest(selected)
        : undefined);
  return {
    ...(resourceId ? { resourceId } : {}),
    afterDigest: semanticDigest && /^[a-f0-9]{64}$/u.test(semanticDigest)
      ? semanticDigest
      : sha256Canonical(selected ?? { resourceId, succeeded: true }),
    ...(responsePackDigest ? { packDigest: responsePackDigest } : {})
  };
}
