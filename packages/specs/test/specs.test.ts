import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  createLegacySpecRevision,
  createNextSpecRevision,
  digestSpecRevision,
  sha256Digest,
  validateSpecRevision
} from "../src/index.js";
import type {
  SpecRef,
  SpecRevision,
  SpecRevisionContent,
  SpecSet
} from "../src/index.js";

function validContent(): SpecRevisionContent {
  return {
    title: "Customer health status",
    hypothesis: "Visible health signals lead to earlier customer follow-up.",
    outcomes: ["A manager can identify an at-risk customer in five seconds."],
    nonGoals: ["Exporting customer data is outside this increment."],
    targetServices: ["customer-api", "customer-web"],
    contracts: {
      interface: {
        endpoint: "/v1/customers",
        responseFields: ["healthStatus", "riskReasons"]
      },
      data: { owner: "customer-api", nullableStatus: "unknown" },
      state: { allowed: ["healthy", "watch", "risk", "unknown"] },
      permission: { read: ["customer_success_manager"] },
      exception: { forbidden: 403, unavailable: 503 },
      quality: { p95LatencyMs: 300 },
      observability: { metrics: ["customer_health_view_total"] }
    },
    acceptanceCases: [
      {
        id: "accept-positive",
        kind: "positive",
        title: "Filter at-risk customers",
        given: ["The manager owns an at-risk customer."],
        when: "The manager filters by risk.",
        then: ["The customer is visible and sorted first."]
      },
      {
        id: "accept-negative",
        kind: "negative",
        title: "Reject cross-owner access",
        given: ["The customer belongs to a different manager."],
        when: "The manager requests the customer details.",
        then: ["The service responds with 403."]
      },
      {
        id: "accept-boundary",
        kind: "boundary",
        title: "Represent missing source data",
        given: ["The source data is incomplete."],
        when: "The daily health snapshot is calculated.",
        then: ["The status is unknown rather than healthy."]
      }
    ],
    risks: [
      {
        id: "risk-stale-data",
        level: "medium",
        description: "A stale snapshot may mislead a manager.",
        mitigation: "Expose snapshot time and alert on a missed calculation."
      }
    ],
    unknowns: [
      {
        id: "unknown-retention",
        description: "The long-term snapshot retention period is undecided.",
        owner: "customer-platform",
        resolutionCriteria: "A retention policy is approved before production rollout."
      }
    ]
  };
}

function validRevision(
  overrides: Partial<SpecRevision> = {}
): SpecRevision {
  return {
    specSetId: "customer-health",
    revision: 1,
    status: "draft",
    source: "native",
    ...validContent(),
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "product-owner@example.com",
    ...overrides
  };
}

test("canonical JSON sorts object keys recursively and preserves array order", () => {
  const actual = canonicalJson({
    z: 1,
    nested: { beta: true, alpha: "first" },
    values: [{ y: 2, x: 1 }, "last"]
  });

  assert.equal(
    actual,
    '{"nested":{"alpha":"first","beta":true},"values":[{"x":1,"y":2},"last"],"z":1}'
  );
});

test("SHA-256 digest is deterministic across object key insertion order", () => {
  const first = sha256Digest({ alpha: 1, nested: { beta: 2, gamma: 3 } });
  const second = sha256Digest({ nested: { gamma: 3, beta: 2 }, alpha: 1 });

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("canonical JSON accepts JSON scalars and rejects ambiguous values", () => {
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson(42), "42");
  assert.throws(() => canonicalJson(Number.NaN), /finite numbers/u);
  assert.throws(() => canonicalJson(undefined), /does not support undefined/u);
  assert.throws(() => canonicalJson(new Date(0)), /plain objects/u);
  assert.throws(() => canonicalJson({ invalid: undefined }), /undefined at property/u);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular), /circular values/u);
});

test("a complete native revision passes runtime validation", () => {
  const result = validateSpecRevision(validRevision());

  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test("validation reports missing required content fields", () => {
  const revision = validRevision({ hypothesis: "" });
  delete (revision.contracts as Partial<typeof revision.contracts>).observability;

  const result = validateSpecRevision(revision);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path === "hypothesis"));
  assert.ok(
    result.issues.some((issue) => issue.path === "contracts.observability")
  );
});

test("validation requires strict calendar-valid timestamps and coherent approval metadata", () => {
  for (const createdAt of [
    "2026-07-11",
    "2026-02-30T00:00:00Z",
    "07/11/2026",
    "2026-07-11T00:00:00.0001Z"
  ]) {
    const revision = validRevision({ createdAt });
    assert.equal(validateSpecRevision(revision).valid, false);
  }
  const draft = validRevision({
    approvedAt: "2026-07-11T01:00:00.000Z",
    approvedBy: "reviewer@example.com"
  });
  assert.ok(
    validateSpecRevision(draft).issues.some((issue) =>
      issue.message.includes("approval metadata")
    )
  );
});

test("validation rejects duplicate acceptance case identifiers", () => {
  const content = validContent();
  content.acceptanceCases[1] = {
    ...content.acceptanceCases[1]!,
    id: content.acceptanceCases[0]!.id
  };

  const result = validateSpecRevision(validRevision(content));

  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "duplicate" && issue.path === "acceptanceCases[1].id"
    )
  );
});

test("validation requires normalized identity, service, and actor fields", () => {
  const revision = validRevision({
    targetServices: ["payments", " payments"],
    createdBy: " author@example.com",
    acceptanceCases: [
      validRevision().acceptanceCases[0]!,
      {
        ...validRevision().acceptanceCases[0]!,
        id: ` ${validRevision().acceptanceCases[0]!.id}`,
        targetService: " payments"
      }
    ]
  });
  const result = validateSpecRevision(revision);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path === "createdBy"));
  assert.ok(result.issues.some((issue) => issue.path === "targetServices[1]"));
  assert.ok(result.issues.some((issue) => issue.code === "duplicate"));
  assert.ok(
    result.issues.some(
      (issue) => issue.path === "acceptanceCases[1].targetService"
    )
  );
});

test("validation enforces acceptance, risk, and unknown boundary values", () => {
  const content = validContent();
  content.acceptanceCases[0] = {
    ...content.acceptanceCases[0]!,
    kind: "unexpected" as "positive"
  };
  content.risks[0] = {
    ...content.risks[0]!,
    level: "severe" as "high"
  };
  content.unknowns[0] = {
    ...content.unknowns[0]!,
    resolutionCriteria: ""
  };

  const result = validateSpecRevision(validRevision(content));

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path === "acceptanceCases[0].kind"));
  assert.ok(result.issues.some((issue) => issue.path === "risks[0].level"));
  assert.ok(
    result.issues.some((issue) => issue.path === "unknowns[0].resolutionCriteria")
  );
});

test("validation handles malformed revision shapes without throwing", () => {
  assert.deepEqual(validateSpecRevision(null), {
    valid: false,
    issues: [
      {
        path: "$",
        code: "invalid_type",
        message: "Spec revision must be a record"
      }
    ]
  });

  const malformed = {
    ...validRevision(),
    specSetId: 12,
    revision: 0,
    status: "published",
    source: "external",
    createdAt: "not-a-date",
    createdBy: "",
    outcomes: "not-an-array",
    nonGoals: [],
    targetServices: [""],
    contracts: null,
    acceptanceCases: "not-an-array",
    risks: "not-an-array",
    unknowns: "not-an-array",
    approvedAt: "not-a-date",
    digest: "not-a-digest"
  };

  const result = validateSpecRevision(malformed);
  const paths = new Set(result.issues.map((issue) => issue.path));
  assert.equal(result.valid, false);
  for (const path of [
    "specSetId",
    "revision",
    "status",
    "source",
    "createdAt",
    "createdBy",
    "outcomes",
    "nonGoals",
    "targetServices[0]",
    "contracts",
    "acceptanceCases",
    "risks",
    "unknowns",
    "approvedAt",
    "digest"
  ]) {
    assert.ok(paths.has(path), `expected issue at ${path}`);
  }
});

test("validation reports malformed acceptance, risk, and unknown entries", () => {
  const malformed = validRevision({
    acceptanceCases: [
      null as unknown as SpecRevision["acceptanceCases"][number],
      {
        id: "",
        kind: "invalid" as "boundary",
        title: "",
        given: "invalid" as unknown as string[],
        when: "",
        then: [],
        targetService: ""
      }
    ],
    risks: [
      null as unknown as SpecRevision["risks"][number],
      {
        id: "",
        level: "invalid" as "critical",
        description: "",
        mitigation: ""
      }
    ],
    unknowns: [
      null as unknown as SpecRevision["unknowns"][number],
      { id: "", description: "", owner: "", resolutionCriteria: "" }
    ]
  });

  const result = validateSpecRevision(malformed);
  const paths = new Set(result.issues.map((issue) => issue.path));
  assert.equal(result.valid, false);
  for (const path of [
    "acceptanceCases[0]",
    "acceptanceCases[1].id",
    "acceptanceCases[1].kind",
    "acceptanceCases[1].given",
    "acceptanceCases[1].then",
    "acceptanceCases[1].targetService",
    "risks[0]",
    "risks[1].level",
    "unknowns[0]",
    "unknowns[1].resolutionCriteria"
  ]) {
    assert.ok(paths.has(path), `expected issue at ${path}`);
  }
});

test("validation rejects non-canonical contract values before digesting", () => {
  const unsupportedValues: unknown[] = [
    new Date(0),
    undefined,
    () => "not-json",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1n,
    Symbol("not-json")
  ];
  const revisions = unsupportedValues.map((unsupported) => {
    const revision = validRevision();
    revision.contracts.interface.unsupported = unsupported;
    return revision;
  });
  const withCycle = validRevision();
  withCycle.contracts.state.self = withCycle.contracts.state;
  revisions.push(withCycle);

  for (const revision of revisions) {
    const result = validateSpecRevision(revision);
    assert.equal(result.valid, false);
    assert.ok(
      result.issues.some(
        (issue) => issue.code === "invalid_value" && issue.path === "$"
      )
    );
    assert.throws(
      () =>
        createNextSpecRevision(revision, {
          createdAt: "2026-07-12T00:00:00.000Z"
        }),
      /invalid predecessor/u
    );
  }
});

test("validation rejects sparse arrays, symbol keys, and accessor properties", () => {
  const sparse = validRevision();
  sparse.outcomes = new Array<string>(1);

  const symbolKey = validRevision();
  symbolKey.contracts.interface[Symbol("hidden") as unknown as string] = "value";

  const accessor = validRevision();
  Object.defineProperty(accessor.contracts.data, "owner", {
    enumerable: true,
    get: () => "customer-api"
  });

  for (const revision of [sparse, symbolKey, accessor]) {
    const result = validateSpecRevision(revision);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.path === "$"));
  }
});

test("validation does not execute a top-level accessor", () => {
  let calls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "specSetId", {
    enumerable: true,
    get() {
      calls += 1;
      throw new Error("must not execute");
    }
  });
  let result: ReturnType<typeof validateSpecRevision> | undefined;
  assert.doesNotThrow(() => {
    result = validateSpecRevision(accessor);
  });
  assert.equal(calls, 0);
  assert.equal(result?.valid, false);
  assert.ok(result?.issues.some((issue) => issue.path === "$"));
});

test("validation rejects unknown fixed-schema fields even with a matching digest", () => {
  const base = validRevision();
  const { digest: _digest, ...unsigned } = base;
  const extended = {
    ...unsigned,
    complianceRequirement: "This must not be silently ignored.",
    acceptanceCases: [
      {
        ...unsigned.acceptanceCases[0]!,
        hiddenRequirement: "also unsupported"
      },
      ...unsigned.acceptanceCases.slice(1)
    ]
  };
  const candidate = {
    ...extended,
    digest: digestSpecRevision(extended as unknown as SpecRevision)
  };
  const result = validateSpecRevision(candidate);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.path === "complianceRequirement")
  );
  assert.ok(
    result.issues.some(
      (issue) => issue.path === "acceptanceCases[0].hiddenRequirement"
    )
  );
});

test("validation rejects unsafe Spec identities and prototype-pollution keys", () => {
  const unsafe = validRevision({ specSetId: "../../outside", digest: undefined });
  unsafe.digest = digestSpecRevision(unsafe);
  assert.equal(validateSpecRevision(unsafe).valid, false);
  assert.ok(
    validateSpecRevision(unsafe).issues.some((issue) => issue.path === "specSetId")
  );

  const polluted = validRevision();
  polluted.contracts.interface = JSON.parse(
    '{"__proto__":{"polluted":true},"endpoint":"/v1/test"}'
  ) as Record<string, unknown>;
  const result = validateSpecRevision(polluted);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path === "$"));
  assert.throws(() => digestSpecRevision(polluted), /dangerous property/u);
});

test("validation rejects duplicate risk and unknown identifiers", () => {
  const content = validContent();
  content.risks.push({ ...content.risks[0]! });
  content.unknowns.push({ ...content.unknowns[0]! });

  const result = validateSpecRevision(validRevision(content));

  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "duplicate" && issue.path === "risks[1].id"
    )
  );
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "duplicate" && issue.path === "unknowns[1].id"
    )
  );
});

test("an approved revision requires a matching content digest", () => {
  const unsigned = validRevision({
    status: "approved",
    approvedAt: "2026-07-11T01:00:00.000Z",
    approvedBy: "reviewer@example.com"
  });

  const missing = validateSpecRevision(unsigned);
  assert.equal(missing.valid, false);
  assert.ok(missing.issues.some((issue) => issue.code === "required" && issue.path === "digest"));

  const approved = { ...unsigned, digest: digestSpecRevision(unsigned) };
  assert.equal(validateSpecRevision(approved).valid, true);

  const tampered = { ...approved, hypothesis: "A changed hypothesis." };
  const mismatch = validateSpecRevision(tampered);
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.issues.some((issue) => issue.code === "digest_mismatch"));
});

test("legacy prompt and acceptance criteria become a valid approved revision", () => {
  const revision = createLegacySpecRevision({
    taskId: "task-42",
    title: "Legacy health task",
    prompt: "Add customer health status without adding export.",
    acceptanceCriteria: ["Risk filtering works", "Cross-owner access is rejected"],
    targetServices: ["customer-api"],
    createdAt: "2026-07-11T00:00:00.000Z"
  });

  assert.equal(revision.specSetId, "legacy-task-42");
  assert.equal(revision.source, "legacy");
  assert.equal(revision.status, "approved");
  assert.deepEqual(
    revision.acceptanceCases.map((acceptance) => acceptance.kind),
    ["positive", "positive"]
  );
  assert.deepEqual(revision.outcomes, [
    "Risk filtering works",
    "Cross-owner access is rejected"
  ]);
  assert.equal(validateSpecRevision(revision).valid, true);
  assert.ok(Object.isFrozen(revision));
});

test("legacy adapter produces a repository-safe identity for unsafe task ids", () => {
  const revision = createLegacySpecRevision({
    taskId: "../../outside/path",
    prompt: "Keep the legacy behavior.",
    acceptanceCriteria: ["The task can be persisted."],
    createdAt: "2026-07-11T00:00:00.000Z"
  });
  assert.match(revision.specSetId, /^legacy-[a-f0-9]{24}$/u);
  assert.doesNotMatch(revision.specSetId, /[/:]/u);
});

test("legacy adapter has deterministic identity defaults and rejects empty inputs", () => {
  const input = {
    prompt: "\n  Implement the bounded change.\nDo not expand scope.",
    acceptanceCriteria: ["  The requested behavior passes.  "],
    createdAt: "2026-07-11T00:00:00.000Z"
  };
  const first = createLegacySpecRevision(input);
  const second = createLegacySpecRevision(input);

  assert.equal(first.specSetId, second.specSetId);
  assert.equal(first.title, "Implement the bounded change.");
  assert.deepEqual(first.targetServices, []);
  assert.equal(first.createdBy, "legacy-adapter");
  assert.throws(
    () =>
      createLegacySpecRevision({
        prompt: " ",
        acceptanceCriteria: ["done"]
      }),
    /prompt must be a non-empty string/u
  );
  assert.throws(
    () =>
      createLegacySpecRevision({
        prompt: "Do the work",
        acceptanceCriteria: [" "]
      }),
    /acceptance criteria must contain at least one item/u
  );
});

test("next revision increments monotonically without mutating its predecessor", () => {
  const approvedWithoutDigest = validRevision({
    status: "approved",
    approvedAt: "2026-07-11T01:00:00.000Z",
    approvedBy: "reviewer@example.com"
  });
  const current: SpecRevision = {
    ...approvedWithoutDigest,
    digest: digestSpecRevision(approvedWithoutDigest)
  };
  const before = structuredClone(current);

  const next = createNextSpecRevision(current, {
    outcomes: [...current.outcomes, "Risk reasons are visible."],
    createdAt: "2026-07-12T00:00:00.000Z",
    createdBy: "product-owner@example.com"
  });

  assert.deepEqual(current, before);
  assert.equal(next.specSetId, current.specSetId);
  assert.equal(next.revision, 2);
  assert.equal(next.status, "draft");
  assert.equal(next.approvedAt, undefined);
  assert.equal(next.approvedBy, undefined);
  assert.equal(next.digest, digestSpecRevision(next));
  assert.ok(Object.isFrozen(next));
  assert.ok(Object.isFrozen(next.contracts.interface));
  assert.throws(() => {
    (next.outcomes as string[]).push("Mutation is forbidden.");
  }, TypeError);
  assert.equal(validateSpecRevision(next).valid, true);
});

test("next revision refuses invalid, overflowing, or invalidly changed predecessors", () => {
  assert.throws(
    () => createNextSpecRevision(validRevision({ hypothesis: "" })),
    /invalid predecessor/u
  );
  assert.throws(
    () =>
      createNextSpecRevision(
        validRevision({ revision: Number.MAX_SAFE_INTEGER }),
        { createdAt: "2026-07-12T00:00:00.000Z" }
      ),
    /cannot exceed/u
  );
  assert.throws(
    () =>
      createNextSpecRevision(validRevision(), {
        outcomes: [],
        createdAt: "2026-07-12T00:00:00.000Z"
      }),
    /produced an invalid revision/u
  );
});

test("aggregate and reference types preserve revision identity", () => {
  const reference: SpecRef = {
    specSetId: "customer-health",
    revision: 2,
    digest: "a".repeat(64)
  };
  const specSet: SpecSet = {
    id: reference.specSetId,
    title: "Customer health",
    latestRevision: reference.revision,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z"
  };

  assert.equal(specSet.id, reference.specSetId);
  assert.equal(specSet.latestRevision, reference.revision);
});
