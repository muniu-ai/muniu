// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSchemaFixtureDigest,
  validateOpenAiCodexProvenance
} from "../lib/openai-codex-provenance.mjs";

const baselineCommit = "99660ab3c7b861c916e467581fa9b8723504d66b";
const fixtures = [
  {
    upstreamPath: "codex-rs/app-server-protocol/src/rpc.rs",
    sha256: "78c516097c55b665e375807be6dcdceba232805c9ae9fa48420b0a537f0df705"
  },
  {
    upstreamPath: "codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json",
    sha256: "f7f448fce148b1ad47d5d7ea3d05a56f14c21a2b7dc64580966b56cc97389514"
  }
];

function validManifest() {
  const digest = computeSchemaFixtureDigest(fixtures);
  return [
    "schemaVersion: 1",
    "upstream:",
    "  name: OpenAI Codex",
    "  repository: https://github.com/openai/codex",
    `  commit: ${baselineCommit}`,
    "  license: Apache-2.0",
    "compatibility:",
    "  protocol: app-server-v2",
    "  methodSet: core-stable-subset",
    "  implementation: clean-room-typescript-boundary",
    "schemaFixtures:",
    `  aggregateSha256: ${digest}`,
    "  files:",
    ...fixtures.flatMap((fixture) => [
      `    - upstreamPath: ${fixture.upstreamPath}`,
      `      sha256: ${fixture.sha256}`
    ]),
    "adaptations: []"
  ].join("\n");
}

test("accepts the exact Codex app-server compatibility baseline", () => {
  assert.deepEqual(validateOpenAiCodexProvenance(validManifest()), []);
});

test("rejects a floating or different Codex baseline", () => {
  const failures = validateOpenAiCodexProvenance(
    validManifest().replace(baselineCommit, "main")
  );

  assert.equal(failures.some((failure) => failure.includes("fixed commit")), true);
});

test("rejects schema fixture drift and duplicate paths", () => {
  const manifest = validManifest()
    .replace(/aggregateSha256: [0-9a-f]{64}/u, `aggregateSha256: ${"0".repeat(64)}`)
    .replace(
      "adaptations: []",
      [
        `    - upstreamPath: ${fixtures[0].upstreamPath}`,
        `      sha256: ${fixtures[0].sha256}`,
        "adaptations: []"
      ].join("\n")
    );
  const failures = validateOpenAiCodexProvenance(manifest);

  assert.equal(failures.some((failure) => failure.includes("duplicate schema fixture")), true);
  assert.equal(failures.some((failure) => failure.includes("aggregate digest")), true);
});

test("requires every adaptation to retain the fixed source commit", () => {
  const manifest = validManifest().replace(
    "adaptations: []",
    [
      "adaptations:",
      "  - upstreamPath: codex-rs/app-server-protocol/src/protocol/v2/thread.rs",
      "    localPath: packages/app-server-protocol/src/thread.ts",
      "    upstreamCommit: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "    mode: adapted",
      "    summary: Defines the selected stable thread fields."
    ].join("\n")
  );
  const failures = validateOpenAiCodexProvenance(manifest);

  assert.equal(failures.some((failure) => failure.includes("adaptations[0].upstreamCommit")), true);
});

test("accepts adaptations only from the reviewed Codex source scope", () => {
  const manifest = validManifest().replace(
    "adaptations: []",
    [
      "adaptations:",
      "  - upstreamPath: codex-rs/app-server/src/message_processor.rs",
      "    localPath: packages/app-server/src/message-processor.ts",
      `    upstreamCommit: ${baselineCommit}`,
      "    mode: adapted",
      "    summary: Adapts request dispatch to the Muniu TypeScript runtime."
    ].join("\n")
  );

  assert.deepEqual(validateOpenAiCodexProvenance(manifest), []);
});
