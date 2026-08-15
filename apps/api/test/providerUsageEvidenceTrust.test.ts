import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from "node:crypto";
import test from "node:test";
import {
  createProviderUsageEvidenceVerifier,
  providerUsageEvidenceSigningPayload,
  ProviderUsageEvidenceInvalidError,
  ProviderUsageEvidenceVerificationUnavailableError,
  type ExpectedProviderUsageEvidenceBindings,
  type ProviderUsageEvidenceClaims,
  type ProviderUsageEvidenceEnvelope,
  type ProviderUsageEvidenceTrustProfile,
  type ProviderUsageEvidenceTrustKey,
  type UnsignedProviderUsageEvidenceEnvelope
} from "../src/providerUsageEvidenceTrust.js";

const NOW = "2026-07-12T12:00:00.000Z";
const ISSUED_AT = "2026-07-12T11:55:00.000Z";
const OUTBOUND_DIGEST = "a".repeat(64);
const DISPATCH_DIGEST = "d".repeat(64);
const primaryPair = generateKeyPairSync("ed25519");
const secondaryPair = generateKeyPairSync("ed25519");
const untrustedPair = generateKeyPairSync("ed25519");

const baseClaims: ProviderUsageEvidenceClaims = {
  kind: "invoice",
  app: "codex",
  tenantId: "tenant-a",
  runId: "run-a",
  logicalRequestId: "logical-a",
  providerId: "provider-a",
  providerAccountId: "account-a",
  providerRequestId: "provider-request-a",
  dispatchRequestDigest: DISPATCH_DIGEST,
  outboundRequestKeyDigest: OUTBOUND_DIGEST,
  model: "model-a",
  statusCode: 200,
  tokens: {
    inputTokens: 17,
    outputTokens: 5,
    cachedInputTokens: 3,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 1,
    reasoningOutputTokens: 4
  },
  authoritativeCostUsd: 0.125,
  sourceReference: "invoice-2026-0001",
  issuedAt: ISSUED_AT
};

const expected: ExpectedProviderUsageEvidenceBindings = {
  kind: baseClaims.kind,
  app: baseClaims.app,
  tenantId: baseClaims.tenantId,
  runId: baseClaims.runId,
  logicalRequestId: baseClaims.logicalRequestId,
  providerId: baseClaims.providerId,
  providerAccountId: baseClaims.providerAccountId,
  providerRequestId: baseClaims.providerRequestId,
  dispatchRequestDigest: baseClaims.dispatchRequestDigest,
  outboundRequestKeyDigest: baseClaims.outboundRequestKeyDigest,
  model: baseClaims.model,
  statusCode: baseClaims.statusCode,
  tokens: baseClaims.tokens,
  authoritativeCostUsd: baseClaims.authoritativeCostUsd,
  sourceReference: baseClaims.sourceReference,
  issuer: "billing.example.test",
  verificationTime: NOW
};

test("trusted Ed25519 evidence verifies all bindings and returns a frozen result", () => {
  const envelope = signedEnvelope();
  const result = createProviderUsageEvidenceVerifier(profile()).verify(
    envelope,
    expected
  );

  assert.deepEqual(result.claims, baseClaims);
  assert.equal(result.issuer, "billing.example.test");
  assert.equal(result.keyId, "key-primary");
  assert.equal(
    result.signatureDigest,
    createHash("sha256")
      .update(Buffer.from(envelope.signature, "base64url"))
      .digest("hex")
  );
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.claims));
  assert.ok(Object.isFrozen(result.claims.tokens));
});

test("signed dispatch evidence remains exact when no provider wire key exists", () => {
  const { outboundRequestKeyDigest: _outbound, ...withoutWireKey } = baseClaims;
  const claims: ProviderUsageEvidenceClaims = withoutWireKey;
  const envelope = signedEnvelope({ claims });
  const expectedWithoutWireKey = expectedFor(claims);
  assert.equal(
    createProviderUsageEvidenceVerifier(profile()).verify(
      envelope,
      expectedWithoutWireKey
    ).claims.dispatchRequestDigest,
    DISPATCH_DIGEST
  );
});

test("multiple keys support PEM, DER base64, and bounded retired-key history", () => {
  const activeDer = secondaryPair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const trust = profile([
    key("key-primary", primaryPair.publicKey, "retired", "2026-07-12T11:56:00.000Z"),
    { keyId: "key-secondary", publicKey: activeDer, status: "active" }
  ]);
  const verifier = createProviderUsageEvidenceVerifier(trust);

  assert.equal(verifier.verify(signedEnvelope(), expected).keyId, "key-primary");
  const secondary = signedEnvelope({
    keyId: "key-secondary",
    privateKey: secondaryPair.privateKey
  });
  assert.equal(verifier.verify(secondary, expected).keyId, "key-secondary");

  const afterRetirementClaims = {
    ...baseClaims,
    issuedAt: "2026-07-12T11:57:00.000Z"
  };
  assertInvalid(() => verifier.verify(
    signedEnvelope({ claims: afterRetirementClaims }),
    expected
  ));
});

test("strict envelope and detached signature reject tamper, unsigned data and forged zero", () => {
  const verifier = createProviderUsageEvidenceVerifier(profile());
  const envelope = signedEnvelope();

  assertInvalid(() => verifier.verify(
    { ...envelope, unknown: true },
    expected
  ));
  assertInvalid(() => verifier.verify(
    { ...envelope, claims: { ...envelope.claims, unknown: true } },
    expected
  ));
  assertInvalid(() => verifier.verify(
    {
      ...envelope,
      claims: {
        ...envelope.claims,
        tokens: { ...envelope.claims.tokens, unknown: 1 }
      }
    },
    expected
  ));
  const { signature: _signature, ...unsigned } = envelope;
  assertInvalid(() => verifier.verify(unsigned, expected));
  assertInvalid(() => verifier.verify(
    { ...envelope, signature: `${envelope.signature}=` },
    expected
  ));
  assertInvalid(() => verifier.verify(
    { ...envelope, algorithm: "Ed25519" },
    expected
  ));
  assertInvalid(() => verifier.verify(
    { ...envelope, source: "unsigned-source" },
    expected
  ));

  const zeroTokens = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningOutputTokens: 0
  };
  const forgedZero = {
    ...envelope,
    claims: {
      ...envelope.claims,
      tokens: zeroTokens,
      authoritativeCostUsd: 0
    }
  };
  assertInvalid(() => verifier.verify(forgedZero, {
    ...expected,
    tokens: zeroTokens,
    authoritativeCostUsd: 0
  }));
});

test("expected dispatch and reconciliation bindings are all exact", async (t) => {
  const envelope = signedEnvelope();
  const verifier = createProviderUsageEvidenceVerifier(profile());
  const cases: ReadonlyArray<readonly [string, ExpectedProviderUsageEvidenceBindings]> = [
    ["kind", { ...expected, kind: "provider" }],
    ["app", { ...expected, app: "claude" }],
    ["tenant", { ...expected, tenantId: "tenant-b" }],
    ["run", { ...expected, runId: "run-b" }],
    ["logical request", { ...expected, logicalRequestId: "logical-b" }],
    ["provider", { ...expected, providerId: "provider-b" }],
    ["provider account", { ...expected, providerAccountId: "account-b" }],
    ["provider request", { ...expected, providerRequestId: "provider-request-b" }],
    ["dispatch request digest", {
      ...expected,
      dispatchRequestDigest: "c".repeat(64)
    }],
    ["outbound request digest", {
      ...expected,
      outboundRequestKeyDigest: "b".repeat(64)
    }],
    ["model", { ...expected, model: "model-b" }],
    ["status", { ...expected, statusCode: 201 }],
    ["tokens", {
      ...expected,
      tokens: { ...expected.tokens, reasoningOutputTokens: 5 }
    }],
    ["cost", { ...expected, authoritativeCostUsd: 0.25 }],
    ["source", { ...expected, sourceReference: "invoice-other" }],
    ["issuer", { ...expected, issuer: "another.example.test" }]
  ];

  for (const [name, mismatch] of cases) {
    await t.test(name, () => assertInvalid(() => verifier.verify(envelope, mismatch)));
  }
});

test("issuer constraints reject otherwise valid provider and account claims", () => {
  const verifier = createProviderUsageEvidenceVerifier(profile());
  const providerClaims = { ...baseClaims, providerId: "provider-outside-scope" };
  assertInvalid(() => verifier.verify(
    signedEnvelope({ claims: providerClaims }),
    expectedFor(providerClaims)
  ));

  const accountClaims = { ...baseClaims, providerAccountId: "account-outside-scope" };
  assertInvalid(() => verifier.verify(
    signedEnvelope({ claims: accountClaims }),
    expectedFor(accountClaims)
  ));
});

test("wrong issuer, unknown/wrong key, revoked key and untrusted signature are invalid", () => {
  const verifier = createProviderUsageEvidenceVerifier(profile([
    key("key-primary", primaryPair.publicKey),
    key("key-secondary", secondaryPair.publicKey),
    key("key-revoked", untrustedPair.publicKey, "revoked")
  ]));

  const wrongIssuer = signedEnvelope({ issuer: "untrusted.example.test" });
  assertInvalid(() => verifier.verify(wrongIssuer, {
    ...expected,
    issuer: "untrusted.example.test"
  }));

  assertInvalid(() => verifier.verify(
    signedEnvelope({ keyId: "key-unknown" }),
    expected
  ));
  assertInvalid(() => verifier.verify(
    signedEnvelope({ keyId: "key-secondary" }),
    expected
  ));
  assertInvalid(() => verifier.verify(
    signedEnvelope({
      keyId: "key-revoked",
      privateKey: untrustedPair.privateKey
    }),
    expected
  ));
  assertInvalid(() => verifier.verify(
    signedEnvelope({ privateKey: untrustedPair.privateKey }),
    expected
  ));
});

test("invalid timestamps, future evidence and configured stale evidence are rejected", () => {
  const normal = createProviderUsageEvidenceVerifier(profile());
  assertInvalid(() => normal.verify(
    signedEnvelope({ claims: { ...baseClaims, issuedAt: "2026-07-12T11:55:00Z" } }),
    expected
  ));
  const futureClaims = {
    ...baseClaims,
    issuedAt: "2026-07-12T12:01:01.000Z"
  };
  assertInvalid(() => normal.verify(
    signedEnvelope({ claims: futureClaims }),
    expectedFor(futureClaims)
  ));

  const ageLimited = createProviderUsageEvidenceVerifier({
    ...profile(),
    maxEvidenceAgeSeconds: 60
  });
  assertInvalid(() => ageLimited.verify(signedEnvelope(), expected));
});

test("missing or malformed trust anchors are unavailable without leaking bindings", () => {
  const unavailable = capture(() => createProviderUsageEvidenceVerifier(undefined)
    .verify(signedEnvelope(), expected));
  assert.ok(unavailable instanceof ProviderUsageEvidenceVerificationUnavailableError);
  assert.equal(unavailable.code, "provider_usage_evidence_verification_unavailable");
  assert.equal(unavailable.message, "Provider usage evidence verification is unavailable");
  assert.doesNotMatch(unavailable.message, /tenant-a|account-a|billing/u);

  const malformed = createProviderUsageEvidenceVerifier({
    schemaVersion: 1,
    issuers: []
  });
  const malformedError = capture(() => malformed.verify(signedEnvelope(), expected));
  assert.ok(malformedError instanceof ProviderUsageEvidenceVerificationUnavailableError);

  const invalidExpected = capture(() => createProviderUsageEvidenceVerifier(profile())
    .verify(signedEnvelope(), {
      ...expected,
      verificationTime: "not-an-instant"
    }));
  assert.ok(invalidExpected instanceof ProviderUsageEvidenceVerificationUnavailableError);
});

function signedEnvelope(options: {
  readonly claims?: ProviderUsageEvidenceClaims;
  readonly issuer?: string;
  readonly keyId?: string;
  readonly privateKey?: KeyObject;
} = {}): ProviderUsageEvidenceEnvelope {
  const unsigned: UnsignedProviderUsageEvidenceEnvelope = {
    schemaVersion: 2,
    claims: options.claims ?? baseClaims,
    algorithm: "ed25519",
    keyId: options.keyId ?? "key-primary",
    issuer: options.issuer ?? "billing.example.test"
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(providerUsageEvidenceSigningPayload(unsigned), "utf8"),
      options.privateKey ?? primaryPair.privateKey
    ).toString("base64url")
  };
}

function expectedFor(
  claims: ProviderUsageEvidenceClaims
): ExpectedProviderUsageEvidenceBindings {
  const { outboundRequestKeyDigest: _outbound, ...expectedWithoutWireKey } = expected;
  return {
    ...expectedWithoutWireKey,
    kind: claims.kind,
    app: claims.app,
    tenantId: claims.tenantId,
    runId: claims.runId,
    logicalRequestId: claims.logicalRequestId,
    providerId: claims.providerId,
    providerAccountId: claims.providerAccountId,
    providerRequestId: claims.providerRequestId,
    dispatchRequestDigest: claims.dispatchRequestDigest,
    ...(claims.outboundRequestKeyDigest
      ? { outboundRequestKeyDigest: claims.outboundRequestKeyDigest }
      : {}),
    model: claims.model,
    statusCode: claims.statusCode,
    tokens: claims.tokens,
    authoritativeCostUsd: claims.authoritativeCostUsd,
    sourceReference: claims.sourceReference
  };
}

function profile(
  keys: readonly ProviderUsageEvidenceTrustKey[] = [
    key("key-primary", primaryPair.publicKey)
  ]
): ProviderUsageEvidenceTrustProfile {
  return {
    schemaVersion: 1,
    issuers: [{
      issuer: "billing.example.test",
      providerIds: ["provider-a"],
      providerAccountIds: ["account-a"],
      keys
    }],
    maxFutureSkewSeconds: 60
  };
}

function key(
  keyId: string,
  publicKey: KeyObject,
  status: ProviderUsageEvidenceTrustKey["status"] = "active",
  retiredAt?: string
): ProviderUsageEvidenceTrustKey {
  return {
    keyId,
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    status,
    ...(retiredAt ? { retiredAt } : {})
  };
}

function assertInvalid(callback: () => unknown): void {
  const error = capture(callback);
  assert.ok(error instanceof ProviderUsageEvidenceInvalidError);
  assert.equal(error.code, "provider_usage_evidence_invalid");
  assert.equal(error.message, "Provider usage evidence is invalid");
  assert.doesNotMatch(error.message, /tenant-a|account-a|provider-request-a/u);
}

function capture(callback: () => unknown): Error & { readonly code?: string } {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected callback to throw");
}
