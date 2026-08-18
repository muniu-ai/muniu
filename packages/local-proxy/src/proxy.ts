import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  HttpTransportError,
  classifyHttpUsageV1,
  dispatchHttpRequest,
  type HttpDispatchResult,
  type HttpResponseSnapshot
} from "@mn/agent-llm";
import type {
  ManagedAgentApp,
  ProxyReplayRecord,
  ProxyReplayToolCall,
  ProxyRequestLog,
  ProxyToolReplayEffect,
  TrustedProxyUsageAssociation
} from "@mn/provider-catalog";
import {
  normalizeUsageFromJson,
  normalizeUsageFromResponseBody,
  type TokenUsage
} from "@mn/usage";
import type {
  LocalProxyOptions,
  LocalProxyStatus,
  ProviderUsageDispatchIntent,
  ProviderUsageAttemptLog,
  ProviderUsagePreparationIntent,
  ProviderUsageReservationDecision,
  ProviderUsageUnknownIntent,
  ProviderUsageUnknownReason,
  ResolvedProxyProvider
} from "./types.js";
import {
  INVALID_PROVIDER_USAGE_RECEIPT_MESSAGE,
  PROVIDER_USAGE_RECEIPT_AUTHORITY_UNAVAILABLE_MESSAGE,
  ProviderUsageReceiptVerificationUnavailableError,
  isProviderUsageReceiptVerificationUnavailableError
} from "./errors.js";
import { providerUsageAttemptLogId } from "./identity.js";

class ProviderUsageRecordingError extends Error {
  constructor(cause: unknown) {
    super("provider usage accounting is unavailable", { cause });
    this.name = "ProviderUsageRecordingError";
  }
}

class ProviderDispatchUnknownError extends Error {
  constructor(
    readonly reason: ProviderUsageUnknownReason,
    readonly statusCode?: number,
    cause?: unknown
  ) {
    super("provider result is unavailable", { cause });
    this.name = "ProviderDispatchUnknownError";
  }
}

type ProviderDispatchPhase =
  | "fetch"
  | "response_read"
  | "response_conversion"
  | "stream";

type ResponseConversion = "chat_to_responses" | "chat_to_anthropic" | "responses_to_anthropic";

type StreamUsageResult = Partial<TokenUsage> & {
  model?: string;
  body?: Buffer;
};

type StreamToolCall = {
  index: number;
  outputIndex?: number;
  contentIndex?: number;
  id: string;
  callId: string;
  name: string;
  arguments: string;
  responsesStarted: boolean;
  responsesArgumentsDone: boolean;
  responsesDone: boolean;
  anthropicStarted: boolean;
  anthropicStopped: boolean;
};

type ReplaySafetyEvaluation = {
  containsToolCall: boolean;
  toolCalls: ProxyReplayToolCall[];
  replaySafe: boolean;
};

type ResponsesStreamState = {
  responseId: string;
  messageId: string;
  createdAt: number;
  model: string;
  started: boolean;
  completed: boolean;
  outputText: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
  nextOutputIndex: number;
  textOutputIndex?: number;
  textItemStarted: boolean;
  textItemDone: boolean;
  toolCalls: StreamToolCall[];
};

type AnthropicStreamState = {
  messageId: string;
  model: string;
  started: boolean;
  completed: boolean;
  outputText: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
  nextContentIndex: number;
  textContentIndex?: number;
  textBlockStarted: boolean;
  textBlockStopped: boolean;
  toolCalls: StreamToolCall[];
};

export class LocalProxyServer {
  private server?: Server;
  private readonly host: string;
  private readonly port: number;
  private readonly resolveProvider: LocalProxyOptions["resolveProvider"];
  private readonly resolveProviders?: LocalProxyOptions["resolveProviders"];
  private readonly appendLog: LocalProxyOptions["appendLog"];
  private readonly recordProviderHealth?: LocalProxyOptions["recordProviderHealth"];
  private readonly getReplay?: LocalProxyOptions["getReplay"];
  private readonly saveReplay?: LocalProxyOptions["saveReplay"];
  private readonly markReplayUsed?: LocalProxyOptions["markReplayUsed"];
  private readonly verifyUsageAssociationReceipt?: LocalProxyOptions["verifyUsageAssociationReceipt"];
  private readonly reserveTrustedUsageAssociation?: LocalProxyOptions["reserveTrustedUsageAssociation"];
  private readonly markProviderUsageAttemptDispatchStarted?: LocalProxyOptions["markProviderUsageAttemptDispatchStarted"];
  private readonly markProviderUsageAttemptUnknown?: LocalProxyOptions["markProviderUsageAttemptUnknown"];
  private readonly requireTrustedUsageAssociation: boolean;
  private readonly semanticDigestKey?: Buffer;
  private readonly upstreamTimeoutMs: number;

  constructor(options: LocalProxyOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port;
    this.resolveProvider = options.resolveProvider;
    this.resolveProviders = options.resolveProviders;
    this.appendLog = options.appendLog;
    this.recordProviderHealth = options.recordProviderHealth;
    this.getReplay = options.getReplay;
    this.saveReplay = options.saveReplay;
    this.markReplayUsed = options.markReplayUsed;
    this.verifyUsageAssociationReceipt = options.verifyUsageAssociationReceipt;
    this.reserveTrustedUsageAssociation = options.reserveTrustedUsageAssociation;
    this.markProviderUsageAttemptDispatchStarted =
      options.markProviderUsageAttemptDispatchStarted;
    this.markProviderUsageAttemptUnknown = options.markProviderUsageAttemptUnknown;
    this.requireTrustedUsageAssociation = options.requireTrustedUsageAssociation ?? false;
    this.semanticDigestKey = options.semanticDigestKey === undefined
      ? undefined
      : Buffer.isBuffer(options.semanticDigestKey)
        ? Buffer.from(options.semanticDigestKey)
        : Buffer.from(options.semanticDigestKey, "utf8");
    if (
      this.requireTrustedUsageAssociation &&
      (!this.verifyUsageAssociationReceipt || !this.reserveTrustedUsageAssociation)
    ) {
      throw new TypeError(
        "trusted provider usage requires both receipt verification and preauthorization"
      );
    }
    this.upstreamTimeoutMs = options.upstreamTimeoutMs ?? 30_000;
  }

  status(): LocalProxyStatus {
    const address = this.server?.address() as AddressInfo | null;
    return {
      running: Boolean(this.server?.listening),
      host: this.host,
      port: address?.port ?? this.port
    };
  }

  async start(): Promise<LocalProxyStatus> {
    if (this.server?.listening) return this.status();
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.host, () => resolve());
    });
    return this.status();
  }

  async stop(): Promise<LocalProxyStatus> {
    if (!this.server) return this.status();
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.server = undefined;
    return this.status();
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const startedAt = Date.now();
    const route = parseAssociatedRequestUrl(request.url ?? "/");
    const app = detectApp(request, route.requestUrl);
    let association: RequestAssociation;
    try {
      association = await readRequestAssociation({
        request,
        route,
        verifyReceipt: this.verifyUsageAssociationReceipt,
        requireTrusted: this.requireTrustedUsageAssociation
      });
    } catch (error) {
      if (isProviderUsageReceiptVerificationUnavailableError(error)) {
        writeJsonError(response, 503, {
          error: PROVIDER_USAGE_RECEIPT_AUTHORITY_UNAVAILABLE_MESSAGE
        });
        return;
      }
      writeJsonError(response, 401, {
        error: INVALID_PROVIDER_USAGE_RECEIPT_MESSAGE
      });
      return;
    }
    let candidates: ResolvedProxyProvider[];
    try {
      candidates = await this.resolveCandidates(app, association.trustedAssociation);
      assertResolvedCandidates(candidates, app);
    } catch {
      writeJsonError(response, 503, {
        error: `provider resolution is unavailable for ${app}`
      });
      return;
    }
    if (candidates.length === 0) {
      writeJsonError(response, 503, { error: `no enabled provider for ${app}` });
      return;
    }

    let requestBody: Buffer;
    try {
      requestBody = await readRequestBody(request);
    } catch {
      writeJsonError(response, 400, { error: "provider request body is unavailable" });
      return;
    }

    const requestModel = readModelFromBody(requestBody);
    let logicalRequestId: string = randomUUID();
    const governedEnterprise = Boolean(
      association.trustedAssociation &&
      this.markProviderUsageAttemptDispatchStarted
    );
    const callerIdempotencyKey = governedEnterprise
      ? readHeaderString(request, "idempotency-key")
      : undefined;
    const callerIdempotencyKeyDigest =
      callerIdempotencyKey && association.trustedAssociation
        ? providerCallerIdempotencyKeyDigest({
            association: association.trustedAssociation,
            app,
            key: callerIdempotencyKey
          })
        : undefined;
    let firstRoutedRequest: ReturnType<typeof routeRequest>;
    try {
      firstRoutedRequest = routeRequest({
        requestUrl: route.requestUrl,
        requestBody,
        headers: buildHeaders(request, candidates[0]!),
        resolved: candidates[0]!
      });
    } catch {
      writeJsonError(response, 503, {
        error: "provider request preparation is unavailable"
      });
      return;
    }
    if (governedEnterprise && callerIdempotencyKeyDigest && !this.semanticDigestKey) {
      writeJsonError(response, 503, {
        error: "provider request semantic binding is unavailable"
      });
      return;
    }
    const semanticDigest = governedEnterprise && this.semanticDigestKey
      ? providerRequestSemanticDigest(firstRoutedRequest, this.semanticDigestKey!)
      : undefined;
    const requestDigest = sha256(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      app,
      method: (request.method ?? "GET").toUpperCase(),
      requestUrl: route.requestUrl,
      requestBodyDigest: sha256(requestBody),
      ...(semanticDigest ? { semanticDigest } : {}),
      runId: association.runId ?? null,
      candidateId: association.candidateId ?? null
    })));
    const providerPlanDigest = sha256(Buffer.from(JSON.stringify(
      candidates.map(({ app: candidateApp, provider }) => ({
        app: candidateApp,
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        apiFormat: provider.apiFormat,
        defaultModel: provider.defaultModel,
        providerAccountId: providerAccountId(provider),
        enterpriseCapabilities: provider.enterpriseCapabilities ?? null
      }))
    )));
    const prepareAttempt = async (
      resolved: ResolvedProxyProvider,
      attemptIndex: number
    ) => {
      const routedRequest = attemptIndex === 1
        ? firstRoutedRequest
        : routeRequest({
            requestUrl: route.requestUrl,
            requestBody,
            headers: buildHeaders(request, resolved),
            resolved
          });
      const replayKey = governedEnterprise
        ? callerIdempotencyKeyDigest
          ? buildEnterpriseReplayKey({
              app,
              providerId: resolved.provider.id,
              runId: association.runId!,
              candidateId: association.candidateId!,
              callerIdempotencyKeyDigest,
              requestDigest,
              providerPlanDigest,
              method: request.method ?? "GET",
              targetUrl: routedRequest.targetUrl,
              body: routedRequest.body
            })
          : undefined
        : buildReplayKey({
            app,
            providerId: resolved.provider.id,
            runId: association.runId,
            candidateId: association.candidateId,
            method: request.method ?? "GET",
            targetUrl: routedRequest.targetUrl,
            body: routedRequest.body
          });
      const outboundIdempotencyKey = providerOutboundIdempotencyKey({
        logicalRequestId,
        attemptIndex,
        providerId: resolved.provider.id
      });
      const outboundIdempotencyEvidence = governedEnterprise
        ? applyEnterpriseProviderIdempotencyHeader(
            routedRequest.headers,
            resolved.provider,
            outboundIdempotencyKey
          )
        : undefined;
      if (!governedEnterprise && replayKey) {
        applyProviderIdempotencyHeader(
          routedRequest.headers,
          resolved.provider,
          outboundIdempotencyKey
        );
      }
      const replay = replayKey
        ? await this.readReplayRecord(replayKey.key)
        : undefined;
      const replayUsable = replay
        ? shouldUseReplayRecord(replay, resolved.provider)
        : false;
      const upstreamRequest = new Request(routedRequest.targetUrl, {
        method: request.method,
        headers: routedRequest.headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : new Uint8Array(routedRequest.body)
      });
      return {
        routedRequest,
        replayKey,
        replay,
        replayUsable,
        upstreamRequest,
        providerIdempotencyStrength:
          outboundIdempotencyEvidence?.strength ?? "none" as const,
        outboundIdempotencyHeaderName: outboundIdempotencyEvidence?.headerName,
        outboundIdempotencyKeyDigest: outboundIdempotencyEvidence?.keyDigest
      };
    };
    let firstAttempt: Awaited<ReturnType<typeof prepareAttempt>>;
    try {
      firstAttempt = await prepareAttempt(candidates[0]!, 1);
    } catch {
      writeJsonError(response, 503, {
        error: "provider request preparation is unavailable"
      });
      return;
    }

    // All deterministic, side-effect-free request preparation is complete.
    // From this point every path is either an upstream/replay attempt that is
    // append-only accounted below, or a fail-closed accounting outage.
    if (association.trustedAssociation && this.reserveTrustedUsageAssociation) {
      try {
        const verifiedAssociation = Object.freeze({
          ...association.trustedAssociation
        });
        const preparation: ProviderUsagePreparationIntent | undefined =
          this.markProviderUsageAttemptDispatchStarted
            ? Object.freeze({
                schemaVersion: 1 as const,
                logicalRequestId,
                app,
                model: requestModel,
                requestDigest,
                providerPlanDigest,
                ...(callerIdempotencyKeyDigest
                  ? { callerIdempotencyKeyDigest }
                  : {}),
                providerIdempotencyStrength:
                  firstAttempt.providerIdempotencyStrength,
                ...(firstAttempt.outboundIdempotencyHeaderName
                  ? {
                      firstOutboundIdempotencyHeaderName:
                        firstAttempt.outboundIdempotencyHeaderName
                    }
                  : {}),
                ...(firstAttempt.outboundIdempotencyKeyDigest
                  ? {
                      firstOutboundIdempotencyKeyDigest:
                        firstAttempt.outboundIdempotencyKeyDigest
                    }
                  : {}),
                preparedAt: new Date().toISOString()
              })
            : undefined;
        const reservation = await this.reserveTrustedUsageAssociation(
          verifiedAssociation,
          preparation
        );
        if (isProviderUsageReservationDecision(reservation)) {
          logicalRequestId = reservation.logicalRequestId;
          if (reservation.kind === "conflict") {
            writeJsonError(response, 409, {
              error: "provider request idempotency key conflicts with different semantics"
            });
            return;
          }
          if (
            reservation.kind === "duplicate_finalized" &&
            firstAttempt.replay &&
            firstAttempt.replayUsable
          ) {
            await this.markReplayRecordUsed(firstAttempt.replay.key);
            writeReplayResponse(response, firstAttempt.replay);
            return;
          }
          writeJsonError(response, 409, {
            error: reservation.kind === "duplicate_pending"
              ? "provider request with this idempotency key is still pending"
              : "provider request result for this idempotency key is unavailable"
          });
          return;
        }
        const trustedAssociation = reservation;
        assertReservedAssociation(verifiedAssociation, trustedAssociation);
        if (
          preparation &&
          trustedAssociation.reservationId !== preparation.logicalRequestId
        ) {
          throw new TypeError("provider usage reservation changed logical request identity");
        }
        association = {
          runId: trustedAssociation.runId,
          candidateId: trustedAssociation.candidateId,
          trustedAssociation
        };
        logicalRequestId = trustedAssociation.reservationId!;
      } catch {
        writeJsonError(response, 503, {
          error: "provider usage accounting is unavailable"
        });
        return;
      }
    }

    let lastError: unknown;

    for (const [index, resolved] of candidates.entries()) {
      const attemptIndex = index + 1;
      const attemptStartedAt = Date.now();
      let statusCode = 502;
      let model = requestModel;
      const hasFallback = index < candidates.length - 1;
      let dispatchIntent: ProviderUsageDispatchIntent | undefined;
      let dispatchCommitted = false;
      let dispatchPhase: ProviderDispatchPhase | undefined;
      let upstreamDispatch: HttpDispatchResult | undefined;
      try {
        const {
          routedRequest,
          replayKey,
          replay,
          replayUsable,
          upstreamRequest,
          providerIdempotencyStrength,
          outboundIdempotencyHeaderName,
          outboundIdempotencyKeyDigest
        } = index === 0
          ? firstAttempt
          : await prepareAttempt(resolved, attemptIndex);
        if (replay && !governedEnterprise) {
          if (!replayUsable) {
            // Tool-call responses can trigger client-side tool execution again; replay only
            // when the provider declares a safe tool contract or keeps legacy opt-in enabled.
          } else {
            await this.markReplayRecordUsed(replay.key);
            await this.recordAttempt({
              app,
              resolved,
              model: replay.model,
              statusCode: replay.statusCode,
              startedAt: attemptStartedAt,
              ok: true,
              retryable: false,
              logicalRequestId,
              attemptIndex,
              terminal: true,
              // The replay record retains the original provider usage for the
              // delivered response, but this attempt is a local cache hit and
              // must not charge the provider or the governed Loop a second time.
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              reasoningOutputTokens: 0,
              runId: association.runId,
              candidateId: association.candidateId,
              trustedAssociation: association.trustedAssociation,
              replayed: true,
              containsToolCall: replay.containsToolCall,
              toolCalls: replay.toolCalls,
              recordHealth: false
            });
            writeReplayResponse(response, replay);
            return;
          }
        }
        if (
          association.trustedAssociation &&
          this.markProviderUsageAttemptDispatchStarted
        ) {
          dispatchIntent = Object.freeze({
            schemaVersion: 1,
            logicalRequestId,
            attemptIndex,
            providerId: resolved.provider.id,
            providerAccountId: providerAccountId(resolved.provider),
            model,
            requestDigest,
            providerIdempotencyStrength,
            ...(outboundIdempotencyHeaderName
              ? { outboundIdempotencyHeaderName }
              : {}),
            ...(outboundIdempotencyKeyDigest
              ? {
                  outboundRequestKeyDigest: outboundIdempotencyKeyDigest,
                  outboundIdempotencyKeyDigest
                }
              : {}),
            startedAt: new Date().toISOString()
          });
          try {
            await this.markProviderUsageAttemptDispatchStarted(
              association.trustedAssociation,
              dispatchIntent
            );
            dispatchCommitted = true;
          } catch (error) {
            throw new ProviderUsageRecordingError(error);
          }
        }
        dispatchPhase = "fetch";
        upstreamDispatch = await dispatchHttpRequest({
          request: upstreamRequest,
          timeoutMs: this.upstreamTimeoutMs
        });
        const upstream = upstreamDispatch.response;
        statusCode = upstream.status;
        if (shouldFailover(statusCode) && hasFallback) {
          dispatchPhase = "response_read";
          const failedBody = Buffer.from(await upstream.arrayBuffer());
          const eventUsage = isEventStream(upstream)
            ? authoritativeEventStreamUsage(failedBody)
            : undefined;
          const failedUsageState = eventUsage?.state ?? authoritativeUsageState(failedBody);
          if (
            governedEnterprise &&
            failedUsageState !== "complete" &&
            resolved.provider.enterpriseCapabilities
              ?.retryableFailureResponsesUnbilled !== true
          ) {
            throw new ProviderDispatchUnknownError(
              failedUsageState === "partial"
                ? "partial_usage"
                : "unverified_failure_response",
              statusCode
            );
          }
          const failedUsage = eventUsage?.usage ?? normalizeUsageFromResponseBody(failedBody);
          model = model || readModelFromBody(failedBody);
          await this.recordAttempt({
            app,
            resolved,
            model,
            statusCode,
            startedAt: attemptStartedAt,
            ok: false,
            retryable: true,
            logicalRequestId,
            attemptIndex,
            terminal: false,
            inputTokens: failedUsage.inputTokens,
            outputTokens: failedUsage.outputTokens,
            cachedInputTokens: failedUsage.cachedInputTokens,
            cacheCreationInputTokens: failedUsage.cacheCreationInputTokens,
            cacheReadInputTokens: failedUsage.cacheReadInputTokens,
            reasoningOutputTokens: failedUsage.reasoningOutputTokens,
            runId: association.runId,
            candidateId: association.candidateId,
            trustedAssociation: association.trustedAssociation,
            error: `retryable upstream status ${statusCode}`
          });
          continue;
        }
        if (isEventStream(upstream)) {
          let streamSource = upstream;
          let authoritativeStreamUsage: TokenUsage | undefined;
          if (governedEnterprise) {
            // Governed streams are buffered before any client-visible terminal
            // bytes. This lets the ledger/journal fail closed on missing or
            // partial authoritative usage instead of settling estimates.
            dispatchPhase = "stream";
            const rawStreamBody = Buffer.from(await upstream.arrayBuffer());
            const usage = authoritativeEventStreamUsage(rawStreamBody);
            const explicitlyUnbilledFailure = statusCode >= 400 &&
              resolved.provider.enterpriseCapabilities
                ?.retryableFailureResponsesUnbilled === true;
            if (usage.state !== "complete" && !explicitlyUnbilledFailure) {
              throw new ProviderDispatchUnknownError(
                usage.state === "partial"
                  ? "partial_usage"
                  : statusCode >= 400
                    ? "unverified_failure_response"
                    : "unverified_success_response",
                statusCode
              );
            }
            authoritativeStreamUsage = usage.usage;
            streamSource = upstream.withBody(rawStreamBody);
          }
          dispatchPhase = "stream";
          const streamResponse = governedEnterprise
            ? bufferedServerResponse()
            : response;
          const streamResult = await streamUpstreamResponse(
            streamResponse,
            streamSource,
            routedRequest.responseConversion,
            routedRequest.body
          );
          model = streamResult.model ?? model;
          const streamReplaySafety = streamResult.body
            ? evaluateReplaySafety(streamResult.body, resolved.provider)
            : emptyReplaySafety();
          await this.recordAttempt({
            app,
            resolved,
            model,
            statusCode,
            startedAt: attemptStartedAt,
            ok: !shouldFailover(statusCode),
            retryable: shouldFailover(statusCode),
            logicalRequestId,
            attemptIndex,
            terminal: true,
            inputTokens: authoritativeStreamUsage?.inputTokens ?? streamResult.inputTokens,
            outputTokens: authoritativeStreamUsage?.outputTokens ?? streamResult.outputTokens,
            cachedInputTokens: authoritativeStreamUsage?.cachedInputTokens ?? streamResult.cachedInputTokens,
            cacheCreationInputTokens: authoritativeStreamUsage?.cacheCreationInputTokens ?? streamResult.cacheCreationInputTokens,
            cacheReadInputTokens: authoritativeStreamUsage?.cacheReadInputTokens ?? streamResult.cacheReadInputTokens,
            reasoningOutputTokens: authoritativeStreamUsage?.reasoningOutputTokens ?? streamResult.reasoningOutputTokens,
            runId: association.runId,
            candidateId: association.candidateId,
            trustedAssociation: association.trustedAssociation,
            containsToolCall: streamReplaySafety.containsToolCall,
            toolCalls: streamReplaySafety.toolCalls,
            error: shouldFailover(statusCode)
              ? `retryable upstream status ${statusCode}`
              : undefined
          });
          if (
            replayKey &&
            shouldStoreReplay(statusCode) &&
            streamResult.body &&
            streamReplaySafety.replaySafe
          ) {
            await this.saveReplayRecord({
              key: replayKey.key,
              app,
              providerId: resolved.provider.id,
              model,
              method: request.method ?? "GET",
              targetUrl: routedRequest.targetUrl,
              requestHash: replayKey.requestHash,
              statusCode,
              headers: buildResponseHeaders(upstream),
              bodyBase64: streamResult.body.toString("base64"),
              inputTokens: authoritativeStreamUsage?.inputTokens ?? streamResult.inputTokens ?? 0,
              outputTokens: authoritativeStreamUsage?.outputTokens ?? streamResult.outputTokens ?? 0,
              cachedInputTokens: authoritativeStreamUsage?.cachedInputTokens ?? streamResult.cachedInputTokens,
              cacheCreationInputTokens: authoritativeStreamUsage?.cacheCreationInputTokens ?? streamResult.cacheCreationInputTokens,
              cacheReadInputTokens: authoritativeStreamUsage?.cacheReadInputTokens ?? streamResult.cacheReadInputTokens,
              reasoningOutputTokens: authoritativeStreamUsage?.reasoningOutputTokens ?? streamResult.reasoningOutputTokens,
              containsToolCall: streamReplaySafety.containsToolCall,
              ...(streamReplaySafety.toolCalls.length > 0
                ? { toolCalls: streamReplaySafety.toolCalls }
                : {}),
              runId: replayKey.runId,
              candidateId: replayKey.candidateId,
              createdAt: new Date().toISOString(),
              replayCount: 0
            });
          }
          if (governedEnterprise) {
            writeUpstreamResponse(
              response,
              streamSource,
              streamResult.body ?? Buffer.alloc(0)
            );
          } else if (!response.writableEnded) {
            response.end();
          }
        } else {
          dispatchPhase = "response_read";
          const responseBody = Buffer.from(await upstream.arrayBuffer());
          dispatchPhase = "response_conversion";
          if (
            governedEnterprise &&
            routedRequest.responseConversion &&
            !isJsonObjectBody(responseBody)
          ) {
            throw new ProviderDispatchUnknownError(
              "response_conversion_error",
              statusCode
            );
          }
          if (
            governedEnterprise &&
            authoritativeUsageState(responseBody) !== "complete" &&
            !(
              statusCode >= 400 &&
              resolved.provider.enterpriseCapabilities
                ?.retryableFailureResponsesUnbilled === true
            )
          ) {
            throw new ProviderDispatchUnknownError(
              authoritativeUsageState(responseBody) === "partial"
                ? "partial_usage"
                : statusCode >= 400
                  ? "unverified_failure_response"
                  : "unverified_success_response",
              statusCode
            );
          }
          const clientBody = routedRequest.responseConversion === "chat_to_responses"
            ? convertChatCompletionToResponses(responseBody)
            : routedRequest.responseConversion === "chat_to_anthropic"
              ? convertChatCompletionToAnthropicMessage(responseBody)
              : routedRequest.responseConversion === "responses_to_anthropic"
                ? convertResponsesToAnthropicMessage(responseBody)
            : responseBody;
          model = model || readModelFromBody(clientBody);
          const tokenUsage = normalizeUsageFromResponseBody(clientBody);
          const responseReplaySafety = evaluateReplaySafety(clientBody, resolved.provider);
          await this.recordAttempt({
            app,
            resolved,
            model,
            statusCode,
            startedAt: attemptStartedAt,
            ok: !shouldFailover(statusCode),
            retryable: shouldFailover(statusCode),
            logicalRequestId,
            attemptIndex,
            terminal: true,
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens,
            cachedInputTokens: tokenUsage.cachedInputTokens,
            cacheCreationInputTokens: tokenUsage.cacheCreationInputTokens,
            cacheReadInputTokens: tokenUsage.cacheReadInputTokens,
            reasoningOutputTokens: tokenUsage.reasoningOutputTokens,
            runId: association.runId,
            candidateId: association.candidateId,
            trustedAssociation: association.trustedAssociation,
            containsToolCall: responseReplaySafety.containsToolCall,
            toolCalls: responseReplaySafety.toolCalls,
            error: shouldFailover(statusCode)
              ? `retryable upstream status ${statusCode}`
              : undefined
          });
          if (
            replayKey &&
            shouldStoreReplay(statusCode) &&
            responseReplaySafety.replaySafe
          ) {
            await this.saveReplayRecord({
              key: replayKey.key,
              app,
              providerId: resolved.provider.id,
              model,
              method: request.method ?? "GET",
              targetUrl: routedRequest.targetUrl,
              requestHash: replayKey.requestHash,
              statusCode,
              headers: buildResponseHeaders(upstream),
              bodyBase64: clientBody.toString("base64"),
              inputTokens: tokenUsage.inputTokens ?? 0,
              outputTokens: tokenUsage.outputTokens ?? 0,
              cachedInputTokens: tokenUsage.cachedInputTokens,
              cacheCreationInputTokens: tokenUsage.cacheCreationInputTokens,
              cacheReadInputTokens: tokenUsage.cacheReadInputTokens,
              reasoningOutputTokens: tokenUsage.reasoningOutputTokens,
              containsToolCall: responseReplaySafety.containsToolCall,
              ...(responseReplaySafety.toolCalls.length > 0
                ? { toolCalls: responseReplaySafety.toolCalls }
                : {}),
              runId: replayKey.runId,
              candidateId: replayKey.candidateId,
              createdAt: new Date().toISOString(),
              replayCount: 0
            });
          }
          writeUpstreamResponse(response, upstream, clientBody);
        }
        return;
      } catch (error) {
        if (error instanceof ProviderUsageRecordingError) {
          if (!response.headersSent) {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({
              error: "provider usage accounting is unavailable"
            }));
          } else if (!response.writableEnded) {
            response.destroy();
          }
          return;
        }
        if (
          governedEnterprise &&
          dispatchCommitted &&
          dispatchIntent &&
          association.trustedAssociation
        ) {
          const unknownReason = providerUnknownReason(error, dispatchPhase);
          const unknownStatusCode = error instanceof ProviderDispatchUnknownError
            ? error.statusCode
            : dispatchPhase !== "fetch" && statusCode >= 100 && statusCode <= 999
              ? statusCode
              : undefined;
          if (!this.markProviderUsageAttemptUnknown) {
            writeJsonError(response, 503, {
              error: "provider usage accounting is unavailable"
            });
            if (response.headersSent && !response.writableEnded) response.destroy();
            return;
          }
          const unknownIntent: ProviderUsageUnknownIntent = Object.freeze({
            ...dispatchIntent,
            reason: unknownReason,
            observedAt: new Date().toISOString(),
            ...(unknownStatusCode === undefined
              ? {}
              : { statusCode: unknownStatusCode })
          });
          try {
            await this.markProviderUsageAttemptUnknown(
              association.trustedAssociation,
              unknownIntent
            );
          } catch {
            writeJsonError(response, 503, {
              error: "provider usage accounting is unavailable"
            });
            if (response.headersSent && !response.writableEnded) response.destroy();
            return;
          }
          if (!response.headersSent) {
            writeJsonError(
              response,
              unknownReason === "timeout" ? 504 : 503,
              { error: "provider result is unavailable" }
            );
          } else if (!response.writableEnded) {
            response.destroy();
          }
          return;
        }
        lastError = error;
        statusCode = isAbortError(error) ? 504 : statusCode;
        const message = error instanceof Error ? error.message : String(error);
        try {
          await this.recordAttempt({
            app,
            resolved,
            model,
            statusCode,
            startedAt: attemptStartedAt,
            ok: false,
            retryable: true,
            logicalRequestId,
            attemptIndex,
            terminal: !hasFallback || response.headersSent,
            runId: association.runId,
            candidateId: association.candidateId,
            trustedAssociation: association.trustedAssociation,
            error: message
          });
        } catch (recordingError) {
          if (!response.headersSent) {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({
              error: "provider usage accounting is unavailable"
            }));
          } else if (!response.writableEnded) {
            response.destroy();
          }
          return;
        }
        if (hasFallback && !response.headersSent) continue;
        if (!response.headersSent) {
          response.writeHead(statusCode, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: message }));
        } else if (!response.writableEnded) {
          response.destroy(error instanceof Error ? error : undefined);
        }
        return;
      } finally {
        upstreamDispatch?.dispose();
      }
    }

    const message = lastError instanceof Error ? lastError.message : "upstream request failed";
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: message }));
  }

  private async resolveCandidates(
    app: ManagedAgentApp,
    association?: TrustedProxyUsageAssociation
  ): Promise<ResolvedProxyProvider[]> {
    if (this.resolveProviders) {
      return this.resolveProviders(app, association);
    }
    const resolved = await this.resolveProvider(app, association);
    return resolved ? [resolved] : [];
  }

  private async recordAttempt(input: {
    app: ManagedAgentApp;
    resolved: ResolvedProxyProvider;
    model: string;
    statusCode: number;
    startedAt: number;
    ok: boolean;
    retryable: boolean;
    logicalRequestId: string;
    attemptIndex: number;
    terminal: boolean;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    reasoningOutputTokens?: number;
    runId?: string;
    candidateId?: string;
    trustedAssociation?: TrustedProxyUsageAssociation;
    error?: string;
    replayed?: boolean;
    containsToolCall?: boolean;
    toolCalls?: ProxyReplayToolCall[];
    recordHealth?: boolean;
  }): Promise<void> {
    const latencyMs = Date.now() - input.startedAt;
    try {
      const log = toRequestLog({
        app: input.app,
        providerId: input.resolved.provider.id,
        model: input.model,
        statusCode: input.statusCode,
        latencyMs,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        cachedInputTokens: input.cachedInputTokens,
        cacheCreationInputTokens: input.cacheCreationInputTokens,
        cacheReadInputTokens: input.cacheReadInputTokens,
        reasoningOutputTokens: input.reasoningOutputTokens,
        runId: input.runId,
        candidateId: input.candidateId,
        trustedAssociation: input.trustedAssociation,
        replayed: input.replayed,
        containsToolCall: input.containsToolCall,
        toolCalls: input.toolCalls,
        usageAttempt: {
          schemaVersion: 1,
          logicalRequestId: input.logicalRequestId,
          index: input.attemptIndex,
          terminal: input.terminal,
          outcome:
            input.ok && input.statusCode >= 200 && input.statusCode < 400
              ? "succeeded"
              : "failed",
          retryable: input.retryable
        }
      });
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await this.appendLog(log);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError !== undefined) throw lastError;
    } catch (error) {
      throw new ProviderUsageRecordingError(error);
    }
    if (input.recordHealth === false) return;
    try {
      await this.recordProviderHealth?.({
        app: input.app,
        providerId: input.resolved.provider.id,
        ok: input.ok,
        statusCode: input.statusCode,
        latencyMs,
        retryable: input.retryable,
        error: input.error
      });
    } catch {
      // Health projection is non-authoritative. Usage has already been durably
      // appended and must never be duplicated because that projection failed.
    }
  }

  private async readReplayRecord(
    key: string
  ): Promise<ProxyReplayRecord | undefined> {
    if (!this.getReplay) return undefined;
    try {
      return await this.getReplay(key);
    } catch {
      return undefined;
    }
  }

  private async saveReplayRecord(record: ProxyReplayRecord): Promise<void> {
    if (!this.saveReplay) return;
    try {
      await this.saveReplay(record);
    } catch {
      // Replay caching is best effort; provider responses should still reach the client.
    }
  }

  private async markReplayRecordUsed(key: string): Promise<void> {
    if (!this.markReplayUsed) return;
    try {
      await this.markReplayUsed(key);
    } catch {
      // Replay accounting is best effort.
    }
  }
}

function detectApp(request: IncomingMessage, requestUrl: string): ManagedAgentApp {
  const header = request.headers["x-mn-app"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === "claude" || value === "codex") return value;
  const path = requestUrl.split("?")[0] ?? requestUrl;
  if (
    path === "/messages" ||
    path === "/v1/messages" ||
    path.startsWith("/anthropic") ||
    path.startsWith("/claude")
  ) {
    return "claude";
  }
  return "codex";
}

interface RequestAssociation {
  runId?: string;
  candidateId?: string;
  trustedAssociation?: TrustedProxyUsageAssociation;
}

async function readRequestAssociation(input: {
  request: IncomingMessage;
  route: AssociatedRequestUrl;
  verifyReceipt?: LocalProxyOptions["verifyUsageAssociationReceipt"];
  requireTrusted: boolean;
}): Promise<RequestAssociation> {
  if (input.route.usageReceipt) {
    if (!input.verifyReceipt) {
      throw new ProviderUsageReceiptVerificationUnavailableError();
    }
    const trustedAssociation = await input.verifyReceipt(input.route.usageReceipt);
    return {
      runId: trustedAssociation.runId,
      candidateId: trustedAssociation.candidateId,
      trustedAssociation
    };
  }
  if (input.requireTrusted) {
    throw new TypeError("trusted provider usage association receipt is required");
  }
  const runId = readHeaderString(input.request, "x-mn-run-id");
  const candidateId = readHeaderString(input.request, "x-mn-candidate-id");
  return {
    ...(input.route.runId ? { runId: input.route.runId } : {}),
    ...(input.route.candidateId ? { candidateId: input.route.candidateId } : {}),
    ...(runId ? { runId } : {}),
    ...(candidateId ? { candidateId } : {})
  };
}

interface AssociatedRequestUrl {
  requestUrl: string;
  runId?: string;
  candidateId?: string;
  usageReceipt?: string;
}

function parseAssociatedRequestUrl(requestUrl: string): AssociatedRequestUrl {
  const parsed = new URL(requestUrl, "http://mn-proxy.local");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    segments.length >= 3 &&
    segments[0] === "mn" &&
    segments[1] === "usage-receipts"
  ) {
    const receipt = safeDecodePathSegment(segments[2]!);
    const rest = segments.slice(3);
    const path = rest.length > 0 ? `/${rest.join("/")}` : "/";
    return {
      requestUrl: `${path}${parsed.search}`,
      usageReceipt: receipt
    };
  }
  if (
    segments.length < 6 ||
    segments[0] !== "mn" ||
    segments[1] !== "runs" ||
    segments[3] !== "candidates"
  ) {
    return { requestUrl };
  }

  const rest = segments.slice(5);
  const path = rest.length > 0 ? `/${rest.join("/")}` : "/";
  return {
    requestUrl: `${path}${parsed.search}`,
    runId: safeDecodePathSegment(segments[2]!),
    candidateId: safeDecodePathSegment(segments[4]!)
  };
}

interface ReplayKeyParts {
  key: string;
  requestHash: string;
  runId: string;
  candidateId: string;
}

function buildEnterpriseReplayKey(input: {
  app: ManagedAgentApp;
  providerId: string;
  runId: string;
  candidateId: string;
  callerIdempotencyKeyDigest: string;
  requestDigest: string;
  providerPlanDigest: string;
  method: string;
  targetUrl: string;
  body: Buffer;
}): ReplayKeyParts {
  const requestHash = sha256(input.body);
  const key = sha256(Buffer.from(JSON.stringify({
    version: 2,
    domain: "mn-enterprise-caller-idempotency-replay",
    app: input.app,
    providerId: input.providerId,
    runId: input.runId,
    candidateId: input.candidateId,
    callerIdempotencyKeyDigest: input.callerIdempotencyKeyDigest,
    requestDigest: input.requestDigest,
    providerPlanDigest: input.providerPlanDigest,
    method: input.method.toUpperCase(),
    targetUrl: input.targetUrl,
    requestHash
  })));
  return {
    key,
    requestHash,
    runId: input.runId,
    candidateId: input.candidateId
  };
}

function buildReplayKey(input: {
  app: ManagedAgentApp;
  providerId: string;
  runId?: string;
  candidateId?: string;
  method: string;
  targetUrl: string;
  body: Buffer;
}): ReplayKeyParts | undefined {
  if (!input.runId || !input.candidateId) return undefined;
  const requestHash = sha256(input.body);
  const key = sha256(Buffer.from(JSON.stringify({
    version: 1,
    app: input.app,
    providerId: input.providerId,
    runId: input.runId,
    candidateId: input.candidateId,
    method: input.method.toUpperCase(),
    targetUrl: input.targetUrl,
    requestHash
  })));
  return {
    key,
    requestHash,
    runId: input.runId,
    candidateId: input.candidateId
  };
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function shouldStoreReplay(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function shouldUseReplayRecord(
  record: ProxyReplayRecord,
  provider: ResolvedProxyProvider["provider"]
): boolean {
  return evaluateReplayRecordSafety(record, provider).replaySafe;
}

function evaluateReplayRecordSafety(
  record: ProxyReplayRecord,
  provider: ResolvedProxyProvider["provider"]
): ReplaySafetyEvaluation {
  const body = Buffer.from(record.bodyBase64, "base64");
  const detection = detectResponseToolCalls(body);
  const storedNames = Array.isArray(record.toolCalls)
    ? record.toolCalls.map((toolCall) => normalizeToolName(toolCall.name)).filter(Boolean)
    : [];
  return evaluateReplayToolCalls({
    containsToolCall: record.containsToolCall ?? detection.containsToolCall,
    names: storedNames.length > 0 ? storedNames : detection.names
  }, provider);
}

function evaluateReplaySafety(
  body: Buffer,
  provider: ResolvedProxyProvider["provider"]
): ReplaySafetyEvaluation {
  return evaluateReplayToolCalls(detectResponseToolCalls(body), provider);
}

function emptyReplaySafety(): ReplaySafetyEvaluation {
  return { containsToolCall: false, toolCalls: [], replaySafe: true };
}

function evaluateReplayToolCalls(
  detection: { containsToolCall: boolean; names: string[] },
  provider: ResolvedProxyProvider["provider"]
): ReplaySafetyEvaluation {
  if (!detection.containsToolCall) return emptyReplaySafety();
  const policy = readToolReplayPolicy(provider.config);
  if (!policy) {
    const replaySafe = provider.config.replayToolCalls === true;
    return {
      containsToolCall: true,
      replaySafe,
      toolCalls: detection.names.map((name) => ({
        name,
        effect: "unknown",
        replaySafe
      }))
    };
  }
  const toolCalls = detection.names.map((name) => {
    const effect = policy.get(name) ?? "unknown";
    return {
      name,
      effect,
      replaySafe: isReplaySafeToolEffect(effect)
    };
  });
  return {
    containsToolCall: true,
    toolCalls,
    replaySafe: toolCalls.length > 0 && toolCalls.every((toolCall) => toolCall.replaySafe)
  };
}

function readToolReplayPolicy(
  config: Record<string, unknown>
): Map<string, ProxyToolReplayEffect> | undefined {
  const value = config.toolReplayPolicy;
  if (!isRecord(value)) return undefined;
  const tools = new Map<string, ProxyToolReplayEffect>();
  const toolMap = value.tools;
  if (isRecord(toolMap)) {
    for (const [rawName, rawEffect] of Object.entries(toolMap)) {
      const name = normalizeToolName(rawName);
      const effect = normalizeToolReplayEffect(rawEffect);
      if (name && effect) tools.set(name, effect);
    }
  }
  addToolReplayPolicyList(tools, value.readonlyTools, "readonly");
  addToolReplayPolicyList(tools, value.idempotentTools, "idempotent");
  addToolReplayPolicyList(tools, value.sideEffectTools, "side_effect");
  return tools;
}

function addToolReplayPolicyList(
  tools: Map<string, ProxyToolReplayEffect>,
  value: unknown,
  effect: ProxyToolReplayEffect
): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const name = normalizeToolName(item);
    if (name) tools.set(name, effect);
  }
}

function normalizeToolReplayEffect(value: unknown): ProxyToolReplayEffect | undefined {
  if (value === "readonly" || value === "read_only") return "readonly";
  if (value === "idempotent") return "idempotent";
  if (value === "side_effect" || value === "side-effect" || value === "effectful") {
    return "side_effect";
  }
  if (value === "unknown") return "unknown";
  return undefined;
}

function isReplaySafeToolEffect(effect: ProxyToolReplayEffect): boolean {
  return effect === "readonly" || effect === "idempotent";
}

function applyProviderIdempotencyHeader(
  headers: Headers,
  provider: ResolvedProxyProvider["provider"],
  outboundIdempotencyKey: string
): void {
  const headerName = readProviderConfigString(provider.config, "idempotencyHeaderName");
  if (!headerName || !isValidHeaderName(headerName) || headers.has(headerName)) return;
  headers.set(headerName, outboundIdempotencyKey);
}

function applyEnterpriseProviderIdempotencyHeader(
  headers: Headers,
  provider: ResolvedProxyProvider["provider"],
  outboundIdempotencyKey: string
): {
  strength: "none" | "strong";
  headerName?: string;
  keyDigest?: string;
} {
  const legacyHeaderName = readProviderConfigString(
    provider.config,
    "idempotencyHeaderName"
  );
  const capability = provider.enterpriseCapabilities?.idempotency;
  if (
    capability &&
    (capability.strength !== "strong" ||
      !isSafeEnterpriseIdempotencyHeaderName(capability.headerName))
  ) {
    throw new TypeError("provider strong idempotency capability is invalid");
  }
  const candidateHeaderNames = new Set<string>(["idempotency-key"]);
  if (legacyHeaderName && isSafeEnterpriseIdempotencyHeaderName(legacyHeaderName)) {
    candidateHeaderNames.add(legacyHeaderName);
  }
  if (capability?.headerName) {
    candidateHeaderNames.add(capability.headerName);
  }
  for (const headerName of candidateHeaderNames) headers.delete(headerName);
  if (!capability) return { strength: "none" };
  headers.set(capability.headerName, outboundIdempotencyKey);
  const actual = headers.get(capability.headerName);
  if (actual !== outboundIdempotencyKey) {
    throw new TypeError("provider idempotency wire header is unavailable");
  }
  return {
    strength: "strong",
    headerName: capability.headerName.toLowerCase(),
    keyDigest: sha256(Buffer.from(actual, "utf8"))
  };
}

function providerOutboundIdempotencyKey(input: {
  logicalRequestId: string;
  attemptIndex: number;
  providerId: string;
}): string {
  return `mn-${sha256(Buffer.from(JSON.stringify({
    domain: "mn-provider-outbound-v1",
    logicalRequestId: input.logicalRequestId,
    attemptIndex: input.attemptIndex,
    providerId: input.providerId
  })))}`;
}

function readProviderConfigString(
  config: Record<string, unknown>,
  key: string
): string | undefined {
  const value = config[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function isValidHeaderName(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

function isSafeEnterpriseIdempotencyHeaderName(value: string): boolean {
  if (!isValidHeaderName(value)) return false;
  return /^(?:idempotency-key|x-[a-z0-9-]*idempotency(?:-key)?)$/iu.test(value);
}

function providerAccountId(provider: ResolvedProxyProvider["provider"]): string {
  return readProviderConfigString(provider.config, "providerAccountId") ?? provider.id;
}

function providerCallerIdempotencyKeyDigest(input: {
  association: TrustedProxyUsageAssociation;
  app: ManagedAgentApp;
  key: string;
}): string {
  return sha256(Buffer.from(JSON.stringify({
    domain: "mn-enterprise-caller-idempotency-v1",
    tenantId: input.association.tenantId,
    runId: input.association.runId,
    candidateId: input.association.candidateId,
    app: input.app,
    key: input.key
  })));
}

function isProviderUsageReservationDecision(
  value: TrustedProxyUsageAssociation | ProviderUsageReservationDecision
): value is ProviderUsageReservationDecision {
  return "kind" in value;
}

function authoritativeUsageState(body: Buffer): "complete" | "partial" | "missing" {
  const parsed = parseJsonValue(body.toString("utf8"));
  if (!isRecord(parsed)) return "missing";
  const usage = isRecord(parsed.usage) ? parsed.usage : parsed;
  const valid = (field: string): boolean =>
    typeof usage[field] === "number" &&
    Number.isSafeInteger(usage[field]) &&
    (usage[field] as number) >= 0;
  const inputPresent = ["input_tokens", "prompt_tokens", "inputTokens"]
    .some((field) => valid(field));
  const outputPresent = ["output_tokens", "completion_tokens", "outputTokens"]
    .some((field) => valid(field));
  const anyUsage = Object.keys(usage).some((field) =>
    /token/i.test(field) && valid(field)
  );
  return classifyHttpUsageV1({
    observed: anyUsage,
    ...(inputPresent ? { inputTokens: 0 } : {}),
    ...(outputPresent ? { outputTokens: 0 } : {})
  }).state;
}

function authoritativeEventStreamUsage(body: Buffer): {
  state: "complete" | "partial" | "missing";
  usage?: TokenUsage;
} {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let cacheReadInputTokens: number | undefined;
  let reasoningOutputTokens: number | undefined;
  let sawUsage = false;
  let sawTerminalMarker = false;
  for (const frame of body.toString("utf8").split(/\r?\n\r?\n/u)) {
    const data = readSseData(frame);
    if (data === "[DONE]") {
      sawTerminalMarker = true;
      continue;
    }
    if (!data) continue;
    const parsed = parseJsonValue(data);
    if (!isRecord(parsed)) continue;
    const eventType = typeof parsed.type === "string" ? parsed.type : undefined;
    if (
      eventType === "response.completed" ||
      eventType === "message_stop" ||
      eventType === "message.stop"
    ) {
      sawTerminalMarker = true;
    }
    const sources = [
      parsed.usage,
      isRecord(parsed.message) ? parsed.message.usage : undefined,
      isRecord(parsed.response) ? parsed.response.usage : undefined,
      isRecord(parsed.delta) ? parsed.delta.usage : undefined
    ].filter(isRecord);
    for (const source of sources) {
      const valid = (names: string[]): number | undefined => {
        for (const name of names) {
          const value = source[name];
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
            return value;
          }
        }
        return undefined;
      };
      const nextInput = valid(["input_tokens", "prompt_tokens", "inputTokens"]);
      const nextOutput = valid(["output_tokens", "completion_tokens", "outputTokens"]);
      if (nextInput !== undefined) inputTokens = nextInput;
      if (nextOutput !== undefined) outputTokens = nextOutput;
      cachedInputTokens = valid(["cached_input_tokens"]) ?? cachedInputTokens;
      cacheCreationInputTokens = valid(["cache_creation_input_tokens"]) ?? cacheCreationInputTokens;
      cacheReadInputTokens = valid(["cache_read_input_tokens"]) ?? cacheReadInputTokens;
      reasoningOutputTokens = valid(["reasoning_output_tokens"]) ?? reasoningOutputTokens;
      sawUsage = sawUsage || Object.keys(source).some((name) => /token/iu.test(name));
    }
  }
  const classification = classifyHttpUsageV1({
    observed: sawUsage,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens })
  });
  if (classification.state !== "complete") return { state: classification.state };
  if (inputTokens === undefined || outputTokens === undefined) {
    throw new TypeError("complete provider usage is missing aggregate counters");
  }
  if (!sawTerminalMarker) {
    // A clean HTTP EOF is not an application-level SSE completion signal.
    // Settling here would turn a truncated stream that happened to emit usage
    // early into an authoritative success.
    return { state: "partial" };
  }
  return {
    state: "complete",
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
      ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
      ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens })
    }
  };
}

function providerRequestSemanticDigest(
  routed: ReturnType<typeof routeRequest>,
  key: Buffer
): string {
  const excluded = new Set([
    "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
    "traceparent", "tracestate", "user-agent", "x-request-id"
  ]);
  const headers = [...routed.headers.entries()]
    .filter(([name]) => {
      const normalized = name.toLowerCase();
      return !excluded.has(normalized) && !normalized.startsWith("x-mn-") &&
        normalized !== "idempotency-key";
    })
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHmac("sha256", key).update(JSON.stringify({
    schemaVersion: 1,
    targetUrl: routed.targetUrl,
    bodyDigest: sha256(routed.body),
    headers
  })).digest("hex");
}

function isJsonObjectBody(body: Buffer): boolean {
  try {
    return isRecord(JSON.parse(body.toString("utf8")) as unknown);
  } catch {
    return false;
  }
}

function providerUnknownReason(
  error: unknown,
  phase: ProviderDispatchPhase | undefined
): ProviderUsageUnknownReason {
  if (error instanceof ProviderDispatchUnknownError) return error.reason;
  if (phase === "fetch") return isAbortError(error) ? "timeout" : "connection_error";
  if (phase === "response_read") return "response_read_error";
  if (phase === "response_conversion") return "response_conversion_error";
  if (phase === "stream") return "stream_interrupted";
  return "connection_error";
}

function detectResponseToolCalls(body: Buffer): { containsToolCall: boolean; names: string[] } {
  const text = body.toString("utf8");
  const names = new Set<string>();
  const json = parseJsonValue(text);
  const jsonHasToolCall = json ? collectJsonToolCallNames(json, names) : false;
  const sseHasToolCall = collectSseToolCallNames(text, names);
  const containsToolCall =
    jsonHasToolCall ||
    sseHasToolCall ||
    /"tool_calls"|"tool_use"|"function_call"/.test(text);
  return {
    containsToolCall,
    names: [...names].sort()
  };
}

function collectSseToolCallNames(text: string, names: Set<string>): boolean {
  let containsToolCall = false;
  for (const block of text.split(/\n\n+/)) {
    let eventName = "";
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
        if (eventName.includes("function_call")) containsToolCall = true;
      }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") continue;
      const json = parseJsonValue(payload);
      if (json && collectJsonToolCallNames(json, names)) containsToolCall = true;
    }
  }
  return containsToolCall;
}

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function collectJsonToolCallNames(value: unknown, names: Set<string>): boolean {
  if (Array.isArray(value)) {
    let containsToolCall = false;
    for (const item of value) {
      if (collectJsonToolCallNames(item, names)) containsToolCall = true;
    }
    return containsToolCall;
  }
  if (!isRecord(value)) return false;
  let containsToolCall = false;
  if (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) {
    containsToolCall = true;
    for (const item of value.tool_calls) {
      if (!isRecord(item)) continue;
      const name = readToolCallName(item);
      if (name) names.add(name);
    }
  }
  const type = readString(value.type);
  if (type === "tool_use" || type === "function_call") {
    containsToolCall = true;
    const name = readToolCallName(value);
    if (name) names.add(name);
  }
  const stopReason = readString(value.stop_reason) ?? readString(value.finish_reason);
  if (stopReason === "tool_use" || stopReason === "tool_calls") containsToolCall = true;
  for (const nested of Object.values(value)) {
    if (collectJsonToolCallNames(nested, names)) containsToolCall = true;
  }
  return containsToolCall;
}

function readToolCallName(value: Record<string, unknown>): string | undefined {
  const directName = normalizeToolName(value.name);
  if (directName) return directName;
  const fn = value.function;
  if (isRecord(fn)) return normalizeToolName(fn.name);
  return undefined;
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeDecodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readHeaderString(
  request: IncomingMessage,
  name: string
): string | undefined {
  const header = request.headers[name];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() || undefined;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function assertResolvedCandidates(
  candidates: unknown,
  app: ManagedAgentApp
): asserts candidates is ResolvedProxyProvider[] {
  if (!Array.isArray(candidates)) {
    throw new TypeError("provider resolution did not return a candidate list");
  }
  for (const candidate of candidates) {
    let providerUrl: URL | undefined;
    try {
      providerUrl = new URL((candidate as ResolvedProxyProvider).provider?.baseUrl);
    } catch {
      // Rejected by the common invalid-candidate branch below.
    }
    if (
      !candidate ||
      typeof candidate !== "object" ||
      (candidate as ResolvedProxyProvider).app !== app ||
      !(candidate as ResolvedProxyProvider).provider ||
      typeof (candidate as ResolvedProxyProvider).provider.id !== "string" ||
      !(candidate as ResolvedProxyProvider).provider.id.trim() ||
      typeof (candidate as ResolvedProxyProvider).provider.baseUrl !== "string" ||
      !(candidate as ResolvedProxyProvider).provider.baseUrl.trim() ||
      (providerUrl?.protocol !== "http:" && providerUrl?.protocol !== "https:")
    ) {
      throw new TypeError("provider resolution returned an invalid candidate");
    }
  }
}

function assertReservedAssociation(
  verified: TrustedProxyUsageAssociation,
  reserved: TrustedProxyUsageAssociation
): void {
  if (
    verified.reservationId !== undefined ||
    typeof reserved?.reservationId !== "string" ||
    !reserved.reservationId.trim()
  ) {
    throw new TypeError("provider usage reservation identity is invalid");
  }
  const immutableBindings = [
    "schemaVersion",
    "issuer",
    "tenantId",
    "runId",
    "candidateId",
    "workerId",
    "claimDigest",
    "receiptDigest",
    "issuedAt",
    "expiresAt",
    "verifiedAt"
  ] as const;
  for (const binding of immutableBindings) {
    if (reserved[binding] !== verified[binding]) {
      throw new TypeError(`provider usage reservation changed ${binding}`);
    }
  }
}

function writeJsonError(
  response: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, unknown>>
): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function buildHeaders(
  request: IncomingMessage,
  resolved: ResolvedProxyProvider
): Headers {
  const headers = new Headers();
  for (const [key, rawValue] of Object.entries(request.headers)) {
    if (!rawValue || key === "host" || key === "content-length") continue;
    if (key.startsWith("x-mn-")) continue;
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) headers.append(key, value);
    } else {
      headers.set(key, rawValue);
    }
  }
  if (resolved.bearerToken) {
    headers.set("authorization", `Bearer ${resolved.bearerToken}`);
    if (resolved.app === "claude") {
      headers.set("x-api-key", resolved.bearerToken);
    }
  }
  return headers;
}

function routeRequest(input: {
  requestUrl: string;
  requestBody: Buffer;
  headers: Headers;
  resolved: ResolvedProxyProvider;
}): {
  targetUrl: string;
  body: Buffer;
  headers: Headers;
  responseConversion?: ResponseConversion;
} {
  if (shouldConvertClaudeMessagesToChat(input.requestUrl, input.resolved)) {
    const chatBody = convertAnthropicMessagesToChatCompletion(
      input.requestBody,
      input.resolved.provider.defaultModel
    );
    const chatPath = chatCompletionsPathFor(input.requestUrl);
    input.headers.set("content-type", "application/json");
    return {
      targetUrl: joinUrl(input.resolved.provider.baseUrl, chatPath),
      body: Buffer.from(JSON.stringify(chatBody)),
      headers: input.headers,
      responseConversion: "chat_to_anthropic"
    };
  }
  if (shouldConvertClaudeMessagesToResponses(input.requestUrl, input.resolved)) {
    const responsesBody = convertAnthropicMessagesToResponses(
      input.requestBody,
      input.resolved.provider.defaultModel
    );
    const responsesPath = responsesPathFor(input.requestUrl);
    input.headers.set("content-type", "application/json");
    return {
      targetUrl: joinUrl(input.resolved.provider.baseUrl, responsesPath),
      body: Buffer.from(JSON.stringify(responsesBody)),
      headers: input.headers,
      responseConversion: "responses_to_anthropic"
    };
  }
  if (shouldConvertCodexResponsesToChat(input.requestUrl, input.resolved)) {
    const chatBody = convertResponsesToChatCompletion(input.requestBody);
    const chatPath = chatCompletionsPathFor(input.requestUrl);
    input.headers.set("content-type", "application/json");
    return {
      targetUrl: joinUrl(input.resolved.provider.baseUrl, chatPath),
      body: Buffer.from(JSON.stringify(chatBody)),
      headers: input.headers,
      responseConversion: "chat_to_responses"
    };
  }
  return {
    targetUrl: joinUrl(input.resolved.provider.baseUrl, input.requestUrl),
    body: input.requestBody,
    headers: input.headers
  };
}

function shouldConvertClaudeMessagesToChat(
  requestUrl: string,
  resolved: ResolvedProxyProvider
): boolean {
  const path = requestUrl.split("?")[0] ?? requestUrl;
  return (
    resolved.app === "claude" &&
    resolved.provider.apiFormat === "openai_chat" &&
    (path === "/messages" || path === "/v1/messages")
  );
}

function shouldConvertClaudeMessagesToResponses(
  requestUrl: string,
  resolved: ResolvedProxyProvider
): boolean {
  const path = requestUrl.split("?")[0] ?? requestUrl;
  return (
    resolved.app === "claude" &&
    resolved.provider.apiFormat === "openai_responses" &&
    (path === "/messages" || path === "/v1/messages")
  );
}

function shouldConvertCodexResponsesToChat(
  requestUrl: string,
  resolved: ResolvedProxyProvider
): boolean {
  const path = requestUrl.split("?")[0] ?? requestUrl;
  return (
    resolved.app === "codex" &&
    resolved.provider.apiFormat === "openai_chat" &&
    (path === "/responses" || path === "/v1/responses")
  );
}

function chatCompletionsPathFor(requestUrl: string): string {
  const path = requestUrl.split("?")[0] ?? requestUrl;
  return path.startsWith("/v1/")
    ? "/v1/chat/completions"
    : "/chat/completions";
}

function responsesPathFor(requestUrl: string): string {
  const path = requestUrl.split("?")[0] ?? requestUrl;
  return path.startsWith("/v1/")
    ? "/v1/responses"
    : "/responses";
}

function convertResponsesToChatCompletion(body: Buffer): Record<string, unknown> {
  const parsed = parseJsonObject(body);
  const messages: Array<Record<string, unknown>> = [];
  const instructions = readString(parsed.instructions);
  const stream = readBoolean(parsed.stream) ?? false;
  if (instructions) messages.push({ role: "system", content: instructions });
  messages.push(...responsesInputToMessages(parsed.input));
  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }
  const tools = responsesToolsToChatTools(parsed.tools);
  const toolChoice = responsesToolChoiceToChat(parsed.tool_choice);
  return {
    model: readString(parsed.model) ?? "unknown",
    messages,
    stream,
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(readNumber(parsed.temperature) !== undefined ? { temperature: readNumber(parsed.temperature) } : {}),
    ...(readNumber(parsed.max_output_tokens) !== undefined
      ? { max_tokens: readNumber(parsed.max_output_tokens) }
      : {}),
    ...(readNumber(parsed.top_p) !== undefined ? { top_p: readNumber(parsed.top_p) } : {})
  };
}

function convertChatCompletionToResponses(body: Buffer): Buffer {
  const parsed = parseJsonObject(body);
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(firstChoice.message) ? firstChoice.message : {};
  const text = extractTextContent(message.content);
  const output = chatMessageToResponsesOutput(message, text);
  const usage = normalizeChatUsageForResponses(parsed.usage);
  return Buffer.from(JSON.stringify({
    id: readString(parsed.id) ?? `resp_${randomUUID()}`,
    object: "response",
    created_at: readNumber(parsed.created) ?? Math.floor(Date.now() / 1000),
    model: readString(parsed.model) ?? "unknown",
    output,
    output_text: text,
    stop_reason: readString(firstChoice.finish_reason),
    usage
  }));
}

function convertAnthropicMessagesToChatCompletion(
  body: Buffer,
  defaultModel: string
): Record<string, unknown> {
  const parsed = parseJsonObject(body);
  const messages: Array<Record<string, unknown>> = [];
  const system = extractAnthropicTextContent(parsed.system);
  if (system) messages.push({ role: "system", content: system });
  messages.push(...anthropicMessagesToChatMessages(parsed.messages));
  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }
  const stop = readStringArray(parsed.stop_sequences);
  const tools = anthropicToolsToChatTools(parsed.tools);
  const toolChoice = anthropicToolChoiceToChat(parsed.tool_choice);
  return {
    model: defaultModel || readString(parsed.model) || "unknown",
    messages,
    stream: readBoolean(parsed.stream) ?? false,
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(readNumber(parsed.max_tokens) !== undefined
      ? { max_tokens: readNumber(parsed.max_tokens) }
      : {}),
    ...(readNumber(parsed.temperature) !== undefined ? { temperature: readNumber(parsed.temperature) } : {}),
    ...(readNumber(parsed.top_p) !== undefined ? { top_p: readNumber(parsed.top_p) } : {}),
    ...(stop.length > 0 ? { stop } : {})
  };
}

function convertAnthropicMessagesToResponses(
  body: Buffer,
  defaultModel: string
): Record<string, unknown> {
  const parsed = parseJsonObject(body);
  const input = anthropicMessagesToResponsesInput(parsed.messages);
  const instructions = extractAnthropicTextContent(parsed.system);
  const tools = anthropicToolsToResponsesTools(parsed.tools);
  const toolChoice = anthropicToolChoiceToResponses(parsed.tool_choice);
  return {
    model: defaultModel || readString(parsed.model) || "unknown",
    input: input.length > 0 ? input : "",
    stream: readBoolean(parsed.stream) ?? false,
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(instructions ? { instructions } : {}),
    ...(readNumber(parsed.max_tokens) !== undefined
      ? { max_output_tokens: readNumber(parsed.max_tokens) }
      : {}),
    ...(readNumber(parsed.temperature) !== undefined ? { temperature: readNumber(parsed.temperature) } : {}),
    ...(readNumber(parsed.top_p) !== undefined ? { top_p: readNumber(parsed.top_p) } : {})
  };
}

function convertChatCompletionToAnthropicMessage(body: Buffer): Buffer {
  const parsed = parseJsonObject(body);
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(firstChoice.message) ? firstChoice.message : {};
  const content = chatMessageToAnthropicContent(message);
  const usage = normalizeChatUsageForAnthropic(parsed.usage);
  return Buffer.from(JSON.stringify({
    id: readString(parsed.id)?.replace(/^chatcmpl/, "msg") ?? `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: readString(parsed.model) ?? "unknown",
    content,
    stop_reason: mapChatFinishReasonToAnthropic(readString(firstChoice.finish_reason)),
    stop_sequence: null,
    usage
  }));
}

function convertResponsesToAnthropicMessage(body: Buffer): Buffer {
  const parsed = parseJsonObject(body);
  const usage = normalizeResponsesUsageForAnthropic(parsed.usage);
  const content = responsesOutputToAnthropicContent(parsed);
  return Buffer.from(JSON.stringify({
    id: readString(parsed.id)?.replace(/^resp/, "msg") ?? `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: readString(parsed.model) ?? "unknown",
    content,
    stop_reason: mapResponsesStopReasonToAnthropic(
      readResponsesStopReason(parsed) ?? (hasAnthropicToolUse(content) ? "tool_use" : undefined)
    ),
    stop_sequence: null,
    usage
  }));
}

function responsesInputToMessages(input: unknown): Array<Record<string, unknown>> {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input)) return [];
  const messages: Array<Record<string, unknown>> = [];
  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!isRecord(item)) continue;
    const type = readString(item.type);
    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: readString(item.call_id) ?? readString(item.id) ?? `call_${randomUUID()}`,
        content: extractTextContent(item.output ?? item.content)
      });
      continue;
    }
    if (type === "function_call") {
      const callId = readString(item.call_id) ?? readString(item.id) ?? `call_${randomUUID()}`;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: {
              name: readString(item.name) ?? "unknown_tool",
              arguments: readString(item.arguments) ?? stringifyToolArguments(item.arguments)
            }
          }
        ]
      });
      continue;
    }
    const role = normalizeChatRole(readString(item.role));
    const content = extractTextContent(item.content ?? item.text);
    if (content || role === "assistant") {
      messages.push({ role, content });
    }
  }
  return messages;
}

function anthropicMessagesToChatMessages(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return [];
  const output: Array<Record<string, unknown>> = [];
  for (const item of messages) {
    if (!isRecord(item)) continue;
    const role = readString(item.role) === "assistant" ? "assistant" : "user";
    if (role === "assistant") {
      const content = extractAnthropicTextContentWithoutTools(item.content);
      const toolCalls = anthropicToolUseBlocksToChatToolCalls(item.content);
      if (content || toolCalls.length > 0) {
        output.push({
          role: "assistant",
          content: content || (toolCalls.length > 0 ? null : ""),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        });
      }
      continue;
    }
    const content = extractAnthropicTextContentWithoutTools(item.content);
    if (content) output.push({ role: "user", content });
    output.push(...anthropicToolResultBlocksToChatMessages(item.content));
  }
  return output;
}

function anthropicMessagesToResponsesInput(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return [];
  const input: Array<Record<string, unknown>> = [];
  for (const item of messages) {
    if (!isRecord(item)) continue;
    const role = readString(item.role) === "assistant" ? "assistant" : "user";
    if (role === "assistant") {
      const content = extractAnthropicTextContentWithoutTools(item.content);
      if (content) input.push({ role, content });
      input.push(...anthropicToolUseBlocksToResponsesInput(item.content));
      continue;
    }
    const content = extractAnthropicTextContentWithoutTools(item.content);
    if (content) input.push({ role, content });
    input.push(...anthropicToolResultBlocksToResponsesInput(item.content));
  }
  return input;
}

function anthropicToolsToChatTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const name = readString(tool.name);
    if (!name) continue;
    result.push({
      type: "function",
      function: {
        name,
        ...(readString(tool.description) ? { description: readString(tool.description) } : {}),
        parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} }
      }
    });
  }
  return result;
}

function anthropicToolsToResponsesTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const name = readString(tool.name);
    if (!name) continue;
    result.push({
      type: "function",
      name,
      ...(readString(tool.description) ? { description: readString(tool.description) } : {}),
      parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} }
    });
  }
  return result;
}

function responsesToolsToChatTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (!isRecord(tool) || readString(tool.type) !== "function") continue;
    const name = readString(tool.name);
    if (!name) continue;
    result.push({
      type: "function",
      function: {
        name,
        ...(readString(tool.description) ? { description: readString(tool.description) } : {}),
        parameters: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} }
      }
    });
  }
  return result;
}

function anthropicToolChoiceToChat(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const type = readString(value.type);
  if (type === "auto") return "auto";
  if (type === "any") return "required";
  if (type === "none") return "none";
  if (type === "tool") {
    const name = readString(value.name);
    return name ? { type: "function", function: { name } } : undefined;
  }
  return undefined;
}

function anthropicToolChoiceToResponses(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const type = readString(value.type);
  if (type === "auto") return "auto";
  if (type === "any") return "required";
  if (type === "none") return "none";
  if (type === "tool") {
    const name = readString(value.name);
    return name ? { type: "function", name } : undefined;
  }
  return undefined;
}

function responsesToolChoiceToChat(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (readString(value.type) === "function") {
    const name = readString(value.name);
    return name ? { type: "function", function: { name } } : undefined;
  }
  return value;
}

function chatMessageToResponsesOutput(
  message: Record<string, unknown>,
  text: string
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  if (text) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text,
          annotations: []
        }
      ]
    });
  }
  output.push(...chatToolCallsToResponsesOutput(message.tool_calls));
  if (output.length === 0) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "",
          annotations: []
        }
      ]
    });
  }
  return output;
}

function chatMessageToAnthropicContent(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  const text = extractTextContent(message.content);
  if (text) content.push({ type: "text", text });
  content.push(...chatToolCallsToAnthropicContent(message.tool_calls));
  if (content.length === 0) content.push({ type: "text", text: "" });
  return content;
}

function responsesOutputToAnthropicContent(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  const outputText = readString(parsed.output_text);
  if (outputText) content.push({ type: "text", text: outputText });
  const output = Array.isArray(parsed.output) ? parsed.output : [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const type = readString(item.type);
    if (type === "function_call") {
      content.push(responsesFunctionCallToAnthropicToolUse(item));
      continue;
    }
    if (type !== "message" || outputText) continue;
    const text = extractTextContent(item.content ?? item.text);
    if (text) content.push({ type: "text", text });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return content;
}

function chatToolCallsToResponsesOutput(toolCalls: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(toolCalls)) return [];
  const output: Array<Record<string, unknown>> = [];
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall)) continue;
    const fn = isRecord(toolCall.function) ? toolCall.function : {};
    const callId = readString(toolCall.id) ?? `call_${randomUUID()}`;
    output.push({
      id: callId,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name: readString(fn.name) ?? "unknown_tool",
      arguments: readString(fn.arguments) ?? stringifyToolArguments(fn.arguments)
    });
  }
  return output;
}

function chatToolCallsToAnthropicContent(toolCalls: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(toolCalls)) return [];
  const content: Array<Record<string, unknown>> = [];
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall)) continue;
    const fn = isRecord(toolCall.function) ? toolCall.function : {};
    content.push({
      type: "tool_use",
      id: readString(toolCall.id) ?? `toolu_${randomUUID()}`,
      name: readString(fn.name) ?? "unknown_tool",
      input: parseToolArguments(fn.arguments)
    });
  }
  return content;
}

function responsesFunctionCallToAnthropicToolUse(item: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "tool_use",
    id: readString(item.call_id) ?? readString(item.id) ?? `toolu_${randomUUID()}`,
    name: readString(item.name) ?? "unknown_tool",
    input: parseToolArguments(item.arguments)
  };
}

function anthropicToolUseBlocksToChatToolCalls(content: unknown): Array<Record<string, unknown>> {
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const block of asArray(content)) {
    if (!isRecord(block) || readString(block.type) !== "tool_use") continue;
    const id = readString(block.id) ?? `toolu_${randomUUID()}`;
    toolCalls.push({
      id,
      type: "function",
      function: {
        name: readString(block.name) ?? "unknown_tool",
        arguments: stringifyToolArguments(block.input)
      }
    });
  }
  return toolCalls;
}

function anthropicToolUseBlocksToResponsesInput(content: unknown): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const block of asArray(content)) {
    if (!isRecord(block) || readString(block.type) !== "tool_use") continue;
    input.push({
      type: "function_call",
      call_id: readString(block.id) ?? `toolu_${randomUUID()}`,
      name: readString(block.name) ?? "unknown_tool",
      arguments: stringifyToolArguments(block.input)
    });
  }
  return input;
}

function anthropicToolResultBlocksToChatMessages(content: unknown): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const block of asArray(content)) {
    if (!isRecord(block) || readString(block.type) !== "tool_result") continue;
    messages.push({
      role: "tool",
      tool_call_id: readString(block.tool_use_id) ?? readString(block.id) ?? `toolu_${randomUUID()}`,
      content: extractAnthropicTextContent(block.content)
    });
  }
  return messages;
}

function anthropicToolResultBlocksToResponsesInput(content: unknown): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const block of asArray(content)) {
    if (!isRecord(block) || readString(block.type) !== "tool_result") continue;
    input.push({
      type: "function_call_output",
      call_id: readString(block.tool_use_id) ?? readString(block.id) ?? `toolu_${randomUUID()}`,
      output: extractAnthropicTextContent(block.content)
    });
  }
  return input;
}

function extractAnthropicTextContentWithoutTools(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    if (!isRecord(value)) return value === undefined ? "" : JSON.stringify(value);
    const type = readString(value.type);
    if (type === "tool_use" || type === "tool_result") return "";
    return readString(value.text) ?? extractAnthropicTextContentWithoutTools(value.content);
  }
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!isRecord(item)) continue;
    const type = readString(item.type);
    if (type === "tool_use" || type === "tool_result") continue;
    const text = readString(item.text) ?? readString(item.content);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function hasAnthropicToolUse(content: Array<Record<string, unknown>>): boolean {
  return content.some((item) => readString(item.type) === "tool_use");
}

function stringifyToolArguments(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function extractAnthropicTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    if (!isRecord(value)) return value === undefined || value === null ? "" : JSON.stringify(value);
    return readString(value.text) ?? extractAnthropicTextContent(value.content);
  }
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!isRecord(item)) continue;
    const type = readString(item.type);
    if (type === "text") {
      const text = readString(item.text);
      if (text) parts.push(text);
      continue;
    }
    if (type === "tool_result") {
      const text = extractAnthropicTextContent(item.content);
      if (text) parts.push(text);
      continue;
    }
    const text = readString(item.text) ?? readString(item.content);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function normalizeChatRole(role: string | undefined): string {
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return "system";
  return "user";
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    return value === undefined || value === null ? "" : JSON.stringify(value);
  }
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!isRecord(item)) continue;
    const text = readString(item.text) ?? readString(item.content);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function normalizeChatUsageForResponses(value: unknown): Record<string, unknown> {
  return responsesUsageFromTokenUsage(normalizeUsageFromJson(value));
}

function normalizeChatUsageForAnthropic(value: unknown): Record<string, unknown> {
  return anthropicUsageFromTokenUsage(normalizeUsageFromJson(value));
}

function normalizeResponsesUsageForAnthropic(value: unknown): Record<string, unknown> {
  return anthropicUsageFromTokenUsage(normalizeUsageFromJson(value));
}

function responsesUsageFromTokenUsage(usage: Partial<TokenUsage>): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ??
      (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.cacheCreationInputTokens ?? 0) +
        (usage.cacheReadInputTokens ?? 0),
    ...((usage.cachedInputTokens ?? 0) > 0 ||
    (usage.cacheCreationInputTokens ?? 0) > 0 ||
    (usage.cacheReadInputTokens ?? 0) > 0
      ? {
          input_tokens_details: {
            ...(usage.cachedInputTokens !== undefined
              ? { cached_tokens: usage.cachedInputTokens }
              : {}),
            ...(usage.cacheCreationInputTokens !== undefined
              ? { cache_creation_tokens: usage.cacheCreationInputTokens }
              : {}),
            ...(usage.cacheReadInputTokens !== undefined
              ? { cache_read_tokens: usage.cacheReadInputTokens }
              : {})
          }
        }
      : {}),
    ...((usage.reasoningOutputTokens ?? 0) > 0
      ? {
          output_tokens_details: {
            reasoning_tokens: usage.reasoningOutputTokens
          }
        }
      : {})
  };
}

function anthropicUsageFromTokenUsage(usage: Partial<TokenUsage>): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    ...((usage.cacheCreationInputTokens ?? 0) > 0
      ? { cache_creation_input_tokens: usage.cacheCreationInputTokens }
      : {}),
    ...((usage.cacheReadInputTokens ?? 0) > 0 || (usage.cachedInputTokens ?? 0) > 0
      ? { cache_read_input_tokens: usage.cacheReadInputTokens ?? usage.cachedInputTokens }
      : {}),
    ...((usage.reasoningOutputTokens ?? 0) > 0
      ? { reasoning_output_tokens: usage.reasoningOutputTokens }
      : {})
  };
}

function mapChatFinishReasonToAnthropic(value: string | undefined): string {
  if (value === "stop") return "end_turn";
  if (value === "length") return "max_tokens";
  if (value === "tool_calls") return "tool_use";
  return value ?? "end_turn";
}

function mapResponsesStopReasonToAnthropic(value: string | undefined): string {
  if (!value || value === "stop" || value === "end_turn") return "end_turn";
  if (value === "length" || value === "max_tokens" || value === "max_output_tokens") {
    return "max_tokens";
  }
  if (value === "tool_calls" || value === "tool_use") return "tool_use";
  return value;
}

function readResponsesStopReason(value: Record<string, unknown>): string | undefined {
  const incompleteDetails = isRecord(value.incomplete_details) ? value.incomplete_details : {};
  return readString(value.stop_reason) ??
    readString(incompleteDetails.reason) ??
    (readString(value.status) === "incomplete" ? "max_output_tokens" : undefined);
}

function extractResponsesOutputText(value: Record<string, unknown>): string {
  const outputText = readString(value.output_text);
  if (outputText !== undefined) return outputText;
  const output = Array.isArray(value.output) ? value.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = item.content;
    if (Array.isArray(content)) {
      const text = extractTextContent(content);
      if (text) parts.push(text);
      continue;
    }
    const text = extractTextContent(content ?? item.text);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function parseJsonObject(body: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function shouldFailover(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof HttpTransportError
    && (error.code === "aborted" || error.code === "timeout");
}

function joinUrl(baseUrl: string, requestUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${base}${path.slice(3)}`;
  }
  return `${base}${path}`;
}

function writeUpstreamResponse(
  response: ServerResponse,
  upstream: HttpResponseSnapshot,
  body: Buffer
): void {
  const headers = buildResponseHeaders(upstream);
  headers["content-length"] = String(body.length);
  response.writeHead(upstream.status, headers);
  response.end(body);
}

function writeReplayResponse(
  response: ServerResponse,
  record: ProxyReplayRecord
): void {
  const body = Buffer.from(record.bodyBase64, "base64");
  const headers = {
    ...record.headers,
    "content-length": String(body.length),
    "x-mn-proxy-replay": "hit"
  };
  response.writeHead(record.statusCode, headers);
  response.end(body);
}

/** Minimal sink used to materialize a governed SSE conversion in memory.
 * `streamUpstreamResponse` wraps `write` and returns the exact client bytes;
 * no headers or body reach the real client until accounting is durable. */
function bufferedServerResponse(): ServerResponse {
  const sink: {
    writableEnded: boolean;
    destroyed: boolean;
    headersSent: boolean;
    writeHead: (...args: unknown[]) => unknown;
    write: (...args: unknown[]) => boolean;
    end: (...args: unknown[]) => unknown;
  } = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead() {
      sink.headersSent = true;
      return sink;
    },
    write(...args: unknown[]) {
      const callback = args.find((value) => typeof value === "function");
      if (typeof callback === "function") callback();
      return true;
    },
    end(...args: unknown[]) {
      sink.writableEnded = true;
      const callback = args.find((value) => typeof value === "function");
      if (typeof callback === "function") callback();
      return sink;
    }
  };
  return sink as unknown as ServerResponse;
}

async function streamUpstreamResponse(
  response: ServerResponse,
  upstream: HttpResponseSnapshot,
  conversion: ResponseConversion | undefined,
  requestBody: Buffer
): Promise<StreamUsageResult> {
  const headers = buildResponseHeaders(upstream);
  response.writeHead(upstream.status, headers);
  const finishRecording = startResponseBodyRecording(response);
  if (!upstream.body) {
    return { body: finishRecording() };
  }
  try {
    if (conversion === "chat_to_responses") {
      const result = await streamChatCompletionsAsResponses(response, upstream, requestBody);
      return { ...result, body: finishRecording() };
    }
    if (conversion === "chat_to_anthropic") {
      const result = await streamChatCompletionsAsAnthropic(response, upstream, requestBody);
      return { ...result, body: finishRecording() };
    }
    if (conversion === "responses_to_anthropic") {
      const result = await streamResponsesAsAnthropic(response, upstream, requestBody);
      return { ...result, body: finishRecording() };
    }
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) response.write(Buffer.from(value));
      }
      return { body: finishRecording() };
    } finally {
      reader.releaseLock();
    }
  } finally {
    finishRecording();
  }
}

function startResponseBodyRecording(response: ServerResponse): () => Buffer {
  type WritableResponse = {
    write: (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void
    ) => boolean;
  };

  const writable = response as unknown as WritableResponse;
  const originalWrite = writable.write.bind(response);
  const chunks: Buffer[] = [];
  let restored = false;

  writable.write = (chunk, encodingOrCallback, callback) => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    chunks.push(Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : Buffer.from(chunk, encoding ?? "utf8"));

    if (typeof encodingOrCallback === "function") {
      return originalWrite(chunk, encodingOrCallback);
    }
    return originalWrite(chunk, encodingOrCallback, callback);
  };

  return () => {
    if (!restored) {
      writable.write = originalWrite;
      restored = true;
    }
    return Buffer.concat(chunks);
  };
}

async function streamResponsesAsAnthropic(
  response: ServerResponse,
  upstream: HttpResponseSnapshot,
  requestBody: Buffer
): Promise<StreamUsageResult> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return {};
  }

  const state: AnthropicStreamState = {
    messageId: `msg_${randomUUID()}`,
    model: "unknown",
    started: false,
    completed: false,
    outputText: "",
    nextContentIndex: 0,
    textBlockStarted: false,
    textBlockStopped: false,
    toolCalls: [],
    inputTokens: estimateInputTokensFromRequestBody(requestBody)
  };
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += Buffer.from(value).toString("utf8");
      buffer = processSseBuffer(buffer, (frame) => {
        processResponsesAnthropicSseFrame(response, state, frame);
      });
    }
    if (buffer.trim()) {
      processResponsesAnthropicSseFrame(response, state, buffer);
    }
    completeAnthropicSse(response, state);
    return {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cachedInputTokens: state.cachedInputTokens,
      cacheCreationInputTokens: state.cacheCreationInputTokens,
      cacheReadInputTokens: state.cacheReadInputTokens,
      reasoningOutputTokens: state.reasoningOutputTokens,
      model: state.model === "unknown" ? undefined : state.model
    };
  } finally {
    reader.releaseLock();
  }
}

async function streamChatCompletionsAsAnthropic(
  response: ServerResponse,
  upstream: HttpResponseSnapshot,
  requestBody: Buffer
): Promise<StreamUsageResult> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return {};
  }

  const state: AnthropicStreamState = {
    messageId: `msg_${randomUUID()}`,
    model: "unknown",
    started: false,
    completed: false,
    outputText: "",
    nextContentIndex: 0,
    textBlockStarted: false,
    textBlockStopped: false,
    toolCalls: [],
    inputTokens: estimateInputTokensFromRequestBody(requestBody)
  };
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += Buffer.from(value).toString("utf8");
      buffer = processSseBuffer(buffer, (frame) => {
        processChatCompletionAnthropicSseFrame(response, state, frame);
      });
    }
    if (buffer.trim()) {
      processChatCompletionAnthropicSseFrame(response, state, buffer);
    }
    completeAnthropicSse(response, state);
    return {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cachedInputTokens: state.cachedInputTokens,
      cacheCreationInputTokens: state.cacheCreationInputTokens,
      cacheReadInputTokens: state.cacheReadInputTokens,
      reasoningOutputTokens: state.reasoningOutputTokens,
      model: state.model === "unknown" ? undefined : state.model
    };
  } finally {
    reader.releaseLock();
  }
}

async function streamChatCompletionsAsResponses(
  response: ServerResponse,
  upstream: HttpResponseSnapshot,
  requestBody: Buffer
): Promise<StreamUsageResult> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return {};
  }

  const state: ResponsesStreamState = {
    responseId: `resp_${randomUUID()}`,
    messageId: `msg_${randomUUID()}`,
    createdAt: Math.floor(Date.now() / 1000),
    model: "unknown",
    started: false,
    completed: false,
    outputText: "",
    nextOutputIndex: 0,
    textItemStarted: false,
    textItemDone: false,
    toolCalls: [],
    inputTokens: estimateInputTokensFromRequestBody(requestBody)
  };
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += Buffer.from(value).toString("utf8");
      buffer = processSseBuffer(buffer, (frame) => {
        processChatCompletionSseFrame(response, state, frame);
      });
    }
    if (buffer.trim()) {
      processChatCompletionSseFrame(response, state, buffer);
    }
    completeResponsesSse(response, state);
    return {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cachedInputTokens: state.cachedInputTokens,
      cacheCreationInputTokens: state.cacheCreationInputTokens,
      cacheReadInputTokens: state.cacheReadInputTokens,
      reasoningOutputTokens: state.reasoningOutputTokens,
      model: state.model === "unknown" ? undefined : state.model
    };
  } finally {
    reader.releaseLock();
  }
}

function processResponsesAnthropicSseFrame(
  response: ServerResponse,
  state: AnthropicStreamState,
  frame: string
): void {
  const data = readSseData(frame);
  if (!data || data === "[DONE]") {
    if (data === "[DONE]") completeAnthropicSse(response, state);
    return;
  }
  const parsed = parseJsonObject(Buffer.from(data));
  const responseObject = isRecord(parsed.response) ? parsed.response : parsed;
  const id = readString(responseObject.id) ?? readString(parsed.response_id);
  if (id) state.messageId = id.replace(/^resp/, "msg");
  state.model = readString(responseObject.model) ?? readString(parsed.model) ?? state.model;

  const usageSource = isRecord(responseObject.usage) ? responseObject.usage : parsed.usage;
  if (usageSource !== undefined) {
    applyTokenUsage(state, normalizeUsageFromJson(usageSource));
  }

  const delta = readString(parsed.delta);
  if (delta) {
    ensureAnthropicTextBlock(response, state);
    state.outputText += delta;
    writeSseEvent(response, "content_block_delta", {
      type: "content_block_delta",
      index: state.textContentIndex ?? 0,
      delta: {
        type: "text_delta",
        text: delta
      }
    });
  }

  processResponsesToolCallFrameAsAnthropic(response, state, parsed, responseObject);

  const completedText = extractResponsesOutputText(responseObject);
  if (!state.outputText && completedText) {
    ensureAnthropicTextBlock(response, state);
    state.outputText = completedText;
    writeSseEvent(response, "content_block_delta", {
      type: "content_block_delta",
      index: state.textContentIndex ?? 0,
      delta: {
        type: "text_delta",
        text: completedText
      }
    });
  }

  const stopReason = readResponsesStopReason(responseObject);
  if (stopReason) state.stopReason = mapResponsesStopReasonToAnthropic(stopReason);
  const type = readString(parsed.type);
  if (type === "response.completed" || type === "response.incomplete") {
    completeAnthropicSse(response, state);
  }
}

function processChatCompletionAnthropicSseFrame(
  response: ServerResponse,
  state: AnthropicStreamState,
  frame: string
): void {
  const data = readSseData(frame);
  if (!data || data === "[DONE]") {
    if (data === "[DONE]") completeAnthropicSse(response, state);
    return;
  }
  const parsed = parseJsonObject(Buffer.from(data));
  const id = readString(parsed.id);
  if (id) state.messageId = id.replace(/^chatcmpl/, "msg");
  state.model = readString(parsed.model) ?? state.model;

  if (isRecord(parsed.usage)) {
    applyTokenUsage(state, normalizeUsageFromJson(parsed.usage));
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    const text = extractTextContent(delta.content);
    if (text) {
      ensureAnthropicTextBlock(response, state);
      state.outputText += text;
      writeSseEvent(response, "content_block_delta", {
        type: "content_block_delta",
        index: state.textContentIndex ?? 0,
        delta: {
          type: "text_delta",
          text
        }
      });
    }
    processChatToolCallDeltasAsAnthropic(response, state, delta.tool_calls);
    const finishReason = readString(choice.finish_reason);
    if (finishReason) {
      state.stopReason = mapChatFinishReasonToAnthropic(finishReason);
    }
  }
}

function processSseBuffer(
  buffer: string,
  onFrame: (frame: string) => void
): string {
  while (true) {
    const separator = findSseFrameSeparator(buffer);
    if (!separator) return buffer;
    const frame = buffer.slice(0, separator.index);
    buffer = buffer.slice(separator.index + separator.length);
    if (frame.trim()) onFrame(frame);
  }
}

function findSseFrameSeparator(
  buffer: string
): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) {
    return crlf === -1 ? undefined : { index: crlf, length: 4 };
  }
  if (crlf === -1 || lf < crlf) {
    return { index: lf, length: 2 };
  }
  return { index: crlf, length: 4 };
}

function startAnthropicMessage(
  response: ServerResponse,
  state: AnthropicStreamState
): void {
  if (state.started) return;
  state.started = true;
  writeSseEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      model: state.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        ...anthropicUsageFromTokenUsage({ ...state, outputTokens: 0 }),
        output_tokens: 0
      }
    }
  });
}

function ensureAnthropicTextBlock(
  response: ServerResponse,
  state: AnthropicStreamState
): void {
  startAnthropicMessage(response, state);
  if (state.textBlockStarted) return;
  state.textBlockStarted = true;
  state.textContentIndex = state.nextContentIndex++;
  writeSseEvent(response, "content_block_start", {
    type: "content_block_start",
    index: state.textContentIndex,
    content_block: {
      type: "text",
      text: ""
    }
  });
}

function completeAnthropicSse(
  response: ServerResponse,
  state: AnthropicStreamState
): void {
  if (state.completed) return;
  applyEstimatedOutputTokens(state);
  startAnthropicMessage(response, state);
  if (!state.textBlockStarted && state.toolCalls.length === 0) {
    ensureAnthropicTextBlock(response, state);
  }
  state.completed = true;
  stopAnthropicTextBlock(response, state);
  for (const toolCall of state.toolCalls) {
    stopAnthropicToolBlock(response, state, toolCall);
  }
  writeSseEvent(response, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: state.stopReason ?? (state.toolCalls.length > 0 ? "tool_use" : "end_turn"),
      stop_sequence: null
    },
    usage: {
      output_tokens: state.outputTokens ?? 0,
      ...((state.reasoningOutputTokens ?? 0) > 0
        ? { reasoning_output_tokens: state.reasoningOutputTokens }
        : {})
    }
  });
  writeSseEvent(response, "message_stop", {
    type: "message_stop"
  });
}

function stopAnthropicTextBlock(
  response: ServerResponse,
  state: AnthropicStreamState
): void {
  if (!state.textBlockStarted || state.textBlockStopped) return;
  state.textBlockStopped = true;
  writeSseEvent(response, "content_block_stop", {
    type: "content_block_stop",
    index: state.textContentIndex ?? 0
  });
}

function ensureAnthropicToolBlock(
  response: ServerResponse,
  state: AnthropicStreamState,
  toolCall: StreamToolCall
): void {
  startAnthropicMessage(response, state);
  if (toolCall.anthropicStarted) return;
  toolCall.anthropicStarted = true;
  toolCall.contentIndex = state.nextContentIndex++;
  writeSseEvent(response, "content_block_start", {
    type: "content_block_start",
    index: toolCall.contentIndex,
    content_block: {
      type: "tool_use",
      id: toolCall.callId,
      name: toolCall.name || "unknown_tool",
      input: {}
    }
  });
}

function writeAnthropicToolArgumentsDelta(
  response: ServerResponse,
  state: AnthropicStreamState,
  toolCall: StreamToolCall,
  delta: string
): void {
  if (!delta) return;
  ensureAnthropicToolBlock(response, state, toolCall);
  writeSseEvent(response, "content_block_delta", {
    type: "content_block_delta",
    index: toolCall.contentIndex ?? 0,
    delta: {
      type: "input_json_delta",
      partial_json: delta
    }
  });
}

function stopAnthropicToolBlock(
  response: ServerResponse,
  state: AnthropicStreamState,
  toolCall: StreamToolCall
): void {
  ensureAnthropicToolBlock(response, state, toolCall);
  if (toolCall.anthropicStopped) return;
  toolCall.anthropicStopped = true;
  writeSseEvent(response, "content_block_stop", {
    type: "content_block_stop",
    index: toolCall.contentIndex ?? 0
  });
}

function processChatCompletionSseFrame(
  response: ServerResponse,
  state: ResponsesStreamState,
  frame: string
): void {
  const data = readSseData(frame);
  if (!data || data === "[DONE]") {
    if (data === "[DONE]") completeResponsesSse(response, state);
    return;
  }
  const parsed = parseJsonObject(Buffer.from(data));
  const id = readString(parsed.id);
  if (id) state.responseId = id.replace(/^chatcmpl/, "resp");
  state.createdAt = readNumber(parsed.created) ?? state.createdAt;
  state.model = readString(parsed.model) ?? state.model;

  if (isRecord(parsed.usage)) {
    applyTokenUsage(state, normalizeUsageFromJson(parsed.usage));
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    const text = extractTextContent(delta.content);
    if (text) {
      ensureResponsesTextItem(response, state);
      state.outputText += text;
      writeSseEvent(response, "response.output_text.delta", {
        type: "response.output_text.delta",
        response_id: state.responseId,
        item_id: state.messageId,
        output_index: state.textOutputIndex ?? 0,
        content_index: 0,
        delta: text
      });
    }
    processChatToolCallDeltasAsResponses(response, state, delta.tool_calls);
    const finishReason = readString(choice.finish_reason);
    if (finishReason) state.stopReason = finishReason;
  }
}

function processChatToolCallDeltasAsResponses(
  response: ServerResponse,
  state: ResponsesStreamState,
  value: unknown
): void {
  if (!Array.isArray(value)) return;
  value.forEach((item, fallbackIndex) => {
    const updated = updateChatStreamToolCall(state.toolCalls, item, fallbackIndex);
    if (!updated) return;
    ensureResponsesToolCallItem(response, state, updated.toolCall);
    writeResponsesToolArgumentsDelta(response, state, updated.toolCall, updated.argumentDelta);
  });
}

function processChatToolCallDeltasAsAnthropic(
  response: ServerResponse,
  state: AnthropicStreamState,
  value: unknown
): void {
  if (!Array.isArray(value)) return;
  value.forEach((item, fallbackIndex) => {
    const updated = updateChatStreamToolCall(state.toolCalls, item, fallbackIndex);
    if (!updated) return;
    ensureAnthropicToolBlock(response, state, updated.toolCall);
    writeAnthropicToolArgumentsDelta(response, state, updated.toolCall, updated.argumentDelta);
  });
}

function processResponsesToolCallFrameAsAnthropic(
  response: ServerResponse,
  state: AnthropicStreamState,
  parsed: Record<string, unknown>,
  responseObject: Record<string, unknown>
): void {
  const type = readString(parsed.type);
  const item = isRecord(parsed.item) ? parsed.item : undefined;
  if ((type === "response.output_item.added" || type === "response.output_item.done") && item) {
    const toolCall = updateResponsesStreamToolCallFromItem(
      state.toolCalls,
      item,
      readNumber(parsed.output_index)
    );
    if (toolCall) {
      ensureAnthropicToolBlock(response, state, toolCall);
      syncAnthropicToolArguments(response, state, toolCall, readString(item.arguments));
      if (type === "response.output_item.done") {
        stopAnthropicToolBlock(response, state, toolCall);
      }
    }
  }

  if (type === "response.function_call_arguments.delta") {
    const toolCall = findResponsesStreamToolCall(
      state.toolCalls,
      readString(parsed.item_id),
      readNumber(parsed.output_index)
    );
    if (toolCall) {
      const delta = readString(parsed.delta) ?? "";
      toolCall.arguments += delta;
      writeAnthropicToolArgumentsDelta(response, state, toolCall, delta);
    }
  }

  if (type === "response.function_call_arguments.done") {
    const toolCall = findResponsesStreamToolCall(
      state.toolCalls,
      readString(parsed.item_id),
      readNumber(parsed.output_index)
    );
    if (toolCall) {
      syncAnthropicToolArguments(response, state, toolCall, readString(parsed.arguments));
    }
  }

  if (type === "response.completed" || type === "response.incomplete") {
    for (const outputItem of asArray(responseObject.output)) {
      if (!isRecord(outputItem) || readString(outputItem.type) !== "function_call") continue;
      const toolCall = updateResponsesStreamToolCallFromItem(
        state.toolCalls,
        outputItem,
        state.toolCalls.length
      );
      if (!toolCall) continue;
      ensureAnthropicToolBlock(response, state, toolCall);
      syncAnthropicToolArguments(response, state, toolCall, readString(outputItem.arguments));
      stopAnthropicToolBlock(response, state, toolCall);
    }
  }
}

function updateChatStreamToolCall(
  toolCalls: StreamToolCall[],
  value: unknown,
  fallbackIndex: number
): { toolCall: StreamToolCall; argumentDelta: string } | undefined {
  if (!isRecord(value)) return undefined;
  const index = readNumber(value.index) ?? fallbackIndex;
  const toolCall = getStreamToolCallByIndex(toolCalls, index);
  const id = readString(value.id);
  if (id && !toolCall.responsesStarted && !toolCall.anthropicStarted) {
    toolCall.id = id;
    toolCall.callId = id;
  }
  const fn = isRecord(value.function) ? value.function : {};
  const name = readString(fn.name);
  if (name) toolCall.name = name;
  const argumentDelta = readString(fn.arguments) ?? "";
  toolCall.arguments += argumentDelta;
  return { toolCall, argumentDelta };
}

function updateResponsesStreamToolCallFromItem(
  toolCalls: StreamToolCall[],
  item: Record<string, unknown>,
  fallbackIndex: number | undefined
): StreamToolCall | undefined {
  if (readString(item.type) !== "function_call") return undefined;
  const id = readString(item.id) ?? readString(item.call_id);
  const index = fallbackIndex ?? toolCalls.length;
  const toolCall = id
    ? findResponsesStreamToolCall(toolCalls, id, index)
    : getStreamToolCallByIndex(toolCalls, index);
  if (id && !toolCall.responsesStarted && !toolCall.anthropicStarted) toolCall.id = id;
  const callId = readString(item.call_id) ?? id;
  if (callId && !toolCall.responsesStarted && !toolCall.anthropicStarted) toolCall.callId = callId;
  const name = readString(item.name);
  if (name) toolCall.name = name;
  return toolCall;
}

function findResponsesStreamToolCall(
  toolCalls: StreamToolCall[],
  itemId: string | undefined,
  fallbackIndex: number | undefined
): StreamToolCall {
  const byId = itemId
    ? toolCalls.find((toolCall) => toolCall.id === itemId || toolCall.callId === itemId)
    : undefined;
  if (byId) return byId;
  return getStreamToolCallByIndex(toolCalls, fallbackIndex ?? toolCalls.length);
}

function getStreamToolCallByIndex(
  toolCalls: StreamToolCall[],
  index: number
): StreamToolCall {
  let toolCall = toolCalls.find((candidate) => candidate.index === index);
  if (toolCall) return toolCall;
  const id = `call_${randomUUID()}`;
  toolCall = {
    index,
    id,
    callId: id,
    name: "unknown_tool",
    arguments: "",
    responsesStarted: false,
    responsesArgumentsDone: false,
    responsesDone: false,
    anthropicStarted: false,
    anthropicStopped: false
  };
  toolCalls.push(toolCall);
  return toolCall;
}

function syncAnthropicToolArguments(
  response: ServerResponse,
  state: AnthropicStreamState,
  toolCall: StreamToolCall,
  finalArguments: string | undefined
): void {
  if (finalArguments === undefined || finalArguments === toolCall.arguments) return;
  const delta = finalArguments.startsWith(toolCall.arguments)
    ? finalArguments.slice(toolCall.arguments.length)
    : finalArguments;
  toolCall.arguments = finalArguments;
  writeAnthropicToolArgumentsDelta(response, state, toolCall, delta);
}

function readSseData(frame: string): string {
  const parts: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    parts.push(line.slice(5).trimStart());
  }
  return parts.join("\n");
}

function applyTokenUsage(
  state: Partial<TokenUsage>,
  usage: TokenUsage
): void {
  state.inputTokens = usage.inputTokens;
  state.outputTokens = usage.outputTokens;
  if (usage.cachedInputTokens !== undefined) {
    state.cachedInputTokens = usage.cachedInputTokens;
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    state.cacheCreationInputTokens = usage.cacheCreationInputTokens;
  }
  if (usage.cacheReadInputTokens !== undefined) {
    state.cacheReadInputTokens = usage.cacheReadInputTokens;
  }
  if (usage.reasoningOutputTokens !== undefined) {
    state.reasoningOutputTokens = usage.reasoningOutputTokens;
  }
}

function estimateInputTokensFromRequestBody(body: Buffer): number | undefined {
  const parsed = parseJsonObject(body);
  const parts: string[] = [];
  collectRequestText(parsed.instructions, parts);
  collectRequestText(parsed.system, parts);
  collectMessagesText(parsed.messages, parts);
  collectRequestText(parsed.input, parts);
  collectRequestText(parsed.prompt, parts);
  const tokens = estimateTextTokens(parts.join("\n"));
  return tokens > 0 ? tokens : undefined;
}

function collectMessagesText(value: unknown, parts: string[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isRecord(item)) continue;
    collectRequestText(item.content, parts);
    collectRequestText(item.text, parts);
    collectRequestText(item.output, parts);
    const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) continue;
      const fn = isRecord(toolCall.function) ? toolCall.function : {};
      collectRequestText(fn.arguments, parts);
    }
  }
}

function collectRequestText(value: unknown, parts: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRequestText(item, parts);
    return;
  }
  if (!isRecord(value)) return;
  collectRequestText(value.content, parts);
  collectRequestText(value.text, parts);
  collectRequestText(value.output, parts);
  collectRequestText(value.input, parts);
  collectRequestText(value.arguments, parts);
}

function applyEstimatedOutputTokens(state: {
  outputText?: string;
  outputTokens?: number;
  toolCalls?: StreamToolCall[];
}): void {
  if (state.outputTokens !== undefined) return;
  const toolText = (state.toolCalls ?? [])
    .map((toolCall) => `${toolCall.name} ${toolCall.arguments}`)
    .join("\n");
  const tokens = estimateTextTokens([state.outputText ?? "", toolText].filter(Boolean).join("\n"));
  if (tokens > 0) state.outputTokens = tokens;
}

function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function startResponsesEnvelope(
  response: ServerResponse,
  state: ResponsesStreamState
): void {
  if (state.started) return;
  state.started = true;
  writeSseEvent(response, "response.created", {
    type: "response.created",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      status: "in_progress",
      model: state.model,
      output: []
    }
  });
}

function ensureResponsesTextItem(
  response: ServerResponse,
  state: ResponsesStreamState
): void {
  startResponsesEnvelope(response, state);
  if (state.textItemStarted) return;
  state.textItemStarted = true;
  state.textOutputIndex = state.nextOutputIndex++;
  writeSseEvent(response, "response.output_item.added", {
    type: "response.output_item.added",
    response_id: state.responseId,
    output_index: state.textOutputIndex,
    item: {
      id: state.messageId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: []
    }
  });
  writeSseEvent(response, "response.content_part.added", {
    type: "response.content_part.added",
    response_id: state.responseId,
    item_id: state.messageId,
    output_index: state.textOutputIndex,
    content_index: 0,
    part: {
      type: "output_text",
      text: "",
      annotations: []
    }
  });
}

function completeResponsesSse(
  response: ServerResponse,
  state: ResponsesStreamState
): void {
  if (state.completed) return;
  applyEstimatedOutputTokens(state);
  startResponsesEnvelope(response, state);
  if (!state.textItemStarted && state.toolCalls.length === 0) {
    ensureResponsesTextItem(response, state);
  }
  state.completed = true;
  const content = {
    type: "output_text",
    text: state.outputText,
    annotations: []
  };
  const output: Array<Record<string, unknown>> = [];
  if (state.textItemStarted) {
    const item = {
      id: state.messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [content]
    };
    output.push(item);
    if (!state.textItemDone) {
      state.textItemDone = true;
      writeSseEvent(response, "response.output_text.done", {
        type: "response.output_text.done",
        response_id: state.responseId,
        item_id: state.messageId,
        output_index: state.textOutputIndex ?? 0,
        content_index: 0,
        text: state.outputText
      });
      writeSseEvent(response, "response.content_part.done", {
        type: "response.content_part.done",
        response_id: state.responseId,
        item_id: state.messageId,
        output_index: state.textOutputIndex ?? 0,
        content_index: 0,
        part: content
      });
      writeSseEvent(response, "response.output_item.done", {
        type: "response.output_item.done",
        response_id: state.responseId,
        output_index: state.textOutputIndex ?? 0,
        item
      });
    }
  }
  for (const toolCall of state.toolCalls) {
    finishResponsesToolCall(response, state, toolCall);
    output.push(toResponsesToolCallItem(toolCall));
  }
  output.sort((left, right) => {
    const leftIndex = outputIndexForCompletedItem(state, left);
    const rightIndex = outputIndexForCompletedItem(state, right);
    return leftIndex - rightIndex;
  });
  const usage = responsesUsageFromTokenUsage(state);
  writeSseEvent(response, "response.completed", {
    type: "response.completed",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      status: "completed",
      model: state.model,
      output,
      output_text: state.outputText,
      stop_reason: state.stopReason,
      usage
    }
  });
}

function ensureResponsesToolCallItem(
  response: ServerResponse,
  state: ResponsesStreamState,
  toolCall: StreamToolCall
): void {
  startResponsesEnvelope(response, state);
  if (toolCall.responsesStarted) return;
  toolCall.responsesStarted = true;
  toolCall.outputIndex = state.nextOutputIndex++;
  writeSseEvent(response, "response.output_item.added", {
    type: "response.output_item.added",
    response_id: state.responseId,
    output_index: toolCall.outputIndex,
    item: {
      id: toolCall.id,
      type: "function_call",
      status: "in_progress",
      call_id: toolCall.callId,
      name: toolCall.name || "unknown_tool",
      arguments: ""
    }
  });
}

function writeResponsesToolArgumentsDelta(
  response: ServerResponse,
  state: ResponsesStreamState,
  toolCall: StreamToolCall,
  delta: string
): void {
  if (!delta) return;
  ensureResponsesToolCallItem(response, state, toolCall);
  writeSseEvent(response, "response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    response_id: state.responseId,
    item_id: toolCall.id,
    output_index: toolCall.outputIndex ?? 0,
    delta
  });
}

function finishResponsesToolCall(
  response: ServerResponse,
  state: ResponsesStreamState,
  toolCall: StreamToolCall
): void {
  ensureResponsesToolCallItem(response, state, toolCall);
  if (!toolCall.responsesArgumentsDone) {
    toolCall.responsesArgumentsDone = true;
    writeSseEvent(response, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: state.responseId,
      item_id: toolCall.id,
      output_index: toolCall.outputIndex ?? 0,
      arguments: toolCall.arguments
    });
  }
  if (toolCall.responsesDone) return;
  toolCall.responsesDone = true;
  writeSseEvent(response, "response.output_item.done", {
    type: "response.output_item.done",
    response_id: state.responseId,
    output_index: toolCall.outputIndex ?? 0,
    item: toResponsesToolCallItem(toolCall)
  });
}

function toResponsesToolCallItem(toolCall: StreamToolCall): Record<string, unknown> {
  return {
    id: toolCall.id,
    type: "function_call",
    status: "completed",
    call_id: toolCall.callId,
    name: toolCall.name || "unknown_tool",
    arguments: toolCall.arguments
  };
}

function outputIndexForCompletedItem(
  state: ResponsesStreamState,
  item: Record<string, unknown>
): number {
  const id = readString(item.id);
  if (id === state.messageId) return state.textOutputIndex ?? 0;
  const toolCall = state.toolCalls.find((candidate) => candidate.id === id);
  return toolCall?.outputIndex ?? 0;
}

function writeSseEvent(
  response: ServerResponse,
  event: string,
  data: Record<string, unknown>
): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildResponseHeaders(upstream: HttpResponseSnapshot): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.forEachHeader((value, key) => {
    if (
      key !== "transfer-encoding" &&
      key !== "content-encoding" &&
      key !== "content-length"
    ) {
      headers[key] = value;
    }
  });
  return headers;
}

function isEventStream(upstream: HttpResponseSnapshot): boolean {
  return (upstream.header("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
}

function readModelFromBody(body: Buffer): string {
  return readString(parseJsonObject(body).model) ?? "unknown";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRequestLog(input: {
  app: ManagedAgentApp;
  providerId: string;
  model: string;
  statusCode: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
  runId?: string;
  candidateId?: string;
  trustedAssociation?: TrustedProxyUsageAssociation;
  replayed?: boolean;
  containsToolCall?: boolean;
  toolCalls?: ProxyReplayToolCall[];
  usageAttempt: ProviderUsageAttemptLog["usageAttempt"];
}): ProviderUsageAttemptLog {
  return {
    id: providerUsageAttemptLogId(
      input.usageAttempt.logicalRequestId,
      input.usageAttempt.index
    ),
    app: input.app,
    providerId: input.providerId,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    ...(input.cachedInputTokens !== undefined ? { cachedInputTokens: input.cachedInputTokens } : {}),
    ...(input.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: input.cacheCreationInputTokens }
      : {}),
    ...(input.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: input.cacheReadInputTokens }
      : {}),
    ...(input.reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: input.reasoningOutputTokens }
      : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    ...(input.trustedAssociation
      ? { trustedAssociation: input.trustedAssociation }
      : {}),
    ...(input.replayed !== undefined ? { replayed: input.replayed } : {}),
    ...(input.containsToolCall !== undefined
      ? { containsToolCall: input.containsToolCall }
      : {}),
    ...(input.toolCalls && input.toolCalls.length > 0 ? { toolCalls: input.toolCalls } : {}),
    usageAttempt: input.usageAttempt,
    statusCode: input.statusCode,
    latencyMs: input.latencyMs,
    createdAt: new Date().toISOString()
  };
}
