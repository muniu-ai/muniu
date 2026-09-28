// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const readManifest = (path) => JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
const rootManifest = readManifest("");
const workspaces = new Map(rootManifest.workspaces.flatMap((pattern) => {
  const parent = pattern.replace(/\/\*$/u, "");
  return readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifest = readManifest(join(parent, entry.name));
      return [manifest.name, manifest];
    });
}));

function commands(workflow, job) {
  return workflow.jobs[job].steps.flatMap((step) => (step.run ?? "").split(/\n|&&/u))
    .map((command) => command.trim()).filter(Boolean);
}

function expandedCommands(command) {
  const script = /^npm run (\S+)$/u.exec(command)?.[1];
  if (!script) return [command];
  assert.ok(rootManifest.scripts[script], `Unknown root script: ${script}`);
  return rootManifest.scripts[script].split(/\n|&&/u)
    .flatMap((child) => expandedCommands(child.trim()));
}

function workspaceDependencies(name, visited = new Set()) {
  for (const dependency of Object.keys(workspaces.get(name)?.dependencies ?? {})) {
    if (!workspaces.has(dependency) || visited.has(dependency)) continue;
    visited.add(dependency);
    workspaceDependencies(dependency, visited);
  }
  return visited;
}

for (const name of ["ci", "release"]) {
  const workflow = parse(readFileSync(join(root, `.github/workflows/${name}.yml`), "utf8"));

  test(`${name}: macOS builds workspace dependencies before each Runner or Worker test`, () => {
    const built = new Set();
    let checked = 0;
    for (const command of commands(workflow, "desktop").flatMap(expandedCommands)) {
      const build = /^npm run build -w (\S+)$/u.exec(command)?.[1];
      if (build) built.add(build);
      const target = /^npm test -w (\S+)$/u.exec(command)?.[1];
      if (!target) continue;
      checked += 1;
      for (const dependency of workspaceDependencies(target)) {
        assert.ok(built.has(dependency), `${target} requires a prior build of ${dependency}`);
      }
    }
    assert.ok(checked >= 3, "Runner and Worker tests must remain in the macOS job");
  });

  test(`${name}: Kind installs locked host dependencies with pinned npm before probes`, () => {
    const steps = commands(workflow, "kubernetes-sandbox");
    const probe = steps.indexOf("scripts/verify-kind-sandbox.sh");
    const install = steps.indexOf("npm ci");
    const pinnedNpm = steps.indexOf("npm install --global npm@${NPM_VERSION}");
    assert.ok(probe >= 0, "Kind probes must remain enabled");
    assert.ok(pinnedNpm >= 0 && pinnedNpm < install, "Install pinned npm before npm ci");
    assert.ok(install >= 0 && install < probe, "Install host dependencies before Kind probes");
    assert.equal(workflow.env.NPM_VERSION, rootManifest.packageManager.slice("npm@".length));
  });

  test(`${name}: macOS builds the Host fixture and its dependencies before UI verification`, () => {
    const built = new Set();
    let checked = 0;
    for (const command of commands(workflow, "desktop").flatMap(expandedCommands)) {
      const build = /^npm run build -w (\S+)$/u.exec(command)?.[1];
      if (build) built.add(build);
      if (!/^npm run verify:(?:onboarding|opc|coding)-ui -w @mn\/desktop-mac$/u.test(command)) continue;
      checked += 1;
      for (const dependency of ["@mn/host", ...workspaceDependencies("@mn/host")]) {
        assert.ok(built.has(dependency), `UI fixture requires a prior build of ${dependency}`);
      }
    }
    assert.equal(checked, 3, "All desktop journeys must remain in the macOS job");
  });
}
