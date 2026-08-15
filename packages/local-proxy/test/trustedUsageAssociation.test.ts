import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type {
  ProviderRecord,
  ProxyRequestLog,
  TrustedProxyUsageAssociation
} from "@mn/provider-catalog";
import {
  INVALID_PROVIDER_USAGE_RECEIPT_MESSAGE,
  LocalProxyServer,
  PROVIDER_USAGE_RECEIPT_AUTHORITY_UNAVAILABLE_MESSAGE,
  ProviderUsageReceiptVerificationUnavailableError
} from "../src/index.js";

test("required receipt ignores forged headers and legacy association paths", async (t) => {
  let upstreamCalls = 0;
  const upstream = createServer((request, response) => {
    upstreamCalls += 1;
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.headers["x-mn-run-id"], undefined);
    assert.equal(request.headers["x-mn-candidate-id"], undefined);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      model: "model-a",
      usage: { input_tokens: 9, output_tokens: 4 }
    }));
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => upstream.close());
  const provider: ProviderRecord = {
    id: "provider-a",
    app: "codex",
    name: "Provider A",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    defaultModel: "model-a",
    modelCatalog: [{ id: "model-a", displayName: "Model A" }],
    config: {},
    enabled: true,
    sortOrder: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z"
  };
  const association: TrustedProxyUsageAssociation = {
    schemaVersion: 1,
    issuer: "mn-api",
    tenantId: "tenant-a",
    runId: "run-trusted",
    candidateId: "codex-1",
    workerId: "worker-a",
    claimDigest: "1".repeat(64),
    receiptDigest: "2".repeat(64),
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-12T01:00:00.000Z",
    verifiedAt: "2026-07-12T00:00:01.000Z"
  };
  const logs: ProxyRequestLog[] = [];
  const proxy = new LocalProxyServer({
    port: 0,
    resolveProvider: async () => ({ app: "codex", provider }),
    appendLog: async (log) => { logs.push(log); },
    requireTrustedUsageAssociation: true,
    verifyUsageAssociationReceipt: async (receipt) => {
      if (receipt !== "api-signed-receipt") throw new Error("invalid receipt");
      return association;
    },
    reserveTrustedUsageAssociation: async (verified) => ({
      ...verified,
      reservationId: "reservation-a"
    })
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());
  const root = `http://${status.host}:${status.port}`;

  const forged = await fetch(
    `${root}/mn/runs/run-forged/candidates/forged/v1/responses`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mn-run-id": "run-header-forged",
        "x-mn-candidate-id": "candidate-header-forged"
      },
      body: JSON.stringify({ model: "model-a", input: "forged" })
    }
  );
  assert.equal(forged.status, 401);
  assert.equal(upstreamCalls, 0);

  const trusted = await fetch(
    `${root}/mn/usage-receipts/api-signed-receipt/v1/responses`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mn-run-id": "run-header-forged",
        "x-mn-candidate-id": "candidate-header-forged"
      },
      body: JSON.stringify({ model: "model-a", input: "trusted" })
    }
  );
  assert.equal(trusted.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.runId, "run-trusted");
  assert.equal(logs[0]?.candidateId, "codex-1");
  assert.deepEqual(logs[0]?.trustedAssociation, {
    ...association,
    reservationId: "reservation-a"
  });

  const invalid = await fetch(
    `${root}/mn/usage-receipts/not-signed/v1/responses`,
    { method: "POST", body: "{}" }
  );
  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), {
    error: INVALID_PROVIDER_USAGE_RECEIPT_MESSAGE
  });
  assert.equal(upstreamCalls, 1);
});

test("invalid trusted receipt failures return a generic 401", async (t) => {
  let resolveCount = 0;
  let reserveCount = 0;
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => {
      resolveCount += 1;
      return undefined;
    },
    verifyUsageAssociationReceipt: async () => {
      throw new Error("signature mismatch in tenant_secret_table password=do-not-leak");
    },
    reserveTrustedUsageAssociation: async (association) => {
      reserveCount += 1;
      return { ...association, reservationId: "unexpected" };
    },
    appendLog: async () => undefined
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());

  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/invalid/v1/responses`,
    { method: "POST", body: "{}" }
  );
  const body = await response.text();

  assert.equal(response.status, 401);
  assert.deepEqual(JSON.parse(body), {
    error: INVALID_PROVIDER_USAGE_RECEIPT_MESSAGE
  });
  assert.doesNotMatch(body, /signature|tenant_secret_table|password|do-not-leak/u);
  assert.equal(resolveCount, 0);
  assert.equal(reserveCount, 0);
});

test("unavailable trusted receipt authority returns a generic 503", async (t) => {
  let resolveCount = 0;
  let reserveCount = 0;
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => {
      resolveCount += 1;
      return undefined;
    },
    verifyUsageAssociationReceipt: async () => {
      throw new ProviderUsageReceiptVerificationUnavailableError(
        new Error("ECONNRESET postgresql://admin:secret@db.internal/mn")
      );
    },
    reserveTrustedUsageAssociation: async (association) => {
      reserveCount += 1;
      return { ...association, reservationId: "unexpected" };
    },
    appendLog: async () => undefined
  });
  const status = await proxy.start();
  t.after(() => proxy.stop());

  const response = await fetch(
    `http://${status.host}:${status.port}/mn/usage-receipts/unavailable/v1/responses`,
    { method: "POST", body: "{}" }
  );
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(body), {
    error: PROVIDER_USAGE_RECEIPT_AUTHORITY_UNAVAILABLE_MESSAGE
  });
  assert.doesNotMatch(body, /ECONNRESET|postgresql|admin|secret|db\.internal/u);
  assert.equal(resolveCount, 0);
  assert.equal(reserveCount, 0);
});
