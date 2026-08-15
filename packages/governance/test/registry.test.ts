import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign
} from "node:crypto";
import test from "node:test";
import {
  comparePackVersions,
  createPackLock,
  hashRegistryIndex,
  hashStandardPackManifest,
  packLockDigest,
  planStandardPackRollback,
  planStandardPackSync,
  standardPackReleaseSignaturePayload,
  standardPackSignaturePayload,
  validatePackLock,
  validateStandardPack,
  type PackLock,
  type PublicKey,
  type RegistryIndex,
  type ReleaseMetadata,
  type StandardPackManifest,
  type TrustProfile
} from "../src/index.js";

const NOW = "2026-07-11T12:00:00.000Z";
const GENERATED_AT = "2026-07-11T12:30:00.000Z";

function keys(id = "corp-2026") {
  const pair = generateKeyPairSync("ed25519");
  const publicKey: PublicKey = {
    id,
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    status: "active"
  };
  return { pair, publicKey };
}

function unsignedManifest(
  version = "1.0.0",
  release: StandardPackManifest["release"] = {
    sequence: 1,
    publishedAt: "2026-07-10T00:00:00.000Z"
  }
): StandardPackManifest {
  return {
    schemaVersion: 1,
    id: "corp/default",
    name: "Corporate defaults",
    version,
    description: "Enterprise engineering baseline",
    rules: {
      requiredGates: ["typecheck", "security"],
      allowedProviders: ["claude", "codex"],
      commandAllowlist: ["npm", "node"],
      approvalMode: "on-risk"
    },
    specTemplates: ["service-change"],
    harnessProfiles: ["enterprise"],
    workflows: ["governed-increment-v1"],
    release
  };
}

function signedManifest(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  keyId: string,
  version = "1.0.0",
  release?: StandardPackManifest["release"]
): StandardPackManifest {
  const manifest = unsignedManifest(version, release);
  return {
    ...manifest,
    signature: {
      algorithm: "ed25519",
      keyId,
      value: sign(
        null,
        Buffer.from(standardPackSignaturePayload(manifest)),
        privateKey
      ).toString("base64")
    }
  };
}

function signedRegistry(input: {
  manifest: StandardPackManifest;
  releasePrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  releaseKeyId: string;
  publicKeys?: PublicKey[];
  sequence?: number;
  issuedAt?: string;
  expiresAt?: string;
}): RegistryIndex {
  const base: RegistryIndex = {
    schemaVersion: 1,
    entries: [
      {
        manifest: input.manifest,
        digest: hashStandardPackManifest(input.manifest),
        scope: "organization",
        scopeId: "corp",
        source: "https://registry.example.test/standard-packs.json"
      }
    ],
    publicKeys: input.publicKeys ?? []
  };
  const metadata: ReleaseMetadata = {
    schemaVersion: 1,
    sequence: input.sequence ?? 9,
    issuedAt: input.issuedAt ?? "2026-07-11T00:00:00.000Z",
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    registryDigest: hashRegistryIndex(base)
  };
  return {
    ...base,
    release: {
      ...metadata,
      signature: {
        algorithm: "ed25519",
        keyId: input.releaseKeyId,
        value: sign(
          null,
          Buffer.from(standardPackReleaseSignaturePayload(metadata)),
          input.releasePrivateKey
        ).toString("base64")
      }
    }
  };
}

function trust(publicKeys: PublicKey[], overrides: Partial<TrustProfile> = {}): TrustProfile {
  return {
    id: "corp-registry",
    requireSignature: true,
    requireReleaseMetadata: true,
    requireReleaseSignature: true,
    trustedPublicKeys: publicKeys,
    revokedPublicKeyIds: [],
    verificationTime: NOW,
    ...overrides
  };
}

test("hashes strict canonical manifest content while excluding its signature", () => {
  const first = unsignedManifest();
  const second = {
    workflows: ["governed-increment-v1"],
    harnessProfiles: ["enterprise"],
    specTemplates: ["service-change"],
    release: first.release,
    rules: {
      approvalMode: "on-risk",
      commandAllowlist: ["npm", "node"],
      allowedProviders: ["claude", "codex"],
      requiredGates: ["typecheck", "security"]
    },
    description: first.description,
    version: first.version,
    name: first.name,
    id: first.id,
    schemaVersion: 1 as const
  } satisfies StandardPackManifest;
  const withSignature: StandardPackManifest = {
    ...first,
    signature: {
      algorithm: "ed25519",
      keyId: "irrelevant",
      value: "not-part-of-the-digest"
    }
  };

  assert.equal(hashStandardPackManifest(first), hashStandardPackManifest(second));
  assert.equal(hashStandardPackManifest(first), hashStandardPackManifest(withSignature));
  assert.throws(
    () =>
      hashStandardPackManifest({
        ...first,
        rules: { requiredGates: [() => "execute"] }
      } as unknown as StandardPackManifest),
    /declarative|function/i
  );
});

test("rejects functions, executable fields, and unsupported manifest fields", () => {
  const executable = {
    ...unsignedManifest(),
    scripts: { postInstall: "node install.js" }
  };
  const functionValue = {
    ...unsignedManifest(),
    rules: {
      ...unsignedManifest().rules,
      handler: () => true
    }
  };

  const executableResult = validateStandardPack(executable);
  const functionResult = validateStandardPack(functionValue);
  assert.equal(executableResult.valid, false);
  assert.ok(
    executableResult.issues.some(
      (issue) => issue.code === "EXECUTABLE_FIELD_FORBIDDEN"
    )
  );
  assert.equal(functionResult.valid, false);
  assert.ok(
    functionResult.issues.some((issue) => issue.code === "NON_DECLARATIVE_VALUE")
  );
});

test("rejects waivable targets that are not declared by the same pack", () => {
  const candidate = unsignedManifest();
  const validation = validateStandardPack({
    ...candidate,
    rules: {
      ...candidate.rules,
      requiredGates: ["typecheck"],
      waivableRules: [{ field: "requiredGates", value: "security" }]
    }
  });
  assert.equal(validation.valid, false);
  assert.ok(
    validation.issues.some(
      (issue) =>
        issue.code === "INVALID_MANIFEST" &&
        issue.path === "$.rules.waivableRules[0]"
    )
  );
});

test("verifies entry and release signatures and creates a no-write sync plan", () => {
  const entryKeys = keys("entry-2026");
  const releaseKeys = keys("release-2026");
  const manifest = signedManifest(entryKeys.pair.privateKey, entryKeys.publicKey.id);
  const registry = signedRegistry({
    manifest,
    releasePrivateKey: releaseKeys.pair.privateKey,
    releaseKeyId: releaseKeys.publicKey.id,
    publicKeys: [entryKeys.publicKey, releaseKeys.publicKey]
  });
  const registryBefore = structuredClone(registry);
  const trustProfile = trust([entryKeys.publicKey, releaseKeys.publicKey]);
  const trustBefore = structuredClone(trustProfile);

  const plan = planStandardPackSync([], registry, trustProfile, true);

  assert.equal(plan.valid, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.changed, true);
  assert.equal(plan.entries[0]?.status, "new");
  assert.equal(plan.entries[0]?.signatureVerified, true);
  assert.equal(plan.release?.signatureVerified, true);
  assert.equal(plan.entries[0]?.target?.sequence, manifest.release?.sequence);
  assert.equal(plan.proposedLock?.packs[0]?.id, manifest.id);
  assert.equal(plan.proposedLock?.packs[0]?.sequence, manifest.release?.sequence);
  assert.deepEqual(registry, registryBefore);
  assert.deepEqual(trustProfile, trustBefore);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.entries));
});

test("marks wrong, revoked, ambiguous, and retired signatures invalid", () => {
  const signer = keys("entry-2026");
  const releaseSigner = keys("release-2026");
  const other = keys("other-2026");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id);
  const registry = signedRegistry({
    manifest,
    releasePrivateKey: releaseSigner.pair.privateKey,
    releaseKeyId: releaseSigner.publicKey.id
  });

  const wrong = planStandardPackSync(
    [],
    registry,
    trust([other.publicKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(wrong.entries[0]?.status, "invalid");

  const forgedManifest = signedManifest(
    other.pair.privateKey,
    signer.publicKey.id
  );
  const forged = planStandardPackSync(
    [],
    signedRegistry({
      manifest: forgedManifest,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id
    }),
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(forged.entries[0]?.status, "invalid");
  assert.ok(
    forged.entries[0]?.issues.some((issue) => issue.code === "SIGNATURE_INVALID")
  );

  const revoked = planStandardPackSync(
    [],
    registry,
    trust([signer.publicKey, releaseSigner.publicKey], {
      revokedPublicKeyIds: [signer.publicKey.id]
    }),
    true
  );
  assert.equal(revoked.entries[0]?.status, "invalid");
  assert.ok(revoked.entries[0]?.issues.some((issue) => issue.code === "KEY_REVOKED"));

  const ambiguous = planStandardPackSync(
    [],
    registry,
    trust([
      signer.publicKey,
      { ...signer.publicKey, publicKey: other.publicKey.publicKey },
      releaseSigner.publicKey
    ]),
    true
  );
  assert.equal(ambiguous.entries[0]?.status, "invalid");
  assert.ok(ambiguous.issues.some((issue) => issue.code === "KEY_AMBIGUOUS"));

  const retiredKey: PublicKey = {
    ...signer.publicKey,
    status: "retired",
    retiredAt: "2026-07-01T00:00:00.000Z"
  };
  const retired = planStandardPackSync(
    [],
    registry,
    trust([retiredKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(retired.entries[0]?.status, "invalid");
  assert.ok(retired.entries[0]?.issues.some((issue) => issue.code === "KEY_RETIRED"));
});

test("allows a retired key only for a manifest published before retirement", () => {
  const signer = keys("entry-2025");
  const releaseSigner = keys("release-2026");
  const manifest = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "1.0.0",
    {
      sequence: 1,
      publishedAt: "2025-12-01T00:00:00.000Z"
    }
  );
  const registry = signedRegistry({
    manifest,
    releasePrivateKey: releaseSigner.pair.privateKey,
    releaseKeyId: releaseSigner.publicKey.id
  });
  const retiredKey: PublicKey = {
    ...signer.publicKey,
    status: "retired",
    retiredAt: "2026-01-01T00:00:00.000Z"
  };

  const plan = planStandardPackSync(
    [],
    registry,
    trust([retiredKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(plan.valid, true);
  assert.equal(plan.entries[0]?.signatureVerified, true);
});

test("rejects expired or replayed release metadata", () => {
  const signer = keys("entry-2026");
  const releaseSigner = keys("release-2026");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id);
  const registry = signedRegistry({
    manifest,
    releasePrivateKey: releaseSigner.pair.privateKey,
    releaseKeyId: releaseSigner.publicKey.id,
    expiresAt: "2026-07-11T11:59:59.999Z",
    sequence: 9
  });

  const expired = planStandardPackSync(
    [],
    registry,
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(expired.valid, false);
  assert.equal(expired.entries[0]?.status, "invalid");
  assert.ok(expired.issues.some((issue) => issue.code === "RELEASE_EXPIRED"));

  const { release: _release, ...registryWithoutRelease } = registry;
  const replayed = planStandardPackSync(
    [],
    registryWithoutRelease,
    trust([signer.publicKey, releaseSigner.publicKey], {
      requireReleaseMetadata: false,
      requireReleaseSignature: false,
      minimumReleaseSequence: 10
    }),
    true
  );
  assert.equal(replayed.valid, false);
  assert.ok(replayed.issues.some((issue) => issue.code === "RELEASE_REQUIRED"));

  const sequenceRegistry = signedRegistry({
    manifest,
    releasePrivateKey: releaseSigner.pair.privateKey,
    releaseKeyId: releaseSigner.publicKey.id,
    sequence: 9
  });
  const oldSequence = planStandardPackSync(
    [],
    sequenceRegistry,
    trust([signer.publicKey, releaseSigner.publicKey], {
      minimumReleaseSequence: 10
    }),
    true
  );
  assert.equal(oldSequence.valid, false);
  assert.ok(oldSequence.issues.some((issue) => issue.code === "RELEASE_SEQUENCE_ROLLBACK"));

  const digestTampered = planStandardPackSync(
    [],
    {
      ...sequenceRegistry,
      release: {
        ...sequenceRegistry.release!,
        registryDigest: "f".repeat(64)
      }
    },
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(digestTampered.valid, false);
  assert.ok(
    digestTampered.issues.some(
      (issue) => issue.code === "RELEASE_DIGEST_MISMATCH"
    )
  );
});

test("classifies current, update, and downgrade without changing current locks", () => {
  const signer = keys("entry-2026");
  const releaseSigner = keys("release-2026");
  const currentManifest = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "2.0.0"
  );
  const currentLock = createPackLock(
    [
      {
        id: currentManifest.id,
        version: currentManifest.version,
        digest: hashStandardPackManifest(currentManifest),
        sequence: currentManifest.release!.sequence,
        scope: "organization",
        scopeId: "corp",
        source: "https://registry.example.test/standard-packs.json"
      }
    ],
    GENERATED_AT
  );
  const currentBefore = structuredClone(currentLock);
  const profile = trust([signer.publicKey, releaseSigner.publicKey]);

  const current = planStandardPackSync(
    [currentLock],
    signedRegistry({
      manifest: currentManifest,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id
    }),
    profile,
    true
  );
  assert.equal(current.entries[0]?.status, "current");

  const newer = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "2.1.0",
    {
      sequence: 2,
      publishedAt: "2026-07-10T01:00:00.000Z",
      previousDigest: hashStandardPackManifest(currentManifest)
    }
  );
  const update = planStandardPackSync(
    [currentLock],
    signedRegistry({
      manifest: newer,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id
    }),
    profile,
    false
  );
  assert.equal(update.entries[0]?.status, "update");
  assert.equal(update.dryRun, false);

  const older = signedManifest(signer.pair.privateKey, signer.publicKey.id, "1.9.0");
  const downgrade = planStandardPackSync(
    [currentLock],
    signedRegistry({
      manifest: older,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id
    }),
    profile,
    false
  );
  assert.equal(downgrade.entries[0]?.status, "downgrade");
  assert.equal(downgrade.valid, false);
  assert.equal(downgrade.proposedLock, undefined);
  assert.deepEqual(currentLock, currentBefore);
});

test("creates deterministic lock digests and plans rollback only from trusted history", () => {
  const v1 = {
    id: "corp/default",
    version: "1.0.0",
    digest: "a".repeat(64),
    scope: "organization" as const,
    scopeId: "corp"
  };
  const service = {
    id: "corp/payments",
    version: "3.0.0",
    digest: "b".repeat(64),
    scope: "service" as const,
    scopeId: "payments"
  };
  const first = createPackLock([service, v1], GENERATED_AT);
  const second = createPackLock([v1, service], "2026-07-12T00:00:00.000Z");
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.packs.map((entry) => entry.id), [
    "corp/default",
    "corp/payments"
  ]);
  assert.ok(Object.isFrozen(first.packs));

  const current = createPackLock(
    [{ ...v1, version: "2.0.0", digest: "c".repeat(64) }],
    "2026-07-12T00:00:00.000Z"
  );
  const trustedHistory = [
    {
      lock: first,
      trustedAt: "2026-07-11T13:00:00.000Z",
      approvedBy: "governance@example.com"
    }
  ];

  const rollback = planStandardPackRollback(current, first.digest, trustedHistory);
  assert.equal(rollback.valid, true);
  assert.equal(rollback.status, "rollback");
  assert.equal(rollback.targetLock?.digest, first.digest);
  assert.ok(rollback.diff.some((entry) => entry.status === "downgrade"));

  const untrusted = planStandardPackRollback(current, "d".repeat(64), trustedHistory);
  assert.equal(untrusted.valid, false);
  assert.equal(untrusted.status, "invalid");
  assert.equal(untrusted.targetLock, undefined);
});

test("rejects a tampered trusted historical lock", () => {
  const trusted = createPackLock(
    [
      {
        id: "corp/default",
        version: "1.0.0",
        digest: "a".repeat(64),
        scope: "organization",
        scopeId: "corp"
      }
    ],
    GENERATED_AT
  );
  const current: PackLock = createPackLock(
    [{ ...trusted.packs[0]!, version: "2.0.0", digest: "b".repeat(64) }],
    "2026-07-12T00:00:00.000Z"
  );
  const tampered = {
    ...trusted,
    packs: [{ ...trusted.packs[0]!, version: "0.0.1" }]
  } as PackLock;

  const plan = planStandardPackRollback(current, trusted.digest, [
    {
      lock: tampered,
      trustedAt: "2026-07-11T13:00:00.000Z",
      approvedBy: "governance@example.com"
    }
  ]);
  assert.equal(plan.valid, false);
  assert.ok(plan.issues.some((issue) => issue.code === "LOCK_DIGEST_MISMATCH"));
});

test("implements complete SemVer prerelease validation and precedence", () => {
  for (const version of [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-0.3.7",
    "1.0.0-x.7.z.92+build.5",
    "1.0.0+build.1"
  ]) {
    assert.equal(validateStandardPack(unsignedManifest(version)).valid, true, version);
  }
  for (const version of [
    "01.0.0",
    "1.0.0-01",
    "1.0.0-alpha..1",
    "1.0.0-alpha.",
    "1.0.0+build..1"
  ]) {
    assert.equal(validateStandardPack(unsignedManifest(version)).valid, false, version);
  }

  const precedence = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0"
  ];
  for (let index = 0; index < precedence.length - 1; index += 1) {
    assert.ok(
      comparePackVersions(precedence[index]!, precedence[index + 1]!) < 0,
      `${precedence[index]} must precede ${precedence[index + 1]}`
    );
  }
  assert.equal(comparePackVersions("1.0.0+one", "1.0.0+two"), 0);
  assert.ok(
    comparePackVersions(
      "1.0.0-beta.9007199254740992",
      "1.0.0-beta.9007199254740993"
    ) < 0
  );
  assert.ok(
    comparePackVersions(
      "9007199254740992.0.0",
      "9007199254740993.0.0"
    ) < 0
  );
});

test("treats duplicate key revocation monotonically and independently of declaration order", () => {
  const signer = keys("entry-monotonic");
  const releaseSigner = keys("release-monotonic");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id);
  const registry = signedRegistry({
    manifest,
    releasePrivateKey: releaseSigner.pair.privateKey,
    releaseKeyId: releaseSigner.publicKey.id
  });
  const revoked: PublicKey = { ...signer.publicKey, status: "revoked" };

  const first = planStandardPackSync(
    [],
    registry,
    trust([signer.publicKey, revoked, releaseSigner.publicKey]),
    true
  );
  const second = planStandardPackSync(
    [],
    registry,
    trust([revoked, signer.publicKey, releaseSigner.publicKey]),
    true
  );

  assert.equal(first.valid, false);
  assert.equal(second.valid, false);
  assert.ok(first.entries[0]?.issues.some((issue) => issue.code === "KEY_REVOKED"));
  assert.ok(second.entries[0]?.issues.some((issue) => issue.code === "KEY_REVOKED"));
  assert.deepEqual(
    first.issues.map((issue) => String(issue.code)).sort(),
    second.issues.map((issue) => String(issue.code)).sort()
  );
});

test("requires retired keys to declare a valid retirement instant", () => {
  const signer = keys("entry-retired-missing-date");
  const releaseSigner = keys("release-retired-missing-date");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id);
  const registry = signedRegistry({
    manifest,
    releasePrivateKey: releaseSigner.pair.privateKey,
    releaseKeyId: releaseSigner.publicKey.id
  });
  const plan = planStandardPackSync(
    [],
    registry,
    trust([
      {
        id: signer.publicKey.id,
        publicKey: signer.publicKey.publicKey,
        status: "retired"
      },
      releaseSigner.publicKey
    ]),
    true
  );

  assert.equal(plan.valid, false);
  assert.ok(plan.issues.some((issue) => String(issue.code) === "KEY_RETIRED"));
  assert.equal(plan.entries[0]?.signatureVerified, false);
});

test("enforces pack publication, expiry, sequence, and predecessor invariants", () => {
  const invalidReleases: StandardPackManifest["release"][] = [
    { sequence: 0, publishedAt: "2026-07-10T00:00:00.000Z" },
    { sequence: 2, publishedAt: "2026-07-10T00:00:00.000Z" },
    {
      sequence: 1,
      publishedAt: "2026-07-10T00:00:00.000Z",
      previousDigest: "a".repeat(64)
    },
    {
      sequence: 1,
      publishedAt: "2026-07-10T00:00:00.000Z",
      expiresAt: "2026-07-10T00:00:00.000Z"
    },
    {
      sequence: 1,
      publishedAt: "2026-02-30T00:00:00.000Z"
    }
  ];
  for (const release of invalidReleases) {
    assert.equal(validateStandardPack(unsignedManifest("1.0.0", release)).valid, false);
  }

  const signer = keys("entry-chain");
  const releaseSigner = keys("release-chain");
  const currentManifest = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "1.0.0"
  );
  const currentDigest = hashStandardPackManifest(currentManifest);
  const currentLock = createPackLock(
    [{
      id: currentManifest.id,
      version: currentManifest.version,
      digest: currentDigest,
      scope: "organization",
      scopeId: "corp",
      source: "https://registry.example.test/standard-packs.json"
    }],
    GENERATED_AT
  );
  const badNext = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "1.1.0",
    {
      sequence: 2,
      publishedAt: "2026-07-11T01:00:00.000Z",
      previousDigest: "f".repeat(64)
    }
  );
  const badPlan = planStandardPackSync(
    [currentLock],
    signedRegistry({
      manifest: badNext,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id,
      issuedAt: "2026-07-11T02:00:00.000Z"
    }),
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(badPlan.valid, false);
  assert.ok(
    badPlan.entries[0]?.issues.some(
      (issue) => String(issue.code) === "PACK_RELEASE_CHAIN_INVALID"
    )
  );

  const goodNext = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "1.1.0",
    {
      sequence: 2,
      publishedAt: "2026-07-11T01:00:00.000Z",
      previousDigest: currentDigest
    }
  );
  const goodPlan = planStandardPackSync(
    [currentLock],
    signedRegistry({
      manifest: goodNext,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id,
      issuedAt: "2026-07-11T02:00:00.000Z"
    }),
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(goodPlan.valid, true);
  assert.equal(goodPlan.entries[0]?.status, "update");

  for (const release of [
    {
      sequence: 1,
      publishedAt: "2026-07-11T12:00:00.001Z"
    },
    {
      sequence: 1,
      publishedAt: "2026-07-10T00:00:00.000Z",
      expiresAt: "2026-07-11T12:00:00.000Z"
    }
  ] satisfies StandardPackManifest["release"][]) {
    const candidate = signedManifest(
      signer.pair.privateKey,
      signer.publicKey.id,
      "1.0.1",
      release
    );
    const plan = planStandardPackSync(
      [],
      signedRegistry({
        manifest: candidate,
        releasePrivateKey: releaseSigner.pair.privateKey,
        releaseKeyId: releaseSigner.publicKey.id
      }),
      trust([signer.publicKey, releaseSigner.publicKey]),
      true
    );
    assert.equal(plan.valid, false);
  }
});

test("rejects unknown registry, entry, key, release, and release-signature fields", () => {
  const signer = keys("entry-exact-schema");
  const releaseSigner = keys("release-exact-schema");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id);
  const valid = signedRegistry({
    manifest,
    releasePrivateKey: releaseSigner.pair.privateKey,
    releaseKeyId: releaseSigner.publicKey.id,
    publicKeys: [signer.publicKey, releaseSigner.publicKey]
  });
  const profile = trust([signer.publicKey, releaseSigner.publicKey]);
  const variants: unknown[] = [
    { ...valid, extra: true },
    {
      ...valid,
      entries: [{ ...valid.entries[0]!, extra: true }]
    },
    {
      ...valid,
      publicKeys: [{ ...valid.publicKeys![0]!, extra: true }, valid.publicKeys![1]!]
    },
    {
      ...valid,
      release: { ...valid.release!, extra: true }
    },
    {
      ...valid,
      release: {
        ...valid.release!,
        signature: {
          ...valid.release!.signature!,
          algorithm: "Ed25519"
        }
      }
    }
  ];

  for (const variant of variants) {
    const plan = planStandardPackSync(
      [],
      variant as RegistryIndex,
      profile,
      true
    );
    assert.equal(plan.valid, false);
    assert.ok(
      plan.issues.some((issue) =>
        ["INVALID_REGISTRY", "RELEASE_INVALID", "UNKNOWN_FIELD"].includes(
          String(issue.code)
        )
      )
    );
  }
});

test("returns structured invalid plans for malformed envelopes instead of throwing", () => {
  const profile = trust([],{ requireSignature: false, requireReleaseMetadata: false, requireReleaseSignature: false });
  for (const registry of [null, [], { schemaVersion: 1, entries: "bad" }]) {
    let plan: ReturnType<typeof planStandardPackSync> | undefined;
    assert.doesNotThrow(() => {
      plan = planStandardPackSync([], registry as unknown as RegistryIndex, profile, true);
    });
    assert.equal(plan?.valid, false);
    assert.ok(plan?.issues.some((issue) => issue.code === "INVALID_REGISTRY"));
  }
});

test("returns structured invalid results for malformed key catalogues", () => {
  const signer = keys("entry-malformed-key");
  const releaseSigner = keys("release-malformed-key");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id);
  const registry = signedRegistry({
    manifest,
    releasePrivateKey: releaseSigner.pair.privateKey,
    releaseKeyId: releaseSigner.publicKey.id
  });
  const malformedRegistry = {
    ...registry,
    publicKeys: [null]
  } as unknown as RegistryIndex;
  const malformedTrust = {
    ...trust([signer.publicKey, releaseSigner.publicKey]),
    trustedPublicKeys: [null]
  } as unknown as TrustProfile;

  for (const [candidateRegistry, candidateTrust] of [
    [malformedRegistry, trust([signer.publicKey, releaseSigner.publicKey])],
    [registry, malformedTrust]
  ] as const) {
    let plan: ReturnType<typeof planStandardPackSync> | undefined;
    assert.doesNotThrow(() => {
      plan = planStandardPackSync([], candidateRegistry, candidateTrust, true);
    });
    assert.equal(plan?.valid, false);
  }
});

test("rejects accessors, symbols, non-enumerable fields, and sparse arrays without executing code", () => {
  let getterCalls = 0;
  const accessorManifest = { ...unsignedManifest() } as Record<string, unknown>;
  Object.defineProperty(accessorManifest, "rules", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("must not execute");
    }
  });
  const accessorResult = validateStandardPack(accessorManifest);
  assert.equal(getterCalls, 0);
  assert.equal(accessorResult.valid, false);
  assert.ok(
    accessorResult.issues.some((issue) => issue.code === "NON_DECLARATIVE_VALUE")
  );

  const symbolManifest = { ...unsignedManifest() } as Record<PropertyKey, unknown>;
  symbolManifest[Symbol("hidden")] = "value";
  assert.equal(validateStandardPack(symbolManifest).valid, false);

  const hiddenManifest = { ...unsignedManifest() } as Record<string, unknown>;
  Object.defineProperty(hiddenManifest, "hidden", {
    value: "value",
    enumerable: false
  });
  assert.equal(validateStandardPack(hiddenManifest).valid, false);

  const sparseManifest = {
    ...unsignedManifest(),
    rules: { requiredGates: new Array<string>(1) }
  };
  assert.equal(validateStandardPack(sparseManifest).valid, false);

  let registryGetterCalls = 0;
  const accessorRegistry: Record<string, unknown> = { schemaVersion: 1 };
  Object.defineProperty(accessorRegistry, "entries", {
    enumerable: true,
    get() {
      registryGetterCalls += 1;
      throw new Error("must not execute");
    }
  });
  const plan = planStandardPackSync(
    [],
    accessorRegistry as unknown as RegistryIndex,
    trust([], {
      requireSignature: false,
      requireReleaseMetadata: false,
      requireReleaseSignature: false
    }),
    true
  );
  assert.equal(registryGetterCalls, 0);
  assert.equal(plan.valid, false);
});

test("requires PackLock packs and rejects unknown lock and entry fields", () => {
  const empty = createPackLock([], GENERATED_AT);
  const missingPacks = {
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    digest: packLockDigest([])
  };
  assert.ok(validatePackLock(missingPacks).some((issue) => issue.code === "LOCK_INVALID"));
  assert.ok(
    validatePackLock({ ...empty, extra: true }).some(
      (issue) => issue.code === "LOCK_INVALID"
    )
  );
  const entry = {
    id: "corp/default",
    version: "1.0.0",
    digest: "a".repeat(64),
    scope: "organization" as const,
    scopeId: "corp"
  };
  const valid = createPackLock([entry], GENERATED_AT);
  assert.ok(
    validatePackLock({
      ...valid,
      packs: [{ ...entry, extra: true }]
    }).some((issue) => issue.code === "LOCK_INVALID")
  );
});

test("detects conflicting current locks using the complete identity independent of order", () => {
  const signer = keys("entry-lock-conflict");
  const releaseSigner = keys("release-lock-conflict");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id);
  const digest = hashStandardPackManifest(manifest);
  const base = {
    id: manifest.id,
    version: manifest.version,
    digest,
    scope: "organization" as const,
    scopeId: "corp"
  };
  const firstLock = createPackLock([{ ...base, source: "https://one.test" }], GENERATED_AT);
  const secondLock = createPackLock([{ ...base, source: "https://two.test" }], GENERATED_AT);
  const registry = signedRegistry({
    manifest,
    releasePrivateKey: releaseSigner.pair.privateKey,
    releaseKeyId: releaseSigner.publicKey.id
  });
  const profile = trust([signer.publicKey, releaseSigner.publicKey]);

  const first = planStandardPackSync([firstLock, secondLock], registry, profile, true);
  const second = planStandardPackSync([secondLock, firstLock], registry, profile, true);
  assert.equal(first.valid, false);
  assert.equal(second.valid, false);
  assert.ok(first.issues.some((issue) => issue.code === "LOCK_INVALID"));
  assert.ok(second.issues.some((issue) => issue.code === "LOCK_INVALID"));
  assert.deepEqual(first.entries[0]?.current, second.entries[0]?.current);
});

test("rejects a different digest for an already locked pack version", () => {
  const signer = keys("entry-version-immutable");
  const releaseSigner = keys("release-version-immutable");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id, "2.0.0");
  const current = createPackLock(
    [{
      id: manifest.id,
      version: manifest.version,
      digest: "f".repeat(64),
      scope: "organization",
      scopeId: "corp",
      source: "https://registry.example.test/standard-packs.json"
    }],
    GENERATED_AT
  );
  const plan = planStandardPackSync(
    [current],
    signedRegistry({
      manifest,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id
    }),
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(plan.valid, false);
  assert.equal(plan.entries[0]?.status, "invalid");
  assert.ok(
    plan.entries[0]?.issues.some(
      (issue) => String(issue.code) === "VERSION_DIGEST_CONFLICT"
    )
  );
});

test("rejects cross-scope id-version digest conflicts", () => {
  const signer = keys("entry-cross-scope-version");
  const releaseSigner = keys("release-cross-scope-version");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id);
  const current = createPackLock(
    [{
      id: manifest.id,
      version: manifest.version,
      digest: "f".repeat(64),
      scope: "team",
      scopeId: "payments"
    }],
    GENERATED_AT
  );
  const plan = planStandardPackSync(
    current,
    signedRegistry({
      manifest,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id
    }),
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(plan.valid, false);
  assert.ok(
    plan.entries.some((entry) =>
      entry.issues.some((issue) => issue.code === "VERSION_DIGEST_CONFLICT")
    )
  );
  assert.equal(plan.proposedLock, undefined);
});

test("rejects rollback version-digest conflicts and forward-dated targets", () => {
  const base = {
    id: "corp/default",
    version: "1.0.0",
    scope: "organization" as const,
    scopeId: "corp"
  };
  const current = createPackLock(
    [{ ...base, digest: "b".repeat(64), sequence: 2 }],
    "2026-07-12T00:00:00.000Z"
  );
  const conflicting = createPackLock(
    [{ ...base, digest: "a".repeat(64), sequence: 1 }],
    GENERATED_AT
  );
  const conflictPlan = planStandardPackRollback(current, conflicting.digest, [{
    lock: conflicting,
    trustedAt: "2026-07-11T13:00:00.000Z",
    approvedBy: "governance@example.com"
  }]);
  assert.equal(conflictPlan.valid, false);
  assert.ok(
    conflictPlan.issues.some((issue) => issue.code === "VERSION_DIGEST_CONFLICT")
  );

  const future = createPackLock(
    [{ ...base, version: "2.0.0", digest: "c".repeat(64), sequence: 3 }],
    "2026-07-13T00:00:00.000Z"
  );
  const futurePlan = planStandardPackRollback(current, future.digest, [{
    lock: future,
    trustedAt: "2026-07-13T01:00:00.000Z",
    approvedBy: "governance@example.com"
  }]);
  assert.equal(futurePlan.valid, false);
  assert.ok(
    futurePlan.issues.some((issue) => issue.code === "TRUSTED_HISTORY_INVALID")
  );
});

test("rollback validation never invokes accessors on malformed locks", () => {
  let getterCalls = 0;
  const malformed: Record<string, unknown> = {
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    packs: []
  };
  Object.defineProperty(malformed, "digest", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("must not execute");
    }
  });

  let plan: ReturnType<typeof planStandardPackRollback> | undefined;
  assert.doesNotThrow(() => {
    plan = planStandardPackRollback(
      malformed as unknown as PackLock,
      "f".repeat(64),
      []
    );
  });
  assert.equal(getterCalls, 0);
  assert.equal(plan?.valid, false);
  assert.ok(plan?.issues.some((issue) => issue.code === "LOCK_INVALID"));
});

test("rollback validation returns structured errors for malformed history entries", () => {
  const current = createPackLock([], GENERATED_AT);
  let plan: ReturnType<typeof planStandardPackRollback> | undefined;
  assert.doesNotThrow(() => {
    plan = planStandardPackRollback(
      current,
      "f".repeat(64),
      [null] as unknown as readonly {
        lock: PackLock;
        trustedAt: string;
        approvedBy: string;
      }[]
    );
  });
  assert.equal(plan?.valid, false);
  assert.ok(
    plan?.issues.some((issue) => issue.code === "TRUSTED_HISTORY_INVALID")
  );
});

test("trusted rollback history wrapper is an exact schema", () => {
  const lock = createPackLock([], GENERATED_AT);
  const plan = planStandardPackRollback(lock, lock.digest, [{
    lock,
    trustedAt: "2026-07-11T13:00:00.000Z",
    approvedBy: "governance@example.com",
    signature: "unverified-and-ignored"
  } as never]);
  assert.equal(plan.valid, false);
  assert.ok(
    plan.issues.some((issue) => issue.code === "TRUSTED_HISTORY_INVALID")
  );
});

test("persists release sequence and rejects a signed pack release replay", () => {
  const signer = keys("entry-sequence-chain");
  const releaseSigner = keys("release-sequence-chain");
  const currentManifest = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "10.0.0",
    {
      sequence: 10,
      publishedAt: "2026-07-09T00:00:00.000Z",
      previousDigest: "a".repeat(64)
    }
  );
  const currentDigest = hashStandardPackManifest(currentManifest);
  const currentLock = createPackLock(
    [{
      id: currentManifest.id,
      version: currentManifest.version,
      digest: currentDigest,
      sequence: 10,
      scope: "organization",
      scopeId: "corp",
      source: "https://registry.example.test/standard-packs.json"
    }],
    GENERATED_AT
  );
  const replayedManifest = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "10.1.0",
    {
      sequence: 2,
      publishedAt: "2026-07-11T01:00:00.000Z",
      previousDigest: currentDigest
    }
  );
  const profile = trust([signer.publicKey, releaseSigner.publicKey]);
  const replayed = planStandardPackSync(
    currentLock,
    signedRegistry({
      manifest: replayedManifest,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id,
      issuedAt: "2026-07-11T02:00:00.000Z"
    }),
    profile,
    true
  );

  assert.equal(replayed.valid, false);
  assert.equal(replayed.entries[0]?.target?.sequence, 2);
  assert.ok(
    replayed.entries[0]?.issues.some(
      (issue) => issue.code === "PACK_RELEASE_CHAIN_INVALID"
    )
  );

  const nextManifest = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "10.1.0",
    {
      sequence: 11,
      publishedAt: "2026-07-11T01:00:00.000Z",
      previousDigest: currentDigest
    }
  );
  const next = planStandardPackSync(
    currentLock,
    signedRegistry({
      manifest: nextManifest,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id,
      issuedAt: "2026-07-11T02:00:00.000Z"
    }),
    profile,
    true
  );

  assert.equal(next.valid, true);
  assert.equal(next.entries[0]?.target?.sequence, 11);
  assert.equal(next.proposedLock?.packs[0]?.sequence, 11);
  assert.ok(next.entries[0]?.diff.some((diff) => diff.field === "sequence"));
});

test("keeps sequence-less legacy locks compatible while recording the new sequence", () => {
  const signer = keys("entry-legacy-sequence");
  const releaseSigner = keys("release-legacy-sequence");
  const currentManifest = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "1.0.0"
  );
  const currentDigest = hashStandardPackManifest(currentManifest);
  const legacyLock = createPackLock(
    [{
      id: currentManifest.id,
      version: currentManifest.version,
      digest: currentDigest,
      scope: "organization",
      scopeId: "corp",
      source: "https://registry.example.test/standard-packs.json"
    }],
    GENERATED_AT
  );
  const nextManifest = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "1.1.0",
    {
      sequence: 7,
      publishedAt: "2026-07-11T01:00:00.000Z",
      previousDigest: currentDigest
    }
  );
  const plan = planStandardPackSync(
    legacyLock,
    signedRegistry({
      manifest: nextManifest,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id,
      issuedAt: "2026-07-11T02:00:00.000Z"
    }),
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );

  assert.equal(legacyLock.packs[0]?.sequence, undefined);
  assert.equal(plan.valid, true);
  assert.equal(plan.proposedLock?.packs[0]?.sequence, 7);
});

test("backfills sequence when a legacy lock otherwise matches the registry target", () => {
  const signer = keys("entry-legacy-sequence-backfill");
  const releaseSigner = keys("release-legacy-sequence-backfill");
  const manifest = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "1.0.0"
  );
  const digest = hashStandardPackManifest(manifest);
  const legacyLock = createPackLock(
    [{
      id: manifest.id,
      version: manifest.version,
      digest,
      scope: "organization",
      scopeId: "corp",
      source: "https://registry.example.test/standard-packs.json"
    }],
    GENERATED_AT
  );

  const plan = planStandardPackSync(
    legacyLock,
    signedRegistry({
      manifest,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id
    }),
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );

  assert.equal(plan.valid, true);
  assert.equal(plan.changed, true);
  assert.equal(plan.entries[0]?.status, "update");
  assert.equal(plan.entries[0]?.current?.sequence, undefined);
  assert.equal(plan.entries[0]?.target?.sequence, 1);
  assert.ok(
    plan.entries[0]?.diff.some(
      (diff) => diff.field === "sequence" && diff.before === undefined && diff.after === 1
    )
  );
  assert.equal(plan.proposedLock?.packs[0]?.sequence, 1);
  assert.equal(legacyLock.packs[0]?.sequence, undefined);
});

test("rejects a registry release issued after the verification clock", () => {
  const signer = keys("entry-future-release");
  const releaseSigner = keys("release-future-release");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id);
  const plan = planStandardPackSync(
    [],
    signedRegistry({
      manifest,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id,
      issuedAt: "2026-07-11T12:00:00.001Z"
    }),
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );

  assert.equal(plan.valid, false);
  assert.equal(plan.proposedLock, undefined);
  assert.ok(plan.issues.some((issue) => issue.code === "RELEASE_INVALID"));
});

test("includes sequence in lock validation, digest, diff, and trusted rollback", () => {
  const base = {
    id: "corp/default",
    scope: "organization" as const,
    scopeId: "corp"
  };
  const historical = createPackLock(
    [{ ...base, version: "1.0.0", digest: "a".repeat(64), sequence: 2 }],
    GENERATED_AT
  );
  const current = createPackLock(
    [{ ...base, version: "2.0.0", digest: "b".repeat(64), sequence: 10 }],
    "2026-07-12T00:00:00.000Z"
  );

  assert.notEqual(
    current.digest,
    createPackLock(
      [{ ...base, version: "2.0.0", digest: "b".repeat(64) }],
      "2026-07-12T00:00:00.000Z"
    ).digest
  );
  for (const sequence of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.ok(
      validatePackLock({
        ...current,
        packs: [{ ...current.packs[0]!, sequence }]
      }).some((issue) => issue.code === "LOCK_INVALID")
    );
  }

  const rollback = planStandardPackRollback(current, historical.digest, [{
    lock: historical,
    trustedAt: "2026-07-12T01:00:00.000Z",
    approvedBy: "governance@example.com"
  }]);
  assert.equal(rollback.valid, true);
  assert.equal(rollback.status, "rollback");
  assert.equal(rollback.targetLock?.packs[0]?.sequence, 2);
  assert.ok(
    rollback.diff[0]?.diff.some(
      (diff) => diff.field === "sequence" && diff.before === 10 && diff.after === 2
    )
  );
});

test("requires strict RFC3339 calendar timestamps for locks and trusted history", () => {
  const valid = createPackLock(
    [{
      id: "corp/default",
      version: "1.0.0",
      digest: "a".repeat(64),
      sequence: 1,
      scope: "organization",
      scopeId: "corp"
    }],
    GENERATED_AT
  );
  for (const timestamp of [
    "07/11/2026",
    "2026-07-11",
    "2026-02-30T00:00:00.000Z"
  ]) {
    assert.throws(() => createPackLock(valid.packs, timestamp), /generatedAt/i);
    assert.ok(
      validatePackLock({ ...valid, generatedAt: timestamp }).some(
        (issue) => issue.code === "LOCK_INVALID"
      )
    );
    const rollback = planStandardPackRollback(valid, valid.digest, [{
      lock: valid,
      trustedAt: timestamp,
      approvedBy: "governance@example.com"
    }]);
    assert.equal(rollback.valid, false);
    assert.ok(
      rollback.issues.some((issue) => issue.code === "TRUSTED_HISTORY_INVALID")
    );
  }
});

test("release signature policy requires release metadata", () => {
  const plan = planStandardPackSync(
    [],
    { schemaVersion: 1, entries: [] },
    trust([], {
      requireSignature: false,
      requireReleaseMetadata: false,
      requireReleaseSignature: true
    }),
    true
  );
  assert.equal(plan.valid, false);
  assert.ok(plan.issues.some((issue) => issue.code === "RELEASE_REQUIRED"));
});

test("pack release sequence is unique across scopes and legacy scopes are backfilled", () => {
  const signer = keys("entry-cross-scope-sequence");
  const releaseSigner = keys("release-cross-scope-sequence");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id);
  const digest = hashStandardPackManifest(manifest);
  assert.throws(
    () =>
      createPackLock(
        [
          {
            id: manifest.id,
            version: manifest.version,
            digest,
            sequence: 1,
            scope: "organization",
            scopeId: "corp"
          },
          {
            id: manifest.id,
            version: manifest.version,
            digest,
            sequence: 999,
            scope: "team",
            scopeId: "payments"
          }
        ],
        GENERATED_AT
      ),
    /conflicting release identities/u
  );
  const current = createPackLock(
    [
      {
        id: manifest.id,
        version: manifest.version,
        digest,
        sequence: manifest.release!.sequence,
        scope: "organization",
        scopeId: "corp"
      },
      {
        id: manifest.id,
        version: manifest.version,
        digest,
        scope: "team",
        scopeId: "payments"
      }
    ],
    GENERATED_AT
  );
  const plan = planStandardPackSync(
    current,
    signedRegistry({
      manifest,
      releasePrivateKey: releaseSigner.pair.privateKey,
      releaseKeyId: releaseSigner.publicKey.id
    }),
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(plan.valid, true);
  assert.equal(plan.changed, true);
  assert.equal(
    plan.proposedLock?.packs.find((entry) => entry.scope === "team")?.sequence,
    manifest.release!.sequence
  );
});

test("rollback checks release sequence identity across different scopes", () => {
  const base = {
    id: "corp/default",
    version: "1.0.0",
    digest: "a".repeat(64)
  };
  const current = createPackLock(
    [{ ...base, sequence: 1, scope: "organization", scopeId: "corp" }],
    "2026-07-12T00:00:00.000Z"
  );
  const historical = createPackLock(
    [{ ...base, sequence: 999, scope: "team", scopeId: "payments" }],
    GENERATED_AT
  );
  const plan = planStandardPackRollback(current, historical.digest, [{
    lock: historical,
    trustedAt: "2026-07-11T13:00:00.000Z",
    approvedBy: "governance@example.com"
  }]);
  assert.equal(plan.valid, false);
  assert.ok(
    plan.issues.some((issue) => issue.code === "VERSION_DIGEST_CONFLICT")
  );
});

test("rollback validates every trusted history lock", () => {
  const target = createPackLock([], GENERATED_AT);
  const current = createPackLock([], "2026-07-12T00:00:00.000Z");
  const plan = planStandardPackRollback(current, target.digest, [
    {
      lock: { totally: "malformed" } as never,
      trustedAt: "2026-07-11T13:00:00.000Z",
      approvedBy: "governance@example.com"
    },
    {
      lock: target,
      trustedAt: "2026-07-11T13:00:00.000Z",
      approvedBy: "governance@example.com"
    }
  ]);
  assert.equal(plan.valid, false);
  assert.ok(plan.issues.some((issue) => issue.code === "LOCK_INVALID"));
});

test("proposed lock uses the frozen verification clock without regressing", () => {
  const signer = keys("entry-lock-clock");
  const releaseSigner = keys("release-lock-clock");
  const manifest = signedManifest(signer.pair.privateKey, signer.publicKey.id);
  const registry = signedRegistry({
    manifest,
    releasePrivateKey: releaseSigner.pair.privateKey,
    releaseKeyId: releaseSigner.publicKey.id,
    issuedAt: "2026-07-10T01:00:00.000Z"
  });
  const fresh = planStandardPackSync(
    [],
    registry,
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(fresh.proposedLock?.generatedAt, NOW);

  const oldManifest = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "0.9.0"
  );
  const oldDigest = hashStandardPackManifest(oldManifest);
  const updateManifest = signedManifest(
    signer.pair.privateKey,
    signer.publicKey.id,
    "1.0.0",
    {
      sequence: 2,
      publishedAt: "2026-07-10T02:00:00.000Z",
      previousDigest: oldDigest
    }
  );
  const updateRegistry = signedRegistry({
    manifest: updateManifest,
    releasePrivateKey: releaseSigner.pair.privateKey,
    releaseKeyId: releaseSigner.publicKey.id,
    issuedAt: "2026-07-10T03:00:00.000Z"
  });
  const current = createPackLock(
    [{
      id: oldManifest.id,
      version: oldManifest.version,
      digest: oldDigest,
      sequence: oldManifest.release!.sequence,
      scope: "organization",
      scopeId: "corp"
    }],
    GENERATED_AT
  );
  const update = planStandardPackSync(
    current,
    updateRegistry,
    trust([signer.publicKey, releaseSigner.publicKey]),
    true
  );
  assert.equal(update.proposedLock?.generatedAt, GENERATED_AT);
});
