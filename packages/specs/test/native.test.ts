import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  exportNativeSpecYaml,
  importNativeSpecYaml,
  parseNativeSpecYaml,
  serializeNativeSpecYaml
} from "../src/index.js";
import { makeRevision } from "./fixtures.js";

async function tempRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mn-native-spec-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  return root;
}

test("native spec YAML has deterministic semantic round-trip", () => {
  const revision = makeRevision();
  const first = serializeNativeSpecYaml(revision);
  const second = serializeNativeSpecYaml({
    ...revision,
    contracts: {
      observability: revision.contracts.observability,
      quality: revision.contracts.quality,
      exception: revision.contracts.exception,
      permission: revision.contracts.permission,
      state: revision.contracts.state,
      data: revision.contracts.data,
      interface: revision.contracts.interface
    }
  });

  assert.equal(first, second);
  assert.match(first, /"apiVersion": "mn.dev\/spec\/v1"/u);
  assert.deepEqual(parseNativeSpecYaml(first), revision);
});

test("native spec parser returns a deeply immutable revision", () => {
  const revision = makeRevision();
  const parsed = parseNativeSpecYaml(serializeNativeSpecYaml(revision));
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.acceptanceCases), true);
  assert.equal(Object.isFrozen(parsed.contracts), true);
  assert.throws(() => {
    (parsed as { hypothesis: string }).hypothesis = "tampered";
  }, TypeError);
});

test("native spec envelope rejects unknown fields", () => {
  const revision = makeRevision();
  const document = JSON.parse(serializeNativeSpecYaml(revision)) as Record<string, unknown>;
  document.execute = "ignored-before-this-fix";
  assert.throws(
    () => parseNativeSpecYaml(`${JSON.stringify(document)}\n`),
    /unsupported fields/u
  );
});

test("native spec YAML imports and exports files atomically", async (t) => {
  const root = await tempRoot(t);
  const filePath = path.join(root, "spec.yaml");
  const revision = makeRevision();

  await exportNativeSpecYaml(filePath, revision);
  assert.deepEqual(await importNativeSpecYaml(filePath), revision);

  const invalidPath = path.join(root, "invalid.yaml");
  await writeFile(invalidPath, "not valid native yaml", "utf8");
  await assert.rejects(importNativeSpecYaml(invalidPath), /Invalid native spec YAML/u);
  await assert.rejects(
    importNativeSpecYaml(path.join(root, "missing.yaml")),
    /ENOENT/u
  );
});
