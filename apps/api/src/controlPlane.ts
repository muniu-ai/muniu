import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  GovernanceResolutionError,
  createPackLock,
  explainGovernance,
  hashStandardPackManifest,
  planStandardPackSync,
  resolveGovernance,
  sha256Canonical,
  validateStandardPack,
  type GovernanceScope,
  type GovernanceSpecRef,
  type PackLockEntry,
  type ScopedGovernanceLayer,
  type StandardPackManifest,
  type TrustProfile,
  type VersionedGovernanceRef,
  type Waiver
} from "@mn/governance";
import {
  FileSpecRepository,
  approveSpecRevision,
  isStrictTimestamp,
  type SpecRevision,
  type SpecSet
} from "@mn/specs";
import { DEFAULT_POLICY, type RequestContext } from "@mn/core";
import {
  BUILTIN_DEFAULT_STANDARD_PACK,
  LOCAL_TENANT_ID,
  scopedTenantRecordKey,
  type GovernanceLayerRecord,
  type MemoryStore,
  type StandardPackRecord
} from "./store.js";

const scopeSchema = z.enum([
  "builtin",
  "organization",
  "team",
  "project",
  "service",
  "task"
]);
const importPackSchema = z.object({
  manifest: z.unknown(),
  importedBy: z.string().min(1).default("local-user")
});
const activatePackSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  scope: scopeSchema,
  scopeId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  activatedBy: z.string().min(1).default("local-user")
});
const diffPackSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1)
});
const specSetCreateSchema = z.object({
  specSet: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    latestRevision: z.number().int().nonnegative().default(0),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1)
  }),
  initialRevision: z.unknown().optional()
});
const approveSchema = z.object({
  approvedBy: z.string().min(1),
  approvedAt: z.string().optional(),
  createdBy: z.string().optional()
});
const governanceQuerySchema = z.object({
  now: z.string().optional(),
  organizationId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  serviceId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  specSetId: z.string().min(1).optional(),
  specRevision: z.coerce.number().int().positive().optional(),
  workflowId: z.string().min(1).optional(),
  workflowVersion: z.string().min(1).optional(),
  workflowDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  harnessProfileId: z.string().min(1).optional(),
  harnessProfileVersion: z.string().min(1).optional(),
  harnessProfileDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional()
});
const waiverSchema = z.object({
  id: z.string().min(1),
  target: z.object({
    field: z.enum(["requiredGates", "deny", "protectedPaths"]),
    value: z.string().min(1)
  }),
  scope: z.object({ level: scopeSchema, id: z.string().min(1) }),
  reason: z.string().min(1),
  approvedBy: z.string().min(1),
  approvedAt: z.string().min(1),
  expiresAt: z.string().min(1)
});

export interface ControlPlaneRouteOptions {
  readonly store: MemoryStore;
  readonly specRepository: FileSpecRepository;
  readonly contextForRequest?: (request: FastifyRequest) => RequestContext;
  readonly standardPackTrustProfile?: TrustProfile;
  readonly requireVerifiedStandardPacks?: boolean;
}

function packKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function tenantForRequest(
  request: FastifyRequest,
  options: ControlPlaneRouteOptions
): string {
  return options.contextForRequest?.(request).tenantId ?? LOCAL_TENANT_ID;
}

function actorForRequest(
  request: FastifyRequest,
  options: ControlPlaneRouteOptions,
  claimedActorId: string
): string {
  const context = options.contextForRequest?.(request);
  return context && context.authentication !== "local"
    ? context.actorId
    : claimedActorId;
}

function tenantStoreKey(tenantId: string, resourceId: string): string {
  return scopedTenantRecordKey(tenantId, resourceId);
}

function scopedKeyBelongsToTenant(key: string, tenantId: string): boolean {
  try {
    const parsed = JSON.parse(key) as unknown;
    return Array.isArray(parsed) && parsed.length === 2 && parsed[0] === tenantId;
  } catch {
    return tenantId === LOCAL_TENANT_ID;
  }
}

function recordBelongsToTenant(
  record: { readonly tenantId?: string },
  tenantId: string
): boolean {
  return (record.tenantId ?? LOCAL_TENANT_ID) === tenantId;
}

function specBelongsToTenant(
  specSetId: string,
  tenantId: string,
  options: ControlPlaneRouteOptions
): boolean {
  return (options.store.specSetTenants.get(specSetId) ?? LOCAL_TENANT_ID) === tenantId;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function builtinLayer(): ScopedGovernanceLayer {
  const policy = {
    requiredGates: DEFAULT_POLICY.defaultRequiredGates,
    protectedPaths: DEFAULT_POLICY.protectedPaths,
    allowedProviders: DEFAULT_POLICY.allowedProviders,
    commandAllowlist: DEFAULT_POLICY.commandAllowlist,
    budgets: {
      maxCandidates: DEFAULT_POLICY.maxCandidates,
      maxDurationSeconds: DEFAULT_POLICY.maxTimeoutSeconds,
      maxRepairAttempts: 3
    },
    approvalMode: "on-risk" as const
  };
  return {
    scope: "builtin",
    scopeId: "default",
    source: {
      id: "builtin/default",
      version: "1",
      digest: sha256Canonical(policy)
    },
    policy
  };
}

function changedTopLevelFields(
  before: StandardPackManifest,
  after: StandardPackManifest
): string[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields]
    .filter(
      (field) => {
        const beforeRecord = before as unknown as Record<string, unknown>;
        const afterRecord = after as unknown as Record<string, unknown>;
        const beforeValue = Object.hasOwn(beforeRecord, field)
          ? { present: true, value: beforeRecord[field] }
          : { present: false };
        const afterValue = Object.hasOwn(afterRecord, field)
          ? { present: true, value: afterRecord[field] }
          : { present: false };
        return sha256Canonical(beforeValue) !== sha256Canonical(afterValue);
      }
    )
    .sort(compareCodeUnits);
}

function activeLayerMatches(
  record: GovernanceLayerRecord,
  bindings: Readonly<Partial<Record<GovernanceScope, string>>>
): boolean {
  const expected = bindings[record.layer.scope];
  return expected !== undefined && expected === record.layer.scopeId;
}

function parseRevisionNumber(value: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(value)) return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

function governanceError(error: unknown): { statusCode: number; body: unknown } {
  if (error instanceof GovernanceResolutionError) {
    return {
      statusCode: 400,
      body: { error: "governance resolution failed", details: error.issues }
    };
  }
  return {
    statusCode: 400,
    body: { error: error instanceof Error ? error.message : String(error) }
  };
}

export async function resolveProjectGovernance(
  projectId: string,
  queryInput: unknown,
  options: ControlPlaneRouteOptions,
  expectedTenantId?: string
) {
  const project = options.store.projects.get(projectId);
  if (!project) return { notFound: true as const };
  const tenantId = project.tenantId ?? LOCAL_TENANT_ID;
  if (expectedTenantId !== undefined && tenantId !== expectedTenantId) {
    return { notFound: true as const };
  }
  const query = governanceQuerySchema.parse(queryInput);
  if (
    tenantId !== LOCAL_TENANT_ID &&
    query.organizationId !== undefined &&
    query.organizationId !== tenantId
  ) {
    throw new TypeError("organizationId is outside the tenant");
  }
  const bindings: Partial<Record<GovernanceScope, string>> = {
    builtin: "default",
    organization: query.organizationId ?? tenantId,
    project: projectId,
    ...(query.teamId ? { team: query.teamId } : {}),
    ...(query.serviceId ? { service: query.serviceId } : {}),
    ...(query.taskId ? { task: query.taskId } : {})
  };
  const layers = [
    builtinLayer(),
    ...[...options.store.governanceLayers.values()]
      .filter(
        (record) =>
          recordBelongsToTenant(record, tenantId) &&
          activeLayerMatches(record, bindings)
      )
      .map((record) => record.layer)
  ];
  const now = query.now ?? new Date().toISOString();
  const tenantWaivers = [...options.store.waivers.entries()]
    .filter(([key]) => scopedKeyBelongsToTenant(key, tenantId))
    .map(([, waiver]) => waiver);
  const activeWaivers = tenantWaivers.filter(
    (waiver) =>
      bindings[waiver.scope.level] === waiver.scope.id &&
      Date.parse(waiver.expiresAt) > Date.parse(now)
  );
  let specRef: GovernanceSpecRef | undefined;
  let workflowRef: VersionedGovernanceRef | undefined;
  let harnessProfileRef: VersionedGovernanceRef | undefined;

  if (query.specSetId !== undefined || query.specRevision !== undefined) {
    if (!query.specSetId || !query.specRevision) {
      throw new TypeError("specSetId and specRevision must be supplied together");
    }
    if (!specBelongsToTenant(query.specSetId, tenantId, options)) {
      throw new TypeError("effective governance requires an existing approved Spec revision");
    }
    const record = await options.specRepository.get(query.specSetId);
    const revision = record?.revisions.find(
      (candidate) => candidate.revision === query.specRevision
    );
    if (!revision || revision.status !== "approved" || !revision.digest) {
      throw new TypeError("effective governance requires an existing approved Spec revision");
    }
    specRef = {
      specSetId: revision.specSetId,
      revision: revision.revision,
      digest: revision.digest
    };
  }

  if (
    query.workflowId !== undefined ||
    query.workflowVersion !== undefined ||
    query.workflowDigest !== undefined
  ) {
    if (!query.workflowId || !query.workflowVersion || !query.workflowDigest) {
      throw new TypeError("workflowId, workflowVersion and workflowDigest must be supplied together");
    }
    workflowRef = {
      id: query.workflowId,
      version: query.workflowVersion,
      digest: query.workflowDigest
    };
  }
  if (
    query.harnessProfileId !== undefined ||
    query.harnessProfileVersion !== undefined ||
    query.harnessProfileDigest !== undefined
  ) {
    if (
      !query.harnessProfileId ||
      !query.harnessProfileVersion ||
      !query.harnessProfileDigest
    ) {
      throw new TypeError(
        "harnessProfileId, harnessProfileVersion and harnessProfileDigest must be supplied together"
      );
    }
    harnessProfileRef = {
      id: query.harnessProfileId,
      version: query.harnessProfileVersion,
      digest: query.harnessProfileDigest
    };
  }

  return {
    notFound: false as const,
    snapshot: resolveGovernance(layers, {
      now,
      scopeBindings: bindings,
      waivers: activeWaivers,
      ...(specRef ? { specRef } : {}),
      ...(workflowRef ? { workflowRef } : {}),
      ...(harnessProfileRef ? { harnessProfileRef } : {})
    }),
    bindings,
    ignoredWaiverIds: [...options.store.waivers.values()]
      .filter((waiver) => tenantWaivers.includes(waiver) && !activeWaivers.includes(waiver))
      .map((waiver) => waiver.id)
      .sort(compareCodeUnits)
  };
}

export function registerControlPlaneRoutes(
  app: FastifyInstance,
  options: ControlPlaneRouteOptions
): void {
  app.get("/v1/standard-packs", async (request) => {
    const tenantId = tenantForRequest(request, options);
    return {
      standardPacks: [...options.store.standardPacks.values()]
        .filter((record) => recordBelongsToTenant(record, tenantId))
        .sort((left, right) => compareCodeUnits(left.key, right.key))
    };
  });

  app.post("/v1/standard-packs/validate", async (request, reply) => {
    const result = validateStandardPack(request.body);
    return reply.code(result.valid ? 200 : 400).send(result);
  });

  app.post("/v1/standard-packs/import", async (request, reply) => {
    const body = importPackSchema.parse(request.body);
    const validation = validateStandardPack(body.manifest);
    if (!validation.valid || !validation.manifest) {
      return reply.code(400).send(validation);
    }
    const manifest = validation.manifest;
    const key = packKey(manifest.id, manifest.version);
    const tenantId = tenantForRequest(request, options);
    const storageKey = tenantStoreKey(tenantId, key);
    const digest = hashStandardPackManifest(manifest);
    if (options.requireVerifiedStandardPacks || options.standardPackTrustProfile) {
      if (!options.standardPackTrustProfile) {
        return reply.code(503).send({
          error: "verified Standard Pack import requires a configured trust profile"
        });
      }
      const verification = planStandardPackSync(
        [],
        {
          schemaVersion: 1,
          entries: [{
            manifest,
            digest,
            scope: "organization",
            scopeId: tenantId,
            source: `api://standard-packs/${encodeURIComponent(key)}`
          }],
          publicKeys: options.standardPackTrustProfile.trustedPublicKeys,
          revokedPublicKeyIds:
            options.standardPackTrustProfile.revokedPublicKeyIds ?? []
        },
        options.standardPackTrustProfile,
        true
      );
      if (!verification.valid || verification.entries[0]?.signatureVerified !== true) {
        return reply.code(400).send({
          error: "Standard Pack signature or release trust verification failed",
          issues: verification.issues,
          entryIssues: verification.entries[0]?.issues ?? []
        });
      }
    }
    const existing = options.store.standardPacks.get(storageKey) ??
      (tenantId === LOCAL_TENANT_ID
        ? options.store.standardPacks.get(key)
        : undefined);
    if (existing && existing.digest !== digest) {
      return reply.code(409).send({
        error: "standard pack version already exists with a different digest",
        key,
        existingDigest: existing.digest,
        receivedDigest: digest
      });
    }
    const record: StandardPackRecord =
      existing ?? {
        key,
        tenantId,
        manifest,
        digest,
        importedAt: new Date().toISOString(),
        importedBy: actorForRequest(request, options, body.importedBy),
        trust: options.standardPackTrustProfile ? "verified" : "local"
      };
    options.store.standardPacks.set(storageKey, record);
    return reply.code(existing ? 200 : 201).send(record);
  });

  app.post("/v1/standard-packs/diff", async (request, reply) => {
    const body = diffPackSchema.parse(request.body);
    const tenantId = tenantForRequest(request, options);
    const before = options.store.standardPacks.get(tenantStoreKey(tenantId, body.from)) ??
      (tenantId === LOCAL_TENANT_ID ? options.store.standardPacks.get(body.from) : undefined);
    const after = options.store.standardPacks.get(tenantStoreKey(tenantId, body.to)) ??
      (tenantId === LOCAL_TENANT_ID ? options.store.standardPacks.get(body.to) : undefined);
    if (!before || !after) {
      return reply.code(404).send({ error: "standard pack not found" });
    }
    return {
      from: { key: before.key, digest: before.digest },
      to: { key: after.key, digest: after.digest },
      changed: before.digest !== after.digest,
      changedFields: changedTopLevelFields(before.manifest, after.manifest)
    };
  });

  app.post("/v1/standard-packs/activate", async (request, reply) => {
    const body = activatePackSchema.parse(request.body);
    const key = packKey(body.id, body.version);
    const tenantId = tenantForRequest(request, options);
    const pack = options.store.standardPacks.get(tenantStoreKey(tenantId, key)) ??
      (tenantId === LOCAL_TENANT_ID ? options.store.standardPacks.get(key) : undefined);
    if (!pack) return reply.code(404).send({ error: "standard pack not found" });
    if (body.scope === "builtin") {
      return reply.code(400).send({ error: "builtin scope cannot be changed through the API" });
    }
    if (
      tenantId !== LOCAL_TENANT_ID &&
      body.scope === "organization" &&
      body.scopeId !== tenantId
    ) {
      return reply.code(400).send({ error: "organization scope is outside the tenant" });
    }
    if (
      body.scope === "project" &&
      body.projectId !== undefined &&
      body.projectId !== body.scopeId
    ) {
      return reply.code(400).send({ error: "projectId does not match project scope" });
    }
    let projectId = body.projectId ?? (body.scope === "project" ? body.scopeId : undefined);
    if (body.scope === "task") {
      const task = options.store.tasks.get(body.scopeId);
      if (!task || (task.tenantId ?? LOCAL_TENANT_ID) !== tenantId) {
        return reply.code(404).send({ error: "task not found" });
      }
      if (projectId !== undefined && projectId !== task.projectId) {
        return reply.code(400).send({ error: "projectId does not own task scope" });
      }
      projectId = task.projectId;
    }
    if (projectId) {
      const project = options.store.projects.get(projectId);
      if (!project || (project.tenantId ?? LOCAL_TENANT_ID) !== tenantId) {
        return reply.code(404).send({ error: "project not found" });
      }
    }
    const layer: ScopedGovernanceLayer = {
      scope: body.scope,
      scopeId: body.scopeId,
      source: { id: pack.manifest.id, version: pack.manifest.version, digest: pack.digest },
      policy: pack.manifest.rules
    };
    for (const [recordKey, existing] of options.store.governanceLayers) {
      if (
        recordBelongsToTenant(existing, tenantId) &&
        existing.layer.scope === body.scope &&
        existing.layer.scopeId === body.scopeId &&
        existing.layer.source.id === pack.manifest.id
      ) {
        options.store.governanceLayers.delete(recordKey);
      }
    }
    const recordKey = `${body.scope}:${body.scopeId}:${pack.manifest.id}`;
    const storageKey = tenantStoreKey(tenantId, recordKey);
    const activatedAt = new Date().toISOString();
    options.store.governanceLayers.set(storageKey, {
      key: recordKey,
      tenantId,
      layer,
      activatedAt,
      activatedBy: actorForRequest(request, options, body.activatedBy),
      packKey: key
    });

    let lock;
    if (projectId) {
      const lockStorageKey = tenantStoreKey(tenantId, projectId);
      const current = (options.store.projectPackLocks.get(lockStorageKey) ??
        (tenantId === LOCAL_TENANT_ID
          ? options.store.projectPackLocks.get(projectId)
          : undefined))?.lock.packs ?? [];
      const entry: PackLockEntry = {
        id: pack.manifest.id,
        version: pack.manifest.version,
        digest: pack.digest,
        scope: body.scope,
        scopeId: body.scopeId,
        ...(pack.manifest.release
          ? { sequence: pack.manifest.release.sequence }
          : {})
      };
      lock = createPackLock(
        [...current.filter((candidate) => !(candidate.id === entry.id && candidate.scope === entry.scope && candidate.scopeId === entry.scopeId)), entry],
        activatedAt
      );
      options.store.projectPackLocks.set(lockStorageKey, {
        projectId,
        tenantId,
        lock,
        updatedAt: activatedAt
      });
    }
    return { activated: true, layer, ...(lock ? { lock } : {}) };
  });

  app.get("/v1/projects/:id/standards-lock", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = tenantForRequest(request, options);
    const record = options.store.projectPackLocks.get(tenantStoreKey(tenantId, id)) ??
      (tenantId === LOCAL_TENANT_ID
        ? options.store.projectPackLocks.get(id)
        : undefined);
    if (!record) return reply.code(404).send({ error: "standards lock not found" });
    return record;
  });

  app.post("/v1/waivers", async (request, reply) => {
    const parsedWaiver = waiverSchema.parse(request.body) as Waiver;
    const waiver: Waiver = {
      ...parsedWaiver,
      approvedBy: actorForRequest(
        request,
        options,
        parsedWaiver.approvedBy
      )
    };
    const tenantId = tenantForRequest(request, options);
    const storageKey = tenantStoreKey(tenantId, waiver.id);
    if (waiver.scope.level === "organization" && waiver.scope.id !== tenantId) {
      return reply.code(400).send({ error: "waiver organization scope is outside the tenant" });
    }
    if (waiver.scope.level === "project") {
      const project = options.store.projects.get(waiver.scope.id);
      if (!project || (project.tenantId ?? LOCAL_TENANT_ID) !== tenantId) {
        return reply.code(404).send({ error: "project not found" });
      }
    }
    if (waiver.scope.level === "task") {
      const task = options.store.tasks.get(waiver.scope.id);
      if (!task || (task.tenantId ?? LOCAL_TENANT_ID) !== tenantId) {
        return reply.code(404).send({ error: "task not found" });
      }
    }
    const now = Date.now();
    if (
      !isStrictTimestamp(waiver.approvedAt) ||
      !isStrictTimestamp(waiver.expiresAt) ||
      Date.parse(waiver.approvedAt) > now ||
      Date.parse(waiver.approvedAt) >= Date.parse(waiver.expiresAt) ||
      Date.parse(waiver.expiresAt) <= now
    ) {
      return reply.code(400).send({ error: "waiver approval and expiry timeline is invalid" });
    }
    if (options.store.waivers.has(storageKey) ||
      (tenantId === LOCAL_TENANT_ID && options.store.waivers.has(waiver.id))) {
      return reply.code(409).send({ error: "waiver id already exists" });
    }
    options.store.waivers.set(storageKey, waiver);
    return reply.code(201).send(waiver);
  });

  app.get("/v1/waivers", async (request) => {
    const tenantId = tenantForRequest(request, options);
    return {
      waivers: [...options.store.waivers.entries()]
        .filter(([key]) => scopedKeyBelongsToTenant(key, tenantId))
        .map(([, waiver]) => waiver)
        .sort((left, right) => compareCodeUnits(left.id, right.id))
    };
  });

  app.post("/v1/spec-sets", async (request, reply) => {
    const body = specSetCreateSchema.parse(request.body);
    const tenantId = tenantForRequest(request, options);
    const existingOwner = options.store.specSetTenants.get(body.specSet.id);
    if (existingOwner !== undefined && existingOwner !== tenantId) {
      return reply.code(409).send({ error: "spec set id is unavailable" });
    }
    const reservedOwnership = existingOwner === undefined;
    if (reservedOwnership) {
      // Persist ownership before writing the separate Spec repository. A crash
      // may leave a harmless reservation, but cannot leave enterprise Spec
      // content unowned and therefore visible through the legacy-local fallback.
      options.store.specSetTenants.set(body.specSet.id, tenantId);
    }
    try {
      const record = await options.specRepository.create(
        body.specSet as SpecSet,
        body.initialRevision as SpecRevision | undefined
      );
      return reply.code(201).send(record);
    } catch (error) {
      if (
        reservedOwnership &&
        options.store.specSetTenants.get(body.specSet.id) === tenantId
      ) {
        options.store.specSetTenants.delete(body.specSet.id);
      }
      return reply.code(error instanceof Error && error.message.includes("already exists") ? 409 : 400).send({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/v1/spec-sets", async (request) => {
    const tenantId = tenantForRequest(request, options);
    const records = await options.specRepository.list();
    return {
      specSets: records.filter((record) =>
        specBelongsToTenant(record.id, tenantId, options)
      )
    };
  });

  app.get("/v1/spec-sets/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = tenantForRequest(request, options);
    if (!specBelongsToTenant(id, tenantId, options)) {
      return reply.code(404).send({ error: "spec set not found" });
    }
    try {
      const record = await options.specRepository.get(id);
      return record ?? reply.code(404).send({ error: "spec set not found" });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/v1/spec-sets/:id/revisions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = tenantForRequest(request, options);
    if (!specBelongsToTenant(id, tenantId, options)) {
      return reply.code(404).send({ error: "spec set not found" });
    }
    const revision = request.body as SpecRevision;
    if (revision?.specSetId !== id) {
      return reply.code(400).send({ error: "revision specSetId does not match route" });
    }
    try {
      return reply.code(201).send(await options.specRepository.saveRevision(revision));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/v1/spec-sets/:id/revisions/:revision", async (request, reply) => {
    const { id, revision: rawRevision } = request.params as { id: string; revision: string };
    const tenantId = tenantForRequest(request, options);
    if (!specBelongsToTenant(id, tenantId, options)) {
      return reply.code(404).send({ error: "spec revision not found" });
    }
    const revisionNumber = parseRevisionNumber(rawRevision);
    if (!revisionNumber) return reply.code(400).send({ error: "invalid revision" });
    const record = await options.specRepository.get(id);
    const revision = record?.revisions.find((candidate) => candidate.revision === revisionNumber);
    return revision ?? reply.code(404).send({ error: "spec revision not found" });
  });

  app.post("/v1/spec-sets/:id/revisions/:revision/approve", async (request, reply) => {
    const { id, revision: rawRevision } = request.params as { id: string; revision: string };
    const tenantId = tenantForRequest(request, options);
    if (!specBelongsToTenant(id, tenantId, options)) {
      return reply.code(404).send({ error: "spec revision not found" });
    }
    const revisionNumber = parseRevisionNumber(rawRevision);
    if (!revisionNumber) return reply.code(400).send({ error: "invalid revision" });
    const parsedInput = approveSchema.parse(request.body);
    const approvedBy = actorForRequest(
      request,
      options,
      parsedInput.approvedBy
    );
    const input = {
      ...parsedInput,
      approvedBy,
      createdBy: actorForRequest(
        request,
        options,
        parsedInput.createdBy ?? approvedBy
      )
    };
    const record = await options.specRepository.get(id);
    const predecessor = record?.revisions.find((candidate) => candidate.revision === revisionNumber);
    if (!record || !predecessor) return reply.code(404).send({ error: "spec revision not found" });
    if (record.specSet.latestRevision !== revisionNumber) {
      return reply.code(409).send({ error: "only the latest revision can be approved" });
    }
    try {
      const approved = approveSpecRevision(predecessor, input);
      await options.specRepository.saveRevision(approved);
      return reply.code(201).send(approved);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/v1/projects/:id/effective-governance", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await resolveProjectGovernance(
        id,
        request.query,
        options,
        tenantForRequest(request, options)
      );
      if (result.notFound) return reply.code(404).send({ error: "project not found" });
      return result;
    } catch (error) {
      const mapped = governanceError(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  app.get("/v1/projects/:id/policy/explain", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await resolveProjectGovernance(
        id,
        request.query,
        options,
        tenantForRequest(request, options)
      );
      if (result.notFound) return reply.code(404).send({ error: "project not found" });
      return {
        snapshotDigest: result.snapshot.digest,
        bindings: result.bindings,
        ignoredWaiverIds: result.ignoredWaiverIds,
        explanation: explainGovernance(result.snapshot)
      };
    } catch (error) {
      const mapped = governanceError(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });
}

export function defaultControlPlaneSpecRepository(root: string): FileSpecRepository {
  return new FileSpecRepository(root);
}
