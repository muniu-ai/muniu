// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  AgentSessionServiceError,
  type AgentSessionEventSubscription,
  type LocalMockAgentSessionService
} from "./agentSessionService.js";

const controlId = z.string().min(1).max(256);
const clientRequestId = z.string().min(1).max(256);
const paramsSchema = z.object({ id: controlId }).strict();
const approvalParamsSchema = z.object({ id: controlId, approvalId: controlId }).strict();
const createSchema = z.object({
  clientRequestId,
  provider: controlId.optional(),
  model: controlId.optional(),
  cwd: z.string().max(16_384).optional(),
  labels: z.record(z.string().max(16_384)).optional()
}).strict();
const messageSchema = z.object({
  clientRequestId,
  prompt: z.string().min(1).max(1_000_000)
}).strict();
const controlSchema = z.object({ clientRequestId }).strict();
const approvalSchema = z.object({
  clientRequestId,
  decision: z.enum(["approve_once", "approve_session_scope", "deny"])
}).strict();
const eventQuerySchema = z.object({
  after: z.coerce.number().int().min(-1).default(-1)
}).strict();

export interface AgentSessionRouteOptions {
  readonly getService: () => Promise<LocalMockAgentSessionService>;
}

function invalid(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({ error: "INVALID_REQUEST" });
}

function failure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AgentSessionServiceError) {
    return reply.code(error.statusCode).send({ error: error.code });
  }
  return reply.code(500).send({ error: "AGENT_SESSION_SERVICE_ERROR" });
}

export function registerAgentSessionRoutes(
  app: FastifyInstance,
  options: AgentSessionRouteOptions
): void {
  const service = options.getService;
  const activeEventStreams = new Set<() => void>();

  app.addHook("preClose", async () => {
    for (const close of [...activeEventStreams]) close();
  });

  app.post("/v1/agent-sessions", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    try {
      const result = await (await service()).create(parsed.data);
      return reply.code(result.statusCode).send(result.body);
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.get("/v1/agent-sessions/:id", async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return invalid(reply);
    try {
      return reply.send(await (await service()).get(parsed.data.id));
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.post("/v1/agent-sessions/:id/messages", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = messageSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    try {
      const result = await (await service()).message(params.data.id, body.data);
      return reply.code(result.statusCode).send(result.body);
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.get("/v1/agent-sessions/:id/events", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = eventQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply);
    let disconnected = false;
    let abortStream: (() => void) | undefined;
    const onDisconnect = (): void => {
      disconnected = true;
      if (abortStream) abortStream();
      else abandonPending();
    };
    const detachDisconnect = (): void => {
      request.raw.off("aborted", onDisconnect);
      request.raw.off("close", onDisconnect);
    };
    const abandonPending = (): void => {
      detachDisconnect();
      activeEventStreams.delete(shutdownPending);
    };
    const shutdownPending = (): void => {
      disconnected = true;
      if (abortStream) abortStream();
      else {
        abandonPending();
        reply.raw.destroy();
      }
    };
    const isDisconnected = (): boolean =>
      disconnected || request.raw.destroyed || reply.raw.destroyed || reply.raw.writableEnded;
    request.raw.once("aborted", onDisconnect);
    request.raw.once("close", onDisconnect);
    activeEventStreams.add(shutdownPending);
    try {
      const runtime = await service();
      if (isDisconnected()) {
        abandonPending();
        return;
      }
      await runtime.get(params.data.id);
      if (isDisconnected()) {
        abandonPending();
        return;
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      let closed = false;
      let subscription: AgentSessionEventSubscription | undefined;
      let pendingResume = false;
      const onDrain = (): void => {
        if (subscription) subscription.resume();
        else pendingResume = true;
      };
      const keepAlive = setInterval(() => {
        if (!closed && !reply.raw.writableNeedDrain
          && !reply.raw.write(": keep-alive\n\n")) {
          subscription?.pause();
          reply.raw.once("drain", onDrain);
        }
      }, 15_000);
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        reply.raw.off("drain", onDrain);
        subscription?.unsubscribe();
        activeEventStreams.delete(close);
        activeEventStreams.delete(shutdownPending);
        detachDisconnect();
        reply.raw.end();
      };
      activeEventStreams.delete(shutdownPending);
      activeEventStreams.add(close);
      abortStream = close;
      if (isDisconnected()) {
        close();
        return;
      }
      subscription = await runtime.subscribeEvents(
        params.data.id,
        query.data.after,
        (event) => {
          if (closed) return false;
          const writable = reply.raw.write(
            `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
          );
          if (!writable) reply.raw.once("drain", onDrain);
          return writable;
        }
      );
      if (closed || isDisconnected()) {
        subscription.unsubscribe();
        close();
        return;
      }
      if (pendingResume) subscription.resume();
      return;
    } catch (error: unknown) {
      if (abortStream) {
        abortStream();
        return;
      }
      abandonPending();
      if (isDisconnected()) return;
      return failure(reply, error);
    }
  });

  app.post("/v1/agent-sessions/:id/cancel", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = controlSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    try {
      const result = await (await service()).cancel(params.data.id, body.data);
      return reply.code(result.statusCode).send(result.body);
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.post("/v1/agent-sessions/:id/close", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = controlSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    try {
      const result = await (await service()).close(params.data.id, body.data);
      return reply.code(result.statusCode).send(result.body);
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });

  app.post("/v1/agent-sessions/:id/approvals/:approvalId", async (request, reply) => {
    const params = approvalParamsSchema.safeParse(request.params);
    const body = approvalSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    try {
      const result = await (await service()).approve(
        params.data.id,
        params.data.approvalId,
        body.data
      );
      return reply.code(result.statusCode).send(result.body);
    } catch (error: unknown) {
      return failure(reply, error);
    }
  });
}
