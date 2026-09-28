// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const manifest = (path) => JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));

function sources(path) {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? sources(child) : /\.(?:ts|mjs)$/u.test(entry.name) ? [child] : [];
  });
}

test("Kernel 不包含行业类型、规则或应用执行服务依赖", () => {
  for (const path of sources("packages/kernel/src")) {
    const source = readFileSync(join(root, path), "utf8");
    assert.doesNotMatch(source,
      /Business(?:Candidate|Action|Scope)|IssueQuotePackage|EffectReceiptV1|\b(?:sales|industry)\b|询价|报价|business[-.]execution|business[-.](?:candidates|actions)/u,
      path);
  }
  assert.deepEqual(manifest("packages/kernel").dependencies, { "@mn/contracts": "0.2.0" });
});

test("业务执行服务保持私有，Host 与 Worker 显式依赖服务", () => {
  const application = manifest("packages/business-execution");
  assert.equal(application.name, "@mn/business-execution");
  assert.equal(application.private, true);
  assert.deepEqual(application.dependencies, { "@mn/contracts": "0.2.0", "@mn/kernel": "0.2.0" });
  for (const path of ["apps/host", "apps/worker"]) {
    assert.equal(manifest(path).dependencies["@mn/business-execution"], "0.2.0");
    for (const name of ["business-actions.ts", "business-candidates.ts"]) {
      assert.match(readFileSync(join(root, path, "src", name), "utf8"), /from "@mn\/business-execution"/u);
    }
  }
});

test("产品插件不能依赖业务执行服务或内核事务", () => {
  for (const entry of readdirSync(join(root, "plugins"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join("plugins", entry.name);
    const configuration = manifest(path);
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dependency of Object.keys(configuration[field] ?? {})) {
        assert.ok(!["@mn/business-execution", "@mn/kernel"].includes(dependency), `${path}: ${dependency}`);
      }
    }
    for (const source of sources(join(path, "src"))) {
      assert.doesNotMatch(readFileSync(join(root, source), "utf8"),
        /(?:from|import\()\s*["'][^"']*(?:@mn\/(?:business-execution|kernel)|packages\/(?:business-execution|kernel))/u, source);
    }
  }
});

test("企业镜像在消费者之前构建业务执行服务", () => {
  const source = readFileSync(join(root, "scripts/build-v2-runtime.mjs"), "utf8");
  const order = [...source.matchAll(/^  "((?:packages|apps|plugins|vendor)\/[^"]+)"/gmu)].map(match => match[1]);
  const service = order.indexOf("packages/business-execution");
  assert.ok(service > order.indexOf("packages/kernel") && order.indexOf("packages/kernel") >= 0);
  assert.ok(service < order.indexOf("apps/worker"));
  assert.ok(service < order.indexOf("apps/host"));
});
