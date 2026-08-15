import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { RequestContext } from "@mn/core";
import {
  EvalAssetRegistry,
  LearningProposalRegistry,
  analyzeTraceGraph,
  buildMaturityReport,
  createLearningProposal,
  createTraceGraph,
  type CreateEvalAssetInput,
  type CreateLearningProposalInput,
  type EvalAssetRevision,
  type LearningProposal,
  type LearningProposalRegistryOptions,
  type MaturityMeasurementInput,
  type TraceAnalysis,
  type TraceGraph
} from "@mn/evidence";
import { canonicalJson, isStrictTimestamp } from "@mn/specs";
import {
  aggregateEnterpriseMaturity,
  validateEnterpriseEvalAsset,
  validateEnterpriseLearningEvidence,
  validateEnterpriseTraceGraph,
  type EnterpriseEvidenceTruthResolvers
} from "./evidenceTruth.js";
import {
  LOCAL_TENANT_ID,
  scopedEvidenceRecordKey,
  type EvalAssetRecord,
  type LearningProposalRecord,
  type MemoryStore,
  type MaturityReportRecord,
  type TraceGraphRecord
} from "./store.js";

const resourceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const projectQuerySchema = z.object({ projectId: resourceIdSchema }).strict();
const resourceQuerySchema = projectQuerySchema.extend({
  revision: z.coerce.number().int().positive().optional()
}).strict();
const evalAssetListQuerySchema = projectQuerySchema.extend({
  kind: z
    .enum([
      "acceptance_case",
      "contract_test",
      "golden_case",
      "regression_slice",
      "fixture",
      "operational_probe"
    ])
    .optional(),
  specClauseId: resourceIdSchema.optional(),
  serviceId: resourceIdSchema.optional(),
  owner: resourceIdSchema.optional()
}).strict();
const createEvalAssetSchema = z.object({
  projectId: resourceIdSchema,
  asset: z.unknown()
}).strict();
const traceAnalysisInputSchema = z.object({
  requiredSpecClauseIds: z.array(resourceIdSchema),
  contracts: z.array(z.object({
    ref: resourceIdSchema,
    expectedDigest: digestSchema,
    actualDigest: digestSchema
  }).strict()).optional(),
  expectedContextDigest: digestSchema.optional(),
  actualContextDigest: digestSchema.optional()
}).strict();
const createTraceGraphSchema = z.object({
  projectId: resourceIdSchema,
  id: resourceIdSchema,
  graph: z.object({
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown())
  }).strict(),
  analysis: traceAnalysisInputSchema.optional()
}).strict();
const createLearningProposalSchema = z.object({
  projectId: resourceIdSchema,
  proposal: z.unknown()
}).strict();
const transitionBaseSchema = z.object({
  projectId: resourceIdSchema,
  at: z.string().optional()
}).strict();
const reviewSchema = z.object({
  projectId: resourceIdSchema,
  approved: z.boolean(),
  decidedAt: z.string().optional(),
  reason: resourceIdSchema
}).strict();
const canarySchema = z.object({
  projectId: resourceIdSchema,
  passed: z.boolean(),
  environment: resourceIdSchema,
  evidenceDigest: digestSchema,
  completedAt: z.string().optional()
}).strict();
const promoteSchema = z.object({
  projectId: resourceIdSchema,
  promotedAt: z.string().optional(),
  rollbackRef: resourceIdSchema,
  signature: z.object({
    algorithm: z.literal("ed25519"),
    keyId: resourceIdSchema,
    value: resourceIdSchema
  }).strict()
}).strict();
const rollbackSchema = z.object({
  projectId: resourceIdSchema,
  at: z.string().optional(),
  reason: resourceIdSchema
}).strict();
const createMaturityReportSchema = z.object({
  projectId: resourceIdSchema,
  id: resourceIdSchema,
  generatedAt: z.string().optional(),
  measurement: z.unknown().optional()
}).strict();
const maturityReportQuerySchema = projectQuerySchema.extend({
  id: resourceIdSchema.optional()
}).strict();
const resourceParamsSchema = z.object({ id: resourceIdSchema }).strict();

export interface EvidenceRouteOptions {
  readonly store: MemoryStore;
  readonly contextForRequest: (request: FastifyRequest) => RequestContext;
  readonly verifyLearningProposalSignature?: LearningProposalRegistryOptions["verifySignature"];
  /** Enterprise profile enables fail-closed, server-resolved evidence truth. */
  readonly strictEnterpriseEvidence?: boolean;
  readonly evidenceTruthResolvers?: EnterpriseEvidenceTruthResolvers;
}

class PersistedEvidenceError extends Error {}

function requireEnterpriseResolvers(
  options: EvidenceRouteOptions
): EnterpriseEvidenceTruthResolvers {
  if (!options.evidenceTruthResolvers) {
    throw new Error("enterprise evidence truth resolvers are not configured");
  }
  return options.evidenceTruthResolvers;
}

export function registerEvidenceRoutes(
  app: FastifyInstance,
  options: EvidenceRouteOptions
): void {
  app.post("/v1/eval-assets", async (request, reply) => {
    const body = parseInput(createEvalAssetSchema, request.body, reply);
    if (!body) return;
    const context = options.contextForRequest(request);
    if (!projectInScope(options.store, context, body.projectId)) return notFound(reply);
    try {
      const registry = hydrateEvalAssets(options.store, context.tenantId, body.projectId);
      const asset = registry.register(body.asset as CreateEvalAssetInput);
      if (asset.createdBy !== context.actorId) {
        return reply.code(400).send({
          error: "eval asset createdBy must match the authenticated actor"
        });
      }
      if (options.strictEnterpriseEvidence) {
        const resolvers = requireEnterpriseResolvers(options);
        await validateEnterpriseEvalAsset(asset, {
          store: options.store,
          tenantId: context.tenantId,
          projectId: body.projectId,
          resolvers
        });
      }
      options.store.evalAssets.set(
        scopedEvidenceRecordKey(context.tenantId, body.projectId, asset.id, asset.revision),
        Object.freeze({ tenantId: context.tenantId, projectId: body.projectId, asset })
      );
      return reply.code(201).send(asset);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/v1/eval-assets", async (request, reply) => {
    const query = parseInput(evalAssetListQuerySchema, request.query, reply);
    if (!query) return;
    const context = options.contextForRequest(request);
    if (!projectInScope(options.store, context, query.projectId)) return notFound(reply);
    try {
      const registry = hydrateEvalAssets(options.store, context.tenantId, query.projectId);
      return {
        evalAssets: registry.list({
          ...(query.kind ? { kind: query.kind } : {}),
          ...(query.specClauseId ? { specClauseId: query.specClauseId } : {}),
          ...(query.serviceId ? { serviceId: query.serviceId } : {}),
          ...(query.owner ? { owner: query.owner } : {})
        })
      };
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/v1/eval-assets/:id", async (request, reply) => {
    const params = parseInput(resourceParamsSchema, request.params, reply);
    const query = parseInput(resourceQuerySchema, request.query, reply);
    if (!params || !query) return;
    const context = options.contextForRequest(request);
    if (!projectInScope(options.store, context, query.projectId)) return notFound(reply);
    try {
      const asset = hydrateEvalAssets(
        options.store,
        context.tenantId,
        query.projectId
      ).get(params.id, query.revision);
      return asset ?? notFound(reply);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/v1/trace-graphs", async (request, reply) => {
    const body = parseInput(createTraceGraphSchema, request.body, reply);
    if (!body) return;
    const context = options.contextForRequest(request);
    if (!projectInScope(options.store, context, body.projectId)) return notFound(reply);
    const key = scopedEvidenceRecordKey(context.tenantId, body.projectId, body.id);
    if (options.store.traceGraphs.has(key)) {
      return reply.code(409).send({ error: "trace graph id already exists" });
    }
    try {
      const graph = createTraceGraph(body.graph as Parameters<typeof createTraceGraph>[0]);
      if (options.strictEnterpriseEvidence) {
        if (!body.analysis) {
          throw new TypeError("enterprise trace graphs require analysis");
        }
        await validateEnterpriseTraceGraph({
          graph,
          analysis: body.analysis,
          context: {
            store: options.store,
            tenantId: context.tenantId,
            projectId: body.projectId,
            resolvers: requireEnterpriseResolvers(options)
          }
        });
      }
      const analysis = body.analysis ? analyzeTraceGraph(graph, body.analysis) : undefined;
      const record: TraceGraphRecord = Object.freeze({
        tenantId: context.tenantId,
        projectId: body.projectId,
        id: body.id,
        graph,
        ...(analysis ? { analysis } : {}),
        createdAt: new Date().toISOString(),
        createdBy: context.actorId
      });
      options.store.traceGraphs.set(key, record);
      return reply.code(201).send(record);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/v1/trace-graphs", async (request, reply) => {
    const query = parseInput(projectQuerySchema, request.query, reply);
    if (!query) return;
    const context = options.contextForRequest(request);
    if (!projectInScope(options.store, context, query.projectId)) return notFound(reply);
    try {
      const records = scopedTraceGraphs(options.store, context.tenantId, query.projectId);
      records.forEach(validateTraceGraphRecord);
      return { traceGraphs: records };
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/v1/trace-graphs/:id", async (request, reply) => {
    const params = parseInput(resourceParamsSchema, request.params, reply);
    const query = parseInput(projectQuerySchema, request.query, reply);
    if (!params || !query) return;
    const context = options.contextForRequest(request);
    if (!projectInScope(options.store, context, query.projectId)) return notFound(reply);
    const record = options.store.traceGraphs.get(
      scopedEvidenceRecordKey(context.tenantId, query.projectId, params.id)
    );
    if (!record) return notFound(reply);
    try {
      validateTraceGraphRecord(record);
      return record;
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/v1/learning-proposals", async (request, reply) => {
    const body = parseInput(createLearningProposalSchema, request.body, reply);
    if (!body) return;
    const context = options.contextForRequest(request);
    if (!projectInScope(options.store, context, body.projectId)) return notFound(reply);
    try {
      const proposal = createLearningProposal(body.proposal as CreateLearningProposalInput);
      if (proposal.createdBy !== context.actorId) {
        return reply.code(400).send({
          error: "learning proposal createdBy must match the authenticated actor"
        });
      }
      const sourceRun = options.store.runs.get(proposal.sourceRunId);
      if (
        !sourceRun ||
        (sourceRun.tenantId ?? LOCAL_TENANT_ID) !== context.tenantId ||
        sourceRun.projectId !== body.projectId
      ) {
        return reply.code(400).send({
          error: "learning proposal sourceRunId must bind a run in the same tenant and project"
        });
      }
      if (options.strictEnterpriseEvidence) {
        await validateEnterpriseLearningEvidence({
          proposal,
          context: {
            store: options.store,
            tenantId: context.tenantId,
            projectId: body.projectId,
            resolvers: requireEnterpriseResolvers(options)
          }
        });
      }
      const history = scopedLearningHistory(
        options.store,
        context.tenantId,
        body.projectId,
        proposal.id
      );
      if (history.length > 0) {
        return reply.code(409).send({ error: "learning proposal id already exists" });
      }
      saveLearningProposal(options.store, context, body.projectId, proposal);
      return reply.code(201).send(proposal);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/v1/learning-proposals", async (request, reply) => {
    const query = parseInput(projectQuerySchema, request.query, reply);
    if (!query) return;
    const context = options.contextForRequest(request);
    if (!projectInScope(options.store, context, query.projectId)) return notFound(reply);
    try {
      const latest = latestLearningProposals(
        options.store,
        context.tenantId,
        query.projectId,
        options.verifyLearningProposalSignature
      );
      return { learningProposals: latest };
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/v1/learning-proposals/:id", async (request, reply) => {
    const params = parseInput(resourceParamsSchema, request.params, reply);
    const query = parseInput(resourceQuerySchema, request.query, reply);
    if (!params || !query) return;
    const context = options.contextForRequest(request);
    if (!projectInScope(options.store, context, query.projectId)) return notFound(reply);
    try {
      const registry = hydrateLearningProposals(
        options.store,
        context.tenantId,
        query.projectId,
        params.id,
        options.verifyLearningProposalSignature
      );
      const proposal = registry?.get(params.id, query.revision);
      return proposal ?? notFound(reply);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/v1/learning-proposals/:id/submit", async (request, reply) => {
    const input = parseLearningAction(request, reply, transitionBaseSchema, options);
    if (!input) return;
    const at = timestampOrNow(input.body.at, reply);
    if (!at) return;
    return transitionLearning(options, input, reply, (registry) =>
      registry.submit(input.id, input.context.actorId, at)
    );
  });

  app.post("/v1/learning-proposals/:id/review", async (request, reply) => {
    const input = parseLearningAction(request, reply, reviewSchema, options);
    if (!input) return;
    const decidedAt = timestampOrNow(input.body.decidedAt, reply);
    if (!decidedAt) return;
    return transitionLearning(options, input, reply, (registry) =>
      registry.review({
        id: input.id,
        approved: input.body.approved,
        actor: input.context.actorId,
        decidedAt,
        reason: input.body.reason
      })
    );
  });

  app.post("/v1/learning-proposals/:id/canary", async (request, reply) => {
    const input = parseLearningAction(request, reply, canarySchema, options);
    if (!input) return;
    const completedAt = timestampOrNow(input.body.completedAt, reply);
    if (!completedAt) return;
    return transitionLearning(options, input, reply, (registry) =>
      registry.recordCanary({
        id: input.id,
        passed: input.body.passed,
        environment: input.body.environment,
        evidenceDigest: input.body.evidenceDigest,
        completedAt,
        completedBy: input.context.actorId
      })
    );
  });

  app.post("/v1/learning-proposals/:id/promote", async (request, reply) => {
    const input = parseLearningAction(request, reply, promoteSchema, options);
    if (!input) return;
    const promotedAt = timestampOrNow(input.body.promotedAt, reply);
    if (!promotedAt) return;
    return transitionLearning(options, input, reply, (registry) =>
      registry.promote({
        id: input.id,
        promotedAt,
        promotedBy: input.context.actorId,
        rollbackRef: input.body.rollbackRef,
        signature: input.body.signature
      })
    );
  });

  app.post("/v1/learning-proposals/:id/rollback", async (request, reply) => {
    const input = parseLearningAction(request, reply, rollbackSchema, options);
    if (!input) return;
    const at = timestampOrNow(input.body.at, reply);
    if (!at) return;
    return transitionLearning(options, input, reply, (registry) =>
      registry.rollback({
        id: input.id,
        actor: input.context.actorId,
        at,
        reason: input.body.reason
      })
    );
  });

  app.post("/v1/maturity-report", async (request, reply) => {
    const body = parseInput(createMaturityReportSchema, request.body, reply);
    if (!body) return;
    const context = options.contextForRequest(request);
    if (!projectInScope(options.store, context, body.projectId)) return notFound(reply);
    const key = scopedEvidenceRecordKey(context.tenantId, body.projectId, body.id);
    if (options.store.maturityReports.has(key)) {
      return reply.code(409).send({ error: "maturity report id already exists" });
    }
    if (
      options.strictEnterpriseEvidence &&
      (body.measurement !== undefined || body.generatedAt !== undefined)
    ) {
      return reply.code(400).send({
        error: "enterprise maturity reports are server-aggregated; measurement and generatedAt are not accepted"
      });
    }
    if (!options.strictEnterpriseEvidence && body.measurement === undefined) {
      return reply.code(400).send({ error: "maturity measurement is required" });
    }
    const generatedAt = timestampOrNow(
      options.strictEnterpriseEvidence ? undefined : body.generatedAt,
      reply
    );
    if (!generatedAt) return;
    try {
      const aggregate = options.strictEnterpriseEvidence
        ? await aggregateEnterpriseMaturity({
            store: options.store,
            tenantId: context.tenantId,
            projectId: body.projectId,
            resolvers: requireEnterpriseResolvers(options)
          })
        : undefined;
      const report = buildMaturityReport(
        (aggregate?.measurement ?? body.measurement) as MaturityMeasurementInput
      );
      const record: MaturityReportRecord = Object.freeze({
        tenantId: context.tenantId,
        projectId: body.projectId,
        id: body.id,
        report,
        generatedAt,
        generatedBy: context.actorId,
        ...(aggregate ? { source: aggregate.source } : {})
      });
      options.store.maturityReports.set(key, record);
      return reply.code(201).send(record);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/v1/maturity-report", async (request, reply) => {
    const query = parseInput(maturityReportQuerySchema, request.query, reply);
    if (!query) return;
    const context = options.contextForRequest(request);
    if (!projectInScope(options.store, context, query.projectId)) return notFound(reply);
    try {
      const records = [...options.store.maturityReports.values()]
        .filter(
          (record) =>
            record.tenantId === context.tenantId &&
            record.projectId === query.projectId &&
            (query.id === undefined || record.id === query.id)
        )
        .sort(
          (left, right) =>
            left.generatedAt.localeCompare(right.generatedAt) || left.id.localeCompare(right.id)
        );
      records.forEach((record) => validateDigest(record.report, "maturity report"));
      if (query.id) return records[0] ?? notFound(reply);
      return { maturityReports: records };
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });
}

function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  reply: FastifyReply
): z.infer<T> | undefined {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  void reply.code(400).send({
    error: "invalid evidence request",
    details: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  });
  return undefined;
}

function projectInScope(
  store: MemoryStore,
  context: RequestContext,
  projectId: string
): boolean {
  const project = store.projects.get(projectId);
  if (!project || (project.tenantId ?? LOCAL_TENANT_ID) !== context.tenantId) return false;
  return (
    context.projectIds.length === 0 ||
    context.projectIds.includes(projectId) ||
    context.roles.includes("org_admin") ||
    context.roles.includes("governance_admin")
  );
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "resource not found" });
}

function sendDomainError(reply: FastifyReply, error: unknown) {
  if (error instanceof PersistedEvidenceError) {
    return reply.code(500).send({ error: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not trusted/u.test(message)) return reply.code(403).send({ error: message });
  if (
    /already exists|\bexists\b|expected revision|does not supersede|must be (?:draft|in_review|approved|canary_passed)|only promoted/u.test(
      message
    )
  ) {
    return reply.code(409).send({ error: message });
  }
  return reply.code(400).send({ error: message });
}

function timestampOrNow(value: string | undefined, reply: FastifyReply): string | undefined {
  const result = value ?? new Date().toISOString();
  if (isStrictTimestamp(result)) return result;
  void reply.code(400).send({ error: "timestamp must be strict RFC3339" });
  return undefined;
}

function scopedEvalRecords(
  store: MemoryStore,
  tenantId: string,
  projectId: string
): EvalAssetRecord[] {
  return [...store.evalAssets.values()]
    .filter((record) => record.tenantId === tenantId && record.projectId === projectId)
    .sort(
      (left, right) =>
        left.asset.id.localeCompare(right.asset.id) ||
        left.asset.revision - right.asset.revision
    );
}

function hydrateEvalAssets(
  store: MemoryStore,
  tenantId: string,
  projectId: string
): EvalAssetRegistry {
  const registry = new EvalAssetRegistry();
  for (const { asset } of scopedEvalRecords(store, tenantId, projectId)) {
    const { schemaVersion: _schemaVersion, digest: _digest, ...input } = asset;
    let restored: EvalAssetRevision;
    try {
      restored = registry.register(input);
    } catch (error) {
      throw new PersistedEvidenceError(
        `persisted eval asset history is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    assertCanonicalMatch(restored, asset, "eval asset");
  }
  return registry;
}

function scopedTraceGraphs(
  store: MemoryStore,
  tenantId: string,
  projectId: string
): TraceGraphRecord[] {
  return [...store.traceGraphs.values()]
    .filter((record) => record.tenantId === tenantId && record.projectId === projectId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function validateTraceGraphRecord(record: TraceGraphRecord): void {
  let graph: TraceGraph;
  try {
    graph = createTraceGraph({ nodes: record.graph.nodes, edges: record.graph.edges });
  } catch (error) {
    throw new PersistedEvidenceError(
      `persisted trace graph is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  assertCanonicalMatch(graph, record.graph, "trace graph");
  if (record.analysis) validateDigest(record.analysis, "trace analysis");
}

function saveLearningProposal(
  store: MemoryStore,
  context: RequestContext,
  projectId: string,
  proposal: LearningProposal
): void {
  const record: LearningProposalRecord = Object.freeze({
    tenantId: context.tenantId,
    projectId,
    proposal
  });
  store.learningProposals.set(
    scopedEvidenceRecordKey(context.tenantId, projectId, proposal.id, proposal.revision),
    record
  );
}

function scopedLearningHistory(
  store: MemoryStore,
  tenantId: string,
  projectId: string,
  id: string
): LearningProposal[] {
  return [...store.learningProposals.values()]
    .filter(
      (record) =>
        record.tenantId === tenantId &&
        record.projectId === projectId &&
        record.proposal.id === id
    )
    .map((record) => record.proposal)
    .sort((left, right) => left.revision - right.revision);
}

function hydrateLearningProposals(
  store: MemoryStore,
  tenantId: string,
  projectId: string,
  id: string,
  verifySignature?: LearningProposalRegistryOptions["verifySignature"]
): LearningProposalRegistry | undefined {
  const history = scopedLearningHistory(store, tenantId, projectId, id);
  if (history.length === 0) return undefined;
  const registry = new LearningProposalRegistry({
    ...(verifySignature ? { verifySignature } : {})
  });
  const first = history[0]!;
  const restoredFirst = registry.create(createInputFromProposal(first));
  assertCanonicalMatch(restoredFirst, first, "learning proposal");
  for (const expected of history.slice(1)) {
    const current = registry.get(id)!;
    let restored: LearningProposal;
    try {
      restored = replayLearningTransition(registry, current, expected);
    } catch (error) {
      throw new PersistedEvidenceError(
        `persisted learning proposal history is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    assertCanonicalMatch(restored, expected, "learning proposal");
  }
  return registry;
}

function replayLearningTransition(
  registry: LearningProposalRegistry,
  current: LearningProposal,
  expected: LearningProposal
): LearningProposal {
  if (expected.revision !== current.revision + 1) {
    throw new Error(`expected revision ${current.revision + 1}`);
  }
  if (expected.status === "in_review" && expected.review) {
    return registry.submit(expected.id, expected.review.actor, expected.review.decidedAt);
  }
  if (
    (expected.status === "approved" ||
      (expected.status === "rejected" && current.status === "in_review")) &&
    expected.review
  ) {
    return registry.review({
      id: expected.id,
      approved: expected.status === "approved",
      actor: expected.review.actor,
      decidedAt: expected.review.decidedAt,
      reason: expected.review.reason
    });
  }
  if (
    (expected.status === "canary_passed" ||
      (expected.status === "rejected" && current.status === "approved")) &&
    expected.canary
  ) {
    return registry.recordCanary({
      id: expected.id,
      passed: expected.status === "canary_passed",
      environment: expected.canary.environment,
      evidenceDigest: expected.canary.evidenceDigest,
      completedAt: expected.canary.completedAt,
      completedBy: expected.canary.completedBy
    });
  }
  if (expected.status === "promoted" && expected.promotion) {
    return registry.promote({
      id: expected.id,
      promotedAt: expected.promotion.promotedAt,
      promotedBy: expected.promotion.promotedBy,
      rollbackRef: expected.promotion.rollbackRef,
      signature: expected.promotion.signature
    });
  }
  if (expected.status === "rolled_back" && expected.review && expected.rollbackReason) {
    return registry.rollback({
      id: expected.id,
      actor: expected.review.actor,
      at: expected.review.decidedAt,
      reason: expected.rollbackReason
    });
  }
  throw new Error(`unsupported transition ${current.status}->${expected.status}`);
}

function createInputFromProposal(proposal: LearningProposal): CreateLearningProposalInput {
  return {
    id: proposal.id,
    kind: proposal.kind,
    title: proposal.title,
    rationale: proposal.rationale,
    sourceRunId: proposal.sourceRunId,
    sourceEvidenceIds: proposal.sourceEvidenceIds,
    targetRef: proposal.targetRef,
    changeDigest: proposal.changeDigest,
    createdAt: proposal.createdAt,
    createdBy: proposal.createdBy
  };
}

function latestLearningProposals(
  store: MemoryStore,
  tenantId: string,
  projectId: string,
  verifySignature?: LearningProposalRegistryOptions["verifySignature"]
): LearningProposal[] {
  const ids = [...new Set(
    [...store.learningProposals.values()]
      .filter((record) => record.tenantId === tenantId && record.projectId === projectId)
      .map((record) => record.proposal.id)
  )].sort();
  return ids.map((id) => hydrateLearningProposals(
    store,
    tenantId,
    projectId,
    id,
    verifySignature
  )!.get(id)!);
}

function parseLearningAction<T extends z.ZodTypeAny>(
  request: FastifyRequest,
  reply: FastifyReply,
  schema: T,
  options: EvidenceRouteOptions
): {
  id: string;
  body: z.infer<T>;
  context: RequestContext;
} | undefined {
  const params = parseInput(resourceParamsSchema, request.params, reply);
  const body = parseInput(schema, request.body, reply);
  if (!params || !body) return undefined;
  const context = options.contextForRequest(request);
  if (!projectInScope(options.store, context, body.projectId)) {
    notFound(reply);
    return undefined;
  }
  return { id: params.id, body, context };
}

function transitionLearning<T extends { projectId: string }>(
  options: EvidenceRouteOptions,
  input: { id: string; body: T; context: RequestContext },
  reply: FastifyReply,
  transition: (registry: LearningProposalRegistry) => LearningProposal
) {
  try {
    const registry = hydrateLearningProposals(
      options.store,
      input.context.tenantId,
      input.body.projectId,
      input.id,
      options.verifyLearningProposalSignature
    );
    if (!registry) return notFound(reply);
    const proposal = transition(registry);
    saveLearningProposal(options.store, input.context, input.body.projectId, proposal);
    return proposal;
  } catch (error) {
    return sendDomainError(reply, error);
  }
}

function assertCanonicalMatch(actual: unknown, expected: unknown, kind: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new PersistedEvidenceError(`persisted ${kind} digest or content mismatch`);
  }
}

function validateDigest(value: { readonly digest: string }, kind: string): void {
  const { digest, ...semantic } = value;
  const actual = createHash("sha256").update(canonicalJson(semantic), "utf8").digest("hex");
  if (digest !== actual) throw new PersistedEvidenceError(`persisted ${kind} digest mismatch`);
}
