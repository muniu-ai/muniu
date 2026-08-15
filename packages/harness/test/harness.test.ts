import assert from "node:assert/strict";
import test from "node:test";
import { digestSpecRevision, type SpecRevision } from "@mn/specs";
import {
  resolveGovernance,
  type GovernanceSnapshot,
  type ScopedGovernanceLayer
} from "@mn/governance";
import {
  CapabilityRegistry,
  HarnessCompilationError,
  compileHarnessManifest,
  createStaticContextSource,
  digestHarnessProfile,
  redactContextContent,
  type GateRunner,
  type HarnessCompileInput,
  type HarnessProfile,
  type SandboxBackend
} from "../src/index.js";

function approvedSpec(): SpecRevision {
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId: "checkout-flow",
    revision: 2,
    status: "approved",
    source: "native",
    title: "Checkout flow",
    hypothesis: "A governed checkout change reduces integration failures.",
    outcomes: ["Checkout completes with contract-compatible services."],
    nonGoals: ["Do not deploy automatically."],
    targetServices: ["checkout", "payment"],
    contracts: {
      interface: { openapi: "checkout/openapi.yaml" },
      data: { owner: "checkout" },
      state: { states: ["pending", "confirmed"] },
      permission: { roles: ["customer"] },
      exception: { timeout: "fail" },
      quality: { p95Ms: 500 },
      observability: { metrics: ["checkout_completed_total"] }
    },
    acceptanceCases: [
      {
        id: "accept-checkout",
        kind: "positive",
        title: "Complete checkout",
        given: ["Stock is available."],
        when: "The customer checks out.",
        then: ["The order is confirmed."],
        targetService: "checkout"
      }
    ],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "product@example.com",
    approvedAt: "2026-07-11T01:00:00.000Z",
    approvedBy: "architect@example.com"
  };
  return { ...unsigned, digest: digestSpecRevision(unsigned) };
}

function governance(spec: SpecRevision, harnessProfileDigest: string): GovernanceSnapshot {
  const layers: ScopedGovernanceLayer[] = [
    {
      scope: "builtin",
      scopeId: "default",
      source: { id: "builtin/default", version: "1", digest: "a".repeat(64) },
      policy: {
        requiredGates: ["unit_test", "contract"],
        protectedPaths: [".env"],
        allowedProviders: ["claude", "codex"],
        commandAllowlist: ["npm"],
        networkAllowlist: ["proxy.corp"],
        budgets: {
          maxTokens: 20_000,
          maxCostUsd: 10,
          maxRepairAttempts: 3
        },
        approvalMode: "on-risk"
      }
    }
  ];
  return resolveGovernance(layers, {
    now: "2026-07-11T01:00:00.000Z",
    specRef: {
      specSetId: spec.specSetId,
      revision: spec.revision,
      digest: spec.digest!
    },
    workflowRef: {
      id: "governed-increment-v1",
      version: "1",
      digest: "b".repeat(64)
    },
    harnessProfileRef: {
      id: "enterprise",
      version: "1",
      digest: harnessProfileDigest
    }
  });
}

function profile(
  overrides: Partial<Omit<HarnessProfile, "digest">> = {}
): HarnessProfile {
  const unsigned: Omit<HarnessProfile, "digest"> = {
    id: "enterprise",
    version: "1",
    sandboxBackendId: "container",
    minimumSandboxEnforcement: "enforced",
    requiredSandboxCapabilities: ["filesystem"],
    maxContextBytes: 2_048,
    maxContextTokens: 2_048,
    contextSourceTimeoutMs: 1_000,
    failOnMissingRequiredGates: true,
    redactSensitiveContext: true,
    outputSchema: "mn.agent-result.v1",
    ...overrides
  };
  return { ...unsigned, digest: digestHarnessProfile(unsigned) };
}

function rebindProfile(
  input: HarnessCompileInput,
  overrides: Partial<Omit<HarnessProfile, "digest">>
): void {
  const { digest: _digest, ...current } = input.profile;
  input.profile = profile({ ...current, ...overrides });
  input.governance = governance(input.spec, input.profile.digest!);
}

function gate(id: string): GateRunner {
  return {
    id,
    version: "1",
    languages: ["typescript"],
    async run() {
      return { id, status: "pass", summary: "ok", evidence: [] };
    }
  };
}

function sandbox(): SandboxBackend {
  return {
    id: "container",
    version: "1",
    enforcement: "enforced",
    capabilities: ["filesystem", "network-policy", "resource-limits"],
    runtimeImage: { reference: "registry.example/mn-runtime@sha256:test", digest: "9".repeat(64) },
    async prepare() {
      return { backendId: "container", workspacePath: "/workspace" };
    }
  };
}

function compileInput(): HarnessCompileInput {
  const spec = approvedSpec();
  const harnessProfile = profile();
  const registry = new CapabilityRegistry();
  registry.registerGateRunner(gate("unit_test"));
  registry.registerGateRunner(gate("contract"));
  registry.registerSandboxBackend(sandbox());
  registry.registerContextSource(
    createStaticContextSource("repo-rules", [
      {
        id: "agents",
        kind: "rules",
        source: "AGENTS.md",
        content: "Use strict boundaries.",
        priority: 100,
        required: true
      }
    ])
  );
  registry.registerContextSource(
    createStaticContextSource("history", [
      {
        id: "previous-failure",
        kind: "history",
        source: "run:previous",
        content: "Authorization: Bearer secret-token\nPrevious contract failed.",
        priority: 20
      }
    ])
  );
  return {
    spec,
    governance: governance(spec, harnessProfile.digest!),
    registry,
    context: {
      taskId: "task-1",
      projectRoot: "/repo",
      selectedServices: ["checkout", "payment"],
      languageByService: { checkout: "typescript", payment: "typescript" }
    },
    profile: harnessProfile,
    now: "2026-07-11T02:00:00.000Z"
  };
}

test("compiles an immutable manifest with deterministic semantic digest", async () => {
  const input = compileInput();
  const before = structuredClone({
    spec: input.spec,
    governance: input.governance,
    context: input.context,
    profile: input.profile
  });

  const first = await compileHarnessManifest(input);
  const second = await compileHarnessManifest({ ...compileInput(), now: "2026-07-12T00:00:00.000Z" });

  assert.equal(first.digest, second.digest);
  assert.equal(first.specRef.digest, input.spec.digest);
  assert.equal(first.governanceDigest, input.governance.digest);
  assert.deepEqual(first.gatePlan.map((item) => item.id), ["contract", "unit_test"]);
  assert.equal(first.sandbox.backendId, "container");
  assert.equal(first.context.fragments[0]?.id, "agents");
  assert.match(first.context.fragments[1]?.content ?? "", /\[REDACTED\]/);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.context.fragments));
  assert.deepEqual(
    { spec: input.spec, governance: input.governance, context: input.context, profile: input.profile },
    before
  );
});

test("orders context deterministically and records budget omissions", async () => {
  const input = compileInput();
  input.registry.registerContextSource(
    createStaticContextSource("large", [
      {
        id: "large-low-priority",
        kind: "document",
        source: "docs/large.md",
        content: "x".repeat(1_000),
        priority: 1
      }
    ])
  );

  const manifest = await compileHarnessManifest(input);

  assert.deepEqual(manifest.context.fragments.map((item) => item.id), [
    "agents",
    "previous-failure"
  ]);
  assert.deepEqual(manifest.context.omitted.map((item) => item.id), [
    "large-low-priority"
  ]);
  assert.equal(manifest.context.omitted[0]?.reason, "byte_budget");
});

test("fails closed when an enterprise required gate is unavailable", async () => {
  const input = compileInput();
  input.registry = new CapabilityRegistry();
  input.registry.registerGateRunner(gate("unit_test"));
  input.registry.registerSandboxBackend(sandbox());

  await assert.rejects(
    () => compileHarnessManifest(input),
    (error: unknown) =>
      error instanceof HarnessCompilationError &&
      error.issues.some((issue) => issue.code === "MISSING_REQUIRED_GATE")
  );
});

test("rejects a mismatched or non-approved spec snapshot", async () => {
  const mismatch = compileInput();
  mismatch.governance = governance(
    { ...mismatch.spec, specSetId: "other" },
    mismatch.profile.digest!
  );
  await assert.rejects(
    () => compileHarnessManifest(mismatch),
    (error: unknown) =>
      error instanceof HarnessCompilationError &&
      error.issues.some((issue) => issue.code === "SPEC_REF_MISMATCH")
  );

  const draft = compileInput();
  draft.spec = { ...draft.spec, status: "draft" };
  await assert.rejects(
    () => compileHarnessManifest(draft),
    (error: unknown) =>
      error instanceof HarnessCompilationError &&
      error.issues.some((issue) => issue.code === "SPEC_NOT_APPROVED")
  );
});

test("rejects insufficient sandbox enforcement and duplicate capabilities", async () => {
  const input = compileInput();
  const weak: SandboxBackend = {
    ...sandbox(),
    id: "weak",
    enforcement: "postcheck"
  };
  input.registry.registerSandboxBackend(weak);
  rebindProfile(input, { sandboxBackendId: "weak" });
  await assert.rejects(
    () => compileHarnessManifest(input),
    (error: unknown) =>
      error instanceof HarnessCompilationError &&
      error.issues.some((issue) => issue.code === "INSUFFICIENT_SANDBOX")
  );

  assert.throws(
    () => input.registry.registerGateRunner(gate("unit_test")),
    /already registered/
  );
});

test("redacts common secret forms without removing useful context", () => {
  const redacted = redactContextContent(
    "Authorization: Bearer abc.def\napi_key=sk-secret\nmessage=keep-me"
  );
  assert.doesNotMatch(redacted, /abc\.def|sk-secret/);
  assert.match(redacted, /message=keep-me/);
});
