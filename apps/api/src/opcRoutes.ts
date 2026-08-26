// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  VISIT_ASSISTANT_PACK_V1,
  createBusinessRecord,
  createCustomerCommitment,
  createPublicationEnvelope,
  createSettlementRecord,
  reviseBusinessRecord,
  verifyBusinessRecord,
  type BusinessRecordEnvelopeV1,
  type CustomerCommitmentV1
} from "@mn/opc";
import {
  OpcIdempotencyConflictError,
  OpcRevisionConflictError,
  type OpcAggregateKind,
  type OpcAppendStore,
  type OpcStoredEntry
} from "@mn/opc-store";
import {
  appendOperationEvent,
  createAuthorityDecision,
  createOperationRun,
  sortAttentionItems,
  type ActionIntentV1,
  type AttentionItemV1,
  type AuthorityDecisionV1,
  type OperationEventV1,
  type OperationRunV1,
  type SubjectRefV1
} from "@mn/operations";
import { sha256Digest, type SpecJsonValue } from "@mn/specs";

export interface OpcRequestContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly roles: readonly string[];
}

export interface OpcRouteOptions {
  readonly store: OpcAppendStore;
  readonly contextForRequest: (request: FastifyRequest) => OpcRequestContext;
}

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: false });
const writeFields = {
  requestId: identifier,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
} as const;
const versionedRef = z.object({ id: identifier, version: identifier, digest }).strict();
const subjectRef = z.object({ kind: identifier, id: identifier, digest }).strict();
const runFields = {
  id: identifier,
  specRef: versionedRef,
  governanceDigest: digest,
  harnessDigest: digest,
  domainModuleRef: versionedRef,
  workflowRef: versionedRef,
  currentStage: identifier,
  budgetUsage: z.record(z.number().nonnegative().finite()).optional(),
  createdAt: timestamp
} as const;
const recordCreateSchema = z.object({
  ...writeFields,
  id: identifier,
  kind: identifier,
  status: z.enum(["proposed", "verified", "superseded", "void"]),
  payload: z.unknown(),
  createdAt: timestamp
}).strict();
const recordRevisionSchema = z.object({
  ...writeFields,
  status: z.enum(["proposed", "verified", "superseded", "void"]),
  payload: z.unknown(),
  createdAt: timestamp
}).strict();
const commitmentApprovalSchema = z.object({
  ...writeFields,
  approvedAt: timestamp
}).strict();
const commitmentRunSchema = z.object({ ...writeFields, ...runFields }).strict();
const domainRunSchema = z.object({
  ...writeFields,
  ...runFields,
  domainId: identifier,
  subjectRefs: z.array(subjectRef).min(1)
}).strict();
const decisionSchema = z.object({
  ...writeFields,
  decision: z.enum(["approve", "reject", "request_changes", "defer"]),
  actorRole: identifier,
  decidedAt: timestamp,
  deferUntil: timestamp.optional()
}).strict();
const attentionQuerySchema = z.object({ now: timestamp.optional() }).strict();
const moneySchema = z.object({ currency: z.string().regex(/^[A-Z]{3}$/u), minorUnits: z.string() }).strict();
const settlementSchema = z.object({
  ...writeFields,
  id: identifier,
  commitmentRef: identifier,
  contracted: moneySchema.optional(),
  invoiced: moneySchema.optional(),
  received: moneySchema.optional(),
  modelCost: moneySchema.optional(),
  externalCost: moneySchema.optional(),
  humanMinutes: z.number().int().nonnegative(),
  sourceRefs: z.array(identifier).min(1),
  recordedAt: timestamp
}).strict();
const publicationSchema = z.object({
  ...writeFields,
  id: identifier,
  sourceRecordId: identifier,
  targetTenantId: identifier,
  purpose: z.string().min(1).max(4_096),
  allowedFields: z.array(identifier).min(1),
  retentionUntil: timestamp,
  idempotencyKey: identifier,
  createdAt: timestamp
}).strict();
const businessPackEnableSchema = z.object({
  ...writeFields,
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  enabled: z.boolean(),
  createdAt: timestamp
}).strict();
const acceptanceSchema = z.object({
  ...writeFields,
  status: z.enum(["accepted", "rejected", "changes_requested"]),
  evidenceRefs: z.array(identifier).min(1),
  note: z.string().max(4_096).optional(),
  decidedAt: timestamp
}).strict();

function json(value: unknown): SpecJsonValue {
  return JSON.parse(JSON.stringify(value)) as SpecJsonValue;
}

function requestContext(request: FastifyRequest, options: OpcRouteOptions): OpcRequestContext {
  const context = options.contextForRequest(request);
  if (
    !identifier.safeParse(context.tenantId).success ||
    !identifier.safeParse(context.actorId).success ||
    context.roles.length === 0 ||
    context.roles.some((role) => !identifier.safeParse(role).success)
  ) {
    throw new TypeError("authenticated OPC request context is invalid");
  }
  return context;
}

function requireAnyRole(
  context: OpcRequestContext,
  allowed: ReadonlySet<string>,
  reply: FastifyReply
): boolean {
  if (context.roles.some((role) => allowed.has(role))) return true;
  reply.code(403).send({ code: "POLICY_DENIED", error: "authenticated role cannot perform this OPC operation" });
  return false;
}

const OPERATION_ROLES = new Set(["org_admin", "project_owner", "developer"]);
const DECISION_ROLES = new Set(["org_admin", "project_owner", "reviewer", "governance_admin"]);
const EXTENSION_ROLES = new Set(["org_admin", "governance_admin"]);

function body<S extends z.ZodTypeAny>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  reply.code(400).send({
    code: "INVALID_REQUEST",
    error: "request body does not match the OPC contract",
    issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))
  });
  return undefined;
}

function query<S extends z.ZodTypeAny>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  reply.code(400).send({ code: "INVALID_REQUEST", error: "query does not match the OPC contract" });
  return undefined;
}

async function handled<T>(reply: FastifyReply, callback: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof OpcRevisionConflictError) {
      return reply.code(409).send({
        code: error.code,
        error: error.message,
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision
      });
    }
    if (error instanceof OpcIdempotencyConflictError) {
      return reply.code(409).send({ code: error.code, error: error.message });
    }
    if (error instanceof TypeError) {
      return reply.code(400).send({ code: "INVALID_REQUEST", error: error.message });
    }
    return reply.code(409).send({
      code: "POLICY_DENIED",
      error: error instanceof Error ? error.message : "OPC request failed"
    });
  }
}

async function required<T extends SpecJsonValue>(
  store: OpcAppendStore,
  tenantId: string,
  kind: OpcAggregateKind,
  id: string,
  reply: FastifyReply
): Promise<OpcStoredEntry<T> | undefined> {
  const entry = await store.read<T>(tenantId, kind, id);
  if (entry === undefined) reply.code(404).send({ code: "NOT_FOUND", error: `${kind} ${id} not found` });
  return entry;
}

async function appendRun(
  store: OpcAppendStore,
  tenantId: string,
  input: z.infer<typeof commitmentRunSchema> | z.infer<typeof domainRunSchema>,
  domainId: string,
  subjectRefs: readonly SubjectRefV1[]
): Promise<OpcStoredEntry> {
  const run = createOperationRun({
    id: input.id,
    tenantId,
    domainId,
    subjectRefs,
    specRef: input.specRef,
    governanceDigest: input.governanceDigest,
    harnessDigest: input.harnessDigest,
    domainModuleRef: input.domainModuleRef,
    workflowRef: input.workflowRef,
    currentStage: input.currentStage,
    ...(input.budgetUsage === undefined ? {} : { budgetUsage: input.budgetUsage }),
    createdAt: input.createdAt
  });
  const initialEventDigest = sha256Digest({ runId: run.id, ordinal: 1 });
  const initialEvent = appendOperationEvent(undefined, {
    id: `operationEvent.${initialEventDigest}`,
    tenantId,
    runId: run.id,
    kind: "source_captured",
    actor: "operation.compiler",
    sourceRefs: run.subjectRefs.map((ref) => ref.digest),
    payloadRef: `operation:${run.id}`,
    createdAt: input.createdAt
  });
  const stored = await store.appendBatch([
    {
      tenantId,
      kind: "operation_run",
      id: run.id,
      expectedRevision: input.expectedRevision,
      requestId: input.requestId,
      value: json(run),
      createdAt: input.createdAt
    },
    {
      tenantId,
      kind: "operation_event",
      id: run.id,
      expectedRevision: 0,
      requestId: `operationEvent.${sha256Digest({ requestId: input.requestId })}`,
      value: json(initialEvent),
      createdAt: input.createdAt
    }
  ]);
  return stored[0]!;
}

export function registerOpcRoutes(app: FastifyInstance, options: OpcRouteOptions): void {
  app.get("/v1/domains", async (request) => {
    requestContext(request, options);
    return {
      domains: [
        { id: "coding", trustClass: "official-domain", status: "available", runProjection: "RunRecord" },
        { id: "opc", trustClass: "official-domain", status: "available", runProjection: "OperationRunV1" }
      ]
    };
  });

  app.post("/v1/domain-runs", async (request, reply) => {
    const input = body(domainRunSchema, request.body, reply);
    if (input === undefined) return reply;
    const context = requestContext(request, options);
    if (!requireAnyRole(context, OPERATION_ROLES, reply)) return reply;
    return handled(reply, async () => {
      const existing = await options.store.read(context.tenantId, "operation_run", input.id);
      const stored = await appendRun(options.store, context.tenantId, input, input.domainId, input.subjectRefs);
      return reply.code(existing === undefined ? 201 : 200).send(stored);
    });
  });

  app.get("/v1/domain-runs/:id", async (request, reply) => {
    const context = requestContext(request, options);
    const id = identifier.parse((request.params as { id: string }).id);
    const entry = await required<SpecJsonValue>(options.store, context.tenantId, "operation_run", id, reply);
    return entry === undefined ? reply : entry.value;
  });

  app.get("/v1/domain-runs/:id/events", async (request, reply) => {
    const context = requestContext(request, options);
    const id = identifier.parse((request.params as { id: string }).id);
    const run = await required(options.store, context.tenantId, "operation_run", id, reply);
    if (run === undefined) return reply;
    const events = await options.store.history<SpecJsonValue>(context.tenantId, "operation_event", id);
    return { events: events.map((entry) => entry.value) };
  });

  app.post("/v1/opc-records", async (request, reply) => {
    const input = body(recordCreateSchema, request.body, reply);
    if (input === undefined) return reply;
    const context = requestContext(request, options);
    if (!requireAnyRole(context, OPERATION_ROLES, reply)) return reply;
    return handled(reply, async () => {
      const existing = await options.store.read(context.tenantId, "record", input.id);
      const record = createBusinessRecord({
        tenantId: context.tenantId,
        kind: input.kind,
        id: input.id,
        status: input.status,
        payload: json(input.payload),
        createdAt: input.createdAt,
        createdBy: context.actorId
      });
      const stored = await options.store.append({
        tenantId: context.tenantId,
        kind: "record",
        id: record.id,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        value: json(record),
        createdAt: input.createdAt
      });
      return reply.code(existing === undefined ? 201 : 200).send(stored);
    });
  });

  app.post("/v1/opc-records/:id/revisions", async (request, reply) => {
    const input = body(recordRevisionSchema, request.body, reply);
    if (input === undefined) return reply;
    const context = requestContext(request, options);
    if (!requireAnyRole(context, OPERATION_ROLES, reply)) return reply;
    const id = identifier.parse((request.params as { id: string }).id);
    return handled(reply, async () => {
      const previous = await required<SpecJsonValue>(options.store, context.tenantId, "record", id, reply);
      if (previous === undefined) return reply;
      const record = reviseBusinessRecord(previous.value as unknown as BusinessRecordEnvelopeV1, {
        status: input.status,
        payload: json(input.payload),
        createdAt: input.createdAt,
        createdBy: context.actorId
      });
      const stored = await options.store.append({
        tenantId: context.tenantId,
        kind: "record",
        id,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        value: json(record),
        createdAt: input.createdAt
      });
      return reply.code(201).send(stored);
    });
  });

  app.post("/v1/opc-commitments/:id/approve", async (request, reply) => {
    const input = body(commitmentApprovalSchema, request.body, reply);
    if (input === undefined) return reply;
    const context = requestContext(request, options);
    if (!requireAnyRole(context, DECISION_ROLES, reply)) return reply;
    const id = identifier.parse((request.params as { id: string }).id);
    return handled(reply, async () => {
      const previous = await required<SpecJsonValue>(options.store, context.tenantId, "record", id, reply);
      if (previous === undefined) return reply;
      const record = previous.value as unknown as BusinessRecordEnvelopeV1;
      if (record.kind !== "customer_commitment" || !verifyBusinessRecord(record)) {
        throw new Error("customer commitment record is invalid");
      }
      const payload = createCustomerCommitment(record.payload as unknown as CustomerCommitmentV1);
      const approved = reviseBusinessRecord(record, {
        status: "verified",
        payload: json(payload),
        createdAt: input.approvedAt,
        createdBy: context.actorId
      });
      const stored = await options.store.append({
        tenantId: context.tenantId,
        kind: "record",
        id,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        value: json(approved),
        createdAt: input.approvedAt
      });
      return reply.code(201).send(stored);
    });
  });

  app.post("/v1/opc-commitments/:id/runs", async (request, reply) => {
    const input = body(commitmentRunSchema, request.body, reply);
    if (input === undefined) return reply;
    const context = requestContext(request, options);
    if (!requireAnyRole(context, OPERATION_ROLES, reply)) return reply;
    const commitmentId = identifier.parse((request.params as { id: string }).id);
    return handled(reply, async () => {
      const commitment = await required<SpecJsonValue>(options.store, context.tenantId, "record", commitmentId, reply);
      if (commitment === undefined) return reply;
      const record = commitment.value as unknown as BusinessRecordEnvelopeV1;
      if (record.kind !== "customer_commitment" || record.status !== "verified" || !verifyBusinessRecord(record)) {
        throw new Error("only a verified customer commitment can create an operation run");
      }
      const existing = await options.store.read(context.tenantId, "operation_run", input.id);
      const stored = await appendRun(options.store, context.tenantId, input, "opc", [{
        kind: "customer_commitment",
        id: commitmentId,
        digest: record.digest
      }]);
      return reply.code(existing === undefined ? 201 : 200).send(stored);
    });
  });

  app.get("/v1/attention-items", async (request, reply) => {
    const input = query(attentionQuerySchema, request.query, reply);
    if (input === undefined) return reply;
    const context = requestContext(request, options);
    const entries = await options.store.list<SpecJsonValue>(context.tenantId, "attention_item");
    const items = entries.map((entry) => entry.value as unknown as AttentionItemV1)
      .filter((item) => item.status === "pending" || item.status === "in_progress");
    return { items: sortAttentionItems(items, input.now ?? new Date().toISOString()) };
  });

  const decide = async (
    request: FastifyRequest,
    reply: FastifyReply,
    actionId: string,
    aggregateId: string,
    decisionIdPrefix: string
  ) => {
    const input = body(decisionSchema, request.body, reply);
    if (input === undefined) return reply;
    const context = requestContext(request, options);
    if (!requireAnyRole(context, DECISION_ROLES, reply)) return reply;
    if (!context.roles.includes(input.actorRole)) {
      return reply.code(403).send({ code: "POLICY_DENIED", error: "actorRole is not bound to the authenticated principal" });
    }
    return handled(reply, async () => {
      const actionEntry = await required<SpecJsonValue>(options.store, context.tenantId, "action_intent", actionId, reply);
      if (actionEntry === undefined) return reply;
      const action = actionEntry.value as unknown as ActionIntentV1;
      if (action.tenantId !== context.tenantId) throw new Error("action intent tenant does not match authentication");
      const decision = createAuthorityDecision(action, {
        id: `${decisionIdPrefix}.${input.requestId}`,
        decision: input.decision,
        actor: context.actorId,
        actorRole: input.actorRole,
        decidedAt: input.decidedAt,
        ...(input.deferUntil === undefined ? {} : { deferUntil: input.deferUntil })
      });
      const stored = await options.store.append({
        tenantId: context.tenantId,
        kind: "authority_decision",
        id: aggregateId,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        value: json(decision),
        createdAt: input.decidedAt
      });
      return reply.code(201).send(stored);
    });
  };

  app.post("/v1/action-intents/:id/decide", async (request, reply) => {
    const id = identifier.parse((request.params as { id: string }).id);
    return decide(request, reply, id, id, "authority");
  });

  app.post("/v1/attention-items/:id/decide", async (request, reply) => {
    const context = requestContext(request, options);
    const id = identifier.parse((request.params as { id: string }).id);
    const attention = await required<SpecJsonValue>(options.store, context.tenantId, "attention_item", id, reply);
    if (attention === undefined) return reply;
    const item = attention.value as unknown as AttentionItemV1;
    if (item.sourceKind !== "approval") {
      return reply.code(409).send({ code: "POLICY_DENIED", error: "attention item is not an action approval" });
    }
    const decisionInput = decisionSchema.safeParse(request.body);
    if (
      decisionInput.success &&
      !context.roles.includes("org_admin") &&
      !item.eligibleRoles.includes(decisionInput.data.actorRole)
    ) {
      return reply.code(403).send({ code: "POLICY_DENIED", error: "authenticated role is not eligible for this attention item" });
    }
    return decide(request, reply, item.sourceId, id, "attentionAuthority");
  });

  app.post("/v1/opc-deliveries/:id/acceptances", async (request, reply) => {
    const input = body(acceptanceSchema, request.body, reply);
    if (input === undefined) return reply;
    const context = requestContext(request, options);
    if (!requireAnyRole(context, DECISION_ROLES, reply)) return reply;
    const deliveryId = identifier.parse((request.params as { id: string }).id);
    return handled(reply, async () => {
      const recordId = `${deliveryId}.acceptance`;
      const previous = await options.store.read<SpecJsonValue>(context.tenantId, "record", recordId);
      const payload = json({
        deliveryId,
        status: input.status,
        evidenceRefs: input.evidenceRefs,
        ...(input.note === undefined ? {} : { note: input.note }),
        decidedAt: input.decidedAt,
        decidedBy: context.actorId
      });
      const record = previous === undefined
        ? createBusinessRecord({
            tenantId: context.tenantId,
            kind: "delivery_acceptance",
            id: recordId,
            status: "verified",
            payload,
            createdAt: input.decidedAt,
            createdBy: context.actorId
          })
        : reviseBusinessRecord(previous.value as unknown as BusinessRecordEnvelopeV1, {
            status: "verified",
            payload,
            createdAt: input.decidedAt,
            createdBy: context.actorId
          });
      const stored = await options.store.append({
        tenantId: context.tenantId,
        kind: "record",
        id: recordId,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        value: json(record),
        createdAt: input.decidedAt
      });
      return reply.code(201).send(stored);
    });
  });

  app.post("/v1/opc-settlements", async (request, reply) => {
    const input = body(settlementSchema, request.body, reply);
    if (input === undefined) return reply;
    const context = requestContext(request, options);
    if (!requireAnyRole(context, OPERATION_ROLES, reply)) return reply;
    return handled(reply, async () => {
      const settlement = createSettlementRecord({
        id: input.id,
        commitmentRef: input.commitmentRef,
        ...(input.contracted === undefined ? {} : { contracted: input.contracted }),
        ...(input.invoiced === undefined ? {} : { invoiced: input.invoiced }),
        ...(input.received === undefined ? {} : { received: input.received }),
        ...(input.modelCost === undefined ? {} : { modelCost: input.modelCost }),
        ...(input.externalCost === undefined ? {} : { externalCost: input.externalCost }),
        humanMinutes: input.humanMinutes,
        sourceRefs: input.sourceRefs,
        recordedAt: input.recordedAt,
        recordedBy: context.actorId
      });
      const stored = await options.store.append({
        tenantId: context.tenantId,
        kind: "settlement_record",
        id: settlement.id,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        value: json(settlement),
        createdAt: input.recordedAt
      });
      return reply.code(201).send(stored);
    });
  });

  app.get("/v1/domain-runs/:id/evidence-export", async (request, reply) => {
    const context = requestContext(request, options);
    const id = identifier.parse((request.params as { id: string }).id);
    const runEntry = await required<SpecJsonValue>(options.store, context.tenantId, "operation_run", id, reply);
    if (runEntry === undefined) return reply;
    const run = runEntry.value as unknown as OperationRunV1;
    const events = (await options.store.history<SpecJsonValue>(context.tenantId, "operation_event", id))
      .map((entry) => entry.value as unknown as OperationEventV1);
    const actionEntries = await options.store.list<SpecJsonValue>(context.tenantId, "action_intent");
    const actions = actionEntries.map((entry) => entry.value as unknown as ActionIntentV1)
      .filter((action) => action.runId === id);
    const decisionEntries = await options.store.list<SpecJsonValue>(context.tenantId, "authority_decision");
    const actionIds = new Set(actions.map((action) => action.id));
    const decisions = decisionEntries.map((entry) => entry.value as unknown as AuthorityDecisionV1)
      .filter((decision) => actionIds.has(decision.actionId));
    const semantic = { schemaVersion: 1, tenantId: context.tenantId, run, events, actions, decisions };
    return { ...semantic, digest: sha256Digest(semantic) };
  });

  app.get("/v1/business-packs", async (request) => {
    const context = requestContext(request, options);
    const bindings = await options.store.list<SpecJsonValue>(context.tenantId, "business_pack_binding");
    return { businessPacks: [VISIT_ASSISTANT_PACK_V1], bindings: bindings.map((entry) => entry.value) };
  });

  app.post("/v1/business-packs/:id/enable", async (request, reply) => {
    const input = body(businessPackEnableSchema, request.body, reply);
    if (input === undefined) return reply;
    const context = requestContext(request, options);
    if (!requireAnyRole(context, EXTENSION_ROLES, reply)) return reply;
    const id = identifier.parse((request.params as { id: string }).id);
    return handled(reply, async () => {
      if (id !== VISIT_ASSISTANT_PACK_V1.id || input.version !== VISIT_ASSISTANT_PACK_V1.version) {
        return reply.code(503).send({ code: "DOMAIN_MODULE_UNAVAILABLE", error: "business pack is unavailable" });
      }
      const stored = await options.store.append({
        tenantId: context.tenantId,
        kind: "business_pack_binding",
        id,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        value: json({ id, version: input.version, enabled: input.enabled, changedBy: context.actorId }),
        createdAt: input.createdAt
      });
      return reply.code(201).send(stored);
    });
  });

  app.post("/v1/publications", async (request, reply) => {
    const input = body(publicationSchema, request.body, reply);
    if (input === undefined) return reply;
    const context = requestContext(request, options);
    if (!requireAnyRole(context, OPERATION_ROLES, reply)) return reply;
    return handled(reply, async () => {
      const source = await required<SpecJsonValue>(options.store, context.tenantId, "record", input.sourceRecordId, reply);
      if (source === undefined) return reply;
      const publication = createPublicationEnvelope(
        source.value as unknown as BusinessRecordEnvelopeV1,
        {
          id: input.id,
          targetTenantId: input.targetTenantId,
          purpose: input.purpose,
          allowedFields: input.allowedFields,
          retentionUntil: input.retentionUntil,
          idempotencyKey: input.idempotencyKey,
          createdAt: input.createdAt,
          createdBy: context.actorId
        }
      );
      const stored = await options.store.append({
        tenantId: context.tenantId,
        kind: "publication_outbox",
        id: publication.id,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        value: json(publication),
        createdAt: input.createdAt
      });
      return reply.code(201).send(stored);
    });
  });

  app.get("/v1/publication-receipts", async (request) => {
    const context = requestContext(request, options);
    const receipts = await options.store.list<SpecJsonValue>(context.tenantId, "publication_receipt");
    return { receipts: receipts.map((entry) => entry.value) };
  });
}
