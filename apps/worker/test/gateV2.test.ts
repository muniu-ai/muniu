import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  GateRegistryV2,
  canonicalizeGateEvidenceLog,
  createDefaultGateRegistry,
  createGoGateRunner,
  createJavaGateRunner,
  createPythonGateRunner,
  createRustGateRunner,
  gateResultV2OutputDigest,
  parseGateResultV2,
  runGateEngineV2,
  validateGateResultV2,
  type GateCommandExecutor,
  type GateRunnerV2
} from "../src/index.js";

const execFileAsync = promisify(execFile);

async function tempProject(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mn-gate-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Gate V2 emits command, tool, digest, artifact, clause, time, and freshness evidence", async (t) => {
  const root = await tempProject(t);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node -e \"console.log('gate-v2-ok')\"" } }),
    "utf8"
  );
  const [result] = await runGateEngineV2({
    cwd: root,
    gates: [
      {
        id: "unit_test",
        required: true,
        language: "typescript",
        specClauseIds: ["accept-checkout"]
      }
    ],
    registry: createDefaultGateRegistry(),
    runId: "run-1",
    candidateId: "candidate-1",
    failClosed: true
  });
  assert.equal(result?.status, "pass");
  assert.equal(result?.command?.display, "npm run test");
  assert.equal(result?.tool?.id, "npm");
  assert.notEqual(result?.tool?.version, "unknown");
  assert.deepEqual(result?.specClauseIds, ["accept-checkout"]);
  assert.match(result?.inputDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.match(result?.outputDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.match(result?.artifacts[0]?.digest ?? "", /^[a-f0-9]{64}$/u);
  assert.ok(Date.parse(result!.freshUntil!) > Date.parse(result!.finishedAt));
  assert.ok(Object.isFrozen(result));
});

test("Gate V2 publishes exact artifact bytes before emitting an enterprise handle", async (t) => {
  const root = await tempProject(t);
  const registry = new GateRegistryV2();
  registry.register({
    id: "test/evaluator",
    version: "1",
    gateIds: ["acceptance_coverage"],
    languages: ["typescript"],
    evaluate() {
      return {
        status: "pass",
        summary: "coverage passed",
        log: "verified bytes"
      };
    }
  });
  const published: Array<{ gateResultId: string; text: string }> = [];
  const [result] = await runGateEngineV2({
    cwd: root,
    gates: [{ id: "acceptance_coverage", required: true, language: "typescript" }],
    registry,
    runId: "enterprise-run",
    candidateId: "candidate-1",
    failClosed: true,
    artifactPublisher: async (request) => {
      published.push({
        gateResultId: request.gateResultId,
        text: Buffer.from(request.content).toString("utf8")
      });
      return {
        ...request.artifact,
        handle: "mn://cas/gate-artifacts/00000000-0000-4000-8000-000000000001"
      };
    }
  });
  assert.equal(result?.status, "pass");
  assert.deepEqual(published, [{ gateResultId: result!.id, text: "verified bytes" }]);
  assert.equal(
    result?.artifacts[0]?.handle,
    "mn://cas/gate-artifacts/00000000-0000-4000-8000-000000000001"
  );
  assert.equal(result?.artifacts[0]?.path, undefined);
  assert.equal(result?.outputDigest, gateResultV2OutputDigest(result!));
  assert.equal(parseGateResultV2(structuredClone(result)).artifacts[0]?.handle,
    result?.artifacts[0]?.handle);
});

test("logical evidence cwd does not change resolver, evaluator, execute, or probe cwd", async (t) => {
  const root = await tempProject(t);
  const logical = "/logical/candidate/services/orders";
  const observed: Array<[string, string]> = [];
  const registry = new GateRegistryV2();
  registry.register({
    id: "logical-command-runner",
    version: "1",
    gateIds: ["unit_test"],
    languages: ["typescript"],
    resolveCommand(context) {
      observed.push(["resolve", context.cwd]);
      return {
        executable: "node",
        args: ["-e", "process.exit(0)"],
        display: "node -e process.exit(0)",
        versionArgs: ["--version"]
      };
    }
  });
  const executeCommand = (evidenceCwd: string) => runGateEngineV2({
    cwd: root,
    evidenceCwd,
    gates: [{ id: "unit_test", required: true, language: "typescript" }],
    registry,
    runId: "logical-cwd-run",
    candidateId: "candidate-1",
    failClosed: true,
    commandExecutor: {
      id: "test/logical-cwd",
      version: "1",
      sandboxExecution: canonicalizationExecution(),
      async resolveToolIdentity(executable) {
        return testToolIdentity(executable);
      },
      async execute(request) {
        observed.push(["execute", request.cwd]);
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
      async probeVersion(_executable, _args, cwd) {
        observed.push(["probe", cwd]);
        return "v25.7.0";
      }
    }
  });
  const [commandResult] = await executeCommand(logical);
  const [differentLogicalResult] = await executeCommand(`${logical}-other`);
  assert.equal(commandResult?.workingDirectory, logical);
  assert.notEqual(commandResult?.inputDigest, differentLogicalResult?.inputDigest);
  assert.deepEqual(
    observed.map(([kind, cwd]) => [kind, cwd]),
    [
      ["resolve", root],
      ["execute", root],
      ["probe", root],
      ["resolve", root],
      ["execute", root],
      ["probe", root]
    ]
  );

  const evaluatorRegistry = new GateRegistryV2();
  let evaluatedCwd = "";
  evaluatorRegistry.register({
    id: "logical-evaluator",
    version: "1",
    gateIds: ["acceptance_coverage"],
    languages: ["typescript"],
    evaluate(context) {
      evaluatedCwd = context.cwd;
      return { status: "pass", summary: "evaluated actual cwd" };
    }
  });
  const [evaluation] = await runGateEngineV2({
    cwd: root,
    evidenceCwd: logical,
    gates: [{ id: "acceptance_coverage", required: true, language: "typescript" }],
    registry: evaluatorRegistry,
    runId: "logical-evaluator-run",
    candidateId: "candidate-1",
    failClosed: true
  });
  assert.equal(evaluatedCwd, root);
  assert.equal(evaluation?.workingDirectory, logical);

  const [synthetic] = await runGateEngineV2({
    cwd: root,
    evidenceCwd: logical,
    gates: [{ id: "missing", required: true, language: "typescript" }],
    registry: new GateRegistryV2(),
    runId: "logical-synthetic-run",
    candidateId: "candidate-1",
    failClosed: true
  });
  assert.equal(synthetic?.workingDirectory, logical);
});

test("node-test JUnit canonicalization requires a complete reporter envelope", () => {
  const first = junitEvidence({
    name: "approved increment remains correct",
    testcaseTime: "0.028444",
    durationMs: "172.244125"
  });
  const second = junitEvidence({
    name: "approved increment remains correct",
    testcaseTime: "0.026303",
    durationMs: "160.955375"
  });
  const canonical = canonicalizeGateEvidenceLog(first, "node-test-junit-v2");
  assert.equal(
    canonical,
    canonicalizeGateEvidenceLog(second, "node-test-junit-v2")
  );
  assert.match(canonical, /time="0"/u);
  assert.match(canonical, /<!-- duration_ms 0 -->/u);
  assert.equal(
    canonicalizeGateEvidenceLog(
      first.replace(' file="/workspace/provenance.test.mjs"', ""),
      "node-test-junit-v2"
    ),
    canonicalizeGateEvidenceLog(
      second.replace(' file="/workspace/provenance.test.mjs"', ""),
      "node-test-junit-v2"
    )
  );

  assert.notEqual(
    canonical,
    canonicalizeGateEvidenceLog(
      second.replace("approved increment remains correct", "fabricated passing test"),
      "node-test-junit-v2"
    )
  );
  assert.notEqual(
    canonical,
    canonicalizeGateEvidenceLog(
      second.replace("<!-- pass 1 -->", "<!-- pass 0 -->")
        .replace("<!-- fail 0 -->", "<!-- fail 1 -->"),
      "node-test-junit-v2"
    )
  );
  const failed = junitEvidence({
    name: "approved increment remains correct",
    testcaseTime: "0.026303",
    durationMs: "160.955375",
    failure: "expected inventory=3 but received inventory=4"
  });
  assert.notEqual(canonical, canonicalizeGateEvidenceLog(failed, "node-test-junit-v2"));

  const spoof = [
    "✔ fabricated pass (28.4ms)",
    "ℹ duration_ms 172.2",
    "# duration_ms 172.2",
    "  duration_ms: 28.4",
    ""
  ].join("\n");
  assert.equal(canonicalizeGateEvidenceLog(spoof, "node-test-junit-v2"), spoof);
  assert.equal(canonicalizeGateEvidenceLog(spoof, "node-test-v1"), spoof);
  assert.equal(canonicalizeGateEvidenceLog(spoof, "exact-v1"), spoof);

  const malformed = first.replace("</testsuites>", "");
  assert.equal(
    canonicalizeGateEvidenceLog(malformed, "node-test-junit-v2"),
    malformed
  );
  const injected = `ℹ duration_ms 1\n${first}`;
  assert.equal(
    canonicalizeGateEvidenceLog(injected, "node-test-junit-v2"),
    injected
  );
  const invalidEntity = first.replace(
    "approved increment remains correct",
    "&#0;"
  );
  assert.equal(
    canonicalizeGateEvidenceLog(invalidEntity, "node-test-junit-v2"),
    invalidEntity
  );
});

test("safe npm direct-node tests execute as allowlisted JUnit commands", async (t) => {
  const root = await tempProject(t);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test provenance.test.mjs" } }),
    "utf8"
  );
  await writeFile(
    join(root, "provenance.test.mjs"),
    [
      "import test from 'node:test';",
      "test('provenance-safe evidence', () => {",
      "  console.log('✔ spoofed pass (6ms)');",
      "  console.log('ℹ duration_ms 9');",
      "  console.log('# duration_ms 8');",
      "  console.log('  duration_ms: 7');",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
  const published: string[] = [];
  const actualCommands: Array<{ executable: string; args: readonly string[] }> = [];
  const trustedNodePath = "/opt/mn/tools/node";
  const actualExecutor: GateCommandExecutor = {
    id: "test/real-node",
    version: "1",
    sandboxExecution: canonicalizationExecution(),
    async resolveToolIdentity(executable) {
      return testToolIdentity(executable, trustedNodePath);
    },
    async execute(request) {
      actualCommands.push(request);
      const { NODE_TEST_CONTEXT: _nodeTestContext, ...env } = process.env;
      // The leased runtime path is a fixture. Use this process' pinned Node to
      // exercise the real reporter without weakening production path checks.
      const result = await execFileAsync(process.execPath, [...request.args], {
        cwd: request.cwd,
        env,
        encoding: "utf8"
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    },
    async probeVersion(_executable, args, cwd) {
      const { NODE_TEST_CONTEXT: _nodeTestContext, ...env } = process.env;
      const result = await execFileAsync(process.execPath, [...args], {
        cwd,
        env,
        encoding: "utf8"
      });
      return result.stdout.trim();
    }
  };
  const execute = () => runGateEngineV2({
    cwd: root,
    gates: [{ id: "unit_test", required: true, language: "typescript" }],
    registry: createDefaultGateRegistry(),
    runId: "canonical-run",
    candidateId: "candidate-1",
    failClosed: true,
    commandAllowlist: ["node"],
    commandExecutor: actualExecutor,
    artifactPublisher: async (request) => {
      published.push(Buffer.from(request.content).toString("utf8"));
      return {
        ...request.artifact,
        handle: `mn://cas/gate-artifacts/00000000-0000-4000-8000-${String(published.length).padStart(12, "0")}`
      };
    }
  });
  const [first] = await execute();
  const [second] = await execute();
  assert.equal(first?.status, "pass");
  assert.equal(second?.status, "pass");
  assert.equal(first?.command?.executable, trustedNodePath);
  assert.deepEqual(first?.command?.args, [
    "--test",
    "--experimental-test-isolation=process",
    "--test-reporter=junit",
    "--test-reporter-destination=stdout",
    "provenance.test.mjs"
  ]);
  assert.equal(first?.tool?.id, "node");
  assert.equal(first?.tool?.resolvedExecutable, trustedNodePath);
  assert.match(first?.tool?.contentDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(first?.tool?.imageDigest, TEST_IMAGE_DIGEST);
  assert.equal(actualCommands[0]?.executable, trustedNodePath);
  assert.equal(published[0], published[1], JSON.stringify(published));
  assert.equal(first?.artifacts[0]?.digest, second?.artifacts[0]?.digest);
  assert.match(published[0] ?? "", /^<\?xml version="1\.0" encoding="utf-8"\?>/u);
  assert.match(published[0] ?? "", /time="0"/u);
  assert.doesNotMatch(published[0] ?? "", /spoofed pass|ℹ duration_ms 9|# duration_ms 8/u);
});

test("node-test conversion checks the actual node tool allowlist", async (t) => {
  const root = await tempProject(t);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test provenance.test.mjs" } }),
    "utf8"
  );
  let executions = 0;
  const [result] = await runGateEngineV2({
    cwd: root,
    gates: [{ id: "unit_test", required: true, language: "typescript" }],
    registry: createDefaultGateRegistry(),
    runId: "allowlist-run",
    candidateId: "candidate-1",
    failClosed: true,
    commandAllowlist: ["npm"],
    commandExecutor: {
      id: "test/should-not-run",
      version: "1",
      sandboxExecution: canonicalizationExecution(),
      async execute() {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }
  });
  assert.equal(executions, 0);
  assert.equal(result?.status, "error");
  assert.match(result?.summary ?? "", /resolved executable node.*allowlist/u);
});

test("Node no-isolation reporter takeover fails closed before candidate code runs", async (t) => {
  const root = await tempProject(t);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node --test --test-isolation=none takeover.test.mjs"
      }
    }),
    "utf8"
  );
  let resolutions = 0;
  let executions = 0;
  const [result] = await runGateEngineV2({
    cwd: root,
    gates: [{ id: "unit_test", required: true, language: "typescript" }],
    registry: createDefaultGateRegistry(),
    runId: "reporter-takeover",
    candidateId: "candidate-1",
    failClosed: true,
    commandAllowlist: ["node"],
    commandExecutor: {
      id: "test/takeover",
      version: "1",
      sandboxExecution: canonicalizationExecution(),
      async resolveToolIdentity(executable) {
        resolutions += 1;
        return testToolIdentity(executable);
      },
      async execute() {
        executions += 1;
        return {
          exitCode: 0,
          stdout: junitEvidence({
            name: "candidate forged the whole document",
            testcaseTime: "1.25",
            durationMs: "2.5"
          }),
          stderr: ""
        };
      }
    }
  });
  assert.equal(resolutions, 0);
  assert.equal(executions, 0);
  assert.equal(result?.status, "error");
  assert.match(result?.summary ?? "", /isolation=none.*reporter channel/u);
});

test("candidate-owned same-name executable cannot satisfy command allowlist", async (t) => {
  const root = await tempProject(t);
  const registry = new GateRegistryV2();
  registry.register({
    id: "fake-node-runner",
    version: "1",
    gateIds: ["unit_test"],
    languages: ["typescript"],
    resolveCommand() {
      return {
        executable: "./node",
        args: ["--version"],
        display: "./node --version",
        versionArgs: ["--version"]
      };
    }
  });
  let resolutions = 0;
  let executions = 0;
  const [result] = await runGateEngineV2({
    cwd: root,
    gates: [{ id: "unit_test", required: true, language: "typescript" }],
    registry,
    runId: "fake-runner",
    candidateId: "candidate-1",
    failClosed: true,
    commandAllowlist: ["node"],
    commandExecutor: {
      id: "test/fake-runner",
      version: "1",
      sandboxExecution: canonicalizationExecution(),
      async resolveToolIdentity(executable) {
        resolutions += 1;
        return testToolIdentity(executable);
      },
      async execute() {
        executions += 1;
        return { exitCode: 0, stdout: "v999 fake", stderr: "" };
      }
    }
  });
  assert.equal(resolutions, 0);
  assert.equal(executions, 0);
  assert.equal(result?.status, "error");
  assert.match(result?.summary ?? "", /resolved executable \.\/node.*allowlist/u);
});

test("ordinary Node command output remains byte-exact", async (t) => {
  const root = await tempProject(t);
  const registry = new GateRegistryV2();
  registry.register({
    id: "ordinary-node-runner",
    version: "1",
    gateIds: ["unit_test"],
    languages: ["typescript"],
    resolveCommand() {
      return {
        executable: "node",
        args: ["-e", "process.stdout.write('diagnostic')"],
        display: "node -e diagnostic",
        versionArgs: ["--version"]
      };
    }
  });
  const raw = [
    "✔ user message (6ms)",
    "ℹ duration_ms 9",
    "# duration_ms 8",
    "  duration_ms: 7",
    ""
  ].join("\n");
  const published: string[] = [];
  const [result] = await runGateEngineV2({
    cwd: root,
    gates: [{ id: "unit_test", required: true, language: "typescript" }],
    registry,
    runId: "ordinary-node-run",
    candidateId: "candidate-1",
    failClosed: true,
    commandExecutor: {
      id: "test/ordinary-node",
      version: "1",
      sandboxExecution: canonicalizationExecution(),
      async resolveToolIdentity(executable) {
        return testToolIdentity(executable);
      },
      async execute() {
        return { exitCode: 0, stdout: raw, stderr: "" };
      },
      async probeVersion() {
        return "v25.7.0";
      }
    },
    artifactPublisher: async (request) => {
      published.push(Buffer.from(request.content).toString("utf8"));
      return {
        ...request.artifact,
        handle: "mn://cas/gate-artifacts/00000000-0000-4000-8000-000000000098"
      };
    }
  });
  assert.equal(result?.command?.executable, "/opt/mn/tools/node");
  assert.deepEqual(result?.command?.args, ["-e", "process.stdout.write('diagnostic')"]);
  assert.equal(published[0], raw);
});

test("npm lifecycle, control syntax, and non-direct scripts remain exact", async (t) => {
  const root = await tempProject(t);
  const cases = [
    {
      name: "lifecycle",
      scripts: { pretest: "node pre.mjs", test: "node --test test.mjs" }
    },
    {
      name: "control",
      scripts: { test: "node --test test.mjs && node after.mjs" }
    },
    {
      name: "non-direct",
      scripts: { test: "vitest run" }
    }
  ] as const;
  for (const [index, fixture] of cases.entries()) {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: fixture.scripts }),
      "utf8"
    );
    const requests: Array<{ executable: string; args: readonly string[] }> = [];
    const raw = `ℹ duration_ms ${index + 1}.25\n`;
    const published: string[] = [];
    const [result] = await runGateEngineV2({
      cwd: root,
      gates: [{ id: "unit_test", required: true, language: "typescript" }],
      registry: createDefaultGateRegistry(),
      runId: `exact-${fixture.name}`,
      candidateId: "candidate-1",
      failClosed: true,
      commandAllowlist: ["npm", "node"],
      commandExecutor: {
        id: "test/exact-npm",
        version: "1",
        sandboxExecution: canonicalizationExecution(),
        async resolveToolIdentity(executable) {
          return testToolIdentity(executable);
        },
        async execute(request) {
          requests.push(request);
          return { exitCode: 0, stdout: raw, stderr: "" };
        },
        async probeVersion() {
          return "11.10.1";
        }
      },
      artifactPublisher: async (request) => {
        published.push(Buffer.from(request.content).toString("utf8"));
        return {
          ...request.artifact,
          handle: `mn://cas/gate-artifacts/00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`
        };
      }
    });
    assert.equal(result?.status, "pass");
    assert.equal(result?.command?.executable, "/opt/mn/tools/npm", fixture.name);
    assert.equal(requests[0]?.executable, "/opt/mn/tools/npm", fixture.name);
    assert.equal(published[0], raw, fixture.name);
  }
});

function junitEvidence(input: {
  name: string;
  testcaseTime: string;
  durationMs: string;
  failure?: string;
}): string {
  const testcase = input.failure
    ? [
        `\t<testcase name="${input.name}" time="${input.testcaseTime}" classname="test" file="/workspace/provenance.test.mjs" failure="${input.failure}">`,
        `\t\t<failure type="testCodeFailure" message="${input.failure}">${input.failure}</failure>`,
        "\t</testcase>"
      ]
    : [
        `\t<testcase name="${input.name}" time="${input.testcaseTime}" classname="test" file="/workspace/provenance.test.mjs"/>`
      ];
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<testsuites>",
    ...testcase,
    "\t<!-- tests 1 -->",
    "\t<!-- suites 0 -->",
    `\t<!-- pass ${input.failure ? 0 : 1} -->`,
    `\t<!-- fail ${input.failure ? 1 : 0} -->`,
    "\t<!-- cancelled 0 -->",
    "\t<!-- skipped 0 -->",
    "\t<!-- todo 0 -->",
    `\t<!-- duration_ms ${input.durationMs} -->`,
    "</testsuites>",
    ""
  ].join("\n");
}

function canonicalizationExecution() {
  return {
    backendId: "enterprise-container",
    backendVersion: "1",
    leaseId: "lease-canonical",
    attestationDigest: "a".repeat(64),
    runtimeId: "b".repeat(64),
    runtimeDigest: "c".repeat(64),
    imageDigest: TEST_IMAGE_DIGEST,
    runtimeProof: {
      schemaVersion: 1 as const,
      issuer: "mn-api" as const,
      issuedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T01:00:00.000Z",
      tenantId: "tenant-a",
      runId: "canonical-run",
      workerId: "worker-a",
      claimDigest: "d".repeat(64),
      attestationDigest: "a".repeat(64),
      runtimeId: "b".repeat(64),
      runtimeDigest: "c".repeat(64),
      imageDigest: TEST_IMAGE_DIGEST,
      digest: "e".repeat(64),
      signature: "f".repeat(64)
    }
  };
}

const TEST_IMAGE_DIGEST = "9".repeat(64);

function testToolIdentity(executable: string, resolved?: string) {
  const resolvedExecutable = resolved ?? `/opt/mn/tools/${executable}`;
  return {
    schemaVersion: 1 as const,
    requestedExecutable: executable,
    resolvedExecutable,
    contentDigest: createHash("sha256").update(`trusted:${resolvedExecutable}`).digest("hex"),
    imageDigest: TEST_IMAGE_DIGEST
  };
}

test("required missing or unsupported runners fail closed", async (t) => {
  const root = await tempProject(t);
  const registry = createDefaultGateRegistry();
  const missing = await runGateEngineV2({
    cwd: root,
    gates: [{ id: "unregistered_enterprise_gate", required: true, language: "go" }],
    registry,
    runId: "run-1",
    candidateId: "candidate-1",
    failClosed: true
  });
  assert.equal(missing[0]?.status, "error");
  assert.match(missing[0]?.summary ?? "", /No runner supports/u);

  const unsupported = await runGateEngineV2({
    cwd: root,
    gates: [{ id: "unit_test", required: true, language: "elixir" }],
    registry,
    runId: "run-1",
    candidateId: "candidate-1",
    failClosed: false
  });
  assert.equal(unsupported[0]?.status, "unsupported");
});

test("required undiscoverable commands fail closed while classic mode may skip", async (t) => {
  const root = await tempProject(t);
  const registry = createDefaultGateRegistry();
  const closed = await runGateEngineV2({
    cwd: root,
    gates: [{ id: "typecheck", required: true, language: "typescript" }],
    registry,
    runId: "run-1",
    candidateId: "candidate-1",
    failClosed: true
  });
  const classic = await runGateEngineV2({
    cwd: root,
    gates: [{ id: "typecheck", required: true, language: "typescript" }],
    registry,
    runId: "run-2",
    candidateId: "candidate-1",
    failClosed: false
  });
  assert.equal(closed[0]?.status, "error");
  assert.equal(classic[0]?.status, "skipped");
});

test("Gate registry rejects duplicate runner and gate/language capabilities", () => {
  const registry = new GateRegistryV2();
  const runner: GateRunnerV2 = {
    id: "runner-a",
    version: "1",
    gateIds: ["custom"],
    languages: ["go"],
    resolveCommand() {
      return undefined;
    }
  };
  registry.register(runner);
  assert.throws(() => registry.register(runner), /already registered/u);
  assert.throws(
    () =>
      registry.register({ ...runner, id: "runner-b" }),
    /capability custom\/go is already registered/u
  );
});

test("builtin runners select deterministic Go, Java, Python, and Rust commands", async () => {
  const cases = [
    [createGoGateRunner(), "go", "typecheck", "go test -run=^$ ./..."],
    [createPythonGateRunner(), "python", "lint", "python -m ruff check ."],
    [createRustGateRunner(), "rust", "typecheck", "cargo check"]
  ] as const;
  for (const [runner, language, gateId, display] of cases) {
    const resolved = await runner.resolveCommand({
      gateId,
      language,
      cwd: "/tmp/project"
    });
    assert.equal(resolved?.display, display);
  }
  const java = createJavaGateRunner();
  const declared = await java.resolveCommand({
    gateId: "unit_test",
    language: "java",
    cwd: "/tmp/project",
    declaredCommands: {
      unit_test: { executable: "./gradlew", args: ["test"] }
    }
  });
  assert.equal(declared?.display, "./gradlew test");
});

test("Gate V2 records cancellation and command timeout as non-pass", async (t) => {
  const root = await tempProject(t);
  const registry = createDefaultGateRegistry();
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runGateEngineV2({
    cwd: root,
    gates: [{ id: "unit_test", required: true, language: "typescript" }],
    registry,
    runId: "cancelled",
    candidateId: "candidate",
    failClosed: true,
    abortSignal: controller.signal
  });
  assert.equal(cancelled[0]?.status, "cancelled");

  const timeout = await runGateEngineV2({
    cwd: root,
    gates: [
      {
        id: "unit_test",
        required: true,
        language: "typescript",
        timeoutSeconds: 1,
        declaredCommands: {
          unit_test: {
            executable: process.execPath,
            args: ["-e", "setTimeout(() => {}, 10000)"]
          }
        }
      }
    ],
    registry,
    runId: "timeout",
    candidateId: "candidate",
    failClosed: true
  });
  assert.notEqual(timeout[0]?.status, "pass");
  assert.match(timeout[0]?.summary ?? "", /exit code null|error/u);
});

test("external Gate V2 parser rejects malformed exact evidence without throwing raw errors", async (t) => {
  const root = await tempProject(t);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node -e \"console.log('ok')\"" } }),
    "utf8"
  );
  const [result] = await runGateEngineV2({
    cwd: root,
    gates: [
      {
        id: "unit_test",
        required: true,
        language: "typescript",
        specClauseIds: ["accept-checkout"]
      }
    ],
    registry: createDefaultGateRegistry(),
    runId: "external-run",
    candidateId: "external-candidate",
    failClosed: true
  });
  assert.ok(result);
  const parsed = parseGateResultV2(structuredClone(result));
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.artifacts));

  const unknown = validateGateResultV2({ ...result, unexpected: true });
  assert.equal(unknown.valid, false);
  assert.match(unknown.issues[0] ?? "", /unsupported field/u);

  const { artifacts: _artifacts, ...withoutArtifacts } = result!;
  assert.match(
    validateGateResultV2(withoutArtifacts).issues[0] ?? "",
    /artifacts is required/u
  );

  const sparseArtifacts = new Array(1);
  assert.match(
    validateGateResultV2({ ...result, artifacts: sparseArtifacts }).issues[0] ?? "",
    /dense data array/u
  );
  assert.match(
    validateGateResultV2({
      ...result,
      specClauseIds: ["accept-checkout", "accept-checkout"]
    }).issues[0] ?? "",
    /duplicates/u
  );
  assert.match(
    validateGateResultV2({ ...result, status: "warn" }).issues[0] ?? "",
    /status is unsupported/u
  );
  assert.match(
    validateGateResultV2({
      ...result,
      finishedAt: "not-a-time"
    }).issues[0] ?? "",
    /canonical UTC timestamp/u
  );
  assert.ok(
    validateGateResultV2(
      result,
      new Date(Date.parse(result!.freshUntil) + 1).toISOString()
    ).issues.some((issue) => /stale/u.test(issue))
  );
  const {
    command: _forgedCommand,
    tool: _forgedTool,
    ...resultWithoutExecutableIdentity
  } = result;
  const forgedOutput = {
    ...resultWithoutExecutableIdentity,
    runnerId: "attacker",
    artifacts: [],
    workingDirectory: "/etc",
    exitCode: 99,
    startedAt: "2099-01-01T00:00:00.000Z",
    finishedAt: "2099-01-01T00:00:00.000Z",
    freshUntil: "2100-01-01T00:00:00.000Z"
  };
  assert.ok(
    validateGateResultV2({
      ...forgedOutput,
      outputDigest: gateResultV2OutputDigest(forgedOutput)
    }).issues.some((issue) => /exitCode 0|tool identity|future|freshness/u.test(issue))
  );
  assert.throws(
    () => parseGateResultV2({ ...result, artifacts: undefined }),
    /omitted instead of undefined/u
  );
});
