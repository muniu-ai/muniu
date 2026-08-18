import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelAttemptStartedV1,
  createModelAttemptTerminalV1,
  createModelPricingSnapshotV1,
  estimateModelCostV1,
  inspectModelAttemptStartedV1,
  inspectModelAttemptTerminalV1,
  inspectModelPricingSnapshotV1
} from "../src/index.js";

const digest = (character: string): string => character.repeat(64);

test("model audit DTOs are exact, detached, frozen and survive JSON round trips", () => {
  const pricingInput = {
    inputUsdPerMillion: "2.5",
    outputUsdPerMillion: "4",
    cacheReadUsdPerMillion: "0.25",
    cacheWriteUsdPerMillion: "3",
    thinkingUsdPerMillion: "5"
  };
  const pricing = createModelPricingSnapshotV1(pricingInput);
  pricingInput.inputUsdPerMillion = "999";
  assert.equal(pricing.inputUsdPerMillion, "2.5");
  assert.equal(Object.isFrozen(pricing), true);
  assert.deepEqual(inspectModelPricingSnapshotV1(JSON.parse(JSON.stringify(pricing))), pricing);

  const started = createModelAttemptStartedV1({
    providerId: "provider-safe",
    modelId: "model-safe",
    apiFormat: "openai_chat",
    attempt: 1,
    protectedRequestDigest: digest("a"),
    routeDigest: digest("b"),
    pricing
  });
  assert.equal(started.pricingDigest, pricing.digest);
  assert.deepEqual(inspectModelAttemptStartedV1(JSON.parse(JSON.stringify(started))), started);

  const terminal = createModelAttemptTerminalV1({
    started,
    dispatchState: "dispatched",
    outcome: "completed",
    statusCode: 200,
    retryable: false,
    fallbackAllowed: false,
    usageState: "complete",
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 200_000,
      thinkingTokens: 100_000
    }
  });
  assert.deepEqual(terminal.cost, {
    schemaVersion: 1,
    kind: "model-cost-estimate",
    status: "estimated",
    pricingDigest: pricing.digest,
    estimatedCostPicoUsd: "4475000000000"
  });
  assert.deepEqual(inspectModelAttemptTerminalV1(JSON.parse(JSON.stringify(terminal))), terminal);
});

test("fixed-point model cost never turns missing, partial, or unpriced usage into zero", () => {
  const pricing = createModelPricingSnapshotV1({
    inputUsdPerMillion: "0.000000001",
    outputUsdPerMillion: "4"
  });
  assert.deepEqual(estimateModelCostV1("missing", undefined, pricing), {
    schemaVersion: 1,
    kind: "model-cost-estimate",
    status: "partial",
    pricingDigest: pricing.digest
  });
  assert.deepEqual(estimateModelCostV1("partial", { inputTokens: 1 }, pricing), {
    schemaVersion: 1,
    kind: "model-cost-estimate",
    status: "partial",
    pricingDigest: pricing.digest
  });
  assert.deepEqual(estimateModelCostV1("complete", {
    inputTokens: 0,
    outputTokens: 1,
    thinkingTokens: 1
  }, pricing), {
    schemaVersion: 1,
    kind: "model-cost-estimate",
    status: "unpriced",
    pricingDigest: pricing.digest
  });
  assert.deepEqual(estimateModelCostV1("complete", {
    inputTokens: 1,
    outputTokens: 0
  }, pricing), {
    schemaVersion: 1,
    kind: "model-cost-estimate",
    status: "estimated",
    pricingDigest: pricing.digest,
    estimatedCostPicoUsd: "0"
  });
  assert.throws(() => estimateModelCostV1("complete", {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 2
  }, pricing), /usage/i);
});

test("model audit inspectors reject accessors, proxies, unknown fields and invalid decimals without traps", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "inputUsdPerMillion", {
    enumerable: true,
    get() {
      reads += 1;
      return "1";
    }
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(inspectModelPricingSnapshotV1(accessor), undefined);
  assert.equal(inspectModelPricingSnapshotV1(revoked.proxy), undefined);
  assert.equal(reads, 0);
  assert.throws(() => createModelPricingSnapshotV1({ inputUsdPerMillion: "1e3" }), /pricing/i);
  assert.throws(() => createModelPricingSnapshotV1({ inputUsdPerMillion: "-0" }), /pricing/i);
  assert.throws(() => createModelPricingSnapshotV1({ inputUsdPerMillion: "1", extra: "x" } as never), /pricing/i);

  const pricing = createModelPricingSnapshotV1({ inputUsdPerMillion: "1", outputUsdPerMillion: "1" });
  const started = createModelAttemptStartedV1({
    providerId: "provider-safe",
    modelId: "model-safe",
    apiFormat: "anthropic_messages",
    attempt: 1,
    protectedRequestDigest: digest("a"),
    routeDigest: digest("b"),
    pricing
  });
  assert.equal(inspectModelAttemptStartedV1({ ...started, extra: true }), undefined);
  assert.equal(inspectModelAttemptTerminalV1({
    schemaVersion: 1,
    kind: "model-attempt-terminal",
    providerId: "provider-safe",
    modelId: "model-safe",
    apiFormat: "anthropic_messages",
    attempt: 1,
    protectedRequestDigest: digest("a"),
    routeDigest: digest("b"),
    pricingDigest: pricing.digest,
    dispatchState: "not-dispatched",
    outcome: "failed",
    retryable: false,
    fallbackAllowed: false,
    usageState: "missing",
    cost: {
      schemaVersion: 1,
      kind: "model-cost-estimate",
      status: "estimated",
      pricingDigest: pricing.digest,
      estimatedCostPicoUsd: "0"
    }
  }), undefined);
});

test("model terminal audit rejects contradictory outcome and dispatch facts", () => {
  const started = createModelAttemptStartedV1({
    providerId: "provider-safe",
    modelId: "model-safe",
    apiFormat: "openai_chat",
    attempt: 1,
    protectedRequestDigest: digest("a"),
    routeDigest: digest("b"),
    pricing: createModelPricingSnapshotV1({})
  });
  const valid = {
    started,
    dispatchState: "dispatched" as const,
    outcome: "completed" as const,
    statusCode: 200,
    retryable: false,
    fallbackAllowed: false,
    usageState: "missing" as const
  };
  const contradictory = [
    { ...valid, dispatchState: "not-dispatched" as const },
    { ...valid, dispatchState: "unknown" as const },
    { ...valid, failureCode: "stream_error" as const },
    { ...valid, statusCode: 503 },
    { ...valid, retryable: true },
    { ...valid, fallbackAllowed: true },
    {
      ...valid,
      dispatchState: "not-dispatched" as const,
      outcome: "failed" as const,
      statusCode: undefined,
      failureCode: undefined
    },
    {
      ...valid,
      dispatchState: "not-dispatched" as const,
      outcome: "failed" as const,
      statusCode: undefined,
      failureCode: "http_error" as const
    },
    {
      ...valid,
      dispatchState: "unknown" as const,
      outcome: "interrupted" as const,
      statusCode: 200,
      failureCode: "stream_interrupted" as const
    },
    {
      ...valid,
      dispatchState: "not-dispatched" as const,
      outcome: "interrupted" as const,
      statusCode: undefined,
      failureCode: "cancelled" as const,
      retryable: true
    }
  ];
  for (const terminal of contradictory) {
    assert.throws(() => createModelAttemptTerminalV1(terminal), /terminal|dispatch|outcome/iu);
  }
});
