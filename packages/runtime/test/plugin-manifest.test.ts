// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootRuntime,
  runtimePluginIntegrity,
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
