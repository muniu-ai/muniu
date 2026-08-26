// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootRuntime,
  runtimePluginIntegrity,
  runtimePluginSignaturePayload,
  verifyRuntimePluginManifest
} from "../src/index.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-runtime-plugin-v2-"));
  const entryPath = path.join(root, "plugin.mjs");
  await writeFile(entryPath, [
    "export default function plugin(ctx, config) {",
    "  ctx.provide('manifestPluginValue', config.value)",
    "  ctx.effect(() => () => ctx.set('manifestPluginValue', undefined))",
    "}"
  ].join("\n"), "utf8");
  const manifestPath = path.join(root, "muniu.plugin.json");
  const manifest = {
    schemaVersion: 1,
    name: "fixture-plugin",
    version: "1.2.3",
    integrity: runtimePluginIntegrity(await readFile(entryPath)),
    entry: "plugin.mjs",
    skills: ["review"],
    mcpServers: ["weather"],
    hooks: ["turn.completed"],
    tools: ["fixture_tool"],
    configSchema: { type: "object" },
    requiredCapabilities: ["threads"]
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  return { root, entryPath, manifestPath, manifest };
}

test("plugin manifest pins all executable contributions and loads through Cordis", async () => {
  const { manifestPath } = await fixture();
  const verified = await verifyRuntimePluginManifest(manifestPath, ["threads", "tools"]);
  assert.equal(verified.manifest.name, "fixture-plugin");
  assert.equal(verified.entryPath.endsWith("plugin.mjs"), true);

  const runtime = await bootRuntime({
    scope: "worker",
    profileId: "local",
    hostCapabilities: ["threads", "tools"],
    plugins: [{ manifestPath, config: { value: 7 } }]
  });
  assert.equal(runtime.context.get("manifestPluginValue"), 7);
  assert.ok(runtime.audit.list().some((event) =>
    event.type === "plugin.configured" && event.pluginName === "fixture-plugin"
  ));
  assert.equal(runtime.context.get("muniuContributorBus"), runtime.contributors);
  await runtime.dispose();
});

test("signed V2 manifest contributes only operator-approved domain capabilities", async () => {
  const { entryPath, manifestPath } = await fixture();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsigned = {
    schemaVersion: 2,
    name: "opc-domain",
    version: "0.3.0",
    integrity: runtimePluginIntegrity(await readFile(entryPath)),
    entry: "plugin.mjs",
    skills: ["visit-summary"],
    mcpServers: [],
    hooks: ["operation.compile"],
    tools: ["visit_record"],
    configSchema: { type: "object" },
    requiredCapabilities: ["operations"],
    release: { sequence: 1, publishedAt: "2026-08-26T00:00:00.000Z" },
    trustClass: "official-domain",
    contributes: {
      domains: ["opc"],
      recordSchemas: ["opc.visit.v1"],
      workflows: ["opc.visit-assistant.v1"],
      gates: ["opc.visit.source-trace.v1"],
      connectors: [],
      renderers: ["opc.visit.review.v1"]
    },
    externalEffects: [],
    migrations: []
  } as const;
  const signature = sign(
    null,
    Buffer.from(runtimePluginSignaturePayload(unsigned), "utf8"),
    privateKey
  ).toString("base64");
  await writeFile(manifestPath, `${JSON.stringify({
    ...unsigned,
    signature: { algorithm: "ed25519", keyId: "release-key", value: signature }
  })}\n`, "utf8");

  const trustedKeys = {
    "release-key": publicKey.export({ type: "spki", format: "pem" }).toString()
  };
  const verified = await verifyRuntimePluginManifest(
    manifestPath,
    ["operations"],
    { trustedKeys }
  );
  assert.equal(verified.manifest.schemaVersion, 2);
  if (verified.manifest.schemaVersion === 2) {
    assert.deepEqual(verified.manifest.contributes.domains, ["opc"]);
    assert.equal(verified.manifest.trustClass, "official-domain");
  }

  await writeFile(manifestPath, `${JSON.stringify({
    ...unsigned,
    contributes: { ...unsigned.contributes, domains: ["opc", "finance"] },
    signature: { algorithm: "ed25519", keyId: "release-key", value: signature }
  })}\n`, "utf8");
  await assert.rejects(
    () => verifyRuntimePluginManifest(manifestPath, ["operations"], { trustedKeys }),
    /signature/u
  );

  await writeFile(manifestPath, `${JSON.stringify({
    ...unsigned,
    signature: { algorithm: "ed25519", keyId: "release-key", value: "AAAA" }
  })}\n`, "utf8");
  await assert.rejects(
    () => verifyRuntimePluginManifest(manifestPath, ["operations"], { trustedKeys }),
    /signature is invalid/u
  );

  const impossibleDate = {
    ...unsigned,
    release: { sequence: 1, publishedAt: "2026-02-30T00:00:00.000Z" }
  } as const;
  const impossibleDateSignature = sign(
    null,
    Buffer.from(runtimePluginSignaturePayload(impossibleDate), "utf8"),
    privateKey
  ).toString("base64");
  await writeFile(manifestPath, `${JSON.stringify({
    ...impossibleDate,
    signature: { algorithm: "ed25519", keyId: "release-key", value: impossibleDateSignature }
  })}\n`, "utf8");
  await assert.rejects(
    () => verifyRuntimePluginManifest(manifestPath, ["operations"], { trustedKeys }),
    /publishedAt/u
  );
});

test("plugin manifest rejects digest mismatch, missing capability and symlinked entry", async () => {
  const { root, entryPath, manifestPath, manifest } = await fixture();
  await writeFile(entryPath, "export default function changed() {}\n", "utf8");
  await assert.rejects(
    () => verifyRuntimePluginManifest(manifestPath, ["threads"]),
    /integrity/iu
  );

  await writeFile(entryPath, "export default function plugin() {}\n", "utf8");
  const next = { ...manifest, integrity: runtimePluginIntegrity(await readFile(entryPath)) };
  await writeFile(manifestPath, `${JSON.stringify(next)}\n`, "utf8");
  await assert.rejects(
    () => verifyRuntimePluginManifest(manifestPath, []),
    /required capability/iu
  );

  const outside = path.join(root, "outside.mjs");
  await writeFile(outside, "export default function plugin() {}\n", "utf8");
  await writeFile(manifestPath, `${JSON.stringify({
    ...next,
    integrity: runtimePluginIntegrity(await readFile(outside)),
    entry: "linked.mjs"
  })}\n`, "utf8");
  await symlink(outside, path.join(root, "linked.mjs"));
  await assert.rejects(
    () => verifyRuntimePluginManifest(manifestPath, ["threads"]),
    /symbolic link|regular file/iu
  );
});
