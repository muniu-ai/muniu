import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestSpecRevision, type SpecRevision } from "@mn/specs";
import {
  resolveGovernance,
  sha256Canonical,
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
  safeRedactedErrorMessage,
  type ContextCollectionRequest,
  type ContextFragmentInput,
  type ContextSource,
  type CapabilityRegistryLike,
  type GateRunner,
  type HarnessCompileInput,
  type HarnessProfile,
  type SandboxBackend
} from "../src/index.js";

function approvedSpec(): SpecRevision {
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId: "checkout-flow",
    revision: 1,
    status: "approved",
    source: "native",
    title: "Checkout flow",
    hypothesis: "A governed checkout change reduces integration failures.",
    outcomes: ["Checkout remains contract compatible."],
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
    acceptanceCases: [{
      id: "accept-checkout",
      kind: "positive",
      title: "Complete checkout",
      given: ["Stock is available."],
      when: "The customer checks out.",
      then: ["The order is confirmed."],
      targetService: "checkout"
    }],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "product@example.com",
    approvedAt: "2026-07-11T01:00:00.000Z",
    approvedBy: "architect@example.com"
  };
  return { ...unsigned, digest: digestSpecRevision(unsigned) };
}

function profile(
  overrides: Partial<Omit<HarnessProfile, "digest">> = {}
): HarnessProfile {
  const unsigned: Omit<HarnessProfile, "digest"> = {
    id: "enterprise",
    version: "1",
    sandboxBackendId: "container",
    minimumSandboxEnforcement: "enforced",
    requiredSandboxCapabilities: ["filesystem", "network-policy"],
    maxContextBytes: 2_048,
    maxContextTokens: 2_048,
    contextSourceTimeoutMs: 100,
    failOnMissingRequiredGates: true,
    redactSensitiveContext: true,
    outputSchema: "mn.agent-result.v1",
    ...overrides
  };
  return { ...unsigned, digest: digestHarnessProfile(unsigned) };
}

function governance(
  spec: SpecRevision,
  harnessProfile: HarnessProfile,
  budgetOverrides: Readonly<Record<string, number>> = {}
): GovernanceSnapshot {
  const layers: ScopedGovernanceLayer[] = [{
    scope: "builtin",
    scopeId: "default",
    source: { id: "builtin/default", version: "1", digest: "a".repeat(64) },
    policy: {
      requiredGates: ["unit_test"],
      budgets: { maxCandidates: 4, maxRepairAttempts: 3, ...budgetOverrides },
      approvalMode: "on-risk"
    }
  }];
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
      id: harnessProfile.id,
      version: harnessProfile.version,
      digest: harnessProfile.digest!
    }
  });
}

function resignGovernance(
  snapshot: GovernanceSnapshot,
  changes: Partial<GovernanceSnapshot>
): GovernanceSnapshot {
  const candidate = { ...snapshot, ...changes };
  const semantic = {
    schemaVersion: candidate.schemaVersion,
    layers: candidate.layers,
    policy: candidate.policy,
    appliedWaivers: candidate.appliedWaivers,
    decisions: candidate.decisions,
    ...(candidate.specRef === undefined ? {} : { specRef: candidate.specRef }),
    ...(candidate.workflowRef === undefined ? {} : { workflowRef: candidate.workflowRef }),
    ...(candidate.harnessProfileRef === undefined
      ? {}
      : { harnessProfileRef: candidate.harnessProfileRef })
  };
  return { ...candidate, digest: sha256Canonical(semantic) };
}

function gate(): GateRunner {
  return {
    id: "unit_test",
    version: "1",
    languages: ["typescript"],
    async run() {
      return { id: "unit_test", status: "pass", summary: "ok", evidence: [] };
    }
  };
}

function sandbox(overrides: Partial<SandboxBackend> = {}): SandboxBackend {
  return {
    id: "container",
    version: "1",
    enforcement: "enforced",
    capabilities: ["filesystem", "network-policy", "resource-limits"],
    runtimeImage: { reference: "registry.example/mn-runtime@sha256:test", digest: "9".repeat(64) },
    async prepare() {
      return { backendId: "container", workspacePath: "/workspace" };
    },
    ...overrides
  };
}

function input(): HarnessCompileInput {
  const spec = approvedSpec();
  const harnessProfile = profile();
  const registry = new CapabilityRegistry();
  registry.registerGateRunner(gate());
  registry.registerSandboxBackend(sandbox());
  registry.registerContextSource(createStaticContextSource("rules", [{
    id: "agents",
    kind: "rules",
    source: "AGENTS.md",
    content: "Follow repository rules.",
    priority: 100,
    required: true
  }]));
  return {
    spec,
    governance: governance(spec, harnessProfile),
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

function rebindProfile(
  compileInput: HarnessCompileInput,
  overrides: Partial<Omit<HarnessProfile, "digest">>
): void {
  const { digest: _digest, ...current } = compileInput.profile;
  compileInput.profile = profile({ ...current, ...overrides });
  compileInput.governance = governance(compileInput.spec, compileInput.profile);
}

async function rejectsWithCode(
  compileInput: HarnessCompileInput,
  code: string
): Promise<HarnessCompilationError> {
  let caught: unknown;
  try {
    await compileHarnessManifest(compileInput);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HarnessCompilationError);
  assert.ok(caught.issues.some((entry) => entry.code === code), JSON.stringify(caught.issues));
  return caught;
}

test("binds the exact profile id, version and semantic digest", async () => {
  const compileInput = input();
  const manifest = await compileHarnessManifest(compileInput);
  assert.equal(manifest.profile.digest, compileInput.profile.digest);

  const wrongRef = input();
  wrongRef.governance = {
    ...wrongRef.governance,
    harnessProfileRef: {
      id: wrongRef.profile.id,
      version: wrongRef.profile.version,
      digest: "f".repeat(64)
    }
  };
  await rejectsWithCode(wrongRef, "GOVERNANCE_DIGEST_MISMATCH");

  const selfTampered = input();
  selfTampered.profile = { ...selfTampered.profile, maxContextBytes: 99_999 };
  await rejectsWithCode(selfTampered, "PROFILE_REF_MISMATCH");

  const validButWrongBinding = input();
  const otherProfile = profile({ id: "other-enterprise" });
  validButWrongBinding.governance = governance(validButWrongBinding.spec, otherProfile);
  await rejectsWithCode(validButWrongBinding, "PROFILE_REF_MISMATCH");
});

test("does not confuse harmless JSON-like control strings with credentials", async () => {
  const compileInput = input();
  rebindProfile(compileInput, { version: "1.0" });
  const manifest = await compileHarnessManifest(compileInput);
  assert.equal(manifest.profile.version, "1.0");
});

test("recomputes and rejects a tampered governance semantic digest", async () => {
  const compileInput = input();
  compileInput.governance = {
    ...compileInput.governance,
    policy: { ...compileInput.governance.policy, requiredGates: [] }
  };
  await rejectsWithCode(compileInput, "GOVERNANCE_DIGEST_MISMATCH");
});

test("rejects self-consistent governance snapshots with illegal budget semantics", async () => {
  const invalidBudgets: readonly Readonly<Record<string, number>>[] = [
    { maxRepairAttempts: -1 },
    { maxCandidates: 1.5 },
    { maxTokens: Number.MAX_SAFE_INTEGER + 1 },
    { maxExplosions: 1 }
  ];
  for (const budgets of invalidBudgets) {
    const compileInput = input();
    const policy = {
      ...compileInput.governance.policy,
      budgets
    } as GovernanceSnapshot["policy"];
    compileInput.governance = resignGovernance(compileInput.governance, { policy });
    await rejectsWithCode(compileInput, "INVALID_GOVERNANCE");
  }
});

test("validates sandbox enforcement enums and required capabilities", async () => {
  const invalidProfile = input();
  rebindProfile(invalidProfile, {
    minimumSandboxEnforcement: "root" as HarnessProfile["minimumSandboxEnforcement"]
  });
  await rejectsWithCode(invalidProfile, "INVALID_PROFILE");

  const invalidBackend = input();
  invalidBackend.registry.registerSandboxBackend(sandbox({
    id: "invalid",
    enforcement: "root" as SandboxBackend["enforcement"]
  }));
  rebindProfile(invalidBackend, { sandboxBackendId: "invalid" });
  await rejectsWithCode(invalidBackend, "INVALID_SANDBOX");

  const missingCapability = input();
  rebindProfile(missingCapability, {
    requiredSandboxCapabilities: ["filesystem", "seccomp"]
  });
  await rejectsWithCode(missingCapability, "MISSING_SANDBOX_CAPABILITY");
});

test("cannot disable fail-closed required gates for enterprise or enforced sandboxes", async () => {
  for (const overrides of [
    { id: "enterprise", minimumSandboxEnforcement: "enforced" as const },
    { id: "local", minimumSandboxEnforcement: "postcheck" as const }
  ]) {
    const compileInput = input();
    rebindProfile(compileInput, {
      ...overrides,
      failOnMissingRequiredGates: false
    });
    const registry = new CapabilityRegistry();
    registry.registerSandboxBackend(sandbox());
    registry.registerContextSource(createStaticContextSource("rules", []));
    compileInput.registry = registry;
    await rejectsWithCode(compileInput, "MISSING_REQUIRED_GATE");
  }
});

test("requires a complete one-to-one service language mapping", async () => {
  const missing = input();
  missing.context = {
    ...missing.context,
    languageByService: { checkout: "typescript" }
  };
  await rejectsWithCode(missing, "INVALID_CONTEXT");

  const extra = input();
  extra.context = {
    ...extra.context,
    languageByService: {
      checkout: "typescript",
      payment: "typescript",
      inventory: "typescript"
    }
  };
  await rejectsWithCode(extra, "INVALID_CONTEXT");

  const missingSpecTarget = input();
  missingSpecTarget.context = {
    ...missingSpecTarget.context,
    selectedServices: ["checkout"],
    languageByService: { checkout: "typescript" }
  };
  await rejectsWithCode(missingSpecTarget, "INVALID_CONTEXT");

  const sparse = input();
  const sparseServices = new Array<string>(3);
  sparseServices[0] = "checkout";
  sparseServices[2] = "payment";
  sparse.context = { ...sparse.context, selectedServices: sparseServices };
  await rejectsWithCode(sparse, "INVALID_CONTEXT");
});

test("binds task and project root into the semantic manifest digest", async () => {
  const first = await compileHarnessManifest(input());
  const otherTask = input();
  otherTask.context = { ...otherTask.context, taskId: "task-2" };
  const second = await compileHarnessManifest(otherTask);
  const otherRoot = input();
  otherRoot.context = { ...otherRoot.context, projectRoot: "/other-repo" };
  const third = await compileHarnessManifest(otherRoot);

  assert.deepEqual(first.task, { taskId: "task-1", projectRoot: "/repo" });
  assert.notEqual(first.digest, second.digest);
  assert.notEqual(first.digest, third.digest);
});

test("takes one immutable entry snapshot before collectors can rebind inputs or capabilities", async () => {
  const compileInput = input();
  const originalSpecRef = {
    specSetId: compileInput.spec.specSetId,
    revision: compileInput.spec.revision,
    digest: compileInput.spec.digest
  };
  const originalProfile = {
    id: compileInput.profile.id,
    version: compileInput.profile.version,
    digest: compileInput.profile.digest
  };
  let originalSecondCalled = false;
  let reboundSecondCalled = false;
  const second = {
    id: "z-second",
    collect(): readonly ContextFragmentInput[] {
      originalSecondCalled = true;
      return [];
    }
  };
  const mutator: ContextSource = {
    id: "a-mutator",
    async collect() {
      const attackerSpec = { ...approvedSpec(), specSetId: "attacker-spec" };
      const attackerProfile = profile({
        id: "attacker-profile",
        maxContextBytes: 1,
        maxContextTokens: 1
      });
      compileInput.spec = attackerSpec;
      compileInput.profile = attackerProfile;
      compileInput.governance = governance(attackerSpec, attackerProfile);
      compileInput.context = {
        taskId: "attacker-task",
        projectRoot: "/attacker",
        selectedServices: ["checkout", "payment"],
        languageByService: { checkout: "typescript", payment: "typescript" }
      };
      second.collect = () => {
        reboundSecondCalled = true;
        return [{
          id: "attacker-fragment",
          kind: "attack",
          source: "attack",
          content: "password=collector-rebind-secret",
          priority: 1
        }];
      };
      await Promise.resolve();
      return [];
    }
  };
  const fakeRegistry: CapabilityRegistryLike = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    getGateRunner(id) {
      return id === "unit_test" ? gate() : undefined;
    },
    getSandboxBackend(id) {
      return id === "container" ? sandbox() : undefined;
    },
    listContextSources() {
      return [mutator, second];
    }
  };
  compileInput.registry = fakeRegistry;

  const manifest = await compileHarnessManifest(compileInput);
  assert.deepEqual(manifest.specRef, originalSpecRef);
  assert.deepEqual(manifest.profile, originalProfile);
  assert.deepEqual(manifest.task, { taskId: "task-1", projectRoot: "/repo" });
  assert.equal(originalSecondCalled, true);
  assert.equal(reboundSecondCalled, false);
  assert.doesNotMatch(JSON.stringify(manifest), /attacker|collector-rebind-secret/);
});

test("rejects accessor-backed entry and capability snapshots", async () => {
  const base = input();
  const accessorInput = { ...base };
  Object.defineProperty(accessorInput, "profile", {
    enumerable: true,
    get() {
      return base.profile;
    }
  });
  await rejectsWithCode(accessorInput, "INVALID_CONTEXT");

  const accessorRegistry = input();
  const fake = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    get getGateRunner() {
      return () => gate();
    },
    getSandboxBackend() {
      return sandbox();
    },
    listContextSources() {
      return [];
    }
  } as unknown as CapabilityRegistryLike;
  accessorRegistry.registry = fake;
  await rejectsWithCode(accessorRegistry, "INVALID_CAPABILITY_REGISTRY");

  const accessorRunner = input();
  const runnerWithAccessor = {
    id: "unit_test",
    version: "1",
    languages: ["typescript"],
    get run() {
      return gate().run;
    }
  } as GateRunner;
  accessorRunner.registry = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    getGateRunner() {
      return runnerWithAccessor;
    },
    getSandboxBackend() {
      return sandbox();
    },
    listContextSources() {
      return [];
    }
  };
  await rejectsWithCode(accessorRunner, "INVALID_CAPABILITY_REGISTRY");
});

test("rejects array accessors and non-enumerable indices without executing them", async () => {
  let serviceGetterCalls = 0;
  const serviceAccessor = input();
  const services = new Array<string>(2);
  Object.defineProperty(services, "0", {
    enumerable: true,
    get() {
      serviceGetterCalls += 1;
      return "checkout";
    }
  });
  services[1] = "payment";
  serviceAccessor.context = { ...serviceAccessor.context, selectedServices: services };
  await rejectsWithCode(serviceAccessor, "INVALID_CONTEXT");
  assert.equal(serviceGetterCalls, 0);

  const hiddenService = input();
  const hiddenServices = ["checkout", "payment"];
  Object.defineProperty(hiddenServices, "0", {
    enumerable: false,
    value: "checkout"
  });
  hiddenService.context = { ...hiddenService.context, selectedServices: hiddenServices };
  await rejectsWithCode(hiddenService, "INVALID_CONTEXT");

  let languageGetterCalls = 0;
  const runnerLanguages = new Array<string>(1);
  Object.defineProperty(runnerLanguages, "0", {
    enumerable: true,
    get() {
      languageGetterCalls += 1;
      return "typescript";
    }
  });
  const badLanguages = input();
  badLanguages.registry = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    getGateRunner() {
      return { ...gate(), languages: runnerLanguages };
    },
    getSandboxBackend() {
      return sandbox();
    },
    listContextSources() {
      return [];
    }
  };
  await rejectsWithCode(badLanguages, "INVALID_CAPABILITY_REGISTRY");
  assert.equal(languageGetterCalls, 0);

  let fragmentGetterCalls = 0;
  const fragmentAccessor = input();
  fragmentAccessor.registry.registerContextSource({
    id: "accessor-container",
    collect() {
      const fragments = new Array<ContextFragmentInput>(1);
      Object.defineProperty(fragments, "0", {
        enumerable: true,
        get() {
          fragmentGetterCalls += 1;
          return {
            id: "must-not-run",
            kind: "attack",
            source: "attack",
            content: "password=container-secret",
            priority: 1
          };
        }
      });
      return fragments;
    }
  });
  await rejectsWithCode(fragmentAccessor, "INVALID_CONTEXT");
  assert.equal(fragmentGetterCalls, 0);

  const hiddenFragment = input();
  hiddenFragment.registry.registerContextSource({
    id: "hidden-container",
    collect() {
      const fragments = [{
        id: "hidden",
        kind: "attack",
        source: "attack",
        content: "safe",
        priority: 1
      }];
      Object.defineProperty(fragments, "0", {
        enumerable: false,
        value: fragments[0]
      });
      return fragments;
    }
  });
  await rejectsWithCode(hiddenFragment, "INVALID_CONTEXT");

  let registrationGetterCalls = 0;
  const registrationLanguages = new Array<string>(1);
  Object.defineProperty(registrationLanguages, "0", {
    enumerable: true,
    get() {
      registrationGetterCalls += 1;
      return "typescript";
    }
  });
  const registrationRegistry = new CapabilityRegistry();
  assert.throws(() =>
    registrationRegistry.registerGateRunner({
      ...gate(),
      languages: registrationLanguages
    })
  );
  assert.equal(registrationGetterCalls, 0);

  const hiddenCapabilities = ["filesystem"];
  Object.defineProperty(hiddenCapabilities, "0", {
    enumerable: false,
    value: "filesystem"
  });
  assert.throws(() =>
    registrationRegistry.registerSandboxBackend({
      ...sandbox(),
      capabilities: hiddenCapabilities
    })
  );
});

test("includes maxCandidates in bounded stop conditions", async () => {
  const manifest = await compileHarnessManifest(input());
  assert.equal(manifest.stopConditions.maxCandidates, 4);
});

test("accepts only strict RFC3339 generation timestamps", async () => {
  for (const invalid of [
    "2026-07-11",
    "2026-07-11 02:00:00Z",
    "2026-02-30T02:00:00Z",
    "2026-07-11T24:00:00Z",
    "2026-07-11T02:00:00+14:30"
  ]) {
    const compileInput = input();
    compileInput.now = invalid;
    await rejectsWithCode(compileInput, "INVALID_GENERATED_AT");
  }

  const offset = input();
  offset.now = "2026-07-11T10:00:00+08:00";
  const manifest = await compileHarnessManifest(offset);
  assert.equal(manifest.generatedAt, "2026-07-11T02:00:00.000Z");
});

test("enforces required context source and fragment ids", async () => {
  const missingSource = input();
  rebindProfile(missingSource, { requiredContextSourceIds: ["rules", "codeowners"] });
  await rejectsWithCode(missingSource, "MISSING_REQUIRED_CONTEXT_SOURCE");

  const missingFragment = input();
  rebindProfile(missingFragment, { requiredContextFragmentIds: ["agents", "codeowners"] });
  await rejectsWithCode(missingFragment, "MISSING_REQUIRED_CONTEXT_FRAGMENT");
});

test("derives required fragments only from the signed profile", async () => {
  const compileInput = input();
  rebindProfile(compileInput, { maxContextBytes: 128, maxContextTokens: 128 });
  compileInput.registry.registerContextSource(createStaticContextSource("self-report", [{
    id: "collector-required",
    kind: "document",
    source: "untrusted-source",
    content: "x".repeat(1_000),
    priority: 1,
    required: true
  }]));
  const manifest = await compileHarnessManifest(compileInput);
  assert.equal(
    manifest.context.omitted.find((entry) => entry.id === "collector-required")?.id,
    "collector-required"
  );
});

test("passes a cloned frozen request to context collectors", async () => {
  const compileInput = input();
  let received: ContextCollectionRequest | undefined;
  compileInput.registry.registerContextSource({
    id: "request-inspector",
    collect(request) {
      received = request;
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.selectedServices));
      assert.ok(Object.isFrozen(request.languageByService));
      assert.notEqual(request.selectedServices, compileInput.context.selectedServices);
      assert.notEqual(request.languageByService, compileInput.context.languageByService);
      return [];
    }
  });
  await compileHarnessManifest(compileInput);
  assert.equal(received?.taskId, "task-1");
});

test("deep snapshots static context inputs and collection results", async () => {
  const nested = { owner: { team: "checkout" } };
  const fragment: ContextFragmentInput = {
    id: "ownership",
    kind: "metadata",
    source: ".mn/project.yaml",
    content: "owner=checkout",
    priority: 1,
    metadata: nested
  };
  const source = createStaticContextSource("static", [fragment]);
  nested.owner.team = "tampered";
  const first = await source.collect({
    taskId: "task",
    projectRoot: "/repo",
    selectedServices: [],
    languageByService: {}
  });
  assert.deepEqual(first[0]?.metadata, { owner: { team: "checkout" } });
  (first[0]!.metadata as { owner: { team: string } }).owner.team = "returned-tamper";
  const second = await source.collect({
    taskId: "task",
    projectRoot: "/repo",
    selectedServices: [],
    languageByService: {}
  });
  assert.deepEqual(second[0]?.metadata, { owner: { team: "checkout" } });
});

test("times out and cancels context collection with bounded errors", async () => {
  const timeout = input();
  rebindProfile(timeout, { contextSourceTimeoutMs: 10 });
  timeout.registry.registerContextSource({
    id: "never",
    collect() {
      return new Promise<readonly ContextFragmentInput[]>(() => undefined);
    }
  });
  await rejectsWithCode(timeout, "CONTEXT_SOURCE_TIMEOUT");

  const controller = new AbortController();
  const cancelled = input();
  cancelled.signal = controller.signal;
  cancelled.registry.registerContextSource({
    id: "cancelled",
    collect(request) {
      return new Promise<readonly ContextFragmentInput[]>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    }
  });
  const pending = compileHarnessManifest(cancelled);
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof HarnessCompilationError &&
      error.issues.some((entry) => entry.code === "COMPILATION_CANCELLED")
  );

  const preCancelledController = new AbortController();
  preCancelledController.abort();
  const preCancelled = input();
  preCancelled.signal = preCancelledController.signal;
  preCancelled.registry = new CapabilityRegistry();
  preCancelled.registry.registerGateRunner(gate());
  preCancelled.registry.registerSandboxBackend(sandbox());
  await rejectsWithCode(preCancelled, "COMPILATION_CANCELLED");
});

test("redacts secrets from content, nested metadata and source failures", async () => {
  const compileInput = input();
  compileInput.registry.registerContextSource({
    id: "secrets",
    collect() {
      return [{
        id: "secret-context",
        kind: "history",
        source: "run:prior",
        content: "OPENAI_API_KEY=sk-proj-abcdefghijk Authorization: Basic Zm9vOmJhcg== useful=keep",
        priority: 10,
        metadata: {
          password: "correct horse battery staple",
          nested: {
            client_secret: "client-value",
            note: "token=metadata-value with an unquoted multi word secret"
          },
          useful: "keep-this"
        }
      }];
    }
  });
  const manifest = await compileHarnessManifest(compileInput);
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /abcdefghijk|Zm9vOmJhcg|correct horse|client-value|metadata-value/);
  assert.match(serialized, /keep-this/);

  const failing = input();
  failing.registry.registerContextSource({
    id: "failure",
    collect() {
      throw new Error("source failed api_key=sk-secret-abcdefgh");
    }
  });
  const error = await rejectsWithCode(failing, "CONTEXT_SOURCE_FAILED");
  assert.doesNotMatch(`${error.message} ${JSON.stringify(error.issues)}`, /sk-secret-abcdefgh/);
});

test("treats secret redaction as a non-waivable manifest boundary", async () => {
  const compileInput = input();
  rebindProfile(compileInput, { redactSensitiveContext: false });
  compileInput.registry.registerContextSource(createStaticContextSource("non-waivable", [{
    id: "json-secret",
    kind: "configuration",
    source: "config.json",
    content: '{"password":"two words secret","api_key":"plain-value","url":"https://user:pass-value@example.test"}',
    priority: 5,
    metadata: { authorization: "Bearer metadata-secret" }
  }]));
  const manifest = await compileHarnessManifest(compileInput);
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /two words secret|plain-value|pass-value|metadata-secret/);
});

test("redacts quoted JSON, query parameters and URI credentials", () => {
  const redacted = redactContextContent(
    '{"password":"two words secret","client_secret":"client value"} ' +
    "https://user:pass-value@example.test/callback?access_token=query-value " +
    "AWS_SECRET_ACCESS_KEY=aws-secret-value authorization=opaque-value"
  );
  assert.doesNotMatch(redacted, /two words secret|client value|user|pass-value|query-value|aws-secret-value|opaque-value/);
});

test("redacts escaped JSON secret values without leaving suffixes", () => {
  const secretSuffix = "escaped-secret-suffix";
  const json = JSON.stringify({
    password: `prefix\"${secretSuffix}`,
    nested: { api_key: `key-${secretSuffix}` },
    useful: "keep-me"
  });
  const redacted = redactContextContent(json);
  assert.doesNotMatch(redacted, new RegExp(secretSuffix));
  assert.equal(JSON.parse(redacted).password, "[REDACTED]");
  assert.equal(JSON.parse(redacted).nested.api_key, "[REDACTED]");
  assert.equal(JSON.parse(redacted).useful, "keep-me");

  const embedded = `prefix ${json} suffix`;
  assert.doesNotMatch(redactContextContent(embedded), new RegExp(secretSuffix));

  const malformed = `prefix {"password":"prefix\\\"malformed-secret-suffix`;
  assert.doesNotMatch(redactContextContent(malformed), /malformed-secret-suffix/);

  const assigned = 'password = "abc\\\"assignment-secret-suffix"';
  assert.doesNotMatch(redactContextContent(assigned), /assignment-secret-suffix/);

  const unquotedJson = '{"password":unquoted-secret-value}';
  assert.doesNotMatch(redactContextContent(unquotedJson), /unquoted-secret-value/);

  const unquotedJsonWithSuffix =
    '{"password":unquoted secret suffix,"useful":"keep"}';
  const suffixRedacted = redactContextContent(unquotedJsonWithSuffix);
  assert.doesNotMatch(suffixRedacted, /secret suffix/);
  assert.match(suffixRedacted, /"useful":"keep"/);

  const unicodeKey = '{"pass\\u0077ord":"unicode-secret-value"}';
  assert.doesNotMatch(redactContextContent(unicodeKey), /unicode-secret-value/);

  const malformedUnicode = 'prefix {"pass\\u0077ord":malformed-unicode-secret}';
  assert.doesNotMatch(
    redactContextContent(malformedUnicode),
    /malformed-unicode-secret/
  );
});

test("rejects credentials from every persisted manifest control string boundary", async () => {
  const cases: Array<{
    readonly secret: string;
    readonly code: string;
    readonly mutate: (compileInput: HarnessCompileInput) => void;
  }> = [
    {
      secret: "profile-secret",
      code: "INVALID_PROFILE",
      mutate(compileInput) {
        rebindProfile(compileInput, { id: "enterprise?token=profile-secret" });
      }
    },
    {
      secret: "schema-secret",
      code: "INVALID_PROFILE",
      mutate(compileInput) {
        rebindProfile(compileInput, { outputSchema: "schema?api_key=schema-secret" });
      }
    },
    {
      secret: "profile-version-secret",
      code: "INVALID_PROFILE",
      mutate(compileInput) {
        rebindProfile(compileInput, {
          version: "v1?password=profile-version-secret"
        });
      }
    },
    {
      secret: "task-secret",
      code: "INVALID_CONTEXT",
      mutate(compileInput) {
        compileInput.context = {
          ...compileInput.context,
          taskId: "task?access_token=task-secret"
        };
      }
    },
    {
      secret: "signature-secret",
      code: "INVALID_CONTEXT",
      mutate(compileInput) {
        compileInput.context = {
          ...compileInput.context,
          taskId:
            "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-secret"
        };
      }
    },
    {
      secret: "root-secret",
      code: "INVALID_CONTEXT",
      mutate(compileInput) {
        compileInput.context = {
          ...compileInput.context,
          projectRoot: "https://user:root-secret@example.test/repo"
        };
      }
    },
    {
      secret: "language-secret",
      code: "INVALID_CONTEXT",
      mutate(compileInput) {
        compileInput.context = {
          ...compileInput.context,
          languageByService: {
            checkout: "typescript?token=language-secret",
            payment: "typescript"
          }
        };
      }
    },
    {
      secret: "service-secret",
      code: "INVALID_CONTEXT",
      mutate(compileInput) {
        compileInput.context = {
          ...compileInput.context,
          selectedServices: ["checkout", "payment?token=service-secret"],
          languageByService: {
            checkout: "typescript",
            "payment?token=service-secret": "typescript"
          }
        };
      }
    }
  ];
  for (const attack of cases) {
    const compileInput = input();
    attack.mutate(compileInput);
    const error = await rejectsWithCode(compileInput, attack.code);
    assert.doesNotMatch(
      `${error.message} ${JSON.stringify(error.issues)}`,
      new RegExp(attack.secret)
    );
  }

  const runnerVersion = input();
  runnerVersion.registry = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    getGateRunner() {
      return { ...gate(), version: "v1?token=runner-secret" };
    },
    getSandboxBackend() {
      return sandbox();
    },
    listContextSources() {
      return [];
    }
  };
  const runnerError = await rejectsWithCode(
    runnerVersion,
    "INVALID_CAPABILITY_REGISTRY"
  );
  assert.doesNotMatch(JSON.stringify(runnerError.issues), /runner-secret/);

  const backendVersion = input();
  backendVersion.registry = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    getGateRunner() {
      return gate();
    },
    getSandboxBackend() {
      return { ...sandbox(), version: "v1?password=backend-secret" };
    },
    listContextSources() {
      return [];
    }
  };
  const backendError = await rejectsWithCode(backendVersion, "INVALID_SANDBOX");
  assert.doesNotMatch(JSON.stringify(backendError.issues), /backend-secret/);

  const policyExtra = input();
  policyExtra.governance = resignGovernance(policyExtra.governance, {
    policy: {
      ...policyExtra.governance.policy,
      credential: "token=policy-secret"
    } as unknown as GovernanceSnapshot["policy"]
  });
  const policyError = await rejectsWithCode(policyExtra, "INVALID_GOVERNANCE");
  assert.doesNotMatch(JSON.stringify(policyError.issues), /policy-secret/);

  const workflowSecret = input();
  workflowSecret.governance = resignGovernance(workflowSecret.governance, {
    workflowRef: {
      ...workflowSecret.governance.workflowRef!,
      id: "workflow?token=workflow-secret"
    }
  });
  const workflowError = await rejectsWithCode(
    workflowSecret,
    "INVALID_GOVERNANCE"
  );
  assert.doesNotMatch(JSON.stringify(workflowError.issues), /workflow-secret/);

  const policyNetwork = input();
  policyNetwork.governance = resignGovernance(policyNetwork.governance, {
    policy: {
      ...policyNetwork.governance.policy,
      networkAllowlist: [
        "https://user:network-secret@example.test"
      ]
    }
  });
  const networkError = await rejectsWithCode(
    policyNetwork,
    "INVALID_GOVERNANCE"
  );
  assert.doesNotMatch(JSON.stringify(networkError.issues), /network-secret/);

  const specId = input();
  const { digest: _digest, ...unsignedSpec } = specId.spec;
  const attackedUnsigned = {
    ...unsignedSpec,
    specSetId: "checkout?token=spec-id-secret"
  };
  specId.spec = {
    ...attackedUnsigned,
    digest: digestSpecRevision(attackedUnsigned)
  };
  specId.governance = resignGovernance(specId.governance, {
    specRef: {
      specSetId: specId.spec.specSetId,
      revision: specId.spec.revision,
      digest: specId.spec.digest!
    }
  });
  const specError = await rejectsWithCode(specId, "SPEC_INVALID");
  assert.doesNotMatch(JSON.stringify(specError.issues), /spec-id-secret/);
});

test("rejects secret-bearing metadata property keys before persistence", async () => {
  const compileInput = input();
  compileInput.registry.registerContextSource({
    id: "metadata-key",
    collect() {
      return [{
        id: "metadata-key-attack",
        kind: "metadata",
        source: "metadata",
        content: "safe",
        priority: 1,
        metadata: { "token=metadata-key-secret": "value" }
      }];
    }
  });
  const error = await rejectsWithCode(compileInput, "INVALID_CONTEXT");
  assert.doesNotMatch(JSON.stringify(error.issues), /metadata-key-secret/);
});

test("rejects secret-bearing fragment identifiers and sanitizes source URIs", async () => {
  for (const field of ["id", "kind"] as const) {
    const compileInput = input();
    compileInput.registry.registerContextSource({
      id: `sensitive-${field}`,
      collect() {
        return [{
          id: field === "id" ? "token=identifier-secret" : "ordinary-id",
          kind: field === "kind" ? "api_key=kind-secret" : "document",
          source: "docs/context.md",
          content: "safe",
          priority: 1
        }];
      }
    });
    const error = await rejectsWithCode(compileInput, "INVALID_CONTEXT");
    assert.doesNotMatch(
      `${error.message} ${JSON.stringify(error.issues)}`,
      /identifier-secret|kind-secret/
    );
  }

  const uri = input();
  uri.registry.registerContextSource({
    id: "uri-source",
    collect() {
      return [{
        id: "remote-contract",
        kind: "contract",
        source: "https://user:uri-password@example.test/openapi?access_token=uri-token",
        content: "safe",
        priority: 1
      }];
    }
  });
  const manifest = await compileHarnessManifest(uri);
  const fragment = manifest.context.fragments.find((entry) => entry.id === "remote-contract");
  assert.equal(
    fragment?.source,
    "https://[REDACTED]@example.test/openapi?access_token=[REDACTED]"
  );
  assert.doesNotMatch(JSON.stringify(manifest), /user|uri-password|uri-token/);
});

test("fails closed for fake registries with non-callable runner or sandbox operations", async () => {
  const badRunner = input();
  badRunner.registry = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    getGateRunner() {
      return { ...gate(), run: "not-callable" } as unknown as GateRunner;
    },
    getSandboxBackend() {
      return sandbox();
    },
    listContextSources() {
      return [];
    }
  };
  await rejectsWithCode(badRunner, "INVALID_CAPABILITY_REGISTRY");

  const badSandbox = input();
  badSandbox.registry = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    getGateRunner() {
      return gate();
    },
    getSandboxBackend() {
      return { ...sandbox(), prepare: "not-callable" } as unknown as SandboxBackend;
    },
    listContextSources() {
      return [];
    }
  };
  await rejectsWithCode(badSandbox, "INVALID_CAPABILITY_REGISTRY");

  const malformedRunner = input();
  malformedRunner.registry = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    getGateRunner() {
      return {
        ...gate(),
        id: "wrong-gate",
        version: " ",
        languages: ["typescript", "typescript"]
      };
    },
    getSandboxBackend() {
      return sandbox();
    },
    listContextSources() {
      return [];
    }
  };
  await rejectsWithCode(malformedRunner, "INVALID_CAPABILITY_REGISTRY");

  const malformedSandbox = input();
  malformedSandbox.registry = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    getGateRunner() {
      return gate();
    },
    getSandboxBackend() {
      return {
        ...sandbox(),
        id: "wrong-sandbox",
        version: " ",
        capabilities: ["filesystem", "filesystem"]
      };
    },
    listContextSources() {
      return [];
    }
  };
  await rejectsWithCode(malformedSandbox, "INVALID_SANDBOX");

  const missingMethod = input();
  missingMethod.registry = {
    getGateRunner() {
      return gate();
    },
    getSandboxBackend() {
      return sandbox();
    },
    listContextSources() {
      return [];
    }
  } as unknown as CapabilityRegistryLike;
  await rejectsWithCode(missingMethod, "INVALID_CAPABILITY_REGISTRY");

  const sparseSources = input();
  sparseSources.registry = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    getGateRunner() {
      return gate();
    },
    getSandboxBackend() {
      return sandbox();
    },
    listContextSources() {
      return new Array<ContextSource>(1);
    }
  };
  await rejectsWithCode(sparseSources, "INVALID_CAPABILITY_REGISTRY");
});

test("converts malicious context values into sanitized HarnessCompilationError", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "leak", {
    enumerable: true,
    get() {
      throw new Error("password=accessor-secret");
    }
  });
  const badValues: readonly unknown[] = [
    null,
    { id: "non-string", kind: "x", source: "x", content: 42, priority: 1 },
    { id: "bad-required", kind: "x", source: "x", content: "x", priority: 1, required: "yes" },
    { id: "date", kind: "x", source: "x", content: "x", priority: 1, metadata: { at: new Date() } },
    { id: "circular", kind: "x", source: "x", content: "x", priority: 1, metadata: circular },
    { id: "accessor", kind: "x", source: "x", content: "x", priority: 1, metadata: accessor }
  ];

  for (const [index, badValue] of badValues.entries()) {
    const compileInput = input();
    const source: ContextSource = {
      id: `bad-${index}`,
      collect() {
        return [badValue] as readonly ContextFragmentInput[];
      }
    };
    compileInput.registry.registerContextSource(source);
    const error = await rejectsWithCode(compileInput, "INVALID_CONTEXT");
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error.issues)}`, /accessor-secret/);
  }
});

test("uses fixed code-unit ordering, conservative versioned token estimates and omission digests", async () => {
  const compileInput = input();
  compileInput.registry.registerContextSource(createStaticContextSource("ordering", [
    { id: "z", kind: "doc", source: "z", content: "z", priority: 1 },
    { id: "ä", kind: "doc", source: "a-umlaut", content: "ä", priority: 1 },
    { id: "Z", kind: "doc", source: "capital-z", content: "Z", priority: 1 },
    { id: "large", kind: "doc", source: "large", content: "x".repeat(3_000), priority: 0 }
  ]));
  const manifest = await compileHarnessManifest(compileInput);
  assert.deepEqual(
    manifest.context.fragments.filter((entry) => ["Z", "z", "ä"].includes(entry.id)).map((entry) => entry.id),
    ["Z", "z", "ä"]
  );
  assert.deepEqual(manifest.context.tokenEstimator, {
    id: "utf8-byte-upper-bound",
    version: "1"
  });
  const unicode = manifest.context.fragments.find((entry) => entry.id === "ä");
  assert.equal(unicode?.tokenEstimate, unicode?.byteLength);
  assert.equal(
    unicode?.byteLength,
    Buffer.byteLength(JSON.stringify(unicode), "utf8")
  );
  const omitted = manifest.context.omitted.find((entry) => entry.id === "large");
  assert.match(omitted?.digest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    omitted?.contentDigest,
    createHash("sha256").update("x".repeat(3_000), "utf8").digest("hex")
  );
});

test("redaction handles Unicode and encoded keys, multi-word values, truncated PEM and is idempotent", () => {
  const secret = "must-never-survive in multiple words";
  const samples = [
    `ｐａｓｓｗｏｒｄ=${secret}`,
    `p%61ssword=${secret}`,
    `pass\\u{77}ord=${secret}`,
    `api%5Fkey=${secret}`,
    `密码=${secret}`,
    `prefix {"pass\\u0077ord":${secret},"useful":"keep"}`,
    `-----BEGIN PRIVATE KEY-----\n${secret}`
  ];
  for (const sample of samples) {
    const redacted = redactContextContent(sample);
    assert.doesNotMatch(redacted, /must-never-survive/);
    assert.equal(redactContextContent(redacted), redacted);
  }
  const error = new Error(`credential=${secret}`);
  const message = safeRedactedErrorMessage(error);
  assert.doesNotMatch(message, /must-never-survive/);
  assert.equal(safeRedactedErrorMessage(message), message);
});

test("enterprise profile identity cannot downgrade below enforced isolation", async () => {
  for (const id of ["enterprise", "enterprise-payments", "enterprise_v2"]) {
    const compileInput = input();
    rebindProfile(compileInput, {
      id,
      minimumSandboxEnforcement: "postcheck"
    });
    await rejectsWithCode(compileInput, "INVALID_PROFILE");
  }
});

test("context budget accounts for full serialized fragments and bounds raw aggregate before redaction", async () => {
  const serialized = input();
  rebindProfile(serialized, { maxContextBytes: 420, maxContextTokens: 420 });
  const registry = new CapabilityRegistry();
  registry.registerGateRunner(gate());
  registry.registerSandboxBackend(sandbox());
  registry.registerContextSource(createStaticContextSource("metadata-heavy", [{
    id: "tiny-content",
    kind: "metadata",
    source: `project://${"s".repeat(180)}`,
    content: "x",
    priority: 1,
    metadata: { owner: "team", description: "m".repeat(180) }
  }]));
  serialized.registry = registry;
  const manifest = await compileHarnessManifest(serialized);
  assert.deepEqual(manifest.context.fragments, []);
  assert.equal(manifest.context.omitted[0]?.id, "tiny-content");
  assert.ok((manifest.context.omitted[0]?.byteLength ?? 0) > 420);

  const selected = input();
  const selectedManifest = await compileHarnessManifest(selected);
  assert.equal(
    selectedManifest.context.usedBytes,
    Buffer.byteLength(JSON.stringify(selectedManifest.context.fragments), "utf8")
  );
  assert.equal(selectedManifest.context.usedTokens, selectedManifest.context.usedBytes);

  const raw = input();
  raw.registry.registerContextSource({
    id: "raw-secret-flood",
    collect() {
      return [{
        id: "raw-flood",
        kind: "configuration",
        source: "raw",
        content: `password=${"z".repeat(1_100_000)}`,
        priority: 1
      }];
    }
  });
  await rejectsWithCode(raw, "INVALID_CONTEXT");
});

test("governance root, layers, waivers, decisions and resolution timestamp use exact semantics", async () => {
  const mutations: Array<(compileInput: HarnessCompileInput) => void> = [
    (compileInput) => {
      compileInput.governance = resignGovernance(
        compileInput.governance,
        { unexpectedRoot: true } as unknown as Partial<GovernanceSnapshot>
      );
    },
    (compileInput) => {
      compileInput.governance = resignGovernance(compileInput.governance, {
        layers: compileInput.governance.layers.map((layer, index) =>
          index === 0 ? { ...layer, hiddenRule: true } as never : layer
        )
      });
    },
    (compileInput) => {
      compileInput.governance = resignGovernance(compileInput.governance, {
        appliedWaivers: [{ unexpected: true } as never]
      });
    },
    (compileInput) => {
      compileInput.governance = resignGovernance(compileInput.governance, {
        decisions: compileInput.governance.decisions.map((decision, index) =>
          index === 0
            ? { ...decision, effectiveValue: ["different"] }
            : decision
        )
      });
    },
    (compileInput) => {
      compileInput.governance = resignGovernance(compileInput.governance, {
        resolvedAt: "2026-02-30T01:00:00Z"
      });
    },
    (compileInput) => {
      const base = compileInput.governance.layers[0]!;
      compileInput.governance = resignGovernance(compileInput.governance, {
        layers: [
          base,
          {
            ...base,
            scopeId: "other-active-builtin",
            source: { id: "other/source", version: "1", digest: "b".repeat(64) }
          }
        ]
      });
    },
    (compileInput) => {
      const base = compileInput.governance.layers[0]!;
      compileInput.governance = resignGovernance(compileInput.governance, {
        layers: [
          base,
          {
            ...base,
            scope: "organization",
            scopeId: "acme"
          }
        ]
      });
    },
    (compileInput) => {
      compileInput.governance = resignGovernance(compileInput.governance, {
        decisions: [...compileInput.governance.decisions].reverse()
      });
    }
  ];
  for (const mutate of mutations) {
    const compileInput = input();
    mutate(compileInput);
    await rejectsWithCode(compileInput, "INVALID_GOVERNANCE");
  }
});

test("accepts an exact active waiver whose decision removes and traces its target", async () => {
  const compileInput = input();
  const layers: ScopedGovernanceLayer[] = [{
    scope: "builtin",
    scopeId: "default",
    source: { id: "builtin/default", version: "1", digest: "a".repeat(64) },
    policy: {
      requiredGates: ["unit_test"],
      deny: ["legacy-endpoint"],
      waivableRules: [{ field: "deny", value: "legacy-endpoint" }],
      budgets: { maxCandidates: 4, maxRepairAttempts: 3 },
      approvalMode: "on-risk"
    }
  }];
  compileInput.governance = resolveGovernance(layers, {
    now: "2026-07-11T01:00:00.000Z",
    scopeBindings: { builtin: "default" },
    specRef: {
      specSetId: compileInput.spec.specSetId,
      revision: compileInput.spec.revision,
      digest: compileInput.spec.digest!
    },
    workflowRef: {
      id: "governed-increment-v1",
      version: "1",
      digest: "b".repeat(64)
    },
    harnessProfileRef: {
      id: compileInput.profile.id,
      version: compileInput.profile.version,
      digest: compileInput.profile.digest!
    },
    waivers: [{
      id: "temporary-legacy-endpoint",
      target: { field: "deny", value: "legacy-endpoint" },
      scope: { level: "builtin", id: "default" },
      reason: "Temporary compatibility window",
      approvedBy: "governance-admin@example.com",
      approvedAt: "2026-07-11T00:30:00.000Z",
      expiresAt: "2026-07-12T00:00:00.000Z"
    }]
  });
  const manifest = await compileHarnessManifest(compileInput);
  assert.deepEqual(manifest.policy.deny, []);
});

test("capability invocation and Date parsing never read attacker-controlled bind/getTime getters", async () => {
  let getterCalls = 0;
  const compileInput = input();
  const registry = new CapabilityRegistry();
  const run = async () => ({
    id: "unit_test",
    status: "pass" as const,
    summary: "ok",
    evidence: []
  });
  const prepare = async () => ({ backendId: "container", workspacePath: "/workspace" });
  const collect = () => [] as readonly ContextFragmentInput[];
  for (const callable of [run, prepare, collect]) {
    Object.defineProperty(callable, "bind", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("password=bind-getter-secret");
      }
    });
  }
  registry.registerGateRunner({
    id: "unit_test",
    version: "1",
    languages: ["typescript"],
    run
  });
  registry.registerSandboxBackend({
    id: "container",
    version: "1",
    enforcement: "enforced",
    capabilities: ["filesystem", "network-policy"],
    runtimeImage: { reference: "registry.example/mn-runtime", digest: "9".repeat(64) },
    prepare
  });
  registry.registerContextSource({ id: "safe", collect });
  compileInput.registry = registry;
  const date = new Date("2026-07-11T02:00:00.000Z");
  Object.defineProperty(date, "getTime", {
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error("password=date-getter-secret");
    }
  });
  compileInput.now = date;
  const manifest = await compileHarnessManifest(compileInput);
  assert.equal(manifest.generatedAt, "2026-07-11T02:00:00.000Z");

  const poisonBind = <T extends (...args: never[]) => unknown>(callable: T): T => {
    Object.defineProperty(callable, "bind", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("password=fake-registry-bind-secret");
      }
    });
    return callable;
  };
  const fakeInput = input();
  const rawRun = poisonBind(async () => ({
    id: "unit_test",
    status: "pass" as const,
    summary: "ok",
    evidence: []
  }));
  const rawPrepare = poisonBind(async () => ({
    backendId: "container",
    workspacePath: "/workspace"
  }));
  const rawCollect = poisonBind(() => [] as readonly ContextFragmentInput[]);
  const getGateRunner = poisonBind((id: string) =>
    id === "unit_test"
      ? { id, version: "1", languages: ["typescript"], run: rawRun }
      : undefined
  );
  const getSandboxBackend = poisonBind((id: string) =>
    id === "container"
      ? {
          id,
          version: "1",
          enforcement: "enforced" as const,
          capabilities: ["filesystem", "network-policy"],
          runtimeImage: { reference: "registry.example/mn-runtime", digest: "9".repeat(64) },
          prepare: rawPrepare
        }
      : undefined
  );
  const listContextSources = poisonBind(() => [{ id: "safe", collect: rawCollect }]);
  fakeInput.registry = {
    registerGateRunner() {},
    registerSandboxBackend() {},
    registerContextSource() {},
    getGateRunner,
    getSandboxBackend,
    listContextSources
  };
  await compileHarnessManifest(fakeInput);
  assert.equal(getterCalls, 0);
});

test("HarnessProfile rejects unknown fields and cannot give them an ambiguous digest", async () => {
  const compileInput = input();
  compileInput.profile = {
    ...compileInput.profile,
    activationHook: "run-arbitrary-code"
  } as unknown as HarnessProfile;
  await rejectsWithCode(compileInput, "INVALID_PROFILE");

  const valid = profile();
  assert.throws(() => digestHarnessProfile({
    ...valid,
    activationHook: "ignored-before-hardening"
  } as unknown as HarnessProfile));
});

test("generatedAt cannot predate Spec creation/approval or Governance resolution", async () => {
  const beforeApproval = input();
  beforeApproval.now = "2026-07-11T00:30:00.000Z";
  await rejectsWithCode(beforeApproval, "INVALID_GENERATED_AT");

  const beforeGovernance = input();
  beforeGovernance.governance = resignGovernance(beforeGovernance.governance, {
    resolvedAt: "2026-07-11T03:00:00.000Z"
  });
  beforeGovernance.now = "2026-07-11T02:00:00.000Z";
  await rejectsWithCode(beforeGovernance, "INVALID_GENERATED_AT");
});
