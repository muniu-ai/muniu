// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bootRuntime,
  createSessionContext,
  resolveProfileLayers
} from "../src/index.js";

test("boots a Cordis profile, records lifecycle, and disposes effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-runtime-"));
  await writeFile(
    join(directory, "fixture.mjs"),
    [
      "export default function fixture(ctx, config) {",
      "  ctx.provide('fixtureValue', config.value)",
      "  ctx.effect(() => () => { globalThis.__muniuDisposed = true })",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(directory, "cordis.yml"),
    "- id: fixture\n  name: ./fixture.mjs\n  config:\n    value: 7\n",
    "utf8"
  );

  const runtime = await bootRuntime({
    scope: "api",
    profileId: "local",
    profilePath: join(directory, "cordis.yml")
  });
  assert.equal(runtime.context.get("fixtureValue"), 7);
  assert.equal(runtime.snapshot.profileId, "local");
  assert.ok(runtime.snapshot.plugins.some((plugin) => plugin.id === "fixture"));
  assert.ok(runtime.audit.list().some((event) => event.type === "plugin.loaded"));

  await runtime.dispose();
  assert.equal((globalThis as Record<string, unknown>).__muniuDisposed, true);
  assert.ok(runtime.audit.list().some((event) => event.type === "plugin.unloaded"));
  delete (globalThis as Record<string, unknown>).__muniuDisposed;
});

test("profile layers are deterministic and later entries replace by id", () => {
  const resolved = resolveProfileLayers([
    {
      id: "base",
      entries: [{ id: "tools", name: "./tools.mjs", config: { write: false } }]
    },
    {
      id: "local",
      entries: [
        { id: "tools", name: "./tools.mjs", config: { write: true } },
        { id: "desktop", name: "./desktop.mjs" }
      ]
    }
  ]);

  assert.deepEqual(resolved.entries, [
    { id: "tools", name: "./tools.mjs", config: { write: true } },
    { id: "desktop", name: "./desktop.mjs" }
  ]);
  assert.match(resolved.digest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(resolved.layers, ["base", "local"]);
});

test("session contexts isolate session-owned services from the root", async () => {
  const runtime = await bootRuntime({ scope: "worker", profileId: "enterprise-worker" });
  const session = createSessionContext(runtime.context, "session-1");
  session.provide("muniuSession", { id: "session-1" });

  assert.deepEqual(session.get("muniuSession"), { id: "session-1" });
  assert.equal(runtime.context.get("muniuSession"), undefined);
  assert.equal(session.muniuScope.sessionId, "session-1");
  await runtime.dispose();
});
