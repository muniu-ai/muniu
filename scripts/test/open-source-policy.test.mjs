import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findSecretFindings,
  findUnpinnedWorkflowActions,
  validateAgentCoverageGate,
  validateAttributionPolicy,
  validateLicenseExpression,
  validateLicenseInventory,
  validateWorkspaceSourceLicenses
} from "../lib/open-source-policy.mjs";

const fakeSecretsFixture = fileURLToPath(
  new URL("./fixtures/allowed-fake-secrets.txt", import.meta.url)
);

const agentWorkspaces = [
  "agent-protocol",
  "agent-session",
  "agent-llm",
  "agent-tools",
  "agent-kernel",
  "agent-host"
];
const agentCoverageScript = "tsc -p tsconfig.test.json && node --test --experimental-test-coverage --test-coverage-include=dist-test/src/**/*.js --test-coverage-lines=70 --test-coverage-functions=70 --test-coverage-branches=70 dist-test/test/**/*.test.js";

function validAgentCoveragePackages() {
  return Object.fromEntries(agentWorkspaces.map((workspace) => [
    workspace,
    { scripts: { "test:coverage": agentCoverageScript } }
  ]));
}

test("secret scan detects a credential even when the file contains NUL bytes", () => {
  const credential = ["AKIA", "1234567890ABCDEF"].join("");
  const content = Buffer.concat([
    Buffer.from("binary-prefix\0AWS_ACCESS_KEY_ID="),
    Buffer.from(credential),
    Buffer.from("\0binary-suffix")
  ]);

  assert.deepEqual(findSecretFindings(content, "fixture.bin"), [
    { label: "AWS access key", path: "fixture.bin" }
  ]);
});

test("secret scan allows only the documented fake fixture values", async () => {
  const content = await readFile(fakeSecretsFixture);
  assert.deepEqual(
    findSecretFindings(content, "scripts/test/fixtures/allowed-fake-secrets.txt"),
    []
  );
  assert.deepEqual(findSecretFindings("AKIA0000000000000000", "src/config.ts"), [
    { label: "AWS access key", path: "src/config.ts" }
  ]);
});

test("secret scan checks every match around an allowlisted fake value", () => {
  const realBefore = ["AKIA", "1111111111111111"].join("");
  const allowedFake = ["AKIA", "0000000000000000"].join("");
  const realAfter = ["AKIA", "2222222222222222"].join("");
  const content = Buffer.from(`${realBefore}\0${allowedFake}\0${realAfter}`);

  assert.deepEqual(findSecretFindings(content, ".gitleaks.toml"), [
    { label: "AWS access key", path: ".gitleaks.toml" },
    { label: "AWS access key", path: ".gitleaks.toml" }
  ]);
  assert.deepEqual(
    findSecretFindings(`${allowedFake}\0${realAfter}`, ".gitleaks.toml"),
    [{ label: "AWS access key", path: ".gitleaks.toml" }]
  );
});

test("workflow scan includes nested repository workflows", () => {
  const failures = findUnpinnedWorkflowActions([
    {
      path: ".github/workflows/ci.yml",
      text: "- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262"
    },
    {
      path: "examples/service/.github/workflows/fixture.yml",
      text: "- uses: actions/setup-node@v4"
    }
  ]);

  assert.equal(failures.length, 1);
  assert.match(failures[0], /examples\/service\/\.github\/workflows\/fixture\.yml/u);
});

test("workflow scan parses YAML uses keys and rejects mutable Docker actions", () => {
  const failures = findUnpinnedWorkflowActions([
    {
      path: ".github/workflows/supply-chain.yml",
      text: [
        "jobs:",
        "  build:",
        "    uses : actions/checkout@v4",
        "  test:",
        "    steps:",
        "      - uses: docker://alpine:latest",
        "      - uses: ./.github/actions/local",
        "      - uses: docker://alpine@sha256:" + "a".repeat(64),
        "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"
      ].join("\n")
    }
  ]);

  assert.equal(failures.length, 2);
  assert.match(failures[0], /actions\/checkout@v4/u);
  assert.match(failures[1], /docker:\/\/alpine:latest/u);
});

test("workflow scan fails closed for invalid YAML and escaping local actions", () => {
  const failures = findUnpinnedWorkflowActions([
    {
      path: ".github/workflows/invalid.yml",
      text: "jobs: ["
    },
    {
      path: ".github/workflows/escape.yml",
      text: "jobs:\n  build:\n    steps:\n      - uses: ./../outside/action"
    }
  ]);

  assert.equal(failures.length, 2);
  assert.match(failures[0], /invalid YAML/u);
  assert.match(failures[1], /\.\/\.\.\/outside\/action/u);
});

test("agent coverage policy requires the serial six-package root gate in the node job", () => {
  const command = [
    "npm run test:coverage -w @mn/agent-protocol",
    "npm run test:coverage -w @mn/agent-session",
    "npm run test:coverage -w @mn/agent-llm",
    "npm run test:coverage -w @mn/agent-tools",
    "npm run test:coverage -w @mn/agent-kernel",
    "npm run test:coverage -w @mn/agent-host"
  ].join(" && ");
  assert.deepEqual(validateAgentCoverageGate({
    rootPackage: { scripts: { "test:coverage:agent": command } },
    workspacePackages: validAgentCoveragePackages(),
    ciWorkflow: [
      "jobs:",
      "  node:",
      "    steps:",
      "      - run: npm run test:coverage:agent"
    ].join("\n")
  }), []);

  const failures = validateAgentCoverageGate({
    rootPackage: { scripts: { "test:coverage:agent": command.replace("agent-host", "agent-kernel") } },
    workspacePackages: validAgentCoveragePackages(),
    ciWorkflow: [
      "jobs:",
      "  baseline:",
      "    steps:",
      "      - run: npm run test:coverage:agent",
      "  node:",
      "    steps:",
      "      - run: npm test"
    ].join("\n")
  });
  assert.equal(failures.length, 2);
  assert.match(failures[0], /serially run all six agent package coverage suites/u);
  assert.match(failures[1], /node job.*test:coverage:agent/u);
});

test("agent coverage policy rejects disguised or incomplete workspace coverage commands", () => {
  const command = agentWorkspaces
    .map((workspace) => `npm run test:coverage -w @mn/${workspace}`)
    .join(" && ");
  const ciWorkflow = [
    "jobs:",
    "  node:",
    "    steps:",
    "      - run: npm run test:coverage:agent"
  ].join("\n");
  const invalidScripts = [
    `true # ${agentCoverageScript}`,
    `echo ${agentCoverageScript}`,
    agentCoverageScript.replace("node --test", "node"),
    agentCoverageScript.replace(" --experimental-test-coverage", ""),
    agentCoverageScript.replace(" --test-coverage-include=dist-test/src/**/*.js", ""),
    agentCoverageScript.replace(" --test-coverage-lines=70", ""),
    agentCoverageScript.replace(" --test-coverage-functions=70", ""),
    agentCoverageScript.replace(" --test-coverage-branches=70", ""),
    agentCoverageScript.replace(" dist-test/test/**/*.test.js", "")
  ];

  for (const workspace of agentWorkspaces) {
    for (const script of invalidScripts) {
      const workspacePackages = validAgentCoveragePackages();
      workspacePackages[workspace].scripts["test:coverage"] = script;
      const failures = validateAgentCoverageGate({
        rootPackage: { scripts: { "test:coverage:agent": command } },
        workspacePackages,
        ciWorkflow
      });
      assert.equal(
        failures.some((failure) => failure.includes(`packages/${workspace}`)),
        true,
        `${workspace} accepted invalid test:coverage script: ${script}`
      );
    }
  }
});

test("agent coverage policy rejects disabled or error-swallowing CI coverage gates", () => {
  const command = agentWorkspaces
    .map((workspace) => `npm run test:coverage -w @mn/${workspace}`)
    .join(" && ");
  const invalidWorkflows = [
    ["step if", [
      "jobs:",
      "  node:",
      "    steps:",
      "      - if: false",
      "        run: npm run test:coverage:agent"
    ]],
    ["continue-on-error", [
      "jobs:",
      "  node:",
      "    steps:",
      "      - continue-on-error: true",
      "        run: npm run test:coverage:agent"
    ]],
    ["custom shell", [
      "jobs:",
      "  node:",
      "    steps:",
      "      - shell: echo {0}",
      "        run: npm run test:coverage:agent"
    ]],
    ["step working-directory", [
      "jobs:",
      "  node:",
      "    steps:",
      "      - working-directory: packages/agent-host",
      "        run: npm run test:coverage:agent"
    ]],
    ["disabled node job", [
      "jobs:",
      "  node:",
      "    if: false",
      "    steps:",
      "      - run: npm run test:coverage:agent"
    ]],
    ["node job continue-on-error", [
      "jobs:",
      "  node:",
      "    continue-on-error: true",
      "    steps:",
      "      - run: npm run test:coverage:agent"
    ]],
    ["workflow run defaults", [
      "defaults:",
      "  run:",
      "    shell: echo {0}",
      "jobs:",
      "  node:",
      "    steps:",
      "      - run: npm run test:coverage:agent"
    ]],
    ["node job run defaults", [
      "jobs:",
      "  node:",
      "    defaults:",
      "      run:",
      "        working-directory: packages/agent-host",
      "    steps:",
      "      - run: npm run test:coverage:agent"
    ]]
  ];

  for (const [label, lines] of invalidWorkflows) {
    const failures = validateAgentCoverageGate({
      rootPackage: { scripts: { "test:coverage:agent": command } },
      workspacePackages: validAgentCoveragePackages(),
      ciWorkflow: lines.join("\n")
    });
    assert.equal(
      failures.some((failure) => /CI node job.*test:coverage:agent/u.test(failure)),
      true,
      `${label} was accepted`
    );
  }

  assert.deepEqual(validateAgentCoverageGate({
    rootPackage: { scripts: { "test:coverage:agent": command } },
    workspacePackages: validAgentCoveragePackages(),
    ciWorkflow: [
      "jobs:",
      "  node:",
      "    continue-on-error: false",
      "    steps:",
      "      - continue-on-error: false",
      "        run: npm run test:coverage:agent"
    ].join("\n")
  }), []);
});

test("attribution policy rejects claiming unimported upstream code in NOTICE", () => {
  assert.throws(
    () =>
      validateAttributionPolicy({
        notice: "Portions are derived from DeepSeek Harness.",
        thirdParty: "At this baseline no DeepSeek Harness source file is copied.",
        provenance: "files: []"
      }),
    /NOTICE must not claim DeepSeek Harness attribution before files are imported/u
  );
});

test("license policy accepts approved SPDX expressions and rejects forbidden or unknown values", () => {
  assert.equal(validateLicenseExpression("MIT OR Apache-2.0"), true);
  assert.equal(validateLicenseExpression("MIT OR GPL-3.0-only"), true);
  assert.equal(validateLicenseExpression("MIT or GPL-2.0"), true);
  assert.equal(validateLicenseExpression("MIT AND GPL-3.0-only"), false);
  assert.equal(validateLicenseExpression("BSD-3-Clause"), true);
  assert.equal(validateLicenseExpression("BlueOak-1.0.0"), true);
  assert.equal(validateLicenseExpression("CC-BY-3.0"), true);
  assert.equal(validateLicenseExpression("GPL-3.0-only"), false);
  assert.equal(validateLicenseExpression("UNKNOWN"), false);
  assert.equal(validateLicenseExpression(""), false);
});

test("license inventory reports unknown and forbidden third-party packages", () => {
  assert.deepEqual(
    validateLicenseInventory([
      { name: "accepted@1.0.0", license: "MIT" },
      { name: "forbidden@1.0.0", license: "GPL-3.0-only" },
      { name: "unknown@1.0.0", license: null }
    ]),
    [
      "forbidden@1.0.0: GPL-3.0-only",
      "unknown@1.0.0: UNKNOWN"
    ]
  );
});

test("workspace source license policy permits MIT only for exact provenance-backed files", () => {
  const provenance = [
    "upstream:",
    "  commit: 47f943859bef60e4160492346772ded9b24f765a",
    "files:",
    "  - upstreamPath: packages/core/agent-loop/src/agent.ts",
    "    localPath: packages/agent-kernel/src/react-driver.ts",
    "    mode: adapted",
    "    summary: Static loop adaptation."
  ].join("\n");
  const source = [
    "/*",
    " * 47f943859bef60e4160492346772ded9b24f765a.",
    " * Original path: packages/core/agent-loop/src/agent.ts",
    " * Copyright (c) 2026 DeepSeek",
    " * SPDX-License-Identifier: MIT",
    " */"
  ].join("\n");
  assert.deepEqual(validateWorkspaceSourceLicenses({
    manifests: [
      { path: "package.json", license: "Apache-2.0" },
      { path: "packages/agent-kernel/package.json", license: "Apache-2.0 AND MIT" },
      { path: "packages/agent-host/package.json", license: "Apache-2.0" }
    ],
    provenance,
    sourceFiles: [{ path: "packages/agent-kernel/src/react-driver.ts", text: source }]
  }), []);

  const failures = validateWorkspaceSourceLicenses({
    manifests: [
      { path: "package.json", license: "Apache-2.0 AND MIT" },
      { path: "packages/agent-kernel/package.json", license: "Apache-2.0" },
      { path: "packages/unlisted/package.json", license: "Apache-2.0 AND MIT" }
    ],
    provenance,
    sourceFiles: [
      { path: "packages/agent-kernel/src/react-driver.ts", text: source },
      { path: "packages/agent-kernel/src/unlisted.ts", text: source.replace("agent.ts", "other.ts") }
    ]
  });
  assert.equal(failures.some((failure) => /^package\.json must declare Apache-2\.0/u.test(failure)), true);
  assert.equal(failures.some((failure) => /agent-kernel\/package\.json must declare Apache-2\.0 AND MIT/u.test(failure)), true);
  assert.equal(failures.some((failure) => /unlisted\/package\.json.*no listed MIT source/u.test(failure)), true);
  assert.equal(failures.some((failure) => /unlisted\.ts has an unlisted DeepSeek MIT notice/u.test(failure)), true);
});

test("workspace source license policy fails closed on bad provenance metadata and headers", () => {
  const failures = validateWorkspaceSourceLicenses({
    manifests: [{ path: "packages/agent-kernel/package.json", license: "Apache-2.0 AND MIT" }],
    provenance: [
      "files:",
      "  - upstreamPath: packages/core/agent-loop/src/agent.ts",
      "    localPath: packages/agent-kernel/src/react-driver.ts",
      "    mode: inspired",
      "    summary: ''"
    ].join("\n"),
    sourceFiles: [{
      path: "packages/agent-kernel/src/react-driver.ts",
      text: "// SPDX-License-Identifier: MIT"
    }]
  });
  assert.equal(failures.some((failure) => /mode must be copied or adapted/u.test(failure)), true);
  assert.equal(failures.some((failure) => /summary must not be empty/u.test(failure)), true);
  assert.equal(failures.some((failure) => /approved upstream commit/u.test(failure)), true);
  assert.equal(failures.some((failure) => /original upstream path/u.test(failure)), true);
  assert.equal(failures.some((failure) => /DeepSeek copyright/u.test(failure)), true);
});
