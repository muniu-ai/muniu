import assert from "node:assert/strict";
import test from "node:test";
import {
  GovernanceResolutionError,
  canonicalJson,
  explainGovernance,
  resolveGovernance,
  validateStandardPack,
  type GovernanceIssueCode,
  type PackLock,
  type PolicyRuleSet,
  type ScopedGovernanceLayer,
  type StandardPackManifest,
  type Waiver
} from "../src/index.js";

const DIGEST_A = "a".repeat(64);

function layer(
  scope: ScopedGovernanceLayer["scope"],
  policy: PolicyRuleSet,
  scopeId = `${scope}-1`
): ScopedGovernanceLayer {
  return {
    scope,
    scopeId,
    source: {
      id: `${scope}/standard`,
      version: "1.0.0",
      digest: DIGEST_A
    },
    policy
  };
}

function assertResolutionIssue(
  operation: () => unknown,
  expectedCode: GovernanceIssueCode,
  expectedField?: string
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof GovernanceResolutionError);
    assert.equal(error.code, "GOVERNANCE_RESOLUTION_FAILED");
    const issue = error.issues.find((candidate) => candidate.code === expectedCode);
    assert.ok(issue, `expected issue ${expectedCode}`);
    if (expectedField) {
      assert.equal(issue.field, expectedField);
    }
    return true;
  });
}

test("merges scoped policy layers with monotonic enterprise semantics", () => {
  const builtin = layer("builtin", {
    requiredGates: ["unit_test", "typecheck"],
    deny: ["git.force-push"],
    protectedPaths: [".env"],
    allowedProviders: ["claude", "codex"],
    commandAllowlist: ["node", "npm", "go"],
    networkAllowlist: ["registry.npmjs.org", "proxy.corp"],
    budgets: {
      maxCandidates: 4,
      maxDurationSeconds: 7_200,
      maxTokens: 100_000,
      maxCostUsd: 50,
      maxRepairAttempts: 5,
      maxChangedFiles: 40,
      maxChangedLines: 2_000
    },
    approvalMode: "never"
  });
  const organization = layer("organization", {
    requiredGates: ["security", "typecheck"],
    deny: ["network.unrestricted"],
    protectedPaths: ["secrets/"],
    allowedProviders: ["codex"],
    commandAllowlist: ["npm", "go"],
    networkAllowlist: ["proxy.corp"],
    budgets: {
      maxDurationSeconds: 3_600,
      maxTokens: 50_000,
      maxRepairAttempts: 3
    },
    approvalMode: "on-risk"
  });
  const project = layer("project", {
    requiredGates: ["contract"],
    deny: ["database.shared-write"],
    protectedPaths: ["infra/prod/"],
    commandAllowlist: ["npm"],
    budgets: {
      maxTokens: 60_000,
      maxCostUsd: 20,
      maxChangedFiles: 12
    },
    approvalMode: "before-merge"
  });

  const snapshot = resolveGovernance([project, builtin, organization], {
    now: "2026-07-11T00:00:00.000Z",
    specRef: { specSetId: "checkout", revision: 3, digest: "b".repeat(64) },
    workflowRef: {
      id: "governed-increment-v1",
      version: "1",
      digest: "c".repeat(64)
    },
    harnessProfileRef: {
      id: "enterprise",
      version: "1",
      digest: "d".repeat(64)
    }
  });

  assert.deepEqual(snapshot.layers.map((item) => item.scope), [
    "builtin",
    "organization",
    "project"
  ]);
  assert.deepEqual(snapshot.policy.requiredGates, [
    "contract",
    "security",
    "typecheck",
    "unit_test"
  ]);
  assert.deepEqual(snapshot.policy.deny, [
    "database.shared-write",
    "git.force-push",
    "network.unrestricted"
  ]);
  assert.deepEqual(snapshot.policy.protectedPaths, [
    ".env",
    "infra/prod/",
    "secrets/"
  ]);
  assert.deepEqual(snapshot.policy.allowedProviders, ["codex"]);
  assert.deepEqual(snapshot.policy.commandAllowlist, ["npm"]);
  assert.deepEqual(snapshot.policy.networkAllowlist, ["proxy.corp"]);
  assert.deepEqual(snapshot.policy.budgets, {
    maxCandidates: 4,
    maxDurationSeconds: 3_600,
    maxTokens: 50_000,
    maxCostUsd: 20,
    maxRepairAttempts: 3,
    maxChangedFiles: 12,
    maxChangedLines: 2_000
  });
  assert.equal(snapshot.policy.approvalMode, "before-merge");
  assert.equal(snapshot.specRef?.revision, 3);
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
});

test("intersects only layers that explicitly declare an allowlist", () => {
  const snapshot = resolveGovernance([
    layer("builtin", { requiredGates: ["typecheck"] }),
    layer("organization", { commandAllowlist: ["npm", "node"] }),
    layer("project", { requiredGates: ["unit_test"] })
  ]);

  assert.deepEqual(snapshot.policy.commandAllowlist, ["node", "npm"]);
  assert.equal(snapshot.policy.allowedProviders, undefined);
  assert.equal(snapshot.policy.networkAllowlist, undefined);
});

test("reports a structured error when an explicit allowlist intersection is empty", () => {
  assertResolutionIssue(
    () =>
      resolveGovernance([
        layer("builtin", { allowedProviders: ["claude"] }),
        layer("organization", { allowedProviders: ["codex"] })
      ]),
    "EMPTY_ALLOWLIST",
    "allowedProviders"
  );

  assertResolutionIssue(
    () => resolveGovernance([layer("builtin", { commandAllowlist: [] })]),
    "EMPTY_ALLOWLIST",
    "commandAllowlist"
  );
});

test("applies a valid, scoped, unexpired waiver only to explicitly waivable rules", () => {
  const waivers: Waiver[] = [
    {
      id: "waive-lint",
      target: { field: "requiredGates", value: "lint" },
      scope: { level: "project", id: "payments" },
      reason: "Legacy linter replacement is approved",
      approvedBy: "reviewer@example.com",
      approvedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z"
    },
    {
      id: "waive-network",
      target: { field: "deny", value: "network.test-sandbox" },
      scope: { level: "project", id: "payments" },
      reason: "Ephemeral test endpoint",
      approvedBy: "security@example.com",
      approvedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z"
    },
    {
      id: "waive-fixture",
      target: { field: "protectedPaths", value: "fixtures/generated/" },
      scope: { level: "project", id: "payments" },
      reason: "Generated fixture refresh",
      approvedBy: "owner@example.com",
      approvedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z"
    }
  ];
  const originalWaivers = structuredClone(waivers);
  const snapshot = resolveGovernance(
    [
      layer("builtin", {
        requiredGates: ["lint", "typecheck"],
        deny: ["network.test-sandbox", "network.production"],
        protectedPaths: ["fixtures/generated/", ".env"],
        waivableRules: [
          { field: "requiredGates", value: "lint" },
          { field: "deny", value: "network.test-sandbox" },
          { field: "protectedPaths", value: "fixtures/generated/" }
        ]
      }),
      layer("project", {}, "payments")
    ],
    { now: "2026-07-11T00:00:00.000Z", waivers }
  );

  assert.deepEqual(snapshot.policy.requiredGates, ["typecheck"]);
  assert.deepEqual(snapshot.policy.deny, ["network.production"]);
  assert.deepEqual(snapshot.policy.protectedPaths, [".env"]);
  assert.deepEqual(snapshot.appliedWaivers.map((waiver) => waiver.id), [
    "waive-fixture",
    "waive-lint",
    "waive-network"
  ]);
  assert.deepEqual(waivers, originalWaivers);
});

test("rejects expired, malformed, scope-mismatched, and non-waivable waivers", () => {
  const base = [
    layer("builtin", {
      requiredGates: ["security"],
      waivableRules: [{ field: "requiredGates", value: "security" }]
    }),
    layer("organization", {
      requiredGates: ["security"]
    }),
    layer("project", {}, "payments")
  ];
  const validMetadata = {
    target: { field: "requiredGates", value: "security" } as const,
    scope: { level: "project", id: "payments" } as const,
    reason: "Temporary exception",
    approvedBy: "reviewer@example.com",
    approvedAt: "2026-07-01T00:00:00.000Z"
  };

  assertResolutionIssue(
    () =>
      resolveGovernance(base, {
        now: "2026-07-11T00:00:00.000Z",
        waivers: [
          {
            id: "expired",
            ...validMetadata,
            expiresAt: "2026-07-10T23:59:59.999Z"
          }
        ]
      }),
    "WAIVER_EXPIRED"
  );

  assertResolutionIssue(
    () =>
      resolveGovernance(base, {
        waivers: [
          {
            id: "malformed",
            target: { field: "requiredGates", value: "security" },
            scope: undefined,
            reason: " ",
            approvedBy: "",
            expiresAt: "not-a-date"
          } as unknown as Waiver
        ]
      }),
    "WAIVER_INVALID"
  );

  assertResolutionIssue(
    () =>
      resolveGovernance(base, {
        waivers: [
          {
            id: "wrong-scope",
            ...validMetadata,
            scope: { level: "project", id: "catalog" },
            expiresAt: "2026-08-01T00:00:00.000Z"
          }
        ]
      }),
    "WAIVER_SCOPE_MISMATCH"
  );

  assertResolutionIssue(
    () =>
      resolveGovernance(base, {
        waivers: [
          {
            id: "non-waivable-origin",
            ...validMetadata,
            expiresAt: "2026-08-01T00:00:00.000Z"
          }
        ]
      }),
    "WAIVER_TARGET_NON_WAIVABLE"
  );
});

test("produces a deterministic semantic digest without mutating caller input", () => {
  const layers: ScopedGovernanceLayer[] = [
    layer("project", {
      requiredGates: ["unit_test", "contract", "unit_test"],
      commandAllowlist: ["node", "npm"]
    }),
    layer("builtin", {
      requiredGates: ["typecheck"],
      commandAllowlist: ["npm", "node", "go"]
    })
  ];
  const original = structuredClone(layers);

  const first = resolveGovernance(layers, { now: "2026-01-01T00:00:00.000Z" });
  const second = resolveGovernance(
    [
      layer("builtin", {
        requiredGates: ["typecheck"],
        commandAllowlist: ["go", "node", "npm"]
      }),
      layer("project", {
        requiredGates: ["contract", "unit_test"],
        commandAllowlist: ["npm", "node"]
      })
    ],
    { now: "2026-07-11T00:00:00.000Z" }
  );

  assert.deepEqual(layers, original);
  assert.equal(first.digest, second.digest);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.policy));
  assert.ok(Object.isFrozen(first.policy.requiredGates));
  assert.throws(() => {
    (first.policy.requiredGates as string[]).push("security");
  }, TypeError);

  const changed = resolveGovernance([
    ...layers,
    layer("service", { requiredGates: ["security"] })
  ]);
  assert.notEqual(changed.digest, first.digest);
});

test("explains effective decisions and their policy sources", () => {
  const snapshot = resolveGovernance([
    layer("builtin", {
      requiredGates: ["typecheck"],
      commandAllowlist: ["npm", "node"],
      budgets: { maxTokens: 100_000 },
      approvalMode: "never"
    }),
    layer("organization", {
      requiredGates: ["security"],
      commandAllowlist: ["npm"],
      budgets: { maxTokens: 50_000 },
      approvalMode: "on-risk"
    })
  ]);

  const explanation = explainGovernance(snapshot);
  assert.equal(explanation.digest, snapshot.digest);
  assert.deepEqual(explanation.sources.map((source) => source.scope), [
    "builtin",
    "organization"
  ]);
  const gateDecision = explanation.decisions.find(
    (decision) => decision.field === "requiredGates"
  );
  assert.equal(gateDecision?.strategy, "union");
  assert.deepEqual(gateDecision?.effectiveValue, ["security", "typecheck"]);
  assert.equal(gateDecision?.sourceIds.length, 2);
  const approvalDecision = explanation.decisions.find(
    (decision) => decision.field === "approvalMode"
  );
  assert.equal(approvalDecision?.strategy, "strictest");
  assert.match(approvalDecision?.summary ?? "", /on-risk/);
});

test("exports versioned standard pack and lock contracts", () => {
  const pack: StandardPackManifest = {
    schemaVersion: 1,
    id: "corp/default",
    name: "Corporate defaults",
    version: "2.1.0",
    description: "Baseline engineering governance",
    rules: {
      requiredGates: ["typecheck"],
      allowedProviders: ["claude", "codex"],
      approvalMode: "on-risk"
    },
    specTemplates: ["service-change"],
    harnessProfiles: ["enterprise"],
    workflows: ["governed-increment-v1"],
    release: {
      sequence: 7,
      publishedAt: "2026-07-11T00:00:00.000Z"
    },
    signature: {
      algorithm: "ed25519",
      keyId: "corp-2026",
      value: "base64-signature"
    }
  };
  const lock: PackLock = {
    schemaVersion: 1,
    generatedAt: "2026-07-11T00:00:00.000Z",
    packs: [
      {
        id: pack.id,
        version: pack.version,
        digest: DIGEST_A,
        scope: "organization",
        scopeId: "corp"
      }
    ],
    digest: "b".repeat(64)
  };

  assert.equal(pack.signature?.algorithm, "ed25519");
  assert.equal(lock.packs[0]?.id, "corp/default");
});

test("rejects malformed immutable Spec, Workflow, and Harness references", () => {
  assertResolutionIssue(
    () =>
      resolveGovernance([layer("builtin", {})], {
        specRef: {
          specSetId: "../../outside",
          revision: 1,
          digest: "a".repeat(64)
        }
      }),
    "INVALID_REFERENCE",
    "specRef"
  );
  assertResolutionIssue(
    () =>
      resolveGovernance([layer("builtin", {})], {
        specRef: { specSetId: " ", revision: 0, digest: "not-a-digest" }
      }),
    "INVALID_REFERENCE",
    "specRef"
  );
  assertResolutionIssue(
    () =>
      resolveGovernance([layer("builtin", {})], {
        workflowRef: { id: "governed-increment-v1", version: " ", digest: "bad" }
      }),
    "INVALID_REFERENCE",
    "workflowRef"
  );
  assertResolutionIssue(
    () =>
      resolveGovernance([layer("builtin", {})], {
        harnessProfileRef: { id: " ", version: "1" } as never
      }),
    "INVALID_REFERENCE",
    "harnessProfileRef"
  );
  assertResolutionIssue(
    () =>
      resolveGovernance([layer("builtin", {})], {
        workflowRef: {
          id: "governed-increment-v1",
          version: "1"
        } as never
      }),
    "INVALID_REFERENCE",
    "workflowRef"
  );
  assertResolutionIssue(
    () =>
      resolveGovernance([layer("builtin", {})], {
        harnessProfileRef: { id: "enterprise", version: "1" } as never
      }),
    "INVALID_REFERENCE",
    "harnessProfileRef"
  );
});

test("requires waiver approval timestamps with timezone and a valid approval window", () => {
  const baseLayer = layer("project", {
    requiredGates: ["security"],
    waivableRules: [{ field: "requiredGates", value: "security" }]
  }, "payments");
  const baseWaiver: Waiver = {
    id: "waive-security",
    target: { field: "requiredGates", value: "security" },
    scope: { level: "project", id: "payments" },
    reason: "Approved test exception",
    approvedBy: "reviewer@example.com",
    approvedAt: "2026-07-11T11:00:00.000Z",
    expiresAt: "2026-07-12T00:00:00.000Z"
  };

  assertResolutionIssue(
    () =>
      resolveGovernance([baseLayer], {
        now: "2026-07-11T12:00:00.000Z",
        waivers: [{ ...baseWaiver, approvedAt: "2026-07-11T11:00:00" }]
      }),
    "WAIVER_INVALID"
  );
  assertResolutionIssue(
    () =>
      resolveGovernance([baseLayer], {
        now: "2026-07-11T12:00:00.000Z",
        waivers: [{ ...baseWaiver, approvedAt: "2026-07-11T12:00:00.001Z" }]
      }),
    "WAIVER_INVALID"
  );
  assertResolutionIssue(
    () =>
      resolveGovernance([baseLayer], {
        now: "2026-07-11T12:00:00.000Z",
        waivers: [{ ...baseWaiver, approvedAt: baseWaiver.expiresAt }]
      }),
    "WAIVER_INVALID"
  );
});

test("enforces one active scope id per level and consistent explicit bindings", () => {
  assertResolutionIssue(
    () =>
      resolveGovernance([
        layer("project", { requiredGates: ["typecheck"] }, "payments"),
        layer("project", { requiredGates: ["security"] }, "catalog")
      ]),
    "SCOPE_CONFLICT",
    "scopeBindings.project"
  );
  assertResolutionIssue(
    () =>
      resolveGovernance(
        [layer("project", { requiredGates: ["typecheck"] }, "payments")],
        { scopeBindings: { project: "catalog" } }
      ),
    "SCOPE_BINDING_MISMATCH",
    "scopeBindings.project"
  );
});

test("rejects duplicate source identities and duplicate waiver ids", () => {
  const duplicateSource = layer("project", { requiredGates: ["security"] }, "payments");
  assertResolutionIssue(
    () => resolveGovernance([duplicateSource, structuredClone(duplicateSource)]),
    "DUPLICATE_LAYER_SOURCE"
  );

  const waiver: Waiver = {
    id: "duplicate-waiver",
    target: { field: "requiredGates", value: "security" },
    scope: { level: "project", id: "payments" },
    reason: "Temporary exception",
    approvedBy: "reviewer@example.com",
    approvedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z"
  };
  assertResolutionIssue(
    () =>
      resolveGovernance(
        [
          layer(
            "project",
            {
              requiredGates: ["security"],
              waivableRules: [{ field: "requiredGates", value: "security" }]
            },
            "payments"
          )
        ],
        { waivers: [waiver, { ...waiver }] }
      ),
    "DUPLICATE_WAIVER_ID"
  );
});

test("treats source id and version as the identity and requires one digest", () => {
  const first = layer("organization", { requiredGates: ["typecheck"] }, "corp");
  const second: ScopedGovernanceLayer = {
    ...layer("project", { requiredGates: ["security"] }, "payments"),
    source: {
      id: first.source.id,
      version: first.source.version,
      digest: "b".repeat(64)
    }
  };
  assertResolutionIssue(
    () => resolveGovernance([first, second]),
    "DUPLICATE_LAYER_SOURCE"
  );
});

test("requires count budgets to be non-negative safe integers", () => {
  for (const [field, value] of [
    ["maxCandidates", 1.5],
    ["maxDurationSeconds", Number.MAX_SAFE_INTEGER + 1],
    ["maxTokens", 10.25],
    ["maxRepairAttempts", 2.5],
    ["maxChangedFiles", 3.1],
    ["maxChangedLines", Number.MAX_SAFE_INTEGER + 1]
  ] as const) {
    assertResolutionIssue(
      () =>
        resolveGovernance([
          layer("builtin", {
            budgets: { [field]: value }
          })
        ]),
      "INVALID_BUDGET",
      `budgets.${field}`
    );
    assert.equal(
      validateStandardPack({
        schemaVersion: 1,
        id: "corp/budget",
        name: "Budget",
        version: "1.0.0",
        rules: { budgets: { [field]: value } }
      }).valid,
      false
    );
  }

  const snapshot = resolveGovernance([
    layer("builtin", { budgets: { maxCostUsd: 1.25 } })
  ]);
  assert.equal(snapshot.policy.budgets.maxCostUsd, 1.25);
});

test("rejects rule strings with leading or trailing whitespace", () => {
  assertResolutionIssue(
    () => resolveGovernance([layer("builtin", { requiredGates: [" typecheck"] })]),
    "INVALID_LAYER",
    "requiredGates[0]"
  );
});

test("canonical JSON accepts only finite, circular-free plain JSON", () => {
  assert.equal(canonicalJson({ b: 2, a: [true, null] }), '{"a":[true,null],"b":2}');
  assert.throws(() => canonicalJson({ value: undefined }), /undefined|JSON/i);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite|JSON/i);
  assert.throws(() => canonicalJson({ value: new Date(0) }), /plain|JSON/i);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular), /circular/i);
});

test("clones resolver ingress descriptor-safely without invoking accessors", () => {
  const expectStructuredFailure = (operation: () => unknown): void => {
    assert.throws(operation, (error: unknown) => {
      assert.ok(error instanceof GovernanceResolutionError);
      assert.ok(error.issues.length > 0);
      return true;
    });
  };

  let layerGetterCalls = 0;
  const accessorLayer: Record<string, unknown> = {
    scope: "builtin",
    scopeId: "builtin-1",
    source: { id: "builtin/standard", version: "1.0.0", digest: DIGEST_A }
  };
  Object.defineProperty(accessorLayer, "policy", {
    enumerable: true,
    get() {
      layerGetterCalls += 1;
      throw new Error("must not execute layer accessor");
    }
  });
  expectStructuredFailure(() =>
    resolveGovernance([accessorLayer] as unknown as ScopedGovernanceLayer[])
  );
  assert.equal(layerGetterCalls, 0);

  let optionGetterCalls = 0;
  const accessorOptions: Record<string, unknown> = {};
  Object.defineProperty(accessorOptions, "waivers", {
    enumerable: true,
    get() {
      optionGetterCalls += 1;
      throw new Error("must not execute options accessor");
    }
  });
  expectStructuredFailure(() =>
    resolveGovernance(
      [layer("builtin", {})],
      accessorOptions as unknown as Parameters<typeof resolveGovernance>[1]
    )
  );
  assert.equal(optionGetterCalls, 0);

  const sparseLayers = new Array<ScopedGovernanceLayer>(1);
  expectStructuredFailure(() => resolveGovernance(sparseLayers));

  const symbolPolicy = { requiredGates: ["typecheck"] } as Record<PropertyKey, unknown>;
  symbolPolicy[Symbol("hidden")] = true;
  expectStructuredFailure(() =>
    resolveGovernance([
      layer("builtin", symbolPolicy as unknown as PolicyRuleSet)
    ])
  );

  const hiddenPolicy = { requiredGates: ["typecheck"] } as Record<string, unknown>;
  Object.defineProperty(hiddenPolicy, "hidden", {
    value: true,
    enumerable: false
  });
  expectStructuredFailure(() =>
    resolveGovernance([
      layer("builtin", hiddenPolicy as unknown as PolicyRuleSet)
    ])
  );
});

test("rejects unknown fields throughout resolver ingress schemas", () => {
  const expectStructuredFailure = (operation: () => unknown): void => {
    assert.throws(operation, (error: unknown) => {
      assert.ok(error instanceof GovernanceResolutionError);
      assert.ok(error.issues.length > 0);
      return true;
    });
  };
  const baseLayer = layer(
    "project",
    {
      requiredGates: ["security"],
      waivableRules: [{ field: "requiredGates", value: "security" }]
    },
    "payments"
  );
  const waiver: Waiver = {
    id: "waive-security",
    target: { field: "requiredGates", value: "security" },
    scope: { level: "project", id: "payments" },
    reason: "Temporary exception",
    approvedBy: "reviewer@example.com",
    approvedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z"
  };

  const operations: Array<() => unknown> = [
    () => resolveGovernance([{ ...baseLayer, extra: true } as unknown as ScopedGovernanceLayer]),
    () => resolveGovernance([{
      ...baseLayer,
      source: { ...baseLayer.source, extra: true }
    } as unknown as ScopedGovernanceLayer]),
    () => resolveGovernance([{
      ...baseLayer,
      policy: { ...baseLayer.policy, extra: true }
    } as unknown as ScopedGovernanceLayer]),
    () => resolveGovernance([{
      ...baseLayer,
      policy: {
        ...baseLayer.policy,
        waivableRules: [{ field: "requiredGates", value: "security", extra: true }]
      }
    } as unknown as ScopedGovernanceLayer]),
    () => resolveGovernance([baseLayer], {
      now: "2026-07-11T00:00:00.000Z",
      waivers: [{ ...waiver, extra: true } as unknown as Waiver]
    }),
    () => resolveGovernance([baseLayer], {
      now: "2026-07-11T00:00:00.000Z",
      waivers: [{
        ...waiver,
        target: { ...waiver.target, extra: true }
      } as unknown as Waiver]
    }),
    () => resolveGovernance([baseLayer], {
      now: "2026-07-11T00:00:00.000Z",
      waivers: [{
        ...waiver,
        scope: { ...waiver.scope, extra: true }
      } as unknown as Waiver]
    }),
    () => resolveGovernance([baseLayer], {
      extra: true
    } as unknown as Parameters<typeof resolveGovernance>[1]),
    () => resolveGovernance([baseLayer], {
      specRef: {
        specSetId: "checkout",
        revision: 1,
        digest: "b".repeat(64),
        extra: true
      }
    } as unknown as Parameters<typeof resolveGovernance>[1]),
    () => resolveGovernance([baseLayer], {
      workflowRef: {
        id: "governed-increment-v1",
        version: "1",
        digest: "c".repeat(64),
        extra: true
      }
    } as unknown as Parameters<typeof resolveGovernance>[1])
  ];

  for (const operation of operations) expectStructuredFailure(operation);
});

test("accepts only valid Date or strict RFC3339 resolver clocks", () => {
  for (const now of [
    "2026-07-11",
    "07/11/2026",
    "2026-07-11T00:00:00",
    "2026-02-30T00:00:00.000Z"
  ]) {
    assertResolutionIssue(
      () => resolveGovernance([layer("builtin", {})], { now }),
      "INVALID_RESOLUTION_TIME",
      "now"
    );
  }
  assertResolutionIssue(
    () => resolveGovernance([layer("builtin", {})], { now: new Date(Number.NaN) }),
    "INVALID_RESOLUTION_TIME",
    "now"
  );

  const validDate = new Date("2026-07-11T08:30:00.000Z");
  const snapshot = resolveGovernance([layer("builtin", {})], { now: validDate });
  assert.equal(snapshot.resolvedAt, validDate.toISOString());
});
