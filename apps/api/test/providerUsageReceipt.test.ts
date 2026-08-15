import assert from "node:assert/strict";
import test from "node:test";
import {
  INVALID_PROVIDER_USAGE_RECEIPT_MESSAGE,
  LocalProxyServer,
  PROVIDER_USAGE_RECEIPT_AUTHORITY_UNAVAILABLE_MESSAGE,
  type LocalProxyOptions
} from "@mn/local-proxy";
import {
  createEnterpriseProviderUsageReceiptVerifier,
  issueProviderUsageReceipt,
  verifyProviderUsageReceipt
} from "../src/providerUsageReceipt.js";

const key = "provider-usage-receipt-key-0123456789abcdef0123456789abcdef";

test("provider usage receipt is API-signed and claim/candidate bound", () => {
  const issued = issueProviderUsageReceipt({
    tenantId: "tenant-a",
    runId: "run-a",
    candidateId: "codex-1",
    workerId: "worker-a",
    claimDigest: "1".repeat(64),
    authorityExpiresAt: "2026-07-12T01:00:00.000Z",
    signingKey: key,
    now: "2026-07-12T00:00:00.000Z",
    receiptId: "receipt-a",
    providerPlan: {
      schemaVersion: 1,
      projectId: "project-a",
      app: "codex",
      providerIds: ["provider-primary", "provider-fallback"],
      digest: "2".repeat(64)
    }
  });
  const verified = verifyProviderUsageReceipt({
    receipt: issued.receipt,
    signingKey: key,
    now: "2026-07-12T00:00:01.000Z"
  });
  assert.equal(verified.tenantId, "tenant-a");
  assert.equal(verified.runId, "run-a");
  assert.equal(verified.candidateId, "codex-1");
  assert.equal(verified.workerId, "worker-a");
  assert.equal(verified.claimDigest, "1".repeat(64));
  assert.equal(verified.receiptDigest, issued.receiptDigest);
  assert.deepEqual(verified.providerPlan, {
    schemaVersion: 1,
    projectId: "project-a",
    app: "codex",
    providerIds: ["provider-primary", "provider-fallback"],
    digest: "2".repeat(64)
  });

  const [payload, signature] = issued.receipt.split(".");
  const forgedClaims = JSON.parse(
    Buffer.from(payload!, "base64url").toString("utf8")
  ) as Record<string, unknown>;
  forgedClaims.runId = "run-b";
  const forgedPayload = Buffer.from(JSON.stringify(forgedClaims)).toString("base64url");
  assert.throws(
    () => verifyProviderUsageReceipt({
      receipt: `${forgedPayload}.${signature}`,
      signingKey: key,
      now: "2026-07-12T00:00:01.000Z"
    }),
    /signature is invalid/u
  );
});

test("provider usage receipt rejects expiry and copied signatures", () => {
  const issued = issueProviderUsageReceipt({
    tenantId: "tenant-a",
    runId: "run-a",
    candidateId: "codex-1",
    workerId: "worker-a",
    claimDigest: "1".repeat(64),
    authorityExpiresAt: "2026-07-12T00:00:02.000Z",
    signingKey: key,
    now: "2026-07-12T00:00:00.000Z"
  });
  assert.throws(
    () => verifyProviderUsageReceipt({
      receipt: issued.receipt,
      signingKey: key,
      now: "2026-07-12T00:00:02.000Z"
    }),
    /expired/u
  );
  assert.throws(
    () => verifyProviderUsageReceipt({
      receipt: tamperReceiptSignature(issued.receipt),
      signingKey: key,
      now: "2026-07-12T00:00:01.000Z"
    }),
    /signature is invalid/u
  );
});

test("provider usage receipt rejects non-canonical base64url payloads", () => {
  let nonCanonicalReceipt: string | undefined;
  for (let length = 1; length <= 4 && !nonCanonicalReceipt; length += 1) {
    const issued = issueProviderUsageReceipt({
      tenantId: "tenant-a",
      runId: "run-a",
      candidateId: "codex-1",
      workerId: "worker-a",
      claimDigest: "1".repeat(64),
      authorityExpiresAt: "2026-07-12T00:00:02.000Z",
      signingKey: key,
      now: "2026-07-12T00:00:00.000Z",
      receiptId: "r".repeat(length)
    });
    const [payload, signature] = issued.receipt.split(".");
    const alternate = nonCanonicalBase64Url(payload!);
    if (alternate) nonCanonicalReceipt = `${alternate}.${signature}`;
  }
  assert.ok(nonCanonicalReceipt, "fixture must have unused base64url padding bits");
  assert.throws(
    () => verifyProviderUsageReceipt({
      receipt: nonCanonicalReceipt!,
      signingKey: key,
      now: "2026-07-12T00:00:01.000Z"
    }),
    /invalid envelope/u
  );
});

test("enterprise verifier keeps forged, expired and unbound receipts generic", async () => {
  const issued = issueProviderUsageReceipt({
    tenantId: "tenant-a",
    runId: "run-a",
    candidateId: "codex-1",
    workerId: "worker-a",
    claimDigest: "1".repeat(64),
    authorityExpiresAt: "2026-07-12T00:10:00.000Z",
    signingKey: key,
    now: "2026-07-12T00:00:00.000Z"
  });
  const cases = [
    {
      name: "forged",
      receipt: tamperReceiptSignature(issued.receipt),
      now: "2026-07-12T00:01:00.000Z",
      readRunJob: async () => {
        throw new Error("authority must not be queried for a forged receipt");
      }
    },
    {
      name: "expired",
      receipt: issued.receipt,
      now: "2026-07-12T00:10:00.000Z",
      readRunJob: async () => {
        throw new Error("authority must not be queried for an expired receipt");
      }
    },
    {
      name: "unbound",
      receipt: issued.receipt,
      now: "2026-07-12T00:01:00.000Z",
      readRunJob: async () => undefined
    }
  ] as const;

  for (const fixture of cases) {
    const response = await requestThroughEnterpriseVerifier({
      receipt: fixture.receipt,
      verifier: createEnterpriseProviderUsageReceiptVerifier({
        signingKey: key,
        authority: { readRunJob: fixture.readRunJob },
        now: () => fixture.now
      })
    });
    assert.equal(response.status, 401, fixture.name);
    assert.deepEqual(JSON.parse(response.body), {
      error: INVALID_PROVIDER_USAGE_RECEIPT_MESSAGE
    }, fixture.name);
    assert.doesNotMatch(
      response.body,
      /signature|expired|active claim|authority must not|run-a|tenant-a/u,
      fixture.name
    );
  }
});

test("enterprise verifier query outage reaches the proxy client as a generic 503", async () => {
  const issued = issueProviderUsageReceipt({
    tenantId: "tenant-a",
    runId: "run-a",
    candidateId: "codex-1",
    workerId: "worker-a",
    claimDigest: "1".repeat(64),
    authorityExpiresAt: "2026-07-12T00:10:00.000Z",
    signingKey: key,
    now: "2026-07-12T00:00:00.000Z"
  });
  // buildServer owns and migrates a concrete PostgreSQL runtime during
  // onReady, so a query-outage unit test uses the exact verifier callback
  // factory installed by buildServer instead of a parallel test-only path.
  const verifier = createEnterpriseProviderUsageReceiptVerifier({
    signingKey: key,
    authority: {
      readRunJob: async () => {
        throw new Error(
          "ECONNREFUSED postgresql://admin:secret@db.internal/mn SELECT mn_run_jobs"
        );
      }
    },
    now: () => "2026-07-12T00:01:00.000Z"
  });

  const response = await requestThroughEnterpriseVerifier({
    receipt: issued.receipt,
    verifier
  });

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.body), {
    error: PROVIDER_USAGE_RECEIPT_AUTHORITY_UNAVAILABLE_MESSAGE
  });
  assert.doesNotMatch(
    response.body,
    /ECONNREFUSED|postgresql|admin|secret|db\.internal|SELECT|mn_run_jobs/u
  );
});

async function requestThroughEnterpriseVerifier(input: {
  receipt: string;
  verifier: NonNullable<LocalProxyOptions["verifyUsageAssociationReceipt"]>;
}): Promise<{ status: number; body: string }> {
  let resolveCount = 0;
  let reserveCount = 0;
  const proxy = new LocalProxyServer({
    port: 0,
    requireTrustedUsageAssociation: true,
    resolveProvider: async () => {
      resolveCount += 1;
      return undefined;
    },
    verifyUsageAssociationReceipt: input.verifier,
    reserveTrustedUsageAssociation: async (association) => {
      reserveCount += 1;
      return { ...association, reservationId: "unexpected" };
    },
    appendLog: async () => undefined
  });
  const status = await proxy.start();
  try {
    const response = await fetch(
      `http://${status.host}:${status.port}/mn/usage-receipts/${encodeURIComponent(input.receipt)}/v1/responses`,
      { method: "POST", body: "{}" }
    );
    const body = await response.text();
    assert.equal(resolveCount, 0);
    assert.equal(reserveCount, 0);
    return { status: response.status, body };
  } finally {
    await proxy.stop();
  }
}

function tamperReceiptSignature(receipt: string): string {
  const [payload, signature] = receipt.split(".");
  assert.ok(payload && signature);
  const bytes = Buffer.from(signature, "hex");
  bytes[0] = bytes[0]! ^ 0x01;
  return `${payload}.${bytes.toString("hex")}`;
}

function nonCanonicalBase64Url(value: string): string | undefined {
  const decoded = Buffer.from(value, "base64url");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (const replacement of alphabet) {
    if (replacement === value.at(-1)) continue;
    const candidate = `${value.slice(0, -1)}${replacement}`;
    if (Buffer.from(candidate, "base64url").equals(decoded)) return candidate;
  }
  return undefined;
}
