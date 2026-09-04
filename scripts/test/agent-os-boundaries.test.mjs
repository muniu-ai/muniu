import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

function filesUnder(directory) {
  const output = [];
  if (!existsSync(directory)) return output;
  for (const entry of readdirSync(directory)) {
    if (["dist", "dist-test", "node_modules", "target"].includes(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) output.push(...filesUnder(path));
    else output.push(path);
  }
  return output;
}

test("0.2 只保留目标工作区", () => {
  const required = [
    "apps/host",
    "apps/worker",
    "apps/desktop-mac",
    "apps/cli",
    "packages/contracts",
    "packages/kernel",
    "packages/agent-runtime",
    "packages/plugin-sdk",
    "packages/storage",
    "plugins/opc",
    "plugins/coding",
    "plugins/runner-claude-cli",
    "plugins/runner-codex-cli",
  ];
  for (const path of required) assert.equal(existsSync(join(root, path)), true, `缺少 ${path}`);
  for (const path of [
    "apps/api",
    "packages/agent-host",
    "packages/agent-kernel",
    "packages/agent-llm",
    "packages/agent-protocol",
    "packages/agent-session",
    "packages/agent-tools",
    "packages/config-manager",
    "packages/connectors",
    "packages/core",
    "packages/data-policy",
    "packages/evidence",
    "packages/executors",
    "packages/extensions",
    "packages/governance",
    "packages/harness",
    "packages/local-proxy",
    "packages/loop",
    "packages/provider-catalog",
    "packages/runtime",
    "packages/specs",
    "packages/store",
    "packages/usage",
    "packages/verifier",
  ])
    assert.equal(existsSync(join(root, path)), false, `旧入口仍存在：${path}`);
});

test("内核不得导入产品插件", () => {
  for (const file of filesUnder(join(root, "packages/kernel", "src"))) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /(?:from|import\()\s*["'][^"']*(?:plugins\/|@mn\/plugin-opc|@mn\/plugin-coding)/, relative(root, file));
  }
});

test("源代码和当前文档不暴露 v1 路由或旧协议", () => {
  const roots = ["apps", "packages", "plugins", "docs/reference", "docs/quickstart.md"];
  for (const item of roots) {
    for (const file of filesUnder(join(root, item))) {
      if (!/\.(?:ts|tsx|rs|json|ya?ml|md|mjs)$/.test(file)) continue;
      if (relative(root, file).split("/").includes("test")) continue;
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /["'`]\/v1(?:\/|\b)|mniu:\/\//, relative(root, file));
    }
  }
});
