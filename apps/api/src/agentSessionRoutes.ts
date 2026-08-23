// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  inspectAgentApprovalDecisionRequestV1,
  inspectAgentAttachmentUploadRequestV1,
  inspectAgentMessageRequestV1,
  inspectAgentMessageRequestV2,
  inspectAgentSessionControlRequestV1,
  inspectAgentSessionCreateRequestV1,
  inspectAgentSessionCreateRequestV2
} from "@mn/agent-protocol";

import {
  AgentSessionServiceError,
  type LocalMockAgentSessionService
} from "./agentSessionService.js";
import { AgentRuntimeResolutionError } from "./agentRuntimeFactory.js";

const controlId = z.string().min(1).max(256);
const paramsSchema = z.object({ id: controlId }).strict();
const approvalParamsSchema = z.object({ id: controlId, approvalId: controlId }).strict();
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();

export interface AgentSessionRouteOptions {
  readonly getService: (request: FastifyRequest) => Promise<LocalMockAgentSessionService>;
}

function invalid(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    schemaVersion: 1,
    kind: "agent-error-response",
    error: "INVALID_REQUEST"
  });
}

function failure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AgentRuntimeResolutionError) {
    const statusCode = error.code === "PROVIDER_NOT_FOUND"
      ? 404
      : error.code === "PROVIDER_DISABLED"
          || error.code === "PROVIDER_CONSUMER_UNAVAILABLE"
          || error.code === "MODEL_NOT_FOUND"
        ? 409
        : 503;
    return reply.code(statusCode).send({
      schemaVersion: 1,
      kind: "agent-error-response",
      error: error.code
    });
  }
  if (error instanceof AgentSessionServiceError) {
    return reply.code(error.statusCode).send({
      schemaVersion: 1,
      kind: "agent-error-response",
      error: error.code
    });
  }
  return reply.code(500).send({
    schemaVersion: 1,
    kind: "agent-error-response",
    error: "AGENT_SESSION_SERVICE_ERROR"
  });
}

function registerRoutes(
  app: FastifyInstance,
  options: AgentSessionRouteOptions
): void {
  const service = options.getService;

  app.post("/v1/agent-sessions", async (request, reply) => {
    const parsed = inspectAgentSessionCreateRequestV1(request.body)
      ?? inspectAgentSessionCreateRequestV2(request.body);
    if (parsed === undefined) return invalid(reply);
    try {
      const result = await (await service(request)).create(parsed);
      return reply.code(result.statusCode).send(result.body);
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.get("/v1/agent-sessions", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply);
    try {
      return reply.send({
        schemaVersion: 1,
        kind: "agent-session-list",
        sessions: await (await service(request)).list(query.data.limit)
      });
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.get("/v1/agent-sessions/:id", async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return invalid(reply);
    try {
      return reply.send(await (await service(request)).get(parsed.data.id));
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.post("/v1/agent-sessions/:id/messages", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = inspectAgentMessageRequestV1(request.body)
      ?? inspectAgentMessageRequestV2(request.body);
    if (!params.success || body === undefined) return invalid(reply);
    try {
      const result = await (await service(request)).message(params.data.id, body);
      return reply.code(result.statusCode).send(result.body);
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.post("/v1/agent-sessions/:id/attachments", {
    bodyLimit: 6 * 1024 * 1024
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = inspectAgentAttachmentUploadRequestV1(request.body);
    if (!params.success || body === undefined) return invalid(reply);
    try {
      const result = await (await service(request)).uploadAttachment(params.data.id, body);
      return reply.code(result.statusCode).send(result.body);
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.post("/v1/agent-sessions/:id/cancel", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = inspectAgentSessionControlRequestV1(request.body);
    if (!params.success || body === undefined) return invalid(reply);
    try {
      const result = await (await service(request)).cancel(params.data.id, body);
      return reply.code(result.statusCode).send(result.body);
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.post("/v1/agent-sessions/:id/close", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = inspectAgentSessionControlRequestV1(request.body);
    if (!params.success || body === undefined) return invalid(reply);
    try {
      const result = await (await service(request)).close(params.data.id, body);
      return reply.code(result.statusCode).send(result.body);
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.post("/v1/agent-sessions/:id/approvals/:approvalId", async (request, reply) => {
    const params = approvalParamsSchema.safeParse(request.params);
    const body = inspectAgentApprovalDecisionRequestV1(request.body);
    if (!params.success || body === undefined) return invalid(reply);
    try {
      const result = await (await service(request)).approve(
        params.data.id,
        params.data.approvalId,
        body
      );
      return reply.code(result.statusCode).send(result.body);
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });
}

export function registerAgentSessionRoutes(
  app: FastifyInstance,
  options: AgentSessionRouteOptions
): void {
  app.register(async (scoped) => {
    scoped.setErrorHandler((error, _request, reply) => {
      const statusDescriptor = error !== null && typeof error === "object"
        ? Reflect.getOwnPropertyDescriptor(error, "statusCode")
        : undefined;
      if (statusDescriptor && "value" in statusDescriptor && statusDescriptor.value === 400) {
        return invalid(reply);
      }
      return failure(reply, error);
    });
    registerRoutes(scoped, options);
  });
}
