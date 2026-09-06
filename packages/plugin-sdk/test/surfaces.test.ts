import assert from "node:assert/strict";
import test from "node:test";
import { assertPluginSurfaces } from "../src/surfaces.js";

const contributions = {
  routes: [{ id: "research.home", path: "/plugins/research" }],
  widgets: [{ id: "research.today", slot: "home" as const, title: "今日研究" }],
  commands: [{ id: "summarize", title: "整理", run: async () => ({}) }],
};
const surfaces = {
  ui: { pages: [{ routeId: "research.home", title: "研究", cards: [{ title: "下一步", body: "整理来源", commandId: "summarize" }] }], widgets: [] },
  cli: { commands: [{ name: "summarize", commandId: "summarize", description: "整理来源", fields: [{ name: "input", type: "string" as const, required: true }] }] },
};
test("声明式 UI 和 CLI 只能引用已声明贡献，不接受脚本、HTML 或额外字段", () => {
  assert.doesNotThrow(() => assertPluginSurfaces(surfaces, contributions));
  for (const bad of [
    { ...surfaces, ui: { pages: [{ ...surfaces.ui.pages[0], routeId: "settings" }], widgets: [] } },
    { ...surfaces, ui: { pages: [{ ...surfaces.ui.pages[0], html: "<script>bad</script>" }], widgets: [] } },
    { ...surfaces, cli: { commands: [{ ...surfaces.cli.commands[0], commandId: "undeclared" }] } },
  ]) assert.throws(() => assertPluginSurfaces(bad, contributions));
});
