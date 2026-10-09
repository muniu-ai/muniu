// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("../verify-packaged-macos-app.mjs", import.meta.url);
async function helpers() {
  // Importing this gate must never launch Desktop from a unit test.
  assert.equal(readFileSync(script, "utf8").includes("export async function verifyPackagedMacosApp"), true,
    "打包门禁必须提供无启动副作用的测试入口");
  return import(script.href);
}

test("经营打包门禁不能把接口缺失视为健康", async () => {
  const { verifyBusinessManagement } = await helpers();
  assert.equal(typeof verifyBusinessManagement, "function");
  await assert.rejects(verifyBusinessManagement(async () => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 })), /经营.*404/u);
});

test("打包检查覆盖业务数据目录，并保留系统 HOME 与 Keychain", async () => {
  const { packagedArtifacts, isolatedEnvironment } = await helpers();
  assert.equal(path.basename(packagedArtifacts("/repo", { productName: "木牛", version: "0.2.0" }).executable), "muniu-desktop");
  const environment = isolatedEnvironment("/tmp/isolated", { HOME: "/Users/real", MN_V2_STATE_ROOT: "/Users/real/state" });
  assert.equal(environment.HOME, "/Users/real");
  assert.equal(environment.MN_V2_STATE_ROOT, "/tmp/isolated/.muniu/v2");
});

test("首次设置与同键重放都必须成功并返回同一身份", async () => {
  const { verifySetup } = await helpers();
  const calls = [];
  await verifySetup(async (url, options) => {
    calls.push({ url, options });
    return Response.json({ data: { tenantId: "local", principalId: "local-owner" }, traceId: String(calls.length) });
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:7318/v2/setup");
  const { signal: firstSignal, ...firstRequest } = calls[0].options;
  const { signal: secondSignal, ...secondRequest } = calls[1].options;
  assert.equal(calls[1].url, calls[0].url);
  assert.deepEqual(secondRequest, firstRequest);
  assert.ok(firstSignal instanceof AbortSignal);
  assert.ok(secondSignal instanceof AbortSignal);
  assert.notEqual(firstSignal, secondSignal);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, "{}");
  assert.ok(calls[0].options.headers["Idempotency-Key"]);
});

for (const failureAt of [1, 2]) test(`首次设置第 ${failureAt} 次请求失败不能被健康检查掩盖`, async () => {
  const { verifySetup } = await helpers();
  let count = 0;
  await assert.rejects(verifySetup(async () => {
    count += 1;
    return count === failureAt ? Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })
      : Response.json({ data: { tenantId: "local", principalId: "local-owner" } });
  }), /设置.*500/u);
  assert.equal(count, failureAt);
});

test("首次设置重放身份变化会阻止打包门禁通过", async () => {
  const { verifySetup } = await helpers();
  let count = 0;
  await assert.rejects(verifySetup(async () => Response.json({ data: {
    tenantId: "local", principalId: ++count === 1 ? "local-owner" : "other",
  } })), /设置.*身份/u);
});

test("仅当受管 Host 确认打开临时数据库时才允许设置请求", async t => {
  const { assertIsolatedHost } = await helpers();
  const temporary = mkdtempSync(path.join(tmpdir(), "mn-packaged-gate-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const database = path.join(temporary, "state.sqlite3"); writeFileSync(database, "");
  assert.doesNotThrow(() => assertIsolatedHost(123, database, () => `p123\nn${database}\n`));
  assert.throws(() => assertIsolatedHost(123, database, () => "p123\nn/Users/real/.muniu/v2/state.sqlite3\n"), /隔离/u);
  assert.throws(() => assertIsolatedHost(123, database, () => { throw new Error("lsof failed"); }), /隔离/u);
});
