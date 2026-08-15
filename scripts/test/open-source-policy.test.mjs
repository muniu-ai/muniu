import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findSecretFindings,
  findUnpinnedWorkflowActions,
  validateAttributionPolicy,
  validateLicenseExpression,
  validateLicenseInventory
} from "../lib/open-source-policy.mjs";

const fakeSecretsFixture = fileURLToPath(
  new URL("./fixtures/allowed-fake-secrets.txt", import.meta.url)
);

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
