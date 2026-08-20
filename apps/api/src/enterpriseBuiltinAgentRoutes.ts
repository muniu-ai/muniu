// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createSafeDeterministicPublicControlIdV1 } from "@mn/agent-protocol";

import {
  executionTargets,
  type AgentExecutionBindingV1,
  type AgentTask,
  type EnterpriseBuiltinExecutionStartV1,
  type EnterpriseBuiltinToolResultV1,
  type RequestContext,
  type RunRecord
} from "@mn/core";
import type { SandboxExecutionEvidence, SandboxLeaseAttestation } from "@mn/harness";
import { sha256Canonical } from "@mn/governance";
import type { ProviderRecord } from "@mn/provider-catalog";
import type { FileLocalStore } from "@mn/store";

import type { LocalMockAgentSessionService } from "./agentSessionService.js";
import {
  EnterpriseBuiltinAgentBroker,
  type EnterpriseBuiltinExecutionIdentity
} from "./enterpriseBuiltinAgentBroker.js";
import type {
  EnterpriseClaimSnapshot,
  EnterprisePostgresRuntime
} from "./enterprisePostgres.js";
import { executionStateFromEnterpriseClaim } from "./enterpriseClaimState.js";
import {
  sandboxExecutionMatchesAttestation,
  verifySandboxRuntimeProof
} from "./sandboxRuntimeProof.js";
import { verifySandboxAttestation } from "./sandboxAttestation.js";
import type { MemoryStore } from "./store.js";

const safeId = z.string().min(1).max(512).refine(
  (value) => value === value.trim() && !/[\0\r\n]/u.test(value),
  "must be a safe identifier"
);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const claimSchema = z.object({
  ownerId: safeId,
  claimToken: safeId
}).strict();
const executionBindingSchema = z.object({
  schemaVersion: z.literal(1),
  runId: safeId,
  candidateId: safeId,
  sessionId: safeId,
  runtimeId: z.literal("builtin"),
  providerId: safeId.optional(),
  modelId: safeId.optional(),
  harnessDigest: digest,
  governanceDigest: digest,
  effectPolicyDigest: digest,
  sandboxCapabilityId: safeId
}).strict();
const executionStartSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: safeId,
  runId: safeId,
  candidateId: safeId,
  workspacePath: z.string().min(1).max(4_096),
  prompt: z.string().min(1).max(1_000_000),
  providerId: safeId,
  modelId: safeId,
  timeoutSeconds: z.number().int().min(1).max(7_200),
  executionBinding: executionBindingSchema,
  sandboxAttestation: z.unknown().refine((value) => value !== undefined),
  sandboxExecution: z.unknown().refine((value) => value !== undefined)
}).strict();
const startSchema = claimSchema.extend({ execution: executionStartSchema }).strict();
const pollSchema = claimSchema.extend({
  afterRevision: z.number().int().min(-1).default(-1),
  waitMs: z.number().int().min(0).max(10_000).default(10_000)
}).strict();
const toolResultSchema = z.object({
  schemaVersion: z.literal(1),
  callId: safeId,
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().max(4_096).optional()
}).strict().superRefine((value, context) => {
  if (value.ok && value.result === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "successful result is required" });
  }
  if (!value.ok && !value.error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "failure error is required" });
  }
});
const submitSchema = claimSchema.extend({ result: toolResultSchema }).strict();
const paramsSchema = z.object({ id: safeId, executionId: safeId.optional() }).strict();

export interface EnterpriseBuiltinAgentRouteOptions {
  readonly runtimeProfile: "local" | "enterprise";
  readonly postgres?: Pick<EnterprisePostgresRuntime, "inspectClaim">;
  readonly signingKey?: string;
  readonly store: Pick<MemoryStore, "projects" | "tasks" | "runs">;
  readonly providerStore: Pick<FileLocalStore, "listProviders">;
  readonly broker: EnterpriseBuiltinAgentBroker;
  readonly requestContext: (request: FastifyRequest) => RequestContext | undefined;
  readonly getAgentSessionService?: (
    request: FastifyRequest
  ) => Promise<LocalMockAgentSessionService>;
}

export function registerEnterpriseBuiltinAgentRoutes(
  app: FastifyInstance,
  options: EnterpriseBuiltinAgentRouteOptions
): void {
  app.post("/v1/run-jobs/queue/:id/builtin-executions", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const parsed = startSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const authority = authorityForRequest(request, reply, options);
    if (!authority) return;
    const { id } = params.data;
    if (parsed.data.execution.runId !== id) return conflict(reply, "run binding is invalid");
    const active = await inspectActiveClaim(options, authority.context, id, parsed.data);
    if (!active) return conflict(reply, "run job claim is not active");
    let validation: ReturnType<typeof validateExecutionStart>;
    try {
      validation = validateExecutionStart({
        request: parsed.data.execution as EnterpriseBuiltinExecutionStartV1,
        active,
        context: authority.context,
        signingKey: authority.signingKey,
        store: options.store
      });
    } catch {
      return conflict(reply, "candidate execution proof is malformed");
    }
    if (typeof validation === "string") return conflict(reply, validation);
    const provider = await resolveProvider(
      options.providerStore,
      authority.context,
      validation.run.projectId,
      validation.target.providerId,
      validation.target.modelId
    );
    if (typeof provider === "string") return conflict(reply, provider);
    const service = await authority.getAgentSessionService(request);
    const stillActive = await inspectActiveClaim(options, authority.context, id, parsed.data);
    if (!stillActive || stillActive.item.claimTokenHash !== active.item.claimTokenHash) {
      return conflict(reply, "run job claim changed during Agent preparation");
    }
    const executionBinding: AgentExecutionBindingV1 = Object.freeze({
      ...validation.request.executionBinding,
      providerId: provider.provider.id,
      modelId: provider.modelId
    });
    try {
      const view = await options.broker.start({
        tenantId: authority.context.tenantId,
        workerId: parsed.data.ownerId,
        claimDigest: active.item.claimTokenHash!,
        request: {
          ...validation.request,
          providerId: provider.provider.id,
          modelId: provider.modelId,
          executionBinding
        },
        providerId: provider.provider.id,
        modelId: provider.modelId,
        executionBinding,
        humanApproval: validation.task.strategy.humanApproval,
        execute: (input, signal) => service.executeCandidate({
          sessionId: input.sessionId,
          runId: input.runId,
          candidateId: input.candidateId,
          cwd: input.workspacePath,
          prompt: input.prompt,
          providerId: provider.provider.id,
          modelId: provider.modelId,
          timeoutSeconds: input.timeoutSeconds,
          executionBinding,
          recoverExistingSession: true,
          signal
        })
      });
      return reply.code(202).send(view);
    } catch {
      return conflict(reply, "enterprise builtin execution could not be started");
    }
  });

  app.post(
    "/v1/run-jobs/queue/:id/builtin-executions/:executionId/poll",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const parsed = pollSchema.safeParse(request.body);
      if (!params.success || !params.data.executionId || !parsed.success) return invalid(reply);
      const authority = authorityForRequest(request, reply, options);
      if (!authority) return;
      const active = await inspectActiveClaim(options, authority.context, params.data.id, parsed.data);
      if (!active?.item.claimTokenHash) return conflict(reply, "run job claim is not active");
      const identity = executionIdentity(authority.context, parsed.data.ownerId, active);
      try {
        const view = await options.broker.poll(
          params.data.executionId,
          identity,
          parsed.data.afterRevision,
          parsed.data.waitMs
        );
        const stillActive = await inspectActiveClaim(
          options,
          authority.context,
          params.data.id,
          parsed.data
        );
        if (!stillActive || stillActive.item.claimTokenHash !== active.item.claimTokenHash) {
          await options.broker.cancel(params.data.executionId, identity);
          return conflict(reply, "run job claim changed during Agent poll");
        }
        return reply.send(view);
      } catch {
        return conflict(reply, "enterprise builtin execution is unavailable");
      }
    }
  );

  app.post(
    "/v1/run-jobs/queue/:id/builtin-executions/:executionId/tool-results",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const parsed = submitSchema.safeParse(request.body);
      if (!params.success || !params.data.executionId || !parsed.success) return invalid(reply);
      const authority = authorityForRequest(request, reply, options);
      if (!authority) return;
      const active = await inspectActiveClaim(options, authority.context, params.data.id, parsed.data);
      if (!active?.item.claimTokenHash) return conflict(reply, "run job claim is not active");
      try {
        return reply.send(await options.broker.submitToolResult(
          params.data.executionId,
          executionIdentity(authority.context, parsed.data.ownerId, active),
          parsed.data.result as EnterpriseBuiltinToolResultV1
        ));
      } catch {
        return conflict(reply, "enterprise builtin tool result was not accepted");
      }
    }
  );

  app.post(
    "/v1/run-jobs/queue/:id/builtin-executions/:executionId/cancel",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const parsed = claimSchema.safeParse(request.body);
      if (!params.success || !params.data.executionId || !parsed.success) return invalid(reply);
      const authority = authorityForRequest(request, reply, options);
      if (!authority) return;
      const active = await inspectActiveClaim(options, authority.context, params.data.id, parsed.data);
      if (!active?.item.claimTokenHash) return conflict(reply, "run job claim is not active");
      try {
        return reply.send(await options.broker.cancel(
          params.data.executionId,
          executionIdentity(authority.context, parsed.data.ownerId, active)
        ));
      } catch {
        return conflict(reply, "enterprise builtin execution is unavailable");
      }
    }
  );
}

function authorityForRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: EnterpriseBuiltinAgentRouteOptions
): {
  context: RequestContext;
  signingKey: string;
  getAgentSessionService: NonNullable<EnterpriseBuiltinAgentRouteOptions["getAgentSessionService"]>;
} | undefined {
  const context = options.requestContext(request);
  if (
    options.runtimeProfile !== "enterprise" ||
    !options.postgres ||
    !options.signingKey ||
    !context ||
    !options.getAgentSessionService
  ) {
    reply.code(503).send({ error: "enterprise builtin Agent authority is unavailable" });
    return undefined;
  }
  return { context, signingKey: options.signingKey, getAgentSessionService: options.getAgentSessionService };
}

async function inspectActiveClaim(
  options: EnterpriseBuiltinAgentRouteOptions,
  context: RequestContext,
  runId: string,
  claim: { readonly ownerId: string; readonly claimToken: string }
): Promise<EnterpriseClaimSnapshot | undefined> {
  const active = await options.postgres?.inspectClaim({
    runId,
    ownerId: claim.ownerId,
    claimToken: claim.claimToken
  });
  return active?.item.tenantId === context.tenantId ? active : undefined;
}

function executionIdentity(
  context: RequestContext,
  workerId: string,
  active: EnterpriseClaimSnapshot
): EnterpriseBuiltinExecutionIdentity {
  return {
    tenantId: context.tenantId,
    workerId,
    claimDigest: active.item.claimTokenHash!
  };
}

function validateExecutionStart(input: {
  readonly request: EnterpriseBuiltinExecutionStartV1;
  readonly active: EnterpriseClaimSnapshot;
  readonly context: RequestContext;
  readonly signingKey: string;
  readonly store: EnterpriseBuiltinAgentRouteOptions["store"];
}): string | {
  request: EnterpriseBuiltinExecutionStartV1;
  run: RunRecord;
  task: AgentTask;
  target: { providerId: string; modelId: string };
} {
  const request = input.request;
  const durable = executionStateFromEnterpriseClaim(input.active);
  const run = durable.run;
  const task = durable.task ?? input.store.tasks.get(run.taskId);
  const project = durable.project ?? input.store.projects.get(run.projectId);
  if (
    !run?.harnessManifest ||
    !task ||
    !project ||
    input.active.item.version !== 2 ||
    input.active.item.runId !== run.id ||
    run.tenantId !== input.context.tenantId ||
    task.tenantId !== input.context.tenantId ||
    project.tenantId !== input.context.tenantId ||
    input.active.item.projectId !== run.projectId ||
    input.active.item.taskId !== run.taskId
  ) {
    return "governed run bindings are unavailable";
  }
  const selected = selectCandidateTarget(task, request.candidateId);
  if (!selected || selected.runtimeId !== "builtin") {
    return "candidate is not an authorized builtin target";
  }
  if (
    request.providerId !== selected.providerId ||
    request.modelId !== selected.modelId ||
    request.timeoutSeconds !== task.strategy.timeoutSeconds ||
    request.timeoutSeconds > request.sandboxAttestation.policy.resources.timeoutSeconds
  ) {
    return "candidate execution policy binding is invalid";
  }
  const expectedBinding = expectedExecutionBindingForRun(
    run.id,
    task,
    request.candidateId,
    selected,
    request.sessionId
  );
  if (
    request.sessionId !== request.executionBinding.sessionId ||
    sha256Canonical(request.executionBinding) !== sha256Canonical(expectedBinding)
  ) {
    return "candidate Agent execution binding is invalid";
  }
  const attestation = request.sandboxAttestation as SandboxLeaseAttestation;
  const execution = request.sandboxExecution as SandboxExecutionEvidence;
  if (
    !input.active.item.requirementsDigest ||
    !input.active.item.workerCapabilityDigest ||
    !input.active.item.claimTokenHash
  ) {
    return "active claim capability binding is incomplete";
  }
  const attestationVerification = verifySandboxAttestation(attestation, {
    run,
    tenantId: input.context.tenantId,
    workerId: input.active.item.ownerId!,
    requirementsDigest: input.active.item.requirementsDigest,
    workerCapabilityDigest: input.active.item.workerCapabilityDigest,
    claimDigest: input.active.item.claimTokenHash,
    signingKey: input.signingKey
  });
  if (!attestationVerification.valid || !sandboxExecutionMatchesAttestation(execution, attestation)) {
    return "sandbox lease or inspected runtime binding is invalid";
  }
  const runtimeVerification = verifySandboxRuntimeProof(execution.runtimeProof, {
    attestation,
    tenantId: input.context.tenantId,
    runId: run.id,
    workerId: input.active.item.ownerId!,
    claimDigest: input.active.item.claimTokenHash,
    runtimeId: execution.runtimeId,
    runtimeDigest: execution.runtimeDigest,
    imageDigest: execution.imageDigest,
    signingKey: input.signingKey
  });
  if (!runtimeVerification.valid) return "sandbox runtime proof is invalid or expired";
  if (!workspaceIsWritableLeasePath(request.workspacePath, attestation)) {
    return "candidate workspace is outside the writable sandbox lease";
  }
  if (!attestation.policy.allowedTools.includes("node")) {
    return "builtin workspace tools require node in the immutable command allowlist";
  }
  return {
    request: Object.freeze({ ...request, sandboxAttestation: attestation, sandboxExecution: execution }),
    run,
    task,
    target: { providerId: selected.providerId, modelId: selected.modelId }
  };
}

function selectCandidateTarget(task: AgentTask, candidateId: string): {
  runtimeId: "builtin" | "claude" | "codex";
  providerId: string;
  modelId: string;
} | undefined {
  const selected = executionTargets(task.strategy).flatMap((target) =>
    Array.from({ length: target.candidates }, () => ({
      runtimeId: target.runtimeId,
      providerId: target.providerId ?? "",
      modelId: target.modelId ?? ""
    }))
  );
  const index = selected.findIndex((target, ordinal) =>
    `${target.runtimeId}-${ordinal + 1}` === candidateId
  );
  const target = index < 0 ? undefined : selected[index];
  return target?.providerId && target.modelId ? target : undefined;
}

function expectedExecutionBindingForRun(
  runId: string,
  task: AgentTask,
  candidateId: string,
  target: { runtimeId: "builtin" | "claude" | "codex"; providerId: string; modelId: string },
  sessionId?: string
): AgentExecutionBindingV1 {
  return Object.freeze({
    schemaVersion: 1,
    runId,
    candidateId,
    sessionId: sessionId ?? createSafeDeterministicPublicControlIdV1(
      "agent",
      JSON.stringify({ runId, candidateId })
    ),
    runtimeId: target.runtimeId,
    providerId: target.providerId,
    modelId: target.modelId,
    harnessDigest: task.harnessProfileRef?.digest ?? semanticDigest({
      harnessProfileRef: task.harnessProfileRef ?? "classic"
    }),
    governanceDigest: task.workflowRef?.digest ?? semanticDigest({
      workflowRef: task.workflowRef ?? "classic-v1",
      specRef: task.specRef ?? null
    }),
    effectPolicyDigest: semanticDigest({
      sandbox: task.strategy.sandbox,
      requiredGates: task.strategy.requiredGates,
      humanApproval: task.strategy.humanApproval,
      timeoutSeconds: task.strategy.timeoutSeconds
    }),
    sandboxCapabilityId: task.strategy.sandbox
  });
}

function semanticDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function workspaceIsWritableLeasePath(
  workspacePath: string,
  attestation: SandboxLeaseAttestation
): boolean {
  if (
    workspacePath !== workspacePath.trim() ||
    workspacePath.includes("\0") ||
    !posix.isAbsolute(workspacePath) ||
    workspacePath.split("/").includes("..")
  ) return false;
  const scratch = attestation.policy.mounts.filter((mount) => mount.source === "scratch");
  if (scratch.length !== 1 || scratch[0]!.readOnly) return false;
  const root = posix.normalize(scratch[0]!.target);
  const normalized = posix.normalize(workspacePath);
  const relative = posix.relative(root, normalized);
  return relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative);
}

async function resolveProvider(
  providerStore: EnterpriseBuiltinAgentRouteOptions["providerStore"],
  context: RequestContext,
  projectId: string,
  requestedProviderId: string,
  requestedModelId: string
): Promise<string | { provider: ProviderRecord; modelId: string }> {
  const providers = (await providerStore.listProviders("agent"))
    .filter((provider) => provider.enabled)
    .filter((provider) => providerIsScoped(provider, context.tenantId, projectId))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const provider = requestedProviderId === "default"
    ? providers[0]
    : providers.find((candidate) => candidate.id === requestedProviderId);
  if (!provider) return "no tenant-scoped Agent provider is authorized for this candidate";
  const modelId = requestedModelId === "default" ? provider.defaultModel : requestedModelId;
  if (
    !modelId ||
    (modelId !== provider.defaultModel && !provider.modelCatalog.some((model) => model.id === modelId))
  ) {
    return "Agent model is not authorized by the provider catalog";
  }
  return { provider, modelId };
}

function providerIsScoped(provider: ProviderRecord, tenantId: string, projectId: string): boolean {
  const scope = provider.config.enterpriseScope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
  const record = scope as Record<string, unknown>;
  const tenantIds = Array.isArray(record.tenantIds)
    ? record.tenantIds.filter((value): value is string => typeof value === "string")
    : [];
  const projectIds = Array.isArray(record.projectIds)
    ? record.projectIds.filter((value): value is string => typeof value === "string")
    : [];
  return tenantIds.includes(tenantId) && (projectIds.length === 0 || projectIds.includes(projectId));
}

function invalid(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({ error: "invalid enterprise builtin Agent request" });
}

function conflict(reply: FastifyReply, error: string): FastifyReply {
  return reply.code(409).send({ error });
}
