// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
let directory, fixture;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "muniu-team-view-"));
  const file = join(directory, "fixture.cjs");
  await build({ entryPoints: [new URL("../fixtures/team-plan.tsx", import.meta.url).pathname], bundle: true, platform: "node", format: "cjs", jsx: "automatic", loader: { ".css": "empty" }, define: { "import.meta.env": "{}" }, outfile: file });
  fixture = createRequire(import.meta.url)(file);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
test("固定团队计划保留依赖、输入输出、成员、复核边界与不同币种预算", () => {
  const html = fixture.teamPlanMarkup();
  for (const text of ["研究汇总", "计划修订 2", "资料研究", "依赖", "独立复核", "研究员", "复核员", "Codex CLI", "test-model", "目标与验收要求", "material-1", "版本 3", "有依据的研究发现", "来源与反证检查", "核对客户提供的事实", "最终调研报告", "12.50 CNY", "9007199254740993.01 USD", "并行 3", "累计尝试 24", "独立审阅"]) assert.ok(html.includes(text), `缺少 ${text}`);
  assert.ok(html.indexOf("资料研究") < html.indexOf("独立复核"));
  assert.equal((html.match(/data-node-kind="human_decision"/gu) ?? []).length, 1);
  assert.equal((html.match(/data-node-kind="join"/gu) ?? []).length, 1);
});
test("旧单 Agent 计划保持单执行者内容", () => {
  const html = fixture.singlePlanMarkup();
  assert.ok(html.includes("单 Agent")); assert.ok(html.includes("木牛内置 Agent"));
  assert.ok(html.includes("test-model")); assert.ok(html.includes("12.50 CNY"));
  assert.equal(html.includes("累计尝试"), false);
});
test("进展只显示 Host 允许操作，未知结果不产生重跑入口或虚假用量", () => {
  const blocked = fixture.progressMarkup([]);
  assert.equal(blocked.includes("<button"), false);
  for (const text of ["待核对", "已尝试 2 次", "等待执行", "外部结果未知，等待核对 &lt;script&gt;"]) assert.ok(blocked.includes(text));
  assert.equal(blocked.includes("<script>"), false); assert.equal(blocked.includes("0.00"), false); assert.equal(blocked.includes("重跑"), false);
  const enabled = fixture.progressMarkup(["resume", "cancel"]);
  assert.equal((enabled.match(/<button/gu) ?? []).length, 2);
  assert.ok(enabled.includes("恢复")); assert.ok(enabled.includes("取消")); assert.equal(enabled.includes(">开始<"), false);
  const busy = fixture.progressMarkup(["pause", "decide"], true);
  assert.equal((busy.match(/ disabled=""/gu) ?? []).length, 2);
});


test("工作台保留暂停与正在暂停团队的直达入口", () => {
  const html = fixture.pausedHomeMarkup();
  assert.ok(html.includes("等待恢复的经营团队")); assert.ok(html.includes("已暂停"));
  assert.ok(html.includes("正在停止派发的团队")); assert.ok(html.includes("正在暂停"));
});

test("技能计划显示固定技能版本和摘要，不宣称跟随最新版本", () => {
  const html = fixture.teamPlanMarkup({ skillRef: { id: 'skill', version: '3', digest: 'fixed-skill-digest' } });
  assert.ok(html.includes('技能版本 3')); assert.ok(html.includes('fixed-skill-digest'));
});
