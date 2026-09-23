import type { JsonObject, JsonValue } from "@mn/contracts";
import type { PluginDefinitionV1 } from "@mn/plugin-sdk";
import { createOpportunityDraft } from "./capture.js";
import { exportOpportunityDeliverables } from "./deliverables.js";
import { OpcDomainError } from "./errors.js";
import type { OpportunityCaptureDraft } from "./model.js";
import type { OpcService } from "./service.js";

export interface OpcPluginDefinitionOptions {
  readonly service: OpcService;
}

export function createOpcPluginDefinition(
  options: OpcPluginDefinitionOptions,
): PluginDefinitionV1 {
  return {
    id: "opc",
    version: "0.2.0",
    official: true,
    trustBoundary: "process_equivalent",
    contributions: {
      routes: [
        { id: "opc.opportunities", path: "/opc/opportunities" },
        { id: "opc.opportunity", path: "/opc/opportunity" },
      ],
      navigation: [
        { id: "opc.navigation.opportunities", label: "机会验证", routeId: "opc.opportunities", order: 20 },
      ],
      widgets: [
        { id: "opc.widget.today", slot: "home", title: "今日验证行动" },
        { id: "opc.widget.evidence-gaps", slot: "workspace", title: "证据缺口" },
      ],
      commands: [
        {
          id: "opc.capture.preview",
          title: "捕获机会",
          description: "把自然语言整理成待审阅结构，不直接写入事实记录",
          run: async (input) => createOpportunityDraft(readString(input, "text")),
        },
        {
          id: "opc.capture.confirm",
          title: "确认创建机会",
          description: "确认待审阅结构后创建机会",
          run: async (input, context) => options.service.capture({
            workspaceId: context.workspaceId,
            opportunityId: readString(input, "opportunityId"),
            expectedStreamVersion: readInteger(input, "expectedStreamVersion"),
            actor: { id: context.principalId ?? "local-owner", kind: "human" },
            draft: readDraft(input),
          }),
        },
        {
          id: "opc.export",
          title: "导出机会成果",
          description: "导出验证档案、访谈包、证据、方案和决策",
          run: async (input, context) => {
            const opportunity = await options.service.get(
              context.workspaceId,
              readString(input, "opportunityId"),
            );
            if (!opportunity) {
              throw new OpcDomainError("NOT_FOUND", "机会不存在", "刷新工作区后重试");
            }
            return exportOpportunityDeliverables(opportunity);
          },
        },
      ],
      agents: [{
        id: "opc.opportunity-validator",
        displayName: "机会验证 Agent",
        description: "整理假设、证据和反证；承诺证据与最终决策仍由人确认",
      }],
      skills: [
        {
          id: "opc.skill.frame-opportunity",
          title: "界定机会",
          expectedOutcome: "形成目标客户、客户问题和可证伪假设",
          exampleInput: "目标客户是首次创业者，问题是无法判断需求真伪",
          source: "木牛 Agent OS",
          license: "Apache-2.0",
          version: "0.2.0",
          permissionIds: [],
        },
        {
          id: "opc.skill.public-research",
          title: "公开资料研究",
          expectedOutcome: "记录带来源和时间的支持、反对与中立信号",
          exampleInput: "查找独立开发者进行客户访谈时遇到的具体问题",
          source: "木牛 Agent OS",
          license: "Apache-2.0",
          version: "0.2.0",
          permissionIds: ["opc.public-web.read"],
        },
        {
          id: "opc.skill.non-leading-interview",
          title: "非诱导访谈",
          expectedOutcome: "生成围绕既往行为的提纲，并把模型判断作为追加标注",
          exampleInput: "为访谈独立开发者生成五个不暗示答案的问题",
          source: "木牛 Agent OS",
          license: "Apache-2.0",
          version: "0.2.0",
          permissionIds: [],
        },
        {
          id: "opc.skill.minimum-paid-offer",
          title: "最小收费方案",
          expectedOutcome: "形成范围、价格假设、验收、下一次客户行动和风险",
          exampleInput: "把访谈证据整理成七天交付的最小收费方案",
          source: "木牛 Agent OS",
          license: "Apache-2.0",
          version: "0.2.0",
          permissionIds: [],
        },
      ],
      workflows: [{ id: "opc.opportunity-validation", version: "0.2.0" }],
      tools: [{
        id: "opc.public-web.read",
        version: "0.2.0",
        effectClass: "external_read",
      }],
      memorySchemas: [{
        id: "opc.opportunity-context",
        version: "0.2.0",
        namespace: "opc",
      }],
    },
    healthCheck: () => ({ status: "healthy" }),
  };
}

function readString(input: JsonObject, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new OpcDomainError("REQUIRED_FIELD", `${field} 不能为空`, `填写 ${field} 后重试`, field);
  }
  return value.trim();
}

function readInteger(input: JsonObject, field: string): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OpcDomainError("INVALID_INPUT", `${field} 必须是非负整数`, `修正 ${field} 后重试`, field);
  }
  return value;
}

function readDraft(input: JsonObject): OpportunityCaptureDraft {
  const value = input.draft;
  if (!isJsonRecord(value)) {
    throw new OpcDomainError("REQUIRED_FIELD", "draft 不能为空", "先预览并审阅机会结构", "draft");
  }
  const draft = createOpportunityDraft(readRecordString(value, "rawInput"));
  return {
    ...draft,
    title: readRecordString(value, "title"),
    ...(optionalRecordString(value, "targetCustomer") ? { targetCustomer: optionalRecordString(value, "targetCustomer") } : {}),
    ...(optionalRecordString(value, "problem") ? { problem: optionalRecordString(value, "problem") } : {}),
    ...(optionalRecordString(value, "falsifiableHypothesis") ? { falsifiableHypothesis: optionalRecordString(value, "falsifiableHypothesis") } : {}),
  };
}

function isJsonRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRecordString(value: Readonly<Record<string, JsonValue>>, field: string): string {
  const item = value[field];
  if (typeof item !== "string" || !item.trim()) {
    throw new OpcDomainError("REQUIRED_FIELD", `${field} 不能为空`, `填写 ${field} 后重试`, field);
  }
  return item.trim();
}

function optionalRecordString(
  value: Readonly<Record<string, JsonValue>>,
  field: string,
): string | undefined {
  const item = value[field];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
}
