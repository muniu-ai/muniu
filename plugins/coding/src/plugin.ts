import type { JsonObject } from "@mn/contracts";
import type { PluginDefinitionV1 } from "@mn/plugin-sdk";

export const CODING_AGENT_PRESET = Object.freeze({
  id: "coding.builtin",
  runnerId: "builtin",
  default: true,
  protocol: "coding-v2",
});

async function acceptCommand(input: JsonObject): Promise<JsonObject> {
  return { accepted: true, input };
}

export const codingPlugin = {
  id: "coding",
  version: "0.2.0",
  official: true,
  trustBoundary: "process_equivalent",
  contributions: {
    routes: [
      { id: "coding.tasks", path: "/plugins/coding/tasks" },
      { id: "coding.repositories", path: "/plugins/coding/repositories" },
    ],
    navigation: [
      { id: "coding.navigation.tasks", label: "Coding 任务", routeId: "coding.tasks", order: 20 },
    ],
    widgets: [
      { id: "coding.widget.next-action", slot: "home", title: "Coding 下一步" },
    ],
    commands: [
      { id: "coding.task.capture", title: "创建 Coding 任务", run: acceptCommand },
    ],
    agents: [
      {
        id: "coding.builtin",
        displayName: "木牛 Coding Agent",
        description: "按 Spec、Governance、Harness、Gate 和 Evidence 单轨协议完成代码任务",
      },
    ],
    skills: [
      {
        id: "coding.change",
        title: "实现代码变更",
        expectedOutcome: "生成可审阅的代码变更、检查结果和证据",
        exampleInput: "修复已提交事件在重启后丢失的问题",
        source: "Muniu",
        license: "Apache-2.0",
        version: "0.2.0",
        permissionIds: ["coding.repository.read", "coding.sandbox.write"],
      },
    ],
    workflows: [
      { id: "coding.workflow.v2", version: "0.2.0" },
    ],
    tools: [
      { id: "coding.repository.read", version: "0.2.0", effectClass: "local_read" },
      { id: "coding.sandbox.write", version: "0.2.0", effectClass: "local_reversible_write" },
      { id: "coding.gate.verify", version: "0.2.0", effectClass: "local_read" },
    ],
    memorySchemas: [
      { id: "coding.memory.repository", version: "0.2.0", namespace: "coding" },
    ],
  },
  healthCheck() {
    return { status: "healthy" as const };
  },
} satisfies PluginDefinitionV1;
