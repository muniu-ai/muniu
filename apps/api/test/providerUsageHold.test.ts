import assert from "node:assert/strict";
import test from "node:test";
import type { RunRecord } from "@mn/core";
import { enterpriseProviderUsageConservativeHold } from "../src/server.js";

test("enterprise provider hold requires positive immutable token and cost bounds", () => {
  const run = (stopConditions: { maxTokens?: number; maxCostUsd?: number }) => ({
    id: "run-hold",
    harnessManifest: {
      digest: "a".repeat(64),
      stopConditions
    }
  } as unknown as RunRecord);

  assert.throws(
    () => enterpriseProviderUsageConservativeHold(run({ maxTokens: 1, maxCostUsd: 0 })),
    /positive immutable conservative hold/u
  );
  assert.throws(
    () => enterpriseProviderUsageConservativeHold(run({ maxTokens: 0, maxCostUsd: 1 })),
    /positive immutable conservative hold/u
  );
  assert.throws(
    () => enterpriseProviderUsageConservativeHold(run({ maxTokens: 1 })),
    /positive immutable conservative hold/u
  );
  const hold = enterpriseProviderUsageConservativeHold(
    run({ maxTokens: 200, maxCostUsd: 12.5 })
  );
  assert.equal(hold.maxTokens, 200);
  assert.equal(hold.maxCostUsd, 12.5);
  assert.match(hold.basisDigest, /^[a-f0-9]{64}$/u);
});
